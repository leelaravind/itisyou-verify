/**
 * The payment-recovery window — the founder's approved policy, in one place.
 *
 * Approved 2026-09-19. This file is the single source of the policy: the length, what
 * pauses, what stays available, what resuming requires, and what happens on day 8.
 * `docs/billing.md` §4 restates it in prose, A05 renders `PRE_CHECKOUT_DISCLOSURE` before
 * checkout, and A09's `payment_problem` notification says the same thing. If the founder
 * changes the policy, this file changes and everything downstream follows.
 *
 * Everything here is pure. No clock is read; `nowIso` is always a parameter.
 *
 * ## The anchor, and why it is the period end rather than the failure instant
 *
 * `migrations/0001_init.sql` is frozen and has no grace column, so the window has to be
 * derivable from what we already store. It is: when a renewal invoice is not paid, Stripe
 * does **not** advance the subscription's period, so `current_period_end` stays at the end
 * of the period the customer actually paid for. That instant is exactly the moment service
 * was paid up to, so the window runs seven days from it.
 *
 * This is better than storing the failure instant would have been. It is stable under
 * redelivery (a duplicate `invoice.payment_failed` computes the same deadline), stable
 * under reordering (it does not depend on which event arrived first), and it cannot drift
 * if Stripe retries the card several times inside the window.
 *
 * Fallback: if we have no period end for the subscription, the window is measured from
 * when we recorded the failed state. Stated rather than hidden.
 */
import { LIMITS } from '@verify/contracts';
import { PAYMENT_FAILURE_GRACE_DAYS, PLAN } from './config';
import type { SubscriptionRecord } from './port';
import { entitlementFor, type EntitlementView } from './state';

/** The approved window length in days. One constant; changing it changes the product. */
export const PAYMENT_RECOVERY_DAYS = PAYMENT_FAILURE_GRACE_DAYS;

export interface PaymentRecoveryPolicy {
  readonly graceDays: number;
  readonly headline: string;
  /** What stops. Exactly one thing stops. */
  readonly whatPauses: readonly string[];
  /** What keeps working. No exceptions to this list. */
  readonly whatStaysAvailable: readonly string[];
  /** What it takes to start verifying again. */
  readonly resumeRequires: readonly string[];
  /** What happens on day 8. */
  readonly afterWindow: string;
  /** What happens to their data. Never a deletion path. */
  readonly dataHandling: string;
}

/**
 * The policy as approved.
 *
 * Read this list literally — each line is a commitment, and the tests assert the
 * behaviour behind each one rather than the string.
 */
export const PAYMENT_RECOVERY_POLICY: PaymentRecoveryPolicy = Object.freeze({
  graceDays: PAYMENT_RECOVERY_DAYS,
  headline: `If a monthly payment fails, you get ${PAYMENT_RECOVERY_DAYS} days to fix it. During those ${PAYMENT_RECOVERY_DAYS} days we pause checking new runs, and nothing else changes.`,
  whatPauses: Object.freeze([
    'New verification runs are not accepted, so new enquiries are not being checked.',
  ]),
  whatStaysAvailable: Object.freeze([
    'Signing in to your workspace',
    'Your full run history and every past result',
    'Evidence still inside its retention period',
    'Exporting your data',
    'Updating your payment method',
    'Cancelling your subscription',
  ]),
  resumeRequires: Object.freeze([
    'A successful payment confirmed by our payment provider',
    'Or our scheduled check reading that payment back from the provider’s own records',
  ]),
  afterWindow: `After ${PAYMENT_RECOVERY_DAYS} unpaid days, verification stays paused and the subscription is marked unpaid. It is not cancelled for you, and it does not quietly start again.`,
  dataHandling:
    'Nothing of yours is deleted because of a missed payment. Retention follows our published policy and nothing else — see docs/privacy-retention.md.',
});

/**
 * What A05 renders on the review-and-price step, **before** the customer pays.
 *
 * The policy is disclosed up front, not discovered after a card has failed. A05 imports
 * this and renders it; it does not retype any of it.
 */
export interface PreCheckoutDisclosure {
  readonly priceMinor: number;
  readonly currency: string;
  readonly runsPerPeriod: number;
  readonly interval: 'month';
  readonly allowanceBehaviour: string;
  readonly cancellationBehaviour: string;
  readonly recovery: PaymentRecoveryPolicy;
  readonly refundBehaviour: string;
}

export const PRE_CHECKOUT_DISCLOSURE: PreCheckoutDisclosure = Object.freeze({
  priceMinor: PLAN.amountMinor,
  currency: PLAN.currency,
  runsPerPeriod: PLAN.runsPerPeriod,
  interval: 'month',
  allowanceBehaviour: `${LIMITS.PLAN_RUNS_PER_PERIOD} runs a month. At the limit we stop accepting new runs — we never charge you more than £29 without you choosing to. Unused runs do not carry over.`,
  cancellationBehaviour:
    'Cancel any time. By default you keep the period you have already paid for, and you are not charged again.',
  recovery: PAYMENT_RECOVERY_POLICY,
  refundBehaviour:
    'Refunds are reviewed by a person, not decided automatically. We will tell you the outcome rather than showing you a status that has not happened yet.',
});

// ---------------------------------------------------------------------------
// the window itself
// ---------------------------------------------------------------------------

export type RecoveryPhase =
  /** Paid and being served. */
  | 'serving'
  /** A renewal failed and we are inside the approved window. */
  | 'in_recovery_window'
  /** The window has run out but nothing has marked the subscription unpaid yet. */
  | 'window_elapsed'
  /** Day 8 and beyond: suspended and marked unpaid. Not cancelled. */
  | 'suspended_unpaid'
  /** No subscription, or a state the window does not describe. */
  | 'not_applicable';

