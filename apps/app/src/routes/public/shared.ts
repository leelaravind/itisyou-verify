/**
 * Shared plumbing for the server-rendered routes.
 *
 * Deliberately tiny: a bindings type, one response helper and the security headers a
 * server-rendered page should carry. Nothing here touches the database or a provider.
 */
import type { Context } from 'hono';
import { render, type Html } from '@verify/ui';

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

/** ISO-8601 UTC, rendered for a human without ever guessing a local timezone. */
export function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return 'not recorded';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'not recorded';
  return `${new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '')} UTC`;
}

/** A duration a person can read, from seconds. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
