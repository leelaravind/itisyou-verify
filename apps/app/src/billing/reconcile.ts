/**
 * Scheduled reconciliation: compare what we believe against Stripe's own records.
 *
 * It **reports, and repairs exactly one thing.**
 *
 * Reporting is the default and the rule. A reconciliation that silently fixes state is how
 * a bug in the webhook handler becomes invisible, and how a cancelled subscription gets
 * quietly re-enabled by a job nobody is watching. Every disagreement comes back as a typed
 * discrepancy for the owner.
 *
 * ## The one exception: payment recovery
 *
 * The founder's requirement 4 names two ways verification may resume — "a signature-verified
 * webhook, **or** our scheduled check reading that payment back from the provider's own
 * records" — and `PAYMENT_RECOVERY_POLICY.resumeRequires` promises the customer exactly
 * that. A reconciliation that could only detect would make that a published promise with
 * nothing behind it, which is the same class of defect as claiming a coverage mode we do
 * not implement.
 *
 * So when we hold a payment-paused status and Stripe's own records say the subscription is
 * being served, that is provider-confirmed payment and we apply it. The repair is
 * deliberately narrow:
 *
 *  - **One direction only.** It can move `past_due` / `unpaid` / `paused` to `active` or
 *    `trialing`. It can never move anything *to* a paused or cancelled state — that is
 *    reported, never applied, because "Stripe says cancelled" is exactly the case where a
 *    bug in our webhook handling should be visible rather than papered over.
 *  - **Through the same guards.** It goes through `reconcileSubscription()`, so the
 *    terminal-cancellation guard still holds: a cancelled subscription is never
 *    resurrected, whatever Stripe returns (`BILL-152`).
 *  - **Reported, not silent.** Every recovery appears in the report's `recovered` list. The
 *    owner sees that it happened; it is not a state change nobody can account for.
 *
 * Everything else — a status drifting the other way, a price change, a period-end
 * mismatch, a missing allowance row — is still reported and never touched.
 *
 * This is the second of the only two things permitted to change entitlement: a
 * signature-verified webhook, or a read against Stripe's own records. A customer arriving
 * at a URL is neither.
 */
import { rollover } from './entitlements';
import { allowancePeriodKey } from './period';
import type { SubscriptionRecord } from './port';
import type { BillingRuntime } from './runtime';
import {
  SERVING_SUBSCRIPTION_STATUSES,
  asSubscriptionStatus,
  entitlementFor,
  reconcileSubscription,
  unixToIso,
} from './state';

export type DiscrepancyKind =
  | 'status_mismatch'
  | 'price_mismatch'
  | 'period_end_mismatch'
  | 'cancel_at_period_end_mismatch'
  | 'missing_at_provider'
  | 'environment_mismatch'
  | 'allowance_period_missing'
  | 'provider_unreadable';

export interface Discrepancy {
  readonly kind: DiscrepancyKind;
  readonly workspaceId: string;
  readonly subscriptionId: string;
  readonly providerSubscriptionId: string;
  /** What we have stored. Always a short string an owner can read. */
  readonly ours: string;
  /** What Stripe says. `null` when we could not read it. */
  readonly theirs: string | null;
  /** Plain language. This goes in front of a person, not a log parser. */
  readonly note: string;
}

/**
 * A subscription whose payment we confirmed against Stripe's own records, and resumed.
 *
 * Listed rather than merely counted: a state change made by a background job must be
 * accountable to a person afterwards.
 */
export interface PaymentRecovered {
  readonly workspaceId: string;
  readonly subscriptionId: string;
  readonly providerSubscriptionId: string;
  readonly from: string;
  readonly to: string;
}

export interface ReconciliationReport {
  readonly checkedAt: string;
  readonly environment: string;
  readonly examined: number;
  readonly agreed: number;
  readonly discrepancies: readonly Discrepancy[];
  /** Rows we could not read at all. Not a discrepancy in our data — a provider problem. */
  readonly unreadable: number;
  /** Payment recoveries applied on this pass. Empty on a pass that changed nothing. */
  readonly recovered: readonly PaymentRecovered[];
}

export interface ReconcileOptions {
  readonly limit?: number;
  /**
   * Apply confirmed payment recoveries. Default true — it is the promise the policy makes.
   * Set false for a dry run that only reports.
   */
  readonly applyPaymentRecovery?: boolean;
}