export interface PaymentRecoveryWindow {
  readonly phase: RecoveryPhase;
  /** The instant the window opened — the end of the period that was paid for. */
  readonly startedAt: string | null;
  readonly endsAt: string | null;
  /** Whole days left, rounded up. Zero once the window has run out. */
  readonly daysRemaining: number;
  /** True while verification is paused for a payment reason. */
  readonly runsPaused: boolean;
  /** True when a sweep should now mark the subscription unpaid. */
  readonly needsSuspension: boolean;
  readonly anchoredOn: 'period_end' | 'recorded_state' | 'none';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a subscription sits in the recovery window, as at `nowIso`.
 *
 * Pure and total: every subscription status maps to a phase, and a null subscription is
 * `not_applicable` rather than an error.
 */
export function paymentRecoveryWindow(
  subscription: SubscriptionRecord | null,
  nowIso: string,
  graceDays: number = PAYMENT_RECOVERY_DAYS,
): PaymentRecoveryWindow {
  const none: PaymentRecoveryWindow = {
    phase: 'not_applicable',
    startedAt: null,
    endsAt: null,
    daysRemaining: 0,
    runsPaused: false,
    needsSuspension: false,
    anchoredOn: 'none',
  };
  if (subscription === null) return none;

  if (subscription.status === 'active' || subscription.status === 'trialing') {
    return { ...none, phase: 'serving' };
  }

  if (subscription.status === 'unpaid') {
    const anchor = anchorFor(subscription);
    return {
      phase: 'suspended_unpaid',
      startedAt: anchor.startedAt,
      endsAt: anchor.endsAt(graceDays),
      daysRemaining: 0,
      runsPaused: true,
      needsSuspension: false,
      anchoredOn: anchor.anchoredOn,
    };
  }

  if (subscription.status !== 'past_due') {
    // `paused`, `canceled`, `incomplete`, `incomplete_expired`: not a payment-recovery
    // situation, but none of them serve runs either. `entitlementFor` remains the
    // authority on what each means for access.
    return { ...none, runsPaused: true };
  }

  const anchor = anchorFor(subscription);
  const endsAt = anchor.endsAt(graceDays);
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) throw new TypeError(`paymentRecoveryWindow needs an ISO instant`);
  const end = endsAt === null ? null : Date.parse(endsAt);

  if (end === null || now < end) {
    return {
      phase: 'in_recovery_window',
      startedAt: anchor.startedAt,
      endsAt,
      daysRemaining: end === null ? graceDays : Math.max(0, Math.ceil((end - now) / DAY_MS)),
      runsPaused: true,
      needsSuspension: false,
      anchoredOn: anchor.anchoredOn,
    };
  }

  return {
    phase: 'window_elapsed',
    startedAt: anchor.startedAt,
    endsAt,
    daysRemaining: 0,
    runsPaused: true,
    needsSuspension: true,
    anchoredOn: anchor.anchoredOn,
  };
}

function anchorFor(subscription: SubscriptionRecord): {
  startedAt: string | null;
  anchoredOn: 'period_end' | 'recorded_state';
  endsAt: (graceDays: number) => string | null;
} {
  const fromPeriod = subscription.currentPeriodEnd;
  const startedAt = fromPeriod ?? subscription.updatedAt;
  const anchoredOn: 'period_end' | 'recorded_state' =
    fromPeriod === null ? 'recorded_state' : 'period_end';
  return {
    startedAt,
    anchoredOn,
    endsAt: (graceDays: number) => {
      const parsed = Date.parse(startedAt);
      return Number.isNaN(parsed) ? null : new Date(parsed + graceDays * DAY_MS).toISOString();
    },
  };
}

/**
 * The entitlement view with the recovery window layered on.
 *
 * Nothing here can *add* entitlement — it only ever pauses. `entitlementFor` remains the
 * authority on whether a subscription is served at all, and this function can turn
 * `serving` into a pause but never the other way round.
 */
export interface RecoveryAwareEntitlement extends EntitlementView {
  readonly recovery: PaymentRecoveryWindow;
}

export function entitlementWithRecovery(
  subscription: SubscriptionRecord | null,
  nowIso: string,
  graceDays: number = PAYMENT_RECOVERY_DAYS,
): RecoveryAwareEntitlement {
  const base = entitlementFor(subscription);
  const recovery = paymentRecoveryWindow(subscription, nowIso, graceDays);
  if (!recovery.runsPaused) return { ...base, recovery };
  return {
    ...base,
    admitsNewRuns: false,
    // Access and cancellation are preserved in every phase of the window, without
    // exception. This is the founder's requirement 2 expressed as code.
    accountAccessible: true,
    cancellationAvailable: base.cancellationAvailable || recovery.phase !== 'not_applicable',
    recovery,
  };
}

/**
 * The customer-facing sentence about what is happening.
 *
 * Says the thing they care about — new runs are not being checked — rather than a generic
 * "billing issue". Requirement 3.
 */
export function recoveryStatement(window: PaymentRecoveryWindow): string {
  switch (window.phase) {
    case 'serving':
      return 'Your subscription is active and new runs are being checked.';
    case 'in_recovery_window':
      return `We could not take your last payment, so we have paused checking new runs. Your workspace, your history and your evidence are all still here, and you can update your card or cancel at any time. You have ${window.daysRemaining} day${window.daysRemaining === 1 ? '' : 's'} to fix it before the subscription is marked unpaid.`;
    case 'window_elapsed':
    case 'suspended_unpaid':
      return 'We could not take your last payment within the recovery window, so checking new runs is suspended and the subscription is marked unpaid. Nothing has been deleted and nothing has been cancelled — you can still sign in, read your history, export your data, update your card or cancel.';
    case 'not_applicable':
    default:
      return 'There is no payment problem on this workspace.';
  }
}
