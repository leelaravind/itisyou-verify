/**
 * HubSpot CRM connector — read-only contact evidence.
 *
 * Verified against HubSpot's documentation on 2026-09-19; every endpoint, scope, header
 * and limit below is recorded with its source URL in `docs/connectors.md`. Nothing here
 * was written from memory.
 *
 *   - Contacts API v3, base `https://api.hubapi.com`.
 *     https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide
 *   - `GET /crm/v3/objects/contacts/{recordId}` with `properties` as a comma-separated
 *     allowlist. Same source.
 *   - `POST /crm/v3/objects/contacts/search`, body `filterGroups[].filters[]` of
 *     `{propertyName, operator, value}`, response `{total, results[], paging.next.after}`,
 *     max 200 per page, max 10,000 results, **rate limited to five requests per second
 *     per account**, and search responses carry no rate-limit headers.
 *     https://developers.hubspot.com/docs/api-reference/legacy/crm/search-the-crm
 *   - Scope `crm.objects.contacts.read`. Same contacts guide.
 *   - Private-app auth: `Authorization: Bearer <token>`, token prefixed `pat-` (`pat-eu-`
 *     in the EU region). https://developers.hubspot.com/docs/guides/apps/private-apps/overview
 *   - Account identity: `POST /oauth/v2/private-apps/get/access-token-info` with body
 *     `{"tokenKey": "<token>"}` returns `{userId, hubId, appId, scopes}`. `hubId` is the
 *     portal id. EU tokens additionally require the `Authorization` header, so we always
 *     send it. Same overview page, plus
 *     https://community.hubspot.com/t5/APIs-Integrations/Private-App-access-token-info-endpoint-error-for-EU-tokens/m-p/719418
 *   - Rate limits, private apps: 100 requests / 10s (Free & Starter), 190 / 10s
 *     (Professional, Enterprise), 250 / 10s with the API Limit Increase add-on; daily
 *     250,000 / 625,000 / 1,000,000 per account. Headers `X-HubSpot-RateLimit-Max`,
 *     `-Remaining`, `-Interval-Milliseconds`, `-Daily`, `-Daily-Remaining`.
 *     https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines
 *
 * **This connector cannot write.** Not "does not" — cannot. Every request it can emit is
 * an entry in `HUBSPOT_OPERATIONS`, a frozen table of three read operations, and
 * `hubspotCall` refuses anything not in it. There is no create, update, delete, merge,
 * archive or batch-write path to disable, because none was written. A reviewer can verify
 * that by reading one twenty-line table.
 */
import type {
  ConnectorErrorCode,
  CrmRecordEvidence,
  EvidenceGap,
  EvidenceTransport,
} from '@verify/contracts';
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
  makeAuthoritativeAbsenceGap,
  makeGap,
  type ClassifiedError,
  type ConnectionConfig,
  type ConnectionSetupStep,
  type ConnectionValidation,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorCredentials,
  type ConnectorFetchResult,
  type ContactCandidate,
  type FetchEvidenceInput,
  type LookupOutcome,
  type NormaliseContext,
  type NormaliseResult,
  type ProviderErrorInput,
  type RevokeResult,
} from './types.js';

export const HUBSPOT_PROVIDER = 'hubspot';
export const HUBSPOT_READ_SCOPE = 'crm.objects.contacts.read';
/** Search page size. Two is all we need: zero, one, or "more than one" is the whole answer. */
export const SEARCH_PROBE_LIMIT = 2;
/** Guard against a workflow asking for an unreasonable slice of a contact record. */
export const MAX_REQUESTED_PROPERTIES = 25;

/**
 * Every request this connector is capable of making. Read operations only.
 *
 * `token_info` and `contact_search` are POSTs because HubSpot models them that way; both
 * are pure reads. There is no table entry that mutates a customer's CRM, and `hubspotCall`
 * cannot construct a request that is not in this table.
 */
export const HUBSPOT_OPERATIONS = Object.freeze({
  token_info: Object.freeze({
    method: 'POST' as SafeMethod,
    path: '/oauth/v2/private-apps/get/access-token-info',
  }),
  contact_by_id: Object.freeze({ method: 'GET' as SafeMethod, path: '/crm/v3/objects/contacts/' }),
  contact_search: Object.freeze({
    method: 'POST' as SafeMethod,
    path: '/crm/v3/objects/contacts/search',
  }),
  // The same read endpoint, listed separately because it is used for a different reason:
  // the customer choosing a contact to test with. Its purpose is stated on its own line on
  // the connections page rather than folded into the evidence search's.
  contact_lookup: Object.freeze({
    method: 'POST' as SafeMethod,
    path: '/crm/v3/objects/contacts/search',
  }),
});
export type HubSpotOperation = keyof typeof HUBSPOT_OPERATIONS;

