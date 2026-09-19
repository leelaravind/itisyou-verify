/**
 * The admission gate — the one call a request path makes before accepting work.
 *
 * ## Why this exists
 *
 * The payment-recovery logic was correct and exhaustively tested, and **no request path
 * consulted it**. An auditor put it precisely: tested and working had diverged. A pause
 * that nothing enforces is not a pause; it is a constant in a file.
 *
 * This module closes that. One call answers the whole money question for an arriving
 * event — is this workspace being served, is it inside a payment-recovery window, does it
 * have allowance left, and which allowance period does this run belong to — and returns a
 * verdict the route can act on without knowing any billing rules.
 *
 * ## Where it belongs
 *
 * At the **events route**, before `sourceEvents.admitOnce`. Not inside `admitOnce`:
 *
 *  - `admitOnce` answers a different question. Its conditional `UPDATE` is the atomic gate
 *    on the *allowance* — it is what stops two simultaneous events sharing the last unit.
 *    Entitlement is the prior question of whether we should be doing work for this
 *    workspace at all, and answering it inside the reservation would mean taking a unit
 *    from a workspace we have already decided not to serve.
 *  - The refusals differ. "At your allowance" is a 429-shaped answer about this period;
 *    "your payment failed" is a 402-shaped answer about the account, and the customer
 *    needs to be told which, in words they can act on.
 *  - `admitOnce` needs the billing period key as an argument. Resolving it here means the
 *    key comes from the one function that computes it (`period.ts`), which is the other
 *    half of the A13-010 fix: the admission side can no longer derive its own spelling.
 *
 * Everything here is a read. It reserves nothing — `admitOnce` still does that, atomically,
 * and may still refuse if the last unit went to someone else in between. That race is
 * correct and expected: this gate is the policy answer, the reservation is the arbiter.
 */
import { admissionDecision, type AdmissionKind } from './entitlements';
import { allowancePeriodKeyAt } from './period';
import { entitlementWithRecovery, recoveryStatement } from './policy';
import type { BillingRuntime } from './runtime';

export type { AdmissionKind };

export type AdmissionRefusal =
  /** No subscription at all. Never subscribed, or fully cancelled. */
  | 'not_subscribed'
  /** A renewal failed; inside or past the recovery window. */
  | 'payment_paused'
  /** A subscription exists but is in a state that never serves (incomplete, cancelled). */
  | 'subscription_inactive'
  /** Served, but this period's runs are used up. */
  | 'at_allowance'
  /** Served, but no allowance row exists for the period. A fault, not a limit. */
  | 'no_allowance_period';

export interface AdmissionVerdict {
  readonly admit: boolean;
  /** True only when this arrival should take a unit of allowance. */
  readonly reserves: boolean;
  /**
   * The allowance period this run belongs to, resolved the one permitted way. Pass this
   * straight to `sourceEvents.admitOnce`; never derive one at the call site.
   */
  readonly billingPeriod: string | null;
  readonly refusal: AdmissionRefusal | null;
  /** Suggested HTTP status. 402 is about the account, 429 about this period. */
  readonly httpStatus: 200 | 402 | 409 | 429;
  /** Machine tag for logs and metrics. */
  readonly reason: string;
  /** Plain language, safe to return to the customer. Never mentions another tenant. */
  readonly customerMessage: string;
  /** For the `Retry-After` header on an allowance refusal, when the period end is known. */
  readonly retryAfterIso: string | null;
}

export interface CheckAdmissionParams {
  /** Resolved from the signing key or the session. Never from a request body. */
  readonly workspaceId: string;
  /**
   * What kind of arrival this is. Only `new_run` is ever billable; retries, provider
   * callbacks and internal recovery belong to a unit already held.
   */
  readonly kind?: AdmissionKind;
  /** When the event arrived. Defaults to the runtime clock. */
  readonly atIso?: string;
}

/**
 * Answer the money question for an arriving event.
 *
 * Reads only. Returns a verdict; never throws for a business refusal, because "you are at
 * your allowance" is an answer, not an error.
 */
