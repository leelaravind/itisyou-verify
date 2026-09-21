/**
 * A customer can actually get into their own setup.
 *
 * ## Why this file exists
 *
 * The seven onboarding steps were built, routed and tested, and the product could not be
 * entered through any of them. `/app` and `/app/onboarding/compatibility` both rendered
 * `UnavailableAction` unconditionally, so the only way through the journey was to know the
 * form routes and post to them by hand. Every existing case drove those routes directly,
 * which is precisely why none of them noticed: a test that constructs the request itself
 * cannot tell you whether a browser could ever have constructed it. That is the same
 * defect, and the same blind spot, that `checkout-control.test.ts` was written for one
 * step further down the journey.
 *
 * Worse than absent, the reason given was untrue of the reader. It said we are not taking
 * payment or activating new workspaces yet, to somebody already signed in to a workspace
 * that exists, and then added "nothing here is broken on your side".
 *
 * So these cases fetch the two pages a signed-in customer is actually sent to and look for
 * a real anchor to the next step. The second half matters as much: a `workspace_viewer`
 * must not be offered a step the server would refuse, so the same fetch under a viewer
 * membership asserts the control is gone and the reason names the role. The condition
 * rendered is `session.role === 'workspace_admin'`, which is the single condition
 * `customerPort.submitConnectionCredentials` and `saveFieldMapping` refuse on, so the page
 * cannot offer a step the server would then decline.
 *
 * Case ids `CUST-133`, `CUST-143`, `CUST-144`, `CUST-145`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import worker from '../../../apps/app/src/index.js';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from '../db/harness';

const BASE = 'https://verify.test';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(h: TestDb): never {
  return {
    DB: h.db,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

async function signedInCookie(h: TestDb, ws: SeededWorkspace): Promise<string> {
  const value = `session-value-for-${ws.workspaceId}`;
  h.raw
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(await hashToken(value, 'session'), ws.userId, T0, '2099-01-01T00:00:00.000Z', T0);
  return `verify_session=${value}`;
}

/** Demote the seeded admin, so the only difference between the two cases is the role. */
function demoteToViewer(h: TestDb, ws: SeededWorkspace): void {
  h.raw
    .prepare("UPDATE memberships SET role = 'workspace_viewer' WHERE workspace_id = ? AND user_id = ?")
    .run(ws.workspaceId, ws.userId);
}

/**
 * Remove the seeded workflow, which is what puts `/app` into the state this is about: a
 * real workspace with nothing configured in it yet, which is where every new customer
 * starts and the only state that renders the entry control at all.
 */
function removeWorkflow(h: TestDb, ws: SeededWorkspace): void {
  h.raw.prepare('DELETE FROM workflow_versions WHERE workspace_id = ?').run(ws.workspaceId);
  h.raw.prepare('DELETE FROM workflows WHERE workspace_id = ?').run(ws.workspaceId);
}

async function fetchPage(h: TestDb, ws: SeededWorkspace, path: string): Promise<string> {
  const response = (await worker.fetch(
    new Request(`${BASE}${path}`, { headers: { cookie: await signedInCookie(h, ws) } }),
    envFor(h),
    ctx,
  )) as Response;
  expect(response.status, `${path} must render for a signed-in customer`).toBe(200);
  return await response.text();
}

/**
 * A real anchor a browser would follow, aimed at `href`.
 *
 * Deliberately not "the string appears in the page": the taken-down control renders its
 * label as a `<p role="note">`, and a substring match would have passed against exactly
 * the markup this file exists to reject.
 */
function linksTo(markup: string, href: string): boolean {
  return new RegExp(`<a[^>]*href="${href.replace(/\//g, '\\/')}"`).test(markup);
}

describe('the setup can be entered from the pages that lead to it', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'setupentry');
  });

  it('CUST-133 a workspace admin with nothing configured is given a live way into step 1', async () => {
    removeWorkflow(h, ws);
    const markup = await fetchPage(h, ws, '/app');
    expect(markup).toContain('No workflow set up yet');
    expect(
      linksTo(markup, '/app/onboarding/compatibility'),
      'the workspace page must offer a real link into the first onboarding step',
    ).toBe(true);
    expect(markup).not.toContain('data-unavailable="Start the setup"');
  });

  it('CUST-143 a workspace viewer is not offered a setup the server would refuse them', async () => {
    removeWorkflow(h, ws);
    demoteToViewer(h, ws);
    const markup = await fetchPage(h, ws, '/app');
    expect(linksTo(markup, '/app/onboarding/compatibility')).toBe(false);
    expect(markup).toContain('data-unavailable="Start the setup"');
    // The reason has to be about them, not about the deployment: the old copy told a
    // signed-in customer that no workspace existed here. Scoped to the control's own
    // block, because the reason travels with the control -- the page may legitimately
    // carry the activation notice elsewhere, and a whole-page match would not tell the
    // two apart.
    const control = markup.slice(
      markup.indexOf('data-unavailable="Start the setup"'),
      markup.indexOf('data-unavailable="Start the setup"') + 900,
    );
    expect(control).toContain('Your role in this workspace is viewer');
    expect(control).not.toContain('not taking payment or activating new workspaces');
  });

  it('CUST-144 step 1 leads to step 2 for a workspace admin', async () => {
    const markup = await fetchPage(h, ws, '/app/onboarding/compatibility');
    expect(
      linksTo(markup, '/app/onboarding/connect'),
      'the compatibility step must offer a real link to the connect step',
    ).toBe(true);
    expect(markup).not.toContain('data-unavailable="These all apply, continue"');
  });

  it('CUST-145 step 1 does not lead past itself for a workspace viewer, and says why', async () => {
    demoteToViewer(h, ws);
    const markup = await fetchPage(h, ws, '/app/onboarding/compatibility');
    expect(linksTo(markup, '/app/onboarding/connect')).toBe(false);
    expect(markup).toContain('data-unavailable="These all apply, continue"');
    expect(markup).toContain('Your role in this workspace is viewer');
  });
});
