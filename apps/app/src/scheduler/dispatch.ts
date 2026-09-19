/**
 * The outbox dispatcher: the bridge across the commit/dispatch boundary.
 *
 * A row is written to `outbox` in the same transaction as the business change it
 * announces, so the two can never disagree. Dispatch happens afterwards, in a different
 * process, which means exactly one thing: **delivery is at-least-once and every handler
 * must be idempotent.** There is no arrangement of retries that turns this into
 * exactly-once, and pretending otherwise is how duplicate emails get sent.
 *
 * What this file guarantees:
 *  - a row is claimed by one dispatcher per attempt (compare-and-set on `attempts`);
 *  - a handler that throws cannot kill the tick or the other rows in it;
 *  - a row that keeps failing is buried after a bounded number of attempts rather than
 *    retried forever;
 *  - a row whose handler is unknown is retried and then buried, never silently dropped.
 */
import { outbox, type OutboxRow } from '../db/webhooks';
import type { Db } from '../db/d1';
import { addSecondsIso, toIso } from '../lib/time';
import { TICK_DEFAULTS, type TickBudget } from './budget';
import { SILENT_LOGGER, type OutboxEvent, type OutboxHandler, type SchedulerLogger } from './ports';

/** Attempts before a row is buried. Small: a message nobody can deliver is a bug to see. */
export const MAX_DISPATCH_ATTEMPTS = 5;

/** First retry delay, in seconds. Doubles per attempt, capped. */
export const DISPATCH_BACKOFF_BASE_SECONDS = 30;
export const DISPATCH_BACKOFF_MAX_SECONDS = 900;

export interface DispatchDeps {
  readonly db: Db;
  readonly now: Date;
  readonly budget: TickBudget;
  /** Handlers by `event_type`. A missing handler is a visible failure, not a silent drop. */
  readonly handlers: ReadonlyMap<string, OutboxHandler>;
  readonly maxAttempts?: number;
  readonly logger?: SchedulerLogger;
}

export interface DispatchReport {
  readonly examined: number;
  /** Rows this dispatcher won the claim for. */
  readonly claimed: number;
  readonly dispatched: number;
  readonly retrying: number;
  readonly dead: number;
  /** Rows another dispatcher had already claimed. Expected, not an error. */
  readonly lostRace: number;
  readonly stoppedEarly: boolean;
}

export function dispatchBackoffSeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 10));
  return Math.min(DISPATCH_BACKOFF_BASE_SECONDS * 2 ** exponent, DISPATCH_BACKOFF_MAX_SECONDS);
}

/**
 * Dispatch one bounded batch of due outbox rows.
 *
 * Never throws. A dispatcher that can fail the tick would take the due-run pass down with
 * it, and the due-run pass is the product.
 */
export async function dispatchOutbox(deps: DispatchDeps): Promise<DispatchReport> {
  const logger = deps.logger ?? SILENT_LOGGER;
  const maxAttempts = deps.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;
  const nowIso = toIso(deps.now);

  let examined = 0;
  let claimed = 0;
  let dispatched = 0;
  let retrying = 0;
  let dead = 0;
  let lostRace = 0;
  let stoppedEarly = false;

  let due: readonly OutboxRow[];
  try {
    due = await outbox.listDue(deps.db, nowIso, deps.budget.maxOutbox);
  } catch (error) {
    logger.warn('scheduler.outbox.list_failed', { message: shortMessage(error) });
    return { examined: 0, claimed: 0, dispatched: 0, retrying: 0, dead: 0, lostRace: 0, stoppedEarly: true };
  }

  for (const row of due) {
    if (!deps.budget.hasHeadroom()) {
      stoppedEarly = true;
      break;
    }
    examined += 1;

    // The claim also pushes `next_attempt_at` forward, so a dispatcher that dies holding
    // this row does not block it forever — the row simply becomes due again.
    const leaseUntil = addSecondsIso(deps.now, TICK_DEFAULTS.LEASE_SECONDS);
    let won = false;
    try {
      won = await outbox.tryClaim(deps.db, { id: row.id, expectedAttempts: row.attempts, leaseUntil });
    } catch (error) {
      logger.warn('scheduler.outbox.claim_failed', { id: row.id, message: shortMessage(error) });
      continue;
    }
    if (!won) {
      lostRace += 1;
      continue;
    }
    claimed += 1;

    const handler = deps.handlers.get(row.event_type);
    const event: OutboxEvent = {
      id: row.id,
      workspaceId: row.workspace_id,
      eventType: row.event_type,
      entityId: row.entity_id,
      uniqueEventKey: row.unique_event_key,
      payload: parsePayload(row.payload_json),
      // The attempt number this delivery is. A handler that cares whether it is a retry
      // has it; a handler that is properly idempotent does not need to look.
      attempts: row.attempts + 1,
      now: deps.now,
    };

    if (handler === undefined) {
      const state = await failRow(deps, row, `no handler for event type ${row.event_type}`, maxAttempts, logger);
      if (state === 'dead') dead += 1;
      else retrying += 1;
      continue;
    }

    let handled = false;
    let failure: string | null = null;
    try {
      handled = await handler.handle(event);
    } catch (error) {
      failure = shortMessage(error);
    }

    if (handled) {
      try {
        await outbox.markDispatched(deps.db, row.id);
        dispatched += 1;
      } catch (error) {
        // The work was done but we could not record it. The row becomes due again and the
        // handler will be called a second time — which is exactly why handlers must be
        // idempotent, and exactly the case that makes it non-negotiable.
        logger.warn('scheduler.outbox.mark_failed', { id: row.id, message: shortMessage(error) });
        retrying += 1;
      }
      continue;
    }

    const state = await failRow(deps, row, failure ?? 'handler declined the event', maxAttempts, logger);
    if (state === 'dead') dead += 1;
    else retrying += 1;
  }

  if (due.length === deps.budget.maxOutbox) deps.budget.noteBatchExhausted();

  return { examined, claimed, dispatched, retrying, dead, lostRace, stoppedEarly };
}

