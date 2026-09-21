/**
 * An in-memory implementation of `CustomerDataPort`.
 *
 * It exists so every customer page renders and every browser test runs today, while A02's
 * data layer is still being written. It is not a mock in the "pretend it worked" sense:
 * verdicts come from A03's real engine over synthetic evidence, writes actually change the
 * in-memory state, and validation failures actually fail.
 *
 * What it deliberately does not do:
 *   - It never claims a provider was contacted. `beginConnection()` marks a connection
 *     `testing` and says plainly that no authorisation was performed.
 *   - It never claims a payment was taken. `createCheckout()` refuses and says why.
 *   - It never claims a support message reached anybody.
 *
 * State lives for the life of the isolate. That is honest for a demonstration and wrong for
 * a customer, which is exactly why `synthetic` is true and every page says so.
 */
import { decideRunStatus, evaluateAssertions, type AssertionResult } from '@verify/domain';
import {
  LIMITS,
  formatMoney,
  money,
  type CoverageMode,
  type EvidenceBundle,
  type RunStatus,
  type WorkflowRules,
} from '@verify/contracts';
import { maskEmail, maskToken } from '@verify/security';
/*
 * Deliberate: this imports the shared synthetic fixture *builders* from `tests/fixtures/`.
 *
 * They are pure typed functions over the frozen contract with no vitest import, so nothing
 * from the test framework reaches the bundle — only the same builders the domain suite uses,
 * which is precisely the point: the demo cannot drift away from what the tests prove. The
 * brief asked for the demo to run on these fixtures.
 *
 * It is NOT an accident to be tidied away. Moving them would mean a new workspace package
 * (`pnpm-workspace.yaml` and `tsconfig.json` paths are the lead's), which is why they are
 * still here; say the word and I will do it properly rather than by relocating a file.
 */
import {
  CONNECTED_CRM_ACCOUNT,
  CONNECTED_EMAIL_ACCOUNT,
  CORRELATION_VALUE,
  RECIPIENT,
  T_DEADLINE,
  T_EVENT,
  T_INSIDE_WINDOW,
  T_AFTER_DEADLINE,
  makeEmailEventWithStatus,
  makeEmptyBundle,
  makeEvidenceBundle,
  makeUnreachableBundle,
} from '../../../../../tests/fixtures/index.js';
import { composeWorkflowRules } from '../../db/ruleCompiler.js';
import type {
  TestVerificationOffer,
  ActivationView,
  SigningKeyIssueResult,
  ConnectionCredentialsInput,
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
  SupportRequestInput,
  SupportResult,
  UsageView,
  WorkflowDetail,
  WorkflowSummary,
  WriteResult,
} from './port.js';

const DEADLINE_OPTIONS = [60, 300, 600, 1800, 3600] as const;

interface SyntheticState {
  signedIn: boolean;
  email: string;
  workflowName: string;
  correlationProperty: string;
  deadlineSeconds: number;
  coverageMode: CoverageMode;
  requireRecordExists: boolean;
  requireCorrelationMatch: boolean;
  requireEmailDelivered: boolean;
  requireRecipientMatch: boolean;
  connections: Record<ProviderKey, ConnectionView['status']>;
  checkoutAttempted: boolean;
  supportMessages: { reference: string; subject: string }[];
}

function initialState(): SyntheticState {
  return {
    signedIn: true,
    email: 'owner@example.test',
    workflowName: 'Website enquiry → HubSpot contact + acknowledgement',
    correlationProperty: 'verify_correlation_id',
    deadlineSeconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
    coverageMode: 'customer_triggered',
    requireRecordExists: true,
    requireCorrelationMatch: true,
    requireEmailDelivered: true,
    requireRecipientMatch: true,
    connections: { hubspot: 'ready', resend: 'expired' },
    checkoutAttempted: false,
    supportMessages: [],
  };
}

/** Module-level so a POST is still visible on the following GET within one isolate. */
let state: SyntheticState = initialState();

/** Reset between tests. Not reachable from any route. */
export function resetSyntheticState(): void {
  state = initialState();
}

/* -------------------------------------------------------------- synthetic runs */

interface SyntheticRunSeed {
  readonly id: string;
  readonly bundle: EvidenceBundle;
  readonly now: Date;
  readonly hasWorkingEvidenceAccess: boolean;
  readonly observationsRemaining: number;
  readonly occurredOffsetHours: number;
}

