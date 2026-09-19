/**
 * Mount readiness, provisioning, and the disclosure the customer sees before paying.
 *
 * These are the cases that make the difference between "correct in isolation" and "safe to
 * turn on". Nothing here reaches Stripe — the provisioning gateway is a stub that records
 * what it was asked for, and `tests/setup.ts` would fail the run if anything escaped.
 */
import { describe, expect, it } from 'vitest';
import { createStripeWebhookRoute } from '@app/routes/webhooks/stripe';
import {
  BILLING_SECRET_NAMES,
  BillingConfigurationError,
  assertBillingSecrets,
  billingEnvironmentOf,
  checkBillingSecrets,
  createEndpointSecretResolver,
  createStripeWebhookDeps,
  type BillingEnv,
} from '@app/billing/mount';
import {
  createProvisionRoute,
  provisionIdempotencyKey,
  provisionPlanPrice,
  type ProvisioningGateway,
} from '@app/billing/provision';
import { preCheckoutDisclosureText, preCheckoutPanel } from '@app/billing/disclosure';
import { PAYMENT_RECOVERY_POLICY } from '@app/billing/policy';
import { createHarness, signedDelivery, stripeEvent, invoiceObject } from './harness';

/** Assembled at runtime — never a credential-shaped literal. See `docs/agent-brief.md`. */
const WEBHOOK_SECRET = 'whsec' + '_' + 'M'.repeat(32);
const UNKNOWN_KEY = 'whsec' + '_' + 'U'.repeat(32);
const TEST_KEY = ['sk', 'test', '51MountSuiteFixtureKey0000000000000'].join('_');
const LIVE_KEY = ['sk', 'live', '51MountSuiteFixtureKey0000000000000'].join('_');
const PATH_ID = 'wh_8c41b6de9a027f35';
const BOOTSTRAP = 'obt' + '_' + 'Z'.repeat(40);

function env(overrides: Partial<BillingEnv> = {}): BillingEnv {
  return {
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: 'https://verify.itisyou.example',
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_PRICE_ID: 'price_planv1stub',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_WEBHOOK_PATH_ID: PATH_ID,
    STRIPE_WEBHOOK_UNKNOWN_KEY: UNKNOWN_KEY,
    ...overrides,
  };
}

describe('mount readiness', () => {
  it('BILL-220 every billing secret is named in one place and all five are required', () => {
    expect(Object.values(BILLING_SECRET_NAMES).sort()).toEqual([
      'STRIPE_PRICE_ID',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_PATH_ID',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_WEBHOOK_UNKNOWN_KEY',
    ]);
    expect(checkBillingSecrets(env()).ready).toBe(true);
  });

  it('BILL-221 a missing secret is reported by name rather than silently defaulted', () => {
    const result = checkBillingSecrets(env({ STRIPE_WEBHOOK_UNKNOWN_KEY: undefined }));
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['STRIPE_WEBHOOK_UNKNOWN_KEY']);
  });

  it('BILL-222 production refuses to mount without the stand-in key — a silent default is how SEC-431 reopens', () => {
    expect(() =>
      assertBillingSecrets(env({ ENVIRONMENT: 'production', STRIPE_WEBHOOK_UNKNOWN_KEY: '' })),
    ).toThrow(BillingConfigurationError);
    expect(() =>
      assertBillingSecrets(env({ ENVIRONMENT: 'staging', STRIPE_WEBHOOK_SECRET: undefined })),
    ).toThrow(/cannot be mounted in staging/);
  });

  it('BILL-223 development still boots with nothing configured, and every delivery is a 400', async () => {
    const bare = env({
      ENVIRONMENT: 'development',
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_WEBHOOK_PATH_ID: undefined,
    });
    expect(() => assertBillingSecrets(bare)).not.toThrow();
    const resolve = createEndpointSecretResolver(bare);
    expect(await resolve(PATH_ID)).toBeNull();
  });

  it('BILL-224 the resolver returns the secret only for the exact configured path id', async () => {
    const resolve = createEndpointSecretResolver(env());
    expect(await resolve(PATH_ID)).toBe(WEBHOOK_SECRET);
    expect(await resolve(PATH_ID.toUpperCase())).toBeNull();
    expect(await resolve(`${PATH_ID}x`)).toBeNull();
    expect(await resolve(PATH_ID.slice(0, -1))).toBeNull();
    expect(await resolve('')).toBeNull();
  });

  it('BILL-225 STRIPE_MODE must be test or live and nothing else', () => {
    expect(billingEnvironmentOf(env())).toBe('test');
    expect(billingEnvironmentOf(env({ STRIPE_MODE: 'live' }))).toBe('live');
    expect(billingEnvironmentOf(env({ STRIPE_MODE: undefined }))).toBe('test');
    expect(() => billingEnvironmentOf(env({ STRIPE_MODE: 'sandbox' }))).toThrow(
      BillingConfigurationError,
    );
  });

  it('BILL-226 the assembled deps carry the stand-in key from the environment', () => {
    const harness = createHarness();
    const deps = createStripeWebhookDeps(env(), {
      data: harness.data,
      gateway: harness.gateway,
      newId: harness.newId,
      now: harness.now,
    });
    expect(deps.unknownEndpointKey).toBe(UNKNOWN_KEY);
    expect(deps.config.environment).toBe('test');
    expect(deps.config.priceId).toBe('price_planv1stub');
  });
});

