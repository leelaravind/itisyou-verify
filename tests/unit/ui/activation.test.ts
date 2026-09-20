/**
 * CUST-121..CUST-132 — the service activation notice, the disabled activation path, and
 * the pre-checkout disclosure.
 *
 * Why these exist, stated plainly so nobody deletes them for being inconvenient:
 *
 * `POST /api/v1/events` — the intake this product is named for — is not mounted. Verified
 * directly rather than from a doc comment: `grep 'app.route(' apps/app/src/index.ts` shows
 * `/app`, `/api/v1/runner` and `/` only, and a live `wrangler dev` answers
 * `POST /api/v1/events` with **404**. So nothing a customer's automation sends can reach
 * us, and every step downstream of that is unreachable from outside.
 *
 * While that is true, a page that invites a stranger to hand over a card is making a claim
 * the system cannot honour. These cases keep the description up and the transaction down.
 *
 * Delete them when the notice stops being true — not when it stops being convenient.
 */
import { describe, expect, it } from 'vitest';
import { render, SERVICE_ACTIVATION_NOTICE } from '@verify/ui';
import { preCheckoutPanel } from '../../../apps/app/src/billing/index.js';
import { HomePage } from '../../../apps/app/src/routes/public/home.js';
import { DemoPage } from '../../../apps/app/src/routes/public/demo.js';
import { HowItWorksPage, PricingPage } from '../../../apps/app/src/routes/public/marketing.js';
import { CompatibilityPage, ReviewPage } from '../../../apps/app/src/routes/app/onboardingPages.js';
import { WorkspacePage } from '../../../apps/app/src/routes/app/workspacePage.js';
import {
  SyntheticCustomerDataPort,
  resetSyntheticState,
} from '../../../apps/app/src/routes/app/syntheticPort.js';

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

async function compatibility(): Promise<string> {
  resetSyntheticState();
  const port = new SyntheticCustomerDataPort();
  return render(CompatibilityPage(await port.connectorCompatibility()));
}

async function review(): Promise<string> {
  resetSyntheticState();
  const port = new SyntheticCustomerDataPort();
  const workflow = await port.workflow();
  return render(
    ReviewPage({ order: await port.orderSummary(), workflow, csrfToken: 'tok', submitted: null }),
  );
}

describe('the service activation notice', () => {
  it('CUST-121 the home page carries the notice verbatim, before anything that invites action', async () => {
    const markup = await render(HomePage());
    expect(text(markup)).toContain(collapse(SERVICE_ACTIVATION_NOTICE.headline));
    expect(text(markup)).toContain(collapse(SERVICE_ACTIVATION_NOTICE.body));
    // Ahead of the first call to action, measured by position rather than asserted.
    const noticeAt = markup.indexOf('data-activation-notice');
    const firstCta = markup.indexOf('class="btn btn--primary"');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(firstCta).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(firstCta);
    // Exactly once. A banner rendered twice reads as a page that has lost track of itself,
    // and a doubled warning is easier to dismiss than a single one. This caught a real
    // duplicate introduced while wiring it in.
    expect((markup.match(/data-activation-notice/g) ?? []).length).toBe(1);
  });

  it('CUST-122 the pricing page carries it, and it is not behind a disclosure control', async () => {
    const markup = await render(PricingPage());
    expect(text(markup)).toContain(collapse(SERVICE_ACTIVATION_NOTICE.body));
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<summary');
    // Not demoted to small print: the nearest enclosing callout is the warn tone, which is
    // the loudest the system has. Found by walking back from the notice rather than by
    // guessing how many characters of heading sit between the two.
    const noticeAt = markup.indexOf('data-activation-notice');
    const enclosing = markup.lastIndexOf('callout--', noticeAt);
    expect(markup.slice(enclosing, enclosing + 20)).toContain('callout--warn');
    expect((markup.match(/data-activation-notice/g) ?? []).length).toBe(1);
  });

  it('CUST-123 the onboarding entry point carries it too', async () => {
    const markup = await compatibility();
    expect(text(markup)).toContain(collapse(SERVICE_ACTIVATION_NOTICE.headline));
    expect(text(markup)).toContain(collapse(SERVICE_ACTIVATION_NOTICE.body));
    expect((markup.match(/data-activation-notice/g) ?? []).length).toBe(1);
  });

  it('CUST-124 the notice names each gap rather than apologising in general terms', async () => {
    const body = text(await render(PricingPage()));
    // The property is that the notice NAMES its gaps rather than apologising in general
    // terms. The gaps themselves changed when three of them were closed, so the specific
    // sentences moved; asserting the old ones would have pinned the notice to claiming
    // less than was true.
    // 20 September 2026: both earlier gaps closed on a deployment (a sandbox purchase
    // activated a subscription; a HubSpot contact was read back and supported a verdict)
    // while this page kept naming them -- on the sign-in route the owner met when their
    // own sign-in failed. The gaps it names now are the two that are actually open.
    expect(body).toContain('live payments are switched off');
    expect(body).toContain('cannot yet create a new customer workspace');
    // And it still says what it will take to change, rather than "soon".
    expect(body).toContain('when either of those changes');
    expect(body).toContain('not taking payment or activating new workspaces');
  });
});

