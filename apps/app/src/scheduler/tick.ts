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
import { sendOwnerAlert, telegramTransportFromEnv } from '../notifications/telegram';
import {
  runBillingNotificationTick,
  type BillingNotificationTickReport,
} from '../notifications/billingTick';
import { runMoneyMaintenance, type MoneyMaintenanceReport } from '../money/maintenance';
import { checkBillingSecrets, createBillingRuntime } from '../billing/mount';
import { createStripeClient } from '@verify/connectors/stripe';
import { D1AllowanceRepair } from '../db/allowanceRepair';
import { runDueWorkspaceDeletions, type DueDeletionOutcome } from '../privacy/requests';
import { createNotificationDelivery } from '../notifications/delivery';
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

/** The outcome of the owner-alert pass. `outcome` is null exactly when nothing was sent. */
export interface OwnerAlertPassReport {
  readonly attempted: boolean;
  readonly outcome: string | null;
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
   * Whether this tick needed to ping the owner, and what came of it.
   *
   * `attempted: false` is the healthy state and is reported rather than omitted, because a
   * pass that never runs and a pass that is not wired look identical in a log -- which is
   * how the Telegram channel came to be unreachable without anyone noticing.
   */
  readonly ownerAlert?: OwnerAlertPassReport;
  /**
   * The billing-maintenance and customer-notification pass.
   *
   * `undefined` from `runSchedulerTick`, which does not own it; populated by
   * `handleScheduled`, which is the entry point the cron actually reaches. Optional so the
   * scheduler's own tests and the operations view are unaffected by its presence.
   */
  readonly billing?: BillingNotificationTickReport | undefined;
  /**
   * The money pass: allowance-period reconciliation and the billing maintenance both it
   * and the notification pass depend on.
   *
   * `undefined` when Stripe is not configured on this deployment, which is a legitimate
   * state and not a failure. When present, `allowanceRepairSkipped` says why the repair
   * did not run if it did not — `no_port` is a configuration fact an operator needs, not
   * an absence to shrug at.
   */
  readonly money?: MoneyMaintenanceReport | undefined;
  /**
   * Workspace deletions carried out this tick.
   *
   * Each outcome carries its own report; a deletion that did not complete is retried on a
   * later tick and is deliberately NOT announced to the customer. Telling someone their
   * data is gone while some of it remains is the one failure this message must not have.
   */
  readonly deletions?: readonly DueDeletionOutcome[] | undefined;
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
  /**
   * When true the due-run pass does not run at all.
   *
   * Set from the owner's  switch. The cost this control exists to
   * stop is the provider reads and retries inside the due pass, so that is where it is
   * enforced. Claimed runs are NOT lost: nothing is claimed, so nothing needs releasing,
   * and every due run is simply still due on the next tick once the owner un-pauses.
   *
   * Deliberately a skip rather than a zero call budget. A zero budget would report the
   * runs as deferred for want of capacity, which reads as the service struggling; this
   * reports them as paused, which is what actually happened and what the owner did.
   */
  readonly suspendDueRuns?: boolean;
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

