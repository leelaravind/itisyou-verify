/**
 * CUST-420..CUST-427 — the claim/evidence comparator, as served.
 *
 * The one idea worth taking from the generated designs was a side-by-side panel: what the
 * automation reported beside what an independent check retrieved, the same fields in both
 * columns. `design/MAPPING.md` §8 specifies it; this file asserts that specification on
 * the pages that render it, through the Worker entry point.
 *
 * The rules that carry the most weight are the ones the generated version could not
 * express: an UNVERIFIED row is never an empty cell, never an em dash and never a spinner
 * — it is the words `no reading`, a dashed cell border echoing the dashed glyph ring, and a
 * reason line naming what blocked the check. A mixed panel is UNVERIFIED, not
 * VERIFIED-with-notes. And the column heads say who made the claim and what we actually
 * did, never "reality" or "truth".
 */
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import {
  getSignedIn,
  seedAssertionsFor,
  seedRunsFor,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness.js';

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

async function getDemo(): Promise<string> {
  const response = await worker.fetch(
    new Request('https://verify.itisyou.app/demo'),
    PUBLIC_ENV,
    ctx,
  );
  expect(response.status).toBe(200);
  return response.text();
}

/** Every comparator on the page, as raw markup, verdict strip included. */
function comparators(html: string): readonly string[] {
  return html.match(/<div class="compare"[\s\S]*?<\/div>\s*<\/div>/g) ?? [];
}

function rows(comparator: string): readonly string[] {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(comparator)?.[1] ?? '';
  return body.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
}

/** A run with one confirmed check and one that could not be read — the mixed panel. */
async function mixedRun(): Promise<SignedIn> {
  const s = await signedInWorkspace();
  seedRunsFor(s, [{ id: 'run_mix', status: 'UNVERIFIED' }]);
  seedAssertionsFor(s, 'run_mix', [
    {
      ruleId: 'r1_crm',
      label: 'A CRM record was created',
      status: 'SUPPORTED',
      reasonCode: 'MATCHED',
      expected: 'a contact carrying enq_0001',
      observed: 'contact crm-rec-1 carrying enq_0001',
    },
    // Later rule id, so the database hands it back second; only the component's own
    // ordering can put it first.
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

describe('the comparator is a table, and says who claimed what', () => {
  it('CUST-420 GET /demo serves the comparator as a captioned table with a row header per field', async () => {
    const html = await getDemo();
    const panels = comparators(html);
    expect(panels.length).toBeGreaterThanOrEqual(4);
    for (const panel of panels) {
      expect(panel).toMatch(/<table class="compare__table"/);
      expect(panel).toMatch(/<caption/);
      expect((panel.match(/<th scope="col"/g) ?? []).length).toBe(3);
      for (const row of rows(panel)) {
        expect(row).toMatch(/<th scope="row"/);
        // The row's verdict is announced before its two values.
        expect(row.indexOf('badge__glyph')).toBeLessThan(row.indexOf('<td'));
      }
    }
  });

  it('CUST-421 the column heads name the claimant and the act, never reality or truth', async () => {
    const html = await getDemo();
    // Not vacuous: the page must actually render the component under test.
    expect(comparators(html).length).toBeGreaterThan(0);
    for (const panel of comparators(html)) {
      const heads = visibleText(/<thead[^>]*>[\s\S]*?<\/thead>/.exec(panel)?.[0] ?? '');
      expect(heads).toContain('Reported by your workflow');
      expect(heads).toContain('What we retrieved');
      expect(heads.toLowerCase()).not.toMatch(/reality|truth|actual|claimed|reported state/);
    }
  });
});

describe('an UNVERIFIED row is an absence with a stated reason, not a blank', () => {
  it('CUST-422 the unknown row reads "no reading" in a dashed cell, and carries its reason line', async () => {
    open = await mixedRun();
    const { status, html } = await getSignedIn(open, '/app/runs/run_mix');
    expect(status).toBe(200);
    const [panel] = comparators(html);
    expect(panel).toBeDefined();

    const unknown = rows(panel ?? '').find((row) => row.includes('data-row-status="UNKNOWN"'));
    expect(unknown).toBeDefined();
    const cells = unknown?.match(/<td[\s\S]*?<\/td>/g) ?? [];
    expect(cells.length).toBe(2);
    const retrieved = cells[1] ?? '';
    expect(retrieved).toContain('compare__cell--unverified');
    expect(visibleText(retrieved)).toBe('no reading');
    // Never an em dash, an ellipsis or an empty cell.
    expect(retrieved).not.toMatch(/—|…|<td[^>]*>\s*<\/td>/);
    // The reason is adjacent and visible: in the row, not behind a control.
    const reason = visibleText(/<[^>]*data-row-reason[^>]*>[\s\S]*?<\/[a-z]+>/.exec(unknown ?? '')?.[0] ?? '');
    expect(reason.toLowerCase()).toContain('could not reach the connected system');
    expect(unknown).not.toContain('<details');
  });

  it('CUST-423 the pending right cell says "not checked yet" and the confirmed row says nothing extra', async () => {
    const html = await getDemo();
    const pendingRows = comparators(html)
      .flatMap((panel) => rows(panel))
      .filter((row) => row.includes('data-row-status="PENDING"'));
    expect(pendingRows.length).toBeGreaterThan(0);
    for (const row of pendingRows) {
      const cells = row.match(/<td[\s\S]*?<\/td>/g) ?? [];
      expect(visibleText(cells[1] ?? '')).toBe('not checked yet');
    }
    const confirmed = comparators(html)
      .flatMap((panel) => rows(panel))
      .filter((row) => row.includes('data-row-status="SUPPORTED"'));
    expect(confirmed.length).toBeGreaterThan(0);
    for (const row of confirmed) {
      expect(row).not.toContain('data-row-reason');
      expect(row).not.toContain('compare__cell--unverified');
    }
  });

  it('CUST-424 UNVERIFIED rows lead when the panel is UNVERIFIED, whatever order the database returned', async () => {
    open = await mixedRun();
    const { html } = await getSignedIn(open, '/app/runs/run_mix');
    const [panel] = comparators(html);
    const order = rows(panel ?? '').map((row) => /data-row-status="([A-Z]+)"/.exec(row)?.[1]);
    expect(order).toEqual(['UNKNOWN', 'SUPPORTED']);
  });

  it('CUST-425 a mixed panel is UNVERIFIED, and the strip says how many items could not be checked', async () => {
    open = await mixedRun();
    const { html } = await getSignedIn(open, '/app/runs/run_mix');
    const [panel] = comparators(html);
    const strip = /<p class="compare__verdict"[\s\S]*?<\/p>/.exec(panel ?? '')?.[0] ?? '';
    expect(strip).toContain('data-compare-verdict="UNVERIFIED"');
    const text = visibleText(strip);
    expect(text).toContain('We could not check 1 of 2 items');
    // Not rounded up: one confirmed of two is not a pass.
    expect(text.toLowerCase()).not.toContain('every item matched');
    // The strip is outside the table, so it is not mistaken for a row.
    expect((panel ?? '').indexOf('</table>')).toBeLessThan((panel ?? '').indexOf('compare__verdict'));
  });

  it('CUST-426 a FAILED row emphasises both values, never only the "wrong" side', async () => {
    const html = await getDemo();
    const failed = comparators(html)
      .flatMap((panel) => rows(panel))
      .filter((row) => row.includes('data-row-status="CONTRADICTED"'));
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      const cells = row.match(/<td[\s\S]*?<\/td>/g) ?? [];
      expect(cells.length).toBe(2);
      expect(cells[0]).toContain('compare__cell--emphasis');
      expect(cells[1]).toContain('compare__cell--emphasis');
    }
  });

  it('CUST-427 no inline style, no script and no animation reaches the comparator', async () => {
    const html = await getDemo();
    for (const panel of comparators(html)) {
      expect(panel).not.toMatch(/\sstyle="/);
      expect(panel).not.toMatch(/\son[a-z]+="/);
      expect(panel).not.toContain('<script');
    }
    // And the stylesheet gives the verdict no motion.
    const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) ?? [])[1] ?? '';
    const compareRules = css.match(/\.compare[^{]*\{[^}]*\}/g) ?? [];
    expect(compareRules.length).toBeGreaterThan(3);
    for (const rule of compareRules) expect(rule).not.toMatch(/animation|transition/);
  });
});
