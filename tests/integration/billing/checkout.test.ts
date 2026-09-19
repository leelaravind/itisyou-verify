/**
 * Checkout, the portal and the success URL.
 *
 * The rule under test throughout: arriving at the success URL proves nothing. The only
 * things that can make a workspace entitled are a signature-verified webhook and a read
 * against Stripe's own records.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import {
  checkoutIdempotencyKey,
  readCheckoutReturn,
  startCheckout,
  type CheckoutDeps,
} from '@app/billing/checkout';
import { cancelSubscription, openBillingPortal } from '@app/billing/portal';
import { entitlementFor } from '@app/billing/state';
import type { SubscriptionRecord } from '@app/billing/port';
import { createHarness, type BillingHarness } from './harness';

const WS = 'ws_customer_1';

function eligible(): CheckoutDeps['checkEligibility'] {
  return async () => ({ eligible: true });
}

function ineligible(reason: string, detail: string): CheckoutDeps['checkEligibility'] {
  return async () => ({ eligible: false, reason, detail });
}

function deps(harness: BillingHarness, check = eligible()): CheckoutDeps {
  return { ...harness, checkEligibility: check };
}

async function seedSubscription(
  harness: BillingHarness,
  overrides: Partial<SubscriptionRecord> = {},
): Promise<SubscriptionRecord> {
  return harness.data.saveSubscriptionSnapshot({
    id: 'sub_row_seed',
    workspaceId: WS,
    providerSubscriptionId: 'sub_live_1',
    environment: harness.config.environment,
    status: 'active',
    priceId: harness.config.priceId,
    currentPeriodEnd: '2026-10-19T09:00:00.000Z',
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    providerEventCreated: 1_800_000_000,
    updatedAt: harness.at(),
    ...overrides,
  });
}

describe('starting a checkout', () => {
  it('BILL-087 the price, currency and amount come from configuration, never from the caller', async () => {
    const harness = createHarness();
    const result = await startCheckout(deps(harness), { workspaceId: WS });
    expect(result.outcome).toBe('checkout_ready');
    if (result.outcome !== 'checkout_ready') throw new Error('unreachable');
    expect(result.order.priceId).toBe(harness.config.priceId);
    expect(result.order.amountMinor).toBe(LIMITS.PLAN_PRICE_PENCE);
    expect(result.order.currency).toBe('GBP');

    const created = harness.gateway.calls.find((call) => call.method === 'createCheckoutSession');
    expect(created?.params).toMatchObject({
      priceId: 'price_planv1stub',
      clientReferenceId: WS,
    });
  });

  it('BILL-088 a tampered payload has nothing to tamper with — extra fields are not read', async () => {
    const harness = createHarness();
    // A caller trying to force a price, an amount, a customer or a status. The function
    // signature accepts none of them; passing them changes nothing.
    const tampered = {
      workspaceId: WS,
      priceId: 'price_attacker_free',
      amountMinor: 1,
      currency: 'USD',
      customerId: 'cus_someone_else',
      subscriptionStatus: 'active',
      workspace_id: 'ws_victim',
    } as unknown as { workspaceId: string };

    const result = await startCheckout(deps(harness), tampered);
    expect(result.outcome).toBe('checkout_ready');
    if (result.outcome !== 'checkout_ready') throw new Error('unreachable');
    expect(result.order.amountMinor).toBe(LIMITS.PLAN_PRICE_PENCE);
    expect(result.order.currency).toBe('GBP');
    expect(result.order.priceId).toBe('price_planv1stub');
    expect(result.order.workspaceId).toBe(WS);

    const session = harness.gateway.calls.find((call) => call.method === 'createCheckoutSession');
    expect(session?.params).toMatchObject({
      priceId: 'price_planv1stub',
      customerId: 'cus_stub_1',
    });
    expect(JSON.stringify(session?.params)).not.toContain('price_attacker_free');
    expect(JSON.stringify(session?.params)).not.toContain('cus_someone_else');
  });

  it('BILL-089 an unsupported setup is rejected before payment with a reason the customer can act on', async () => {
    const harness = createHarness();
    const result = await startCheckout(
      deps(harness, ineligible('hubspot_not_connected', 'Connect HubSpot with read access first.')),
      { workspaceId: WS },
    );
    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('hubspot_not_connected');
    expect(result.detail).toBe('Connect HubSpot with read access first.');
    expect(result.order.status).toBe('rejected');
    // Nothing was created at the provider: no customer, no session.
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-090 fixing the setup lets the same order proceed to checkout', async () => {
    const harness = createHarness();
    await startCheckout(deps(harness, ineligible('hubspot_not_connected', 'x')), {
      workspaceId: WS,
    });
    harness.tick(60);
    const second = await startCheckout(deps(harness), { workspaceId: WS });
    expect(second.outcome).toBe('checkout_ready');
    if (second.outcome !== 'checkout_ready') throw new Error('unreachable');
    expect(second.order.status).toBe('checkout_created');
    // Same order row, reopened — not a second one.
    expect(harness.data.debug.orders()).toHaveLength(1);
  });

  it('BILL-091 a concurrent double checkout for one workspace produces one order and one session', async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([
      startCheckout(deps(harness), { workspaceId: WS }),
      startCheckout(deps(harness), { workspaceId: WS }),
    ]);
    expect(first.outcome).toBe('checkout_ready');
    expect(second.outcome).toBe('checkout_ready');
    expect(harness.data.debug.orders()).toHaveLength(1);
    expect(harness.data.debug.customers()).toHaveLength(1);

    const keys = new Set(
      harness.gateway.calls
        .filter((call) => call.method === 'createCheckoutSession')
        .map((call) => (call.params as { idempotencyKey: string }).idempotencyKey),
    );
    // One idempotency key means Stripe returns one session, so one subscription.
    expect(keys.size).toBe(1);
  });

  it('BILL-092 the checkout idempotency key is stable across attempts and scoped to the plan version', () => {
    expect(checkoutIdempotencyKey(WS, 1)).toBe(checkoutIdempotencyKey(WS, 1));
    expect(checkoutIdempotencyKey(WS, 1)).not.toBe(checkoutIdempotencyKey(WS, 2));
    expect(checkoutIdempotencyKey(WS, 1)).not.toBe(checkoutIdempotencyKey('ws_other', 1));
  });

  it('BILL-093 a workspace that is already served is not sold a second subscription', async () => {
    const harness = createHarness();
    await seedSubscription(harness);
    const result = await startCheckout(deps(harness), { workspaceId: WS });
    expect(result.outcome).toBe('already_subscribed');
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-094 a workspace is bound to exactly one Stripe customer, ever', async () => {
    const harness = createHarness();
    await startCheckout(deps(harness), { workspaceId: WS });
    harness.tick(3_600);
    await startCheckout(deps(harness), { workspaceId: WS });
    const createdCustomers = harness.gateway.calls.filter(
      (call) => call.method === 'createCustomer',
    );
    expect(createdCustomers).toHaveLength(1);
    expect(harness.data.debug.customers()).toHaveLength(1);
  });
});

describe('the success URL', () => {
  it('BILL-095 hitting the success URL alone leaves the workspace inactive', async () => {
    const harness = createHarness();
    const started = await startCheckout(deps(harness), { workspaceId: WS });
    expect(started.outcome).toBe('checkout_ready');

    // The customer is redirected back. No webhook has arrived.
    const view = await readCheckoutReturn(harness, { workspaceId: WS });
    expect(view.entitlement.level).toBe('not_entitled');
    expect(view.entitlement.admitsNewRuns).toBe(false);
    expect(view.awaitingConfirmation).toBe(true);
    expect(view.orderStatus).toBe('checkout_created');

    // And nothing was written by looking.
    const subscription = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(subscription).toBeNull();
    expect(entitlementFor(subscription).admitsNewRuns).toBe(false);
  });

  it('BILL-096 replaying the success URL many times still activates nothing', async () => {
    const harness = createHarness();
    await startCheckout(deps(harness), { workspaceId: WS });
    for (let i = 0; i < 5; i += 1) {
      harness.tick(1);
      const view = await readCheckoutReturn(harness, { workspaceId: WS });
      expect(view.entitlement.admitsNewRuns).toBe(false);
    }
    expect(harness.data.debug.subscriptions()).toHaveLength(0);
    expect(harness.data.debug.allowances()).toHaveLength(0);
  });

  it('BILL-097 once a verified webhook has activated the subscription the same page reads as active', async () => {
    const harness = createHarness();
    await startCheckout(deps(harness), { workspaceId: WS });
    await seedSubscription(harness);
    const view = await readCheckoutReturn(harness, { workspaceId: WS });
    expect(view.entitlement.level).toBe('serving');
    expect(view.awaitingConfirmation).toBe(false);
  });
});

describe('the billing portal and cancellation', () => {
  it('BILL-098 the portal link is built from our own binding, not a caller-supplied customer id', async () => {
    const harness = createHarness();
    await startCheckout(deps(harness), { workspaceId: WS });
    const result = await openBillingPortal(harness, { workspaceId: WS });
    expect(result.portalUrl).toContain('billing.stripe.com');
    const call = harness.gateway.calls.find(
      (entry) => entry.method === 'createBillingPortalSession',
    );
    expect(call?.params).toMatchObject({ customerId: 'cus_stub_1' });
  });

  it('BILL-099 a workspace with no billing account cannot open a portal session', async () => {
    const harness = createHarness();
    await expect(openBillingPortal(harness, { workspaceId: WS })).rejects.toThrow(
      /no billing account/,
    );
  });

  it('BILL-100 cancelling at period end keeps the customer served for what they paid for', async () => {
    const harness = createHarness();
    await seedSubscription(harness);
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
    });
    const result = await cancelSubscription(harness, { workspaceId: WS });
    expect(result.requested).toBe('period_end');
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.servedUntil).toBe('2026-10-19T09:00:00.000Z');
    // Our stored state is not changed here — the webhook does that, through the guards.
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('active');
    expect(stored?.cancelAtPeriodEnd).toBe(false);
  });

  it('BILL-101 cancelling immediately does not itself refund anything', async () => {
    const harness = createHarness();
    await seedSubscription(harness);
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
    });
    const result = await cancelSubscription(harness, { workspaceId: WS, when: 'immediately' });
    expect(result.providerStatus).toBe('canceled');
    expect(result.note).toContain('does not itself issue a refund');
    expect(harness.gateway.calls.some((call) => call.method === 'createRefund')).toBe(false);
    expect(harness.data.debug.refunds()).toHaveLength(0);
  });

  it('BILL-102 cancelling an already cancelled subscription sends nothing to Stripe', async () => {
    const harness = createHarness();
    await seedSubscription(harness, { status: 'canceled' });
    const result = await cancelSubscription(harness, { workspaceId: WS });
    expect(result.providerStatus).toBe('canceled');
    expect(
      harness.gateway.calls.filter((call) => call.method === 'cancelSubscription'),
    ).toHaveLength(0);
  });

  it('BILL-103 a past_due customer can still reach the portal and cancel', async () => {
    const harness = createHarness();
    await startCheckout(deps(harness), { workspaceId: WS });
    const stored = await seedSubscription(harness, { status: 'past_due' });
    expect(entitlementFor(stored).cancellationAvailable).toBe(true);
    const portal = await openBillingPortal(harness, { workspaceId: WS });
    expect(portal.entitlement.level).toBe('paused_payment');
    expect(portal.portalUrl).toContain('billing.stripe.com');
  });
});
