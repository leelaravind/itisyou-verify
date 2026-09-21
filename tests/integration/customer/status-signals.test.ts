/**
 * CUST-410..CUST-416 — the four statuses are distinguishable with no colour at all, and an
 * UNVERIFIED verdict names the hole in it.
 *
 * ## The measurement behind this file
 *
 * The four status colours were measured against each other (`design/MAPPING.md` §2): the
 * pairwise contrast runs 1.03–1.24:1 in light mode and 1.01–1.11:1 in dark. In greyscale,
 * or to a reader who cannot separate the hues, all four are the same mark. Colour here is
 * not a weak signal; it is no signal. So every status must carry signals that survive its
 * colour being removed, and this file asserts them on the pages a customer is served — not
 * on a component's return value, because the stylesheet, the markup and the data only meet
 * in the response body.
 *
 * The four signals, from the design: a glyph with a distinct silhouette, an always-rendered
 * text label, a border, and — new here — a border *style*: solid for the three settled
 * answers, dashed for UNVERIFIED, because the container's outline is broken when the check
 * is. UNVERIFIED keeps the same size, weight and type as the others: it is a first-class
 * answer meaning "we do not know", not a quieter pass or a quieter fail.
 *
 * And a headline UNVERIFIED verdict is not a statement until it says what could not be
 * checked and why — so it must carry a follow-up line naming the gap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import {
  getSignedIn,
  seedAssertionsFor,
  seedRunsFor,
  servedStylesheet,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness.js';
import { DEMO_RUNS } from '../../../apps/app/src/routes/public/demoData.js';

let open: SignedIn | null = null;

afterEach(() => {
  open?.h.close();
  open = null;
});

const PUBLIC_ENV = {
  ASSETS: { fetch: async () => new Response('', { status: 404 }) },
  DB: {},
  ENVIRONMENT: 'test',
  PUBLIC_BASE_URL: 'https://verify.itisyou.app',
} as never;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

async function getPublic(path: string): Promise<string> {
  const response = await worker.fetch(
    new Request(`https://verify.itisyou.app${path}`),
    PUBLIC_ENV,
    ctx,
  );
  expect(response.status).toBe(200);
  return response.text();
}

/**
 * Every `<span class="badge …">` element, whole. A badge contains a nested `sr-only` span,
 * so a lazy regex would stop at the inner close; this walks span depth instead.
 */
function badgesIn(html: string): readonly string[] {
  const out: string[] = [];
  const open = /<span[^>]*class="badge[^"]*"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const tag = /<\/?span\b[^>]*>/g;
    tag.lastIndex = cursor;
    let inner: RegExpExecArray | null;
    while (depth > 0 && (inner = tag.exec(html)) !== null) {
      depth += inner[0].startsWith('</') ? -1 : 1;
      cursor = inner.index + inner[0].length;
    }
    out.push(html.slice(match.index, cursor));
    open.lastIndex = cursor;
  }
  return out;
}

/** The declarations of every rule whose selector list contains `selector`, joined. */
function declarationsFor(css: string, selector: string): string {
  const out: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(match[2] ?? '');
  }
  return out.join(';');
}

/** An UNVERIFIED run whose two checks are one confirmed and one that could not be read. */
async function unverifiedRun(): Promise<SignedIn> {
  const s = await signedInWorkspace();
  seedRunsFor(s, [{ id: 'run_unv', status: 'UNVERIFIED' }]);
  seedAssertionsFor(s, 'run_unv', [
    {
      ruleId: 'r1_crm',
      label: 'A CRM record was created',
      status: 'SUPPORTED',
      reasonCode: 'MATCHED',
      expected: 'a contact carrying enq_0001',
      observed: 'contact crm-rec-1 carrying enq_0001',
    },
    {
      ruleId: 'r2_email',
      label: 'The acknowledgement email was delivered',
      status: 'UNKNOWN',
      reasonCode: 'CONNECTION_UNAVAILABLE',
      expected: 'a delivered event for a**@example.test',
      observed: null,
    },
  ]);
  return s;
}

