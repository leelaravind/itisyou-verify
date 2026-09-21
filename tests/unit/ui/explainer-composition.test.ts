/**
 * CUST-801..CUST-808 — the composition of /how-it-works, /demo and /security.
 *
 * The approved Stitch screen for these routes proposes a particular arrangement: a framed
 * hero panel with a two-pane split, three steps across, the four statuses as four tiles in
 * one panel, a framed results table with a tally under it, one framed record per run. These
 * cases pin that arrangement in the rendered bytes, and — because the reference markup
 * carries claims this business does not make — pin just as hard that none of its copy came
 * along with its layout.
 */
import { describe, expect, it } from 'vitest';
import { PublicLayout, render } from '@verify/ui';
import { HowItWorksPage, SecurityPage } from '../../../apps/app/src/routes/public/marketing.js';
import { DemoPage } from '../../../apps/app/src/routes/public/demo.js';
import { DEMO_RUNS } from '../../../apps/app/src/routes/public/demoData.js';

/**
 * Phrases the reference screens carry and this site must never render. Layout only.
 *
 * Competitor names are deliberately NOT on this list: A01's exclusion copy names n8n, Make
 * and Zapier to describe our own blindness ("we never see inside..."), under its own
 * claim-scan:allow. What must not arrive is the reference's use of them as a comparison.
 */
// claim-scan:allow these are the strings the cases below assert are ABSENT from the rendered pages
const REFERENCE_COPY_THAT_MUST_NOT_ARRIVE = [
  'SOC2',
  'SOC 2',
  'ISO/IEC 27001',
  'ZERO-TRUST',
  'Postmark',
  'Stripe API',
  '14-Day',
  'No CC',
  'PHANTOM',
  'GROUND TRUTH',
  'Forensic Standard',
  'OBSERVER ENGINE',
  'Live Telemetry',
  'Whitepaper',
  '99.92',
  'settling window',
  'alex.taylor',
  'northfield',
];

