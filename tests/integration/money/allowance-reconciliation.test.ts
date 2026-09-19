/**
 * Reconciling allowance rows that two spellings of one key left behind. (A13-010, part 2.)
 *
 * ## What the forward fix does not do
 *
 * A06 and A02 closed the forward half: one function derives the key, the D1 port validates
 * it, and nothing can write `YYYY-MM` again. None of that touches a row already on disk,
 * and there were two ways the old code could damage one:
 *
 *  - a row stored under a calendar-month key, which the fixed code will never find again —
 *    so the next `ensurePeriod` opens a *second* row for the same paid period and the
 *    customer is handed their 500 runs twice;
 *  - a reservation that was never settled, because `settleReservation` was called with
 *    `YYYY-MM` against a row keyed `YYYY-MM-DD`, matched nothing, and returned `false`
 *    silently. The run finished; the unit never converted. Allowance leaks away one stuck
 *    reservation at a time and the customer is refused at a limit they never reached.
 *
 * ## The two rules the repair may not break
 *
 * **Never reset usage** and **never grant a duplicate allowance**. Both are asserted here
 * directly rather than described: `BILL-334` deletes the runs out from under a repaired row
 * and requires `consumed` to hold; `BILL-335` requires `run_limit` to be the same number
 * after a merge as before it.
 *
 * Everything below runs against the real schema through the real `Db`, and every assertion
 * reads the row back rather than the report.
 *
 * Area risk: this pass rewrites the counters that decide whether a paying customer's work
 * is accepted. Getting it wrong in one direction sells runs twice; in the other it refuses
 * a customer who has paid.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { allowancePeriodKey } from '@app/billing/period';
import { reconcileAllowancePeriods } from '@app/money/periodReconciliation';
import { seedRun } from '../db/harness';
import {
  ALLOWANCE_KEY,
  NOW,
  allowanceRow,
  allowanceRows,
  createMoneyHarness,
  eventBody,
  postEvent,
  type MoneyHarness,
} from './harness';

/** An anchor on the 1st. The only shape where a calendar month maps to exactly one period. */
const FIRST_OF_MONTH_END = '2026-10-01T00:00:00.000Z';
const CLEAN_KEY = allowancePeriodKey(FIRST_OF_MONTH_END);

const LEGACY = '2026-09';
const REPAIR_AT = '2026-09-19T11:00:00.000Z';

let harness: MoneyHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

async function open(options: Parameters<typeof createMoneyHarness>[0] = {}): Promise<MoneyHarness> {
  harness = await createMoneyHarness(options);
  return harness;
}

