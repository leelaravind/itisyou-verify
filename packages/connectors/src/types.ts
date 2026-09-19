/**
 * The one connector interface — plan §17.
 *
 * Everything a provider adapter is allowed to do is on this interface, and everything it
 * is allowed to *return* is in `@verify/contracts`. The evaluator (A03) never sees a
 * provider payload; it sees `Evidence` and `EvidenceGap` and nothing else.
 *
 * Three rules this file exists to make structural rather than aspirational:
 *
 *  1. `NOT_FOUND` means the provider **authoritatively answered "there is nothing"**.
 *     A timeout, a 5xx, a rate limit, a dropped connection or an empty page produced by a
 *     *failed* request are never `NOT_FOUND`. Only `NOT_FOUND` can turn a mandatory
 *     UNKNOWN into FAILED at the deadline, so mislabelling here manufactures a false
 *     accusation against a customer's automation.
 *  2. Every piece of evidence carries a `provider_account_id`. A customer-supplied record
 *     id is a *locator*; the account the record actually lives in is the *fact*.
 *  3. `origin` is set honestly. `provider_readback` means we asked the API ourselves;
 *     `provider_webhook` means we verified a signature over raw bytes; `customer_claim`
 *     means the customer told us, which can never support a mandatory assertion.
 *
 * No connector performs a write against a customer system. That is enforced by the shape
 * of this interface — there is no method that could — and, in each adapter, by a
 * request-construction layer that physically cannot emit a mutating request.
 */
import type {
  ConnectorErrorCode,
  CrmRecordEvidence,
  EmailEventEvidence,
  Evidence,
  EvidenceBundle,
  EvidenceGap,
  EvidenceOrigin,
} from '@verify/contracts';

/** Providers with an adapter in v1. Stripe is billing-only and has no evidence adapter. */
export const SUPPORTED_PROVIDERS = ['hubspot', 'resend'] as const;
export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number];

export type EvidenceKind = Evidence['kind'];

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a connector can and cannot prove, stated in machine-readable form so the UI (A05)
 * and the health panel (A07) can render the limits instead of implying capabilities we do
 * not have. Every `false` here is a promise we are refusing to make.
 */
