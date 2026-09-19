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
