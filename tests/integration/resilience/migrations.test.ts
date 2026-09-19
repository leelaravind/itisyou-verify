/**
 * Rollback (RESIL 140 to 157) — whether the previous Worker still runs.
 *
 * A rollback is not a database operation. When we roll a Worker back, the schema stays
 * where it is, so the question is always the same: **does version N-1 of the code still
 * work against version N of the schema?** For SQLite that reduces to properties we can
 * check directly, by applying the migrations incrementally into real databases and
 * comparing what each step did:
 *
 *  - nothing an older statement reads may have been removed;
 *  - nothing an older INSERT omits may have become required;
 *  - nothing an older write produced may have become forbidden.
 *
 * The third is the one people forget, and it is the one this suite found.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface SchemaSnapshot {
  readonly tables: ReadonlyMap<string, readonly ColumnInfo[]>;
  readonly indexes: ReadonlySet<string>;
  readonly tableSql: ReadonlyMap<string, string>;
}

/** Apply the first `count` migrations into a fresh database and describe the result. */
function schemaAfter(count: number): SchemaSnapshot {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of migrationFiles().slice(0, count)) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    const tables = new Map<string, readonly ColumnInfo[]>();
    const tableSql = new Map<string, string>();
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string }[];
    for (const row of rows) {
      const columns = db.prepare(`PRAGMA table_info(${row.name})`).all() as unknown as ColumnInfo[];
      tables.set(
        row.name,
        columns.map((c) => ({
          name: String(c.name),
          type: String(c.type),
          notnull: Number(c.notnull),
          dflt_value: c.dflt_value === null ? null : String(c.dflt_value),
          pk: Number(c.pk),
        })),
      );
      tableSql.set(row.name, row.sql ?? '');
    }
    const indexes = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    return { tables, indexes, tableSql };
  } finally {
    db.close();
  }
}

/** A live database at the current schema, for statements we want to actually run. */
function currentDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of migrationFiles()) db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  return db;
}

function columnsOf(snapshot: SchemaSnapshot, table: string): readonly ColumnInfo[] {
  return snapshot.tables.get(table) ?? [];
}

const FILES = migrationFiles();
const STEPS = FILES.map((_, index) => index + 1);

/**
 * The one migration that tightens rather than adds, recorded deliberately.
 *
 * `0002` rebuilds `credential_versions` to add CHECK constraints on `owner_scope` and
 * `aad`. That is *not* forward-compatible in general: a previous Worker writing a
 * credential whose AAD does not begin `v1|kv=` would now be rejected by the database.
 *
 * It is accepted here because no credential has ever been written — the service is not yet
 * accepting connections — and because the AAD shape it requires is the only one
 * `bindKeyVersion` can produce. If a second entry ever appears in this list without that
 * being a conscious decision, this test is where it gets noticed.
 */
const KNOWN_CONSTRAINT_TIGHTENING: ReadonlyMap<string, readonly string[]> = new Map([
  ['0002_credential_scope_check.sql', ['credential_versions']],
]);

describe('RESIL: migrations apply', () => {
  it('RESIL-140 every migration applies cleanly, in filename order, onto a fresh database', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(() => currentDatabase().close()).not.toThrow();
  });

  it('RESIL-141 each migration applies onto the schema the one before it left', () => {
    // Applying 1..n for every n proves the sequence, not just the end state. A migration
    // that only works on a fresh database is a migration that fails in production.
    for (const step of STEPS) {
      expect(() => schemaAfter(step), `migrations 1..${step} failed to apply`).not.toThrow();
    }
  });

  it('RESIL-142 the migration list is ordered and gapless, so "apply in order" is well defined', () => {
    const numbers = FILES.map((name) => Number(name.slice(0, 4)));
    expect(numbers).toEqual(numbers.slice().sort((a, b) => a - b));
    for (let i = 0; i < numbers.length; i += 1) expect(numbers[i]).toBe(i + 1);
  });
});

