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
import { DemoPage, syntheticStripe } from './demo.js';
import { DevelopmentStoryPage, loadDevelopmentStory } from './developmentStory.js';
import { HomePage } from './home.js';
import { PrivacyPage, RefundsPage, StatusPage, TermsPage } from './legal.js';
import { HowItWorksPage, PricingPage, SecurityPage, SupportPage } from './marketing.js';
import { page, type RouteBindings } from './shared.js';

export const publicRoutes = new Hono<RouteBindings>();

publicRoutes.get('/', (c) =>
  page(
    c,
    PublicLayout({
      title: 'Know whether your automation actually did the job',
      description:
        'ITISYOU Verify reads your HubSpot record and Resend email status back itself and tells you what the evidence shows. One workflow, four results, no guessing.',
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
      description:
        'One plan, one workflow, 500 runs a month, no overage charges. Cancel from the billing portal at any time.',
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
      description: 'Frequently asked questions about what this product covers, and how to reach us.',
      path: '/support',
      body: SupportPage(),
    }),
    { cache: 'public' },
  ),
);

publicRoutes.get('/terms', (c) =>
  page(c, PublicLayout({ title: 'Terms of service', path: '/terms', body: TermsPage() }), { cache: 'public' }),
);

publicRoutes.get('/privacy', (c) =>
  page(c, PublicLayout({ title: 'Privacy', path: '/privacy', body: PrivacyPage() }), { cache: 'public' }),
);

publicRoutes.get('/refunds', (c) =>
  page(c, PublicLayout({ title: 'Cancellation and refunds', path: '/refunds', body: RefundsPage() }), {
    cache: 'public',
  }),
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
        checkedAt: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'),
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

/** The favicon: the product mark, drawn rather than fetched. */
publicRoutes.get('/favicon.svg', (c) =>
  c.body(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="6" fill="#10161C"/>' +
      '<circle cx="16" cy="16" r="9" fill="none" stroke="#F1F4F6" stroke-width="2"/>' +
      '<path d="M11.5 16.4 14.6 19.4 20.8 12.6" fill="none" stroke="#5CCCA4" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',
    200,
    {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  ),
);

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
