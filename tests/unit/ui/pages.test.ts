/**
 * CUST-041..CUST-056 — whole pages.
 *
 * These render the real route bodies, so they catch the mistakes component tests cannot:
 * a limitation dropped from a layout, a placeholder quietly omitted from a legal page, a
 * demo that stops being driven by the real engine.
 */
import { describe, expect, it } from 'vitest';
import { AppLayout, CSS, PublicLayout, THEME_SCRIPT, meterFillClass, render } from '@verify/ui';
import { HomePage } from '../../../apps/app/src/routes/public/home.js';
import { DemoPage } from '../../../apps/app/src/routes/public/demo.js';
import { DEMO_HEALTH, DEMO_RUNS } from '../../../apps/app/src/routes/public/demoData.js';
import {
  PrivacyPage,
  RefundsPage,
  StatusPage,
  TermsPage,
} from '../../../apps/app/src/routes/public/legal.js';
import { SupportPage } from '../../../apps/app/src/routes/public/marketing.js';
import {
  DevelopmentStoryPage,
  renderMarkdownSubset,
} from '../../../apps/app/src/routes/public/developmentStory.js';
import { WorkspacePage } from '../../../apps/app/src/routes/app/workspacePage.js';
import {
  RunDetailPage,
  RunListPage,
  maskValues,
} from '../../../apps/app/src/routes/app/runPages.js';
import {
  SyntheticCustomerDataPort,
  resetSyntheticState,
} from '../../../apps/app/src/routes/app/syntheticPort.js';

const NOW = new Date('2026-03-01T23:00:00.000Z');

