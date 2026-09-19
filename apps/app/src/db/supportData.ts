/**
 * Support cases, notification deliveries, retention sweeps and export pages.
 *
 * Three shapes in here are load-bearing and were named as such by A09:
 *
 *  - `claimNotification` is insert-once. A duplicate must return the EXISTING row and
 *    report `inserted: false`, because the caller's next line sends an email.
 *  - `transitionCase` carries the expected state in its `WHERE`. Two owners answering the
 *    same case at the same moment must not both believe they won.
 *  - retention reads are keyset scans on an existing index. An `OFFSET` sweep degrades
 *    silently as the table grows until the cron job times out and retention quietly stops
 *    happening — which is the failure you discover from a regulator, not a dashboard.
 *
 * The per-target SQL is a frozen table rather than an assembled string. Table and column
 * names cannot be bound as parameters, so the only safe way to vary them is to enumerate
 * every legal statement in advance (the same reasoning as `budget.ts` after AUTH-203).
 */
import { type Db, orNull } from './d1';

// ---------------------------------------------------------------------------
// support cases
// ---------------------------------------------------------------------------

export type SupportCaseState = 'open' | 'awaiting_owner' | 'answered' | 'escalated' | 'closed';
export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportCaseRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly contact_email: string;
  readonly subject: string;
  readonly body_redacted: string;
  readonly category: string;
  readonly priority: SupportPriority;
  readonly state: SupportCaseState;
  readonly linked_run_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const CASE_COLUMNS =
  'id, workspace_id, contact_email, subject, body_redacted, category, priority, state, linked_run_id, created_at, updated_at';

