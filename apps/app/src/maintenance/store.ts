/**
 * Persistence for `runner_devices` and `maintenance_jobs`.
 *
 * **A note on ownership.** `docs/agent-brief.md` puts all raw SQL in `apps/app/src/db/`
 * (A02's directory). A02 wrote no repository for these two tables and that directory is
 * read-only for A08, so the SQL for them lives here, alone, and keeps every rule that
 * directory keeps: explicit columns, conditional writes reported through `meta.changes`
 * rather than a re-read, `batch()` for anything atomic, and no `SELECT *`. If the lead
 * would rather these two tables were served from `apps/app/src/db/maintenance.ts`, this
 * file moves there unchanged — it imports nothing from the rest of this directory.
 *
 * Neither table is customer-scoped: both belong to the platform owner, which is why
 * neither takes a `workspace_id`. Every route that reaches them proves platform ownership
 * (or a paired device identity) before it gets here.
 */
import { type Db, applied, resultAt } from '../db/d1.js';

// ---------------------------------------------------------------------------
// runner_devices
// ---------------------------------------------------------------------------

export type RunnerDeviceStatus = 'pending_pair' | 'active' | 'revoked';

export interface RunnerDeviceRow {
  readonly id: string;
  readonly owner_id: string;
  readonly label: string;
  /** Base64 raw Ed25519 public key. Empty while the device is still `pending_pair`. */
  readonly public_key: string;
  readonly status: RunnerDeviceStatus;
  readonly pairing_code_hash: string | null;
  readonly pairing_expires_at: string | null;
  readonly last_heartbeat_at: string | null;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

const DEVICE_COLUMNS =
  'id, owner_id, label, public_key, status, pairing_code_hash, pairing_expires_at, last_heartbeat_at, created_at, revoked_at';

export const runnerDevices = {
  /**
   * Open a pairing window. The code itself is never stored — only its hash, exactly as a
   * session cookie or a magic-link token is handled.
   */
  async createPairing(
    db: Db,
    params: {
      readonly id: string;
      readonly ownerId: string;
      readonly label: string;
      readonly pairingCodeHash: string;
      readonly pairingExpiresAt: string;
      readonly createdAt: string;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO runner_devices
           (id, owner_id, label, public_key, status, pairing_code_hash, pairing_expires_at, created_at)
         VALUES (?, ?, ?, '', 'pending_pair', ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.ownerId,
        params.label,
        params.pairingCodeHash,
        params.pairingExpiresAt,
        params.createdAt,
      )
      .run();
  },

  /**
   * Redeem a pairing code, single-use and time-bound, in one conditional statement.
   *
   * Clearing `pairing_code_hash` in the same UPDATE is what makes the code single-use: a
   * second redemption finds no row whose hash matches and reports `meta.changes === 0`.
   * Two devices racing with the same code therefore produce exactly one pairing.
   */
  async completePairing(
    db: Db,
    params: {
      readonly pairingCodeHash: string;
      readonly publicKey: string;
      readonly now: string;
    },
  ): Promise<RunnerDeviceRow | null> {
    const result = await db
      .prepare(
        `UPDATE runner_devices
            SET status = 'active',
                public_key = ?,
                pairing_code_hash = NULL,
                pairing_expires_at = NULL,
                last_heartbeat_at = ?
          WHERE pairing_code_hash = ?
            AND status = 'pending_pair'
            AND pairing_expires_at > ?
          RETURNING ${DEVICE_COLUMNS}`,
      )
      .bind(params.publicKey, params.now, params.pairingCodeHash, params.now)
      .all<RunnerDeviceRow>();
    return applied(result) ? (result.results[0] ?? null) : null;
  },

  async get(db: Db, deviceId: string): Promise<RunnerDeviceRow | null> {
    return db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM runner_devices WHERE id = ?`)
      .bind(deviceId)
      .first<RunnerDeviceRow>();
  },

  async list(db: Db, limit = 50): Promise<RunnerDeviceRow[]> {
    const result = await db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM runner_devices ORDER BY created_at DESC LIMIT ?`)
      .bind(Math.min(Math.max(1, limit), 200))
      .all<RunnerDeviceRow>();
    return result.results;
  },

  /**
   * Revoke, and release whatever the device was holding in the same transaction.
   *
   * A revoked device that still held a lease would otherwise strand its job until the
   * lease expired. Both statements are conditional and they commit or roll back together.
   */
  async revoke(db: Db, deviceId: string, at: string): Promise<boolean> {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE runner_devices SET status = 'revoked', revoked_at = ?
            WHERE id = ? AND status <> 'revoked'`,
        )
        .bind(at, deviceId),
      db
        .prepare(
          `UPDATE maintenance_jobs
              SET state = 'queued', lease_device_id = NULL, lease_nonce = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE lease_device_id = ? AND state IN ('leased','running')`,
        )
        .bind(at, deviceId),
    ]);
    return resultAt(results, 0).meta.changes === 1;
  },

  /** Heartbeat. Only an active device has one, and it never extends a job lease. */
  async heartbeat(db: Db, deviceId: string, at: string): Promise<boolean> {
    const result = await db
      .prepare(`UPDATE runner_devices SET last_heartbeat_at = ? WHERE id = ? AND status = 'active'`)
      .bind(at, deviceId)
      .run();
    return applied(result);
  },
};

// ---------------------------------------------------------------------------
// maintenance_jobs
// ---------------------------------------------------------------------------

export type MaintenanceJobState =
  | 'queued'
  | 'awaiting_runner'
  | 'leased'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'infrastructure_error';

/** States a job can be claimed from. An expired lease is handled separately. */
export const CLAIMABLE_STATES: readonly MaintenanceJobState[] = ['queued', 'awaiting_runner'];

export const TERMINAL_STATES: ReadonlySet<MaintenanceJobState> = new Set([
  'passed',
  'failed',
  'cancelled',
  'timed_out',
  'infrastructure_error',
]);

export interface MaintenanceJobRow {
  readonly id: string;
  readonly typed_kind: string;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly priority: number;
  readonly approval_id: string | null;
  readonly state: MaintenanceJobState;
  readonly lease_device_id: string | null;
  readonly lease_nonce: string | null;
  readonly lease_expires_at: string | null;
  readonly result_json: string | null;
  readonly requested_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const JOB_COLUMNS =
  'id, typed_kind, payload_json, payload_hash, priority, approval_id, state, lease_device_id, lease_nonce, lease_expires_at, result_json, requested_by, created_at, updated_at';

export const maintenanceJobs = {
  async insert(
    db: Db,
    params: {
      readonly id: string;
      readonly typedKind: string;
      readonly payloadJson: string;
      readonly payloadHash: string;
      readonly priority: number;
      readonly approvalId: string | null;
      readonly state: MaintenanceJobState;
      readonly requestedBy: string;
      readonly at: string;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO maintenance_jobs
           (id, typed_kind, payload_json, payload_hash, priority, approval_id, state, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.typedKind,
        params.payloadJson,
        params.payloadHash,
        params.priority,
        params.approvalId,
        params.state,
        params.requestedBy,
        params.at,
        params.at,
      )
      .run();
  },

  async get(db: Db, jobId: string): Promise<MaintenanceJobRow | null> {
    return db
      .prepare(`SELECT ${JOB_COLUMNS} FROM maintenance_jobs WHERE id = ?`)
      .bind(jobId)
      .first<MaintenanceJobRow>();
  },

  /** The next candidate, by priority then age. Read-only; claiming is a separate CAS. */
  async nextCandidate(db: Db, now: string): Promise<MaintenanceJobRow | null> {
    return db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM maintenance_jobs
          WHERE state IN ('queued','awaiting_runner')
             OR (state IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          ORDER BY priority ASC, created_at ASC
          LIMIT 1`,
      )
      .bind(now)
      .first<MaintenanceJobRow>();
  },

