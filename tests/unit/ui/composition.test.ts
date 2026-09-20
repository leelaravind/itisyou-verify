/**
 * CUST-701..CUST-708 — the composition of the two public screens that were recomposed to
 * the approved designs: the landing page and the pricing page.
 *
 * "Palette applied; layout is ours" was the honest state of every route until this block
 * (docs/stitch-mapping.md). These cases pin the part that changed — section order, column
 * counts, hero structure and responsive steps — by reading the rendered bytes and the
 * served stylesheet, never by checking that a helper was called. They also pin the part
 * that must NOT have changed: the copy. The reference files carry prices, a trial, a
 * certification and seat wording that are not ours, and a layout job is the easiest way
 * to carry a sentence across without noticing.
 */
import { describe, expect, it } from 'vitest';
import {
  CSS,
  PLAN_ALLOWANCE,
  PLAN_NAME,
  PLAN_PRICE_DISPLAY,
  SERVICE_ACTIVATION_NOTICE,
  STATUS_DEFINITIONS,
  render,
} from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import { HomePage } from '../../../apps/app/src/routes/public/home.js';
import { PricingPage } from '../../../apps/app/src/routes/public/marketing.js';

function text(markup: string): string {
  return markup
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

describe('the landing page composition', () => {
  it('CUST-701 the hero is one centred column: notice, copy, calls to action, then the evidence card full width', async () => {
    const markup = await render(HomePage());
    expect(markup).toContain('<div class="wrap stack center">');

    const notice = markup.indexOf('data-activation-notice');
    const headline = markup.indexOf('<h1 class="display">');
    const firstCta = markup.indexOf('class="btn btn--primary"');
    const evidence = markup.indexOf('data-claim-rule="FAILED"');
    for (const at of [notice, headline, firstCta, evidence]) expect(at).toBeGreaterThan(-1);
    // Notice before headline before the first call to action before the evidence card:
    // the order the design draws, and the order CUST-121 already relies on.
    expect(notice).toBeLessThan(headline);
    expect(headline).toBeLessThan(firstCta);
    expect(firstCta).toBeLessThan(evidence);
    // The evidence card is wrapped so it stays left-aligned inside a centred section.
    expect(markup.lastIndexOf('<div class="hero-card stack-sm">', evidence)).toBeGreaterThan(firstCta);
    expect(declarationsFor('.center')).toBe('text-align:center');
    expect(declarationsFor('.hero-card')).toContain('text-align:left');
    expect(declarationsFor('.hero-card')).toContain('margin-inline:auto');
    // Both button rows stack full width below phone-landscape width, as drawn.
    expect(count(markup, 'class="btn-row btn-row--stack"')).toBe(2);
    expect(CSS).toContain(
      '@media (max-width:39.99rem){.btn-row--stack{flex-direction:column;align-items:stretch}.btn-row--stack .btn{width:100%}}',
    );
    // The notice's own text is intact inside the new wrapper.
    expect(text(markup)).toContain(SERVICE_ACTIVATION_NOTICE.headline);
  });

  it('CUST-702 the four statuses are four cards in one row, each ruled along its top in its own colour, and only UNVERIFIED is dashed', async () => {
    const markup = await render(HomePage());
    const grid = markup.indexOf('<div class="grid grid-4">');
    expect(grid).toBeGreaterThan(-1);
    const cards = [...markup.matchAll(/class="status-card status-card--([a-z]+)"/g)].map((m) => m[1]);
    expect(cards).toEqual(['verified', 'failed', 'unverified', 'pending']);
    // Each card carries the badge for the same status, so the colour rule is never the
    // only signal. Checked in order, not merely for presence.
    for (const status of cards) {
      const at = markup.indexOf(`status-card--${status}"`);
      const next = markup.indexOf('class="status-card', at + 1);
      const slice = markup.slice(at, next === -1 ? undefined : next);
      expect(slice, status).toContain(`badge--${status}`);
    }
    for (const definition of STATUS_DEFINITIONS) {
      const key = definition.status.toLowerCase();
      const declarations = declarationsFor(`.status-card--${key}`);
      expect(declarations, key).toContain(`border-top-color:var(--c-${key})`);
      // The rule about badges (CUST-411) holds for the cards too: no verdict is smaller.
      expect(declarations, key).not.toMatch(/font-size|font-weight|padding|opacity|border-width/);
      if (key === 'unverified') expect(declarations).toContain('border-top-style:dashed');
      else expect(declarations, key).not.toContain('dashed');
    }
    // The base card owns the 2px rule; a modifier only recolours it.
    expect(declarationsFor('.status-card')).toContain('border-top:2px solid var(--c-rule-strong)');
  });

  it('CUST-703 sections follow the approved order — hero, results band, exclusions as a card grid, three step cards, closing — and the proof notice follows the steps', async () => {
    const markup = await render(HomePage());
    const order = [
      'Independent verification of one automation',
      '>What we report<',
      '>What this does not do<',
      '>What setting this up actually involves<',
      'class="btn-row btn-row--stack"', // the closing call to action (second occurrence)
    ];
    const positions = order.map((needle, i) =>
      i === order.length - 1 ? markup.lastIndexOf(needle) : markup.indexOf(needle),
    );
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], order[i]).toBeGreaterThan(positions[i - 1] as number);
    }
    // The exclusions: three across at desktop, one card per item, none dropped.
    const exclusions = markup.indexOf('>What this does not do<');
    const steps = markup.indexOf('<ol class="step-cards grid grid-3">');
    expect(steps).toBeGreaterThan(exclusions);
    const exclusionSlice = markup.slice(exclusions, steps);
    expect(exclusionSlice).toContain('<div class="grid grid-3">');
    expect(count(exclusionSlice, 'class="card__title"')).toBe(5);
    expect(exclusionSlice).toContain('It does not detect a run that never started<');
    // The three steps: an ordered list of exactly three cards, then the notice that
    // qualifies step 3, then the link to the long version.
    const stepsEnd = markup.indexOf('</ol>', steps);
    expect(count(markup.slice(steps, stepsEnd), '<li class="card step-card">')).toBe(3);
    const proof = markup.indexOf('data-provider-proof-notice');
    expect(proof).toBeGreaterThan(stepsEnd);
    expect(markup.indexOf('href="/how-it-works"', proof)).toBeGreaterThan(proof);
    // Three columns only where three columns of prose are readable; the base grid rule.
    expect(CSS).toContain('@media (min-width:60rem){.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}}');
  });

  it('CUST-704 the plan line under the hero and under the closing is the contract, stated once each and never a second figure', async () => {
    const markup = await render(HomePage());
    const line = `${PLAN_PRICE_DISPLAY} a month · ${LIMITS.PLAN_RUNS_PER_PERIOD} runs · one workflow · HubSpot and Resend`;
    expect(count(text(markup), line)).toBe(2);
    // Every pound sign on the page is the plan price. The reference carries four other
    // monthly prices; none of them may arrive with the layout.
    expect(count(markup, '£')).toBe(count(markup, PLAN_PRICE_DISPLAY));
  });
});

