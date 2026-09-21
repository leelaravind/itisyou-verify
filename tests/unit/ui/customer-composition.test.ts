/**
 * CUST-901..CUST-908 — the composition of the authenticated customer screens recomposed to
 * the approved designs: the dashboard, connections, run detail, usage, billing and the
 * onboarding steps.
 *
 * These cases pin the arrangement — which block precedes which, what sits in the wider
 * column, that a count card exists for every status and carries the port's own figure —
 * by reading the rendered bytes and the served stylesheet. They pin just as hard what must
 * NOT have changed: every figure is the port's, every sentence is ours, the checkout control
 * is still gated on `order.ready`, and an UNVERIFIED run is still never dressed as a
 * failure. The reference files carry a payment state, prices, a trial, a certification,
 * providers and a guarantee that are not ours, and a layout job is the easiest way to carry
 * a sentence across without noticing.
 */
import { describe, expect, it } from 'vitest';
import {
  CSS,
  PLAN_NAME,
  PLAN_PRICE_DISPLAY,
  STATUS_DEFINITIONS,
  render,
} from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import { WorkspacePage } from '../../../apps/app/src/routes/app/workspacePage.js';
import { RunDetailPage } from '../../../apps/app/src/routes/app/runPages.js';
import { ConnectionsPage, UsagePage } from '../../../apps/app/src/routes/app/accountPages.js';
import { BillingPage } from '../../../apps/app/src/routes/app/billingPages.js';
import {
  CompatibilityPage,
  MappingPage,
  OutcomePage,
  ProofPage,
  ReviewPage,
} from '../../../apps/app/src/routes/app/onboardingPages.js';
import {
  DEADLINE_CHOICES,
  SyntheticCustomerDataPort,
  resetSyntheticState,
} from '../../../apps/app/src/routes/app/syntheticPort.js';
import type { OrderSummaryView } from '../../../apps/app/src/routes/app/port.js';

const NOW = new Date('2026-03-01T23:00:00.000Z');
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

/** The declarations of one rule in the collapsed sheet, or an empty string if it is absent. */
function declarationsFor(selector: string): string {
  const at = CSS.indexOf(`${selector}{`);
  if (at === -1) return '';
  const open = at + selector.length + 1;
  return CSS.slice(open, CSS.indexOf('}', open));
}

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

function port(): SyntheticCustomerDataPort {
  resetSyntheticState();
  return new SyntheticCustomerDataPort();
}

async function workspace(): Promise<string> {
  const p = port();
  return render(
    WorkspacePage({
      testOffer: { canStart: false, reason: null, consumesAllowance: true, runsRemaining: 0, runsIncluded: 500, correlationProperty: 'verify_correlation_id' },
      csrfToken: null,

        canStartSetup: true,
      workflow: await p.workflow(),
      recentRuns: (await p.listRuns({ limit: 5 })).items,
      connections: await p.connections(),
      usage: await p.usage(),
      now: NOW,
    }),
  );
}

/**
 * Phrases the reference screens carry and these pages must never render. Layout only.
 * Competitor names are deliberately NOT on this list: A01's exclusion copy names them to
 * describe our own blindness, under its own allow marker.
 */
// claim-scan:allow these are the strings the cases below assert are ABSENT from the rendered pages
const REFERENCE_COPY_THAT_MUST_NOT_ARRIVE = [
  'SOC2',
  'SOC 2',
  'ISO/IEC 27001',
  'ZERO-TRUST',
  'Postmark',
  'Airtable',
  'Salesforce',
  'Attio',
  'SendGrid',
  'QuickBooks',
  'Xero',
  'Shopify',
  'Typeform',
  'Klaviyo',
  'PHANTOM',
  'GROUND TRUTH',
  'Forensic',
  'Ledger',
  'Telemetry',
  'Deterministic',
  'Merkle',
  'AES-256',
  'HMAC-SHA256',
  'Settling',
  'Renewal payment unresolved',
  'Acme',
  'ws_984e1',
  'Burst',
  'VAT Registration',
  'Invoice',
];

