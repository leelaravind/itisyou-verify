/**
 * One-shot provisioning of the £29/month GBP product and price.
 *
 * ## Why this is a Worker route and not a local CLI
 *
 * The brief asked for a script. There is no TypeScript runner in this repository —
 * `node_modules/.bin` has `tsc`, `vitest`, `eslint`, `prettier`, `wrangler` and nothing
 * that executes a `.ts` file directly — and adding one would be a new dependency, which
 * is out. Duplicating the Stripe calls into a plain `.mjs` would put money-touching code
 * in two places, which is worse than either.
 *
 * Running it inside the Worker is better than working around that anyway:
 *
 *  - The secret key never leaves the Worker secret store. It is never on a laptop, never
 *    in a shell history, never in a CI log.
 *  - The same environment guard that protects the webhook path protects this, rather than
 *    a second implementation of "are we in test mode".
 *  - It is still one command: a `curl` with the owner bootstrap token.
 *
 * ## The guarantees
 *
 *  - **Refuses to run without a key.** 422, naming the missing secret, no call attempted.
 *  - **Refuses live mode outright.** Going live is a separate, authorised step; this
 *    endpoint returns 403 for a live key or `STRIPE_MODE=live` and makes no call.
 *  - **Idempotent.** Keyed on the price `lookup_key`. A second run returns the existing
 *    price id and creates nothing. A lookup key already in use on different terms is
 *    refused rather than duplicated.
 *  - **Never prints the key.** The response and every log line carry the price id, the
 *    product id and the mode. `StripeError` scrubs any key-shaped string out of a message
 *    before it can be thrown, so even a provider error that echoed the key cannot escape.
 *  - **Authorised.** Requires the owner bootstrap token, compared in constant time.
 */
import { Hono } from 'hono';
import { timingSafeEqual } from '@verify/security';
import { PLAN } from './config';
import { billingEnvironmentOf, BILLING_SECRET_NAMES, type BillingEnv } from './mount';

/**
 * The slice of the connector this needs. Declared structurally so `apps/app` does not
 * import `@verify/connectors` — A04's barrel does not export `stripe.ts`, and the
 * composition root passes `createStripeClient(...)` in, which satisfies this by shape.
 */
export interface ProvisioningGateway {
  readonly environment: 'test' | 'live';
  ensureProductAndPrice(params: {
    readonly idempotencyKey: string;
    readonly lookupKey: string;
    readonly productName: string;
    readonly productDescription?: string;
    readonly unitAmountMinor: number;
    readonly currency: 'gbp' | 'usd' | 'eur';
    readonly interval?: 'month' | 'year';
  }): Promise<{
    readonly priceId: string;
    readonly productId: string;
    readonly created: boolean;
    readonly environment: 'test' | 'live';
    readonly unitAmountMinor: number;
    readonly currency: string;
  }>;
}

export type ProvisionOutcome =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly priceId: string;
      readonly productId: string;
      readonly created: boolean;
      readonly mode: 'test';
      readonly amountMinor: number;
      readonly currency: string;
      /** What the lead does next, in one line. */
      readonly nextStep: string;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 422 | 502;
      readonly code: ProvisionFailureCode;
      readonly message: string;
    };

export type ProvisionFailureCode =
  | 'STRIPE_KEY_MISSING'
  | 'LIVE_MODE_REFUSED'
  | 'MODE_MISMATCH'
  | 'PROVIDER_ERROR';

/**
 * The deterministic idempotency key for the bootstrap calls.
 *
 * Keyed on the plan code and version with no time component, so a re-run presents the same
 * key to Stripe and Stripe returns the original objects rather than making new ones. Two
 * layers of idempotency, then: this key, and the `lookup_key` search the helper does first.
 */
export function provisionIdempotencyKey(): string {
  return `bootstrap:${PLAN.code}:v${PLAN.version}`;
}

/**
 * Do it. Pure orchestration over the gateway — no HTTP, no environment reading beyond what
 * is passed in, so every branch below is testable without a Worker.
 */
