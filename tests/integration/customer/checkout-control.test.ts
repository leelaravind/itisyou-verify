/**
 * A customer can actually click something that leads to a charge.
 *
 * ## Why this file exists
 *
 * `createCheckout` was wired to `startCheckout` on 20 September 2026 and
 * `tests/integration/db/createCheckout.test.ts` proved it calls Stripe. I then reported
 * "checkout is wired", and it was true of the port and false of the product: the review
 * page rendered `UnavailableAction` unconditionally. No form, no submit control, nothing
 * on any page in the application that a person could click to reach the route. The
 * independent auditor found it standing two passes after I first said otherwise.
 *
 * Every existing case called the port or the POST route directly, which is exactly why
 * none of them noticed. A test that constructs the request itself cannot tell you whether
 * a browser could ever have constructed it. So these cases fetch the page a customer is
 * sent to and look for a submittable control inside a form aimed at the checkout path --
 * the assertion whose absence let the gap survive.
 *
 * The second half matters as much: the control must be absent when the purchase would be
 * refused. `orderSummary().ready` is the single condition `createCheckout` enforces, so it
 * is the condition the page renders on, and CONN-478 holds those two together by removing
 * a connection and asserting the button leaves with it.
 *
 * Case ids `CUST-478..CUST-481`, `CONN-478`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import worker from '../../../apps/app/src/index.js';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from '../db/harness';

const BASE = 'https://verify.test';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
// secret-scan:allow synthetic test-mode key; no account behind it, never sent anywhere real
const STRIPE_KEY = `sk_test_${'0'.repeat(24)}`;

function envFor(h: TestDb, overrides: Record<string, string | undefined> = {}): never {
  return {
    DB: h.db,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_PRICE_ID: 'price_0000000000test',
    ...overrides,
  } as never;
}

/** Both providers ready, which is what `orderSummary` requires before it will sell. */
function connectBoth(h: TestDb, ws: SeededWorkspace): void {
  for (const provider of ['hubspot', 'resend']) {
    h.raw
      .prepare(
        `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at, last_check_at)
         VALUES (?, ?, ?, 'ready', '[]', ?, ?)`,
      )
      .run(`conn_${provider}`, ws.workspaceId, provider, T0, T0);
  }
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

async function reviewPage(
  h: TestDb,
  ws: SeededWorkspace,
  overrides: Record<string, string | undefined> = {},
): Promise<string> {
  const response = (await worker.fetch(
    new Request(`${BASE}/app/onboarding/review`, {
      headers: { cookie: await signedInCookie(h, ws) },
    }),
    envFor(h, overrides),
    ctx,
  )) as Response;
  expect(response.status, 'the review page must render for a signed-in customer').toBe(200);
  return await response.text();
}

/**
 * A form that posts to the checkout path and contains a submit control.
 *
 * Deliberately not a substring search for the path: the path appears in prose on that page
 * too, and a URL printed in a paragraph is not something anyone can click. This looks for
 * the form element and then inside it, which is the shape a browser needs.
 */
function checkoutForm(body: string): string | null {
  for (const match of body.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    if (/action="\/app\/onboarding\/checkout"/.test(match[0])) return match[1] ?? '';
  }
  return null;
}

let h: TestDb;
let ws: SeededWorkspace;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'alpha');
});
afterEach(() => {
  h.close();
});

describe('the review page offers a control that reaches checkout', () => {
  it('CUST-478 a ready order renders a form aimed at the checkout route', async () => {
    connectBoth(h, ws);

    const form = checkoutForm(await reviewPage(h, ws));

    // The assertion that was missing for two passes.
    expect(form, 'no <form> on the review page posts to /app/onboarding/checkout').not.toBeNull();
  });

  it('CUST-479 that form carries a submit control and a CSRF field', async () => {
    connectBoth(h, ws);

    const form = checkoutForm(await reviewPage(h, ws)) ?? '';

    // A form with no submit control is as unreachable as no form, and `withSession`
    // refuses a POST without the token, so a form lacking the field is a guaranteed 403.
    expect(form, 'the checkout form has no submit control').toMatch(/type="submit"/);
    expect(form, 'the checkout form carries no CSRF token').toMatch(/name="csrf_token"/);
  });

  it('CONN-478 the control leaves when a connection does, because the server would refuse', async () => {
    connectBoth(h, ws);
    expect(checkoutForm(await reviewPage(h, ws))).not.toBeNull();

    // Exactly the condition `createCheckout` refuses on. If these two ever disagree the
    // page offers a purchase the server declines, or hides one it would have allowed.
    h.raw.prepare("DELETE FROM connections WHERE provider = 'hubspot'").run();

    const body = await reviewPage(h, ws);
    expect(checkoutForm(body), 'checkout was offered while HubSpot was disconnected').toBeNull();
    // And it says which thing is missing, rather than a generic refusal.
    expect(body).toContain('Connect HubSpot');
  });

  it('CUST-480 an unconfigured deployment offers nothing and names its own misconfiguration', async () => {
    connectBoth(h, ws);

    const body = await reviewPage(h, ws, { STRIPE_SECRET_KEY: '' });

    expect(checkoutForm(body), 'checkout was offered with no Stripe key').toBeNull();
    expect(body).toContain('STRIPE_SECRET_KEY');
  });

  it('CUST-481 a sandbox deployment says so before the customer is handed to Stripe', async () => {
    connectBoth(h, ws);

    const body = await reviewPage(h, ws);

    // The page must not let someone believe they have bought a service that is owed to
    // them. Stripe's own test banner appears only after the redirect, which is too late.
    expect(body).toContain('sandbox');
    expect(body).toContain('No card is charged');
  });
});

/**
 * The condition the page renders on must mean "this deployment can actually charge".
 *
 * Added after the button was pressed on staging and answered 500. `orderSummary` checked
 * that `STRIPE_SECRET_KEY` was non-empty, staging held a malformed value, and so the review
 * page offered a checkout in front of a call that threw
 * `Stripe secret key does not look like a test or live key` — a customer meeting the
 * failure only after deciding to buy. Every unit test supplies a well-formed fixture, which
 * is exactly why none of them could see it.
 *
 * Case ids `BILL-615..BILL-616`.
 */
describe('a deployment that cannot charge does not offer to', () => {
  it('BILL-615 a malformed Stripe key blocks checkout instead of 500ing after the click', async () => {
    connectBoth(h, ws);

    // Non-empty, and not a key. The exact shape staging was holding.
    const body = await reviewPage(h, ws, { STRIPE_SECRET_KEY: 'not-a-stripe-key' });

    expect(checkoutForm(body), 'checkout was offered with an unusable Stripe key').toBeNull();
    expect(body).toContain('is not a usable Stripe key');
  });

  it('BILL-616 a well-formed key still offers checkout, so the guard is not simply off', async () => {
    connectBoth(h, ws);

    // The paired case: a guard that blocks everything would pass BILL-615 and be useless.
    expect(checkoutForm(await reviewPage(h, ws))).not.toBeNull();
  });
});
