/**
 * Cache-control posture for authenticated responses.
 *
 * Cloudflare's CDN does not cache HTML or JSON by default — only a fixed list of static
 * extensions — so today a customer's run report is private by accident of its content
 * type rather than by instruction. That is one Cache Rule, one "cache everything" page
 * rule, or one corporate proxy away from a shared cache holding one tenant's evidence and
 * serving it to another.
 *
 * So every response says so explicitly:
 *
 *   Cache-Control: private, no-store
 *   Vary: Cookie
 *
 * `private` forbids shared caches. `no-store` forbids writing it to disk at all, which is
 * what matters on a shared machine and in a browser's back/forward cache. `Vary: Cookie`
 * means that any cache which ignores the first two still cannot serve one signed-in
 * customer's response to a different cookie.
 *
 * Genuinely public, cacheable responses — marketing pages, the demo, static assets — opt
 * out by setting their own `Cache-Control` before this middleware runs. Absence of an
 * instruction is treated as "private", never as "cacheable": the default must be the safe
 * one, because the pages nobody thought about are exactly the ones that leak.
 */

export const PRIVATE_CACHE_CONTROL = 'private, no-store';
export const PRIVATE_VARY = 'Cookie';

/** Headers a cacheable public response may set to opt out. Exported for A05's use. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

function mergeVary(existing: string | null): string {
  if (existing === null || existing.trim().length === 0) return PRIVATE_VARY;
  const parts = existing
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.some((p) => p === '*')) return '*';
  if (parts.some((p) => p.toLowerCase() === 'cookie')) return parts.join(', ');
  return [...parts, PRIVATE_VARY].join(', ');
}

/**
 * Stamp the private-cache headers onto a `Headers` object in place.
 *
 * An existing `Cache-Control` is left alone — that is the opt-out — but `Vary: Cookie` is
 * merged in regardless, because a response that varies by cookie varies by cookie whether
 * or not its author wanted it cached.
 */
export function applyPrivateCacheHeaders(headers: Headers): void {
  if (!headers.has('cache-control')) {
    headers.set('cache-control', PRIVATE_CACHE_CONTROL);
  }
  headers.set('vary', mergeVary(headers.get('vary')));
}

/** Return a copy of `response` carrying the private-cache headers. */
export function withPrivateCacheHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  applyPrivateCacheHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Minimal structural view of the Hono context this middleware needs.
 *
 * Typed structurally rather than importing Hono so `apps/app/src/lib` stays free of a
 * framework dependency and remains testable without one.
 */
export interface CacheMiddlewareContext {
  res: Response;
}

export type Next = () => Promise<void>;

/**
 * Hono-compatible middleware. Mount it once, outermost, so it covers every route
 * including error responses:
 *
 *   app.use('*', privateCacheHeaders());
 */
export function privateCacheHeaders(): (c: CacheMiddlewareContext, next: Next) => Promise<void> {
  return async (c, next) => {
    await next();
    try {
      // Hono exposes the finished response on `c.res`; mutating its headers in place
      // avoids rebuilding the body stream.
      applyPrivateCacheHeaders(c.res.headers);
    } catch {
      // Some responses (redirects, and anything proxied from `fetch`) carry immutable
      // headers. Rebuild rather than silently shipping an uncontrolled response.
      c.res = withPrivateCacheHeaders(c.res);
    }
  };
}
