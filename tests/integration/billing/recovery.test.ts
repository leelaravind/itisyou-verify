/**
 * The payment-recovery window end to end, over real signed webhooks and the scheduled
 * sweep.
 *
 * Each `describe` below maps to one of the founder's numbered requirements. The invariant
 * that gets the most attention is requirement 5 — the paid period's allowance is applied
 * exactly once — because redelivery and reordering are where it would break silently.
 */
import { describe, expect, it } from 'vitest';
import { createStripeWebhookRoute } from '@app/routes/webhooks/stripe';
import { cancelSubscription } from '@app/billing/portal';
import { entitlementWithRecovery, paymentRecoveryWindow } from '@app/billing/policy';
import { expirePaymentRecoveryWindows, recoveryStatus } from '@app/billing/recovery';
import { handleStripeEvent } from '@app/billing/events';
import type { BillingRuntime } from '@app/billing/runtime';
import {
  OPAQUE_ID,
  WEBHOOK_SECRET,
  createHarness,
  invoiceObject,
  signedDelivery,
  stripeEvent,
  subscriptionObject,
  type BillingHarness,
} from './harness';

const WS = 'ws_customer_1';
const PATH = `/api/v1/webhooks/stripe/${OPAQUE_ID}`;

/** Period end 2026-09-19T09:00:00Z, so the window closes 2026-09-26T09:00:00Z. */
const PERIOD_END = Math.floor(Date.parse('2026-09-19T09:00:00.000Z') / 1000);
const NEXT_PERIOD_END = Math.floor(Date.parse('2026-10-19T09:00:00.000Z') / 1000);

function withContact(harness: BillingHarness): BillingRuntime {
  return {
    ...harness,
    billingContact: async (workspaceId: string) =>
      workspaceId === WS ? { email: 'owner@agency.example', workspaceName: 'Acme Automations' } : null,
  };
}

async function deliver(
  harness: BillingHarness,
  event: Record<string, unknown>,
  runtime: BillingRuntime = harness,
): Promise<Response> {
  const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
  const app = createStripeWebhookRoute({
    ...runtime,
    resolveEndpointSecret: async (id) => (id === OPAQUE_ID ? WEBHOOK_SECRET : null),
  });
  return app.request(PATH, { method: 'POST', headers, body });
}

async function seedWorkspace(harness: BillingHarness): Promise<void> {
  await harness.data.rememberBillingCustomer({
    workspaceId: WS,
    stripeCustomerId: 'cus_stub_1',
    environment: 'test',
    createdAt: harness.at(),
  });
  await harness.data.openOrderOnce({
    id: 'ord_0001',
    workspaceId: WS,
    status: 'active',
    rejectionReason: null,
    priceId: harness.config.priceId,
    amountMinor: 2900,
    currency: 'GBP',
    checkoutSessionId: 'cs_stub_1',
    idempotencyKey: 'checkout:v1:ws_customer_1',
    createdAt: harness.at(),
    updatedAt: harness.at(),
  });
}

/** An active subscription whose current period ends on 2026-09-19T09:00Z. */
async function activate(harness: BillingHarness, created = 1_795_000_000): Promise<void> {
  await deliver(
    harness,
    stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ workspaceId: WS, currentPeriodEnd: PERIOD_END }),
      { created },
    ),
  );
}

/** The renewal invoice for that period fails. */
async function failRenewal(
  harness: BillingHarness,
  created: number,
  runtime: BillingRuntime = harness,
): Promise<Response> {
  return deliver(
    harness,
    stripeEvent(
      'invoice.payment_failed',
      invoiceObject({ subscriptionId: 'sub_live_1', billingReason: 'subscription_cycle' }),
      { created },
    ),
    runtime,
  );
}

describe('requirement 1 — a failed renewal pauses new runs and nothing else', () => {
  it('BILL-184 a failed renewal invoice puts the subscription into the recovery window', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');

    const response = await failRenewal(harness, 1_795_100_000);
    expect(response.status).toBe(200);

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('past_due');
    const view = entitlementWithRecovery(stored, harness.at());
    expect(view.admitsNewRuns).toBe(false);
    expect(view.recovery.phase).toBe('in_recovery_window');
    expect(view.recovery.endsAt).toBe('2026-09-26T09:00:00.000Z');
  });

  it('BILL-185 a first-invoice failure does not fabricate past_due on a serving subscription', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    await deliver(
      harness,
      stripeEvent(
        'invoice.payment_failed',
        invoiceObject({ subscriptionId: 'sub_live_1', billingReason: 'subscription_create' }),
        { created: 1_795_100_000 },
      ),
    );
    // Not a renewal, so we wait for Stripe's own subscription event rather than guessing.
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');
  });

  it('BILL-186 access, history and cancellation all stay reachable on day one', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    await failRenewal(harness, 1_795_100_000);

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    const status = recoveryStatus(harness, stored, harness.at());
    expect(status.cancellationAvailable).toBe(true);
    expect(status.policy.whatStaysAvailable.join(' ').toLowerCase()).toContain('exporting');

    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'past_due',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
    });
    const cancelled = await cancelSubscription(harness, { workspaceId: WS });
    expect(cancelled.requested).toBe('period_end');
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
  });
});