/** Provider-response shapes we rely on, kept as narrow local guards rather than casts. */
interface HubSpotContact {
  readonly id: string;
  readonly properties: Record<string, string | null>;
  readonly createdAt: string | null;
  readonly archived: boolean;
}

export interface HubSpotFetchOptions {
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injected wait for the retry planner. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly jitterSeed?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
}

// ---------------------------------------------------------------------------
// Request layer
// ---------------------------------------------------------------------------

interface HubSpotCallInput {
  readonly operation: HubSpotOperation;
  readonly token: string;
  /** Customer-supplied path segment, appended to a table path. Percent-encoded here. */
  readonly segment?: string | undefined;
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined;
  readonly body?: unknown;
  readonly options: HubSpotFetchOptions;
}

async function hubspotCall(input: HubSpotCallInput): Promise<GuardedResponse> {
  const op = HUBSPOT_OPERATIONS[input.operation];
  if (op === undefined) {
    // Unreachable through the type system; present so a future edit that widens the union
    // without widening the table fails closed instead of constructing an arbitrary request.
    throw new ConnectorTransportError('blocked_url', `unknown hubspot operation`);
  }
  const path = input.segment === undefined ? op.path : `${op.path}${pathSegment(input.segment)}`;
  const url = providerUrl(HUBSPOT_PROVIDER, path, input.query);
  return guardedCall({
    url,
    method: op.method,
    token: input.token,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    options: input.options,
  });
}

