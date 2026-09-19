/**
 * Scheduled reconciliation.
 *
 * The point of these cases is what reconciliation does *not* do: it never rewrites a
 * status to match Stripe. Silent repair would hide the webhook bug that caused the drift,
 * and — for a cancelled subscription — would be the resurrection the whole design exists
 * to prevent.
 */
import { describe, expect, it } from 'vitest';
import { reconcileSubscriptions } from '@app/billing/reconcile';
import type { SubscriptionRecord } from '@app/billing/port';
import { createHarness, type BillingHarness } from './harness';

const WS = 'ws_customer_1';

async function stored(
  harness: BillingHarness,
  overrides: Partial<SubscriptionRecord> = {},
): Promise<SubscriptionRecord> {
  return harness.data.saveSubscriptionSnapshot({
    id: 'sub_row_1',
    workspaceId: WS,
    providerSubscriptionId: 'sub_live_1',
    environment: 'test',
    status: 'active',
    priceId: 'price_planv1stub',
    currentPeriodEnd: '2026-10-19T09:00:00.000Z',
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    providerEventCreated: 1_798_000_000,
    updatedAt: harness.at(),
    ...overrides,
  });
}

/** 2026-10-19T09:00:00Z as unix seconds, so provider and stored agree exactly. */
const PERIOD_END_UNIX = Math.floor(Date.parse('2026-10-19T09:00:00.000Z') / 1000);

function providerSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_live_1',
    status: 'active',
    customer: 'cus_stub_1',
    cancel_at_period_end: false,
    livemode: false,
    items: { data: [{ current_period_end: PERIOD_END_UNIX, price: { id: 'price_planv1stub' } }] },
    ...overrides,
  };
}

/**
 * The allowance period is keyed by the date the paid period **ends**, which is the only
 * value both `customer.subscription.*` and `invoice.paid` report exactly.
 */
async function openAllowance(harness: BillingHarness): Promise<void> {
  await harness.data.openAllowancePeriod({
    id: 'ent_0001',
    workspaceId: WS,
    billingPeriod: '2026-10-19',
    planVersion: 1,
    runLimit: 500,
    consumed: 0,
    reserved: 0,
    updatedAt: harness.at(),
  });
}

describe('reconciliation', () => {
  it('BILL-150 agreement produces no discrepancies and stamps the row as reconciled', async () => {
    const harness = createHarness();
    await stored(harness);
    await openAllowance(harness);
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription());

    const report = await reconcileSubscriptions(harness);
    expect(report).toMatchObject({ examined: 1, agreed: 1, unreadable: 0 });
    expect(report.discrepancies).toHaveLength(0);
    expect(harness.data.debug.subscriptions()[0]?.reconciledAt).toBe(report.checkedAt);
  });

  it('BILL-151 a status difference is reported and our stored status is left alone', async () => {
    const harness = createHarness();
    await stored(harness, { status: 'active' });
    await openAllowance(harness);
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription({ status: 'past_due' }));

    const report = await reconcileSubscriptions(harness);
    expect(report.agreed).toBe(0);
    expect(report.discrepancies.map((entry) => entry.kind)).toContain('status_mismatch');
    const drift = report.discrepancies.find((entry) => entry.kind === 'status_mismatch');
    expect(drift).toMatchObject({ ours: 'active', theirs: 'past_due', workspaceId: WS });
    // Nothing was repaired.
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');
  });

  it('BILL-152 a cancelled subscription that Stripe reports as active is reported, never resurrected', async () => {
    const harness = createHarness();
    await stored(harness, { status: 'canceled' });
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription({ status: 'active' }));

    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.some((entry) => entry.kind === 'status_mismatch')).toBe(true);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('canceled');
  });

  it('BILL-153 a subscription Stripe no longer returns is reported as missing, not deleted', async () => {
    const harness = createHarness();
    await stored(harness);
    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.map((entry) => entry.kind)).toEqual(['missing_at_provider']);
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
  });

  it('BILL-154 a provider read failure counts as unreadable, not as drift in our data', async () => {
    const harness = createHarness();
    await stored(harness);
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription());
    harness.gateway.failNext(
      'retrieveSubscription',
      Object.assign(new Error('rate limited'), { kind: 'rate_limited' }),
    );

    const report = await reconcileSubscriptions(harness);
    expect(report.unreadable).toBe(1);
    expect(report.agreed).toBe(0);
    expect(report.discrepancies[0]?.kind).toBe('provider_unreadable');
  });

  it('BILL-155 a cancellation the customer made in the portal shows up as drift', async () => {
    const harness = createHarness();
    await stored(harness, { cancelAtPeriodEnd: false });
    await openAllowance(harness);
    harness.gateway.subscriptions.set(
      'sub_live_1',
      providerSubscription({ cancel_at_period_end: true }),
    );

    const report = await reconcileSubscriptions(harness);
    const drift = report.discrepancies.find(
      (entry) => entry.kind === 'cancel_at_period_end_mismatch',
    );
    expect(drift).toMatchObject({ ours: 'false', theirs: 'true' });
    expect(drift?.note).toContain('renews');
  });

  it('BILL-156 a price change made in the dashboard is reported', async () => {
    const harness = createHarness();
    await stored(harness);
    await openAllowance(harness);
    harness.gateway.subscriptions.set(
      'sub_live_1',
      providerSubscription({
        items: { data: [{ current_period_end: PERIOD_END_UNIX, price: { id: 'price_other' } }] },
      }),
    );

    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.map((entry) => entry.kind)).toContain('price_mismatch');
  });

  it('BILL-157 a served workspace with no allowance row for the period is reported', async () => {
    const harness = createHarness();
    await stored(harness);
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription());

    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.map((entry) => entry.kind)).toContain('allowance_period_missing');
    // Reported, not silently opened.
    expect(harness.data.debug.allowances()).toHaveLength(0);
  });

  it('BILL-158 a live-mode object returned for a test-mode row is reported as a configuration fault', async () => {
    const harness = createHarness();
    await stored(harness, { environment: 'test' });
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription({ livemode: true }));

    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.map((entry) => entry.kind)).toEqual(['environment_mismatch']);
  });

  it('BILL-159 every discrepancy carries a plain-language note an owner can act on', async () => {
    const harness = createHarness();
    await stored(harness);
    harness.gateway.subscriptions.set('sub_live_1', providerSubscription({ status: 'unpaid' }));

    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.length).toBeGreaterThan(0);
    for (const entry of report.discrepancies) {
      expect(entry.note.length).toBeGreaterThan(20);
      expect(entry.workspaceId).toBe(WS);
      expect(entry.providerSubscriptionId).toBe('sub_live_1');
    }
  });
});
