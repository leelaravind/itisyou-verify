/**
 * Day 8, the reconciliation, and the allowance repair — driven by one call.
 *
 * ## What was wrong
 *
 * `expirePaymentRecoveryWindows()` is correct and has eight passing cases. It had no
 * caller, so **day 8 never arrived**: a customer whose payment failed stayed paused
 * forever and their subscription was never marked `unpaid`. `reconcileSubscriptions()` is
 * correct and can resume a confirmed payment. It had no caller either, so the second half
 * of the promise in `policy.ts` — *"our scheduled check reading that payment back from the
 * provider's own records"* — was a published promise with nothing behind it.
 * `runBillingMaintenance()` was written to be the one call that fixed this, and it had no
 * caller.
 *
 * Four correct functions, zero callers. These cases assert the call, the cadence and the
 * **row it changes** — never the report alone.
 *
 * Area risk: this is the only thing that ends a payment-recovery window. Too eager and a
 * paying customer is suspended early; absent and a failed payment pauses a workspace
 * indefinitely with nobody deciding to.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { BillingGatewayPort } from '@app/billing/gateway';
import { runMoneyMaintenance, ALLOWANCE_REPAIR_EVERY_MINUTES } from '@app/money/maintenance';
import { ALLOWANCE_KEY, allowanceRows, createMoneyHarness, type MoneyHarness } from './harness';

let harness: MoneyHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/** Eight days after the payment failed. Past the seven-day window by a clear day. */
const DAY_EIGHT = '2026-09-27T11:07:00.000Z';
/** A minute divisible by neither 15 nor 30, and not the sweep minute. Nothing is due. */
const NOTHING_DUE = '2026-09-27T11:13:00.000Z';

function subscriptionRow(m: MoneyHarness): { status: string; updated_at: string } {
  return m.h.raw
    .prepare('SELECT status, updated_at FROM subscriptions WHERE workspace_id = ?')
    .get(m.ws.workspaceId) as { status: string; updated_at: string };
}