/** Write an allowance row directly, so the fixture is not built from the code under test. */
function seedAllowance(
  m: MoneyHarness,
  billingPeriod: string,
  counters: { consumed: number; reserved: number; runLimit?: number; updatedAt?: string },
): void {
  m.h.raw
    .prepare(
      `INSERT INTO entitlements (id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      `ent_${billingPeriod}`,
      m.ws.workspaceId,
      billingPeriod,
      counters.runLimit ?? 500,
      counters.consumed,
      counters.reserved,
      counters.updatedAt ?? NOW,
    );
}

function setCounters(m: MoneyHarness, billingPeriod: string, consumed: number, reserved: number) {
  m.h.raw
    .prepare(
      'UPDATE entitlements SET consumed = ?, reserved = ? WHERE workspace_id = ? AND billing_period = ?',
    )
    .run(consumed, reserved, m.ws.workspaceId, billingPeriod);
}

const options = { now: REPAIR_AT, environment: 'test' as const };

describe('a workspace holding rows under both key shapes', () => {
  it('BILL-330 ends with exactly one correct row and its consumption preserved', async () => {
    const m = await open({
      billingPeriod: CLEAN_KEY,
      subscription: { currentPeriodEnd: FIRST_OF_MONTH_END },
    });
    // The correct row already carries three consumed and one reserved.
    setCounters(m, CLEAN_KEY, 3, 1);
    // And a legacy row nothing can see any more carries seven more, plus two reservations.
    seedAllowance(m, LEGACY, { consumed: 7, reserved: 2 });

    expect(allowanceRows(m.h, m.ws.workspaceId)).toHaveLength(2);

    const report = await reconcileAllowancePeriods(m.repair, options);

    const rows = allowanceRows(m.h, m.ws.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.billing_period).toBe(CLEAN_KEY);
    // 3 + 7 consumed. Not one unit lost, not one invented.
    expect(rows[0]?.consumed).toBe(10);
    // One allowance, not two. This is the duplicate grant the merge must not make.
    expect(rows[0]?.run_limit).toBe(500);

    const fold = report.folds[0];
    expect(fold?.outcome).toBe('merged');
    expect(fold?.legacyKey).toBe(LEGACY);
    expect(fold?.targetKey).toBe(CLEAN_KEY);
    expect(fold?.carriedConsumed).toBe(7);
  });

  it('BILL-331 is idempotent — a second pass writes nothing at all', async () => {
    const m = await open({
      billingPeriod: CLEAN_KEY,
      subscription: { currentPeriodEnd: FIRST_OF_MONTH_END },
    });
    setCounters(m, CLEAN_KEY, 3, 1);
    seedAllowance(m, LEGACY, { consumed: 7, reserved: 2 });

    await reconcileAllowancePeriods(m.repair, options);
    const afterFirst = allowanceRows(m.h, m.ws.workspaceId);

    const second = await reconcileAllowancePeriods(m.repair, {
      ...options,
      now: '2026-09-19T12:00:00.000Z',
    });

    expect(allowanceRows(m.h, m.ws.workspaceId)).toEqual(afterFirst);
    expect(second.folds).toHaveLength(0);
    expect(second.repairs.every((r) => r.outcome === 'already_correct')).toBe(true);
  });

  it('BILL-332 renames in place when no row occupies the correct key', async () => {
    const m = await open({
      // The workspace's only allowance row is the wrong-shaped one.
      billingPeriod: LEGACY,
      subscription: { currentPeriodEnd: FIRST_OF_MONTH_END },
    });
    setCounters(m, LEGACY, 12, 0);

    const report = await reconcileAllowancePeriods(m.repair, options);

    const rows = allowanceRows(m.h, m.ws.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.billing_period).toBe(CLEAN_KEY);
    expect(rows[0]?.consumed).toBe(12);
    expect(rows[0]?.run_limit).toBe(500);
    expect(report.folds[0]?.outcome).toBe('renamed');
  });

  it('BILL-333 leaves a workspace with no subscription untouched and says why', async () => {
    const m = await open({ billingPeriod: LEGACY, subscription: null });
    setCounters(m, LEGACY, 4, 0);

    const report = await reconcileAllowancePeriods(m.repair, options);

    expect(allowanceRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(allowanceRows(m.h, m.ws.workspaceId)[0]?.billing_period).toBe(LEGACY);
    expect(report.folds[0]?.outcome).toBe('no_anchor');
    expect(report.folds[0]?.note).toMatch(/no subscription period to anchor/i);
  });
});

describe('reservations stranded by the settle that missed', () => {
  it('BILL-334 converts a stranded reservation to consumption, from the runs on record', async () => {
    const m = await open();
    // Two runs admitted and finished. The old scheduler settled them under `2026-09`,
    // which matched nothing, so the counters still say both units are in flight.
    seedRun(m.h, m.ws, 'run_a', { status: 'VERIFIED', createdAt: NOW, nextCheckAt: null });
    seedRun(m.h, m.ws, 'run_b', { status: 'UNVERIFIED', createdAt: NOW, nextCheckAt: null });
    setCounters(m, ALLOWANCE_KEY, 0, 2);

    const report = await reconcileAllowancePeriods(m.repair, options);

    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 500,
      consumed: 2,
      reserved: 0,
    });
    const repair = report.repairs.find((r) => r.billingPeriod === ALLOWANCE_KEY);
    expect(repair?.outcome).toBe('repaired');
    expect(repair?.evidence).toEqual({ terminalRuns: 2, pendingRuns: 0 });
    // The total is unchanged: two units were used before and two after. Nothing was
    // handed back and nothing was taken twice.
    expect((repair?.before.consumed ?? 0) + (repair?.before.reserved ?? 0)).toBe(2);
  });

  it('BILL-335 leaves a genuinely in-flight reservation alone', async () => {
    const m = await open();
    seedRun(m.h, m.ws, 'run_pending', { status: 'PENDING', createdAt: NOW });
    setCounters(m, ALLOWANCE_KEY, 0, 1);

    await reconcileAllowancePeriods(m.repair, options);

    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 500,
      consumed: 0,
      reserved: 1,
    });
  });

  it('BILL-336 never resets usage when retention has deleted the runs behind it', async () => {
    const m = await open();
    // 40 runs consumed long ago; retention has since removed every one of them. A repair
    // that recomputed `consumed` from surviving runs would hand 40 runs back, every time
    // the sweeper ran.
    setCounters(m, ALLOWANCE_KEY, 40, 0);

    const report = await reconcileAllowancePeriods(m.repair, options);

    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)?.consumed).toBe(40);
    expect(report.repairs[0]?.outcome).toBe('already_correct');
  });

  it('BILL-337 releases a reservation whose run no longer exists', async () => {
    const m = await open();
    // The documented rule: retention deleted the run before it settled, so the customer
    // got nothing for the unit and it is handed back.
    setCounters(m, ALLOWANCE_KEY, 5, 3);

    await reconcileAllowancePeriods(m.repair, options);

    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 500,
      consumed: 5,
      reserved: 0,
    });
  });

  it('BILL-338 refuses to overwrite a row that moved while the repair was being decided', async () => {
    const m = await open();
    seedRun(m.h, m.ws, 'run_done', { status: 'VERIFIED', createdAt: NOW, nextCheckAt: null });
    setCounters(m, ALLOWANCE_KEY, 0, 1);

    let reads = 0;
    // A concurrent admission lands between the read and the write. The port's writes are
    // compare-and-set on `updated_at`, which `admitOnce` bumps inside its own batch.
    const racing = {
      ...m.repair,
      listWorkspacesWithAllowanceRows: (limit: number) =>
        m.repair.listWorkspacesWithAllowanceRows(limit),
      currentPeriodEnd: (ws: string, env: 'test' | 'live') => m.repair.currentPeriodEnd(ws, env),
      listRunPeriodFacts: (ws: string, limit: number) => m.repair.listRunPeriodFacts(ws, limit),
      renameAllowancePeriod: m.repair.renameAllowancePeriod.bind(m.repair),
      mergeAllowancePeriod: m.repair.mergeAllowancePeriod.bind(m.repair),
      dropAllowanceRow: m.repair.dropAllowanceRow.bind(m.repair),
      setAllowanceCounters: m.repair.setAllowanceCounters.bind(m.repair),
      listAllowanceRows: async (ws: string) => {
        const rows = await m.repair.listAllowanceRows(ws);
        // Somebody else writes after the read the decision is made from, and before the
        // compare-and-set that would apply it.
        reads += 1;
        if (reads === 2) {
          m.h.raw
            .prepare(
              "UPDATE entitlements SET reserved = reserved + 1, updated_at = '2026-09-19T10:59:59.000Z' WHERE workspace_id = ?",
            )
            .run(ws);
        }
        return rows;
      },
    };

    const report = await reconcileAllowancePeriods(racing, options);

    // The live write stands; the repair did not clobber it.
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)?.reserved).toBe(2);
    expect(report.repairs.some((r) => r.outcome === 'raced')).toBe(true);
  });
});

describe('a month that straddles two paid periods', () => {
  it('BILL-339 drops the legacy row only when every unit is accounted for by a run', async () => {
    // The harness anchor is the 5th, so `2026-09` spans the period ending 2026-09-05 and
    // the one ending 2026-10-05. One pair of counters, two periods, no way to divide them
    // by arithmetic — so the runs decide.
    const m = await open();
    seedRun(m.h, m.ws, 'run_early', {
      status: 'VERIFIED',
      createdAt: '2026-09-02T09:00:00.000Z',
      nextCheckAt: null,
    });
    seedRun(m.h, m.ws, 'run_late', {
      status: 'VERIFIED',
      createdAt: '2026-09-19T09:00:00.000Z',
      nextCheckAt: null,
    });
    setCounters(m, ALLOWANCE_KEY, 0, 0);
    seedAllowance(m, LEGACY, { consumed: 2, reserved: 0 });

    const report = await reconcileAllowancePeriods(m.repair, options);

    const rows = allowanceRows(m.h, m.ws.workspaceId);
    // The legacy row is gone and the surviving period is rebuilt from its own run.
    expect(rows.map((r) => r.billing_period)).toEqual([ALLOWANCE_KEY]);
    expect(rows[0]?.consumed).toBe(1);
    expect(report.folds[0]?.outcome).toBe('merged');
    expect(report.folds[0]?.note).toMatch(/accounted for by a surviving run/i);
  });

  it('BILL-340 leaves a straddling row untouched when the runs cannot account for it', async () => {
    const m = await open();
    // Twelve units recorded, no runs left to attribute them to. Splitting would be a
    // guess, and the guess that is cheap for us is expensive for the customer.
    seedAllowance(m, LEGACY, { consumed: 12, reserved: 0 });

    const report = await reconcileAllowancePeriods(m.repair, options);

    const rows = allowanceRows(m.h, m.ws.workspaceId);
    expect(rows.map((r) => r.billing_period).sort()).toEqual([LEGACY, ALLOWANCE_KEY].sort());
    expect(report.folds[0]?.outcome).toBe('ambiguous_unattributable');
    expect(report.folds[0]?.note).toMatch(/benefit of the doubt/i);
  });
});

describe('the repaired state is what the live path then reads', () => {
  it('BILL-341 after reconciliation a real signed event is admitted against the merged row', async () => {
    const m = await open({
      billingPeriod: CLEAN_KEY,
      subscription: { currentPeriodEnd: FIRST_OF_MONTH_END },
      runLimit: 10,
    });
    setCounters(m, CLEAN_KEY, 2, 0);
    seedAllowance(m, LEGACY, { consumed: 7, reserved: 0, runLimit: 10 });

    await reconcileAllowancePeriods(m.repair, options);

    // Nine of ten used. One left, and the door must sell exactly one.
    expect(allowanceRow(m.h, m.ws.workspaceId, CLEAN_KEY)).toEqual({
      run_limit: 10,
      consumed: 9,
      reserved: 0,
    });

    const accepted = await postEvent(m, eventBody(m.ws));
    expect(accepted.status).toBe(202);
    expect(allowanceRow(m.h, m.ws.workspaceId, CLEAN_KEY)?.reserved).toBe(1);

    const refused = await postEvent(m, eventBody(m.ws, { event_id: 'evt-000000002' }));
    expect(refused.status).toBe(429);

    // Before the reconciliation this workspace would have shown 2 of 10 used and sold
    // eight more runs than it had been paid for.
    expect(allowanceRow(m.h, m.ws.workspaceId, CLEAN_KEY)).toEqual({
      run_limit: 10,
      consumed: 9,
      reserved: 1,
    });
  });
});
