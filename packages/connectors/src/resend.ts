/**
 * Resend email connector — delivery evidence.
 *
 * Verified against Resend's documentation on 2026-09-19; sources are recorded in
 * `docs/connectors.md`.
 *
 *   - Base `https://api.resend.com`, `Authorization: Bearer re_...`, default rate limit
 *     **10 requests per second per team**, and a missing `User-Agent` produces error
 *     `1010` / 403 — which is why `http.ts` always sends one.
 *     https://resend.com/docs/api-reference/introduction
 *   - `GET /emails/{id}` returns `{object, id, message_id, to, from, created_at, subject,
 *     html, text, bcc, cc, reply_to, last_event, scheduled_at, tags}`.
 *     https://resend.com/docs/api-reference/emails/retrieve-email
 *   - `GET /domains` returns `{object, has_more, data[]}`; used only as a liveness and
 *     permission probe at setup. https://resend.com/docs/api-reference/domains/list-domains
 *   - Webhook events: `email.sent`, `email.delivered`, `email.delivery_delayed`,
 *     `email.bounced`, `email.failed`, `email.opened`, `email.clicked`,
 *     `email.complained`, `email.suppressed`, `email.scheduled`, `email.received`, plus
 *     `domain.*`, `contact.*` and `suppression.*`.
 *     https://resend.com/docs/dashboard/webhooks/event-types
 *   - Payload: `{type, created_at, data:{email_id, message_id, from, to[], subject,
 *     created_at, broadcast_id?, template_id?, tags?, bounce?}}`.
 *     https://resend.com/docs/webhooks/emails/delivered and .../bounced
 *   - Signing is Svix: headers `svix-id`, `svix-timestamp`, `svix-signature`, secret
 *     `whsec_` + base64, signed content `${id}.${timestamp}.${body}`, HMAC-SHA-256
 *     base64, header entries space-delimited and version-prefixed `v1,`.
 *     https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 *     https://docs.svix.com/receiving/verifying-payloads/how-manual
 *   - API key permissions are **`full_access` or `sending_access` only**. There is no
 *     read-only permission. https://resend.com/docs/api-reference/api-keys/create-api-key
 *
 * Two things this connector refuses to pretend:
 *
 *  1. `email.sent` means Resend accepted the message. It is `accepted`, never `delivered`.
 *     `opened` and `clicked` are tracking-pixel and link-redirect artefacts; they are
 *     recorded, and they prove nothing about a human reading anything.
 *  2. Resend's retrieve endpoint publishes `last_event` but not *when* that event
 *     happened. Readback evidence therefore carries the message's creation time as its
 *     `occurred_at`. Webhook evidence carries the event's own instant and is the only
 *     source that can support a rule about *when* delivery happened.
 */
import { readSvixHeaders, sha256Hex, verifySvixSignature } from '@verify/security';
import type { ConnectorErrorCode, EmailEventEvidence, EmailStatus, EvidenceGap } from '@verify/contracts';
import {
  ConnectorTransportError,
  guardedFetch,
  parseJsonBody,
  pathSegment,
  providerUrl,
  readRetryAfterSeconds,
  type GuardedResponse,
  type SafeMethod,
} from './http.js';
import { withTransportRetry } from './retry.js';
import {
  makeGap,
  type ClassifiedError,
  type ConnectionConfig,
  type ConnectionSetupStep,
  type ConnectionValidation,
  type ConnectorCapabilities,
  type ConnectorCredentials,
  type ConnectorFetchResult,
  type FetchEvidenceInput,
  type NormaliseContext,
  type NormaliseResult,
  type ProviderErrorInput,
  type RevokeResult,
  type WebhookCapableConnector,
  type WebhookVerification,
  type WebhookVerificationInput,
} from './types.js';

