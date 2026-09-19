/**
 * Allowance arithmetic. Pure, integer, no I/O.
 *
 * The allowance is held in three integers — `runLimit`, `consumed`, `reserved` — and
 * `remaining = runLimit - consumed - reserved`. A unit is **reserved** the moment a run
 * is admitted, so two concurrent source events cannot be sold the same unit, and moves to
 * **consumed** when the run reaches a terminal state.
 *
 * ## Which internal failures release a reservation
 *
 * This is the list the rest of the system must honour. A release is correct exactly when
 * the customer got nothing for the unit:
 *
 * | Case | Release? | Why |
 * | --- | --- | --- |
 * | Admission accepted but the run row failed to commit | **release** | Nothing exists to verify. |
 * | Scheduler could never lease the run (poisoned row, dispatcher crash) | **release** | No observation was ever attempted. |
 * | Our own configuration was invalid (missing workflow version) | **release** | Our fault, before any provider work. |
 * | Retention/cleanup deleted the run before it settled | **release** | We destroyed the work. |
 * | Workspace deleted mid-flight | **release** | Nobody to serve. |
 * | Provider call failed and the run settled `UNVERIFIED` | **consume** | We did the work; `UNVERIFIED` is a real answer. |
 * | Run settled `VERIFIED`/`FAILED`/`UNVERIFIED` | **consume** | Terminal state reached. |
 * | Queue retry of an already-admitted run | **neither** | Same unit; a retry is not a new run. |
 * | Provider callback for an existing run | **neither** | Evidence for a unit already held. |
 * | Internal error recovery re-running an admitted run | **neither** | Same unit. |
 *
 * The last three are the ones that turn into a double charge if you get them wrong, so
 * they are stated as "neither": a retry, a callback and a recovery never reserve.
 *
 * ## At the allowance
 *
 * When `remaining` reaches zero we stop admitting new runs. We do not charge overage, we
 * do not silently downgrade a verification, and the account stays fully usable: sign-in,
 * history, export, card update and cancellation all keep working.
 */

export interface AllowanceSnapshot {
  readonly runLimit: number;
  readonly consumed: number;
  readonly reserved: number;
}

export type AdmissionKind =
  /** A new source event asking for a fresh unit of allowance. */
  | 'new_run'
  /** A bounded retry of a run that already holds a unit. */
  | 'queue_retry'
  /** A provider callback carrying evidence for an existing run. */
  | 'provider_callback'
  /** Recovery after one of our own failures, for a run that already holds a unit. */
  | 'internal_recovery';

export type AdmissionDecision =
  | { readonly admit: true; readonly reserves: boolean; readonly reason: string }
  | { readonly admit: false; readonly reserves: false; readonly reason: 'at_allowance' };

/** `runLimit - consumed - reserved`, clamped at zero, computed one way everywhere. */
export function remainingRuns(snapshot: AllowanceSnapshot): number {
  assertSnapshot(snapshot);
  return Math.max(0, snapshot.runLimit - snapshot.consumed - snapshot.reserved);
}

/** True when there is nothing left to admit against. */
export function atAllowance(snapshot: AllowanceSnapshot): boolean {
  return remainingRuns(snapshot) === 0;
}

/**
 * Whether this arrival may proceed, and whether it takes a unit.
 *
 * Only `new_run` can ever reserve. The other three kinds belong to a unit that was
 * already taken, so they are admitted without touching the counters even when the
 * workspace is at its allowance — refusing them would strand work the customer already
 * paid for.
 */
export function admissionDecision(
  snapshot: AllowanceSnapshot,
  kind: AdmissionKind,
): AdmissionDecision {
  if (kind !== 'new_run') {
    return { admit: true, reserves: false, reason: `${kind}_holds_existing_reservation` };
  }
  if (atAllowance(snapshot)) return { admit: false, reserves: false, reason: 'at_allowance' };
  return { admit: true, reserves: true, reason: 'allowance_available' };
}

export type AllowanceOutcome<T> =
  | { readonly ok: true; readonly next: T }
  | { readonly ok: false; readonly reason: AllowanceFailure };

export type AllowanceFailure =
  | 'at_allowance'
  | 'no_reservation_held'
  | 'invalid_snapshot';

/** Take one unit. Fails rather than going negative; the caller shows "at allowance". */
export function reserve(snapshot: AllowanceSnapshot): AllowanceOutcome<AllowanceSnapshot> {
  if (!isValid(snapshot)) return { ok: false, reason: 'invalid_snapshot' };
  if (atAllowance(snapshot)) return { ok: false, reason: 'at_allowance' };
  return { ok: true, next: { ...snapshot, reserved: snapshot.reserved + 1 } };
}

/** A run reached a terminal state: the held unit becomes consumption. */
export function consume(snapshot: AllowanceSnapshot): AllowanceOutcome<AllowanceSnapshot> {
  if (!isValid(snapshot)) return { ok: false, reason: 'invalid_snapshot' };
  if (snapshot.reserved < 1) return { ok: false, reason: 'no_reservation_held' };
  return {
    ok: true,
    next: { ...snapshot, reserved: snapshot.reserved - 1, consumed: snapshot.consumed + 1 },
  };
}

/** The run will never execute: hand the unit back. Never increments `consumed`. */
export function release(snapshot: AllowanceSnapshot): AllowanceOutcome<AllowanceSnapshot> {
  if (!isValid(snapshot)) return { ok: false, reason: 'invalid_snapshot' };
  if (snapshot.reserved < 1) return { ok: false, reason: 'no_reservation_held' };
  return { ok: true, next: { ...snapshot, reserved: snapshot.reserved - 1 } };
}

/**
 * Open the next period.
 *
 * A new period is a new row with fresh counters — it never edits the period that just
 * ended, because that row is the record of what the customer actually used and is what a
 * dispute would be settled from. Unused allowance does not carry over; that is stated in
 * `docs/billing.md` rather than hidden here.
 */
export function rollover(runLimit: number): AllowanceSnapshot {
  if (!Number.isSafeInteger(runLimit) || runLimit < 0) {
    throw new TypeError(`run limit must be a non-negative integer, received ${runLimit}`);
  }
  return { runLimit, consumed: 0, reserved: 0 };
}

/** What the customer is shown. Percentages are computed here so the UI cannot drift. */
export interface AllowanceView {
  readonly runLimit: number;
  readonly used: number;
  readonly inFlight: number;
  readonly remaining: number;
  readonly atAllowance: boolean;
  readonly percentUsed: number;
}

export function allowanceView(snapshot: AllowanceSnapshot): AllowanceView {
  assertSnapshot(snapshot);
  const remaining = remainingRuns(snapshot);
  const percentUsed =
    snapshot.runLimit === 0
      ? 100
      : Math.min(100, Math.round(((snapshot.consumed + snapshot.reserved) / snapshot.runLimit) * 100));
  return {
    runLimit: snapshot.runLimit,
    used: snapshot.consumed,
    inFlight: snapshot.reserved,
    remaining,
    atAllowance: remaining === 0,
    percentUsed,
  };
}

function isValid(snapshot: AllowanceSnapshot): boolean {
  return (
    Number.isSafeInteger(snapshot.runLimit) &&
    Number.isSafeInteger(snapshot.consumed) &&
    Number.isSafeInteger(snapshot.reserved) &&
    snapshot.runLimit >= 0 &&
    snapshot.consumed >= 0 &&
    snapshot.reserved >= 0
  );
}

function assertSnapshot(snapshot: AllowanceSnapshot): void {
  if (!isValid(snapshot)) {
    throw new TypeError('allowance counters must be non-negative safe integers');
  }
}