export const supportCases = {
  async insert(db: Db, row: SupportCaseRow): Promise<void> {
    await db
      .prepare(
        `INSERT INTO support_cases (id, workspace_id, contact_email, subject, body_redacted, category, priority, state, linked_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        orNull(row.workspace_id),
        row.contact_email,
        row.subject,
        row.body_redacted,
        row.category,
        row.priority,
        row.state,
        orNull(row.linked_run_id),
        row.created_at,
        row.updated_at,
      )
      .run();
  },

  /**
   * Tenant-scoped read. `null` as the workspace means "a signed-out submission", which is
   * a real scope and not a wildcard — `workspace_id IS NULL` rather than no predicate.
   */
  async get(db: Db, id: string, workspaceId: string | null): Promise<SupportCaseRow | null> {
    if (workspaceId === null) {
      return db
        .prepare(`SELECT ${CASE_COLUMNS} FROM support_cases WHERE id = ? AND workspace_id IS NULL`)
        .bind(id)
        .first<SupportCaseRow>();
    }
    return db
      .prepare(`SELECT ${CASE_COLUMNS} FROM support_cases WHERE id = ? AND workspace_id = ?`)
      .bind(id, workspaceId)
      .first<SupportCaseRow>();
  },

  /**
   * The platform owner's queue reads any tenant's case, because answering support is the
   * one job that cannot be done from inside a single workspace. Named `forOwner` so it
   * cannot be reached by autocomplete from a customer-facing path.
   *
   * tenant-scope:exempt platform-owner support queue; the only cross-tenant case read.
   */
  async getForOwner(db: Db, id: string): Promise<SupportCaseRow | null> {
    return db
      .prepare(`SELECT ${CASE_COLUMNS} FROM support_cases WHERE id = ?`)
      .bind(id)
      .first<SupportCaseRow>();
  },

  /**
   * Keyset page over `(created_at DESC, id DESC)`.
   *
   * `scope` distinguishes three things a single nullable parameter cannot: every
   * workspace (owner queue), one workspace, and the signed-out submissions.
   */
  async list(
    db: Db,
    query: {
      scope: { kind: 'all' } | { kind: 'workspace'; workspaceId: string } | { kind: 'anonymous' };
      state?: SupportCaseState;
      limit: number;
      cursor: { createdAt: string; id: string } | null;
    },
  ): Promise<SupportCaseRow[]> {
    const limit = Math.min(Math.max(1, query.limit), 100);
    const bindings: unknown[] = [];

    // tenant-scope:exempt the 'all' scope is the platform-owner queue; see getForOwner.
    let scopeClause: string;
    if (query.scope.kind === 'workspace') {
      scopeClause = 'workspace_id = ?';
      bindings.push(query.scope.workspaceId);
    } else if (query.scope.kind === 'anonymous') {
      scopeClause = 'workspace_id IS NULL';
    } else {
      scopeClause = '1 = 1';
    }

    let stateClause = '';
    if (query.state !== undefined) {
      stateClause = ' AND state = ?';
      bindings.push(query.state);
    }
    let cursorClause = '';
    if (query.cursor !== null) {
      cursorClause = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      bindings.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
    }
    bindings.push(limit);

    const sql =
      `SELECT ${CASE_COLUMNS} FROM support_cases WHERE ` +
      scopeClause +
      stateClause +
      cursorClause +
      ' ORDER BY created_at DESC, id DESC LIMIT ?';
    const result = await db.prepare(sql).bind(...bindings).all<SupportCaseRow>();
    return result.results;
  },

  /**
   * One statement with the expected state in the `WHERE`.
   *
   * Returns false when nothing changed, which means somebody else moved the case first.
   * A read-then-write here would let two owners both think they escalated it.
   */
  async transition(
    db: Db,
    params: {
      id: string;
      workspaceId?: string | null;
      expectedState: SupportCaseState;
      nextState: SupportCaseState;
      priority?: SupportPriority;
      updatedAt: string;
    },
  ): Promise<boolean> {
    const bindings: unknown[] = [params.nextState, orNull(params.priority), params.updatedAt];
    let scopeClause = '';
    if (params.workspaceId === null) {
      scopeClause = ' AND workspace_id IS NULL';
    } else if (params.workspaceId !== undefined) {
      scopeClause = ' AND workspace_id = ?';
    }

    const sql =
      `UPDATE support_cases
          SET state = ?, priority = COALESCE(?, priority), updated_at = ?
        WHERE id = ? AND state = ?` + scopeClause;

    bindings.push(params.id, params.expectedState);
    if (params.workspaceId !== null && params.workspaceId !== undefined) {
      bindings.push(params.workspaceId);
    }
    const result = await db.prepare(sql).bind(...bindings).run();
    return result.meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// notification deliveries
// ---------------------------------------------------------------------------

export type NotificationState = 'pending' | 'sent' | 'failed' | 'suppressed';

export interface NotificationRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly notification_key: string;
  readonly channel: string;
  readonly recipient_hash: string;
  readonly template: string;
  readonly state: NotificationState;
  readonly attempt_count: number;
  readonly provider_status: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
}

const NOTIFICATION_COLUMNS =
  'id, workspace_id, notification_key, channel, recipient_hash, template, state, attempt_count, provider_status, created_at, sent_at';

export const notifications = {
  /**
   * Claim the right to send exactly one message for this key.
   *
   * `ON CONFLICT(notification_key) DO NOTHING` plus `meta.changes`. `inserted: false`
   * means somebody already claimed it and the caller must send nothing — which is why the
   * existing row comes back rather than the one the caller offered.
   */
  async claim(
    db: Db,
    row: Omit<NotificationRow, 'state' | 'attempt_count' | 'provider_status' | 'sent_at'>,
  ): Promise<{ inserted: boolean; record: NotificationRow }> {
    const result = await db
      .prepare(
        `INSERT INTO notification_deliveries (id, workspace_id, notification_key, channel, recipient_hash, template, state, attempt_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
         ON CONFLICT(notification_key) DO NOTHING`,
      )
      .bind(
        row.id,
        orNull(row.workspace_id),
        row.notification_key,
        row.channel,
        row.recipient_hash,
        row.template,
        row.created_at,
      )
      .run();

    const stored = await notifications.getByKey(db, row.notification_key);
    if (stored === null) throw new Error('notifications.claim wrote no row');
    return { inserted: result.meta.changes === 1, record: stored };
  },

  async getByKey(db: Db, notificationKey: string): Promise<NotificationRow | null> {
    return db
      .prepare(
        `SELECT ${NOTIFICATION_COLUMNS} FROM notification_deliveries WHERE notification_key = ?`,
      )
      .bind(notificationKey)
      .first<NotificationRow>();
  },

  /** Record what the sending service said. Never a delivery claim. */
  async settle(
    db: Db,
    params: {
      notificationKey: string;
      state: NotificationState;
      attemptCount: number;
      providerStatus: string | null;
      settledAt: string;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE notification_deliveries
            SET state = ?, attempt_count = ?, provider_status = ?,
                sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
          WHERE notification_key = ?`,
      )
      .bind(
        params.state,
        params.attemptCount,
        orNull(params.providerStatus),
        params.state,
        params.settledAt,
        params.notificationKey,
      )
      .run();
    return result.meta.changes === 1;
  },

  /** Newest first. Answers "did we already tell them about this?". */
  async findHistory(
    db: Db,
    query: {
      workspaceId: string | null;
      template: string;
      since: string;
      keyPrefix?: string;
      limit?: number;
    },
  ): Promise<NotificationRow[]> {
    const bindings: unknown[] = [];
    const scopeClause =
      query.workspaceId === null ? 'workspace_id IS NULL' : 'workspace_id = ?';
    if (query.workspaceId !== null) bindings.push(query.workspaceId);
    bindings.push(query.template, query.since);

    let prefixClause = '';
    if (query.keyPrefix !== undefined && query.keyPrefix.length > 0) {
      // GLOB, not LIKE: `_` and `%` are wildcards in LIKE and notification keys contain
      // both, so a LIKE prefix would quietly match more than it was asked to.
      prefixClause = ' AND notification_key GLOB ?';
      bindings.push(`${query.keyPrefix}*`);
    }
    bindings.push(Math.min(Math.max(1, query.limit ?? 50), 200));

    const sql =
      `SELECT ${NOTIFICATION_COLUMNS} FROM notification_deliveries WHERE ` +
      scopeClause +
      ' AND template = ? AND created_at >= ?' +
      prefixClause +
      ' ORDER BY created_at DESC, id DESC LIMIT ?';
    const result = await db.prepare(sql).bind(...bindings).all<NotificationRow>();
    return result.results;
  },
};

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

export type RetentionTarget =
  | 'evidence'
  | 'visit_sessions'
  | 'rate_limits'
  | 'login_tokens'
  | 'sessions'
  | 'webhook_receipts'
  | 'source_events'
  | 'audit_events'
  | 'notification_deliveries'
  | 'support_cases';

interface RetentionPlan {
  /** Keyset page, bound as (expiredAt, afterId, limit) — or (expiredAt, limit) at the start. */
  readonly listSql: string;
  readonly listFirstPageSql: string;
  /** Same, narrowed to one workspace. `null` when the table has no workspace column. */
  readonly listForWorkspaceSql: string | null;
  readonly listForWorkspaceFirstPageSql: string | null;
  /** Delete exactly one row by its key. Batched by the caller. */
  readonly deleteOneSql: string;
  /** Bounded workspace purge, ignoring expiry. `null` when the table has no workspace. */
  readonly purgeSql: string | null;
}

/**
 * Every statement retention is allowed to run, enumerated.
 *
 * Note the key column is not always `id`: `rate_limits` is keyed by `bucket` and
 * `login_tokens` by `token_hash`. That is exactly why this is a table of whole statements
 * and not a template with a column name substituted in.
 *
 * tenant-scope:exempt the cron sweep is platform-wide by definition; the per-workspace
 * variants below carry workspace_id, and the sweep only ever removes rows past their own
 * expiry column.
 */
const RETENTION: Readonly<Record<RetentionTarget, RetentionPlan>> = {
  evidence: {
    // Expiry-driven sweep across every tenant. The predicate is the row's own expires_at,
    // so only rows already past it are eligible; it is keyset-paged on the primary key, so
    // it cannot degrade into a full scan; and workspace_id is selected so the caller
    // scopes everything it does with the result.
    // tenant-scope:exempt expiry-driven retention sweep; see above.
    listFirstPageSql:
      'SELECT id, workspace_id FROM evidence WHERE expires_at <= ? ORDER BY id LIMIT ?',
    // tenant-scope:exempt as above; this is the same sweep resumed from a keyset position.
    listSql:
      'SELECT id, workspace_id FROM evidence WHERE expires_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql:
      'SELECT id, workspace_id FROM evidence WHERE expires_at <= ? AND workspace_id = ? ORDER BY id LIMIT ?',
    listForWorkspaceSql:
      'SELECT id, workspace_id FROM evidence WHERE expires_at <= ? AND id > ? AND workspace_id = ? ORDER BY id LIMIT ?',
    // tenant-scope:exempt deletes one id the caller already read from a scoped listExpired
    // page; the page carried the tenant predicate, this removes exactly what it returned.
    deleteOneSql: 'DELETE FROM evidence WHERE id = ?',
    purgeSql: 'DELETE FROM evidence WHERE id IN (SELECT id FROM evidence WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  },
  source_events: {
    // Expiry-driven sweep across every tenant. The predicate is the row's own received_at
    // against the retention cut-off, so only rows already past it are eligible; it is
    // keyset-paged on the primary key, so it cannot degrade into a full scan; and
    // workspace_id is selected so the caller scopes what it does next.
    // tenant-scope:exempt expiry-driven retention sweep; see above.
    listFirstPageSql:
      'SELECT id, workspace_id FROM source_events WHERE received_at <= ? ORDER BY id LIMIT ?',
    // tenant-scope:exempt as above; this is the same sweep resumed from a keyset position.
    listSql:
      'SELECT id, workspace_id FROM source_events WHERE received_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql:
      'SELECT id, workspace_id FROM source_events WHERE received_at <= ? AND workspace_id = ? ORDER BY id LIMIT ?',
    listForWorkspaceSql:
      'SELECT id, workspace_id FROM source_events WHERE received_at <= ? AND id > ? AND workspace_id = ? ORDER BY id LIMIT ?',
    // tenant-scope:exempt deletes one id the caller already read from a scoped listExpired
    // page; the page carried the tenant predicate, this removes exactly what it returned.
    deleteOneSql: 'DELETE FROM source_events WHERE id = ?',
    purgeSql:
      'DELETE FROM source_events WHERE id IN (SELECT id FROM source_events WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  },
  webhook_receipts: {
    listFirstPageSql:
      'SELECT id, workspace_id FROM webhook_receipts WHERE received_at <= ? ORDER BY id LIMIT ?',
    listSql:
      'SELECT id, workspace_id FROM webhook_receipts WHERE received_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql:
      'SELECT id, workspace_id FROM webhook_receipts WHERE received_at <= ? AND workspace_id = ? ORDER BY id LIMIT ?',
    listForWorkspaceSql:
      'SELECT id, workspace_id FROM webhook_receipts WHERE received_at <= ? AND id > ? AND workspace_id = ? ORDER BY id LIMIT ?',
    deleteOneSql: 'DELETE FROM webhook_receipts WHERE id = ?',
    purgeSql:
      'DELETE FROM webhook_receipts WHERE id IN (SELECT id FROM webhook_receipts WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  },
  audit_events: {
    listFirstPageSql:
      'SELECT id, workspace_id FROM audit_events WHERE occurred_at <= ? ORDER BY id LIMIT ?',
    listSql:
      'SELECT id, workspace_id FROM audit_events WHERE occurred_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql:
      'SELECT id, workspace_id FROM audit_events WHERE occurred_at <= ? AND workspace_id = ? ORDER BY id LIMIT ?',
    listForWorkspaceSql:
      'SELECT id, workspace_id FROM audit_events WHERE occurred_at <= ? AND id > ? AND workspace_id = ? ORDER BY id LIMIT ?',
    deleteOneSql: 'DELETE FROM audit_events WHERE id = ?',
    purgeSql:
      'DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  },
  notification_deliveries: {
    listFirstPageSql:
      'SELECT id, workspace_id FROM notification_deliveries WHERE created_at <= ? ORDER BY id LIMIT ?',
    listSql:
      'SELECT id, workspace_id FROM notification_deliveries WHERE created_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql:
      'SELECT id, workspace_id FROM notification_deliveries WHERE created_at <= ? AND workspace_id = ? ORDER BY id LIMIT ?',
    listForWorkspaceSql:
      'SELECT id, workspace_id FROM notification_deliveries WHERE created_at <= ? AND id > ? AND workspace_id = ? ORDER BY id LIMIT ?',
    deleteOneSql: 'DELETE FROM notification_deliveries WHERE id = ?',
    purgeSql:
      'DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM notification_deliveries WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  },
  support_cases: {
    listFirstPageSql:
      'SELECT id, workspace_id FROM support_cases WHERE updated_at <= ? ORDER BY id LIMIT ?',
    listSql:
      'SELECT id, workspace_id FROM support_cases WHERE updated_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql:
      'SELECT id, workspace_id FROM support_cases WHERE updated_at <= ? AND workspace_id = ? ORDER BY id LIMIT ?',
    listForWorkspaceSql:
      'SELECT id, workspace_id FROM support_cases WHERE updated_at <= ? AND id > ? AND workspace_id = ? ORDER BY id LIMIT ?',
    deleteOneSql: 'DELETE FROM support_cases WHERE id = ?',
    purgeSql:
      'DELETE FROM support_cases WHERE id IN (SELECT id FROM support_cases WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  },
  // --- tables with no workspace column: swept globally, never purged per workspace ---
  sessions: {
    listFirstPageSql:
      'SELECT id, NULL AS workspace_id FROM sessions WHERE expires_at <= ? ORDER BY id LIMIT ?',
    listSql:
      'SELECT id, NULL AS workspace_id FROM sessions WHERE expires_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql: null,
    listForWorkspaceSql: null,
    deleteOneSql: 'DELETE FROM sessions WHERE id = ?',
    purgeSql: null,
  },
  login_tokens: {
    listFirstPageSql:
      'SELECT token_hash AS id, NULL AS workspace_id FROM login_tokens WHERE expires_at <= ? ORDER BY token_hash LIMIT ?',
    listSql:
      'SELECT token_hash AS id, NULL AS workspace_id FROM login_tokens WHERE expires_at <= ? AND token_hash > ? ORDER BY token_hash LIMIT ?',
    listForWorkspaceFirstPageSql: null,
    listForWorkspaceSql: null,
    deleteOneSql: 'DELETE FROM login_tokens WHERE token_hash = ?',
    purgeSql: null,
  },
  rate_limits: {
    listFirstPageSql:
      'SELECT bucket AS id, NULL AS workspace_id FROM rate_limits WHERE expires_at <= ? ORDER BY bucket LIMIT ?',
    listSql:
      'SELECT bucket AS id, NULL AS workspace_id FROM rate_limits WHERE expires_at <= ? AND bucket > ? ORDER BY bucket LIMIT ?',
    listForWorkspaceFirstPageSql: null,
    listForWorkspaceSql: null,
    deleteOneSql: 'DELETE FROM rate_limits WHERE bucket = ?',
    purgeSql: null,
  },
  visit_sessions: {
    listFirstPageSql:
      'SELECT id, NULL AS workspace_id FROM visit_sessions WHERE expires_at <= ? ORDER BY id LIMIT ?',
    listSql:
      'SELECT id, NULL AS workspace_id FROM visit_sessions WHERE expires_at <= ? AND id > ? ORDER BY id LIMIT ?',
    listForWorkspaceFirstPageSql: null,
    listForWorkspaceSql: null,
    deleteOneSql: 'DELETE FROM visit_sessions WHERE id = ?',
    purgeSql: null,
  },
};

/**
 * Tables that are never swept on a timer but must be emptied when a workspace is deleted.
 *
 * A09 widened `purgeWorkspaceRows` to cover these after finding that the deletion email
 * promised to remove workflow configuration and provider connections that deletion was in
 * fact leaving behind — the worst kind of gap, because the promise was already published.
 *
 * **The order these are purged in is a foreign-key order, not a preference.**
 * `runs.workflow_version_id` references `workflow_versions(id)` with no `ON DELETE`
 * clause, so it defaults to NO ACTION. Deleting `workflows` while any run still points at
 * one of its versions fails on that constraint, halfway through a deletion. Source events
 * must go first — they cascade to runs, attempts, assertions and evidence — and only then
 * workflows. `privacy/deletion.ts` already sequences its steps that way; PERSIST-280 and
 * PERSIST-281 below prove the constraint is real and that the order satisfies it.
 *
 * `connections` is the one that makes a published sentence true: deleting it cascades to
 * `credential_versions`, which is what turns "the credentials you gave us are deleted"
 * from a hope into a fact. PERSIST-282 proves that cascade fires.
 */
export type PurgeOnlyTarget = 'workflows' | 'connections' | 'memberships';
export type PurgeTarget = RetentionTarget | PurgeOnlyTarget;

const PURGE_ONLY: Readonly<Record<PurgeOnlyTarget, string>> = {
  // Takes workflow_versions with it by cascade. Must run AFTER source_events.
  workflows:
    'DELETE FROM workflows WHERE id IN (SELECT id FROM workflows WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  // Takes credential_versions with it by cascade — the sentence in the deletion email.
  connections:
    'DELETE FROM connections WHERE id IN (SELECT id FROM connections WHERE workspace_id = ? ORDER BY id LIMIT ?)',
  // Composite primary key (workspace_id, user_id), so the keyset column is user_id.
  memberships:
    'DELETE FROM memberships WHERE workspace_id = ? AND user_id IN (SELECT user_id FROM memberships WHERE workspace_id = ? ORDER BY user_id LIMIT ?)',
};

export interface ExpiredRowRef {
  readonly id: string;
  readonly workspace_id: string | null;
}

export const retention = {
  /**
   * One keyset page of expired rows.
   *
   * `WHERE <expiry> <= ? AND <key> > ? ORDER BY <key> LIMIT ?` — no `OFFSET`, so the cost
   * of page N is the same as page 1 no matter how big the table has become.
   */
  async listExpired(
    db: Db,
    params: {
      target: RetentionTarget;
      expiredAt: string;
      afterId: string | null;
      limit: number;
      workspaceId?: string;
    },
  ): Promise<ExpiredRowRef[]> {
    const plan = RETENTION[params.target];
    const limit = Math.min(Math.max(1, params.limit), 500);

    if (params.workspaceId !== undefined) {
      const sql =
        params.afterId === null ? plan.listForWorkspaceFirstPageSql : plan.listForWorkspaceSql;
      if (sql === null) return [];
      const bindings =
        params.afterId === null
          ? [params.expiredAt, params.workspaceId, limit]
          : [params.expiredAt, params.afterId, params.workspaceId, limit];
      const scoped = await db.prepare(sql).bind(...bindings).all<ExpiredRowRef>();
      return scoped.results;
    }

    const sql = params.afterId === null ? plan.listFirstPageSql : plan.listSql;
    const bindings =
      params.afterId === null ? [params.expiredAt, limit] : [params.expiredAt, params.afterId, limit];
    const result = await db.prepare(sql).bind(...bindings).all<ExpiredRowRef>();
    return result.results;
  },

  /**
   * Delete exactly these keys from exactly this table, in one transaction.
   *
   * One statement per key rather than an `IN (?, ?, …)` list whose placeholder count is
   * built at runtime: the batch is still a single transaction, and there is no
   * string-building anywhere near a DELETE.
   */
  async deleteRows(db: Db, target: RetentionTarget, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const plan = RETENTION[target];
    const statements = ids.map((id) => db.prepare(plan.deleteOneSql).bind(id));
    const results = await db.batch(statements);
    let removed = 0;
    for (const result of results) removed += result.meta.changes;
    return removed;
  },

  /**
   * Bounded per-workspace purge, ignoring expiry. Used only by account deletion.
   *
   * Returns rows removed; zero means this table is empty for this workspace and the
   * caller stops. Tables with no workspace column return zero and are handled by their
   * own paths (`revokeSessions`, the global sweeps).
   */
  async purgeWorkspaceRows(
    db: Db,
    workspaceId: string,
    target: PurgeTarget,
    limit: number,
  ): Promise<number> {
    const bounded = Math.min(Math.max(1, limit), 500);

    if (target in PURGE_ONLY) {
      const sql = PURGE_ONLY[target as PurgeOnlyTarget];
      // memberships binds the workspace twice: once for the delete's own predicate and
      // once for the bounded keyset subquery.
      const result = await db
        .prepare(sql)
        .bind(
          ...(target === 'memberships'
            ? [workspaceId, workspaceId, bounded]
            : [workspaceId, bounded]),
        )
        .run();
      return result.meta.changes;
    }

    const plan = RETENTION[target as RetentionTarget];
    if (plan.purgeSql === null) return 0;
    const result = await db.prepare(plan.purgeSql).bind(workspaceId, bounded).run();
    return result.meta.changes;
  },
};

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export type ExportSection =
  | 'workspace'
  | 'members'
  | 'workflows'
  | 'runs'
  | 'assertions'
  | 'evidence'
  | 'support_cases'
  | 'notifications'
  | 'audit_events'
  | 'billing';

/**
 * One statement per section, selecting exactly the allowlisted columns in exactly the
 * declared order.
 *
 * `privacy/export.ts` refuses a page whose columns are not its allowlist for that section,
 * and these statements are the other half of that check. Writing them out rather than
 * generating them is the point: a `SELECT *` here would put whatever column somebody adds
 * next month into a customer's export file.
 *
 * Every statement is keyset-paged on its own key and every one carries the workspace
 * predicate — including `workspace`, which is keyed by the workspace id itself.
 */
const EXPORT_SQL: Readonly<Record<ExportSection, string>> = {
  workspace: `SELECT id, name, status, retention_policy_version, created_at
                FROM workspaces WHERE id = ? AND id > ? ORDER BY id LIMIT ?`,
  members: `SELECT m.workspace_id, m.user_id, u.auth_subject AS user_email, m.role, m.created_at
              FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.workspace_id = ? AND m.user_id > ? ORDER BY m.user_id LIMIT ?`,
  // `workflows` has no updated_at column; archived_at is the only later mutation we keep,
  // so it stands in and falls back to created_at rather than inventing a value.
  workflows: `SELECT id, workspace_id, name, status, coverage_mode, created_at,
                     COALESCE(archived_at, created_at) AS updated_at
                FROM workflows WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  runs: `SELECT id, workspace_id, workflow_id, status, observation_count, deadline_at, created_at, completed_at
           FROM runs WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  assertions: `SELECT id, workspace_id, run_id, rule_id, status, reason_code, observed_at
                 FROM assertions WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  evidence: `SELECT id, workspace_id, run_id, provider, origin, provider_record_id, observed_at,
                    content_digest, redacted_summary, expires_at
               FROM evidence WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  support_cases: `SELECT id, workspace_id, subject, body_redacted, category, priority, state, created_at, updated_at
                    FROM support_cases WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  notifications: `SELECT id, workspace_id, template, state, provider_status, created_at, sent_at
                    FROM notification_deliveries WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  audit_events: `SELECT id, workspace_id, actor_kind, action, target, occurred_at, redacted_metadata
                   FROM audit_events WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
  // The customer's own money record: orders and refunds under one shape. Deliberately no
  // card, no Stripe customer id and no price id — none of that is theirs to re-export.
  billing: `SELECT id, workspace_id, 'order' AS kind, status, amount_minor, currency, created_at
              FROM orders WHERE workspace_id = ? AND id > ?
            UNION ALL
            SELECT id, workspace_id, 'refund' AS kind, state AS status, amount_minor, currency, created_at
              FROM refunds WHERE workspace_id = ? AND id > ?
            ORDER BY id LIMIT ?`,
};

/** Exactly the columns each statement above produces, in order. */
export const EXPORT_PAGE_COLUMNS: Readonly<Record<ExportSection, readonly string[]>> = {
  workspace: ['id', 'name', 'status', 'retention_policy_version', 'created_at'],
  members: ['workspace_id', 'user_id', 'user_email', 'role', 'created_at'],
  workflows: ['id', 'workspace_id', 'name', 'status', 'coverage_mode', 'created_at', 'updated_at'],
  runs: [
    'id',
    'workspace_id',
    'workflow_id',
    'status',
    'observation_count',
    'deadline_at',
    'created_at',
    'completed_at',
  ],
  assertions: ['id', 'workspace_id', 'run_id', 'rule_id', 'status', 'reason_code', 'observed_at'],
  evidence: [
    'id',
    'workspace_id',
    'run_id',
    'provider',
    'origin',
    'provider_record_id',
    'observed_at',
    'content_digest',
    'redacted_summary',
    'expires_at',
  ],
  support_cases: [
    'id',
    'workspace_id',
    'subject',
    'body_redacted',
    'category',
    'priority',
    'state',
    'created_at',
    'updated_at',
  ],
  notifications: [
    'id',
    'workspace_id',
    'template',
    'state',
    'provider_status',
    'created_at',
    'sent_at',
  ],
  audit_events: [
    'id',
    'workspace_id',
    'actor_kind',
    'action',
    'target',
    'occurred_at',
    'redacted_metadata',
  ],
  billing: ['id', 'workspace_id', 'kind', 'status', 'amount_minor', 'currency', 'created_at'],
};

export type ExportValue = string | number | boolean | null;

export const exportPages = {
  async read(
    db: Db,
    params: { workspaceId: string; section: ExportSection; afterId: string; limit: number },
  ): Promise<{ rows: ExportValue[][]; lastId: string | null }> {
    const limit = Math.min(Math.max(1, params.limit), 500);
    const sql = EXPORT_SQL[params.section];
    const bindings =
      params.section === 'billing'
        ? [params.workspaceId, params.afterId, params.workspaceId, params.afterId, limit]
        : [params.workspaceId, params.afterId, limit];
    const result = await db.prepare(sql).bind(...bindings).all<Record<string, unknown>>();

    const columns = EXPORT_PAGE_COLUMNS[params.section];
    const rows: ExportValue[][] = [];
    let lastId: string | null = null;
    for (const row of result.results) {
      rows.push(
        columns.map((column) => {
          const value = row[column];
          if (value === null || value === undefined) return null;
          if (typeof value === 'number' || typeof value === 'boolean') return value;
          return String(value);
        }),
      );
      // The keyset key is the first column for most sections and `user_id` for members.
      const keyColumn = params.section === 'members' ? 'user_id' : 'id';
      const key = row[keyColumn];
      if (typeof key === 'string') lastId = key;
    }
    return { rows, lastId };
  },
};