const RUN_SEEDS: readonly SyntheticRunSeed[] = [
  {
    id: 'run_syn_0001',
    bundle: makeEvidenceBundle(),
    now: T_INSIDE_WINDOW,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 3,
    occurredOffsetHours: 0,
  },
  {
    id: 'run_syn_0002',
    bundle: makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('bounced')] }),
    now: T_AFTER_DEADLINE,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 0,
    occurredOffsetHours: 2,
  },
  {
    id: 'run_syn_0003',
    bundle: makeEmptyBundle(),
    now: T_INSIDE_WINDOW,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 3,
    occurredOffsetHours: 3,
  },
  {
    id: 'run_syn_0004',
    bundle: makeUnreachableBundle('AUTH_EXPIRED'),
    now: T_AFTER_DEADLINE,
    hasWorkingEvidenceAccess: false,
    observationsRemaining: 0,
    occurredOffsetHours: 5,
  },
  {
    id: 'run_syn_0005',
    bundle: makeEvidenceBundle(),
    now: T_INSIDE_WINDOW,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 3,
    occurredOffsetHours: 7,
  },
  {
    id: 'run_syn_0006',
    bundle: makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('accepted')] }),
    now: T_AFTER_DEADLINE,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 0,
    occurredOffsetHours: 9,
  },
  {
    id: 'run_syn_0007',
    bundle: makeEvidenceBundle(),
    now: T_INSIDE_WINDOW,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 3,
    occurredOffsetHours: 11,
  },
];

/**
 * Build the workflow rules the current in-memory configuration describes.
 *
 * Through the real rule compiler — the same pure function the D1-backed port uses — so this
 * port publishes exactly the checks a real workspace would get from the same two forms.
 *
 * Until 2026-09-19 this function hand-built its assertions and asserted
 * `normalised_email_equals` on the recipient against a fixture literal. The evaluator
 * implements that operator; the product's own composer does not emit it. So the synthetic
 * dashboard was showing a check that no real run performs. Composing through the compiler
 * removes the possibility, and `tests/unit/public/demo-rules.test.ts` pins it.
 */
export function currentRules(): WorkflowRules {
  const composed = composeWorkflowRules({
    correlationProperty: state.correlationProperty,
    deadlineSeconds: state.deadlineSeconds,
    coverageMode: state.coverageMode,
    requireRecordExists: state.requireRecordExists,
    requireCorrelationMatch: state.requireCorrelationMatch,
    requireEmailDelivered: state.requireEmailDelivered,
    requireRecipientMatch: state.requireRecipientMatch,
  });
  if (!composed.ok) {
    // `saveFieldMapping` and `saveExpectedOutcome` refuse every state the compiler would
    // reject, so this is unreachable through the forms. If it is ever reached, a loud error
    // is the honest outcome — never a hand-written document that looks like the rules.
    throw new Error(`synthetic workflow state does not compose: ${composed.failure.message}`);
  }
  return composed.rules;
}

interface DecidedRun {
  readonly id: string;
  readonly status: RunStatus;
  readonly reason: string;
  readonly results: readonly AssertionResult[];
  readonly occurredAt: string;
  readonly decidedAt: string;
}

function decide(seed: SyntheticRunSeed): DecidedRun {
  const rules = currentRules();
  const results = evaluateAssertions(rules, seed.bundle, {
    occurredAt: T_EVENT,
    now: seed.now,
    connectedCrmAccountId: CONNECTED_CRM_ACCOUNT,
    connectedEmailAccountId: CONNECTED_EMAIL_ACCOUNT,
    sourceEvent: { correlation_id: CORRELATION_VALUE, email_recipient: RECIPIENT },
  });
  const decision = decideRunStatus(results, {
    deadlineAt: T_DEADLINE,
    now: seed.now,
    hasWorkingEvidenceAccess: seed.hasWorkingEvidenceAccess,
    observationsRemaining: seed.observationsRemaining,
  });
  const occurredAt = new Date(
    T_EVENT.getTime() + seed.occurredOffsetHours * 3_600_000,
  ).toISOString();
  return {
    id: seed.id,
    status: decision.status,
    reason: decision.reason,
    results,
    occurredAt,
    decidedAt: new Date(Date.parse(occurredAt) + 600_000).toISOString(),
  };
}

