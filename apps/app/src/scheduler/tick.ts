/**
 * The tick.
 *
 * One entry point, called once a minute by the Worker's `scheduled()` handler, doing three
 * things in a deliberate order:
 *
 *   1. **Due runs.** The product. Claim, observe, decide, persist.
 *   2. **The outbox.** Announcements for what step 1 committed.
 *   3. **Retention.** Housekeeping, last and first to be given up.
 *
 * Everything is bounded, and every boundary is a place we chose to stop. A Worker
 * invocation that overruns is killed wherever it happens to be, so the tick's job is to be
 * somewhere safe when the minute ends: between runs, never inside one.
 *
 * The tick never throws. A scheduled handler that rejects produces a retry we do not
 * control and a log line nobody reads; a tick that returns a report produces a number we
 * can look at.
 */
import { sha256Hex } from '@verify/security';
import { getConnector, type ProviderId } from '@verify/connectors';
import { runs, type DueRun } from '../db/runs';
import { D1BillingDataPort, createBillingContactLookup } from '../db/billingPort';
import { D1SupportDataPort } from '../db/supportPort';
import {
  runBillingNotificationTick,
  type BillingNotificationTickReport,
} from '../notifications/billingTick';
import type { NotificationDelivery, DeliveryLog } from '../notifications/delivery';
import type { SubscriptionPeriodSource } from '../billing/period';
import type { Db } from '../db/d1';
import { newId } from '../lib/ids';
import { addSecondsIso, toIso } from '../lib/time';
import { TICK_DEFAULTS, TickBudget, type BudgetStop, type TickBudgetOptions } from './budget';
import { createD1CredentialResolver, NOT_CONNECTED_RESOLVER } from './credentials';
import { defaultOutboxHandlers, dispatchOutbox, type DispatchReport } from './dispatch';
import { deferredOutcome, observeRun, type ObservationOutcome } from './observe';
import { createRetentionSweeper, runRetentionPass, type RetentionPassReport } from './retention';
import {
  SILENT_LOGGER,
  type ConnectorRegistry,
  type CredentialResolver,
  type DigestFn,
  type IdFactory,
  type OutboxHandler,
  type RetentionSweeper,
  type SchedulerLogger,
} from './ports';

export interface RunPassReport {
  readonly claimed: number;
  readonly observed: number;
  readonly terminal: number;
  readonly deferred: number;
  readonly stale: number;
  readonly callsMade: number;
  /**
   * Runs whose workflow asked for coverage we do not implement. Any number above zero is a
   * configuration that is promising a customer more than we can deliver; the operations
   * view surfaces it rather than letting it pass unremarked.
   */
  readonly coverageWarnings: number;
  readonly outcomes: readonly ObservationOutcome[];
}

export interface TickReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runs: RunPassReport;
  readonly outbox: DispatchReport;
  readonly retention: RetentionPassReport;
  readonly budget: {
    readonly callsUsed: number;
    readonly maxExternalCalls: number;
    readonly elapsedMs: number;
    readonly stoppedBecause: BudgetStop;
  };
  /** Set when the tick itself failed. The handler still resolves; the number is the signal. */
  readonly error: string | null;
  /**
   * The billing-maintenance and customer-notification pass.
   *
   * `undefined` from `runSchedulerTick`, which does not own it; populated by
   * `handleScheduled`, which is the entry point the cron actually reaches. Optional so the
   * scheduler's own tests and the operations view are unaffected by its presence.
   */
  readonly billing?: BillingNotificationTickReport | undefined;
}

export interface TickDeps {
  readonly db: Db;
  /** Injected. Nothing in the tick reads a wall clock for business time. */
  readonly now: Date;
  readonly resolver: CredentialResolver;
  /**
   * Where the allowance period key is read from. Required: the scheduler must never derive
   * one of its own (A13-010).
   */
  readonly billing: SubscriptionPeriodSource;
  readonly billingEnvironment?: 'test' | 'live';
  readonly connectors?: ConnectorRegistry;
  readonly handlers?: ReadonlyMap<string, OutboxHandler>;
  readonly sweeper?: RetentionSweeper | undefined;
  readonly budget?: TickBudget | TickBudgetOptions;
  readonly newId?: IdFactory;
  readonly digest?: DigestFn;
  readonly logger?: SchedulerLogger;
}

