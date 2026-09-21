/**
 * The Stripe adapter.
 *
 * Every request is served by an injected stub. Nothing here has ever spoken to Stripe —
 * there is no key in this repository and a test-mode call would still create real objects
 * in the owner's account. What is proved here is the *shape* of the requests we would
 * send and the handling of the responses we would get, against the documented API
 * (version 2026-08-26.dahlia, checked 2026-09-19).
 */
import { describe, expect, it } from 'vitest';
import {
  createStripeClient,
  encodeForm,
  environmentForSecretKey,
  invoiceSubscriptionId,
  scrubSecret,
  StripeError,
  subscriptionPeriodEnd,
  subscriptionPriceId,
  type StripeSubscription,
} from '../../../packages/connectors/src/stripe';

// Assembled at runtime. The value is invented, but committing a literal of this
// shape trips our own scanner and GitHub push protection, and the correct response
// to that is to stop committing the shape — not to allowlist the warning.
const TEST_KEY = ['sk', 'test', '51NotARealKeyJustAFixture0000000000'].join('_');

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

interface StubResponse {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

function stubFetch(responses: readonly StubResponse[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    const body = spec.text ?? JSON.stringify(spec.json ?? {});
    return new Response(body, {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function client(responses: readonly StubResponse[]) {
  const { fetchImpl, requests } = stubFetch(responses);
  return { stripe: createStripeClient({ secretKey: TEST_KEY, fetchImpl }), requests };
}

function formOf(body: string | null): URLSearchParams {
  return new URLSearchParams(body ?? '');
}

describe('form encoding', () => {
  it('BILL-057 nested objects become bracketed keys', () => {
    expect(encodeForm({ recurring: { interval: 'month', interval_count: 1 } })).toBe(
      'recurring%5Binterval%5D=month&recurring%5Binterval_count%5D=1',
    );
  });

  it('BILL-058 an array of objects becomes an indexed list, as line_items needs', () => {
    const encoded = decodeURIComponent(
      encodeForm({ line_items: [{ price: 'price_1', quantity: 1 }] }),
    );
    expect(encoded).toBe('line_items[0][price]=price_1&line_items[0][quantity]=1');
  });

  it('BILL-059 an array of scalars becomes a repeated bracket list, as types[] needs', () => {
    const encoded = decodeURIComponent(encodeForm({ types: ['invoice.paid', 'charge.refunded'] }));
    expect(encoded).toBe('types[]=invoice.paid&types[]=charge.refunded');
  });

  it('BILL-060 undefined and null members are dropped rather than sent as strings', () => {
    expect(encodeForm({ a: 'x', b: undefined, c: null })).toBe('a=x');
  });

  it('BILL-061 values are percent-encoded so a URL parameter cannot break out', () => {
    const encoded = encodeForm({ success_url: 'https://x.example/return?a=b&c=d' });
    expect(encoded).toContain('%3Fa%3Db%26c%3Dd');
  });
});

describe('keys and secrets', () => {
  it('BILL-062 a test key and a live key are told apart, and anything else is refused', () => {
    expect(environmentForSecretKey('sk_test_abc123')).toBe('test');
    expect(environmentForSecretKey('sk_live_abc123')).toBe('live');
    expect(environmentForSecretKey('rk_test_abc123')).toBe('test');
    expect(() => environmentForSecretKey('pk_test_abc123')).toThrow(StripeError);
  });

  it('BILL-063 a secret key is scrubbed out of anything that could be logged or thrown', () => {
    expect(scrubSecret(`boom ${TEST_KEY} boom`, TEST_KEY)).toBe('boom [redacted-stripe-key] boom');
    // Even a key that is not ours never travels onward.
    expect(scrubSecret('leaked ' + ['sk', 'live', 'someoneelseskey000000'].join('_'))).toBe(
      'leaked [redacted-stripe-key]',
    );
  });

  it('BILL-064 a provider error that echoes the key back cannot escape through the throw', async () => {
    const { stripe } = client([
      {
        status: 400,
        json: {
          error: { message: `Invalid API Key provided: ${TEST_KEY}`, code: 'api_key_invalid' },
        },
      },
    ]);
    await expect(
      stripe.createCustomer({ idempotencyKey: 'k1', email: 'a@example.com' }),
    ).rejects.toThrow(/\[redacted-stripe-key\]/);
    await expect(
      stripe.createCustomer({ idempotencyKey: 'k1', email: 'a@example.com' }),
    ).rejects.not.toThrow(new RegExp(TEST_KEY));
  });

  it('BILL-065 the key never appears in a request URL, only in the Authorization header', async () => {
    const { stripe, requests } = client([
      { json: { id: 'cus_1', object: 'customer', livemode: false } },
    ]);
    await stripe.createCustomer({ idempotencyKey: 'k1' });
    const request = requests[0];
    expect(request).toBeDefined();
    expect(request?.url).not.toContain(TEST_KEY);
    expect(request?.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
  });
});

describe('mutating calls', () => {
  it('BILL-066 every mutating call carries an Idempotency-Key and the pinned API version', async () => {
    const { stripe, requests } = client([
      { json: { id: 'cus_1', object: 'customer', livemode: false } },
    ]);
    await stripe.createCustomer({ idempotencyKey: 'customer:ws_1', email: 'a@example.com' });
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['idempotency-key']).toBe('customer:ws_1');
    expect(requests[0]?.headers['stripe-version']).toBe('2026-08-26.dahlia');
  });

  it('BILL-067 an idempotency key over Stripe’s 255-character limit is refused before sending', async () => {
    const { stripe, requests } = client([{ json: {} }]);
    await expect(stripe.createCustomer({ idempotencyKey: 'x'.repeat(256) })).rejects.toThrow(
      StripeError,
    );
    expect(requests).toHaveLength(0);
  });

  it('BILL-068 a subscription checkout session sends mode=subscription and our own price id', async () => {
    const { stripe, requests } = client([
      {
        json: {
          id: 'cs_1',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/cs_1',
          livemode: false,
        },
      },
    ]);
    await stripe.createCheckoutSession({
      idempotencyKey: 'checkout:v1:ws_1',
      priceId: 'price_plan',
      customerId: 'cus_1',
      successUrl: 'https://verify.example/ok',
      cancelUrl: 'https://verify.example/no',
      clientReferenceId: 'ws_1',
    });
    const form = formOf(requests[0]?.body ?? null);
    expect(requests[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_plan');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('client_reference_id')).toBe('ws_1');
  });

  it('BILL-069 cancelling immediately is a DELETE, and at period end is an update', async () => {
    const subscription = {
      id: 'sub_1',
      object: 'subscription',
      status: 'canceled',
      customer: 'cus_1',
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: 1,
      livemode: false,
    };
    const immediate = client([{ json: subscription }]);
    await immediate.stripe.cancelSubscription({
      subscriptionId: 'sub_1',
      idempotencyKey: 'cancel:immediately:sub_1',
      when: 'immediately',
    });
    expect(immediate.requests[0]?.method).toBe('DELETE');

    const atPeriodEnd = client([
      { json: { ...subscription, status: 'active', cancel_at_period_end: true } },
    ]);
    await atPeriodEnd.stripe.cancelSubscription({
      subscriptionId: 'sub_1',
      idempotencyKey: 'cancel:period_end:sub_1',
      when: 'period_end',
    });
    expect(atPeriodEnd.requests[0]?.method).toBe('POST');
    expect(formOf(atPeriodEnd.requests[0]?.body ?? null).get('cancel_at_period_end')).toBe('true');
  });

  it('BILL-070 a refund needs exactly one of a payment intent or a charge', async () => {
    const { stripe, requests } = client([{ json: {} }]);
    await expect(stripe.createRefund({ idempotencyKey: 'r1', amountMinor: 2900 })).rejects.toThrow(
      StripeError,
    );
    await expect(
      stripe.createRefund({
        idempotencyKey: 'r1',
        amountMinor: 2900,
        chargeId: 'ch_1',
        paymentIntentId: 'pi_1',
      }),
    ).rejects.toThrow(StripeError);
    expect(requests).toHaveLength(0);
  });

  it('BILL-071 a refund amount must be a positive integer of minor units', async () => {
    const { stripe } = client([{ json: {} }]);
    await expect(
      stripe.createRefund({ idempotencyKey: 'r1', amountMinor: 0, chargeId: 'ch_1' }),
    ).rejects.toThrow(StripeError);
    await expect(
      stripe.createRefund({ idempotencyKey: 'r1', amountMinor: 29.5, chargeId: 'ch_1' }),
    ).rejects.toThrow(StripeError);
  });

  it('BILL-072 a refund sends its idempotency key so a retry cannot move money twice', async () => {
    const { stripe, requests } = client([
      {
        json: {
          id: 're_1',
          object: 'refund',
          amount: 2900,
          currency: 'gbp',
          charge: 'ch_1',
          payment_intent: null,
          status: 'succeeded',
          reason: 'requested_by_customer',
        },
      },
    ]);
    await stripe.createRefund({
      idempotencyKey: 'refund:ws_1:ord_1:2900:full',
      amountMinor: 2900,
      chargeId: 'ch_1',
      reason: 'requested_by_customer',
    });
    expect(requests[0]?.headers['idempotency-key']).toBe('refund:ws_1:ord_1:2900:full');
    expect(formOf(requests[0]?.body ?? null).get('amount')).toBe('2900');
  });
});

describe('reads', () => {
  it('BILL-073 listing events encodes the type filter and the created lower bound', async () => {
    const { stripe, requests } = client([{ json: { object: 'list', data: [], has_more: false } }]);
    await stripe.listEvents({ types: ['invoice.paid'], createdGte: 1_700_000_000, limit: 50 });
    const url = decodeURIComponent(requests[0]?.url ?? '');
    expect(url).toContain('/v1/events?');
    expect(url).toContain('types[]=invoice.paid');
    expect(url).toContain('created[gte]=1700000000');
    expect(url).toContain('limit=50');
  });

  it('BILL-074 the event list limit is clamped to Stripe’s documented 1..100 range', async () => {
    const { stripe, requests } = client([{ json: { object: 'list', data: [], has_more: false } }]);
    await stripe.listEvents({ limit: 5_000 });
    expect(decodeURIComponent(requests[0]?.url ?? '')).toContain('limit=100');
  });

  it('BILL-075 a live-mode object returned to a test-mode key is refused', async () => {
    const { stripe } = client([
      {
        json: {
          id: 'sub_1',
          object: 'subscription',
          status: 'active',
          customer: 'cus_1',
          cancel_at_period_end: false,
          cancel_at: null,
          canceled_at: null,
          livemode: true,
        },
      },
    ]);
    await expect(stripe.retrieveSubscription('sub_1')).rejects.toThrow(/live-mode/);
  });
});

describe('failure handling', () => {
  it('BILL-076 HTTP statuses map to typed failure kinds and a retryable flag', async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, 'authentication', false],
      [404, 'not_found', false],
      [409, 'idempotency_conflict', false],
      [429, 'rate_limited', true],
      [503, 'provider_unavailable', true],
      [400, 'invalid_request', false],
    ];
    for (const [status, kind, retryable] of cases) {
      const { stripe } = client([{ status, json: { error: { message: 'nope' } } }]);
      await stripe.retrieveSubscription('sub_1').then(
        () => {
          throw new Error(`expected ${status} to reject`);
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(StripeError);
          expect((error as StripeError).kind).toBe(kind);
          expect((error as StripeError).retryable).toBe(retryable);
        },
      );
    }
  });

  it('BILL-077 a body that is not JSON is a typed malformed_response, not a crash', async () => {
    const { stripe } = client([{ text: '<html>gateway</html>' }]);
    await stripe.retrieveSubscription('sub_1').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => {
        expect((error as StripeError).kind).toBe('malformed_response');
      },
    );
  });

  it('BILL-078 an oversized response is refused rather than parsed', async () => {
    const { fetchImpl } = stubFetch([{ text: 'x'.repeat(2_000) }]);
    const stripe = createStripeClient({
      secretKey: TEST_KEY,
      fetchImpl,
      maxResponseBytes: 100,
    });
    await stripe.retrieveSubscription('sub_1').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => {
        expect((error as StripeError).kind).toBe('response_too_large');
      },
    );
  });

  it('BILL-079 a base URL outside the connector allowlist never becomes a request', async () => {
    const { fetchImpl, requests } = stubFetch([{ json: {} }]);
    const stripe = createStripeClient({
      secretKey: TEST_KEY,
      fetchImpl,
      apiBase: 'https://api.stripe.com.evil.example',
    });
    await stripe.retrieveSubscription('sub_1').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => {
        expect((error as StripeError).kind).toBe('blocked_url');
      },
    );
    expect(requests).toHaveLength(0);
  });

  it('BILL-080 a transport failure becomes provider_unavailable without leaking the cause', async () => {
    const stripe = createStripeClient({
      secretKey: TEST_KEY,
      fetchImpl: (async () => {
        throw new Error(`socket closed while talking to ${TEST_KEY}`);
      }) as typeof fetch,
    });
    await stripe.retrieveSubscription('sub_1').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => {
        expect((error as StripeError).kind).toBe('provider_unavailable');
        expect((error as StripeError).message).not.toContain(TEST_KEY);
      },
    );
  });
});

