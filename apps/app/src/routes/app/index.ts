/**
 * The customer router.
 *
 * Mount it at `/app`. Every route resolves a `CustomerDataPort` for the request and reads
 * nothing else — no database handle, no provider client, no session parsing of its own.
 * That is what lets A02 swap the synthetic implementation for the real one without a single
 * page changing.
 *
 * To mount (`apps/app/src/index.ts`, the lead's file):
 *
 *     import { appRoutes } from './routes/app/index.js';
 *     app.route('/app', appRoutes);
 *
 * To hand it A02's repositories later, build it with a resolver instead:
 *
 *     import { createAppRoutes } from './routes/app/index.js';
 *     app.route('/app', createAppRoutes(async (c) => new D1CustomerDataPort(c)));
 *
 * Forms are POST-redirect-GET: a successful write answers 303 to a GET so a refresh cannot
 * repeat it. A failed write re-renders the same page with the field errors in place, at
 * status 422, so nothing is lost and nothing is fabricated.
 */
import { Hono, type Context } from 'hono';
import { AppLayout } from '@verify/ui';
import { failureBody, page, type RouteBindings } from '../public/shared.js';
import { syntheticNotice, syntheticStripe } from './chrome.js';
import { SignInPage } from './authPages.js';
import { WorkspacePage } from './workspacePage.js';
import {
  ActivationPage,
  CompatibilityPage,
  ConnectPage,
  MappingPage,
  OutcomePage,
  ProofPage,
  ReviewPage,
} from './onboardingPages.js';
import { RunDetailPage, RunListPage, RunNotFoundPage } from './runPages.js';
import { CancelPage, ConnectionsPage, SupportFormPage, UsagePage } from './accountPages.js';
import { BillingPage, BillingReturnPage } from './billingPages.js';
import {
  DEADLINE_CHOICES,
  SyntheticCustomerDataPort,
  maskedAccountLabel,
} from './syntheticPort.js';
import { SELECTABLE_COVERAGE_MODES } from '@verify/domain';
import {
  isSecureRequest,
  readCookie,
  sessionCookie,
  sessionCookieName,
  sessionIdFor,
} from '../../lib/session.js';
import type { Env } from '../../lib/context.js';
import type { CoverageMode } from '@verify/contracts';
import type {
  CustomerDataPort,
  ProofRunView,
  SessionView,
  SigningKeyIssueResult,
  SupportResult,
  WriteResult,
} from './port.js';
import { html, type Html } from '@verify/ui';
import {
  csrfCookieName,
  generateCsrfToken,
  isSameOriginRequest,
  isStateChangingMethod,
  validateCsrfToken,
} from '@verify/security';
import { getCookie, setCookie } from 'hono/cookie';

export type PortResolver = (c: Context<RouteBindings>) => Promise<CustomerDataPort>;

/** The default resolver: one synthetic port per request. */
const syntheticResolver: PortResolver = async () => new SyntheticCustomerDataPort();

const RUNS_PER_PAGE = 25;