describe('requirement 3 — the customer is told verification is paused', () => {
  it('BILL-187 the failure produces a notification naming the paused runs, not a generic billing issue', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);

    const runtime = withContact(harness);
    const outcome = await handleStripeEvent(
      runtime,
      stripeEvent(
        'invoice.payment_failed',
        invoiceObject({ subscriptionId: 'sub_live_1', billingReason: 'subscription_cycle' }),
        { created: 1_795_100_000 },
      ) as never,
    );

    expect(outcome.status).toBe('processed');
    expect(outcome.notifications).toHaveLength(1);
    const notification = outcome.notifications?.[0];
    expect(notification?.template).toBe('payment_problem');
    expect(notification?.recipientEmail).toBe('owner@agency.example');
    expect(notification?.vars.reasonSentence.toLowerCase()).toContain('paused checking new runs');
    expect(notification?.vars.workspaceName).toBe('Acme Automations');
  });

  it('BILL-188 Stripe’s card retries do not become a stream of identical emails', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    const runtime = withContact(harness);

    const keys: string[] = [];
    for (const created of [1_795_100_000, 1_795_200_000, 1_795_300_000]) {
      harness.tick(3_600);
      const outcome = await handleStripeEvent(
        runtime,
        stripeEvent(
          'invoice.payment_failed',
          invoiceObject({ subscriptionId: 'sub_live_1', billingReason: 'subscription_cycle' }),
          { created },
        ) as never,
      );
      const key = outcome.notifications?.[0]?.notificationKey;
      if (key !== undefined) keys.push(key);
    }
    // The key is derived from the window, not the clock, so A09 claims it once.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('BILL-189 a workspace with no reachable billing contact still enters the window', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    const outcome = await handleStripeEvent(
      { ...harness, billingContact: async () => null },
      stripeEvent(
        'invoice.payment_failed',
        invoiceObject({ subscriptionId: 'sub_live_1', billingReason: 'subscription_cycle' }),
        { created: 1_795_100_000 },
      ) as never,
    );
    expect(outcome.notifications).toHaveLength(0);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('past_due');
  });
});

