/**
 * Observing one run: gather, evaluate, decide, persist, settle, reschedule.
 *
 * The order of the writes in `finaliseRun` is the crash-safety design, not an accident.
 * Read the comment there before changing it.
 *
 * Three properties this file has to keep true:
 *
 *  1. **An unreachable provider never produces FAILED.** Not through a thrown error, not
 *     through a missing credential, not through an empty bundle. The only route to FAILED
 *     is evidence that contradicts a mandatory rule, or an absence the provider itself
 *     authoritatively confirmed after the deadline.
 *  2. **A provider we cannot reach at all costs zero calls.** If the credential will not
 *     open, we do not dial.
 *  3. **The per-run call ceiling survives being driven by this code.** The tick's budget
 *     is checked before each connector call and the connector's own reported `calls_made`
 *     is what gets spent — never an estimate.
 */
import {
  LIMITS,
  sourceEventSchema,
  workflowRulesSchema,
  type EvidenceBundle,
  type ConnectorErrorCode,
  type EvidenceGap,
  type RunStatus,
  type WorkflowRules,
} from '@verify/contracts';
import {
  MAX_EXTERNAL_CALLS_PER_RUN,
  coverageWarningFor,
  decideRunStatus,
  evaluateAssertions,
  planNextObservation,
  type AssertionResult,
  type CoverageWarning,
} from '@verify/domain';
import { D1ResendWebhookDataPort } from '../db/resendWebhookPort.js';
import {
  makeGap,
  toEvidenceBundle,
  totalCalls,
  type ConnectorFetchResult,
  type EvidenceLocator,
  type ProviderId,
} from '@verify/connectors';
import { maskEmail, stableStringify } from '@verify/security';
import { assertions, evidence as evidenceRepo, runAttempts, runs, type DueRun } from '../db/runs';
import { workflowVersions } from '../db/workflows';
import { sourceEvents } from '../db/sourceEvents';
import { entitlements } from '../db/entitlements';
import { outbox } from '../db/webhooks';
import {
  isAllowancePeriodKey,
  resolveAllowancePeriodKey,
  type SubscriptionPeriodSource,
} from '../billing/period';
import type { Db } from '../db/d1';
import { addSecondsIso, parseIso, toIso } from '../lib/time';
import { ID_PREFIX } from '../lib/ids';
import { TICK_DEFAULTS, observationsRemainingAfter, type TickBudget } from './budget';
import type {
  ConnectionUnavailableReason,
  ConnectorRegistry,
  CredentialResolver,
  DigestFn,
  IdFactory,
  ResolvedConnection,
  SchedulerLogger,
} from './ports';
import { SILENT_LOGGER } from './ports';

/** Which provider answers for which evidence source. The only mapping in the product. */
const PROVIDER_FOR_SOURCE: Readonly<Record<'crm_record' | 'email_event', ProviderId>> = {
  crm_record: 'hubspot',
  email_event: 'resend',
};

/**
 * How a connection failure is expressed to the evaluator.
 *
 * All four are terminal connector codes, which is what makes `planNextObservation` stop
 * scheduling instead of burning the run's four observations on a problem no amount of
 * waiting will fix. They reach the customer as `CONNECTION_UNAVAILABLE` — "we could not
 * look" — and can never become FAILED.
 */
const GAP_CODE_FOR_REASON: Readonly<Record<ConnectionUnavailableReason, ConnectorErrorCode>> = {
  not_connected: 'PERMISSION_MISSING',
  connection_not_ready: 'PERMISSION_MISSING',
  no_credential: 'PERMISSION_MISSING',
  credential_unreadable: 'AUTH_EXPIRED',
};

export type ObservationNote =
  /** Evidence was gathered and the run was judged. */
  | 'observed'
  /** A newer attempt had already written; this result was discarded. */
  | 'stale'
  /** The run was already terminal and only needed its finalisation completing. */
  | 'finalised'
  /** The run's rules could not be evaluated at all. Resolved UNVERIFIED, never FAILED. */
  | 'rules_unusable'
  /** The tick ran out of budget before this run could be observed. Lease will expire. */
  | 'deferred';