describe('the cron tick drives the money jobs', () => {
  it('BILL-370 day eight arrives: a past_due subscription is marked unpaid', async () => {
    harness = await createMoneyHarness({
      subscription: {
        status: 'past_due',
        // The window is anchored on the period END (`policy.ts` anchorFor), so this is the
        // renewal that failed. Seven days later is 2026-09-26; the sweep runs on the 27th.
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
    const m = harness;
    expect(subscriptionRow(m).status).toBe('past_due');

    const report = await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: DAY_EIGHT },
    );

    expect(report.billing.ranRecoverySweep).toBe(true);
    expect(report.billing.recoverySweep?.suspended).toHaveLength(1);
    // The row, read back. This is the fact the report is about.
    expect(subscriptionRow(m).status).toBe('unpaid');
  });

  it('BILL-371 day eight deletes nothing — the allowance and its consumption survive', async () => {
    harness = await createMoneyHarness({
      subscription: {
        status: 'past_due',
        // The window is anchored on the period END (`policy.ts` anchorFor), so this is the
        // renewal that failed. Seven days later is 2026-09-26; the sweep runs on the 27th.
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
    const m = harness;
    m.h.raw
      .prepare(
        'UPDATE entitlements SET consumed = 37 WHERE workspace_id = ? AND billing_period = ?',
      )
      .run(m.ws.workspaceId, ALLOWANCE_KEY);

    await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: DAY_EIGHT },
    );

    // Suspension is not deletion, and it is not a reset. Nothing is ever removed for
    // non-payment; the founder's requirement, asserted against the rows.
    const rows = allowanceRows(m.h, m.ws.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumed).toBe(37);
    expect(
      (
        m.h.raw
          .prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?')
          .get(m.ws.workspaceId) as { n: number }
      ).n,
    ).toBe(0);
  });

  it('BILL-372 a subscription inside the window is left exactly alone', async () => {
    harness = await createMoneyHarness({
      subscription: {
        // Period end on the 25th: the window runs to 2026-10-02, so the 27th is inside it.
        status: 'past_due',
        currentPeriodEnd: '2026-09-25T00:00:00.000Z',
        updatedAt: '2026-09-26T10:00:00.000Z',
      },
    });
    const m = harness;

    const report = await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: DAY_EIGHT },
    );

    expect(report.billing.recoverySweep?.inWindow).toBe(1);
    expect(report.billing.recoverySweep?.suspended).toHaveLength(0);
    expect(subscriptionRow(m).status).toBe('past_due');
  });

  it('BILL-373 the sweep is idempotent — a second tick suspends nothing again', async () => {
    harness = await createMoneyHarness({
      subscription: {
        status: 'past_due',
        // The window is anchored on the period END (`policy.ts` anchorFor), so this is the
        // renewal that failed. Seven days later is 2026-09-26; the sweep runs on the 27th.
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
    const m = harness;

    await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: DAY_EIGHT },
    );
    const afterFirst = subscriptionRow(m);
    const second = await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: '2026-09-27T12:07:00.000Z' },
    );

    expect(second.billing.recoverySweep?.suspended).toHaveLength(0);
    expect(subscriptionRow(m)).toEqual(afterFirst);
  });

  it('BILL-374 nothing due on an ordinary minute, and the report says which jobs skipped', async () => {
    harness = await createMoneyHarness({
      subscription: {
        status: 'past_due',
        // The window is anchored on the period END (`policy.ts` anchorFor), so this is the
        // renewal that failed. Seven days later is 2026-09-26; the sweep runs on the 27th.
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
    const m = harness;

    const report = await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: NOTHING_DUE },
    );

    expect(report.billing.ranRecoverySweep).toBe(false);
    expect(report.billing.ranReconciliation).toBe(false);
    expect(report.ranAllowanceRepair).toBe(false);
    expect(report.allowanceRepairSkipped).toBe('not_due');
    // And the subscription is untouched, because nothing ran.
    expect(subscriptionRow(m).status).toBe('past_due');
  });

  it('BILL-375 an absent repair port is reported, never treated as done', async () => {
    harness = await createMoneyHarness();
    const m = harness;

    const report = await runMoneyMaintenance({ billing: m.billing }, { now: DAY_EIGHT });

    expect(report.ranAllowanceRepair).toBe(false);
    // The distinction that matters: "we did not run it" rather than "there was nothing
    // to do". A deployment without the port still has damaged rows.
    expect(report.allowanceRepairSkipped).toBe('no_port');
  });

  it('BILL-376 the allowance repair runs on its own cadence and repairs a real row', async () => {
    harness = await createMoneyHarness();
    const m = harness;
    // A reservation stranded by the settle that missed, and no run to hold it.
    m.h.raw
      .prepare('UPDATE entitlements SET reserved = 4 WHERE workspace_id = ? AND billing_period = ?')
      .run(m.ws.workspaceId, ALLOWANCE_KEY);

    const at = `2026-09-27T11:${String(ALLOWANCE_REPAIR_EVERY_MINUTES).padStart(2, '0')}:00.000Z`;
    const report = await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: m.repair },
      { now: at },
    );

    expect(report.ranAllowanceRepair).toBe(true);
    expect(allowanceRows(m.h, m.ws.workspaceId)[0]?.reserved).toBe(0);
  });

  it('BILL-377 one job failing never stops the others', async () => {
    harness = await createMoneyHarness({
      subscription: {
        status: 'past_due',
        // The window is anchored on the period END (`policy.ts` anchorFor), so this is the
        // renewal that failed. Seven days later is 2026-09-26; the sweep runs on the 27th.
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
    const m = harness;

    const brokenRepair = {
      ...m.repair,
      listWorkspacesWithAllowanceRows: async (): Promise<readonly string[]> => {
        throw new Error('the repair port is unreachable');
      },
      currentPeriodEnd: m.repair.currentPeriodEnd.bind(m.repair),
      listAllowanceRows: m.repair.listAllowanceRows.bind(m.repair),
      listRunPeriodFacts: m.repair.listRunPeriodFacts.bind(m.repair),
      renameAllowancePeriod: m.repair.renameAllowancePeriod.bind(m.repair),
      mergeAllowancePeriod: m.repair.mergeAllowancePeriod.bind(m.repair),
      dropAllowanceRow: m.repair.dropAllowanceRow.bind(m.repair),
      setAllowanceCounters: m.repair.setAllowanceCounters.bind(m.repair),
    };

    const report = await runMoneyMaintenance(
      { billing: m.billing, allowanceRepair: brokenRepair },
      { now: DAY_EIGHT, force: true },
    );

    expect(report.failures.map((f) => f.job)).toContain('allowance_repair');
    // The customer-facing job still ran, which is the whole point of isolating them.
    expect(subscriptionRow(m).status).toBe('unpaid');
  });

  it('BILL-378 reconciliation runs on its cadence and reports what the provider said', async () => {
    harness = await createMoneyHarness({
      subscription: {
        status: 'past_due',
        // The window is anchored on the period END (`policy.ts` anchorFor), so this is the
        // renewal that failed. Seven days later is 2026-09-26; the sweep runs on the 27th.
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
    const m = harness;

    // A provider that says the subscription is being served. This is the only thing
    // permitted to resume a paused workspace besides a signed webhook.
    const gateway: Partial<BillingGatewayPort> = {
      retrieveSubscription: async (subscriptionId: string) => ({
        id: subscriptionId,
        status: 'active',
        customer: 'cus_test',
        cancel_at_period_end: false,
        livemode: false,
        items: {
          data: [
            {
              current_period_end: Math.floor(Date.parse('2026-10-05T00:00:00.000Z') / 1000),
              price: { id: 'price_test123' },
            },
          ],
        },
      }),
    };

    const report = await runMoneyMaintenance(
      {
        billing: { ...m.billing, gateway: gateway as BillingGatewayPort },
        allowanceRepair: m.repair,
      },
      { now: '2026-09-27T11:15:00.000Z' },
    );

    expect(report.billing.ranReconciliation).toBe(true);
    expect(report.billing.reconciliation?.examined).toBe(1);
    // Provider-confirmed payment: the subscription resumes, and it is listed rather than
    // merely counted, because a state change made by a background job must be accountable.
    expect(report.billing.reconciliation?.recovered).toHaveLength(1);
    expect(subscriptionRow(m).status).toBe('active');
  });
});
