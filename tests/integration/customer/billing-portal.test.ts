/**
 * Opening the billing portal, and the defect that made it fail for the owner.
 *
 * ## The defect
 *
 * `GET /app/billing` rendered the control by calling `billingPortalLink()`, which created a
 * real Stripe billing-portal session and handed its URL to `Button({ href })`. A Stripe
 * portal session is single-use and short-lived, so:
 *
 *   - the link a customer clicked had been minted when the page was DRAWN, not when they
 *     clicked it. On any page left open for a while it was already spent. That is the
 *     "expired session" the owner met from a fresh, authenticated session;
 *   - every render burned a session, including a refresh, a back-button and a prefetch;
 *   - a bearer-secret URL sat in the markup of an authenticated page.
 *
 * The first two cases below are the ones that would have caught it: BILL-670 asserts the
 * GET calls Stripe ZERO times, and BILL-672 asserts two clicks produce two DIFFERENT
 * sessions. Neither could pass against the old code.
 *
 * ## Why these drive the real route
 *
 * Every existing billing case called the port directly. The defect was not in the port: it
 * was in WHEN the route called it. So these go through `worker.fetch` with a real session
 * cookie and a real double-submit CSRF pair read back off a real response, which is also
 * the only way to prove the POST reaches authorisation rather than being turned away by
 * the CSRF gate before it.
 *
 * Case ids `BILL-670..BILL-674`, `AUTH-517`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import worker from '../../../apps/app/src/index.js';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from '../db/harness';

const BASE = 'https://verify.test';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
// secret-scan:allow synthetic test-mode key; no account behind it, never sent anywhere real
const STRIPE_KEY = `sk_test_${'0'.repeat(24)}`;

function envFor(h: TestDb): never {
  return {
    DB: h.db,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_PRICE_ID: 'price_0000000000test',
  } as never;
}

/** A workspace that really could open a portal: a Stripe customer binding and a subscription. */
function seedBilling(h: TestDb, ws: SeededWorkspace): void {
  h.raw
    .prepare(
      `INSERT INTO billing_customers (workspace_id, stripe_customer_id, environment, created_at)
       VALUES (?, ?, 'test', ?)`,
    )
    .run(ws.workspaceId, 'cus_test_portal', T0);
  h.raw
    .prepare(
      `INSERT INTO subscriptions
         (id, workspace_id, provider_subscription_id, environment, status, current_period_end, updated_at)
       VALUES (?, ?, ?, 'test', 'active', ?, ?)`,
    )
    .run('sub_portal', ws.workspaceId, 'sub_provider_portal', '2099-01-01T00:00:00.000Z', T0);
}

async function signedInCookie(h: TestDb, ws: SeededWorkspace): Promise<string> {
  const value = `portal-session-${ws.workspaceId}`;
  h.raw
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(await hashToken(value, 'session'), ws.userId, T0, '2099-01-01T00:00:00.000Z', T0);
  return `verify_session=${value}`;
}

interface StripeCall {
  readonly url: string;
  readonly body: string;
}

/**
 * A Stripe that answers as Stripe does and records what it was asked.
 *
 * Each portal session gets a DIFFERENT id, because the whole point of BILL-672 is that a
 * second click is a second session. A stub returning one fixed URL would have let the
 * defect pass.
 */
