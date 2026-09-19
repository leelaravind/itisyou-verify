/**
 * Identity: users, workspaces, memberships.
 *
 * `users` is deliberately NOT workspace-scoped — a person exists before and independently
 * of any workspace, and the same person can belong to several. The tenancy gate is
 * `memberships.roleFor()`: no handler may act on a workspace without first resolving a
 * role from the session, and every workspace-scoped repository below takes the workspace
 * id as an explicit parameter.
 */
import type { Role } from '@verify/contracts';
import { type Db, type DbResult, orNull, toSqlBool } from './d1';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface UserRow {
  readonly id: string;
  readonly auth_subject: string;
  readonly display_name: string | null;
  readonly is_platform_owner: number;
  readonly totp_secret_ref: string | null;
  readonly totp_enrolled_at: string | null;
  readonly created_at: string;
  readonly disabled_at: string | null;
}

const USER_COLUMNS =
  'id, auth_subject, display_name, is_platform_owner, totp_secret_ref, totp_enrolled_at, created_at, disabled_at';

export const users = {
  /**
   * Create a user, or return the existing one for the same normalised email. The upsert
   * is a single statement so two concurrent magic-link redemptions cannot create two
   * users for one address.
   */
  async createOrGet(
    db: Db,
    params: {
      id: string;
      authSubject: string;
      displayName?: string | null;
      isPlatformOwner?: boolean;
      createdAt: string;
    },
  ): Promise<UserRow> {
    const row = await db
      .prepare(
        `INSERT INTO users (id, auth_subject, display_name, is_platform_owner, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(auth_subject) DO UPDATE SET auth_subject = excluded.auth_subject
         RETURNING ${USER_COLUMNS}`,
      )
      .bind(
        params.id,
        params.authSubject,
        orNull(params.displayName),
        toSqlBool(params.isPlatformOwner ?? false),
        params.createdAt,
      )
      .first<UserRow>();
    if (row === null) throw new Error('users.createOrGet returned no row');
    return row;
  },

  async findById(db: Db, userId: string): Promise<UserRow | null> {
    return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(userId).first<UserRow>();
  },

  async findByAuthSubject(db: Db, authSubject: string): Promise<UserRow | null> {
    return db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE auth_subject = ?`)
      .bind(authSubject)
      .first<UserRow>();
  },

  /** Records only the *reference* to the encrypted TOTP secret, never the secret. */
  async setTotpReference(
    db: Db,
    userId: string,
    params: { secretRef: string; enrolledAt: string },
  ): Promise<boolean> {
    const result = await db
      .prepare('UPDATE users SET totp_secret_ref = ?, totp_enrolled_at = ? WHERE id = ? AND disabled_at IS NULL')
      .bind(params.secretRef, params.enrolledAt, userId)
      .run();
    return result.meta.changes === 1;
  },

  async disable(db: Db, userId: string, at: string): Promise<boolean> {
    const result = await db
      .prepare('UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
      .bind(at, userId)
      .run();
    return result.meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

export type WorkspaceStatus = 'active' | 'paused' | 'suspended' | 'deleted';

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly is_synthetic: number;
  readonly retention_policy_version: number;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

const WORKSPACE_COLUMNS =
  'id, name, status, is_synthetic, retention_policy_version, created_at, deleted_at';

export const workspaces = {
  /** Creates the workspace and its owning membership atomically. */
  async createWithOwner(
    db: Db,
    params: {
      workspaceId: string;
      name: string;
      userId: string;
      createdAt: string;
      isSynthetic?: boolean;
    },
  ): Promise<void> {
    await db.batch([
      db
        .prepare(
          `INSERT INTO workspaces (id, name, status, is_synthetic, retention_policy_version, created_at)
           VALUES (?, ?, 'active', ?, 1, ?)`,
        )
        .bind(params.workspaceId, params.name, toSqlBool(params.isSynthetic ?? false), params.createdAt),
      db
        .prepare(
          `INSERT INTO memberships (workspace_id, user_id, role, created_at)
           VALUES (?, ?, 'workspace_admin', ?)`,
        )
        .bind(params.workspaceId, params.userId, params.createdAt),
    ]);
  },

  async findById(db: Db, workspaceId: string): Promise<WorkspaceRow | null> {
    return db
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<WorkspaceRow>();
  },

  /** Workspaces this user can actually see, resolved from memberships — never from input. */
  async listForUser(
    db: Db,
    userId: string,
  ): Promise<{ id: string; name: string; status: WorkspaceStatus; role: Role; created_at: string }[]> {
    const result = await db
      .prepare(
        `SELECT w.id, w.name, w.status, m.role, w.created_at
           FROM workspaces w
           JOIN memberships m ON m.workspace_id = w.id
          WHERE m.user_id = ? AND w.deleted_at IS NULL
          ORDER BY w.created_at ASC
          LIMIT 50`,
      )
      .bind(userId)
      .all<{ id: string; name: string; status: WorkspaceStatus; role: Role; created_at: string }>();
    return result.results;
  },

  async setStatus(db: Db, workspaceId: string, status: WorkspaceStatus): Promise<boolean> {
    const result = await db
      .prepare('UPDATE workspaces SET status = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(status, workspaceId)
      .run();
    return result.meta.changes === 1;
  },

  async softDelete(db: Db, workspaceId: string, at: string): Promise<boolean> {
    const result = await db
      .prepare("UPDATE workspaces SET status = 'deleted', deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(at, workspaceId)
      .run();
    return result.meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// memberships — the tenancy gate
// ---------------------------------------------------------------------------

export interface MembershipRow {
  readonly workspace_id: string;
  readonly user_id: string;
  readonly role: Role;
  readonly created_at: string;
}

export const memberships = {
  async add(
    db: Db,
    params: { workspaceId: string; userId: string; role: Role; createdAt: string },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(params.workspaceId, params.userId, params.role, params.createdAt)
      .run();
  },

  /**
   * The single authority on "may this user touch this workspace". Returns null when
   * there is no membership — which is the same answer as "the workspace does not exist",
   * on purpose, so the API cannot be used to probe for workspace ids.
   */
  async roleFor(db: Db, workspaceId: string, userId: string): Promise<Role | null> {
    const row = await db
      .prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?')
      .bind(workspaceId, userId)
      .first<{ role: Role }>();
    return row?.role ?? null;
  },

  async list(db: Db, workspaceId: string): Promise<MembershipRow[]> {
    const result = await db
      .prepare(
        `SELECT workspace_id, user_id, role, created_at FROM memberships
          WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 100`,
      )
      .bind(workspaceId)
      .all<MembershipRow>();
    return result.results;
  },

  async remove(db: Db, workspaceId: string, userId: string): Promise<boolean> {
    const result: DbResult = await db
      .prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?')
      .bind(workspaceId, userId)
      .run();
    return result.meta.changes === 1;
  },
};
