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
import type {
  ConnectionStatus,
  CoverageMode,
  RunStatus,
  SubscriptionStatus,
} from '@verify/contracts';

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
  /**
   * The address Resend must call for THIS connection, assembled from `PUBLIC_BASE_URL` and
   * the connection's `webhook_path_id` at read time. Null for HubSpot, and for Resend until
   * a key has been checked. Until 20 September the connect page told every customer this
   * address "does not exist in this deployment yet" while the route was mounted and the id
   * was assigned on submit -- a connection that could never be finished through the product.
   */
  readonly webhookUrl: string | null;
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
  /** Runs their automation reported. Test runs are excluded, so this is the honest rate. */
  readonly counts: RunCountsView;
  /**
   * Runs the customer started themselves, counted separately.
   *
   * Exists so a workspace showing four zeroes beside "7 of 500 used" can explain itself
   * out of real data rather than leaving a reader to conclude the product is broken.
   */
  readonly testCounts: RunCountsView;
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

/**
 * Whether this workflow is admitting what the customer's automation sends.
 *
 * `paused` is a choice the customer made and can undo. `awaiting_setup` means we have
 * never heard from their automation and there is nothing to receive yet. `receiving` means
 * events are arriving. The three are distinguishable because a customer who sees nothing
 * arriving needs to know which of "I turned it off", "I never finished setting it up" and
 * "it broke" they are looking at, and those have different next steps.
 */
export type AutomationStatus = 'receiving' | 'awaiting_setup' | 'paused';

export interface AdmissionControls {
  readonly status: AutomationStatus;
  /** When the customer paused new admissions, or null while admitting normally. */
  readonly pausedAt: string | null;
  /** A customer-set ceiling for the period, below the plan allowance. Null for none. */
  readonly limitPerPeriod: number | null;
  /** Admissions counted against that ceiling this period. */
  readonly admittedThisPeriod: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  readonly admission: AdmissionControls;
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
  /** True when the customer started this from the workspace rather than their automation. */
  readonly isTest: boolean;
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
  /**
   * The four values this enquiry was described with, when they can still be read.
   *
   * Used to prefill "Recheck this enquiry" so the customer does not retype four
   * identifiers. Null for a run whose payload cannot be read, in which case the page
   * offers a fresh verification instead of a prefill it cannot honestly populate.
   */
  readonly enquiry: {
    readonly crmRecordId: string;
    readonly messageId: string;
    readonly expectedRecipient: string;
    readonly correlationValue: string;
  } | null;
  readonly results: readonly AssertionResult[];
}

/* -------------------------------------------------------------- billing and usage */

export interface UsageView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly runsUsed: number;
  readonly runsIncluded: number;
  /**
   * The two halves of `runsUsed`, kept apart.
   *
   * `consumed` is settled: those runs reached a verdict. `reserved` is in flight: admitted,
   * charged, not yet decided. Both are subtracted from the allowance identically, so a page
   * showing only their sum is arithmetically right and still hides the thing a customer
   * asks about when a figure surprises them — how much of this is still happening.
   */
  readonly consumed: number;
  readonly reserved: number;
  /** `runsIncluded - runsUsed`, never below zero. */
  readonly runsRemaining: number;
  /** When these figures were read. Shown, so a stale tab cannot pass for a fresh one. */
  readonly readAt: string;
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
  /**
   * Which Stripe the customer is about to be handed to.
   *
   * Carried into the view because the review page must say it. In `test` no card is
   * charged and no service is owed, and a person about to type a card number is entitled
   * to know that before they type it rather than after, when Stripe's own banner tells
   * them. Resolved from the environment, never from the request.
   */
  readonly paymentsMode: 'test' | 'live';
}

/** Whether the signed-in person can obtain a signing key here and, if not, why not. */
export interface SigningKeyIssuanceView {
  readonly canIssue: boolean;
  /**
   * Non-null exactly when `canIssue` is false. Plain language, and when the reason is the
   * deployment's own configuration it names the missing secret, because the person reading
   * it on a bare deployment is the operator.
   */
  readonly cannotIssueReason: string | null;
}