describe('bootstrap helper', () => {
  const existingPrice = {
    id: 'price_existing',
    object: 'price',
    active: true,
    currency: 'gbp',
    unit_amount: 2900,
    lookup_key: 'verify_single_workflow_monthly_gbp_v1',
    product: 'prod_existing',
    livemode: false,
    recurring: { interval: 'month', interval_count: 1 },
  };

  const params = {
    idempotencyKey: 'bootstrap:v1',
    lookupKey: 'verify_single_workflow_monthly_gbp_v1',
    productName: 'ITISYOU Verify — one workflow',
    unitAmountMinor: 2900,
    currency: 'gbp',
  } as const;

  it('BILL-081 an existing price with the same lookup key is reused, not duplicated', async () => {
    const { stripe, requests } = client([
      { json: { object: 'list', data: [existingPrice], has_more: false } },
    ]);
    const result = await stripe.ensureProductAndPrice(params);
    expect(result).toMatchObject({
      priceId: 'price_existing',
      productId: 'prod_existing',
      created: false,
      environment: 'test',
    });
    expect(requests).toHaveLength(1);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('BILL-082 with no existing price it creates a product and a recurring GBP price', async () => {
    const { stripe, requests } = client([
      { json: { object: 'list', data: [], has_more: false } },
      { json: { id: 'prod_new', object: 'product', name: 'x', active: true, livemode: false } },
      { json: { ...existingPrice, id: 'price_new', product: 'prod_new' } },
    ]);
    const result = await stripe.ensureProductAndPrice(params);
    expect(result).toMatchObject({ priceId: 'price_new', created: true, unitAmountMinor: 2900 });
    const priceForm = formOf(requests[2]?.body ?? null);
    expect(priceForm.get('currency')).toBe('gbp');
    expect(priceForm.get('unit_amount')).toBe('2900');
    expect(priceForm.get('recurring[interval]')).toBe('month');
    expect(priceForm.get('lookup_key')).toBe('verify_single_workflow_monthly_gbp_v1');
  });

  it('BILL-083 a lookup key already in use on different terms is refused, not overwritten', async () => {
    const { stripe, requests } = client([
      {
        json: {
          object: 'list',
          data: [{ ...existingPrice, unit_amount: 4900 }],
          has_more: false,
        },
      },
    ]);
    await expect(stripe.ensureProductAndPrice(params)).rejects.toThrow(/different terms/);
    expect(requests).toHaveLength(1);
  });
});

describe('current API object shapes', () => {
  const subscription = {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    livemode: false,
  } as const;

  it('BILL-084 the period end is read from the subscription item, where it now lives', () => {
    const withItem: StripeSubscription = {
      ...subscription,
      items: {
        data: [{ id: 'si_1', current_period_end: 1_760_000_000, price: { id: 'price_1' } }],
      },
    };
    expect(subscriptionPeriodEnd(withItem)).toBe(1_760_000_000);
    expect(subscriptionPriceId(withItem)).toBe('price_1');
  });

  it('BILL-085 an event generated under an older API version still parses via the legacy field', () => {
    const legacy: StripeSubscription = { ...subscription, current_period_end: 1_750_000_000 };
    expect(subscriptionPeriodEnd(legacy)).toBe(1_750_000_000);
    expect(subscriptionPriceId(legacy)).toBeNull();
  });

  it('BILL-086 an invoice’s subscription is read from parent.subscription_details and the legacy field', () => {
    expect(
      invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_new' } } }),
    ).toBe('sub_new');
    expect(invoiceSubscriptionId({ subscription: 'sub_old' })).toBe('sub_old');
    expect(invoiceSubscriptionId({ subscription: { id: 'sub_expanded' } })).toBe('sub_expanded');
    expect(invoiceSubscriptionId({})).toBeNull();
  });
});

describe('the billing portal session is a new session every time', () => {
  /*
   * This is the defect that survived its own fix.
   *
   * `openBillingPortal` was corrected to mint a session per click rather than during the
   * page render, and BILL-672 holds that in place. But the adapter below sent a
   * DETERMINISTIC idempotency key, `portal:<customer>:<returnUrl>`, identical on every
   * opening for a customer. Stripe replays the stored response for a repeated key for 24
   * hours, so the second click received the FIRST session: single-use, short-lived, and
   * already spent. BILL-672 could not see it, because its gateway is a stub that never
   * reaches this code.
   *
   * So the assertion is on the wire: two openings, two different keys.
   */
  const portalResponse = {
    json: {
      id: 'bps_1',
      url: 'https://billing.stripe.com/p/session/test_fixture',
      livemode: false,
      return_url: 'https://verify.example.test/app/billing',
    },
  };

  it('BILL-675 two openings send two different idempotency keys, so Stripe cannot replay the first session', async () => {
    const { stripe, requests } = client([portalResponse, portalResponse]);

    await stripe.createBillingPortalSession({
      customerId: 'cus_fixture',
      returnUrl: 'https://verify.example.test/app/billing',
    });
    await stripe.createBillingPortalSession({
      customerId: 'cus_fixture',
      returnUrl: 'https://verify.example.test/app/billing',
    });

    const keys = requests.map((request) => request.headers['idempotency-key'] ?? '');
    expect(requests.length, 'the second opening did not reach Stripe at all').toBe(2);
    expect(keys[0]).not.toBe('');
    expect(
      keys[0],
      'both openings sent the same idempotency key, so Stripe replays the first, spent session',
    ).not.toBe(keys[1]);
    // Still recognisable, and still inside Stripe's 255-character limit.
    for (const key of keys) {
      expect(key.startsWith('portal:cus_fixture:')).toBe(true);
      expect(key.length).toBeLessThanOrEqual(255);
    }
  });

  it('BILL-676 each opening is a real call rather than a local cache, and the mode is checked', async () => {
    const { stripe, requests } = client([
      portalResponse,
      { json: { ...portalResponse.json, id: 'bps_2', livemode: true } },
    ]);

    const first = await stripe.createBillingPortalSession({
      customerId: 'cus_fixture',
      returnUrl: 'https://verify.example.test/app/billing',
    });
    expect(first.id).toBe('bps_1');

    // A live-mode object arriving at a test-mode deployment is refused rather than opened:
    // the customer would otherwise be handed somebody else's billing account.
    await expect(
      stripe.createBillingPortalSession({
        customerId: 'cus_fixture',
        returnUrl: 'https://verify.example.test/app/billing',
      }),
    ).rejects.toThrow(StripeError);
    expect(requests.length).toBe(2);
  });
});
