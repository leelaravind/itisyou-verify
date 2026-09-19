/**
 * The guarded fetch — the *only* place in the product where a connector reaches the
 * network.
 *
 * Every rule the brief states about outbound traffic is enforced here, once, rather than
 * being repeated hopefully in each adapter:
 *
 *  - A fixed compile-time host allowlist (`CONNECTOR_ALLOWED_HOSTS`). No customer-supplied
 *    URL is ever fetched; connectors pass a *path*, and the base is chosen from a frozen
 *    table by provider id.
 *  - Private, loopback, link-local, CGNAT and cloud-metadata addresses are refused, as are
 *    bare IP literals, non-HTTPS schemes, non-443 ports and credentials embedded in a URL.
 *    That logic is A10's, adopted verbatim in `./url-guard.ts`.
 *  - `redirect: 'manual'`. A redirect is followed only if its target passes the whole
 *    guard again, with a hop budget of three.
 *  - An explicit timeout via `AbortSignal.timeout`, applied per hop.
 *  - A bounded response body, enforced while streaming rather than after buffering, so an
 *    endless body cannot exhaust the isolate before we notice.
 *  - A `User-Agent` identifying the service. (Resend documents error `1010` for requests
 *    without one, so this is a correctness requirement as well as a courtesy.)
 *  - Secrets never appear in a message, a thrown value, or anything returned from here.
 *    Every credential handed in is registered and scrubbed out of every string that
 *    escapes this module.
 *
 * Nothing in here knows what a contact or an email is. It moves bytes safely and stops.
 */
import { CONNECTOR_URL_GUARD_OPTIONS, checkRedirect, checkUrl } from './url-guard.js';
import type { ProviderId } from './types.js';

/** Frozen API bases, keyed by provider. Never assembled from customer input. */
export const PROVIDER_BASE_URL: Readonly<Record<ProviderId, string>> = Object.freeze({
  hubspot: 'https://api.hubapi.com',
  resend: 'https://api.resend.com',
});

export const USER_AGENT = 'ITISYOU-Verify/1.0 (+https://itisyou.co.uk/verify)';

/** Default per-hop timeout. Short: an observation that hangs is an observation that lies. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Default response ceiling. A contact record and an email event are both a few kilobytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
/** Redirect hops we will follow, each fully re-guarded. */
export const MAX_REDIRECT_HOPS = 3;

/** HTTP methods this layer will emit. There is no PUT, PATCH or DELETE, by construction. */
export type SafeMethod = 'GET' | 'POST';

export type TransportFailure =
  | 'blocked_url'
  | 'blocked_redirect'
  | 'missing_location'
  | 'too_many_redirects'
  | 'timeout'
  | 'network'
  | 'response_too_large'
  | 'invalid_response';

/**
 * A transport-level failure, before any provider semantics are applied.
 *
 * The message is assembled from a fixed reason word and an already-scrubbed detail. No
 * header, no request body and no credential is ever interpolated into it, and the detail
 * passes through `redactSecrets` on the way in.
 */
export class ConnectorTransportError extends Error {
  readonly reason: TransportFailure;
  readonly detail: string;