async function failRow(
  deps: DispatchDeps,
  row: OutboxRow,
  error: string,
  maxAttempts: number,
  logger: SchedulerLogger,
): Promise<'pending' | 'dead'> {
  const nextAttemptAt = addSecondsIso(deps.now, dispatchBackoffSeconds(row.attempts + 1));
  try {
    const state = await outbox.markFailed(deps.db, {
      id: row.id,
      error,
      nextAttemptAt,
      maxAttempts,
    });
    if (state === 'dead') {
      logger.warn('scheduler.outbox.dead', { id: row.id, event_type: row.event_type });
      return 'dead';
    }
    return 'pending';
  } catch (failureError) {
    logger.warn('scheduler.outbox.fail_write_failed', { id: row.id, message: shortMessage(failureError) });
    return 'pending';
  }
}

function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** A short, secret-free message. Provider bodies and credentials never reach a log line. */
function shortMessage(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'unknown error';
}

// ---------------------------------------------------------------------------
// The handlers we ship
// ---------------------------------------------------------------------------

/**
 * `run.created` — written by admission so the scheduler can never see a run the outbox
 * does not know about.
 *
 * There is nothing to deliver: nobody is emailed when a run starts, and telling them would
 * be noise. The row exists to prove the commit/dispatch pairing, so acknowledging it is the
 * correct handling, not a stub.
 */
export const runCreatedHandler: OutboxHandler = {
  async handle(): Promise<boolean> {
    return true;
  },
};

/**
 * What a `run.decided` announcement carries. Deliberately tiny: the payload is a pointer,
 * and anything a notification needs is read fresh at send time rather than frozen here.
 */
export interface RunDecidedPayload {
  readonly run_id: string;
  readonly status: string;
  readonly decided_at: string;
}

export function readRunDecidedPayload(payload: unknown): RunDecidedPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.run_id !== 'string' || typeof record.status !== 'string') return null;
  return {
    run_id: record.run_id,
    status: record.status,
    decided_at: typeof record.decided_at === 'string' ? record.decided_at : '',
  };
}

/**
 * The default `run.decided` handler: acknowledge, notify nobody.
 *
 * Customer alerting belongs to A09's grouping and sending layer, which decides whether a
 * transition is material and whether this workspace has already been told inside the
 * window. Until a sending transport is configured there is nothing to send, and inventing
 * a notification here would produce exactly the alert storm the grouping layer exists to
 * prevent. Replace this with `createNotifyingRunDecidedHandler` once a transport exists.
 */
export const runDecidedAcknowledgeHandler: OutboxHandler = {
  async handle(): Promise<boolean> {
    return true;
  },
};

/** The handler table the tick uses unless a caller supplies its own. */
export function defaultOutboxHandlers(): ReadonlyMap<string, OutboxHandler> {
  return new Map<string, OutboxHandler>([
    ['run.created', runCreatedHandler],
    ['run.decided', runDecidedAcknowledgeHandler],
  ]);
}
