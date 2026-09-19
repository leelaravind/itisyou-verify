/**
 * The gap between "tested" and "working".
 *
 * The payment-recovery logic was correct and exhaustively covered, and no request path
 * consulted it, nothing invoked the day-8 sweep, and reconciliation could only ever detect.
 * The logic tests all passed. This file tests the parts that make the logic reachable: the
 * admission gate a route calls, the scheduler entry point a tick calls, and the one repair
 * reconciliation is allowed to perform.
 */
import { describe, expect, it } from 'vitest';
import { checkAdmission } from '@app/billing/admission';
import { allowancePeriodKeyAt } from '@app/billing/period';
import { reconcileSubscriptions } from '@app/billing/reconcile';
import {
  RECONCILE_EVERY_MINUTES,
  RECOVERY_SWEEP_MINUTE,
  maintenanceNotifications,
  runBillingMaintenance,
} from '@app/billing/scheduled';
import type { SubscriptionRecord } from '@app/billing/port';
import { createHarness, type BillingHarness } from './harness';

const WS = 'ws_customer_1';
/** Subscribed on the 19th, so the period ends on the 19th — never the 1st. */
const PERIOD_END = '2026-10-19T09:00:00.000Z';
const PERIOD_KEY = '2026-10-19';

async function subscribe(
  harness: BillingHarness,
  overrides: Partial<SubscriptionRecord> = {},
): Promise<SubscriptionRecord> {
  return harness.data.saveSubscriptionSnapshot({
    id: 'sub_row_1',
    workspaceId: WS,
    providerSubscriptionId: 'sub_live_1',
    environment: 'test',
    status: 'active',
    priceId: harness.config.priceId,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    latestPaymentIntentId: null,
    latestPaymentPeriodEnd: null,
    providerEventCreated: 1_795_000_000,
    updatedAt: harness.at(),
    ...overrides,
  });
}

async function openAllowance(
  harness: BillingHarness,
  counters: { consumed?: number; reserved?: number; runLimit?: number } = {},
): Promise<void> {
  await harness.data.openAllowancePeriod({
    id: 'ent_0001',
    workspaceId: WS,
    billingPeriod: PERIOD_KEY,
    planVersion: 1,
    runLimit: counters.runLimit ?? 500,
    consumed: counters.consumed ?? 0,
    reserved: counters.reserved ?? 0,
    updatedAt: harness.at(),
  });
}

describe('PR2 the admission gate a route actually calls', () => {
  it('BILL-262 a served workspace with allowance is admitted, reserves, and gets the one true period key', async () => {
    const harness = createHarness();
    await subscribe(harness);
    await openAllowance(harness);

    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict).toMatchObject({ admit: true, reserves: true, httpStatus: 200 });
    // The key comes from period.ts, so the admission side cannot invent its own spelling.
    expect(verdict.billingPeriod).toBe(allowancePeriodKeyAt(harness.at(), PERIOD_END));
    expect(verdict.billingPeriod).toBe(PERIOD_KEY);
  });

  it('BILL-263 a failed renewal pauses new runs at the gate, with words the customer can act on', async () => {
    // PR-2. This is the case that had no caller: the logic said paused, and every route
    // accepted work anyway.
    const harness = createHarness();
    await subscribe(harness, { status: 'past_due', currentPeriodEnd: '2026-09-19T09:00:00.000Z' });
    await openAllowance(harness);

    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict.admit).toBe(false);
    expect(verdict.refusal).toBe('payment_paused');
    expect(verdict.httpStatus).toBe(402);
    expect(verdict.customerMessage.toLowerCase()).toContain('paused checking new runs');
    expect(verdict.retryAfterIso).toBe('2026-09-26T09:00:00.000Z');
  });

  it('BILL-264 after day eight the gate still refuses, and still says nothing was deleted', async () => {
    const harness = createHarness();
    await subscribe(harness, { status: 'unpaid', currentPeriodEnd: '2026-09-19T09:00:00.000Z' });
    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict.admit).toBe(false);
    expect(verdict.httpStatus).toBe(402);
    expect(verdict.customerMessage.toLowerCase()).toContain('nothing has been deleted');
  });

  it('BILL-265 a retry, a provider callback and internal recovery are admitted even while paused', async () => {
    // The money rule that must hold at the entitlement level too: these belong to a unit
    // already paid for. Refusing them would strand work the customer was charged for.
    const harness = createHarness();
    await subscribe(harness, { status: 'past_due' });
    await openAllowance(harness);

    for (const kind of ['queue_retry', 'provider_callback', 'internal_recovery'] as const) {
      const verdict = await checkAdmission(harness, { workspaceId: WS, kind });
      expect(verdict.admit, kind).toBe(true);
      expect(verdict.reserves, kind).toBe(false);
      expect(verdict.billingPeriod, kind).toBe(PERIOD_KEY);
    }
  });

  it('BILL-266 a workspace at its allowance is refused with 429 and the period end to retry after', async () => {
    const harness = createHarness();
    await subscribe(harness);
    await openAllowance(harness, { runLimit: 500, consumed: 499, reserved: 1 });

    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict).toMatchObject({
      admit: false,
      refusal: 'at_allowance',
      httpStatus: 429,
      retryAfterIso: PERIOD_END,
    });
    expect(verdict.customerMessage).toContain('500 runs');
    expect(verdict.customerMessage.toLowerCase()).toContain('not been charged anything extra');
  });

  it('BILL-267 a workspace with no subscription is refused before any allowance is looked for', async () => {
    const harness = createHarness();
    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict).toMatchObject({
      admit: false,
      refusal: 'not_subscribed',
      httpStatus: 402,
      billingPeriod: null,
    });
  });

  it('BILL-268 a cancelled subscription is refused as inactive, not as a payment problem', async () => {
    const harness = createHarness();
    await subscribe(harness, { status: 'canceled' });
    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict.admit).toBe(false);
    expect(verdict.refusal).toBe('subscription_inactive');
  });

  it('BILL-269 a served workspace whose allowance row is missing is our fault, not their limit', async () => {
    const harness = createHarness();
    await subscribe(harness);
    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict).toMatchObject({
      admit: false,
      refusal: 'no_allowance_period',
      httpStatus: 409,
    });
    // Never blamed on the customer's usage.
    expect(verdict.customerMessage.toLowerCase()).not.toContain('used');
    expect(verdict.customerMessage.toLowerCase()).toContain('contact support');
  });

  it('BILL-270 the gate reserves nothing — the atomic reservation is still admitOnce’s job', async () => {
    const harness = createHarness();
    await subscribe(harness);
    await openAllowance(harness);
    await checkAdmission(harness, { workspaceId: WS });
    await checkAdmission(harness, { workspaceId: WS });
    expect(harness.data.debug.allowances()[0]).toMatchObject({ consumed: 0, reserved: 0 });
  });
});

