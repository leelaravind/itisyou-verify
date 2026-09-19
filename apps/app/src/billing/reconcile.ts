/**
 * Scheduled reconciliation: compare what we believe against Stripe's own records.
 *
 * It **reports**. It does not repair. A reconciliation that silently "fixes" state is how
 * a bug in the webhook handler becomes invisible, and how a cancelled subscription gets
 * quietly re-enabled by a job nobody is watching. Every disagreement comes back as a typed
 * discrepancy for the owner to look at.
 *
 * The one write it performs is `markSubscriptionReconciled`, on rows that agreed. That is
 * a timestamp, not a state change.
 *
 * This is also the second of the only two things permitted to change entitlement: a
 * signature-verified webhook, or a read against Stripe's own records. A customer arriving
 * at a URL is neither.
 */
import { entitlementFor } from './state';
import type { SubscriptionRecord } from './port';
import type { BillingRuntime } from './runtime';
import { allowancePeriodKey, unixToIso } from './state';

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

export interface ReconciliationReport {
  readonly checkedAt: string;
  readonly environment: string;
  readonly examined: number;
  readonly agreed: number;
  readonly discrepancies: readonly Discrepancy[];
  /** Rows we could not read at all. Not a discrepancy in our data — a provider problem. */
  readonly unreadable: number;
}

export interface ReconcileOptions {
  readonly limit?: number;
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
  let agreed = 0;
  let unreadable = 0;

  for (const record of stored) {
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
      discrepancies.push(
        discrepancy(record, 'status_mismatch', record.status, provider.status, [
          'Our stored subscription status differs from Stripe.',
          'Most often a webhook we never received, or one we rejected as stale.',
        ]),
      );
    }

    const providerPriceId = provider.items?.data?.[0]?.price?.id ?? null;
    if (providerPriceId !== null && providerPriceId !== record.priceId) {
      matched = false;
      discrepancies.push(
        discrepancy(record, 'price_mismatch', record.priceId ?? 'none', providerPriceId, [
          'The subscription is on a different price than we recorded.',
          'Check nobody changed the price in the Stripe dashboard.',
        ]),
      );
    }

    const providerPeriodEnd =
      unixToIso(provider.items?.data?.[0]?.current_period_end) ??
      unixToIso(provider.current_period_end);
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
  };
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
