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

  /*
   * The hole an independent review found on 21 September 2026, hours after two other
   * pages were changed to render their setup controls on `role === 'workspace_admin'`
   * with a comment claiming that was "the same rule the server uses".
   *
   * It was the rule for `saveFieldMapping`, `saveExpectedOutcome` and
   * `submitConnectionCredentials`. It was not the rule for `createCheckout`, which
   * refuses only on `orderSummary().ready`, and `orderSummary` had never consulted a
   * role at all. So on a workspace that was otherwise ready to buy, a `workspace_viewer`
   * was shown a live "Continue to secure checkout" submit button, and pressing it created
   * a real Stripe Checkout Session for a workspace they may only read.
   *
   * Fixed as a blocker inside `orderSummary` rather than as a second guard inside
   * `createCheckout`, so the page and the route read one answer.
   *
   * ## Why AUTH-515 is built the way it is
   *
   * Its first version posted an empty body with no CSRF token and asserted the response
   * was not a 303. That passes whether or not any role check exists, because
   * `withSession` refuses on CSRF before the handler runs: it was proving the CSRF guard
   * and claiming to prove authorisation. The owner rejected it, correctly.
   *
   * So the request below is the one a viewer's browser would actually send: a real
   * session cookie, the double-submit CSRF cookie read back from a real response, the
   * same value echoed in the form field, and an `Origin` header. It reaches the handler,
   * and the assertion is on the specific role sentence coming back out of it.
   *
   * AUTH-516 is the control that makes the other two mean something: the same fixture,
   * the same request, one column of one row different, reaching Stripe. Without it,
   * "Stripe was never called" is equally consistent with a fixture that could never have
   * bought anything.
   */

  /** A `Set-Cookie` line's value for a name, from a real response. Never invented. */
  function cookieValueFrom(response: Response, name: string): string {
    const lines =
      typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
    for (const line of lines) {
      const match = new RegExp(`${name}=([^;]+)`).exec(line);
      if (match?.[1] !== undefined && match[1] !== '') return match[1];
    }
    throw new Error(`no ${name} cookie was set on that response`);
  }

  /**
   * The double-submit pair, obtained the way a browser obtains it.
   *
   * `withSession` calls `setCsrfCookie(c, session.csrfToken)` on every authenticated
   * response including GETs, so any `/app` page hands the browser the value. The form
   * field carries the same value, which is what makes it a double submit, so echoing the
   * cookie is exactly what the rendered page does. Nothing here is fabricated: a
   * fabricated token would prove only that the check can be fooled by the test.
   */
  async function csrfPairFor(h: TestDb, ws: SeededWorkspace): Promise<string> {
    const response = (await worker.fetch(
      new Request(`${BASE}/app/onboarding/review`, {
        headers: { cookie: await signedInCookie(h, ws) },
      }),
      envFor(h),
      ctx,
    )) as Response;
    expect(response.status, 'the review page must render before a token can be read').toBe(200);
    return cookieValueFrom(response, 'verify_csrf');
  }

  /** A fetch that answers as Stripe would and counts what it was asked. */
  function stripeCounting(calls: { n: number }): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('stripe.com')) calls.n += 1;
      if (url.includes('/checkout/sessions')) {
        return new Response(
          JSON.stringify({
            id: 'cs_test_auth',
            object: 'checkout.session',
            url: 'https://checkout.stripe.com/c/pay/cs_test_auth',
            livemode: false,
            status: 'open',
            client_reference_id: null,
            customer: 'cus_test_auth',
            subscription: null,
            payment_status: 'unpaid',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ id: 'cus_test_auth', object: 'customer', livemode: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  }

  /** POST the checkout route as a browser would, with a real CSRF pair. */
  async function postCheckout(
    h: TestDb,
    ws: SeededWorkspace,
    calls: { n: number },
  ): Promise<{ readonly status: number; readonly location: string | null; readonly body: string }> {
    const token = await csrfPairFor(h, ws);
    const sessionCookie = await signedInCookie(h, ws);
    const realFetch = globalThis.fetch;
    globalThis.fetch = stripeCounting(calls);
    try {
      const response = (await worker.fetch(
        new Request(`${BASE}/app/onboarding/checkout`, {
          method: 'POST',
          headers: {
            cookie: `${sessionCookie}; __Host-verify_csrf=${token}`,
            'content-type': 'application/x-www-form-urlencoded',
            origin: BASE,
          },
          body: new URLSearchParams({ csrf_token: token }).toString(),
        }),
        envFor(h),
        ctx,
      )) as Response;
      const location = response.headers.get('location');
      const body = response.status >= 300 && response.status < 400 ? '' : await response.text();
      return { status: response.status, location, body };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  function orderCount(h: TestDb, ws: SeededWorkspace): number {
    return (
      h.raw.prepare('SELECT COUNT(*) AS n FROM orders WHERE workspace_id = ?').get(ws.workspaceId) as {
        n: number;
      }
    ).n;
  }

  function demoteToViewer(h: TestDb, ws: SeededWorkspace): void {
    h.raw
      .prepare("UPDATE memberships SET role = 'workspace_viewer' WHERE workspace_id = ?")
      .run(ws.workspaceId);
  }

  it('AUTH-514 a workspace viewer is shown no checkout control on a workspace that is otherwise ready', async () => {
    connectBoth(h, ws);
    expect(checkoutForm(await reviewPage(h, ws)), 'the fixture is not a ready order').not.toBeNull();

    demoteToViewer(h, ws);

    const body = await reviewPage(h, ws);
    expect(checkoutForm(body), 'a viewer is offered a form that reaches checkout').toBeNull();
    expect(body).toContain('Only a workspace admin can subscribe');
  });

  it('AUTH-515 a viewer posting the checkout route with a valid session and CSRF pair is refused on role, calls Stripe zero times and creates no order', async () => {
    connectBoth(h, ws);
    demoteToViewer(h, ws);
    const calls = { n: 0 };

    const result = await postCheckout(h, ws, calls);

    // It reached the handler rather than being turned away at the CSRF gate: the refusal
    // is the route's own 503 re-render of the review step, not a 403.
    expect(result.status, 'the request did not reach checkout authorisation').toBe(503);
    expect(result.location, 'a viewer was redirected to a payment page').toBeNull();
    // The specific refusal, not merely "something went wrong".
    expect(result.body).toContain('Only a workspace admin can subscribe');
    expect(result.body).toContain('No checkout session was created and no card was charged');
    expect(calls.n, 'Stripe was called for a viewer').toBe(0);
    expect(orderCount(h, ws), 'an order row was created for a viewer').toBe(0);
  });

  it('AUTH-516 the same fixture and the same request DO reach Stripe for a workspace admin, so the refusal above is about the role', async () => {
    connectBoth(h, ws);
    const calls = { n: 0 };

    const result = await postCheckout(h, ws, calls);

    expect(result.status, 'an admin was not sent onward to checkout').toBe(303);
    expect(result.location ?? '', 'the redirect does not go to Stripe').toContain(
      'checkout.stripe.com',
    );
    expect(calls.n, 'the admin path never reached Stripe').toBeGreaterThan(0);
    expect(orderCount(h, ws), 'no order was recorded for the admin').toBe(1);
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

/**
 * Say which problem it is, and tolerate the one that is our fault.
 *
 * "STRIPE_PRICE_ID is set but is not a Stripe price id" sent the owner to the Stripe
 * dashboard three times looking for a value they may already have set correctly. The three
 * likely causes want three different actions, and one of them — a trailing newline from
 * `node -e "..." | wrangler secret put` — is not a wrong value at all. A validator that
 * rejects it while the consumer would have accepted it is a defect in the validator.
 *
 * So the value is trimmed where it is READ, not only where it is checked. Trimming in one
 * place and not the other is worse than neither: the check passes and Stripe receives a
 * value with a newline in it.
 *
 * Case ids `BILL-621..BILL-624`.
 */
describe('a misconfigured price id says which misconfiguration it is', () => {
  it('BILL-621 a price id with a trailing newline is accepted, not rejected', async () => {
    connectBoth(h, ws);

    // Exactly what a piped `wrangler secret put` stores.
    const body = await reviewPage(h, ws, { STRIPE_PRICE_ID: 'price_0000000000test\n' });

    expect(
      checkoutForm(body),
      'a stray newline blocked an otherwise valid price id',
    ).not.toBeNull();
  });

  it('BILL-622 a product id is named as a product id', async () => {
    connectBoth(h, ws);

    const body = await reviewPage(h, ws, { STRIPE_PRICE_ID: 'prod_ABC123' });

    expect(checkoutForm(body)).toBeNull();
    expect(body).toContain('product id');
  });

  it('BILL-623 anything else is reported as not beginning with the prefix', async () => {
    connectBoth(h, ws);

    const body = await reviewPage(h, ws, { STRIPE_PRICE_ID: 'not-an-id-at-all' });

    expect(checkoutForm(body)).toBeNull();
    expect(body).toContain('does not begin with');
  });

  it('BILL-624 a secret key with surrounding whitespace is accepted too', async () => {
    connectBoth(h, ws);

    // The same pipe, the same newline, the other half of the pair.
    const padded = `  ${['sk', 'test', '0'.repeat(24)].join('_')}\n`;
    const body = await reviewPage(h, ws, { STRIPE_SECRET_KEY: padded });

    expect(checkoutForm(body), 'a stray newline blocked an otherwise valid key').not.toBeNull();
  });
});