/**
 * The scheduler passes that actually exist.
 *
 * Bound to `COVERAGE_MODE_REQUIREMENTS` by the capability test: a coverage mode whose
 * required pass is not named here cannot be marked supported. Adding a name to this list
 * without writing the pass behind it fails that test, which is exactly the point — the list
 * is a claim, and the test is what stops a claim running ahead of its implementation.
 *
 * There is deliberately no `enumeration` pass. Nothing in this product can list records it
 * was never told about.
 */
export const IMPLEMENTED_SCHEDULER_PASSES = ['due_job', 'outbox', 'retention'] as const;
export type SchedulerPass = (typeof IMPLEMENTED_SCHEDULER_PASSES)[number];

/** The real connector registry. Closed over `ProviderId`, so no string can reach it. */
export const PRODUCTION_CONNECTORS: ConnectorRegistry = {
  get: (provider: ProviderId) => getConnector(provider),
};

const DEFAULT_DIGEST: DigestFn = (input: string) => sha256Hex(input);

/**
 * Run one scheduler tick.
 *
 * Returns a report rather than throwing, always. Callers that want to know whether
 * anything went wrong read `report.error` and the counts.
 */
export async function runSchedulerTick(deps: TickDeps): Promise<TickReport> {
  const logger = deps.logger ?? SILENT_LOGGER;
  const budget =
    deps.budget instanceof TickBudget ? deps.budget : new TickBudget(deps.budget ?? {});
  const startedAt = toIso(deps.now);

  let runPass: RunPassReport = {
    claimed: 0,
    observed: 0,
    terminal: 0,
    deferred: 0,
    stale: 0,
    callsMade: 0,
    coverageWarnings: 0,
    outcomes: [],
  };
  let dispatchReport: DispatchReport = {
    examined: 0,
    claimed: 0,
    dispatched: 0,
    retrying: 0,
    dead: 0,
    lostRace: 0,
    stoppedEarly: false,
  };
  let retentionReport: RetentionPassReport = {
    ran: false,
    removed: 0,
    complete: true,
    error: null,
  };
  let error: string | null = null;

  try {
    runPass = await runDuePass(deps, budget, logger);
  } catch (caught) {
    error = messageOf(caught);
    logger.warn('scheduler.runs.failed', { message: error });
  }

  try {
    dispatchReport = await dispatchOutbox({
      db: deps.db,
      now: deps.now,
      budget,
      handlers: deps.handlers ?? defaultOutboxHandlers(),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
  } catch (caught) {
    error = error ?? messageOf(caught);
    logger.warn('scheduler.outbox.failed', { message: messageOf(caught) });
  }

  try {
    retentionReport = await runRetentionPass({
      now: deps.now,
      budget,
      sweeper: deps.sweeper,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
  } catch (caught) {
    error = error ?? messageOf(caught);
  }

  const report: TickReport = {
    startedAt,
    finishedAt: toIso(deps.now),
    runs: runPass,
    outbox: dispatchReport,
    retention: retentionReport,
    budget: {
      callsUsed: budget.callsUsed,
      maxExternalCalls: budget.maxExternalCalls,
      elapsedMs: budget.elapsedMs,
      stoppedBecause: budget.stoppedBecause,
    },
    error,
  };

  logger.info('scheduler.tick', {
    claimed: runPass.claimed,
    terminal: runPass.terminal,
    dispatched: dispatchReport.dispatched,
    removed: retentionReport.removed,
    calls: budget.callsUsed,
    coverage_warnings: runPass.coverageWarnings,
  });

  return report;
}

/**
 * Claim and observe one bounded batch of due runs.
 *
 * The lease is what makes a killed tick safe: `claimDue` pushes each claimed run's
 * `next_check_at` to the end of the lease, so a run whose worker dies is not lost and is
 * not claimed forever — it simply becomes due again when the lease expires, and the next
 * tick picks it up. Nothing here needs to detect the crash; the absence of a completion is
 * the detection.
 */
async function runDuePass(
  deps: TickDeps,
  budget: TickBudget,
  logger: SchedulerLogger,
): Promise<RunPassReport> {
  const nowIso = toIso(deps.now);
  const leaseUntil = addSecondsIso(deps.now, TICK_DEFAULTS.LEASE_SECONDS);

  const claimed: DueRun[] = await runs.claimDue(deps.db, {
    now: nowIso,
    limit: budget.maxRuns,
    leaseSeconds: TICK_DEFAULTS.LEASE_SECONDS,
    leaseUntil,
  });

  if (claimed.length === budget.maxRuns) budget.noteBatchExhausted();

  const outcomes: ObservationOutcome[] = [];
  let observed = 0;
  let terminal = 0;
  let deferred = 0;
  let stale = 0;
  let callsMade = 0;
  let coverageWarnings = 0;

  const observeDeps = {
    db: deps.db,
    now: deps.now,
    connectors: deps.connectors ?? PRODUCTION_CONNECTORS,
    resolver: deps.resolver,
    budget,
    newId: deps.newId ?? ((prefix: string) => newId(prefix)),
    digest: deps.digest ?? DEFAULT_DIGEST,
    billing: deps.billing,
    billingEnvironment: deps.billingEnvironment ?? 'test',
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  };

  for (const run of claimed) {
    // Between runs is the safe place to stop. Inside one is not.
    if (!budget.hasHeadroom()) {
      outcomes.push(deferredOutcome(run));
      deferred += 1;
      continue;
    }

    let outcome: ObservationOutcome;
    try {
      outcome = await observeRun(run, observeDeps);
    } catch (caught) {
      // One run's failure must never cost the other nine. The lease expires and this run
      // is observed again; nothing about it has been decided.
      logger.warn('scheduler.run.failed', { run_id: run.id, message: messageOf(caught) });
      outcome = deferredOutcome(run);
    }

    outcomes.push(outcome);
    callsMade += outcome.callsMade;
    if (outcome.coverageWarning !== null) coverageWarnings += 1;
    if (outcome.note === 'deferred') deferred += 1;
    else if (outcome.note === 'stale') stale += 1;
    else observed += 1;
    if (outcome.terminal && outcome.applied) terminal += 1;
  }

  return {
    claimed: claimed.length,
    observed,
    terminal,
    deferred,
    stale,
    callsMade,
    coverageWarnings,
    outcomes,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

// ---------------------------------------------------------------------------
// The Worker entry point
// ---------------------------------------------------------------------------

/**
 * The slice of the Worker `Env` the scheduler needs.
 *
 * Structural on purpose: `apps/app/src/index.ts` owns `Env`, and its interface already
 * satisfies this one, so wiring the tick needs no change to the entry point's types.
 */
export interface SchedulerEnv {
  readonly DB: D1Database;
  readonly ENVIRONMENT?: string | undefined;
  readonly CREDENTIAL_KEY_V1?: string | undefined;
  /** Which Stripe world this deployment's subscriptions live in. Defaults to test. */
  readonly STRIPE_MODE?: string | undefined;

  /* -- the billing-maintenance and notification pass ------------------------ *
   *
   * Optional and structural, all of them. The Worker's `Env` already satisfies this, and a
   * deployment missing any Stripe secret skips the pass entirely rather than degrading:
   * an unconfigured development Worker makes no provider call on its tick. See
   * `notifications/billingTick.ts`.
   */
  readonly PUBLIC_BASE_URL?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_PRICE_ID?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  readonly STRIPE_WEBHOOK_PATH_ID?: string | undefined;
  readonly STRIPE_WEBHOOK_UNKNOWN_KEY?: string | undefined;
  readonly RESEND_API_KEY?: string | undefined;
  readonly RESEND_FROM_ADDRESS?: string | undefined;
}

export interface ScheduledOptions {
  /** Injected clock. Production passes the cron's own scheduled time. */
  readonly now?: Date;
  readonly logger?: SchedulerLogger;
  readonly sweeper?: RetentionSweeper | undefined;
  /**
   * Where a customer notification produced by the billing pass is sent.
   *
   * Injected in tests so nothing builds a Resend client and nothing reaches the network.
   * Omitted in production, where it is built from `RESEND_API_KEY` and
   * `RESEND_FROM_ADDRESS`; absent those, every notification is still claimed and recorded
   * as `no_email_transport_configured` rather than silently not happening.
   */
  readonly notifications?: NotificationDelivery | undefined;
  readonly notificationLog?: DeliveryLog | undefined;
  /** Run every billing job regardless of the minute. Tests and a manual owner trigger. */
  readonly forceBillingMaintenance?: boolean | undefined;
}

/**
 * **This is the export `scheduled()` calls.**
 *
 *     import { handleScheduled } from './scheduler/index.js';
 *     // ...
 *     async scheduled(event: ScheduledController, env: Env): Promise<void> {
 *       await handleScheduled(env, { now: new Date(event.scheduledTime) });
 *     }
 *
 * It resolves for every outcome, including failure: a rejected scheduled handler buys a
 * retry we did not ask for and cannot bound, and the tick is already designed to leave a
 * safe, resumable state whenever it stops.
 */
export async function handleScheduled(
  env: SchedulerEnv,
  options: ScheduledOptions = {},
): Promise<TickReport> {
  const now = options.now ?? new Date();
  const db = env.DB as unknown as Db;
  const resolver =
    env.CREDENTIAL_KEY_V1 === undefined || env.CREDENTIAL_KEY_V1.length === 0
      ? // No wrapping key on this deployment: nothing can be opened, so nothing is dialled.
        // Stating that as a configured resolver beats discovering it one decrypt at a time.
        NOT_CONNECTED_RESOLVER
      : createD1CredentialResolver({ db, credentialKeyBase64: env.CREDENTIAL_KEY_V1 });

  const report = await runSchedulerTick({
    db,
    now,
    resolver,
    // The allowance period key is owned by billing and read through this port. The
    // scheduler holds a workspace and an instant, and nothing else about billing.
    billing: new D1BillingDataPort(db),
    billingEnvironment: env.STRIPE_MODE === 'live' ? 'live' : 'test',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.sweeper === undefined ? {} : { sweeper: options.sweeper }),
  });

  // The fourth pass, and the one that had no caller at all.
  //
  // `billing/scheduled.ts` documents its own contract — "A03's tick calls
  // `runBillingMaintenance(runtime, { now })` and does nothing else" — and nothing called
  // it. So the seven-day payment-recovery window never reached day 8, no subscription was
  // ever marked `unpaid`, and the notification telling a customer their verification is
  // paused was built by a function with no caller. Last in the tick, deliberately: the
  // product's own work comes first, and a billing pass that cannot run must not cost a
  // due run its observation.
  //
  // Never throws. A configuration failure is a populated `failures` list, which is a
  // number the operator can see; a rejection here would be a cron retry nobody asked for.
  const billing = await runBillingNotificationTick({
    // `BillingEnv` requires both of these as strings; `SchedulerEnv` has them optional
    // because the scheduler itself needs neither. An empty `PUBLIC_BASE_URL` cannot
    // produce a half-configured money path: `checkBillingSecrets` skips the whole pass
    // when a Stripe secret is absent, and `buildBillingConfig` throws on an invalid base
    // URL, which is caught and reported rather than acted on.
    env: {
      ...env,
      ENVIRONMENT: env.ENVIRONMENT ?? 'development',
      PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? '',
    },
    billingData: new D1BillingDataPort(db),
    supportPort: new D1SupportDataPort(db),
    billingContact: createBillingContactLookup(db),
    newId: (prefix: string) => newId(prefix),
    now: toIso(now),
    ...(options.notifications === undefined ? {} : { delivery: options.notifications }),
    ...(options.notificationLog === undefined ? {} : { log: options.notificationLog }),
    ...(options.forceBillingMaintenance === undefined
      ? {}
      : { force: options.forceBillingMaintenance }),
  });

  return { ...report, billing };
}

export { createRetentionSweeper };
