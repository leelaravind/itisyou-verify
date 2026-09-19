/**
 * Paid-mode spending control.
 *
 * Three rules, in the order they are applied:
 *
 *  1. **Per-request cap.** An estimate above the configured per-request ceiling is refused
 *     before anything is reserved.
 *  2. **Cumulative cap.** `spent + reserved + committed + estimate` must stay at or below
 *     the configured cumulative ceiling. This is the rule that blocks the call that would
 *     *cross* the cap, not the one after it.
 *  3. **Reserve before the call, reconcile after.** The reservation goes through A02's
 *     `budget.reserve`, whose insert and update carry the same availability guard, so two
 *     concurrent requests for the last penny cannot both pass. After the provider answers,
 *     the reservation is settled at the real cost and the remainder released.
 *
 * **Fail closed.** If budget accounting is unavailable for any reason — the account is
 * missing, the database threw, the configuration is incomplete — the answer is "no call".
 * There is no branch in this file that proceeds to spend money on an unknown balance.
 */
import { budget } from '../db/index.js';
import type { Db } from '../db/d1.js';
import { newId } from '../lib/ids.js';
import type { AssistantConfig } from './types.js';

export type BudgetRefusal =
  'NOT_CONFIGURED' | 'PER_REQUEST_CAP_EXCEEDED' | 'CUMULATIVE_CAP_REACHED' | 'BUDGET_UNAVAILABLE';

export type ReservationOutcome =
  | {
      readonly ok: true;
      readonly entryId: string;
      readonly accountId: string;
      readonly reservedMinor: number;
      readonly idempotencyKey: string;
    }
  | { readonly ok: false; readonly reason: BudgetRefusal; readonly detail: string };

/**
 * Estimate the cost of one request in integer minor units.
 *
 * Rounded **up**, always. A cap that can be crossed by a rounding error is not a cap.
 * `pricePerMillionTokensMinor` is owner-supplied configuration for the named paid model —
 * it is never read from a model's own output, and it is never inferred.
 */
export function estimateRequestCostMinor(params: {
  readonly promptTokens: number;
  readonly maxOutputTokens: number;
  readonly inputPricePerMillionMinor: number;
  readonly outputPricePerMillionMinor: number;
}): number {
  const safe = (value: number): number => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const input = safe(params.promptTokens) * safe(params.inputPricePerMillionMinor);
  const output = safe(params.maxOutputTokens) * safe(params.outputPricePerMillionMinor);
  return Math.ceil((input + output) / 1_000_000);
}

/** The cap arithmetic, isolated so it can be tested without a database. */
export function capDecision(
  config: AssistantConfig,
  estimateMinor: number,
  committedTotalMinor: number,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: BudgetRefusal } {
  if (config.mode !== 'paid_api') return { allowed: false, reason: 'NOT_CONFIGURED' };
  if (config.perRequestCapMinor <= 0 || config.cumulativeCapMinor <= 0) {
    return { allowed: false, reason: 'NOT_CONFIGURED' };
  }
  if (!Number.isSafeInteger(estimateMinor) || estimateMinor < 0) {
    return { allowed: false, reason: 'BUDGET_UNAVAILABLE' };
  }
  if (estimateMinor > config.perRequestCapMinor) {
    return { allowed: false, reason: 'PER_REQUEST_CAP_EXCEEDED' };
  }
  // Strictly greater-than: a request that lands exactly on the cap is allowed, the next
  // penny is not. The boundary is stated here once so no caller re-derives it.
  if (committedTotalMinor + estimateMinor > config.cumulativeCapMinor) {
    return { allowed: false, reason: 'CUMULATIVE_CAP_REACHED' };
  }
  return { allowed: true };
}

export interface ReserveParams {
  readonly db: Db;
  readonly config: AssistantConfig;
  readonly estimateMinor: number;
  /** Stable across retries of the same logical request. */
  readonly requestId: string;
  readonly now: string;
}

