/**
 * Signing a browser test in as the scoped automation identity.
 *
 * ## Read the cookie name; never assume it
 *
 * This helper existed once with `__Host-verify_session` hard-coded, and that was wrong in
 * the most expensive way available. `__Host-` is a browser-enforced prefix that **requires
 * `Secure`**, so over `http://127.0.0.1:8788` the cookie is rejected outright — nothing is
 * stored, every request arrives signed out, and the suite fails exactly as it would if the
 * authorisation guard were broken. A false negative that is indistinguishable from the real
 * defect is worse than no test, because it teaches you to distrust a working control.
 *
 * So the name comes from `E2E_AUTOMATION_COOKIE_NAME`, which
 * `scripts/seed-automation-identity.mjs` emits alongside the value. The same rule applies to
 * the CSRF pair: A02 picks `__Host-verify_csrf` or `verify_csrf` from the transport, and
 * picking the wrong one silently breaks every form post rather than failing loudly.
 *
 * ## What this does not do
 *
 * It does not create a session, weaken a guard, or reach a route a person could not. It
 * seeds cookies a real sign-in would have set. If the seed has not been run, every caller
 * skips with a reason rather than proceeding — a browser suite that quietly measures the
 * signed-out version of a page is the failure mode this whole file is written against.
 */
import type { BrowserContext, Page } from '@playwright/test';

export interface AutomationSeed {
  readonly sessionCookieName: string;
  readonly sessionCookieValue: string;
  readonly csrfCookieName: string;
  readonly csrfToken: string;
  readonly baseUrl: string;
}

export const SEED_MISSING =
  'No automation identity is seeded. Run `node scripts/seed-automation-identity.mjs` and export what it ' +
  'prints (E2E_AUTOMATION_SESSION, E2E_AUTOMATION_COOKIE_NAME, E2E_AUTOMATION_CSRF, ' +
  'E2E_AUTOMATION_CSRF_COOKIE_NAME, E2E_BASE_URL) before running the authenticated browser suite.';

/** The seed from the environment, or `null` when it has not been run. */
export function automationSeed(): AutomationSeed | null {
  const sessionCookieValue = process.env['E2E_AUTOMATION_SESSION'];
  if (sessionCookieValue === undefined || sessionCookieValue.length === 0) return null;
  return {
    sessionCookieValue,
    // Read, never assumed. Locally this is `verify_session`; over HTTPS it is the
    // `__Host-`-prefixed name, and hard-coding either one breaks the other transport.
    sessionCookieName: process.env['E2E_AUTOMATION_COOKIE_NAME'] ?? 'verify_session',
    csrfToken: process.env['E2E_AUTOMATION_CSRF'] ?? '',
    csrfCookieName: process.env['E2E_AUTOMATION_CSRF_COOKIE_NAME'] ?? 'verify_csrf',
    baseUrl: process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8788',
  };
}

/**
 * Put the identity's cookies in the context. Returns false when there is nothing to seed,
 * so the caller can skip with a stated reason instead of measuring a signed-out page.
 */
export async function signInAsAutomation(context: BrowserContext): Promise<boolean> {
  const seed = automationSeed();
  if (seed === null) return false;

  const cookies = [
    { name: seed.sessionCookieName, value: seed.sessionCookieValue, url: seed.baseUrl },
  ];
  // The CSRF half matters for anything that posts. A session without it fails every form
  // with a token error, which reads like a CSRF defect rather than a missing fixture.
  if (seed.csrfToken.length > 0) {
    cookies.push({ name: seed.csrfCookieName, value: seed.csrfToken, url: seed.baseUrl });
  }
  await context.addCookies(cookies);
  return true;
}

/**
 * Proof that the seeding actually worked, for a test that is about to measure a page it
 * believes is authenticated.
 *
 * `addCookies` succeeds silently when the browser then discards the cookie — which is
 * precisely what a `__Host-` name over http does. Reading the jar back is the only way to
 * know the identity is really present, and it turns a whole class of silent false negative
 * into one legible failure.
 */
