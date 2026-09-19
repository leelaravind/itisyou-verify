/**
 * CUST-380..CUST-382 — a figure a customer reads says what it actually is.
 *
 * All three of these were found by looking at a screenshot of `/app/usage` at 390px rather
 * than by reading the template, which is the only way any of them was going to surface:
 *
 *  - `formatInstant` stripped exactly the literal `.000Z`, so any instant with a non-zero
 *    millisecond rendered as `2026-09-19 12:10:15.869Z UTC` — a string carrying both `Z`
 *    and `UTC`, which is not a format and which no reader can parse with confidence. The
 *    usage page reads its "period start" from `new Date()`, so it hits this every time.
 *  - The allowance summary read "1 runs remaining".
 *  - The row labelled **Period start** does not hold a period start. `customerPort.usage()`
 *    documents this openly: A06 has not exported a period-start resolver, and deriving one
 *    here would be a second spelling of the key that caused A13-010, so the field carries
 *    the instant the figures were read. That is an honest value under a dishonest label,
 *    and on this product a label that overstates its value is the whole disease.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getSignedIn, signedInWorkspace, visibleText, type SignedIn } from './harness.js';

let open: SignedIn | null = null;

afterEach(() => {
  open?.h.close();
  open = null;
});

describe('a figure a customer reads says what it is', () => {
  it('CUST-380 an instant never renders with both a Z and a UTC', async () => {
    open = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    const { html } = await getSignedIn(open, '/app/usage');

    // `Z UTC` is the signature of a fractional second surviving the formatter.
    expect(html).not.toMatch(/Z UTC/);
    expect(html).not.toMatch(/\d\.\d{3}Z/);
  });

  it('CUST-381 one remaining run is "1 run remaining", not "1 runs remaining"', async () => {
    open = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    const text = visibleText((await getSignedIn(open, '/app/usage')).html);

    expect(text).toContain('1 run remaining');
    expect(text).not.toContain('1 runs remaining');
  });

  it('CUST-382 the usage page does not label a read time as the start of a billing period', async () => {
    open = await signedInWorkspace({ consumed: 10, runLimit: 500 });
    const text = visibleText((await getSignedIn(open, '/app/usage')).html);

    // The value is the instant we read the figures. The label must say so, because a
    // customer reading "period start" will date their allowance from it.
    expect(text).not.toContain('Period start');
    expect(text.toLowerCase()).toContain('figures read at');
  });
});