/** Cap, then reserve. Any failure at all returns a refusal; none of them proceeds. */
export async function reserveForCall(params: ReserveParams): Promise<ReservationOutcome> {
  const accountId = params.config.budgetAccountId;
  if (params.config.mode !== 'paid_api' || accountId === null) {
    return { ok: false, reason: 'NOT_CONFIGURED', detail: 'paid mode is not fully configured' };
  }

  let committedTotal: number;
  try {
    const account = await budget.getAccount(params.db, accountId);
    if (account === null) {
      return { ok: false, reason: 'BUDGET_UNAVAILABLE', detail: 'budget account not found' };
    }
    committedTotal = account.spent_minor + account.reserved_minor + account.committed_minor;
  } catch {
    // Accounting unavailable. Fail closed — never spend against a balance we cannot read.
    return { ok: false, reason: 'BUDGET_UNAVAILABLE', detail: 'budget accounting unavailable' };
  }

  const decision = capDecision(params.config, params.estimateMinor, committedTotal);
  if (!decision.allowed) {
    return {
      ok: false,
      reason: decision.reason,
      detail:
        decision.reason === 'CUMULATIVE_CAP_REACHED'
          ? `this call would take cumulative assistant spend past ${params.config.cumulativeCapMinor} minor units`
          : `estimated ${params.estimateMinor} minor units exceeds the per-request cap of ${params.config.perRequestCapMinor}`,
    };
  }

  if (params.estimateMinor === 0) {
    // A zero-cost estimate needs no reservation, but it still had to pass both caps above.
    return {
      ok: true,
      entryId: '',
      accountId,
      reservedMinor: 0,
      idempotencyKey: `assistant:${params.requestId}`,
    };
  }

  const idempotencyKey = `assistant:reserve:${params.requestId}`;
  try {
    const outcome = await budget.reserve(params.db, {
      entryId: newId('bce'),
      accountId,
      amountMinor: params.estimateMinor,
      source: 'assistant',
      idempotencyKey,
      at: params.now,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        reason: 'BUDGET_UNAVAILABLE',
        detail:
          outcome.reason === 'INSUFFICIENT_FUNDS' ? 'insufficient budget' : 'no budget account',
      };
    }
    return {
      ok: true,
      entryId: outcome.entryId,
      accountId,
      reservedMinor: params.estimateMinor,
      idempotencyKey,
    };
  } catch {
    return { ok: false, reason: 'BUDGET_UNAVAILABLE', detail: 'budget reservation failed' };
  }
}

export interface ReconcileParams {
  readonly db: Db;
  readonly reservation: Extract<ReservationOutcome, { ok: true }>;
  /** What the call actually cost, in minor units. Never larger than the reservation. */
  readonly actualMinor: number;
  readonly requestId: string;
  readonly now: string;
}

export interface ReconcileResult {
  readonly settledMinor: number;
  readonly releasedMinor: number;
  /** True when the ledger could not be updated. The caller must surface this, not hide it. */
  readonly failed: boolean;
}

/**
 * Turn a reservation into real spend, and hand back whatever was not used.
 *
 * `actualMinor` is clamped to the reservation: the assistant may never settle more than it
 * held, because the only guard proving the money was there was the one at reservation time.
 * An overrun is recorded as a full settle of the reservation, and the difference is left
 * for the owner's reconciliation to pick up rather than silently drawn from the account.
 */
export async function reconcileAfterCall(params: ReconcileParams): Promise<ReconcileResult> {
  const held = params.reservation.reservedMinor;
  if (held === 0) return { settledMinor: 0, releasedMinor: 0, failed: false };

  const actual = Math.max(
    0,
    Math.min(Number.isSafeInteger(params.actualMinor) ? params.actualMinor : held, held),
  );
  const unused = held - actual;

  let failed = false;
  try {
    if (actual > 0) {
      const settled = await budget.settle(params.db, {
        entryId: newId('bce'),
        accountId: params.reservation.accountId,
        amountMinor: actual,
        source: 'assistant',
        idempotencyKey: `assistant:settle:${params.requestId}`,
        at: params.now,
      });
      if (!settled.ok) failed = true;
    }
    if (unused > 0) {
      const released = await budget.release(params.db, {
        entryId: newId('bce'),
        accountId: params.reservation.accountId,
        amountMinor: unused,
        source: 'assistant',
        idempotencyKey: `assistant:release:${params.requestId}`,
        at: params.now,
      });
      if (!released.ok) failed = true;
    }
  } catch {
    failed = true;
  }
  return { settledMinor: actual, releasedMinor: unused, failed };
}

/** Release the whole reservation. Used when the provider call never happened. */
export async function releaseReservation(params: {
  readonly db: Db;
  readonly reservation: Extract<ReservationOutcome, { ok: true }>;
  readonly requestId: string;
  readonly now: string;
}): Promise<boolean> {
  if (params.reservation.reservedMinor === 0) return true;
  try {
    const outcome = await budget.release(params.db, {
      entryId: newId('bce'),
      accountId: params.reservation.accountId,
      amountMinor: params.reservation.reservedMinor,
      source: 'assistant',
      idempotencyKey: `assistant:release:${params.requestId}`,
      at: params.now,
    });
    return outcome.ok;
  } catch {
    return false;
  }
}