export const RESEND_PROVIDER = 'resend';
/** Svix's recommended tolerance, matching `@verify/security`'s default. */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Provider event type to the frozen `EmailStatus` ladder.
 *
 * Every mapping here is a judgement about what the provider actually proved:
 *
 *  - `email.sent` — "API request was successful". Resend took it. `accepted`.
 *  - `email.delivered` — "successfully delivered the email to the recipient's mail
 *    server". That, and only that, is `delivered`.
 *  - `email.delivery_delayed` — a temporary problem. `deferred`: not yet delivered, not
 *    a contradiction either.
 *  - `email.bounced` — permanently rejected. Contradicts delivery.
 *  - `email.complained` — delivered, then marked as spam. The contract treats it as
 *    delivery-contradicting; that is A03's call and we honour it.
 *  - `email.failed` — never sent.
 *  - `email.suppressed` — Resend refused to send it because the address is suppressed.
 *    The recipient's server never saw it, so this is `failed`, not `queued`.
 *  - `email.scheduled` — accepted for later sending. `queued`.
 *  - `email.opened` / `email.clicked` — tracking artefacts. Recorded, never treated as
 *    proof of delivery or of reading.
 *
 * `email.received` (inbound mail) and the `domain.*`, `contact.*`, `suppression.*`
 * families are deliberately absent: they are not outbound-delivery evidence, and forcing
 * them onto this ladder would invent a fact.
 */
export const RESEND_EVENT_STATUS: Readonly<Record<string, EmailStatus>> = Object.freeze({
  'email.sent': 'accepted',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'deferred',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'failed',
  'email.scheduled': 'queued',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
});

/** `last_event` on a retrieved email uses the bare form of the same vocabulary. */
export const RESEND_LAST_EVENT_STATUS: Readonly<Record<string, EmailStatus>> = Object.freeze({
  sent: 'accepted',
  delivered: 'delivered',
  delivery_delayed: 'deferred',
  bounced: 'bounced',
  complained: 'complained',
  failed: 'failed',
  suppressed: 'failed',
  scheduled: 'queued',
  queued: 'queued',
  opened: 'opened',
  clicked: 'clicked',
  canceled: 'failed',
  cancelled: 'failed',
});

/**
 * Map a provider event name to our ladder, or `null` when we do not recognise it.
 *
 * `null` is the important return value. Resend can ship a new event type tomorrow, and the
 * only two wrong answers are to crash and to guess — guessing towards `delivered` would
 * manufacture a VERIFIED out of an event nobody has read the definition of.
 */
export function mapResendEventType(eventType: unknown): EmailStatus | null {
  if (typeof eventType !== 'string') return null;
  const key = eventType.trim().toLowerCase();
  const direct = RESEND_EVENT_STATUS[key];
  if (direct !== undefined) return direct;
  if (key.startsWith('email.')) {
    const bare = RESEND_LAST_EVENT_STATUS[key.slice('email.'.length)];
    if (bare !== undefined) return bare;
  }
  return null;
}

export function mapResendLastEvent(lastEvent: unknown): EmailStatus | null {
  if (typeof lastEvent !== 'string') return null;
  const key = lastEvent.trim().toLowerCase();
  return RESEND_LAST_EVENT_STATUS[key] ?? mapResendEventType(key);
}

// ---------------------------------------------------------------------------
// Request layer
// ---------------------------------------------------------------------------

/**
 * Every request this connector can make. Both are reads.
 *
 * `POST /emails` — the send endpoint — is not here, is not imported, and cannot be
 * constructed: `resendCall` builds its URL from this table alone. The verification
 * service does not send mail on a customer's behalf, and nothing in this file could.
 */
const RESEND_OPERATIONS = Object.freeze({
  retrieve_email: Object.freeze({ method: 'GET' as SafeMethod, path: '/emails/' }),
  list_domains: Object.freeze({ method: 'GET' as SafeMethod, path: '/domains' }),
});
type ResendOperation = keyof typeof RESEND_OPERATIONS;

export interface ResendFetchOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly jitterSeed?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly toleranceSeconds?: number | undefined;
}