describe('public pages', () => {
  it('CUST-041 the layout sets a British English lang, a viewport, and does not index an authenticated page', async () => {
    const publicMarkup = await render(PublicLayout({ title: 'Home', path: '/', body: HomePage() }));
    expect(publicMarkup).toContain('<html lang="en-GB">');
    expect(publicMarkup).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(publicMarkup).not.toContain('name="robots"');

    const appMarkup = await render(
      AppLayout({ title: 'Workspace', path: '/app', body: HomePage() }),
    );
    expect(appMarkup).toContain('name="robots" content="noindex, nofollow"');
  });

  it('CUST-042 every page offers a skip link that lands on the main landmark', async () => {
    const markup = await render(PublicLayout({ title: 'Home', path: '/', body: HomePage() }));
    expect(markup).toContain('<a class="skip" href="#main">Skip to main content</a>');
    expect(markup).toContain('<main id="main"');
  });

  it('CUST-043 the home page states what the product does not do, with the same weight as what it does', async () => {
    const markup = await render(HomePage());
    expect(markup).toContain('What this does not do');
    expect(markup).toContain('It does not fix anything');
    // "by default" came off this heading on 2026-09-19. It implied a non-default setting
    // that would detect a run that never started; `packages/domain/src/coverage.ts` marks
    // that mode unsupported and unselectable, and no connector or scheduler pass can deliver
    // it. The assertion is tightened, not weakened: the heading must now be the unqualified
    // one, so restoring the old copy fails here as well as in CUST-330.
    expect(markup).toContain('It does not detect a run that never started<');
    expect(markup).toContain('It is not instant');
  });

  it('CUST-044 the home page shows all four statuses in A01’s own words', async () => {
    const markup = await render(HomePage());
    for (const word of ['Verified', 'Failed', 'Unverified', 'Pending']) {
      expect(markup).toContain(word);
    }
    expect(markup).toContain('This is not a pass and not a failure.');
  });

  it('CUST-045 the demo’s four runs are produced by the real engine, one of each status', async () => {
    expect(DEMO_RUNS.map((run) => run.status)).toEqual([
      'VERIFIED',
      'FAILED',
      'PENDING',
      'UNVERIFIED',
    ]);
    // The demo deliberately does not flatter itself: one failure and one unverified.
    expect(DEMO_HEALTH.verified_percentage).toBe(33);
    expect(DEMO_HEALTH.state).toBe('degraded');
  });

  it('CUST-046 the demo is unmistakably marked synthetic and accepts no input', async () => {
    const markup = await render(DemoPage());
    expect(markup).toContain('Synthetic workspace');
    expect(markup).toContain(
      'Every record, address, account and message on this page is invented.',
    );
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<textarea');
  });

  it('CUST-047 the demo masks addresses even though they are synthetic, so it teaches the right expectation', async () => {
    const markup = await render(DemoPage());
    expect(markup).not.toContain('ada@example.test');
    expect(markup).toContain('a**@example.test');
  });

  it('CUST-048 the demo shows the coverage limitation and the standing limitations on the page itself', async () => {
    const markup = await render(DemoPage());
    expect(markup).toContain('data-coverage-limitation');
    expect(markup).toContain('data-standing-limitations');
    expect(markup).not.toContain('<details');
  });

  it('CUST-049 the demo shows the rule version, source type and timestamps that produced each verdict', async () => {
    const markup = await render(DemoPage());
    expect(markup).toContain('Rule version');
    expect(markup).toContain('Source type');
    expect(markup).toContain('signed source event');
    expect(markup).toContain('wf_demo@v1');
  });

  it('CUST-050 the real owner-confirmed identity renders on the legal pages, with no placeholder left', async () => {
    for (const body of [TermsPage(), PrivacyPage()]) {
      const markup = await render(body);
      expect(markup).toContain('Leela Aravind Karlapudi, trading as ITISYOU');
      expect(markup).toContain(
        'Lytchett House, 13 Freeland Park, Wareham Road, Poole, Dorset, BH16 6FA, United Kingdom',
      );
      expect(markup).toContain('Not applicable (sole trader)');
      expect(markup).toContain('Not VAT-registered');
      expect(markup).toContain('Sole trader');
      // No TODO marker leaks anywhere now that every owner-identity field is real.
      expect(markup).not.toContain('TODO_OWNER_INPUT');
      expect(markup).not.toContain('Not yet published');
    }
  });

  it('CUST-051 the refunds page states the plain legal-minimum refund position, with no placeholder', async () => {
    const markup = await render(RefundsPage());
    expect(markup).toContain('Refund policy');
    expect(markup).toContain(
      'We do not offer partial refunds for the unused part of a billing period unless required by law.',
    );
    expect(markup).not.toContain('TODO_OWNER_INPUT');
  });

  it('CUST-052 the status page publishes no uptime figure and no green tick', async () => {
    const markup = await render(
      StatusPage({ environment: 'development', checkedAt: '2026-03-01 12:00 UTC' }),
    );
    expect(markup).toContain('We publish no uptime figure and no incident history');
    expect(markup).not.toMatch(/all systems operational/i);
    expect(markup).not.toMatch(/\b99\.9\d*%/);
  });

  it('CUST-053 the public support page shows the real contact address now that the owner has supplied one', async () => {
    const markup = await render(SupportPage());
    expect(markup).toContain('support@itisyou.app');
    expect(markup).not.toContain('Not yet published — contactEmailForLegalNotices');
  });

  it('CUST-054 the development story renders an honest empty state when the document is not published', async () => {
    const markup = await render(DevelopmentStoryPage({ markdown: null }));
    expect(markup).toContain('Not yet published');
    expect(markup).toContain('We would rather show an empty page');
  });

  it('CUST-055 the development story renderer escapes markup in the document and refuses a javascript: link', async () => {
    const rendered = renderMarkdownSubset(
      '# Title\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1)) and [ok](https://example.test/a)\n',
    );
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).not.toContain('href="javascript:');
    // Links now carry rel, because the target goes through the shared scheme guard (SEC-1214).
    expect(rendered).toContain(
      '<a href="https://example.test/a" rel="nofollow noopener noreferrer">ok</a>',
    );
  });
});

