/**
 * Repairing allowance rows that two spellings of one key left behind. (A13-010, part 2.)
 *
 * ## What is already fixed, and what this is for
 *
 * A06 and A02 closed the *forward* half: `apps/app/src/billing/period.ts` is now the only
 * place an allowance period key is derived, the D1 port validates the key it is handed
 * (`db/billingPort.ts`), the scheduler resolves one rather than slicing a date
 * (`scheduler/observe.ts`), and the customer usage page reads through the same resolver
 * (`db/customerPort.ts`). From now on, nothing can write a `YYYY-MM` key.
 *
 * That does nothing for rows already on disk. While the two spellings coexisted, two
 * distinct kinds of damage were possible, and they need different repairs:
 *
 * **(a) Rows under the wrong key.** An allowance row whose `billing_period` is `2026-09`
 * rather than `2026-09-19`. Nothing in the fixed code will ever find it again: the
 * customer's usage page reads the correct key, sees no row, and reports "nothing used" —
 * while the row holding their consumption sits beside it, invisible. Left alone, the next
 * `ensurePeriod` opens a *second* row for the same paid period and the customer is handed
 * their 500 runs twice. That is the duplicate grant, arriving by a different door.
 *
 * **(b) Counters stranded by a settle that missed.** This is the damage the shipped code
 * actually did in production. `settleReservation` was called with `YYYY-MM` against a row
 * stored under `YYYY-MM-DD`: the `UPDATE` matched nothing and returned `false`, silently.
 * The run finished, the unit was never converted, and `reserved` stayed up forever. Five
 * hundred runs of allowance leak away one stuck reservation at a time, and the customer is
 * refused at a limit they never reached.
 *
 * ## The two rules this repair may not break
 *
 * The founder's constraint, and they are not negotiable:
 *
 *  1. **Never reset usage.** `consumed` may rise to meet the evidence and may never fall.
 *     Retention deletes runs after their window; a repair that recomputed `consumed` from
 *     surviving runs would hand back allowance every time the retention sweeper ran.
 *  2. **Never grant a duplicate allowance.** `run_limit` is never summed, never raised,
 *     never re-granted. Merging two rows produces one row with one limit.
 *
 * Both are expressed directly in the arithmetic below:
 *
 *     consumed := max(consumed, terminal runs in this period)
 *     reserved := min(reserved, runs still PENDING in this period)
 *     run_limit unchanged, always
 *
 * `max` on one side and `min` on the other is what makes the pass safe to run repeatedly
 * and safe to run late. It can only move a unit from `reserved` to `consumed`, or release
 * a reservation nothing is holding. It can never invent a unit and never return one that
 * was spent.
 *
 * ## Why the runs table is the arbiter
 *
 * `entitlements` is a derived counter. `runs` is the record of what we actually did, each
 * row carrying `created_at`, and `allowancePeriodKeyAt(created_at, currentPeriodEnd)` maps
 * every one of them onto the period that paid for it — using the same anchor walk Stripe
 * bills on, so a run admitted before a renewal is still attributed to the period it was
 * admitted in. That makes the true consumption of a period computable rather than
 * negotiable, which is the only way to reconcile counters that disagree.
 *
 * ## Concurrency
 *
 * Every write is a compare-and-set against the exact `(consumed, reserved, updated_at)`
 * this pass read. A run admitted while we were deciding bumps `entitlements.updated_at` in
 * `sourceEvents.admitOnce`'s batch, our update matches nothing, and the row is reported as
 * `raced` and left for the next pass. A repair that clobbered a live reservation would
 * sell the same unit twice, which is the defect this file exists to end, not to repeat.
 *
 * The legacy fold is a single `db.batch()` — one transaction, per D1's documented "batched
 * statements are SQL transactions". The merge and the delete commit together or not at
 * all, so a Worker killed mid-pass leaves either the old shape or the new one, never a
 * double count.
 */
import { allowancePeriodKeyAt, isAllowancePeriodKey } from '../billing/period';
import type { AllowanceRepairPort, AllowanceRowSnapshot, RunPeriodFact } from './ports';

