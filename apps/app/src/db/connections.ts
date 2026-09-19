/**
 * Provider connections and the encrypted credential versions attached to them.
 *
 * `credential_versions` has no `workspace_id` column of its own — it is scoped through
 * `connections`. Every read here therefore joins to `connections` and filters on the
 * workspace, which is what proves the child belongs to the parent *within the same
 * tenant*. A credential is never returned as plaintext by this layer; callers receive the
 * sealed envelope and must open it with the AAD they rebuild from their own context.
 */
import type { ConnectionStatus } from '@verify/contracts';
import { type Db, orNull, resultAt } from './d1';

export type Provider = 'hubspot' | 'resend';

export interface ConnectionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider: Provider;
  readonly external_account_id: string | null;
  readonly status: ConnectionStatus;
  readonly scopes: string;
  readonly last_check_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

const CONNECTION_COLUMNS =
  'id, workspace_id, provider, external_account_id, status, scopes, last_check_at, last_error_code, created_at, revoked_at';

export const connections = {
  /**
   * Create or update the one connection a workspace may have per provider. The UNIQUE
   * `(workspace_id, provider)` constraint carries the "one per provider" rule; this
   * upsert never creates a second row for a re-authorisation.
   */
  async upsert(
    db: Db,
    params: {
      id: string;
      workspaceId: string;
      provider: Provider;
      status: ConnectionStatus;
      externalAccountId?: string | null;
      scopes?: readonly string[];
      createdAt: string;
    },
  ): Promise<ConnectionRow> {
    const row = await db
      .prepare(
        `INSERT INTO connections (id, workspace_id, provider, external_account_id, status, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, provider) DO UPDATE SET
           external_account_id = excluded.external_account_id,
           status              = excluded.status,
           scopes              = excluded.scopes,
           revoked_at          = NULL
         RETURNING ${CONNECTION_COLUMNS}`,
      )
      .bind(
        params.id,
        params.workspaceId,
        params.provider,
        orNull(params.externalAccountId),
        params.status,
        JSON.stringify(params.scopes ?? []),
        params.createdAt,
      )
      .first<ConnectionRow>();
    if (row === null) throw new Error('connections.upsert returned no row');
    return row;
  },

  async getByProvider(
    db: Db,
    workspaceId: string,
    provider: Provider,
  ): Promise<ConnectionRow | null> {
    return db
      .prepare(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id = ? AND provider = ?`)
      .bind(workspaceId, provider)
      .first<ConnectionRow>();
  },

  /** There is no get-by-id without a workspace. This is the only id lookup there is. */
  async getById(db: Db, workspaceId: string, connectionId: string): Promise<ConnectionRow | null> {
    return db
      .prepare(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, connectionId)
      .first<ConnectionRow>();
  },

  async list(db: Db, workspaceId: string): Promise<ConnectionRow[]> {
    const result = await db
      .prepare(
        `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id = ? ORDER BY provider ASC LIMIT 20`,
      )
      .bind(workspaceId)
      .all<ConnectionRow>();
    return result.results;
  },

  async setStatus(
    db: Db,
    workspaceId: string,
    connectionId: string,
    params: { status: ConnectionStatus; lastCheckAt?: string | null; lastErrorCode?: string | null },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE connections SET status = ?, last_check_at = ?, last_error_code = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(
        params.status,
        orNull(params.lastCheckAt),
        orNull(params.lastErrorCode),
        workspaceId,
        connectionId,
      )
      .run();
    return result.meta.changes === 1;
  },

  /**
   * Revoke a connection and retire every credential version it owns, atomically. A
   * revoked connection must never be left holding a usable credential.
   */
  async revoke(db: Db, workspaceId: string, connectionId: string, at: string): Promise<boolean> {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE connections SET status = 'revoked', revoked_at = ?
            WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL`,
        )
        .bind(at, workspaceId, connectionId),
      db
        .prepare(
          `UPDATE credential_versions SET retired_at = ?
            WHERE retired_at IS NULL AND connection_id IN (
              SELECT id FROM connections WHERE workspace_id = ? AND id = ?
            )`,
        )
        .bind(at, workspaceId, connectionId),
    ]);
    return resultAt(results, 0).meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// credential versions
