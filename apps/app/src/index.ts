/**
 * Worker entry point.
 *
 * Owns exactly three things: the security headers every response carries, the
 * mounting of the routers each specialist built, and the scheduled tick. Page
 * rendering lives in `routes/`, data access in `db/`, and no business logic is
 * written here.
 */
import { Hono } from 'hono';
import { CSS, THEME_SCRIPT, render } from '@verify/ui';
import { publicRoutes, notFoundPage } from './routes/public/index.js';
import { appRoutes } from './routes/app/index.js';
import { createOwnerRoutes } from './routes/owner/index.js';
import { MemoryOwnerDataPort } from './owner/memory.js';
import { ANONYMOUS_PRINCIPAL } from './owner/access.js';

export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly ENVIRONMENT: string;
  readonly PUBLIC_BASE_URL: string;
  readonly STRIPE_MODE?: string;
  readonly CREDENTIAL_KEY_V1?: string;
  readonly SESSION_SIGNING_KEY?: string;
  readonly ANALYTICS_SALT?: string;
  readonly OWNER_BOOTSTRAP_TOKEN?: string;
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly RESEND_API_KEY?: string;
  readonly RESEND_WEBHOOK_SECRET?: string;
  readonly OPENROUTER_API_KEY?: string;
}

type Bindings = { Bindings: Env };

const app = new Hono<Bindings>();

/* ------------------------------------------------------------------ *
 * Content-Security-Policy
 * ------------------------------------------------------------------ */

/**
 * The page inlines one stylesheet and one theme script, so the policy carries their
 * hashes rather than `unsafe-inline`. The hashes are computed from the very constants
 * the page renders, so there is no duplicated literal to drift out of step.
 *
 * Two variants of each are included: the bare constant, and the constant surrounded by
 * the indentation the template literal in `shell.ts` currently emits. A browser matches
 * the exact bytes between the tags, and which of the two those are depends on a detail
 * of formatting that a reformat could silently change. Covering both means a reindent
 * cannot ship a page whose styles the browser refuses to apply. The padded variants come
 * out once `shell.ts` emits `<style>${raw(CSS)}</style>` with no surrounding whitespace
 * and the test asserting that is in place.
 */
const SHELL_PADDING = { before: '\n      ', after: '\n    ' } as const;