/** Read a POST body into a plain map. No JSON, no JavaScript, just a real form. */
async function formBody(c: Context<RouteBindings>): Promise<Record<string, string>> {
  const parsed = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function checked(body: Record<string, string>, name: string): boolean {
  const value = body[name];
  return value !== undefined && value !== '' && value !== 'off';
}

/** One status per refusal, so a probe can tell "sign in" from "not yours" from "not here". */
const SIGNING_KEY_REFUSAL_STATUS: Readonly<
  Record<Extract<SigningKeyIssueResult, { outcome: 'refused' }>['reason'], number>
> = {
  not_signed_in: 401,
  not_permitted: 403,
  cross_site: 403,
  no_workflow: 404,
  unavailable: 422,
};

function signingKeyStatus(result: SigningKeyIssueResult): number {
  if (result.outcome === 'issued') return 200;
  // A configuration fault on our side, said as one. Not a 500 and not a 4xx blaming the caller.
  if (result.outcome === 'unconfigured') return 503;
  return SIGNING_KEY_REFUSAL_STATUS[result.reason];
}

export function createAppRoutes(resolve: PortResolver = syntheticResolver): Hono<RouteBindings> {
  const routes = new Hono<RouteBindings>();

  /**
   * The failure state for every customer screen at once.
   *
   * Hono applies a sub-app's error handler to its own routes when the sub-app is mounted,
   * so this catches anything thrown under `/app` — a database that is unreachable, a port
   * that cannot resolve the session — before it reaches the Worker's global handler and
   * its JSON envelope. The cause is logged with the path and never rendered. The status is
   * 500 and the body is `no-store`: a failure must not be cached and must not be read as a
   * verdict about anything.
   *
   * The ordinary `shell()` is not used here on purpose: it needs a resolved port, and the
   * port resolving is one of the things that may have failed.
   */
  routes.onError((error, c) => {
    console.error('customer_page_failed', { path: c.req.path, message: String(error) });
    return page(
      c,
      AppLayout({
        title: 'We could not load this page',
        path: c.req.path,
        body: failureBody({
          retryHref: c.req.path,
          supportHref: '/app/support',
          requestId: c.req.header('cf-ray') ?? 'unknown',
        }),
      }),
      { status: 500 },
    );
  });

  /** Wrap a page body in the authenticated layout, with the synthetic notice if applicable. */
  function shell(
    port: CustomerDataPort,
    options: {
      readonly title: string;
      readonly path: string;
      readonly accountLabel?: string;
      readonly csrfToken?: string;
      readonly body: Html;
    },
  ): Html {
    const notice = syntheticNotice(port.synthetic);
    const stripe = syntheticStripe(port.synthetic);
    return AppLayout({
      title: options.title,
      path: options.path,
      ...(options.accountLabel === undefined ? {} : { accountLabel: options.accountLabel }),
      ...(options.csrfToken === undefined ? {} : { csrfToken: options.csrfToken }),
      ...(stripe === null ? {} : { beforeMain: stripe }),
      body:
        notice === null
          ? options.body
          : html`<div class="wrap pad-top">${notice}</div>
            ${options.body}`,
    });
  }

  /** Set the double-submit CSRF cookie to `token` on this response. Not HttpOnly — the
   * form must be able to echo it. Same cookie name, same attributes, same reasoning as
   * `routes/owner/index.ts`'s identical helper: this is the one CSRF implementation in the
   * codebase, not a second one that can drift from it. */
  function setCsrfCookie(c: Context<RouteBindings>, token: string): void {
    const secure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, csrfCookieName(secure), token, {
      path: '/',
      sameSite: 'Lax',
      maxAge: 43200,
      secure,
    });
  }

  /**
   * Both halves of the CSRF defence, applied together and never separately — the double-
   * submit cookie AND the proven same-origin request. `routes/owner/index.ts`'s
   * `csrfProblem` states why both are required: a same-origin check alone trusts a header a
   * misconfigured proxy can drop, and a token alone trusts a cookie a subdomain can plant.
   * Together, neither gap is enough on its own. Returns null when the request is genuine.
   *
   * Reads the form body to find `csrf_token`; `formBody(c)` after this call gets the same
   * cached parse, not a second read of the request stream.
   */
  async function csrfProblem(c: Context<RouteBindings>): Promise<string | null> {
    const secure = new URL(c.req.url).protocol === 'https:';
    const cookie = getCookie(c, csrfCookieName(secure)) ?? null;
    const body = await formBody(c);
    const submitted = body['csrf_token'] ?? null;
    if (!validateCsrfToken(cookie, submitted)) {
      return 'This form was submitted without a valid token. Reload the page and try again.';
    }
    if (!isSameOriginRequest(c.req.raw, new URL(c.req.url).origin)) {
      return 'This form was submitted from somewhere else. Nothing was changed.';
    }
    return null;
  }

  /** The generic response every customer mutation gets when the CSRF check fails — the
   * request never became a real write, so there is nothing route-specific to re-render
   * around it, the same shape `routes/owner/index.ts` answers with. */
  function csrfRefusalPage(
    c: Context<RouteBindings>,
    port: CustomerDataPort,
    session: SessionView | null,
    message: string,
    csrfToken: string,
  ): Promise<Response> {
    return page(
      c,
      shell(port, {
        title: 'Not saved',
        path: new URL(c.req.url).pathname,
        ...(session === null ? {} : { accountLabel: maskedAccountLabel(session.email) }),
        csrfToken,
        body: html`<div class="wrap section stack">
          <h1>That did not go through</h1>
          <p data-csrf-error="true">${message}</p>
        </div>`,
      }),
      { status: 403 },
    );
  }

  /**
   * Every authenticated route runs through this. No session means the sign-in page, at 401
   * — not a redirect that loses the reason, and not a blank page.
   *
   * Authentication is checked before CSRF, the same order `routes/owner/index.ts` uses
   * (authorisation in `withView`/`withAction`, CSRF only once that has already passed): a
   * signed-out POST here reaches every route this wrapper guards, so there is nothing
   * workspace-scoped for a forged cross-site request to do yet, and the honest answer is
   * still "sign in", not a CSRF-shaped refusal that hides the real reason. `/sign-in` and
   * `/sign-out` do not use this wrapper — they are reachable signed out by design — and
   * carry their own, identical CSRF check below.
   */
  async function withSession(
    c: Context<RouteBindings>,
    render: (
      port: CustomerDataPort,
      session: NonNullable<Awaited<ReturnType<CustomerDataPort['session']>>>,
    ) => Promise<Response>,
  ): Promise<Response> {
    const port = await resolve(c);
    const session = await port.session();

    if (session === null) {
      const token = generateCsrfToken();
      setCsrfCookie(c, token);
      return page(
        c,
        shell(port, {
          title: 'Sign in',
          path: '/app/sign-in',
          body: SignInPage({ csrfToken: token, submitted: null, email: '', linkSent: false }),
        }),
        { status: 401 },
      );
    }

    if (isStateChangingMethod(c.req.method)) {
      const problem = await csrfProblem(c);
      if (problem !== null) {
        setCsrfCookie(c, session.csrfToken);
        return csrfRefusalPage(c, port, session, problem, session.csrfToken);
      }
    }

    // Set fresh for this response, matching whatever `render` embeds in the page below —
    // cookie and form field are always the same value inside one response.
    setCsrfCookie(c, session.csrfToken);
    return render(port, session);
  }

  /* -------------------------------------------------------------------- sign in */

  /**
   * The session id the browser already holds, hashed, so the redemption can revoke it.
   *
   * A stale cookie must not stop a valid link working, and it must not be carried forward
   * either: fixation is exactly what rotating on every privilege transition prevents.
   */
  async function presentedSessionId(request: Request, secure: boolean): Promise<string | null> {
    const value = readCookie(request.headers.get('cookie'), sessionCookieName(secure));
    return value === null ? null : sessionIdFor(value);
  }

  /**
   * Complete a sign-in from an emailed link.
   *
   * This route did not exist until 20 September 2026, and its absence made the whole
   * customer journey a dead end by construction: `redeemSignInToken` was written, tested
   * and reachable from nothing, so even a delivered link had nowhere to land. The owner's
   * link had the same problem -- I wired /admin/login to genuinely send an email the day
   * before, and the URL inside it answered 404.
   *
   * The token is single-use and the redemption is one conditional statement, so two
   * browsers opening the same link race in the database and the loser gets nothing. The
   * session id is minted fresh, so a cookie the browser already held cannot survive a
   * sign-in.
   *
   * Every failure answers the same way. "That link has expired" and "that link was already
   * used" and "no such token" are one sentence, because distinguishing them tells an
   * unauthenticated caller which addresses have accounts.
   */
  routes.get('/sign-in/complete', async (c) => {
    const { redeemSignInToken } = await import('../../lib/auth.js');
    const env = c.env as Env;
    const secure = isSecureRequest(c.req.raw, env.PUBLIC_BASE_URL);
    const token = (c.req.query('token') ?? '').trim();

    const redeemed =
      token === ''
        ? ({ ok: false, refusal: 'unknown_or_used' } as const)
        : await redeemSignInToken(env.DB as never, {
            token,
            now: new Date(),
            presentedSessionId: await presentedSessionId(c.req.raw, secure),
          });

    if (!redeemed.ok) {
      const port = await resolve(c);
      const csrf = generateCsrfToken();
      setCsrfCookie(c, csrf);
      return page(
        c,
        shell(port, {
          title: 'Sign in',
          path: '/app/sign-in',
          body: SignInPage({
            csrfToken: csrf,
            submitted: {
              ok: false,
              fieldErrors: {},
              redirectTo: null,
              message:
                'That sign-in link cannot be used. Links work once and expire after fifteen minutes. Ask for a new one.',
            },
            email: '',
            linkSent: false,
          }),
        }),
        { status: 401 },
      );
    }

    c.header('set-cookie', sessionCookie(redeemed.session.sessionValue, { secure }), {
      append: true,
    });
    return c.redirect('/app', 303);
  });

  routes.get('/sign-in', async (c) => {
    const port = await resolve(c);
    const session = await port.session();
    if (session !== null) return c.redirect('/app', 303);
    const token = generateCsrfToken();
    setCsrfCookie(c, token);
    return page(
      c,
      shell(port, {
        title: 'Sign in',
        path: '/app/sign-in',
        body: SignInPage({ csrfToken: token, submitted: null, email: '', linkSent: false }),
      }),
    );
  });

  /**
   * The one POST a signed-out visitor can reach, which is exactly why it needs the same
   * CSRF defence as everything `withSession` guards rather than an exemption for being
   * "only" a sign-in request — a forged cross-site submission here can still send an
   * unwanted magic link to an address the attacker chose.
   */
  routes.post('/sign-in', async (c) => {
    const port = await resolve(c);
    const problem = await csrfProblem(c);
    if (problem !== null) {
      const token = generateCsrfToken();
      setCsrfCookie(c, token);
      return csrfRefusalPage(c, port, null, problem, token);
    }
    const body = await formBody(c);
    const email = body['email'] ?? '';
    const result = await port.requestSignInLink(email);
    const token = generateCsrfToken();
    setCsrfCookie(c, token);
    // A successful request is NOT a redirect to /app. There is no session yet -- the link
    // is in an inbox -- so redirecting would bounce straight back here and look like the
    // request had failed. It renders the confirmation instead, which is also the only
    // answer that can be identical for an address with an account and one without.
    return page(
      c,
      shell(port, {
        title: 'Sign in',
        path: '/app/sign-in',
        body: SignInPage({
          csrfToken: token,
          submitted: result,
          email,
          linkSent: result.ok,
        }),
      }),
      { status: result.ok ? 200 : 422 },
    );
  });

  routes.post('/sign-out', async (c) => {
    const port = await resolve(c);
    const session = await port.session();
    // Nothing to protect when there is no session to end — the same reasoning
    // `csrfRefusalPage` would otherwise apply for no benefit.
    if (session !== null) {
      const problem = await csrfProblem(c);
      if (problem !== null) {
        setCsrfCookie(c, session.csrfToken);
        return csrfRefusalPage(c, port, session, problem, session.csrfToken);
      }
    }
    const result = await port.signOut();
    return c.redirect(result.redirectTo ?? '/', 303);
  });

  /* ------------------------------------------------------------------ workspace */

  routes.get('/', async (c) =>
    withSession(c, async (port, session) => {
      const workflow = await port.workflow();
      const runs = await port.listRuns({ limit: 5 });
      const connections = await port.connections();
      const usage = await port.usage();
      return page(
        c,
        shell(port, {
          title: 'Workspace',
          path: '/app',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: WorkspacePage({
            workflow,
            recentRuns: runs.items,
            connections,
            usage,
            now: new Date(),
            canStartSetup: session.role === 'workspace_admin',
            testOffer: await port.testVerificationOffer(),
            csrfToken: session.csrfToken,
            submissionId: crypto.randomUUID(),
            openVerifyForm: c.req.query('verify') === '1',
            verdictScope:
              c.req.query('scope') === 'tests'
                ? 'tests'
                : c.req.query('scope') === 'all'
                  ? 'all'
                  : 'automation',
          }),
        }),
      );
    }),
  );

  /* ----------------------------------------------------------------- onboarding */

  routes.get('/onboarding/compatibility', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Check compatibility',
          path: '/app/onboarding/compatibility',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: CompatibilityPage(await port.connectorCompatibility(), {
            canContinue: session.role === 'workspace_admin',
          }),
        }),
      ),
    ),
  );

  routes.get('/onboarding/connect', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Connect providers',
          path: '/app/onboarding/connect',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ConnectPage({
            connections: await port.connections(),
            csrfToken: session.csrfToken,
            submitted: null,
            canSubmitCredentials: typeof port.submitConnectionCredentials === 'function',
          }),
        }),
      ),
    ),
  );

  /**
   * Two intents share this route because they are two halves of one action: `credentials`
   * validates a pasted key against the provider, `authorise` starts an OAuth redirect. The
   * form says which; anything else is treated as the authorisation path rather than guessed at.
   *
   * A rejected credential answers 422 and re-renders the same card with the message beside
   * the field it concerns. A submitted secret is never echoed back into the form, so the
   * customer retypes it — which is the right trade against putting a live API key back into
   * the HTML of a page that may sit in a browser cache.
   */
  routes.post('/onboarding/connect', async (c) =>
    withSession(c, async (port, session) => {
      const body = await formBody(c);
      const provider = body['provider'] === 'resend' ? 'resend' : 'hubspot';
      const submitCredentials = port.submitConnectionCredentials?.bind(port);

      let result: WriteResult;
      if (body['intent'] === 'credentials' && submitCredentials !== undefined) {
        const webhookSecret = (body['webhook_secret'] ?? '').trim();
        result = await submitCredentials({
          provider,
          accessToken: body['access_token'] ?? '',
          ...(webhookSecret === '' ? {} : { webhookSecret }),
        });
      } else if (body['intent'] === 'credentials') {
        // Never claim to have checked something we have no way of checking.
        result = {
          ok: false,
          fieldErrors: {},
          message:
            'Nothing was sent anywhere and nothing was stored. This workspace has no way to validate a credential against the provider yet.',
          redirectTo: null,
        };
      } else {
        result = await port.beginConnection(provider);
      }

      if (result.ok && result.redirectTo !== null) return c.redirect(result.redirectTo, 303);
      return page(
        c,
        shell(port, {
          title: 'Connect providers',
          path: '/app/onboarding/connect',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ConnectPage({
            connections: await port.connections(),
            csrfToken: session.csrfToken,
            submitted: result,
            submittedProvider: provider,
            canSubmitCredentials: submitCredentials !== undefined,
          }),
        }),
        { status: result.ok ? 200 : 422 },
      );
    }),
  );

  routes.get('/onboarding/mapping', async (c) =>
    withSession(c, async (port, session) => {
      const workflow = await port.workflow();
      if (workflow === null) return c.redirect('/app/onboarding/compatibility', 303);
      return page(
        c,
        shell(port, {
          title: 'Map fields',
          path: '/app/onboarding/mapping',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: MappingPage({
            workflow,
            csrfToken: session.csrfToken,
            submitted: null,
            value: workflow.mapping.correlationProperty,
          }),
        }),
      );
    }),
  );

  routes.post('/onboarding/mapping', async (c) =>
    withSession(c, async (port, session) => {
      const body = await formBody(c);
      const value = body['correlationProperty'] ?? '';
      const result = await port.saveFieldMapping({ correlationProperty: value });
      if (result.ok) return c.redirect(result.redirectTo ?? '/app/onboarding/outcome', 303);
      const workflow = await port.workflow();
      if (workflow === null) return c.redirect('/app/onboarding/compatibility', 303);
      return page(
        c,
        shell(port, {
          title: 'Map fields',
          path: '/app/onboarding/mapping',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: MappingPage({ workflow, csrfToken: session.csrfToken, submitted: result, value }),
        }),
        { status: 422 },
      );
    }),
  );

  routes.get('/onboarding/outcome', async (c) =>
    withSession(c, async (port, session) => {
      const workflow = await port.workflow();
      if (workflow === null) return c.redirect('/app/onboarding/compatibility', 303);
      return page(
        c,
        shell(port, {
          title: 'Expected outcome',
          path: '/app/onboarding/outcome',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: OutcomePage({
            workflow,
            csrfToken: session.csrfToken,
            submitted: null,
            deadlineChoices: DEADLINE_CHOICES,
          }),
        }),
      );
    }),
  );

  routes.post('/onboarding/outcome', async (c) =>
    withSession(c, async (port, session) => {
      const body = await formBody(c);
      const result = await port.saveExpectedOutcome({
        deadlineSeconds: Number.parseInt(body['deadlineSeconds'] ?? '', 10),
        requireRecordExists: checked(body, 'requireRecordExists'),
        requireCorrelationMatch: checked(body, 'requireCorrelationMatch'),
        requireEmailDelivered: checked(body, 'requireEmailDelivered'),
        requireRecipientMatch: checked(body, 'requireRecipientMatch'),
        // Resolved against what the domain says is selectable, not against a literal.
        // A hand-posted form (the control is gone from the page, the HTTP request is not)
        // asking for `independently_sourced` gets the coverage we can actually deliver
        // rather than a stored promise nothing implements. Never trust a browser-supplied
        // entitlement — brief rule 5 — and a coverage mode is an entitlement to a
        // capability.
        coverageMode: (SELECTABLE_COVERAGE_MODES as readonly string[]).includes(
          body['coverageMode'] ?? '',
        )
          ? (body['coverageMode'] as CoverageMode)
          : ('customer_triggered' as CoverageMode),
      });
      if (result.ok) return c.redirect(result.redirectTo ?? '/app/onboarding/proof', 303);
      const workflow = await port.workflow();
      if (workflow === null) return c.redirect('/app/onboarding/compatibility', 303);
      return page(
        c,
        shell(port, {
          title: 'Expected outcome',
          path: '/app/onboarding/outcome',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: OutcomePage({
            workflow,
            csrfToken: session.csrfToken,
            submitted: result,
            deadlineChoices: DEADLINE_CHOICES,
          }),
        }),
        { status: 422 },
      );
    }),
  );

  routes.get('/onboarding/proof', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Proof run',
          path: '/app/onboarding/proof',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ProofPage({ proof: null, csrfToken: session.csrfToken }),
        }),
      ),
    ),
  );

  routes.post('/onboarding/proof', async (c) =>
    withSession(c, async (port, session) => {
      const proof: ProofRunView = await port.runProof();
      return page(
        c,
        shell(port, {
          title: 'Proof run',
          path: '/app/onboarding/proof',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ProofPage({ proof, csrfToken: session.csrfToken }),
        }),
      );
    }),
  );

  routes.get('/onboarding/review', async (c) =>
    withSession(c, async (port, session) => {
      const workflow = await port.workflow();
      if (workflow === null) return c.redirect('/app/onboarding/compatibility', 303);
      return page(
        c,
        shell(port, {
          title: 'Review and price',
          path: '/app/onboarding/review',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ReviewPage({
            order: await port.orderSummary(),
            workflow,
            csrfToken: session.csrfToken,
            submitted: null,
          }),
        }),
      );
    }),
  );

  routes.post('/onboarding/checkout', async (c) =>
    withSession(c, async (port, session) => {
      const result: WriteResult = await port.createCheckout();
      if (result.ok && result.redirectTo !== null) return c.redirect(result.redirectTo, 303);
      const workflow = await port.workflow();
      if (workflow === null) return c.redirect('/app/onboarding/compatibility', 303);
      return page(
        c,
        shell(port, {
          title: 'Review and price',
          path: '/app/onboarding/review',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ReviewPage({
            order: await port.orderSummary(),
            workflow,
            csrfToken: session.csrfToken,
            submitted: result,
          }),
        }),
        { status: 503 },
      );
    }),
  );

  routes.get('/onboarding/activation', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Activation',
          path: '/app/onboarding/activation',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ActivationPage(await port.activation(), {
            csrfToken: session.csrfToken,
            issued: null,
          }),
        }),
      ),
    ),
  );

  /**
   * Issue or rotate the workflow signing key.
   *
   * This is the request that had never existed. `workflows.setSigningKey` had a writer,
   * `issueWorkflowSigningKey` had tests, the activation page rendered a hint — and no
   * browser could reach any of it, so no customer could ever hold a key. The response to
   * THIS request is the only place the secret is ever rendered. It is answered directly,
   * `no-store`, rather than by redirect: a redirect would need the secret carried somewhere
   * between two requests, and there is nowhere it may be carried.
   *
   * Rotation is destructive to the customer's own integration — the old key stops being
   * accepted at once — so a forged cross-site POST must not be able to trigger it. The
   * customer routes do not yet validate the double-submit token (`session()` mints a fresh
   * one per request and no cookie half exists), so the gate here is the request's proven
   * origin, against the configured public origin or the origin actually served. Absence
   * of proof is not proof of absence: no `Origin` and no `Referer` refuses.
   */
  routes.post('/onboarding/activation/signing-key', async (c) =>
    withSession(c, async (port, session) => {
      // `withSession` has already enforced both CSRF halves (the double-submit cookie AND
      // the proven same-origin request) before this callback ever runs — see its own
      // docblock. There is no second, route-specific origin check here any more.
      const result: SigningKeyIssueResult = await port.issueSigningKey();
      return page(
        c,
        shell(port, {
          title: 'Activation',
          path: '/app/onboarding/activation',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          // Re-read after the write, so the key id in the facts list is the one just issued.
          body: ActivationPage(await port.activation(), {
            csrfToken: session.csrfToken,
            issued: result,
          }),
        }),
        { status: signingKeyStatus(result) },
      );
    }),
  );

  /* ----------------------------------------------------------------------- runs */

  routes.get('/runs', async (c) =>
    withSession(c, async (port, session) => {
      const cursor = c.req.query('cursor');
      // Anything but the two known values is `all`: a filter is not a place to answer a
      // question the customer did not ask.
      const asked = c.req.query('show');
      const source: 'all' | 'real' | 'test' =
        asked === 'real' || asked === 'test' ? asked : 'all';
      const workflow = await port.workflow();
      const runPage = await port.listRuns({
        limit: RUNS_PER_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
        ...(source === 'all' ? {} : { source }),
      });
      return page(
        c,
        shell(port, {
          title: 'Runs',
          path: '/app/runs',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: RunListPage({
            page: runPage,
            workflowName: workflow?.name ?? 'This workspace',
            basePath: '/app/runs',
            source,
          }),
        }),
      );
    }),
  );

  routes.get('/runs/:id', async (c) =>
    withSession(c, async (port, session) => {
      const run = await port.run(c.req.param('id'));
      if (run === null) {
        return page(
          c,
          shell(port, {
            title: 'Run not found',
            path: '/app/runs',
            accountLabel: maskedAccountLabel(session.email),
            csrfToken: session.csrfToken,
            body: RunNotFoundPage(),
          }),
          { status: 404 },
        );
      }
      return page(
        c,
        shell(port, {
          title: `Run ${run.id}`,
          path: '/app/runs',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: RunDetailPage({
            run,
            csrfToken: session.csrfToken,
            // A fresh identity per render: pressing Recheck twice on ONE page is one
            // submission, while loading the page again is a new one the customer asked for.
            submissionId: crypto.randomUUID(),
            runsRemaining: (await port.usage()).runsRemaining,
            justStarted: c.req.query('started') === 'test',
            wasDuplicate: c.req.query('again') !== undefined,
          }),
        }),
      );
    }),
  );

  /* ----------------------------------------------------- connections and usage */

  /**
   * Start a guided test verification.
   *
   * A POST for the same reason as the connection test, with one more: this one spends a run
   * from the customer's allowance. A GET that did it could be fired by a prefetch and cost
   * them money's worth of allowance without a press.
   *
   * On success it redirects to the run it created rather than rendering a result, because
   * there is no result yet: the run is admitted PENDING and decided later by the scheduler
   * reading the providers. Sending the customer to the run is sending them to the thing
   * that will actually answer, and a page that claimed an outcome here would be inventing
   * one.
   */
  routes.post('/test-verification', async (c) =>
    withSession(c, async (port, session) => {
      const body = await formBody(c);
      const start = port.startTestVerification?.bind(port);
      const result =
        start === undefined
          ? {
              ok: false,
              runId: null,
              fieldErrors: {},
              message: 'Test verifications are not available on this deployment.',
            }
          : await start({
              crmRecordId: body['crmRecordId'] ?? '',
              messageId: body['messageId'] ?? '',
              expectedRecipient: body['expectedRecipient'] ?? '',
              correlationValue: body['correlationValue'] ?? '',
              submissionId: body['submissionId'] ?? '',
            });
      if (result.ok && result.runId !== null) {
        // `started=test` is the first sight of a new run; `again=1` says this press found
        // the one already running, so the page can say so rather than look identical.
        const marker = result.duplicate === true ? 'again' : 'started=test';
        return c.redirect(`/app/runs/${encodeURIComponent(result.runId)}?${marker}`, 303);
      }
      const workflow = await port.workflow();
      return page(
        c,
        shell(port, {
          title: 'Workspace',
          path: '/app',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: WorkspacePage({
            workflow,
            recentRuns: (await port.listRuns({ limit: 5 })).items,
            connections: await port.connections(),
            usage: await port.usage(),
            now: new Date(),
            canStartSetup: session.role === 'workspace_admin',
            testOffer: await port.testVerificationOffer(),
            csrfToken: session.csrfToken,
            testSubmitted: result,
            // Echoed back, not re-minted: correcting a typo and pressing again is the same
            // submission, and must not become a second charged run once it validates.
            submissionId: body['submissionId'] ?? crypto.randomUUID(),
            openVerifyForm: true,
          }),
        }),
        { status: 422 },
      );
    }),
  );

  /**
   * Test one connection, now, against the provider.
   *
   * A POST because it costs an outbound call to somebody else's API on our account: a GET
   * would be fired by a prefetch, a crawler or a link preview, and the customer would be
   * spending their own provider's rate limit without pressing anything. It also means the
   * CSRF check applies.
   *
   * The result is rendered on the page the customer is already on rather than redirected
   * to, so the check, its time and its next action arrive together.
   */
  routes.post('/connections/test', async (c) =>
    withSession(c, async (port, session) => {
      const body = await formBody(c);
      const provider = body['provider'] === 'resend' ? 'resend' : 'hubspot';
      const test = port.testConnection?.bind(port);
      const tested = test === undefined ? null : await test(provider);
      return page(
        c,
        shell(port, {
          title: 'Connections',
          path: '/app/connections',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ConnectionsPage({
            connections: await port.connections(),
            csrfToken: session.csrfToken,
            submitted: null,
            canTest: session.role === 'workspace_admin' && test !== undefined,
            tested,
          }),
        }),
        // A check that ran and found a problem is a successful check: the page renders 200
        // and says what it found. Only a check that could not run at all is a 503.
        { status: tested?.blockedReason == null ? 200 : 503 },
      );
    }),
  );

  routes.get('/connections', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Connections',
          path: '/app/connections',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: ConnectionsPage({
            connections: await port.connections(),
            csrfToken: session.csrfToken,
            submitted: null,
            canTest: session.role === 'workspace_admin' && typeof port.testConnection === 'function',
            tested: null,
          }),
        }),
      ),
    ),
  );

  routes.get('/usage', async (c) =>
    withSession(c, async (port, session) => {
      // The run counts come from the same read the workspace uses, so the four cards on
      // this page cannot disagree with the four on /app. No workflow means no cards.
      const workflow = await port.workflow();
      return page(
        c,
        shell(port, {
          title: 'Usage',
          path: '/app/usage',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: UsagePage(await port.usage(), workflow?.counts ?? null),
        }),
      );
    }),
  );

  /* -------------------------------------------------------------------- support */

  routes.get('/support', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Support',
          path: '/app/support',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: SupportFormPage({
            csrfToken: session.csrfToken,
            submitted: null,
            subject: '',
            body: '',
            runId: c.req.query('run') ?? null,
          }),
        }),
      ),
    ),
  );

  routes.post('/support', async (c) =>
    withSession(c, async (port, session) => {
      const body = await formBody(c);
      const subject = body['subject'] ?? '';
      const message = body['body'] ?? '';
      const runId = body['runId'] ?? '';
      const result: SupportResult = await port.submitSupportRequest({
        subject,
        body: message,
        ...(runId === '' ? {} : { runId }),
      });
      return page(
        c,
        shell(port, {
          title: 'Support',
          path: '/app/support',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: SupportFormPage({
            csrfToken: session.csrfToken,
            submitted: result,
            subject: result.ok ? '' : subject,
            body: result.ok ? '' : message,
            runId: runId === '' ? null : runId,
          }),
        }),
        { status: result.ok ? 200 : 422 },
      );
    }),
  );

  /* --------------------------------------------------------------- cancellation */

  /*
   * The two pages Stripe returns a customer to, which had never existed.
   *
   * `checkoutReturnUrls` has always pointed at these paths and `portalReturnUrl` at the
   * second. The first real sandbox payment, on 20 September 2026, ended on a 404 — the
   * dominant defect class arriving at the worst moment available, immediately after
   * somebody paid.
   *
   * Both are GET and read-only. Nothing here activates a subscription: activation is the
   * webhook's job, and a redirect is not evidence that we have been told anything.
   */
  routes.get('/billing/return', async (c) =>
    withSession(c, async (port, session) => {
      const sessionId = c.req.query('session_id') ?? null;
      return page(
        c,
        shell(port, {
          title: 'Billing',
          path: '/app/billing',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: BillingReturnPage({
            activation: await port.activation(),
            // Stripe substitutes its own placeholder, so this is never customer input in
            // the ordinary case -- but it arrives in a query string, so it is rendered as
            // text and never used to look anything up.
            sessionId: sessionId === '' ? null : sessionId,
          }),
        }),
      );
    }),
  );

  routes.get('/billing', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Billing',
          path: '/app/billing',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: BillingPage({
            activation: await port.activation(),
            // Availability, not a link. This GET no longer creates a Stripe session.
            portal: await port.billingPortalAvailability(),
            csrfToken: session.csrfToken,
            checkoutCancelled: c.req.query('checkout') === 'cancelled',
          }),
        }),
      ),
    ),
  );

  /**
   * Open the billing portal: one fresh Stripe session per authorised click.
   *
   * A POST, so it runs through `withSession`'s CSRF check and cannot be triggered by a
   * link, a prefetch, an image tag or a crawler. That matters more here than usual: the
   * response body is a redirect to a bearer-secret URL, and a GET that mints one could be
   * fired by anything that touches the page.
   *
   * The URL goes straight into the `Location` of a 303 and nowhere else. It is not logged,
   * not stored, not counted and never rendered, which is the second half of the defect
   * this route replaces: the old control put it in an anchor on an authenticated page.
   *
   * `port.openBillingPortal` repeats the authorisation check rather than trusting that the
   * page drew a button, because the page is not what protects this route.
   */
  routes.post('/billing/portal', async (c) =>
    withSession(c, async (port, session) => {
      const opened = await port.openBillingPortal();
      if (opened.href !== null) return c.redirect(opened.href, 303);
      // Refused or Stripe failed: re-render the page the customer was on, carrying the
      // reason, rather than a bare error. 503 because nothing of theirs is wrong.
      return page(
        c,
        shell(port, {
          title: 'Billing',
          path: '/app/billing',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: BillingPage({
            activation: await port.activation(),
            portal: await port.billingPortalAvailability(),
            csrfToken: session.csrfToken,
            checkoutCancelled: false,
            portalProblem: opened.reason,
          }),
        }),
        { status: 503 },
      );
    }),
  );

  routes.get('/cancel', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Cancel your plan',
          path: '/app/cancel',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: CancelPage({
            portal: await port.billingPortalAvailability(),
            csrfToken: session.csrfToken,
          }),
        }),
      ),
    ),
  );

  return routes;
}

/** The router as mounted today: every page on the synthetic port. */
export const appRoutes: Hono<RouteBindings> = createAppRoutes();