describe('the four statuses survive the removal of colour', () => {
  it('CUST-410 the served stylesheet gives UNVERIFIED a dashed border and the other three a solid one', async () => {
    open = await unverifiedRun();
    const { status, html } = await getSignedIn(open, '/app/runs');
    expect(status).toBe(200);
    // The page really renders the badge under test, so this is not a vacuous read of CSS.
    expect(html).toContain('badge--unverified');

    const css = servedStylesheet(html);
    expect(css.length).toBeGreaterThan(1000);
    expect(declarationsFor(css, '.badge--unverified')).toMatch(/border-style:\s*dashed/);
    for (const other of ['.badge--verified', '.badge--failed', '.badge--pending']) {
      expect(declarationsFor(css, other), other).not.toMatch(/dashed/);
    }
  });

  it('CUST-411 UNVERIFIED is not rendered smaller, thinner or quieter than the other three', async () => {
    open = await unverifiedRun();
    const css = servedStylesheet((await getSignedIn(open, '/app/runs')).html);
    // Size, weight and type come from `.badge`; no status modifier may override them. A
    // verdict rendered smaller than a pass teaches the reader to skim past it.
    for (const modifier of [
      '.badge--verified',
      '.badge--failed',
      '.badge--unverified',
      '.badge--pending',
    ]) {
      const declarations = declarationsFor(css, modifier);
      expect(declarations, modifier).not.toMatch(
        /font-size|font-weight|padding|opacity|border-width/,
      );
    }
    // The badge that carries the dash also carries full colour, not a faint grey: it says
    // "unresolved", not "unimportant".
    expect(declarationsFor(css, '.badge--unverified')).toMatch(/color:\s*var\(--c-unverified\)/);
  });

  it('CUST-412 every status badge on the run list carries a glyph with its own silhouette and a text label', async () => {
    open = await signedInWorkspace();
    seedRunsFor(open, [
      { id: 'run_v', status: 'VERIFIED' },
      { id: 'run_f', status: 'FAILED' },
      { id: 'run_u', status: 'UNVERIFIED' },
      { id: 'run_p', status: 'PENDING' },
    ]);
    const { html } = await getSignedIn(open, '/app/runs');
    const badges = badgesIn(html);
    const byStatus = new Map<string, string>();
    for (const badge of badges) {
      const status = /data-status="([A-Z]+)"/.exec(badge)?.[1];
      if (status !== undefined) byStatus.set(status, badge);
    }
    expect([...byStatus.keys()].sort()).toEqual(['FAILED', 'PENDING', 'UNVERIFIED', 'VERIFIED']);

    // Four different path bodies: the silhouettes differ, not only the fill.
    const paths = new Set(
      [...byStatus.values()].map((badge) => (badge.match(/<path[^>]*>/g) ?? []).join('')),
    );
    expect(paths.size).toBe(4);
    // Only UNVERIFIED's ring is broken.
    expect(byStatus.get('UNVERIFIED')).toContain('stroke-dasharray');
    for (const settled of ['VERIFIED', 'FAILED', 'PENDING']) {
      expect(byStatus.get(settled), settled).not.toContain('stroke-dasharray');
    }
    // And each says its word, with the screen-reader prefix.
    for (const [status, badge] of byStatus) {
      const text = visibleText(badge);
      expect(text).toContain('Status:');
      expect(text.toLowerCase()).toContain(status.toLowerCase());
    }
  });
});

