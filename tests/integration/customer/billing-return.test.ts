/**
 * Stripe has somewhere to send a customer back to.
 *
 * ## Why this file exists
 *
 * `checkoutReturnUrls` has always told Stripe to return the browser to
 * `/app/billing/return?session_id=…` after a successful payment, and to `/app/billing`
 * after a cancelled one. `portalReturnUrl` points at the second as well. None of those
 * routes existed.
 *
 * On 20 September 2026 the first real sandbox payment completed on a deployment and Stripe
 * returned the customer to a **404**. The dominant defect class arriving at the worst
 * moment available: immediately after somebody paid.
 *
 * Every existing case drove `POST /app/onboarding/checkout` and asserted on its redirect,
 * so the journey ended at Stripe's front door and nothing followed the customer home. These
 * cases start where Stripe puts them.
 *
 * Case ids `BILL-625..BILL-629`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import { checkoutReturnUrls, buildBillingConfig } from '@app/billing/config';
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

let h: TestDb;
let ws: SeededWorkspace;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'ret');
});
afterEach(() => {
  h.close();
});

async function signedInGet(path: string): Promise<Response> {
  const value = `session-value-for-${ws.workspaceId}`;
  h.raw
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(await hashToken(value, 'session'), ws.userId, T0, '2099-01-01T00:00:00.000Z', T0);
  return (await worker.fetch(
    new Request(`${BASE}${path}`, { headers: { cookie: `verify_session=${value}` } }),
    envFor(h),
    ctx,
  )) as Response;
}

describe('the URLs we give Stripe resolve to pages', () => {
  it('BILL-625 every return URL in the checkout config is a route that exists', async () => {
    // The assertion that would have caught the whole defect, taken from the configuration
    // itself rather than from a path typed again by hand — a test that re-types the path
    // cannot notice when the config points somewhere else.
    const config = buildBillingConfig({
      environment: 'test',
      priceId: 'price_0000000000test',
      publicBaseUrl: BASE,
    });
    const urls = checkoutReturnUrls(config);

    for (const raw of [urls.successUrl, urls.cancelUrl]) {
      const path = raw.replace(BASE, '').replace('{CHECKOUT_SESSION_ID}', 'cs_test_123');
      const response = await signedInGet(path);
      expect(response.status, `${path} is not a route`).not.toBe(404);
    }
  });

  it('BILL-626 the post-payment page does not claim a subscription it has not been told about', async () => {
    // Reached the instant Stripe redirects, which is before the webhook has necessarily
    // arrived. Claiming activation from a redirect is claiming an outcome from the fact
    // that a request was made — the exact thing this product exists to refuse.
    const body = await (await signedInGet('/app/billing/return?session_id=cs_test_123')).text();

    expect(body).toContain('Stripe has taken your payment');
    expect(body).not.toContain('Your subscription is active');
    expect(body).toContain('no subscription is recorded for this workspace yet');
  });

  it('BILL-627 the payment reference is shown and no card detail is', async () => {
    const body = await (await signedInGet('/app/billing/return?session_id=cs_test_ABC123')).text();

    expect(body).toContain('cs_test_ABC123');
    expect(body).toContain('never a card');
  });

  it('BILL-628 a cancelled checkout says plainly that no card was charged', async () => {
    const body = await (await signedInGet('/app/billing?checkout=cancelled')).text();

    expect(body).toContain('no card was charged');
    expect(body).toContain('nothing about this workspace has changed');
  });

  it('BILL-629 the billing page without the cancelled flag does not mention cancelling a checkout', async () => {
    // The paired case: a banner that always showed would make the real one meaningless.
    const body = await (await signedInGet('/app/billing')).text();

    expect(body).not.toContain('Checkout was cancelled');
  });
});
