/**
 * CSRF on the customer router — structurally, not route by route.
 *
 * Customer routes had no CSRF defence at all: `session()` minted a fresh token per request
 * and the pages rendered it in a hidden field, but no cookie half was ever set and nothing
 * validated the submitted value against anything. It looked like a defence in the markup,
 * which is worse than having none — a reviewer scanning the form for a hidden token field
 * would see one and move on. Every customer mutation was exposed: connection setup,
 * workflow configuration, checkout, cancellation, sign-in, sign-out.
 *
 * `routes/owner/index.ts` had it right from the start: the double-submit cookie AND a
 * proven same-origin request, applied together and never separately. `routes/app/index.ts`
 * now shares the exact same three functions from `@verify/security`
 * (`csrfCookieName`, `validateCsrfToken`, `isSameOriginRequest`) rather than a second
 * implementation of the same idea — see `withSession`'s docblock there.
 *
 * This file has two jobs. First, the structural one (per-route tests would pass the moment
 * today's routes are fixed and say nothing about the next route added): enumerate every
 * POST this router actually registers, from the router's own route table, and prove each
 * one refuses a request that fails the check. Second, prove the failure modes and the
 * success case with real requests through the real Worker entry point — a real POST with
 * no token, a real POST with a token but no cookie, a real POST with a mismatched pair, and
 * a real legitimate same-origin submission that still works, because a CSRF fix that
 * breaks the real form is a denial of service shipped by the fix itself.
 *
 * Case ids CUST-460..CUST-467.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../../../apps/app/src/routes/app/index.js';
import worker from '../../../apps/app/src/index.js';
import type { TestDb } from '../db/harness.js';
import { BASE, csrfPairFor, postSignedIn, signedInWorkspace, type SignedIn } from './harness.js';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(h: TestDb): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

/** Every POST this router actually registers, read from Hono's own route table — not a
 * hand-maintained list that the next new route could silently miss. Paths come back
 * relative to this sub-app (`/sign-in`); the mount prefix (`/app`) is added here to match
 * where `apps/app/src/index.ts` actually serves it, and where every request below fires. */
function registeredPostPaths(): readonly string[] {
  const routes = createAppRoutes().routes;
  return [...new Set(routes.filter((r) => r.method === 'POST').map((r) => `/app${r.path}`))];
}

/** A GET page that exists for every mutation route below, to source a real CSRF pair from.
 * `/onboarding/activation/signing-key` has no GET twin — it shares the activation page's. */
const GET_SOURCE: Readonly<Record<string, string>> = {
  '/sign-in': '/sign-in',
  '/sign-out': '/', // any authenticated page carries the pair; the workspace root does.
  '/onboarding/connect': '/onboarding/connect',
  '/onboarding/mapping': '/onboarding/mapping',
  '/onboarding/outcome': '/onboarding/outcome',
  '/onboarding/proof': '/onboarding/proof',
  '/onboarding/checkout': '/onboarding/review',
  '/onboarding/activation/signing-key': '/onboarding/activation',
  '/support': '/support',
};

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
});
async function workspace(): Promise<SignedIn> {
  open = await signedInWorkspace();
  return open;
}

describe('CSRF is structural on the customer router, not a per-route patch', () => {
  it('CUST-460 the router registers at least the mutation routes this suite knows about', () => {
    const paths = registeredPostPaths();
    // A floor, not a ceiling: if this list undercounts, the loop below tests fewer routes
    // than exist, which is exactly the blind spot a hand-maintained list would leave.
    for (const known of Object.keys(GET_SOURCE)) {
      expect(paths, `expected ${known} to be registered`).toContain(`/app${known}`);
    }
  });

  it('CUST-461 every registered POST route refuses a request with no CSRF token and no cookie at all', async () => {
    const s = await workspace();
    for (const fullPath of registeredPostPaths()) {
      const response = await worker.fetch(
        new Request(`${BASE}${fullPath}`, {
          method: 'POST',
          headers: {
            cookie: `__Host-verify_session=test-session-value-customer-integration`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: '',
        }),
        envFor(s.h),
        ctx,
      );
      // Reached the route (never a 404, which would mean this path is not actually
      // registered where the assertion below thinks it is), never a success, never a
      // server error: a real refusal, from the real route, every time.
      expect(response.status, fullPath).not.toBe(404);
      expect([200, 303], fullPath).not.toContain(response.status);
      expect(response.status, fullPath).toBeLessThan(500);
    }
  });

  it('CUST-462 a submitted token with no cookie at all is refused', async () => {
    const s = await workspace();
    const path = '/app/onboarding/mapping';
    const pair = await csrfPairFor(s, '/app/onboarding/mapping');
    const response = await worker.fetch(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          cookie: '__Host-verify_session=test-session-value-customer-integration',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf_token: pair.token,
          correlationProperty: 'verify_correlation_id',
        }).toString(),
      }),
      envFor(s.h),
      ctx,
    );
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain('data-csrf-error');
  });

  it('CUST-463 a real cookie with no submitted token at all is refused', async () => {
    const s = await workspace();
    const path = '/app/onboarding/mapping';
    const pair = await csrfPairFor(s, path);
    const response = await worker.fetch(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          cookie: `__Host-verify_session=test-session-value-customer-integration; __Host-verify_csrf=${pair.cookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ correlationProperty: 'verify_correlation_id' }).toString(),
      }),
      envFor(s.h),
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it('CUST-464 a mismatched cookie/token pair is refused', async () => {
    const s = await workspace();
    const served = await postSignedIn(
      s,
      '/app/onboarding/mapping',
      { correlationProperty: 'verify_correlation_id' },
      { csrfTokenOverride: 'a-token-that-does-not-match-the-cookie-at-all' },
    );
    expect(served.status).toBe(403);
    expect(served.html).toContain('data-csrf-error');
  });

  it('CUST-465 a real, same-origin, matched pair still lets the form through', async () => {
    const s = await workspace();
    const served = await postSignedIn(s, '/app/onboarding/mapping', {
      correlationProperty: 'verify_correlation_id',
    });
    // A CSRF fix that breaks the real form is a denial of service shipped by the fix.
    expect(served.status).toBe(303);
  });

  it('CUST-466 a correct pair from a foreign Origin is refused even though the token matches', async () => {
    const s = await workspace();
    const served = await postSignedIn(
      s,
      '/app/onboarding/mapping',
      { correlationProperty: 'verify_correlation_id' },
      { origin: 'https://attacker.example' },
    );
    expect(served.status).toBe(403);
    expect(served.html).toContain('data-csrf-error');
  });

  it('CUST-467 the signed-out sign-in POST needs the same real pair as every other route', async () => {
    const s = await workspace();
    // No forged pair accepted, signed out or not.
    const forged = await postSignedIn(
      s,
      '/app/sign-in',
      { email: 'someone@example.com' },
      { signedIn: false, csrfCookieOverride: null, csrfTokenOverride: 'invented' },
    );
    expect(forged.status).toBe(403);

    // A real pair sourced from the sign-in page itself, still signed out, still works.
    const genuine = await postSignedIn(
      s,
      '/app/sign-in',
      { email: 'someone@example.com' },
      { signedIn: false, csrfSourcePath: '/app/sign-in' },
    );
    expect(genuine.status).not.toBe(403);
  });
});
