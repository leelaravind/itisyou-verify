/**
 * The founder's spending budget. Integer minor units only; no float ever touches a cap.
 *
 * Availability is the one formula the whole system agrees on:
 *
 *     available = authorised_limit - spent - reserved - committed - safety_buffer
 *
 * Every state change is a *pair* of statements in one `batch()`:
 *
 *   1. an INSERT into `budget_entries`, conditional on the same availability guard, whose
 *      `UNIQUE (idempotency_key)` makes a retry a no-op rather than a second movement;
 *   2. the conditional UPDATE on `budget_accounts`, which succeeds only when the funds are
 *      genuinely there.
 *
 * Because both statements carry the identical guard, an insufficient balance writes
 * nothing at all and reports `meta.changes === 0` — and two concurrent requests for the
 * last pound cannot both pass, since the second evaluates its guard against the first's
 * committed row.
 */
import { type Db, resultAt } from './d1';

export type BudgetEntryKind = 'reserve' | 'release' | 'spend' | 'commit' | 'uncommit' | 'credit';

export interface BudgetAccountRow {
  readonly id: string;
  readonly scope: string;
  readonly currency: string;
  readonly authorised_limit_minor: number;
  readonly spent_minor: number;
  readonly reserved_minor: number;
  readonly committed_minor: number;
  readonly safety_buffer_minor: number;
  readonly revision: number;
  readonly updated_at: string;
}

export interface BudgetEntryRow {
  readonly id: string;
  readonly account_id: string;
  readonly kind: BudgetEntryKind;
  readonly amount_minor: number;
  readonly source: string;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly reconciled_at: string | null;
}

export type BudgetOutcome =
  | { readonly ok: true; readonly idempotent: boolean; readonly entryId: string }
  | { readonly ok: false; readonly reason: 'INSUFFICIENT_FUNDS' | 'ACCOUNT_NOT_FOUND' };

const ACCOUNT_COLUMNS =
  'id, scope, currency, authorised_limit_minor, spent_minor, reserved_minor, committed_minor, safety_buffer_minor, revision, updated_at';

const AVAILABLE_EXPR =
  '(authorised_limit_minor - spent_minor - reserved_minor - committed_minor - safety_buffer_minor)';

function assertAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError('budget amounts must be a positive integer in minor units');
  }
}