export interface ConnectorCapabilities {
  readonly provider: ProviderId;
  /** Evidence kinds this connector can produce at all. */
  readonly evidence_kinds: readonly EvidenceKind[];
  /** Origins this connector can legitimately stamp on evidence. */
  readonly origins: readonly EvidenceOrigin[];
  /** Can retrieve a single record/message by a known provider id. */
  readonly can_read_by_id: boolean;
  /** Can search for a record by the workspace's correlation property. */
  readonly can_search_by_correlation: boolean;
  /**
   * Can distinguish "a matching record exists" from "a record was **created** for this
   * enquiry", because the provider returns a trustworthy creation timestamp.
   */
  readonly can_prove_record_created_in_window: boolean;
  /**
   * Can bind evidence to a provider-published account identifier. False means the account
   * id we attach is derived from the credential we hold, not published by the provider —
   * weaker, and it must be said out loud rather than implied.
   */
  readonly can_prove_account_identity: boolean;
  /** Can verify a signed callback from this provider over raw request bytes. */
  readonly can_verify_webhooks: boolean;
  /**
   * Can create/verify the webhook endpoint through the provider's API. When false the
   * customer must configure it by hand and `validateConnection` returns setup steps.
   */
  readonly can_provision_webhooks: boolean;
  /**
   * Always `false`, as a type. A connector that could write to a customer system would
   * not type-check against this interface.
   */
  readonly writes_to_customer_system: false;
  /** The exact provider scopes/permissions the customer must grant. */
  readonly required_scopes: readonly string[];
  /** Plain-language limits, rendered verbatim by A05. Never marketing copy. */
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// Connection configuration
// ---------------------------------------------------------------------------

/**
 * The decrypted credential material for one connection, handed in per call.
 *
 * Connectors never read a binding, a database row or an environment variable. They are
 * given exactly what they need and they never hold it beyond the call. Every string in
 * here is registered with the redactor before any request is made, so it cannot reach an
 * error message even by accident.
 */
export interface ConnectorCredentials {
  /** Provider API token. HubSpot: `pat-...`. Resend: `re_...`. */
  readonly accessToken: string;
  /** Webhook signing secret, when the provider signs callbacks. Resend: `whsec_...`. */
  readonly webhookSecret?: string | undefined;
}

/**
 * Non-secret connection settings. `account_id` is established by `validateConnection`
 * against the live credential and then stored; it is what the evaluator compares
 * evidence against.
 */
export interface ConnectionConfig {
  readonly provider: ProviderId;
  /**
   * The provider account this connection is believed to belong to, as established at
   * setup. `null` means setup never completed — `fetchEvidence` will then resolve it
   * live, at the cost of one extra external call.
   */
  readonly account_id: string | null;
  /** CRM property carrying our correlation id. Mirrors `WorkflowRules.crm_correlation_property`. */
  readonly correlation_property?: string | undefined;
  /**
   * Re-resolve the account identity on every observation instead of trusting the stored
   * value. Costs one extra call; used by connection-health checks (A07).
   */
  readonly reverify_account?: boolean | undefined;
  /**
   * When a correctly signed provider callback was last received and understood, for
   * providers whose evidence arrives that way.
   *
   * `null` or absent means we have never seen one. A stored signing secret is a promise
   * that a webhook *will* work; this field is the record that one actually did. Nothing
   * but `markWebhookVerified` should ever produce a value for it.
   */
  readonly webhook_verified_at?: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A provider failure, already mapped onto the frozen vocabulary.
 *
 * `retryable` is derived from the code and never set independently, so a connector cannot
 * mark a `PERMISSION_MISSING` retryable and burn the run's budget on a problem only the
 * customer can fix.
 */
export interface ClassifiedError {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  /** Safe to log and to store. Contains no credential, no header and no request body. */
  readonly detail: string;
  /** Seconds the provider asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | null;
}

/** What `classifyError` is given. Deliberately not a `Response` — bodies must be bounded first. */
export interface ProviderErrorInput {
  /** HTTP status, or `null` when the request never produced one (timeout, DNS, guard). */
  readonly status: number | null;
  /** Response headers, when there was a response. */
  readonly headers?: Headers | null | undefined;
  /** Bounded response body text, when there was one. */
  readonly bodyText?: string | null | undefined;
  /** A thrown transport error, when the request failed before a response. */
  readonly cause?: unknown;
  /** Injected clock, used only to turn an HTTP-date `Retry-After` into a delta. */
  readonly now?: Date | undefined;
}

// ---------------------------------------------------------------------------
// Connection validation
// ---------------------------------------------------------------------------

/**
 * One thing the customer has to do by hand, because the provider does not expose it to
 * us. A05 renders these; we do not pretend every provider setting is editable through
 * our app.
 */
export interface ConnectionSetupStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Provider documentation the customer can check for themselves. */
  readonly doc_url: string;
  /** True when we can confirm completion; false when we can only ask and trust. */
  readonly verifiable_by_us: boolean;
}

export interface ConnectionValidation {
  /** True only when the credential worked *and* nothing is left for the customer to do. */
  readonly ok: boolean;
  /** The provider account the credential actually belongs to, when we could establish it. */
  readonly account_id: string | null;
  /** Scopes the provider reported, when it reports them. */
  readonly granted_scopes: readonly string[];
  /** Capabilities that are unavailable on this particular connection. */
  readonly missing_capabilities: readonly string[];
  /** Outstanding manual steps. Non-empty means the connection is incomplete. */
  readonly setup_steps: readonly ConnectionSetupStep[];
  /** Why it failed, when it failed. */
  readonly error: ClassifiedError | null;
  readonly checked_at: string;
  /** External calls this validation actually made. */
  readonly calls_made: number;
}

// ---------------------------------------------------------------------------
// Evidence retrieval
// ---------------------------------------------------------------------------

export interface FetchEvidenceInput {
  readonly credentials: ConnectorCredentials;
  readonly connection: ConnectionConfig;
  /**
   * What the customer told us. A locator, never a fact. Anything in here may be wrong,
   * stale or hostile, and nothing in here is ever used as a URL.
   */
  readonly locator: EvidenceLocator;
  /** The business event's own timestamp. */
  readonly occurredAt: Date;
  /** Wall clock, injected so a run replays identically. */
  readonly now: Date;
  /** CRM properties the workflow's rules actually reference. Nothing else is requested. */
  readonly requiredProperties?: readonly string[] | undefined;
  /** Transport retries already spent inside this observation. */
  readonly attemptsUsed?: number | undefined;
}

export interface EvidenceLocator {
  /** Provider record id supplied by the customer's automation, if any. */
  readonly record_id?: string | undefined;
  /** Our correlation id, expected to appear in the CRM correlation property. */
  readonly correlation_value?: string | undefined;
  /** Provider message id for the acknowledgement email, if any. */
  readonly message_id?: string | undefined;
  /** Recipient address the acknowledgement should have gone to. */
  readonly recipient?: string | undefined;
}

export interface ConnectorFetchResult {
  readonly provider: ProviderId;
  /** The account identity used to stamp the evidence. Null only when we could not establish one. */
  readonly provider_account_id: string | null;
  readonly evidence: readonly Evidence[];
  readonly gaps: readonly EvidenceGap[];
  /** External HTTP calls actually made, for the per-run ceiling accounting. */
  readonly calls_made: number;
}

/** What `normaliseEvidence` is handed: a decoded provider payload plus the context to stamp it. */
export interface NormaliseContext {
  readonly provider_account_id: string;
  readonly origin: EvidenceOrigin;
  readonly observedAt: Date;
  readonly correlationProperty?: string | undefined;
  readonly correlationValue?: string | undefined;
}

export type NormaliseResult<E extends Evidence = Evidence> =
  | { readonly ok: true; readonly evidence: E }
  | { readonly ok: false; readonly gap: EvidenceGap };

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookVerificationInput {
  /**
   * The **raw request bytes**, exactly as received. Never a re-serialised object: JSON
   * round-tripping changes byte order and whitespace, and a signature computed over the
   * re-serialised form would verify a document the provider never sent.
   */
  readonly rawBody: Uint8Array;
  readonly headers: Headers;
  readonly secret: string;
  readonly now: Date;
  /** The connection this callback is claimed to belong to. */
  readonly connection: ConnectionConfig;
  /**
   * Provider event ids already stored for this connection. A correctly signed message
   * replayed by an attacker who captured it is still correctly signed; only the id ledger
   * can reject it. Supplied by the webhook route from the `webhooks` table (A02).
   */
  readonly seenEventIds?: ReadonlySet<string> | undefined;
}

export type WebhookVerification =
  | {
      readonly valid: true;
      /** Evidence derived from the verified payload, stamped `provider_webhook`. */
      readonly evidence: readonly Evidence[];
      readonly gaps: readonly EvidenceGap[];
      /** Provider event id, for idempotent storage and replay rejection. */
      readonly event_id: string | null;
      readonly event_type: string | null;
    }
  | {
      readonly valid: false;
      /** A machine reason. Never echoed to the caller of the webhook route. */
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

export interface RevokeResult {
  /** True when the local credential is gone and will not be used again. */
  readonly local_credential_cleared: boolean;
  /**
   * True only when the provider itself confirmed revocation. False means the customer
   * must delete the key in the provider's dashboard, and we say so rather than implying
   * we did it.
   */
  readonly provider_revoked: boolean;
  readonly manual_steps: readonly ConnectionSetupStep[];
  readonly calls_made: number;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Connector {
  readonly provider: ProviderId;
  capabilities(): ConnectorCapabilities;
  validateConnection(input: {
    readonly credentials: ConnectorCredentials;
    readonly connection: ConnectionConfig;
    readonly now: Date;
  }): Promise<ConnectionValidation>;
  fetchEvidence(input: FetchEvidenceInput): Promise<ConnectorFetchResult>;
  normaliseEvidence(raw: unknown, ctx: NormaliseContext): NormaliseResult;
  classifyError(input: ProviderErrorInput): ClassifiedError;
  revokeOrDisconnect(input: {
    readonly credentials: ConnectorCredentials;
    readonly connection: ConnectionConfig;
    readonly now: Date;
  }): Promise<RevokeResult>;
}

/** A connector that also receives signed callbacks. */
export interface WebhookCapableConnector extends Connector {
  verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerification>;
}

export function isWebhookCapable(c: Connector): c is WebhookCapableConnector {
  return typeof (c as Partial<WebhookCapableConnector>).verifyWebhook === 'function';
}

// ---------------------------------------------------------------------------
// Gap helpers — the highest-consequence code in this package
// ---------------------------------------------------------------------------

/**
 * Build a gap. `retryable` is derived from the code, never passed in.
 *
 * `NOT_FOUND` is deliberately *not* retryable and deliberately *not* terminal: A03's
 * scheduler treats it as "keep looking until the deadline, then let the evaluator decide",
 * which is the only correct behaviour for an authoritative absence inside an open window.
 */
export function makeGap(
  source: EvidenceGap['source'],
  code: ConnectorErrorCode,
  detail: string,
): EvidenceGap {
  return {
    source,
    code,
    retryable: code === 'RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE',
    detail,
  };
}

/**
 * The only sanctioned way to produce a `NOT_FOUND` gap.
 *
 * It takes proof-of-authority as an argument rather than a boolean the caller can shrug
 * at: you must hand it the successful provider response that established the absence. A
 * request that failed has no `status`, so it cannot reach this function, and a caller who
 * tries to fabricate one has to write a lie that a reviewer can see.
 */
export function makeAuthoritativeAbsenceGap(
  source: EvidenceGap['source'],
  proof: { readonly status: number; readonly detail: string },
): EvidenceGap {
  if (proof.status < 200 || proof.status >= 300) {
    // A non-2xx response is not an authoritative answer about existence. Refuse, loudly,
    // rather than downgrade to something that might read as a failure at the deadline.
    return makeGap(source, 'PROVIDER_UNAVAILABLE', `absence claimed from status ${proof.status}; refused`);
  }
  return makeGap(source, 'NOT_FOUND', proof.detail);
}

/** Merge connector results into the single bundle the evaluator consumes. */
export function toEvidenceBundle(results: readonly ConnectorFetchResult[]): EvidenceBundle {
  let crm: CrmRecordEvidence | null = null;
  const emailEvents: EmailEventEvidence[] = [];
  const gaps: EvidenceGap[] = [];
  for (const result of results) {
    for (const item of result.evidence) {
      if (item.kind === 'crm_record') {
        // First CRM record wins; a connector that found two emits AMBIGUOUS_MATCH instead
        // of returning both, so this branch never silently picks between candidates.
        if (crm === null) crm = item;
      } else {
        emailEvents.push(item);
      }
    }
    gaps.push(...result.gaps);
  }
  emailEvents.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
  return { crm, email_events: emailEvents, gaps };
}

/** Total external calls a set of results caused. Used by the budget assertions. */
export function totalCalls(results: readonly ConnectorFetchResult[]): number {
  return results.reduce((sum, r) => sum + r.calls_made, 0);
}
