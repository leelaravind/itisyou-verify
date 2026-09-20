/**
 * `GrowthDataPort` against D1 — the implementation that was never written.
 *
 * ## Why this file exists
 *
 * `growth/visits.ts` is a complete, careful visit counter. `growth/port.ts` states its
 * contract in six numbered rules. `growth/memory.ts` implements that contract faithfully
 * and the suite runs against it. `index.ts` mounts the middleware on every request.
 *
 * And the mount passed **`port: () => null`**, with a comment explaining that a D1 port did
 * not exist yet and that mounting the in-memory one would report "plausible numbers that
 * are silently wrong". That reasoning was right. What nobody did was write the D1 one.
 *
 * So on 20 September 2026, after a day of fetching production pages, `visit_sessions` held
 * **zero rows**. The project's whole launch objective is ten genuine external visits, and
 * the number that objective is measured by could not have moved off zero no matter how much
 * traffic arrived. A counter that counts nothing is the dominant defect of this codebase
 * landing on its own success metric.
 *
 * ## What this does and does not decide
 *
 * Nothing here decides anything (rule 6). Classification, attribution and hashing all
 * happen in `growth/`; this persists what it is handed and reads it back.
 *
 * Rule 3 is the one that shapes every method below: **unknown is not zero.** Every
 * count-shaped return is `null` when the read failed. Returning `0` for "I could not read"
 * would turn a broken query into a confident business fact — the precise failure this
 * product exists to detect in other people's systems, and the reason a visitor count must
 * be able to say "I do not know" out loud.
 */
import type { Db } from './d1';
import { newId } from '../lib/ids';
import type {
  CampaignMetricsRow,
  CampaignSyncState,
  GrowthDataPort,
  VisitCountQuery,
  VisitCounts,
  VisitRecordResult,
} from '../growth/port';
import type { VisitSession } from '../growth/analytics';

/** Row shape of `visit_sessions`, as the table declares it. */
interface VisitRow {
  readonly page_views: number;
}

interface CountRow {
  readonly classification: string;
  readonly n: number;
  readonly ad: number;
}

export class D1GrowthPort implements GrowthDataPort {
  constructor(private readonly db: Db) {}

  /**
   * Insert-or-touch, keyed by the daily hash (rule 1).
   *
   * A second request from the same visitor on the same day must never produce a second
   * row, which is what makes "visits" a count of people-days rather than page loads. The
   * `ON CONFLICT` branch updates `last_seen_at` and increments `page_views`; it
   * deliberately does NOT touch `first_seen_at`, `landing_path` or the UTM columns,
   * because those describe how the session BEGAN and a later page view does not revise
   * that. Re-attributing a visit to whatever page they happened to reach second would
   * quietly overstate the landing page that actually earned the visit.
   *
   * Classification is the one exception, and only in one direction (rule 7). A session may
   * be corrected INTO `internal_test` or `bot_suspected` and may never leave one. That is
   * not a revision of how the session began; it is what happens when we learn, on the
   * second request, something we could not know on the first — a browser cannot send the
   * internal header, so the operator only becomes recognisable once the exclusion cookie
   * is set, which is after their first page view. Production recorded two of this
   * project's own browser checks as external visitors for exactly that reason.
   *
   * The direction is the safety property: a correction can only ever REDUCE the external
   * figure, so nothing — not a visitor, not a bug in the classifier — can use this branch
   * to inflate the number the launch objective is measured by.
   *
   * `meta.changes` cannot distinguish an insert from an update here — D1 reports 1 for
   * both — so `inserted` is derived from the returned `page_views`: a fresh row is always
   * 1. That is exact rather than heuristic, because the column is set by the same
   * statement.
   */
  async recordVisit(session: VisitSession, seenAt: string): Promise<VisitRecordResult> {
    const row = await this.db
      .prepare(
        `INSERT INTO visit_sessions
           (id, first_seen_at, last_seen_at, landing_path, utm_source, utm_medium,
            utm_campaign, classification, page_views, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           page_views = visit_sessions.page_views + 1,
           classification = CASE
             WHEN excluded.classification IN ('internal_test', 'bot_suspected')
              AND visit_sessions.classification NOT IN ('internal_test', 'bot_suspected')
             THEN excluded.classification
             ELSE visit_sessions.classification
           END
         RETURNING page_views`,
      )
      .bind(
        session.id,
        session.first_seen_at,
        seenAt,
        session.landing_path,
        session.utm_source,
        session.utm_medium,
        session.utm_campaign,
        session.classification,
        session.expires_at,
      )
      .first<VisitRow>();

    const pageViews = row?.page_views ?? 1;
    return { inserted: pageViews === 1, pageViews };
  }

