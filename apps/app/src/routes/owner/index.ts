/**
 * The owner router — `/admin` and `/owner`.
 *
 * Mount it at the root, because it owns two prefixes:
 *
 *     import { createOwnerRoutes } from './routes/owner/index.js';
 *     app.route('/', createOwnerRoutes());
 *
 * and, once A02's repositories are wired to `OwnerDataPort`:
 *
 *     app.route('/', createOwnerRoutes({ resolvePort: async (c) => new D1OwnerDataPort(c) }));
 *
 * ## The shape every route follows
 *
 * 1. Resolve the port and the principal.
 * 2. `authorise(principal, capability, now)` — and answer its refusal verbatim. A refusal
 *    of `not_found` renders the ordinary 404 page with no hint that this address is
 *    administrative. Nothing below step 2 runs for an unauthorised request: not a database
 *    read, not a CSRF check, not a log line naming the route.
 * 3. For a mutation, both halves of CSRF — the double-submit token **and** the
 *    `Origin`/`Referer` check. A10's T-OWN-03 asks for both together, so they are one
 *    helper here and neither can be applied without the other.
 * 4. Do the thing, through the port, which re-checks the capability itself.
 * 5. POST-redirect-GET on success. A failure re-renders at 422 with the reason, and a
 *    blocked action re-renders with the dependency — never a redirect that implies it
 *    worked.
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AccessMode } from '@verify/contracts';
import { csrfCookieName, isSameOriginRequest, validateCsrfToken } from '@verify/security';
import {
  ANONYMOUS_PRINCIPAL,
  authorise,
  describeAccessMode,
  type OwnerCapability,
  type OwnerPrincipal,
} from '../../owner/access.js';
import { bootstrapOwner, type BootstrapResult } from '../../owner/bootstrap.js';
import { isControlKey } from '../../owner/controls.js';
import { approvalStanding, isOwnerActionType } from '../../owner/approvals.js';

/**
 * The maintenance kinds this panel offers as a one-press button.
 *
 * A08's vocabulary is wider; these are the ones whose payload has no required fields, so a
 * button can genuinely supply everything they need. A coding-agent job needs a reviewed
 * brief and belongs on its own screen, and a release needs a bound approval — neither is
 * something a single button should be able to start.
 */
const OWNER_DISPATCHABLE_JOB_KINDS: ReadonlySet<string> = new Set([
  'run_health_checks',
  'collect_redacted_diagnostics',
]);
import { MemoryOwnerDataPort } from '../../owner/memory.js';
import { PairingUnavailable, type RunnerPairingPort } from '../../owner/runner.js';
import {
  artifactMeta,
  isQualityArtifactId,
  UnboundQualityArtifactStore,
  type QualityArtifactStore,
} from '../../owner/quality.js';
import {
  DEFAULT_ACCESS_MODE,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_BUSINESS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_PRICING,
  DEFAULT_RETENTION,
  SETTINGS_KEY,
  parseMinorUnits,
  validateBusiness,
  validatePricing,
  validateRetention,
  type BudgetLimitSettings,
  type BusinessDetails,
  type NotificationSettings,
  type PricingSettings,
  type RetentionSettings,
} from '../../owner/settings.js';
import type { ActionContext, OwnerDataPort } from '../../owner/port.js';
import type { CleanupInventory } from '../../owner/cleanup.js';
import type { RouteBindings } from '../public/shared.js';
import {
  ActionForm,
  OwnerLayout,
  ownerNotFoundPage,
  ownerPage,
  mfaRequiredPage,
  PageHead,
  readForm,
  type OwnerForm,
} from './chrome.js';
import { adminLoginDocument, bootstrapDocument } from './adminPages.js';
import {
  ConnectionsPage,
  CustomersPage,
  OverviewPage,
  VerificationDetailPage,
  VerificationListPage,
} from './dashboardPages.js';
import { AdsPage, ApprovalsPage } from './adsPages.js';
import { ControlsPage, OperationsPage, SettingsPage } from './opsPages.js';
import { CleanupPage, QualityPage } from './qualityPages.js';
import { Button, Callout, html } from '@verify/ui';

/* --------------------------------------------------------------------- the ports */

export type OwnerPortResolver = (c: Context<RouteBindings>) => Promise<OwnerDataPort>;

export interface TotpResult {
  readonly ok: boolean;
  /** Non-null when the check could not be performed at all. Shown as a dependency. */
  readonly dependency: string | null;
}

/**
 * Authentication actions the panel triggers but does not own. A02 owns magic links,
 * sessions and TOTP; the bootstrap decision is `owner/bootstrap.ts`'s, and this port only
 * supplies it with the deployment's own facts.
 */
export interface OwnerAuthPort {
  /** Always returns. Never reveals whether the address has an account. */
  requestSignInLink(email: string): Promise<{ readonly delivery: 'sent' | 'no_transport' }>;
  verifyTotp(principal: OwnerPrincipal, code: string, now: Date): Promise<TotpResult>;
  bootstrap(
    input: { readonly presentedToken: string; readonly verifiedAuthSubject: string | null },
    now: Date,
  ): Promise<BootstrapResult>;
  signOut(principal: OwnerPrincipal): Promise<void>;
  accessMode(): Promise<AccessMode>;
}

/**
 * The honest default until A02's identity path is wired: it accepts a sign-in request and
 * does nothing with it, and it tells the truth about the TOTP check rather than pretending
 * a wrong code was entered.
 */
export class UnwiredOwnerAuth implements OwnerAuthPort {
  async requestSignInLink(): Promise<{ readonly delivery: 'sent' | 'no_transport' }> {
    // This port is unwired by definition, so nothing was sent, and it says so. Returning
    // `sent` here would reproduce the exact defect the real port was just fixed for.
    return { delivery: 'no_transport' };
  }

