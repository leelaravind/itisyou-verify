/**
 * SEC-43x — adversarial review of the shipped Stripe webhook route.
 *
 * A06's `apps/app/src/routes/webhooks/stripe.ts` gets the hard parts right: raw bytes are
 * read once and verified before any parse, a size cap runs before the read, the mode is
 * checked, the event id is claimed against `UNIQUE (provider, event_id)`, and a bad
 * signature is a 400 that says only "Invalid signature".
 *
 * It also contains one critical mistake, and this file exists to hold it red until it is
 * fixed. See SEC-431.
 *
 * Harness note: these cases drive the REAL Hono route with REAL signatures produced by
 * `@verify/security`. Nothing here reaches the network — `tests/setup.ts` blocks fetch and
 * the billing store is A06's in-memory one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signStripe } from '@verify/security';
import { createStripeWebhookRoute } from '@app/routes/webhooks/stripe';
import {
  OPAQUE_ID,
  WEBHOOK_SECRET,
  createHarness,
  signedDelivery,
  stripeEvent,
  subscriptionObject,
  type BillingHarness,
} from '../../integration/billing/harness';

const ROUTE_SOURCE = join(
  process.cwd(),
  'apps',
  'app',
  'src',
  'routes',
  'webhooks',
  'stripe.ts',
);

/** Only `OPAQUE_ID` is a real endpoint. Everything else is unknown. */
function route(harness: BillingHarness) {
  return createStripeWebhookRoute({
    ...harness,
    resolveEndpointSecret: async (opaqueId) => (opaqueId === OPAQUE_ID ? WEBHOOK_SECRET : null),
  });
}

function anEvent(harness: BillingHarness): Record<string, unknown> {
  return stripeEvent(
    'customer.subscription.updated',
    subscriptionObject({ id: 'sub_attack_1', status: 'active', customerId: 'cus_stub_1' }),
    { livemode: harness.config.environment === 'live' },
  );
}

/**
 * Pull the decoy secret out of the shipped source exactly as an attacker reading the
 * public repository would. If the constant is renamed, this throws and the test fails —
 * which is the correct outcome, because the test must then be re-read by a human.
 */
function publishedDecoySecret(): string {
  const source = readFileSync(ROUTE_SOURCE, 'utf8');
  const m = /const DECOY_SECRET = '([^']+)'/.exec(source);
  if (m === null || m[1] === undefined) {
    throw new Error(
      'SEC-431/432: no `const DECOY_SECRET = \'…\'` literal found in stripe.ts. ' +
        'If the decoy is now generated per deployment, delete these two cases — the ' +
        'finding is fixed. If it was merely renamed, update the pattern.',
    );
  }
  return m[1];
}

describe('Stripe webhook route: the unknown-endpoint path', () => {
  it('SEC-431 FINDING: an unknown endpoint id must be rejected even with a signature that verifies', async () => {
    // THE ATTACK, in full.
    //
    // The route resolves the endpoint secret and falls back to a hardcoded constant when
    // the opaque path id is unknown:
    //
    //     const secret = (await deps.resolveEndpointSecret(opaqueId)) ?? DECOY_SECRET;
    //     const verified = await verify(raw, signature, secret, ...);
    //     if (!verified.valid) return 400;
    //     ... parse, mode check, claim event id, DISPATCH ...
    //
    // The intent is good: run verification anyway so a prober cannot distinguish "no such
    // endpoint" from "wrong secret". The mistake is that nothing afterwards remembers the
    // endpoint was unknown. THIS REPOSITORY IS PUBLIC, so `DECOY_SECRET` is not a secret —
    // anyone can read it, sign a body with it, POST to
    // `/api/v1/webhooks/stripe/<any-id-they-invent>`, and have a fabricated
    // `checkout.session.completed` or `invoice.paid` dispatched to the real handler.
    // That is a free subscription, and on the refund path it is money out.
    //
    // NOT CURRENTLY LIVE: the route is not yet mounted in `apps/app/src/index.ts`. It
    // becomes exploitable the moment it is. Fix before mounting.
    //
    // FIX (A06): keep running the verification so the timing and response shape stay
    // indistinguishable, but fail closed on the lookup result:
    //
    //     const known = await deps.resolveEndpointSecret(opaqueId);
    //     const verified = await verify(raw, signature, known ?? DECOY_SECRET, ...);
    //     if (known === null || !verified.valid) return 400;
    //
    // and generate the decoy from a Worker secret rather than a repository constant.
    const harness = createHarness();
    const decoy = publishedDecoySecret();
    const event = anEvent(harness);
    const { body, headers } = await signedDelivery(event, harness.at(), decoy);

    const response = await route(harness).request(
      '/api/v1/webhooks/stripe/wh_an_id_the_attacker_invented',
      { method: 'POST', headers, body },
    );

    expect(response.status, 'a forged delivery to an unknown endpoint must not be accepted').toBe(
      400,
    );
  });

  it('SEC-432 FINDING: the decoy secret must not be a literal in a public repository', () => {
    // Even once SEC-431 is fixed, a published constant used in a cryptographic comparison
    // is a liability: it invites exactly the mistake above, and it makes the "we cannot be
    // distinguished from a real endpoint" claim false for anyone who reads the source.
    // Derive it from a Worker secret (e.g. HMAC of the opaque id under SESSION_SIGNING_KEY)
    // so it is unguessable and per-deployment.
    const source = readFileSync(ROUTE_SOURCE, 'utf8');
    expect(
      /const DECOY_SECRET\s*=\s*'[^']+'/.test(source),
      'DECOY_SECRET is a hardcoded literal in a public file',
    ).toBe(false);
  });

  it('SEC-433 an unknown endpoint and a wrong secret are indistinguishable to the caller', async () => {
    // The property A06 was aiming for, asserted directly. Whatever SEC-431's fix is, it
    // must not break this: status and body must match exactly.
    const harness = createHarness();
    const event = anEvent(harness);

    const wrongSecret = await signedDelivery(event, harness.at(), 'whsec_definitely_not_the_secret');
    const unknownEndpoint = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);

    const a = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers: wrongSecret.headers,
      body: wrongSecret.body,
    });
    const b = await route(harness).request('/api/v1/webhooks/stripe/wh_not_a_real_endpoint', {
      method: 'POST',
      headers: unknownEndpoint.headers,
      body: unknownEndpoint.body,
    });

    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(await a.text()).toBe(await b.text());
  });
});