export async function reconcileSubscriptions(
  deps: BillingRuntime,
  options: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const { config, data, gateway, now } = deps;
  const checkedAt = now();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const stored = await data.listSubscriptionsForReconciliation(config.environment, limit);

  const discrepancies: Discrepancy[] = [];
  const recovered: PaymentRecovered[] = [];
  const applyRecovery = options.applyPaymentRecovery ?? true;
  let agreed = 0;
  let unreadable = 0;

  for (const original of stored) {
    let record = original;
    let provider;
    try {
      provider = await gateway.retrieveSubscription(record.providerSubscriptionId);
    } catch (error) {
      const kind = failureKind(error);
      if (kind === 'not_found') {
        discrepancies.push(
          discrepancy(record, 'missing_at_provider', record.status, null, [
            'We hold a subscription Stripe no longer returns.',
            'Nothing has been changed locally. Check the Stripe dashboard before acting.',
          ]),
        );
      } else {
        unreadable += 1;
        discrepancies.push(
          discrepancy(record, 'provider_unreadable', record.status, null, [
            'Stripe could not be read for this subscription on this pass.',
            'This is a provider or network problem, not evidence of drift.',
          ]),
        );
      }
      continue;
    }

    const providerEnvironment = provider.livemode ? 'live' : 'test';
    if (providerEnvironment !== record.environment) {
      discrepancies.push(
        discrepancy(record, 'environment_mismatch', record.environment, providerEnvironment, [
          'The stored mode and the mode Stripe returned disagree.',
          'Treat this as a configuration fault; do not migrate the row automatically.',
        ]),
      );
      continue;
    }

    let matched = true;

    if (provider.status !== record.status) {
      matched = false;
      const providerStatus = asSubscriptionStatus(provider.status);
      const isConfirmedPayment =
        applyRecovery &&
        providerStatus !== null &&
        SERVING_SUBSCRIPTION_STATUSES.has(providerStatus) &&
        !SERVING_SUBSCRIPTION_STATUSES.has(record.status);

      if (isConfirmedPayment && providerStatus !== null) {
        // Requirement 4's second route, and the only repair this job performs. It runs
        // through the same guards as a webhook, so a cancelled subscription is still
        // never resurrected however the provider answers.
        const applied = await applyConfirmedPayment(deps, record, {
          status: providerStatus,
          priceId: providerPriceIdOf(provider),
          currentPeriodEnd: providerPeriodEndOf(provider),
          cancelAtPeriodEnd: provider.cancel_at_period_end,
          at: checkedAt,
        });
        if (applied !== null) {
          recovered.push({
            workspaceId: record.workspaceId,
            subscriptionId: record.id,
            providerSubscriptionId: record.providerSubscriptionId,
            from: record.status,
            to: applied.status,
          });
          record = applied;
        } else {
          discrepancies.push(
            discrepancy(record, 'status_mismatch', record.status, provider.status, [
              'Stripe reports this subscription as served, but our guards refused the change.',
              'A cancelled subscription is never resurrected automatically — look at it.',
            ]),
          );
        }
      } else {
        discrepancies.push(
          discrepancy(record, 'status_mismatch', record.status, provider.status, [
            'Our stored subscription status differs from Stripe.',
            'Most often a webhook we never received, or one we rejected as stale.',
            'Nothing has been changed: a drift away from being served is reported, never applied.',
          ]),
        );
      }
    }

    const providerPriceId = providerPriceIdOf(provider);
    if (providerPriceId !== null && providerPriceId !== record.priceId) {
      matched = false;
      discrepancies.push(
        discrepancy(record, 'price_mismatch', record.priceId ?? 'none', providerPriceId, [
          'The subscription is on a different price than we recorded.',
          'Check nobody changed the price in the Stripe dashboard.',
        ]),
      );
    }

    const providerPeriodEnd = providerPeriodEndOf(provider);
    if (providerPeriodEnd !== null && providerPeriodEnd !== record.currentPeriodEnd) {
      matched = false;
      discrepancies.push(
        discrepancy(
          record,
          'period_end_mismatch',
          record.currentPeriodEnd ?? 'none',
          providerPeriodEnd,
          [
            'The billing period we show the customer ends at a different time than Stripe says.',
            'The allowance period key is derived from this, so it matters.',
          ],
        ),
      );
    }

    if (provider.cancel_at_period_end !== record.cancelAtPeriodEnd) {
      matched = false;
      discrepancies.push(
        discrepancy(
          record,
          'cancel_at_period_end_mismatch',
          String(record.cancelAtPeriodEnd),
          String(provider.cancel_at_period_end),
          [
            'We and Stripe disagree about whether this subscription is set to end.',
            'A customer who cancelled in the portal and still sees "renews" is this bug.',
          ],
        ),
      );
    }

    // A serving subscription with no allowance row means admitted runs would be refused.
    if (entitlementFor(record).level === 'serving' && record.currentPeriodEnd !== null) {
      const allowance = await data.findAllowance(
        record.workspaceId,
        allowancePeriodKey(record.currentPeriodEnd),
      );
      if (allowance === null) {
        matched = false;
        discrepancies.push(
          discrepancy(record, 'allowance_period_missing', 'no allowance row', 'serving', [
            'This workspace is being served but holds no allowance row for the period.',
            'New runs would be refused. Open the period before the customer notices.',
          ]),
        );
      }
    }

    if (matched) {
      agreed += 1;
      await data.markSubscriptionReconciled(record.id, checkedAt);
    }
  }

  return {
    checkedAt,
    environment: config.environment,
    examined: stored.length,
    agreed,
    discrepancies,
    unreadable,
    recovered,
  };
}