export interface ObservationOutcome {
  readonly runId: string;
  readonly workspaceId: string;
  readonly status: RunStatus;
  readonly reason: string;
  readonly terminal: boolean;
  /** False when a newer revision had already written and this result was discarded. */
  readonly applied: boolean;
  readonly note: ObservationNote;
  readonly callsMade: number;
  readonly nextCheckAt: string | null;
  readonly assertionsWritten: number;
  readonly allowanceSettled: boolean;
  /**
   * Non-null when this run's workflow asked for coverage we do not implement. The run is
   * still observed — with the coverage we actually have — but the claim is never handled
   * silently. See `coverage.ts`: `independently_sourced` is not built.
   */
  readonly coverageWarning: CoverageWarning | null;
}

export interface ObserveDeps {
  readonly db: Db;
  readonly now: Date;
  readonly connectors: ConnectorRegistry;
  readonly resolver: CredentialResolver;
  readonly budget: TickBudget;
  readonly newId: IdFactory;
  readonly digest: DigestFn;
  /**
   * Where the allowance period key comes from. Required, not optional: the defect this
   * replaced (A13-010) was a consumer deriving a key of its own, and an optional port is a
   * port somebody forgets to pass. The scheduler must be unable to settle without it.
   */
  readonly billing: SubscriptionPeriodSource;
  readonly billingEnvironment: 'test' | 'live';
  readonly logger?: SchedulerLogger;
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'VERIFIED',
  'FAILED',
  'UNVERIFIED',
]);

/** The reason a run resolved without ever being evaluable. Plain, and never accusatory. */
const RULES_UNUSABLE_REASON =
  'We could not run this workflow’s checks, so this run is unverified rather than failed. The checks need editing before we can judge a run against them.';

const DEFERRED_REASON =
  'This run was not checked in this cycle and will be picked up in the next one.';

/**
 * Observe one claimed run.
 *
 * `run` must be a run this caller actually won from `runs.claimDue`, carrying the revision
 * the claim produced. Everything written here is conditional on that revision still being
 * current, so a slow worker finishing after a faster one simply discards its result.
 */