describe('how it works — composition', () => {
  it('CUST-801 the hero is one framed panel carrying the head and a two-pane split of A01’s own questions', async () => {
    const markup = await render(HowItWorksPage());
    // One hero panel, and the two panes sit inside it rather than beside it.
    const heroStart = markup.indexOf('<section class="panel panel--hero">');
    expect(heroStart).toBeGreaterThanOrEqual(0);
    const heroEnd = markup.indexOf('</section>', heroStart);
    const hero = markup.slice(heroStart, heroEnd);
    expect(hero).toContain('<h1>Three steps, and the setup work each one really needs</h1>');
    expect(hero).toContain('<div class="split">');
    expect(hero).toContain('<div class="pane" id="faq-different-from-automation-error-alerts">');
    expect(hero).toContain('<div class="pane" id="faq-do-you-modify-anything">');
    // The pane headings are the FAQ questions verbatim: nothing in the panes was written here.
    // (The apostrophe in the first question is entity-escaped by the renderer, so the
    // assertion holds the tail of the sentence rather than coupling to the escape form.)
    expect(hero).toContain('own error alerts?</h3>');
    expect(hero).toContain('<h3>Do you ever modify my CRM or resend my emails?</h3>');
    expect(hero).toContain('We only ever read.');
    // The question moved into the hero is not repeated in the list below it.
    expect(markup.match(/id="faq-different-from-automation-error-alerts"/g)?.length).toBe(1);
  });

  it('CUST-802 the three steps are a numbered ordered list, matching the home page, not a card row', async () => {
    /*
     * Three cards across until 21 September 2026, which is the generic three-feature-card
     * row the owner's exclusions name. The home page carries the same three steps and was
     * recomposed the same day, so the assertion here is deliberately the same shape as
     * CUST-703's: one device, asserted in both places it appears.
     */
    const markup = await render(HowItWorksPage());
    expect(markup).toContain('<ol class="steps">');
    const steps = markup.indexOf('<ol class="steps">');
    const stepsEnd = markup.indexOf('</ol>', steps);
    expect(markup.slice(steps, stepsEnd).match(/<li>/g)?.length).toBe(3);
    expect(markup.slice(steps, stepsEnd), 'the steps are cards again').not.toContain('step-card');
    // Order is the content module's order — connect, define, receive — and unchanged.
    const connect = markup.indexOf('<h3>Connect HubSpot and Resend</h3>');
    const define = markup.indexOf('<h3>Define the expected result</h3>');
    const receive = markup.indexOf('<h3>Receive the evidence</h3>');
    expect(connect).toBeGreaterThan(0);
    expect(define).toBeGreaterThan(connect);
    expect(receive).toBeGreaterThan(define);
    // The provider-proof qualification still precedes the first step.
    expect(markup.indexOf('data-provider-proof-notice')).toBeLessThan(connect);
  });

  it('CUST-803 the four statuses are four tiles in one panel, each carrying its badge, and UNVERIFIED is not drawn as a pass', async () => {
    const markup = await render(HowItWorksPage());
    const panelStart = markup.indexOf('<h2>What we report</h2>');
    expect(panelStart).toBeGreaterThan(0);
    const panel = markup.slice(panelStart, markup.indexOf('</section>', panelStart));
    expect(panel).toContain('<div class="grid grid-4">');
    for (const status of ['VERIFIED', 'FAILED', 'UNVERIFIED', 'PENDING']) {
      expect(panel).toContain(`<div class="tile" data-status-tile="${status}">`);
      expect(panel).toContain(`data-status="${status}"`);
    }
    expect(panel.match(/class="tile"/g)?.length).toBe(4);
    // The UNVERIFIED tile carries the dashed badge and A01's sentence, in that tile.
    const unverified = panel.slice(panel.indexOf('data-status-tile="UNVERIFIED"'));
    const tile = unverified.slice(0, unverified.indexOf('</div>'));
    expect(tile).toContain('badge--unverified');
    expect(tile).toContain('This is not a pass and not a failure.');
    expect(tile).not.toContain('badge--verified');
  });

  it('CUST-804 the exclusions are a ruled reading column inside a panel, all five present, none demoted', async () => {
    const markup = await render(HowItWorksPage());
    const start = markup.indexOf('<h2>What this does not do</h2>');
    const section = markup.slice(start, markup.indexOf('</section>', start));
    expect(section).toContain('<div class="rule-list">');
    for (const heading of [
      'It does not watch your automation platform',
      'It does not fix anything',
      'It does not cover every workflow',
      'It does not detect a run that never started',
      'It is not instant',
    ]) {
      expect(section).toContain(`<h3>${heading}</h3>`);
    }
    // Exclusions get the same frame as the statuses: a panel, not a footnote.
    expect(markup.slice(0, start).lastIndexOf('<section class="panel">')).toBeGreaterThan(0);
    // The calls to action close the page in a band, after the standing limitations.
    const band = markup.indexOf('<div class="cta-band">');
    expect(band).toBeGreaterThan(markup.indexOf('data-standing-limitations'));
    expect(markup.slice(band)).toContain('href="/demo"');
  });
});