describe('requirements 4 and 5 — resume only on confirmed payment, allowance applied once', () => {
  it('BILL-190 recovery inside the window resumes on the existing allowance, not a second one', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);

    // Use some of the period before the payment fails.
    const period = harness.data.debug.allowances()[0];
    expect(period).toBeDefined();
    for (let i = 0; i < 3; i += 1) {
      await harness.data.reserveRun(WS, period!.billingPeriod, harness.at());
      await harness.data.settleReservedRun(WS, period!.billingPeriod, harness.at());
    }
    expect(harness.data.debug.allowances()[0]?.consumed).toBe(3);

    await failRenewal(harness, 1_795_100_000);
    harness.tick(3 * 24 * 3_600);

    // The customer fixes the card. Stripe confirms with a subscription event.
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'active', currentPeriodEnd: PERIOD_END }),
        { created: 1_795_400_000 },
      ),
    );

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('active');
    expect(entitlementWithRecovery(stored, harness.at()).admitsNewRuns).toBe(true);

    // One allowance row, and the three runs they used are still used.
    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(1);
    expect(allowances[0]).toMatchObject({ runLimit: 500, consumed: 3, reserved: 0 });
  });

  it('BILL-191 a duplicate invoice.paid grants nothing extra', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    const period = harness.data.debug.allowances()[0];
    await harness.data.reserveRun(WS, period!.billingPeriod, harness.at());
    await harness.data.settleReservedRun(WS, period!.billingPeriod, harness.at());

    const paid = stripeEvent(
      'invoice.paid',
      invoiceObject({
        subscriptionId: 'sub_live_1',
        billingReason: 'subscription_cycle',
        periodStart: PERIOD_END - 2_592_000,
      }),
      { id: 'evt_paid_once', created: 1_795_400_000 },
    );

    const first = await deliver(harness, paid);
    const second = await deliver(harness, paid);
    const third = await deliver(harness, paid);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(1);
    expect(allowances[0]).toMatchObject({ runLimit: 500, consumed: 1 });
  });

  it('BILL-192 a subscription event and an invoice describing the same period open one allowance', async () => {
    // The regression this guards: the two sources used to derive the period key
    // differently — one by stepping a month back from the end — so a 30- versus 31-day
    // month produced two rows for one paid period. 1,000 runs sold for £29.
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    expect(harness.data.debug.allowances()).toHaveLength(1);

    await deliver(
      harness,
      stripeEvent(
        'invoice.paid',
        invoiceObject({
          subscriptionId: 'sub_live_1',
          billingReason: 'subscription_cycle',
          periodStart: PERIOD_END - 2_592_000,
        }),
        { created: 1_795_050_000 },
      ),
    );

    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(1);
    expect(allowances[0]?.billingPeriod).toBe('2026-09-19');
  });

  it('BILL-193 an out-of-order invoice.paid for the period already open grants nothing extra', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    const period = harness.data.debug.allowances()[0];
    await harness.data.reserveRun(WS, period!.billingPeriod, harness.at());

    // A late-delivered invoice for the *same* period, generated before the subscription
    // event we already processed.
    await deliver(
      harness,
      stripeEvent(
        'invoice.paid',
        invoiceObject({
          subscriptionId: 'sub_live_1',
          billingReason: 'subscription_cycle',
          periodStart: PERIOD_END - 2_592_000,
        }),
        { created: 1_794_000_000 },
      ),
    );

    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(1);
    expect(allowances[0]?.reserved).toBe(1);
  });

  it('BILL-194 a genuinely new paid period does open its own allowance', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);

    await deliver(
      harness,
      stripeEvent(
        'invoice.paid',
        invoiceObject({
          subscriptionId: 'sub_live_1',
          billingReason: 'subscription_cycle',
          periodStart: PERIOD_END,
        }),
        { created: 1_795_500_000 },
      ),
    );

    const periods = harness.data.debug.allowances().map((row) => row.billingPeriod).sort();
    expect(periods).toEqual(['2026-09-19', '2026-10-19']);
  });

  it('BILL-195 a checkout redirect during the window resumes nothing', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    await failRenewal(harness, 1_795_100_000);

    // Whatever the browser does, entitlement is read from stored provider evidence.
    for (let i = 0; i < 3; i += 1) {
      harness.tick(60);
      const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
      expect(entitlementWithRecovery(stored, harness.at()).admitsNewRuns).toBe(false);
    }
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('past_due');
  });
});

