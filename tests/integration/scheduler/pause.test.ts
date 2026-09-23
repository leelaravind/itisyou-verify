/**
 * The owner's "expensive verification" pause, through the real scheduled entry point.
 *
 * `TickDeps.suspendDueRuns` existed from the start and `handleScheduled` never passed it, so
 * the switch on /owner said it stopped provider reads while the minute tick carried on. Found
 * by the 23 September audit. This drives `handleScheduled` (what the Worker's `scheduled()`
 * calls) against a real database with a due run, paused and then not.
 *
 * Case ids `OWNER-931..OWNER-932`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleScheduled } from '@app/scheduler/tick';
import { controlSettingKey } from '@app/owner/controls';
import { createTestDb, seedRun, seedWorkspace, type TestDb } from '../db/harness';

let h: TestDb | null = null;
afterEach(() => {
  h?.close();
  h = null;
  vi.unstubAllGlobals();
});

function setup(paused: boolean): { h: TestDb; calls: string[] } {
  h = createTestDb();
  const ws = seedWorkspace(h, 'pause', { createdAt: '2026-09-19T10:00:00.000Z' });
  seedRun(h, ws, 'run_pause_1', { status: 'PENDING' });
  h.raw
    .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
    .run(
      controlSettingKey('expensive_verification'),
      JSON.stringify({ paused, changedAt: '2026-09-19T10:00:00.000Z', changedBy: 'owner' }),
      '2026-09-19T10:00:00.000Z',
    );
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{}', { status: 503 });
  });
  return { h, calls };
}

function revision(db: TestDb): number {
  return (
    db.raw.prepare("SELECT revision FROM runs WHERE id = 'run_pause_1'").get() as {
      revision: number;
    }
  ).revision;
}

describe('the expensive-verification pause', () => {
  it('OWNER-931 while paused, the minute tick claims no due run and reads no provider', async () => {
    const { h: db, calls } = setup(true);
    const before = revision(db);
    const report = await handleScheduled(
      { DB: db.db, ENVIRONMENT: 'test', STRIPE_MODE: 'test' } as never,
      { now: new Date('2026-09-19T10:05:00.000Z') },
    );
    expect(report.runs.claimed).toBe(0);
    expect(revision(db)).toBe(before);
    expect(calls.filter((url) => /hubapi|resend/.test(url))).toHaveLength(0);
  });

  it('OWNER-932 once the pause lifts, the same due run is claimed as before', async () => {
    const { h: db } = setup(false);
    const report = await handleScheduled(
      { DB: db.db, ENVIRONMENT: 'test', STRIPE_MODE: 'test' } as never,
      { now: new Date('2026-09-19T10:05:00.000Z') },
    );
    expect(report.runs.claimed).toBe(1);
  });
});