  async verifyTotp(): Promise<TotpResult> {
    return {
      ok: false,
      dependency:
        'Two-factor checking is not wired to this deployment yet, so this code cannot be verified. Nothing has been ' +
        'accepted — you have not been let through on a guess.',
    };
  }

  async bootstrap(): Promise<BootstrapResult> {
    return {
      ok: false,
      refusal: 'not_configured',
      message:
        'This deployment carries no owner bootstrap secret, so there is nothing to bootstrap from.',
    };
  }

  async signOut(): Promise<void> {
    /* Session revocation is A02's. */
  }

  async accessMode(): Promise<AccessMode> {
    return DEFAULT_ACCESS_MODE.mode;
  }
}

/**
 * The wiring point for the real bootstrap, once A02's user repository is available.
 *
 * It exists so `bootstrapOwner`'s four conditions are composed in exactly one place: the
 * lead supplies the deployment's secrets and the two database operations, and gets back an
 * `OwnerAuthPort['bootstrap']` that cannot be assembled wrongly.
 */
export function bootstrapHandler(deps: {
  readonly configuredToken: string | null;
  readonly configuredEmail: string | null;
  readonly platformOwnerExists: () => Promise<boolean>;
  readonly promote: (authSubject: string) => Promise<string>;
  readonly recordAudit: (entry: {
    readonly action: string;
    readonly actor: string;
    readonly outcome: string;
    readonly occurredAt: string;
  }) => Promise<void>;
}): OwnerAuthPort['bootstrap'] {
  return async (input, now) =>
    bootstrapOwner(input, {
      configuredToken: deps.configuredToken,
      configuredEmail: deps.configuredEmail,
      platformOwnerExists: deps.platformOwnerExists,
      promote: deps.promote,
      recordAudit: deps.recordAudit,
      now,
    });
}

export interface OwnerRouterOptions {
  readonly resolvePort?: OwnerPortResolver;
  readonly artifacts?: QualityArtifactStore;
  /**
   * Resolved per request, for a store that needs a binding — `D1QualityArtifactStore` needs
   * `env.DB`, and the router is constructed at module scope where no binding exists. Takes
   * precedence over `artifacts`.
   */
  readonly resolveArtifacts?: (c: Context<RouteBindings>) => Promise<QualityArtifactStore>;
  readonly auth?: OwnerAuthPort;
  /**
   * Resolved per request, like `resolvePort`, because pairing needs the database and the
   * router is constructed once at module scope where no binding exists yet.
   */
  readonly resolvePairing?: (c: Context<RouteBindings>) => Promise<RunnerPairingPort>;
  readonly now?: () => Date;
  /**
   * The deployment this router is being constructed for. Supply it and an unconfigured
   * mount in production throws here rather than serving anything — see the note below.
   */
  readonly environment?: string;
}

/** Thrown at construction when a production mount has no real data source behind it. */
export class UnconfiguredOwnerRouterError extends Error {
  constructor() {
    super(
      'createOwnerRoutes() was constructed for production with no resolvePort. The in-memory ' +
        'port is a development stand-in and must never back a production deployment. Pass ' +
        'resolvePort, or do not mount the owner router here.',
    );
    this.name = 'UnconfiguredOwnerRouterError';
  }
}

/* ------------------------------------------------------------------- the router */