  if (deps.suspendDueRuns === true) {
    logger.warn('scheduler.due_runs.suspended', {
      reason: 'expensive_verification is paused by the owner',
    });
  } else {
    try {
      runPass = await runDuePass(deps, budget, logger);
    } catch (caught) {
      error = messageOf(caught);
      logger.warn('scheduler.runs.failed', { message: error });
    }
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
  /**
   * The `fetch` the owner-alert pass hands to the Telegram transport.
   *
   * Injected for the same reason `notifications` is: with the global hardcoded, the only
   * way to test this pass is to let it reach the network, so it would not be tested -- and
   * an untested notification pass is how the Telegram channel came to be complete,
   * guarded, and called by nothing. Omitted in production, where the global is correct.
   */
  readonly ownerAlertFetch?: typeof fetch | undefined;
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
  /*
   * The money pass, which had no caller at all.
   *
   * `money/maintenance.ts` states in its own doc comment that this is the export
   * `scheduler/tick.ts` calls. It did not — it called the notification tick instead. So
   * `reconcileAllowancePeriods` was unreachable in production: every allowance row damaged
   * by the period-identity split stayed damaged, and a workspace showing 2 of 10 used could
   * sell eight runs nobody paid for.
   *
   * It runs BEFORE the notification pass and hands its billing report onward, because both
   * call `runBillingMaintenance` and running that twice per tick is not merely wasteful.
   * The guarantee it underwrites is that a paid period's allowance is applied exactly once,
   * and two passes over the same subscriptions at two instants is the precise shape of the
   * defect that would violate it. In production both clocks agree, so it would not be seen
   * until it mattered.
   *
   * `runMoneyMaintenance` is the right producer of the pair: it pins the runtime clock to
   * the tick instant, closing a split where the cadence was decided from one clock and the
   * seven-day boundary read from another.
   *
   * Without an allowance-repair port the repair is reported as skipped with the reason
   * `no_port`, never as done — a deployment lacking it is one where damaged rows are still
   * damaged, and the report has to say so rather than shrug.
   */
  const billingEnv = {
    ...env,
    ENVIRONMENT: env.ENVIRONMENT ?? 'development',
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? '',
  };

  /*
   * Due workspace deletions.
   *
   * `deletion_completed` is announced from here and nowhere else, and only when the purge
   * reports itself complete — a partial purge is retried and stays silent, because telling
   * a customer their data is gone while some of it remains is the one failure mode this
   * particular message must never have.
   *
   * Runs before the money pass on purpose: a deletion that is due has already waited out
   * its grace period, and a billing pass that runs long must not be what delays it.
   *
   * Bounded. Ten per tick, so a large backlog is drained across minutes rather than
   * risking a Worker invocation being killed mid-purge.
   */
  let deletions: readonly DueDeletionOutcome[] = [];
  if ((env.PUBLIC_BASE_URL ?? '').length > 0) {
    try {
      const supportPort = new D1SupportDataPort(db);
      deletions = await runDueWorkspaceDeletions({
        port: supportPort,
        notifications: createNotificationDelivery(billingEnv, supportPort, {
          now: () => now,
        }),
        baseUrl: env.PUBLIC_BASE_URL ?? '',
        now: () => now,
      });
    } catch (caught) {
      // A tick must not reject. Nothing here is destructive on the failure path: a purge
      // that did not finish is simply still due on the next tick.
      (options.logger ?? SILENT_LOGGER).warn('scheduler.deletions.failed', {
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  let money: MoneyMaintenanceReport | null = null;
  if (checkBillingSecrets(billingEnv).ready) {
    try {
      money = await runMoneyMaintenance(
        {
          billing: createBillingRuntime(billingEnv, {
            data: new D1BillingDataPort(db),
            gateway: createStripeClient({ secretKey: env.STRIPE_SECRET_KEY ?? '' }),
            billingContact: createBillingContactLookup(db),
            // Seeded from the TICK's instant, not the wall clock. `newId(prefix)` alone
            // takes Date.now(), so a builder given an injected `now` was minting ids from
            // a different clock -- the same divergence found in the two ports, in a fourth
            // builder. It also made id ordering untestable at a fixed instant.
            newId: (prefix: string) => newId(prefix, now.getTime()),
            now: () => toIso(now),
          }),
          allowanceRepair: new D1AllowanceRepair(db),
        },
        { now: toIso(now) },
      );
    } catch (caught) {
      // A tick must not reject. A cron retry nobody asked for is worse than a reported
      // failure an operator can see.
      money = null;
      (options.logger ?? SILENT_LOGGER).warn('scheduler.money.failed', {
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  const billing = await runBillingNotificationTick({
    // `BillingEnv` requires both of these as strings; `SchedulerEnv` has them optional
    // because the scheduler itself needs neither. An empty `PUBLIC_BASE_URL` cannot
    // produce a half-configured money path: `checkBillingSecrets` skips the whole pass
    // when a Stripe secret is absent, and `buildBillingConfig` throws on an invalid base
    // URL, which is caught and reported rather than acted on.
    env: billingEnv,
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
    ...(money?.billing === undefined ? {} : { maintenance: money.billing }),
  });

  /*
   * The owner alert pass, and the fifth thing in this file that had no caller.
   *
   * `notifications/telegram.ts` is a complete, guarded channel: a kind allowlist, a shape
   * guard that refuses rather than redacts, a one-method API allowlist protecting the
   * founder's running poller, and `paymentGatewayReadyAlert` written for this exact
   * situation by name. Nothing in the application called `sendOwnerAlert`. The founder
   * asked to be pinged when something needed them and the code to do it was unreachable,
   * which is this project's dominant defect class landing on the one path whose whole
   * value is timing.
   *
   * The condition is deliberately narrow: this deployment cannot take money. That is the
   * only state where the owner is genuinely the only person who can act, because the fix
   * is a secret value that must never travel through anything but `wrangler secret put`.
   *
   * `notificationKey` is derived from the environment and the sorted list of secret NAMES,
   * never a clock, so a five-minute cron sending this every tick sends it once -- and
   * sends again only if a different secret becomes the problem. `dispatchNotification`
   * enforces that; this function only has to name the event honestly.
   *
   * Never throws. A tick that cannot ping is a tick, not a retry.
   */
  let ownerAlert: OwnerAlertPassReport = { attempted: false, outcome: null };
  const billingSecrets = checkBillingSecrets(billingEnv);
  // Gated on `PUBLIC_BASE_URL`, exactly as the deletions pass above is, and for the same
  // reason: a deployment without one is not serving customers -- a local dev tick, or a
  // bare Worker -- and "this deployment cannot take payment" is not news about it. Without
  // this, every unconfigured tick anywhere would write a delivery row saying the owner
  // could not be told something that did not matter.
  if (!billingSecrets.ready && (env.PUBLIC_BASE_URL ?? '').length > 0) {
    try {
      const names = [...billingSecrets.missing].sort();
      const environment = env.STRIPE_MODE === 'live' ? 'live' : 'test';
      // The names, not the values. A secret name is a variable name.
      const notificationKey = `authentication_required:billing_secrets:${environment}:${names.join(',')}`;
      /*
       * Why a send failed has to reach somebody.
       *
       * `recordedStatusFor` deliberately discards the provider's own word -- it is right
       * that `notification_deliveries` records `sending_service_unavailable` rather than a
       * provider string, and the table has no column for a cause. But that left the
       * operator with a channel that is silent and a row that cannot say why, which is the
       * shrug this product exists to refuse. The first real failure on this path recorded
       * three attempts and nothing about the reason.
       *
       * So the tick observes the transport it owns rather than changing what is stored.
       * `redactTelegramToken` has already been applied by the transport to both the error
       * and the status, because a fetch failure commonly carries the request URL and the
       * request URL carries the token.
       */
      /*
       * `fetch` is BOUND, and that is not a style preference.
       *
       * Passing the bare global into a class that later calls `this.fetchImpl(...)` gives
       * Workers "Illegal invocation: function called with incorrect `this` reference", and
       * the send fails every attempt. No test could have caught it: every test injects a
       * plain function, which has no `this` requirement at all, so the stub passes exactly
       * where the real global fails. It was found by deploying, reading the transport's own
       * words out of a live tick, and only because the previous commit added that log line.
       */
      const inner = telegramTransportFromEnv(
        env as unknown as Readonly<Record<string, unknown>>,
        options.ownerAlertFetch ?? globalThis.fetch.bind(globalThis),
      );
      const observed =
        inner === undefined
          ? undefined
          : {
              send: async (message: Parameters<typeof inner.send>[0]) => {
                const outcome = await inner.send(message);
                if (!outcome.accepted) {
                  // eslint-disable-next-line no-console -- the operator's only view of this channel
                  console.log('owner_alert', {
                    event: 'telegram_attempt_failed',
                    provider_status: outcome.providerStatus,
                    retryable: outcome.retryable,
                  });
                }
                return outcome;
              },
            };

      /*
       * A standing condition gets another chance; a delivered message does not.
       *
       * `dispatchNotification` claims the key before sending and settles the outcome onto
       * the same row, so one transient failure would take this key forever -- and it did:
       * production and staging each hold one `failed` row for this alert and neither could
       * ever fire again. The condition it describes is still true, which is exactly why the
       * key must be releasable. `releaseUndelivered` refuses to touch a `sent` row in SQL,
       * so this cannot become a way to buzz a phone twice about one thing.
       */
      const supportPort = new D1SupportDataPort(db);
      await supportPort.releaseUndeliveredNotification(notificationKey);

      const result = await sendOwnerAlert(
        {
          port: supportPort,
          transport: observed,
          now: () => now,
        },
        {
          kind: 'authentication_required',
          notificationKey,
          headline: 'Payments are not configured on a deployment',
          detail:
            `The ${environment} deployment cannot take payment. ` +
            `Unset or unusable: ${names.join(', ')}. ` +
            'Only you can set these, because the value must not pass through the assistant, ' +
            'a log or a screenshot. Set each one with wrangler secret put, then the checkout ' +
            'control appears on the review page by itself.',
        },
      );
      ownerAlert = { attempted: true, outcome: result.outcome };
    } catch (caught) {
      (options.logger ?? SILENT_LOGGER).warn('scheduler.owner_alert.failed', {
        message: caught instanceof Error ? caught.message : String(caught),
      });
      ownerAlert = { attempted: true, outcome: 'failed' };
    }
  }

  return {
    ...report,
    billing,
    ownerAlert,
    ...(money === null ? {} : { money }),
    ...(deletions.length === 0 ? {} : { deletions }),
  };
}

export { createRetentionSweeper };