describe('PR4 reconciliation can actually resume', () => {
  function providerSays(harness: BillingHarness, status: string): void {
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status,
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
      items: {
        data: [
          {
            current_period_end: Math.floor(Date.parse(PERIOD_END) / 1000),
            price: { id: harness.config.priceId },
          },
        ],
      },
    });
  }

  it('BILL-271 a payment confirmed against Stripe’s own records resumes verification', async () => {
    // The promise in PAYMENT_RECOVERY_POLICY.resumeRequires, made real. Before this,
    // reconciliation could only ever write a timestamp.
    const harness = createHarness();
    await subscribe(harness, { status: 'past_due' });
    providerSays(harness, 'active');

    const report = await reconcileSubscriptions(harness);
    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0]).toMatchObject({ workspaceId: WS, from: 'past_due', to: 'active' });

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('active');
    // And the workspace can take work again, through the gate a route calls.
    expect((await checkAdmission(harness, { workspaceId: WS })).admit).toBe(true);
  });

  it('BILL-272 resuming opens the period’s allowance without handing out a second one', async () => {
    const harness = createHarness();
    await subscribe(harness, { status: 'past_due' });
    await openAllowance(harness, { consumed: 12, reserved: 1 });
    providerSays(harness, 'active');

    const report = await reconcileSubscriptions(harness);
    // Assert the recovery actually happened first — otherwise this case passes vacuously
    // when nothing is recovered, which is exactly how it passed while BILL-271 failed.
    expect(report.recovered).toHaveLength(1);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');

    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(1);
    // Resumed on the allowance they already had, with what they had used still used.
    expect(allowances[0]).toMatchObject({ consumed: 12, reserved: 1, runLimit: 500 });
  });

  it('BILL-273 drift the other way is reported and never applied', async () => {
    // We hold `active`, Stripe says `past_due`. That direction stays report-only: a
    // webhook we mishandled must stay visible rather than be papered over by a job.
    const harness = createHarness();
    await subscribe(harness, { status: 'active' });
    await openAllowance(harness);
    providerSays(harness, 'past_due');

    const report = await reconcileSubscriptions(harness);
    expect(report.recovered).toHaveLength(0);
    expect(report.discrepancies.map((d) => d.kind)).toContain('status_mismatch');
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');
  });

  it('BILL-274 a cancelled subscription is never resurrected, whatever Stripe answers', async () => {
    const harness = createHarness();
    await subscribe(harness, { status: 'canceled' });
    providerSays(harness, 'active');

    const report = await reconcileSubscriptions(harness);
    expect(report.recovered).toHaveLength(0);
    expect(report.discrepancies.map((d) => d.kind)).toContain('status_mismatch');
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('canceled');
  });

  it('BILL-275 a dry run reports the recovery without applying it', async () => {
    const harness = createHarness();
    await subscribe(harness, { status: 'past_due' });
    providerSays(harness, 'active');

    const report = await reconcileSubscriptions(harness, { applyPaymentRecovery: false });
    expect(report.recovered).toHaveLength(0);
    expect(report.discrepancies.map((d) => d.kind)).toContain('status_mismatch');
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('past_due');
  });
});

