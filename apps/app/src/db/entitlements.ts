/**
 * Plan allowance per billing period.
 *
 * Allowance is held in two columns: `reserved` is taken the moment a source event is
 * admitted (so an in-flight run cannot be double-sold) and moves to `consumed` when the
 * run reaches a terminal state. A run that never starts releases its reservation.
 *
 * Every mutation here is a single conditional statement; nothing reads a count and writes
 * it back.
 */
import type { Db } from './d1';

export interface EntitlementRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly billing_period: string;
  readonly plan_version: number;
  readonly run_limit: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly updated_at: string;
}

const COLUMNS =
  'id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at';

export const entitlements = {
  /**
   * Make sure the period row exists. Idempotent: a second call for the same period only
   * refreshes the limit and plan version, never the counters.
   */
  async ensurePeriod(
    db: Db,
    params: {
      id: string;
      workspaceId: string;
      billingPeriod: string;
      planVersion: number;
      runLimit: number;
      updatedAt: string;
    },
  ): Promise<EntitlementRow> {
    const row = await db
      .prepare(
        `INSERT INTO entitlements (id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT(workspace_id, billing_period) DO UPDATE SET
           run_limit    = excluded.run_limit,
           plan_version = excluded.plan_version,
           updated_at   = excluded.updated_at
         RETURNING ${COLUMNS}`,
      )
      .bind(
        params.id,
        params.workspaceId,
        params.billingPeriod,
        params.planVersion,
        params.runLimit,
        params.updatedAt,
      )
      .first<EntitlementRow>();
    if (row === null) throw new Error('entitlements.ensurePeriod returned no row');
    return row;
  },

  async get(db: Db, workspaceId: string, billingPeriod: string): Promise<EntitlementRow | null> {
    return db
      .prepare(`SELECT ${COLUMNS} FROM entitlements WHERE workspace_id = ? AND billing_period = ?`)
      .bind(workspaceId, billingPeriod)
      .first<EntitlementRow>();
  },

  /** Remaining allowance, computed the one way the system agrees on. */
  async remaining(db: Db, workspaceId: string, billingPeriod: string): Promise<number | null> {
    const row = await db
      .prepare(
        `SELECT (run_limit - consumed - reserved) AS remaining FROM entitlements
          WHERE workspace_id = ? AND billing_period = ?`,
      )
      .bind(workspaceId, billingPeriod)
      .first<{ remaining: number }>();
    return row === null ? null : Number(row.remaining);
  },

  /**
   * Take one unit of allowance, atomically.
   *
   * One conditional statement: the availability test is in the `WHERE`, so two concurrent
   * callers asking for the last unit cannot both succeed. Returns false when there is
   * none left — which is the "at allowance" signal, not an error.
   *
   * This is a DIFFERENT call site from `sourceEvents.admitOnce`, which reserves inside its
   * own batch so the reservation commits with the run and the outbox row. Billing calls
   * this one when it needs a unit without an admission (a replayed provider event, an
   * owner-initiated run). Merging them would make one of the two lose its atomicity with
   * the thing it is paired to.
   */
  async reserve(
    db: Db,
    workspaceId: string,
    billingPeriod: string,
    at: string,
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE entitlements SET reserved = reserved + 1, updated_at = ?
          WHERE workspace_id = ? AND billing_period = ?
            AND (run_limit - consumed - reserved) >= 1`,
      )
      .bind(at, workspaceId, billingPeriod)
      .run();
    return result.meta.changes === 1;
  },

  /**
   * A run reached a terminal state: the reservation becomes a consumption. Conditional on
   * a reservation actually being held, so a duplicate completion cannot over-count.
   */
  async settleReservation(
    db: Db,
    workspaceId: string,
    billingPeriod: string,
    at: string,
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE entitlements SET reserved = reserved - 1, consumed = consumed + 1, updated_at = ?
          WHERE workspace_id = ? AND billing_period = ? AND reserved >= 1`,
      )
      .bind(at, workspaceId, billingPeriod)
      .run();
    return result.meta.changes === 1;
  },

  /** A run was abandoned before it could consume anything: hand the unit back. */
  async releaseReservation(
    db: Db,
    workspaceId: string,
    billingPeriod: string,
    at: string,
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE entitlements SET reserved = reserved - 1, updated_at = ?
          WHERE workspace_id = ? AND billing_period = ? AND reserved >= 1`,
      )
      .bind(at, workspaceId, billingPeriod)
      .run();
    return result.meta.changes === 1;
  },

  async listForWorkspace(db: Db, workspaceId: string, limit = 12): Promise<EntitlementRow[]> {
    const result = await db
      .prepare(
        `SELECT ${COLUMNS} FROM entitlements WHERE workspace_id = ?
          ORDER BY billing_period DESC LIMIT ?`,
      )
      .bind(workspaceId, limit)
      .all<EntitlementRow>();
    return result.results;
  },
};