function guardedCall(args: {
  readonly url: string;
  readonly method: SafeMethod;
  readonly token: string;
  readonly body?: string | undefined;
  readonly options: HubSpotFetchOptions;
}): Promise<GuardedResponse> {
  return guardedFetch({
    url: args.url,
    method: args.method,
    headers: { authorization: `Bearer ${args.token}` },
    ...(args.body === undefined ? {} : { body: args.body }),
    secrets: [args.token],
    ...(args.options.fetchImpl === undefined ? {} : { fetchImpl: args.options.fetchImpl }),
    ...(args.options.timeoutMs === undefined ? {} : { timeoutMs: args.options.timeoutMs }),
    ...(args.options.maxBytes === undefined ? {} : { maxBytes: args.options.maxBytes }),
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

/** HubSpot's documented error envelope: `{status, message, errorType|category, correlationId}`. */
function hubspotErrorSummary(bodyText: string | null | undefined): string {
  if (typeof bodyText !== 'string' || bodyText.trim() === '') return '';
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return bodyText.slice(0, 120);
  }
  const body = parsed.value as Record<string, unknown>;
  const category = typeof body['category'] === 'string' ? body['category'] : null;
  const errorType = typeof body['errorType'] === 'string' ? body['errorType'] : null;
  // The message may name a property or an object id, but never a credential — the token is
  // sent in a header, not a body, and the redactor has already run over anything that came
  // back through `guardedFetch`.
  const message = typeof body['message'] === 'string' ? body['message'].slice(0, 160) : '';
  return [category ?? errorType, message].filter((part) => part !== null && part !== '').join(': ');
}

export function classifyHubSpotError(input: ProviderErrorInput): ClassifiedError {
  if (input.status === null) {
    const cause = input.cause;
    if (cause instanceof ConnectorTransportError) {
      switch (cause.reason) {
        case 'timeout':
          // A timeout is the single most dangerous thing to get wrong. It is silence, not
          // an answer. Never NOT_FOUND.
          return classified('PROVIDER_UNAVAILABLE', `timeout: ${cause.detail}`);
        case 'response_too_large':
          return classified('PROVIDER_UNAVAILABLE', `oversized response: ${cause.detail}`);
        case 'blocked_url':
        case 'blocked_redirect':
        case 'missing_location':
        case 'too_many_redirects':
          return classified(
            'PROVIDER_UNAVAILABLE',
            `refused by the outbound guard: ${cause.reason}`,
          );
        case 'invalid_response':
        case 'network':
        default:
          return classified('PROVIDER_UNAVAILABLE', `transport: ${cause.reason}`);
      }
    }
    return classified('PROVIDER_UNAVAILABLE', 'the request did not produce a response');
  }

  const retryAfter = readRetryAfterSeconds(input.headers ?? null, input.now ?? new Date());
  const summary = hubspotErrorSummary(input.bodyText);

  if (input.status === 401) {
    return classified('AUTH_EXPIRED', summary === '' ? 'token rejected (401)' : summary);
  }
  if (input.status === 403) {
    return classified('PERMISSION_MISSING', summary === '' ? 'forbidden (403)' : summary);
  }
  if (input.status === 429) {
    return classified('RATE_LIMITED', summary === '' ? 'rate limited (429)' : summary, retryAfter);
  }
  if (input.status === 404) {
    // Deliberately NOT turned into an absence here. Only `readContactById` may do that, and
    // only after confirming the body is HubSpot's object-not-found envelope.
    return classified('NOT_FOUND', summary === '' ? 'not found (404)' : summary);
  }
  if (input.status === 400 || input.status === 422) {
    // Almost always a correlation property that does not exist in this portal: a
    // configuration problem the customer must fix, not something a retry can cure.
    return classified(
      'UNSUPPORTED_CAPABILITY',
      summary === '' ? `rejected request (${input.status})` : summary,
    );
  }
  if (input.status >= 500 || input.status === 408 || input.status === 409 || input.status === 423) {
    return classified(
      'PROVIDER_UNAVAILABLE',
      summary === '' ? `provider error (${input.status})` : summary,
      retryAfter,
    );
  }
  if (input.status >= 200 && input.status < 300) {
    // A 200 carrying an error envelope. We were answered, but not with an answer.
    return classified('PROVIDER_UNAVAILABLE', summary === '' ? 'unusable 200 response' : summary);
  }
  return classified(
    'PROVIDER_UNAVAILABLE',
    summary === '' ? `unexpected status ${input.status}` : summary,
  );
}

/**
 * True only for HubSpot's documented "this object does not exist" 404 envelope.
 *
 * A 404 that does not look like this one is a routing or gateway problem, and treating it
 * as absence would let a misconfigured proxy fail a customer's run.
 */
function isObjectNotFoundBody(bodyText: string): boolean {
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return false;
  const body = parsed.value as Record<string, unknown>;
  if (body['status'] !== 'error') return false;
  const category = typeof body['category'] === 'string' ? body['category'] : '';
  const message = typeof body['message'] === 'string' ? body['message'] : '';
  return category === 'OBJECT_NOT_FOUND' || /not found|does not exist/i.test(message);
}

// ---------------------------------------------------------------------------
// Property selection
// ---------------------------------------------------------------------------

const HUBSPOT_PROPERTY_NAME = /^[A-Za-z0-9_]{1,128}$/;

/**
 * The exact property list to request — never the whole record.
 *
 * This is a privacy control before it is a cost control: a contact record can hold a
 * phone number, an address, a deal history and a decade of notes, and none of that is
 * needed to answer "does this record exist and does this field match". We ask for the
 * fields the rules name, plus `createdate` (which is what distinguishes "a record exists"
 * from "a record was created for this enquiry") and `email`.
 */
export function selectProperties(
  required: readonly string[] | undefined,
  correlationProperty: string | undefined,
): readonly string[] {
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    if (name === undefined) return;
    if (!HUBSPOT_PROPERTY_NAME.test(name)) return;
    if (out.includes(name)) return;
    if (out.length >= MAX_REQUESTED_PROPERTIES) return;
    out.push(name);
  };
  add('hs_object_id');
  add('email');
  add('createdate');
  add(correlationProperty);
  for (const name of required ?? []) add(name);
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function asIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Coerce one HubSpot property value.
 *
 * HubSpot returns every property as a string, but a proxy, a future API version or a
 * hostile intermediary may not. Numbers and booleans become their string form; anything
 * structural becomes `null` rather than an object the evaluator would have to guess at.
 * Nothing here throws — a surprising field must not cost the customer their run.
 */
function coercePropertyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function readContactShape(raw: unknown): HubSpotContact | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rawId = record['id'];
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
  if (id === null || id === '') return null;
  const rawProps = record['properties'];
  if (
    rawProps !== undefined &&
    (typeof rawProps !== 'object' || rawProps === null || Array.isArray(rawProps))
  ) {
    return null;
  }
  const properties: Record<string, string | null> = {};
  for (const [key, value] of Object.entries((rawProps ?? {}) as Record<string, unknown>)) {
    properties[key] = coercePropertyValue(value);
  }
  return {
    id,
    properties,
    createdAt: asIsoOrNull(record['createdAt']),
    archived: record['archived'] === true,
  };
}

/**
 * Turn one HubSpot contact into the frozen evidence shape.
 *
 * `provider_account_id` comes from the context, never from the payload: HubSpot does not
 * put the portal id on a contact, so the only honest source is the identity of the
 * credential that retrieved it.
 */
export function normaliseHubSpotContact(
  raw: unknown,
  ctx: NormaliseContext,
): NormaliseResult<CrmRecordEvidence> {
  const contact = readContactShape(raw);
  if (contact === null) {
    return {
      ok: false,
      gap: makeGap(
        'crm_record',
        'INVALID_EVIDENCE',
        'contact payload did not match the expected shape',
      ),
    };
  }
  const correlationProperty = ctx.correlationProperty;
  const correlationValue =
    correlationProperty === undefined ? null : (contact.properties[correlationProperty] ?? null);
  const createdAt = asIsoOrNull(contact.properties['createdate']) ?? contact.createdAt;
  const evidence: CrmRecordEvidence = {
    kind: 'crm_record',
    origin: ctx.origin,
    // `ctx.transport` is never a caller-chosen value once it originates from
    // `fetchEvidence` — see `GuardedResponse.transport`. Absent (a caller with no basis to
    // know) is left absent here rather than defaulted to `'unknown'`, so a future reader
    // cannot mistake an explicit `unknown` for a connector that forgot to check.
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    provider: HUBSPOT_PROVIDER,
    provider_account_id: ctx.provider_account_id,
    record_id: contact.id,
    email: contact.properties['email'] ?? null,
    correlation_value: correlationValue,
    created_at: createdAt,
    properties: Object.freeze({ ...contact.properties }),
    observed_at: ctx.observedAt.toISOString(),
  };
  return { ok: true, evidence };
}

// ---------------------------------------------------------------------------
// Account identity
// ---------------------------------------------------------------------------

export interface HubSpotAccountIdentity {
  readonly account_id: string;
  readonly scopes: readonly string[];
}

type IdentityOutcome =
  | { readonly ok: true; readonly identity: HubSpotAccountIdentity }
  | { readonly ok: false; readonly error: ClassifiedError };

/**
 * Resolve the portal the token actually belongs to.
 *
 * This is the whole point of the connector: a customer telling us their portal id is a
 * claim, and a claim cannot support a mandatory assertion. `hubId` from the token-info
 * endpoint is the provider telling us, which can.
 */
export async function resolveHubSpotAccount(
  token: string,
  options: HubSpotFetchOptions,
): Promise<IdentityOutcome> {
  let response: GuardedResponse;
  try {
    response = await hubspotCall({
      operation: 'token_info',
      token,
      // The token also goes in the body: that is what the endpoint reads. EU tokens
      // additionally require the Authorization header, which `hubspotCall` always sends.
      body: { tokenKey: token },
      options,
    });
  } catch (error) {
    return { ok: false, error: classifyHubSpotError({ status: null, cause: error }) };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      error: classifyHubSpotError({
        status: response.status,
        headers: response.headers,
        bodyText: response.bodyText,
      }),
    };
  }
  const parsed = parseJsonBody(response.bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return {
      ok: false,
      error: classified('PROVIDER_UNAVAILABLE', 'token info was not usable JSON'),
    };
  }
  const body = parsed.value as Record<string, unknown>;
  const hubId = body['hubId'];
  const accountId =
    typeof hubId === 'number' && Number.isFinite(hubId)
      ? String(hubId)
      : typeof hubId === 'string' && hubId !== ''
        ? hubId
        : null;
  if (accountId === null) {
    return {
      ok: false,
      error: classified('PROVIDER_UNAVAILABLE', 'token info did not include hubId'),
    };
  }
  const rawScopes = body['scopes'];
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((s): s is string => typeof s === 'string')
    : [];
  return { ok: true, identity: { account_id: accountId, scopes } };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type ReadOutcome =
  | { readonly kind: 'found'; readonly contact: unknown; readonly transport: EvidenceTransport }
  | { readonly kind: 'absent'; readonly gap: EvidenceGap }
  | { readonly kind: 'error'; readonly error: ClassifiedError };

async function readContactById(
  token: string,
  recordId: string,
  properties: readonly string[],
  options: HubSpotFetchOptions,
): Promise<ReadOutcome> {
  let response: GuardedResponse;
  try {
    response = await hubspotCall({
      operation: 'contact_by_id',
      token,
      segment: recordId,
      query: { properties: properties.join(','), archived: 'false' },
      options,
    });
  } catch (error) {
    return { kind: 'error', error: classifyHubSpotError({ status: null, cause: error }) };
  }

  if (response.status === 404) {
    if (isObjectNotFoundBody(response.bodyText)) {
      // HubSpot has answered, with its documented object-not-found envelope, that no
      // contact with this id is visible to this token. A record in another portal is
      // invisible to this token and lands here too, which is correct: it is not our
      // customer's record. This is one of only two places NOT_FOUND may originate.
      return {
        kind: 'absent',
        gap: makeGap('crm_record', 'NOT_FOUND', `no contact with the supplied id in this portal`),
      };
    }
    // A 404 that is not HubSpot's object-not-found envelope is a routing problem, and a
    // routing problem must never read as "the customer's automation did nothing".
    return {
      kind: 'error',
      error: classified(
        'PROVIDER_UNAVAILABLE',
        'a 404 that is not the documented object-not-found response',
      ),
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      kind: 'error',
      error: classifyHubSpotError({
        status: response.status,
        headers: response.headers,
        bodyText: response.bodyText,
      }),
    };
  }

  const parsed = parseJsonBody(response.bodyText);
  if (!parsed.ok) {
    return {
      kind: 'error',
      error: classified('PROVIDER_UNAVAILABLE', `unparseable 200: ${parsed.detail}`),
    };
  }
  const body = parsed.value;
  if (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>)['status'] === 'error'
  ) {
    return {
      kind: 'error',
      error: classifyHubSpotError({ status: response.status, bodyText: response.bodyText }),
    };
  }
  return { kind: 'found', contact: body, transport: response.transport };
}

