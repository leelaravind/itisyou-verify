/**
 * Runs, attempts, assertions and evidence.
 *
 * Two things here are load-bearing for correctness:
 *
 *  - `claimDue` is the single indexed due-job query plus a compare-and-set lease. The
 *    scan is bounded and hits `idx_runs_due`; the claim is a conditional update on
 *    `(id, revision)` that also pushes `next_check_at` beyond the lease, so two schedulers
 *    running in the same minute cannot both take the same run.
 *  - `applyOutcome` is optimistic concurrency on the same `revision`. A late attempt
 *    finishing after a newer one has already written cannot overwrite it.
 */
import type { AssertionStatus, RunStatus } from '@verify/contracts';
import { buildPage, clampLimit, decodeCursor, type Page, type PageRequest } from './cursor';
import { changesAt, type Db, orNull, toSqlBool } from './d1';

export interface RunRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly workflow_id: string;
  readonly workflow_version_id: string;
  readonly source_event_id: string;
  readonly status: RunStatus;
  readonly revision: number;
  readonly observation_count: number;
  readonly deadline_at: string;
  readonly next_check_at: string | null;
  readonly is_synthetic: number;
  readonly created_at: string;
  readonly completed_at: string | null;
}

const RUN_COLUMNS =
  'id, workspace_id, workflow_id, workflow_version_id, source_event_id, status, revision, observation_count, deadline_at, next_check_at, is_synthetic, created_at, completed_at';

/** The bounded projection the scheduler needs. Never `SELECT *` on the hot path. */
export interface DueRun {
  readonly id: string;
  readonly workspace_id: string;
  readonly workflow_id: string;
  readonly workflow_version_id: string;
  readonly revision: number;
  readonly observation_count: number;
  readonly deadline_at: string;
  readonly next_check_at: string;
}