describe('the pricing page composition', () => {
  it('CUST-705 the main grid is seven to five: plan and payment policy in the wider column, the order summary and the unavailable control in the narrower', async () => {
    const markup = await render(PricingPage());
    const grid = markup.indexOf('<div class="grid grid-7-5">');
    expect(grid).toBeGreaterThan(-1);
    // The notice still precedes the grid, as CUST-122 requires of the page.
    expect(markup.indexOf('data-activation-notice')).toBeLessThan(grid);
    const policy = markup.indexOf('data-payment-recovery');
    const summary = markup.indexOf('<dl class="summary">');
    const control = markup.indexOf('data-unavailable');
    for (const at of [policy, summary, control]) expect(at).toBeGreaterThan(grid);
    // Left column is emitted first: the policy sits before the summary, and the control
    // sits inside the summary's card, after its rows.
    expect(policy).toBeLessThan(summary);
    expect(summary).toBeLessThan(control);
    // The price is in the plan card's head, opposite the plan name.
    const head = markup.indexOf('<div class="card__head">', grid);
    const headEnd = markup.indexOf('</div>', markup.indexOf('price__period', head));
    const headSlice = markup.slice(head, headEnd);
    expect(headSlice).toContain(`<h2 class="card__title">${PLAN_NAME}</h2>`);
    expect(headSlice).toContain(`<span class="price__amount">${PLAN_PRICE_DISPLAY}</span>`);
    // Two columns only at desktop width; below it the sheet leaves the grid single column.
    expect(CSS).toContain(
      '@media (min-width:60rem){.grid-7-5{grid-template-columns:minmax(0,7fr) minmax(0,5fr);align-items:start}}',
    );
    expect(count(CSS, '.grid-7-5{')).toBe(1);
  });

  it('CUST-706 the allowance is a bar of metrics — one tile per line of the contract — and the order summary repeats the price and the runs, not a different figure', async () => {
    const markup = await render(PricingPage());
    const metrics = markup.indexOf('<dl class="metrics"');
    expect(metrics).toBeGreaterThan(-1);
    const metricsSlice = markup.slice(metrics, markup.indexOf('</dl>', metrics));
    expect(count(metricsSlice, '<dt>')).toBe(PLAN_ALLOWANCE.length);
    for (const line of PLAN_ALLOWANCE) {
      expect(metricsSlice).toContain(`<dt>${line.label}</dt>`);
      expect(metricsSlice).toContain(`<dd>${line.value}</dd>`);
    }
    expect(metricsSlice).toContain(`${LIMITS.PLAN_RUNS_PER_PERIOD} per month`);
    // auto-fit: the five tiles fall from a row to pairs to a stack with no breakpoint of
    // their own, so a narrow phone never gets a squeezed five-column bar.
    expect(declarationsFor('.metrics')).toContain('grid-template-columns:repeat(auto-fit,minmax(9rem,1fr))');
    const summary = markup.indexOf('<dl class="summary">');
    const summarySlice = markup.slice(summary, markup.indexOf('</dl>', summary));
    expect(summarySlice).toContain(`<dd>${PLAN_NAME}</dd>`);
    expect(summarySlice).toContain(`<dd>${PLAN_PRICE_DISPLAY} per month</dd>`);
    expect(summarySlice).toContain('<dt>Runs included</dt>');
    expect(summarySlice).toContain(`<dd>${LIMITS.PLAN_RUNS_PER_PERIOD} per month</dd>`);
    expect(declarationsFor('.summary>div')).toContain('justify-content:space-between');
  });

  it('CUST-707 below the grid the page carries the four results as cards, the questions two abreast, then the standing limitations', async () => {
    const markup = await render(PricingPage());
    const grid = markup.indexOf('<div class="grid grid-7-5">');
    const results = markup.indexOf('<div class="grid grid-4">');
    const faq = markup.indexOf('<div class="faq-grid">');
    const limitations = markup.indexOf('data-standing-limitations');
    expect(grid).toBeLessThan(results);
    expect(results).toBeLessThan(faq);
    expect(faq).toBeLessThan(limitations);
    const cards = [...markup.matchAll(/class="status-card status-card--([a-z]+)"/g)].map((m) => m[1]);
    expect(cards).toEqual(['verified', 'failed', 'unverified', 'pending']);
    const faqSlice = markup.slice(faq, limitations);
    expect(count(faqSlice, 'id="faq-')).toBe(5);
    expect(CSS).toContain('@media (min-width:46rem){.faq-grid .faq{grid-template-columns:repeat(2,minmax(0,1fr))}}');
    // The single-column FAQ list elsewhere is untouched: the grid applies only under the wrapper.
    expect(count(CSS, '.faq-grid .faq{')).toBe(2);
    expect(declarationsFor('.faq{')).toBe('');
    expect(declarationsFor('.faq')).toBe('border-top:1px solid var(--c-rule)');
  });

  it('CUST-708 neither recomposed screen emits a style attribute, and neither carries a figure, trial, seat term or attestation from the reference', async () => {
    for (const [name, page] of [
      ['home', await render(HomePage())],
      ['pricing', await render(PricingPage())],
    ] as const) {
      expect(page, `${name} emits an inline style attribute`).not.toMatch(/\sstyle="/);
      const body = text(page);
      // The reference files' claims, by class rather than by string, so a paraphrase fails too.
      expect(body, name).not.toMatch(/\btrial\b/i);
      expect(body, name).not.toMatch(/per[- ]seat/i);
      expect(body, name).not.toMatch(/\bSOC\s?2\b/i);
      expect(body, name).not.toMatch(/ISO\s?27001/i);
      expect(body, name).not.toMatch(/\b(guaranteed?|100%)\b/i);
      // Every pound figure on the page is the one plan price.
      const pounds = body.match(/£[\d,.]+/g) ?? [];
      expect(pounds.length, name).toBeGreaterThan(0);
      for (const figure of pounds) expect(figure, name).toBe(PLAN_PRICE_DISPLAY);
    }
  });
});