/** A calendar-month key, which is the only wrong shape that was ever written. */
const CALENDAR_MONTH = /^\d{4}-\d{2}$/;

/** How many workspaces one pass will look at. Bounded: this runs on a minute tick. */
export const DEFAULT_WORKSPACE_LIMIT = 25;

/** How many runs one workspace's evidence walk will read. */
export const DEFAULT_RUN_SCAN_LIMIT = 5_000;

export type LegacyFoldOutcome =
  /** Renamed in place: no row existed under the correct key. */
  | 'renamed'
  /** Counters folded into the existing correct row, legacy row removed. */
  | 'merged'
  /**
   * The month straddles two paid periods and the run evidence does not account for the
   * whole legacy counter, so splitting it would be a guess. Left untouched and reported.
   */
  | 'ambiguous_unattributable'
  /** Another writer moved the row while we were deciding. Next pass will retry. */
  | 'raced'
  /** No subscription, so no anchor, so no correct key exists to move it to. */
  | 'no_anchor';

export interface LegacyFold {
  readonly workspaceId: string;
  readonly legacyKey: string;
  /** The key it was moved to. `null` when nothing was moved. */
  readonly targetKey: string | null;
  readonly outcome: LegacyFoldOutcome;
  /** Units carried across: `consumed` and `reserved` as they stood on the legacy row. */
  readonly carriedConsumed: number;
  readonly carriedReserved: number;
  /** One sentence, written for the owner queue rather than a log parser. */
  readonly note: string;
}

export type CounterRepairOutcome = 'repaired' | 'already_correct' | 'raced';

export interface CounterRepair {
  readonly workspaceId: string;
  readonly billingPeriod: string;
  readonly outcome: CounterRepairOutcome;
  readonly before: { readonly consumed: number; readonly reserved: number };
  readonly after: { readonly consumed: number; readonly reserved: number };
  /** Runs that prove the figures: terminal and still-pending, in this period. */
  readonly evidence: { readonly terminalRuns: number; readonly pendingRuns: number };
  readonly note: string;
}

export interface AllowanceReconciliationReport {
  readonly checkedAt: string;
  readonly environment: 'test' | 'live';
  readonly workspacesExamined: number;
  readonly rowsExamined: number;
  readonly folds: readonly LegacyFold[];
  readonly repairs: readonly CounterRepair[];
  /**
   * Rows whose `consumed + reserved` exceeds `run_limit` after the pass. Reported and
   * never clamped: a counter above the limit is evidence of a bug somewhere else, and
   * silently trimming it would destroy that evidence.
   */
  readonly overLimit: readonly {
    readonly workspaceId: string;
    readonly billingPeriod: string;
    readonly used: number;
    readonly runLimit: number;
  }[];
  /** Non-fatal per-workspace failures. One bad workspace never stops the pass. */
  readonly failures: readonly { readonly workspaceId: string; readonly error: string }[];
}

export interface ReconcileAllowanceOptions {
  readonly now: string;
  readonly environment: 'test' | 'live';
  /** Reconcile one workspace only. Used by the owner's per-workspace repair. */
  readonly workspaceId?: string;
  readonly workspaceLimit?: number;
  readonly runScanLimit?: number;
}

interface RunTally {
  terminal: number;
  pending: number;
}

/**
 * Reconcile allowance rows against the runs that actually happened.
 *
 * Idempotent by construction: a second pass over a reconciled workspace performs no
 * writes and reports every row as `already_correct`. That property is asserted directly
 * by `BILL-302`, because "idempotent" is a claim and a claim needs a test.
 */
