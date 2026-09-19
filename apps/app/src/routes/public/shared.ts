/**
 * Shared plumbing for the server-rendered routes.
 *
 * Deliberately tiny: a bindings type, one response helper and the security headers a
 * server-rendered page should carry. Nothing here touches the database or a provider.
 */
import type { Context } from 'hono';
import { Button, ErrorState, html, render, type Html } from '@verify/ui';

/**
 * The bindings these routes read. A superset is fine — the lead's `BootstrapEnv` already
 * provides all of them. Declared here rather than imported from `src/index.ts` so mounting
 * the router does not create an import cycle back into the Worker entry point.
 */
export interface RouteEnv {
  readonly ENVIRONMENT: string;
  readonly PUBLIC_BASE_URL: string;
  readonly ASSETS?: Fetcher;
}

export type RouteBindings = { Bindings: RouteEnv };

/**
 * Render a page and answer with it. Public pages are revalidated; app pages are `no-store`.
 *
 * A Content-Security-Policy belongs on the Worker entry point, which the lead owns — these
 * pages load nothing from anywhere, so `default-src 'none'` with hashes for the one inline
 * style block and the one inline theme script would hold. That request is in the handoff.
 */
export async function page(
  c: Context<RouteBindings>,
  node: Html,
  options: { status?: number; cache?: 'public' | 'private' } = {},
): Promise<Response> {
  const body = await render(node);
  const status = options.status ?? 200;
  const cache = options.cache === 'public' ? 'public, max-age=0, must-revalidate' : 'no-store';
  return c.html(body, status as 200, {
    'cache-control': cache,
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
  });
}

export interface FailureBodyOptions {
  /** Where "Try again" goes — the page that failed. */
  readonly retryHref: string;
  /** The support route appropriate to the surface: signed-in or public. */
  readonly supportHref: string;
  /** The request id from the edge, so the support queue can find the same event. */
  readonly requestId: string;
}

/**
 * The failure state every rendered route shares.
 *
 * Until this existed, an exception under `/app` or `/` fell through to the Worker's global
 * `onError`, which answers a JSON envelope — right for `/api/v1`, and a wall of braces for
 * a person who clicked "Runs". A realistic failure state says what failed, what did NOT
 * happen (no run was decided, nothing was changed, nothing was charged — a page that fails
 * must never be read as a verdict), what to do, and a reference. It never carries the
 * cause: an error body naming an internal identifier is a gift to whoever is probing, and
 * the cause is logged with the request instead.
 *
 * Rendered inside the ordinary layout so the reader keeps the navigation and a way out,
 * and announced (`role="alert"`) so a screen reader hears the replacement content.
 */
export function failureBody(options: FailureBodyOptions): Html {
  return html`<div class="wrap section stack-lg measure">
    ${ErrorState({
      title: 'We could not load this page',
      body:
        'Something on our side failed while this page was being built. No run has been decided, no ' +
        'setting has been changed and nothing has been charged as a result. Try again in a moment; if it ' +
        'keeps happening, write to support and quote the reference below so we can find the same event.',
      requestId: options.requestId,
      actions: [
        Button({ label: 'Try again', href: options.retryHref, variant: 'primary' }),
        Button({ label: 'Contact support', href: options.supportHref, variant: 'quiet' }),
      ],
    })}
  </div>`;
}

/** ISO-8601 UTC, rendered for a human without ever guessing a local timezone. */
export function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return 'not recorded';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'not recorded';
  // Strip *any* fractional second, not the literal `.000Z`. An instant taken from
  // `new Date()` almost never has a zero millisecond, so the old spelling rendered
  // `2026-09-19 12:10:15.869Z UTC` — a string carrying both a `Z` and a `UTC`, which is not
  // a format. Found on a screenshot of /app/usage, not by reading this line.
  return `${new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')} UTC`;
}

/** A duration a person can read, from seconds. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
