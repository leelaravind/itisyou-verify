/**
 * Pure state: the order machine and subscription reconciliation.
 *
 * No I/O, no clock, no database, no `fetch`. Everything here is a function of its
 * arguments, which is why the out-of-order webhook logic lives here — it is the part that
 * must be exhaustively testable, and it is the part where a mistake is a customer who
 * paid and got nothing, or a cancelled subscription that quietly came back to life.
 *
 * Two independent guards protect subscription state:
 *
 *  1. **Monotonic.** `subscriptions.provider_event_created` records the `created`
 *     timestamp of the provider event that last wrote the row. An event with a smaller
 *     value is ignored. Stripe states plainly that it "doesn't guarantee the delivery of
 *     events in the order that they're generated"
 *     (https://docs.stripe.com/webhooks, checked 2026-09-19).
 *  2. **Terminal.** Stripe also documents that a cancelled subscription "is largely
 *     immutable" (https://docs.stripe.com/api/subscriptions/cancel). Once we have stored
 *     `canceled`, no event moves it to another status — including one that shares the
 *     same `created` second, because Stripe warns that "distinct events can share a
 *     timestamp" and tells you not to order by `created`. Guard 1 alone would not stop a
 *     same-second `customer.subscription.updated` from re-enabling a deleted
 *     subscription. Guard 2 does.
 */
import type { OrderStatus, SubscriptionStatus } from '@verify/contracts';
import { SUBSCRIPTION_STATUS } from '@verify/contracts';
import type { BillingEnvironment } from './config';
import type { SubscriptionRecord } from './port';

// ---------------------------------------------------------------------------
// order state machine
// ---------------------------------------------------------------------------

/**
 * What can happen to an order. Deliberately named after the business event, not after the
 * status it produces, so an event can be rejected in a state rather than silently applied.
 */
export type OrderEvent =
  | { readonly kind: 'eligibility_passed' }
  | { readonly kind: 'eligibility_failed'; readonly reason: string }
  | { readonly kind: 'checkout_created'; readonly checkoutSessionId: string }
  | { readonly kind: 'checkout_expired' }
  | { readonly kind: 'checkout_completed_unpaid' }
  | { readonly kind: 'payment_succeeded' }
  | { readonly kind: 'payment_failed' }
  | { readonly kind: 'subscription_cancelled' }
  | { readonly kind: 'refund_succeeded' };

export type OrderTransition =
  | { readonly allowed: true; readonly next: OrderStatus; readonly rejectionReason?: string }
  | { readonly allowed: false; readonly from: OrderStatus; readonly event: OrderEvent['kind'] };

/** Statuses from which nothing further happens. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'expired',
  'cancelled',
  'refunded',
  'rejected',
]);

/**
 * The order machine.
 *
 * Note what is *absent*: there is no transition from a browser. `payment_succeeded` is
 * only ever produced by a signature-verified webhook or by reconciliation against
 * Stripe's own records — never by the customer arriving at the success URL.
 */
export function orderTransition(from: OrderStatus, event: OrderEvent): OrderTransition {
  const no = (): OrderTransition => ({ allowed: false, from, event: event.kind });

  switch (event.kind) {
    case 'eligibility_passed':
      return from === 'draft' || from === 'compatible'
        ? { allowed: true, next: 'compatible' }
        : no();

    case 'eligibility_failed':
      // Rejection happens before payment wherever possible, with an actionable reason.
      return from === 'draft' || from === 'compatible'
        ? { allowed: true, next: 'rejected', rejectionReason: event.reason }
        : no();

    case 'checkout_created':
      return from === 'compatible' || from === 'checkout_created'
        ? { allowed: true, next: 'checkout_created' }
        : no();

    case 'checkout_expired':
      return from === 'checkout_created' || from === 'payment_pending'
        ? { allowed: true, next: 'expired' }
        : no();

    case 'checkout_completed_unpaid':
      return from === 'checkout_created' || from === 'payment_pending'
        ? { allowed: true, next: 'payment_pending' }
        : no();

    case 'payment_succeeded':
      // Also legal from `active`: a redelivered event must be a no-op, not a rejection.
      return from === 'checkout_created' || from === 'payment_pending' || from === 'active'
        ? { allowed: true, next: 'active' }
        : no();

    case 'payment_failed':
      return from === 'checkout_created' || from === 'payment_pending' || from === 'active'
        ? { allowed: true, next: 'failed' }
        : no();

    case 'subscription_cancelled':
      return from === 'active' || from === 'failed' || from === 'payment_pending'
        ? { allowed: true, next: 'cancelled' }
        : no();

    case 'refund_succeeded':
      return from === 'active' || from === 'cancelled' || from === 'failed'
        ? { allowed: true, next: 'refunded' }
        : no();

    default: {
      const exhaustive: never = event;
      return { allowed: false, from, event: (exhaustive as OrderEvent).kind };
    }
  }
}