export async function reconcileAllowancePeriods(
  port: AllowanceRepairPort,
  options: ReconcileAllowanceOptions,
): Promise<AllowanceReconciliationReport> {
  const checkedAt = options.now;
  const workspaceLimit = clamp(options.workspaceLimit ?? DEFAULT_WORKSPACE_LIMIT, 1, 500);
  const runScanLimit = clamp(options.runScanLimit ?? DEFAULT_RUN_SCAN_LIMIT, 1, 50_000);

  const folds: LegacyFold[] = [];
  const repairs: CounterRepair[] = [];
  const overLimit: {
    workspaceId: string;
    billingPeriod: string;
    used: number;
    runLimit: number;
  }[] = [];
  const failures: { workspaceId: string; error: string }[] = [];
  let rowsExamined = 0;

  const workspaceIds =
    options.workspaceId === undefined
      ? await port.listWorkspacesWithAllowanceRows(workspaceLimit)
      : [options.workspaceId];

  for (const workspaceId of workspaceIds) {
    try {
      const anchor = await port.currentPeriodEnd(workspaceId, options.environment);
      const rows = await port.listAllowanceRows(workspaceId);
      rowsExamined += rows.length;
      if (rows.length === 0) continue;

      // No anchor means no subscription, so no correct key exists anywhere and there is
      // nothing to move a legacy row to. Reported rather than guessed at.
      if (anchor === null) {
        for (const row of rows) {
          if (isAllowancePeriodKey(row.billingPeriod)) continue;
          folds.push({
            workspaceId,
            legacyKey: row.billingPeriod,
            targetKey: null,
            outcome: 'no_anchor',
            carriedConsumed: row.consumed,
            carriedReserved: row.reserved,
            note:
              'This workspace holds an allowance row under a calendar-month key but has no ' +
              'subscription period to anchor a correct key to, so there is nowhere to move it. ' +
              'Left untouched.',
          });
        }
        continue;
      }

      const tally = tallyRunsByPeriod(
        await port.listRunPeriodFacts(workspaceId, runScanLimit),
        anchor,
      );

      // (a) Legacy keys first, so the counter repair below sees one row per period.
      for (const row of rows) {
        if (isAllowancePeriodKey(row.billingPeriod)) continue;
        folds.push(await foldLegacyRow(port, { row, anchor, tally, at: checkedAt }));
      }

      // (b) Counters, against the runs that prove them. Re-read, because the fold above
      // may have moved figures into a row we are about to repair.
      for (const row of await port.listAllowanceRows(workspaceId)) {
        if (!isAllowancePeriodKey(row.billingPeriod)) continue;
        const repair = await repairCounters(port, { row, tally, at: checkedAt });
        repairs.push(repair);
        const used = repair.after.consumed + repair.after.reserved;
        if (used > row.runLimit) {
          overLimit.push({
            workspaceId,
            billingPeriod: row.billingPeriod,
            used,
            runLimit: row.runLimit,
          });
        }
      }
    } catch (error) {
      failures.push({ workspaceId, error: describe(error) });
    }
  }

  return {
    checkedAt,
    environment: options.environment,
    workspacesExamined: workspaceIds.length,
    rowsExamined,
    folds,
    repairs,
    overLimit,
    failures,
  };
}

/* -------------------------------------------------------------------------- */
/* (a) folding a legacy key into the correct one                              */
/* -------------------------------------------------------------------------- */

/**
 * The allowance period keys whose paid period overlaps a `YYYY-MM` calendar month.
 *
 * One or two, never more: a monthly period is at least 28 days, so a calendar month can
 * straddle at most one boundary. Two is the case that cannot be resolved by arithmetic —
 * the legacy row holds one pair of counters for two periods — and that is exactly why this
 * returns a list rather than an answer.
 */
export function candidateKeysForMonth(monthKey: string, anchorIso: string): readonly string[] {
  if (!CALENDAR_MONTH.test(monthKey)) return [];
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const first = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  // One millisecond before the next month begins: the last instant belonging to it.
  const last = Date.UTC(year, month, 1, 0, 0, 0, 0) - 1;
  const opensAt = allowancePeriodKeyAt(new Date(first).toISOString(), anchorIso);
  const endsAt = allowancePeriodKeyAt(new Date(last).toISOString(), anchorIso);
  return opensAt === endsAt ? [opensAt] : [opensAt, endsAt];
}