  /**
   * Counts by classification over a half-open window, plus the ad-attributed subset.
   *
   * One query rather than five: the classification counts and the campaign subset come
   * back in the same pass, so the figures cannot describe two different instants. The
   * bounds are inclusive-since / exclusive-until exactly as `VisitCountQuery` documents.
   *
   * `adAttributed` counts only sessions that are BOTH external and carry the campaign's
   * own `utm_campaign`. A bot arriving on an ad link is a bot, and counting it as an
   * ad-attributed visit would be the campaign marking its own homework.
   */
  async countVisits(query: VisitCountQuery): Promise<VisitCounts | null> {
    try {
      const result = await this.db
        .prepare(
          `SELECT classification,
                  COUNT(*) AS n,
                  SUM(CASE WHEN classification = 'external' AND utm_campaign IS NOT NULL
                            AND utm_campaign = ?3 THEN 1 ELSE 0 END) AS ad
             FROM visit_sessions
            WHERE first_seen_at >= ?1 AND first_seen_at < ?2
            GROUP BY classification`,
        )
        .bind(query.since, query.until, query.campaignUtm ?? null)
        .all<CountRow>();

      const counts = {
        external: 0,
        adAttributed: 0,
        internalTest: 0,
        botSuspected: 0,
        unknown: 0,
      };
      for (const row of result.results) {
        counts.adAttributed += Number(row.ad ?? 0);
        if (row.classification === 'external') counts.external = Number(row.n);
        else if (row.classification === 'internal_test') counts.internalTest = Number(row.n);
        else if (row.classification === 'bot_suspected') counts.botSuspected = Number(row.n);
        else if (row.classification === 'unknown') counts.unknown = Number(row.n);
      }
      return { ...counts, countedAt: new Date().toISOString() };
    } catch {
      // Rule 3. A read that failed is not a day with no visitors.
      return null;
    }
  }

  async countExpiredVisits(now: string): Promise<number | null> {
    try {
      const row = await this.db
        .prepare('SELECT COUNT(*) AS n FROM visit_sessions WHERE expires_at <= ?')
        .bind(now)
        .first<{ n: number }>();
      return row === null ? null : Number(row.n);
    } catch {
      return null;
    }
  }

  /**
   * One row per (campaign, interval) — rule 5, enforced by the UNIQUE constraint.
   *
   * The interface speaks camelCase and the table speaks snake_case; the translation lives
   * here and nowhere else, which is the point of the port. `id` is generated only for the
   * insert branch: on conflict the existing row keeps its own primary key.
   */
  async upsertCampaignMetrics(row: CampaignMetricsRow): Promise<{ readonly inserted: boolean }> {
    const existing = await this.db
      .prepare(
        `SELECT 1 AS present FROM campaign_metrics
          WHERE campaign_id = ? AND interval_start = ? AND interval_end = ?`,
      )
      .bind(row.campaignId, row.intervalStart, row.intervalEnd)
      .first<{ present: number }>();

    await this.db
      .prepare(
        `INSERT INTO campaign_metrics
           (id, campaign_id, interval_start, interval_end, impressions, clicks, spend_minor,
            currency, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, interval_start, interval_end) DO UPDATE SET
           impressions = excluded.impressions,
           clicks = excluded.clicks,
           spend_minor = excluded.spend_minor,
           currency = excluded.currency,
           received_at = excluded.received_at`,
      )
      .bind(
        newId('cmt'),
        row.campaignId,
        row.intervalStart,
        row.intervalEnd,
        row.impressions,
        row.clicks,
        row.spendMinor,
        row.currency,
        row.receivedAt,
      )
      .run();

    return { inserted: existing === null };
  }

  async latestCampaignMetrics(campaignId: string): Promise<CampaignMetricsRow | null> {
    const row = await this.db
      .prepare(
        `SELECT campaign_id, interval_start, interval_end, impressions, clicks, spend_minor,
                currency, received_at
           FROM campaign_metrics
          WHERE campaign_id = ?
          ORDER BY interval_end DESC
          LIMIT 1`,
      )
      .bind(campaignId)
      .first<{
        campaign_id: string;
        interval_start: string;
        interval_end: string;
        impressions: number | null;
        clicks: number | null;
        spend_minor: number | null;
        currency: string | null;
        received_at: string;
      }>();
    if (row === null) return null;
    return {
      campaignId: row.campaign_id,
      intervalStart: row.interval_start,
      intervalEnd: row.interval_end,
      impressions: row.impressions,
      clicks: row.clicks,
      spendMinor: row.spend_minor,
      currency: row.currency,
      receivedAt: row.received_at,
    };
  }

  /**
   * Rule 4: a failed sync records the failure and touches no figures.
   *
   * `campaign_metrics` is not referenced here at all, which is the point. A stale number
   * honestly labelled stale beats a fresh-looking zero, and the only way to guarantee that
   * is for the failure path to have no access to the figures.
   */
  async recordSyncFailure(campaignId: string, error: string, at: string): Promise<void> {
    await this.db
      .prepare('UPDATE campaigns SET last_sync_error = ?, last_sync_at = ? WHERE id = ?')
      .bind(error, at, campaignId)
      .run();
  }

  async recordSyncSuccess(campaignId: string, at: string): Promise<void> {
    await this.db
      .prepare('UPDATE campaigns SET last_sync_error = NULL, last_sync_at = ? WHERE id = ?')
      .bind(at, campaignId)
      .run();
  }

  async campaignSyncState(campaignId: string): Promise<CampaignSyncState | null> {
    const row = await this.db
      .prepare('SELECT last_sync_at, last_sync_error FROM campaigns WHERE id = ?')
      .bind(campaignId)
      .first<{ last_sync_at: string | null; last_sync_error: string | null }>();
    if (row === null) return null;
    return { lastSyncAt: row.last_sync_at, lastSyncError: row.last_sync_error };
  }
}

/** Convenience for the mount in `index.ts`. */
export function createD1GrowthPort(db: Db): GrowthDataPort {
  return new D1GrowthPort(db);
}
