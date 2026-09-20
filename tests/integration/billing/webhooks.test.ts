/**
 * The Stripe webhook route, end to end over a real Hono request.
 *
 * Signatures are genuine: `signStripe` from `@verify/security` signs the exact bytes the
 * route reads back. No network call happens anywhere in this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signStripe } from '@verify/security';
import { createStripeWebhookRoute } from '@app/routes/webhooks/stripe';
import { reconcileSubscriptions } from '@app/billing/reconcile';
import type { BillingDataPort } from '@app/billing/port';
import {
  OPAQUE_ID,
  WEBHOOK_SECRET,
  chargeRefundedObject,
  createHarness,
  invoiceObject,
  signedDelivery,
  stripeEvent,
  subscriptionObject,
  type BillingHarness,
} from './harness';

const WS = 'ws_customer_1';
const PATH = `/api/v1/webhooks/stripe/${OPAQUE_ID}`;

/** Assembled at runtime — see the note on `WEBHOOK_SECRET` in `harness.ts`. */
const WRONG_SECRET = 'whsec' + '_' + 'W'.repeat(32);

function route(harness: BillingHarness, overrides: { data?: BillingDataPort } = {}) {
  return createStripeWebhookRoute({
    ...harness,
    ...(overrides.data === undefined ? {} : { data: overrides.data }),
    resolveEndpointSecret: async (opaqueId) => (opaqueId === OPAQUE_ID ? WEBHOOK_SECRET : null),
  });
}

async function deliver(
  harness: BillingHarness,
  event: Record<string, unknown>,
  options: { path?: string; secret?: string; data?: BillingDataPort } = {},
): Promise<Response> {
  const { body, headers } = await signedDelivery(
    event,
    harness.at(),
    options.secret ?? WEBHOOK_SECRET,
  );
  return route(harness, options.data === undefined ? {} : { data: options.data }).request(
    options.path ?? PATH,
    { method: 'POST', headers, body },
  );
}

/** A workspace already bound to the stub Stripe customer, with an open checkout order. */
async function seedWorkspace(harness: BillingHarness): Promise<void> {
  await harness.data.rememberBillingCustomer({
    workspaceId: WS,
    stripeCustomerId: 'cus_stub_1',
    environment: harness.config.environment,
    createdAt: harness.at(),
  });
  await harness.data.openOrderOnce({
    id: 'ord_0001',
    workspaceId: WS,
    status: 'checkout_created',
    rejectionReason: null,
    priceId: harness.config.priceId,
    amountMinor: 2900,
    currency: 'GBP',
    checkoutSessionId: 'cs_stub_1',
    paymentIntentId: null,
    idempotencyKey: 'checkout:v1:ws_customer_1',
    createdAt: harness.at(),
    updatedAt: harness.at(),
  });
}