async function foldLegacyRow(
  port: AllowanceRepairPort,
  input: {
    readonly row: AllowanceRowSnapshot;
    readonly anchor: string;
    readonly tally: ReadonlyMap<string, RunTally>;
    readonly at: string;
  },
): Promise<LegacyFold> {
  const { row, anchor, tally, at } = input;
  const workspaceId = row.workspaceId;
  const legacyKey = row.billingPeriod;
  const carried = { carriedConsumed: row.consumed, carriedReserved: row.reserved };

  const candidates = candidateKeysForMonth(legacyKey, anchor);
  if (candidates.length === 0) {
    return {
      workspaceId,
      legacyKey,
      targetKey: null,
      outcome: 'ambiguous_unattributable',
      ...carried,
      note:
        `The key "${legacyKey}" is neither an allowance period key nor a calendar month, so no ` +
        'correct key can be derived from it. Left untouched for the owner to look at.',
    };
  }

  if (candidates.length > 1) {
    // The month straddles a renewal. The legacy row holds one pair of counters for two
    // paid periods and nothing in it says how they divide. The runs can say — but only if
    // they are all still there. `consumed + reserved` is what must be accounted for; if
    // the surviving runs account for at least that much, dropping the row loses nothing,
    // because step (b) rebuilds each period from the runs themselves.
    const accounted = candidates.reduce((sum, key) => {
      const counts = tally.get(key);
      return sum + (counts === undefined ? 0 : counts.terminal + counts.pending);
    }, 0);
    const owed = row.consumed + row.reserved;
    if (accounted < owed) {
      return {
        workspaceId,
        legacyKey,
        targetKey: null,
        outcome: 'ambiguous_unattributable',
        ...carried,
        note:
          `"${legacyKey}" spans two paid periods (${candidates.join(' and ')}) and holds ` +
          `${String(owed)} units, but only ${String(accounted)} runs survive to attribute them ` +
          'to. Splitting the rest would be a guess, so nothing was moved. The customer keeps ' +
          'the benefit of the doubt.',
      };
    }
    const dropped = await port.dropAllowanceRow({
      workspaceId,
      billingPeriod: legacyKey,
      expectConsumed: row.consumed,
      expectReserved: row.reserved,
      expectUpdatedAt: row.updatedAt,
    });
    return {
      workspaceId,
      legacyKey,
      targetKey: null,
      outcome: dropped ? 'merged' : 'raced',
      ...carried,
      note: dropped
        ? `"${legacyKey}" spans ${candidates.join(' and ')}; every one of its ${String(owed)} ` +
          'units is accounted for by a surviving run, so the row was removed and each period ' +
          'was rebuilt from the runs themselves. No consumption was lost and no allowance was ' +
          're-granted.'
        : 'Another writer moved this row while it was being folded. The next pass will retry it.',
    };
  }

  const targetKey = candidates[0] as string;

  // Rename first. If no row exists under the correct key this is the whole repair: the
  // counters cross untouched and no arithmetic happens at all.
  const renamed = await port.renameAllowancePeriod({
    workspaceId,
    fromPeriod: legacyKey,
    toPeriod: targetKey,
    expectUpdatedAt: row.updatedAt,
    at,
  });
  if (renamed) {
    return {
      workspaceId,
      legacyKey,
      targetKey,
      outcome: 'renamed',
      ...carried,
      note:
        `Moved from the calendar-month key "${legacyKey}" to the paid-period key "${targetKey}". ` +
        'Counters carried across unchanged; no allowance was granted and none was reset.',
    };
  }

  // A row already occupies the correct key, so this is a merge: one transaction, one
  // surviving row, one allowance limit.
  const merged = await port.mergeAllowancePeriod({
    workspaceId,
    fromPeriod: legacyKey,
    intoPeriod: targetKey,
    at,
  });
  return {
    workspaceId,
    legacyKey,
    targetKey,
    outcome: merged ? 'merged' : 'raced',
    ...carried,
    note: merged
      ? `Folded "${legacyKey}" into "${targetKey}": ${String(row.consumed)} consumed and ` +
        `${String(row.reserved)} reserved carried across, one row left, one allowance limit.`
      : 'Another writer moved one of these rows mid-merge; nothing was changed. The next pass ' +
        'retries.',
  };
}

