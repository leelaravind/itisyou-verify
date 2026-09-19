/**
 * Integration harness: a real SQLite database that speaks the slice of the D1 API our
 * repositories use.
 *
 * WHY THIS EXISTS, AND WHAT IT DOES NOT PROVE
 * -------------------------------------------
 * The intended harness was `@cloudflare/vitest-pool-workers`, which runs tests inside
 * workerd against Miniflare's own D1. On this checkout it does not start: pool-workers
 * 0.9.14 with the hoisted miniflare 4.20251011.0 fails with
 * `TypeError: vm._setUnsafeEval is not a function` before any test is collected. Rather
 * than pin transitive versions across the whole workspace, the harness runs the *same*
 * repository code against Node 22's built-in `node:sqlite` (`DatabaseSync`), which is the
 * same SQLite engine D1 is built on and needs no new dependency.
 *
 * What this DOES exercise faithfully:
 *  - every line of SQL, including `ON CONFLICT ... DO UPDATE`, `RETURNING`, partial
 *    indexes, `WHERE EXISTS` insert guards, and the NOT NULL / UNIQUE constraint
 *    violations the idempotency logic relies on;
 *  - `meta.changes` semantics, which is how every conditional write reports success;
 *  - `batch()` atomicity — implemented here with a real `BEGIN` / `COMMIT` / `ROLLBACK`,
 *    matching D1's documented "batched statements are SQL transactions ... it aborts or
 *    rolls back the entire sequence".
 *
 * What it does NOT prove:
 *  - Cloudflare's network behaviour, D1 sessions/read replicas, or its row and statement
 *    limits;
 *  - true OS-level parallelism. `DatabaseSync` is synchronous, so two awaited calls
 *    interleave at the await points rather than racing on two threads. That is enough to
 *    prove the *guard* is a single atomic statement (a second caller evaluating its
 *    condition against the first caller's committed row), which is the property the
 *    concurrency tests assert. It is not a stress test.
 *
 * USAGE
 * -----
 *   import { createTestDb, seedWorkspace } from './harness';
 *
 *   const h = createTestDb();          // fresh in-memory DB with migrations applied
 *   await runs.get(h.db, wsId, runId); // h.db is a `Db`
 *   h.close();                         // in an afterEach
 *
 * A06 and A11: `h.db` is the exact `Db` interface `apps/app/src/db` expects, so anything
 * that takes a `D1Database` in production takes `h.db` in a test unchanged.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, DbResult, DbStatement } from '@app/db/d1';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

let cachedMigration: string | null = null;

/**
 * Every migration, in filename order.
 *
 * Deliberately not just `0001_init.sql`. The harness was one migration behind for a while
 * and the symptom was `no such column` in whichever test happened to touch the new column
 * first — which reads like a broken test rather than a stale harness. Reading the whole
 * directory means a migration the lead adds is picked up with no change here.
 */
function migrationSql(): string {
  if (cachedMigration === null) {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    cachedMigration = files
      .map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
      .join(String.fromCharCode(10));
  }
  return cachedMigration;
}

type Row = Record<string, unknown>;

/** SQLite returns BigInt for INTEGER columns in some builds; normalise to number. */
function normaliseRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

function bindable(values: readonly unknown[]): unknown[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

class SqliteStatement implements DbStatement {
  #values: unknown[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): DbStatement {
    const next = new SqliteStatement(this.database, this.sql);
    next.#values = bindable(values);
    return next;
  }

  /** Internal: run against whatever connection the caller is holding (batch included). */
  execute<T>(): DbResult<T> {
    let prepared: StatementSync;
    try {
      prepared = this.database.prepare(this.sql);
    } catch (error) {
      throw new Error(`failed to prepare SQL: ${(error as Error).message}\n${this.sql}`);
    }
    // `all()` works for every statement kind in node:sqlite, including INSERT/UPDATE with
    // RETURNING (which yields rows) and without (which yields none).
    let rows: Row[];
    let changes = 0;
    let lastRowId = 0;
    try {
      rows = prepared.all(...(this.#values as never[])) as Row[];
    } catch (error) {
      throw new Error(`${(error as Error).message}`, { cause: error });
    }
    // node:sqlite exposes the change count on the database after execution.
    const counters = this.database
      .prepare('SELECT changes() AS c, last_insert_rowid() AS r')
      .get() as { c: number | bigint; r: number | bigint };
    changes = Number(counters.c);
    lastRowId = Number(counters.r);

    return {
      success: true,
      results: rows.map(normaliseRow) as T[],
      meta: { changes, last_row_id: lastRowId, rows_read: rows.length, rows_written: changes },
    };
  }

  async first<T = Row>(): Promise<T | null> {
    const result = this.execute<T>();
    return result.results[0] ?? null;
  }

  async all<T = Row>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }

  async run<T = Row>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }
}

