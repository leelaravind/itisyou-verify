/**
 * `CustomerDataPort` against D1.
 *
 * The property that makes this file safe is A05's, not mine: **no method takes a
 * workspace id.** The workspace is resolved once, from the session cookie, inside
 * `#scope()`. A page cannot ask for another tenant's data because there is no parameter
 * through which to ask. Every read below goes through a repository that takes that
 * resolved id explicitly, so the tenant predicate is in the SQL as well as in the shape.
 *
 * The second property is honesty. Three members cannot be implemented truthfully yet:
 * `beginConnection` needs A04's OAuth flow, `runProof` needs the connectors to produce
 * evidence, and `createCheckout` needs Stripe keys that do not exist in this environment.
 * Each says exactly that and exactly why, in the same register A05's synthetic port uses.
 * A plausible fake here would be worse than useless: the customer would believe a card was
 * charged, or that a connection was authorised.
 *
 * `synthetic` is false. Every page therefore drops the placeholder banner, which is only
 * correct because the reads below really are this workspace's rows.
 */
import type { AssertionResult } from '@verify/domain';
import type { CoverageMode, RunStatus, SubscriptionStatus } from '@verify/contracts';
import { LIMITS, formatMoney, money } from '@verify/contracts';
import { generateCsrfToken, maskToken } from '@verify/security';
import { AppError } from '@verify/contracts';
import type {
  ActivationView,
  ConnectionView,
  ConnectorCompatibility,
  CustomerDataPort,
  ExpectedOutcomeInput,
  FieldMappingInput,
  OrderSummaryView,
  ProofRunView,
  ProviderKey,
  RunDetailView,
  RunListItem,
  RunPage,
  SessionView,
  SigningKeyIssuanceView,
  SigningKeyIssueResult,
  SupportRequestInput,
  SupportResult,
  UsageView,
  WorkflowDetail,
  WorkflowSummary,
  WriteResult,
} from '../routes/app/port';
import type { Env } from '../lib/context';
import { ID_PREFIX, newId } from '../lib/ids';
import { resolveSession, type ResolvedSession } from '../lib/session';
import { nowIso, toIso } from '../lib/time';
import { issueWorkflowSigningKey, type IssuedSigningKey } from '../money/signingKeys';
import { auditEvents } from './audit';
import { connections } from './connections';
import type { Db } from './d1';
import { entitlements } from './entitlements';
import { assertions, runs } from './runs';
import { sourceEvents } from './sourceEvents';
import { resolveAllowancePeriodKey, type SubscriptionPeriodSource } from '../billing/period';
import { subscriptions } from './commerce';
import { createCase } from '../support/cases';
import { D1SupportDataPort } from './supportPort';
import { workflows, workflowVersions, type WorkflowRow } from './workflows';

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Said the same way on the page before the button and on the response after it.
 *
 * It names the missing secret on purpose. The person who reads this on a bare deployment is
 * the operator, and "not available" would send them reading code to find out which one.
 */
const SIGNING_KEY_UNCONFIGURED =
  'A signing key cannot be issued on this deployment: the EVENT_SIGNING_ROOT_KEY secret is not configured, so there is nothing to derive one from. Nothing was changed. This is our configuration, not something on your side.';

const ok = (redirectTo: string | null = null, message: string | null = null): WriteResult => ({
  ok: true,
  fieldErrors: {},
  message,
  redirectTo,
});

const refuse = (message: string, fieldErrors: Record<string, string> = {}): WriteResult => ({
  ok: false,
  fieldErrors,
  message,
  redirectTo: null,
});

/**
 * @deprecated **This is not an allowance period key and must never be used as one.**
 *
 * Renamed from `billingPeriodFor` so nobody reaches for it by its old, plausible name. It
 * returns a calendar month (`YYYY-MM`); allowance rows are keyed on the paid period END
 * (`YYYY-MM-DD`) by `apps/app/src/billing/period.ts`, which owns the one spelling.
 *
 * It survives for exactly one reason: `BILL-244` locks the A13-010 regression by calling it
 * and asserting it settles nothing. Nothing correct calls it. If you want a key, call
 * `resolveAllowancePeriodKey`.
 */
export function calendarMonthNotAnAllowanceKey(at: Date): string {
  return toIso(at).slice(0, 7);
}