function resendCall(
  operation: ResendOperation,
  token: string,
  segment: string | undefined,
  options: ResendFetchOptions,
): Promise<GuardedResponse> {
  const op = RESEND_OPERATIONS[operation];
  if (op === undefined) throw new ConnectorTransportError('blocked_url', 'unknown resend operation');
  const path = segment === undefined ? op.path : `${op.path}${pathSegment(segment)}`;
  return guardedFetch({
    url: providerUrl(RESEND_PROVIDER, path),
    method: op.method,
    headers: { authorization: `Bearer ${token}` },
    secrets: [token],
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const RETRYABLE: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
]);

function classified(
  code: ConnectorErrorCode,
  detail: string,
  retryAfterSeconds: number | null = null,
): ClassifiedError {
  return { code, retryable: RETRYABLE.has(code), detail, retryAfterSeconds };
}

/** Resend's error envelope is `{statusCode, name, message}`. */
function resendErrorName(bodyText: string | null | undefined): { name: string; message: string } {
  if (typeof bodyText !== 'string' || bodyText.trim() === '') return { name: '', message: '' };
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return { name: '', message: bodyText.slice(0, 120) };
  }
  const body = parsed.value as Record<string, unknown>;
  return {
    name: typeof body['name'] === 'string' ? body['name'] : '',
    message: typeof body['message'] === 'string' ? body['message'].slice(0, 160) : '',
  };
}

export function classifyResendError(input: ProviderErrorInput): ClassifiedError {
  if (input.status === null) {
    const cause = input.cause;
    if (cause instanceof ConnectorTransportError) {
      switch (cause.reason) {
        case 'timeout':
          return classified('PROVIDER_UNAVAILABLE', `timeout: ${cause.detail}`);
        case 'response_too_large':
          return classified('PROVIDER_UNAVAILABLE', `oversized response: ${cause.detail}`);
        case 'blocked_url':
        case 'blocked_redirect':
        case 'missing_location':
        case 'too_many_redirects':
          return classified('PROVIDER_UNAVAILABLE', `refused by the outbound guard: ${cause.reason}`);
        case 'network':
        case 'invalid_response':
        default:
          return classified('PROVIDER_UNAVAILABLE', `transport: ${cause.reason}`);
      }
    }
    return classified('PROVIDER_UNAVAILABLE', 'the request did not produce a response');
  }

  const { name, message } = resendErrorName(input.bodyText);
  const detail = [name, message].filter((part) => part !== '').join(': ');
  const retryAfter = readRetryAfterSeconds(input.headers ?? null, input.now ?? new Date());

  if (input.status === 401) {
    // `restricted_api_key` at 401 means the key can only send. That is a permission
    // problem the customer must fix, not an expired credential.
    if (name === 'restricted_api_key' || name === 'invalid_permission') {
      return classified('PERMISSION_MISSING', detail === '' ? 'the API key may only send email' : detail);
    }
    return classified('AUTH_EXPIRED', detail === '' ? 'API key rejected (401)' : detail);
  }
  if (input.status === 403) {
    return classified('PERMISSION_MISSING', detail === '' ? 'forbidden (403)' : detail);
  }
  if (input.status === 429) {
    return classified('RATE_LIMITED', detail === '' ? 'rate limited (429)' : detail, retryAfter);
  }
  if (input.status === 404) {
    return classified('NOT_FOUND', detail === '' ? 'not found (404)' : detail);
  }
  if (input.status === 400 || input.status === 422) {
    return classified('UNSUPPORTED_CAPABILITY', detail === '' ? `rejected request (${input.status})` : detail);
  }
  if (input.status >= 500 || input.status === 408 || input.status === 409) {
    return classified('PROVIDER_UNAVAILABLE', detail === '' ? `provider error (${input.status})` : detail, retryAfter);
  }
  if (input.status >= 200 && input.status < 300) {
    return classified('PROVIDER_UNAVAILABLE', detail === '' ? 'unusable 200 response' : detail);
  }
  return classified('PROVIDER_UNAVAILABLE', detail === '' ? `unexpected status ${input.status}` : detail);
}

// ---------------------------------------------------------------------------
// Account identity
// ---------------------------------------------------------------------------

/**
 * Resend publishes no team or account identifier through its API, so there is no
 * provider-sourced account id to attach to evidence.
 *
 * Rather than invent one or leave the field blank, we attach a stable fingerprint of the
 * credential the evidence was retrieved with. That is a real, checkable identity — if the
 * key is swapped, the fingerprint changes and the evaluator sees a different account — but
 * it is *weaker* than HubSpot's `hubId`, and `capabilities().can_prove_account_identity`
 * is `false` to say so out loud rather than let the UI imply parity.
 */
