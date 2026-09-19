/**
 * Worker entry point.
 *
 * Owns exactly three things: the security headers every response carries, the
 * mounting of the routers each specialist built, and the scheduled tick. Page
 * rendering lives in `routes/`, data access in `db/`, and no business logic is
 * written here.
 */
import { Hono, type Context } from 'hono';
import { CSS, THEME_SCRIPT, render } from '@verify/ui';
import { publicRoutes, notFoundPage } from './routes/public/index.js';
import { storyRoutes } from './routes/public/story/index.js';
import { createAppRoutes } from './routes/app/index.js';
import { createCustomerDataPort, createOwnerDataPort, createOwnerAuth } from './db/index.js';
import { createOwnerRoutes } from './routes/owner/index.js';
import { createRunnerRoutes } from './maintenance/routes.js';
import { createVisitCounter } from './growth/visits.js';
import { createStripeWebhookRoute } from './routes/webhooks/stripe.js';
import { createStripeWebhookDeps } from './billing/mount.js';
import { createStripeClient } from '@verify/connectors/stripe';
import { D1BillingDataPort, createBillingContactLookup } from './db/index.js';
import { newId } from './lib/ids.js';
import { handleScheduled } from './scheduler/index.js';
import { createRetentionSweeper } from './scheduler/retention.js';
import { D1SupportDataPort } from './db/supportPort.js';
import { createNotificationDelivery } from './notifications/delivery.js';
import { D1QualityArtifactStore } from './owner/quality.js';
import { createMoneyRoutes } from './money/index.js';
import { createWorkflowSigningKeyStore } from './db/workflowSigningKeys.js';

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
  /**
   * The verified `From:` address transactional email is sent as. Documented in
   * `.dev.vars.example` since the first commit and never read by anything until the
   * notification transport existed. Without it nothing is sent and every notification is
   * recorded as `no_email_transport_configured`.
   */
  readonly RESEND_FROM_ADDRESS?: string;
  readonly RESEND_WEBHOOK_SECRET?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly STRIPE_PRICE_ID?: string;
  readonly STRIPE_WEBHOOK_PATH_ID?: string;
  readonly STRIPE_WEBHOOK_UNKNOWN_KEY?: string;
  readonly INTERNAL_TEST_TOKEN?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TELEGRAM_OWNER_CHAT_ID?: string;
  /**
   * Root key from which every workflow's event-signing secret is derived, rather than
   * stored. Migration 0002 constrains `credential_versions.owner_scope` to
   * `connection:*` or `user:*`, so a workflow key cannot live there without widening a
   * CHECK constraint; deriving it keeps no ciphertext at rest and makes rotation a new
   * `signing_key_ref`. Absent, `POST /api/v1/events` answers 503 rather than 401 — the
   * fault is ours, and the status says so.
   */
  readonly EVENT_SIGNING_ROOT_KEY?: string;
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
 * Visit counting
 * ------------------------------------------------------------------ */

/**
 * Counts one landing session per visitor per day, for the launch-reach figure.
 *
 * Mounted after the security headers and before the routers so it sees every public
 * request. All of its real work happens in `waitUntil` after the response is sent, so a
 * page render never waits for it, and a failed write never reaches the visitor.
 *
 * `port` is `null` until a D1 growth port exists, which means nothing is counted yet.
 * That is deliberate: A12's in-memory port forgets on every isolate, so mounting it here
 * would report plausible numbers that are silently wrong — worse than reporting nothing,
 * because the founder could not tell the difference.
 *
 * `salt` comes from a Worker secret. Without it nothing is counted at all, because an
 * unsalted hash of an IP address is reversible in seconds and would turn a visit counter
 * into a log of who visited.
 */
let visitCounter: ReturnType<typeof createVisitCounter> | null = null;

app.use('*', async (c, next) => {
  // Built on first request, not at module scope, because the internal-traffic token and
  // the salt are Worker secrets and there is no `env` until a request arrives. Cached per
  // isolate so this costs one construction, not one per visit.
  visitCounter ??= createVisitCounter({
    // `null` until a D1 growth port exists: nothing is counted yet. Deliberate — the
    // in-memory port forgets on every isolate, so mounting it would report plausible
    // numbers that are silently wrong, which is worse than reporting nothing because
    // the founder could not tell the difference.
    port: () => null,
    salt: () => c.env.ANALYTICS_SALT,
    internal: {
      // `null` disables header-based exclusion rather than accepting any value. A
      // permissive fallback would let anyone on the internet remove themselves — or
      // everyone — from the founder's launch figures.
      headerValue: c.env.INTERNAL_TEST_TOKEN ?? null,
      cookieName: 'verify_internal',
    },
    onError: (error) => {
      console.error('visit_counter_failed', { message: String(error) });
    },
  });
  return visitCounter(c, next);
});

/* ------------------------------------------------------------------ *
 * Provider webhooks
 * ------------------------------------------------------------------ */

