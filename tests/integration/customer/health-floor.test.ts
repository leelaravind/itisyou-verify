/**
 * CUST-400..CUST-403 — the verification rate never rounds up, on any page that shows one.
 *
 * ## The scar, one layer further up
 *
 * The 33%-drawn-as-100% incident was fixed twice: first in transport (`meterFillClass`
 * rounds down to a predefined class, because `style-src-attr 'none'` drops an inline
 * width), then in the usage arithmetic (`percentFloor`, after 499 of 500 rendered as 100%).
 * The verification-rate readout on `/app` and `/demo` takes its number from a third place —
 * `summariseWorkflowHealth()` in the domain package — and that one rounded to nearest. So
 * 199 verified of 200 decided runs became the integer 100, which prints "100%" in the score
 * and selects `meter__fill--100`: a full bar and a perfect score for a workflow with a run
 * that failed. The page the reader trusts most was the last one still capable of the lie.
 *
 * Every case reads the bytes the Worker serves for a real request, because the arithmetic
 * lives in one package, the class in another and the number in a third, and only the served
 * page shows whether they agree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import { getSignedIn, seedRunsFor, signedInWorkspace, type SignedIn } from './harness.js';

let open: SignedIn | null = null;

afterEach(() => {
  open?.h.close();
  open = null;
});

/** The meter fill modifier actually served, e.g. `95` from `meter__fill--95`. */
function fillStep(html: string): string | null {
  return /meter__fill meter__fill--(\d+)/.exec(html)?.[1] ?? null;
}

function score(html: string): string | null {
  return /data-score="([^"]+)"/.exec(html)?.[1] ?? null;
}

describe('the verification rate rounds down everywhere it is shown', () => {
  it('CUST-400 GET /app shows 2 verified of 3 decided as 66%, never 67%', async () => {
    open = await signedInWorkspace();
    seedRunsFor(open, [
      { id: 'run_v1', status: 'VERIFIED' },
      { id: 'run_v2', status: 'VERIFIED' },
      { id: 'run_f1', status: 'FAILED' },
    ]);
    const { status, html } = await getSignedIn(open, '/app');
    expect(status).toBe(200);
    expect(score(html)).toBe('66');
    expect(html).not.toContain('67% of decided runs');
    expect(html).toContain('66% of decided runs');
  });

  it('CUST-401 GET /app does not print 100% or fill the meter at 199 verified of 200 decided', async () => {
    open = await signedInWorkspace();
    const runs = Array.from({ length: 199 }, (_, i) => ({
      id: `run_ok_${String(i)}`,
      status: 'VERIFIED',
    }));
    seedRunsFor(open, [...runs, { id: 'run_bad', status: 'FAILED' }]);
    const { status, html } = await getSignedIn(open, '/app');
    expect(status).toBe(200);
    // Proof the fixture reached the page: the failed run is named in the headline.
    expect(html).toContain('1 run failed');
    expect(score(html)).toBe('99');
    expect(fillStep(html)).toBe('95');
    expect(html).not.toContain('meter__fill meter__fill--100');
    expect(html).not.toContain('100% of');
  });

  it('CUST-402 GET /app still fills the meter when every decided run really was verified', async () => {
    open = await signedInWorkspace();
    seedRunsFor(open, [
      { id: 'run_v1', status: 'VERIFIED' },
      { id: 'run_v2', status: 'VERIFIED' },
      { id: 'run_p1', status: 'PENDING' },
    ]);
    const { html } = await getSignedIn(open, '/app');
    // Rounding down must not become "the bar can never finish".
    expect(score(html)).toBe('100');
    expect(fillStep(html)).toBe('100');
  });

  it('CUST-403 GET /demo draws its 33% as the 30 step, never the 35 step and never full', async () => {
    const response = await worker.fetch(
      new Request('https://verify.itisyou.app/demo'),
      {
        ASSETS: { fetch: async () => new Response('', { status: 404 }) },
        DB: {},
        ENVIRONMENT: 'test',
        PUBLIC_BASE_URL: 'https://verify.itisyou.app',
      } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(score(html)).toBe('33');
    expect(fillStep(html)).toBe('30');
  });
});
