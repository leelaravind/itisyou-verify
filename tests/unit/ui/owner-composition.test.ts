/**
 * OWNER-901..OWNER-904 — the owner overview's launch figures and the composition of the
 * two owner screens recomposed to the approved designs: `/owner` and `/owner/quality`.
 *
 * These cases pin two things at once. First, that every figure on the overview is the
 * port's own value or the word "unknown" — never a zero for something nobody measured, and
 * never a literal typed into the page: the money figure is proved computed by rendering two
 * different inputs. Second, the arrangement — head beside a mono bar, the figures as one
 * strip of tiles, the money table in the wider column, the health as a framed table with a
 * tally — and that none of the reference screens' words, prices or badges arrived with it.
 * The owner references carry an operator console with invented incidents, budgets, a
 * "contingency reserve" and a cryptographic test estate; none of that is ours.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@verify/ui';
import { OverviewPage } from '../../../apps/app/src/routes/owner/dashboardPages.js';
import { QualityPage } from '../../../apps/app/src/routes/owner/qualityPages.js';
import { displayMinor, summariseFinance } from '../../../apps/app/src/owner/finance.js';
import type { OverviewView } from '../../../apps/app/src/owner/port.js';
import type { QualityRun } from '../../../apps/app/src/owner/quality.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const OBSERVED = '2026-09-20T11:50:00.000Z';
const CSRF = 'test-csrf-token';

function text(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

/** The rendered value of one figure tile, by its key. */
function figureValue(markup: string, key: string): string {
  const open = `<span data-figure-value="${key}">`;
  const at = markup.indexOf(open);
  expect(at, key).toBeGreaterThan(-1);
  return markup.slice(at + open.length, markup.indexOf('</span>\n', at));
}

function view(overrides: Partial<OverviewView> = {}): OverviewView {
  return {
    finance: {
      currency: 'GBP',
      cashRevenueMinor: 0,
      refundsMinor: 0,
      variableCostsMinor: null,
      outstandingCommitmentsMinor: null,
      startupCashRemainingMinor: 10_000,
      lastRefreshAt: OBSERVED,
      estimatedFields: [],
    },
    health: [
      { component: 'worker', state: 'ok', detail: 'Serving requests.', observedAt: OBSERVED },
      {
        component: 'database',
        state: 'unknown',
        detail: 'No health probe is wired to this deployment.',
        observedAt: null,
      },
      { component: 'money path', state: 'degraded', detail: 'One webhook late.', observedAt: OBSERVED },
    ],
    customersActive: 2,
    customersTotal: 7,
    launch: {
      totalVisits: { value: 13, observedAt: OBSERVED },
      adAttributedVisits: { value: 5, observedAt: OBSERVED },
      qualifiedSignups: { value: 3, observedAt: OBSERVED },
      payingCustomers: { value: 2, observedAt: OBSERVED },
    },
    pendingApprovals: 1,
    openSupportCases: 0,
    runsLast24h: 11,
    assembledAt: NOW.toISOString(),
    ...overrides,
  };
}

const FIGURE_KEYS = [
  'external-visits',
  'ad-attributed-visits',
  'qualified-signups',
  'paying-customers',
  'customers-total',
  'paid-orders',
  'cash-received',
  'runs-24h',
];

/**
 * Phrases the owner reference screens carry and these pages must never render. Layout
 * only: the console vocabulary, the invented incidents and budgets, the test-estate
 * cryptography.
 */
// claim-scan:allow these are the strings the cases below assert are ABSENT from the rendered pages
const OWNER_REFERENCE_COPY_THAT_MUST_NOT_ARRIVE = [
  'Operational',
  'Contingency',
  'Escrow',
  'Enclave',
  'Cluster',
  'Wireguard',
  'Watchdog',
  'Dunning',
  'Telemetry',
  'Forensic',
  'INC-2025',
  'Discrepancy',
  'Quorum',
  'Airgap',
  'Purge',
  'Manifest',
  'cgroup',
  'Pinned',
  'SHA-256',
  'Immutable',
  'Deterministic',
  'Accounts',
  'Incidents',
];

function run(overrides: Partial<QualityRun> = {}): QualityRun {
  return {
    id: 'qr_1',
    suiteId: 'unit',
    environment: 'development',
    executor: 'local_runner',
    state: 'passed',
    commitSha: 'd477586abcdef0123456',
    dedupeKey: 'unit:d477586',
    requestedBy: 'usr_synthetic_owner',
    totalCases: 10,
    passed: 10,
    failed: 0,
    skipped: 0,
    startedAt: OBSERVED,
    endedAt: NOW.toISOString(),
    createdAt: OBSERVED,
    reportRef: null,
    limitations: 'Nothing about the database, the browser or any provider.',
    blockedReason: null,
    ...overrides,
  };
}