export async function provisionPlanPrice(params: {
  readonly env: BillingEnv;
  /** Built by the caller only once the guards below have passed. */
  readonly gateway: ProvisioningGateway | null;
}): Promise<ProvisionOutcome> {
  const { env, gateway } = params;

  // 1. Live mode is refused before anything else, including before a key is looked at.
  //    Going live is a separate, authorised step and must never be reachable by accident.
  let mode: 'test' | 'live';
  try {
    mode = billingEnvironmentOf(env);
  } catch (error) {
    return {
      ok: false,
      status: 422,
      code: 'MODE_MISMATCH',
      message: error instanceof Error ? error.message : 'STRIPE_MODE is not valid.',
    };
  }
  if (mode === 'live') {
    return {
      ok: false,
      status: 403,
      code: 'LIVE_MODE_REFUSED',
      message:
        'Refusing to provision in live mode. This endpoint only ever runs against test mode; ' +
        'creating the live product and price is a separate, authorised step.',
    };
  }

  // 2. No key, no call.
  const key = env.STRIPE_SECRET_KEY;
  if (typeof key !== 'string' || key.trim().length === 0) {
    return {
      ok: false,
      status: 422,
      code: 'STRIPE_KEY_MISSING',
      message: `${BILLING_SECRET_NAMES.secretKey} is not set. Provision it as a Worker secret first. Nothing was sent to Stripe.`,
    };
  }
  if (gateway === null) {
    return {
      ok: false,
      status: 422,
      code: 'STRIPE_KEY_MISSING',
      message: 'No Stripe client was supplied. Nothing was sent to Stripe.',
    };
  }

  // 3. Belt and braces: the key itself must be a test key, whatever STRIPE_MODE claims.
  //    A live key with `STRIPE_MODE=test` is a misconfiguration that would otherwise
  //    create real objects in the owner's live account.
  if (gateway.environment !== 'test') {
    return {
      ok: false,
      status: 403,
      code: 'LIVE_MODE_REFUSED',
      message:
        'The configured Stripe key is a live key. Refusing to provision. Nothing was sent to Stripe.',
    };
  }

  try {
    const result = await gateway.ensureProductAndPrice({
      idempotencyKey: provisionIdempotencyKey(),
      lookupKey: PLAN.lookupKey,
      productName: PLAN.displayName,
      productDescription: `One workflow, ${PLAN.runsPerPeriod} verification runs per month.`,
      unitAmountMinor: PLAN.amountMinor,
      currency: 'gbp',
      interval: 'month',
    });

    if (result.environment !== 'test') {
      return {
        ok: false,
        status: 403,
        code: 'LIVE_MODE_REFUSED',
        message: 'Stripe returned a live-mode object. Refusing to record it.',
      };
    }

    return {
      ok: true,
      status: 200,
      priceId: result.priceId,
      productId: result.productId,
      created: result.created,
      mode: 'test',
      amountMinor: result.unitAmountMinor,
      currency: result.currency,
      nextStep: `Set ${BILLING_SECRET_NAMES.priceId}=${result.priceId} as a Worker secret, then redeploy.`,
    };
  } catch (error) {
    // `StripeError` has already scrubbed any key-shaped string out of its message. This
    // re-reads only the message, never the cause chain, so nothing unscrubbed escapes.
    return {
      ok: false,
      status: 502,
      code: 'PROVIDER_ERROR',
      message: error instanceof Error ? error.message : 'Stripe call failed.',
    };
  }
}

export interface ProvisionRouteDeps {
  readonly env: BillingEnv;
  /** The owner bootstrap token. Absent means the endpoint is closed entirely. */
  readonly bootstrapToken?: string | undefined;
  /** Built lazily so no client is constructed for an unauthorised request. */
  readonly createGateway: () => ProvisioningGateway | null;
  readonly log?: (entry: Record<string, string | number | boolean>) => void;
}

/**
 * `POST /api/v1/billing/provision-price`
 *
 * Owner-only. Returns 404 rather than 401 for a bad or missing token, so the endpoint's
 * existence is not confirmed to anyone who cannot already use it — the same rule the owner
 * routes follow.
 */
export function createProvisionRoute(deps: ProvisionRouteDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? (() => undefined);

  app.post('/api/v1/billing/provision-price', async (c) => {
    const token = deps.bootstrapToken;
    const presented = c.req.header('x-owner-bootstrap-token') ?? '';
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      presented.length === 0 ||
      !timingSafeEqual(token, presented)
    ) {
      // Never confirms the route exists.
      return c.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    }

    const outcome = await provisionPlanPrice({
      env: deps.env,
      gateway: deps.createGateway(),
    });

    if (outcome.ok) {
      log({
        event: 'billing_price_provisioned',
        price_id: outcome.priceId,
        product_id: outcome.productId,
        created: outcome.created,
        mode: outcome.mode,
      });
      return c.json(
        {
          price_id: outcome.priceId,
          product_id: outcome.productId,
          created: outcome.created,
          mode: outcome.mode,
          amount_minor: outcome.amountMinor,
          currency: outcome.currency,
          next_step: outcome.nextStep,
        },
        200,
      );
    }

    log({ event: 'billing_price_provision_refused', code: outcome.code });
    return c.json({ error: { code: outcome.code, message: outcome.message } }, outcome.status);
  });

  return app;
}
