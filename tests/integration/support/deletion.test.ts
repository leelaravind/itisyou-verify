/**
 * API-3xx — workspace deletion.
 *
 * Leaving has to work as well as joining. The assertions that matter: access is cut
 * before data is removed, an interrupted deletion resumes without deleting twice, and a
 * partial deletion never claims to have finished.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { InMemorySupportData, type MemoryRow } from '@app/support/memory';
import {
  BACKUP_STATEMENT,
  DELETION_GRACE_DAYS,
  DELETION_STEP,
  deleteWorkspace,
  deletionStatement,
  scheduleWorkspaceDeletion,
} from '@app/privacy/deletion';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function rows(prefix: string, count: number, workspaceId: string): MemoryRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${String(i).padStart(4, '0')}`,
    workspaceId,
    expiryValue: '2026-12-01T00:00:00.000Z',
  }));
}

function seeded(): InMemorySupportData {
  const port = new InMemorySupportData();
  port.seedWorkspace({
    id: 'ws_1',
    name: 'Acme',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  port.seedTable('evidence', [...rows('evd', 5, 'ws_1'), ...rows('evdx', 2, 'ws_2')]);
  port.seedTable('source_events', rows('sev', 4, 'ws_1'));
  port.seedTable('workflows', rows('wf', 1, 'ws_1'));
  port.seedTable('connections', [...rows('conn', 2, 'ws_1'), ...rows('connx', 1, 'ws_2')]);
  port.seedTable('support_cases', rows('sup', 2, 'ws_1'));
  port.seedTable('notification_deliveries', rows('ntf', 3, 'ws_1'));
  port.seedTable('memberships', rows('mem', 2, 'ws_1'));
  port.retained = { billingRecords: 2, auditEvents: 7 };
  return port;
}

describe('workspace deletion', () => {
  it('API-360 a deletion is scheduled with a grace period and removes nothing yet', () => {
    const port = seeded();
    const schedule = scheduleWorkspaceDeletion({
      workspaceId: 'ws_1',
      now: NOW,
    });

    expect(schedule.deletionAt).toBe('2026-09-26T12:00:00.000Z');
    expect(DELETION_GRACE_DAYS).toBe(7);
    expect(schedule.statement).toMatch(/nothing has been removed yet/i);
    expect(schedule.statement).toMatch(/without having to speak to anyone|speak to anyone/i);
    expect(port.rowsIn('evidence')).toHaveLength(7);
  });

  it('API-361 access is revoked and scheduled work stopped before any data is removed', async () => {
    const port = seeded();
    const order: string[] = [];
    const originalPurge = port.purgeWorkspaceRows.bind(port);
    port.revokeSessions = () => {
      order.push('revoke_sessions');
      return Promise.resolve(1);
    };
    port.revokeCredentials = () => {
      order.push('revoke_credentials');
      return Promise.resolve(1);
    };
    port.stopScheduledWork = () => {
      order.push('stop_scheduled_work');
      return Promise.resolve(1);
    };
    port.purgeWorkspaceRows = (workspaceId, target, limit) => {
      order.push(`purge:${target}`);
      return originalPurge(workspaceId, target, limit);
    };

    await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(order[0]).toBe('revoke_sessions');
    expect(order[1]).toBe('revoke_credentials');
    expect(order[2]).toBe('stop_scheduled_work');
    expect(order.findIndex((o) => o.startsWith('purge:'))).toBeGreaterThan(2);
  });

  it('API-362 deletion removes this workspace’s data and leaves another workspace alone', async () => {
    const port = seeded();

    const report = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(report.complete).toBe(true);
    expect(port.rowsIn('source_events')).toHaveLength(0);
    expect(port.rowsIn('support_cases')).toHaveLength(0);
    expect(port.rowsIn('notification_deliveries')).toHaveLength(0);
    // The workflow configuration the `deletion_scheduled` email promises to remove.
    expect(port.rowsIn('workflows')).toHaveLength(0);
    // Connections go, taking `credential_versions` with them by cascade.
    expect(port.rowsIn('connections').map((r) => r.workspaceId)).toEqual(['ws_2']);
    // Nobody is still a member of a deleted workspace.
    expect(port.rowsIn('memberships')).toHaveLength(0);
    // ws_2's evidence is untouched.
    expect(port.rowsIn('evidence').map((r) => r.workspaceId)).toEqual(['ws_2', 'ws_2']);
    expect(port.effects.expiredReportLinks).toBe(1);
    expect(port.workspaces.get('ws_1')?.status).toBe('deleted');
  });

  it('API-370 the runs are gone before the workflow versions they point at', () => {
    // `runs.workflow_version_id` has no cascade, so purging `workflows` before
    // `source_events` would fail on a constraint halfway through a deletion.
    const steps = [...DELETION_STEP];
    expect(steps.indexOf('purge_source_events')).toBeLessThan(steps.indexOf('purge_workflows'));
    expect(steps.indexOf('purge_workflows')).toBeLessThan(steps.indexOf('mark_workspace_deleted'));
  });

  it('API-371 every claim the deletion statement makes is one a step actually performs', async () => {
    const port = seeded();
    const report = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(report.statement).toMatch(/workflow configuration and rules/i);
    expect(port.rowsIn('workflows')).toHaveLength(0);
    expect(report.statement).toMatch(
      /provider connections and the credentials you gave us are deleted/i,
    );
    expect(port.rowsIn('connections').every((r) => r.workspaceId !== 'ws_1')).toBe(true);
    expect(port.effects.revokedCredentials).toBe(1);
    expect(report.statement).toMatch(/everyone's membership of it/i);
    expect(port.rowsIn('memberships')).toHaveLength(0);
    // And the one thing deletion does NOT do is stated rather than glossed over.
    expect(report.statement).toMatch(/sign-in identity .* is a separate record/i);
  });

  it('API-363 an interrupted deletion resumes without double-deleting and without claiming success', async () => {
    const port = seeded();
    // One batch of two rows per purge step, then the ceiling stops it.
    const first = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
      batchSize: 2,
      maxBatches: 1,
    });

    expect(first.complete).toBe(false);
    expect(first.completedAt).toBeNull();
    expect(first.statement).toMatch(/not finished/i);
    const evidenceStep = first.steps.find((s) => s.step === 'purge_evidence');
    expect(evidenceStep?.status).toBe('incomplete');
    expect(evidenceStep?.affected).toBe(2);
    expect(port.rowsIn('evidence').filter((r) => r.workspaceId === 'ws_1')).toHaveLength(3);

    const second = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
      batchSize: 2,
    });

    expect(second.complete).toBe(true);
    expect(port.rowsIn('evidence').filter((r) => r.workspaceId === 'ws_1')).toHaveLength(0);
    // The already-finished steps were not repeated.
    expect(second.steps.filter((s) => s.status === 'already_done').map((s) => s.step)).toContain(
      'revoke_sessions',
    );
    expect(port.effects.revokedSessions).toBe(1);
  });

  it('API-364 running deletion twice is safe and does nothing the second time', async () => {
    const port = seeded();

    const first = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });
    const second = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.steps.every((s) => s.status === 'already_done')).toBe(true);
    expect(port.effects.revokedCredentials).toBe(1);
    expect(port.effects.markedDeleted).toBe(1);
  });

  it('API-365 the statement names what remains and exactly why', async () => {
    const port = seeded();
    const report = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(report.statement).toContain('Acme');
    expect(report.statement).toMatch(/2 billing records/);
    expect(report.statement).toMatch(/business and tax records have to be kept/i);
    expect(report.statement).toMatch(/7 audit records/);
    expect(report.statement).toMatch(/never a card number/i);
    expect(report.statement).toMatch(/nothing else is kept/i);
  });

  it('API-366 the statement is honest about backups rather than claiming instant erasure', async () => {
    const port = seeded();
    const report = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(report.backupStatement).toBe(BACKUP_STATEMENT);
    expect(report.backupStatement).toMatch(/still contains the data until that backup expires/i);
    expect(deletionStatement(report)).toContain(BACKUP_STATEMENT);
    // And nowhere does it claim the data is gone everywhere, immediately.
    expect(deletionStatement(report)).not.toMatch(/permanently erased everywhere/i);
    expect(deletionStatement(report)).not.toMatch(/immediately and irreversibly deleted/i);
  });

  it('API-367 deleting a workspace that does not exist is a typed 404, not a silent success', async () => {
    const port = new InMemorySupportData();
    const error = await deleteWorkspace(port, {
      workspaceId: 'ws_missing',
      requestedBy: 'usr_1',
      now: NOW,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).httpStatus).toBe(404);
  });

  it('API-368 a failing step is reported and the deletion is not marked complete', async () => {
    const port = seeded();
    port.failNextDelete = 'database is locked';

    const report = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    const failed = report.steps.filter((s) => s.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toBe('database is locked');
    expect(report.complete).toBe(false);
    expect(report.completedAt).toBeNull();
  });

  it('API-369 every declared step is attempted, in the declared order', async () => {
    const port = seeded();
    const report = await deleteWorkspace(port, {
      workspaceId: 'ws_1',
      requestedBy: 'usr_1',
      now: NOW,
    });

    expect(report.steps.map((s) => s.step)).toEqual([...DELETION_STEP]);
    // Evidence expiry is brought forward before the purge, so an interrupted deletion is
    // still finished off by the ordinary retention sweep.
    expect(report.steps.findIndex((s) => s.step === 'schedule_evidence_removal')).toBeLessThan(
      report.steps.findIndex((s) => s.step === 'purge_evidence'),
    );
  });
});
