/**
 * Bounded retry and observation scheduling — plan §16.6 / §22.
 *
 * Two budgets, nested, never multiplied by accident:
 *
 *   - `LIMITS.MAX_OBSERVATIONS_PER_RUN` observations for the whole run.
 *   - `LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION` transport retries *inside* one
 *     observation.
 *
 * The outer budget is the authority. Exhausting the inner retry budget never buys another
 * observation, so the total number of external calls one run can ever cause is a fixed,
 * provable ceiling — `MAX_EXTERNAL_CALLS_PER_RUN`.
 *
 * Pure: `now` is injected and jitter is derived deterministically from the run's own
 * counters, so the same inputs always produce the same schedule. No `Math.random()`, ever —
 * a scheduler you cannot replay is a scheduler you cannot debug.
 */
import { LIMITS, TERMINAL_CONNECTOR_ERRORS, type ConnectorErrorCode, type EvidenceGap } from '@verify/contracts';

/** First backoff step, in seconds. Doubles per completed observation. */
export const BASE_BACKOFF_SECONDS = 30;
/** Upper bound on any single wait, before the deadline clamp. */
export const MAX_BACKOFF_SECONDS = 600;
/** How far past the deadline an already-scheduled observation may still land. */
export const DEADLINE_GRACE_SECONDS = 60;
/** Jitter spread: the computed delay is scaled into [0.8, 1.2]. */
export const JITTER_SPREAD = 0.4;

/**
 * The hard ceiling on external provider calls a single run can cause.
 *
 * One observation costs one initial call plus at most
 * `MAX_TRANSIENT_RETRIES_PER_OBSERVATION` retries — a *retry* is an additional attempt, not
 * the first one — and a run gets at most `MAX_OBSERVATIONS_PER_RUN` observations. Observations
 * bound the outer loop; retries bound the inner one; nothing multiplies further.
 */
export const MAX_EXTERNAL_CALLS_PER_RUN =
  LIMITS.MAX_OBSERVATIONS_PER_RUN * (1 + LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION);

export interface ObservationPlanInput {
  /** Observations already completed for this run. */
  readonly observationCount: number;
  readonly deadlineAt: Date;
  readonly now: Date;
  /** The connector problem that ended the last observation, if any. */
  readonly lastGap?: EvidenceGap | null;
  /** Transport retries already spent inside the current observation. */
  readonly attemptsUsed: number;
  /** Provider `Retry-After`, in seconds, when one was supplied. Honoured as a floor. */
  readonly retryAfterSeconds?: number | null;
  /** True once the run has reached a terminal status. */
  readonly decided?: boolean;
  /** Deterministic jitter fraction in [0, 1). Omit to derive one from the run's counters. */
  readonly jitterSeed?: number;
}

export interface ObservationPlan {
  /** When to look again, or null when the scheduler should stop looking at this run. */
  readonly nextCheckAt: Date | null;
  readonly reason: string;
}

export const SCHEDULE_REASON = {
  DECIDED: 'This run already has a final result, so no further checks are scheduled.',
  BUDGET_EXHAUSTED: 'This run has used every check it is allowed, so it will now be resolved with what we know.',
  TERMINAL_GAP: 'This connection needs attention before another check could succeed, so retrying would not help.',
  PAST_DEADLINE: 'The completion window has closed, so this run will now be resolved.',
  WOULD_EXCEED_DEADLINE: 'The next check would fall after the completion window, so this run will be resolved instead.',
  SCHEDULED: 'Another check is scheduled inside the completion window.',
  RETRY_AFTER: 'The provider asked us to wait, so the next check honours the delay it requested.',
} as const;

export const RETRY_REASON = {
  BUDGET_EXHAUSTED: 'This attempt has used its transport retries; the run will fall back to its next scheduled check.',
  TERMINAL: 'This failure cannot be fixed by retrying.',
  SCHEDULED: 'A bounded transport retry is scheduled.',
} as const;

/**
 * Deterministic jitter in [0, 1) derived from the run's own counters. Spreads simultaneous
 * runs across the minute without making the schedule unrepeatable.
 */
function derivedJitter(observationCount: number, attemptsUsed: number): number {
  // A small integer hash. Stable across processes and platforms.
  let h = (observationCount + 1) * 2654435761 + (attemptsUsed + 1) * 40503;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h % 1000) / 1000;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value >= 1) return 0.999;
  return value;
}

/** Exponential backoff with deterministic jitter, in seconds. */
export function backoffSeconds(observationCount: number, jitter: number): number {
  const exponent = Math.max(0, Math.min(observationCount, 16));
  const base = Math.min(BASE_BACKOFF_SECONDS * 2 ** exponent, MAX_BACKOFF_SECONDS);
  const scaled = base * (1 - JITTER_SPREAD / 2 + JITTER_SPREAD * clampFraction(jitter));
  return Math.max(1, Math.round(scaled));
}