describe('the assembled webhook route', () => {
  function assembled(overrides: Partial<BillingEnv> = {}) {
    const harness = createHarness();
    const app = createStripeWebhookRoute(
      createStripeWebhookDeps(env(overrides), {
        data: harness.data,
        gateway: harness.gateway,
        newId: harness.newId,
        now: harness.now,
      }),
    );
    return { harness, app };
  }

  it('BILL-227 a signature-verified event through the assembled route activates the subscription, and a replay changes nothing', async () => {
    const { harness, app } = assembled();
    await harness.data.rememberBillingCustomer({
      workspaceId: 'ws_1',
      stripeCustomerId: 'cus_stub_1',
      environment: 'test',
      createdAt: harness.at(),
    });
    harness.gateway.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_stub_1',
      cancel_at_period_end: false,
      livemode: false,
      items: { data: [{ current_period_end: 1_800_500_000, price: { id: 'price_planv1stub' } }] },
    });

    const event = stripeEvent(
      'checkout.session.completed',
      {
        id: 'cs_mounted_1',
        object: 'checkout.session',
        mode: 'subscription',
        status: 'complete',
        payment_status: 'paid',
        customer: 'cus_stub_1',
        subscription: 'sub_live_1',
        client_reference_id: 'ws_1',
        livemode: false,
      },
      { id: 'evt_mounted_1' },
    );
    const { body, headers } = await signedDelivery(event, harness.at(), WEBHOOK_SECRET);
    const path = `/api/v1/webhooks/stripe/${PATH_ID}`;

    const first = await app.request(path, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, duplicate: false });
    expect((await harness.data.findSubscriptionForWorkspace('ws_1', 'test'))?.status).toBe(
      'active',
    );
    const afterFirst = harness.data.debug.allowances().length;

    const replay = await app.request(path, { method: 'POST', headers, body });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });
    expect(harness.data.debug.allowances()).toHaveLength(afterFirst);
    expect(harness.data.debug.subscriptions()).toHaveLength(1);
  });

  it('BILL-228 a forged event at an invented endpoint id is rejected and reads identically to a bad signature', async () => {
    const { harness, app } = assembled();
    const event = stripeEvent('invoice.paid', invoiceObject({ subscriptionId: 'sub_live_1' }));

    // Signed with the stand-in key, at an id we never issued.
    const forged = await signedDelivery(event, harness.at(), UNKNOWN_KEY);
    const atUnknownId = await app.request('/api/v1/webhooks/stripe/wh_invented_by_attacker', {
      method: 'POST',
      headers: forged.headers,
      body: forged.body,
    });

    // A plainly wrong signature at the real id.
    const wrong = await signedDelivery(event, harness.at(), 'whsec' + '_' + 'X'.repeat(32));
    const badSignature = await app.request(`/api/v1/webhooks/stripe/${PATH_ID}`, {
      method: 'POST',
      headers: wrong.headers,
      body: wrong.body,
    });

    expect(atUnknownId.status).toBe(400);
    expect(badSignature.status).toBe(400);
    expect(await atUnknownId.text()).toBe(await badSignature.text());
    expect(harness.data.debug.receipts()).toHaveLength(0);
    expect(harness.data.debug.allowances()).toHaveLength(0);
  });
});

