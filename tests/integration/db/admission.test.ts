/**
 * Source event admission: one run, one allowance unit, one outbox row, no exceptions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { entitlements, runs, sourceEvents } from '@app/db';
import {
  countRows,
  createTestDb,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

const DEADLINE = '2026-09-19T10:10:00.000Z';

function admitParams(ws: SeededWorkspace, overrides: Record<string, unknown> = {}) {
  const suffix = (overrides['suffix'] as string) ?? '1';
  return {
    workspaceId: ws.workspaceId,
    billingPeriod: ws.billingPeriod,
    workflowId: ws.workflowId,
    workflowVersionId: ws.workflowVersionId,
    externalEventId: 'customer-event-0001',
    source: 'signed_customer_event' as const,
    sourceEventId: `sev_${suffix}`,
    runId: `run_${suffix}`,
    outboxId: `obx_${suffix}`,
    receivedAt: T0,
    occurredAt: T0,
    correlationKeyHash: 'corr-hash',
    payloadHash: 'payload-hash-a',
    payloadJson: '{"event_id":"customer-event-0001"}',
    deadlineAt: DEADLINE,
    nextCheckAt: '2026-09-19T10:01:00.000Z',
    ...overrides,
  };
}

describe('sourceEvents.admitOnce', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha', { runLimit: 2 });
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-100 admits a new event, creating the run, the outbox row and one reservation', async () => {
    const result = await sourceEvents.admitOnce(h.db, admitParams(ws));
    expect(result).toEqual({
      runId: 'run_1',
      sourceEventId: 'sev_1',
      status: 'PENDING',
      deadlineAt: DEADLINE,
      duplicate: false,
    });
    expect(countRows(h, 'source_events')).toBe(1);
    expect(countRows(h, 'runs')).toBe(1);
    expect(countRows(h, 'outbox')).toBe(1);
    const ent = await entitlements.get(h.db, ws.workspaceId, ws.billingPeriod);
    expect(ent?.reserved).toBe(1);
    expect(ent?.consumed).toBe(0);
  });

  it('PERSIST-101 a duplicate external id returns the original run and consumes nothing more', async () => {
    const first = await sourceEvents.admitOnce(h.db, admitParams(ws));
    const second = await sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: '2' }));

    expect(second.duplicate).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.deadlineAt).toBe(DEADLINE);
    expect(countRows(h, 'runs')).toBe(1);
    expect(countRows(h, 'source_events')).toBe(1);
    expect(countRows(h, 'outbox')).toBe(1);
    expect((await entitlements.get(h.db, ws.workspaceId, ws.billingPeriod))?.reserved).toBe(1);
  });

  it('PERSIST-102 ten identical retries still produce exactly one run and one reservation', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: `r${i}` }))),
    );
    const runIds = new Set(results.map((r) => r.runId));
    expect(runIds.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(countRows(h, 'runs')).toBe(1);
    expect((await entitlements.get(h.db, ws.workspaceId, ws.billingPeriod))?.reserved).toBe(1);
  });

  it('PERSIST-103 the same external id with a different body is a 409, and the original is untouched', async () => {
    await sourceEvents.admitOnce(h.db, admitParams(ws));
    const error = await sourceEvents
      .admitOnce(h.db, admitParams(ws, { suffix: '2', payloadHash: 'payload-hash-b' }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).httpStatus).toBe(409);
    expect((error as AppError).code).toBe('IDEMPOTENCY_CONFLICT');

    const stored = await sourceEvents.getByExternalId(h.db, ws.workspaceId, 'customer-event-0001');
    expect(stored?.payload_hash).toBe('payload-hash-a');
    expect(stored?.id).toBe('sev_1');
    expect(countRows(h, 'runs')).toBe(1);
    expect((await entitlements.get(h.db, ws.workspaceId, ws.billingPeriod))?.reserved).toBe(1);
  });

  it('PERSIST-104 refuses admission when the allowance is exhausted, writing nothing at all', async () => {
    await sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: 'a', externalEventId: 'e-a' }));
    await sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: 'b', externalEventId: 'e-b' }));

    const error = await sourceEvents
      .admitOnce(h.db, admitParams(ws, { suffix: 'c', externalEventId: 'e-c' }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).httpStatus).toBe(402);
    expect((error as AppError).code).toBe('ALLOWANCE_EXHAUSTED');

    // The whole batch rolled back: no orphan source event, run or outbox row.
    expect(countRows(h, 'source_events')).toBe(2);
    expect(countRows(h, 'runs')).toBe(2);
    expect(countRows(h, 'outbox')).toBe(2);
    expect((await entitlements.get(h.db, ws.workspaceId, ws.billingPeriod))?.reserved).toBe(2);
  });

  it('PERSIST-105 counts a settled consumption against the limit, not just reservations', async () => {
    await sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: 'a', externalEventId: 'e-a' }));
    await entitlements.settleReservation(h.db, ws.workspaceId, ws.billingPeriod, T0);
    const ent = await entitlements.get(h.db, ws.workspaceId, ws.billingPeriod);
    expect(ent).toMatchObject({ reserved: 0, consumed: 1 });

    await sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: 'b', externalEventId: 'e-b' }));
    await expect(
      sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: 'c', externalEventId: 'e-c' })),
    ).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
  });

  it('PERSIST-106 refuses admission when the workspace has no plan period', async () => {
    const error = await sourceEvents
      .admitOnce(h.db, admitParams(ws, { billingPeriod: '2027-01' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('ENTITLEMENT_MISSING');
    expect(countRows(h, 'source_events')).toBe(0);
    expect(countRows(h, 'runs')).toBe(0);
    expect(countRows(h, 'outbox')).toBe(0);
  });

  it('PERSIST-107 concurrent admissions against a single remaining unit admit exactly one', async () => {
    const tight = seedWorkspace(h, 'tight', { runLimit: 1 });
    const outcomes = await Promise.allSettled([
      sourceEvents.admitOnce(h.db, admitParams(tight, { suffix: 'x', externalEventId: 'e-x' })),
      sourceEvents.admitOnce(h.db, admitParams(tight, { suffix: 'y', externalEventId: 'e-y' })),
    ]);
    const admitted = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(countRows(h, 'runs', 'workspace_id = ?', tight.workspaceId)).toBe(1);
    expect((await entitlements.get(h.db, tight.workspaceId, tight.billingPeriod))?.reserved).toBe(1);
  });

  it('PERSIST-108 the outbox row is committed with the run and carries a stable dedupe key', async () => {
    await sourceEvents.admitOnce(h.db, admitParams(ws));
    const row = await h.db
      .prepare('SELECT unique_event_key, event_type, entity_id, dispatch_state, workspace_id FROM outbox')
      .first<{
        unique_event_key: string;
        event_type: string;
        entity_id: string;
        dispatch_state: string;
        workspace_id: string;
      }>();
    expect(row).toEqual({
      unique_event_key: 'run.created:run_1',
      event_type: 'run.created',
      entity_id: 'run_1',
      dispatch_state: 'pending',
      workspace_id: ws.workspaceId,
    });
  });

  it('PERSIST-109 the created run is PENDING, scheduled, and linked to its source event', async () => {
    await sourceEvents.admitOnce(h.db, admitParams(ws));
    const run = await runs.get(h.db, ws.workspaceId, 'run_1');
    expect(run).toMatchObject({
      status: 'PENDING',
      revision: 1,
      observation_count: 0,
      deadline_at: DEADLINE,
      next_check_at: '2026-09-19T10:01:00.000Z',
      source_event_id: 'sev_1',
      workflow_version_id: ws.workflowVersionId,
    });
    expect(await sourceEvents.getForRun(h.db, ws.workspaceId, 'run_1')).toMatchObject({
      external_event_id: 'customer-event-0001',
    });
  });

  it('PERSIST-110 two workspaces may use the same external event id independently', async () => {
    const other = seedWorkspace(h, 'beta', { runLimit: 2 });
    await sourceEvents.admitOnce(h.db, admitParams(ws, { suffix: 'a' }));
    const second = await sourceEvents.admitOnce(h.db, admitParams(other, { suffix: 'b' }));
    expect(second.duplicate).toBe(false);
    expect(countRows(h, 'runs')).toBe(2);
  });
});