export async function resendAccountFingerprint(token: string): Promise<string> {
  const digest = await sha256Hex(`verify.resend.account.v1:${token}`);
  return `resend-key-${digest.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function firstRecipient(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') return item.trim();
    }
  }
  return null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  // Resend emits both RFC 3339 (`2026-02-22T23:41:12.126Z`) and a Postgres-ish form
  // (`2026-04-03 22:13:42.674981+00`). The second needs two fixes before any runtime will
  // parse it: the space becomes `T`, and a bare two-digit offset becomes `+HH:00`.
  // Normalising a valid timestamp is right; rejecting one because of its punctuation would
  // discard real evidence.
  const text =
    typeof value === 'number'
      ? value
      : value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export interface ResendNormaliseInput {
  /** Provider event name, for a webhook. */
  readonly eventType?: string | undefined;
  /** `last_event`, for a readback. */
  readonly lastEvent?: string | undefined;
  readonly messageId: unknown;
  readonly recipient: unknown;
  readonly occurredAt: unknown;
}

/**
 * Build one `EmailEventEvidence`, or a gap explaining precisely why we could not.
 *
 * A payload we do not understand becomes `INVALID_EVIDENCE`, never a status. There is no
 * default branch that falls through to `delivered`, and there is no `catch` that swallows
 * a surprise into a pass.
 */
export function normaliseResendEvent(raw: unknown, ctx: NormaliseContext): NormaliseResult<EmailEventEvidence> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, gap: makeGap('email_event', 'INVALID_EVIDENCE', 'email payload was not an object') };
  }
  const input = raw as Partial<ResendNormaliseInput>;
  const status =
    input.eventType !== undefined ? mapResendEventType(input.eventType) : mapResendLastEvent(input.lastEvent);
  if (status === null) {
    const label = String(input.eventType ?? input.lastEvent ?? 'missing').slice(0, 64);
    return {
      ok: false,
      gap: makeGap(
        'email_event',
        'UNSUPPORTED_CAPABILITY',
        `Resend event "${label}" is not one this version maps to a delivery status`,
      ),
    };
  }
  const messageId =
    typeof input.messageId === 'string' && input.messageId.trim() !== '' ? input.messageId.trim() : null;
  if (messageId === null) {
    return { ok: false, gap: makeGap('email_event', 'INVALID_EVIDENCE', 'email payload carried no message id') };
  }
  const occurredAt = isoOrNull(input.occurredAt);
  if (occurredAt === null) {
    // Without a timestamp we cannot say whether this happened inside the window, and a
    // delivery event outside the window is a different fact from one inside it.
    return { ok: false, gap: makeGap('email_event', 'INVALID_EVIDENCE', 'email payload carried no usable timestamp') };
  }
  const evidence: EmailEventEvidence = {
    kind: 'email_event',
    origin: ctx.origin,
    provider: RESEND_PROVIDER,
    provider_account_id: ctx.provider_account_id,
    message_id: messageId,
    recipient: firstRecipient(input.recipient),
    status,
    occurred_at: occurredAt,
    observed_at: ctx.observedAt.toISOString(),
  };
  return { ok: true, evidence };
}

// ---------------------------------------------------------------------------
// Capabilities and setup
// ---------------------------------------------------------------------------

const RESEND_WEBHOOK_SETUP_STEP: ConnectionSetupStep = Object.freeze({
  id: 'resend_create_webhook_endpoint',
  title: 'Add our webhook endpoint in Resend',
  detail:
    'Resend does not let us create a webhook endpoint for you through its API, so this one is on you. In the Resend dashboard open Webhooks, add an endpoint pointing at the URL we show you, subscribe it to email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained and email.failed, then paste the signing secret (it starts whsec_) back to us. Until a signed callback arrives we will treat this connection as incomplete rather than pretend it is working.',
  doc_url: 'https://resend.com/docs/dashboard/webhooks/introduction',
  verifiable_by_us: true,
});

const RESEND_REVOKE_STEP: ConnectionSetupStep = Object.freeze({
  id: 'resend_delete_api_key',
  title: 'Delete the API key in Resend',
  detail:
    'We have deleted our copy of your API key and will not use it again. Resend does not let a key delete itself, so it stays valid until you remove it in the Resend dashboard under API Keys.',
  doc_url: 'https://resend.com/docs/dashboard/api-keys/introduction',
  verifiable_by_us: false,
});

const RESEND_CAPABILITIES: ConnectorCapabilities = Object.freeze({
  provider: RESEND_PROVIDER,
  evidence_kinds: Object.freeze(['email_event'] as const),
  origins: Object.freeze(['provider_readback', 'provider_webhook'] as const),
  can_read_by_id: true,
  // There is no searchable correlation field on a Resend message. We can only look up a
  // message id the customer's automation gave us, or match a signed webhook.
  can_search_by_correlation: false,
  can_prove_record_created_in_window: false,
  // No team/account identifier is published by the API. See `resendAccountFingerprint`.
  can_prove_account_identity: false,
  can_verify_webhooks: true,
  // Resend's public API has no webhook-endpoint CRUD, so setup is a guided manual step.
  can_provision_webhooks: false,
  writes_to_customer_system: false,
  // Resend offers only `full_access` and `sending_access`. Reading an email requires the
  // former, which is broader than reading needs. Recorded here so the UI cannot soften it.
  required_scopes: Object.freeze(['full_access']),
  limitations: Object.freeze([
    'Resend has no read-only API key. Reading a message needs a full-access key, which can also send and delete. We ask for one only because Resend offers nothing narrower.',
    'Resend does not publish a team or account identifier, so we attribute evidence to a fingerprint of the key it was read with, not to a named Resend account.',
    'A retrieved email tells us its latest status but not when that status was reached. Only a signed webhook carries the event time.',
    'Opens and clicks are tracking artefacts. They never count as proof that a person read anything.',
    'We can only look up a message whose Resend id your automation told us. A message we were never told about is invisible to us.',
    'We cannot create your webhook endpoint for you; Resend has no API for it.',
  ]),
});

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

type ReadOutcome =
  | { readonly kind: 'found'; readonly payload: unknown }
  | { readonly kind: 'absent'; readonly gap: EvidenceGap }
  | { readonly kind: 'error'; readonly error: ClassifiedError };

export class ResendConnector implements WebhookCapableConnector {
  readonly provider = RESEND_PROVIDER;
  private readonly options: ResendFetchOptions;

  constructor(options: ResendFetchOptions = {}) {
    this.options = options;
  }

  capabilities(): ConnectorCapabilities {
    return RESEND_CAPABILITIES;
  }

  classifyError(input: ProviderErrorInput): ClassifiedError {
    return classifyResendError(input);
  }

  normaliseEvidence(raw: unknown, ctx: NormaliseContext): NormaliseResult<EmailEventEvidence> {
    return normaliseResendEvent(raw, ctx);
  }

  /**
   * Check the credential and report what is left to do.
   *
   * A working key is not a working connection: without a signing secret we can never
   * receive an event, so `ok` stays false and the setup step is returned. Marking this
   * connection green would be the single most misleading thing this file could do.
   */
  async validateConnection(input: {
    readonly credentials: ConnectorCredentials;
    readonly connection: ConnectionConfig;
    readonly now: Date;
  }): Promise<ConnectionValidation> {
    const accountId = await resendAccountFingerprint(input.credentials.accessToken);
    let response: GuardedResponse;
    try {
      response = await resendCall('list_domains', input.credentials.accessToken, undefined, this.options);
    } catch (error) {
      return {
        ok: false,
        account_id: null,
        granted_scopes: [],
        missing_capabilities: ['email_event'],
        setup_steps: [],
        error: classifyResendError({ status: null, cause: error, now: input.now }),
        checked_at: input.now.toISOString(),
        calls_made: 1,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      const error = classifyResendError({
        status: response.status,
        headers: response.headers,
        bodyText: response.bodyText,
        now: input.now,
      });
      return {
        ok: false,
        account_id: null,
        granted_scopes: [],
        missing_capabilities: ['email_event'],
        setup_steps:
          error.code === 'PERMISSION_MISSING'
            ? [
                {
                  id: 'resend_use_full_access_key',
                  title: 'Use a full-access Resend API key',
                  detail:
                    'The key you gave us can only send email, so it cannot read anything back. Resend offers no read-only key, so reading delivery evidence needs a full-access key. Create one in the Resend dashboard under API Keys.',
                  doc_url: 'https://resend.com/docs/dashboard/api-keys/introduction',
                  verifiable_by_us: true,
                },
              ]
            : [],
        error,
        checked_at: input.now.toISOString(),
        calls_made: 1,
      };
    }

    const hasSecret =
      typeof input.credentials.webhookSecret === 'string' && input.credentials.webhookSecret.startsWith('whsec_');
    return {
      ok: hasSecret,
      account_id: accountId,
      // Resend does not report a key's permission back to us; we learn it only by being
      // refused. Reporting an empty list is honest, where reporting `['full_access']`
      // would be a guess.
      granted_scopes: [],
      missing_capabilities: hasSecret ? [] : ['provider_webhook'],
      setup_steps: hasSecret ? [] : [RESEND_WEBHOOK_SETUP_STEP],
      error: null,
      checked_at: input.now.toISOString(),
      calls_made: 1,
    };
  }

  /** Read one message back by the id the customer's automation gave us. */
  async fetchEvidence(input: FetchEvidenceInput): Promise<ConnectorFetchResult> {
    const token = input.credentials.accessToken;
    const accountId = input.connection.account_id ?? (await resendAccountFingerprint(token));
    const messageId = input.locator.message_id;

    if (messageId === undefined || messageId === '') {
      return {
        provider: RESEND_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps: [
          makeGap(
            'email_event',
            'INVALID_EVIDENCE',
            'no Resend message id was supplied, and Resend cannot be searched by correlation value',
          ),
        ],
        calls_made: 0,
      };
    }

    const retried = await withTransportRetry<ReadOutcome>({
      now: input.now,
      ...(input.attemptsUsed === undefined ? {} : { attemptsUsed: input.attemptsUsed }),
      ...(this.options.jitterSeed === undefined ? {} : { jitterSeed: this.options.jitterSeed }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      attempt: async () => {
        const outcome = await this.readEmail(token, messageId, input.now);
        if (outcome.kind === 'error') {
          return {
            value: outcome,
            gap: makeGap('email_event', outcome.error.code, outcome.error.detail),
            retryAfterSeconds: outcome.error.retryAfterSeconds,
          };
        }
        return { value: outcome, gap: null };
      },
    });

    const outcome = retried.value;
    const calls = retried.attempts;
    if (outcome.kind === 'error') {
      return {
        provider: RESEND_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps: [makeGap('email_event', outcome.error.code, outcome.error.detail)],
        calls_made: calls,
      };
    }
    if (outcome.kind === 'absent') {
      return {
        provider: RESEND_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps: [outcome.gap],
        calls_made: calls,
      };
    }

    const body = outcome.payload as Record<string, unknown>;
    const normalised = this.normaliseEvidence(
      {
        lastEvent: typeof body['last_event'] === 'string' ? body['last_event'] : undefined,
        messageId: body['id'],
        recipient: body['to'],
        // Deliberate and documented: `created_at` is when the message was created, not
        // when `last_event` happened. Resend publishes no timestamp for the latter.
        occurredAt: body['created_at'],
      },
      {
        provider_account_id: accountId,
        origin: 'provider_readback',
        observedAt: input.now,
      },
    );
    if (!normalised.ok) {
      return {
        provider: RESEND_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps: [normalised.gap],
        calls_made: calls,
      };
    }
    return {
      provider: RESEND_PROVIDER,
      provider_account_id: accountId,
      evidence: [normalised.evidence],
      gaps: [],
      calls_made: calls,
    };
  }

  private async readEmail(token: string, messageId: string, now: Date): Promise<ReadOutcome> {
    let response: GuardedResponse;
    try {
      response = await resendCall('retrieve_email', token, messageId, this.options);
    } catch (error) {
      return { kind: 'error', error: classifyResendError({ status: null, cause: error, now }) };
    }
    if (response.status === 404) {
      // The path is compiled in and covered by tests, so a 404 here is about the id, not
      // the route. Resend has answered that it holds no message with this id for this
      // key: an authoritative absence.
      return {
        kind: 'absent',
        gap: makeGap('email_event', 'NOT_FOUND', 'Resend holds no message with the supplied id for this account'),
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        kind: 'error',
        error: classifyResendError({
          status: response.status,
          headers: response.headers,
          bodyText: response.bodyText,
          now,
        }),
      };
    }
    const parsed = parseJsonBody(response.bodyText);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      return { kind: 'error', error: classified('PROVIDER_UNAVAILABLE', 'retrieve returned 200 with an unusable body') };
    }
    const body = parsed.value as Record<string, unknown>;
    if (typeof body['name'] === 'string' && typeof body['message'] === 'string' && body['id'] === undefined) {
      // A 200 carrying Resend's error envelope. Answered, but not with an answer.
      return {
        kind: 'error',
        error: classifyResendError({ status: response.status, bodyText: response.bodyText, now }),
      };
    }
    return { kind: 'found', payload: body };
  }

  /**
   * Verify a Svix-signed Resend callback over the **raw request bytes**.
   *
   * The bytes are never re-serialised. `JSON.parse` then `JSON.stringify` produces a
   * different document — key order, whitespace, number formatting — and a signature check
   * over that would be checking something Resend never sent. Parsing happens only *after*
   * the signature has been verified, and only for the bytes that were verified.
   */
  async verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerification> {
    const headers = readSvixHeaders(input.headers);
    const result = await verifySvixSignature(
      input.rawBody,
      headers,
      input.secret,
      input.now,
      this.options.toleranceSeconds ?? RESEND_WEBHOOK_TOLERANCE_SECONDS,
    );
    if (!result.valid) return { valid: false, reason: result.reason };

    const eventId = typeof headers.id === 'string' && headers.id !== '' ? headers.id : null;
    if (eventId !== null && input.seenEventIds?.has(eventId) === true) {
      // A replayed message carries a valid signature by definition. Only the id ledger can
      // tell the difference between Resend retrying and someone replaying.
      return { valid: false, reason: 'replayed_event' };
    }

    const decoded = new TextDecoder().decode(input.rawBody);
    const parsed = parseJsonBody(decoded);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      return { valid: false, reason: 'body_not_json' };
    }
    const body = parsed.value as Record<string, unknown>;
    const eventType = typeof body['type'] === 'string' ? body['type'] : null;
    const data =
      typeof body['data'] === 'object' && body['data'] !== null && !Array.isArray(body['data'])
        ? (body['data'] as Record<string, unknown>)
        : {};

    const accountId = input.connection.account_id ?? 'resend-unattributed';
    const normalised = this.normaliseEvidence(
      {
        ...(eventType === null ? {} : { eventType }),
        messageId: data['email_id'],
        recipient: data['to'],
        // The event's own instant, which is what a "delivered within N seconds" rule needs.
        occurredAt: body['created_at'] ?? data['created_at'],
      },
      {
        provider_account_id: accountId,
        // The signature proves Resend sent this, so it is independent evidence — but only
        // of what the payload says, and only for the connection whose secret verified it.
        origin: 'provider_webhook',
        observedAt: input.now,
      },
    );

    if (!normalised.ok) {
      return { valid: true, evidence: [], gaps: [normalised.gap], event_id: eventId, event_type: eventType };
    }
    return { valid: true, evidence: [normalised.evidence], gaps: [], event_id: eventId, event_type: eventType };
  }

  async revokeOrDisconnect(): Promise<RevokeResult> {
    return Promise.resolve({
      local_credential_cleared: true,
      provider_revoked: false,
      manual_steps: [RESEND_REVOKE_STEP],
      calls_made: 0,
    });
  }
}

export const resendConnector = new ResendConnector();
