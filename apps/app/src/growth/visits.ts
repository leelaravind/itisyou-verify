/**
 * The visit counter, as mountable middleware.
 *
 * ## Mounting (lead — this is the whole change)
 *
 * In `apps/app/src/index.ts`, **after** the security-headers `app.use('*', …)` block and
 * **before** `app.route('/app', …)`. Order matters in one direction only: it must be
 * inside the headers middleware so a counted request still gets its headers, and it must
 * be above the routers so it sees every public path.
 *
 *     import { createVisitCounter } from './growth/visits.js';
 *     import { createD1GrowthPort } from './db/growthPort.js';   // A02, not yet written
 *
 *     app.use(
 *       '*',
 *       createVisitCounter({
 *         // Returning null disables counting outright — that is the correct behaviour
 *         // while A02's port does not exist yet, and the page is unaffected either way.
 *         port: (c) => createD1GrowthPort((c.env as Env).DB),
 *         salt: (c) => (c.env as Env).ANALYTICS_SALT,
 *         internal: { headerValue: (c.env as Env).INTERNAL_TEST_TOKEN ?? null },
 *       }),
 *     );
 *
 * Two bindings are needed and neither is set today:
 *
 *  - `ANALYTICS_SALT` — a secret, at least 16 characters. **Without it nothing is
 *    counted at all**, deliberately: an unsalted hash of an IP address is reversible by
 *    brute force over the IPv4 space in seconds, so no counting is the safer failure.
 *  - `INTERNAL_TEST_TOKEN` — a secret the deploy smoke check and any uptime probe send as
 *    `x-verify-internal`. Without it, header-based exclusion is simply off; it never
 *    degrades to "any value excludes", because that would let anyone on the internet
 *    remove themselves — or everyone — from the founder's figures.
 *
 * Both need adding to `Env` in `index.ts` and `lib/context.ts`, and `INTERNAL_TEST_TOKEN`
 * to `.dev.vars.example` as a placeholder. Those are all files I do not own.
 *
 * Until `createD1GrowthPort` exists, `createMemoryGrowthPort()` from `./growth/memory.js`
 * satisfies the same interface, but it is a **test double** — it forgets everything on
 * each isolate, so mounting it in production would report plausible-looking numbers that
 * are silently wrong. Prefer passing `null` and counting nothing.
 *
 * Four properties this file exists to guarantee:
 *
 *  1. **It costs nothing measurable on a page render.** The request path does string
 *     comparisons on the method and the path, reads three headers, and schedules. The
 *     hashing and the database write happen in `executionCtx.waitUntil()`, after the
 *     response has been returned. A visit counter that slows the landing page is worse
 *     than no counter.
 *  2. **It fails open, always.** Every path through the deferred work is wrapped. A
 *     missing salt, a missing port, a thrown write, a malformed URL — none of them can
 *     reach the response. Nobody sees an error because analytics had a bad day.
 *  3. **No raw address is ever stored.** The address is an argument to the hash and
 *     nothing else. It is not logged, not returned, and has no column to live in.
 *  4. **Our own traffic never counts.** Deploy smoke checks, uptime probes and the
 *     owner's own browsing are classified `internal_test` and excluded from the external
 *     figure. The founder's ten must be ten strangers.
 */
import { timingSafeEqual } from '@verify/security';
import { buildVisitSession, type VisitRequestInput, type VisitSession } from './analytics';
import type { GrowthDataPort } from './port';

/* -------------------------------------------------------------------------- */
/* what counts as a page view                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Paths that are never a visit. `/health` is first for a reason: an uptime check hitting
 * it every minute would otherwise be the single largest "visitor" we have.
 */
const NEVER_COUNTED_PREFIXES: readonly string[] = [
  '/health',
  '/api/',
  '/assets/',
  '/static/',
  '/admin',
  '/owner',
  '/app',
  '/.well-known/',
];

const NEVER_COUNTED_EXACT: readonly string[] = [
  '/robots.txt',
  '/favicon.ico',
  '/sitemap.xml',
  '/manifest.json',
];

/**
 * A page, not an asset. Anything with a file extension is a resource request — counting
 * the stylesheet as a second visit would inflate the figure by exactly the number of
 * assets on the page.
 */
export function isCountablePath(path: string): boolean {
  if (NEVER_COUNTED_EXACT.includes(path)) return false;
  if (NEVER_COUNTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix)))
    return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* internal traffic                                                           */
/* -------------------------------------------------------------------------- */

export interface InternalMarkers {
  /** Header a deploy smoke check or uptime probe sets. Default `x-verify-internal`. */
  readonly headerName?: string;
  /**
   * The value that header must carry. `null` disables header-based exclusion entirely —
   * it never falls back to "any value counts", because that would let anyone on the
   * internet exclude themselves from the figures, or worse, exclude everyone.
   */
  readonly headerValue: string | null;
  /** Cookie the owner's own browser carries. Default `verify_internal`. */
  readonly cookieName?: string;
  /** Lower-cased user-agent fragments belonging to our own tooling. */
  readonly userAgentSubstrings?: readonly string[];
}

const DEFAULT_INTERNAL_UA: readonly string[] = [
  'itisyou-verify-smoke',
  'itisyou-verify-deploy',
  'wrangler',
];

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

