/**
 * The public router.
 *
 * Mount it at the root. Every route here is a GET that reads nothing but its own bindings:
 * no database, no session, no provider call. That is what makes the marketing and legal
 * surface safe to serve while the rest of the system is still being built.
 *
 * To mount (`apps/app/src/index.ts`, the lead's file):
 *
 *     import { publicRoutes } from './routes/public/index.js';
 *     app.route('/', publicRoutes);
 */
import { Hono } from 'hono';
import { PublicLayout, html } from '@verify/ui';
import { LIMITS } from '@verify/contracts';
/*
 * The allowance and the recovery window are read from the constants that govern them, not
 * retyped into a meta description. A description is the one sentence a search result quotes,
 * so a stale figure there is a wrong price shown to someone who never opens the page.
 */
import { PAYMENT_RECOVERY_DAYS } from '../../billing/policy.js';
import { DemoPage, syntheticStripe } from './demo.js';
import { DevelopmentStoryPage, loadDevelopmentStory } from './developmentStory.js';
import { HomePage } from './home.js';
import { PrivacyPage, RefundsPage, StatusPage, TermsPage } from './legal.js';
import { HowItWorksPage, PricingPage, SecurityPage, SupportPage } from './marketing.js';
import { failureBody, page, type RouteBindings } from './shared.js';

export const publicRoutes = new Hono<RouteBindings>();

/**
 * The failure state for the public surface. Nothing here reads a database, so this is
 * rarely reached — but a page that cannot be built must still answer with a page, not the
 * JSON envelope the Worker's global handler produces for the API. The cause is logged and
 * never rendered.
 */
publicRoutes.onError((error, c) => {
  console.error('public_page_failed', { path: c.req.path, message: String(error) });
  return page(
    c,
    PublicLayout({
      title: 'We could not load this page',
      path: c.req.path,
      body: failureBody({
        retryHref: c.req.path,
        supportHref: '/support',
        requestId: c.req.header('cf-ray') ?? 'unknown',
      }),
    }),
    { status: 500 },
  );
});

publicRoutes.get('/', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Know whether your automation actually did the job',
      /*
       * A meta description is quoted where none of the page's qualifying copy follows it —
       * a search result, a chat link preview, a shared card. The previous sentence
       * ("ITISYOU Verify reads your HubSpot record and Resend email status back itself and
       * tells you what the evidence shows") read as a running service, and the activation
       * notice on the page cannot qualify a sentence that has been lifted off the page.
       * So the state of the service travels with the description. CUST-336.
       */
      description:
        'ITISYOU Verify is built to read your HubSpot record and Resend email status back itself and tell you what the evidence shows. One workflow, four results, no guessing — and not yet accepting live traffic, so nothing is on sale today.',
      path: '/',
      body: HomePage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/how-it-works', (c) =>
  page(
    c,
    PublicLayout({
      title: 'How it works',
      description:
        'Connect HubSpot and Resend, define the expected result, and receive evidence. The full setup requirements, including the work this needs before day one.',
      path: '/how-it-works',
      body: HowItWorksPage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/pricing', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Pricing',
      /*
       * "Cancel from the billing portal at any time" is an instruction to someone who has
       * subscribed. Nobody can subscribe: checkout is closed, and the page says so. An
       * instruction quoted in a search result away from that notice reads as an open shop.
       * The seven-day recovery window is named here because it is the term a buyer is most
       * likely to be surprised by, and it is now on the page itself too. CUST-337.
       */
      description: `One plan, one workflow, ${LIMITS.PLAN_RUNS_PER_PERIOD} runs a month, no overage charges, and ${PAYMENT_RECOVERY_DAYS} days to fix a failed payment. We are not yet taking payment, so the full terms are here to read rather than to buy.`,
      path: '/pricing',
      body: PricingPage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/demo', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Worked example',
      description:
        'A labelled synthetic workspace showing four real verification runs — verified, failed, pending and unverified — produced by the live verification engine against synthetic evidence.',
      path: '/demo',
      beforeMain: syntheticStripe(),
      body: DemoPage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/security', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Security and data handling',
      description:
        'Where your data goes, every subprocessor that touches it, and how long evidence is kept. We hold no certification and do not claim one.',
      path: '/security',
      body: SecurityPage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/support', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Support',
      description:
        'Frequently asked questions about what this product covers, and how to reach us.',
      path: '/support',
      body: SupportPage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/terms', (c) =>
  page(c, PublicLayout({ title: 'Terms of service', path: '/terms', body: TermsPage() }), {
    cache: 'public',
  }),
);

publicRoutes.get('/privacy', (c) =>
  page(c, PublicLayout({ title: 'Privacy', path: '/privacy', body: PrivacyPage() }), {
    cache: 'public',
  }),
);

publicRoutes.get('/refunds', (c) =>
  page(
    c,
    PublicLayout({ title: 'Cancellation and refunds', path: '/refunds', body: RefundsPage() }),
    {
      cache: 'public',
    },
  ),
);

publicRoutes.get('/status', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Service status',
      description: 'What we can honestly tell you about availability. We publish no uptime figure.',
      path: '/status',
      body: StatusPage({
        environment: c.env.ENVIRONMENT,
        checkedAt: new Date()
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d{3}Z$/, ' UTC'),
      }),
    }),
  ),
);

publicRoutes.get('/development-story', async (c) => {
  const markdown = await loadDevelopmentStory(c.env.ASSETS, c.env.PUBLIC_BASE_URL);
  return page(
    c,
    PublicLayout({
      title: 'How this was built',
      path: '/development-story',
      body: DevelopmentStoryPage({ markdown }),
    }),
    { cache: 'public' },
  );
});

/*
 * There is deliberately no `/favicon.svg` route here. The lead added
 * `apps/app/public/favicon.svg`, and Workers Static Assets answer before the Worker, so a
 * route would be a second answer to the same path that could silently diverge from the file
 * actually served. `shell.ts` references `/favicon.svg`; the asset serves it.
 */

/** A 404 that is a real page rather than a bare string. */
export function notFoundPage(path: string) {
  return PublicLayout({
    title: 'Page not found',
    path,
    body: html`<div class="wrap section stack">
      <div class="stack-sm">
        <p class="eyebrow">404</p>
        <h1>That page does not exist</h1>
        <p class="lede measure">
          The address you asked for is not one we serve. Nothing has gone wrong with your account or your
          runs.
        </p>
      </div>
      <p><a href="/">Back to the home page</a> · <a href="/support">Support</a></p>
    </div>`,
  });
}
