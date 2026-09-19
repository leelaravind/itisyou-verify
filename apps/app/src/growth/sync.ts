/**
 * Applying a metrics sync — and, more importantly, not applying a failed one.
 *
 * The rule the whole file exists for: **a failed sync must never overwrite previous
 * figures with zeros.** A campaign that spent £11.50 yesterday and whose sync failed today
 * must still read £11.50, labelled out of date. Rewriting it to £0.00 would turn a
 * transport failure into a confident statement that nothing has been spent — and that
 * figure is the one the stop rules act on.
 *
 * Also here: the derivation of the budget-ledger idempotency key, so the same reporting
 * interval can be settled against A06's ledger repeatedly without double-counting spend.
 */
import type { CampaignMetricsRow, GrowthDataPort } from './port';

/** What a provider read returned. `failed` carries no figures, by construction. */
export type MetricsSyncResult =
  | {
      readonly kind: 'observed';
      readonly intervalStart: string;
      readonly intervalEnd: string;
      /** `null` where the provider did not report the figure. Never coerced to 0. */
      readonly impressions: number | null;
      readonly clicks: number | null;
      readonly spendMinor: number | null;
      readonly currency: string | null;
    }
  | { readonly kind: 'failed'; readonly error: string };

export type MetricsSyncOutcome =
  | {
      readonly applied: true;
      readonly inserted: boolean;
      readonly row: CampaignMetricsRow;
    }
  | {
      readonly applied: false;
      readonly error: string;
      /** The figures we still hold, untouched. `null` means we never had any. */
      readonly retained: CampaignMetricsRow | null;
      /** Always true: anything we are still showing predates this failed attempt. */
      readonly retainedIsStale: true;
    };

function assertMinor(value: number | null, field: string): void {
  if (value === null) return;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be an integer number of minor units, received ${value}`);
  }
  if (value < 0) {
    throw new TypeError(`${field} must not be negative, received ${value}`);
  }
}

/**
 * Apply one sync result to the store.
 *
 * On `observed`, upserts exactly one row for the (campaign, interval) and clears the
 * campaign's error. On `failed`, records the error against the campaign and **writes no
 * figures at all** — the previous row is returned so the caller can render it with an
 * honest staleness label.
 */
export async function applyMetricsSync(
  port: GrowthDataPort,
  campaignId: string,
  result: MetricsSyncResult,
  at: string,
): Promise<MetricsSyncOutcome> {
  if (result.kind === 'failed') {
    const retained = await port.latestCampaignMetrics(campaignId).catch(() => null);
    await port.recordSyncFailure(campaignId, result.error, at);
    return { applied: false, error: result.error, retained, retainedIsStale: true };
  }

  assertMinor(result.impressions, 'impressions');
  assertMinor(result.clicks, 'clicks');
  assertMinor(result.spendMinor, 'spend_minor');

  const row: CampaignMetricsRow = {
    campaignId,
    intervalStart: result.intervalStart,
    intervalEnd: result.intervalEnd,
    impressions: result.impressions,
    clicks: result.clicks,
    spendMinor: result.spendMinor,
    currency: result.currency,
    receivedAt: at,
  };
  const { inserted } = await port.upsertCampaignMetrics(row);
  await port.recordSyncSuccess(campaignId, at);
  return { applied: true, inserted, row };
}

/* -------------------------------------------------------------------------- */
/* budget ledger                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The idempotency key under which a reporting interval's spend is settled against A06's
 * budget account.
 *
 * Derived purely from the campaign and the interval, so re-syncing the same interval — the
 * normal case, since ad platforms restate recent figures — produces the same key and A06's
 * `budget.settle` returns `{ idempotent: true }` rather than double-counting. It contains
 * no amount: if the provider restates the spend for an interval we have already settled,
 * that is a correction the owner must see, not a second silent deduction.
 */
export function spendIdempotencyKey(
  campaignId: string,
  intervalStart: string,
  intervalEnd: string,
): string {
  return `campaign_spend:${campaignId}:${intervalStart}:${intervalEnd}`;
}

export interface LedgerSettlement {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly source: string;
  readonly at: string;
}

/**
 * Turn an applied metrics row into the settlement A06's ledger expects, or `null` when
 * there is nothing to settle.
 *
 * Returns `null` — rather than a zero-amount movement — when spend is unknown or zero.
 * "The provider has not told us what this cost" and "this cost nothing" are different
 * statements, and neither is a ledger entry.
 */
export function settlementFor(row: CampaignMetricsRow): LedgerSettlement | null {
  if (row.spendMinor === null || row.spendMinor === 0) return null;
  if (!Number.isSafeInteger(row.spendMinor) || row.spendMinor < 0) return null;
  const idempotencyKey = spendIdempotencyKey(row.campaignId, row.intervalStart, row.intervalEnd);
  return {
    entryId: `bge_${idempotencyKey}`,
    idempotencyKey,
    amountMinor: row.spendMinor,
    source: `campaign:${row.campaignId}`,
    at: row.receivedAt,
  };
}