export async function observeRun(run: DueRun, deps: ObserveDeps): Promise<ObservationOutcome> {
  const logger = deps.logger ?? SILENT_LOGGER;
  const nowIso = toIso(deps.now);

  const row = await runs.get(deps.db, run.workspace_id, run.id);
  if (row === null) {
    // Deleted between the claim and now — a data-deletion request, most likely. Nothing to
    // do and nothing to repair.
    return outcome(
      run,
      'UNVERIFIED',
      'This run no longer exists.',
      false,
      'stale',
      0,
      null,
      0,
      false,
    );
  }

  // A run that is already terminal but still due is one whose finalisation did not finish:
  // the tick that decided it died between committing the outcome and announcing it. Finish
  // that, and nothing else — no provider calls, no re-evaluation, no second decision.
  if (TERMINAL_STATUSES.has(row.status)) {
    const settled = await finaliseTerminalRun(
      {
        db: deps.db,
        workspaceId: run.workspace_id,
        runId: run.id,
        expectedRevision: run.revision,
        status: row.status,
        observationCount: row.observation_count,
        createdAt: row.created_at,
        now: deps.now,
        newId: deps.newId,
        billing: deps.billing,
        billingEnvironment: deps.billingEnvironment,
      },
      logger,
    );
    return outcome(
      run,
      row.status,
      'This run was already decided; its notification and allowance have now been settled.',
      true,
      'finalised',
      0,
      null,
      0,
      settled,
    );
  }

  const attemptId = deps.newId(ID_PREFIX.runAttempt);
  await runAttempts.start(deps.db, {
    id: attemptId,
    workspaceId: run.workspace_id,
    runId: run.id,
    leaseId: attemptId,
    leaseExpiresAt: run.next_check_at,
    startedAt: nowIso,
  });

  // -------------------------------------------------------------------------
  // 1. What are we checking, and against what?
  // -------------------------------------------------------------------------
  const rules = await loadRules(deps.db, run);
  if (rules === null) {
    const result = await resolveWithoutEvaluation(
      run,
      row.observation_count,
      deps,
      RULES_UNUSABLE_REASON,
    );
    await runAttempts.finish(deps.db, {
      workspaceId: run.workspace_id,
      attemptId,
      endedAt: nowIso,
      outcome: 'rules_unusable',
      errorCode: 'WORKFLOW_RULES_INVALID',
    });
    return { ...result, note: 'rules_unusable' };
  }

  /*
   * Coverage. `independently_sourced` is selectable nowhere any more, but a hand-written
   * row, a restored backup or a future migration could still carry it — and a workflow
   * claiming coverage we do not have must never be processed as though we had it.
   *
   * The degrade is deliberate and total: we run the ordinary customer-triggered due-job
   * pass, which is the only coverage that exists, and we carry a critical warning out with
   * the outcome so the operations view and the customer's report can both say so. Behaving
   * quietly as if coverage were independent is the one outcome that must be impossible.
   */
  const coverageWarning = coverageWarningFor(rules.coverage_mode);
  if (coverageWarning !== null) {
    logger.warn('scheduler.coverage.unsupported', {
      run_id: run.id,
      workflow_id: run.workflow_id,
      requested_mode: coverageWarning.requested_mode,
      effective_mode: coverageWarning.effective_mode,
    });
  }

  const sourceEvent = await sourceEvents.getForRun(deps.db, run.workspace_id, run.id);
  const occurredAt = parseIso(sourceEvent?.occurred_at ?? row.created_at);
  const locator = readLocator(sourceEvent?.payload_json ?? null);

  // A delivery event can arrive before the run that was waiting for it: the provider fires
  // `email.sent` within milliseconds of the send, and the signed source event describing
  // the enquiry arrives afterwards. Those callbacks are parked in the evidence inbox
  // because nothing could bind them at the time. This is the run that can.
  //
  // Claimed BEFORE gathering, so the record is complete even when the readback below
  // succeeds, and so a readback that fails still has whatever the provider already told us
  // rather than nothing at all. Bounded, idempotent, and scoped to this workspace.
  if (locator.message_id !== undefined) {
    try {
      await claimParkedEmailEvidenceForRun(deps.db, {
        workspaceId: run.workspace_id,
        runId: run.id,
        messageId: locator.message_id,
        now: toIso(deps.now),
      });
    } catch (error) {
      // Draining the inbox is a bonus, never a precondition. A failure here must not stop
      // the run being observed, because the readback is the authoritative path.
      deps.logger?.warn?.('scheduler.inbox.claim_failed', {
        run_id: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Gather evidence, spending nothing we do not have to
  // -------------------------------------------------------------------------
  const gathered = await gatherEvidence({ run, rules, locator, occurredAt, deps });
  const bundle = toEvidenceBundle(gathered.results);

  // -------------------------------------------------------------------------
  // 3. Judge it
  // -------------------------------------------------------------------------
  let results: readonly AssertionResult[];
  try {
    results = evaluateAssertions(rules, bundle, {
      occurredAt,
      now: deps.now,
      connectedCrmAccountId: gathered.accounts.hubspot,
      connectedEmailAccountId: gathered.accounts.resend,
      // The run's own expected values, for assertions bound with `expected_from`. Drawn from
      // the same parsed source event as the locator — so a payload we could not read binds
      // nothing, and every bound assertion is UNKNOWN rather than judged against a guess.
      sourceEvent: {
        correlation_id: locator.correlation_value ?? null,
        email_recipient: locator.recipient ?? null,
      },
    });
  } catch {
    const resolved = await resolveWithoutEvaluation(
      run,
      row.observation_count,
      deps,
      RULES_UNUSABLE_REASON,
    );
    await runAttempts.finish(deps.db, {
      workspaceId: run.workspace_id,
      attemptId,
      endedAt: nowIso,
      outcome: 'rules_unusable',
      errorCode: 'WORKFLOW_RULES_INVALID',
    });
    return { ...resolved, note: 'rules_unusable', callsMade: gathered.calls };
  }

  const observationCount = row.observation_count + 1;
  const deadlineAt = parseIso(row.deadline_at);
  const lastGap = worstGap(bundle.gaps);

  // Can we ever usefully look again? Ask the scheduler before deciding, because "no" is
  // what turns an open window into a resolution instead of three more pointless attempts.
  const tentativePlan = planNextObservation({
    observationCount,
    deadlineAt,
    now: deps.now,
    attemptsUsed: 0,
    ...(lastGap === null ? {} : { lastGap }),
  });
  const canLookAgain = tentativePlan.nextCheckAt !== null;
  const observationsRemaining = canLookAgain ? observationsRemainingAfter(observationCount) : 0;

  let decision: { status: RunStatus; reason: string };
  try {
    decision = decideRunStatus(results, {
      deadlineAt,
      now: deps.now,
      hasWorkingEvidenceAccess: hasWorkingEvidenceAccess(bundle.gaps),
      observationsRemaining,
    });
  } catch {
    const resolved = await resolveWithoutEvaluation(
      run,
      row.observation_count,
      deps,
      RULES_UNUSABLE_REASON,
    );
    await runAttempts.finish(deps.db, {
      workspaceId: run.workspace_id,
      attemptId,
      endedAt: nowIso,
      outcome: 'rules_unusable',
      errorCode: 'WORKFLOW_RULES_INVALID',
    });
    return { ...resolved, note: 'rules_unusable', callsMade: gathered.calls };
  }

  const terminal = TERMINAL_STATUSES.has(decision.status);

  // -------------------------------------------------------------------------
  // 4. Persist
  // -------------------------------------------------------------------------
  const evidenceIds = await recordEvidence(bundle, run, deps);
  const assertionsWritten = await assertions.replaceForRevision(deps.db, {
    workspaceId: run.workspace_id,
    runId: run.id,
    revision: run.revision,
    rows: results.map((result) => ({
      id: deps.newId(ID_PREFIX.assertion),
      ruleId: result.rule_id,
      label: result.label,
      mandatory: result.mandatory,
      status: result.status,
      reasonCode: result.reason_code,
      expectedDisplay: result.expected_display,
      observedDisplay: result.observed_display,
      observedAt: result.observed_at,
      evidenceId:
        result.evidence_ref === null ? null : (evidenceIds.get(result.evidence_ref) ?? null),
    })),
  });

  /*
   * THE COMMIT POINT, and the two-phase finalisation that follows it.
   *
   * A terminal decision is written with `next_check_at` set a little way ahead rather than
   * null. The customer sees the final status immediately, and the run stays *due* until
   * its outbox row has been written and its allowance settled. If this tick dies in that
   * window, the next one reclaims the run, sees it is already terminal, and completes the
   * finalisation without re-observing anything.
   *
   * That is what makes "an outcome written but not dispatched must still be dispatched"
   * true rather than hopeful. The cost is one extra conditional UPDATE per terminal run.
   */
  const committedNextCheck = terminal
    ? addSecondsIso(deps.now, TICK_DEFAULTS.FINALISE_DELAY_SECONDS)
    : tentativePlan.nextCheckAt === null
      ? null
      : toIso(tentativePlan.nextCheckAt);

  const applied = await runs.applyOutcome(deps.db, {
    workspaceId: run.workspace_id,
    runId: run.id,
    expectedRevision: run.revision,
    status: decision.status,
    nextCheckAt: committedNextCheck,
    observationCount,
    completedAt: terminal ? nowIso : null,
  });

  if (!applied) {
    // A newer attempt already wrote. Discard rather than retry: retrying would overwrite a
    // decision made with more evidence than we have.
    logger.info('scheduler.run.stale', { run_id: run.id, revision: run.revision });
    await runAttempts.finish(deps.db, {
      workspaceId: run.workspace_id,
      attemptId,
      endedAt: nowIso,
      outcome: 'stale',
    });
    return outcome(
      run,
      decision.status,
      decision.reason,
      terminal,
      'stale',
      gathered.calls,
      null,
      assertionsWritten,
      false,
      coverageWarning,
    );
  }

  let allowanceSettled = false;
  if (terminal) {
    allowanceSettled = await finaliseTerminalRun(
      {
        db: deps.db,
        workspaceId: run.workspace_id,
        runId: run.id,
        expectedRevision: run.revision + 1,
        status: decision.status,
        observationCount,
        createdAt: row.created_at,
        now: deps.now,
        newId: deps.newId,
        billing: deps.billing,
        billingEnvironment: deps.billingEnvironment,
      },
      logger,
    );
  }

  await runAttempts.finish(deps.db, {
    workspaceId: run.workspace_id,
    attemptId,
    endedAt: nowIso,
    outcome: decision.status,
  });

  logger.info('scheduler.run.observed', {
    run_id: run.id,
    status: decision.status,
    calls: gathered.calls,
    observation: observationCount,
  });

  return outcome(
    run,
    decision.status,
    decision.reason,
    terminal,
    'observed',
    gathered.calls,
    terminal ? null : committedNextCheck,
    assertionsWritten,
    allowanceSettled,
    coverageWarning,
  );
}

/** A run the tick had no budget left to observe. Its lease expires and the next tick takes it. */
export function deferredOutcome(run: DueRun): ObservationOutcome {
  return outcome(
    run,
    'PENDING',
    DEFERRED_REASON,
    false,
    'deferred',
    0,
    run.next_check_at,
    0,
    false,
  );
}

// ---------------------------------------------------------------------------
// finalisation
// ---------------------------------------------------------------------------

interface FinaliseInput {
  readonly db: Db;
  readonly workspaceId: string;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly status: RunStatus;
  readonly observationCount: number;
  readonly createdAt: string;
  readonly now: Date;
  readonly newId: IdFactory;
  readonly billing: SubscriptionPeriodSource;
  readonly billingEnvironment: 'test' | 'live';
}

/**
 * Phase two of a terminal run: announce it, settle the allowance, then stop scheduling it.
 *
 * Every step is safe to repeat:
 *  - the outbox enqueue is keyed `run.decided:<run>:<status>` and is a no-op on conflict;
 *  - the allowance settlement is guarded by the compare-and-set that ends the run's
 *    schedule, so it fires at most once (see the note below);
 *  - clearing `next_check_at` is itself a compare-and-set on the revision.
 *
 * ON SETTLEMENT AND CRASHES. `settleReservation` moves one unit from `reserved` to
 * `consumed`. Both are subtracted from the allowance identically, so a settlement lost to
 * a crash never over-grants allowance and never over-charges a customer — the unit simply
 * reads as in-flight instead of used. The opposite choice (settle first, retry on failure)
 * could settle twice and steal a *different* run's reservation, which would under-serve the
 * customer. So this is deliberately at-most-once, and the residue is a reporting
 * inaccuracy rather than a billing one. The clean fix is a settled marker on the run; that
 * needs a migration, which is the lead's to write.
 */
async function finaliseTerminalRun(
  input: FinaliseInput,
  logger: SchedulerLogger,
): Promise<boolean> {
  const nowIso = toIso(input.now);

  await outbox.enqueue(input.db, {
    id: input.newId(ID_PREFIX.outbox),
    workspaceId: input.workspaceId,
    eventType: 'run.decided',
    entityId: input.runId,
    // Keyed on the outcome, not the revision: re-running finalisation announces nothing
    // new, while a genuinely different later decision still gets its own announcement.
    uniqueEventKey: `run.decided:${input.runId}:${input.status}`,
    payloadJson: JSON.stringify({ run_id: input.runId, status: input.status, decided_at: nowIso }),
    nextAttemptAt: nowIso,
    createdAt: nowIso,
  });

  // Stop scheduling this run. Doing this *before* the settlement is what makes the
  // settlement at-most-once: only the caller that won this compare-and-set may settle.
  const closed = await runs.applyOutcome(input.db, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    status: input.status,
    nextCheckAt: null,
    observationCount: input.observationCount,
    completedAt: nowIso,
  });

  if (!closed) {
    logger.info('scheduler.run.finalise_raced', { run_id: input.runId });
    return false;
  }

  /*
   * THE ALLOWANCE PERIOD KEY IS READ, NEVER DERIVED.
   *
   * This call site used to compute `YYYY-MM` from the run's creation date while billing
   * opened the row as `YYYY-MM-DD`. The two never matched, so nothing was ever settled and
   * a workspace at its limit reported itself unblocked (A13-010).
   *
   * The fix is not a different string format — it is that the consumer stops deriving the
   * key at all and asks the one module that owns it. `resolveAllowancePeriodKey` reads the
   * subscription's own period end and steps *backwards* from it, so a run decided a minute
   * after a renewal still settles against the period the reservation was taken from rather
   * than against the new one.
   */
  const period = await resolveAllowancePeriodKey(input.billing, {
    workspaceId: input.workspaceId,
    atIso: input.createdAt,
    environment: input.billingEnvironment,
  });

  if (period.key === null) {
    // No subscription means no allowance row to settle, so there is nothing to do and
    // nothing to repair. Inventing a key here would write to a row that should not exist —
    // which is how the original defect would have been "fixed" by guessing.
    if (period.reason === 'no_period_end') {
      // A subscription that carries no period end is a data problem worth seeing: the row
      // exists, so an allowance row probably does too, and we cannot address it.
      logger.warn('scheduler.allowance.no_period_end', {
        run_id: input.runId,
        workspace_id: input.workspaceId,
      });
    } else {
      logger.info('scheduler.allowance.no_subscription', { run_id: input.runId });
    }
    return false;
  }

  // Cheap guard, loud failure. If a key of the wrong shape ever reaches this line again,
  // it stops here instead of silently matching nothing for another six months.
  if (!isAllowancePeriodKey(period.key)) {
    logger.warn('scheduler.allowance.bad_period_key', {
      run_id: input.runId,
      workspace_id: input.workspaceId,
    });
    return false;
  }

  const settled = await entitlements.settleReservation(
    input.db,
    input.workspaceId,
    period.key,
    nowIso,
  );
  if (!settled) {
    // The row was there to address but held no reservation: already settled, or released.
    logger.info('scheduler.allowance.nothing_to_settle', { run_id: input.runId });
  }
  return settled;
}

/**
 * Resolve a run we could never evaluate. UNVERIFIED, terminal, no provider calls, and it
 * still goes through finalisation so its allowance is released rather than held forever.
 */
async function resolveWithoutEvaluation(
  run: DueRun,
  observationCount: number,
  deps: ObserveDeps,
  reason: string,
): Promise<ObservationOutcome> {
  const nowIso = toIso(deps.now);
  const applied = await runs.applyOutcome(deps.db, {
    workspaceId: run.workspace_id,
    runId: run.id,
    expectedRevision: run.revision,
    status: 'UNVERIFIED',
    nextCheckAt: addSecondsIso(deps.now, TICK_DEFAULTS.FINALISE_DELAY_SECONDS),
    observationCount,
    completedAt: nowIso,
  });
  if (!applied) {
    return outcome(run, 'UNVERIFIED', reason, true, 'stale', 0, null, 0, false);
  }

  const row = await runs.get(deps.db, run.workspace_id, run.id);
  const settled = await finaliseTerminalRun(
    {
      db: deps.db,
      workspaceId: run.workspace_id,
      runId: run.id,
      expectedRevision: run.revision + 1,
      status: 'UNVERIFIED',
      observationCount,
      createdAt: row?.created_at ?? nowIso,
      now: deps.now,
      newId: deps.newId,
      billing: deps.billing,
      billingEnvironment: deps.billingEnvironment,
    },
    deps.logger ?? SILENT_LOGGER,
  );
  return outcome(run, 'UNVERIFIED', reason, true, 'observed', 0, null, 0, settled);
}

// ---------------------------------------------------------------------------
// evidence gathering
// ---------------------------------------------------------------------------

interface GatherInput {
  readonly run: DueRun;
  readonly rules: WorkflowRules;
  readonly locator: EvidenceLocator;
  readonly occurredAt: Date;
  readonly deps: ObserveDeps;
}

interface GatherOutput {
  readonly results: readonly ConnectorFetchResult[];
  readonly calls: number;
  readonly accounts: { hubspot: string | null; resend: string | null };
}

/**
 * Call only the providers the rules actually address, and only when we hold a credential.
 *
 * A source with no usable connection produces a terminal gap and costs nothing. A source
 * whose connector throws produces a gap too — an exception escaping into the tick would
 * take the other nine runs down with it, and there is no failure of ours that should ever
 * become a customer's FAILED.
 */
async function gatherEvidence(input: GatherInput): Promise<GatherOutput> {
  const { run, rules, deps } = input;
  const sources = new Set(rules.assertions.map((a) => a.source));
  const results: ConnectorFetchResult[] = [];
  const accounts: { hubspot: string | null; resend: string | null } = {
    hubspot: null,
    resend: null,
  };

  for (const source of sources) {
    const provider = PROVIDER_FOR_SOURCE[source];
    const resolution = await deps.resolver.resolve(run.workspace_id, provider);

    if (!resolution.ok) {
      // The no-credentials path. Zero external calls, an honest terminal gap, and the run
      // resolves UNVERIFIED rather than sitting PENDING for the whole window.
      results.push({
        provider,
        provider_account_id: null,
        evidence: [],
        gaps: [makeGap(source, GAP_CODE_FOR_REASON[resolution.reason], resolution.detail)],
        calls_made: 0,
      });
      continue;
    }

    if (!deps.budget.canSpendCalls(1)) {
      // No tick budget left. Not a failure of the customer's automation and not a gap we
      // should judge on, so it reads as a retryable outage and the run stays open.
      results.push({
        provider,
        provider_account_id: resolution.connection.connection.account_id,
        evidence: [],
        gaps: [
          makeGap(source, 'PROVIDER_UNAVAILABLE', 'this cycle ran out of budget before checking'),
        ],
        calls_made: 0,
      });
      continue;
    }

    const fetched = await callConnector(resolution.connection, source, input);
    results.push(fetched);
    deps.budget.spendCalls(fetched.calls_made);
    accounts[provider] = fetched.provider_account_id ?? resolution.connection.connection.account_id;
  }

  return { results, calls: totalCalls(results), accounts };
}

async function callConnector(
  resolved: ResolvedConnection,
  source: 'crm_record' | 'email_event',
  input: GatherInput,
): Promise<ConnectorFetchResult> {
  const { deps } = input;
  const connector = deps.connectors.get(resolved.provider);
  const requiredProperties = [
    ...new Set(
      input.rules.assertions
        .filter((a) => a.field === 'record.property' && a.property_name !== undefined)
        .map((a) => a.property_name as string),
    ),
  ];

  try {
    const result = await connector.fetchEvidence({
      credentials: resolved.credentials,
      connection: {
        ...resolved.connection,
        correlation_property: input.rules.crm_correlation_property,
      },
      locator: input.locator,
      occurredAt: input.occurredAt,
      now: deps.now,
      requiredProperties,
      attemptsUsed: 0,
    });
    // A connector that reports more calls than the per-run ceiling is a bug in the
    // connector, not a licence to spend them. Record what it claimed so the ceiling test
    // can see it, but never below what it actually reported.
    return result;
  } catch (error) {
    // Never let a provider adapter's exception decide a customer's status.
    const classified = connector.classifyError({ status: null, cause: error, now: deps.now });
    return {
      provider: resolved.provider,
      provider_account_id: resolved.connection.account_id,
      evidence: [],
      gaps: [makeGap(source, classified.code, classified.detail)],
      calls_made: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Evidence access is working when every gap we hold is an *answer*. `NOT_FOUND` is the
 * provider telling us there is nothing there — that is a working connection reporting an
 * absence. Everything else means we could not look, and a run we could not look at is
 * never failed.
 */
export function hasWorkingEvidenceAccess(gaps: readonly EvidenceGap[]): boolean {
  return gaps.every((gap) => gap.code === 'NOT_FOUND');
}

/**
 * The gap that should drive the retry decision: a terminal one if there is one, because a
 * problem nobody can fix by waiting should stop the schedule rather than be averaged away
 * with a transient one.
 */
function worstGap(gaps: readonly EvidenceGap[]): EvidenceGap | null {
  if (gaps.length === 0) return null;
  const terminal = gaps.find((g) => !g.retryable && g.code !== 'NOT_FOUND');
  if (terminal !== undefined) return terminal;
  const retryable = gaps.find((g) => g.retryable);
  return retryable ?? gaps[0] ?? null;
}

async function loadRules(db: Db, run: DueRun): Promise<WorkflowRules | null> {
  const version = await workflowVersions.get(db, run.workspace_id, run.workflow_version_id);
  if (version === null) return null;
  try {
    return workflowRulesSchema.parse(JSON.parse(version.rules_json));
  } catch {
    return null;
  }
}

/**
 * Drain any parked delivery events this run was waiting for.
 *
 * Constructs the webhook data port because the claim is its query; the scheduler owns when
 * it happens, not how.
 */
async function claimParkedEmailEvidenceForRun(
  db: Db,
  params: { workspaceId: string; runId: string; messageId: string; now: string },
): Promise<number> {
  return new D1ResendWebhookDataPort(db).claimInboxForRun(params);
}

/** What the customer's automation told us. Locators only; nothing here is ever trusted. */
function readLocator(payloadJson: string | null): EvidenceLocator {
  if (payloadJson === null || payloadJson.length === 0) return {};
  try {
    const parsed = sourceEventSchema.parse(JSON.parse(payloadJson));
    return {
      correlation_value: parsed.correlation_id,
      recipient: parsed.expected.email_recipient,
      ...(parsed.expected.crm_record_id === undefined
        ? {}
        : { record_id: parsed.expected.crm_record_id }),
      ...(parsed.expected.email_message_id === undefined
        ? {}
        : { message_id: parsed.expected.email_message_id }),
    };
  } catch {
    // A payload we cannot read is not a reason to guess. We look by correlation alone.
    return {};
  }
}

/** Store each piece of evidence, masked, and map its ref back to the stored row id. */
async function recordEvidence(
  bundle: EvidenceBundle,
  run: DueRun,
  deps: ObserveDeps,
): Promise<Map<string, string>> {
  const items = [...(bundle.crm === null ? [] : [bundle.crm]), ...bundle.email_events];
  if (items.length === 0) return new Map();

  const expiresAt = addSecondsIso(deps.now, LIMITS.EVIDENCE_RETENTION_DAYS * 24 * 3_600);
  const refToId = new Map<string, string>();
  const rows = [];

  for (const item of items) {
    const id = deps.newId(ID_PREFIX.evidence);
    const ref =
      item.kind === 'crm_record'
        ? `crm_record:${item.provider}:${item.record_id}`
        : `email_event:${item.provider}:${item.message_id}:${item.status}`;
    refToId.set(ref, id);
    rows.push({
      id,
      provider: item.provider,
      origin: item.origin,
      providerRecordId: item.kind === 'crm_record' ? item.record_id : item.message_id,
      observedAt: item.observed_at,
      contentDigest: await deps.digest(stableStringify(item)),
      redactedSummary: summariseEvidence(item),
      expiresAt,
    });
  }

  await evidenceRepo.recordMany(deps.db, {
    workspaceId: run.workspace_id,
    runId: run.id,
    rows,
  });
  return refToId;
}

/**
 * A one-line, masked description of a piece of evidence.
 *
 * Never the provider payload. The stored summary has to be enough for a customer to
 * recognise the record and not enough for a leak of this table to be interesting.
 */
export function summariseEvidence(
  item: EvidenceBundle['email_events'][number] | NonNullable<EvidenceBundle['crm']>,
): string {
  if (item.kind === 'crm_record') {
    const email = item.email === null ? 'none' : maskEmail(item.email);
    const correlation = item.correlation_value === null ? 'absent' : 'present';
    return `crm record ${item.record_id}; email ${email}; correlation ${correlation}; created ${item.created_at ?? 'unknown'}`;
  }
  const recipient = item.recipient === null ? 'none' : maskEmail(item.recipient);
  return `email ${item.message_id}; recipient ${recipient}; status ${item.status}; occurred ${item.occurred_at}`;
}

function outcome(
  run: DueRun,
  status: RunStatus,
  reason: string,
  terminal: boolean,
  note: ObservationNote,
  callsMade: number,
  nextCheckAt: string | null,
  assertionsWritten: number,
  allowanceSettled: boolean,
  coverageWarning: CoverageWarning | null = null,
): ObservationOutcome {
  return {
    runId: run.id,
    workspaceId: run.workspace_id,
    status,
    reason,
    terminal,
    applied: note === 'observed' || note === 'finalised',
    note,
    callsMade,
    nextCheckAt,
    assertionsWritten,
    allowanceSettled,
    coverageWarning,
  };
}

/** Re-exported so the budget test can assert the ceiling against the real constant. */
export { MAX_EXTERNAL_CALLS_PER_RUN };