// ---------------------------------------------------------------------------
// subscription reconciliation
// ---------------------------------------------------------------------------

/** A snapshot of provider truth, from a webhook or from a read against Stripe. */
export interface ProviderSubscriptionSnapshot {
  readonly providerSubscriptionId: string;
  readonly environment: BillingEnvironment;
  readonly status: SubscriptionStatus;
  readonly priceId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** `event.created` in unix seconds. For a direct API read, use the read time. */
  readonly providerEventCreated: number;
}

export type SubscriptionDecision =
  | { readonly action: 'insert'; readonly next: ProviderSubscriptionSnapshot }
  | { readonly action: 'apply'; readonly next: ProviderSubscriptionSnapshot }
  | { readonly action: 'ignore_stale'; readonly storedEventCreated: number }
  | { readonly action: 'ignore_duplicate' }
  | { readonly action: 'ignore_terminal'; readonly storedStatus: SubscriptionStatus }
  | { readonly action: 'reject_environment_mismatch'; readonly storedEnvironment: BillingEnvironment };

/**
 * Decide what an incoming provider snapshot does to what we have stored.
 *
 * Returning a decision rather than mutating is the point: the caller persists, the tests
 * assert on the decision, and nothing about ordering depends on a database.
 */
export function reconcileSubscription(
  stored: SubscriptionRecord | null,
  incoming: ProviderSubscriptionSnapshot,
): SubscriptionDecision {
  if (stored === null) return { action: 'insert', next: incoming };

  if (stored.environment !== incoming.environment) {
    return { action: 'reject_environment_mismatch', storedEnvironment: stored.environment };
  }

  // Guard 2, checked first: a cancelled subscription never comes back. A stale
  // `customer.subscription.updated` carrying `active` is exactly the event this stops,
  // and it stops it even when the two events share a `created` second.
  if (stored.status === 'canceled' && incoming.status !== 'canceled') {
    return { action: 'ignore_terminal', storedStatus: stored.status };
  }

  // Guard 1: monotonic on the provider event timestamp.
  if (incoming.providerEventCreated < stored.providerEventCreated) {
    return { action: 'ignore_stale', storedEventCreated: stored.providerEventCreated };
  }

  if (
    incoming.providerEventCreated === stored.providerEventCreated &&
    incoming.status === stored.status &&
    incoming.priceId === stored.priceId &&
    incoming.currentPeriodEnd === stored.currentPeriodEnd &&
    incoming.cancelAtPeriodEnd === stored.cancelAtPeriodEnd
  ) {
    return { action: 'ignore_duplicate' };
  }

  return { action: 'apply', next: incoming };
}

// ---------------------------------------------------------------------------
// entitlement derived from provider evidence
// ---------------------------------------------------------------------------

/**
 * Statuses under which we admit new verification runs.
 *
 * `trialing` is included because Stripe treats it as a served state; we sell no trial in
 * v1, so in practice this only ever means someone configured one in the dashboard.
 */
export const SERVING_SUBSCRIPTION_STATUSES: ReadonlySet<SubscriptionStatus> =
  new Set<SubscriptionStatus>(['active', 'trialing']);

/**
 * Statuses that keep the account reachable but pause new runs. `past_due` is the failed
 * renewal: the customer can still sign in, read history, fix their card and cancel.
 */