async function searchContactByCorrelation(
  token: string,
  correlationProperty: string,
  correlationValue: string,
  properties: readonly string[],
  options: HubSpotFetchOptions,
): Promise<ReadOutcome> {
  if (!HUBSPOT_PROPERTY_NAME.test(correlationProperty)) {
    return {
      kind: 'error',
      error: classified(
        'UNSUPPORTED_CAPABILITY',
        'the configured correlation property is not a valid HubSpot property name',
      ),
    };
  }
  let response: GuardedResponse;
  try {
    response = await hubspotCall({
      operation: 'contact_search',
      token,
      body: {
        filterGroups: [
          {
            filters: [
              { propertyName: correlationProperty, operator: 'EQ', value: correlationValue },
            ],
          },
        ],
        properties: [...properties],
        // Two is enough to tell zero from one from many, and asking for more would read
        // records we have no business reading.
        limit: SEARCH_PROBE_LIMIT,
      },
      options,
    });
  } catch (error) {
    return { kind: 'error', error: classifyHubSpotError({ status: null, cause: error }) };
  }

  if (response.status < 200 || response.status >= 300) {
    // Includes 429 and 5xx. A search that did not succeed tells us nothing about
    // existence, so it can never become an absence.
    return {
      kind: 'error',
      error: classifyHubSpotError({
        status: response.status,
        headers: response.headers,
        bodyText: response.bodyText,
      }),
    };
  }

  const parsed = parseJsonBody(response.bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return {
      kind: 'error',
      error: classified('PROVIDER_UNAVAILABLE', 'search returned 200 with an unusable body'),
    };
  }
  const body = parsed.value as Record<string, unknown>;
  if (body['status'] === 'error') {
    return {
      kind: 'error',
      error: classifyHubSpotError({ status: response.status, bodyText: response.bodyText }),
    };
  }
  const results = body['results'];
  if (!Array.isArray(results)) {
    // Without a results array we do not know whether the search matched. "We do not know"
    // is PROVIDER_UNAVAILABLE, never absence.
    return {
      kind: 'error',
      error: classified('PROVIDER_UNAVAILABLE', 'search response had no results array'),
    };
  }
  const total =
    typeof body['total'] === 'number' && Number.isFinite(body['total'])
      ? body['total']
      : results.length;

  if (results.length >= 2 || total >= 2) {
    // Two records carrying the same correlation id is a real, reportable condition. Picking
    // one would be a guess, and a guess that produced a VERIFIED would be a lie.
    return {
      kind: 'absent',
      gap: makeGap(
        'crm_record',
        'AMBIGUOUS_MATCH',
        `${Math.max(results.length, total)} contacts carry this correlation value; refusing to choose`,
      ),
    };
  }

  if (results.length === 0) {
    if (total > 0) {
      // The provider contradicted itself. Do not resolve it in either direction.
      return {
        kind: 'error',
        error: classified('PROVIDER_UNAVAILABLE', 'search reported matches but returned none'),
      };
    }
    // A *successful* search that matched nothing. This is the authoritative absence the
    // evaluator is allowed to act on at the deadline.
    return {
      kind: 'absent',
      gap: makeAuthoritativeAbsenceGap('crm_record', {
        status: response.status,
        detail: 'a successful search found no contact carrying this correlation value',
      }),
    };
  }

  return { kind: 'found', contact: results[0], transport: response.transport };
}

