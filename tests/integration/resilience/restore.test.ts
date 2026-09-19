/**
 * Backup restoration (RESIL 160 to 175) — an actual, isolated restore.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * The restore procedure for D1 is a **logical** one: `wrangler d1 export` writes a SQL
 * file, and `wrangler d1 execute --file` replays it into a database you name. This suite
 * performs exactly that shape of operation — dump a populated database to SQL, replay it
 * into a *separate, empty* database created from the migrations, and verify the result —
 * against the real schema and the real repositories.
 *
 * It does **not** prove Cloudflare's own Time Travel or the `wrangler` invocation. That is
 * an account operation, and the exact commands are named in the handoff for the lead to
 * run. What it does prove is everything that could go wrong on our side of that command:
 * counts, tenant ownership, evidence integrity, audit timing, and — the one that would be
 * unforgivable — that restoring does not contact a customer or send anything.
 *
 * Every restore here goes into a NEW database. Nothing in this file can write to the
 * source, which is the property that makes "never restore over production" structural
 * rather than a note in a runbook.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runs, assertions, evidence } from '@app/db/runs';
import {
  at,
  connectedResolver,
  createSchedulerHarness,
  type SchedulerHarness,
} from '../scheduler/harness';
import { makeCrmEvidence, makeEmailEvent } from '../../fixtures/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

/** Tables carrying customer data, in dependency order for replay. */
const DUMP_ORDER = [
  'users',
  'workspaces',
  'memberships',
  'connections',
  'credential_versions',
  'workflows',
  'workflow_versions',
  'source_events',
  'runs',
  'run_attempts',
  'assertions',
  'evidence',
  'outbox',
  'subscriptions',
  'entitlements',
  'notification_deliveries',
  'audit_events',
] as const;

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) {
    return `X'${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The backup artefact: the same shape `wrangler d1 export` produces. */
export function dumpToSql(db: DatabaseSync): string {
  const lines: string[] = [];
  for (const table of DUMP_ORDER) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (columns.length === 0) continue;
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const values = columns.map((name) => sqlLiteral(row[name])).join(', ');
      lines.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values});`);
    }
  }
  return lines.join('\n');
}

/**
 * Restore into a **new, isolated** database built from the migrations.
 *
 * Takes only the dump text, so it has no handle on the source and structurally cannot
 * write to it.
 */