/**
 * Apply a confirmed payment, through the same guards a webhook goes through.
 *
 * Returns the saved record, or `null` when the guards refused — which happens when the
 * stored subscription is terminally cancelled.
 *
 * `providerEventCreated` is stamped with `max(readTime, storedValue)`, and the `max` is
 * load-bearing. The monotonic guard exists to stop *out-of-order events* overwriting newer
 * state; a direct read of the provider's records is not an event but a point-in-time query
 * of current truth, so letting a stale-event rule veto it is a category error. Without the
 * `max`, any clock skew that left a stored event timestamp ahead of our own clock — Stripe
 * stamps `created` on its clock, we read on ours — would make a workspace permanently
 * unrecoverable by reconciliation, silently. With it, the value never goes backwards, so
 * monotonicity still holds for real events, and current truth still gets through.
 *
 * The terminal-cancellation guard is unaffected: `reconcileSubscription` checks it first
 * and this cannot reach past it.
 */
async function applyConfirmedPayment(
  deps: BillingRuntime,
  stored: SubscriptionRecord,
  next: {
    readonly status: SubscriptionRecord['status'];
    readonly priceId: string | null;
    readonly currentPeriodEnd: string | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly at: string;
  },
): Promise<SubscriptionRecord | null> {
  const decision = reconcileSubscription(stored, {
    providerSubscriptionId: stored.providerSubscriptionId,
    environment: stored.environment,
    status: next.status,
    priceId: next.priceId ?? stored.priceId,
    currentPeriodEnd: next.currentPeriodEnd ?? stored.currentPeriodEnd,
    cancelAtPeriodEnd: next.cancelAtPeriodEnd,
    providerEventCreated: Math.max(
      Math.floor(Date.parse(next.at) / 1000),
      stored.providerEventCreated,
    ),
  });
  if (decision.action !== 'apply' && decision.action !== 'insert') return null;

  const saved = await deps.data.saveSubscriptionSnapshot({
    ...stored,
    status: decision.next.status,
    priceId: decision.next.priceId,
    currentPeriodEnd: decision.next.currentPeriodEnd,
    cancelAtPeriodEnd: decision.next.cancelAtPeriodEnd,
    providerEventCreated: decision.next.providerEventCreated,
    updatedAt: next.at,
  });

  // Being served again means the period's allowance must exist. Idempotent and keyed by
  // the period end, so a resume inside the window resumes on the allowance the customer
  // already has rather than being handed a fresh one.
  if (saved.currentPeriodEnd !== null) {
    const fresh = rollover(deps.config.plan.runsPerPeriod);
    await deps.data.openAllowancePeriod({
      id: deps.newId('ent'),
      workspaceId: saved.workspaceId,
      billingPeriod: allowancePeriodKey(saved.currentPeriodEnd),
      planVersion: deps.config.plan.version,
      runLimit: fresh.runLimit,
      consumed: fresh.consumed,
      reserved: fresh.reserved,
      updatedAt: next.at,
    });
  }
  return saved;
}

function providerPriceIdOf(provider: {
  readonly items?: { readonly data: readonly { readonly price?: { readonly id: string } }[] };
}): string | null {
  return provider.items?.data?.[0]?.price?.id ?? null;
}

function providerPeriodEndOf(provider: {
  readonly items?: { readonly data: readonly { readonly current_period_end?: number }[] };
  readonly current_period_end?: number;
}): string | null {
  return (
    unixToIso(provider.items?.data?.[0]?.current_period_end) ??
    unixToIso(provider.current_period_end)
  );
}

function discrepancy(
  record: SubscriptionRecord,
  kind: DiscrepancyKind,
  ours: string,
  theirs: string | null,
  note: readonly string[],
): Discrepancy {
  return {
    kind,
    workspaceId: record.workspaceId,
    subscriptionId: record.id,
    providerSubscriptionId: record.providerSubscriptionId,
    ours,
    theirs,
    note: note.join(' '),
  };
}

/** Read a connector failure kind without importing the connector. */
function failureKind(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return null;
}
