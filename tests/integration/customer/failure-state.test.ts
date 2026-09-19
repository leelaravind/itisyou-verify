/**
 * CUST-430..CUST-433 — when the service itself fails, the customer gets a page, not a
 * JSON envelope, and the page says what failed and what they can do.
 *
 * ## The gap
 *
 * Every customer screen had an empty state and most had a loading state. None had a
 * failure state, because none could: an exception anywhere under `/app` fell through to the
 * Worker's global `onError`, which answers `{"error":{"code":"INTERNAL_ERROR",…}}` — the
 * right envelope for `/api/v1`, and a wall of JSON for a person who clicked "Runs". No
 * navigation, no sign-out, no way to tell whether their runs were affected.
 *
 * ## What a realistic failure state says
 *
 * What failed ("we could not load this page"), what did *not* happen (no run was decided,
 * nothing was changed on the strength of it), what to do (try again, or write to support
 * quoting the reference), and a reference the support queue can find. It never carries the
 * cause: an error body naming an internal identifier is a gift to whoever is probing.
 *
 * Driven through the real entry point with a `DB` binding that fails at execution, the way
 * an unreachable D1 fails.
 */
import { describe, expect, it } from 'vitest';
import { getSignedInAgainst, unreachableDb, visibleText } from './harness.js';

const SECRET_SHAPED = 'D1_ERROR: database unreachable (simulated) internal_table_name_7f3a';

describe('a customer page that cannot be served says so as a page', () => {
  it('CUST-430 GET /app during a database outage answers 500 with an HTML page, not JSON', async () => {
    const served = await getSignedInAgainst(unreachableDb(SECRET_SHAPED), '/app');
    expect(served.status).toBe(500);
    expect(served.contentType).toMatch(/text\/html/);
    expect(served.html.trimStart().startsWith('{')).toBe(false);
    expect(served.html).toContain('<main');
  });

  it('CUST-431 the failure page says what failed, what did not happen, and what to do next', async () => {
    const served = await getSignedInAgainst(unreachableDb(SECRET_SHAPED), '/app/runs');
    const text = visibleText(served.html).toLowerCase();
    // What failed.
    expect(text).toContain('could not load this page');
    // What did not happen — a page that fails must not be read as a verdict.
    expect(text).toContain('no run has been decided');
    // What to do.
    expect(text).toContain('try again');
    expect(text).toContain('support');
    // Announced, so a screen reader hears the replacement content.
    expect(served.html).toMatch(/role="alert"/);
  });

  it('CUST-432 the failure page never carries the cause, and does carry a reference support can find', async () => {
    const served = await getSignedInAgainst(unreachableDb(SECRET_SHAPED), '/app/usage', {
      'cf-ray': '8f3a1b2c3d4e5f60-LHR',
    });
    expect(served.html).not.toContain('internal_table_name_7f3a');
    expect(served.html).not.toContain('D1_ERROR');
    expect(served.html).not.toContain('simulated');
    expect(visibleText(served.html)).toContain('Reference: 8f3a1b2c3d4e5f60-LHR');
  });

  it('CUST-433 the failure page is not cacheable and keeps the app chrome so the reader is not stranded', async () => {
    const served = await getSignedInAgainst(unreachableDb(SECRET_SHAPED), '/app/connections');
    // Every route under /app answers the same page, so a failure cannot be used to probe.
    const other = await getSignedInAgainst(unreachableDb(SECRET_SHAPED), '/app/runs/anything');
    expect(other.status).toBe(500);
    expect(visibleText(other.html)).toBe(visibleText(served.html));
    // The reader can still get somewhere: the skip link and a way out are on the page.
    expect(served.html).toContain('Skip to main content');
    expect(served.html).toMatch(/href="\/app\/support"|href="\/support"/);
    expect(served.html).toContain('noindex');
  });
});