async function findEntry(db: Db, idempotencyKey: string): Promise<BudgetEntryRow | null> {
  return db
    .prepare(
      `SELECT id, account_id, kind, amount_minor, source, idempotency_key, created_at, reconciled_at
         FROM budget_entries WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<BudgetEntryRow>();
}

/**
 * The four legal movements, as a closed set.
 *
 * AUTH-203: `movement()` used to take `guardSql: string` and interpolate it into the
 * statement. Every caller passed a module constant, so it was not exploitable — but a
 * caller-supplied SQL fragment in a money path is one careless refactor away from an
 * injectable budget guard. The SQL now lives entirely in this frozen table; `movement()`
 * receives a `BudgetMovement` key and nothing else, so there is no string a caller could
 * supply even if it wanted to.
 *
 * Each movement pairs a ledger insert with an account update carrying the IDENTICAL
 * guard, so a movement that is not permitted writes nothing at all.
 */
export type BudgetMovement = 'reserve' | 'release' | 'settle' | 'commit';

interface MovementPlan {
  readonly kind: BudgetEntryKind;
  /** Insert guarded by the same predicate as the update below. */
  readonly entrySql: string;
  readonly updateSql: string;
  /** How many times `amountMinor` is bound into the update, in order. */
  readonly updateAmountBindings: number;
}

const ENTRY_INSERT_IF_AVAILABLE =
  `INSERT INTO budget_entries (id, account_id, kind, amount_minor, source, idempotency_key, created_at)
   SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM budget_accounts WHERE id = ? AND ${AVAILABLE_EXPR} >= ?)`;

const ENTRY_INSERT_IF_RESERVED =
  `INSERT INTO budget_entries (id, account_id, kind, amount_minor, source, idempotency_key, created_at)
   SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM budget_accounts WHERE id = ? AND reserved_minor >= ?)`;

const MOVEMENTS: Readonly<Record<BudgetMovement, MovementPlan>> = {
  reserve: {
    kind: 'reserve',
    entrySql: ENTRY_INSERT_IF_AVAILABLE,
    updateSql: `UPDATE budget_accounts
                   SET reserved_minor = reserved_minor + ?, revision = revision + 1, updated_at = ?
                 WHERE id = ? AND ${AVAILABLE_EXPR} >= ?`,
    updateAmountBindings: 1,
  },
  release: {
    kind: 'release',
    entrySql: ENTRY_INSERT_IF_RESERVED,
    updateSql: `UPDATE budget_accounts
                   SET reserved_minor = reserved_minor - ?, revision = revision + 1, updated_at = ?
                 WHERE id = ? AND reserved_minor >= ?`,
    updateAmountBindings: 1,
  },
  settle: {
    kind: 'spend',
    entrySql: ENTRY_INSERT_IF_RESERVED,
    updateSql: `UPDATE budget_accounts
                   SET reserved_minor = reserved_minor - ?, spent_minor = spent_minor + ?,
                       revision = revision + 1, updated_at = ?
                 WHERE id = ? AND reserved_minor >= ?`,
    updateAmountBindings: 2,
  },
  commit: {
    kind: 'commit',
    entrySql: ENTRY_INSERT_IF_RESERVED,
    updateSql: `UPDATE budget_accounts
                   SET reserved_minor = reserved_minor - ?, committed_minor = committed_minor + ?,
                       revision = revision + 1, updated_at = ?
                 WHERE id = ? AND reserved_minor >= ?`,
    updateAmountBindings: 2,
  },
};

export interface MovementParams {
  readonly entryId: string;
  readonly accountId: string;
  readonly amountMinor: number;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly at: string;
}

async function movement(
  db: Db,
  which: BudgetMovement,
  params: MovementParams,
): Promise<BudgetOutcome> {
  assertAmount(params.amountMinor);
  const plan = MOVEMENTS[which];

  const existing = await findEntry(db, params.idempotencyKey);
  if (existing !== null) {
    // A retry. The original movement already happened exactly once.
    return { ok: true, idempotent: true, entryId: existing.id };
  }

  const updateBindings: unknown[] = [];
  for (let i = 0; i < plan.updateAmountBindings; i += 1) updateBindings.push(params.amountMinor);
  updateBindings.push(params.at, params.accountId, params.amountMinor);

  const statements = [
    db
      .prepare(plan.entrySql)
      .bind(
        params.entryId,
        params.accountId,
        plan.kind,
        params.amountMinor,
        params.source,
        params.idempotencyKey,
        params.at,
        params.accountId,
        params.amountMinor,
      ),
    db.prepare(plan.updateSql).bind(...updateBindings),
  ];

  let results;
  try {
    results = await db.batch(statements);
  } catch {
    // Only reachable when a concurrent caller inserted the same idempotency key between
    // our read and our write. That caller's movement stands; ours must not repeat it.
    const raced = await findEntry(db, params.idempotencyKey);
    if (raced !== null) return { ok: true, idempotent: true, entryId: raced.id };
    throw new Error('budget movement failed');
  }

  const updated = resultAt(results, 1).meta.changes;
  if (updated === 1) return { ok: true, idempotent: false, entryId: params.entryId };

  // Nothing moved. The ledger insert carried the same guard, so nothing was written
  // there either — the batch is consistent.
  const account = await budget.getAccount(db, params.accountId);
  return { ok: false, reason: account === null ? 'ACCOUNT_NOT_FOUND' : 'INSUFFICIENT_FUNDS' };
}

export const budget = {
  async ensureAccount(
    db: Db,
    params: {
      id: string;
      scope: string;
      currency: string;
      authorisedLimitMinor: number;
      safetyBufferMinor?: number;
      updatedAt: string;
    },
  ): Promise<BudgetAccountRow> {
    const row = await db
      .prepare(
        `INSERT INTO budget_accounts
           (id, scope, currency, authorised_limit_minor, spent_minor, reserved_minor, committed_minor, safety_buffer_minor, revision, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, 1, ?)
         ON CONFLICT(scope) DO UPDATE SET
           authorised_limit_minor = excluded.authorised_limit_minor,
           safety_buffer_minor    = excluded.safety_buffer_minor,
           revision               = budget_accounts.revision + 1,
           updated_at             = excluded.updated_at
         RETURNING ${ACCOUNT_COLUMNS}`,
      )
      .bind(
        params.id,
        params.scope,
        params.currency,
        params.authorisedLimitMinor,
        params.safetyBufferMinor ?? 0,
        params.updatedAt,
      )
      .first<BudgetAccountRow>();
    if (row === null) throw new Error('budget.ensureAccount returned no row');
    return row;
  },

  async getAccount(db: Db, accountId: string): Promise<BudgetAccountRow | null> {
    return db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM budget_accounts WHERE id = ?`)
      .bind(accountId)
      .first<BudgetAccountRow>();
  },

  async getAccountByScope(db: Db, scope: string): Promise<BudgetAccountRow | null> {
    return db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM budget_accounts WHERE scope = ?`)
      .bind(scope)
      .first<BudgetAccountRow>();
  },

  /**
   * Hold funds. Succeeds only when the money is genuinely available *after* the safety
   * buffer, and exactly once per idempotency key.
   */
  async reserve(
    db: Db,
    params: MovementParams,
  ): Promise<BudgetOutcome> {
    return movement(db, 'reserve', params);
  },

  /** Hand an unused reservation back. */
  async release(
    db: Db,
    params: MovementParams,
  ): Promise<BudgetOutcome> {
    return movement(db, 'release', params);
  },

  /** Reservation becomes real spend. Money left the account. */
  async settle(
    db: Db,
    params: MovementParams,
  ): Promise<BudgetOutcome> {
    return movement(db, 'settle', params);
  },

  /**
   * Reservation becomes a committed obligation: we are contractually on the hook but the
   * money has not left yet (an ad campaign accepted by the provider, for example).
   */
  async commit(
    db: Db,
    params: MovementParams,
  ): Promise<BudgetOutcome> {
    return movement(db, 'commit', params);
  },

  async listEntries(db: Db, accountId: string, limit = 50): Promise<BudgetEntryRow[]> {
    const result = await db
      .prepare(
        `SELECT id, account_id, kind, amount_minor, source, idempotency_key, created_at, reconciled_at
           FROM budget_entries WHERE account_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(accountId, Math.min(Math.max(1, limit), 200))
      .all<BudgetEntryRow>();
    return result.results;
  },

  async markReconciled(db: Db, entryId: string, at: string): Promise<boolean> {
    const result = await db
      .prepare('UPDATE budget_entries SET reconciled_at = ? WHERE id = ? AND reconciled_at IS NULL')
      .bind(at, entryId)
      .run();
    return result.meta.changes === 1;
  },

  /** Available minor units, computed in SQL so it cannot drift from the guards above. */
  async available(db: Db, accountId: string): Promise<number | null> {
    const row = await db
      .prepare(`SELECT ${AVAILABLE_EXPR} AS available FROM budget_accounts WHERE id = ?`)
      .bind(accountId)
      .first<{ available: number }>();
    return row === null ? null : Number(row.available);
  },
};
