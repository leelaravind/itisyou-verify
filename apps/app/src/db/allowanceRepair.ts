/**
 * Allowance-period reconciliation, in D1.
 *
 * Moved verbatim from `tests/integration/money/d1ports.ts` on 19 September 2026. It was
 * written there because `SEC-201` forbids SQL outside this directory and its author did
 * not own this directory. The algorithms were proved against the real migrated schema
 * there; what was missing was that nothing in production implemented the port at all, so
 * no claim that this "runs in production" could be made. Moving it here is what makes
 * that claim true, and the mount in `apps/app/src/index.ts` is what makes it reachable.
 *
 * The statements are unchanged. Every one is workspace-scoped except where a marker and a
 * reason say why it cannot be.
 */
import type { Db } from './d1.js';
import type {
  AllowanceRepairPort,
  AllowanceRowSnapshot,
  RunPeriodFact,
} from '../money/ports.js';

interface AllowanceRow {
  readonly workspace_id: string;
  readonly billing_period: string;
  readonly run_limit: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly updated_at: string;
}

export class D1AllowanceRepair implements AllowanceRepairPort {
  constructor(private readonly db: Db) {}

  async listWorkspacesWithAllowanceRows(limit: number): Promise<readonly string[]> {
    // tenant-scope:exempt this IS the platform-wide sweep that finds work; every read and
    // write after it is scoped by the workspace_id this returns.
    const result = await this.db
      .prepare('SELECT DISTINCT workspace_id FROM entitlements ORDER BY workspace_id LIMIT ?')
      .bind(limit)
      .all<{ workspace_id: string }>();
    return result.results.map((row) => row.workspace_id);
  }

  async currentPeriodEnd(
    workspaceId: string,
    environment: 'test' | 'live',
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT current_period_end FROM subscriptions
          WHERE workspace_id = ? AND environment = ?
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(workspaceId, environment)
      .first<{ current_period_end: string | null }>();
    return row?.current_period_end ?? null;
  }

  async listAllowanceRows(workspaceId: string): Promise<readonly AllowanceRowSnapshot[]> {
    const result = await this.db
      .prepare(
        `SELECT workspace_id, billing_period, run_limit, consumed, reserved, updated_at
           FROM entitlements WHERE workspace_id = ? ORDER BY billing_period`,
      )
      .bind(workspaceId)
      .all<AllowanceRow>();
    return result.results.map((row) => ({
      workspaceId: row.workspace_id,
      billingPeriod: row.billing_period,
      runLimit: row.run_limit,
      consumed: row.consumed,
      reserved: row.reserved,
      updatedAt: row.updated_at,
    }));
  }

  async listRunPeriodFacts(workspaceId: string, limit: number): Promise<readonly RunPeriodFact[]> {
    const result = await this.db
      .prepare(
        'SELECT status, created_at FROM runs WHERE workspace_id = ? ORDER BY created_at LIMIT ?',
      )
      .bind(workspaceId, limit)
      .all<{ status: string; created_at: string }>();
    return result.results.map((row) => ({ status: row.status, createdAt: row.created_at }));
  }

  async renameAllowancePeriod(params: {
    workspaceId: string;
    fromPeriod: string;
    toPeriod: string;
    expectUpdatedAt: string;
    at: string;
  }): Promise<boolean> {
    // The NOT EXISTS guard is what keeps this from colliding with
    // UNIQUE (workspace_id, billing_period); `updated_at = ?` is what keeps it from
    // clobbering a concurrent admission.
    const result = await this.db
      .prepare(
        `UPDATE entitlements SET billing_period = ?, updated_at = ?
          WHERE workspace_id = ? AND billing_period = ? AND updated_at = ?
            AND NOT EXISTS (
              SELECT 1 FROM entitlements t WHERE t.workspace_id = ? AND t.billing_period = ?
            )`,
      )
      .bind(
        params.toPeriod,
        params.at,
        params.workspaceId,
        params.fromPeriod,
        params.expectUpdatedAt,
        params.workspaceId,
        params.toPeriod,
      )
      .run();
    return result.meta.changes === 1;
  }

  async mergeAllowancePeriod(params: {
    workspaceId: string;
    fromPeriod: string;
    intoPeriod: string;
    at: string;
  }): Promise<boolean> {
    // One transaction. The UPDATE reads the source row's counters inside it, so there is
    // no gap in which they could move, and `run_limit` is deliberately absent from the SET
    // clause — merging two rows must produce one allowance, not two.
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE entitlements
              SET consumed = consumed + (
                    SELECT l.consumed FROM entitlements l
                     WHERE l.workspace_id = entitlements.workspace_id AND l.billing_period = ?
                  ),
                  reserved = reserved + (
                    SELECT l.reserved FROM entitlements l
                     WHERE l.workspace_id = entitlements.workspace_id AND l.billing_period = ?
                  ),
                  updated_at = ?
            WHERE workspace_id = ? AND billing_period = ?
              AND EXISTS (
                SELECT 1 FROM entitlements l WHERE l.workspace_id = ? AND l.billing_period = ?
              )`,
        )
        .bind(
          params.fromPeriod,
          params.fromPeriod,
          params.at,
          params.workspaceId,
          params.intoPeriod,
          params.workspaceId,
          params.fromPeriod,
        ),
      this.db
        .prepare('DELETE FROM entitlements WHERE workspace_id = ? AND billing_period = ?')
        .bind(params.workspaceId, params.fromPeriod),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
  }

  async dropAllowanceRow(params: {
    workspaceId: string;
    billingPeriod: string;
    expectConsumed: number;
    expectReserved: number;
    expectUpdatedAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM entitlements
          WHERE workspace_id = ? AND billing_period = ?
            AND consumed = ? AND reserved = ? AND updated_at = ?`,
      )
      .bind(
        params.workspaceId,
        params.billingPeriod,
        params.expectConsumed,
        params.expectReserved,
        params.expectUpdatedAt,
      )
      .run();
    return result.meta.changes === 1;
  }

  async setAllowanceCounters(params: {
    workspaceId: string;
    billingPeriod: string;
    consumed: number;
    reserved: number;
    expectConsumed: number;
    expectReserved: number;
    expectUpdatedAt: string;
    at: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE entitlements SET consumed = ?, reserved = ?, updated_at = ?
          WHERE workspace_id = ? AND billing_period = ?
            AND consumed = ? AND reserved = ? AND updated_at = ?`,
      )
      .bind(
        params.consumed,
        params.reserved,
        params.at,
        params.workspaceId,
        params.billingPeriod,
        params.expectConsumed,
        params.expectReserved,
        params.expectUpdatedAt,
      )
      .run();
    return result.meta.changes === 1;
  }
}