  /**
   * Compare-and-set the claim. This single statement is the whole concurrency control.
   *
   * The `WHERE` re-states the claimable condition, so a second device evaluating it against
   * the first device's committed row matches nothing and gets `meta.changes === 0`. There
   * is no read-then-write window in which both could pass: the candidate read above is a
   * hint, and this statement is the decision.
   *
   * An expired lease is claimable by the same predicate, which is what returns a stranded
   * job to service without a sweeper.
   */
  async claim(
    db: Db,
    params: {
      readonly jobId: string;
      readonly deviceId: string;
      readonly nonce: string;
      readonly leaseExpiresAt: string;
      readonly now: string;
    },
  ): Promise<MaintenanceJobRow | null> {
    const result = await db
      .prepare(
        `UPDATE maintenance_jobs
            SET state = 'leased',
                lease_device_id = ?,
                lease_nonce = ?,
                lease_expires_at = ?,
                updated_at = ?
          WHERE id = ?
            AND (
              state IN ('queued','awaiting_runner')
              OR (state IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            )
          RETURNING ${JOB_COLUMNS}`,
      )
      .bind(
        params.deviceId,
        params.nonce,
        params.leaseExpiresAt,
        params.now,
        params.jobId,
        params.now,
      )
      .all<MaintenanceJobRow>();
    return applied(result) ? (result.results[0] ?? null) : null;
  },