describe('customer pages', () => {
  it('CUST-056 the workspace shows the rate and the activity signal as two separate blocks', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const markup = await render(
      WorkspacePage({
        canStartSetup: true,
        workflow: await port.workflow(),
        recentRuns: (await port.listRuns({ limit: 5 })).items,
        connections: await port.connections(),
        usage: await port.usage(),
        now: NOW,
      }),
    );
    expect(markup).toContain('Verification rate');
    expect(markup).toContain('Are enquiries still arriving?');
    expect(markup).toContain('data-health-state');
    expect(markup).toContain('data-coverage-limitation');
  });

  it('CUST-057 a workspace with no runs at all shows the headline, never a bar', async () => {
    const markup = await render(
      WorkspacePage({
        canStartSetup: true,
        workflow: {
          id: 'wf_1',
          name: 'Quiet workflow',
          coverageMode: 'customer_triggered',
          deadlineSeconds: 600,
          active: true,
          lastEventAt: null,
          counts: { verified: 0, failed: 0, unverified: 0, pending: 0 },
          mapping: { correlationProperty: 'verify_correlation_id', availableProperties: [] },
          outcome: {
            deadlineSeconds: 600,
            requireRecordExists: true,
            requireCorrelationMatch: true,
            requireEmailDelivered: true,
            requireRecipientMatch: true,
            coverageMode: 'customer_triggered',
          },
          signingKeyHint: null,
        },
        recentRuns: [],
        connections: [],
        usage: {
          periodStart: '2026-03-01T00:00:00.000Z',
          periodEnd: '2026-04-01T00:00:00.000Z',
          runsUsed: 0,
          runsIncluded: 500,
          admissionBlocked: false,
          subscriptionStatus: null,
        },
        now: NOW,
      }),
    );
    expect(markup).toContain('No runs received yet');
    expect(markup).toContain('data-score="none"');
    expect(markup).not.toContain('class="meter"');
    expect(markup).toContain('No enquiries received yet');
  });

  it('CUST-058 a hostile workflow name is escaped on the workspace heading', async () => {
    const markup = await render(
      WorkspacePage({
        canStartSetup: true,
        workflow: {
          id: 'wf_1',
          name: '<script>alert("wf")</script>',
          coverageMode: 'customer_triggered',
          deadlineSeconds: 600,
          active: true,
          lastEventAt: null,
          counts: { verified: 1, failed: 0, unverified: 0, pending: 0 },
          mapping: { correlationProperty: 'p', availableProperties: [] },
          outcome: {
            deadlineSeconds: 600,
            requireRecordExists: true,
            requireCorrelationMatch: false,
            requireEmailDelivered: false,
            requireRecipientMatch: false,
            coverageMode: 'customer_triggered',
          },
          signingKeyHint: null,
        },
        recentRuns: [],
        connections: [],
        usage: {
          periodStart: '2026-03-01T00:00:00.000Z',
          periodEnd: '2026-04-01T00:00:00.000Z',
          runsUsed: 0,
          runsIncluded: 500,
          admissionBlocked: false,
          subscriptionStatus: null,
        },
        now: NOW,
      }),
    );
    expect(markup).not.toContain('<script>alert');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('CUST-059 the run list is cursor paginated and never invents a page number', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const firstPage = await port.listRuns({ limit: 3 });
    expect(firstPage.nextCursor).not.toBeNull();
    const markup = await render(
      RunListPage({ page: firstPage, workflowName: 'Enquiry workflow', basePath: '/app/runs' }),
    );
    expect(markup).toContain(`/app/runs?cursor=${firstPage.nextCursor}`);
    expect(markup).not.toMatch(/page \d+ of \d+/i);
  });

  it('CUST-060 an empty run list says so honestly rather than showing a passing score', async () => {
    const markup = await render(
      RunListPage({
        page: { items: [], nextCursor: null, prevCursor: null },
        workflowName: 'Enquiry workflow',
        basePath: '/app/runs',
      }),
    );
    expect(markup).toContain('No runs received yet');
    expect(markup).toContain('That is not a pass');
  });

  it('CUST-061 the run detail masks the recipient and every address in an expected or observed value', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const run = await port.run('run_syn_0002');
    expect(run).not.toBeNull();
    const markup = await render(RunDetailPage({ run: run! }));
    expect(markup).not.toContain('ada@example.test');
    expect(markup).toContain('a**@example.test');
  });

  it('CUST-062 the run detail shows source type, rule version, coverage limitation and the reason codes', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const run = await port.run('run_syn_0004');
    const markup = await render(RunDetailPage({ run: run! }));
    expect(markup).toContain('Source type');
    expect(markup).toContain('Rule version');
    expect(markup).toContain('wf_syn_0001@v1');
    expect(markup).toContain('data-coverage-limitation');
    expect(markup).toContain('reason CONNECTION_UNAVAILABLE');
    // The plain sentence is present, and the code alone is never the whole message.
    expect(markup).toContain('we could not look');
  });

  it('CUST-063 an unverified run is never described as a failure', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const run = await port.run('run_syn_0004');
    expect(run?.status).toBe('UNVERIFIED');
    const markup = await render(RunDetailPage({ run: run! }));
    expect(markup).toContain('This is not a failure');
    expect(markup).not.toContain('badge--failed');
  });

  it('CUST-064 masking leaves non-address values alone', () => {
    expect(maskValues('record crm-rec-1 carrying enq_0000000000000001')).toBe(
      'record crm-rec-1 carrying enq_0000000000000001',
    );
    expect(maskValues('sent to ada@example.test')).toBe('sent to a**@example.test');
    expect(maskValues(null)).toBeNull();
  });
});