function allRuns(): readonly DecidedRun[] {
  return RUN_SEEDS.map(decide);
}

function counts(): WorkflowSummary['counts'] {
  const runs = allRuns();
  return {
    verified: runs.filter((run) => run.status === 'VERIFIED').length,
    failed: runs.filter((run) => run.status === 'FAILED').length,
    unverified: runs.filter((run) => run.status === 'UNVERIFIED').length,
    pending: runs.filter((run) => run.status === 'PENDING').length,
  };
}

function mandatoryCounts(results: readonly AssertionResult[]): {
  supported: number;
  total: number;
} {
  const mandatory = results.filter((result) => result.mandatory);
  return {
    supported: mandatory.filter((result) => result.status === 'SUPPORTED').length,
    total: mandatory.length,
  };
}

/* -------------------------------------------------------------------- the port */

const WORKFLOW_ID = 'wf_syn_0001';

function ok(redirectTo: string | null = null): WriteResult {
  return { ok: true, fieldErrors: {}, message: null, redirectTo };
}

function fail(message: string, fieldErrors: Record<string, string> = {}): WriteResult {
  return { ok: false, fieldErrors, message, redirectTo: null };
}

export class SyntheticCustomerDataPort implements CustomerDataPort {
  readonly synthetic = true;

  async session(): Promise<SessionView | null> {
    if (!state.signedIn) return null;
    return {
      workspaceId: 'ws_syn_0001',
      workspaceName: 'Example Agency (synthetic)',
      email: state.email,
      role: 'workspace_admin',
      // A fixed, obviously-synthetic token. A02's implementation issues a real one and sets
      // the matching double-submit cookie; this one only proves the field is wired.
      csrfToken: 'synthetic-csrf-token-not-a-real-secret',
    };
  }