describe('the activation path is disabled, visibly', () => {
  it('CUST-125 the pricing page offers no live link into sign-up, and says why', async () => {
    const markup = await render(PricingPage());
    expect(markup).not.toMatch(/<a[^>]*href="\/app"[^>]*class="btn btn--primary"/);
    expect(markup).not.toMatch(/class="btn btn--primary"[^>]*href="\/app"/);
    expect(markup).toContain('data-unavailable');
    expect(markup).toContain('aria-disabled="true"');
    expect(text(markup)).toContain('Start setting this up');
    // The reason travels with the control, not in a footnote elsewhere on the page.
    expect(markup).toMatch(/data-unavailable[\s\S]{0,600}not taking payment/);
  });

  it('CUST-126 the onboarding entry point cannot be continued past, and says why', async () => {
    const markup = await compatibility();
    expect(markup).not.toMatch(/<a[^>]*href="\/app\/onboarding\/connect"/);
    expect(markup).toContain('data-unavailable');
    expect(text(markup)).toContain('These all apply');
  });

  it('CUST-127 the checkout button is not merely styled disabled — it cannot be submitted', async () => {
    const markup = await review();
    expect(markup).toContain('data-unavailable');
    expect(markup).toContain('aria-disabled="true"');
    // A `<button disabled>` inside the form would still be a button; there must be no
    // submit control on the page at all while the path is closed.
    expect(markup).not.toMatch(/<button[^>]*type="submit"/);
    expect(text(markup)).toContain('Continue to secure checkout');
  });

  it('CUST-128 the workspace does not invite someone to start a setup that cannot finish', async () => {
    const markup = await render(
      WorkspacePage({
        workflow: null,
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
        now: new Date('2026-03-01T12:00:00.000Z'),
      }),
    );
    expect(markup).not.toMatch(/<a[^>]*href="\/app\/onboarding\/compatibility"/);
    expect(markup).toContain('data-unavailable');
  });

  it('CUST-129 the informational site is preserved — how it works, the price, and the demo all still render', async () => {
    const how = await render(HowItWorksPage());
    expect(how).toContain('Connect HubSpot and Resend');
    expect(how).toContain('Define the expected result');

    const pricing = text(await render(PricingPage()));
    expect(pricing).toContain('£29.00');
    expect(pricing).toContain('500 per month');

    const demo = await render(DemoPage());
    expect(demo).toContain('Synthetic workspace');
    for (const status of ['VERIFIED', 'FAILED', 'PENDING', 'UNVERIFIED']) {
      expect(demo).toContain(`data-status="${status}"`);
    }
    // The demo has never claimed to be live, so it does not need the notice.
    expect(demo).not.toContain('data-activation-notice');
  });
});

describe('the pre-checkout disclosure', () => {
  it('CUST-130 every fact and every section of A06’s panel reaches the review page', async () => {
    const markup = await review();
    const panel = preCheckoutPanel();
    const body = text(markup);

    expect(body).toContain(collapse(panel.heading));
    for (const fact of panel.facts) {
      expect(body, fact.label).toContain(collapse(fact.label));
      expect(body, fact.value).toContain(collapse(fact.value));
    }
    for (const section of panel.sections) {
      expect(body, section.heading).toContain(collapse(section.heading));
      for (const line of section.lines) {
        expect(body, line).toContain(collapse(line));
      }
    }
  });

  it('CUST-131 sections render in A06’s order, and each in the style it declares', async () => {
    const markup = await review();
    const panel = preCheckoutPanel();

    let previous = -1;
    for (const section of panel.sections) {
      const at = markup.indexOf(`data-disclosure-section="${section.id}"`);
      expect(at, section.id).toBeGreaterThan(previous);
      previous = at;
      const block = markup.slice(at, at + 2400);
      if (section.style === 'list') {
        expect(block, section.id).toContain('<li>');
      } else {
        expect(block, section.id).toContain('<p');
        expect(
          block.slice(0, block.indexOf('data-disclosure-section', 1) + 1),
          section.id,
        ).not.toContain('<li>');
      }
    }
    // The seven A06 named, in that order.
    expect(panel.sections.map((s) => s.id)).toEqual([
      'allowance',
      'payment-recovery',
      'payment-recovery-pauses',
      'payment-recovery-preserved',
      'payment-recovery-after',
      'cancellation',
      'refunds',
    ]);
  });

  it('CUST-132 mustBeVisible is on the page, outside any disclosure control', async () => {
    const markup = await review();
    const panel = preCheckoutPanel();
    expect(text(markup)).toContain(collapse(panel.mustBeVisible));
    expect(markup).toContain('data-must-be-visible');
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<summary');
    // Not hidden by an attribute or by inline CSS either. `aria-hidden` on a decorative
    // glyph is fine and is exactly what the icons carry, so the check is specific.
    const at = markup.indexOf('data-must-be-visible');
    const tag = markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1);
    expect(tag).not.toMatch(/hidden/);
    expect(tag).not.toContain('sr-only');
    expect(markup).not.toContain('display:none');
  });
});
