import { describe, expect, it } from 'vitest';
import { createTestDb, seedWorkspace } from './harness';

describe('harness', () => {
  it('PERSIST-001 applies the migration and reports meta.changes', async () => {
    const h = createTestDb();
    try {
      const ws = seedWorkspace(h, 'smoke');
      const row = await h.db
        .prepare('SELECT id, run_limit FROM entitlements WHERE workspace_id = ?')
        .bind(ws.workspaceId)
        .first<{ id: string; run_limit: number }>();
      expect(row?.run_limit).toBe(500);

      const upd = await h.db
        .prepare('UPDATE entitlements SET reserved = reserved + 1 WHERE workspace_id = ? AND run_limit >= 1')
        .bind(ws.workspaceId)
        .run();
      expect(upd.meta.changes).toBe(1);

      const noop = await h.db
        .prepare('UPDATE entitlements SET reserved = reserved + 1 WHERE workspace_id = ? AND run_limit >= 99999')
        .bind(ws.workspaceId)
        .run();
      expect(noop.meta.changes).toBe(0);

      const guarded = await h.db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) SELECT ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?)`,
        )
        .bind('k', '{}', '2026-09-19T10:00:00.000Z', ws.workspaceId)
        .run();
      expect(guarded.meta.changes).toBe(1);

      await expect(
        h.db.batch([
          h.db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').bind('a', '{}', 'x'),
          h.db.prepare('UPDATE entitlements SET reserved = NULL WHERE workspace_id = ?').bind(ws.workspaceId),
        ]),
      ).rejects.toThrow(/NOT NULL/i);

      const rolledBack = await h.db.prepare("SELECT key FROM settings WHERE key = 'a'").first();
      expect(rolledBack).toBeNull();
    } finally {
      h.close();
    }
  });
});