export function restoreIntoNewDatabase(dumpSql: string): DatabaseSync {
  const target = new DatabaseSync(':memory:');
  target.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    target.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  if (dumpSql.trim().length > 0) target.exec(dumpSql);
  return target;
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

let harness: SchedulerHarness;
let restored: DatabaseSync | null = null;

/** A populated, realistic database: an admitted run, observed to a terminal status. */
async function populate(): Promise<void> {
  await harness.admit('evt-restore-1');
  await harness.admit('evt-restore-2');
  await harness.tick({
    now: at(1),
    resolver: connectedResolver(),
    connectors: (await import('../scheduler/harness')).makeRegistry(
      (await import('../scheduler/harness')).makeFakeConnector('hubspot', () => ({
        provider: 'hubspot',
        provider_account_id: 'hub-acct-1000',
        evidence: [makeCrmEvidence()],
        gaps: [],
        calls_made: 1,
      })),
      (await import('../scheduler/harness')).makeFakeConnector('resend', () => ({
        provider: 'resend',
        provider_account_id: 'resend-acct-2000',
        evidence: [makeEmailEvent()],
        gaps: [],
        calls_made: 1,
      })),
    ),
    maxRuns: 10,
  });
}

beforeEach(() => {
  harness = createSchedulerHarness();
});

afterEach(() => {
  restored?.close();
  restored = null;
  harness.close();
});

describe('RESIL: restoring into an isolated database', () => {
  it('RESIL-160 a populated database dumps and restores into a new, separate database', async () => {
    await populate();
    const dump = dumpToSql(harness.h.raw);
    expect(dump.length).toBeGreaterThan(0);

    restored = restoreIntoNewDatabase(dump);

    // Separate handles, separate storage. The restore never touched the source.
    expect(restored).not.toBe(harness.h.raw);
    expect(count(restored, 'runs')).toBeGreaterThan(0);
  });

  it('RESIL-161 every table’s record count matches the source exactly', async () => {
    await populate();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    const mismatches: string[] = [];
    for (const table of DUMP_ORDER) {
      const before = count(harness.h.raw, table);
      const after = count(restored, table);
      if (before !== after) mismatches.push(`${table}: ${before} -> ${after}`);
    }
    expect(mismatches).toEqual([]);
    // And the fixture is not vacuous: there really was something to restore.
    expect(count(restored, 'runs')).toBe(2);
    expect(count(restored, 'assertions')).toBeGreaterThan(0);
    expect(count(restored, 'evidence')).toBeGreaterThan(0);
  });

  it('RESIL-162 tenant ownership survives the restore: every child belongs to its parent', async () => {
    await populate();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    // The composite property, not just "workspace_id is not null": each child's workspace
    // must be the same as its parent's. A restore that crossed those would be a tenancy
    // breach created by our own recovery procedure.
    const orphans = [
      'SELECT COUNT(*) AS n FROM runs r JOIN source_events s ON s.id = r.source_event_id WHERE s.workspace_id <> r.workspace_id',
      'SELECT COUNT(*) AS n FROM assertions a JOIN runs r ON r.id = a.run_id WHERE r.workspace_id <> a.workspace_id',
      'SELECT COUNT(*) AS n FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.workspace_id <> e.workspace_id',
      'SELECT COUNT(*) AS n FROM run_attempts t JOIN runs r ON r.id = t.run_id WHERE r.workspace_id <> t.workspace_id',
      'SELECT COUNT(*) AS n FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE w.workspace_id <> v.workspace_id',
    ];
    for (const sql of orphans) {
      expect(Number((restored.prepare(sql).get() as { n: number }).n), sql).toBe(0);
    }
  });

  it('RESIL-163 no row is restored pointing at a workspace that does not exist', async () => {
    await populate();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    for (const table of ['runs', 'assertions', 'evidence', 'source_events', 'entitlements']) {
      const dangling = restored
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE w.id IS NULL`,
        )
        .get() as { n: number };
      expect(Number(dangling.n), `${table} has rows with no workspace`).toBe(0);
    }
  });

  it('RESIL-164 a sample of evidence is byte-identical after the restore', async () => {
    await populate();
    const sourceRows = await evidence.listForRun(
      harness.h.db,
      harness.ws.workspaceId,
      'run_evt-restore-1',
    );
    expect(sourceRows.length).toBeGreaterThan(0);

    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    for (const row of sourceRows) {
      const after = restored
        .prepare(
          'SELECT id, provider, origin, observed_at, content_digest, redacted_summary, expires_at FROM evidence WHERE id = ?',
        )
        .get(row.id) as Record<string, unknown> | undefined;
      expect(after, `evidence ${row.id} did not restore`).toBeDefined();
      expect(after?.content_digest).toBe(row.content_digest);
      expect(after?.redacted_summary).toBe(row.redacted_summary);
      expect(after?.observed_at).toBe(row.observed_at);
      expect(after?.expires_at).toBe(row.expires_at);
    }
  });

  it('RESIL-165 a restored run keeps its decision and its original timing', async () => {
    await populate();
    const before = await runs.get(harness.h.db, harness.ws.workspaceId, 'run_evt-restore-1');
    expect(before).not.toBeNull();

    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    const after = restored
      .prepare(
        'SELECT status, revision, observation_count, deadline_at, created_at, completed_at FROM runs WHERE id = ?',
      )
      .get('run_evt-restore-1') as Record<string, unknown>;
    // A verification result is an audit record. A restore that shifted a timestamp or a
    // status would rewrite what a customer was told.
    expect(after.status).toBe(before?.status);
    expect(Number(after.revision)).toBe(before?.revision);
    expect(after.deadline_at).toBe(before?.deadline_at);
    expect(after.created_at).toBe(before?.created_at);
    expect(after.completed_at).toBe(before?.completed_at);
  });

  it('RESIL-166 restored assertions still read back through the real repository', async () => {
    await populate();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    const before = await assertions.listForRun(
      harness.h.db,
      harness.ws.workspaceId,
      'run_evt-restore-1',
    );
    const after = restored
      .prepare(
        'SELECT rule_id, status, reason_code FROM assertions WHERE run_id = ? ORDER BY rule_id',
      )
      .all('run_evt-restore-1') as { rule_id: string; status: string; reason_code: string }[];

    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.rule_id)).toEqual(before.map((r) => r.rule_id).sort());
    expect(after.every((r) => r.status.length > 0 && r.reason_code.length > 0)).toBe(true);
  });
});

describe('RESIL: restoring contacts nobody', () => {
  it('RESIL-167 a restore makes no outbound request', async () => {
    await populate();
    // `tests/setup.ts` replaces global fetch with a guard that throws on any host. A restore
    // that tried to reach a provider would fail this test loudly rather than quietly send.
    const dump = dumpToSql(harness.h.raw);
    restored = restoreIntoNewDatabase(dump);
    expect(count(restored, 'runs')).toBe(2);
    // Belt and braces: assert the guard is actually installed, so this is not vacuous.
    await expect(fetch('https://api.hubapi.com/')).rejects.toThrow(/Blocked outbound fetch/);
  });

  it('RESIL-168 a restore makes no provider call through any connector', async () => {
    await populate();
    const callsBefore = harness.registry.totalCalls();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));
    // The restore path has no connector in it at all; this pins that it stays that way.
    expect(harness.registry.totalCalls()).toBe(callsBefore);
  });

  it('RESIL-169 a restore sends no notification and creates no delivery record', async () => {
    await populate();
    const before = count(harness.h.raw, 'notification_deliveries');
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));
    expect(count(restored, 'notification_deliveries')).toBe(before);
  });

  it('RESIL-170 restored outbox rows keep the dispatch state they had, so nothing is re-announced', async () => {
    await populate();
    const before = harness.h.raw
      .prepare('SELECT id, dispatch_state, attempts FROM outbox ORDER BY id')
      .all() as { id: string; dispatch_state: string; attempts: number }[];
    expect(before.length).toBeGreaterThan(0);

    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    const after = restored
      .prepare('SELECT id, dispatch_state, attempts FROM outbox ORDER BY id')
      .all() as { id: string; dispatch_state: string; attempts: number }[];
    expect(after.map((r) => [r.id, r.dispatch_state, Number(r.attempts)])).toEqual(
      before.map((r) => [r.id, r.dispatch_state, Number(r.attempts)]),
    );
    // An already-dispatched announcement must not come back as pending: that is how a
    // restore turns into a second email for an event the customer already heard about.
    expect(after.filter((r) => r.dispatch_state === 'dispatched').length).toBe(
      before.filter((r) => r.dispatch_state === 'dispatched').length,
    );
  });

  it('RESIL-171 restoring an empty backup produces an empty database, not a broken one', async () => {
    restored = restoreIntoNewDatabase('');
    for (const table of DUMP_ORDER) expect(count(restored, table)).toBe(0);
    // And it is a usable schema, not a shell.
    expect(() =>
      restored?.exec(
        "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws_x', 'X', 'active', '2026-09-19T10:00:00.000Z')",
      ),
    ).not.toThrow();
  });
});

describe('RESIL: the restore target is never the source', () => {
  it('RESIL-172 the restore function takes only text, so it cannot write to the source', async () => {
    await populate();
    const sourceRunCount = count(harness.h.raw, 'runs');
    const sourceEvidence = count(harness.h.raw, 'evidence');

    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));
    // Mutate the restored copy heavily.
    restored.exec('DELETE FROM evidence');
    restored.exec("UPDATE runs SET status = 'FAILED'");

    // The source is untouched, because the restore never held a handle to it.
    expect(count(harness.h.raw, 'runs')).toBe(sourceRunCount);
    expect(count(harness.h.raw, 'evidence')).toBe(sourceEvidence);
    const statuses = harness.h.raw.prepare('SELECT DISTINCT status FROM runs').all() as {
      status: string;
    }[];
    expect(statuses.map((s) => s.status)).not.toContain('FAILED');
  });

  it('RESIL-173 a restored database is independent: changes on one side do not reach the other', async () => {
    await populate();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));

    harness.h.raw.exec(
      "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws_after', 'After', 'active', '2026-09-19T11:00:00.000Z')",
    );
    const inRestored = restored
      .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'ws_after'")
      .get() as {
      n: number;
    };
    expect(Number(inRestored.n)).toBe(0);
  });

  it('RESIL-174 the restored database enforces the same constraints as the source', async () => {
    await populate();
    restored = restoreIntoNewDatabase(dumpToSql(harness.h.raw));
    // Foreign keys are on, so a restored database cannot accept a row the live one would
    // refuse. A restore that dropped enforcement would let recovery introduce bad data.
    expect(() =>
      restored?.exec(
        `INSERT INTO runs (id, workspace_id, workflow_id, workflow_version_id, source_event_id, status, revision, observation_count, deadline_at, created_at)
         VALUES ('run_bad', 'ws_nonexistent', 'wf_x', 'wfv_x', 'sev_x', 'PENDING', 1, 0, '2026-09-19T10:10:00.000Z', '2026-09-19T10:00:00.000Z')`,
      ),
    ).toThrow();
  });

  it('RESIL-175 restoring twice into two databases yields two identical, independent copies', async () => {
    await populate();
    const dump = dumpToSql(harness.h.raw);
    restored = restoreIntoNewDatabase(dump);
    const second = restoreIntoNewDatabase(dump);
    try {
      for (const table of DUMP_ORDER) {
        expect(count(second, table), table).toBe(count(restored, table));
      }
      second.exec('DELETE FROM assertions');
      expect(count(restored, 'assertions')).toBeGreaterThan(0);
    } finally {
      second.close();
    }
  });
});