function stripeStub(calls: StripeCall[]): typeof fetch {
  let minted = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.includes('/billing_portal/sessions')) {
      minted += 1;
      return new Response(
        JSON.stringify({
          id: `bps_test_${minted}`,
          object: 'billing_portal.session',
          url: `https://billing.stripe.com/p/session/live_${minted}_secret`,
          livemode: false,
          return_url: `${BASE}/app/billing`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id: 'cus_test_portal', object: 'customer', livemode: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Read a cookie value a real response actually set. Never fabricated. */
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

let h: TestDb;
let ws: SeededWorkspace;
let calls: StripeCall[];
let realFetch: typeof fetch;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'portal');
  seedBilling(h, ws);
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stripeStub(calls);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  h.close();
});

async function getBilling(): Promise<{ status: number; body: string; csrf: string }> {
  const response = (await worker.fetch(
    new Request(`${BASE}/app/billing`, { headers: { cookie: await signedInCookie(h, ws) } }),
    envFor(h),
    ctx,
  )) as Response;
  const body = await response.text();
  return { status: response.status, body, csrf: cookieValueFrom(response, 'verify_csrf') };
}

async function clickOpenPortal(
  csrf: string,
): Promise<{ status: number; location: string | null; body: string }> {
  const response = (await worker.fetch(
    new Request(`${BASE}/app/billing/portal`, {
      method: 'POST',
      headers: {
        cookie: `${await signedInCookie(h, ws)}; __Host-verify_csrf=${csrf}`,
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE,
      },
      body: new URLSearchParams({ csrf_token: csrf }).toString(),
    }),
    envFor(h),
    ctx,
  )) as Response;
  const location = response.headers.get('location');
  const body = response.status >= 300 && response.status < 400 ? '' : await response.text();
  return { status: response.status, location, body };
}

const portalCalls = (): StripeCall[] => calls.filter((c) => c.url.includes('/billing_portal/sessions'));

describe('the billing portal opens a fresh session on each click', () => {
  it('BILL-670 rendering the billing page creates no Stripe portal session at all', async () => {
    const page = await getBilling();
    expect(page.status).toBe(200);
    // The defect, stated as an assertion. The old page called Stripe here, every time.
    expect(portalCalls().length, 'the GET render minted a Stripe portal session').toBe(0);
    // And the control is a form, not an anchor carrying a bearer secret.
    expect(page.body).toContain('action="/app/billing/portal"');
    expect(page.body, 'a portal URL is embedded in the page').not.toContain('billing.stripe.com');
    expect(page.body).toMatch(/<form[^>]*action="\/app\/billing\/portal"[\s\S]*?type="submit"/);
  });

  it('BILL-671 a click mints one session and redirects the browser to it', async () => {
    const page = await getBilling();
    const clicked = await clickOpenPortal(page.csrf);

    expect(clicked.status, 'the click did not redirect to the portal').toBe(303);
    expect(clicked.location ?? '').toContain('https://billing.stripe.com/p/session/');
    expect(portalCalls().length, 'a click must mint exactly one session').toBe(1);
    // Return routing: Stripe is told where to send the customer back to.
    expect(portalCalls()[0]?.body ?? '').toContain(encodeURIComponent(`${BASE}/app/billing`));
  });

  it('BILL-672 a second click mints a SECOND, different session, so a spent one is never reused', async () => {
    /*
     * This is the case the defect could not have passed. The old control was one URL
     * baked into the page: clicking it twice replayed one single-use session, which is
     * exactly what Stripe rejects as expired.
     */
    const first = await clickOpenPortal((await getBilling()).csrf);
    const second = await clickOpenPortal((await getBilling()).csrf);

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(portalCalls().length, 'two clicks did not mint two sessions').toBe(2);
    expect(
      second.location,
      'the second click reused the first session instead of minting one',
    ).not.toBe(first.location);
  });

  it('BILL-673 the bearer-secret portal URL is never rendered, logged or stored', async () => {
    const clicked = await clickOpenPortal((await getBilling()).csrf);
    const secret = clicked.location ?? '';
    expect(secret).toContain('secret');

    // Not in any page the customer can load afterwards.
    for (const path of ['/app/billing', '/app/cancel', '/app']) {
      const response = (await worker.fetch(
        new Request(`${BASE}${path}`, { headers: { cookie: await signedInCookie(h, ws) } }),
        envFor(h),
        ctx,
      )) as Response;
      const body = await response.text();
      expect(body, `${path} carries the portal URL`).not.toContain('billing.stripe.com');
    }

    // And not written into any table. Checked across every column of every table rather
    // than the ones we happen to remember, because "we would not store that" is the
    // assumption this case exists to stop being an assumption.
    const tables = h.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = h.raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          expect(value, `${name}.${column} holds the portal URL`).not.toContain(
            'billing.stripe.com',
          );
        }
      }
    }
  });

  it('BILL-674 a workspace with no subscription is told so, and no Stripe call is made either way', async () => {
    h.raw.prepare('DELETE FROM subscriptions WHERE workspace_id = ?').run(ws.workspaceId);

    const page = await getBilling();
    expect(page.body).toContain('There is nothing to manage yet');
    expect(page.body).not.toContain('action="/app/billing/portal"');

    const clicked = await clickOpenPortal(page.csrf);
    expect(clicked.status, 'a workspace with no subscription was redirected to Stripe').toBe(503);
    expect(clicked.body).toContain('There is no subscription to manage yet');
    expect(portalCalls().length, 'Stripe was called for a workspace with no subscription').toBe(0);
  });

  it('AUTH-517 a workspace viewer cannot open the portal, and the route refuses them too', async () => {
    h.raw
      .prepare("UPDATE memberships SET role = 'workspace_viewer' WHERE workspace_id = ?")
      .run(ws.workspaceId);

    const page = await getBilling();
    expect(page.body, 'a viewer is offered the portal form').not.toContain(
      'action="/app/billing/portal"',
    );
    expect(page.body).toContain('Only a workspace admin can manage billing');

    // The page hiding a control is not an authorisation. The route must refuse as well.
    const clicked = await clickOpenPortal(page.csrf);
    expect(clicked.status, 'a viewer was redirected to the billing portal').toBe(503);
    expect(clicked.body).toContain('Only a workspace admin can manage billing');
    expect(portalCalls().length, 'Stripe was called for a viewer').toBe(0);
  });
});