export interface ActivationView {
  readonly active: boolean;
  readonly subscriptionStatus: SubscriptionStatus | null;
  /** The endpoint the customer's automation must call. */
  readonly eventEndpoint: string;
  readonly workflowId: string;
  /** The public key reference the automation sends in `X-Verify-Key-Id`. Null until issued. */
  readonly signingKeyId: string | null;
  /** A freshly generated mask of the stored key hash, or null when none has been issued. Never the secret. */
  readonly signingKeyHint: string | null;
  readonly signingKeyIssuance: SigningKeyIssuanceView;
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

/**
 * The outcome of issuing or rotating a workflow signing key.
 *
 * `issued` carries the secret **once**. The page renders it on the response to the POST that
 * derived it and nowhere else: the secret is derived from the deployment's root key, not
 * stored, so no later read can show it. Nothing may log it, audit it, notify it or persist
 * it — the row keeps a domain-separated hash and the public reference only.
 */
export type SigningKeyIssueResult =
  | {
      readonly outcome: 'issued';
      readonly keyId: string;
      readonly secret: string;
      /** True when a key already existed: the old reference has just stopped resolving. */
      readonly rotated: boolean;
      readonly issuedAt: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason:
        'not_signed_in' | 'not_permitted' | 'no_workflow' | 'cross_site' | 'unavailable';
      readonly message: string;
    }
  /** No `EVENT_SIGNING_ROOT_KEY` on this deployment. A configuration error, said as one; nothing was written. */
  | { readonly outcome: 'unconfigured'; readonly message: string };

export interface SupportResult extends WriteResult {
  /** A reference the customer can quote. Null when nothing was actually recorded. */
  readonly reference: string | null;
}

/** A pasted credential, on its way to A04's `establishConnection`. */
/**
 * What a "Test connection" actually established, split into the three things a customer
 * could otherwise read as one.
 *
 * The split is the point. A provider answering our API call proves the credential is live
 * and scoped correctly. It does NOT prove the webhook is wired, and neither of those proves
 * the customer's own automation sends us events, which is the only thing that makes a
 * workflow verifiable. Collapsing the three into one green tick would be the product
 * telling exactly the kind of lie it exists to catch in other people's systems.
 */
export interface ConnectionTestResult {
  readonly provider: ProviderKey;
  readonly displayName: string;
  /** Did the provider answer our read with this credential, right now. */
  readonly apiAccess: 'ok' | 'failed' | 'not_checked';
  /**
   * Has a correctly signed callback from this provider ever been received.
   *
   * `not_applicable` for HubSpot, which we poll rather than receive. Never inferred from
   * the API check: a token that reads is not a webhook that arrives.
   */
  readonly webhookReadiness: 'received' | 'never_received' | 'not_applicable';
  /**
   * Always `not_checked`, and it is a field rather than a comment so the page cannot
   * quietly stop saying it. Nothing in a connection test can tell a customer their own
   * automation reports enquiries to us.
   */
  readonly workflowVerification: 'not_checked';
  readonly status: ConnectionStatus;
  /** ISO instant the check ran. Rendered as "last checked". */
  readonly checkedAt: string;
  /** Plain language, from the connector, about what was found. */
  readonly summary: string;
  /** Something the customer can do, or null when there is nothing useful to say. */
  readonly nextStep: string | null;
  /**
   * True when the stored credential was left exactly as it was.
   *
   * A provider being unreachable is our problem or theirs, never evidence that the
   * customer's key is bad, so an outage must not cost them a re-paste. This says so out
   * loud on the page.
   */
  readonly credentialsPreserved: boolean;
  /** Set when the check could not be run at all, rather than run and failed. */
  readonly blockedReason: string | null;
}

/**
 * What a test verification will cost, said before the customer starts one.
 *
 * It costs exactly one run from the monthly allowance, because it is admitted through the
 * same path a real enquiry is. That is not an oversight: a free side-door would be a
 * different code path, and a result from a different path would not tell the customer
 * anything about the one their automation will use.
 */
export interface TestVerificationOffer {
  /** False when something would refuse it; `reason` then says what. */
  readonly canStart: boolean;
  readonly reason: string | null;
  /** Always true today, and a field so the page cannot stop saying it. */
  readonly consumesAllowance: boolean;
  readonly runsRemaining: number;
  readonly runsIncluded: number;
  /** The correlation property the workflow is configured to match on, for the form's hint. */
  readonly correlationProperty: string;
}

/**
 * The four values a customer supplies, which are exactly the four the real source-event
 * schema carries. The form is a guided way of writing one, not a new shape.
 */
export interface TestVerificationInput {
  /** A CRM record that ALREADY EXISTS. We never create one. */
  readonly crmRecordId: string;
  /** The provider's own id for an acknowledgement message that was already sent. */
  readonly messageId: string;
  readonly expectedRecipient: string;
  readonly correlationValue: string;
  /**
   * Identity of the SUBMISSION, minted when the form rendered.
   *
   * A double-click, a browser back-and-resubmit and a refresh all present the same value,
   * and must therefore reuse the same run rather than buy a second one. "Run another
   * verification" loads a fresh form and so carries a fresh identity, which is a new run
   * and is disclosed as costing one before it is pressed.
   */
  readonly submissionId?: string;
}

export interface TestVerificationResult {
  readonly ok: boolean;
  /** Where the customer can watch it resolve. Null when nothing was started. */
  readonly runId: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly message: string;
  /** True when this returned a run an earlier submission already started, unpaid-for twice. */
  readonly duplicate?: boolean;
}

/**
 * A search for something to name in a test verification.
 *
 * `page` is 1-based and carried by the form, so it only bounds a reader who does not edit
 * the form. The bounds that hold regardless are server-side: HubSpot's cursor is an offset
 * capped in the connector, following any cursor spends a separate per-window allowance of
 * `LOOKUP_MAX_PAGES - 1` continuations, and every lookup spends the per-window rate limit.
 * An admin can therefore read further back over time, through their own key, but never
 * more than a few pages at a time and never without end in one sitting.
 */
export interface LookupRequest {
  readonly query: string;
  readonly cursor: string | null;
  readonly page: number;
}

/** Pages a single lookup may be followed through before the customer is asked to narrow it. */
export const LOOKUP_MAX_PAGES = 5;

export interface RecordCandidateView {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly createdAt: string | null;
}

export interface MessageCandidateView {
  readonly id: string;
  readonly to: readonly string[];
  readonly subject: string | null;
  readonly sentAt: string | null;
  /** What Resend last reported for it. A hint for choosing, never a verdict. */
  readonly lastEvent: string | null;
}

/**
 * What a lookup found, or why it found nothing.
 *
 * ## The rule this shape exists to keep
 *
 * Choosing a candidate fills the record id or the message id, and NOTHING ELSE. The expected
 * correlation value and the intended recipient stay the customer's own statement of what
 * should be true. They are never taken from the record or message on screen: a check that
 * compares an observed value with itself proves nothing, and reporting that as a pass is the
 * exact failure this product exists to refuse. So a candidate carries what a person needs to
 * RECOGNISE it, and there is deliberately no field here that could be copied into an
 * expectation by the page.
 *
 * `state`:
 *  - `results`: the provider answered. `items` may be empty; that is an answer, and the page
 *    says so rather than choosing anything.
 *  - `refused`: we did not ask the provider (signed out, viewer, no connection, rate limit).
 *  - `failed`: we asked and did not get an answer we can use. Manual entry stays open.
 * Neither of the last two ever spends a run; neither does the first.
 */
export interface LookupView<T> {
  readonly state: 'results' | 'refused' | 'failed';
  readonly providerName: string;
  readonly query: string;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  /** 1-based page this view shows. */
  readonly page: number;
  /** True when more exist but the paging cap has been reached: narrow the search. */
  readonly pageLimitReached: boolean;
  /** How many the provider returned before a local filter, where one was applied. */
  readonly examined: number;
  /** Explanation for `refused` and `failed`, and for an empty `results`. */
  readonly message: string | null;
}

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

