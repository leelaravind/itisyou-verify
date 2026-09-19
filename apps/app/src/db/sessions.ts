/**
 * Sessions and one-time login tokens.
 *
 * Nothing here ever stores a bearer value. `sessions.id` is the SHA-256 of the cookie
 * value and `login_tokens.token_hash` is the SHA-256 of the emailed token, both produced
 * by `hashToken()` in `@verify/security`. A database dump therefore cannot be replayed as
 * a login.
 */
import { type Db, orNull, toSqlBool } from './d1';

export interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_seen_at: string;
  readonly mfa_verified_at: string | null;
  readonly is_automation: number;
  readonly revoked_at: string | null;
  readonly user_agent_hash: string | null;
}

const SESSION_COLUMNS =
  'id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation, revoked_at, user_agent_hash';

export const sessions = {
  async create(
    db: Db,
    params: {
      /** Hash of the cookie value, never the value. */
      idHash: string;
      userId: string;
      createdAt: string;
      expiresAt: string;
      isAutomation?: boolean;
      userAgentHash?: string | null;
      mfaVerifiedAt?: string | null;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation, user_agent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.idHash,
        params.userId,
        params.createdAt,
        params.expiresAt,
        params.createdAt,
        orNull(params.mfaVerifiedAt),
        toSqlBool(params.isAutomation ?? false),
        orNull(params.userAgentHash),
      )
      .run();
  },

  /**
   * Resolve a live session. Expiry and revocation are part of the query, not a follow-up
   * check, so there is no window in which a revoked session is briefly honoured.
   */
  async findLive(db: Db, idHash: string, now: string): Promise<SessionRow | null> {
    return db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(idHash, now)
      .first<SessionRow>();
  },

  async touch(db: Db, idHash: string, at: string): Promise<void> {
    await db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(at, idHash)
      .run();
  },

  /** Records a fresh strong-auth event; owner-only actions require a recent one. */
  async markMfaVerified(db: Db, idHash: string, at: string): Promise<boolean> {
    const result = await db
      .prepare('UPDATE sessions SET mfa_verified_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(at, idHash)
      .run();
    return result.meta.changes === 1;
  },

  async revoke(db: Db, idHash: string, at: string): Promise<boolean> {
    const result = await db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(at, idHash)
      .run();
    return result.meta.changes === 1;
  },

  /** Used on sign-out-everywhere and whenever an account is disabled. */
  async revokeAllForUser(db: Db, userId: string, at: string): Promise<number> {
    const result = await db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(at, userId)
      .run();
    return result.meta.changes;
  },

  async purgeExpired(db: Db, before: string, limit = 500): Promise<number> {
    const result = await db
      .prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at <= ? LIMIT ?)')
      .bind(before, limit)
      .run();
    return result.meta.changes;
  },
};

// ---------------------------------------------------------------------------
// login tokens
// ---------------------------------------------------------------------------

export type LoginTokenPurpose = 'signin' | 'invite' | 'owner_bootstrap';

export interface LoginTokenRow {
  readonly token_hash: string;
  readonly email: string;
  readonly purpose: LoginTokenPurpose;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly attempts: number;
}

export const loginTokens = {
  async issue(
    db: Db,
    params: {
      tokenHash: string;
      email: string;
      purpose: LoginTokenPurpose;
      createdAt: string;
      expiresAt: string;
    },
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO login_tokens (token_hash, email, purpose, created_at, expires_at, attempts)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .bind(params.tokenHash, params.email, params.purpose, params.createdAt, params.expiresAt)
      .run();
  },

  /**
   * Consume a magic-link token exactly once.
   *
   * The consumption is a single conditional UPDATE with RETURNING: two browsers opening
   * the same link race on one statement and only one of them gets a row back. A second
   * attempt sees `consumed_at IS NOT NULL` and returns null.
   */
  async consumeOnce(
    db: Db,
    tokenHash: string,
    now: string,
  ): Promise<{ email: string; purpose: LoginTokenPurpose } | null> {
    return db
      .prepare(
        `UPDATE login_tokens
            SET consumed_at = ?, attempts = attempts + 1
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
          RETURNING email, purpose`,
      )
      .bind(now, tokenHash, now)
      .first<{ email: string; purpose: LoginTokenPurpose }>();
  },

  /** Counts a failed presentation, for rate limiting. Never reveals whether it existed. */
  async recordAttempt(db: Db, tokenHash: string): Promise<void> {
    await db
      .prepare('UPDATE login_tokens SET attempts = attempts + 1 WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
  },

  async purgeExpired(db: Db, before: string, limit = 500): Promise<number> {
    const result = await db
      .prepare(
        'DELETE FROM login_tokens WHERE token_hash IN (SELECT token_hash FROM login_tokens WHERE expires_at <= ? LIMIT ?)',
      )
      .bind(before, limit)
      .run();
    return result.meta.changes;
  },
};
