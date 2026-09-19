/**
 * The shipped configuration: assistant `off`, no model key, no runner.
 *
 * This is the case the whole design is for. If anything in this file fails, the product
 * has become dependent on an optional convenience, which is the one outcome the brief
 * forbids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ask,
  loadAssistantConfig,
  publicAssistantConfig,
  type AssistantActor,
  type AssistantDataPort,
} from '@app/assistant/index';
import { D1AssistantDataPort } from '@app/assistant/port';
import {
  completePairing,
  enqueueJob,
  leaseOneJob,
  openPairing,
  recordJobResult,
  runnerStatus,
} from '@app/maintenance/index';
import { entitlements, runs, settings } from '@app/db/index';
import { createTestDb, seedRun, seedWorkspace, type TestDb } from '../db/harness';

const NOW = '2026-09-19T12:00:00.000Z';
const OWNER: AssistantActor = { userId: 'usr_owner', workspaceId: 'ws_x', isPlatformOwner: true };

/** Any call to this fails the test. Nothing in `off` mode may touch the network. */
const forbiddenFetch = (async () => {
  throw new Error('a network call was made with the assistant switched off');
}) as unknown as typeof fetch;

describe('assistant off by default', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
    h.raw
      .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
      .run('usr_owner', 'owner@example.com', NOW);
  });
  afterEach(() => {
    h.close();
  });

  it('BUDGET-057 with no assistant configured and no key, the whole owner-facing surface still works', async () => {
    // Nothing has been written to `settings`. This is a fresh installation.
    expect(await settings.get(h.db, 'assistant.config')).toBeNull();
    const config = await loadAssistantConfig(h.db);
    expect(config.mode).toBe('off');
    expect(publicAssistantConfig(config, false)).toEqual({
      mode: 'off',
      model_id: null,
      provider: null,
      api_key_present: false,
      per_request_cap_minor: 0,
      cumulative_cap_minor: 0,
    });

    // The assistant itself declines, honestly and without reaching anything.
    const port: AssistantDataPort = new D1AssistantDataPort(h.db);
    const answer = await ask(
      {
        db: h.db,
        port,
        fetchImpl: forbiddenFetch,
        apiKey: null,
        now: () => NOW,
        requestId: 'req_off',
      },
      OWNER,
      'anything at all',
    );
    expect(answer.available).toBe(false);
    if (answer.available) throw new Error('unreachable');
    expect(answer.reason).toBe('ASSISTANT_OFF');

    // Customer verification: unaffected.
    const ws = seedWorkspace(h, 'x');
    seedRun(h, ws, 'run_offmode0000000000000000');
    expect((await runs.get(h.db, ws.workspaceId, 'run_offmode0000000000000000'))?.status).toBe(
      'PENDING',
    );
    expect(await entitlements.reserve(h.db, ws.workspaceId, ws.billingPeriod, NOW)).toBe(true);
    expect(await runs.countByStatus(h.db, ws.workspaceId, '2026-09-01T00:00:00.000Z')).toEqual({
      PENDING: 1,
    });

    // The owner's read port works with no model anywhere in sight.
    const summary = await port.summary(ws.workspaceId, 7, NOW);
    expect(summary.total_runs).toBe(1);
    expect(await port.incidents(ws.workspaceId, 5)).toEqual([]);

    // The maintenance connector works end to end without the assistant: queue, pair,
    // lease, result, status. Not one of these steps consults a model.
    const queued = await enqueueJob({
      db: h.db,
      kind: 'run_test_suite',
      payload: { suite: 'unit' },
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(queued.ok).toBe(true);

    const invitation = await openPairing(h.db, {
      deviceId: 'dev_off',
      ownerId: 'usr_owner',
      label: 'laptop',
      now: NOW,
    });
    const paired = await completePairing(h.db, {
      code: invitation.code,
      publicKey: Buffer.alloc(32, 3).toString('base64'),
      now: NOW,
    });
    expect(paired.ok).toBe(true);

    const lease = await leaseOneJob({ db: h.db, deviceId: 'dev_off', now: NOW });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('unreachable');
    expect(
      await recordJobResult({
        db: h.db,
        jobId: lease.job.job_id,
        deviceId: 'dev_off',
        nonce: lease.job.lease_nonce,
        body: { outcome: 'passed', summary: '112 tests passed' },
        now: NOW,
      }),
    ).toEqual({ ok: true, state: 'passed', duplicate: false });

    const status = await runnerStatus(h.db, NOW);
    expect(status.availability.online).toBe(true);
    expect(status.last_successful_job?.typed_kind).toBe('run_test_suite');
    expect(status.hosted_service_unaffected).toBe(true);

    // And the audit trail recorded all of it without a single assistant event.
    const actions = (
      h.raw.prepare('SELECT action FROM audit_events').all() as { action: string }[]
    ).map((row) => row.action);
    expect(actions).toContain('maintenance.job.enqueued');
    expect(actions.some((action) => action.startsWith('assistant.'))).toBe(false);
  });
});