export async function automationCookieIsPresent(context: BrowserContext): Promise<boolean> {
  const seed = automationSeed();
  if (seed === null) return false;
  const jar = await context.cookies(seed.baseUrl);
  return jar.some(
    (cookie) => cookie.name === seed.sessionCookieName && cookie.value === seed.sessionCookieValue,
  );
}

/**
 * The customer surface needs one more thing than the owner surface does.
 *
 * `scripts/seed-automation-identity.mjs` creates a user and a session. It creates **no
 * workspace and no membership**, and `/app` resolves its data from a workspace the session
 * belongs to — so with the identity seeded, `/owner` answers 200 and `/app` answers 401.
 * Verified against the running Worker.
 *
 * That is a missing fixture, not a broken guard, and the difference matters: a suite that
 * fails sixteen times here looks like sixteen defects in the customer pages. It is one
 * missing row.
 *
 * **What A02 needs to add to the seed:** a synthetic workspace (`workspaces.is_synthetic = 1`)
 * and a `memberships` row joining the automation user to it as `workspace_viewer` — the
 * read-only role, so the identity gains a surface to measure without gaining the ability to
 * change a customer's configuration.
 */
export const CUSTOMER_WORKSPACE_MISSING =
  'The automation identity has a session but no workspace membership, so /app answers 401 while /owner answers 200. ' +
  'The seed needs a synthetic workspace and a memberships row for the automation user as workspace_viewer. ' +
  'Until then the authenticated customer layouts cannot be measured — this is one missing fixture, not a page defect.';

/** True when the seeded identity can actually reach the customer surface. */
export async function customerSurfaceReady(page: Page): Promise<boolean> {
  const response = await page.goto('/app');
  return response?.status() === 200;
}

/**
 * The seed now creates the workspace and the membership (2026-09-19), so `/app` answers
 * 200 and the sixteen cases behind `CUSTOMER_WORKSPACE_MISSING` are measurable. Measuring
 * them showed the next fixture gap: the workspace has **no workflow, no connections and no
 * runs**, so `/app` renders "No workflow set up yet", every onboarding step past
 * compatibility redirects, and there is no run detail to open. The cases that need those
 * rows skip with this reason rather than fail — the page is doing the right thing with an
 * empty workspace, and sixteen red lines would say the opposite.
 *
 * **What the seed needs next:** a workflow with a current version (so mapping, outcome,
 * proof and review render), two connection rows, and a handful of decided runs with
 * assertion rows — one per status, so a run detail of each kind can be opened.
 */
export const CUSTOMER_WORKFLOW_MISSING =
  'The seeded workspace has no workflow, so /app renders "No workflow set up yet", the onboarding steps past ' +
  'compatibility redirect, and there is no run to open. The seed needs a workflow with a current version, ' +
  'connections and a few decided runs with assertions. This is a thin fixture, not a page defect.';

/** True when the seeded workspace has a workflow to measure against. */
export async function customerWorkflowReady(page: Page): Promise<boolean> {
  const response = await page.goto('/app');
  if (response?.status() !== 200) return false;
  const heading = (await page.getByRole('heading', { level: 1 }).first().textContent()) ?? '';
  return heading.trim() !== 'No workflow set up yet';
}

/**
 * The path of a run detail in the seeded workspace, discovered from the run list rather
 * than assumed from a synthetic fixture id. `status` narrows to a run wearing that badge.
 * `null` when the list has no such run — the caller skips with a stated reason.
 */
export async function firstRunPath(page: Page, status?: string): Promise<string | null> {
  const response = await page.goto('/app/runs');
  if (response?.status() !== 200) return null;
  const rows = page.locator('tbody tr');
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (status !== undefined && (await row.locator(`[data-status="${status}"]`).count()) === 0)
      continue;
    const href = await row.locator('a[href^="/app/runs/"]').first().getAttribute('href');
    if (href !== null) return href;
  }
  return null;
}
