/**
 * CUST-330..CUST-340 — every public claim, asserted against what a visitor is actually served.
 *
 * ## Why these go through the Worker entry point and nothing else
 *
 * The dominant defect on this project is *correct code, thoroughly tested, reached by
 * nothing*. `tests/unit/ui/activation.test.ts` calls `PricingPage()` and asserts the string
 * it returns — which proves the function is correct and proves nothing at all about the
 * bytes `GET /pricing` puts on the wire. A page can be perfect and unmounted; a constant can
 * be honest and unrendered.
 *
 * So every case here builds a real `Request`, hands it to the default export of
 * `apps/app/src/index.ts` — the same object Cloudflare invokes — and asserts against the
 * response body. If a router stops mounting a page, or a layout stops rendering a notice,
 * these fail. That is the only thing worth asserting about a public claim.
 *
 * ## What each case is defending
 *
 * Every assertion below corresponds to a sentence that was published and was not true on
 * 2026-09-19. They are listed in `docs/product-scope.md` §11. Delete one only when the claim
 * it guards is removed from the site, never because the claim became inconvenient to keep.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@verify/ui';
import { LIMITS, formatMoney, money } from '@verify/contracts';
import { COVERAGE_MODE_SUPPORT, SELECTABLE_COVERAGE_MODES } from '@verify/domain';
import { PAYMENT_RECOVERY_POLICY } from '../../../apps/app/src/billing/policy.js';
import { OutcomePage } from '../../../apps/app/src/routes/app/onboardingPages.js';
import {
  SyntheticCustomerDataPort,
  resetSyntheticState,
} from '../../../apps/app/src/routes/app/syntheticPort.js';
import worker from '../../../apps/app/src/index.js';

/**
 * Bindings sufficient to serve a public page.
 *
 * `DB` answers every statement with nothing rather than throwing: no public route touches
 * it, and a throwing stub would turn "this route reads the database" into a passing test by
 * accident. `ASSETS` 404s so the rendered not-found page is exercised rather than an asset.
 */
const env = {
  ASSETS: { fetch: async () => new Response('', { status: 404 }) },
  DB: {
    prepare: () => {
      const statement = {
        bind: () => statement,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({}),
      };
      return statement;
    },
    batch: async () => [],
  },
  ENVIRONMENT: 'test',
  PUBLIC_BASE_URL: 'https://verify.itisyou.app',
} as never;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

/** Every page an anonymous visitor can reach and that carries product claims. */
const PUBLIC_PATHS = [
  '/',
  '/how-it-works',
  '/pricing',
  '/demo',
  '/security',
  '/support',
  '/terms',
  '/privacy',
  '/refunds',
  '/status',
] as const;

async function get(path: string): Promise<{ status: number; html: string }> {
  const response = await worker.fetch(new Request(`https://verify.itisyou.app${path}`), env, ctx);
  return { status: response.status, html: await response.text() };
}

/** Visible text, with entities resolved and whitespace collapsed — what a reader sees. */
function text(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `<meta name="description">` a search result or a link preview would quote. */
function metaDescription(markup: string): string {
  const match = /<meta name="description" content="([^"]*)"/.exec(markup);
  return match?.[1] ?? '';
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ *
 * Coverage: we cannot see a run that never started. There is no mode
 * that changes that, and the site must not imply one can be chosen.
 * ------------------------------------------------------------------ */