// ---------------------------------------------------------------------------
// Lookup: the customer choosing a contact to test with
// ---------------------------------------------------------------------------

/** Contacts per lookup page. Enough to choose from, small enough to read on a phone. */
export const CONTACT_LOOKUP_PAGE_SIZE = 10;
/** Longest free-text query we pass on. HubSpot's own limit is far higher; nobody types more. */
export const CONTACT_LOOKUP_MAX_QUERY = 100;
/**
 * HubSpot's search cursor is an offset. Capping it bounds how deep a lookup can page, so a
 * tampered form cannot walk a customer's whole CRM ten records at a time through us.
 */
export const CONTACT_LOOKUP_MAX_OFFSET = 40;
/** The properties a lookup reads. Enough to recognise a person; nothing that is under test. */
const CONTACT_LOOKUP_PROPERTIES = Object.freeze(['firstname', 'lastname', 'email', 'createdate']);

export interface ContactLookupInput {
  readonly token: string;
  /** The workflow's correlation property: only contacts that carry one are offered. */
  readonly correlationProperty: string;
  /** Free text, matched by HubSpot against its default searchable properties. May be empty. */
  readonly query: string;
  /** The cursor a previous page returned, or null for the first page. */
  readonly after: string | null;
  readonly options?: HubSpotFetchOptions;
}

function trimmedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * One page of contacts the customer can choose from.
 *
 * ## What it deliberately does not return
 *
 * The correlation property's VALUE. The contacts are filtered to those that carry one
 * (`HAS_PROPERTY`), because a contact without it could never match an enquiry, but the value
 * itself is not requested. It is the thing a test verification compares, and a page that
 * displayed it beside a "use this" button would be inviting the customer to copy the
 * observed value into the expectation, which turns a check into a tautology.
 *
 * ## One attempt, no retry
 *
 * The evidence path retries because a verdict depends on it. A lookup is a person waiting
 * for a list; if HubSpot is slow or refusing, the honest answer is to say so at once and
 * leave manual entry open, not to hold the page while we back off.
 */
export async function lookupContacts(
  input: ContactLookupInput,
): Promise<LookupOutcome<ContactCandidate>> {
  if (!HUBSPOT_PROPERTY_NAME.test(input.correlationProperty)) {
    return {
      kind: 'error',
      error: classified(
        'UNSUPPORTED_CAPABILITY',
        'the configured correlation property is not a valid HubSpot property name',
      ),
    };
  }
  const query = input.query.trim().slice(0, CONTACT_LOOKUP_MAX_QUERY);
  if (input.after !== null && !isContactLookupCursor(input.after)) {
    return {
      kind: 'error',
      error: classified('UNSUPPORTED_CAPABILITY', 'the page cursor is not one this lookup issues'),
    };
  }

  let response: GuardedResponse;
  try {
    response = await hubspotCall({
      operation: 'contact_lookup',
      token: input.token,
      body: {
        ...(query === '' ? {} : { query }),
        filterGroups: [
          { filters: [{ propertyName: input.correlationProperty, operator: 'HAS_PROPERTY' }] },
        ],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        properties: [...CONTACT_LOOKUP_PROPERTIES],
        limit: CONTACT_LOOKUP_PAGE_SIZE,
        ...(input.after === null ? {} : { after: input.after }),
      },
      options: input.options ?? {},
    });
  } catch (error) {
    return { kind: 'error', error: classifyHubSpotError({ status: null, cause: error }) };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      kind: 'error',
      error: classifyHubSpotError({
        status: response.status,
        headers: response.headers,
        bodyText: response.bodyText,
      }),
    };
  }
  const parsed = parseJsonBody(response.bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return {
      kind: 'error',
      error: classified('PROVIDER_UNAVAILABLE', 'search returned 200 with an unusable body'),
    };
  }
  const body = parsed.value as Record<string, unknown>;
  const results = body['results'];
  if (!Array.isArray(results)) {
    return {
      kind: 'error',
      error: classified('PROVIDER_UNAVAILABLE', 'search response had no results array'),
    };
  }

  const items: ContactCandidate[] = [];
  for (const entry of results.slice(0, CONTACT_LOOKUP_PAGE_SIZE)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : null;
    // An id we could not put back into the form verbatim is not offered at all.
    if (id === null || !isContactId(id)) continue;
    const properties =
      typeof record['properties'] === 'object' && record['properties'] !== null
        ? (record['properties'] as Record<string, unknown>)
        : {};
    const name = [trimmedText(properties['firstname']), trimmedText(properties['lastname'])]
      .filter((part): part is string => part !== null)
      .join(' ');
    items.push({
      id,
      name: name === '' ? null : name,
      email: trimmedText(properties['email']),
      createdAt: trimmedText(properties['createdate']) ?? trimmedText(record['createdAt']),
    });
  }

  const paging = body['paging'];
  const next =
    typeof paging === 'object' && paging !== null
      ? (paging as Record<string, unknown>)['next']
      : undefined;
  const nextAfter =
    typeof next === 'object' && next !== null ? (next as Record<string, unknown>)['after'] : undefined;
  // A cursor past the cap is dropped rather than offered: the page then says there are more
  // matches and asks for a narrower search, instead of paging on without end.
  const nextCursor =
    typeof nextAfter === 'string' && isContactLookupCursor(nextAfter) ? nextAfter : null;

  return { kind: 'page', items, nextCursor, hasMore: typeof nextAfter === 'string' };
}

/** A HubSpot contact id: digits only, as HubSpot issues them. */
export function isContactId(value: string): boolean {
  return /^\d{1,20}$/.test(value);
}