describe('requirements 6 and 7 — day eight suspends, and deletes nothing', () => {
  async function intoWindow(): Promise<BillingHarness> {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    await failRenewal(harness, 1_795_100_000);
    return harness;
  }

  it('BILL-196 the sweep leaves a subscription alone while it is still inside the window', async () => {
    const harness = await intoWindow();
    harness.tick(6 * 24 * 3_600);
    const report = await expirePaymentRecoveryWindows(harness);
    expect(report.inWindow).toBe(1);
    expect(report.suspended).toHaveLength(0);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('past_due');
  });

  it('BILL-197 on day eight the subscription is marked unpaid and is not cancelled', async () => {
    const harness = await intoWindow();
    harness.tick(8 * 24 * 3_600);
    const report = await expirePaymentRecoveryWindows(harness);

    expect(report.suspended).toHaveLength(1);
    expect(report.suspended[0]).toMatchObject({
      workspaceId: WS,
      providerSubscriptionId: 'sub_live_1',
      windowEndedAt: '2026-09-26T09:00:00.000Z',
    });
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('unpaid');
    expect(stored?.status).not.toBe('canceled');
    expect(stored?.cancelAtPeriodEnd).toBe(false);
  });

  it('BILL-198 day eight deletes nothing — the allowance, orders and history all survive', async () => {
    const harness = await intoWindow();
    const before = {
      allowances: harness.data.debug.allowances().length,
      orders: harness.data.debug.orders().length,
      customers: harness.data.debug.customers().length,
      subscriptions: harness.data.debug.subscriptions().length,
    };
    harness.tick(9 * 24 * 3_600);
    await expirePaymentRecoveryWindows(harness);

    expect(harness.data.debug.allowances()).toHaveLength(before.allowances);
    expect(harness.data.debug.orders()).toHaveLength(before.orders);
    expect(harness.data.debug.customers()).toHaveLength(before.customers);
    expect(harness.data.debug.subscriptions()).toHaveLength(before.subscriptions);
  });

  it('BILL-199 the sweep is idempotent — a second pass finds nothing left to do', async () => {
    const harness = await intoWindow();
    harness.tick(8 * 24 * 3_600);
    await expirePaymentRecoveryWindows(harness);
    const second = await expirePaymentRecoveryWindows(harness);
    expect(second.suspended).toHaveLength(0);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('unpaid');
  });

  it('BILL-200 cancellation still works on day eight', async () => {
    const harness = await intoWindow();
    harness.tick(8 * 24 * 3_600);
    await expirePaymentRecoveryWindows(harness);

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(entitlementWithRecovery(stored, harness.at()).cancellationAvailable).toBe(true);

    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'unpaid',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
    });
    const result = await cancelSubscription(harness, { workspaceId: WS, when: 'immediately' });
    expect(result.providerStatus).toBe('canceled');
  });

  it('BILL-201 a stale event cannot resume a subscription the sweep has marked unpaid', async () => {
    const harness = await intoWindow();
    harness.tick(8 * 24 * 3_600);
    await expirePaymentRecoveryWindows(harness);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('unpaid');

    // An `active` event generated *before* the failure finally turns up.
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'active', currentPeriodEnd: PERIOD_END }),
        { created: 1_795_099_000 },
      ),
    );
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('unpaid');
    expect(entitlementWithRecovery(stored, harness.at()).admitsNewRuns).toBe(false);
  });

  it('BILL-202 a genuine later payment still resumes a suspended subscription', async () => {
    const harness = await intoWindow();
    harness.tick(8 * 24 * 3_600);
    await expirePaymentRecoveryWindows(harness);

    // The suspension kept the row's original provider timestamp, so real provider
    // evidence always outranks it.
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({
          workspaceId: WS,
          status: 'active',
          currentPeriodEnd: NEXT_PERIOD_END,
        }),
        { created: 1_795_900_000 },
      ),
    );
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('active');
    expect(paymentRecoveryWindow(stored, harness.at()).phase).toBe('serving');
  });

  it('BILL-203 the sweep never resurrects a cancelled subscription', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z' });
    await seedWorkspace(harness);
    await activate(harness);
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.deleted',
        subscriptionObject({ workspaceId: WS, status: 'canceled', currentPeriodEnd: PERIOD_END }),
        { created: 1_795_100_000 },
      ),
    );
    harness.tick(30 * 24 * 3_600);
    const report = await expirePaymentRecoveryWindows(harness);
    expect(report.suspended).toHaveLength(0);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('canceled');
  });

  it('BILL-204 the suspension notifies the billing contact when one is reachable', async () => {
    const harness = await intoWindow();
    harness.tick(8 * 24 * 3_600);
    const report = await expirePaymentRecoveryWindows(harness, {
      billingContact: async () => ({ email: 'owner@agency.example', workspaceName: 'Acme' }),
    });
    expect(report.notifications).toHaveLength(1);
    expect(report.notifications[0]?.vars.reasonSentence.toLowerCase()).toContain('unpaid');
    expect(report.notifications[0]?.notificationKey).toContain('payment_problem');
  });
});

describe('requirement 8 — the policy is visible before checkout', () => {
  it('BILL-205 the pre-checkout disclosure carries the window, the pauses and day eight', async () => {
    const harness = createHarness();
    const status = recoveryStatus(harness, null, harness.at());
    expect(status.policy.graceDays).toBe(harness.config.gracePeriodDays);
    expect(status.policy.whatPauses.join(' ')).toMatch(/new verification runs/i);
    expect(status.policy.afterWindow).toMatch(/unpaid/i);
    expect(status.window.phase).toBe('not_applicable');
    expect(status.cancellationAvailable).toBe(true);
  });

  it('BILL-206 the configured grace period is the one the window actually enforces', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:30:00.000Z', gracePeriodDays: 3 });
    await seedWorkspace(harness);
    await activate(harness);
    await failRenewal(harness, 1_795_100_000);

    harness.tick(2 * 24 * 3_600);
    expect((await expirePaymentRecoveryWindows(harness)).suspended).toHaveLength(0);
    harness.tick(2 * 24 * 3_600);
    expect((await expirePaymentRecoveryWindows(harness)).suspended).toHaveLength(1);
  });
});
