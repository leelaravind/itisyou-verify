/**
 * The due-job query, the compare-and-set lease and the optimistic-concurrency outcome
 * write. These three are what stop two scheduler ticks doing the same work twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outbox, runAttempts, runs } from '@app/db';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

const NOW = '2026-09-19T10:05:00.000Z';
const LEASE_UNTIL = '2026-09-19T10:06:00.000Z';

describe('scheduler', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-140 lists only runs that are actually due, oldest first, bounded', async () => {
    seedRun(h, ws, 'run_due_1', { nextCheckAt: '2026-09-19T10:01:00.000Z' });
    seedRun(h, ws, 'run_due_2', { nextCheckAt: '2026-09-19T10:00:00.000Z' });
    seedRun(h, ws, 'run_future', { nextCheckAt: '2026-09-19T11:00:00.000Z' });
    seedRun(h, ws, 'run_terminal', { nextCheckAt: null, status: 'VERIFIED' });

    const due = await runs.listDue(h.db, NOW, 10);
    expect(due.map((r) => r.id)).toEqual(['run_due_2', 'run_due_1']);
    expect(await runs.listDue(h.db, NOW, 1)).toHaveLength(1);
  });

  it('PERSIST-141 a run exactly at its due instant is due', async () => {
    seedRun(h, ws, 'run_edge', { nextCheckAt: NOW });
    expect((await runs.listDue(h.db, NOW, 10)).map((r) => r.id)).toEqual(['run_edge']);
  });

  it('PERSIST-142 claiming pushes the run out of the due window and bumps the revision', async () => {
    seedRun(h, ws, 'run_1', { nextCheckAt: '2026-09-19T10:00:00.000Z' });
    const claimed = await runs.claimDue(h.db, {
      now: NOW,
      limit: 10,
      leaseSeconds: 60,
      leaseUntil: LEASE_UNTIL,
    });
    expect(claimed.map((r) => r.id)).toEqual(['run_1']);
    expect(claimed[0]?.revision).toBe(2);

    const stored = await runs.get(h.db, ws.workspaceId, 'run_1');
    expect(stored?.revision).toBe(2);
    expect(stored?.next_check_at).toBe(LEASE_UNTIL);
    expect(await runs.listDue(h.db, NOW, 10)).toHaveLength(0);
  });

  it('PERSIST-143 two schedulers that see the same candidate: exactly one claims it', async () => {
    seedRun(h, ws, 'run_1', { nextCheckAt: '2026-09-19T10:00:00.000Z' });
    // Both callers ran the due query before either claimed — the real race.
    const [first, second] = await Promise.all([
      runs.listDue(h.db, NOW, 10),
      runs.listDue(h.db, NOW, 10),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const claims = await Promise.all([
      runs.tryClaim(h.db, {
        runId: 'run_1',
        expectedRevision: first[0]?.revision ?? 0,
        now: NOW,
        leaseUntil: LEASE_UNTIL,
      }),
      runs.tryClaim(h.db, {
        runId: 'run_1',
        expectedRevision: second[0]?.revision ?? 0,
        now: NOW,
        leaseUntil: LEASE_UNTIL,
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await runs.get(h.db, ws.workspaceId, 'run_1'))?.revision).toBe(2);
  });

  it('PERSIST-144 two concurrent claimDue callers claim each run exactly once', async () => {
    for (let i = 0; i < 6; i += 1) {
      seedRun(h, ws, `run_${i}`, { nextCheckAt: '2026-09-19T10:00:00.000Z' });
    }
    const [a, b] = await Promise.all([
      runs.claimDue(h.db, { now: NOW, limit: 10, leaseSeconds: 60, leaseUntil: LEASE_UNTIL }),
      runs.claimDue(h.db, { now: NOW, limit: 10, leaseSeconds: 60, leaseUntil: LEASE_UNTIL }),
    ]);
    const claimedIds = [...(a ?? []), ...(b ?? [])].map((r) => r.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds).toHaveLength(6);
  });

  it('PERSIST-145 a stale revision cannot claim', async () => {
    seedRun(h, ws, 'run_1', { nextCheckAt: '2026-09-19T10:00:00.000Z', revision: 3 });
    expect(
      await runs.tryClaim(h.db, { runId: 'run_1', expectedRevision: 2, now: NOW, leaseUntil: LEASE_UNTIL }),
    ).toBe(false);
    expect(
      await runs.tryClaim(h.db, { runId: 'run_1', expectedRevision: 3, now: NOW, leaseUntil: LEASE_UNTIL }),
    ).toBe(true);
  });

  it('PERSIST-146 a terminal run is never claimable', async () => {
    seedRun(h, ws, 'run_done', { nextCheckAt: null, status: 'VERIFIED' });
    expect(
      await runs.tryClaim(h.db, {
        runId: 'run_done',
        expectedRevision: 1,
        now: NOW,
        leaseUntil: LEASE_UNTIL,
      }),
    ).toBe(false);
  });

  it('PERSIST-147 a late worker cannot overwrite a newer outcome', async () => {
    seedRun(h, ws, 'run_1', { nextCheckAt: '2026-09-19T10:00:00.000Z' });
    const fresh = await runs.applyOutcome(h.db, {
      workspaceId: ws.workspaceId,
      runId: 'run_1',
      expectedRevision: 1,
      status: 'UNVERIFIED',
      nextCheckAt: '2026-09-19T10:07:00.000Z',
      observationCount: 1,
    });
    expect(fresh).toBe(true);

    const stale = await runs.applyOutcome(h.db, {
      workspaceId: ws.workspaceId,
      runId: 'run_1',
      expectedRevision: 1,
      status: 'VERIFIED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: NOW,
    });
    expect(stale).toBe(false);
    expect((await runs.get(h.db, ws.workspaceId, 'run_1'))?.status).toBe('UNVERIFIED');
  });

  it('PERSIST-148 a terminal outcome clears next_check_at so the run leaves the queue', async () => {
    seedRun(h, ws, 'run_1', { nextCheckAt: '2026-09-19T10:00:00.000Z' });
    await runs.applyOutcome(h.db, {
      workspaceId: ws.workspaceId,
      runId: 'run_1',
      expectedRevision: 1,
      status: 'VERIFIED',
      nextCheckAt: null,
      observationCount: 2,
      completedAt: NOW,
    });
    const run = await runs.get(h.db, ws.workspaceId, 'run_1');
    expect(run).toMatchObject({ status: 'VERIFIED', next_check_at: null, completed_at: NOW });
    expect(await runs.listDue(h.db, '2027-01-01T00:00:00.000Z', 10)).toHaveLength(0);
  });

  it('PERSIST-149 attempt numbers are dense and cannot collide', async () => {
    seedRun(h, ws, 'run_1');
    expect(
      await runAttempts.start(h.db, {
        id: 'att_1',
        workspaceId: ws.workspaceId,
        runId: 'run_1',
        leaseId: 'lse_1',
        leaseExpiresAt: LEASE_UNTIL,
        startedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await runAttempts.start(h.db, {
        id: 'att_2',
        workspaceId: ws.workspaceId,
        runId: 'run_1',
        leaseId: 'lse_2',
        leaseExpiresAt: LEASE_UNTIL,
        startedAt: NOW,
      }),
    ).toBe(true);
    const list = await runAttempts.listForRun(h.db, ws.workspaceId, 'run_1');
    expect(list.map((r) => r.attempt_number)).toEqual([2, 1]);

    expect(
      await runAttempts.finish(h.db, {
        workspaceId: ws.workspaceId,
        attemptId: 'att_1',
        endedAt: NOW,
        outcome: 'observed',
      }),
    ).toBe(true);
    // Finishing twice must not rewrite the record.
    expect(
      await runAttempts.finish(h.db, {
        workspaceId: ws.workspaceId,
        attemptId: 'att_1',
        endedAt: NOW,
        outcome: 'something-else',
      }),
    ).toBe(false);
  });

  it('PERSIST-150 outbox dispatch is claimed once and retried with a bounded budget', async () => {
    await outbox.enqueue(h.db, {
      id: 'obx_1',
      workspaceId: ws.workspaceId,
      eventType: 'run.created',
      entityId: 'run_1',
      uniqueEventKey: 'run.created:run_1',
      payloadJson: '{}',
      nextAttemptAt: T0,
      createdAt: T0,
    });
    // A duplicate enqueue is a no-op, which is what makes commit-then-dispatch safe.
    expect(
      await outbox.enqueue(h.db, {
        id: 'obx_2',
        workspaceId: ws.workspaceId,
        eventType: 'run.created',
        entityId: 'run_1',
        uniqueEventKey: 'run.created:run_1',
        payloadJson: '{}',
        nextAttemptAt: T0,
        createdAt: T0,
      }),
    ).toBe(false);
    expect(countRows(h, 'outbox')).toBe(1);

    const due = await outbox.listDue(h.db, NOW);
    expect(due.map((r) => r.id)).toEqual(['obx_1']);

    const claims = await Promise.all([
      outbox.tryClaim(h.db, { id: 'obx_1', expectedAttempts: 0, leaseUntil: LEASE_UNTIL }),
      outbox.tryClaim(h.db, { id: 'obx_1', expectedAttempts: 0, leaseUntil: LEASE_UNTIL }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    expect(
      await outbox.markFailed(h.db, {
        id: 'obx_1',
        error: 'connector unavailable',
        nextAttemptAt: '2026-09-19T10:10:00.000Z',
        maxAttempts: 5,
      }),
    ).toBe('pending');
    expect(
      await outbox.markFailed(h.db, {
        id: 'obx_1',
        error: 'connector unavailable',
        nextAttemptAt: '2026-09-19T10:20:00.000Z',
        maxAttempts: 1,
      }),
    ).toBe('dead');
    expect(await outbox.markDispatched(h.db, 'obx_1')).toBe(true);
  });
});