describe('provisioning the plan price', () => {
  function stubGateway(
    environment: 'test' | 'live' = 'test',
    result?: Partial<Awaited<ReturnType<ProvisioningGateway['ensureProductAndPrice']>>>,
  ): ProvisioningGateway & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      environment,
      async ensureProductAndPrice(params) {
        calls.push(params);
        return {
          priceId: 'price_provisioned_1',
          productId: 'prod_provisioned_1',
          created: true,
          environment,
          unitAmountMinor: 2900,
          currency: 'gbp',
          ...result,
        };
      },
    };
  }

  it('BILL-229 it refuses to run without a key and sends nothing', async () => {
    const gateway = stubGateway();
    const outcome = await provisionPlanPrice({
      env: env({ STRIPE_SECRET_KEY: undefined }),
      gateway,
    });
    expect(outcome).toMatchObject({ ok: false, status: 422, code: 'STRIPE_KEY_MISSING' });
    expect(gateway.calls).toHaveLength(0);
  });

  it('BILL-230 it refuses live mode outright, before it even looks at the key', async () => {
    const gateway = stubGateway('live');
    const outcome = await provisionPlanPrice({
      env: env({ STRIPE_MODE: 'live', STRIPE_SECRET_KEY: LIVE_KEY }),
      gateway,
    });
    expect(outcome).toMatchObject({ ok: false, status: 403, code: 'LIVE_MODE_REFUSED' });
    expect(gateway.calls).toHaveLength(0);
  });

  it('BILL-231 a live key with STRIPE_MODE=test is still refused', async () => {
    // The misconfiguration that would otherwise create real objects in the live account.
    const gateway = stubGateway('live');
    const outcome = await provisionPlanPrice({
      env: env({ STRIPE_MODE: 'test', STRIPE_SECRET_KEY: LIVE_KEY }),
      gateway,
    });
    expect(outcome).toMatchObject({ ok: false, status: 403, code: 'LIVE_MODE_REFUSED' });
    expect(gateway.calls).toHaveLength(0);
  });

  it('BILL-232 it provisions the £29 monthly GBP price and prints the price id', async () => {
    const gateway = stubGateway();
    const outcome = await provisionPlanPrice({ env: env(), gateway });
    expect(outcome).toMatchObject({
      ok: true,
      status: 200,
      priceId: 'price_provisioned_1',
      mode: 'test',
      amountMinor: 2900,
      currency: 'gbp',
    });
    expect(gateway.calls[0]).toMatchObject({
      unitAmountMinor: 2900,
      currency: 'gbp',
      interval: 'month',
      lookupKey: 'verify_single_workflow_monthly_gbp_v1',
    });
  });

  it('BILL-233 running it twice presents the same idempotency key and creates nothing the second time', async () => {
    const gateway = stubGateway('test', { created: false });
    const first = await provisionPlanPrice({ env: env(), gateway });
    const second = await provisionPlanPrice({ env: env(), gateway });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.created).toBe(false);
    expect(second.priceId).toBe(first.priceId);
    const keys = new Set(
      (gateway.calls as { idempotencyKey: string }[]).map((call) => call.idempotencyKey),
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(provisionIdempotencyKey());
  });

  it('BILL-234 a provider failure never lets the key into the message', async () => {
    const gateway: ProvisioningGateway = {
      environment: 'test',
      async ensureProductAndPrice() {
        // What the connector would throw: already scrubbed by `StripeError`.
        throw new Error('Invalid API Key provided: [redacted-stripe-key]');
      },
    };
    const outcome = await provisionPlanPrice({ env: env(), gateway });
    expect(outcome).toMatchObject({ ok: false, status: 502, code: 'PROVIDER_ERROR' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).not.toContain(TEST_KEY);
    expect(JSON.stringify(outcome)).not.toContain(TEST_KEY);
  });

  it('BILL-235 the route is owner-only and does not confirm it exists to anyone else', async () => {
    const gateway = stubGateway();
    const app = createProvisionRoute({
      env: env(),
      bootstrapToken: BOOTSTRAP,
      createGateway: () => gateway,
    });

    const anonymous = await app.request('/api/v1/billing/provision-price', { method: 'POST' });
    expect(anonymous.status).toBe(404);

    const wrongToken = await app.request('/api/v1/billing/provision-price', {
      method: 'POST',
      headers: { 'x-owner-bootstrap-token': 'obt' + '_' + 'Q'.repeat(40) },
    });
    expect(wrongToken.status).toBe(404);
    expect(await wrongToken.text()).toBe(await anonymous.text());
    expect(gateway.calls).toHaveLength(0);
  });

  it('BILL-236 with the owner token it returns the price id and the next step, never the key', async () => {
    const gateway = stubGateway();
    const app = createProvisionRoute({
      env: env(),
      bootstrapToken: BOOTSTRAP,
      createGateway: () => gateway,
    });
    const response = await app.request('/api/v1/billing/provision-price', {
      method: 'POST',
      headers: { 'x-owner-bootstrap-token': BOOTSTRAP },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('price_provisioned_1');
    expect(text).toContain('STRIPE_PRICE_ID=price_provisioned_1');
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(BOOTSTRAP);
  });
});

describe('the customer sees the policy before paying', () => {
  it('BILL-237 the panel carries the price, the allowance and the recovery policy', () => {
    const panel = preCheckoutPanel();
    expect(panel.priceFormatted).toBe('£29.00');
    expect(panel.facts.map((fact) => fact.label)).toContain('Included');
    const ids = panel.sections.map((section) => section.id);
    expect(ids).toContain('payment-recovery');
    expect(ids).toContain('payment-recovery-pauses');
    expect(ids).toContain('payment-recovery-preserved');
    expect(ids).toContain('payment-recovery-after');
  });

  it('BILL-238 the recovery policy is reachable from the pre-checkout text, not just from a constant', () => {
    const text = preCheckoutDisclosureText();
    expect(text).toContain(`${PAYMENT_RECOVERY_POLICY.graceDays} days`);
    expect(text.toLowerCase()).toContain('new verification runs are not accepted');
    expect(text.toLowerCase()).toContain('cancelling your subscription');
    expect(text.toLowerCase()).toContain('unpaid');
    expect(text.toLowerCase()).toContain('nothing of yours is deleted');
  });

  it('BILL-239 the one sentence that must be visible without expanding anything says all three things', () => {
    const panel = preCheckoutPanel();
    expect(panel.mustBeVisible).toContain('£29.00');
    expect(panel.mustBeVisible).toContain('500 runs');
    expect(panel.mustBeVisible).toContain('7 days');
    expect(panel.mustBeVisible.toLowerCase()).toContain('cancel any time');
  });

  it('BILL-240 every line A05 renders comes from the policy — none of it is retyped copy', () => {
    const panel = preCheckoutPanel();
    const pauses = panel.sections.find((section) => section.id === 'payment-recovery-pauses');
    const preserved = panel.sections.find((section) => section.id === 'payment-recovery-preserved');
    expect(pauses?.lines).toEqual(PAYMENT_RECOVERY_POLICY.whatPauses);
    expect(preserved?.lines).toEqual(PAYMENT_RECOVERY_POLICY.whatStaysAvailable);
  });
});