describe('the workspace dashboard composition', () => {
  it('CUST-901 the head sits beside a mono bar of the workflow’s own facts, and the four run counts follow as four cards in the contract’s order, each carrying the port’s figure', async () => {
    const p = port();
    const workflow = await p.workflow();
    const markup = await workspace();

    const head = markup.indexOf('<div class="section-head">');
    const meta = markup.indexOf('<ul class="meta-bar" aria-label="About this workflow">');
    const cards = markup.indexOf('<div class="count-grid" data-run-counts>');
    expect(head).toBeGreaterThan(-1);
    expect(meta).toBeGreaterThan(head);
    expect(cards).toBeGreaterThan(meta);
    // The bar carries computed facts only.
    const bar = markup.slice(meta, markup.indexOf('</ul>', meta));
    const total =
      workflow.counts.verified + workflow.counts.failed + workflow.counts.unverified + workflow.counts.pending;
    expect(bar).toContain(`<li>Runs <b>${String(total)}</b></li>`);
    expect(bar).toContain(`<li>Coverage mode <b>${workflow.coverageMode}</b></li>`);

    // Four cards, in order, one per status, and the figure in each is the port's count.
    const order = [...markup.matchAll(/data-count-card="([A-Z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['VERIFIED', 'FAILED', 'UNVERIFIED', 'PENDING']);
    expect(markup).toContain(`<span data-count="VERIFIED">${String(workflow.counts.verified)}</span>`);
    expect(markup).toContain(`<span data-count="FAILED">${String(workflow.counts.failed)}</span>`);
    expect(markup).toContain(`<span data-count="UNVERIFIED">${String(workflow.counts.unverified)}</span>`);
    expect(markup).toContain(`<span data-count="PENDING">${String(workflow.counts.pending)}</span>`);
    // Each card is the shared status card (its top rule is the measured colour, dashed for
    // UNVERIFIED — pinned by CUST-702) and carries the badge for the same status, so the
    // rule is never the only signal. The sentence under it is the content module's.
    for (const definition of STATUS_DEFINITIONS) {
      const key = definition.status.toLowerCase();
      const at = markup.indexOf(`data-count-card="${definition.status}"`);
      const slice = markup.slice(markup.lastIndexOf('<div', at), markup.indexOf('</p>', markup.indexOf('small muted', at)));
      expect(slice, key).toContain(`status-card status-card--${key}`);
      expect(slice, key).toContain(`badge--${key}`);
      expect(text(slice), key).toContain(definition.description);
    }
    // Two abreast from the narrowest phone, four across at desktop — never one column, and
    // never three, which would orphan the fourth.
    expect(declarationsFor('.count-grid')).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(CSS).toContain('@media (min-width:64rem){.count-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}');
  });

  it('CUST-902 the period figures are a bar of metrics, and the recent runs are a framed results panel whose tally is the same counts as the cards, with the table stacking into records on a phone', async () => {
    const p = port();
    const workflow = await p.workflow();
    const usage = await p.usage();
    const recent = (await p.listRuns({ limit: 5 })).items;
    const markup = await workspace();

    // The allowance line is floored, as CUST-352 requires of the served page.
    const metrics = markup.indexOf('<dl class="metrics" aria-label="This period">');
    expect(metrics).toBeGreaterThan(markup.indexOf('data-run-counts'));
    const metricsSlice = markup.slice(metrics, markup.indexOf('</dl>', metrics));
    expect(metricsSlice).toContain(
      `<dd>${String(usage.runsUsed)} of ${String(usage.runsIncluded)} (${String(Math.floor((usage.runsUsed / usage.runsIncluded) * 100))}%)</dd>`,
    );
    expect(metricsSlice).toContain('<dt>Correlation property</dt>');
    expect(metricsSlice).toContain(`<span class="mono">${workflow.mapping.correlationProperty}</span>`);

    // Results panel: heading and link, then the frame, then the table, then the bar.
    const heading = markup.indexOf('<h2 id="recent-runs-heading">Recent runs</h2>');
    const results = markup.indexOf('<div class="results">', heading);
    const table = markup.indexOf('<table class="table table--stack">', results);
    const bar = markup.indexOf('<div class="results__bar">', table);
    for (const at of [heading, results, table, bar]) expect(at).toBeGreaterThan(-1);
    expect(markup.slice(heading, results)).toContain('href="/app/runs"');
    // Every body cell carries its column head for the stacked rendering.
    const body = markup.slice(markup.indexOf('<tbody>', table), markup.indexOf('</tbody>', table));
    expect(count(body, 'data-label="Result"')).toBe(recent.length);
    expect(count(body, 'data-label="Run"')).toBe(recent.length);
    expect(CSS).toContain('@media (max-width:39.99rem){.table--stack,.table--stack caption,.table--stack tbody,.table--stack tr{display:block}');
    expect(CSS).toContain('.table--stack td::before,.table--stack tbody th::before{content:attr(data-label)');
    // The tally under the table is computed from the same counts as the cards above it —
    // all four, in order, zeros included — and the count line is the real lengths.
    const tally = markup.slice(bar, markup.indexOf('</div>', markup.indexOf('</ul>', bar)));
    expect([...tally.matchAll(/data-tally="([A-Z]+)"/g)].map((m) => m[1])).toEqual([
      'VERIFIED',
      'FAILED',
      'UNVERIFIED',
      'PENDING',
    ]);
    expect(tally).toContain(`<span class="tally__count">${String(workflow.counts.failed)}</span>`);
    const total =
      workflow.counts.verified + workflow.counts.failed + workflow.counts.unverified + workflow.counts.pending;
    expect(text(tally)).toContain(`${String(recent.length)} of ${String(total)} runs shown`);
    // The rate and the activity signal are still two blocks, and coverage keeps its limitation.
    expect(markup).toContain('<div class="health">');
    expect(markup).toContain('data-coverage-limitation');
    expect(markup.indexOf('data-standing-limitations')).toBeGreaterThan(bar);
  });
});

describe('the connections composition', () => {
  it('CUST-903 the read-only notice precedes the provider cards, the cards sit two abreast with their facts in a sunken pane, and the tally beside the head groups by the same label and badge each card wears', async () => {
    const p = port();
    const connections = await p.connections();
    const markup = await render(ConnectionsPage({
      canTest: true,
      tested: null, connections, csrfToken: CSRF, submitted: null }));

    const head = markup.indexOf('<div class="section-head">');
    const tally = markup.indexOf('<ul class="tally" aria-label="Connections by state">');
    // The notice heading changed from "We only ever read" to "What we do with these
    // credentials". The old title was a claim about the CREDENTIAL and for Resend it was
    // false: Resend publishes no read-only key, so the key a customer pastes is a
    // full-access one. The page now states what OUR CODE does, which is the true version
    // and the one a customer weighing that trade needs.
    const notice = markup.indexOf('>What we do with these credentials<');
    const grid = markup.indexOf('<div class="grid grid-2">');
    expect(head).toBeGreaterThan(-1);
    expect(tally).toBeGreaterThan(head);
    expect(notice).toBeGreaterThan(tally);
    expect(grid).toBeGreaterThan(notice);
    expect(count(markup, 'data-connection-card=')).toBe(connections.length);
    expect(count(markup, '<div class="pane">')).toBe(connections.length);
    // Ready and expired, in the synthetic port: the tally says one of each, under the card's
    // own label, wearing the card's own badge — never a third label the cards do not carry.
    const tallySlice = markup.slice(tally, markup.indexOf('</ul>', tally));
    expect(tallySlice).toContain('data-connection-tally="Ready"');
    expect(tallySlice).toContain('data-connection-tally="Expired"');
    expect(count(tallySlice, '<span class="tally__count">1</span>')).toBe(2);
    expect(tallySlice).toContain('badge--verified');
    expect(tallySlice).toContain('badge--unverified');
    expect(tallySlice).not.toContain('badge--failed');
    expect(tallySlice).not.toContain('badge--pending');
    // Every card keeps its form, its token and its provider, so a layout change moved no control.
    expect(count(markup, 'action="/app/onboarding/connect"')).toBe(connections.length);
    /*
     * Each card now carries TWO forms: the existing connect form and the new "Test
     * connection" one. The token count moved with it, and that is the assertion worth
     * keeping rather than the literal two: every state-changing form on this page must
     * carry a CSRF field, because one that does not is a guaranteed 403 the customer
     * meets only after pressing it.
     */
    expect(count(markup, 'action="/app/connections/test"')).toBe(connections.length);
    const forms = count(markup, '<form');
    expect(forms).toBe(connections.length * 2);
    expect(count(markup, `name="csrf_token" value="${CSRF}"`)).toBe(forms);
    // No connection list means no grid and no tally — the honest empty state instead.
    const empty = await render(ConnectionsPage({
      canTest: true,
      tested: null, connections: [], csrfToken: CSRF, submitted: null }));
    expect(empty).not.toContain('<div class="grid grid-2">');
    expect(empty).not.toContain('aria-label="Connections by state"');
    expect(empty).toContain('We cannot show your connections right now');
  });
});

describe('the run detail composition', () => {
  it('CUST-904 the verdict is a band ruled in its own colour with the check tally beside it and the run’s identifiers under it; the checks take the wider column; and an UNVERIFIED run still carries no red mark', async () => {
    const p = port();
    const failed = await p.run('run_syn_0002');
    const unverified = await p.run('run_syn_0004');
    expect(failed?.status).toBe('FAILED');
    expect(unverified?.status).toBe('UNVERIFIED');

    const markup = await render(RunDetailPage({ run: failed! }));
    const band = markup.indexOf('<section class="status-card status-card--failed" data-run-band="FAILED">');
    expect(band).toBeGreaterThan(markup.indexOf('<ul class="meta-bar" aria-label="About this run">'));
    const bandEnd = markup.indexOf('</section>', band);
    const bandSlice = markup.slice(band, bandEnd);
    // The domain's verdict, passed through, inside the band; the tally beside it.
    expect(bandSlice).toContain('data-run-verdict="FAILED"');
    expect(bandSlice).toContain('<ul class="tally" aria-label="Checks by result">');
    expect(bandSlice).toContain(`<p class="small mono">${failed!.statusReason}</p>`);
    // The tally lists only outcomes that occurred, and each count is the number of results
    // wearing that status.
    for (const status of ['SUPPORTED', 'CONTRADICTED', 'UNKNOWN', 'PENDING'] as const) {
      const n = failed!.results.filter((result) => result.status === status).length;
      if (n === 0) expect(bandSlice).not.toContain(`data-check-tally="${status}"`);
      else {
        const at = bandSlice.indexOf(`data-check-tally="${status}"`);
        expect(at, status).toBeGreaterThan(-1);
        expect(bandSlice.slice(at, bandSlice.indexOf('</li>', at))).toContain(`<span class="tally__count">${String(n)}</span>`);
      }
    }
    expect(bandSlice).toContain('data-check-tally="CONTRADICTED"');
    // The identifiers as metrics, with the recipient masked, inside the band.
    const metrics = bandSlice.indexOf('<dl class="metrics" aria-label="This run">');
    expect(metrics).toBeGreaterThan(bandSlice.indexOf('</ul>'));
    expect(bandSlice).toContain(`<dd class="mono">${failed!.id}</dd>`);
    expect(bandSlice).toContain('a**@example.test');
    expect(bandSlice).not.toContain('ada@example.test');
    // Comparator after the band; then the wider column carries the checks and the narrower
    // one the provenance and the coverage; the standing limitations close the page.
    const comparator = markup.indexOf('<div class="compare"', bandEnd);
    const grid = markup.indexOf('<div class="grid grid-7-5">', comparator);
    const checks = markup.indexOf('>Expected against observed<', grid);
    const provenance = markup.indexOf('>Where this result came from<', checks);
    const coverage = markup.indexOf('data-coverage-limitation', provenance);
    const standing = markup.indexOf('data-standing-limitations', coverage);
    for (const at of [comparator, grid, checks, provenance, coverage, standing]) expect(at).toBeGreaterThan(-1);
    expect(markup).toContain('Source type');
    expect(markup).toContain(`${failed!.rulesRef} · schema v`);

    // The same page for an UNVERIFIED run: dashed band, no red mark anywhere, the gap named.
    const amber = await render(RunDetailPage({ run: unverified! }));
    expect(amber).toContain('<section class="status-card status-card--unverified" data-run-band="UNVERIFIED">');
    expect(amber).not.toContain('badge--failed');
    expect(amber).not.toContain('data-check-tally="CONTRADICTED"');
    expect(amber).toContain('data-verdict-gap');
    expect(declarationsFor('.status-card--unverified')).toContain('border-top-style:dashed');
  });
});

describe('the usage composition', () => {
  it('CUST-905 the period facts are a mono bar beside the head, the meter takes the wider column, and the run counts follow as four cards from the same counts as the dashboard — or not at all when there is no workflow', async () => {
    const p = port();
    const usage = await p.usage();
    const workflow = await p.workflow();
    const markup = await render(UsagePage(usage, workflow.counts));

    const meta = markup.indexOf('<ul class="meta-bar" aria-label="This billing period">');
    const grid = markup.indexOf('<div class="grid grid-7-5">');
    const meter = markup.indexOf('class="meter"');
    const byResult = markup.indexOf('data-runs-by-result');
    expect(meta).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(meta);
    expect(meter).toBeGreaterThan(grid);
    expect(byResult).toBeGreaterThan(meter);
    // The bar says when the figures were read, and never calls that a period start (CUST-382).
    const bar = text(markup.slice(meta, markup.indexOf('</ul>', meta)));
    expect(bar).toContain('Figures read at');
    expect(bar).toContain('Period end');
    expect(text(markup)).not.toContain('Period start');
    // The meter is the first thing in the wider column; the note sits in the narrower one.
    const firstColumn = markup.slice(grid, markup.indexOf('</div>\n      <div class="stack">', grid));
    expect(firstColumn).toContain('class="meter"');
    expect(markup.indexOf('>What counts as a run<')).toBeGreaterThan(meter);
    // Four cards, the port's counts, and the total named.
    const cards = markup.slice(byResult);
    expect([...cards.matchAll(/data-count-card="([A-Z]+)"/g)].map((m) => m[1])).toEqual([
      'VERIFIED',
      'FAILED',
      'UNVERIFIED',
      'PENDING',
    ]);
    expect(cards).toContain(`<span data-count="UNVERIFIED">${String(workflow.counts.unverified)}</span>`);
    const total =
      workflow.counts.verified + workflow.counts.failed + workflow.counts.unverified + workflow.counts.pending;
    expect(cards).toContain(`<li>Runs received <b>${String(total)}</b></li>`);
    // No workflow: no cards and no zeros dressed as a result.
    const bare = await render(UsagePage(usage, null));
    expect(bare).not.toContain('data-runs-by-result');
    expect(bare).not.toContain('data-count-card');
    expect(bare).toContain('class="meter"');
  });
});

describe('the billing composition', () => {
  it('CUST-906 the subscription and the plan take the wider column, the portal control the narrower one, and cancellation and support close the page as two panes — with the one real price and no invented invoice', async () => {
    const p = port();
    const markup = await render(
      BillingPage({
        activation: await p.activation(),
        portal: await p.billingPortalAvailability(),
        csrfToken: CSRF,
        checkoutCancelled: false,
      }),
    );
    const grid = markup.indexOf('<div class="grid grid-7-5">');
    const subscription = markup.indexOf('>Your subscription<', grid);
    const plan = markup.indexOf(`<h2 class="card__title">${PLAN_NAME}</h2>`, subscription);
    const summary = markup.indexOf('<dl class="summary">', plan);
    const portal = markup.indexOf('>There is nothing to manage yet<', summary);
    const card = markup.indexOf('>Card details<', portal);
    const split = markup.indexOf('<div class="split">', card);
    for (const at of [grid, subscription, plan, summary, portal, card, split]) expect(at).toBeGreaterThan(-1);
    const summarySlice = markup.slice(summary, markup.indexOf('</dl>', summary));
    expect(summarySlice).toContain(`<dd>${PLAN_PRICE_DISPLAY} per month</dd>`);
    expect(summarySlice).toContain(`<dd>${String(LIMITS.PLAN_RUNS_PER_PERIOD)} per month</dd>`);
    expect(summarySlice).toContain(`<dd>${String(LIMITS.EVIDENCE_RETENTION_DAYS)} days</dd>`);
    // Two panes, each leading to its own page with that page's own words.
    const panes = markup.slice(split);
    expect(panes).toContain('data-billing-pane="cancel"');
    expect(panes).toContain('data-billing-pane="support"');
    expect(panes).toContain('href="/app/cancel"');
    expect(panes).toContain('href="/app/support"');
    expect(panes).toContain('<h3>Cancel your plan</h3>');
    expect(panes).toContain('<h3>Ask us something</h3>');
    // No portal link when there is no portal, and the reason stated instead.
    expect(markup).not.toContain('Open the billing portal');
    expect(text(markup)).toContain('There is no subscription to manage');
    // Every pound figure on the page is the plan price. The reference carries four invoices,
    // a tax line and a different price; none of them may arrive with the layout.
    const pounds = text(markup).match(/£[\d,.]+/g) ?? [];
    expect(pounds.length).toBeGreaterThan(0);
    for (const figure of pounds) expect(figure).toBe(PLAN_PRICE_DISPLAY);
    expect(markup).not.toMatch(/\sstyle="/);
  });
});

describe('the onboarding composition', () => {
  it('CUST-907 the outcome step opens with the four results as tiles, the review step sets the disclosure before the order and keeps the checkout control gated on order.ready, and mapping, proof and compatibility take their panes', async () => {
    const p = port();
    const workflow = await p.workflow();

    // Outcome: the tiles panel, then the form; checks in the wider column.
    const outcome = await render(
      OutcomePage({ workflow, csrfToken: CSRF, submitted: null, deadlineChoices: DEADLINE_CHOICES }),
    );
    const tiles = outcome.indexOf('<h2 id="outcome-results-heading">What we report</h2>');
    const form = outcome.indexOf('<form method="post" action="/app/onboarding/outcome"');
    expect(tiles).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(tiles);
    expect([...outcome.matchAll(/data-status-tile="([A-Z]+)"/g)].map((m) => m[1])).toEqual([
      'VERIFIED',
      'FAILED',
      'UNVERIFIED',
      'PENDING',
    ]);
    const outcomeGrid = outcome.indexOf('<div class="grid grid-7-5">', form);
    expect(outcomeGrid).toBeGreaterThan(form);
    expect(outcome.indexOf('<legend>Required checks</legend>')).toBeGreaterThan(outcomeGrid);
    expect(outcome.indexOf('<legend>Completion window</legend>')).toBeGreaterThan(
      outcome.indexOf('<legend>Required checks</legend>'),
    );
    expect(outcome.indexOf('<legend>Coverage mode</legend>')).toBeGreaterThan(
      outcome.indexOf('<legend>Completion window</legend>'),
    );
    // All four checkboxes still post under their own names.
    for (const name of ['requireRecordExists', 'requireCorrelationMatch', 'requireEmailDelivered', 'requireRecipientMatch']) {
      expect(outcome, name).toContain(`name="${name}"`);
    }

    // Review: disclosure in the left column before the order in the right; the control is
    // absent exactly when the server would refuse and present exactly when it would not.
    const order = await p.orderSummary();
    expect(order.ready).toBe(false);
    const blocked = await render(ReviewPage({ order, workflow, csrfToken: CSRF, submitted: null }));
    const reviewGrid = blocked.indexOf('<div class="grid grid-7-5">');
    const disclosure = blocked.indexOf('data-must-be-visible', reviewGrid);
    const yourOrder = blocked.indexOf('>Your order<', disclosure);
    const control = blocked.indexOf('data-unavailable', yourOrder);
    for (const at of [reviewGrid, disclosure, yourOrder, control]) expect(at).toBeGreaterThan(-1);
    expect(blocked).not.toMatch(/<form[^>]*action="\/app\/onboarding\/checkout"/);
    expect(blocked).not.toMatch(/<button[^>]*type="submit"/);
    const orderSlice = blocked.slice(yourOrder, blocked.indexOf('</dl>', yourOrder));
    expect(orderSlice).toContain(`<dd>${order.priceDisplay} ${order.billingPeriod}</dd>`);
    expect(orderSlice).toContain(`<dd>${String(order.runsIncluded)} per month</dd>`);

    const ready: OrderSummaryView = { ...order, blockers: [], ready: true };
    const offered = await render(ReviewPage({ order: ready, workflow, csrfToken: CSRF, submitted: null }));
    const checkout = offered.indexOf('<form method="post" action="/app/onboarding/checkout"');
    expect(checkout).toBeGreaterThan(offered.indexOf('data-must-be-visible'));
    const checkoutForm = offered.slice(checkout, offered.indexOf('</form>', checkout));
    expect(checkoutForm).toContain(`name="csrf_token" value="${CSRF}"`);
    expect(checkoutForm).toMatch(/<button[^>]*type="submit"/);
    expect(offered).not.toContain('data-unavailable');

    // Mapping: the field in the wider column, the visible properties in a pane beside it.
    const mapping = await render(
      MappingPage({ workflow, csrfToken: CSRF, submitted: null, value: workflow.mapping.correlationProperty }),
    );
    const mappingGrid = mapping.indexOf('<div class="grid grid-7-5">');
    const field = mapping.indexOf('name="correlationProperty"', mappingGrid);
    const pane = mapping.indexOf('<div class="pane" data-available-properties>', field);
    for (const at of [mappingGrid, field, pane]) expect(at).toBeGreaterThan(-1);
    for (const property of workflow.mapping.availableProperties) {
      expect(mapping.slice(pane)).toContain(`<span class="mono">${property}</span>`);
    }
    const bareMapping = await render(
      MappingPage({
        workflow: { ...workflow, mapping: { ...workflow.mapping, availableProperties: [] } },
        csrfToken: CSRF,
        submitted: null,
        value: '',
      }),
    );
    expect(bareMapping).not.toContain('data-available-properties');

    // Proof: the verdict in the wider column, every check in the narrower one; no proof, no grid.
    const proof = await render(ProofPage({ proof: await p.runProof(), csrfToken: CSRF }));
    const proofGrid = proof.indexOf('<div class="grid grid-7-5">');
    expect(proofGrid).toBeGreaterThan(-1);
    expect(proof.indexOf('>Proof result<', proofGrid)).toBeGreaterThan(proofGrid);
    expect(proof.indexOf('>Every check<')).toBeGreaterThan(proof.indexOf('>What this proof does not prove<'));
    const noProof = await render(ProofPage({ proof: null, csrfToken: CSRF }));
    expect(noProof).not.toContain('<div class="grid grid-7-5">');
    expect(noProof).toContain('No proof run yet');

    // Compatibility: each provider's requirements in a pane inside its card, both providers,
    // stacked in the wider column of the seven-to-five grid (CUST-952 pins the rest).
    const compatibility = await render(CompatibilityPage(await p.connectorCompatibility(), { canContinue: true }));
    expect(count(compatibility, '<div class="pane">')).toBe(2);
    const compatibilityGrid = compatibility.indexOf('<div class="grid grid-7-5">');
    expect(compatibilityGrid).toBeGreaterThan(-1);
    expect(compatibility.indexOf('<div class="pane">')).toBeGreaterThan(compatibilityGrid);
  });
});

describe('the reference copy stays in the reference', () => {
  it('CUST-908 no recomposed customer screen emits a style attribute, a phrase from the reference markup, a second price, a trial or a seat term', async () => {
    const p = port();
    const workflow = await p.workflow();
    const pages: readonly (readonly [string, string])[] = [
      ['/app', await workspace()],
      [
        '/app/connections',
        await render(ConnectionsPage({
      canTest: true,
      tested: null, connections: await p.connections(), csrfToken: CSRF, submitted: null })),
      ],
      ['/app/runs/:id', await render(RunDetailPage({ run: (await p.run('run_syn_0002'))! }))],
      ['/app/usage', await render(UsagePage(await p.usage(), workflow.counts))],
      [
        '/app/billing',
        await render(
          BillingPage({
            activation: await p.activation(),
            portal: await p.billingPortalAvailability(),
        csrfToken: CSRF,
            checkoutCancelled: false,
          }),
        ),
      ],
      ['/app/onboarding/compatibility', await render(CompatibilityPage(await p.connectorCompatibility(), { canContinue: true }))],
      [
        '/app/onboarding/mapping',
        await render(MappingPage({ workflow, csrfToken: CSRF, submitted: null, value: '' })),
      ],
      [
        '/app/onboarding/outcome',
        await render(
          OutcomePage({ workflow, csrfToken: CSRF, submitted: null, deadlineChoices: DEADLINE_CHOICES }),
        ),
      ],
      ['/app/onboarding/proof', await render(ProofPage({ proof: await p.runProof(), csrfToken: CSRF }))],
      [
        '/app/onboarding/review',
        await render(ReviewPage({ order: await p.orderSummary(), workflow, csrfToken: CSRF, submitted: null })),
      ],
    ];
    for (const [path, markup] of pages) {
      // style-src-attr 'none': a style attribute here renders as nothing, silently.
      expect(markup, path).not.toMatch(/\sstyle=/);
      const body = text(markup);
      for (const phrase of REFERENCE_COPY_THAT_MUST_NOT_ARRIVE) {
        expect(body, `${path} carries "${phrase}"`).not.toContain(phrase);
      }
      // The one real price and plan, and no other. A06's disclosure states it once as
      // "£29" without the pence, which is the same figure and not a second price.
      expect(body, path).not.toMatch(/£(?!29(?:\.00)?\b)\d/);
      expect(body, path).not.toMatch(/\btrial\b/i);
      expect(body, path).not.toMatch(/per[- ]seat|per[- ]user/i);
      expect(body, path).not.toMatch(/\bSOC\s?2\b/i);
      expect(body, path).not.toMatch(/\b(guaranteed?|100%)\b/i);
    }
  });
});