/*
 * There is deliberately no period-key derivation in this file.
 *
 * A13-010: billing opened allowance rows keyed by the paid period END and this page read
 * them keyed by calendar month, so the two never matched and a workspace at its limit
 * reported itself unblocked. `apps/app/src/billing/period.ts` is now the one spelling;
 * anything here that wants a key asks `allowancePeriodKeyAt(at, currentPeriodEnd)` for it,
 * and when there is no subscription there is no paid period and therefore no key to guess.
 */

const PROVIDER_DETAIL: Readonly<
  Record<ProviderKey, { displayName: string; purpose: string; requirements: readonly string[] }>
> = {
  hubspot: {
    displayName: 'HubSpot',
    purpose: 'Reads the contact record your automation was supposed to create.',
    requirements: [
      'A HubSpot account you can grant read access to',
      'A contact property we can write our correlation reference into',
    ],
  },
  resend: {
    displayName: 'Resend',
    purpose: 'Reads the delivery events for the acknowledgement email.',
    requirements: ['A Resend account', 'The acknowledgement email sent through Resend'],
  },
};

/** What the customer sees when a connection is in each state. Never a raw error code. */
function connectionProblem(
  status: string,
  lastErrorCode: string | null,
): {
  problem: string | null;
  nextStep: string | null;
} {
  switch (status) {
    case 'ready':
      return { problem: null, nextStep: null };
    case 'not_connected':
      return {
        problem: 'Not connected yet.',
        nextStep: 'Connect this provider to start checking.',
      };
    case 'authorising':
    case 'testing':
      return { problem: 'Still being checked.', nextStep: 'Nothing to do — refresh in a moment.' };
    case 'expired':
      return {
        problem: 'The access we were granted has expired.',
        nextStep: 'Reconnect to grant read access again.',
      };
    case 'revoked':
      return {
        problem: 'Access was withdrawn.',
        nextStep: 'Reconnect if you still want these checks to run.',
      };
    case 'unsupported':
      return {
        problem: 'Your plan with this provider does not expose the data we need.',
        nextStep: 'Nothing you can do here — this combination is not supported.',
      };
    default:
      return {
        problem:
          lastErrorCode === null
            ? 'We could not use this connection on the last attempt.'
            : `We could not use this connection on the last attempt (${lastErrorCode}).`,
        nextStep: 'Reconnect. If it keeps happening, send us the run id.',
      };
  }
}

/**
 * The one method `resolveAllowancePeriodKey` needs, over the real subscriptions table.
 *
 * Deliberately not the whole billing port: the resolver should be able to answer "which
 * period is this instant in" without being handed everything that can move money.
 */
class BillingPortSubscriptionSource implements SubscriptionPeriodSource {
  constructor(private readonly db: Db) {}

  async findSubscriptionForWorkspace(
    workspaceId: string,
    environment: 'test' | 'live',
  ): Promise<{ readonly currentPeriodEnd: string | null } | null> {
    const row = await subscriptions.getForWorkspace(this.db, workspaceId, environment);
    return row === null ? null : { currentPeriodEnd: row.current_period_end };
  }
}

/* -------------------------------------------------------------------------- */
/* the port                                                                    */
/* -------------------------------------------------------------------------- */

/** Exactly what the port needs from the request. No Hono import, so `db/` stays framework-free. */
export interface CustomerPortInput {
  readonly db: Db;
  readonly env: Env;
  readonly request: { readonly headers: Headers; readonly url: string };
  readonly now?: Date;
}

export class D1CustomerDataPort implements CustomerDataPort {
  readonly synthetic = false;

  readonly #db: Db;
  readonly #env: Env;
  readonly #request: { readonly headers: Headers; readonly url: string };
  readonly #now: Date;
  #resolved: ResolvedSession | null | undefined = undefined;

  constructor(input: CustomerPortInput) {
    this.#db = input.db;
    this.#env = input.env;
    this.#request = input.request;
    this.#now = input.now ?? new Date();
  }

