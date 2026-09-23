/**
 * CUST-370..CUST-376 — empty, not-yet-settled and permission-denied states, on the screens
 * a customer actually reaches.
 *
 * ## What this is defending
 *
 * A screen with no empty state ships a blank panel to its very first user, and the very
 * first user is the one least able to tell "nothing has happened yet" apart from "this is
 * broken". `/app` is the page a customer lands on immediately after their first sign-in,
 * and at that moment every collection on it is empty by definition.
 *
 * `/app/runs` handles this correctly — it renders an `EmptyState` whose body says, in so
 * many words, that no runs is not a pass. `/app` rendered the same data through a `Table`
 * with no `empty` branch, which draws four column headers over an empty body: a panel that
 * looks like a table that failed to load rather than a workspace that has not started.
 *
 * The not-yet-settled case is the same argument in the product's own vocabulary. A run
 * inside its completion window is `PENDING`, which is a real answer — and a page of nothing
 * but clock badges, with no sentence saying the product is working as designed, invites the
 * customer to conclude it is stuck.
 *
 * The permission cases assert the property rather than the page: a resource that is not
 * yours must answer exactly as one that does not exist, byte for byte, or the 404 is an
 * existence oracle.
 *
 * Every case goes through the Worker entry point, because "is there an empty state" is a
 * question about what is served, not about what a template would return if it were called.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSignedIn,
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

async function session(): Promise<SignedIn> {
  open = await signedInWorkspace();
  return open;
}

/** Every `<table>` served, as raw markup. */
function tables(html: string): readonly string[] {
  return html.match(/<table[\s\S]*?<\/table>/g) ?? [];
}

function hasBodyRows(table: string): boolean {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? '';
  return /<tr[\s>]/.test(body);
}

describe('empty and not-yet-settled states on the customer surface', () => {
  it('CUST-370 GET /app with no runs yet says so instead of drawing an empty table', async () => {
    const s = await session();
    const { status, html } = await getSignedIn(s, '/app');
    expect(status).toBe(200);

    const text = visibleText(html).toLowerCase();
    expect(text).toContain('no runs received yet');
    // And the sentence that matters: an empty workspace is not a passing workspace.
    expect(text).toContain('not a pass');
  });

  it('CUST-371 no table anywhere on /app ships column headers over an empty body', async () => {
    const s = await session();
    const { html } = await getSignedIn(s, '/app');

    for (const table of tables(html)) {
      expect(
        hasBodyRows(table),
        'a table head with nothing under it reads as a panel that failed to load',
      ).toBe(true);
    }
  });

  it('CUST-372 GET /app with every run still inside its window says we are still looking', async () => {
    const s = await session();
    seedRunsFor(s, [
      { id: 'run_pending_a', status: 'PENDING' },
      { id: 'run_pending_b', status: 'PENDING' },
    ]);
    const { status, html } = await getSignedIn(s, '/app');
    expect(status).toBe(200);

    // A polite live region, not an alert: a pending result is not urgent. Matched on the
    // element's class attribute, not the string — the stylesheet is inlined into <head>,
    // so every page "contains" every class name it defines.
    expect(html).toMatch(/class="state state--loading"/);
    const text = visibleText(html).toLowerCase();
    expect(text).toContain('still checking');
    // It must not read as a fault, and it must not read as a pass.
    expect(text).not.toContain('all decided runs verified');
  });

  it('CUST-373 a decided run removes the still-looking panel rather than leaving it up', async () => {
    const s = await session();
    seedRunsFor(s, [
      { id: 'run_done', status: 'VERIFIED' },
      { id: 'run_waiting', status: 'PENDING' },
    ]);
    const { html } = await getSignedIn(s, '/app');

    // One settled result means there is a rate to read, so the waiting panel has done its
    // job. Leaving it up beside a real figure would say two things at once.
    expect(html).not.toMatch(/class="state state--loading"/);
  });

  it('CUST-374 /app/connections never renders an empty panel between its lede and its callout', async () => {
    const s = await session();
    const { status, html } = await getSignedIn(s, '/app/connections');
    expect(status).toBe(200);

    // Whatever the port returns, this screen states the position of each provider. It may
    // never render a card with nothing in it.
    const text = visibleText(html).toLowerCase();
    expect(text).toMatch(/hubspot|no connections/);
  });
});