/**
 * Is this our own traffic?
 *
 * The header comparison is constant-time. It is not a secret worth much, but a token that
 * can be probed a byte at a time is a token that can be guessed, and the cost of using the
 * safe comparison is nothing.
 */
export function isInternalTraffic(
  headers: { get(name: string): string | null },
  markers: InternalMarkers,
): boolean {
  const headerName = markers.headerName ?? 'x-verify-internal';
  const cookieName = markers.cookieName ?? 'verify_internal';

  if (markers.headerValue !== null && markers.headerValue.length > 0) {
    const supplied = headers.get(headerName);
    if (supplied !== null && timingSafeEqual(supplied, markers.headerValue)) return true;
  }
  if (cookieValue(headers.get('cookie'), cookieName) === '1') return true;

  const ua = (headers.get('user-agent') ?? '').toLowerCase();
  const fragments = markers.userAgentSubstrings ?? DEFAULT_INTERNAL_UA;
  return ua.length > 0 && fragments.some((fragment) => ua.includes(fragment));
}

/* -------------------------------------------------------------------------- */
/* the middleware                                                             */
/* -------------------------------------------------------------------------- */

/** The minimum of a Hono context this middleware touches. Kept structural so it is testable. */
export interface VisitContext {
  readonly req: {
    readonly method: string;
    readonly url: string;
    readonly raw: { readonly headers: Headers };
  };
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void } | undefined;
}

export interface VisitCounterOptions {
  /** `null` disables counting. Never throws; a missing port is simply "not wired". */
  readonly port: (c: VisitContext) => GrowthDataPort | null;
  /** `undefined` disables counting. An unsalted hash is worse than no hash. */
  readonly salt: (c: VisitContext) => string | undefined;
  readonly internal: InternalMarkers;
  readonly now?: () => Date;
  /** Override which paths count. Defaults to `isCountablePath`. */
  readonly countPath?: (path: string) => boolean;
  /** Called when the deferred work throws. Defaults to swallowing it. */
  readonly onError?: (error: unknown) => void;
}

/** The address headers Cloudflare and common proxies set, in order of trust. */
function clientAddress(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip');
  if (cf !== null && cf.length > 0) return cf;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (first.length > 0) return first;
  }
  return headers.get('x-real-ip') ?? '';
}

/**
 * Build the row for a request. Exported so the deployed-origin check and the tests can
 * exercise exactly what the middleware would store, without a Hono context.
 */
export async function visitFromRequest(
  input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Headers;
  },
  salt: string,
  markers: InternalMarkers,
  now: Date,
): Promise<VisitSession> {
  const url = new URL(input.url);
  const request: VisitRequestInput = {
    ip: clientAddress(input.headers),
    user_agent: input.headers.get('user-agent') ?? '',
    path: url.pathname,
    query: url.search,
    internal_test_marker: isInternalTraffic(input.headers, markers),
    method: input.method,
    ...(input.headers.get('accept-language') !== null
      ? { accept_language: input.headers.get('accept-language') as string }
      : {}),
    ...(input.headers.get('referer') !== null
      ? { referrer: input.headers.get('referer') as string }
      : {}),
  };
  return buildVisitSession(request, salt, now);
}

type Next = () => Promise<void>;

/**
 * The mountable middleware. Returns a function with Hono's middleware shape without
 * importing Hono, so this file has no framework dependency and can be unit tested by
 * calling it directly.
 */
export function createVisitCounter(
  options: VisitCounterOptions,
): (c: VisitContext, next: Next) => Promise<void> {
  const countPath = options.countPath ?? isCountablePath;
  const clock = options.now ?? (() => new Date());
  const report = options.onError ?? (() => undefined);

  return async function visitCounter(c: VisitContext, next: Next): Promise<void> {
    // --- the only work on the request path ---------------------------------
    // Method and path checks are string comparisons. Nothing here awaits, allocates a
    // hash, or touches the database.
    let scheduled: (() => Promise<void>) | null = null;
    try {
      if (c.req.method === 'GET') {
        const path = new URL(c.req.url).pathname;
        if (countPath(path)) {
          const port = options.port(c);
          const salt = options.salt(c);
          if (port !== null && salt !== undefined && salt.length > 0) {
            // Headers are captured now; the request object may not outlive the response.
            const snapshot = new Headers(c.req.raw.headers);
            const method = c.req.method;
            const url = c.req.url;
            const at = clock();
            scheduled = async () => {
              const session = await visitFromRequest(
                { method, url, headers: snapshot },
                salt,
                options.internal,
                at,
              );
              await port.recordVisit(session, at.toISOString());
            };
          }
        }
      }
    } catch (error) {
      // Even deciding whether to count must not be able to break a page render.
      report(error);
      scheduled = null;
    }

    await next();

    // --- everything expensive happens after the response -------------------
    if (scheduled === null) return;
    const work = scheduled().catch((error: unknown) => {
      report(error);
    });
    if (c.executionCtx !== undefined) {
      try {
        c.executionCtx.waitUntil(work);
        return;
      } catch (error) {
        report(error);
      }
    }
    // No execution context (tests, or a runtime that does not provide one). The promise
    // is already guarded, so letting it run detached cannot surface an error anywhere.
    void work;
  };
}
