/**
 * Workflows and their immutable versions.
 *
 * A workflow version is never edited. Editing rules creates a new version row; runs hold
 * the version id they were evaluated against, so a report from three weeks ago still
 * shows the rules that actually applied.
 */
import { type Db, orNull, resultAt } from './d1';
import { buildPage, clampLimit, decodeCursor, type Page, type PageRequest } from './cursor';

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type CoverageMode = 'customer_triggered' | 'independently_sourced';

export interface WorkflowRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly current_version_id: string | null;
  readonly coverage_mode: CoverageMode;
  readonly signing_key_hash: string | null;
  readonly signing_key_ref: string | null;
  readonly last_event_at: string | null;
  readonly expected_activity: string | null;
  readonly created_at: string;
  readonly archived_at: string | null;
}

const WORKFLOW_COLUMNS =
  'id, workspace_id, name, status, current_version_id, coverage_mode, signing_key_hash, signing_key_ref, last_event_at, expected_activity, created_at, archived_at';

export const workflows = {
  async create(
    db: Db,
    params: {
      id: string;
      workspaceId: string;
      name: string;
      coverageMode: CoverageMode;
      createdAt: string;
      signingKeyHash?: string | null;
      signingKeyRef?: string | null;
      expectedActivity?: string | null;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO workflows (id, workspace_id, name, status, coverage_mode, signing_key_hash, signing_key_ref, expected_activity, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.workspaceId,
        params.name,
        params.coverageMode,
        orNull(params.signingKeyHash),
        orNull(params.signingKeyRef),
        orNull(params.expectedActivity),
        params.createdAt,
      )
      .run();
  },

  async get(db: Db, workspaceId: string, workflowId: string): Promise<WorkflowRow | null> {
    return db
      .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, workflowId)
      .first<WorkflowRow>();
  },

  async list(db: Db, workspaceId: string, page: PageRequest = {}): Promise<Page<WorkflowRow>> {
    const limit = clampLimit(page.limit);
    const cursor = decodeCursor(page.cursor);
    const sql = cursor
      ? `SELECT ${WORKFLOW_COLUMNS} FROM workflows
          WHERE workspace_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`
      : `SELECT ${WORKFLOW_COLUMNS} FROM workflows
          WHERE workspace_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`;
    const bindings = cursor
      ? [workspaceId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
      : [workspaceId, limit + 1];
    const result = await db.prepare(sql).bind(...bindings).all<WorkflowRow>();
    return buildPage(result.results, limit);
  },

  /**
   * Resolve the workflow an inbound signed event names, together with its active version.
   * Returns null when the workflow is not this workspace's, is archived, or has no
   * published version — all three mean "we cannot start a run", and the caller must not
   * be able to tell them apart from outside.
   */
  async getActiveWithVersion(
    db: Db,
    workspaceId: string,
    workflowId: string,
  ): Promise<{
    workflow_id: string;
    signing_key_hash: string | null;
    version_id: string;
    rules_json: string;
    deadline_seconds: number;
  } | null> {
    return db
      .prepare(
        `SELECT w.id AS workflow_id, w.signing_key_hash, v.id AS version_id, v.rules_json, v.deadline_seconds
           FROM workflows w
           JOIN workflow_versions v ON v.id = w.current_version_id AND v.workspace_id = w.workspace_id
          WHERE w.workspace_id = ? AND w.id = ? AND w.status = 'active' AND w.archived_at IS NULL`,
      )
      .bind(workspaceId, workflowId)
      .first<{
        workflow_id: string;
        signing_key_hash: string | null;
        version_id: string;
        rules_json: string;
        deadline_seconds: number;
      }>();
  },

  async setStatus(
    db: Db,
    workspaceId: string,
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<boolean> {
    const result = await db
      .prepare('UPDATE workflows SET status = ? WHERE workspace_id = ? AND id = ? AND archived_at IS NULL')
      .bind(status, workspaceId, workflowId)
      .run();
    return result.meta.changes === 1;
  },

  async archive(db: Db, workspaceId: string, workflowId: string, at: string): Promise<boolean> {
    const result = await db
      .prepare(
        "UPDATE workflows SET status = 'archived', archived_at = ? WHERE workspace_id = ? AND id = ? AND archived_at IS NULL",
      )
      .bind(at, workspaceId, workflowId)
      .run();
    return result.meta.changes === 1;
  },

  /** Drives the inactivity warning, which is distinct from a failure. */
  async touchLastEvent(
    db: Db,
    workspaceId: string,
    workflowId: string,
    at: string,
  ): Promise<void> {
    await db
      .prepare(
        `UPDATE workflows SET last_event_at = ?
          WHERE workspace_id = ? AND id = ? AND (last_event_at IS NULL OR last_event_at < ?)`,
      )
      .bind(at, workspaceId, workflowId, at)
      .run();
  },

  async setSigningKey(
    db: Db,
    workspaceId: string,
    workflowId: string,
    params: { signingKeyHash: string; signingKeyRef: string },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        'UPDATE workflows SET signing_key_hash = ?, signing_key_ref = ? WHERE workspace_id = ? AND id = ?',
      )
      .bind(params.signingKeyHash, params.signingKeyRef, workspaceId, workflowId)
      .run();
    return result.meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// workflow versions
// ---------------------------------------------------------------------------

export interface WorkflowVersionRow {
  readonly id: string;
  readonly workflow_id: string;
  readonly workspace_id: string;
  readonly version_number: number;
  readonly rules_json: string;
  readonly rules_hash: string;
  readonly deadline_seconds: number;
  readonly schema_version: number;
  readonly created_by: string;
  readonly created_at: string;
}

const VERSION_COLUMNS =
  'id, workflow_id, workspace_id, version_number, rules_json, rules_hash, deadline_seconds, schema_version, created_by, created_at';

export const workflowVersions = {
  /**
   * Publish a new immutable version and point the workflow at it, atomically.
   *
   * `version_number` is derived inside the INSERT from the existing maximum for this
   * workflow, so two concurrent publishes cannot both claim the same number: the loser
   * hits `UNIQUE (workflow_id, version_number)` and the whole batch rolls back.
   */
  async publish(
    db: Db,
    params: {
      id: string;
      workspaceId: string;
      workflowId: string;
      rulesJson: string;
      rulesHash: string;
      deadlineSeconds: number;
      schemaVersion: number;
      createdBy: string;
      createdAt: string;
      activate?: boolean;
    },
  ): Promise<void> {
    const statements = [
      db
        .prepare(
          `INSERT INTO workflow_versions
             (id, workflow_id, workspace_id, version_number, rules_json, rules_hash, deadline_seconds, schema_version, created_by, created_at)
           SELECT ?, ?, ?,
                  COALESCE((SELECT MAX(version_number) FROM workflow_versions WHERE workflow_id = ?), 0) + 1,
                  ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?)`,
        )
        .bind(
          params.id,
          params.workflowId,
          params.workspaceId,
          params.workflowId,
          params.rulesJson,
          params.rulesHash,
          params.deadlineSeconds,
          params.schemaVersion,
          params.createdBy,
          params.createdAt,
          params.workflowId,
          params.workspaceId,
        ),
      db
        .prepare(
          `UPDATE workflows
              SET current_version_id = ?, status = CASE WHEN ? = 1 THEN 'active' ELSE status END
            WHERE workspace_id = ? AND id = ?`,
        )
        .bind(params.id, params.activate === false ? 0 : 1, params.workspaceId, params.workflowId),
    ];
    const results = await db.batch(statements);
    if (resultAt(results, 0).meta.changes !== 1) {
      throw new Error('workflowVersions.publish: workflow not found in this workspace');
    }
  },

  async get(db: Db, workspaceId: string, versionId: string): Promise<WorkflowVersionRow | null> {
    return db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM workflow_versions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, versionId)
      .first<WorkflowVersionRow>();
  },

  /** Child-within-parent lookup: the version must belong to this workflow *and* tenant. */
  async getForWorkflow(
    db: Db,
    workspaceId: string,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersionRow | null> {
    return db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM workflow_versions
          WHERE workspace_id = ? AND workflow_id = ? AND id = ?`,
      )
      .bind(workspaceId, workflowId, versionId)
      .first<WorkflowVersionRow>();
  },

  async listForWorkflow(
    db: Db,
    workspaceId: string,
    workflowId: string,
    limit = 20,
  ): Promise<WorkflowVersionRow[]> {
    const result = await db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM workflow_versions
          WHERE workspace_id = ? AND workflow_id = ?
          ORDER BY version_number DESC LIMIT ?`,
      )
      .bind(workspaceId, workflowId, clampLimit(limit))
      .all<WorkflowVersionRow>();
    return result.results;
  },
};