describe('RESIL: the previous version still reads the current schema', () => {
  it('RESIL-143 no table is ever removed between consecutive versions', () => {
    for (let step = 1; step < STEPS.length; step += 1) {
      const before = schemaAfter(step);
      const after = schemaAfter(step + 1);
      for (const table of before.tables.keys()) {
        expect(after.tables.has(table), `${FILES[step]} removed table ${table}`).toBe(true);
      }
    }
  });

  it('RESIL-144 no column is ever removed between consecutive versions', () => {
    for (let step = 1; step < STEPS.length; step += 1) {
      const before = schemaAfter(step);
      const after = schemaAfter(step + 1);
      for (const [table, columns] of before.tables) {
        const names = new Set(columnsOf(after, table).map((c) => c.name));
        for (const column of columns) {
          expect(names.has(column.name), `${FILES[step]} removed ${table}.${column.name}`).toBe(true);
        }
      }
    }
  });

  it('RESIL-145 no column changes type between consecutive versions', () => {
    for (let step = 1; step < STEPS.length; step += 1) {
      const before = schemaAfter(step);
      const after = schemaAfter(step + 1);
      for (const [table, columns] of before.tables) {
        const byName = new Map(columnsOf(after, table).map((c) => [c.name, c]));
        for (const column of columns) {
          const now = byName.get(column.name);
          if (now === undefined) continue;
          expect(now.type, `${FILES[step]} retyped ${table}.${column.name}`).toBe(column.type);
        }
      }
    }
  });

  it('RESIL-146 no existing column becomes required between consecutive versions', () => {
    // An older INSERT omits columns it does not know about. If one of them became NOT NULL
    // with no default, that INSERT starts failing the moment the Worker is rolled back.
    for (let step = 1; step < STEPS.length; step += 1) {
      const before = schemaAfter(step);
      const after = schemaAfter(step + 1);
      for (const [table, columns] of before.tables) {
        const byName = new Map(columnsOf(after, table).map((c) => [c.name, c]));
        for (const column of columns) {
          const now = byName.get(column.name);
          if (now === undefined || column.notnull === 1) continue;
          const tightened = now.notnull === 1 && now.dflt_value === null;
          expect(tightened, `${FILES[step]} made ${table}.${column.name} required`).toBe(false);
        }
      }
    }
  });

  it('RESIL-147 every newly added column is nullable or defaulted', () => {
    // This is the property that actually makes an older INSERT keep working.
    for (let step = 1; step < STEPS.length; step += 1) {
      const before = schemaAfter(step);
      const after = schemaAfter(step + 1);
      for (const [table, columns] of after.tables) {
        if (!before.tables.has(table)) continue; // a brand-new table has no older writer
        const existing = new Set(columnsOf(before, table).map((c) => c.name));
        for (const column of columns) {
          if (existing.has(column.name)) continue;
          const usable = column.notnull === 0 || column.dflt_value !== null;
          expect(usable, `${FILES[step]} added required ${table}.${column.name}`).toBe(true);
        }
      }
    }
  });

  it('RESIL-148 primary keys are never changed between consecutive versions', () => {
    for (let step = 1; step < STEPS.length; step += 1) {
      const before = schemaAfter(step);
      const after = schemaAfter(step + 1);
      for (const [table, columns] of before.tables) {
        if (!after.tables.has(table)) continue;
        const pkBefore = columns.filter((c) => c.pk > 0).map((c) => c.name).sort();
        const pkAfter = columnsOf(after, table).filter((c) => c.pk > 0).map((c) => c.name).sort();
        expect(pkAfter, `${FILES[step]} changed the primary key of ${table}`).toEqual(pkBefore);
      }
    }
  });

  it('RESIL-149 an older SELECT of the previous column list still runs against the current schema', () => {
    // The direct proof, rather than an inference from PRAGMA output: take every table's
    // column list as it was one version ago and actually run that SELECT against the
    // current schema.
    const previous = schemaAfter(STEPS.length - 1);
    const db = currentDatabase();
    try {
      for (const [table, columns] of previous.tables) {
        const list = columns.map((c) => c.name).join(', ');
        expect(
          () => db.prepare(`SELECT ${list} FROM ${table} LIMIT 0`).all(),
          `an older SELECT on ${table} no longer runs`,
        ).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('RESIL-150 an older INSERT that omits the newest column is still accepted', () => {
    // The concrete case: `0004` added `connections.webhook_path_id`. A Worker that predates
    // it writes a connection without that column.
    const db = currentDatabase();
    try {
      db.exec(
        "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws_r', 'R', 'active', '2026-09-19T10:00:00.000Z')",
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at)
             VALUES (?, ?, 'hubspot', 'ready', '', '2026-09-19T10:00:00.000Z')`,
          )
          .run('conn_old', 'ws_r'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('RESIL-151 the unique index added in 0004 permits many rows that omit the column', () => {
    // A UNIQUE index over a nullable column would break every older write at the second row
    // if SQLite treated NULLs as equal. It does not, and this is where we prove we relied on
    // that correctly rather than by luck.
    const db = currentDatabase();
    try {
      db.exec(
        "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws_r', 'R', 'active', '2026-09-19T10:00:00.000Z')",
      );
      const insert = db.prepare(
        `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at)
         VALUES (?, 'ws_r', ?, 'ready', '', '2026-09-19T10:00:00.000Z')`,
      );
      insert.run('conn_a', 'hubspot');
      expect(() => insert.run('conn_b', 'resend')).not.toThrow();
      const n = db.prepare('SELECT COUNT(*) AS n FROM connections WHERE webhook_path_id IS NULL').get() as {
        n: number;
      };
      expect(Number(n.n)).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('RESIL: writes an older version made must still be legal', () => {
  it('RESIL-152 constraint tightening is recorded rather than discovered', () => {
    // Find every migration that rebuilds a table — the SQLite idiom for adding a CHECK —
    // and require it to be in the accepted list. Adding a constraint is a deliberate,
    // reviewable act; it must never happen by accident.
    const found = new Map<string, string[]>();
    for (const file of FILES) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const rebuilt = [...sql.matchAll(/ALTER TABLE\s+(\w+)_new\s+RENAME TO\s+(\w+)/gi)].map((m) => m[2] as string);
      if (rebuilt.length > 0) found.set(file, rebuilt);
    }
    for (const [file, tables] of found) {
      const accepted = KNOWN_CONSTRAINT_TIGHTENING.get(file);
      expect(accepted, `${file} rebuilds ${tables.join(', ')} and is not in the accepted list`).toBeDefined();
      expect([...tables].sort()).toEqual([...(accepted ?? [])].sort());
    }
    // And the accepted list is not stale.
    for (const file of KNOWN_CONSTRAINT_TIGHTENING.keys()) {
      expect(FILES, `${file} is listed as tightening but no longer exists`).toContain(file);
    }
  });

  it('RESIL-153 the tightened table is the one we know about, and it is still empty by design', () => {
    // The accepted risk, stated as a test: `credential_versions` gained CHECK constraints
    // that an older Worker could violate. It is safe only because nothing has ever been
    // written to it, so the assertion is on the constraint, not on a hope.
    const db = currentDatabase();
    try {
      const sql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'credential_versions'")
          .get() as { sql: string }
      ).sql;
      expect(sql).toContain('CHECK');
      expect(sql).toContain("aad LIKE 'v1|kv=%'");

      db.exec(
        "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws_r', 'R', 'active', '2026-09-19T10:00:00.000Z')",
      );
      db.exec(
        `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at)
         VALUES ('conn_r', 'ws_r', 'hubspot', 'ready', '', '2026-09-19T10:00:00.000Z')`,
      );
      // An older Worker's AAD shape is now refused by the database. This is the rollback
      // hazard, demonstrated rather than asserted in prose.
      expect(() =>
        db
          .prepare(
            `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
             VALUES (?, 'conn_r', 'connection:conn_r', 1, 'x', 'y', ?, '2026-09-19T10:00:00.000Z')`,
          )
          .run('cred_old', 'v1|ws=ws_r|provider=hubspot|purpose=connector_access_token'),
      ).toThrow();
      // The current shape is accepted.
      expect(() =>
        db
          .prepare(
            `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
             VALUES (?, 'conn_r', 'connection:conn_r', 1, 'x', 'y', ?, '2026-09-19T10:00:00.000Z')`,
          )
          .run('cred_new', 'v1|kv=1|ws=ws_r|provider=hubspot|purpose=connector_access_token'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('RESIL-154 no migration deletes customer data', () => {
    // A rollback cannot restore rows a migration removed. `DELETE FROM` and `DROP TABLE` on
    // anything but a rebuild scratch table are therefore forbidden without a conscious
    // decision, and there is no such decision on record.
    const offenders: string[] = [];
    for (const file of FILES) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      for (const match of sql.matchAll(/^\s*DELETE\s+FROM\s+(\w+)/gim)) offenders.push(`${file}: DELETE FROM ${match[1]}`);
      for (const match of sql.matchAll(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gim)) {
        const table = match[1] as string;
        // Dropping the *old* table is the second half of a rebuild, and the rebuild itself
        // is already governed by the constraint-tightening case above.
        const isRebuild = new RegExp(`ALTER TABLE\\s+${table}_new\\s+RENAME TO\\s+${table}`, 'i').test(sql);
        if (!isRebuild) offenders.push(`${file}: DROP TABLE ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('RESIL-155 a rebuild copies every column it replaces, so no data is silently dropped', () => {
    for (const [file, tables] of KNOWN_CONSTRAINT_TIGHTENING) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      for (const table of tables) {
        const step = FILES.indexOf(file);
        const before = schemaAfter(step); // the schema the rebuild started from
        const columns = columnsOf(before, table);
        expect(columns.length).toBeGreaterThan(0);
        for (const column of columns) {
          expect(sql, `${file} does not carry ${table}.${column.name} across the rebuild`).toContain(column.name);
        }
      }
    }
  });
});

describe('RESIL: the harness runs the schema the service runs', () => {
  it('RESIL-156 the integration harness applies every migration, not just the first', () => {
    // A harness one migration behind reports `no such column` in whichever test happens to
    // touch the new column first, which reads like a broken test rather than a stale
    // harness — and it hides exactly the forward-compatibility questions this suite asks.
    const source = readFileSync(
      fileURLToPath(new URL('../db/harness.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toMatch(/readdirSync/);
    expect(source).not.toMatch(/['"`]0001_init\.sql['"`]\s*\)?\s*;?\s*$/m);
  });

  it('RESIL-157 the current schema carries the newest migration’s column', () => {
    const snapshot = schemaAfter(STEPS.length);
    const connections = columnsOf(snapshot, 'connections').map((c) => c.name);
    expect(connections).toContain('webhook_path_id');
    expect(snapshot.indexes.has('idx_connections_webhook_path')).toBe(true);
  });
});
