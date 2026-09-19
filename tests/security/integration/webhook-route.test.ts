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

const ROUTE_SOURCE = join(process.cwd(), 'apps', 'app', 'src', 'routes', 'webhooks', 'stripe.ts');

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
    subscriptionObject({ id: 'sub_attack_1', status: 'active', customer: 'cus_stub_1' }),
    { livemode: harness.config.environment === 'live' },
  );
}

describe('Stripe webhook route: the unknown-endpoint path', () => {
  it('SEC-431 an unknown endpoint id is rejected even when the fallback key is known', async () => {
    // HISTORY. As first shipped, the route fell back to a hardcoded `DECOY_SECRET` when
    // the opaque path id was unknown, and then acted on the result if the signature
    // verified. The intent was right — run verification anyway so a prober cannot
    // distinguish "no such endpoint" from "wrong secret" — but nothing afterwards
    // remembered that the endpoint was unknown. Since THIS REPOSITORY IS PUBLIC, the
    // fallback constant was not a secret: anyone could read it, sign a body with it, POST
    // to `/api/v1/webhooks/stripe/<any-id-they-invent>`, and have a fabricated
    // `checkout.session.completed` or `invoice.paid` dispatched to the real handler. A
    // free subscription, and on the refund path money out. Reproduced at the time as
    // "expected 400, received 200"; fixed by A06 in the same session.
    //
    // THE PERMANENT PROPERTY, which is what this case now asserts: the opaque id is a
    // gate in its own right. An unknown id must be refused on the LOOKUP RESULT, never on
    // the signature comparison — so the fallback key is injected here and the body is
    // signed with it. Even an attacker who learns that key by any means gets a 400.
    const harness = createHarness();
    const fallback = ['whsec', 'the', 'attacker', 'knows', 'this', 'fallback', 'key'].join('_');
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async (id) => (id === OPAQUE_ID ? WEBHOOK_SECRET : null),
      unknownEndpointKey: fallback,
    });
    const event = anEvent(harness);
    const { body, headers } = await signedDelivery(event, harness.at(), fallback);

    const response = await app.request('/api/v1/webhooks/stripe/wh_an_id_the_attacker_invented', {
      method: 'POST',
      headers,
      body,
    });

    expect(response.status, 'a forged delivery to an unknown endpoint must not be accepted').toBe(
      400,
    );
  });

  it('SEC-432 no secret-shaped literal is hardcoded in the webhook route', () => {
    // A cryptographic constant published in a public file invites exactly the mistake
    // above, and makes the "indistinguishable from a real endpoint" claim false for
    // anyone who reads the source. The fallback must be derived per deployment.
    const source = readFileSync(ROUTE_SOURCE, 'utf8');
    const literals = [...source.matchAll(/['"`](whsec_[A-Za-z0-9_-]{8,})['"`]/g)].map((m) => m[1]);
    expect(literals, 'a whsec_-shaped literal is hardcoded in stripe.ts').toEqual([]);
  });

  it('SEC-433 an unknown endpoint and a wrong secret are indistinguishable to the caller', async () => {
    // The property A06 was aiming for, asserted directly. Whatever SEC-431's fix is, it
    // must not break this: status and body must match exactly.
    const harness = createHarness();
    const event = anEvent(harness);

    const wrongSecret = await signedDelivery(
      event,
      harness.at(),
      ['whsec', 'definitely', 'not', 'the', 'secret'].join('_'),
    );
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
      subscriptionObject({ id: 'sub_test_1', status: 'active', customer: 'cus_stub_1' }),
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
        id === 'wh_endpoint_a'
          ? 'whsec_secret_a_0000'
          : id === 'wh_endpoint_b'
            ? 'whsec_secret_b_0000'
            : null,
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