describe('CUST-330..332 the site does not offer coverage it has not built', () => {
  /**
   * `independently_sourced` is in the contract as a planned capability and is marked
   * `supported: false, selectable: false` in `packages/domain/src/coverage.ts`. No connector
   * can enumerate records it was never told about; no scheduler pass reconciles them. A
   * sentence beginning "only workflows set up with an independently sourced trigger can…"
   * describes a product a visitor cannot buy, on the page selling the product they can.
   */
  it('CUST-330 the home page states the blind spot plainly and offers no way around it', async () => {
    const { status, html } = await get('/');
    expect(status).toBe(200);
    const body = text(html);

    expect(body).toContain('We cannot tell you that a run never started');
    // Not "by default", not "unless you choose another mode". There is no other mode.
    expect(body).not.toMatch(/independently sourced/i);
    expect(body).not.toMatch(/independently[- ]sourced trigger/i);
  });

  it('CUST-331 no public page offers the unbuilt coverage mode anywhere in its copy', async () => {
    for (const path of PUBLIC_PATHS) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(text(html), path).not.toMatch(/independently sourced/i);
    }
  });

  it('CUST-332 the coverage answers say there is one coverage mode, not two', async () => {
    for (const path of ['/how-it-works', '/support']) {
      const body = text((await get(path)).html);
      expect(body, path).toContain('There is one coverage mode');
      // The old answer promised a second mode could be "set up". Nothing sets it up.
      expect(body, path).not.toMatch(/set up with an independently sourced trigger/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The connectors have never been run against a real provider account.
 * ------------------------------------------------------------------ */

describe('CUST-333 pages that claim we read HubSpot and Resend say how that has been proven', () => {
  /**
   * `tests/integration/connectors/live-smoke.test.ts` is explicit: no credential exists, both
   * provider-backed cases skip, and "every claim about reading records back is DESIGNED, NOT
   * OBSERVED". Only `/development-story/visual` said so. The pages that make the claim — the
   * home page, how it works, security — said nothing, so a visitor reading "we read the
   * record back from HubSpot" had no way to learn it had never been done.
   */
  it('CUST-333 every page making the claim states what the proof covers and what it does not', async () => {
    // `/demo` is in this list deliberately. It was the one public page that omitted the
    // notice, and it is the page a paid advert would land on -- a disclosure missing from
    // the page the traffic reaches is not a disclosure.
    //
    // Rewritten 20 September 2026. This case used to require the notice to name HubSpot as
    // UNPROVEN, which was the honest thing to require while it was. HubSpot was proven that
    // morning -- a contact read back from a live portal supported a verified run -- so the
    // old assertion would have forced the page to keep saying something false, and a test
    // that pins a stale disclosure is as dangerous as no test.
    //
    // What replaces it is the property that survives either state: a page claiming we read
    // your records back must say WHEN each provider was actually exercised, and must not let
    // "it worked against our account" stand for "it will work against yours". The second
    // half is now the load-bearing one, and it is the half a reader is most likely to
    // assume in our favour.
    for (const path of ['/', '/how-it-works', '/security', '/demo']) {
      const body = text((await get(path)).html);
      // Each provider named with the date it was exercised, so "proven" cannot float free.
      expect(body, path).toMatch(/Resend,?\s+19 September 2026/);
      expect(body, path).toMatch(/HubSpot,?\s+20 September 2026/);
      // And the limit of that proof, stated on the same page.
      expect(body, path).toContain('our own accounts and our own synthetic records');
      expect(body, path).toContain('not prove anything about your portal');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The payment-recovery policy, before the purchase decision.
 * ------------------------------------------------------------------ */

describe('CUST-334 the seven-day payment-recovery policy is disclosed before checkout', () => {
  /**
   * The founder's requirement was that the recovery policy is displayed before checkout, not
   * discovered afterwards. `preCheckoutPanel()` renders it on `/app/onboarding/review`, which
   * is behind a session nobody can currently obtain — so on the only page a prospective
   * customer can actually read, the price, the renewal, the cancellation terms and the tax
   * were all disclosed and what happens when a payment fails was not.
   *
   * Asserted against `PAYMENT_RECOVERY_POLICY` itself rather than retyped strings: if the
   * founder changes the window from seven days, this fails rather than passing against stale
   * prose.
   */
  it('CUST-334 /pricing carries the policy, sourced from the policy constant', async () => {
    const { status, html } = await get('/pricing');
    expect(status).toBe(200);
    const body = text(html);

    expect(body).toContain(collapse(PAYMENT_RECOVERY_POLICY.headline));
    for (const line of PAYMENT_RECOVERY_POLICY.whatPauses) {
      expect(body, line).toContain(collapse(line));
    }
    for (const line of PAYMENT_RECOVERY_POLICY.whatStaysAvailable) {
      expect(body, line).toContain(collapse(line));
    }
    expect(body).toContain(collapse(PAYMENT_RECOVERY_POLICY.afterWindow));
    expect(body).toContain(collapse(PAYMENT_RECOVERY_POLICY.dataHandling));
  });

  it('CUST-335 the policy is not hidden behind a disclosure control', async () => {
    const { html } = await get('/pricing');
    const at = html.indexOf('data-payment-recovery');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(0, at)).not.toContain('<details');
    expect(html).not.toContain('<summary');
  });
});

/* ------------------------------------------------------------------ *
 * Meta descriptions — the sentence quoted where nothing else is.
 * ------------------------------------------------------------------ */

describe('CUST-336..337 the meta descriptions do not outrun the product', () => {
  /**
   * A meta description is the one sentence a search result or a chat link preview shows, with
   * none of the qualifying copy around it. "ITISYOU Verify reads your HubSpot record and
   * Resend email status back itself" reads as a running service. The activation notice on the
   * page cannot qualify a sentence that is quoted away from the page.
   */
  it('CUST-336 the home description does not present live verification as happening today', async () => {
    const description = metaDescription((await get('/')).html);
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toMatch(/^ITISYOU Verify reads your HubSpot record/);
    expect(description).toMatch(/not (yet )?(accepting|taking)|not live|before it is live/i);
  });

  it('CUST-337 the pricing description does not instruct a visitor to use a portal they cannot reach', async () => {
    const description = metaDescription((await get('/pricing')).html);
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toMatch(/Cancel from the billing portal at any time/i);
    expect(description).toMatch(/not (yet )?(accepting|taking)|not on sale|checkout is closed/i);
  });
});

/* ------------------------------------------------------------------ *
 * Things the site said exist and do not.
 * ------------------------------------------------------------------ */

describe('CUST-338..339 the site does not point at things that do not exist', () => {
  /**
   * "see our onboarding guide for the exact steps" appeared verbatim on `/` (inside the
   * closing callout) and on `/support`. `/how-it-works` carried a callout admitting the guide
   * does not exist — which fixed the sentence on exactly one of the three pages that printed
   * it.
   */
  it('CUST-338 no public page refers the reader to an onboarding guide that has not been written', async () => {
    for (const path of PUBLIC_PATHS) {
      const body = text((await get(path)).html);
      expect(body, path).not.toMatch(/see our onboarding guide/i);
    }
  });

  /**
   * The footer is on every public page, including the legal ones, and stated as bare present
   * fact that the service reads HubSpot and Resend back. It is the last sentence a reader
   * sees on the terms page.
   */
  it('CUST-339 the footer describes the service without asserting it is running today', async () => {
    for (const path of PUBLIC_PATHS) {
      const body = text((await get(path)).html);
      expect(body, path).not.toContain(
        'A service that reads HubSpot and Resend back itself and reports what the evidence shows.',
      );
      expect(body, path).toContain('Not yet accepting live verification traffic');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The sign-in page a stranger actually lands on.
 * ------------------------------------------------------------------ */

describe('CUST-340 the activation path a stranger reaches explains itself', () => {
  /**
   * `GET /app` answers 401 with the sign-in page, so this is a public surface whatever the
   * router calls it. It invited the reader to "sign up" — there is no sign-up, no workspace
   * is being activated, and no payment is being taken. Signing in itself is untouched: an
   * existing account must still be able to reach its workspace.
   */
  it('CUST-340 the sign-in page carries the activation notice and does not invite a sign-up', async () => {
    const { status, html } = await get('/app');
    expect(status).toBe(401);
    const body = text(html);

    expect(body).toContain('We are not yet accepting live verification traffic');
    expect(body).not.toMatch(/before you sign up/i);
    // The sign-in form itself is preserved — this is a claims fix, not an outage.
    expect(html).toMatch(/<form[^>]*action="\/app\/sign-in"/);
    expect(body).toContain('Email me a sign-in link');
  });
});

/* ------------------------------------------------------------------ *
 * The claim the development story makes about the onboarding form.
 * ------------------------------------------------------------------ */

describe('CUST-341 the onboarding form offers only coverage we can deliver', () => {
  /**
   * `/development-story/visual` has claimed since commit 3c94f8d that the unsupported
   * coverage mode "is marked unsupported as data the onboarding UI reads". It was not: the
   * option list was two hard-coded literals and the POST handler stored whichever came back.
   * The public page described a fix that had not been made.
   *
   * **Stated plainly rather than papered over:** the second half of this case does not go
   * through the entry point, and the ones above all do. Every `/app` route answers 401
   * without a session, and obtaining one needs a real D1 plus the owner-authentication
   * wiring — neither of which belongs inside a claims test. So the page render is direct,
   * and what the entry point proves is the other half: that the route is not reachable
   * anonymously, so nobody can be offered the mode by accident today either.
   *
   * The assertion is against `SELECTABLE_COVERAGE_MODES`, not against a count: if A03 ever
   * marks the mode supported, this follows rather than blocking it.
   */
  it('CUST-341 the coverage selector lists exactly the modes the domain marks selectable', async () => {
    // What the entry point can prove: the step is not anonymously reachable.
    const anonymous = await get('/app/onboarding/outcome');
    expect(anonymous.status).toBe(401);

    resetSyntheticState();
    const workflow = await new SyntheticCustomerDataPort().workflow();
    const markup = await render(
      OutcomePage({ workflow, csrfToken: 'tok', submitted: null, deadlineChoices: [1800] }),
    );

    const select = /<select[^>]*name="coverageMode"[\s\S]*?<\/select>/.exec(markup)?.[0] ?? '';
    expect(select).not.toBe('');
    const offered = [...select.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    expect(offered).toEqual([...SELECTABLE_COVERAGE_MODES]);
    expect(offered).not.toContain('independently_sourced');

    // Withdrawn visibly, not silently: the reader is told the step exists and is closed,
    // in A03's own words rather than a fresh apology.
    expect(markup).toContain('data-unavailable="We find enquiries ourselves"');
    expect(text(markup)).toContain(
      collapse(COVERAGE_MODE_SUPPORT.independently_sourced.unavailable_reason ?? ''),
    );
  });
});

/* ------------------------------------------------------------------ *
 * The four claim classes a design audit found on a generated landing
 * page, asserted absent from ours. These are negative cases on purpose:
 * "we checked and found nothing" is only worth something if the check
 * keeps running.
 * ------------------------------------------------------------------ */

describe('CUST-342..345 claim classes that must never appear', () => {
  /**
   * A false certification is not marketing overreach; it is a false statement about a
   * regulated attestation. Every mention of the word "certification" on this site today is a
   * denial or a visible `TODO_OWNER_INPUT` gap, and this case exists so that stays true.
   *
   * `TRUST_WORDS` are matched against the visible text, so a CSS class called `badge` (which
   * the status badges legitimately use) cannot trip it and a rendered "SOC 2" cannot hide
   * behind one.
   */
  const CERTIFICATION_CLAIMS = [
    /\bSOC[ -]?2\b/i,
    /\bISO[ -]?27001\b/i,
    /\bPCI[ -]?DSS\b/i,
    /\bHIPAA\b/i,
    /\bType[ -]?I{1,2}\b/,
    /\bGDPR[ -]certified\b/i,
    /\bcertified\b/i,
    /\baccredited\b/i,
    /\bindependently audited\b/i,
    /\btrust (seal|badge|cent(er|re))\b/i,
  ];

  it('CUST-342 no public page carries a compliance, certification or audit claim', async () => {
    for (const path of [...PUBLIC_PATHS, '/development-story', '/development-story/visual']) {
      const body = text((await get(path)).html);
      for (const pattern of CERTIFICATION_CLAIMS) {
        expect(body, `${path} matched ${pattern}`).not.toMatch(pattern);
      }
      // And no image at all, so no badge graphic can carry the claim where text cannot.
      expect((await get(path)).html, path).not.toMatch(/<img\b/);
    }
  });

  /**
   * A fabricated quote attributed to a named person at a named company is the highest-risk
   * thing a landing page can carry. There are none here, and there is no markup capable of
   * presenting one either — no `<blockquote>`, no `<cite>`, no testimonial component.
   *
   * The competitor rule is narrower than "never name a competitor": `/` and `/how-it-works`
   * legitimately say "we never see inside n8n, Make, Zapier or whatever runs your workflow",
   * which is a statement about our own blindness, not about their products. What is barred
   * is a claim about what a competitor's product does or fails to do.
   */
  it('CUST-343 no attributed quote, named individual or competitor capability claim', async () => {
    for (const path of PUBLIC_PATHS) {
      const { html } = await get(path);
      const body = text(html);

      expect(html, path).not.toMatch(/<blockquote\b/);
      expect(html, path).not.toMatch(/<cite\b/);
      expect(body, path).not.toMatch(/\btestimonial\b/i);
      expect(body, path).not.toMatch(/\btrusted by\b/i);
      expect(body, path).not.toMatch(/\bcase study\b/i);
      // "— Firstname Lastname, Company" — the shape of an attributed quote.
      expect(body, path).not.toMatch(/[—–-]\s*[A-Z][a-z]+ [A-Z][a-z]+,\s*[A-Z]/);
      // A claim about what a competitor does, rather than about what we cannot see.
      expect(body, path).not.toMatch(
        /\b(Zapier|Make|n8n|Workato|Tray)\b[^.]{0,80}\b(fails?|cannot|can't|doesn't|does not|misses)\b/i,
      );
    }
  });

  /**
   * The frozen contract is observe-only: "The service observes. It never modifies a
   * customer's CRM, sends replacement emails or repairs their automation." A remediation
   * claim is therefore not merely unimplemented — it can never become true under this
   * design, which is why the check covers future and aspirational phrasing too.
   */
  it('CUST-344 no page claims we fix, retry, heal or remediate a customer system', async () => {
    for (const path of PUBLIC_PATHS) {
      const body = text((await get(path)).html);
      for (const pattern of [
        /\bauto[- ]?heal/i,
        /\bself[- ]?heal/i,
        /\bauto[- ]?remediat/i,
        /\bremediat/i,
        /\bself[- ]?repair/i,
        /\bwe (will )?(fix|repair|heal|resend|re-?run|re-?trigger) your\b/i,
      ]) {
        expect(body, `${path} matched ${pattern}`).not.toMatch(pattern);
      }
      // And the positive statement of the same rule is present where it belongs.
      if (path === '/' || path === '/how-it-works') {
        expect(body, path).toContain('It does not fix anything');
      }
    }
  });

  /**
   * An install command for a registry name nobody has claimed is a supply-chain exposure as
   * well as a false claim: it tells a reader to fetch code from a name an attacker can
   * register. There is none, and no page carries a code block at all.
   */
  it('CUST-345 no page publishes an install command or a package name', async () => {
    for (const path of PUBLIC_PATHS) {
      const { html } = await get(path);
      const body = text(html);
      for (const pattern of [
        /\bpip install\b/i,
        /\bnpm (i|install|add)\b/i,
        /\b(pnpm|yarn) add\b/i,
        /\bgem install\b/i,
        /\bgo get\b/i,
        /\bcargo add\b/i,
        /\bbrew install\b/i,
        /\bPyPI\b/i,
        /\bnpmjs\.com\b/i,
        /\bcrates\.io\b/i,
      ]) {
        expect(body, `${path} matched ${pattern}`).not.toMatch(pattern);
      }
      expect(html, path).not.toMatch(/<pre\b/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Every published figure, against the constant that governs it.
 * ------------------------------------------------------------------ */

describe('CUST-346..347 published figures match the implementation', () => {
  /**
   * The price, the allowance, the retention period and the recovery window are the only
   * numbers this site publishes. Each is asserted against its constant, and the currency is
   * asserted too: a design audit of a generated page found USD tiers against a GBP plan, and
   * a wrong currency symbol is a wrong price.
   */
  it('CUST-346 price, currency, allowance, retention and recovery window all come from the contract', async () => {
    const price = formatMoney(money(LIMITS.PLAN_PRICE_PENCE, 'GBP'));
    expect(price).toBe('£29.00');

    for (const path of ['/pricing', '/terms']) {
      const body = text((await get(path)).html);
      expect(body, path).toContain(price);
      expect(body, path).toContain(String(LIMITS.PLAN_RUNS_PER_PERIOD));
      expect(body, path).toContain(`${LIMITS.EVIDENCE_RETENTION_DAYS} days`);
    }

    const pricing = text((await get('/pricing')).html);
    expect(pricing).toContain(`${PAYMENT_RECOVERY_POLICY.graceDays} days`);

    // No other currency appears anywhere a visitor can read.
    for (const path of PUBLIC_PATHS) {
      const body = text((await get(path)).html);
      expect(body, path).not.toMatch(/\$\s?\d/);
      expect(body, path).not.toMatch(/€\s?\d/);
      expect(body, path).not.toMatch(/\b\d+(\.\d+)?\s?(USD|EUR)\b/);
    }
  });

  /**
   * Values agreeing today is not the same as one number. A retyped figure passes every
   * rendering assertion right up to the moment somebody changes the constant, which is
   * exactly when a claims test should have fired. So this one reads the copy modules as
   * source and fails on a hard-coded duplicate of a governed number.
   *
   * Four existed on 2026-09-19: "30 days" and "Thirty days" in two FAQ answers, "30 days" in
   * `EVIDENCE_RETENTION_NOTE`, and "500 runs a month … seven days" in the pricing page's meta
   * description.
   */
  it('CUST-347 no customer-facing copy module hard-codes a governed figure', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const modules = [
      'packages/ui/src/content/faq.ts',
      'packages/ui/src/content/legal.ts',
      'packages/ui/src/content/pricing.ts',
      'packages/ui/src/content/home.ts',
      'packages/ui/src/content/site.ts',
      'apps/app/src/routes/public/index.ts',
    ];
    const governed = [
      new RegExp(`\\b${LIMITS.EVIDENCE_RETENTION_DAYS} days\\b`),
      /\bThirty days\b/i,
      new RegExp(`\\b${LIMITS.PLAN_RUNS_PER_PERIOD} runs\\b`),
      /\bseven days\b/i,
      /£\s?29/,
    ];

    for (const relative of modules) {
      const source = readFileSync(resolve(here, '../../..', relative), 'utf8');
      // Strip block and line comments: a comment explaining why a number is not retyped is
      // allowed to name the number.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of governed) {
        expect(code, `${relative} hard-codes ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

/**
 * The claim rules added for the approved designs actually fire.
 *
 * ## Why this exists, and it is not theoretical
 *
 * The owner approved nineteen Stitch screens as a VISUAL reference and asked that invented
 * prices, providers, guarantees and tax statements be replaced with the real configuration.
 * Sweeping those files found the scale: a £85 monthly price where the plan is £29, a
 * "14-Day Agency Trial" where no trial exists, per-seat and volume-tier language where
 * there is one plan, and — caught by a rule that already existed — a claim of **SOC2 Type
 * II**, a certification this business does not hold.
 *
 * Three rules were added for the gaps. When first written they matched **nothing**: a
 * mangled escape had left literal backspace characters (`\u0008`) inside the patterns,
 * invisible in every editor and in `grep` output, and the rules were decoration. The
 * scanner reported "clean" over content containing four wrong prices.
 *
 * So this file asserts the rules FIRE, on the exact strings the designs use. A claim guard
 * that cannot be shown to catch anything is the same defect as correct code nothing
 * reaches, and this project has now shipped that shape often enough to test for it.
 *
 * Case ids `DOC-503..DOC-505`.
 */
describe('the claim rules for the approved designs are not decoration', () => {
  /** Read the live rule out of the scanner, so a drifted copy cannot pass this. */
  function ruleFor(id: string): RegExp {
    const source = readFileSync('scripts/scan-claims.mjs', 'utf8');
    const at = source.indexOf(`id: '${id}'`);
    expect(at, `rule ${id} is not in the scanner`).toBeGreaterThan(-1);
    const line = source
      .slice(at)
      .split('\n')
      .find((candidate) => candidate.trim().startsWith('re: '));
    expect(line, `rule ${id} has no regex`).toBeDefined();
    const literal = (line ?? '').trim().slice(4).replace(/,$/, '');
    const end = literal.lastIndexOf('/');
    const pattern = new RegExp(literal.slice(1, end), literal.slice(end + 1));
    // The bug that made all three dead. Nothing in a rule may be a control character.
    expect(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(pattern.source),
      `rule ${id} contains a control character, which silently breaks matching`,
    ).toBe(false);
    return pattern;
  }

  it('DOC-503 a monthly price that is not the plan price is caught, and the real one is not', () => {
    const rule = ruleFor('wrong-plan-price');
    // Verbatim from the designs.
    for (const invented of ['£85 / month', '£120.00 / month', '£340.00/month', '£49 / month']) {
      expect(rule.test(invented), `${invented} was not caught`).toBe(true);
    }
    // And the paired half, which is the one that matters: our own true sentence must pass.
    for (const truthful of ['£29.00 a month', '£29 per month', '£29.00 a month for 500 runs']) {
      expect(rule.test(truthful), `${truthful} was wrongly flagged`).toBe(false);
    }
  });

  it('DOC-504 a trial this product does not offer is caught, and saying so is still allowed', () => {
    const rule = ruleFor('unoffered-trial');
    for (const invented of ['14-Day Agency Trial', 'No CC Required', '14-Day Trial']) {
      expect(rule.test(invented), `${invented} was not caught`).toBe(true);
    }
    // The site must stay able to state the truth plainly.
    expect(rule.test('There is no free trial.')).toBe(false);
  });

  it('DOC-505 plan tiers and seat pricing are caught', () => {
    const rule = ruleFor('invented-plan-tier');
    for (const invented of [
      'Starter Agency',
      'High-Scale Partner',
      'per-seat',
      'seat limits',
      'VOLUME TIER',
    ]) {
      expect(rule.test(invented), `${invented} was not caught`).toBe(true);
    }
    expect(rule.test('One plan. One workflow. 500 runs a month.')).toBe(false);
  });
});