export function createOwnerRoutes(options: OwnerRouterOptions = {}): Hono<RouteBindings> {
  const routes = new Hono<RouteBindings>();

  /**
   * Refuse to exist in production without a real data source.
   *
   * A loud failure at deploy beats a quiet one in the wild. The in-memory port is a
   * development stand-in; behind a production mount it would render invented customers and
   * invented money as though they were the business.
   */
  const usingDefaultPort = options.resolvePort === undefined;
  if (usingDefaultPort && options.environment === 'production') {
    throw new UnconfiguredOwnerRouterError();
  }

  const resolvePort: OwnerPortResolver =
    options.resolvePort ?? (async () => new MemoryOwnerDataPort());
  const staticArtifacts: QualityArtifactStore =
    options.artifacts ?? new UnboundQualityArtifactStore();
  const resolveArtifacts = options.resolveArtifacts ?? (async () => staticArtifacts);
  const auth: OwnerAuthPort = options.auth ?? new UnwiredOwnerAuth();
  const resolvePairing = options.resolvePairing ?? (async () => new PairingUnavailable());
  const clock = options.now ?? (() => new Date());

  /** The whole page shell for an authenticated screen. */
  function shell(
    port: OwnerDataPort,
    principal: OwnerPrincipal,
    pageOptions: {
      readonly title: string;
      readonly path: string;
      readonly body: ReturnType<typeof html>;
    },
  ) {
    return OwnerLayout({
      title: pageOptions.title,
      path: pageOptions.path,
      body: pageOptions.body,
      synthetic: port.synthetic,
      automation: principal.isAutomation,
      ...(principal.email === null ? {} : { accountLabel: principal.email }),
      csrfToken: principal.csrfToken,
    });
  }

  async function principalOf(
    c: Context<RouteBindings>,
  ): Promise<{ port: OwnerDataPort; principal: OwnerPrincipal }> {
    // The backstop for a mount that did not pass `environment`. Throwing here surfaces as a
    // 500 from the Worker's error handler, which is the right answer: a production owner
    // panel backed by invented data must not render at all. `/admin/login` does not resolve
    // a port, so the way back in stays reachable.
    if (usingDefaultPort && c.env.ENVIRONMENT === 'production') {
      throw new UnconfiguredOwnerRouterError();
    }
    const port = await resolvePort(c);
    let principal: OwnerPrincipal;
    try {
      principal = await port.principal();
    } catch {
      principal = ANONYMOUS_PRINCIPAL;
    }
    return { port, principal };
  }

  /** The 404 everything unauthorised gets. Identical for every refused address. */
  async function refuseNotFound(c: Context<RouteBindings>): Promise<Response> {
    return ownerPage(c, ownerNotFoundPage(new URL(c.req.url).pathname), 404);
  }

  /**
   * Both halves of the CSRF defence, applied together and never separately. Returns null
   * when the request is genuine.
   */
  function csrfProblem(c: Context<RouteBindings>, form: OwnerForm): string | null {
    const url = new URL(c.req.url);
    const secure = url.protocol === 'https:';
    const cookie = getCookie(c, csrfCookieName(secure)) ?? null;
    const submitted = form.single['csrf_token'] ?? null;
    if (!validateCsrfToken(cookie, submitted)) {
      return 'This form was submitted without a valid token. Reload the page and try again.';
    }
    if (!isSameOriginRequest(c.req.raw, url.origin)) {
      return 'This form was submitted from somewhere else. Nothing was changed.';
    }
    return null;
  }

  function actionContext(
    principal: OwnerPrincipal,
    capability: OwnerCapability,
    c: Context<RouteBindings>,
  ): ActionContext {
    return {
      principal,
      capability,
      now: clock(),
      requestId: c.req.header('x-request-id') ?? 'owner',
    };
  }

  /**
   * Every authenticated GET runs through this. The order — 404 first, everything else
   * after — is the whole point.
   */
  async function withView(
    c: Context<RouteBindings>,
    capability: OwnerCapability,
    render: (port: OwnerDataPort, principal: OwnerPrincipal) => Promise<Response>,
  ): Promise<Response> {
    const { port, principal } = await principalOf(c);
    const decision = authorise(principal, capability, clock());
    if (!decision.ok) {
      if (decision.refusal === 'not_found') return refuseNotFound(c);
      if (decision.refusal === 'mfa_required') {
        return ownerPage(
          c,
          mfaRequiredPage({
            path: new URL(c.req.url).pathname,
            detail: decision.detail,
            csrfToken: principal.csrfToken,
            returnTo: new URL(c.req.url).pathname,
          }),
          403,
        );
      }
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Not permitted',
          path: new URL(c.req.url).pathname,
          body: html`<div class="wrap section stack">
            ${PageHead({ title: 'This identity cannot do that' })}
            ${Callout({ tone: 'warn', title: 'Refused', body: html`<p data-refusal="capability_denied">${decision.detail}</p>` })}
          </div>`,
        }),
        403,
      );
    }
    // The double-submit cookie is set on every authenticated GET so the forms on the page
    // have a matching half. A02 owns the session cookie; this one is only the CSRF pair.
    const secure = new URL(c.req.url).protocol === 'https:';
    if (principal.csrfToken.length > 0) {
      setCookie(c, csrfCookieName(secure), principal.csrfToken, {
        path: '/',
        sameSite: 'Lax',
        maxAge: 43200,
        secure,
      });
    }
    return render(port, principal);
  }

  /** Every mutation. Authorise, then CSRF, then act. */
  async function withAction(
    c: Context<RouteBindings>,
    capability: OwnerCapability,
    act: (port: OwnerDataPort, principal: OwnerPrincipal, form: OwnerForm) => Promise<Response>,
  ): Promise<Response> {
    const { port, principal } = await principalOf(c);
    const decision = authorise(principal, capability, clock());
    if (!decision.ok) {
      if (decision.refusal === 'not_found') return refuseNotFound(c);
      if (decision.refusal === 'mfa_required') {
        return ownerPage(
          c,
          mfaRequiredPage({
            path: new URL(c.req.url).pathname,
            detail: decision.detail,
            csrfToken: principal.csrfToken,
            returnTo: c.req.header('referer') ?? '/owner',
          }),
          403,
        );
      }
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Not permitted',
          path: new URL(c.req.url).pathname,
          body: html`<div class="wrap section stack">
            ${PageHead({ title: 'This identity cannot do that' })}
            ${Callout({ tone: 'warn', title: 'Refused', body: html`<p data-refusal="capability_denied">${decision.detail}</p>` })}
          </div>`,
        }),
        403,
      );
    }

    const form = await readForm(c);
    const problem = csrfProblem(c, form);
    if (problem !== null) {
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Not saved',
          path: new URL(c.req.url).pathname,
          body: html`<div class="wrap section stack">
            ${PageHead({ title: 'That did not go through' })}
            ${Callout({ tone: 'warn', title: 'Nothing was changed', body: html`<p data-csrf-error="true">${problem}</p>` })}
          </div>`,
        }),
        403,
      );
    }

    return act(port, principal, form);
  }

  /** A write result turned into a response: redirect, dependency, or re-render. */
  async function respondToWrite(
    c: Context<RouteBindings>,
    port: OwnerDataPort,
    principal: OwnerPrincipal,
    result: {
      readonly ok: boolean;
      readonly message: string | null;
      readonly redirectTo: string | null;
      readonly dependency: string | null;
    },
    fallbackTitle: string,
  ): Promise<Response> {
    if (result.ok && result.redirectTo !== null) return c.redirect(result.redirectTo, 303);
    const path = new URL(c.req.url).pathname;
    return ownerPage(
      c,
      shell(port, principal, {
        title: fallbackTitle,
        path,
        body: html`<div class="wrap section stack">
          ${PageHead({ title: fallbackTitle })}
          ${
            result.dependency === null
              ? null
              : Callout({
                  tone: 'warn',
                  title: 'Something this needs is not there',
                  body: html`<p data-dependency="true">${result.dependency}</p>`,
                })
          }
          ${
            result.message === null
              ? null
              : Callout({
                  tone: 'note',
                  title: 'What happened',
                  body: html`<p>${result.message}</p>`,
                })
          }
          <p><a href="/owner">Back to the overview</a></p>
        </div>`,
      }),
      result.ok ? 200 : 422,
    );
  }

  /* ------------------------------------------------------------------- /admin */

  routes.get('/admin', async (c) => {
    const { principal } = await principalOf(c);
    const decision = authorise(principal, 'owner.view', clock());
    if (decision.ok) return c.redirect('/owner', 303);
    return c.redirect('/admin/login', 303);
  });

  routes.get('/admin/login', async (c) =>
    ownerPage(
      c,
      adminLoginDocument({
        csrfToken: newPageToken(c),
        submitted: false,
        fieldError: null,
        email: '',
      }),
    ),
  );

  /**
   * Every submission gets the one acknowledgement sentence, at status 200, whether the address
   * exists, is the owner's, is a customer's or is nobody's. There is deliberately no branch
   * here that could produce a different page for a different address.
   */
  routes.post('/admin/login', async (c) => {
    const form = await readForm(c);
    const email = (form.single['email'] ?? '').trim().slice(0, 254);
    const looksLikeAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    // What the deployment did, not what we would like it to have done. The answer still
    // does not vary with the address -- only with whether this deployment can send at all.
    const outcome = looksLikeAddress
      ? await auth.requestSignInLink(email.toLowerCase())
      : { delivery: 'no_transport' as const };
    return ownerPage(
      c,
      adminLoginDocument({
        csrfToken: newPageToken(c),
        submitted: looksLikeAddress,
        delivery: outcome.delivery,
        fieldError: looksLikeAddress ? null : 'Enter an email address.',
        email,
      }),
      looksLikeAddress ? 200 : 422,
    );
  });

  routes.get('/admin/bootstrap', async (c) => {
    const { principal } = await principalOf(c);
    return ownerPage(
      c,
      bootstrapDocument({
        csrfToken: principal.csrfToken.length > 0 ? principal.csrfToken : newPageToken(c),
        verifiedSubject: principal.email,
        refusal: null,
      }),
    );
  });

  routes.post('/admin/bootstrap', async (c) => {
    const { principal } = await principalOf(c);
    const form = await readForm(c);
    const result = await auth.bootstrap(
      { presentedToken: form.single['token'] ?? '', verifiedAuthSubject: principal.email },
      clock(),
    );
    if (result.ok) return c.redirect('/owner', 303);
    return ownerPage(
      c,
      bootstrapDocument({
        csrfToken: principal.csrfToken.length > 0 ? principal.csrfToken : newPageToken(c),
        verifiedSubject: principal.email,
        refusal: result.message,
      }),
      403,
    );
  });

  routes.post('/admin/verify', async (c) => {
    const { port, principal } = await principalOf(c);
    const form = await readForm(c);
    const result = await auth.verifyTotp(principal, form.single['totp'] ?? '', clock());
    const returnTo = form.single['return_to'] ?? '/owner';
    if (result.ok) return c.redirect(returnTo.startsWith('/owner') ? returnTo : '/owner', 303);
    return respondToWrite(
      c,
      port,
      principal,
      {
        ok: false,
        message:
          result.dependency === null ? 'That code was not accepted. Nothing has changed.' : null,
        redirectTo: null,
        dependency: result.dependency,
      },
      'Confirm it is you',
    );
  });

  routes.post('/admin/sign-out', async (c) => {
    const { principal } = await principalOf(c);
    await auth.signOut(principal);
    return c.redirect('/admin/login', 303);
  });

  /* ------------------------------------------------------------------- /owner */

  routes.get('/owner', async (c) =>
    withView(c, 'owner.view', async (port, principal) => {
      const now = clock();
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Overview',
          path: '/owner',
          body: OverviewPage({ view: await port.overview(now), now }),
        }),
      );
    }),
  );

  /* customers */

  routes.get('/owner/customers', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Customers',
          path: '/owner/customers',
          body: CustomersPage({
            customers: await port.customers(),
            exceptions: await port.exceptions(),
            csrfToken: principal.csrfToken,
          }),
        }),
      ),
    ),
  );

  routes.post('/owner/customers/:workspaceId/cancel', async (c) =>
    withAction(c, 'customer.reject', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.cancelSubscription(
          actionContext(principal, 'customer.reject', c),
          c.req.param('workspaceId'),
        ),
        'Cancel subscription',
      ),
    ),
  );

  routes.post('/owner/orders/:orderId/reject', async (c) =>
    withAction(c, 'customer.reject', async (port, principal, form) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.rejectBeforeCheckout(
          actionContext(principal, 'customer.reject', c),
          c.req.param('orderId'),
          form.single['reason'] ?? '',
        ),
        'Reject order',
      ),
    ),
  );

  routes.post('/owner/refunds', async (c) =>
    withAction(c, 'refund.issue', async (port, principal, form) => {
      const amountMinor = parseMinorUnits(form.single['amount'] ?? '');
      if (amountMinor === null) {
        return respondToWrite(
          c,
          port,
          principal,
          { ok: false, message: 'Enter an amount like 12.00.', redirectTo: null, dependency: null },
          'Issue refund',
        );
      }
      return respondToWrite(
        c,
        port,
        principal,
        await port.issueRefund(actionContext(principal, 'refund.issue', c), {
          workspaceId: form.single['workspace_id'] ?? '',
          orderId: form.single['order_id'] ?? '',
          amountMinor,
          policyRule: form.single['policy_rule'] ?? '',
          reason: form.single['reason'] ?? '',
          approvalId: form.single['approval_id'] ?? '',
        }),
        'Issue refund',
      );
    }),
  );

  /* verification */

  routes.get('/owner/verification', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Verification',
          path: '/owner/verification',
          body: VerificationListPage({ runs: await port.recentRuns(50) }),
        }),
      ),
    ),
  );

  routes.get('/owner/verification/:runId', async (c) =>
    withView(c, 'owner.view', async (port, principal) => {
      const run = await port.run(c.req.param('runId'));
      if (run === null) return refuseNotFound(c);
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Run',
          path: '/owner/verification',
          body: VerificationDetailPage({ run, csrfToken: principal.csrfToken }),
        }),
      );
    }),
  );

  routes.post('/owner/verification/:runId/retry', async (c) =>
    withAction(c, 'verification.retry', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.retryRun(
          actionContext(principal, 'verification.retry', c),
          c.req.param('runId'),
        ),
        'Check again',
      ),
    ),
  );

  /* connections */

  routes.get('/owner/connections', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Connections',
          path: '/owner/connections',
          body: ConnectionsPage({
            connections: await port.connections(),
            csrfToken: principal.csrfToken,
          }),
        }),
      ),
    ),
  );

  routes.post('/owner/connections/:id/rotate', async (c) =>
    withAction(c, 'connection.rotate', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.rotateConnection(
          actionContext(principal, 'connection.rotate', c),
          c.req.param('id'),
        ),
        'Rotate connection',
      ),
    ),
  );

  routes.post('/owner/connections/:id/revoke', async (c) =>
    withAction(c, 'connection.revoke', async (port, principal, form) => {
      if ((form.single['confirm'] ?? '').trim().toLowerCase() !== 'revoke') {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message: 'Type "revoke" to confirm. Nothing was changed.',
            redirectTo: null,
            dependency: null,
          },
          'Revoke connection',
        );
      }
      return respondToWrite(
        c,
        port,
        principal,
        await port.revokeConnection(
          actionContext(principal, 'connection.revoke', c),
          c.req.param('id'),
        ),
        'Revoke connection',
      );
    }),
  );

  /* ads */

  routes.get('/owner/ads', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Ads',
          path: '/owner/ads',
          body: AdsPage({
            campaigns: await port.campaigns(),
            csrfToken: principal.csrfToken,
            now: clock(),
          }),
        }),
      ),
    ),
  );

  routes.post('/owner/ads/:id/activate', async (c) =>
    withAction(c, 'ads.activate', async (port, principal, form) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.activateCampaign(
          actionContext(principal, 'ads.activate', c),
          c.req.param('id'),
          form.single['approval_id'] ?? '',
        ),
        'Activate campaign',
      ),
    ),
  );

  routes.post('/owner/ads/:id/pause', async (c) =>
    withAction(c, 'ads.pause', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.pauseCampaign(actionContext(principal, 'ads.pause', c), c.req.param('id')),
        'Pause campaign',
      ),
    ),
  );

  routes.post('/owner/ads/:id/resume', async (c) =>
    withAction(c, 'ads.activate', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.resumeCampaign(actionContext(principal, 'ads.activate', c), c.req.param('id')),
        'Resume campaign',
      ),
    ),
  );

  /* operations */

  routes.get('/owner/operations', async (c) =>
    withView(c, 'owner.view', async (port, principal) => {
      const now = clock();
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Operations',
          path: '/owner/operations',
          body: OperationsPage({
            view: await port.operations(now),
            csrfToken: principal.csrfToken,
            now,
          }),
        }),
      );
    }),
  );

  routes.post('/owner/operations/alerts/:id/acknowledge', async (c) =>
    withAction(c, 'controls.toggle', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.acknowledgeAlert(
          actionContext(principal, 'controls.toggle', c),
          c.req.param('id'),
        ),
        'Acknowledge alert',
      ),
    ),
  );

  /**
   * Open a pairing code for a maintenance runner device.
   *
   * A08's `openPairing` implements no access control of its own — deliberately, so there is
   * exactly one place the gate lives. This is it: `maintenance.dispatch` is consequential,
   * so `authorise()` requires `mfa_verified_at` within the last 15 minutes before a code can
   * be minted. The code lets a machine claim and run maintenance jobs; it is shown once and
   * is never re-displayable.
   */
  routes.post('/owner/operations/runner/pair', async (c) =>
    withAction(c, 'maintenance.dispatch', async (port, principal, form) => {
      const label = (form.single['label'] ?? '').trim().slice(0, 80);
      if (label.length === 0) {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message: 'Give the device a name you will recognise later.',
            redirectTo: null,
            dependency: null,
          },
          'Pair a runner',
        );
      }
      const pairing = await resolvePairing(c);
      const outcome = await pairing.openPairing({
        label,
        ownerId: principal.userId ?? 'unknown',
        now: clock(),
      });
      if (!outcome.ok) {
        return respondToWrite(
          c,
          port,
          principal,
          { ok: false, message: null, redirectTo: null, dependency: outcome.dependency },
          'Pair a runner',
        );
      }
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Pair a runner',
          path: '/owner/operations',
          body: html`<div class="wrap section stack">
            ${PageHead({ title: 'Type this into the runner' })}
            ${Callout({
              tone: 'warn',
              title: 'Shown once, and only once',
              body: html`<p>
                  This code is not stored anywhere we can read it back. If you leave this page without using it,
                  open a new pairing — do not go looking for it.
                </p>
                <p class="mono" data-pairing-code="true">${outcome.invitation.code}</p>
                <p class="small">
                  Device <span class="mono">${outcome.invitation.deviceId}</span>. Expires
                  ${outcome.invitation.expiresAt}.
                </p>`,
            })}
            <p><a href="/owner/operations">Back to operations</a></p>
          </div>`,
        }),
      );
    }),
  );

  /**
   * Queue a whole maintenance job by its typed kind.
   *
   * The kind travels in the path and is matched against A08's closed vocabulary before it
   * reaches anything — there is no field on this page that becomes part of a command, and
   * an unrecognised kind is a 404 rather than a refusal that confirms the route's shape.
   */
  routes.post('/owner/operations/jobs/:kind', async (c) =>
    withAction(c, 'maintenance.dispatch', async (port, principal) => {
      const kind = c.req.param('kind');
      if (!OWNER_DISPATCHABLE_JOB_KINDS.has(kind)) return refuseNotFound(c);
      return respondToWrite(
        c,
        port,
        principal,
        await port.enqueueMaintenance(actionContext(principal, 'maintenance.dispatch', c), kind),
        'Maintenance job',
      );
    }),
  );

  routes.post('/owner/operations/restore', async (c) =>
    withAction(c, 'maintenance.dispatch', async (port, principal, form) => {
      if ((form.single['confirm'] ?? '').trim().toLowerCase() !== 'restore') {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message:
              'Type "restore" to confirm. Restoring replaces the running code; nothing was changed.',
            redirectTo: null,
            dependency: null,
          },
          'Restore deployment',
        );
      }
      // The form has had a `deployment_id` field on it all along and this route never read
      // it. That is worse than not having the field: the refusal below used to say "the
      // deployment id is recorded", which was untrue twice over — nothing read it and
      // nothing wrote it. Read it, require it, and say only what is true.
      const deploymentId = (form.single['deployment_id'] ?? '').trim();
      if (deploymentId.length === 0) {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message:
              'Choose the deployment to restore. Nothing has been restored and nothing has been recorded.',
            redirectTo: null,
            dependency: null,
          },
          'Restore deployment',
        );
      }
      const approvalId = (form.single['approval_id'] ?? '').trim();
      if (approvalId.length === 0) {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message:
              'A restore needs an approval bound to the exact deployment being restored. Grant one on the approvals ' +
              'page and paste its id here. Nothing has been restored.',
            redirectTo: null,
            dependency: null,
          },
          'Restore deployment',
        );
      }
      const approval = await port.approval(approvalId);
      if (approval === null || approvalStanding(approval, clock()) !== 'usable') {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message:
              approval === null
                ? 'There is no approval with that id, so nothing authorises this restore.'
                : `That approval is ${approvalStanding(approval, clock())}. Approve the restore again if you still want it.`,
            redirectTo: null,
            dependency: null,
          },
          'Restore deployment',
        );
      }
      // An approval that is *usable* is not the same as an approval that authorises **this**.
      // `approvalStanding` only asks whether a row is granted and unexpired, so before this
      // check a refund approval — or a cleanup approval — read as "the approval stands" on a
      // page that restores code to every customer. None of the four declared action types
      // covers a release, so any of them appearing here is a mismatch, not an authorisation.
      if (isOwnerActionType(approval.action_type)) {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message:
              `That approval was granted for ${approval.action_type}, which does not authorise replacing the ` +
              'running code. Nothing has been restored and the approval has not been used. No approval type on ' +
              'this deployment binds to a deployment id, so there is at present nothing that can authorise a ' +
              'restore from this page — that is a missing action type, not a mistake you made.',
            redirectTo: null,
            dependency: null,
          },
          'Restore deployment',
        );
      }
      // Everything this route can check has now been checked. What remains is genuinely
      // outstanding, and is stated precisely rather than as "not wired": A08's runner port
      // carries a kind and an idempotency key and no approval id, and
      // `execute_approved_release` is refused without one. The gap is one field.
      //
      // The approval is deliberately **not** consumed here. Consume-before-act protects an
      // action that is about to happen; this one is refused before anything could reach a
      // provider, so spending the approval would burn the owner's authorisation on nothing.
      // The moment the release job can carry an approval id, the consumption belongs
      // immediately above that call — not here.
      return respondToWrite(
        c,
        port,
        principal,
        {
          ok: false,
          message: null,
          redirectTo: null,
          dependency:
            'The approval stands, but the release cannot be queued yet: the release job refuses to be created ' +
            'without a bound approval id, and the runner port this panel calls does not carry one. Nothing has ' +
            'been restored, nothing has been recorded against that deployment, and the approval has not been ' +
            'used — so it is still there when this can actually run. `wrangler rollback` from a machine with ' +
            'deploy access does the same job today.',
        },
        'Restore deployment',
      );
    }),
  );

  /* controls */

  routes.get('/owner/controls', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Controls',
          path: '/owner/controls',
          body: ControlsPage({ controls: await port.controls(), csrfToken: principal.csrfToken }),
        }),
      ),
    ),
  );

  routes.post('/owner/controls/:key', async (c) =>
    withAction(c, 'controls.toggle', async (port, principal, form) => {
      const key = c.req.param('key');
      if (!isControlKey(key)) return refuseNotFound(c);
      const paused = (form.single['paused'] ?? '').toLowerCase() === 'yes';
      const note = (form.single[`note_${key}`] ?? '').trim();
      return respondToWrite(
        c,
        port,
        principal,
        await port.setControl(
          actionContext(principal, 'controls.toggle', c),
          key,
          paused,
          note.length === 0 ? null : note,
        ),
        'Controls',
      );
    }),
  );

  /* approvals */

  routes.get('/owner/approvals', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Approvals',
          path: '/owner/approvals',
          body: ApprovalsPage({
            approvals: await port.approvals(),
            csrfToken: principal.csrfToken,
            now: clock(),
            formError: null,
          }),
        }),
      ),
    ),
  );

  routes.post('/owner/approvals', async (c) =>
    withAction(c, 'approval.grant', async (port, principal, form) => {
      const rawAmount = (form.single['maximum_amount'] ?? '').trim();
      const maximumAmountMinor = rawAmount.length === 0 ? null : parseMinorUnits(rawAmount);
      if (rawAmount.length > 0 && maximumAmountMinor === null) {
        return respondToWrite(
          c,
          port,
          principal,
          {
            ok: false,
            message: 'Enter a maximum like 15.00, or leave it empty.',
            redirectTo: null,
            dependency: null,
          },
          'Approve',
        );
      }
      return respondToWrite(
        c,
        port,
        principal,
        await port.grantApproval(actionContext(principal, 'approval.grant', c), {
          actionType: form.single['action_type'] ?? '',
          payloadJson: form.single['payload_json'] ?? '',
          maximumAmountMinor,
          summary: (form.single['summary'] ?? '').trim(),
        }),
        'Approve',
      );
    }),
  );

  routes.post('/owner/approvals/:id/revoke', async (c) =>
    withAction(c, 'approval.grant', async (port, principal) =>
      respondToWrite(
        c,
        port,
        principal,
        await port.revokeApproval(actionContext(principal, 'approval.grant', c), c.req.param('id')),
        'Withdraw approval',
      ),
    ),
  );

  /* settings */

  async function settingsBody(
    port: OwnerDataPort,
    principal: OwnerPrincipal,
    extras: {
      readonly fieldErrors?: Readonly<Record<string, string>>;
      readonly savedMessage?: string | null;
    } = {},
  ) {
    const raw = await port.readSettings();
    return SettingsPage({
      business: parseJson<BusinessDetails>(raw.businessJson, DEFAULT_BUSINESS),
      pricing: parseJson<PricingSettings>(raw.pricingJson, DEFAULT_PRICING),
      notifications: parseJson<NotificationSettings>(raw.notificationsJson, DEFAULT_NOTIFICATIONS),
      retention: parseJson<RetentionSettings>(raw.retentionJson, DEFAULT_RETENTION),
      budgetLimits: parseJson<BudgetLimitSettings>(raw.budgetLimitsJson, DEFAULT_BUDGET_LIMITS),
      accessMode: parseJson<{ mode: AccessMode }>(raw.accessModeJson, DEFAULT_ACCESS_MODE).mode,
      csrfToken: principal.csrfToken,
      fieldErrors: extras.fieldErrors ?? {},
      savedMessage: extras.savedMessage ?? null,
    });
  }

  routes.get('/owner/settings', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Settings',
          path: '/owner/settings',
          body: await settingsBody(port, principal),
        }),
      ),
    ),
  );

  routes.post('/owner/settings/business', async (c) =>
    withAction(c, 'settings.write', async (port, principal, form) => {
      const { values, errors } = validateBusiness(form.single);
      if (Object.keys(errors).length > 0) {
        return ownerPage(
          c,
          shell(port, principal, {
            title: 'Settings',
            path: '/owner/settings',
            body: await settingsBody(port, principal, { fieldErrors: errors }),
          }),
          422,
        );
      }
      return respondToWrite(
        c,
        port,
        principal,
        await port.writeSetting(
          actionContext(principal, 'settings.write', c),
          SETTINGS_KEY.business,
          JSON.stringify(values),
        ),
        'Settings',
      );
    }),
  );

  routes.post('/owner/settings/pricing', async (c) =>
    withAction(c, 'settings.write', async (port, principal, form) => {
      const { values, errors } = validatePricing({
        monthlyAmount: form.single['monthlyAmount'] ?? '',
        runsIncluded: form.single['runsIncluded'] ?? '',
        stripePriceId: form.single['stripePriceId'] ?? '',
        currency: form.single['currency'] ?? 'GBP',
      });
      if (Object.keys(errors).length > 0) {
        return ownerPage(
          c,
          shell(port, principal, {
            title: 'Settings',
            path: '/owner/settings',
            body: await settingsBody(port, principal, { fieldErrors: errors }),
          }),
          422,
        );
      }
      return respondToWrite(
        c,
        port,
        principal,
        await port.writeSetting(
          actionContext(principal, 'settings.write', c),
          SETTINGS_KEY.pricing,
          JSON.stringify(values),
        ),
        'Settings',
      );
    }),
  );

  routes.post('/owner/settings/notifications', async (c) =>
    withAction(c, 'settings.write', async (port, principal, form) => {
      const digest = Number.parseInt(form.single['digestMinutes'] ?? '', 10);
      const values: NotificationSettings = {
        ownerEmail: (form.single['ownerEmail'] ?? '').trim().toLowerCase(),
        onVerificationFailure: form.single['onVerificationFailure'] !== undefined,
        onConnectionBroken: form.single['onConnectionBroken'] !== undefined,
        onPaymentFailure: form.single['onPaymentFailure'] !== undefined,
        onSupportCase: form.single['onSupportCase'] !== undefined,
        onBudgetThreshold: form.single['onBudgetThreshold'] !== undefined,
        digestMinutes: Number.isSafeInteger(digest) && digest >= 0 && digest <= 1440 ? digest : 60,
      };
      return respondToWrite(
        c,
        port,
        principal,
        await port.writeSetting(
          actionContext(principal, 'settings.write', c),
          SETTINGS_KEY.notifications,
          JSON.stringify(values),
        ),
        'Settings',
      );
    }),
  );

  routes.post('/owner/settings/retention', async (c) =>
    withAction(c, 'settings.write', async (port, principal, form) => {
      const { values, errors } = validateRetention(form.single);
      if (Object.keys(errors).length > 0) {
        return ownerPage(
          c,
          shell(port, principal, {
            title: 'Settings',
            path: '/owner/settings',
            body: await settingsBody(port, principal, { fieldErrors: errors }),
          }),
          422,
        );
      }
      return respondToWrite(
        c,
        port,
        principal,
        await port.writeSetting(
          actionContext(principal, 'settings.write', c),
          SETTINGS_KEY.retention,
          JSON.stringify(values),
        ),
        'Settings',
      );
    }),
  );

  routes.post('/owner/settings/access-mode', async (c) =>
    withAction(c, 'settings.write', async (port, principal, form) => {
      const raw = form.single['mode'] ?? '';
      const mode: AccessMode = raw === 'RESTRICTED_ENTRY' ? 'RESTRICTED_ENTRY' : 'PUBLIC_LOGIN';
      const result = await port.writeSetting(
        actionContext(principal, 'settings.write', c),
        SETTINGS_KEY.accessMode,
        JSON.stringify({ mode }),
      );
      // The honest description travels with the setting, so no page can save the mode and
      // forget to say what it does not do.
      return respondToWrite(
        c,
        port,
        principal,
        { ...result, message: describeAccessMode(mode).honestDescription },
        'Settings',
      );
    }),
  );

  /* quality */

  routes.get('/owner/quality', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Test centre',
          path: '/owner/quality',
          body: QualityPage({
            runs: await port.qualityRuns(50),
            csrfToken: principal.csrfToken,
            artifactsUnavailableReason: await (await resolveArtifacts(c)).unavailableReason(),
            formMessage: null,
            formDependency: null,
          }),
        }),
      ),
    ),
  );

  routes.post('/owner/quality/run', async (c) =>
    withAction(c, 'quality.dispatch', async (port, principal, form) => {
      const result = await port.dispatchQuality(
        actionContext(principal, 'quality.dispatch', c),
        form.single['suite_id'] ?? '',
      );
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Test centre',
          path: '/owner/quality',
          body: QualityPage({
            runs: await port.qualityRuns(50),
            csrfToken: principal.csrfToken,
            artifactsUnavailableReason: await (await resolveArtifacts(c)).unavailableReason(),
            formMessage: result.ok
              ? result.message
              : result.dependency === null
                ? result.message
                : null,
            formDependency: result.dependency,
          }),
        }),
        result.ok ? 200 : result.dependency !== null ? 202 : 422,
      );
    }),
  );

  /**
   * The authenticated download. The artifact id is matched against the closed list before
   * anything touches the store, so there is no path here a `../` could travel down.
   */
  routes.get('/owner/quality/report/:artifact', async (c) =>
    withView(c, 'owner.view', async (port, principal) => {
      const id = c.req.param('artifact');
      if (!isQualityArtifactId(id)) return refuseNotFound(c);
      const meta = artifactMeta(id);
      const artifacts = await resolveArtifacts(c);
      const stored = await artifacts.get(id);
      if (meta === null || stored === null) {
        const unavailable = await artifacts.unavailableReason();
        return ownerPage(
          c,
          shell(port, principal, {
            title: 'Evidence pack',
            path: '/owner/quality',
            body: html`<div class="wrap section stack">
              ${PageHead({ title: 'There is nothing to download' })}
              ${Callout({
                tone: 'warn',
                title: 'No evidence pack is attached to this deployment',
                body: html`<p data-dependency="true">
                  ${
                    unavailable ??
                    'This file is not part of the evidence pack attached to this deployment.'
                  }
                </p>`,
              })}
              <p><a href="/owner/quality">Back to the test centre</a></p>
            </div>`,
          }),
          503,
        );
      }
      return new Response(stored.body, {
        status: 200,
        headers: {
          'content-type': meta.contentType,
          'content-disposition': `attachment; filename="${meta.id}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...(stored.generatedAt === null ? {} : { 'x-report-generated-at': stored.generatedAt }),
        },
      });
    }),
  );

  /* cleanup */

  routes.get('/owner/cleanup', async (c) =>
    withView(c, 'owner.view', async (port, principal) =>
      ownerPage(
        c,
        shell(port, principal, {
          title: 'Cleanup',
          path: '/owner/cleanup',
          body: CleanupPage({
            inventory: null,
            lastReport: await port.lastCleanupReport(),
            csrfToken: principal.csrfToken,
            errorMessage: null,
          }),
        }),
      ),
    ),
  );

  routes.post('/owner/cleanup/preview', async (c) =>
    withAction(c, 'cleanup.preview', async (port, principal, form) => {
      const result = await port.cleanupPreview(
        actionContext(principal, 'cleanup.preview', c),
        form.all['categories'] ?? [],
      );
      const inventory: CleanupInventory | null = result.ok ? result.inventory : null;
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Cleanup',
          path: '/owner/cleanup',
          body: CleanupPage({
            inventory,
            lastReport: await port.lastCleanupReport(),
            csrfToken: principal.csrfToken,
            errorMessage: result.ok ? null : result.detail,
          }),
        }),
        result.ok ? 200 : 422,
      );
    }),
  );

  routes.post('/owner/cleanup/run', async (c) =>
    withAction(c, 'cleanup.execute', async (port, principal, form) => {
      if ((form.single['confirm'] ?? '').trim().toLowerCase() !== 'delete') {
        return ownerPage(
          c,
          shell(port, principal, {
            title: 'Cleanup',
            path: '/owner/cleanup',
            body: CleanupPage({
              inventory: null,
              lastReport: await port.lastCleanupReport(),
              csrfToken: principal.csrfToken,
              errorMessage: 'Type "delete" to confirm. Nothing was deleted.',
            }),
          }),
          422,
        );
      }
      const result = await port.cleanupExecute(actionContext(principal, 'cleanup.execute', c), {
        inventoryHash: form.single['inventory_hash'] ?? '',
        quarantine: form.single['quarantine'] !== undefined,
      });
      return ownerPage(
        c,
        shell(port, principal, {
          title: 'Cleanup',
          path: '/owner/cleanup',
          body: CleanupPage({
            inventory: null,
            lastReport: await port.lastCleanupReport(),
            csrfToken: principal.csrfToken,
            errorMessage: result.ok ? null : result.detail,
          }),
        }),
        result.ok ? 200 : 422,
      );
    }),
  );

  return routes;
}

/** Ready-to-mount router on the in-memory port. */
export const ownerRoutes = createOwnerRoutes();

/* ------------------------------------------------------------------- helpers */

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return { ...fallback, ...(parsed as Partial<T>) };
  } catch {
    return fallback;
  }
}

/**
 * A token for a page that has no session yet — the sign-in and bootstrap pages. It is set
 * as the double-submit cookie at the same time, so the form on that page has a matching
 * half without needing a session.
 */
function newPageToken(c: Context<RouteBindings>): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let token = '';
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, csrfCookieName(secure), token, {
    path: '/',
    sameSite: 'Lax',
    maxAge: 43200,
    secure,
  });
  return token;
}

/** Re-exported so the lead can mount the pieces without reaching into the module. */
export { ActionForm, Button };
export { LOGIN_ACKNOWLEDGEMENT } from './adminPages.js';
