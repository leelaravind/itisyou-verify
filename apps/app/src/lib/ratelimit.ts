/**
 * Fixed-window rate limiting over the `rate_limits` D1 table.
 *
 * The whole limiter is one statement. There is no read-then-write anywhere in this file,
 * because a read followed by a write is exactly how two concurrent requests both observe
 * "one left" and both get through. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * increments and reports the post-increment count in a single atomic step.
 *
 * The window resets inside the same statement: if the stored `window_start` is older than
 * `now - windowSeconds`, the counter is set back to 1 and a new window begins.
 */
import type { Db } from '../db/d1';
import { addSecondsIso, parseIso, retryAfterSeconds, toIso } from './time';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests still permitted in this window, after accounting for this one. */
  readonly remaining: number;
  /** Seconds until the window rolls. Zero when the request was allowed. */
  readonly retryAfterSeconds: number;
  /** Post-increment count, exposed for logging and tests. */
  readonly count: number;
  readonly windowStart: string;
}

const CONSUME_SQL = `
INSERT INTO rate_limits (bucket, window_start, count, expires_at)
VALUES (?, ?, 1, ?)
ON CONFLICT(bucket) DO UPDATE SET
  count        = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
  window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END,
  expires_at   = CASE WHEN rate_limits.window_start <= ? THEN excluded.expires_at ELSE rate_limits.expires_at END
RETURNING count, window_start`;

/**
 * Consume one unit from `bucket`.
 *
 * `bucket` is the caller's composite key — for example `events:<workspace_id>` or
 * `login:<email_hash>`. It must never contain a raw email or token; hash first.
 */
export async function consume(
  db: Db,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<RateLimitDecision> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('rate limit must be a positive integer');
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new TypeError('rate limit window must be a positive number of seconds');
  }

  const nowIsoValue = toIso(now);
  // A stored window is stale when it began at or before this instant.
  const staleBefore = addSecondsIso(now, -windowSeconds);
  // Rows are self-expiring so the table cannot grow without bound; retention sweeps them.
  const expiresAt = addSecondsIso(now, windowSeconds * 2);

  const row = await db
    .prepare(CONSUME_SQL)
    .bind(bucket, nowIsoValue, expiresAt, staleBefore, staleBefore, staleBefore)
    .first<{ count: number; window_start: string }>();

  if (row === null) {
    // Cannot happen with RETURNING on a successful upsert; treat as a hard failure rather
    // than silently allowing an unlimited request.
    throw new Error('rate limiter did not return a count');
  }

  const count = Number(row.count);
  const windowEnd = new Date(parseIso(row.window_start).getTime() + windowSeconds * 1000);
  const allowed = count <= limit;

  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds(now, windowEnd)),
    count,
    windowStart: row.window_start,
  };
}

/** Remove expired buckets. Called by the scheduler, never on the request path. */
export async function purgeExpired(db: Db, now: Date = new Date(), limit = 500): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM rate_limits WHERE bucket IN (
         SELECT bucket FROM rate_limits WHERE expires_at <= ? LIMIT ?
       )`,
    )
    .bind(toIso(now), limit)
    .run();
  return result.meta.changes;
}
