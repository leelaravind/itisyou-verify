/**
 * The approved commercial configuration.
 *
 * Every price, currency, allowance and URL a money path uses is resolved from here, on the
 * server, from constants that live in the frozen contract. Nothing in this file reads a
 * request. That is the whole point: brief rule 5 says never trust a browser-supplied
 * price, amount, workspace id or subscription status, and the way to keep that true is to
 * have exactly one function that produces a plan and for it to take no untrusted input.
 */
import { LIMITS, type Currency } from '@verify/contracts';

export type BillingEnvironment = 'test' | 'live';

/** The one plan v1 sells. See `docs/product-scope.md` §6. */
export interface PlanDefinition {
  readonly code: 'verify_single_workflow_monthly';
  readonly version: number;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly interval: 'month';
  readonly runsPerPeriod: number;
  /** Stripe price `lookup_key`; the bootstrap helper keys off this. */
  readonly lookupKey: string;
}

/**
 * Plan version. Bump when the commercial terms change so an existing entitlement row
 * records which terms it was opened under. Never re-price an open period.
 */
export const PLAN_VERSION = 1;

export const PLAN: PlanDefinition = Object.freeze({
  code: 'verify_single_workflow_monthly',
  version: PLAN_VERSION,
  displayName: 'ITISYOU Verify — one workflow',
  amountMinor: LIMITS.PLAN_PRICE_PENCE,
  currency: 'GBP',
  interval: 'month',
  runsPerPeriod: LIMITS.PLAN_RUNS_PER_PERIOD,
  lookupKey: 'verify_single_workflow_monthly_gbp_v1',
});

/**
 * The payment-recovery window for a failed renewal, in days.
 *
 * **Approved by the founder on 2026-09-19.** During the window: new verification runs are
 * paused, and nothing else stops — sign-in, run history, evidence within retention, data
 * export, payment-method update and cancellation all stay available. On day 8 the
 * subscription is marked `unpaid` and stays suspended; it is never cancelled for the
 * customer and nothing is ever deleted for non-payment.
 *
 * The behaviour lives in `policy.ts` and `recovery.ts`; `docs/billing.md` §4 is the prose.
 * This constant is the only place the length exists.
 */
export const PAYMENT_FAILURE_GRACE_DAYS = 7;

/** A webhook body larger than this is refused before it is parsed. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface BillingConfig {
  readonly environment: BillingEnvironment;
  readonly plan: PlanDefinition;
  /** Resolved once at boot from the Stripe price id secret/binding. */
  readonly priceId: string;
  readonly publicBaseUrl: string;
  readonly gracePeriodDays: number;
}

export interface BillingConfigInput {
  readonly environment: BillingEnvironment;
  readonly priceId: string;
  readonly publicBaseUrl: string;
  readonly gracePeriodDays?: number;
}

/**
 * Build the config. Throws on anything that would let a money path run half-configured —
 * a 422 at boot is far cheaper than a checkout that charges the wrong amount.
 */
export function buildBillingConfig(input: BillingConfigInput): BillingConfig {
  if (input.environment !== 'test' && input.environment !== 'live') {
    throw new TypeError(
      `billing environment must be test or live, received ${String(input.environment)}`,
    );
  }
  if (typeof input.priceId !== 'string' || !/^price_[A-Za-z0-9]+$/.test(input.priceId)) {
    throw new TypeError('billing price id is missing or does not look like a Stripe price id');
  }
  if (!/^https:\/\/[^/]+$/.test(input.publicBaseUrl)) {
    throw new TypeError('public base URL must be an https origin with no trailing path');
  }
  return Object.freeze({
    environment: input.environment,
    plan: PLAN,
    priceId: input.priceId,
    publicBaseUrl: input.publicBaseUrl,
    gracePeriodDays: input.gracePeriodDays ?? PAYMENT_FAILURE_GRACE_DAYS,
  });
}

/** Where Stripe sends the browser back to. Both are our own origin, never customer input. */
export function checkoutReturnUrls(config: BillingConfig): {
  readonly successUrl: string;
  readonly cancelUrl: string;
} {
  return {
    // The placeholder is Stripe's; it is substituted by Stripe, not by us, and the page it
    // lands on is read-only — it never activates anything.
    successUrl: `${config.publicBaseUrl}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.publicBaseUrl}/app/billing?checkout=cancelled`,
  };
}

export function portalReturnUrl(config: BillingConfig): string {
  return `${config.publicBaseUrl}/app/billing`;
}

/**
 * The plan, resolved server-side.
 *
 * Takes no argument on purpose. If a future plan picker arrives it must take a plan
 * *code* validated against a closed list, never an amount or a price id.
 */
export function resolvePlan(): PlanDefinition {
  return PLAN;
}