/** A cursor this lookup would itself have issued: a small offset, within the paging cap. */
export function isContactLookupCursor(value: string): boolean {
  return /^\d{1,6}$/.test(value) && Number(value) <= CONTACT_LOOKUP_MAX_OFFSET;
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

const HUBSPOT_CAPABILITIES: ConnectorCapabilities = Object.freeze({
  provider: HUBSPOT_PROVIDER,
  evidence_kinds: Object.freeze(['crm_record'] as const),
  // No HubSpot webhook subscription is created in v1, so this connector never stamps
  // `provider_webhook`. Saying so here stops the UI implying we have two independent
  // sources when we have one.
  origins: Object.freeze(['provider_readback'] as const),
  can_read_by_id: true,
  can_search_by_correlation: true,
  // `createdate` is a real HubSpot property carrying the record's creation instant, so
  // "a record was created for this enquiry" is answerable, not merely "one exists".
  can_prove_record_created_in_window: true,
  can_prove_account_identity: true,
  can_verify_webhooks: false,
  can_provision_webhooks: false,
  writes_to_customer_system: false,
  required_scopes: Object.freeze([HUBSPOT_READ_SCOPE]),
  limitations: Object.freeze([
    'We read contacts only. Companies, deals, tickets and notes are never requested.',
    'We request a named list of properties, not the whole record.',
    'We cannot see a contact that the private app has not been granted access to.',
    'A contact created and then deleted before we looked is indistinguishable from one that never existed.',
    'HubSpot does not tell us which portal a contact belongs to; we attribute evidence to the portal the token belongs to.',
  ]),
});

const MANUAL_REVOKE_STEP: ConnectionSetupStep = Object.freeze({
  id: 'hubspot_delete_private_app_token',
  title: 'Delete the private app token in HubSpot',
  detail:
    'We have deleted our copy of your token and will not use it again. HubSpot does not let an application revoke its own private app token, so the token itself stays valid until you delete it in HubSpot under Settings, Integrations, Private Apps.',
  doc_url: 'https://developers.hubspot.com/docs/guides/apps/private-apps/overview',
  verifiable_by_us: false,
});

export class HubSpotConnector implements Connector {
  readonly provider = HUBSPOT_PROVIDER;
  private readonly options: HubSpotFetchOptions;

  constructor(options: HubSpotFetchOptions = {}) {
    this.options = options;
  }

  capabilities(): ConnectorCapabilities {
    return HUBSPOT_CAPABILITIES;
  }

  classifyError(input: ProviderErrorInput): ClassifiedError {
    return classifyHubSpotError(input);
  }

  normaliseEvidence(raw: unknown, ctx: NormaliseContext): NormaliseResult<CrmRecordEvidence> {
    return normaliseHubSpotContact(raw, ctx);
  }

  async validateConnection(input: {
    readonly credentials: ConnectorCredentials;
    readonly connection: ConnectionConfig;
    readonly now: Date;
  }): Promise<ConnectionValidation> {
    const outcome = await resolveHubSpotAccount(input.credentials.accessToken, this.options);
    if (!outcome.ok) {
      return {
        ok: false,
        account_id: null,
        granted_scopes: [],
        missing_capabilities: ['crm_record'],
        setup_steps: [],
        error: outcome.error,
        checked_at: input.now.toISOString(),
        calls_made: 1,
      };
    }
    const scopes = outcome.identity.scopes;
    // HubSpot reports the granted scopes on the token, so "you forgot to tick the box" is
    // answerable at setup time rather than at 3am inside a customer's run.
    const hasRead = scopes.length === 0 || scopes.includes(HUBSPOT_READ_SCOPE);
    const missing = hasRead ? [] : [HUBSPOT_READ_SCOPE];
    return {
      ok: hasRead,
      account_id: outcome.identity.account_id,
      granted_scopes: scopes,
      missing_capabilities: missing,
      setup_steps: hasRead
        ? []
        : [
            {
              id: 'hubspot_add_contacts_read_scope',
              title: 'Add the contacts read scope to your private app',
              detail: `Your private app does not have ${HUBSPOT_READ_SCOPE}. Edit the app in HubSpot, tick that scope, save, and paste the token again.`,
              doc_url: 'https://developers.hubspot.com/docs/guides/apps/private-apps/overview',
              verifiable_by_us: true,
            },
          ],
      error: hasRead
        ? null
        : classified('PERMISSION_MISSING', `missing scope ${HUBSPOT_READ_SCOPE}`),
      checked_at: input.now.toISOString(),
      calls_made: 1,
    };
  }

  /**
   * Retrieve the CRM evidence for one observation.
   *
   * Order: establish who we are talking to, then look. Identity first, because a record
   * with no attributable account is not evidence — it is an anecdote.
   */
  async fetchEvidence(input: FetchEvidenceInput): Promise<ConnectorFetchResult> {
    const token = input.credentials.accessToken;
    const gaps: EvidenceGap[] = [];
    let calls = 0;

    // --- identity -----------------------------------------------------------
    let accountId = input.connection.account_id;
    const mustResolve = accountId === null || input.connection.reverify_account === true;
    if (mustResolve) {
      const identity = await resolveHubSpotAccount(token, this.options);
      calls += 1;
      if (!identity.ok) {
        return {
          provider: HUBSPOT_PROVIDER,
          provider_account_id: null,
          evidence: [],
          gaps: [makeGap('crm_record', identity.error.code, identity.error.detail)],
          calls_made: calls,
        };
      }
      // The *live* identity wins over the stored one, always. If the customer swapped the
      // token for a different portal, the evidence must carry the portal it really came
      // from so the evaluator can contradict it — not the portal we hoped for.
      accountId = identity.identity.account_id;
    }
    if (accountId === null) {
      return {
        provider: HUBSPOT_PROVIDER,
        provider_account_id: null,
        evidence: [],
        gaps: [
          makeGap(
            'crm_record',
            'PROVIDER_UNAVAILABLE',
            'could not establish which HubSpot account this connection belongs to',
          ),
        ],
        calls_made: calls,
      };
    }

    // --- locator ------------------------------------------------------------
    const properties = selectProperties(
      input.requiredProperties,
      input.connection.correlation_property,
    );
    const recordId = input.locator.record_id;
    const correlationValue = input.locator.correlation_value;
    const correlationProperty = input.connection.correlation_property;

    if (
      (recordId === undefined || recordId === '') &&
      (correlationValue === undefined ||
        correlationValue === '' ||
        correlationProperty === undefined)
    ) {
      return {
        provider: HUBSPOT_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps: [
          makeGap(
            'crm_record',
            'INVALID_EVIDENCE',
            'no record id and no correlation value were supplied, so there is nothing to look up',
          ),
        ],
        calls_made: calls,
      };
    }

    // --- the read, with A03's retry planner in charge of every repeat --------
    const retried = await withTransportRetry<ReadOutcome>({
      now: input.now,
      ...(input.attemptsUsed === undefined ? {} : { attemptsUsed: input.attemptsUsed }),
      ...(this.options.jitterSeed === undefined ? {} : { jitterSeed: this.options.jitterSeed }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      attempt: async () => {
        const outcome =
          recordId !== undefined && recordId !== ''
            ? await readContactById(token, recordId, properties, this.options)
            : await searchContactByCorrelation(
                token,
                correlationProperty as string,
                correlationValue as string,
                properties,
                this.options,
              );
        if (outcome.kind === 'error') {
          return {
            value: outcome,
            gap: makeGap('crm_record', outcome.error.code, outcome.error.detail),
            retryAfterSeconds: outcome.error.retryAfterSeconds,
          };
        }
        // `absent` is an answer, not a failure: NOT_FOUND and AMBIGUOUS_MATCH are both
        // things the provider told us, so neither is retried.
        return { value: outcome, gap: null };
      },
    });
    calls += retried.attempts;

    const outcome = retried.value;
    if (outcome.kind === 'error') {
      gaps.push(makeGap('crm_record', outcome.error.code, outcome.error.detail));
      return {
        provider: HUBSPOT_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps,
        calls_made: calls,
      };
    }
    if (outcome.kind === 'absent') {
      gaps.push(outcome.gap);
      return {
        provider: HUBSPOT_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps,
        calls_made: calls,
      };
    }

    const normalised = this.normaliseEvidence(outcome.contact, {
      provider_account_id: accountId,
      origin: 'provider_readback',
      transport: outcome.transport,
      observedAt: input.now,
      ...(correlationProperty === undefined ? {} : { correlationProperty }),
      ...(correlationValue === undefined ? {} : { correlationValue }),
    });
    if (!normalised.ok) {
      gaps.push(normalised.gap);
      return {
        provider: HUBSPOT_PROVIDER,
        provider_account_id: accountId,
        evidence: [],
        gaps,
        calls_made: calls,
      };
    }
    return {
      provider: HUBSPOT_PROVIDER,
      provider_account_id: accountId,
      evidence: [normalised.evidence],
      gaps,
      calls_made: calls,
    };
  }

  /**
   * HubSpot exposes no endpoint for an application to revoke its own private app token.
   * We delete our copy and tell the customer, honestly, what is left for them to do.
   */
  async revokeOrDisconnect(): Promise<RevokeResult> {
    return Promise.resolve({
      local_credential_cleared: true,
      provider_revoked: false,
      manual_steps: [MANUAL_REVOKE_STEP],
      calls_made: 0,
    });
  }
}

export const hubspotConnector = new HubSpotConnector();