export async function checkAdmission(
  deps: BillingRuntime,
  params: CheckAdmissionParams,
): Promise<AdmissionVerdict> {
  const { config, data } = deps;
  const at = params.atIso ?? deps.now();
  const kind: AdmissionKind = params.kind ?? 'new_run';

  const subscription = await data.findSubscriptionForWorkspace(
    params.workspaceId,
    config.environment,
  );
  const entitlement = entitlementWithRecovery(subscription, at, config.gracePeriodDays);

  // 1. Is this workspace served at all?
  if (!entitlement.admitsNewRuns) {
    // A retry, a provider callback or internal recovery belongs to a unit already paid
    // for, and is admitted even while new work is paused — refusing it would strand work
    // the customer has already been charged for. This is the same rule the allowance
    // arithmetic keeps, and it must hold at the entitlement level too.
    if (kind !== 'new_run') {
      return {
        admit: true,
        reserves: false,
        billingPeriod: periodFor(subscription, at),
        refusal: null,
        httpStatus: 200,
        reason: `${kind}_holds_existing_reservation`,
        customerMessage: 'Continuing work already accepted.',
        retryAfterIso: null,
      };
    }

    if (subscription === null) {
      return refuse('not_subscribed', 402, 'no_subscription', {
        customerMessage:
          'This workspace does not have an active subscription, so new runs are not being accepted.',
      });
    }
    if (entitlement.recovery.runsPaused && entitlement.recovery.phase !== 'not_applicable') {
      return refuse('payment_paused', 402, `payment_${entitlement.recovery.phase}`, {
        customerMessage: recoveryStatement(entitlement.recovery),
        retryAfterIso: entitlement.recovery.endsAt,
      });
    }
    return refuse('subscription_inactive', 402, entitlement.reason, {
      customerMessage:
        'This workspace is not currently being served, so new runs are not being accepted.',
    });
  }

  // 2. Which allowance period does this run belong to?
  const billingPeriod = periodFor(subscription, at);
  if (billingPeriod === null) {
    return refuse('no_allowance_period', 409, 'no_period_end', {
      customerMessage:
        'We could not work out which billing period this run belongs to. Nothing has been charged; please contact support.',
    });
  }

  const allowance = await data.findAllowance(params.workspaceId, billingPeriod);
  if (allowance === null) {
    // Served, but the row is missing — our fault, not the customer's limit. Reconciliation
    // reports this as `allowance_period_missing`.
    return refuse('no_allowance_period', 409, 'allowance_row_missing', {
      billingPeriod,
      customerMessage:
        'Your plan is active but we could not find this period’s allowance. Nothing has been charged; please contact support.',
    });
  }

  // 3. Is there a unit left?
  const decision = admissionDecision(
    { runLimit: allowance.runLimit, consumed: allowance.consumed, reserved: allowance.reserved },
    kind,
  );
  if (!decision.admit) {
    return refuse('at_allowance', 429, 'at_allowance', {
      billingPeriod,
      retryAfterIso: subscription?.currentPeriodEnd ?? null,
      customerMessage: `All ${allowance.runLimit} runs included in this billing period have been used. New runs resume when the period rolls over. You have not been charged anything extra.`,
    });
  }

  return {
    admit: true,
    reserves: decision.reserves,
    billingPeriod,
    refusal: null,
    httpStatus: 200,
    reason: decision.reason,
    customerMessage: 'Accepted.',
    retryAfterIso: null,
  };
}

function periodFor(
  subscription: { readonly currentPeriodEnd: string | null } | null,
  atIso: string,
): string | null {
  if (subscription === null || subscription.currentPeriodEnd === null) return null;
  return allowancePeriodKeyAt(atIso, subscription.currentPeriodEnd);
}

function refuse(
  refusal: AdmissionRefusal,
  httpStatus: 402 | 409 | 429,
  reason: string,
  extra: {
    readonly customerMessage: string;
    readonly billingPeriod?: string | null;
    readonly retryAfterIso?: string | null;
  },
): AdmissionVerdict {
  return {
    admit: false,
    reserves: false,
    billingPeriod: extra.billingPeriod ?? null,
    refusal,
    httpStatus,
    reason,
    customerMessage: extra.customerMessage,
    retryAfterIso: extra.retryAfterIso ?? null,
  };
}