describe('demo — composition', () => {
  it('CUST-805 the run list is a framed results panel: amber callout above the table, a four-status tally below it', async () => {
    const markup = await render(DemoPage());
    const start = markup.indexOf('<section class="stack" id="demo-runs">');
    expect(start).toBeGreaterThan(0);
    const section = markup.slice(start, markup.indexOf('</section>', start));
    expect(section).toContain('<div class="results">');
    const callout = section.indexOf('Read the two amber results carefully');
    const table = section.indexOf('<div class="tablewrap"');
    const tally = section.indexOf('<ul class="tally"');
    expect(callout).toBeGreaterThan(0);
    expect(table).toBeGreaterThan(callout);
    expect(tally).toBeGreaterThan(table);
    // The tally is computed from the engine's runs: one of each, four entries, never a fifth.
    const tallyMarkup = section.slice(tally);
    for (const status of ['VERIFIED', 'FAILED', 'UNVERIFIED', 'PENDING']) {
      const count = DEMO_RUNS.filter((run) => run.status === status).length;
      expect(count).toBe(1);
      expect(tallyMarkup).toContain(`<li data-tally="${status}">`);
      expect(tallyMarkup).toContain(`data-status="${status}"`);
    }
    expect(tallyMarkup.match(/data-tally=/g)?.length).toBe(4);
    expect(tallyMarkup.match(/<span class="tally__count">1<\/span>/g)?.length).toBe(4);
  });

  it('CUST-806 the hero panel keeps the synthetic banner first and states only facts read from the demo rules', async () => {
    const markup = await render(DemoPage());
    const hero = markup.slice(
      markup.indexOf('<section class="panel panel--hero">'),
      markup.indexOf('</section>', markup.indexOf('<section class="panel panel--hero">')),
    );
    // The synthetic banner comes before the heading inside the same panel.
    expect(hero.indexOf('Synthetic workspace')).toBeLessThan(hero.indexOf('<h1>'));
    expect(hero).toContain('<ul class="meta-bar" aria-label="About this workflow">');
    expect(hero).toContain('<li>Runs <b>4</b></li>');
    expect(hero).toContain('<li>Rule version <b>wf_demo@v1</b></li>');
    expect(hero).toContain('<li>Coverage mode <b>customer_triggered</b></li>');
    // Each run is its own framed record, with its verdict, and the verdicts are unchanged.
    expect(markup.match(/<section class="panel" id="run_demo_/g)?.length).toBe(4);
    expect(markup).toContain('data-demo-run="UNVERIFIED"');
    expect(markup).toContain('data-demo-run="FAILED"');
    expect(DEMO_RUNS.map((run) => run.status)).toEqual(['VERIFIED', 'FAILED', 'PENDING', 'UNVERIFIED']);
    // Still no input of any kind.
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('onclick');
  });
});

describe('security — composition', () => {
  it('CUST-807 the two qualifying notices share the hero split, the data flow is six numbered cards, and the subprocessor table is framed with its count', async () => {
    const markup = await render(SecurityPage());
    const heroStart = markup.indexOf('<section class="panel panel--hero">');
    const hero = markup.slice(heroStart, markup.indexOf('</section>', heroStart));
    expect(hero).toContain('<h1>Where your data goes, and who else touches it</h1>');
    expect(hero).toContain('<div class="split">');
    expect(hero).toContain('<span class="mono">None</span>');
    expect(hero).not.toContain('data-todo-owner-input="certifications"');
    expect(hero).toContain('data-provider-proof-notice');
    // Six stages, in order, as cards in an ordered list.
    expect(markup).toContain('<ol class="step-cards grid grid-3">');
    expect(markup.match(/<li class="card step-card">/g)?.length).toBe(6);
    expect(markup.indexOf('<h3>Browser</h3>')).toBeLessThan(markup.indexOf('<h3>HubSpot</h3>'));
    expect(markup.indexOf('<h3>Stripe</h3>')).toBeLessThan(markup.indexOf('<h3>Optional model provider</h3>'));
    // The table is framed, and the count under it is the real length of the list.
    const results = markup.slice(markup.indexOf('<div class="results">'));
    expect(results).toContain('<div class="tablewrap"');
    expect(results).toContain('<p class="micro mono">5 subprocessors</p>');
    expect(results.indexOf('<div class="results__bar">')).toBeGreaterThan(results.indexOf('</table>'));
    // Retention and access sit side by side; the standing limitations close the page.
    expect(markup).toContain('<h2>Retention</h2>');
    expect(markup).toContain('<h2>Access we ask for</h2>');
    expect(markup.lastIndexOf('data-standing-limitations')).toBeGreaterThan(markup.lastIndexOf('<h2>Access we ask for</h2>'));
  });
});

describe('the reference copy stays in the reference', () => {
  it('CUST-808 the three composed pages render no inline style attribute and no phrase from the reference markup', async () => {
    const pages: readonly (readonly [string, () => Promise<string>])[] = [
      [
        '/how-it-works',
        async () =>
          render(PublicLayout({ title: 'How it works', path: '/how-it-works', body: HowItWorksPage() })),
      ],
      ['/demo', async () => render(PublicLayout({ title: 'Demo', path: '/demo', body: DemoPage() }))],
      [
        '/security',
        async () => render(PublicLayout({ title: 'Security', path: '/security', body: SecurityPage() })),
      ],
    ];
    for (const [path, build] of pages) {
      const markup = await build();
      // style-src-attr 'none': a style attribute here renders as nothing, silently.
      expect(markup, path).not.toMatch(/\sstyle=/);
      for (const phrase of REFERENCE_COPY_THAT_MUST_NOT_ARRIVE) {
        expect(markup, `${path} carries "${phrase}"`).not.toContain(phrase);
      }
      // The one real price and plan, and no other.
      expect(markup, path).not.toMatch(/£(?!29\.00\b)\d/);
      expect(markup, path).not.toMatch(/\btrial\b/i);
      expect(markup, path).not.toMatch(/per[- ]seat|per[- ]user/i);
    }
  });
});