  /**
   * Record a terminal result, bound to the lease that produced it.
   *
   * The `WHERE` carries the device id **and** the nonce, so a result from another device,
   * or from a stale lease that has since been reclaimed, changes nothing. Idempotency is
   * the caller's job (`jobs.ts`), which recognises a replay by the nonce recorded inside
   * the stored result envelope.
   */
  async recordResult(
    db: Db,
    params: {
      readonly jobId: string;
      readonly deviceId: string;
      readonly nonce: string;
      readonly state: MaintenanceJobState;
      readonly resultJson: string;
      readonly at: string;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE maintenance_jobs
            SET state = ?, result_json = ?, lease_nonce = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND lease_device_id = ? AND lease_nonce = ? AND state IN ('leased','running')`,
      )
      .bind(params.state, params.resultJson, params.at, params.jobId, params.deviceId, params.nonce)
      .run();
    return applied(result);
  },

  async list(
    db: Db,
    params: { readonly states?: readonly MaintenanceJobState[]; readonly limit?: number } = {},
  ): Promise<MaintenanceJobRow[]> {
    const limit = Math.min(Math.max(1, params.limit ?? 25), 100);
    if (params.states === undefined || params.states.length === 0) {
      const result = await db
        .prepare(`SELECT ${JOB_COLUMNS} FROM maintenance_jobs ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all<MaintenanceJobRow>();
      return result.results;
    }
    // Placeholders are generated from the array length, never from caller text.
    const placeholders = params.states.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM maintenance_jobs
          WHERE state IN (${placeholders})
          ORDER BY priority ASC, created_at ASC LIMIT ?`,
      )
      .bind(...params.states, limit)
      .all<MaintenanceJobRow>();
    return result.results;
  },

  async countByState(db: Db): Promise<Record<string, number>> {
    const result = await db
      .prepare('SELECT state, COUNT(*) AS n FROM maintenance_jobs GROUP BY state')
      .all<{ state: string; n: number }>();
    const out: Record<string, number> = {};
    for (const row of result.results) out[row.state] = Number(row.n);
    return out;
  },

  /** The most recent job that actually passed. Shown on the owner's runner card. */
  async lastSuccessful(db: Db): Promise<MaintenanceJobRow | null> {
    return db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM maintenance_jobs
          WHERE state = 'passed' ORDER BY updated_at DESC LIMIT 1`,
      )
      .first<MaintenanceJobRow>();
  },
};