// ---------------------------------------------------------------------------

export interface CredentialEnvelopeRow {
  readonly id: string;
  readonly connection_id: string | null;
  readonly owner_scope: string;
  readonly key_version: number;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly aad: string;
  readonly created_at: string;
}

const CREDENTIAL_COLUMNS =
  'id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at';

/** Canonical owner scopes. Anything else is rejected before it reaches the database. */
export function connectionScope(connectionId: string): string {
  return `connection:${connectionId}`;
}
export function userScope(userId: string): string {
  return `user:${userId}`;
}

export const credentials = {
  /**
   * Store a new sealed credential and retire the previous active one in a single batch,
   * so there is never a moment with two active versions for one scope.
   */
  async store(
    db: Db,
    params: {
      id: string;
      ownerScope: string;
      connectionId?: string | null;
      keyVersion: number;
      ciphertext: string;
      nonce: string;
      aad: string;
      createdAt: string;
    },
  ): Promise<void> {
    await db.batch([
      // credential_versions carries no workspace_id column: it is scoped by owner_scope
      // ('connection:<id>' or 'user:<id>'). The caller has already proven ownership of
      // that scope, and a user-scoped TOTP secret has no workspace at all. Reads go
      // through activeForConnection(), which joins to connections and does filter on
      // workspace_id.
      // tenant-scope:exempt scoped by owner_scope; see above.
      db
        .prepare('UPDATE credential_versions SET retired_at = ? WHERE owner_scope = ? AND retired_at IS NULL')
        .bind(params.createdAt, params.ownerScope),
      // tenant-scope:exempt same scope rule as the retire above; this is the matching
      // insert and the two must stay in one batch.
      db
        .prepare(
          `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          params.id,
          orNull(params.connectionId),
          params.ownerScope,
          params.keyVersion,
          params.ciphertext,
          params.nonce,
          params.aad,
          params.createdAt,
        ),
    ]);
  },

  /**
   * The active credential for a connection, proven to belong to this workspace.
   *
   * The join is the tenant check: passing another workspace's connection id returns null
   * rather than someone else's ciphertext.
   */
  async activeForConnection(
    db: Db,
    workspaceId: string,
    connectionId: string,
  ): Promise<CredentialEnvelopeRow | null> {
    return db
      .prepare(
        `SELECT cv.id, cv.connection_id, cv.owner_scope, cv.key_version,
                cv.ciphertext, cv.nonce, cv.aad, cv.created_at
           FROM credential_versions cv
           JOIN connections c ON c.id = cv.connection_id
          WHERE c.workspace_id = ? AND c.id = ? AND cv.retired_at IS NULL
          ORDER BY cv.created_at DESC
          LIMIT 1`,
      )
      .bind(workspaceId, connectionId)
      .first<CredentialEnvelopeRow>();
  },

  /**
   * For user-scoped material (the owner's TOTP secret), which has no workspace at all —
   * a platform owner is not a member of any tenant in this capacity, so there is no
   * workspace id to scope by. The caller has already authenticated as that user.
   */
  async activeForUser(db: Db, userId: string): Promise<CredentialEnvelopeRow | null> {
    // tenant-scope:exempt user-scoped TOTP secret; owner_scope is 'user:<id>'.
    return db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM credential_versions
          WHERE owner_scope = ? AND retired_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(userScope(userId))
      .first<CredentialEnvelopeRow>();
  },

  async retireAllForScope(db: Db, ownerScope: string, at: string): Promise<number> {
    // Used for account deletion and TOTP reset, where the caller supplies the scope it
    // has already proven it owns.
    // tenant-scope:exempt scoped by owner_scope, the only scope this table has.
    const result = await db
      .prepare('UPDATE credential_versions SET retired_at = ? WHERE owner_scope = ? AND retired_at IS NULL')
      .bind(at, ownerScope)
      .run();
    return result.meta.changes;
  },
};