describe('the owner overview figures', () => {
  it('OWNER-901 every launch figure renders the port’s own value — eight tiles in a fixed order, the money figure computed from minor units, and no literal anywhere', async () => {
    const markup = await render(OverviewPage({ view: view(), now: NOW, paidOrders: 4 }));

    expect([...markup.matchAll(/data-launch-figure="([a-z0-9-]+)"/g)].map((m) => m[1])).toEqual(FIGURE_KEYS);
    expect(figureValue(markup, 'external-visits')).toBe('13');
    expect(figureValue(markup, 'ad-attributed-visits')).toBe('5');
    expect(figureValue(markup, 'qualified-signups')).toBe('3');
    expect(figureValue(markup, 'paying-customers')).toBe('2');
    expect(figureValue(markup, 'customers-total')).toBe('7');
    expect(figureValue(markup, 'paid-orders')).toBe('4');
    expect(figureValue(markup, 'runs-24h')).toBe('11');
    // Zero pence is an explicit zero from the port, formatted, not the absence of a figure.
    expect(figureValue(markup, 'cash-received')).toBe('£0.00');
    expect(markup.slice(markup.indexOf('data-launch-figure="cash-received"'), markup.indexOf('data-launch-figure="runs-24h"'))).not.toContain('data-unknown');

    // The same page with a different ledger renders a different figure: the pounds are
    // arithmetic over the port's minor units, so the string above cannot be a literal.
    const paid = await render(
      OverviewPage({
        view: view({ finance: { ...view().finance, cashRevenueMinor: 1234 } }),
        now: NOW,
        paidOrders: 0,
      }),
    );
    expect(figureValue(paid, 'cash-received')).toBe('£12.34');
    expect(figureValue(paid, 'paid-orders')).toBe('0');

    // The four launch numbers keep the labels the dependency and browser suites look for.
    for (const label of [
      'People who visited',
      'Of those, arrived from an advert',
      'Created a workspace and connected something',
      'Paying customers',
    ]) {
      expect(markup).toContain(`data-launch-metric="${label}"`);
    }
  });

  it('OWNER-902 a figure whose read failed renders the word unknown and no numeral — for one read, for the order count, and for the whole overview', async () => {
    // Every per-figure null the port can return, at once.
    const nulls = await render(
      OverviewPage({
        view: view({
          finance: { ...view().finance, cashRevenueMinor: null },
          customersTotal: null,
          runsLast24h: null,
          launch: {
            totalVisits: { value: null, observedAt: null },
            adAttributedVisits: { value: null, observedAt: null },
            qualifiedSignups: { value: null, observedAt: null },
            payingCustomers: { value: null, observedAt: null },
          },
        }),
        now: NOW,
        paidOrders: null,
      }),
    );
    for (const key of FIGURE_KEYS) {
      const value = figureValue(nulls, key);
      expect(value, key).toContain('data-unknown="true"');
      expect(text(value), key).toBe('unknown');
      expect(value, key).not.toMatch(/\d/);
    }
    // The figure the port did answer still renders, beside the ones it did not.
    const mixed = await render(
      OverviewPage({ view: view({ customersTotal: null }), now: NOW, paidOrders: null }),
    );
    expect(figureValue(mixed, 'external-visits')).toBe('13');
    expect(text(figureValue(mixed, 'customers-total'))).toBe('unknown');
    expect(text(figureValue(mixed, 'paid-orders'))).toBe('unknown');

    // The overview read itself failed: every tile unknown, the approvals count unknown
    // rather than "Nothing", the health table says why it is empty, and no zero appears
    // in any figure slot.
    const failed = await render(OverviewPage({ view: null, now: NOW, paidOrders: null }));
    for (const key of FIGURE_KEYS) expect(text(figureValue(failed, key)), key).toBe('unknown');
    expect(count(failed, 'data-unknown="true"')).toBeGreaterThanOrEqual(FIGURE_KEYS.length + 2);
    expect(failed).not.toMatch(/data-figure-value="[a-z0-9-]+">0</);
    const waiting = failed.slice(failed.indexOf('>Waiting for you<'), failed.indexOf('Open approvals'));
    expect(waiting).toContain('data-unknown="true"');
    expect(waiting).not.toContain('Nothing');
    const bar = failed.slice(failed.indexOf('aria-label="About this page"'), failed.indexOf('</ul>'));
    expect(bar).toContain('Approvals waiting');
    expect(bar).toContain('data-unknown="true"');
    expect(failed).toContain('The overview could not be read, so no component health is known.');
    expect(failed).toContain('How the business is doing');
  });
});