class SqliteD1 implements Db {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): DbStatement {
    return new SqliteStatement(this.database, query);
  }

  /**
   * D1 semantics: the whole sequence is one transaction. Any failure aborts and rolls
   * back every statement in the batch.
   */
  async batch<T = Row>(statements: DbStatement[]): Promise<DbResult<T>[]> {
    this.database.exec('BEGIN IMMEDIATE');
    const out: DbResult<T>[] = [];
    try {
      for (const statement of statements) {
        out.push((statement as SqliteStatement).execute<T>());
      }
      this.database.exec('COMMIT');
      return out;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export interface TestDb {
  /** The `Db` every repository takes. Structurally identical to a `D1Database`. */
  readonly db: Db;
  /** Escape hatch for assertions that need to look at raw rows. */
  readonly raw: DatabaseSync;
  /** Run arbitrary SQL, for fixtures only. Never used by the code under test. */
  exec(sql: string): void;
  close(): void;
}

/**
 * Create a fresh in-memory database with `migrations/0001_init.sql` applied.
 *
 * Foreign keys are ON, which D1 also enforces, so a test that writes a child row with a
 * bogus parent fails here exactly as it would in production.
 */
export function createTestDb(): TestDb {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(migrationSql());
  return {
    db: new SqliteD1(database),
    raw: database,
    exec: (sql: string) => database.exec(sql),
    close: () => database.close(),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const T0 = '2026-09-19T10:00:00.000Z';

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly billingPeriod: string;
}

/**
 * Seed one tenant with a user, an active workflow at version 1 and an entitlement period.
 *
 * Deliberately raw SQL rather than the repositories: a fixture built out of the code
 * under test would hide a bug in that code.
 */
export function seedWorkspace(
  h: TestDb,
  suffix: string,
  options: { runLimit?: number; createdAt?: string; billingPeriod?: string } = {},
): SeededWorkspace {
  const createdAt = options.createdAt ?? T0;
  const billingPeriod = options.billingPeriod ?? '2026-09';
  const runLimit = options.runLimit ?? 500;
  const workspaceId = `ws_${suffix}`;
  const userId = `usr_${suffix}`;
  const workflowId = `wf_${suffix}`;
  const workflowVersionId = `wfv_${suffix}`;

  const rules = JSON.stringify({ schema_version: 1, assertions: [] });
  h.raw
    .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
    .run(userId, `${suffix}@example.com`, createdAt);
  h.raw
    .prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?, ?, 'active', ?)")
    .run(workspaceId, `Workspace ${suffix}`, createdAt);
  h.raw
    .prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'workspace_admin', ?)",
    )
    .run(workspaceId, userId, createdAt);
  h.raw
    .prepare(
      `INSERT INTO workflows (id, workspace_id, name, status, coverage_mode, created_at)
       VALUES (?, ?, ?, 'active', 'customer_triggered', ?)`,
    )
    .run(workflowId, workspaceId, `Workflow ${suffix}`, createdAt);
  h.raw
    .prepare(
      `INSERT INTO workflow_versions
         (id, workflow_id, workspace_id, version_number, rules_json, rules_hash, deadline_seconds, schema_version, created_by, created_at)
       VALUES (?, ?, ?, 1, ?, 'hash', 600, 1, ?, ?)`,
    )
    .run(workflowVersionId, workflowId, workspaceId, rules, userId, createdAt);
  h.raw
    .prepare('UPDATE workflows SET current_version_id = ? WHERE id = ?')
    .run(workflowVersionId, workflowId);
  h.raw
    .prepare(
      `INSERT INTO entitlements (id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at)
       VALUES (?, ?, ?, 1, ?, 0, 0, ?)`,
    )
    .run(`ent_${suffix}`, workspaceId, billingPeriod, runLimit, createdAt);

  return { workspaceId, userId, workflowId, workflowVersionId, billingPeriod };
}

/** Insert a run directly, for tests that need one without going through admission. */
export function seedRun(
  h: TestDb,
  ws: SeededWorkspace,
  id: string,
  options: {
    status?: string;
    nextCheckAt?: string | null;
    createdAt?: string;
    deadlineAt?: string;
    revision?: number;
  } = {},
): string {
  const createdAt = options.createdAt ?? T0;
  const sourceEventId = `sev_${id}`;
  h.raw
    .prepare(
      `INSERT INTO source_events
         (id, workspace_id, workflow_id, source, external_event_id, received_at, occurred_at, correlation_key_hash, payload_hash, payload_json)
       VALUES (?, ?, ?, 'signed_customer_event', ?, ?, ?, 'corr', 'hash', '{}')`,
    )
    .run(sourceEventId, ws.workspaceId, ws.workflowId, `ext_${id}`, createdAt, createdAt);
  h.raw
    .prepare(
      `INSERT INTO runs
         (id, workspace_id, workflow_id, workflow_version_id, source_event_id, status, revision, observation_count, deadline_at, next_check_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      ws.workspaceId,
      ws.workflowId,
      ws.workflowVersionId,
      sourceEventId,
      options.status ?? 'PENDING',
      options.revision ?? 1,
      options.deadlineAt ?? '2026-09-19T10:10:00.000Z',
      options.nextCheckAt === undefined ? createdAt : options.nextCheckAt,
      createdAt,
    );
  return id;
}

/** Seed a budget account. Amounts are minor units, as everywhere else. */
export function seedBudgetAccount(
  h: TestDb,
  id: string,
  params: {
    scope?: string;
    limitMinor: number;
    spentMinor?: number;
    reservedMinor?: number;
    committedMinor?: number;
    safetyBufferMinor?: number;
  },
): string {
  h.raw
    .prepare(
      `INSERT INTO budget_accounts
         (id, scope, currency, authorised_limit_minor, spent_minor, reserved_minor, committed_minor, safety_buffer_minor, revision, updated_at)
       VALUES (?, ?, 'GBP', ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      params.scope ?? `scope:${id}`,
      params.limitMinor,
      params.spentMinor ?? 0,
      params.reservedMinor ?? 0,
      params.committedMinor ?? 0,
      params.safetyBufferMinor ?? 0,
      T0,
    );
  return id;
}

/** Count rows, for "nothing was written" assertions. */
export function countRows(h: TestDb, table: string, where = '1=1', ...bindings: unknown[]): number {
  const row = h.raw
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...(bindable(bindings) as never[])) as { n: number | bigint };
  return Number(row.n);
}
