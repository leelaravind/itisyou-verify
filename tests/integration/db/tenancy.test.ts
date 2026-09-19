/**
 * Tenant isolation.
 *
 * Two workspaces are seeded with structurally identical data. Every case below asks
 * workspace B's caller for workspace A's row and requires nothing back — and, for the
 * mutations, requires that A's row is still exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertions,
  connections,
  credentials,
  connectionScope,
  entitlements,
  evidence,
  memberships,
  runAttempts,
  runs,
  sourceEvents,
  workflows,
  workflowVersions,
} from '@app/db';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

describe('tenant isolation', () => {
  let h: TestDb;
  let a: SeededWorkspace;
  let b: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    a = seedWorkspace(h, 'alpha');
    b = seedWorkspace(h, 'beta');
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-200 a run is invisible to another workspace', async () => {
    seedRun(h, a, 'run_alpha_1');
    expect(await runs.get(h.db, a.workspaceId, 'run_alpha_1')).not.toBeNull();
    expect(await runs.get(h.db, b.workspaceId, 'run_alpha_1')).toBeNull();
  });

  it('AUTH-201 a run listing never crosses the tenant boundary', async () => {
    seedRun(h, a, 'run_alpha_1');
    seedRun(h, a, 'run_alpha_2');
    seedRun(h, b, 'run_beta_1');
    const forB = await runs.listByWorkspace(h.db, b.workspaceId, { limit: 50 });
    expect(forB.items.map((r) => r.id)).toEqual(['run_beta_1']);
  });

  it('AUTH-202 a run cannot be mutated with the wrong workspace id', async () => {
    seedRun(h, a, 'run_alpha_1');
    const wrong = await runs.applyOutcome(h.db, {
      workspaceId: b.workspaceId,
      runId: 'run_alpha_1',
      expectedRevision: 1,
      status: 'VERIFIED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: T0,
    });
    expect(wrong).toBe(false);
    const untouched = await runs.get(h.db, a.workspaceId, 'run_alpha_1');
    expect(untouched?.status).toBe('PENDING');
    expect(untouched?.revision).toBe(1);
  });

  it('AUTH-203 assertions cannot be written against another workspace’s run', async () => {
    seedRun(h, a, 'run_alpha_1');
    const written = await assertions.replaceForRevision(h.db, {
      workspaceId: b.workspaceId,
      runId: 'run_alpha_1',
      revision: 1,
      rows: [
        {
          id: 'asr_x',
          ruleId: 'crm_exists',
          label: 'CRM record exists',
          mandatory: true,
          status: 'SUPPORTED',
          reasonCode: 'MATCHED',
        },
      ],
    });
    expect(written).toBe(0);
    expect(countRows(h, 'assertions')).toBe(0);
  });

  it('AUTH-204 assertions are only readable through their own workspace', async () => {
    seedRun(h, a, 'run_alpha_1');
    await assertions.replaceForRevision(h.db, {
      workspaceId: a.workspaceId,
      runId: 'run_alpha_1',
      revision: 1,
      rows: [
        {
          id: 'asr_a',
          ruleId: 'crm_exists',
          label: 'CRM record exists',
          mandatory: true,
          status: 'SUPPORTED',
          reasonCode: 'MATCHED',
        },
      ],
    });
    expect(await assertions.listForRun(h.db, a.workspaceId, 'run_alpha_1')).toHaveLength(1);
    expect(await assertions.listForRun(h.db, b.workspaceId, 'run_alpha_1')).toHaveLength(0);
  });

  it('AUTH-205 evidence cannot be written to or read from another workspace', async () => {
    seedRun(h, a, 'run_alpha_1');
    const input = {
      id: 'evd_1',
      provider: 'hubspot',
      origin: 'provider_readback' as const,
      observedAt: T0,
      contentDigest: 'digest',
      redactedSummary: '{"email":"a**@example.com"}',
      expiresAt: '2026-10-19T10:00:00.000Z',
    };
    expect(
      await evidence.recordMany(h.db, { workspaceId: b.workspaceId, runId: 'run_alpha_1', rows: [input] }),
    ).toBe(0);
    expect(countRows(h, 'evidence')).toBe(0);

    await evidence.recordMany(h.db, { workspaceId: a.workspaceId, runId: 'run_alpha_1', rows: [input] });
    expect(await evidence.listForRun(h.db, a.workspaceId, 'run_alpha_1')).toHaveLength(1);
    expect(await evidence.listForRun(h.db, b.workspaceId, 'run_alpha_1')).toHaveLength(0);
    expect(await evidence.getById(h.db, b.workspaceId, 'evd_1')).toBeNull();
  });

  it('AUTH-206 a connection is invisible and unmutable across workspaces', async () => {
    await connections.upsert(h.db, {
      id: 'conn_a',
      workspaceId: a.workspaceId,
      provider: 'hubspot',
      status: 'ready',
      createdAt: T0,
    });
    expect(await connections.getById(h.db, b.workspaceId, 'conn_a')).toBeNull();
    expect(await connections.getByProvider(h.db, b.workspaceId, 'hubspot')).toBeNull();
    expect(await connections.list(h.db, b.workspaceId)).toHaveLength(0);
    expect(
      await connections.setStatus(h.db, b.workspaceId, 'conn_a', { status: 'revoked' }),
    ).toBe(false);
    expect((await connections.getById(h.db, a.workspaceId, 'conn_a'))?.status).toBe('ready');
    expect(await connections.revoke(h.db, b.workspaceId, 'conn_a', T0)).toBe(false);
    expect((await connections.getById(h.db, a.workspaceId, 'conn_a'))?.revoked_at).toBeNull();
  });

  it('AUTH-207 a sealed credential cannot be read through another workspace', async () => {
    await connections.upsert(h.db, {
      id: 'conn_a',
      workspaceId: a.workspaceId,
      provider: 'hubspot',
      status: 'ready',
      createdAt: T0,
    });
    await credentials.store(h.db, {
      id: 'cred_a',
      ownerScope: connectionScope('conn_a'),
      connectionId: 'conn_a',
      keyVersion: 1,
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2Vub25jZQ==',
      aad: 'v1|ws=ws_alpha|provider=hubspot|purpose=api_token',
      createdAt: T0,
    });
    expect(await credentials.activeForConnection(h.db, a.workspaceId, 'conn_a')).not.toBeNull();
    expect(await credentials.activeForConnection(h.db, b.workspaceId, 'conn_a')).toBeNull();
  });

  it('AUTH-208 a workflow and its versions are scoped', async () => {
    expect(await workflows.get(h.db, b.workspaceId, a.workflowId)).toBeNull();
    expect(await workflows.getActiveWithVersion(h.db, b.workspaceId, a.workflowId)).toBeNull();
    expect(await workflowVersions.get(h.db, b.workspaceId, a.workflowVersionId)).toBeNull();
    expect(
      await workflowVersions.getForWorkflow(h.db, b.workspaceId, a.workflowId, a.workflowVersionId),
    ).toBeNull();
    expect(await workflows.setStatus(h.db, b.workspaceId, a.workflowId, 'paused')).toBe(false);
    expect((await workflows.get(h.db, a.workspaceId, a.workflowId))?.status).toBe('active');
  });

  it('AUTH-209 a version belonging to another workflow in the same tenant is still rejected', async () => {
    // Same tenant is not enough: the composite lookup must also prove the parent.
    await workflows.create(h.db, {
      id: 'wf_alpha_other',
      workspaceId: a.workspaceId,
      name: 'Other',
      coverageMode: 'customer_triggered',
      createdAt: T0,
    });
    await workflowVersions.publish(h.db, {
      id: 'wfv_alpha_other',
      workspaceId: a.workspaceId,
      workflowId: 'wf_alpha_other',
      rulesJson: '{}',
      rulesHash: 'hash',
      deadlineSeconds: 600,
      schemaVersion: 1,
      createdBy: a.userId,
      createdAt: T0,
    });
    expect(
      await workflowVersions.getForWorkflow(h.db, a.workspaceId, a.workflowId, 'wfv_alpha_other'),
    ).toBeNull();
    expect(
      await workflowVersions.getForWorkflow(h.db, a.workspaceId, 'wf_alpha_other', 'wfv_alpha_other'),
    ).not.toBeNull();
  });

  it('AUTH-210 entitlements are per workspace and per period', async () => {
    expect(await entitlements.get(h.db, b.workspaceId, a.billingPeriod)).not.toBeNull();
    await entitlements.settleReservation(h.db, a.workspaceId, a.billingPeriod, T0);
    // A has no reservation to settle, so nothing moved anywhere.
    expect((await entitlements.get(h.db, a.workspaceId, a.billingPeriod))?.consumed).toBe(0);
    expect((await entitlements.get(h.db, b.workspaceId, b.billingPeriod))?.consumed).toBe(0);
    expect(await entitlements.remaining(h.db, a.workspaceId, '1999-01')).toBeNull();
  });

  it('AUTH-211 a source event is only reachable through its own workspace', async () => {
    seedRun(h, a, 'run_alpha_1');
    expect(await sourceEvents.getByExternalId(h.db, a.workspaceId, 'ext_run_alpha_1')).not.toBeNull();
    expect(await sourceEvents.getByExternalId(h.db, b.workspaceId, 'ext_run_alpha_1')).toBeNull();
    expect(await sourceEvents.getForRun(h.db, b.workspaceId, 'run_alpha_1')).toBeNull();
    expect(await sourceEvents.getById(h.db, b.workspaceId, 'sev_run_alpha_1')).toBeNull();
  });

  it('AUTH-212 membership is the only authority on access, and it does not leak', async () => {
    expect(await memberships.roleFor(h.db, a.workspaceId, a.userId)).toBe('workspace_admin');
    expect(await memberships.roleFor(h.db, a.workspaceId, b.userId)).toBeNull();
    // A workspace that does not exist is indistinguishable from one you cannot see.
    expect(await memberships.roleFor(h.db, 'ws_does_not_exist', a.userId)).toBeNull();
  });

  it('AUTH-213 a run attempt cannot be opened or closed across workspaces', async () => {
    seedRun(h, a, 'run_alpha_1');
    expect(
      await runAttempts.start(h.db, {
        id: 'att_x',
        workspaceId: b.workspaceId,
        runId: 'run_alpha_1',
        leaseId: 'lse_1',
        leaseExpiresAt: T0,
        startedAt: T0,
      }),
    ).toBe(false);
    expect(countRows(h, 'run_attempts')).toBe(0);
  });
});