describe('the owner overview composition', () => {
  it('OWNER-903 the head sits beside a mono bar of the page’s own facts, the figures follow as one strip, the money table takes the wider column, and the health closes as a framed table with a four-state tally — with no reference copy and no second price', async () => {
    const v = view({ finance: { ...view().finance, cashRevenueMinor: 2900 } });
    const markup = await render(OverviewPage({ view: v, now: NOW, paidOrders: 1 }));

    const head = markup.indexOf('<div class="section-head">');
    const bar = markup.indexOf('<ul class="meta-bar" aria-label="About this page">');
    const panel = markup.indexOf('<section class="panel" aria-labelledby="launch-figures-heading">');
    const strip = markup.indexOf('<div class="count-grid" data-launch-figures>', panel);
    const grid = markup.indexOf('<div class="grid grid-7-5">', strip);
    const money = markup.indexOf('>Money<', grid);
    const customers = markup.indexOf('>Customers<', money);
    const waiting = markup.indexOf('>Waiting for you<', customers);
    const health = markup.indexOf('<h2 id="service-health-heading">Service health</h2>', waiting);
    const results = markup.indexOf('<div class="results">', health);
    const table = markup.indexOf('<div class="tablewrap"', results);
    const resultsBar = markup.indexOf('<div class="results__bar">', table);
    const assembled = markup.indexOf('Page assembled', resultsBar);
    for (const at of [head, bar, panel, strip, grid, money, customers, waiting, health, results, table, resultsBar, assembled]) {
      expect(at).toBeGreaterThan(-1);
    }
    // The bar carries the page's own facts and nothing invented.
    const barText = text(markup.slice(bar, markup.indexOf('</ul>', bar)));
    expect(barText).toContain('Assembled');
    expect(barText).toContain('Approvals waiting 1');
    // Eight tiles, each a card inside the strip, each carrying its label as an eyebrow.
    const stripSlice = markup.slice(strip, grid);
    expect(count(stripSlice, 'data-launch-figure=')).toBe(8);
    expect(count(stripSlice, '<p class="eyebrow">')).toBe(8);
    // The tally names all four health states, zeros included, and each count is the
    // number of rows in that state — the same rows the table above it shows.
    const tally = markup.slice(resultsBar, markup.indexOf('</ul>', resultsBar));
    expect([...tally.matchAll(/data-health-tally="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      'ok',
      'degraded',
      'down',
      'unknown',
    ]);
    for (const [state, n] of [['ok', 1], ['degraded', 1], ['down', 0], ['unknown', 1]] as const) {
      const at = tally.indexOf(`data-health-tally="${state}"`);
      expect(tally.slice(at, tally.indexOf('</li>', at)), state).toContain(`<span class="tally__count">${String(n)}</span>`);
    }
    expect(count(markup.slice(table, resultsBar), 'data-health-state=')).toBe(3);
    // An unknown component is "not known", never a state word it did not report.
    expect(markup).toContain('data-health-state="unknown">not known<');
    expect(text(markup)).toContain('3 components');

    // style-src-attr 'none': a style attribute renders as nothing, silently.
    expect(markup).not.toMatch(/\sstyle=/);
    const body = text(markup);
    for (const phrase of OWNER_REFERENCE_COPY_THAT_MUST_NOT_ARRIVE) {
      expect(body, `carries "${phrase}"`).not.toContain(phrase);
    }
    // Every pound figure on the page is one the finance summary or the ledger computed
    // from the fixture; the reference's budgets and reserves cannot arrive with the layout.
    const allowed = new Set([
      ...summariseFinance(v.finance).lines.map((line) => line.display),
      displayMinor(v.finance.cashRevenueMinor, v.finance.currency),
    ]);
    const pounds = body.match(/£[\d,.]+/g) ?? [];
    expect(pounds.length).toBeGreaterThan(0);
    for (const figure of pounds) expect(allowed.has(figure), figure).toBe(true);
  });
});

describe('the test centre composition', () => {
  it('OWNER-904 the head sits beside a mono bar, the suite form takes the wider column with the evidence pack beside it, and the runs close as a framed table whose tally wears a verdict badge only for a verdict', async () => {
    const runs: readonly QualityRun[] = [
      run(),
      run({ id: 'qr_2', suiteId: 'integration', state: 'failed', passed: 8, failed: 2, dedupeKey: 'integration:d477586' }),
      run({
        id: 'qr_3',
        suiteId: 'browser',
        state: 'awaiting_runner',
        commitSha: null,
        totalCases: null,
        passed: null,
        failed: null,
        skipped: null,
        startedAt: null,
        endedAt: null,
        dedupeKey: 'browser:pending',
        blockedReason: 'No test executor is connected to this deployment.',
      }),
    ];
    const markup = await render(
      QualityPage({
        runs,
        csrfToken: CSRF,
        artifactsUnavailableReason: null,
        formMessage: null,
        formDependency: null,
      }),
    );

    const head = markup.indexOf('<div class="section-head">');
    const bar = markup.indexOf('<ul class="meta-bar" aria-label="About this centre">');
    const strip = markup.indexOf('<dl class="metrics" aria-label="Runs by state">', bar);
    const grid = markup.indexOf('<div class="grid grid-7-5">', strip);
    const form = markup.indexOf('>Run a suite<', grid);
    const pack = markup.indexOf('>Evidence pack<', form);
    const heading = markup.indexOf('<h2 id="quality-runs-heading">Runs</h2>', pack);
    const results = markup.indexOf('<div class="results">', heading);
    const table = markup.indexOf('<div class="tablewrap"', results);
    const resultsBar = markup.indexOf('<div class="results__bar">', table);
    for (const at of [head, bar, strip, grid, form, pack, heading, results, table, resultsBar]) expect(at).toBeGreaterThan(-1);
    const barText = text(markup.slice(bar, markup.indexOf('</ul>', bar)));
    expect(barText).toContain('Runs 3');
    expect(barText).toMatch(/Suites \d/);
    expect(barText).toMatch(/Evidence pack \d files/);
    // The strip of counts by state — the reference's opening block — carries one entry per
    // state that occurred, verdicts first, each count the number of rows in that state,
    // and the label is the plain-language one, never a bare state word or a colour.
    const stripSlice = markup.slice(strip, markup.indexOf('</dl>', strip));
    expect([...stripSlice.matchAll(/data-job-metric="([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      'passed',
      'failed',
      'awaiting_runner',
    ]);
    expect(count(stripSlice, '<dd>1</dd>')).toBe(3);
    expect(stripSlice).toContain('<dt>Waiting for a runner</dt>');
    expect(stripSlice).not.toContain('badge--');
    // The form still posts to the same action with the same token and the same radios.
    expect(markup).toContain('action="/owner/quality/run"');
    expect(markup).toContain(`name="csrf_token" value="${CSRF}"`);
    expect(count(markup, 'name="suite_id"')).toBeGreaterThan(0);

    // The tally lists only the states that occurred, in verdict-first order, and each
    // count is the number of rows wearing that state. A run that proved nothing wears the
    // amber dash — never green, never red.
    const tally = markup.slice(resultsBar, markup.indexOf('</ul>', resultsBar));
    expect([...tally.matchAll(/data-job-tally="([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      'passed',
      'failed',
      'awaiting_runner',
    ]);
    const item = (state: string): string => {
      const at = tally.indexOf(`data-job-tally="${state}"`);
      return tally.slice(at, tally.indexOf('</li>', at));
    };
    expect(item('passed')).toContain('badge--verified');
    expect(item('failed')).toContain('badge--failed');
    expect(item('awaiting_runner')).toContain('badge--unverified');
    expect(item('awaiting_runner')).not.toContain('badge--verified');
    expect(item('awaiting_runner')).toContain('Waiting for a runner');
    expect(count(tally, '<span class="tally__count">1</span>')).toBe(3);
    expect(text(markup)).toContain('3 runs shown');
    // In the table the waiting run has no result and says so, rather than 0/0 passed.
    const rows = markup.slice(table, resultsBar);
    expect(rows).toContain('data-job-state="awaiting_runner"');
    expect(count(rows, 'data-unknown="true">no result<')).toBe(1);

    // No runs: no tally items, the honest empty state, and the bar still counts zero.
    const empty = await render(
      QualityPage({
        runs: [],
        csrfToken: CSRF,
        artifactsUnavailableReason: 'The evidence pack is stored in the quality_artifacts table, and this deployment has no such table.',
        formMessage: null,
        formDependency: null,
      }),
    );
    expect(empty).not.toContain('data-job-tally=');
    // No runs, no strip: a row of zeros would dress an empty centre as a measured one.
    expect(empty).not.toContain('data-job-metric=');
    expect(empty).not.toContain('<dl class="metrics"');
    expect(empty).toContain('No suite has been run from here yet.');
    expect(text(empty)).toContain('Evidence pack nothing to download');
    expect(empty).toContain('>There is nothing to download<');

    for (const page of [markup, empty]) {
      expect(page).not.toMatch(/\sstyle=/);
      const body = text(page);
      for (const phrase of OWNER_REFERENCE_COPY_THAT_MUST_NOT_ARRIVE) {
        expect(body, `carries "${phrase}"`).not.toContain(phrase);
      }
      expect(body).not.toMatch(/£\d/);
    }
  });
});
