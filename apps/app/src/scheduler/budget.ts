/**
 * The tick's budgets.
 *
 * A Cloudflare Worker invocation that overruns is killed mid-flight, and we do not get to
 * choose when. So the tick is bounded in every dimension it can spend: how many runs it
 * takes, how long it may stay alive, and how many external calls it may cause. Whichever
 * ceiling binds first stops the work cleanly at a boundary we chose, leaving the remainder
 * for the next minute rather than being cut off somewhere we did not.
 *
 * The per-run ceiling from `@verify/domain` is nested inside the per-tick one, so the two
 * cannot multiply: a tick can never cause more calls than `maxExternalCalls`, however many
 * runs it claims.
 */
import { LIMITS } from '@verify/contracts';
import { MAX_EXTERNAL_CALLS_PER_RUN } from '@verify/domain';
import type { ElapsedFn } from './ports';

export const TICK_DEFAULTS = {
  /** Runs claimed per tick. Small: a minute is short and D1 is not a queue. */
  MAX_RUNS_PER_TICK: 10,
  /** Outbox rows dispatched per tick. */
  MAX_OUTBOX_PER_TICK: 25,
  /**
   * Wall-clock budget. Well inside a Worker's CPU and duration limits, with room for the
   * writes already in flight when the budget binds.
   */
  WALL_CLOCK_MS: 20_000,
  /**
   * External provider calls per tick, across every run. Deliberately smaller than
   * `MAX_RUNS_PER_TICK × MAX_EXTERNAL_CALLS_PER_RUN`: the per-run ceiling is a worst case
   * for one pathological run, not an allowance every run is expected to spend.
   */
  MAX_EXTERNAL_CALLS: 40,
  /** Lease held over a claimed run. Long enough to finish, short enough to reclaim. */
  LEASE_SECONDS: 120,
  /** Retention rows removed per tick, per target. Small and resumable by design. */
  RETENTION_BATCH_SIZE: 50,
  RETENTION_MAX_BATCHES: 2,
  /**
   * How soon a terminal run is revisited to finish its finalisation (outbox row and
   * allowance settlement) if the tick that decided it died in between.
   */
  FINALISE_DELAY_SECONDS: 30,
} as const;

export interface TickBudgetOptions {
  readonly wallClockMs?: number;
  readonly maxExternalCalls?: number;
  readonly maxRuns?: number;
  readonly maxOutbox?: number;
  /** Elapsed milliseconds since the tick began. Injected; see `ports.ts`. */
  readonly elapsed?: ElapsedFn;
}

export type BudgetStop = 'wall_clock' | 'external_calls' | 'batch' | null;

/**
 * A tick's spending account. Every loop asks it before starting more work, and it is the
 * only thing that decides when the tick stops early.
 */
export class TickBudget {
  readonly wallClockMs: number;
  readonly maxExternalCalls: number;
  readonly maxRuns: number;
  readonly maxOutbox: number;

  #callsUsed = 0;
  #elapsed: ElapsedFn;
  #stoppedBecause: BudgetStop = null;

  constructor(options: TickBudgetOptions = {}) {
    this.wallClockMs = Math.max(1, options.wallClockMs ?? TICK_DEFAULTS.WALL_CLOCK_MS);
    this.maxExternalCalls = Math.max(0, options.maxExternalCalls ?? TICK_DEFAULTS.MAX_EXTERNAL_CALLS);
    this.maxRuns = Math.max(0, options.maxRuns ?? TICK_DEFAULTS.MAX_RUNS_PER_TICK);
    this.maxOutbox = Math.max(0, options.maxOutbox ?? TICK_DEFAULTS.MAX_OUTBOX_PER_TICK);
    const started = Date.now();
    this.#elapsed = options.elapsed ?? (() => Date.now() - started);
  }

  get callsUsed(): number {
    return this.#callsUsed;
  }

  get elapsedMs(): number {
    return this.#elapsed();
  }

  get stoppedBecause(): BudgetStop {
    return this.#stoppedBecause;
  }

  /** External calls still available to the whole tick. */
  get callsRemaining(): number {
    return Math.max(0, this.maxExternalCalls - this.#callsUsed);
  }

  /** True while there is time and call budget left to start another unit of work. */
  hasHeadroom(): boolean {
    if (this.elapsedMs >= this.wallClockMs) {
      this.#stoppedBecause = 'wall_clock';
      return false;
    }
    return true;
  }

  /**
   * True when a run may still make provider calls. A run with no headroom is not failed —
   * it is simply not observed this tick, and its lease will expire so the next tick takes
   * it. Refusing to start is always safer than being killed halfway through one.
   */
  canSpendCalls(atLeast = 1): boolean {
    if (this.callsRemaining < atLeast) {
      this.#stoppedBecause = 'external_calls';
      return false;
    }
    return true;
  }

  /** Record calls a connector actually made. Never an estimate; connectors report it. */
  spendCalls(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.#callsUsed += Math.trunc(count);
  }

  noteBatchExhausted(): void {
    if (this.#stoppedBecause === null) this.#stoppedBecause = 'batch';
  }

  /**
   * The most calls a single run may make in this tick: the lesser of what the run's own
   * ceiling allows and what the tick has left. This is where the two budgets nest.
   */
  runCallAllowance(): number {
    return Math.min(MAX_EXTERNAL_CALLS_PER_RUN, this.callsRemaining);
  }
}

/** Observations a run has left, from the count it has already spent. */
export function observationsRemainingAfter(observationCount: number): number {
  return Math.max(0, LIMITS.MAX_OBSERVATIONS_PER_RUN - observationCount);
}