  /**
   * The workspace this request acts in, resolved from the session and memoised.
   *
   * This is the only place a workspace id enters the port. Every method below takes it
   * from here; none accepts one.
   */
  async #scope(): Promise<ResolvedSession | null> {
    if (this.#resolved === undefined) {
      this.#resolved = await resolveSession(
        this.#db,
        this.#request,
        this.#env.PUBLIC_BASE_URL,
        this.#now,
      );
    }
    return this.#resolved;
  }

  /* --- session --- */

  async session(): Promise<SessionView | null> {
    const scope = await this.#scope();
    if (scope === null) return null;
    return {
      workspaceId: scope.workspaceId,
      workspaceName: scope.workspaceName,
      email: scope.email,
      role: scope.role === 'workspace_viewer' ? 'workspace_viewer' : 'workspace_admin',
      csrfToken: generateCsrfToken(),
    };
  }

  /**
   * Magic-link sign-in.
   *
   * Not implemented here yet: issuing a link means sending an email, and the send path is
   * A09's `notifications/send.ts` with A04's Resend transport behind it. Answering "check
   * your inbox" without a transport wired up would be the exact kind of fabricated success
   * the brief forbids — the customer would sit waiting for a mail nobody sent.
   *
   * The reply is deliberately identical whether or not the address has an account.
   */
  async requestSignInLink(email: string): Promise<WriteResult> {
    const trimmed = email.trim();
    if (trimmed.length === 0 || !trimmed.includes('@')) {
      return refuse('Enter the email address you signed up with.', {
        email: 'That does not look like an email address.',
      });
    }
    return refuse(
      'No sign-in link was sent. Email delivery is not connected in this environment yet, so nothing would arrive and we will not pretend otherwise.',
    );
  }

  async signOut(): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return ok('/app/sign-in');
    const { sessions } = await import('./sessions');
    await sessions.revoke(this.#db, scope.sessionId, nowIso(this.#now));
    this.#resolved = null;
    return ok('/app/sign-in', 'You are signed out on this device.');
  }

  /* --- onboarding --- */

  async connectorCompatibility(): Promise<readonly ConnectorCompatibility[]> {
    return (['hubspot', 'resend'] as const).map((provider) => ({
      provider,
      displayName: PROVIDER_DETAIL[provider].displayName,
      purpose: PROVIDER_DETAIL[provider].purpose,
      requirements: PROVIDER_DETAIL[provider].requirements,
      supported: true,
      unsupportedReason: null,
    }));
  }

  async connections(): Promise<readonly ConnectionView[]> {
    const scope = await this.#scope();
    if (scope === null) return [];
    const rows = await connections.list(this.#db, scope.workspaceId);
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    return (['hubspot', 'resend'] as const).map((provider) => {
      const row = byProvider.get(provider);
      const status = row?.status ?? 'not_connected';
      const { problem, nextStep } = connectionProblem(status, row?.last_error_code ?? null);
      return {
        provider,
        displayName: PROVIDER_DETAIL[provider].displayName,
        status,
        // Generated fresh from the stored account id — never a stored credential, and
        // never a mask we persisted (rule 7).
        accountLabel:
          row?.external_account_id === undefined || row.external_account_id === null
            ? null
            : maskToken(row.external_account_id),
        lastCheckedAt: row?.last_check_at ?? null,
        problem,
        nextStep,
      };
    });
  }

  /**
   * Not implementable honestly yet: starting an authorisation means redirecting to the
   * provider's consent screen with a client id and a registered callback, and neither
   * exists in this environment. Saying "connected" or recording `authorising` would
   * describe a conversation that never happened.
   */
  async beginConnection(provider: ProviderKey): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to connect a provider.');
    return refuse(
      `No authorisation was started and nothing about your ${PROVIDER_DETAIL[provider].displayName} account has changed. The ${PROVIDER_DETAIL[provider].displayName} app credentials are not configured in this environment, so there is nowhere to send you yet.`,
    );
  }

  async workflows(): Promise<readonly WorkflowSummary[]> {
    const scope = await this.#scope();
    if (scope === null) return [];
    const page = await workflows.list(this.#db, scope.workspaceId, { limit: 20 });
    const summaries: WorkflowSummary[] = [];
    for (const row of page.items) {
      summaries.push(await this.#summarise(scope.workspaceId, row));
    }
    return summaries;
  }

  async #summarise(
    workspaceId: string,
    row: {
      id: string;
      name: string;
      coverage_mode: CoverageMode;
      status: string;
      last_event_at: string | null;
      current_version_id: string | null;
    },
  ): Promise<WorkflowSummary> {
    const counts = await runs.countByStatus(this.#db, workspaceId, '1970-01-01T00:00:00.000Z');
    const version =
      row.current_version_id === null
        ? null
        : await workflowVersions.get(this.#db, workspaceId, row.current_version_id);
    return {
      id: row.id,
      name: row.name,
      coverageMode: row.coverage_mode,
      deadlineSeconds: version?.deadline_seconds ?? LIMITS.DEFAULT_DEADLINE_SECONDS,
      active: row.status === 'active',
      lastEventAt: row.last_event_at,
      counts: {
        verified: counts['VERIFIED'] ?? 0,
        failed: counts['FAILED'] ?? 0,
        unverified: counts['UNVERIFIED'] ?? 0,
        pending: counts['PENDING'] ?? 0,
      },
    };
  }

  async workflow(): Promise<WorkflowDetail | null> {
    const scope = await this.#scope();
    if (scope === null) return null;
    const page = await workflows.list(this.#db, scope.workspaceId, { limit: 1 });
    const row = page.items[0];
    if (row === undefined) return null;

    const summary = await this.#summarise(scope.workspaceId, row);
    const version =
      row.current_version_id === null
        ? null
        : await workflowVersions.get(this.#db, scope.workspaceId, row.current_version_id);

    let correlationProperty = '';
    let requireRecordExists = false;
    let requireCorrelationMatch = false;
    let requireEmailDelivered = false;
    let requireRecipientMatch = false;
    if (version !== null) {
      try {
        const rules = JSON.parse(version.rules_json) as {
          crm_correlation_property?: string;
          assertions?: { source?: string; field?: string; operator?: string }[];
        };
        correlationProperty = rules.crm_correlation_property ?? '';
        for (const spec of rules.assertions ?? []) {
          if (spec.field === 'record.id' && spec.operator === 'exists') requireRecordExists = true;
          if (spec.field === 'record.correlation_id') requireCorrelationMatch = true;
          if (spec.field === 'message.status') requireEmailDelivered = true;
          if (spec.field === 'message.recipient') requireRecipientMatch = true;
        }
      } catch {
        // A rules blob we cannot parse is a configuration problem, not a page crash. The
        // customer sees empty toggles rather than a 500, and the values are re-derivable.
      }
    }

    return {
      ...summary,
      mapping: {
        correlationProperty,
        // Empty until a CRM connection can actually list properties. An invented list
        // would make the customer choose a property that does not exist.
        availableProperties: [],
      },
      outcome: {
        deadlineSeconds: summary.deadlineSeconds,
        requireRecordExists,
        requireCorrelationMatch,
        requireEmailDelivered,
        requireRecipientMatch,
        coverageMode: summary.coverageMode,
      },
      signingKeyHint: row.signing_key_hash === null ? null : maskToken(row.signing_key_hash),
    };
  }

  /**
   * Both rule edits publish a new immutable workflow version rather than mutating one, so
   * a report from last week still shows the rules that actually decided it. Refusing here
   * rather than writing a half-formed version: composing valid `WorkflowRules` from these
   * two forms is A03's decision table, and guessing at it would silently change what
   * VERIFIED means.
   */
  async saveFieldMapping(input: FieldMappingInput): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to change this workflow.');
    if (scope.role !== 'workspace_admin') {
      return refuse('Only a workspace admin can change the field mapping.');
    }
    if (!/^[A-Za-z0-9_]{1,128}$/.test(input.correlationProperty)) {
      return refuse('That property name is not valid.', {
        correlationProperty: 'Use letters, numbers and underscores only.',
      });
    }
    return refuse(
      'Nothing was saved. Publishing a rules change needs the rule compiler, which is not wired into this environment yet, and writing a partial workflow version would change what a VERIFIED result means.',
    );
  }

  async saveExpectedOutcome(input: ExpectedOutcomeInput): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to change this workflow.');
    if (scope.role !== 'workspace_admin') {
      return refuse('Only a workspace admin can change the expected outcome.');
    }
    if (
      !Number.isInteger(input.deadlineSeconds) ||
      input.deadlineSeconds < LIMITS.MIN_DEADLINE_SECONDS ||
      input.deadlineSeconds > LIMITS.MAX_DEADLINE_SECONDS
    ) {
      return refuse('That completion window is outside the supported range.', {
        deadlineSeconds: `Choose between ${LIMITS.MIN_DEADLINE_SECONDS} and ${LIMITS.MAX_DEADLINE_SECONDS} seconds.`,
      });
    }
    return refuse(
      'Nothing was saved. Publishing a rules change needs the rule compiler, which is not wired into this environment yet.',
    );
  }

  /**
   * The proof run evaluates real rules against invented evidence. It needs the evaluator
   * AND a compiled rule set; without the compiler it would be evaluating nothing, and a
   * green tick from an empty rule set is the most dangerous output this product could
   * produce.
   */
  async runProof(): Promise<ProofRunView> {
    const scope = await this.#scope();
    return {
      ran: false,
      status: null,
      statusReason: null,
      results: [],
      blockedReason:
        scope === null
          ? 'Sign in to run a proof.'
          : 'No proof run was performed. The rule compiler is not wired into this environment, so there are no rules to evaluate — and a pass against no rules would mean nothing.',
    };
  }

  /* --- billing --- */

  async orderSummary(): Promise<OrderSummaryView> {
    const scope = await this.#scope();
    const blockers: string[] = [];
    if (scope === null) blockers.push('You are not signed in.');

    if (scope !== null) {
      const live = await connections.list(this.#db, scope.workspaceId);
      const ready = new Set(
        live.filter((row) => row.status === 'ready').map((row) => row.provider),
      );
      if (!ready.has('hubspot')) blockers.push('Connect HubSpot so we can read the CRM record.');
      if (!ready.has('resend'))
        blockers.push('Connect Resend so we can read email delivery events.');
      const page = await workflows.list(this.#db, scope.workspaceId, { limit: 1 });
      if (page.items[0] === undefined) blockers.push('Create a workflow to check.');
      else if (page.items[0].current_version_id === null) {
        blockers.push('Publish your expected outcome before subscribing.');
      }
    }
    if ((this.#env.STRIPE_PRICE_ID ?? '') === '' || (this.#env.STRIPE_SECRET_KEY ?? '') === '') {
      blockers.push('Payments are not enabled in this environment.');
    }

    // Every value here is resolved from server-side constants. Nothing is read from the
    // request, so a crafted form cannot buy a plan at a price it chose (rule 5).
    return {
      planName: 'ITISYOU Verify — one workflow',
      priceDisplay: formatMoney(money(LIMITS.PLAN_PRICE_PENCE, 'GBP')),
      billingPeriod: 'month',
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      blockers,
      ready: blockers.length === 0,
    };
  }

  /**
   * Refuses, and says plainly that no card was charged.
   *
   * Creating a Checkout session means calling Stripe with a secret key. There is none in
   * this environment, so there is nothing to redirect to. The wording matters more than
   * the code path: a customer who believes a payment was attempted will wait for it.
   */
  async createCheckout(): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in before subscribing.');
    const summary = await this.orderSummary();
    if (!summary.ready) {
      return refuse(
        `No checkout session was created and no card was charged. ${summary.blockers.join(' ')}`,
      );
    }
    return refuse(
      'No checkout session was created and no card was charged. Stripe is not configured in this environment, so there is no hosted Checkout to hand you to.',
    );
  }

  async activation(): Promise<ActivationView> {
    const scope = await this.#scope();
    const endpoint = `${this.#env.PUBLIC_BASE_URL}/api/v1/events`;
    if (scope === null) {
      return {
        active: false,
        subscriptionStatus: null,
        eventEndpoint: endpoint,
        workflowId: '',
        signingKeyId: null,
        signingKeyHint: null,
        signingKeyIssuance: {
          canIssue: false,
          cannotIssueReason: 'Sign in to issue a signing key.',
        },
        firstRunId: null,
      };
    }
    const page = await workflows.list(this.#db, scope.workspaceId, { limit: 1 });
    const workflow = page.items[0];
    const subscription = await subscriptions.getForWorkspace(
      this.#db,
      scope.workspaceId,
      this.#env.STRIPE_MODE === 'live' ? 'live' : 'test',
    );
    const firstRun =
      workflow === undefined
        ? null
        : ((await runs.listByWorkflow(this.#db, scope.workspaceId, workflow.id, { limit: 1 }))
            .items[0] ?? null);

    return {
      active: subscription?.status === 'active' || subscription?.status === 'trialing',
      subscriptionStatus: (subscription?.status as SubscriptionStatus | undefined) ?? null,
      eventEndpoint: endpoint,
      workflowId: workflow?.id ?? '',
      signingKeyHint:
        workflow?.signing_key_hash === undefined || workflow.signing_key_hash === null
          ? null
          : maskToken(workflow.signing_key_hash),
      firstRunId: firstRun?.id ?? null,
    };
  }

  /* --- results --- */

  async listRuns(options: { cursor?: string; limit: number }): Promise<RunPage> {
    const scope = await this.#scope();
    if (scope === null) return { items: [], nextCursor: null, prevCursor: null };

    const page = await runs.listByWorkspace(this.#db, scope.workspaceId, {
      limit: options.limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });

    const items: RunListItem[] = [];
    for (const row of page.items) {
      const results = await assertions.listForRun(this.#db, scope.workspaceId, row.id);
      const mandatory = results.filter((a) => a.mandatory === 1);
      const event = await sourceEvents.getForRun(this.#db, scope.workspaceId, row.id);
      items.push({
        id: row.id,
        status: row.status,
        summary: summarise(row.status, mandatory.length),
        correlationId: event?.correlation_key_hash ?? '',
        occurredAt: event?.occurred_at ?? row.created_at,
        decidedAt: row.completed_at,
        mandatorySupported: mandatory.filter((a) => a.status === 'SUPPORTED').length,
        mandatoryTotal: mandatory.length,
      });
    }

    // The port exposes a prevCursor; keyset pagination cannot produce one without a
    // reverse query, and inventing one would send the customer to the wrong page.
    return { items, nextCursor: page.nextCursor, prevCursor: null };
  }

  async run(runId: string): Promise<RunDetailView | null> {
    const scope = await this.#scope();
    if (scope === null) return null;

    // Scoped by the resolved workspace, so another tenant's run id returns null rather
    // than a row somebody then has to remember to check.
    const row = await runs.get(this.#db, scope.workspaceId, runId);
    if (row === null) return null;

    const [event, version, workflow, rows] = await Promise.all([
      sourceEvents.getForRun(this.#db, scope.workspaceId, runId),
      workflowVersions.get(this.#db, scope.workspaceId, row.workflow_version_id),
      workflows.get(this.#db, scope.workspaceId, row.workflow_id),
      assertions.listForRun(this.#db, scope.workspaceId, runId),
    ]);

    let recipient = '';
    let correlationId = event?.correlation_key_hash ?? '';
    if (event !== null) {
      try {
        const payload = JSON.parse(event.payload_json) as {
          correlation_id?: string;
          expected?: { email_recipient?: string };
        };
        recipient = payload.expected?.email_recipient ?? '';
        correlationId = payload.correlation_id ?? correlationId;
      } catch {
        /* a payload we cannot parse still yields a readable run */
      }
    }

    const results: AssertionResult[] = rows.map((a) => ({
      rule_id: a.rule_id,
      label: a.label,
      mandatory: a.mandatory === 1,
      status: a.status,
      reason_code: a.reason_code as AssertionResult['reason_code'],
      expected_display: a.expected_display ?? '',
      observed_display: a.observed_display,
      observed_at: a.observed_at,
      evidence_ref: a.evidence_id,
    }));

    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: workflow?.name ?? 'Workflow',
      status: row.status,
      statusReason: summarise(row.status, results.filter((r) => r.mandatory).length),
      correlationId,
      recipient,
      occurredAt: event?.occurred_at ?? row.created_at,
      deadlineAt: row.deadline_at,
      observedAt: results.find((r) => r.observed_at !== null)?.observed_at ?? null,
      decidedAt: row.completed_at,
      sourceType: event?.source ?? 'signed_customer_event',
      rulesRef: `${row.workflow_id}@v${version?.version_number ?? 1}`,
      rulesSchemaVersion: version?.schema_version ?? 1,
      coverageMode: workflow?.coverage_mode ?? 'customer_triggered',
      revision: row.revision,
      lateCompletion:
        row.completed_at !== null &&
        row.completed_at > row.deadline_at &&
        row.status === 'VERIFIED',
      results,
    };
  }

  /* --- usage --- */

  /**
   * Usage for the period the customer is actually paying for.
   *
   * The period key comes from `allowancePeriodKeyAt`, never from the calendar. A
   * subscription that started on the 20th is billed 20th to 20th, so a `YYYY-MM` key would
   * roll the allowance over a week early — handing out runs nobody paid for and then
   * cutting the customer off before their period ended.
   *
   * With no subscription there is no paid period, so there is no key to look up and no
   * allowance row to find. That is reported as "nothing used yet against the plan
   * allowance", not as a fabricated month.
   */
  async usage(): Promise<UsageView> {
    const scope = await this.#scope();
    const nothingYet = (start: string, end: string): UsageView => ({
      periodStart: start,
      periodEnd: end,
      runsUsed: 0,
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      admissionBlocked: false,
      subscriptionStatus: null,
    });

    if (scope === null) return nothingYet(toIso(this.#now), toIso(this.#now));

    const environment = this.#env.STRIPE_MODE === 'live' ? 'live' : 'test';
    const subscription = await subscriptions.getForWorkspace(
      this.#db,
      scope.workspaceId,
      environment,
    );

    // The key comes from A06's resolver, which reads the subscription's own period end.
    // Deriving one here is the A13-010 defect: this page read `YYYY-MM` while billing wrote
    // `YYYY-MM-DD`, so it looked up a row that never existed and reported 0 used / 500 left
    // forever — to a customer who might be at their limit and being refused.
    const resolved = await resolveAllowancePeriodKey(new BillingPortSubscriptionSource(this.#db), {
      workspaceId: scope.workspaceId,
      atIso: toIso(this.#now),
      environment,
    });
    if (resolved.key === null) {
      return {
        ...nothingYet(toIso(this.#now), toIso(this.#now)),
        subscriptionStatus: (subscription?.status as SubscriptionStatus | undefined) ?? null,
      };
    }
    const periodEnd = subscription?.current_period_end ?? toIso(this.#now);

    const allowance = await entitlements.get(this.#db, scope.workspaceId, resolved.key);
    const used = (allowance?.consumed ?? 0) + (allowance?.reserved ?? 0);
    const included = allowance?.run_limit ?? LIMITS.PLAN_RUNS_PER_PERIOD;

    return {
      // The END is the provider's own figure and is the key the row is stored under.
      // The START is NOT derived here: computing it means walking the anchor boundaries,
      // and a second spelling of that walk is exactly the A13-010 defect. A06 has not
      // exported `allowancePeriodStartAt`; requested in the handoff. Until it exists this
      // reports when the figures were read, which is true, rather than a month we guessed.
      periodStart: toIso(this.#now),
      periodEnd: toIso(periodEnd),
      runsUsed: used,
      runsIncluded: included,
      // Resolved from the stored allowance, never from anything the browser sent.
      admissionBlocked: allowance !== null && included - used <= 0,
      subscriptionStatus: (subscription?.status as SubscriptionStatus | undefined) ?? null,
    };
  }

  async billingPortalLink(): Promise<{ href: string | null; reason: string | null }> {
    const scope = await this.#scope();
    if (scope === null) return { href: null, reason: 'Sign in to manage billing.' };
    const subscription = await subscriptions.getForWorkspace(
      this.#db,
      scope.workspaceId,
      this.#env.STRIPE_MODE === 'live' ? 'live' : 'test',
    );
    if (subscription === null) {
      return {
        href: null,
        reason:
          'There is no subscription to manage yet, so there is nothing to open and nothing to cancel.',
      };
    }
    return {
      href: null,
      reason:
        'The billing portal could not be opened. A portal link has to be created through Stripe with a secret key, and Stripe is not configured in this environment.',
    };
  }

  /* --- support --- */

  /**
   * Record a support request.
   *
   * **This delegates to A09's `createCase` and does not reimplement any of it.** The
   * previous version wrote the raw body straight into `body_redacted` and hard-coded
   * `category: 'other'`, `priority: 'normal'`, `state: 'open'` — under a comment claiming
   * redaction had happened elsewhere. Two published statements were false as a result:
   *
   *  - a customer who pasted an API key into the form had it stored verbatim, in a column
   *    whose name asserts the opposite, and in every backup since;
   *  - a billing dispute, a deletion request and a security report never escalated, so
   *    A09's acknowledgement — "it has gone straight to the owner" — was untrue.
   *
   * `createCase` redacts, triages, writes and produces the acknowledgement, in that order.
   * Calling it is the fix; the comment that used to stand here is exactly why the defect
   * survived review, because it told the next reader the work was already done.
   */
  async submitSupportRequest(input: SupportRequestInput): Promise<SupportResult> {
    const scope = await this.#scope();
    const fieldErrors: Record<string, string> = {};
    const subject = input.subject.trim();
    const body = input.body.trim();
    if (subject.length < 3) fieldErrors['subject'] = 'Tell us in a few words what this is about.';
    if (body.length < 10) fieldErrors['body'] = 'A little more detail will let us help faster.';
    if (subject.length > 200)
      fieldErrors['subject'] = 'Please keep the subject under 200 characters.';
    if (body.length > 5000) fieldErrors['body'] = 'Please keep the message under 5000 characters.';
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, fieldErrors, message: null, redirectTo: null, reference: null };
    }
    if (scope === null) {
      return {
        ok: false,
        fieldErrors: {},
        message:
          'Sign in so we can link your message to your workspace, or use the public support form if you cannot sign in.',
        redirectTo: null,
        reference: null,
      };
    }

    // If the run id is not this workspace's, it is dropped rather than stored — a support
    // case must not become a way to reference another tenant's run.
    let linkedRunId: string | null = null;
    if (input.runId !== undefined && input.runId.length > 0) {
      const run = await runs.get(this.#db, scope.workspaceId, input.runId);
      linkedRunId = run?.id ?? null;
    }

    return recordSupportCase(this.#db, {
      workspaceId: scope.workspaceId,
      contactEmail: scope.email,
      subject,
      body,
      linkedRunId,
      now: this.#now,
    });
  }
}

/**
 * The one support write path, shared by the signed-in port and the public form.
 *
 * Both callers land here so neither can drift from the other on redaction or triage. The
 * raw body reaches `createCase` and nothing else: it is redacted before it is stored, and
 * triage decides the category, priority and starting state from the redacted text.
 */
export async function recordSupportCase(
  db: Db,
  input: {
    workspaceId: string | null;
    contactEmail: string;
    subject: string;
    body: string;
    linkedRunId?: string | null;
    servicePaused?: boolean;
    now?: Date;
  },
): Promise<SupportResult> {
  try {
    const created = await createCase(
      new D1SupportDataPort(db),
      {
        workspaceId: input.workspaceId,
        contactEmail: input.contactEmail,
        subject: input.subject,
        body: input.body,
        linkedRunId: input.linkedRunId ?? null,
        ...(input.servicePaused !== undefined ? { servicePaused: input.servicePaused } : {}),
      },
      input.now ?? new Date(),
    );
    return {
      ok: true,
      fieldErrors: {},
      // A09's own wording, which now matches what actually happened: the escalated
      // sentence is only produced when triage actually escalated.
      message: created.acknowledgement,
      redirectTo: '/app/support',
      reference: created.record.id,
    };
  } catch (error) {
    // A validation refusal from `createCase` is a field problem, not a 500.
    if (error instanceof AppError && error.httpStatus === 422) {
      return {
        ok: false,
        fieldErrors: { body: error.publicMessage },
        message: error.publicMessage,
        redirectTo: null,
        reference: null,
      };
    }
    throw error;
  }
}

/**
 * The signed-out support path.
 *
 * Support and cancellation must stay reachable when the service is paused and when the
 * person cannot sign in — which is precisely when they most need to reach us. A signed-out
 * case carries `workspace_id = NULL`, which is a real scope in `supportCases.get`, not a
 * wildcard, so it is readable by the owner queue and by nobody else.
 *
 * The contact address is required here because there is no session to take it from, and a
 * message we cannot reply to is not a support channel.
 */
export async function recordAnonymousSupportCase(
  db: Db,
  input: {
    contactEmail: string;
    subject: string;
    body: string;
    servicePaused?: boolean;
    now?: Date;
  },
): Promise<SupportResult> {
  return recordSupportCase(db, { ...input, workspaceId: null });
}

/** One sentence per status. Deliberately not a decision — it only describes one. */
function summarise(status: RunStatus, mandatoryTotal: number): string {
  switch (status) {
    case 'VERIFIED':
      return `All ${mandatoryTotal} required checks are supported by evidence we retrieved.`;
    case 'FAILED':
      return 'At least one required check is contradicted by the evidence we retrieved.';
    case 'UNVERIFIED':
      return 'We could not retrieve enough evidence to decide. That is not a failure.';
    case 'PENDING':
      return 'Still inside the agreed completion window.';
    default:
      return 'No decision has been recorded.';
  }
}

/**
 * Factory for the route mount.
 *
 * Accepts a Hono context structurally so `apps/app/src/db/` never imports Hono. `c.env` is
 * typed `unknown` because A05's `RouteEnv` deliberately declares only the vars the pages
 * read; the binding really is there at runtime, and this checks it rather than asserting.
 */
export function createCustomerDataPort(
  c: { readonly env: unknown; readonly req: { readonly raw: Request } },
  now?: Date,
): D1CustomerDataPort {
  const env = c.env as Env | undefined;
  if (env === undefined || env === null || typeof env !== 'object' || !('DB' in env)) {
    throw new Error(
      'createCustomerDataPort: the DB binding is missing. Add a d1_databases entry for this environment in wrangler.jsonc.',
    );
  }
  return new D1CustomerDataPort({
    db: env.DB,
    env,
    request: c.req.raw,
    ...(now !== undefined ? { now } : {}),
  });
}
