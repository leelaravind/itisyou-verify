/**
 * Retention, one small bite per tick.
 *
 * A full retention pass is unbounded by nature: it depends on how much expired data there
 * is, which is exactly the number we cannot know before starting. So the tick never asks
 * for one. It asks for a couple of small keyset-paged batches, and A09's sweep is
 * resumable, so the next minute continues where this one stopped.
 *
 * Deleting slowly is the right trade. Data that expired a minute ago and is deleted three
 * minutes later has still been deleted; a tick that is killed halfway through an unbounded
 * delete leaves nothing useful behind and may have to be repeated.
 */
import { runRetentionSweep } from '../privacy/retention';
import type { SupportDataPort } from '../support/port';
import { TICK_DEFAULTS, type TickBudget } from './budget';
import { SILENT_LOGGER, type RetentionSweeper, type SchedulerLogger } from './ports';

export interface RetentionPassReport {
  readonly ran: boolean;
  readonly removed: number;
  /** True when every target reported it had nothing left to remove. */
  readonly complete: boolean;
  /** Present when the sweep could not run at all. Never fails the tick. */
  readonly error: string | null;
}

export interface RetentionPassDeps {
  readonly now: Date;
  readonly budget: TickBudget;
  readonly sweeper?: RetentionSweeper | undefined;
  readonly logger?: SchedulerLogger;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/**
 * Run one bounded retention pass, if there is budget left for it.
 *
 * Retention is the last thing a tick does and the first thing it gives up: a minute spent
 * observing runs is worth more than a minute spent deleting rows that will still be
 * expired next minute.
 */
export async function runRetentionPass(deps: RetentionPassDeps): Promise<RetentionPassReport> {
  const logger = deps.logger ?? SILENT_LOGGER;
  if (deps.sweeper === undefined) {
    return { ran: false, removed: 0, complete: true, error: null };
  }
  if (!deps.budget.hasHeadroom()) {
    return { ran: false, removed: 0, complete: false, error: null };
  }

  try {
    const result = await deps.sweeper.sweep({
      now: deps.now,
      batchSize: deps.batchSize ?? TICK_DEFAULTS.RETENTION_BATCH_SIZE,
      maxBatches: deps.maxBatches ?? TICK_DEFAULTS.RETENTION_MAX_BATCHES,
    });
    if (result.removed > 0) {
      logger.info('scheduler.retention.swept', {
        removed: result.removed,
        complete: result.complete,
      });
    }
    return { ran: true, removed: result.removed, complete: result.complete, error: null };
  } catch (error) {
    // Housekeeping must never fail the tick that verifies customers' runs.
    const message = error instanceof Error ? error.name : 'unknown error';
    logger.warn('scheduler.retention.failed', { message });
    return { ran: true, removed: 0, complete: false, error: message };
  }
}

/** The production sweeper, over A09's resumable, keyset-paged implementation. */
export function createRetentionSweeper(port: SupportDataPort): RetentionSweeper {
  return {
    async sweep(input) {
      const report = await runRetentionSweep(port, {
        now: input.now,
        batchSize: input.batchSize,
        maxBatchesPerTarget: input.maxBatches,
      });
      return { removed: report.totalRemoved, complete: report.complete };
    },
  };
}