  /**
   * Re-check a stored connection against the provider, now, on the customer's request.
   *
   * `revalidateConnection` has existed in `@verify/connectors` since the connector work and
   * was called from nowhere: exported, tested, unreachable. That is this codebase's own
   * named defect pattern, and the customer-visible cost of it was that a connection could
   * rot (a revoked token, a swapped portal) with no way for anybody to find out until a run
   * failed. This is the reachable end of it.
   */
  testConnection?(provider: ProviderKey): Promise<ConnectionTestResult>;

  workflow(): Promise<WorkflowDetail | null>;
  workflows(): Promise<readonly WorkflowSummary[]>;
  saveFieldMapping(input: FieldMappingInput): Promise<WriteResult>;
  saveExpectedOutcome(input: ExpectedOutcomeInput): Promise<WriteResult>;

  /**
   * Pause or resume NEW automatic admissions for this workflow.
   *
   * Narrow on purpose: runs already admitted keep their reservation and still reach a
   * verdict. The page has to say so, because "paused" reads to most people as
   * "everything stops".
   */
  setAdmissionsPaused?(paused: boolean): Promise<WriteResult>;

  /**
   * A ceiling on admissions for the current billing period, below the plan allowance.
   * `null` removes it. A safety catch the customer owns; never a way to buy more.
   */
  setAdmissionLimit?(limit: number | null): Promise<WriteResult>;

