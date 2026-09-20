/**
 * `GrowthDataPort` — the exact set of reads and writes the growth path needs from D1.
 *
 * A02 owns `apps/app/src/db/`, so nothing in `growth/` writes SQL. Everything here codes
 * against this interface, `memory.ts` is a faithful in-memory implementation the tests run
 * against today, and the lead wires A02's repositories to the same shape.
 *
 * Contract every implementation must keep:
 *
 *  1. **A visit row is keyed by the daily hash, and a repeat visit is an UPDATE.**
 *     `recordVisit` is `INSERT … ON CONFLICT(id) DO UPDATE SET last_seen_at = ?,
 *     page_views = page_views + 1` and reports which happened through `meta.changes`. A
 *     second request from the same visitor on the same day must never produce a second row.
 *  2. **No raw address is ever passed across this interface.** `VisitSession.id` is
 *     already a salted daily hash; there is no field on any type here an IP could occupy.
 *  3. **Unknown is not zero.** Every count-shaped return is `null` when the read failed or
 *     has never run. An implementation that returns `0` for "I could not read" turns a
 *     broken query into a confident business fact, which is the exact failure this product
 *     exists to complain about.
 *  4. **A failed metrics sync never writes figures.** `recordSyncFailure` touches
 *     `campaigns.last_sync_error` and `campaigns.last_sync_at` only. Previous
 *     `campaign_metrics` rows stay exactly as they were. A stale number honestly labelled
 *     stale beats a fresh-looking zero.
 *  5. **Metrics are unique per (campaign, interval).** `upsertCampaignMetrics` relies on
 *     the `UNIQUE (campaign_id, interval_start, interval_end)` constraint in
 *     `migrations/0001_init.sql`; a re-sync of the same interval updates one row and never
 *     appends a second.
 *  6. **Nothing here decides anything.** Classification, attribution, stop rules and the
 *     approval hash are pure functions in this directory. The port only persists.
 *  7. **A session's classification may only ever move toward exclusion.** On a repeat
 *     visit, `external` or `unknown` may become `internal_test` or `bot_suspected`, and
 *     nothing may move the other way. Added 20 September 2026, after production recorded
 *     two sessions as external that were this project's own browser checks: a browser
 *     cannot send the internal header, so the operator is only recognisable once the
 *     exclusion cookie is set, which happens after the first page view. Without this rule
 *     that first view stays external for the rest of the day, because rule 1 deliberately
 *     refuses to revise how a session began.
 *
 *     The asymmetry is the whole point. Correcting a session INTO an excluded class can
 *     only ever reduce the external figure, so no visitor and no bug can use it to inflate
 *     the number the launch objective is measured by. Allowing the reverse would let a
 *     session that was once recognised as automated be re-counted as a person. For the
 *     same reason `unknown` never becomes `external` either: unknown is not a visitor, and
 *     a later request is not permission to promote one.
 */
import type { VisitClassification, VisitSession } from './analytics';

/* -------------------------------------------------------------------------- */
/* visits                                                                     */
/* -------------------------------------------------------------------------- */

export interface VisitRecordResult {
  /** True on the first sighting of this daily hash; false when an existing row was touched. */
  readonly inserted: boolean;
  /** Page views on the row after the write. */
  readonly pageViews: number;
}

export interface VisitCountQuery {
  /** Inclusive ISO-8601 lower bound on `first_seen_at`. */
  readonly since: string;
  /** Exclusive ISO-8601 upper bound. */
  readonly until: string;
  /** When set, `adAttributed` counts external sessions whose `utm_campaign` equals this. */
  readonly campaignUtm?: string;
}

/**
 * Counts by classification. Every field is a count of *sessions*, which is an estimate of
 * visits and never a count of people — the id rotates every UTC day by design.
 */
export interface VisitCounts {
  readonly external: number;
  readonly adAttributed: number;
  readonly internalTest: number;
  readonly botSuspected: number;
  readonly unknown: number;
  /** When the count was taken. Rendered next to the figure, never omitted. */
  readonly countedAt: string;
}

/* -------------------------------------------------------------------------- */
/* campaign metrics                                                           */
/* -------------------------------------------------------------------------- */

/** Mirrors `campaign_metrics` in `migrations/0001_init.sql`. */
export interface CampaignMetricsRow {
  readonly campaignId: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  /** `null` means the provider did not report it. Never coerce to 0. */
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly spendMinor: number | null;
  readonly currency: string | null;
  readonly receivedAt: string;
}

export interface CampaignSyncState {
  readonly lastSyncAt: string | null;
  readonly lastSyncError: string | null;
}

/* -------------------------------------------------------------------------- */
/* the port                                                                   */
/* -------------------------------------------------------------------------- */

export interface GrowthDataPort {
  /** Insert-or-touch. See contract rule 1. */
  recordVisit(session: VisitSession, seenAt: string): Promise<VisitRecordResult>;

  /** `null` means the read failed — not that there were no visits. See contract rule 3. */
  countVisits(query: VisitCountQuery): Promise<VisitCounts | null>;

  /** Rows whose `expires_at` has passed. A09's sweep owns the deletion; this is for proof. */
  countExpiredVisits(now: string): Promise<number | null>;

  /** One row per (campaign, interval). See contract rule 5. */
  upsertCampaignMetrics(row: CampaignMetricsRow): Promise<{ readonly inserted: boolean }>;

  /** The newest interval we hold for this campaign, or `null` if we hold none. */
  latestCampaignMetrics(campaignId: string): Promise<CampaignMetricsRow | null>;

  /** Records the failure against the campaign. Writes no figures. See contract rule 4. */
  recordSyncFailure(campaignId: string, error: string, at: string): Promise<void>;

  /** Clears `last_sync_error` and stamps `last_sync_at`. */
  recordSyncSuccess(campaignId: string, at: string): Promise<void>;

  campaignSyncState(campaignId: string): Promise<CampaignSyncState | null>;
}

/* -------------------------------------------------------------------------- */
/* helpers shared by every implementation                                     */
/* -------------------------------------------------------------------------- */

export const EMPTY_VISIT_COUNTS: Omit<VisitCounts, 'countedAt'> = {
  external: 0,
  adAttributed: 0,
  internalTest: 0,
  botSuspected: 0,
  unknown: 0,
};

/** The classification buckets, so an implementation cannot silently miss one. */
export const COUNTED_CLASSIFICATIONS: readonly VisitClassification[] = [
  'external',
  'internal_test',
  'bot_suspected',
  'unknown',
];
