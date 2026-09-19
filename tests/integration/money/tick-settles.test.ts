/**
 * The loop closed: HTTP request in, cron tick out, and one unit of allowance settled.
 *
 * ## Why this file is separate from the route's own cases
 *
 * "Verify queued jobs and callbacks as well as browser requests." A test that POSTs an
 * event and reads the run row proves the door works. It does **not** prove the unit of
 * allowance it reserved ever converts to consumption, and that conversion — settled under
 * `YYYY-MM` against a row keyed `YYYY-MM-DD` — is the exact defect (A13-010) that made a
 * workspace at its limit report itself unblocked, forever.
 *
 * So these cases run both halves against one database:
 *
 *     POST /api/v1/events  ->  runs row, entitlements.reserved = 1
 *     runSchedulerTick()   ->  runs row terminal, entitlements.consumed = 1, reserved = 0
 *
 * and assert the allowance row by name. The harness anchor is `2026-10-05`, chosen so that
 * neither the run's date nor its calendar month is the correct key: if either side derives
 * a key instead of asking `billing/period.ts` for one, the counters do not move and these
 * go red.
 *
 * ## What the answer must be with no provider credential
 *
 * `UNVERIFIED`, and never `FAILED`. We hold no HubSpot or Resend credential, so we did not
 * look and cannot say. `FAILED` would be a claim about the customer's world made from our
 * own missing configuration — the precise dishonesty this product exists to argue against.
 * `BILL-352` pins it.
 *
 * Area risk: this is where a customer's paid run becomes a consumed unit. A settle that
 * misses leaks allowance silently; a settle that fires twice takes a unit that belongs to
 * a different run.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { D1BillingDataPort } from '@app/db/billingPort';
import { isAllowancePeriodKey } from '@app/billing/period';
import { NOT_CONNECTED_RESOLVER } from '@app/scheduler/credentials';
import { runSchedulerTick } from '@app/scheduler/tick';
import {
  ALLOWANCE_KEY,
  NOW,
  allowanceRow,
  createMoneyHarness,
  eventBody,
  postEvent,
  runRows,
  type MoneyHarness,
} from './harness';

let harness: MoneyHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/** The tick, wired the way `handleScheduled` wires it: billing read through the D1 port. */
async function tick(m: MoneyHarness, atIso: string = NOW) {
  return runSchedulerTick({
    db: m.h.db,
    now: new Date(atIso),
    resolver: NOT_CONNECTED_RESOLVER,
    // The scheduler holds a workspace and an instant, and nothing else about billing.
    billing: new D1BillingDataPort(m.h.db),
    billingEnvironment: 'test',
  });
}

describe('a signed event, then a cron tick', () => {
  it('BILL-350 the tick settles the very unit the request reserved, under the same key', async () => {
    harness = await createMoneyHarness();
    const m = harness;

    const accepted = await postEvent(m, eventBody(m.ws));
    expect(accepted.status).toBe(202);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 500,
      consumed: 0,
      reserved: 1,
    });

    // One minute later, the cron runs. Nothing else touches the database in between.
    const report = await tick(m, '2026-09-19T10:01:00.000Z');

    expect(report.error).toBeNull();
    expect(report.runs.claimed).toBe(1);
    expect(report.runs.terminal).toBe(1);

    // The unit moved. It did not vanish, and it was not taken twice.
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 500,
      consumed: 1,
      reserved: 0,
    });

    // And there is still exactly one allowance row: the settle found the row the
    // admission opened rather than opening a second one under a different spelling.
    const rows = m.h.raw
      .prepare('SELECT billing_period FROM entitlements WHERE workspace_id = ?')
      .all(m.ws.workspaceId) as { billing_period: string }[];
    expect(rows).toHaveLength(1);
    expect(isAllowancePeriodKey(rows[0]?.billing_period ?? '')).toBe(true);
  });

  it('BILL-351 the run reaches a terminal state and stops being scheduled', async () => {
    harness = await createMoneyHarness();
    const m = harness;
    await postEvent(m, eventBody(m.ws));

    await tick(m, '2026-09-19T10:01:00.000Z');

    const runs = runRows(m.h, m.ws.workspaceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).not.toBe('PENDING');
    // `next_check_at` null is what takes it out of the due-job sweep for good.
    expect(runs[0]?.next_check_at).toBeNull();
  });

  it('BILL-352 with no provider credential the answer is UNVERIFIED, never FAILED', async () => {
    harness = await createMoneyHarness();
    const m = harness;
    await postEvent(m, eventBody(m.ws));

    await tick(m, '2026-09-19T10:01:00.000Z');

    const runs = runRows(m.h, m.ws.workspaceId);
    // We did not look, so we cannot say. FAILED would be a claim about the customer's
    // world made from our own missing configuration.
    expect(runs[0]?.status).toBe('UNVERIFIED');
  });

  it('BILL-353 a second tick settles nothing a second time', async () => {
    harness = await createMoneyHarness();
    const m = harness;
    await postEvent(m, eventBody(m.ws));

    await tick(m, '2026-09-19T10:01:00.000Z');
    const afterFirst = allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY);

    const second = await tick(m, '2026-09-19T10:02:00.000Z');

    expect(second.runs.claimed).toBe(0);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual(afterFirst);
  });

  it('BILL-354 the outbox row the admission wrote is dispatched by the same tick', async () => {
    harness = await createMoneyHarness();
    const m = harness;
    await postEvent(m, eventBody(m.ws));

    const before = m.h.raw
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE dispatch_state = 'pending'")
      .get() as { n: number };
    expect(before.n).toBe(1);

    const report = await tick(m, '2026-09-19T10:01:00.000Z');
    expect(report.outbox.examined).toBeGreaterThan(0);
    expect(report.outbox.dispatched).toBeGreaterThan(0);
  });

  it('BILL-355 the allowance a full cycle consumed is what the next admission sees', async () => {
    harness = await createMoneyHarness({ runLimit: 2 });
    const m = harness;

    expect((await postEvent(m, eventBody(m.ws))).status).toBe(202);
    await tick(m, '2026-09-19T10:01:00.000Z');
    expect((await postEvent(m, eventBody(m.ws, { event_id: 'evt-000000002' }))).status).toBe(202);
    await tick(m, '2026-09-19T10:02:00.000Z');

    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 2,
      consumed: 2,
      reserved: 0,
    });

    // Both units are spent. The third event is refused about the period, not the account.
    const third = await postEvent(m, eventBody(m.ws, { event_id: 'evt-000000003' }));
    expect(third.status).toBe(429);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(2);
  });
});