  async requestSignInLink(email: string): Promise<WriteResult> {
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      return fail('Enter the email address you want the sign-in link sent to.', {
        email: 'Enter your email address.',
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return fail('That does not look like an email address.', {
        email: 'Enter a complete email address, like name@company.com.',
      });
    }
    state.signedIn = true;
    state.email = trimmed;
    return ok('/app');
  }

  async signOut(): Promise<WriteResult> {
    state.signedIn = false;
    return ok('/');
  }

  async connectorCompatibility(): Promise<readonly ConnectorCompatibility[]> {
    return [
      {
        provider: 'hubspot',
        displayName: 'HubSpot',
        purpose: 'We read your contact records back from HubSpot to check them against your rules.',
        requirements: [
          'A HubSpot account you can grant read access to on contacts',
          'A property on your contact records that carries a unique reference for each enquiry',
        ],
        supported: true,
        unsupportedReason: null,
      },
      {
        provider: 'resend',
        displayName: 'Resend',
        purpose: 'We read message status events back from your Resend account.',
        requirements: [
          'A Resend account whose message events we can read',
          'The acknowledgement email must be sent through that same account',
        ],
        supported: true,
        unsupportedReason: null,
      },
    ];
  }

  async connections(): Promise<readonly ConnectionView[]> {
    const catalogue = await this.connectorCompatibility();
    return catalogue.map((entry) => {
      const status = state.connections[entry.provider];
      const problem =
        status === 'testing'
          ? 'We have stored what you gave us. This connection is not finished: it becomes ready only once a correctly signed message actually arrives and we can read it.'
          : status === 'expired'
            ? 'The authorisation for this connection has expired, so we cannot read evidence from it.'
            : status === 'revoked'
              ? 'Access to this connection was revoked at the provider.'
              : status === 'not_connected'
                ? 'This provider has not been connected yet.'
                : null;
      return {
        provider: entry.provider,
        displayName: entry.displayName,
        status,
        accountLabel:
          status === 'ready' || status === 'expired'
            ? maskToken(`${entry.provider}-account-000042`)
            : null,
        lastCheckedAt: status === 'not_connected' ? null : T_AFTER_DEADLINE.toISOString(),
        // Synthetic: never a real-looking address a reader might register with Resend.
        webhookUrl: null,
        problem,
        nextStep:
          problem === null
            ? null
            : status === 'testing'
              ? `Finish the ${entry.displayName} setup, then wait for the first signed message to arrive.`
              : `Reconnect ${entry.displayName} to restore read access.`,
      };
    });
  }

  async beginConnection(provider: ProviderKey): Promise<WriteResult> {
    return fail(
      `No authorisation was started and nothing about your ${provider} connection has changed. This workspace is running on synthetic data, so there is nowhere to send you.`,
    );
  }

  /**
   * Validates the *shape* of a pasted credential and nothing else.
   *
   * It deliberately stops short of claiming a connection works. A real implementation hands
   * the value to A04's `establishConnection`, which asks the provider; this one cannot, so on
   * a well-shaped value it records `testing` — "we have stored what you gave us" — and says in
   * so many words that storing is not validating. A stored secret is a promise, not evidence.
   */
  async submitConnectionCredentials(input: ConnectionCredentialsInput): Promise<WriteResult> {
    const token = input.accessToken.trim();
    const expectedPrefix = input.provider === 'hubspot' ? 'pat-' : 're_';
    if (token === '') {
      return fail('Nothing was checked and nothing was stored.', {
        access_token: 'Paste the token before submitting.',
      });
    }
    if (!token.startsWith(expectedPrefix)) {
      return fail('Nothing was checked and nothing was stored.', {
        access_token: `A ${input.provider} token starts ${expectedPrefix}. Check you copied the whole value.`,
      });
    }
    const secret = (input.webhookSecret ?? '').trim();
    if (secret !== '' && !secret.startsWith('whsec_')) {
      return fail('Nothing was checked and nothing was stored.', {
        webhook_secret:
          'A signing secret starts whsec_. Leave it blank to connect the webhook later.',
      });
    }

    state.connections[input.provider] = 'testing';
    return {
      ok: false,
      fieldErrors: {},
      message:
        `That looks like a ${input.provider} credential, but nothing was sent to ${input.provider} and nothing was stored. ` +
        'This workspace is running on synthetic data, so we cannot check the credential against the provider, and we are not going to mark the connection working on our own say-so.',
      redirectTo: null,
    };
  }

  async workflow(): Promise<WorkflowDetail> {
    const rules = currentRules();
    return {
      id: WORKFLOW_ID,
      name: state.workflowName,
      coverageMode: state.coverageMode,
      deadlineSeconds: state.deadlineSeconds,
      active: true,
      lastEventAt: new Date(T_EVENT.getTime() + 11 * 3_600_000).toISOString(),
      counts: counts(),
      mapping: {
        correlationProperty: rules.crm_correlation_property,
        availableProperties: [
          'verify_correlation_id',
          'enquiry_reference',
          'hs_object_id',
          'lifecyclestage',
        ],
      },
      outcome: {
        deadlineSeconds: state.deadlineSeconds,
        requireRecordExists: state.requireRecordExists,
        requireCorrelationMatch: state.requireCorrelationMatch,
        requireEmailDelivered: state.requireEmailDelivered,
        requireRecipientMatch: state.requireRecipientMatch,
        coverageMode: state.coverageMode,
      },
      signingKeyHint: maskToken(['whsec', 'synthetic', '000000000000abcd'].join('_')),
    };
  }

  async workflows(): Promise<readonly WorkflowSummary[]> {
    return [await this.workflow()];
  }

  async saveFieldMapping(input: FieldMappingInput): Promise<WriteResult> {
    const value = input.correlationProperty.trim();
    if (value.length === 0) {
      return fail('Choose the property that carries your enquiry reference.', {
        correlationProperty: 'Choose a property.',
      });
    }
    if (!/^[A-Za-z0-9_]{1,128}$/.test(value)) {
      return fail('That property name is not one HubSpot could hold.', {
        correlationProperty: 'Use letters, numbers and underscores only, up to 128 characters.',
      });
    }
    state.correlationProperty = value;
    return ok('/app/onboarding/outcome');
  }

  async saveExpectedOutcome(input: ExpectedOutcomeInput): Promise<WriteResult> {
    if (!DEADLINE_OPTIONS.includes(input.deadlineSeconds as (typeof DEADLINE_OPTIONS)[number])) {
      return fail('Choose one of the completion windows offered.', {
        deadlineSeconds: `Choose a window between ${LIMITS.MIN_DEADLINE_SECONDS} and ${LIMITS.MAX_DEADLINE_SECONDS} seconds.`,
      });
    }
    const anyRequired =
      input.requireRecordExists ||
      input.requireCorrelationMatch ||
      input.requireEmailDelivered ||
      input.requireRecipientMatch;
    if (!anyRequired) {
      return fail(
        'Choose at least one check. With nothing required, a verified result would not mean anything.',
        { requireRecordExists: 'At least one check has to be required.' },
      );
    }
    state.deadlineSeconds = input.deadlineSeconds;
    state.coverageMode = input.coverageMode;
    state.requireRecordExists = input.requireRecordExists;
    state.requireCorrelationMatch = input.requireCorrelationMatch;
    state.requireEmailDelivered = input.requireEmailDelivered;
    state.requireRecipientMatch = input.requireRecipientMatch;
    return ok('/app/onboarding/proof');
  }

  /**
   * The demo workspace cannot start one, and says why rather than pretending.
   *
   * A test verification is admitted through the real path and decided by reading real
   * providers. This workspace has neither: no allowance to draw from and no connected
   * account to read. Offering the form here and fabricating a verdict would be the exact
   * thing the feature is built to refuse.
   */
  async testVerificationOffer(): Promise<TestVerificationOffer> {
    return {
      canStart: false,
      reason:
        'This workspace is running on synthetic data, with no allowance and no connected provider, so there is nothing real to check a test against. A test verification here could only be a fabrication.',
      consumesAllowance: true,
      runsRemaining: 0,
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      correlationProperty: '',
    };
  }

  async runProof(): Promise<ProofRunView> {
    const rules = currentRules();
    const results = evaluateAssertions(rules, makeEvidenceBundle(), {
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
      connectedCrmAccountId: CONNECTED_CRM_ACCOUNT,
      connectedEmailAccountId: CONNECTED_EMAIL_ACCOUNT,
      sourceEvent: { correlation_id: CORRELATION_VALUE, email_recipient: RECIPIENT },
    });
    const decision = decideRunStatus(results, {
      deadlineAt: T_DEADLINE,
      now: T_INSIDE_WINDOW,
      hasWorkingEvidenceAccess: true,
      observationsRemaining: 3,
    });
    return {
      ran: true,
      status: decision.status,
      statusReason: decision.reason,
      results,
      blockedReason: null,
    };
  }

  async orderSummary(): Promise<OrderSummaryView> {
    const blockers: string[] = [];
    for (const connection of await this.connections()) {
      if (connection.status !== 'ready') {
        blockers.push(
          `${connection.displayName} is not connected and ready: its status is "${connection.status}".`,
        );
      }
    }
    return {
      planName: 'Verify',
      priceDisplay: formatMoney(money(LIMITS.PLAN_PRICE_PENCE, 'GBP')),
      billingPeriod: 'per month',
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      // The demo never takes money, so it is always the sandbox answer. Stated rather than
      // defaulted: this port renders the same review page as the real one.
      paymentsMode: 'test' as const,
      blockers,
      ready: blockers.length === 0,
    };
  }

  async createCheckout(): Promise<WriteResult> {
    state.checkoutAttempted = true;
    return fail(
      'No checkout session was created and no card was charged. This workspace is running on synthetic data and is not connected to Stripe. When billing lands, this button hands you to Stripe hosted Checkout: card details never reach us.',
    );
  }

  async activation(): Promise<ActivationView> {
    const runs = allRuns();
    return {
      active: false,
      subscriptionStatus: null,
      eventEndpoint: '/api/v1/events',
      workflowId: WORKFLOW_ID,
      // Obviously synthetic, and not derivable from anything: there is no root key here.
      signingKeyId: ['evk', 'synthetic', '0000000000000000'].join('_'),
      signingKeyHint: maskToken(['whsec', 'synthetic', '000000000000abcd'].join('_')),
      signingKeyIssuance: {
        canIssue: false,
        cannotIssueReason:
          'This workspace is running on synthetic data. There is no root key here and no real workflow to bind one to, so no signing key can be issued.',
      },
      firstRunId: runs[0]?.id ?? null,
    };
  }

  /** Nothing to derive from and nothing to bind to. Says so rather than minting a decoy. */
  async issueSigningKey(): Promise<SigningKeyIssueResult> {
    return {
      outcome: 'refused',
      reason: 'unavailable',
      message:
        'No signing key was issued. This workspace is running on synthetic data: there is no root key here and no real workflow to bind one to, so nothing was changed.',
    };
  }

  async listRuns(options: { readonly cursor?: string; readonly limit: number }): Promise<RunPage> {
    const runs = [...allRuns()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const offset =
      options.cursor === undefined ? 0 : Math.max(0, Number.parseInt(options.cursor, 10) || 0);
    const slice = runs.slice(offset, offset + options.limit);
    const items: RunListItem[] = slice.map((run) => {
      const mandatory = mandatoryCounts(run.results);
      return {
        id: run.id,
        status: run.status,
        summary: `Enquiry from ${RECIPIENT}`,
        correlationId: CORRELATION_VALUE,
        occurredAt: run.occurredAt,
        decidedAt: run.status === 'PENDING' ? null : run.decidedAt,
        mandatorySupported: mandatory.supported,
        mandatoryTotal: mandatory.total,
      };
    });
    return {
      items,
      nextCursor: offset + options.limit < runs.length ? String(offset + options.limit) : null,
      prevCursor: offset > 0 ? String(Math.max(0, offset - options.limit)) : null,
    };
  }

  async run(runId: string): Promise<RunDetailView | null> {
    const found = allRuns().find((run) => run.id === runId);
    if (found === undefined) return null;
    const rules = currentRules();
    return {
      id: found.id,
      workflowId: WORKFLOW_ID,
      workflowName: state.workflowName,
      status: found.status,
      statusReason: found.reason,
      correlationId: CORRELATION_VALUE,
      recipient: RECIPIENT,
      occurredAt: found.occurredAt,
      deadlineAt: new Date(
        Date.parse(found.occurredAt) + state.deadlineSeconds * 1000,
      ).toISOString(),
      observedAt: found.decidedAt,
      decidedAt: found.status === 'PENDING' ? null : found.decidedAt,
      sourceType: 'signed source event from your automation (customer_claim)',
      rulesRef: `${WORKFLOW_ID}@v1`,
      rulesSchemaVersion: rules.schema_version,
      coverageMode: state.coverageMode,
      revision: 1,
      lateCompletion: false,
      results: found.results,
    };
  }

  async usage(): Promise<UsageView> {
    return {
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
      runsUsed: RUN_SEEDS.length,
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      admissionBlocked: false,
      subscriptionStatus: null,
    };
  }

  /** The synthetic workspace has no Stripe binding, so both halves refuse for one reason. */
  readonly #noPortal =
    'There is no subscription to manage. This workspace is running on synthetic data and has never been connected to Stripe, so there is no billing portal to open and nothing to cancel.';

  async billingPortalAvailability(): Promise<{ canOpen: boolean; reason: string | null }> {
    return { canOpen: false, reason: this.#noPortal };
  }

  async openBillingPortal(): Promise<{ href: string | null; reason: string | null }> {
    return { href: null, reason: this.#noPortal };
  }

  async submitSupportRequest(input: SupportRequestInput): Promise<SupportResult> {
    const fieldErrors: Record<string, string> = {};
    if (input.subject.trim().length === 0)
      fieldErrors['subject'] = 'Tell us in a few words what this is about.';
    if (input.body.trim().length < 10)
      fieldErrors['body'] = 'Give us at least a sentence so we can help.';
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, fieldErrors, message: null, redirectTo: null, reference: null };
    }
    const reference = `syn-${String(state.supportMessages.length + 1).padStart(4, '0')}`;
    state.supportMessages.push({ reference, subject: input.subject.trim() });
    return {
      ok: true,
      fieldErrors: {},
      message:
        'Your message was recorded in this browser session only. Nothing was sent to anybody: this workspace is running on synthetic data and the support queue is not connected yet.',
      redirectTo: null,
      reference,
    };
  }
}

/** The masked email a page shows for the signed-in account. */
export function maskedAccountLabel(email: string): string {
  return maskEmail(email);
}

/** The completion windows the outcome form offers. */
export const DEADLINE_CHOICES: readonly number[] = DEADLINE_OPTIONS;
