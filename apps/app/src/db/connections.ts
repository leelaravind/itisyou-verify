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
import { newWebhookPathId } from './resendWebhookPort';
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

  /**
   * Record a connection the provider has just confirmed, together with the sealed
   * credentials that proved it — in **one** batch, which D1 runs as one transaction.
   *
   * Why one statement list rather than an upsert followed by a credential write: the two
   * halves are only true together. A connection row saying `ready` with no credential
   * behind it is a page telling the customer they are connected while every run that
   * follows fails to open anything; a credential with no connection row is unreachable.
   * Either both land or neither does.
   *
   * The caller has already validated against the provider — nothing here checks a
   * credential, and nothing here seals one. It stores what it is given, and it is only
   * ever given envelopes.
   */
  async establish(
    db: Db,
    params: {
      newConnectionId: string;
      workspaceId: string;
      provider: Provider;
      status: ConnectionStatus;
      externalAccountId: string | null;
      scopes: readonly string[];
      lastCheckAt: string;
      credentials: readonly {
        id: string;
        purpose: string;
        keyVersion: number;
        ciphertext: string;
        nonce: string;
        aad: string;
      }[];
    },
  ): Promise<string> {
    const existing = await connections.getByProvider(db, params.workspaceId, params.provider);
    const connectionId = existing?.id ?? params.newConnectionId;
    const scope = connectionScope(connectionId);

    const statements = [
      db
        .prepare(
          `INSERT INTO connections
             (id, workspace_id, provider, external_account_id, status, scopes, last_check_at, last_error_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(workspace_id, provider) DO UPDATE SET
             external_account_id = excluded.external_account_id,
             status              = excluded.status,
             scopes              = excluded.scopes,
             last_check_at       = excluded.last_check_at,
             last_error_code     = NULL,
             revoked_at          = NULL`,
        )
        .bind(
          connectionId,
          params.workspaceId,
          params.provider,
          orNull(params.externalAccountId),
          params.status,
          JSON.stringify(params.scopes),
          params.lastCheckAt,
          params.lastCheckAt,
        ),
    ];

    for (const credential of params.credentials) {
      // Retire only the previous version *of this purpose*: a Resend connection holds an
      // API token and a signing secret under one scope, and storing one must not retire
      // the other.
      // tenant-scope:exempt credential_versions is scoped by owner_scope; the connection
      // id it is built from was just proven to belong to this workspace above.
      statements.push(
        db
          .prepare(
            `UPDATE credential_versions SET retired_at = ?
              WHERE owner_scope = ? AND retired_at IS NULL AND aad LIKE ?`,
          )
          .bind(params.lastCheckAt, scope, `%|purpose=${credential.purpose}`),
      );
      // tenant-scope:exempt same scope rule as the retire above; the two must stay in one
      // batch or a failure between them leaves a connection with no usable credential.
      statements.push(
        db
          .prepare(
            `INSERT INTO credential_versions
               (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            credential.id,
            connectionId,
            scope,
            credential.keyVersion,
            credential.ciphertext,
            credential.nonce,
            credential.aad,
            params.lastCheckAt,
          ),
      );
    }

    /*
     * A Resend connection needs somewhere for Resend to call.
     *
     * `assignWebhookPathId` existed, was exported, and was called by nothing but a test —
     * so `webhook_path_id` stayed null, no URL could be shown to the customer, no signed
     * delivery could arrive, and the connection could never leave `testing`. The page was
     * honest about being unfinished while being structurally unable to finish, which is a
     * worse failure than an error: it looks like patience.
     *
     * Assigned here rather than in a later step, and inside the same batch, because a
     * connection that exists without a path to call it is the state that was broken. Only
     * when null: rotating an existing path silently would break a webhook the customer has
     * already registered with Resend. Rotation is a deliberate act with its own call.
     */
    if (params.provider === 'resend') {
      statements.push(
        db
          .prepare(
            `UPDATE connections SET webhook_path_id = ?
              WHERE workspace_id = ? AND id = ? AND webhook_path_id IS NULL`,
          )
          .bind(newWebhookPathId(), params.workspaceId, connectionId),
      );
    }

    await db.batch(statements);
    return connectionId;
  },

  async getByProvider(
    db: Db,
    workspaceId: string,
    provider: Provider,
  ): Promise<ConnectionRow | null> {
    return db
      .prepare(
        `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id = ? AND provider = ?`,
      )
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
    params: {
      status: ConnectionStatus;
      lastCheckAt?: string | null;
      lastErrorCode?: string | null;
    },
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
   *
   * Note the retire is unqualified: this is for a scope holding exactly one secret (a
   * user's TOTP seed). A provider connection holds more than one — an API token and a
   * signing secret — and goes through `connections.establish`, which retires per purpose.
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
        .prepare(
          'UPDATE credential_versions SET retired_at = ? WHERE owner_scope = ? AND retired_at IS NULL',
        )
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
  /**
   * The active credential for one connection AND one purpose.
   *
   * A connection holds more than one secret — Resend has an API token and a webhook signing
   * secret — so `activeForConnection` alone would hand back whichever was stored last. The
   * purpose is matched against the AAD, which is the field that actually binds a ciphertext
   * to what it is for, rather than a column somebody could edit.
   *
   * The join to `connections` is the tenant check: another workspace's connection id
   * returns null rather than a ciphertext.
   */
  async activeForScope(
    db: Db,
    workspaceId: string,
    connectionId: string,
    purpose: string,
  ): Promise<CredentialEnvelopeRow | null> {
    return db
      .prepare(
        `SELECT cv.id, cv.connection_id, cv.owner_scope, cv.key_version,
                cv.ciphertext, cv.nonce, cv.aad, cv.created_at
           FROM credential_versions cv
           JOIN connections c ON c.id = cv.connection_id
          WHERE c.workspace_id = ? AND c.id = ? AND cv.retired_at IS NULL
            AND cv.aad LIKE ?
          ORDER BY cv.created_at DESC
          LIMIT 1`,
      )
      .bind(workspaceId, connectionId, `%|purpose=${purpose}`)
      .first<CredentialEnvelopeRow>();
  },

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

  /**
   * Store one recovery code, addressed by the hash of the code itself.
   *
   * The hash IS the primary key. That is what makes consumption a single conditional
   * UPDATE rather than a scan-then-write, and a SHA-256 of a 100-bit code is not
   * reversible by anyone who can read the table. The sealed body is a marker, not the
   * code: there is deliberately nothing here that could give a code back.
   */
  async insertRecoveryCode(
    db: Db,
    params: {
      rowId: string;
      ownerScope: string;
      keyVersion: number;
      ciphertext: string;
      nonce: string;
      aad: string;
      createdAt: string;
    },
  ): Promise<void> {
    // tenant-scope:exempt user-scoped recovery code; owner_scope is 'user:<id>:recovery'
    // and this table has no workspace column. See activeForUser above.
    await db
      .prepare(
        `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.rowId,
        params.ownerScope,
        params.keyVersion,
        params.ciphertext,
        params.nonce,
        params.aad,
        params.createdAt,
      )
      .run();
  },

  /**
   * Consume one recovery code, once.
   *
   * `WHERE retired_at IS NULL` is the whole single-use property. Two people presenting the
   * same printed code race on this statement and the loser is told it is wrong — which is
   * true, because it is no longer a code.
   */
  async consumeRecoveryCode(
    db: Db,
    params: { rowId: string; ownerScope: string; at: string },
  ): Promise<boolean> {
    // tenant-scope:exempt user-scoped recovery code, addressed by its own hash.
    const result = await db
      .prepare(
        `UPDATE credential_versions SET retired_at = ?
          WHERE id = ? AND owner_scope = ? AND retired_at IS NULL`,
      )
      .bind(params.at, params.rowId, params.ownerScope)
      .run();
    return result.meta.changes === 1;
  },

  /** How many unused recovery codes remain for a scope. Never the codes themselves. */
  async countActiveForScope(db: Db, ownerScope: string): Promise<number> {
    // tenant-scope:exempt user-scoped count; credential_versions has no workspace column.
    const row = await db
      .prepare(
        'SELECT COUNT(*) AS n FROM credential_versions WHERE owner_scope = ? AND retired_at IS NULL',
      )
      .bind(ownerScope)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  },

  async retireAllForScope(db: Db, ownerScope: string, at: string): Promise<number> {
    // Used for account deletion and TOTP reset, where the caller supplies the scope it
    // has already proven it owns.
    // tenant-scope:exempt scoped by owner_scope, the only scope this table has.
    const result = await db
      .prepare(
        'UPDATE credential_versions SET retired_at = ? WHERE owner_scope = ? AND retired_at IS NULL',
      )
      .bind(at, ownerScope)
      .run();
    return result.meta.changes;
  },
};