describe('transport and signature', () => {
  it('BILL-104 a bad signature is a 400, never a 200, and records nothing', async () => {
    const harness = createHarness();
    const event = stripeEvent('customer.subscription.created', subscriptionObject());
    const body = JSON.stringify(event);
    const response = await route(harness).request(PATH, {
      method: 'POST',
      headers: { 'stripe-signature': 't=1800000000,v1=deadbeef' },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' },
    });
    expect(harness.data.debug.receipts()).toHaveLength(0);
  });

  it('BILL-105 a missing signature header is a 400', async () => {
    const harness = createHarness();
    const response = await route(harness).request(PATH, {
      method: 'POST',
      body: JSON.stringify(stripeEvent('invoice.paid', invoiceObject())),
    });
    expect(response.status).toBe(400);
  });

  it('BILL-106 an unknown opaque id is indistinguishable from a bad signature', async () => {
    const harness = createHarness();
    const event = stripeEvent('customer.subscription.created', subscriptionObject());
    const valid = await signedDelivery(event, harness.at());

    const unknownEndpoint = await route(harness).request(
      '/api/v1/webhooks/stripe/wh_0000000000000000',
      { method: 'POST', headers: valid.headers, body: valid.body },
    );
    const wrongSecret = await route(harness).request(PATH, {
      method: 'POST',
      headers: (await signedDelivery(event, harness.at(), WRONG_SECRET)).headers,
      body: valid.body,
    });

    expect(unknownEndpoint.status).toBe(wrongSecret.status);
    expect(await unknownEndpoint.json()).toEqual(await wrongSecret.json());
    expect(unknownEndpoint.status).toBe(400);
  });

  it('BILL-207 a forged event signed with the route’s own stand-in key is rejected', async () => {
    // A10's SEC-431, as a case in my own suite so the property stays covered whatever
    // happens to their file.
    //
    // The route runs verification against a stand-in key when the opaque id is unknown, so
    // that a prober cannot time the difference. This repository is public, so that key is
    // readable by anyone. The attack is: read it, sign a fabricated `invoice.paid` with
    // it, POST to an endpoint id you invented. If the route rejected only on the signature
    // comparison, that would verify and dispatch — a free subscription, and money out on
    // the refund path.
    //
    // It must be rejected on the *lookup result* instead, which is what makes the opaque
    // id a gate rather than decoration.
    const harness = createHarness();
    await seedWorkspace(harness);
    const standInKey = 'whsec' + '_' + 'A'.repeat(32);
    const forged = stripeEvent('invoice.paid', invoiceObject({ subscriptionId: 'sub_live_1' }));
    const { body, headers } = await signedDelivery(forged, harness.at(), standInKey);

    const response = await route(harness).request(
      '/api/v1/webhooks/stripe/wh_an_id_the_attacker_invented',
      { method: 'POST', headers, body },
    );

    expect(response.status).toBe(400);
    // Nothing was dispatched: no allowance granted, no receipt claimed.
    expect(harness.data.debug.allowances()).toHaveLength(0);
    expect(harness.data.debug.receipts()).toHaveLength(0);
  });

  it('BILL-208 an unknown endpoint id is rejected even when the signature is genuinely valid', async () => {
    // The same failure mode reached the other way: a signature minted with a *real*
    // endpoint secret, replayed against an id we never issued.
    const harness = createHarness();
    await seedWorkspace(harness);
    const event = stripeEvent('invoice.paid', invoiceObject({ subscriptionId: 'sub_live_1' }));
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);

    const response = await route(harness).request('/api/v1/webhooks/stripe/wh_not_issued_by_us', {
      method: 'POST',
      headers,
      body,
    });
    expect(response.status).toBe(400);
    expect(harness.data.debug.receipts()).toHaveLength(0);
  });

  it('BILL-209 a signature minted for one endpoint is not accepted at another', async () => {
    const harness = createHarness();
    const secretA = 'whsec' + '_' + 'A'.repeat(32);
    const secretB = 'whsec' + '_' + 'B'.repeat(32);
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async (id) =>
        id === 'wh_endpoint_a' ? secretA : id === 'wh_endpoint_b' ? secretB : null,
    });
    const event = stripeEvent('invoice.paid', invoiceObject({ subscriptionId: 'sub_live_1' }));
    const signedForA = await signedDelivery(event, harness.at(), secretA);

    const response = await app.request('/api/v1/webhooks/stripe/wh_endpoint_b', {
      method: 'POST',
      headers: signedForA.headers,
      body: signedForA.body,
    });
    expect(response.status).toBe(400);
  });

  it('BILL-210 the stand-in key is assembled at runtime, never committed as a literal', () => {
    // `docs/agent-brief.md`: a credential-shaped literal is rejected by our scanner and by
    // GitHub push protection. The shipped route must contain no such string.
    const source = readFileSync(
      join(process.cwd(), 'apps', 'app', 'src', 'routes', 'webhooks', 'stripe.ts'),
      'utf8',
    );
    expect(/const\s+\w*(?:DECOY|SECRET|KEY)\w*\s*=\s*'whsec_[^']+'/.test(source)).toBe(false);
    expect(/'whsec_[A-Za-z0-9_]{8,}'/.test(source)).toBe(false);
  });

  it('BILL-107 a declared body over the cap is refused before it is read', async () => {
    const harness = createHarness();
    const response = await route(harness).request(PATH, {
      method: 'POST',
      headers: { 'content-length': String(1024 * 1024), 'stripe-signature': 't=1,v1=x' },
      body: '{}',
    });
    expect(response.status).toBe(413);
    expect(harness.data.debug.receipts()).toHaveLength(0);
  });

  it('BILL-108 a body over the cap is refused even when it lies about its length', async () => {
    const harness = createHarness();
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async () => WEBHOOK_SECRET,
      maxBodyBytes: 64,
    });
    const event = stripeEvent('customer.subscription.created', subscriptionObject());
    const { body, headers } = await signedDelivery(event, harness.at());
    const response = await app.request(PATH, { method: 'POST', headers, body });
    expect(response.status).toBe(413);
  });

  it('BILL-109 a correctly signed body that is not JSON is a 400', async () => {
    const harness = createHarness();
    const body = 'not json at all';
    const header = await signStripe(
      body,
      Math.floor(Date.parse(harness.at()) / 1000),
      WEBHOOK_SECRET,
    );
    const response = await route(harness).request(PATH, {
      method: 'POST',
      headers: { 'stripe-signature': header },
      body,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PAYLOAD',
    );
  });

  it('BILL-110 an envelope missing the fields we act on is a 400', async () => {
    const harness = createHarness();
    const response = await deliver(harness, { id: 'evt_1', type: 'invoice.paid' });
    expect(response.status).toBe(400);
  });

  it('BILL-111 the signature is checked against the raw bytes, so re-serialising breaks it', async () => {
    const harness = createHarness();
    const event = stripeEvent('invoice.paid', invoiceObject());
    const original = JSON.stringify(event);
    const header = await signStripe(
      original,
      Math.floor(Date.parse(harness.at()) / 1000),
      WEBHOOK_SECRET,
    );
    // Same object, different bytes: a pretty-printed re-serialisation.
    const reserialised = JSON.stringify(JSON.parse(original), null, 2);
    expect(reserialised).not.toBe(original);
    const response = await route(harness).request(PATH, {
      method: 'POST',
      headers: { 'stripe-signature': header },
      body: reserialised,
    });
    expect(response.status).toBe(400);
  });

  it('BILL-112 a test-mode event delivered to a live configuration is rejected', async () => {
    const harness = createHarness({ environment: 'live' });
    await seedWorkspace(harness);
    const event = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ livemode: false }),
      { livemode: false },
    );
    const response = await deliver(harness, event);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'MODE_MISMATCH',
    );
    expect(harness.data.debug.subscriptions()).toHaveLength(0);
    expect(harness.data.debug.receipts()).toHaveLength(0);
  });
});

