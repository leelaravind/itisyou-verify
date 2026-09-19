/**
 * `createCheckout` reaches Stripe.
 *
 * ## Why this file exists
 *
 * Until 20 September 2026 `customerPort.createCheckout` was a hardcoded refusal. It never
 * called Stripe under any configuration, and it told the customer:
 *
 *   "Stripe is not configured in this environment, so there is no hosted Checkout to hand
 *    you to."
 *
 * On staging, where `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` were
 * all set, that sentence was simply false. The deployment was configured; the method did
 * not exist. Meanwhile `startCheckout` in `billing/checkout.ts` was complete and well
 * tested -- idempotency, tampering, concurrency -- and its only callers were its own tests.
 * The fourteenth instance of this project's dominant defect class, and the one on the money
 * path: no customer could ever have paid.
 *
 * `tests/integration/billing/checkout.test.ts` covers `startCheckout` thoroughly and could
 * never have caught this, because it calls that function directly. So every case here goes
 * through the port a page actually holds, and asserts against the HTTP the gateway made.
 *
 * Case ids `BILL-297..BILL-299`, `API-621`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import { D1CustomerDataPort } from '@app/db';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from './harness';

const NOW = new Date('2026-09-19T12:00:00.000Z');
// secret-scan:allow synthetic test-mode key; no account behind it, never sent anywhere real
const STRIPE_KEY = `sk_test_${'0'.repeat(24)}`;

interface Captured {
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string | null;
}

/** A fetch that answers as Stripe would, and records what it was asked. */
function stripeStub(captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({
      url,
      body: String(init?.body ?? ''),
      idempotencyKey: new Headers(init?.headers ?? {}).get('idempotency-key'),
    });
    if (url.includes('/checkout/sessions')) {
      return new Response(
        JSON.stringify({
          id: 'cs_test_1',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          livemode: false,
          status: 'open',
          client_reference_id: null,
          customer: 'cus_test_1',
          subscription: null,
          payment_status: 'unpaid',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id: 'cus_test_1', object: 'customer', livemode: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function env(h: TestDb, overrides: Record<string, string | undefined> = {}): never {
  return {
    DB: h.db,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: 'https://verify.test',
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_PRICE_ID: 'price_0000000000test',
    ...overrides,
  } as never;
}

async function signedInPort(
  h: TestDb,
  ws: SeededWorkspace,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<D1CustomerDataPort> {
  const cookieValue = `session-value-for-${ws.workspaceId}`;
  h.raw
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(await hashToken(cookieValue, 'session'), ws.userId, T0, '2026-09-20T10:00:00.000Z', T0);

  return new D1CustomerDataPort({
    db: h.db,
    env: env(h, options.env ?? {}),
    request: {
      headers: new Headers({ cookie: `verify_session=${cookieValue}` }),
      url: 'https://verify.test/app/onboarding/review',
    },
    now: NOW,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
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

let h: TestDb;
let ws: SeededWorkspace;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'alpha');
});
afterEach(() => {
  h.close();
});

describe('createCheckout through the port a page holds', () => {
  it('BILL-297 a configured deployment actually calls Stripe and hands back its hosted URL', async () => {
    connectBoth(h, ws);
    const captured: Captured[] = [];
    const port = await signedInPort(h, ws, { fetchImpl: stripeStub(captured) });

    const result = await port.createCheckout();

    // The assertion that would have caught the stub: an HTTP call was made to Stripe.
    const session = captured.find((c) => c.url.includes('/checkout/sessions'));
    expect(session, 'no Checkout Session was requested from Stripe').toBeDefined();
    expect(result.ok).toBe(true);
    expect(result.redirectTo).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    // An order row is what makes the redirect idempotent rather than a fresh purchase.
    expect(
      (h.raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it('BILL-298 a second attempt presents the same idempotency key, so Stripe returns one session', async () => {
    connectBoth(h, ws);
    const captured: Captured[] = [];
    const port = await signedInPort(h, ws, { fetchImpl: stripeStub(captured) });

    const first = await port.createCheckout();
    const second = await port.createCheckout();

    // Two HTTP calls is correct and is the documented design: `resumeCheckoutUrl` asks
    // Stripe again under the SAME key, and Stripe returns the original session rather than
    // a second one. So the guarantee to assert is the key, not the call count -- asserting
    // "exactly one request" would be asserting a mechanism the code deliberately does not
    // use, and would fail while nothing was wrong.
    const sessions = captured.filter((c) => c.url.includes('/checkout/sessions'));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(new Set(sessions.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(sessions[0]?.idempotencyKey).not.toBeNull();

    // And the customer is sent to the same place both times.
    expect(second.ok).toBe(true);
    expect(second.redirectTo).toBe(first.redirectTo);

    // One order, not two: the order idempotency key is what prevents a second purchase.
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(1);
  });

  it('BILL-299 an unconfigured deployment names the secret it is missing, and calls nothing', async () => {
    connectBoth(h, ws);
    const captured: Captured[] = [];
    const port = await signedInPort(h, ws, {
      fetchImpl: stripeStub(captured),
      env: { STRIPE_PRICE_ID: undefined },
    });

    const result = await port.createCheckout();

    expect(result.ok).toBe(false);
    // The old message blamed configuration on every deployment including configured ones.
    // This one is true, and says WHICH secret, because the reader is the operator.
    expect(result.message).toContain('STRIPE_PRICE_ID');
    expect(result.message).toContain('no card was charged');
    expect(captured, 'nothing may be sent to Stripe when we cannot complete the purchase').toEqual(
      [],
    );
  });

  it('API-621 a workspace that is not ready is refused before any money path is touched', async () => {
    // No connections: `orderSummary` is not ready, so this must not reach Stripe at all.
    const captured: Captured[] = [];
    const port = await signedInPort(h, ws, { fetchImpl: stripeStub(captured) });

    const result = await port.createCheckout();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('no card was charged');
    expect(captured).toEqual([]);
  });
});