describe('PR6 the tick that makes day eight arrive', () => {
  it('BILL-276 the sweep runs on its minute and not on others', async () => {
    const harness = createHarness({ startAt: `2026-09-19T09:0${RECOVERY_SWEEP_MINUTE}:00.000Z` });
    const onMinute = await runBillingMaintenance(harness);
    expect(onMinute.ranRecoverySweep).toBe(true);

    const offMinute = await runBillingMaintenance(harness, {
      now: '2026-09-19T09:08:00.000Z',
    });
    expect(offMinute.ranRecoverySweep).toBe(false);
    expect(offMinute.recoverySweep).toBeNull();
  });

  it('BILL-277 reconciliation runs on its quarter-hour and not between', async () => {
    const harness = createHarness();
    for (const minute of [0, RECONCILE_EVERY_MINUTES, 30, 45]) {
      const report = await runBillingMaintenance(harness, {
        now: `2026-09-19T09:${String(minute).padStart(2, '0')}:00.000Z`,
      });
      expect(report.ranReconciliation, String(minute)).toBe(true);
    }
    const between = await runBillingMaintenance(harness, { now: '2026-09-19T09:08:00.000Z' });
    expect(between.ranReconciliation).toBe(false);
  });

  it('BILL-278 the tick actually suspends a subscription whose window ran out', async () => {
    // PR-6 end to end: without a caller, day 8 never arrived however correct the sweep was.
    const harness = createHarness({ startAt: '2026-09-19T09:00:00.000Z' });
    await subscribe(harness, { status: 'past_due', currentPeriodEnd: '2026-09-19T09:00:00.000Z' });

    harness.tick(8 * 24 * 3_600);
    const report = await runBillingMaintenance(harness, { force: true });

    expect(report.recoverySweep?.suspended).toHaveLength(1);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('unpaid');
    // Still refused at the gate, still not cancelled, still nothing deleted.
    const verdict = await checkAdmission(harness, { workspaceId: WS });
    expect(verdict.admit).toBe(false);
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
  });

  it('BILL-279 one job failing never stops the other, and the tick never throws', async () => {
    // A cron tick that throws takes every other job in the same tick with it.
    const harness = createHarness();
    const broken = {
      ...harness,
      data: {
        ...harness.data,
        async listSubscriptionsForReconciliation() {
          throw new Error('D1 unavailable');
        },
      },
    };
    const report = await runBillingMaintenance(broken, { force: true });
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.map((f) => f.job).sort()).toEqual([
      'payment_recovery_sweep',
      'subscription_reconciliation',
    ]);
    expect(report.at).toBeTruthy();
  });

  it('BILL-280 the tick hands the scheduler the notifications to enqueue rather than sending them', async () => {
    const harness = createHarness({ startAt: '2026-09-19T09:00:00.000Z' });
    await subscribe(harness, { status: 'past_due', currentPeriodEnd: '2026-09-19T09:00:00.000Z' });
    harness.tick(8 * 24 * 3_600);

    const withContact = {
      ...harness,
      billingContact: async () => ({ email: 'owner@agency.example', workspaceName: 'Acme' }),
    };
    const report = await runBillingMaintenance(withContact, { force: true });
    const notifications = maintenanceNotifications(report);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.template).toBe('payment_problem');
    // Building one sends nothing.
    expect(notifications[0]?.recipientEmail).toBe('owner@agency.example');
  });

  it('BILL-281 a workspace that pays is resumed by the tick, not only by a webhook', async () => {
    // PR-4's second route, end to end through the scheduler entry point.
    const harness = createHarness();
    await subscribe(harness, { status: 'past_due' });
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
      items: {
        data: [
          {
            current_period_end: Math.floor(Date.parse(PERIOD_END) / 1000),
            price: { id: harness.config.priceId },
          },
        ],
      },
    });

    expect((await checkAdmission(harness, { workspaceId: WS })).admit).toBe(false);
    const report = await runBillingMaintenance(harness, { force: true });
    expect(report.reconciliation?.recovered).toHaveLength(1);
    expect((await checkAdmission(harness, { workspaceId: WS })).admit).toBe(true);
  });
});