describe('checkout.session.completed', () => {
  const session = {
    id: 'cs_stub_1',
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    customer: 'cus_stub_1',
    subscription: 'sub_live_1',
    client_reference_id: WS,
    currency: 'gbp',
    amount_total: 2900,
    livemode: false,
    metadata: { workspace_id: WS, order_id: 'ord_0001' },
  };

  it('BILL-113 a completed checkout links the subscription and moves the order to active', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
      items: { data: [{ current_period_end: 1_800_500_000, price: { id: 'price_planv1stub' } }] },
    });

    const response = await deliver(harness, stripeEvent('checkout.session.completed', session));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false });

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('active');
    expect(stored?.providerSubscriptionId).toBe('sub_live_1');
    const order = await harness.data.findOrder(WS, 'ord_0001');
    expect(order?.status).toBe('active');
  });

  it('BILL-114 a redelivered checkout.session.completed is a 200 with no second effect', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
      items: { data: [{ current_period_end: 1_800_500_000, price: { id: 'price_planv1stub' } }] },
    });
    const event = stripeEvent('checkout.session.completed', session, { id: 'evt_dupe_1' });

    const first = await deliver(harness, event);
    const retrievesAfterFirst = harness.gateway.calls.filter(
      (call) => call.method === 'retrieveSubscription',
    ).length;
    const second = await deliver(harness, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    // The second delivery did no work at all.
    expect(
      harness.gateway.calls.filter((call) => call.method === 'retrieveSubscription').length,
    ).toBe(retrievesAfterFirst);
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
    expect(harness.data.debug.allowances()).toHaveLength(1);
  });

  it('BILL-115 a completed checkout that is not yet paid leaves the order pending, not active', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    const response = await deliver(
      harness,
      stripeEvent('checkout.session.completed', {
        ...session,
        payment_status: 'unpaid',
        subscription: null,
      }),
    );
    expect(response.status).toBe(200);
    const order = await harness.data.findOrder(WS, 'ord_0001');
    expect(order?.status).toBe('payment_pending');
    expect(harness.data.debug.subscriptions()).toHaveLength(0);
  });

  it('BILL-116 a checkout in payment mode is recorded and ignored', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    const response = await deliver(
      harness,
      stripeEvent('checkout.session.completed', { ...session, mode: 'payment' }),
    );
    expect(response.status).toBe(200);
    const receipt = harness.data.debug.receipts()[0];
    expect(receipt?.status).toBe('ignored');
  });
});