let cspPromise: Promise<string> | null = null;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function buildCsp(): Promise<string> {
  const variants = (body: string) => [body, `${SHELL_PADDING.before}${body}${SHELL_PADDING.after}`];
  const [styleHashes, scriptHashes] = await Promise.all([
    Promise.all(variants(CSS).map(sha256Base64)),
    Promise.all(variants(THEME_SCRIPT).map(sha256Base64)),
  ]);
  const quote = (hashes: string[]) => hashes.map((h) => `'sha256-${h}'`).join(' ');

  return [
    // Nothing loads from anywhere unless a directive below says otherwise.
    "default-src 'none'",
    // The inline <style> block is allowed only by its hash; no injected stylesheet loads.
    `style-src ${quote(styleHashes)}`,
    `style-src-elem ${quote(styleHashes)}`,
    // No inline style attributes at all.
    //
    // This started as a concession. A strict policy blocked `style="width:33%"` on the
    // demo page's verification-rate meter, so the fill fell back to its full width and a
    // 33% rate DISPLAYED AS 100% — on the page written to argue that a partial result must
    // never look like a pass. The markup was correct throughout; only a screenshot showed
    // it. Rather than keep the exception, the geometry moved to predefined fill classes
    // that round DOWN: 33% draws as 30, 99% draws as 95, and only a true 100% fills the
    // bar. A bar that errs generous is worse than one that errs mean.
    "style-src-attr 'none'",
    `script-src ${quote(scriptHashes)}`,
    `script-src-elem ${quote(scriptHashes)}`,
    // No inline event handlers anywhere. This one is not a concession.
    "script-src-attr 'none'",
    // The favicon is a same-origin SVG served from the assets binding.
    "img-src 'self' data:",
    "font-src 'self'",
    // Forms post back to us and nowhere else.
    "form-action 'self'",
    "base-uri 'none'",
    // No third party may frame the application.
    "frame-ancestors 'none'",
    // Stripe's hosted checkout and billing portal are full-page redirects, which
    // `form-action 'self'` does not cover and `connect-src` does not gate.
    "connect-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

function csp(): Promise<string> {
  cspPromise ??= buildCsp();
  return cspPromise;
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

/**
 * Security headers on every response, including error responses, because this runs
 * outermost. `Cache-Control` is deliberately NOT set here — a route that has chosen
 * `no-store` for a private page must keep it, and `routes/public/shared.ts` already
 * decides per page.
 */
app.use('*', async (c, next) => {
  await next();

  const headers = c.res.headers;
  if (!headers.has('content-security-policy')) {
    headers.set('content-security-policy', await csp());
  }
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Two years, so the preload list would accept it if the owner ever submits the domain.
  if (c.env.ENVIRONMENT === 'production') {
    headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  }
  // Any response carrying a session cookie must not be shared between viewers.
  const vary = headers.get('vary');
  headers.set('vary', vary === null || vary === '' ? 'Cookie' : `${vary}, Cookie`);
});

/* ------------------------------------------------------------------ *
 * Operational endpoints
 * ------------------------------------------------------------------ */

/**
 * Reports what is actually true rather than a hard-coded "ok": it probes D1 and
 * answers 503 when the database cannot be reached, so an uptime check measures the
 * thing that matters instead of whether the Worker booted.
 */
app.get('/health', async (c) => {
  let database: 'reachable' | 'unreachable' = 'unreachable';
  try {
    await c.env.DB.prepare('SELECT 1').first();
    database = 'reachable';
  } catch {
    database = 'unreachable';
  }
  return c.json(
    {
      service: 'itisyou-verify',
      environment: c.env.ENVIRONMENT,
      database,
      checked_at: new Date().toISOString(),
    },
    database === 'reachable' ? 200 : 503,
    { 'cache-control': 'no-store' },
  );
});

/* ------------------------------------------------------------------ *
 * Routers
 * ------------------------------------------------------------------ */

// `/app` first so the customer application cannot be shadowed by a public route.
app.route('/app', appRoutes);

// Owns two prefixes, `/admin` and `/owner`, so it mounts at the root. `/admin/login`
// is deliberately reachable by anyone on the internet; what is protected is every
// privileged action behind it, and an unauthorised request to an owner route returns
// an ordinary 404 rather than a 403 that would confirm the route exists.
//
// The principal is pinned to ANONYMOUS here, and that is load bearing. The in-memory
// port's own default is a fully authenticated platform owner with recent MFA — a
// development convenience that fails OPEN. Mounting it unconfigured served the entire
// owner dashboard to anonymous visitors on staging, which is how this was found: by
// deploying and fetching `/owner`, not by reading the code, where it looks correct.
//
// Until A02's session and TOTP wiring lands, every owner route must 404 for everyone.
// When it does, this becomes `resolvePort: async (c) => new D1OwnerDataPort(c)` and the
// principal comes from the session instead.
app.route(
  '/',
  createOwnerRoutes({
    resolvePort: async () => new MemoryOwnerDataPort({ principal: ANONYMOUS_PRINCIPAL }),
  }),
);

app.route('/', publicRoutes);

/* ------------------------------------------------------------------ *
 * Static assets, then a rendered 404
 * ------------------------------------------------------------------ */

app.notFound(async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) return asset;
  // Rendered here rather than through `page()`: that helper is typed against the
  // routers' narrower `RouteEnv`, and widening it to the Worker's full `Env` would
  // give every page type-level access to the database binding for no reason.
  const body = await render(notFoundPage(new URL(c.req.url).pathname));
  return c.html(body, 404, {
    'cache-control': 'no-store',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
  });
});

app.onError((err, c) => {
  // The cause is logged with the request, never returned. A customer-facing error
  // that leaks an internal identifier is a gift to whoever is probing.
  console.error('unhandled', { path: new URL(c.req.url).pathname, message: String(err) });
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. Please try again.',
        request_id: c.req.header('cf-ray') ?? 'unknown',
      },
    },
    500,
    { 'cache-control': 'no-store' },
  );
});

export default {
  fetch: app.fetch,

  /**
   * The minute tick that will drive the due-job scheduler, the outbox dispatcher and
   * bounded retention deletes. Still a deliberate no-op until the scheduler is mounted —
   * an empty tick is honest; a fabricated one would not be.
   */
  async scheduled(_event: ScheduledController, _env: Env): Promise<void> {
    return;
  },
} satisfies ExportedHandler<Env>;