describe('an UNVERIFIED verdict shows the shape of the hole', () => {
  it('CUST-413 GET /app/runs/:id for an UNVERIFIED run names the check that could not be completed and why', async () => {
    open = await unverifiedRun();
    const { status, html } = await getSignedIn(open, '/app/runs/run_unv');
    expect(status).toBe(200);

    const gaps = html.match(/<p class="verdict-gap"[^>]*>[\s\S]*?<\/p>/g) ?? [];
    expect(gaps.length, 'an UNVERIFIED headline verdict must carry a follow-up line').toBe(1);
    const gap = visibleText(gaps[0] ?? '');
    expect(gap).toContain('The acknowledgement email was delivered');
    expect(gap.toLowerCase()).toContain('could not reach the connected system');
    // Never a reason code in place of a sentence, and never "our side" turned into blame.
    expect(gap).not.toContain('CONNECTION_UNAVAILABLE');
  });

  it('CUST-414 the follow-up line sits inside the verdict block, directly under the badge', async () => {
    open = await unverifiedRun();
    const { html } = await getSignedIn(open, '/app/runs/run_unv');
    const verdict = /<div[^>]*data-run-verdict="UNVERIFIED"[\s\S]*?<\/div>\s*<\/div>/.exec(
      html,
    )?.[0];
    expect(verdict).toBeDefined();
    expect(verdict).toContain('data-verdict-gap');
    // Not behind a disclosure, not in a tooltip.
    expect(verdict).not.toContain('<details');
    expect(verdict).not.toContain('title="');
  });

  it('CUST-418 two checks blocked by the same outage are named in one line, not in two identical ones', async () => {
    /*
     * Both checks on this run are blocked by one unreachable provider, so both carry the
     * same forty-word sentence. Printed once per gap, that paragraph appeared twice, back
     * to back, word for word. A paragraph repeated verbatim is one a reader learns to skip,
     * which is the opposite of what a follow-up line under an amber verdict is for.
     *
     * Nothing moved into a disclosure and nothing was shortened: both labels are still
     * named, at body size, in the flow. Only the duplicate sentence is gone.
     */
    open = await signedInWorkspace();
    seedRunsFor(open, [{ id: 'run_two', status: 'UNVERIFIED' }]);
    seedAssertionsFor(open, 'run_two', [
      {
        ruleId: 'r1_email',
        label: 'The acknowledgement email was delivered',
        status: 'UNKNOWN',
        reasonCode: 'CONNECTION_UNAVAILABLE',
        expected: 'a delivered event for a**@example.test',
        observed: null,
      },
      {
        ruleId: 'r2_recipient',
        label: 'The acknowledgement went to the address the enquiry named',
        status: 'UNKNOWN',
        reasonCode: 'CONNECTION_UNAVAILABLE',
        expected: 'a**@example.test',
        observed: null,
      },
    ]);

    const { html } = await getSignedIn(open, '/app/runs/run_two');
    const gaps = [...html.matchAll(/data-verdict-gap[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? '');
    expect(gaps.length, 'the same reason was printed once per check again').toBe(1);

    // Both checks are still named, in one line.
    const line = gaps[0] ?? '';
    expect(line).toContain('The acknowledgement email was delivered');
    expect(line).toContain('The acknowledgement went to the address the enquiry named');
    expect(line.toLowerCase()).toContain('could not reach the connected system');
    expect(line, 'a reason code replaced the sentence').not.toContain('CONNECTION_UNAVAILABLE');
  });

  it('CUST-419 two checks blocked for DIFFERENT reasons keep their own lines', async () => {
    // The grouping must not be a collapse. Two different reasons are two different facts.
    open = await signedInWorkspace();
    seedRunsFor(open, [{ id: 'run_mixed', status: 'UNVERIFIED' }]);
    seedAssertionsFor(open, 'run_mixed', [
      {
        ruleId: 'r1_email',
        label: 'The acknowledgement email was delivered',
        status: 'UNKNOWN',
        reasonCode: 'CONNECTION_UNAVAILABLE',
        expected: 'a delivered event for a**@example.test',
        observed: null,
      },
      {
        ruleId: 'r2_record',
        label: 'A CRM record was created',
        status: 'UNKNOWN',
        reasonCode: 'EVIDENCE_UNAVAILABLE',
        expected: 'a contact carrying enq_0001',
        observed: null,
      },
    ]);

    const { html } = await getSignedIn(open, '/app/runs/run_mixed');
    const gaps = [...html.matchAll(/data-verdict-gap[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? '');
    expect(gaps.length, 'two different reasons were merged into one line').toBe(2);
  });

  it('CUST-415 a VERIFIED run carries no follow-up line, so the line keeps its meaning', async () => {
    open = await signedInWorkspace();
    seedRunsFor(open, [{ id: 'run_ok', status: 'VERIFIED' }]);
    seedAssertionsFor(open, 'run_ok', [
      {
        ruleId: 'r1_crm',
        label: 'A CRM record was created',
        status: 'SUPPORTED',
        reasonCode: 'MATCHED',
        expected: 'a contact carrying enq_0001',
        observed: 'contact crm-rec-1 carrying enq_0001',
      },
    ]);
    const { html } = await getSignedIn(open, '/app/runs/run_ok');
    expect(html).not.toContain('data-verdict-gap');
  });

  it('CUST-416 the public demo shows the follow-up line on its unverified run and on no other', async () => {
    const html = await getPublic('/demo');
    // One chunk per run section, each running to the next run's section (cards are
    // sections too, so a lazy `</section>` match would stop at the first nested card).
    //
    // Keyed on `data-demo-run`, NOT on a CSS class. This split used to look for
    // `<section class="stack" id="run_`, and on 20 September 2026 a composition change
    // restyled that wrapper to `class="panel"`. The property below was still true and the
    // case stopped testing it: zero sections matched, so the loop ran zero times and only
    // the length assertion failed. Had the length floor been absent as well, this would
    // have passed while asserting nothing. A test that depends on a class name is a test
    // that any restyle can silently void.
    const sections = html.split(/(?=<section [^>]*data-demo-run=)/).slice(1);
    expect(sections.length, 'no run sections were found — the marker has moved again').toBe(
      DEMO_RUNS.length,
    );
    let unverified = 0;
    for (const section of sections) {
      const isUnverified = section.includes('data-run-verdict="UNVERIFIED"');
      if (isUnverified) unverified += 1;
      expect(section.includes('data-verdict-gap'), section.slice(0, 60)).toBe(isUnverified);
    }
    expect(unverified).toBe(1);
  });
});

describe('the wording of an access gap says whose gap it is', () => {
  it('CUST-417 the demo explains an access-blocked run as a gap in our reading, not a fault in the automation', async () => {
    const text = visibleText(await getPublic('/demo'));
    // The decision engine's own sentence for UNVERIFIED_ACCESS, as served on the demo page.
    expect(text).toContain('unverified rather than failed');
    expect(text.toLowerCase()).toContain('not a fault we found in your automation');
  });
});