describe('subscription lifecycle', () => {
  it('BILL-117 a created subscription grants the plan allowance for the period', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    const response = await deliver(
      harness,
      stripeEvent(
        'customer.subscription.created',
        subscriptionObject({ workspaceId: WS, currentPeriodEnd: 1_800_500_000 }),
        { created: 1_798_000_000 },
      ),
    );
    expect(response.status).toBe(200);
    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(1);
    expect(allowances[0]).toMatchObject({
      workspaceId: WS,
      runLimit: 500,
      consumed: 0,
      reserved: 0,
    });
  });

  it('BILL-118 a stale customer.subscription.updated cannot re-enable a deleted subscription', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);

    await deliver(
      harness,
      stripeEvent('customer.subscription.created', subscriptionObject({ workspaceId: WS }), {
        created: 1_798_000_000,
      }),
    );
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.deleted',
        subscriptionObject({ workspaceId: WS, status: 'canceled' }),
        { created: 1_798_009_000 },
      ),
    );
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('canceled');

    // The out-of-order straggler: an `updated` carrying `active`, generated earlier.
    const straggler = await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'active' }),
        { created: 1_798_005_000 },
      ),
    );
    expect(straggler.status).toBe(200);

    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('canceled');
  });

  it('BILL-119 even a later-stamped update cannot resurrect a cancelled subscription', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.deleted',
        subscriptionObject({ workspaceId: WS, status: 'canceled' }),
        { created: 1_798_000_000 },
      ),
    );
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'active' }),
        { created: 1_799_999_999 },
      ),
    );
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('canceled');
  });

  it('BILL-120 a deletion that arrives before its own update still wins', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    // Delivery order: deleted first, then the update that Stripe generated before it.
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.deleted',
        subscriptionObject({ workspaceId: WS, status: 'canceled' }),
        { created: 1_798_100_000 },
      ),
    );
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'past_due' }),
        { created: 1_798_090_000 },
      ),
    );
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('canceled');
    expect(stored?.providerEventCreated).toBe(1_798_100_000);
  });

  it('BILL-121 an out-of-order older status update never overwrites newer state', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'past_due' }),
        { created: 1_798_200_000 },
      ),
    );
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'active' }),
        { created: 1_798_100_000 },
      ),
    );
    const stored = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(stored?.status).toBe('past_due');
  });

  it('BILL-122 payment failure pauses new runs and recovery restores them', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    await deliver(
      harness,
      stripeEvent('customer.subscription.created', subscriptionObject({ workspaceId: WS }), {
        created: 1_798_000_000,
      }),
    );

    await deliver(
      harness,
      stripeEvent('invoice.payment_failed', invoiceObject({ subscriptionId: 'sub_live_1' }), {
        created: 1_798_100_000,
      }),
    );
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'past_due' }),
        { created: 1_798_100_001 },
      ),
    );
    const paused = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(paused?.status).toBe('past_due');

    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'active' }),
        { created: 1_798_200_000 },
      ),
    );
    const recovered = await harness.data.findSubscriptionForWorkspace(WS, 'test');
    expect(recovered?.status).toBe('active');
  });

  it('BILL-123 a subscription for a customer we do not know is recorded and ignored', async () => {
    const harness = createHarness();
    const response = await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ customer: 'cus_someone_else' }),
      ),
    );
    expect(response.status).toBe(200);
    expect(harness.data.debug.receipts()[0]?.status).toBe('ignored');
    expect(harness.data.debug.subscriptions()).toHaveLength(0);
  });

  it('BILL-124 a status outside the frozen vocabulary is ignored rather than stored', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    const response = await deliver(
      harness,
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ workspaceId: WS, status: 'super_active' }),
      ),
    );
    expect(response.status).toBe(200);
    expect(harness.data.debug.subscriptions()).toHaveLength(0);
  });
});

describe('invoices', () => {
  it('BILL-125 a paid renewal opens the next allowance period with fresh counters', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    await deliver(
      harness,
      stripeEvent(
        'customer.subscription.created',
        subscriptionObject({ workspaceId: WS, currentPeriodEnd: 1_800_500_000 }),
        { created: 1_798_000_000 },
      ),
    );
    // Consume some of the first period so a rollover is visible.
    const first = harness.data.debug.allowances()[0];
    expect(first).toBeDefined();
    await harness.data.reserveRun(WS, first!.billingPeriod, harness.at());
    await harness.data.settleReservedRun(WS, first!.billingPeriod, harness.at());

    await deliver(
      harness,
      stripeEvent(
        'invoice.paid',
        invoiceObject({ subscriptionId: 'sub_live_1', periodStart: 1_800_500_000 }),
        { created: 1_800_500_100 },
      ),
    );

    const allowances = harness.data.debug.allowances();
    expect(allowances).toHaveLength(2);
    const next = allowances.find((row) => row.billingPeriod !== first!.billingPeriod);
    expect(next).toMatchObject({ runLimit: 500, consumed: 0, reserved: 0 });
    const previous = allowances.find((row) => row.billingPeriod === first!.billingPeriod);
    expect(previous).toMatchObject({ consumed: 1 });
  });

  it('BILL-126 a redelivered invoice.paid cannot hand out a second allowance', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    const event = stripeEvent(
      'invoice.paid',
      invoiceObject({ subscriptionId: 'sub_live_1', periodStart: 1_800_500_000 }),
      { id: 'evt_invoice_dupe' },
    );
    await deliver(harness, event);
    const afterFirst = harness.data.debug.allowances();
    await harness.data.reserveRun(WS, afterFirst[0]!.billingPeriod, harness.at());

    const second = await deliver(harness, event);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    const afterSecond = harness.data.debug.allowances();
    expect(afterSecond).toHaveLength(1);
    // The reservation survived: the period was not reset behind the customer's back.
    expect(afterSecond[0]?.reserved).toBe(1);
  });

  it('BILL-127 an invoice paid for a customer we have never seen is a 200 with no effect', async () => {
    const harness = createHarness();
    const response = await deliver(
      harness,
      stripeEvent(
        'invoice.paid',
        invoiceObject({ customer: 'cus_unknown_to_us', subscriptionId: 'sub_unknown' }),
      ),
    );
    expect(response.status).toBe(200);
    expect(harness.data.debug.allowances()).toHaveLength(0);
    expect(harness.data.debug.receipts()[0]?.status).toBe('ignored');
  });

  it('BILL-128 a failed payment marks the order failed without cancelling access', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    await harness.data.recordOrderStatus({
      workspaceId: WS,
      orderId: 'ord_0001',
      status: 'active',
      at: harness.at(),
    });
    const response = await deliver(
      harness,
      stripeEvent('invoice.payment_failed', invoiceObject({ customer: 'cus_stub_1' })),
    );
    expect(response.status).toBe(200);
    const order = await harness.data.findOrder(WS, 'ord_0001');
    expect(order?.status).toBe('failed');
  });
});

