/**
 * Does `ON DELETE CASCADE` actually fire?
 *
 * A09's deletion path deletes `source_events` and relies on the schema to take `runs`,
 * `run_attempts`, `assertions` and `evidence` with it. Its in-memory test can only prove
 * the first of those. If the cascade did not fire in production, account deletion would
 * leave a customer's runs, assertions and evidence in the database while telling them it
 * was gone — which is the worst possible combination of a privacy failure and a false
 * statement.
 *
 * Confirmed 2026-09-19 from Cloudflare's own documentation
 * (https://developers.cloudflare.com/d1/sql-api/foreign-keys/): *"By default, D1 enforces
 * that foreign key constraints are valid within all queries and migrations. This is
 * identical to the behaviour you would observe when setting `PRAGMA foreign_keys = on` in
 * SQLite for every transaction."* The harness sets exactly that PRAGMA, so what these
 * cases prove is what production does.
 *
 * SQLite's own default is the opposite — `foreign_keys` is OFF unless switched on — so
 * PERSIST-221 asserts the harness really has it enabled. Without that case the cascade
 * proof could quietly become vacuous the day somebody edits `createTestDb`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertions, evidence, runAttempts, runs, sourceEvents } from '@app/db';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

describe('foreign key cascade', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-221 the harness enforces foreign keys, as D1 does', () => {
    const row = h.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it('PERSIST-222 deleting a source event cascades to its run, attempts, assertions and evidence', async () => {
    seedRun(h, ws, 'run_1');
    await runAttempts.start(h.db, {
      id: 'att_1',
      workspaceId: ws.workspaceId,
      runId: 'run_1',
      leaseId: 'lse_1',
      leaseExpiresAt: T0,
      startedAt: T0,
    });
    await assertions.replaceForRevision(h.db, {
      workspaceId: ws.workspaceId,
      runId: 'run_1',
      revision: 1,
      rows: [
        {
          id: 'asr_1',
          ruleId: 'crm_exists',
          label: 'CRM record exists',
          mandatory: true,
          status: 'SUPPORTED',
          reasonCode: 'MATCHED',
        },
      ],
    });
    await evidence.recordMany(h.db, {
      workspaceId: ws.workspaceId,
      runId: 'run_1',
      rows: [
        {
          id: 'evd_1',
          provider: 'hubspot',
          origin: 'provider_readback',
          observedAt: T0,
          contentDigest: 'digest',
          redactedSummary: '{}',
          expiresAt: '2026-10-19T10:00:00.000Z',
        },
      ],
    });

    expect(countRows(h, 'source_events')).toBe(1);
    expect(countRows(h, 'runs')).toBe(1);
    expect(countRows(h, 'run_attempts')).toBe(1);
    expect(countRows(h, 'assertions')).toBe(1);
    expect(countRows(h, 'evidence')).toBe(1);

    // Exactly what A09's deletion path does: delete the source event, nothing else.
    const removed = await h.db
      .prepare('DELETE FROM source_events WHERE workspace_id = ? AND id = ?')
      .bind(ws.workspaceId, 'sev_run_1')
      .run();
    expect(removed.meta.changes).toBe(1);

    expect(countRows(h, 'source_events')).toBe(0);
    expect(countRows(h, 'runs')).toBe(0);
    expect(countRows(h, 'run_attempts')).toBe(0);
    expect(countRows(h, 'assertions')).toBe(0);
    expect(countRows(h, 'evidence')).toBe(0);
    expect(await runs.get(h.db, ws.workspaceId, 'run_1')).toBeNull();
    expect(await sourceEvents.getById(h.db, ws.workspaceId, 'sev_run_1')).toBeNull();
  });

  it('PERSIST-223 deleting a workspace cascades through every customer-scoped table', async () => {
    const other = seedWorkspace(h, 'beta');
    seedRun(h, ws, 'run_alpha');
    seedRun(h, other, 'run_beta');
    await evidence.recordMany(h.db, {
      workspaceId: ws.workspaceId,
      runId: 'run_alpha',
      rows: [
        {
          id: 'evd_a',
          provider: 'hubspot',
          origin: 'provider_readback',
          observedAt: T0,
          contentDigest: 'd',
          redactedSummary: '{}',
          expiresAt: '2026-10-19T10:00:00.000Z',
        },
      ],
    });

    await h.db.prepare('DELETE FROM workspaces WHERE id = ?').bind(ws.workspaceId).run();

    // A's rows are gone…
    expect(countRows(h, 'runs', 'workspace_id = ?', ws.workspaceId)).toBe(0);
    expect(countRows(h, 'source_events', 'workspace_id = ?', ws.workspaceId)).toBe(0);
    expect(countRows(h, 'evidence', 'workspace_id = ?', ws.workspaceId)).toBe(0);
    expect(countRows(h, 'memberships', 'workspace_id = ?', ws.workspaceId)).toBe(0);
    expect(countRows(h, 'workflows', 'workspace_id = ?', ws.workspaceId)).toBe(0);
    expect(countRows(h, 'entitlements', 'workspace_id = ?', ws.workspaceId)).toBe(0);
    // …and B's are untouched.
    expect(countRows(h, 'runs', 'workspace_id = ?', other.workspaceId)).toBe(1);
    expect(countRows(h, 'workflows', 'workspace_id = ?', other.workspaceId)).toBe(1);
  });

  it('PERSIST-224 a child row cannot be written against a parent that does not exist', async () => {
    // The other half of the same guarantee: the cascade only means something if the
    // foreign key is real, and a real foreign key refuses an orphan.
    await expect(
      h.db
        .prepare(
          `INSERT INTO evidence (id, workspace_id, run_id, provider, origin, observed_at, content_digest, redacted_summary, expires_at)
           VALUES (?, ?, ?, 'hubspot', 'provider_readback', ?, 'd', '{}', ?)`,
        )
        .bind('evd_x', ws.workspaceId, 'run_does_not_exist', T0, T0)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});