/**
 * Stripe's signed callbacks. Built lazily per isolate because the dependencies need
 * `c.env`, which does not exist at module scope, and cached because rebuilding them on
 * every delivery would add work to the hottest untrusted path in the system.
 *
 * A construction failure means a billing secret is missing. That answers 503 rather than
 * 500: it is a configuration state, not a fault, and the difference matters to whoever is
 * reading the log at the time. The reason is logged and never returned — an error body
 * that names which secret is absent tells an attacker what we have.
 *
 * Mounted before the routers, and nothing parses the body before it: the route reads the
 * raw bytes itself and verifies the signature against them, which is the only thing that
 * makes the signature mean anything.
 */
let stripeWebhookApp: Hono | null = null;
let stripeWebhookUnavailable: string | null = null;

app.all('/api/v1/webhooks/stripe/*', async (c) => {
  if (stripeWebhookApp === null && stripeWebhookUnavailable === null) {
    try {
      stripeWebhookApp = createStripeWebhookRoute({
        ...createStripeWebhookDeps(
          c.env as never,
          {
            data: new D1BillingDataPort(c.env.DB),
            gateway: createStripeClient({ secretKey: c.env.STRIPE_SECRET_KEY ?? '' }),
            billingContact: createBillingContactLookup(c.env.DB),
            newId: (prefix: string) => newId(prefix),
          } as never,
        ),
        // The wire that was missing. Without it `handleStripeEvent` still builds the
        // `payment_problem` notification for a failed renewal and the route still drops
        // it, which is how twelve correct, tested templates reached no customer.
        //
        // `createNotificationDelivery` returns a working collaborator whether or not
        // `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` are set: unset, every notification is
        // still claimed and recorded as `no_email_transport_configured`, which is visible
        // in the owner's queue. "Recorded as not sent" and "never happened" are different
        // states and only the first can be fixed.
        notifications: createNotificationDelivery(c.env, new D1SupportDataPort(c.env.DB)),
      });
    } catch (error) {
      stripeWebhookUnavailable = String(error);
      console.error('stripe_webhook_unconfigured', { message: stripeWebhookUnavailable });
    }
  }

  if (stripeWebhookApp === null) {
    return c.json(
      {
        error: {
          code: 'BILLING_NOT_CONFIGURED',
          message: 'Billing is not configured on this deployment.',
          request_id: c.req.header('cf-ray') ?? 'unknown',
        },
      },
      503,
      { 'cache-control': 'no-store' },
    );
  }

  return stripeWebhookApp.fetch(c.req.raw, c.env, c.executionCtx);
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
//
// Wired to real D1 rather than the synthetic port. A synthetic workspace served at a
// URL that implies it is YOURS is the same family of mistake as the owner panel's
// fail-open default: it shows data where authentication belongs. The demonstration
// lives at /demo, which is labelled as synthetic and says so on every row.
//
// With no email transport configured, sign-in honestly refuses and every page says
// why. An empty, truthful application beats a populated, misleading one.
app.route(
  '/app',
  createAppRoutes(async (c) => createCustomerDataPort(c)),
);

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
// Device-signed runner endpoints. Mounted BEFORE the owner router so /api/v1/runner/*
// is never swallowed by it. /pair, /lease, /heartbeat and /jobs/:id/result authenticate
// with an Ed25519 device signature rather than a session, which is the whole point: the
// runner polls outbound from the owner's own machine and holds no browser session.
app.route('/api/v1/runner', createRunnerRoutes({ db: (c) => (c.env as Env).DB }));

/**
 * `POST /api/v1/events` — the intake this product is named for.
 *
 * It did not exist until 19 September 2026, and the reason is worth keeping: the schema
 * had carried `workflows.signing_key_hash` and `signing_key_ref` since migration 0001 and
 * `setSigningKey` had existed to write them, but nothing ever called it. No customer could
 * hold a key, so no signed request could be verified, so there was no route to build. The
 * intake was missing one layer below where anyone was looking.
 *
 * Built lazily per isolate and cached, exactly as the Stripe webhook block above is, so a
 * cold start pays for it once. The gateway is constructed from whatever key is present —
 * including none — because admission is a pure read of our own tables and never calls the
 * provider; an unconfigured deployment still admits and refuses events correctly.
 */
let moneyApp: Hono | null = null;

app.all('/api/v1/events', async (c) => {
  if (moneyApp === null) {
    const secretKey = (c.env as Env).STRIPE_SECRET_KEY ?? '';
    moneyApp = createMoneyRoutes(c.env as never, {
      // Admission is a pure read of our own tables and never calls the provider, so the
      // events path needs a gateway only to satisfy the billing runtime's type. The
      // module documented an empty key as safe here; it is not — `createStripeClient`
      // throws on a missing key, and mounting it unconditionally turned every request to
      // the intake into a 500 on any deployment without Stripe configured. That was not
      // caught by its tests because they construct the runtime directly and never take
      // this branch. So the client is built only when a key exists, and its absence is
      // represented by an object that fails loudly if the assumption ever stops holding.
      gateway:
        secretKey.length > 0
          ? createStripeClient({ secretKey })
          : (new Proxy(
              {},
              {
                get(_target, property) {
                  return () => {
                    throw new Error(
                      `billing gateway called (${String(property)}) with no STRIPE_SECRET_KEY: ` +
                        'the events path is supposed to read our own tables only. If this ' +
                        'throws, admission has grown a provider call and needs a real client.',
                    );
                  };
                },
              },
            ) as never),
      signingKeyStore: createWorkflowSigningKeyStore(c.env.DB as never),
      log: (entry) => {
        // eslint-disable-next-line no-console -- one structured line per admitted event;
        // this is the only record of intake in production and Workers logs are the sink.
        console.log('events', entry);
      },
    }) as unknown as Hono;
  }
  return moneyApp.fetch(c.req.raw, c.env, c.executionCtx);
});

let ownerApp: ReturnType<typeof createOwnerRoutes> | null = null;

app.all('/owner/*', ownerRoute);
app.all('/owner', ownerRoute);
app.all('/admin/*', ownerRoute);
app.all('/admin', ownerRoute);

async function ownerRoute(c: Context<Bindings>): Promise<Response> {
  // Built on first request, not at module scope, because both the data port and the auth
  // port need `env` and there is no `env` until a request arrives. Cached per isolate, so
  // this costs one construction rather than one per request.
  ownerApp ??= createOwnerRoutes({
    // Real D1 and real authentication: magic link, TOTP, recovery codes, and a bootstrap
    // that closes itself by writing an owner rather than by remembering to delete a
    // secret.
    //
    // Passing `environment` is what makes an unconfigured production deploy throw at
    // construction instead of quietly serving something. The in-memory port's default
    // principal used to be a fully authenticated owner, which served this whole dashboard
    // to anonymous visitors on staging — the access control was correct and its tests
    // passed, because they all constructed an anonymous principal explicitly. The default
    // was what failed, and only a live request showed it.
    environment: c.env.ENVIRONMENT,
    resolvePort: async (ctx) => createOwnerDataPort(ctx),
    // The evidence pack lives in D1, not in the asset directory. apps/app/public is
    // served to anyone, and these reports name failing case ids and internal paths —
    // publishing them there would make "authenticated download" a fiction.
    resolveArtifacts: async (ctx) => new D1QualityArtifactStore((ctx.env as Env).DB),
    auth: createOwnerAuth(c),
  });
  return ownerApp.fetch(c.req.raw, c.env, c.executionCtx);
}

app.route('/', storyRoutes);

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
  /**
   * The minute tick: the due-job scheduler, the outbox dispatcher and bounded retention.
   *
   * `handleScheduled` resolves for every outcome including failure, deliberately — a
   * rejected scheduled handler buys a retry we cannot bound, and an unbounded retry on a
   * cron is how a quiet bug becomes a bill. The outcome is read from the report instead.
   *
   * Retention gets its sweeper explicitly. Omitted, retention is skipped rather than
   * faked — the same rule as everywhere else here: not doing something is honest,
   * pretending to do it is not.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const report = await handleScheduled(env, {
      now: new Date(event.scheduledTime),
      sweeper: createRetentionSweeper(new D1SupportDataPort(env.DB)),
    });

    // One structured line per tick. A tick that did nothing still says so, because a
    // silent scheduler and a stopped scheduler look identical in a log.
    console.log('scheduler_tick', {
      runs_claimed: report.runs?.claimed ?? 0,
      runs_observed: report.runs?.observed ?? 0,
      runs_terminal: report.runs?.terminal ?? 0,
      calls_made: report.runs?.callsMade ?? 0,
      coverage_warnings: report.runs?.coverageWarnings ?? 0,
      outbox_dispatched: report.outbox?.dispatched ?? 0,
      retention_removed: report.retention?.removed ?? 0,
      // The billing-maintenance and notification pass. `billing_skipped` naming a reason
      // is the difference between a deployment that chose not to run it and one where it
      // is quietly broken — the two look identical without this line.
      billing_skipped: report.billing?.skipped ?? null,
      billing_suspended: report.billing?.maintenance?.recoverySweep?.suspended.length ?? 0,
      notifications_sent: report.billing?.delivery?.sent ?? 0,
      notifications_duplicate: report.billing?.delivery?.duplicates ?? 0,
      notifications_suppressed: report.billing?.delivery?.suppressed ?? 0,
      notifications_failed: report.billing?.delivery?.failed ?? 0,
      billing_failures: report.billing?.failures.length ?? 0,
      error: report.error ?? null,
    });
  },
} satisfies ExportedHandler<Env>;