describe('Stripe webhook route: signature before parse', () => {
  it('SEC-434 a bad signature is 400 and never 200', async () => {
    const harness = createHarness();
    const event = anEvent(harness);
    const { body } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    for (const header of [
      undefined,
      '',
      'garbage',
      `t=${Math.floor(Date.parse(harness.at()) / 1000)},v1=${'0'.repeat(64)}`,
      `t=${Math.floor(Date.parse(harness.at()) / 1000)},v0=${'a'.repeat(64)}`,
    ]) {
      const response = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(header === undefined ? {} : { 'stripe-signature': header }),
        },
        body,
      });
      expect(response.status, String(header)).toBe(400);
    }
  });

  it('SEC-435 a body that is not JSON never reaches the parser without a valid signature', async () => {
    // If the route parsed first, a malformed body would surface a parser error (a 400 with
    // a different code, or a 500) even when the signature was wrong. It must be rejected
    // as an invalid signature, with the signature error, because verification came first.
    const harness = createHarness();
    const response = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'garbage' },
      body: 'this is not json at all',
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_SIGNATURE');
  });

  it('SEC-436 a re-serialised body fails, proving the raw bytes are what is verified', async () => {
    const harness = createHarness();
    const event = anEvent(harness);
    const { headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const response = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers,
      // Same object, different bytes.
      body: JSON.stringify(event, null, 2),
    });
    expect(response.status).toBe(400);
  });

  it('SEC-437 the failure reason is logged but never returned to the caller', async () => {
    const harness = createHarness();
    const logged: Record<string, string | number | boolean>[] = [];
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async () => WEBHOOK_SECRET,
      log: (entry) => logged.push(entry),
    });
    const event = anEvent(harness);
    const stale = await signedDelivery(event, '2020-01-01T00:00:00.000Z', WEBHOOK_SECRET);
    const response = await app.request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers: stale.headers,
      body: stale.body,
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    // The caller must not learn WHY: stale vs forged vs wrong-secret are all one answer.
    expect(text).not.toMatch(/stale|tolerance|timestamp|expired|secret/i);
    // But the operator must.
    expect(logged.some((e) => String(e['reason']).startsWith('signature_'))).toBe(true);
  });

  it('SEC-438 an oversized body is refused before it is read or parsed', async () => {
    const harness = createHarness();
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async () => WEBHOOK_SECRET,
      maxBodyBytes: 64,
    });
    const event = anEvent(harness);
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const response = await app.request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(body.length) },
      body,
    });
    expect(response.status).toBe(413);
  });

  it('SEC-439 a test-mode event delivered to a live endpoint is refused', async () => {
    // Otherwise anyone with a free Stripe sandbox can author our subscription state.
    const harness = createHarness({ environment: 'live' });
    const event = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({ id: 'sub_test_1', status: 'active', customerId: 'cus_stub_1' }),
      { livemode: false },
    );
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const response = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers,
      body,
    });
    expect(response.status).toBe(400);
  });

  it('SEC-440 a duplicate event id produces no second effect', async () => {
    const harness = createHarness();
    const event = anEvent(harness);
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const first = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers,
      body,
    });
    const second = await route(harness).request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers,
      body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({ duplicate: true });
  });
});

describe('Stripe webhook route: signing key hygiene', () => {
  it('SEC-441 the webhook signing secret is never echoed into a response or a log entry', async () => {
    const harness = createHarness();
    const logged: Record<string, string | number | boolean>[] = [];
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async () => WEBHOOK_SECRET,
      log: (entry) => logged.push(entry),
    });
    const event = anEvent(harness);
    const { body, headers } = await signedDelivery(event, harness.at(), 'whsec_wrong');
    const response = await app.request(`/api/v1/webhooks/stripe/${OPAQUE_ID}`, {
      method: 'POST',
      headers,
      body,
    });
    const text = await response.text();
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(logged)).not.toContain(WEBHOOK_SECRET);
    // Nor the signature the caller sent, which is a valid MAC under some key.
    expect(JSON.stringify(logged)).not.toContain(headers['stripe-signature']);
  });

  it('SEC-442 a signature valid for a DIFFERENT endpoint is not accepted here', async () => {
    // Multiple endpoints will exist (test and live, and during a secret roll). A signature
    // minted for one must not be usable against another.
    const harness = createHarness();
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async (id) =>
        id === 'wh_endpoint_a' ? 'whsec_secret_a_0000' : id === 'wh_endpoint_b' ? 'whsec_secret_b_0000' : null,
    });
    const event = anEvent(harness);
    const timestamp = Math.floor(Date.parse(harness.at()) / 1000);
    const body = JSON.stringify(event);
    const signedForA = await signStripe(body, timestamp, 'whsec_secret_a_0000');
    const response = await app.request('/api/v1/webhooks/stripe/wh_endpoint_b', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signedForA },
      body,
    });
    expect(response.status).toBe(400);
  });
});