describe('a refusal never confirms what was refused', () => {
  it('CUST-375 a run id from another workspace answers exactly as an id that never existed', async () => {
    const s = await session();
    // A real run, in a workspace this session is not a member of.
    const other = s.h.raw;
    other
      .prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?, ?, 'active', ?)")
      .run('ws_other', 'Someone else', '2026-09-19T10:00:00.000Z');

    const foreign = await getSignedIn(s, '/app/runs/run_belonging_to_ws_other');
    const nonexistent = await getSignedIn(s, '/app/runs/run_that_never_existed');

    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(nonexistent.status);
    // Byte for byte, once the per-request CSRF token is normalised away. A difference of
    // one word would be an existence oracle.
    const normalise = (markup: string, id: string): string =>
      markup.replace(new RegExp(id, 'g'), 'X').replace(/value="[A-Za-z0-9_-]{20,}"/g, 'value="T"');
    expect(normalise(foreign.html, 'run_belonging_to_ws_other')).toBe(
      normalise(nonexistent.html, 'run_that_never_existed'),
    );
    // And it must not name the other workspace, or say the run exists elsewhere.
    expect(foreign.html).not.toContain('ws_other');
    expect(visibleText(foreign.html).toLowerCase()).not.toContain('another workspace');
  });

  it('CUST-376 a signed-out request gets the same refusal whatever it asked for', async () => {
    const s = await session();
    const paths = ['/app', '/app/usage', '/app/runs', '/app/connections'];
    const served = await Promise.all(
      paths.map(async (path) => {
        const response = await fetchSignedOut(s, path);
        return { path, ...response };
      }),
    );

    for (const one of served) {
      expect(one.status, one.path).toBe(401);
      // The refusal must not echo the path, the resource or the reason it was interesting.
      expect(visibleText(one.html).toLowerCase()).toContain('sign in');
    }
    // Every refusal is the same document, once the per-request CSRF token is normalised
    // away — it is freshly minted on every response so the sign-in form itself has a real
    // double-submit pair, and that is the only thing that may legitimately differ here.
    const normaliseCsrf = (markup: string): string =>
      markup.replace(/value="[A-Za-z0-9_-]{20,}"/g, 'value="T"');
    const bodies = new Set(served.map((one) => normaliseCsrf(one.html)));
    expect(bodies.size).toBe(1);
  });
});

