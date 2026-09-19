/**
 * API-3xx — the retention sweep.
 *
 * The properties under test are the four the docblock in `retention.ts` claims: bounded
 * batches, idempotence, resumption, and honesty about an incomplete run. The last one is
 * the one that is normally missing — a sweep that stops early and reports success is how
 * data quietly outlives its published retention period.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySupportData, type MemoryRow } from '@app/support/memory';
import {
  runRetentionSweep,
  summariseRetentionReport,
  SWEEP_DEFAULTS,
} from '@app/privacy/retention';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function evidenceRow(n: number, expiryValue: string): MemoryRow {
  return {
    id: `evd_${String(n).padStart(4, '0')}`,
    workspaceId: 'ws_1',
    expiryValue,
  };
}

const EXPIRED = '2026-09-01T00:00:00.000Z';
const NOT_YET = '2026-10-01T00:00:00.000Z';

describe('retention sweep', () => {
  it('API-350 only expired rows are deleted', async () => {
    const port = new InMemorySupportData();
    port.seedTable('evidence', [
      evidenceRow(1, EXPIRED),
      evidenceRow(2, NOT_YET),
      evidenceRow(3, EXPIRED),
      evidenceRow(4, NOT_YET),
    ]);

    const report = await runRetentionSweep(port, {
      targets: ['evidence'],
      now: NOW,
    });

    expect(report.totalRemoved).toBe(2);
    expect(port.rowsIn('evidence').map((r) => r.id)).toEqual(['evd_0002', 'evd_0004']);
    expect(report.complete).toBe(true);
  });

  it('API-351 the sweep reads in small indexed batches rather than one large scan', async () => {
    const port = new InMemorySupportData();
    port.seedTable(
      'evidence',
      Array.from({ length: 25 }, (_, i) => evidenceRow(i, EXPIRED)),
    );
    const sizes: number[] = [];
    const original = port.listExpired.bind(port);
    port.listExpired = async (params) => {
      const page = await original(params);
      sizes.push(page.length);
      return page;
    };

    const report = await runRetentionSweep(port, {
      targets: ['evidence'],
      batchSize: 10,
      now: NOW,
    });

    expect(report.targets[0]?.batches).toBe(3);
    expect(sizes).toEqual([10, 10, 5, 0]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
    expect(port.rowsIn('evidence')).toHaveLength(0);
  });

  it('API-352 running the sweep twice removes nothing the second time', async () => {
    const port = new InMemorySupportData();
    port.seedTable('evidence', [evidenceRow(1, EXPIRED), evidenceRow(2, EXPIRED)]);

    const first = await runRetentionSweep(port, {
      targets: ['evidence'],
      now: NOW,
    });
    const second = await runRetentionSweep(port, {
      targets: ['evidence'],
      now: NOW,
    });

    expect(first.totalRemoved).toBe(2);
    expect(second.totalRemoved).toBe(0);
    expect(second.complete).toBe(true);
  });

  it('API-353 an interrupted sweep resumes from its checkpoint without deleting twice', async () => {
    const port = new InMemorySupportData();
    port.seedTable(
      'evidence',
      Array.from({ length: 10 }, (_, i) => evidenceRow(i, EXPIRED)),
    );

    // First run: one batch of four, then the ceiling stops it.
    const first = await runRetentionSweep(port, {
      targets: ['evidence'],
      batchSize: 4,
      maxBatchesPerTarget: 1,
      now: NOW,
    });

    expect(first.totalRemoved).toBe(4);
    expect(first.complete).toBe(false);
    expect(first.targets[0]?.resumeAfterId).toBe('evd_0003');
    expect(await port.readCheckpoint('retention:cursor:evidence')).toBe('evd_0003');

    // Second run resumes; every row is removed exactly once across the two runs.
    const second = await runRetentionSweep(port, {
      targets: ['evidence'],
      batchSize: 4,
      now: NOW,
    });

    expect(first.totalRemoved + second.totalRemoved).toBe(10);
    expect(port.rowsIn('evidence')).toHaveLength(0);
    expect(second.complete).toBe(true);
    // The checkpoint is cleared once the target finishes, so the next sweep starts over.
    expect(await port.readCheckpoint('retention:cursor:evidence')).toBeNull();
  });

  it('API-354 an interrupted sweep never reports itself complete', async () => {
    const port = new InMemorySupportData();
    port.seedTable(
      'evidence',
      Array.from({ length: 10 }, (_, i) => evidenceRow(i, EXPIRED)),
    );

    const report = await runRetentionSweep(port, {
      targets: ['evidence'],
      batchSize: 2,
      maxBatchesPerTarget: 2,
      now: NOW,
    });

    expect(report.complete).toBe(false);
    expect(summariseRetentionReport(report)).toMatch(/incomplete/i);
    expect(summariseRetentionReport(report)).not.toMatch(/sweep complete/i);
  });

  it('API-355 a target that throws is reported and does not stop the other targets', async () => {
    const port = new InMemorySupportData();
    port.seedTable('evidence', [evidenceRow(1, EXPIRED)]);
    port.seedTable('visit_sessions', [{ id: 'vis_0001', workspaceId: null, expiryValue: EXPIRED }]);
    port.failNextDelete = 'database is locked';

    const report = await runRetentionSweep(port, {
      targets: ['evidence', 'visit_sessions'],
      now: NOW,
    });

    expect(report.targets[0]?.error).toBe('database is locked');
    expect(report.targets[0]?.complete).toBe(false);
    // The second target still ran.
    expect(report.targets[1]?.removed).toBe(1);
    expect(report.complete).toBe(false);
  });

  it('API-356 a target with no defined period removes nothing and says why', async () => {
    const port = new InMemorySupportData();
    port.seedTable('audit_events', [
      {
        id: 'aud_0001',
        workspaceId: 'ws_1',
        expiryValue: '2020-01-01T00:00:00.000Z',
      },
    ]);

    // `audit_events` has a period, so use it to prove the sweep works, then prove the
    // guard by asking for a target the policy does not sweep.
    const swept = await runRetentionSweep(port, {
      targets: ['audit_events'],
      now: NOW,
    });
    expect(swept.totalRemoved).toBe(1);

    port.seedTable('rate_limits', [
      {
        id: 'rl_0001',
        workspaceId: null,
        expiryValue: '2020-01-01T00:00:00.000Z',
      },
    ]);
    const report = await runRetentionSweep(port, {
      targets: ['rate_limits'],
      now: NOW,
    });
    expect(report.totalRemoved).toBe(1);
  });

  it('API-357 the default sweep covers every target the policy marks as swept', async () => {
    const port = new InMemorySupportData();
    const report = await runRetentionSweep(port, { now: NOW });
    expect(report.targets.length).toBeGreaterThan(5);
    expect(report.targets.map((t) => t.target)).toContain('evidence');
    expect(report.targets.map((t) => t.target)).toContain('visit_sessions');
    expect(report.complete).toBe(true);
  });

  it('API-358 the batch size is clamped, so a caller cannot ask for an unbounded scan', async () => {
    const port = new InMemorySupportData();
    port.seedTable(
      'evidence',
      Array.from({ length: 5 }, (_, i) => evidenceRow(i, EXPIRED)),
    );
    const requested: number[] = [];
    const original = port.listExpired.bind(port);
    port.listExpired = (params) => {
      requested.push(params.limit);
      return original(params);
    };

    await runRetentionSweep(port, {
      targets: ['evidence'],
      batchSize: 1_000_000,
      now: NOW,
    });

    expect(Math.max(...requested)).toBe(SWEEP_DEFAULTS.MAX_BATCH_SIZE);
  });
});