describe('refund events and unknown types', () => {
  it('BILL-129 charge.refunded moves a refund we already hold to succeeded', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    await harness.data.openRefundOnce({
      id: 'ref_0001',
      workspaceId: WS,
      orderId: 'ord_0001',
      providerRefundId: 're_known_1',
      amountMinor: 2900,
      currency: 'GBP',
      state: 'submitted',
      reason: 'customer asked',
      idempotencyKey: 'refund:ws_customer_1:ord_0001:2900:full',
      approvalId: 'apr_1',
      createdAt: harness.at(),
      updatedAt: harness.at(),
    });

    const response = await deliver(
      harness,
      stripeEvent(
        'charge.refunded',
        chargeRefundedObject([
          { id: 're_known_1', object: 'refund', amount: 2900, status: 'succeeded' },
        ]),
      ),
    );
    expect(response.status).toBe(200);
    const refund = await harness.data.findRefund(WS, 'ref_0001');
    expect(refund?.state).toBe('succeeded');
  });

  it('BILL-130 a refund issued straight from the Stripe dashboard is reported, never fabricated', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);
    const response = await deliver(
      harness,
      stripeEvent(
        'charge.refunded',
        chargeRefundedObject([
          { id: 're_dashboard_only', object: 'refund', amount: 2900, status: 'succeeded' },
        ]),
      ),
    );
    expect(response.status).toBe(200);
    expect(harness.data.debug.refunds()).toHaveLength(0);
    expect(harness.data.debug.receipts()[0]?.status).toBe('ignored');
  });

  it('BILL-131 an unrecognised event type is recorded and ignored without an error', async () => {
    const harness = createHarness();
    const response = await deliver(
      harness,
      stripeEvent('radar.early_fraud_warning.created', { id: 'issfr_1', object: 'x' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false });
    const receipt = harness.data.debug.receipts()[0];
    expect(receipt?.status).toBe('ignored');
    expect(receipt?.eventId).toBeDefined();
  });
});