function isTerminalGap(gap: EvidenceGap | null | undefined): boolean {
  if (!gap) return false;
  if (TERMINAL_CONNECTOR_ERRORS.has(gap.code as ConnectorErrorCode)) return true;
  // A connector that told us the problem is not retryable is believed.
  return gap.retryable === false && gap.code !== 'NOT_FOUND';
}

/**
 * Plan the next *observation* for a run.
 *
 * Returns `{ nextCheckAt: null }` — which the scheduler treats as "stop, resolve this run" —
 * when the run is decided, the observation budget is spent, the connector problem cannot be
 * fixed by retrying, or the next check would land beyond the deadline plus its grace.
 */
export function planNextObservation(input: ObservationPlanInput): ObservationPlan {
  if (input.decided === true) {
    return { nextCheckAt: null, reason: SCHEDULE_REASON.DECIDED };
  }

  // The outer budget is absolute. It is checked before anything else so no inner retry
  // accounting can ever talk its way into an extra observation.
  if (input.observationCount >= LIMITS.MAX_OBSERVATIONS_PER_RUN) {
    return { nextCheckAt: null, reason: SCHEDULE_REASON.BUDGET_EXHAUSTED };
  }

  if (isTerminalGap(input.lastGap)) {
    return { nextCheckAt: null, reason: SCHEDULE_REASON.TERMINAL_GAP };
  }

  const nowMs = input.now.getTime();
  const deadlineMs = input.deadlineAt.getTime();
  const latestAllowedMs = deadlineMs + DEADLINE_GRACE_SECONDS * 1000;

  if (nowMs >= latestAllowedMs) {
    return { nextCheckAt: null, reason: SCHEDULE_REASON.PAST_DEADLINE };
  }

  const jitter = clampFraction(input.jitterSeed ?? derivedJitter(input.observationCount, input.attemptsUsed));
  const backoff = backoffSeconds(input.observationCount, jitter);
  const retryAfter =
    typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds)
      ? Math.max(0, Math.ceil(input.retryAfterSeconds))
      : null;

  // A provider's Retry-After is a floor, never a ceiling: we wait at least as long as asked.
  const delaySeconds = retryAfter === null ? backoff : Math.max(retryAfter, backoff);
  const candidateMs = nowMs + delaySeconds * 1000;

  if (candidateMs > latestAllowedMs) {
    return { nextCheckAt: null, reason: SCHEDULE_REASON.WOULD_EXCEED_DEADLINE };
  }

  return {
    nextCheckAt: new Date(candidateMs),
    reason: retryAfter !== null && retryAfter >= backoff ? SCHEDULE_REASON.RETRY_AFTER : SCHEDULE_REASON.SCHEDULED,
  };
}

export interface RetryPlanInput {
  /** Transport retries already spent inside the current observation. */
  readonly attemptsUsed: number;
  readonly now: Date;
  readonly lastGap?: EvidenceGap | null;
  readonly retryAfterSeconds?: number | null;
  readonly jitterSeed?: number;
}

export interface RetryPlan {
  readonly nextAttemptAt: Date | null;
  readonly reason: string;
}

/**
 * Plan a transport retry *inside* the current observation. Capped independently at
 * `LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION`; exhausting it never grants an extra
 * observation, it simply ends this one.
 */
export function planNextRetry(input: RetryPlanInput): RetryPlan {
  if (input.attemptsUsed >= LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION) {
    return { nextAttemptAt: null, reason: RETRY_REASON.BUDGET_EXHAUSTED };
  }
  if (isTerminalGap(input.lastGap)) {
    return { nextAttemptAt: null, reason: RETRY_REASON.TERMINAL };
  }
  const jitter = clampFraction(input.jitterSeed ?? derivedJitter(0, input.attemptsUsed));
  // Short transport backoff: 1s, 2s, 4s, jittered.
  const base = Math.min(2 ** input.attemptsUsed, 30);
  const retryAfter =
    typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds)
      ? Math.max(0, Math.ceil(input.retryAfterSeconds))
      : null;
  const jittered = Math.max(1, Math.round(base * (1 - JITTER_SPREAD / 2 + JITTER_SPREAD * jitter)));
  const delaySeconds = retryAfter === null ? jittered : Math.max(retryAfter, jittered);
  return { nextAttemptAt: new Date(input.now.getTime() + delaySeconds * 1000), reason: RETRY_REASON.SCHEDULED };
}

/**
 * The provable ceiling on external calls for one run, for the budget tests and for A04's
 * concurrency accounting. Nothing in this module can exceed it.
 */
export function maxExternalCallsPerRun(): number {
  return MAX_EXTERNAL_CALLS_PER_RUN;
}
