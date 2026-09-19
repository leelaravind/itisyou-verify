/**
 * `CustomerDataPort` — exactly the reads and writes the customer pages need, and nothing
 * else.
 *
 * A02 owns the data layer and it is still being written. Rather than block, the pages are
 * implemented against this interface and ship today on a synthetic in-memory
 * implementation (`syntheticPort.ts`). When A02's repositories land, the lead wires them to
 * this interface and the pages do not change.
 *
 * Deliberate properties of this contract:
 *
 *   - **No `workspace_id` parameter anywhere.** The port is resolved per request from the
 *     session, so a page physically cannot ask for another tenant's data — engineering rule
 *     1 is enforced by the shape of the interface rather than by remembering.
 *   - **No price, plan or entitlement is ever passed in.** `orderSummary()` and `usage()`
 *     return server-resolved values; the browser never supplies one (rule 5).
 *   - **Writes return a typed result rather than throwing for validation.** A form needs to
 *     re-render with field-level errors, not a 500.
 *   - **Every read that can be empty says so in its type.** `null` means "there is nothing",
 *     never "assume the happy path".
 *
 * Implementations must never fabricate a success (rule 6). If a write could not be
 * performed, `ok` is false and `message` says what actually happened.
 */
import type { AssertionResult } from '@verify/domain';
import type { ConnectionStatus, CoverageMode, RunStatus, SubscriptionStatus } from '@verify/contracts';

/* --------------------------------------------------------------- session / identity */

export type WorkspaceRole = 'workspace_admin' | 'workspace_viewer';

export interface SessionView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The signed-in person's email. Shown to them, and to nobody else. */
  readonly email: string;
  readonly role: WorkspaceRole;
  /** Double-submit CSRF token for every form on the page. A02 owns generation. */
  readonly csrfToken: string;
}

/* ------------------------------------------------------------------ onboarding shape */

export type ProviderKey = 'hubspot' | 'resend';

/** One provider's compatibility answer, before the customer is asked to connect anything. */
export interface ConnectorCompatibility {
  readonly provider: ProviderKey;
  readonly displayName: string;
  /** What this provider is used for, in one line. */
  readonly purpose: string;
  /** What the customer must already have. Rendered as a checklist. */
  readonly requirements: readonly string[];
  readonly supported: boolean;
  /** Non-null only when `supported` is false. Never a generic "not supported". */
  readonly unsupportedReason: string | null;
}

export interface ConnectionView {
  readonly provider: ProviderKey;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  /** A masked account label, generated fresh — never a stored credential (rule 7). */
  readonly accountLabel: string | null;
  readonly lastCheckedAt: string | null;
  /** What is wrong, in plain language, or null when nothing is. */
  readonly problem: string | null;
  /** What the customer can do about it, or null when there is nothing useful to suggest. */
  readonly nextStep: string | null;
}

/* ---------------------------------------------------------------------- workflow */

export interface RunCountsView {
  readonly verified: number;
  readonly failed: number;
  readonly unverified: number;
  readonly pending: number;
}

export interface WorkflowSummary {
  readonly id: string;
  /** Customer-supplied. Always rendered through the escaping template — never with `raw`. */
  readonly name: string;
  readonly coverageMode: CoverageMode;
  readonly deadlineSeconds: number;
  readonly active: boolean;
  /** When the last source event arrived, for the inactivity signal. Null if none ever has. */
  readonly lastEventAt: string | null;
  readonly counts: RunCountsView;
}

/** The mapping between our correlation reference and the customer's CRM property. */
export interface FieldMappingView {
  readonly correlationProperty: string;
  /** Properties the connected CRM actually exposes, for the select. Empty until connected. */
  readonly availableProperties: readonly string[];
}

export interface ExpectedOutcomeView {
  readonly deadlineSeconds: number;
  readonly requireRecordExists: boolean;
  readonly requireCorrelationMatch: boolean;
  readonly requireEmailDelivered: boolean;
  readonly requireRecipientMatch: boolean;
  readonly coverageMode: CoverageMode;
}

export interface WorkflowDetail extends WorkflowSummary {
  readonly mapping: FieldMappingView;
  readonly outcome: ExpectedOutcomeView;
  /** A freshly generated mask of the signing key, or null when none has been issued. */
  readonly signingKeyHint: string | null;
}

/* ------------------------------------------------------------------------- runs */

export interface RunListItem {
  readonly id: string;
  readonly status: RunStatus;
  readonly summary: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly decidedAt: string | null;
  readonly mandatorySupported: number;
  readonly mandatoryTotal: number;
}

/**
 * One page of runs. Cursors are opaque strings; the UI never constructs one and never
 * offers a page number, because a cursor API cannot honour "page 7 of 40".
 */
export interface RunPage {
  readonly items: readonly RunListItem[];
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
}

export interface RunDetailView {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly status: RunStatus;
  /** The decision engine's own sentence for this run. */
  readonly statusReason: string;
  readonly correlationId: string;
  /** The recipient the automation named. Masked by the page before display. */
  readonly recipient: string;
  readonly occurredAt: string;
  readonly deadlineAt: string;
  readonly observedAt: string | null;
  readonly decidedAt: string | null;
  /** How we learned about this enquiry — a signed source event, or our own listing. */
  readonly sourceType: string;
  /** Which version of the rules decided it, e.g. `wf_1@v3`. */
  readonly rulesRef: string;
  readonly rulesSchemaVersion: number;
  readonly coverageMode: CoverageMode;
  readonly revision: number;
  readonly lateCompletion: boolean;
  readonly results: readonly AssertionResult[];
}

