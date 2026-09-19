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
import type { BrowserContext } from '@playwright/test';

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
  return jar.some((cookie) => cookie.name === seed.sessionCookieName && cookie.value === seed.sessionCookieValue);
}