describe('failure of our own handler', () => {
  it('BILL-132 a handler failure returns 500 and releases the event so the retry is not deduplicated', async () => {
    const harness = createHarness();
    await seedWorkspace(harness);

    let failures = 1;
    const flaky: BillingDataPort = {
      ...harness.data,
      async saveSubscriptionSnapshot(record) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('D1 write failed');
        }
        return harness.data.saveSubscriptionSnapshot(record);
      },
    };

    const event = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ workspaceId: WS }),
      { id: 'evt_retry_me', created: 1_798_000_000 },
    );

    const first = await deliver(harness, event, { data: flaky });
    expect(first.status).toBe(500);
    // The receipt was given back, so the retry is a fresh attempt rather than a no-op.
    expect(harness.data.debug.receipts()).toHaveLength(0);

    const retry = await deliver(harness, event, { data: flaky });
    expect(retry.status).toBe(200);
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');
  });

  it('BILL-241 a crash after the effect re-runs the handler on retry, and idempotency keeps it applied once', async () => {
    // The window worth understanding, and it does not behave the way you would first
    // guess. The effect committed, then completing the receipt threw. At that point the
    // route cannot tell "the handler failed" from "the handler worked and bookkeeping
    // failed", so it does the safe-for-lost-events thing and releases the claim.
    //
    // The consequence is that Stripe's retry **re-executes the handler** — it is not
    // deduplicated. What makes that harmless is not the receipt at all: it is that every
    // handler is idempotent by construction. This case exists to prove that claim rather
    // than assert it, which is why it checks the counters and not the `duplicate` flag.
    const harness = createHarness();
    await seedWorkspace(harness);

    let failCompletion = true;
    const flaky: BillingDataPort = {
      ...harness.data,
      async completeWebhookProcessing(receiptId, status, workspaceId) {
        if (failCompletion) {
          failCompletion = false;
          throw new Error('D1 unavailable while completing the receipt');
        }
        return harness.data.completeWebhookProcessing(receiptId, status, workspaceId);
      },
    };

    const event = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ workspaceId: WS }),
      { id: 'evt_crash_after_effect', created: 1_798_000_000 },
    );

    const first = await deliver(harness, event, { data: flaky });
    expect(first.status).toBe(500);
    // The effect did happen.
    expect((await harness.data.findSubscriptionForWorkspace(WS, 'test'))?.status).toBe('active');
    const allowancesAfterFirst = harness.data.debug.allowances().length;

    const retry = await deliver(harness, event, { data: flaky });
    expect(retry.status).toBe(200);
    // The claim was released, so this really did run the handler a second time.
    expect(await retry.json()).toEqual({ received: true, duplicate: false });
    // And it changed nothing: one subscription, one allowance, no second grant.
    expect(harness.data.debug.allowances()).toHaveLength(allowancesAfterFirst);
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
    expect(harness.data.debug.allowances()[0]).toMatchObject({
      runLimit: 500,
      consumed: 0,
      reserved: 0,
    });
  });

  it('BILL-242 when the claim cannot be released the event is stranded, logged, and found by reconciliation', async () => {
    // THE named crash window, stated rather than hidden. The handler failed AND the
    // compensating release failed, so the claim stands over an effect that never
    // happened. Stripe's retry is deduplicated away and that event's effect is lost.
    //
    // Two things must be true about it: the operator is told, and something finds the
    // gap. `reconcile.ts` is that something.
    const harness = createHarness();
    await seedWorkspace(harness);
    await harness.data.saveSubscriptionSnapshot({
      id: 'sub_row_1',
      workspaceId: WS,
      providerSubscriptionId: 'sub_live_1',
      environment: 'test',
      status: 'active',
      priceId: harness.config.priceId,
      currentPeriodEnd: '2026-10-19T09:00:00.000Z',
      cancelAtPeriodEnd: false,
      reconciledAt: null,
      latestPaymentIntentId: null,
      latestPaymentPeriodEnd: null,
      providerEventCreated: 1_795_000_000,
      updatedAt: harness.at(),
    });

    const logged: Record<string, string | number | boolean>[] = [];
    const broken: BillingDataPort = {
      ...harness.data,
      async openAllowancePeriod() {
        throw new Error('D1 write failed');
      },
      async abandonWebhookProcessing() {
        throw new Error('D1 still unavailable');
      },
    };

    const paid = stripeEvent(
      'invoice.paid',
      invoiceObject({ subscriptionId: 'sub_live_1', billingReason: 'subscription_cycle' }),
      { id: 'evt_stranded', created: 1_798_000_000 },
    );
    const { body, headers } = await signedDelivery(paid, harness.at(), WEBHOOK_SECRET);
    const app = createStripeWebhookRoute({
      ...harness,
      data: broken,
      resolveEndpointSecret: async (id) => (id === OPAQUE_ID ? WEBHOOK_SECRET : null),
      log: (entry) => logged.push(entry),
    });

    const first = await app.request(PATH, { method: 'POST', headers, body });
    expect(first.status).toBe(500);
    // The operator is told, precisely.
    expect(logged.some((entry) => entry['event'] === 'stripe_webhook_claim_stranded')).toBe(true);
    expect(logged.some((entry) => entry['claim_released'] === false)).toBe(true);

    // Stripe's retry is now deduplicated away: the allowance never opens.
    const retry = await deliver(harness, paid);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true, duplicate: true });
    expect(harness.data.debug.allowances()).toHaveLength(0);

    // And reconciliation finds the gap it left.
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
      items: {
        data: [
          {
            current_period_end: Math.floor(Date.parse('2026-10-19T09:00:00.000Z') / 1000),
            price: { id: harness.config.priceId },
          },
        ],
      },
    });
    const report = await reconcileSubscriptions(harness);
    expect(report.discrepancies.map((entry) => entry.kind)).toContain('allowance_period_missing');
  });
});

/**
 * BILL-640..643 — an event for a workspace this deployment does not hold.
 *
 * Both deployments share one Stripe sandbox, so production receives events for checkout
 * sessions staging created, carrying a `client_reference_id` production has never held.
 * On 20 September 2026, the moment signature verification started working on production,
 * two handlers threw on exactly that and the route answered 500 — so Stripe retried,
 * for ever, an event that could never succeed. `invoice.paid` already had the guard and
 * correctly answered "unknown customer" and ignored it; the other two did not.
 *
 * The rule these pin: an event this deployment cannot act on is IGNORED by name, answered
 * 200 so the provider stops retrying, and leaves nothing half-written.
 */