  constructor(reason: TransportFailure, detail: string) {
    super(`connector transport failure: ${reason}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'ConnectorTransportError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Replace every registered secret with a fixed marker.
 *
 * Substring replacement, not equality: a token that ends up inside a URL, a JSON body or
 * a provider's echoed error message is still caught. Short strings are ignored so a
 * one-character "secret" cannot blank out an entire diagnostic.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    while (out.includes(secret)) out = out.replace(secret, '[redacted]');
  }
  return out;
}

export interface GuardedRequest {
  /** Absolute HTTPS URL. Built by a connector from a frozen base plus an encoded path. */
  readonly url: string;
  readonly method: SafeMethod;
  /** Request headers. Never logged, never echoed, never returned. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  /** Credential strings to scrub from anything that escapes this call. */
  readonly secrets?: readonly string[] | undefined;
  /** Injected for tests. Defaults to the ambient `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface GuardedResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Bounded body text. Never larger than `maxBytes`. */
  readonly bodyText: string;
  /** The URL that finally answered, after any followed redirects. */
  readonly finalUrl: string;
  readonly redirects: number;
}

function timeoutSignal(ms: number): AbortSignal {
  const ctor = AbortSignal as unknown as { timeout?: (delay: number) => AbortSignal };
  if (typeof ctor.timeout === 'function') return ctor.timeout(ms);
  // Fallback for a runtime without AbortSignal.timeout. Both Workers and Node 22 have it;
  // this exists so the module never depends on a feature check succeeding.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Read at most `maxBytes` of a response body, refusing rather than truncating.
 *
 * Truncating would be worse than refusing: a half-read JSON document parses as malformed
 * and would be classified as a provider fault, when the real problem is that the response
 * was larger than we are willing to hold. We say which.
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new ConnectorTransportError(
      'response_too_large',
      `content-length ${declared} > ${maxBytes}`,
    );
  }
  const body = response.body;
  if (body === null || typeof body.getReader !== 'function') {
    const text = await response.text();
    const size = new TextEncoder().encode(text).byteLength;
    if (size > maxBytes) {
      throw new ConnectorTransportError('response_too_large', `body ${size} > ${maxBytes}`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ConnectorTransportError('response_too_large', `body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A cancel failure on an already-finished stream is not interesting.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Perform one guarded request, following at most `MAX_REDIRECT_HOPS` fully re-guarded
 * redirects.
 *
 * Throws `ConnectorTransportError` for anything that prevented a response from arriving.
 * A 4xx or 5xx is *not* an error here — it is returned, because only the connector knows
 * whether a 404 means "authoritatively absent" or "this endpoint moved".
 */
export async function guardedFetch(request: GuardedRequest): Promise<GuardedResponse> {
  const secrets = request.secrets ?? [];
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const doFetch = request.fetchImpl ?? globalThis.fetch;
  const scrub = (text: string): string => redactSecrets(text, secrets);

  const first = checkUrl(request.url, CONNECTOR_URL_GUARD_OPTIONS);
  if (!first.ok) {
    throw new ConnectorTransportError('blocked_url', scrub(`${first.reason}: ${first.detail}`));
  }

  let current: URL = first.url;
  let redirects = 0;

  for (;;) {
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      'user-agent': USER_AGENT,
      accept: 'application/json',
    };
    // A redirect must never carry the credential to a new origin. The guard already
    // restricts targets to the allowlist, but stripping on cross-origin hops is the
    // behaviour we want even if the allowlist is ever widened.
    if (redirects > 0 && current.origin !== first.url.origin) {
      delete headers['authorization'];
    }

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: timeoutSignal(timeoutMs),
    };
    if (request.body !== undefined && request.method !== 'GET') {
      init.body = request.body;
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await doFetch(current.href, init);
    } catch (error) {
      if (error instanceof ConnectorTransportError) throw error;
      if (isAbort(error))
        throw new ConnectorTransportError('timeout', `no response within ${timeoutMs}ms`);
      // The thrown value may be anything, including something a provider library built
      // from a request that contained the token. Scrub before it becomes a message.
      const text = error instanceof Error ? error.message : String(error);
      throw new ConnectorTransportError('network', scrub(text).slice(0, 200));
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      let bodyText: string;
      try {
        bodyText = await readBounded(response, maxBytes);
      } catch (error) {
        if (error instanceof ConnectorTransportError) throw error;
        if (isAbort(error))
          throw new ConnectorTransportError('timeout', `body not read within ${timeoutMs}ms`);
        throw new ConnectorTransportError('invalid_response', scrub(String(error)).slice(0, 200));
      }
      return {
        status: response.status,
        headers: response.headers,
        bodyText,
        finalUrl: current.href,
        redirects,
      };
    }

    const location = response.headers.get('location');
    if (location === null || location.trim() === '') {
      throw new ConnectorTransportError(
        'missing_location',
        `status ${response.status} without a Location`,
      );
    }
    redirects += 1;
    if (redirects > MAX_REDIRECT_HOPS) {
      throw new ConnectorTransportError(
        'too_many_redirects',
        `stopped after ${MAX_REDIRECT_HOPS} hops`,
      );
    }
    const next = checkRedirect(current, location, CONNECTOR_URL_GUARD_OPTIONS, redirects);
    if (!next.ok) {
      throw new ConnectorTransportError(
        'blocked_redirect',
        scrub(`${next.reason}: ${next.detail}`),
      );
    }
    current = next.url;
  }
}

/**
 * Build a provider URL from a frozen base, an allowlisted path and encoded query values.
 *
 * `path` is written by us, in our source. Customer-supplied values only ever appear as
 * *path segments* or *query values*, both percent-encoded, so a locator such as
 * `../../oauth/v1/tokens` or `https://evil.example` cannot change the host or escape the
 * intended endpoint. The guard then checks the result anyway.
 */
export function providerUrl(
  provider: ProviderId,
  path: string,
  query?: Readonly<Record<string, string | number | undefined>>,
): string {
  if (!path.startsWith('/'))
    throw new ConnectorTransportError('blocked_url', 'path must start with /');
  const url = new URL(PROVIDER_BASE_URL[provider] + path);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

/** Percent-encode one customer-supplied path segment. */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Parse a bounded JSON body.
 *
 * Returns a discriminated result rather than throwing, because "the provider answered 200
 * with something that is not JSON" is a provider-semantics problem the connector has to
 * classify, not a transport failure.
 */
export function parseJsonBody(
  text: string,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (text.trim() === '') return { ok: false, detail: 'empty body' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, detail: 'body is not valid JSON' };
  }
}

/**
 * Extract a retry delay in seconds from response headers.
 *
 * `Retry-After` may be a delta in seconds or an HTTP date; both forms are handled. HubSpot
 * does not document `Retry-After` on its 429s, so `X-HubSpot-RateLimit-Interval-Milliseconds`
 * is accepted as a fallback — it is the provider telling us the length of the window we
 * just exhausted, which is the right thing to wait out.
 */
export function readRetryAfterSeconds(
  headers: Headers | null | undefined,
  now: Date,
): number | null {
  if (!headers) return null;
  const raw = headers.get('retry-after');
  if (raw !== null && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
    }
    const asDate = Date.parse(trimmed);
    if (Number.isFinite(asDate)) {
      const delta = Math.ceil((asDate - now.getTime()) / 1000);
      if (delta > 0) return Math.min(delta, 3600);
      return 0;
    }
  }
  const interval = headers.get('x-hubspot-ratelimit-interval-milliseconds');
  if (interval !== null && /^\d+$/.test(interval.trim())) {
    const seconds = Math.ceil(Number(interval.trim()) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 3600);
  }
  return null;
}