export const GRACE_SUBSCRIPTION_STATUSES: ReadonlySet<SubscriptionStatus> =
  new Set<SubscriptionStatus>(['past_due', 'unpaid', 'paused']);

export type ServiceLevel = 'serving' | 'paused_payment' | 'not_entitled';

export interface EntitlementView {
  readonly level: ServiceLevel;
  /** True only for `serving`. This is the single flag the run admission path reads. */
  readonly admitsNewRuns: boolean;
  readonly accountAccessible: boolean;
  readonly cancellationAvailable: boolean;
  readonly reason: string;
}

/**
 * Turn stored provider evidence into the internal entitlement snapshot.
 *
 * There is no input here the frontend can supply. The argument is a row we wrote from a
 * verified webhook or an API read; a request body cannot reach this function.
 */
export function entitlementFor(subscription: SubscriptionRecord | null): EntitlementView {
  if (subscription === null) {
    return {
      level: 'not_entitled',
      admitsNewRuns: false,
      accountAccessible: true,
      cancellationAvailable: false,
      reason: 'no_subscription',
    };
  }
  if (SERVING_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    return {
      level: 'serving',
      admitsNewRuns: true,
      accountAccessible: true,
      cancellationAvailable: true,
      reason: subscription.cancelAtPeriodEnd ? 'serving_until_period_end' : 'serving',
    };
  }
  if (GRACE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    return {
      level: 'paused_payment',
      admitsNewRuns: false,
      accountAccessible: true,
      cancellationAvailable: true,
      reason: `payment_${subscription.status}`,
    };
  }
  return {
    level: 'not_entitled',
    admitsNewRuns: false,
    accountAccessible: true,
    cancellationAvailable: false,
    reason: `subscription_${subscription.status}`,
  };
}

/** Narrow an unknown provider string to the frozen vocabulary, or `null`. */
export function asSubscriptionStatus(value: unknown): SubscriptionStatus | null {
  return typeof value === 'string' &&
    (SUBSCRIPTION_STATUS as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    : null;
}

/**
 * The UTC date component of an ISO instant.
 *
 * A date rather than a month, because Stripe's billing anchor is the subscription's own
 * start day — a customer who subscribes on the 20th gets periods that run 20th to 20th,
 * and a `YYYY-MM` key would roll their allowance over on a day they are not billed.
 */
export function billingPeriodKey(instantIso: string): string {
  const day = instantIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`billing period key needs an ISO instant, received: ${instantIso}`);
  }
  return day;
}

/**
 * The key an allowance period is stored under: the UTC date the paid period **ends**.
 *
 * The end, not the start, and this is load-bearing. Two different events tell us about the
 * same period — `customer.subscription.*` carries `items.data[].current_period_end`, and
 * `invoice.paid` carries its line item's `period.end` — and both give the end *exactly*.
 * Neither carries a start we can trust to agree: deriving one by stepping a month
 * backwards lands on a 30- or 31-day boundary depending on the month, so the two sources
 * would produce two different keys for one period and `UNIQUE (workspace_id,
 * billing_period)` would let both rows exist. That is 1,000 runs sold for £29.
 *
 * Keying on the end makes the two sources agree by construction.
 */
export function allowancePeriodKey(periodEndIso: string): string {
  return billingPeriodKey(periodEndIso);
}

/** Unix seconds to an ISO-8601 UTC instant, or `null`. Stripe times are always seconds. */
export function unixToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(Math.trunc(seconds) * 1000).toISOString();
}

/**
 * The instant a payment-failure grace period ends.
 *
 * Measured from the failure, not from the period end, so the customer gets the disclosed
 * number of days however late in the cycle the renewal failed.
 */
export function graceDeadline(failedAtIso: string, graceDays: number): string {
  const failedAt = Date.parse(failedAtIso);
  if (Number.isNaN(failedAt)) throw new TypeError(`graceDeadline needs an ISO instant`);
  return new Date(failedAt + graceDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Whether a mode-mismatched event should be processed. It never should. */
export function providerModeMatches(
  eventLivemode: boolean,
  environment: BillingEnvironment,
): boolean {
  return eventLivemode === (environment === 'live');
}