describe('inline blocks and the Content-Security-Policy', () => {
  it('CUST-065 the inline style and script blocks contain exactly the constant, so their CSP hashes match', async () => {
    const markup = await render(PublicLayout({ title: 'Home', path: '/', body: HomePage() }));
    // The Worker's CSP carries sha256 of these constants. A browser hashes the exact bytes
    // between the tags, so a single space added by a reformat breaks styling site-wide.
    expect(markup).toContain(`<style>${CSS}</style>`);
    expect(markup).toContain(`<script>${THEME_SCRIPT}</script>`);
    expect(markup).not.toMatch(/<style>\s/);
    expect(markup).not.toMatch(/\s<\/style>/);
    expect(markup).not.toMatch(/<script>\s/);
    expect(markup).not.toMatch(/\s<\/script>/);
  });

  it('CUST-066 the page loads nothing from a third party, so default-src none can hold', async () => {
    const markup = await render(PublicLayout({ title: 'Demo', path: '/demo', body: DemoPage() }));
    expect(markup).not.toMatch(/<link[^>]+href="https?:\/\//);
    expect(markup).not.toMatch(/<script[^>]+src=/);
    expect(markup).not.toMatch(/<img[^>]+src="https?:\/\//);
    expect(markup).not.toContain('fonts.googleapis.com');
    expect(markup).not.toContain('@import');
  });
});

describe('no inline style attributes anywhere', () => {
  /**
   * The Worker's CSP sets `style-src-attr 'none'`. A blocked `style="width:33%"` does not
   * error — the declaration is simply dropped, and the element falls back to its natural
   * size. That is how a 33% verification rate came to be drawn as a full green bar on the
   * deployed demo page. This case is the guard against it ever returning.
   */
  const pages: readonly (readonly [string, () => Promise<string>])[] = [
    ['/', async () => render(PublicLayout({ title: 'Home', path: '/', body: HomePage() }))],
    ['/demo', async () => render(PublicLayout({ title: 'Demo', path: '/demo', body: DemoPage() }))],
    [
      '/terms',
      async () => render(PublicLayout({ title: 'Terms', path: '/terms', body: TermsPage() })),
    ],
    [
      '/privacy',
      async () => render(PublicLayout({ title: 'Privacy', path: '/privacy', body: PrivacyPage() })),
    ],
    [
      '/status',
      async () =>
        render(
          PublicLayout({
            title: 'Status',
            path: '/status',
            body: StatusPage({ environment: 'test', checkedAt: 'now' }),
          }),
        ),
    ],
  ];

  it('CUST-096 no rendered page emits a style attribute', async () => {
    for (const [path, build] of pages) {
      const markup = await build();
      expect(markup, `${path} emits an inline style attribute`).not.toMatch(/\sstyle="/);
    }
  });

  it('CUST-097 a meter width is expressed as a class at 5% granularity, and never rounds up to full', async () => {
    expect(meterFillClass(33)).toBe('meter__fill meter__fill--30');
    expect(meterFillClass(0)).toBe('meter__fill meter__fill--0');
    expect(meterFillClass(100)).toBe('meter__fill meter__fill--100');
    expect(meterFillClass(null)).toBe('meter__fill meter__fill--0');
    // A partial rate must never carry the class that fills the bar.
    for (const value of [1, 33, 50, 66, 97]) {
      expect(meterFillClass(value)).not.toContain('--100');
    }
  });
});