/* -------------------------------------------------------------------------- */
/* (b) repairing counters against run evidence                                */
/* -------------------------------------------------------------------------- */

async function repairCounters(
  port: AllowanceRepairPort,
  input: {
    readonly row: AllowanceRowSnapshot;
    readonly tally: ReadonlyMap<string, RunTally>;
    readonly at: string;
  },
): Promise<CounterRepair> {
  const { row, tally, at } = input;
  const evidence = tally.get(row.billingPeriod) ?? { terminal: 0, pending: 0 };

  // The two rules, as arithmetic. `max` on consumed: a run retention has since deleted
  // still happened and the customer has already had it. `min` on reserved: a unit is only
  // held while something is actually pending.
  const consumed = Math.max(row.consumed, evidence.terminal);
  const reserved = Math.max(0, Math.min(row.reserved, evidence.pending));

  const before = { consumed: row.consumed, reserved: row.reserved };
  const evidenceOut = { terminalRuns: evidence.terminal, pendingRuns: evidence.pending };

  if (consumed === row.consumed && reserved === row.reserved) {
    return {
      workspaceId: row.workspaceId,
      billingPeriod: row.billingPeriod,
      outcome: 'already_correct',
      before,
      after: before,
      evidence: evidenceOut,
      note: 'The stored counters already agree with the runs on record. Nothing was written.',
    };
  }

  const applied = await port.setAllowanceCounters({
    workspaceId: row.workspaceId,
    billingPeriod: row.billingPeriod,
    consumed,
    reserved,
    expectConsumed: row.consumed,
    expectReserved: row.reserved,
    expectUpdatedAt: row.updatedAt,
    at,
  });

  if (!applied) {
    return {
      workspaceId: row.workspaceId,
      billingPeriod: row.billingPeriod,
      outcome: 'raced',
      before,
      after: before,
      evidence: evidenceOut,
      note:
        'This row changed while the repair was being decided: an admission or a settle ' +
        'landed. Nothing was overwritten; the next pass will look again.',
    };
  }

  const settled = consumed - row.consumed;
  const released = row.reserved - reserved - settled;
  return {
    workspaceId: row.workspaceId,
    billingPeriod: row.billingPeriod,
    outcome: 'repaired',
    before,
    after: { consumed, reserved },
    evidence: evidenceOut,
    note:
      `${String(settled)} unit(s) moved from reserved to consumed and ${String(released)} ` +
      'stranded reservation(s) released, against the runs on record. Consumption was not ' +
      'reset and no additional allowance was granted.',
  };
}

/* -------------------------------------------------------------------------- */
/* run evidence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Group a workspace's runs by the period that paid for them.
 *
 * `allowancePeriodKeyAt` is the same function the scheduler settles with, so a run counted
 * here is a run the live path would have settled against the same row. Two spellings of
 * this walk would be the original defect all over again.
 */
function tallyRunsByPeriod(
  runs: readonly RunPeriodFact[],
  anchorIso: string,
): ReadonlyMap<string, RunTally> {
  const tally = new Map<string, RunTally>();
  for (const run of runs) {
    let key: string;
    try {
      key = allowancePeriodKeyAt(run.createdAt, anchorIso);
    } catch {
      // A run with an unparseable timestamp cannot be attributed to a period. Skipping it
      // means the repair treats it as absent evidence, which is the safe direction:
      // `consumed` is never lowered by evidence that is missing.
      continue;
    }
    const current = tally.get(key) ?? { terminal: 0, pending: 0 };
    if (run.status === 'PENDING') current.pending += 1;
    else current.terminal += 1;
    tally.set(key, current);
  }
  return tally;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
}