/** The same request with no session cookie at all. */
async function fetchSignedOut(
  s: SignedIn,
  path: string,
): Promise<{ status: number; html: string }> {
  const worker = (await import('../../../apps/app/src/index.js')).default;
  const response = await worker.fetch(
    new Request(`https://verify.itisyou.app${path}`),
    {
      ASSETS: { fetch: async () => new Response('', { status: 404 }) },
      DB: s.h.db,
      ENVIRONMENT: 'test',
      PUBLIC_BASE_URL: 'https://verify.itisyou.app',
      STRIPE_MODE: 'test',
    } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  return { status: response.status, html: await response.text() };
}

/**
 * A test run a customer started must be distinguishable from an enquiry their automation
 * reported, in the list as well as on its own page.
 *
 * Met on production, 22 September: `/app/runs` showed a test run with no mark and offered no
 * filter, so two runs the owner started themselves read as two customer failures at a glance.
 * The run's own page said "You started this one" and the verification rate correctly excluded
 * it — the list was the one surface that said nothing.
 */
describe('runs list: a test run says so, and can be filtered out', () => {
  async function mixed(): Promise<SignedIn> {
    const s = await signedInWorkspace();
    seedRunsFor(s, [
      { id: 'run_real_0001', status: 'VERIFIED' },
      { id: 'run_test_0001', status: 'FAILED', source: 'owner_test' },
    ]);
    return s;
  }

  it('CUST-965 the list marks a run the customer started and leaves the others unmarked', async () => {
    open = await mixed();
    const { status, html } = await getSignedIn(open, '/app/runs');
    expect(status).toBe(200);

    // Both runs are listed, and exactly one of them carries the mark.
    expect(html).toContain('run_real_0001');
    expect(html).toContain('run_test_0001');
    // Count the rendered mark, not the stylesheet rule that defines it.
    expect(html.match(/class="chip chip--test"/g) ?? []).toHaveLength(1);
    // The mark sits with the test run, not the real one.
    const testRow = html.slice(html.indexOf('run_test_0001'));
    expect(testRow.slice(0, 400)).toContain('chip--test');
  });

  it('CUST-966 filtering to the automation excludes the test run, and the reverse', async () => {
    open = await mixed();

    const real = await getSignedIn(open, '/app/runs?show=real');
    expect(real.status).toBe(200);
    expect(real.html).toContain('run_real_0001');
    expect(real.html).not.toContain('run_test_0001');

    const tests = await getSignedIn(open, '/app/runs?show=test');
    expect(tests.status).toBe(200);
    expect(tests.html).toContain('run_test_0001');
    expect(tests.html).not.toContain('run_real_0001');
  });

  it('CUST-967 an unknown filter value shows everything rather than guessing', async () => {
    open = await mixed();
    const { html } = await getSignedIn(open, '/app/runs?show=banana');
    expect(html).toContain('run_real_0001');
    expect(html).toContain('run_test_0001');
  });
});

/**
 * The runs list shows the enquiry reference the customer typed, and does not repeat the
 * verdict sentence beside the verdict badge.
 *
 * Both were met on production on 22 September. The column headed "Enquiry" carried the run's
 * verdict sentence rather than anything about the enquiry, which was redundant next to the
 * Result badge in the same row and, once the absence verdict gained its fuller wording, tall
 * enough to push a single row past ten lines. The column headed "Reference" carried
 * `correlation_key_hash` — 64 hex characters — where the run's own page shows the readable
 * value the customer had entered.
 */
describe('runs list: the reference is readable and the verdict is not repeated', () => {
  it('CUST-968 the list shows the enquiry reference, not the hash we index on', async () => {
    open = await signedInWorkspace();
    seedRunsFor(open, [{ id: 'run_ref_0001', status: 'VERIFIED' }]);
    const { html } = await getSignedIn(open, '/app/runs');

    // `seedRun` writes 'corr' as the hash and no `correlation_id` in the payload, so the
    // fallback is what should appear — the point is that the hash is a FALLBACK.
    expect(html).toContain('Enquiry reference');
    // The verdict sentence is not repeated in the row beside the badge.
    expect(html).not.toContain('Every required check has independent supporting evidence');
    expect(html).not.toContain('is contradicted by the evidence we retrieved');
  });
});

/**
 * The workspace panel counts what it shows, on mixed automation and test data.
 *
 * The owner's screenshot read "5 of 3 runs shown": the rows included the customer's own
 * test verifications while the total counted only their automation, so the panel
 * contradicted itself in four characters. Rows, tally, total and the selected scope now all
 * come from one place.
 */
describe('the workspace recent-results panel agrees with itself', () => {
  async function mixedWorkspace(): Promise<SignedIn> {
    const s = await signedInWorkspace();
    seedRunsFor(s, [
      { id: 'run_auto_0001', status: 'VERIFIED' },
      { id: 'run_auto_0002', status: 'FAILED' },
      { id: 'run_test_0001', status: 'VERIFIED', source: 'owner_test' },
      { id: 'run_test_0002', status: 'VERIFIED', source: 'owner_test' },
      { id: 'run_test_0003', status: 'UNVERIFIED', source: 'owner_test' },
    ]);
    return s;
  }

  /** The count of rendered run rows in the recent-results table. */
  function rowCount(html: string): number {
    return (html.match(/data-label="Enquiry reference"/g) ?? []).length;
  }

  it('CUST-970 the automation scope shows only automation rows and totals them', async () => {
    open = await mixedWorkspace();
    const { html } = await getSignedIn(open, '/app');
    const text = visibleText(html);

    expect(rowCount(html), 'automation rows').toBe(2);
    expect(text).toContain('2 of 2 shown');
    expect(text).toContain('from your automation');
    // The thing that could never happen again: more shown than exist.
    expect(text).not.toMatch(/([0-9]+) of (?!\1)([0-9]+) shown · from your automation/);
  });

  it('CUST-971 the tests scope shows only test rows and totals them', async () => {
    open = await mixedWorkspace();
    const { html } = await getSignedIn(open, '/app?scope=tests');
    const text = visibleText(html);

    expect(rowCount(html), 'test rows').toBe(3);
    expect(text).toContain('3 of 3 shown');
    expect(text).toContain('your tests');
  });

  it('CUST-972 the all scope totals both, which is what billing counted', async () => {
    open = await mixedWorkspace();
    const { html } = await getSignedIn(open, '/app?scope=all');
    expect(rowCount(html)).toBe(5);
    expect(visibleText(html)).toContain('5 of 5 shown');
  });

  it('CUST-973 a test run is badged in the workspace recent results, not only in the runs list', async () => {
    open = await mixedWorkspace();
    const { html } = await getSignedIn(open, '/app?scope=all');
    // Three test runs, three marks, and the automation rows carry none.
    expect((html.match(/class="chip chip--test"/g) ?? []).length).toBe(3);
  });
})