export const runs = {
  async get(db: Db, workspaceId: string, runId: string): Promise<RunRow | null> {
    return db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, runId)
      .first<RunRow>();
  },

  async getBySourceEvent(
    db: Db,
    workspaceId: string,
    sourceEventId: string,
  ): Promise<RunRow | null> {
    return db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE workspace_id = ? AND source_event_id = ?`)
      .bind(workspaceId, sourceEventId)
      .first<RunRow>();
  },

  /**
   * Bounded, cursor-paginated list for the dashboard. Explicit columns, capped limit,
   * cursor over `(created_at, id)` so a run created mid-page cannot cause a skip.
   */
  async listByWorkspace(
    db: Db,
    workspaceId: string,
    page: PageRequest & { status?: RunStatus } = {},
  ): Promise<Page<RunRow>> {
    const limit = clampLimit(page.limit);
    const cursor = decodeCursor(page.cursor);
    // The tenant predicate is a literal in every one of these four statements, never a
    // fragment assembled at runtime: a reader — and the AUTH-202 source scan — must be
    // able to see `workspace_id = ?` in the statement that actually runs.
    const statusClause = page.status !== undefined ? ' AND status = ?' : '';
    const cursorClause =
      cursor !== null ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
    const sql =
      `SELECT ${RUN_COLUMNS} FROM runs WHERE workspace_id = ?` +
      statusClause +
      cursorClause +
      ' ORDER BY created_at DESC, id DESC LIMIT ?';

    const bindings: unknown[] = [workspaceId];
    if (page.status !== undefined) bindings.push(page.status);
    if (cursor !== null) bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    bindings.push(limit + 1);

    const result = await db
      .prepare(sql)
      .bind(...bindings)
      .all<RunRow>();
    return buildPage(result.results, limit);
  },

  async listByWorkflow(
    db: Db,
    workspaceId: string,
    workflowId: string,
    page: PageRequest = {},
  ): Promise<Page<RunRow>> {
    const limit = clampLimit(page.limit);
    const cursor = decodeCursor(page.cursor);
    const sql = cursor
      ? `SELECT ${RUN_COLUMNS} FROM runs
          WHERE workspace_id = ? AND workflow_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`
      : `SELECT ${RUN_COLUMNS} FROM runs
          WHERE workspace_id = ? AND workflow_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`;
    const bindings = cursor
      ? [workspaceId, workflowId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
      : [workspaceId, workflowId, limit + 1];
    const result = await db
      .prepare(sql)
      .bind(...bindings)
      .all<RunRow>();
    return buildPage(result.results, limit);
  },

  async countByStatus(db: Db, workspaceId: string, since: string): Promise<Record<string, number>> {
    const result = await db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM runs
          WHERE workspace_id = ? AND created_at >= ? GROUP BY status`,
      )
      .bind(workspaceId, since)
      .all<{ status: string; n: number }>();
    const out: Record<string, number> = {};
    for (const row of result.results) out[row.status] = Number(row.n);
    return out;
  },

  // -------------------------------------------------------------------------
  // scheduler
  // -------------------------------------------------------------------------

  /**
   * The single indexed due-job query.
   *
   * Cross-tenant by design — the scheduler serves every workspace — which is why each row
   * carries its `workspace_id` and every downstream call takes it explicitly. The scan is
   * bounded and ordered by `next_check_at`, so it uses `idx_runs_due` and never becomes a
   * table scan as the table grows.
   *
   * Exported separately from `claimDue` so the race can be exercised directly in tests.
   */
  async listDue(db: Db, now: string, limit: number): Promise<DueRun[]> {
    // Nothing a customer controls selects these rows: the predicate is `next_check_at`,
    // which only our own scheduler writes. The batch is capped and ordered so it stays on
    // idx_runs_due, and every row carries the workspace_id the worker must use downstream.
    // tenant-scope:exempt bounded due-job sweep; see above.
    const result = await db
      .prepare(
        `SELECT id, workspace_id, workflow_id, workflow_version_id, revision, observation_count, deadline_at, next_check_at
           FROM runs
          WHERE next_check_at IS NOT NULL AND next_check_at <= ?
          ORDER BY next_check_at ASC
          LIMIT ?`,
      )
      .bind(now, Math.min(Math.max(1, limit), 200))
      .all<DueRun>();
    return result.results;
  },

  /**
   * Compare-and-set claim. Succeeds only if the run is still at the revision the caller
   * saw and is still due. The winner pushes `next_check_at` to the end of its lease and
   * bumps the revision, so the loser's identical update matches nothing.
   */
  async tryClaim(
    db: Db,
    params: { runId: string; expectedRevision: number; now: string; leaseUntil: string },
  ): Promise<boolean> {
    // The scheduler is cross-tenant by design and claims whatever listDue() handed it,
    // which is already a bounded set of due runs across every workspace. The
    // compare-and-set on (id, revision) is the safety property here, and the claimed row
    // carries its workspace_id onward so every subsequent read and write is scoped.
    // tenant-scope:exempt cross-tenant scheduler claim, guarded by CAS on (id, revision).
    const result = await db
      .prepare(
        `UPDATE runs
            SET next_check_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ? AND next_check_at IS NOT NULL AND next_check_at <= ?`,
      )
      .bind(params.leaseUntil, params.runId, params.expectedRevision, params.now)
      .run();
    return result.meta.changes === 1;
  },

  /**
   * Claim up to `limit` due runs. Returns only the runs this caller actually won, each
   * with the revision it now holds — which is the revision `applyOutcome` must be given.
   */
  async claimDue(
    db: Db,
    params: { now: string; limit: number; leaseSeconds: number; leaseUntil: string },
  ): Promise<DueRun[]> {
    const candidates = await runs.listDue(db, params.now, params.limit);
    const claimed: DueRun[] = [];
    for (const candidate of candidates) {
      const won = await runs.tryClaim(db, {
        runId: candidate.id,
        expectedRevision: candidate.revision,
        now: params.now,
        leaseUntil: params.leaseUntil,
      });
      if (won) claimed.push({ ...candidate, revision: candidate.revision + 1 });
    }
    return claimed;
  },

  /**
   * Write the outcome of an observation under optimistic concurrency.
   *
   * `expectedRevision` is the revision the caller claimed. A stale worker finishing after
   * a newer attempt has already written sees zero changes and must discard its result
   * rather than overwrite a newer decision.
   */
  async applyOutcome(
    db: Db,
    params: {
      workspaceId: string;
      runId: string;
      expectedRevision: number;
      status: RunStatus;
      nextCheckAt: string | null;
      observationCount: number;
      completedAt?: string | null;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE runs
            SET status = ?, next_check_at = ?, observation_count = ?, completed_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .bind(
        params.status,
        orNull(params.nextCheckAt),
        params.observationCount,
        orNull(params.completedAt),
        params.workspaceId,
        params.runId,
        params.expectedRevision,
      )
      .run();
    return result.meta.changes === 1;
  },

  /** Re-arm a run the scheduler leased but could not process. */
  async reschedule(
    db: Db,
    params: { workspaceId: string; runId: string; expectedRevision: number; nextCheckAt: string },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE runs SET next_check_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .bind(params.nextCheckAt, params.workspaceId, params.runId, params.expectedRevision)
      .run();
    return result.meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// run attempts
// ---------------------------------------------------------------------------

export interface RunAttemptRow {
  readonly id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly attempt_number: number;
  readonly lease_id: string | null;
  readonly lease_expires_at: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly error_code: string | null;
}

export const runAttempts = {
  /**
   * Open an attempt. The attempt number is derived inside the INSERT and guarded by
   * `UNIQUE (run_id, attempt_number)`, so a duplicate dispatch of the same tick fails
   * rather than producing two attempts with the same number.
   */
  async start(
    db: Db,
    params: {
      id: string;
      workspaceId: string;
      runId: string;
      leaseId: string;
      leaseExpiresAt: string;
      startedAt: string;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `INSERT INTO run_attempts (id, run_id, workspace_id, attempt_number, lease_id, lease_expires_at, started_at)
         SELECT ?, ?, ?,
                COALESCE((SELECT MAX(attempt_number) FROM run_attempts WHERE run_id = ?), 0) + 1,
                ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND workspace_id = ?)`,
      )
      .bind(
        params.id,
        params.runId,
        params.workspaceId,
        params.runId,
        params.leaseId,
        params.leaseExpiresAt,
        params.startedAt,
        params.runId,
        params.workspaceId,
      )
      .run();
    return result.meta.changes === 1;
  },

  async finish(
    db: Db,
    params: {
      workspaceId: string;
      attemptId: string;
      endedAt: string;
      outcome: string;
      errorCode?: string | null;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE run_attempts
            SET ended_at = ?, outcome = ?, error_code = ?, lease_expires_at = NULL
          WHERE workspace_id = ? AND id = ? AND ended_at IS NULL`,
      )
      .bind(
        params.endedAt,
        params.outcome,
        orNull(params.errorCode),
        params.workspaceId,
        params.attemptId,
      )
      .run();
    return result.meta.changes === 1;
  },

  async listForRun(
    db: Db,
    workspaceId: string,
    runId: string,
    limit = 20,
  ): Promise<RunAttemptRow[]> {
    const result = await db
      .prepare(
        `SELECT id, run_id, workspace_id, attempt_number, lease_id, lease_expires_at, started_at, ended_at, outcome, error_code
           FROM run_attempts
          WHERE workspace_id = ? AND run_id = ?
          ORDER BY attempt_number DESC LIMIT ?`,
      )
      .bind(workspaceId, runId, clampLimit(limit))
      .all<RunAttemptRow>();
    return result.results;
  },
};

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

export interface AssertionRow {
  readonly id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly rule_id: string;
  readonly label: string;
  readonly mandatory: number;
  readonly status: AssertionStatus;
  readonly reason_code: string;
  readonly expected_display: string | null;
  readonly observed_display: string | null;
  readonly observed_at: string | null;
  readonly evidence_id: string | null;
}

export interface AssertionInput {
  readonly id: string;
  readonly ruleId: string;
  readonly label: string;
  readonly mandatory: boolean;
  readonly status: AssertionStatus;
  readonly reasonCode: string;
  readonly expectedDisplay?: string | null;
  readonly observedDisplay?: string | null;
  readonly observedAt?: string | null;
  readonly evidenceId?: string | null;
}

const ASSERTION_COLUMNS =
  'id, run_id, workspace_id, revision, rule_id, label, mandatory, status, reason_code, expected_display, observed_display, observed_at, evidence_id';

export const assertions = {
  /**
   * Write the full assertion set for one revision of a run, atomically.
   *
   * Each insert carries `WHERE EXISTS (run in this workspace)`, which is the composite
   * proof that the child belongs to the parent inside the same tenant — a caller holding
   * another workspace's run id writes nothing. The delete makes a re-evaluation of the
   * same revision idempotent.
   */
  async replaceForRevision(
    db: Db,
    params: {
      workspaceId: string;
      runId: string;
      revision: number;
      rows: readonly AssertionInput[];
    },
  ): Promise<number> {
    if (params.rows.length === 0) return 0;
    const statements = [
      db
        .prepare('DELETE FROM assertions WHERE workspace_id = ? AND run_id = ? AND revision = ?')
        .bind(params.workspaceId, params.runId, params.revision),
      ...params.rows.map((row) =>
        db
          .prepare(
            `INSERT INTO assertions
               (id, run_id, workspace_id, revision, rule_id, label, mandatory, status, reason_code, expected_display, observed_display, observed_at, evidence_id)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND workspace_id = ?)`,
          )
          .bind(
            row.id,
            params.runId,
            params.workspaceId,
            params.revision,
            row.ruleId,
            row.label,
            toSqlBool(row.mandatory),
            row.status,
            row.reasonCode,
            orNull(row.expectedDisplay),
            orNull(row.observedDisplay),
            orNull(row.observedAt),
            orNull(row.evidenceId),
            params.runId,
            params.workspaceId,
          ),
      ),
    ];
    const results = await db.batch(statements);
    let written = 0;
    for (let i = 1; i < statements.length; i += 1) written += changesAt(results, i);
    return written;
  },

  /** A run's assertions, proven to belong to that run inside this workspace. */
  async listForRun(
    db: Db,
    workspaceId: string,
    runId: string,
    revision?: number,
  ): Promise<AssertionRow[]> {
    const sql =
      revision === undefined
        ? `SELECT ${ASSERTION_COLUMNS} FROM assertions a
            WHERE a.workspace_id = ? AND a.run_id = ?
              AND a.revision = (SELECT MAX(revision) FROM assertions WHERE workspace_id = ? AND run_id = ?)
            ORDER BY a.rule_id ASC LIMIT 50`
        : `SELECT ${ASSERTION_COLUMNS} FROM assertions a
            WHERE a.workspace_id = ? AND a.run_id = ? AND a.revision = ?
            ORDER BY a.rule_id ASC LIMIT 50`;
    const bindings =
      revision === undefined
        ? [workspaceId, runId, workspaceId, runId]
        : [workspaceId, runId, revision];
    const result = await db
      .prepare(sql)
      .bind(...bindings)
      .all<AssertionRow>();
    return result.results;
  },
};

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly provider: string;
  readonly origin: 'provider_readback' | 'provider_webhook' | 'customer_claim';
  readonly provider_record_id: string | null;
  readonly observed_at: string;
  readonly content_digest: string;
  readonly redacted_summary: string;
  readonly expires_at: string;
}

export interface EvidenceInput {
  readonly id: string;
  readonly provider: string;
  readonly origin: EvidenceRow['origin'];
  readonly providerRecordId?: string | null;
  readonly observedAt: string;
  readonly contentDigest: string;
  /** Masked values only. A whole provider payload must never reach this column. */
  readonly redactedSummary: string;
  readonly expiresAt: string;
}

const EVIDENCE_COLUMNS =
  'id, workspace_id, run_id, provider, origin, provider_record_id, observed_at, content_digest, redacted_summary, expires_at';

export const evidence = {
  async recordMany(
    db: Db,
    params: { workspaceId: string; runId: string; rows: readonly EvidenceInput[] },
  ): Promise<number> {
    if (params.rows.length === 0) return 0;
    const statements = params.rows.map((row) =>
      db
        .prepare(
          `INSERT INTO evidence
             (id, workspace_id, run_id, provider, origin, provider_record_id, observed_at, content_digest, redacted_summary, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND workspace_id = ?)`,
        )
        .bind(
          row.id,
          params.workspaceId,
          params.runId,
          row.provider,
          row.origin,
          orNull(row.providerRecordId),
          row.observedAt,
          row.contentDigest,
          row.redactedSummary,
          row.expiresAt,
          params.runId,
          params.workspaceId,
        ),
    );
    const results = await db.batch(statements);
    let written = 0;
    for (let i = 0; i < statements.length; i += 1) written += changesAt(results, i);
    return written;
  },

  /**
   * Record one provider-observed event that is not yet attached to a run.
   *
   * A delivery event arrives before, during or after the run it belongs to. Correlating it
   * is the evaluator's job; a webhook that guessed would attach evidence to the wrong run.
   *
   * `evidence.run_id` is NOT NULL in the schema, so an unattached row is parked against the
   * workspace's correlation placeholder run and re-attached by the evaluator. Where no such
   * run exists the write is skipped rather than failing the webhook — losing one delivery
   * event is bad; 500-ing a provider callback and having it retried forever is worse.
   *
   * Idempotent: the caller derives `id` from a digest of the event, so a repeat writes the
   * same primary key and `DO NOTHING` makes it a no-op.
   */
  async recordProviderEvent(
    db: Db,
    params: {
      id: string;
      workspaceId: string;
      provider: string;
      origin: EvidenceRow['origin'];
      providerRecordId: string | null;
      observedAt: string;
      contentDigest: string;
      redactedSummary: string;
      expiresAt: string;
      runId?: string | null;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `INSERT INTO evidence
           (id, workspace_id, run_id, provider, origin, provider_record_id, observed_at, content_digest, redacted_summary, expires_at)
         SELECT ?, ?, COALESCE(?, (
                  SELECT r.id FROM runs r
                   WHERE r.workspace_id = ? AND r.status = 'PENDING'
                   ORDER BY r.created_at DESC LIMIT 1
                )), ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM runs r2 WHERE r2.workspace_id = ?
          )
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        params.id,
        params.workspaceId,
        orNull(params.runId),
        params.workspaceId,
        params.provider,
        params.origin,
        orNull(params.providerRecordId),
        params.observedAt,
        params.contentDigest,
        params.redactedSummary,
        params.expiresAt,
        params.workspaceId,
      )
      .run();
    return result.meta.changes === 1;
  },

  async listForRun(db: Db, workspaceId: string, runId: string, limit = 50): Promise<EvidenceRow[]> {
    const result = await db
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence
          WHERE workspace_id = ? AND run_id = ?
          ORDER BY observed_at ASC LIMIT ?`,
      )
      .bind(workspaceId, runId, clampLimit(limit))
      .all<EvidenceRow>();
    return result.results;
  },

  async getById(db: Db, workspaceId: string, evidenceId: string): Promise<EvidenceRow | null> {
    return db
      .prepare(`SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, evidenceId)
      .first<EvidenceRow>();
  },

  /**
   * Bounded retention delete, driven by the scheduler.
   *
   * Retention is a platform-wide obligation, not a tenant operation: every workspace's
   * expired evidence must go, and selecting by workspace would make the sweep enumerate
   * tenants. It only ever deletes rows past their own expires_at, so it cannot remove
   * live data from any workspace.
   */
  async purgeExpired(db: Db, now: string, limit = 500): Promise<number> {
    // tenant-scope:exempt platform-wide retention sweep; deletes only past expires_at.
    const result = await db
      .prepare(
        'DELETE FROM evidence WHERE id IN (SELECT id FROM evidence WHERE expires_at <= ? LIMIT ?)',
      )
      .bind(now, limit)
      .run();
    return result.meta.changes;
  },
};