/* -------------------------------------------------------------- billing and usage */

export interface UsageView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly runsUsed: number;
  readonly runsIncluded: number;
  /** True once the allowance is spent and new events are being refused. */
  readonly admissionBlocked: boolean;
  readonly subscriptionStatus: SubscriptionStatus | null;
}

/** What the customer is about to buy, resolved entirely server-side. */
export interface OrderSummaryView {
  readonly planName: string;
  readonly priceDisplay: string;
  readonly billingPeriod: string;
  readonly runsIncluded: number;
  /** Everything that must be true before checkout is offered. */
  readonly blockers: readonly string[];
  readonly ready: boolean;
}

export interface ActivationView {
  readonly active: boolean;
  readonly subscriptionStatus: SubscriptionStatus | null;
  /** The endpoint the customer's automation must call. */
  readonly eventEndpoint: string;
  readonly workflowId: string;
  readonly signingKeyHint: string | null;
  /** Null until a first run has actually arrived. */
  readonly firstRunId: string | null;
}

/* --------------------------------------------------------------- proof and support */

/** The synthetic proof run: a real evaluation against evidence we invent, before paying. */
export interface ProofRunView {
  readonly ran: boolean;
  readonly status: RunStatus | null;
  readonly statusReason: string | null;
  readonly results: readonly AssertionResult[];
  /** Why we could not run it, when `ran` is false. Never null in that case. */
  readonly blockedReason: string | null;
}

export interface SupportRequestInput {
  readonly subject: string;
  readonly body: string;
  readonly runId?: string;
}

/* ------------------------------------------------------------------ write results */

/** The shape every form submission comes back as. Field errors render beside their field. */
export interface WriteResult {
  readonly ok: boolean;
  /** Keyed by form field name, so the page can put each message next to its own input. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** A form-level message. Null when every problem is a field problem. */
  readonly message: string | null;
  /** Where to send the browser on success, for the POST-redirect-GET pattern. */
  readonly redirectTo: string | null;
}

export interface SupportResult extends WriteResult {
  /** A reference the customer can quote. Null when nothing was actually recorded. */
  readonly reference: string | null;
}

/** A pasted credential, on its way to A04's `establishConnection`. */
export interface ConnectionCredentialsInput {
  readonly provider: ProviderKey;
  /** Never echoed back to the page, never logged, never stored unsealed. */
  readonly accessToken: string;
  /** Resend only, and optional there: a webhook-only connection is a supported choice. */
  readonly webhookSecret?: string;
}

export interface FieldMappingInput {
  readonly correlationProperty: string;
}

export interface ExpectedOutcomeInput {
  readonly deadlineSeconds: number;
  readonly requireRecordExists: boolean;
  readonly requireCorrelationMatch: boolean;
  readonly requireEmailDelivered: boolean;
  readonly requireRecipientMatch: boolean;
  readonly coverageMode: CoverageMode;
}

/* ----------------------------------------------------------------------- the port */

export interface CustomerDataPort {
  /**
   * True when this is the synthetic implementation. Pages render a visible banner when it
   * is, so nobody can mistake placeholder data for their own.
   */
  readonly synthetic: boolean;

  /* session */
  session(): Promise<SessionView | null>;
  /** Start a magic-link sign-in. Never reveals whether the address has an account. */
  requestSignInLink(email: string): Promise<WriteResult>;
  signOut(): Promise<WriteResult>;

  /* onboarding */
  connectorCompatibility(): Promise<readonly ConnectorCompatibility[]>;
  connections(): Promise<readonly ConnectionView[]>;
  /** Begin an authorisation. Returns where to send the browser, or why it cannot start. */
  beginConnection(provider: ProviderKey): Promise<WriteResult>;

  /**
   * Validate and store a pasted provider credential.
   *
   * Optional on this interface **only so that adding it does not break a port that has not
   * implemented it yet** — a page that finds it missing says so plainly rather than
   * pretending the paste box works. A02: implement it by handing `input` straight to A04's
   * `establishConnection` and persisting only on `ok`.
   *
   * The `fieldErrors` keys are `access_token` and `webhook_secret`, which is exactly what
   * `establishConnection` returns and exactly what `setupGuide(provider).fields[].name`
   * gives, so the three line up with no translation layer in between.
   *
   * On any failure nothing is stored, and the message says so — a credential that was
   * rejected must never leave a half-connected row behind.
   */
  submitConnectionCredentials?(input: ConnectionCredentialsInput): Promise<WriteResult>;

  workflow(): Promise<WorkflowDetail | null>;
  workflows(): Promise<readonly WorkflowSummary[]>;
  saveFieldMapping(input: FieldMappingInput): Promise<WriteResult>;
  saveExpectedOutcome(input: ExpectedOutcomeInput): Promise<WriteResult>;

  /** Run the configured rules against synthetic evidence, so the customer sees a result first. */
  runProof(): Promise<ProofRunView>;

  orderSummary(): Promise<OrderSummaryView>;
  /** Create a Stripe Checkout session. The price is resolved server-side, never posted. */
  createCheckout(): Promise<WriteResult>;
  activation(): Promise<ActivationView>;

  /* results */
  listRuns(options: { readonly cursor?: string; readonly limit: number }): Promise<RunPage>;
  run(runId: string): Promise<RunDetailView | null>;

  /* usage and billing */
  usage(): Promise<UsageView>;
  /** A link into the Stripe Billing Portal, or why there is not one yet. */
  billingPortalLink(): Promise<{ readonly href: string | null; readonly reason: string | null }>;

  /* support */
  submitSupportRequest(input: SupportRequestInput): Promise<SupportResult>;
}
