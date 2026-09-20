/**
 * An in-memory `GrowthDataPort`.
 *
 * Faithful to the contract in `port.ts`, including the parts that are easy to get wrong
 * and expensive to get wrong: a repeat visit touches the existing row rather than adding
 * one, a failed sync leaves previous figures untouched, and every count-shaped read can be
 * made to return `null` so callers are forced to handle "unknown" rather than assuming a
 * number always arrives.
 *
 * This is a test double and says so. The real implementation is A02's D1 repositories.
 */
import type { VisitClassification, VisitSession } from './analytics';
import type {
  CampaignMetricsRow,
  CampaignSyncState,
  GrowthDataPort,
  VisitCountQuery,
  VisitCounts,
  VisitRecordResult,
} from './port';

export interface MemoryGrowthPortOptions {
  /** Make reads fail, so a caller's "unknown" path can be exercised deliberately. */
  readonly failReads?: boolean;
  /** Make writes throw, so the middleware's fail-open behaviour can be exercised. */
  readonly failWrites?: boolean;
}

export interface MemoryGrowthPort extends GrowthDataPort {
  /** Every visit row currently held, newest insertion last. */
  readonly rows: ReadonlyMap<string, VisitSession & { readonly lastSeenAt: string }>;
  readonly metrics: readonly CampaignMetricsRow[];
  readonly syncState: ReadonlyMap<string, CampaignSyncState>;
  /** Deletes rows whose `expires_at` has passed, exactly as A09's sweep would. */
  purgeExpired(now: string): number;
}

/** The two classifications that exclude a session from every reported figure. */
const EXCLUDED: readonly VisitClassification[] = ['internal_test', 'bot_suspected'];

/**
 * Contract rule 7, in one place so both this port and the SQL one can be read against it.
 *
 * A stored classification may be corrected INTO an excluded class and may never leave one.
 * The asymmetry is the safety property: a correction can only ever reduce the external
 * figure the launch objective is measured by, never inflate it.
 */
export function excludedFirst(
  stored: VisitClassification,
  incoming: VisitClassification,
): VisitClassification {
  if (EXCLUDED.includes(stored)) return stored;
  return EXCLUDED.includes(incoming) ? incoming : stored;
}

export function createMemoryGrowthPort(options: MemoryGrowthPortOptions = {}): MemoryGrowthPort {
  const rows = new Map<string, VisitSession & { lastSeenAt: string }>();
  const metrics = new Map<string, CampaignMetricsRow>();
  const syncState = new Map<string, CampaignSyncState>();

  // Unit separator, written as an escape. See the note on FIELD_SEPARATOR in
  // `analytics.ts`: a raw control byte here makes the whole file register as binary.
  const SEP = '\u001f';
  const metricKey = (campaignId: string, start: string, end: string) =>
    `${campaignId}${SEP}${start}${SEP}${end}`;

  const port: MemoryGrowthPort = {
    rows,
    get metrics() {
      return [...metrics.values()];
    },
    syncState,

    async recordVisit(session: VisitSession, seenAt: string): Promise<VisitRecordResult> {
      if (options.failWrites === true) throw new Error('simulated visit write failure');
      const existing = rows.get(session.id);
      if (existing !== undefined) {
        // A repeat visit is an UPDATE. Never a second row.
        const touched = {
          ...existing,
          lastSeenAt: seenAt,
          page_views: existing.page_views + 1,
          // Rule 7: a classification may only ever move toward exclusion, so a correction
          // can reduce the external figure and can never inflate it.
          classification: excludedFirst(existing.classification, session.classification),
        };
        rows.set(session.id, touched);
        return { inserted: false, pageViews: touched.page_views };
      }
      rows.set(session.id, { ...session, lastSeenAt: seenAt });
      return { inserted: true, pageViews: session.page_views };
    },

    async countVisits(query: VisitCountQuery): Promise<VisitCounts | null> {
      if (options.failReads === true) return null;
      const counts = { external: 0, adAttributed: 0, internalTest: 0, botSuspected: 0, unknown: 0 };
      for (const row of rows.values()) {
        if (row.first_seen_at < query.since || row.first_seen_at >= query.until) continue;
        switch (row.classification) {
          case 'external':
            counts.external += 1;
            if (query.campaignUtm !== undefined && row.utm_campaign === query.campaignUtm) {
              counts.adAttributed += 1;
            }
            break;
          case 'internal_test':
            counts.internalTest += 1;
            break;
          case 'bot_suspected':
            counts.botSuspected += 1;
            break;
          case 'unknown':
            counts.unknown += 1;
            break;
        }
      }
      return { ...counts, countedAt: new Date().toISOString() };
    },

    async countExpiredVisits(now: string): Promise<number | null> {
      if (options.failReads === true) return null;
      let n = 0;
      for (const row of rows.values()) if (row.expires_at <= now) n += 1;
      return n;
    },

    async upsertCampaignMetrics(row: CampaignMetricsRow): Promise<{ inserted: boolean }> {
      if (options.failWrites === true) throw new Error('simulated metrics write failure');
      const key = metricKey(row.campaignId, row.intervalStart, row.intervalEnd);
      const inserted = !metrics.has(key);
      metrics.set(key, row);
      return { inserted };
    },

    async latestCampaignMetrics(campaignId: string): Promise<CampaignMetricsRow | null> {
      if (options.failReads === true) return null;
      const mine = [...metrics.values()]
        .filter((m) => m.campaignId === campaignId)
        .sort((a, b) =>
          a.intervalEnd < b.intervalEnd ? -1 : a.intervalEnd > b.intervalEnd ? 1 : 0,
        );
      return mine[mine.length - 1] ?? null;
    },

    async recordSyncFailure(campaignId: string, error: string, at: string): Promise<void> {
      // Deliberately does not touch `metrics`. That is the whole point of the method.
      syncState.set(campaignId, { lastSyncAt: at, lastSyncError: error });
    },

    async recordSyncSuccess(campaignId: string, at: string): Promise<void> {
      syncState.set(campaignId, { lastSyncAt: at, lastSyncError: null });
    },

    async campaignSyncState(campaignId: string): Promise<CampaignSyncState | null> {
      return syncState.get(campaignId) ?? null;
    },

    purgeExpired(now: string): number {
      let n = 0;
      for (const [id, row] of [...rows.entries()]) {
        if (row.expires_at <= now) {
          rows.delete(id);
          n += 1;
        }
      }
      return n;
    },
  };

  return port;
}
