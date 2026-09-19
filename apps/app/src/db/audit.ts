/**
 * Audit trail and platform settings.
 *
 * An audit row must be readable by a human a year later and must never contain a secret.
 * `redacted_metadata` is a JSON string produced by `redactObject()` from
 * `@verify/security`; this layer stores whatever it is given, so the redaction has to
 * happen at the call site, where the allowlist is known.
 */
import { buildPage, clampLimit, decodeCursor, type Page, type PageRequest } from './cursor';
import { type Db, orNull } from './d1';

export type ActorKind = 'user' | 'system' | 'provider' | 'runner' | 'automation';

export interface AuditEventRow {
  readonly id: string;
  readonly actor: string;
  readonly actor_kind: ActorKind;
  readonly workspace_id: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly request_id: string | null;
  readonly occurred_at: string;
  readonly redacted_metadata: string | null;
}

const AUDIT_COLUMNS =
  'id, actor, actor_kind, workspace_id, action, target, request_id, occurred_at, redacted_metadata';

export const auditEvents = {
  async record(
    db: Db,
    params: {
      id: string;
      actor: string;
      actorKind: ActorKind;
      action: string;
      occurredAt: string;
      workspaceId?: string | null;
      target?: string | null;
      requestId?: string | null;
      /** Already-redacted JSON. Never a raw payload. */
      redactedMetadata?: string | null;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO audit_events (id, actor, actor_kind, workspace_id, action, target, request_id, occurred_at, redacted_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.actor,
        params.actorKind,
        orNull(params.workspaceId),
        params.action,
        orNull(params.target),
        orNull(params.requestId),
        params.occurredAt,
        orNull(params.redactedMetadata),
      )
      .run();
  },

  /**
   * A workspace's own audit trail. Note the cursor pages on `(occurred_at, id)` here
   * because that is this table's natural order and its index.
   */
  async listForWorkspace(
    db: Db,
    workspaceId: string,
    page: PageRequest = {},
  ): Promise<Page<AuditEventRow & { created_at: string }>> {
    const limit = clampLimit(page.limit);
    const cursor = decodeCursor(page.cursor);
    const sql = cursor
      ? `SELECT ${AUDIT_COLUMNS}, occurred_at AS created_at FROM audit_events
          WHERE workspace_id = ? AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
          ORDER BY occurred_at DESC, id DESC LIMIT ?`
      : `SELECT ${AUDIT_COLUMNS}, occurred_at AS created_at FROM audit_events
          WHERE workspace_id = ?
          ORDER BY occurred_at DESC, id DESC LIMIT ?`;
    const bindings = cursor
      ? [workspaceId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
      : [workspaceId, limit + 1];
    const result = await db
      .prepare(sql)
      .bind(...bindings)
      .all<AuditEventRow & { created_at: string }>();
    return buildPage(result.results, limit);
  },

  /** Platform-wide trail for the owner dashboard. Deliberately not workspace-scoped. */
  async listPlatform(db: Db, limit = 50): Promise<AuditEventRow[]> {
    const result = await db
      .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_events ORDER BY occurred_at DESC LIMIT ?`)
      .bind(clampLimit(limit))
      .all<AuditEventRow>();
    return result.results;
  },
};

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export interface SettingRow {
  readonly key: string;
  readonly value_json: string;
  readonly updated_at: string;
  readonly updated_by: string | null;
}

export const settings = {
  async get(db: Db, key: string): Promise<SettingRow | null> {
    return db
      .prepare('SELECT key, value_json, updated_at, updated_by FROM settings WHERE key = ?')
      .bind(key)
      .first<SettingRow>();
  },

  /**
   * Read a setting as parsed JSON, falling back when it is absent or unparseable. A
   * corrupted settings row must never take the site down.
   */
  async getJson<T>(db: Db, key: string, fallback: T): Promise<T> {
    const row = await settings.get(db, key);
    if (row === null) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  },

  async set(
    db: Db,
    params: { key: string; valueJson: string; updatedAt: string; updatedBy?: string | null },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .bind(params.key, params.valueJson, params.updatedAt, orNull(params.updatedBy))
      .run();
  },

  async list(db: Db, limit = 100): Promise<SettingRow[]> {
    const result = await db
      .prepare('SELECT key, value_json, updated_at, updated_by FROM settings ORDER BY key ASC LIMIT ?')
      .bind(clampLimit(limit))
      .all<SettingRow>();
    return result.results;
  },
};