describe('an event for a workspace this deployment does not hold', () => {
  it('BILL-640 a checkout for an unknown workspace is ignored by name, not failed', async () => {
    const harness = createHarness({ knownWorkspaces: [] });
    const event = stripeEvent(
      'checkout.session.completed',
      {
        id: 'cs_elsewhere',
        mode: 'subscription',
        client_reference_id: 'ws_on_the_other_deployment',
        customer: 'cus_elsewhere',
        subscription: 'sub_elsewhere',
        payment_status: 'paid',
      },
      { id: 'evt_checkout_elsewhere' },
    );

    const response = await deliver(harness, event);

    // 200, so the provider stops retrying. A 500 here is the defect: Stripe retried an
    // event that cannot succeed until the attempts ran out.
    expect(response.status, 'the handler threw instead of ignoring').toBe(200);
    // And nothing was written for a workspace we do not have.
    expect(harness.data.debug.customers()).toHaveLength(0);
    expect(harness.data.debug.subscriptions()).toHaveLength(0);
    expect(harness.data.debug.allowances()).toHaveLength(0);
  });

  it('BILL-641 a subscription naming an unknown workspace is ignored for THAT reason, and grants no allowance', async () => {
    // Asserted on the logged effect, not on the store being empty.
    //
    // The first version of this case asserted `subscriptions()` and `allowances()` were
    // empty, and it passed with the guard REMOVED — the in-memory store has no foreign
    // key, so it cannot reproduce the constraint violation that made production answer
    // 500, and something else short-circuited the write anyway. A case that is green
    // against the defect it is named for is worse than no case, because the name is then
    // the only evidence and the name is wrong.
    //
    // The effect string is the precise observable: with the guard it is
    // `subscription_for_unknown_workspace`; without it the handler proceeds past the
    // check and reports something else.
    const harness = createHarness({ knownWorkspaces: [] });
    const lines: Record<string, string | number | boolean>[] = [];
    const event = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ id: 'sub_elsewhere', workspaceId: 'ws_elsewhere' }),
      { id: 'evt_sub_elsewhere' },
    );
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async (opaqueId) => (opaqueId === OPAQUE_ID ? WEBHOOK_SECRET : null),
      log: (entry) => lines.push(entry),
    });

    const response = await app.request(PATH, { method: 'POST', headers, body });

    expect(response.status).toBe(200);
    const handled = lines.find((l) => l['event'] === 'stripe_webhook_handled');
    expect(handled?.['effect']).toBe('subscription_for_unknown_workspace');
    // And the one that would cost money: no allowance for a workspace that is not ours.
    expect(harness.data.debug.allowances()).toHaveLength(0);
  });

  it('BILL-642 the same events for a workspace this deployment DOES hold are still acted on', async () => {
    // The guard must not be a way to ignore everything. This is the same pair of events
    // against a deployment that knows the workspace, and it must still do the work.
    const harness = createHarness({ knownWorkspaces: [WS] });
    const event = stripeEvent(
      'checkout.session.completed',
      {
        id: 'cs_ours',
        mode: 'subscription',
        client_reference_id: WS,
        customer: 'cus_ours',
        subscription: 'sub_ours',
        payment_status: 'paid',
      },
      { id: 'evt_checkout_ours' },
    );

    const response = await deliver(harness, event);

    expect(response.status).toBe(200);
    expect(harness.data.debug.customers()).toHaveLength(1);
  });

  it('BILL-643 an unknown workspace is refused on presence, not on the id being absent', async () => {
    // `checkout_without_workspace_reference` already existed and covers a MISSING id. The
    // defect was a PRESENT id naming a workspace this deployment does not hold — a
    // different condition that produced a 500 rather than an ignore.
    const harness = createHarness({ knownWorkspaces: ['ws_something_else'] });
    const event = stripeEvent(
      'checkout.session.completed',
      {
        id: 'cs_named_but_absent',
        mode: 'subscription',
        client_reference_id: 'ws_named_but_absent',
        customer: 'cus_x',
        subscription: 'sub_x',
        payment_status: 'paid',
      },
      { id: 'evt_named_but_absent' },
    );

    const response = await deliver(harness, event);

    expect(response.status).toBe(200);
    expect(harness.data.debug.customers()).toHaveLength(0);
  });
});

/**
 * BILL-650..653 — the two conditions a 200 must never confuse.
 *
 * A 200 tells Stripe to stop retrying. That is right for an event this deployment can
 * never act on, and catastrophic for a legitimate payment that has simply arrived early:
 * the receipt is claimed, the retry is deduplicated away, and a real customer has paid
 * for nothing. So the two are separated here and asserted apart.
 *
 * What makes the discriminator safe is a fact about ORDER, not about ids:
 * `workspaces.createWithOwner` writes the workspace and its owning membership atomically
 * at SIGNUP, long before a checkout session can exist. A legitimate event's workspace is
 * therefore always present locally by the time Stripe sends anything. What may legitimately
 * be missing is the ORDER row or the billing-customer binding — a different condition,
 * reaching different lines, and one that must still be processed.
 */
