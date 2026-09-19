/**
 * In-observation transport retries.
 *
 * There is no retry loop of our own here. The decision "retry, and when" belongs entirely
 * to A03's `planNextRetry` in `@verify/domain`; this module only asks it, waits the amount
 * it was told to wait, and stops the instant it returns `null`.
 *
 * That is not politeness. The provable ceiling of
 * `MAX_OBSERVATIONS_PER_RUN * (1 + MAX_TRANSIENT_RETRIES_PER_OBSERVATION)` external calls
 * per run only holds while every retry in the system goes through that one function. A
 * second, private loop anywhere in the connectors would multiply the budget and the claim
 * would quietly stop being true.
 *
 * `sleep` is injected so tests exercise the real scheduling arithmetic without real time
 * passing, and so a Worker can substitute a scheduler-friendly wait.
 */
import { planNextRetry } from '@verify/domain';
import type { EvidenceGap } from '@verify/contracts';

export interface AttemptOutcome<T> {
  /** The value to return when the attempt succeeded, or when retrying cannot help. */
  readonly value: T;
  /**
   * The connector problem this attempt ended with, or `null` when it succeeded.
   * `planNextRetry` reads the gap's code to decide whether another attempt is worth
   * making, so this must be the real gap and not a placeholder.
   */
  readonly gap: EvidenceGap | null;
  /** Provider-requested delay, honoured by the planner as a floor. */
  readonly retryAfterSeconds?: number | null | undefined;
}

export interface TransportRetryOptions<T> {
  /** One attempt. Receives the zero-based attempt index. */
  readonly attempt: (attemptIndex: number) => Promise<AttemptOutcome<T>>;
  readonly now: Date;
  /** Retries already spent inside this observation, carried across calls by the caller. */
  readonly attemptsUsed?: number | undefined;
  /** Deterministic jitter. Omit to let the planner derive one. */
  readonly jitterSeed?: number | undefined;
  /** Injected wait. Defaults to a real timer. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface TransportRetryResult<T> {
  readonly value: T;
  readonly gap: EvidenceGap | null;
  /** Attempts actually made, including the first. Equals the external calls this caused. */
  readonly attempts: number;
  /** Why we stopped, in A03's vocabulary, for the audit trail. */
  readonly stoppedBecause: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const RETRY_STOP = {
  SUCCEEDED: 'The attempt succeeded, so no retry was needed.',
} as const;

/**
 * Run `attempt` until it succeeds or `planNextRetry` says stop.
 *
 * The first call is not a retry, so a budget of N retries means at most N+1 attempts —
 * the same arithmetic `MAX_EXTERNAL_CALLS_PER_RUN` is built on.
 */
export async function withTransportRetry<T>(
  options: TransportRetryOptions<T>,
): Promise<TransportRetryResult<T>> {
  const sleep = options.sleep ?? realSleep;
  let attemptsUsed = options.attemptsUsed ?? 0;
  let attempts = 0;
  let now = options.now;

  for (;;) {
    const outcome = await options.attempt(attempts);
    attempts += 1;
    if (outcome.gap === null) {
      return { value: outcome.value, gap: null, attempts, stoppedBecause: RETRY_STOP.SUCCEEDED };
    }

    const plan = planNextRetry({
      attemptsUsed,
      now,
      lastGap: outcome.gap,
      retryAfterSeconds: outcome.retryAfterSeconds ?? null,
      ...(options.jitterSeed === undefined ? {} : { jitterSeed: options.jitterSeed }),
    });

    if (plan.nextAttemptAt === null) {
      return { value: outcome.value, gap: outcome.gap, attempts, stoppedBecause: plan.reason };
    }

    const waitMs = Math.max(0, plan.nextAttemptAt.getTime() - now.getTime());
    await sleep(waitMs);
    // Time really did move on, whether or not the injected sleep made it move. Carrying
    // the planner's own instant forward keeps the backoff arithmetic honest under a fake
    // clock instead of compounding from a frozen `now`.
    now = plan.nextAttemptAt;
    attemptsUsed += 1;
  }
}
