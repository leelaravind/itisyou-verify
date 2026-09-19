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
import { page, type RouteBindings } from '../public/shared.js';
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
import {
  DEADLINE_CHOICES,
  SyntheticCustomerDataPort,
  maskedAccountLabel,
} from './syntheticPort.js';
import { SELECTABLE_COVERAGE_MODES } from '@verify/domain';
import type { CoverageMode } from '@verify/contracts';
import type {
  CustomerDataPort,
  ProofRunView,
  SigningKeyIssueResult,
  SupportResult,
  WriteResult,
} from './port.js';
import { html, type Html } from '@verify/ui';
import { isSameOriginRequest } from '@verify/security';

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

  /**
   * Every authenticated route runs through this. No session means the sign-in page, at 401
   * — not a redirect that loses the reason, and not a blank page.
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
      return page(
        c,
        shell(port, {
          title: 'Sign in',
          path: '/app/sign-in',
          body: SignInPage({ csrfToken: null, submitted: null, email: '', linkSent: false }),
        }),
        { status: 401 },
      );
    }
    return render(port, session);
  }

  /* -------------------------------------------------------------------- sign in */

  routes.get('/sign-in', async (c) => {
    const port = await resolve(c);
    const session = await port.session();
    if (session !== null) return c.redirect('/app', 303);
    return page(
      c,
      shell(port, {
        title: 'Sign in',
        path: '/app/sign-in',
        body: SignInPage({ csrfToken: null, submitted: null, email: '', linkSent: false }),
      }),
    );
  });

  routes.post('/sign-in', async (c) => {
    const port = await resolve(c);
    const body = await formBody(c);
    const email = body['email'] ?? '';
    const result = await port.requestSignInLink(email);
    if (result.ok) return c.redirect(result.redirectTo ?? '/app', 303);
    return page(
      c,
      shell(port, {
        title: 'Sign in',
        path: '/app/sign-in',
        body: SignInPage({
          csrfToken: body['csrf_token'] ?? null,
          submitted: result,
          email,
          linkSent: false,
        }),
      }),
      { status: 422 },
    );
  });

  routes.post('/sign-out', async (c) => {
    const port = await resolve(c);
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
          body: CompatibilityPage(await port.connectorCompatibility()),
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
      const sameOrigin =
        isSameOriginRequest(c.req.raw, c.env.PUBLIC_BASE_URL) ||
        isSameOriginRequest(c.req.raw, new URL(c.req.url).origin);
      const result: SigningKeyIssueResult = sameOrigin
        ? await port.issueSigningKey()
        : {
            outcome: 'refused',
            reason: 'cross_site',
            message:
              'That request did not come from this site, so nothing was changed. Use the button on this page.',
          };
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
      const workflow = await port.workflow();
      const runPage = await port.listRuns({
        limit: RUNS_PER_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
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
          body: RunDetailPage({ run }),
        }),
      );
    }),
  );

  /* ----------------------------------------------------- connections and usage */

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
          }),
        }),
      ),
    ),
  );

  routes.get('/usage', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Usage',
          path: '/app/usage',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: UsagePage(await port.usage()),
        }),
      ),
    ),
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

  routes.get('/cancel', async (c) =>
    withSession(c, async (port, session) =>
      page(
        c,
        shell(port, {
          title: 'Cancel your plan',
          path: '/app/cancel',
          accountLabel: maskedAccountLabel(session.email),
          csrfToken: session.csrfToken,
          body: CancelPage({ portal: await port.billingPortalLink() }),
        }),
      ),
    ),
  );

  return routes;
}

/** The router as mounted today: every page on the synthetic port. */
export const appRoutes: Hono<RouteBindings> = createAppRoutes();