  /** Run the configured rules against synthetic evidence, so the customer sees a result first. */
  runProof(): Promise<ProofRunView>;

  /**
   * What a test verification would cost and whether it can be started, asked before the
   * customer commits to one.
   *
   * Separate from starting it for the same reason the billing portal's availability is
   * separate from opening it: a page that has to DO the thing to find out whether it can
   * spends the customer's allowance to render a button.
   */
  testVerificationOffer(): Promise<TestVerificationOffer>;

  /**
   * Start a test verification from four values the customer supplies.
   *
   * It goes through the SAME admission path a real signed event takes and is decided by
   * the same evaluator against the same provider evidence. That is the whole point: a
   * parallel "test mode" that simulated a result would prove nothing about the pipeline
   * the customer is buying, and a green tick from it would be exactly the kind of claim
   * this product exists to refuse.
   */
  startTestVerification?(input: TestVerificationInput): Promise<TestVerificationResult>;

  /**
   * Find a HubSpot contact to name in a test verification.
   *
   * Free: it touches no allowance, admits nothing and writes no run. It fills an
   * IDENTIFIER and nothing else; see `LookupView`.
   */
  lookupRecords?(request: LookupRequest): Promise<LookupView<RecordCandidateView>>;

  /** Find a message Resend already sent, to name in a test verification. Free, as above. */
  lookupMessages?(request: LookupRequest): Promise<LookupView<MessageCandidateView>>;

  orderSummary(): Promise<OrderSummaryView>;
  /** Create a Stripe Checkout session. The price is resolved server-side, never posted. */
  createCheckout(): Promise<WriteResult>;
  activation(): Promise<ActivationView>;
  /**
   * Issue the workflow's signing key, or rotate it if one exists.
   *
   * Rotation is a new `signing_key_ref`, not an edit: the old key stops being accepted on
   * the very next request. Only a workspace admin may call this. An implementation must
   * refuse with `unconfigured` when the deployment has no root key — never derive from an
   * empty string, never throw into a 500, never report success.
   */
  issueSigningKey(): Promise<SigningKeyIssueResult>;

  /* results */
  listRuns(options: {
    readonly cursor?: string;
    readonly limit: number;
    readonly source?: 'real' | 'test';
  }): Promise<RunPage>;
  run(runId: string): Promise<RunDetailView | null>;

  /* usage and billing */
  usage(): Promise<UsageView>;
  /** A link into the Stripe Billing Portal, or why there is not one yet. */
  /**
   * Whether the billing portal COULD be opened for this reader, and why not if it could not.
   *
   * Asks Stripe nothing. It answers from what we already hold: a session, a subscription in
   * this deployment's mode, a billing-customer binding, the secret, and the reader's role.
   *
   * It is separate from `openBillingPortal` because the page that renders the control is a
   * GET, and a Stripe billing-portal session is single-use and short-lived. Creating one to
   * decide whether to draw a button meant every page view burned a session and baked its
   * secret-bearing URL into the HTML, so by the time anybody clicked it had usually been
   * consumed or expired. That is the "expired session" the owner reported.
   */
  billingPortalAvailability(): Promise<{
    readonly canOpen: boolean;
    readonly reason: string | null;
  }>;

  /**
   * Mint a FRESH portal session, now, for one authorised opening.
   *
   * Called only from `POST /app/billing/portal`, never from a render. The returned URL
   * carries a bearer secret: it is handed straight to a 303 and is never logged, stored,
   * counted, or put in a page.
   */
  openBillingPortal(): Promise<{ readonly href: string | null; readonly reason: string | null }>;

  /* support */
  submitSupportRequest(input: SupportRequestInput): Promise<SupportResult>;
}