describe('a 200 must not discard a payment that needs recovery', () => {
  it('BILL-650 a foreign-environment event is recorded as ignored, not dropped without trace', async () => {
    // Ignored is a state, not a silence. The receipt must exist afterwards so that
    // reconciliation and the owner can both see that something arrived and was refused,
    // and why. "We dropped it" and "we have no idea" are different, and only the first
    // can be investigated.
    const harness = createHarness({ knownWorkspaces: [WS] });
    const event = stripeEvent(
      'checkout.session.completed',
      {
        id: 'cs_foreign',
        mode: 'subscription',
        client_reference_id: 'ws_on_the_other_deployment',
        customer: 'cus_foreign',
        subscription: 'sub_foreign',
        payment_status: 'paid',
      },
      { id: 'evt_foreign_env' },
    );

    const response = await deliver(harness, event);

    expect(response.status).toBe(200);
    const receipts = harness.data.debug.receipts();
    const receipt = receipts.find((r) => r.eventId === 'evt_foreign_env');
    expect(receipt, 'the refused event left no receipt at all').toBeDefined();
    expect(receipt?.status).toBe('ignored');
    // And it changed nothing.
    expect(harness.data.debug.customers()).toHaveLength(0);
    expect(harness.data.debug.allowances()).toHaveLength(0);
  });

  it('BILL-651 a legitimate subscription arriving BEFORE any local linkage is processed, never ignored', async () => {
    // The condition the guard must not swallow. The workspace exists — it always does,
    // from signup — but there is no order, no billing-customer binding and no stored
    // subscription yet. This is a real payment that has outrun our own bookkeeping, and
    // ignoring it would take the customer's money and grant nothing.
    const harness = createHarness({ knownWorkspaces: [WS] });
    expect(harness.data.debug.orders(), 'precondition: no local linkage').toHaveLength(0);
    expect(harness.data.debug.customers(), 'precondition: no billing customer').toHaveLength(0);

    const lines: Record<string, string | number | boolean>[] = [];
    const event = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ id: 'sub_early', workspaceId: WS }),
      { id: 'evt_early_subscription' },
    );
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async (opaqueId) => (opaqueId === OPAQUE_ID ? WEBHOOK_SECRET : null),
      log: (entry) => lines.push(entry),
    });

    const response = await app.request(PATH, { method: 'POST', headers, body });

    expect(response.status).toBe(200);
    const handled = lines.find((l) => l['event'] === 'stripe_webhook_handled');
    // The exact thing that must not happen: refused for want of linkage we had not written.
    expect(handled?.['effect']).not.toBe('subscription_for_unknown_workspace');
    expect(handled?.['status']).toBe('processed');
    // And the customer actually got what they paid for.
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
    expect(harness.data.debug.allowances()).toHaveLength(1);
  });

  it('BILL-652 an early invoice for a workspace we hold is not refused as an unknown customer', async () => {
    // The sibling condition on the invoice path. `invoice_for_unknown_customer` is correct
    // for a customer binding we have never made; it must not also swallow an invoice for a
    // workspace we do hold whose subscription arrived first.
    const harness = createHarness({ knownWorkspaces: [WS] });
    await harness.data.rememberBillingCustomer({
      workspaceId: WS,
      stripeCustomerId: 'cus_known',
      environment: 'test',
      createdAt: harness.at(),
    });
    const lines: Record<string, string | number | boolean>[] = [];
    const event = stripeEvent(
      'invoice.paid',
      invoiceObject({ customer: 'cus_known', subscriptionId: 'sub_known' }),
      { id: 'evt_early_invoice' },
    );
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const app = createStripeWebhookRoute({
      ...harness,
      resolveEndpointSecret: async (opaqueId) => (opaqueId === OPAQUE_ID ? WEBHOOK_SECRET : null),
      log: (entry) => lines.push(entry),
    });

    const response = await app.request(PATH, { method: 'POST', headers, body });
    const handled = lines.find((l) => l['event'] === 'stripe_webhook_handled');

    expect(response.status).toBe(200);
    expect(handled?.['effect']).not.toBe('invoice_for_unknown_customer');
  });

  it('BILL-653 the guard keys on the workspace being absent HERE, not on any linkage being absent', async () => {
    // The distinction stated as an assertion, because it is the whole safety argument.
    // Same deployment, same missing linkage, two workspace ids: one we hold and one we do
    // not. They must take different paths. If a future change made the guard key on the
    // order or the customer binding instead, these two would collapse into one answer and
    // every early legitimate payment would be silently ignored.
    const harness = createHarness({ knownWorkspaces: [WS] });
    const ours = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ id: 'sub_ours_early', workspaceId: WS }),
      { id: 'evt_ours_early' },
    );
    const theirs = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ id: 'sub_theirs', workspaceId: 'ws_not_here' }),
      { id: 'evt_theirs' },
    );

    await deliver(harness, ours);
    await deliver(harness, theirs);

    // Ours was acted on; theirs was not. One allowance, one subscription, from two events.
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
    expect(harness.data.debug.allowances()).toHaveLength(1);
    expect(harness.data.debug.allowances()[0]?.workspaceId).toBe(WS);
  });
});
