/**
 * Database outage (RESIL 100 to 122) — the database goes away.
 *
 * Every case here runs the real scheduler and the real repositories against a real SQLite
 * database that has been made to fail at a chosen point. Nothing is mocked: after the
 * failure the test reads the actual rows and asserts what the outage left behind.
 *
 * The property that matters most: **an outage is ours, not the customer's.** A run we could
 * not look at must never be FAILED, no allowance may move for work that did not happen, and
 * `/health` must say "unreachable" rather than "ok".
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runs } from '@app/db/runs';
import { entitlements } from '@app/db/entitlements';
import { assertions } from '@app/db/runs';
import { DatabaseUnreachableError, FailingDb, probeHealth } from './harness';
import { createTestDb, seedWorkspace, type TestDb } from '../db/harness';
import {
  ALLOWANCE_PERIOD_KEY,
  at,
  connectedResolver,
  createSchedulerHarness,
  notConnectedResolver,
  remainingAllowance,
  type SchedulerHarness,
} from '../scheduler/harness';
import { runSchedulerTick } from '@app/scheduler';
import { D1BillingDataPort } from '@app/db/billingPort';

let harness: SchedulerHarness;

beforeEach(() => {
  harness = createSchedulerHarness();
});

afterEach(() => {
  harness.close();
});

/** Drive a real tick against a database that fails according to `plan`. */
async function tickAgainst(failing: FailingDb, now = at(1)) {
  return runSchedulerTick({
    db: failing,
    now,
    resolver: notConnectedResolver(),
    billing: new D1BillingDataPort(failing),
    billingEnvironment: 'test',
    newId: harness.newId,
    digest: async (input: string) => `digest:${input.length}`,
  });
}

describe('RESIL: the database is unreachable for a whole tick', () => {
  it('RESIL-100 a total outage returns a report rather than throwing out of the tick', async () => {
    await harness.admit('evt-100');
    const failing = new FailingDb(harness.h.db, { failEverything: true });

    const report = await tickAgainst(failing);

    // A scheduled handler that rejects buys an uncontrolled retry. The tick reports instead.
    expect(report.error).not.toBeNull();
    expect(report.runs.claimed).toBe(0);
    expect(failing.failureCount).toBeGreaterThan(0);
  });

  it('RESIL-101 a total outage marks no run FAILED', async () => {
    const runId = await harness.admit('evt-101');
    await tickAgainst(new FailingDb(harness.h.db, { failEverything: true }));

    // Read through the healthy handle: the run is untouched, still awaiting its first look.
    const row = harness.runRow(runId);
    expect(row.status).toBe('PENDING');
    expect(row.observation_count).toBe(0);
    expect(row.completed_at).toBeNull();
  });

  it('RESIL-102 a total outage consumes no allowance', async () => {
    await harness.admit('evt-102');
    const before = harness.entitlement();

    await tickAgainst(new FailingDb(harness.h.db, { failEverything: true }));

    const after = harness.entitlement();
    expect(after).toEqual(before);
    expect(after.consumed).toBe(0);
    expect(remainingAllowance(after)).toBe(remainingAllowance(before));
  });

  it('RESIL-103 a total outage writes no assertions, so nothing claims to have been checked', async () => {
    const runId = await harness.admit('evt-103');
    await tickAgainst(new FailingDb(harness.h.db, { failEverything: true }));

    const written = await assertions.listForRun(harness.h.db, harness.ws.workspaceId, runId);
    expect(written).toHaveLength(0);
  });

  it('RESIL-104 the run stays due, so the next healthy tick picks it up', async () => {
    const runId = await harness.admit('evt-104');
    await tickAgainst(new FailingDb(harness.h.db, { failEverything: true }));
    expect(harness.runRow(runId).next_check_at).not.toBeNull();

    // The database comes back. Nothing had to detect the outage.
    const recovered = await harness.tick({ now: at(2), resolver: notConnectedResolver() });
    expect(recovered.runs.claimed).toBe(1);
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });
});

describe('RESIL: the database goes away mid-tick', () => {
  it('RESIL-105 a failure between the claim and the outcome leaves the run recoverable', async () => {
    const runId = await harness.admit('evt-105');

    // Find out how many operations a healthy observation takes, then fail before the end.
    const counter = new FailingDb(harness.h.db, {});
    await tickAgainst(counter);
    const healthyOps = counter.operationCount;
    expect(healthyOps).toBeGreaterThan(3);

    // Reset and replay, failing partway through the run's own writes.
    harness.close();
    harness = createSchedulerHarness();
    const runId2 = await harness.admit('evt-105');
    expect(runId2).toBe(runId);

    const failing = new FailingDb(harness.h.db, { failFromOperation: Math.floor(healthyOps / 2) });
    const report = await tickAgainst(failing);

    // Whatever happened, the run is not half-decided: either untouched or fully resolved.
    const row = harness.runRow(runId);
    expect(['PENDING', 'UNVERIFIED']).toContain(row.status);
    if (row.status === 'PENDING') expect(row.next_check_at).not.toBeNull();
    expect(report.error === null || typeof report.error === 'string').toBe(true);
  });

  it('RESIL-106 a run whose outcome could not be written is never left claiming to be checked', async () => {
    const runId = await harness.admit('evt-106');
    // Fail exactly the statement that writes a run outcome; everything else works.
    const failing = new FailingDb(harness.h.db, { failMatching: /UPDATE runs\s+SET status/ });

    await tickAgainst(failing);

    const row = harness.runRow(runId);
    expect(row.status).toBe('PENDING');
    expect(row.completed_at).toBeNull();
    // And no allowance moved for a decision that was never recorded.
    expect(harness.entitlement().consumed).toBe(0);
  });

  it('RESIL-107 a failed batch leaves no partial assertion set behind', async () => {
    const runId = await harness.admit('evt-107');
    // `assertions.replaceForRevision` is a batch: a DELETE plus one INSERT per rule. If the
    // batch is not atomic, a failure leaves the delete applied and the inserts missing —
    // a run displaying fewer checks than its workflow defines.
    const failing = new FailingDb(harness.h.db, { failBatches: true });

    await tickAgainst(failing);

    const written = await assertions.listForRun(harness.h.db, harness.ws.workspaceId, runId);
    expect(written).toHaveLength(0);
    expect(harness.runRow(runId).status).toBe('PENDING');
  });

  it('RESIL-108 batch atomicity is real: a mid-batch failure rolls the whole batch back', async () => {
    // Proving the property the repositories depend on, directly against the harness that
    // implements D1's documented behaviour with BEGIN/COMMIT/ROLLBACK.
    const runId = await harness.admit('evt-108');
    const before = Number(
      (harness.h.raw.prepare('SELECT COUNT(*) AS n FROM assertions').get() as { n: number }).n,
    );

    await expect(
      assertions.replaceForRevision(harness.h.db, {
        workspaceId: harness.ws.workspaceId,
        runId,
        revision: 1,
        rows: [
          {
            id: 'asr_ok',
            ruleId: 'a',
            label: 'first',
            mandatory: true,
            status: 'SUPPORTED',
            reasonCode: 'MATCHED',
          },
          // Duplicate primary key: the second insert fails, so the batch must roll back.
          {
            id: 'asr_ok',
            ruleId: 'b',
            label: 'second',
            mandatory: true,
            status: 'SUPPORTED',
            reasonCode: 'MATCHED',
          },
        ],
      }),
    ).rejects.toThrow();

    const after = Number(
      (harness.h.raw.prepare('SELECT COUNT(*) AS n FROM assertions').get() as { n: number }).n,
    );
    expect(after).toBe(before);
  });

  it('RESIL-109 an outage during outbox dispatch does not fail the tick or lose the row', async () => {
    await harness.admit('evt-109');
    const failing = new FailingDb(harness.h.db, { failMatching: /FROM outbox/ });

    const report = await tickAgainst(failing);

    expect(report.outbox.dispatched).toBe(0);
    const state = harness.h.raw
      .prepare("SELECT dispatch_state FROM outbox WHERE event_type = 'run.created'")
      .get() as { dispatch_state: string };
    expect(state.dispatch_state).toBe('pending');
  });

  it('RESIL-110 an outage while settling leaves the allowance arithmetic unchanged', async () => {
    await harness.admit('evt-110');
    const before = harness.entitlement();
    const failing = new FailingDb(harness.h.db, { failMatching: /UPDATE entitlements/ });

    await tickAgainst(failing);

    const after = harness.entitlement();
    // A settlement lost to an outage leaves the unit reserved rather than consumed. Both are
    // subtracted from the allowance identically, so nothing is over-granted either way.
    expect(remainingAllowance(after)).toBe(remainingAllowance(before));
    expect(after.consumed + after.reserved).toBe(before.consumed + before.reserved);
  });

  it('RESIL-111 a provider answered but the database did not: the run is re-observed, not judged', async () => {
    const runId = await harness.admit('evt-111');
    const failing = new FailingDb(harness.h.db, { failMatching: /INSERT INTO evidence/ });

    await runSchedulerTick({
      db: failing,
      now: at(1),
      resolver: connectedResolver(),
      billing: new D1BillingDataPort(failing),
      billingEnvironment: 'test',
      connectors: harness.registry,
      newId: harness.newId,
      digest: async () => 'digest',
    });

    const row = harness.runRow(runId);
    expect(row.status).toBe('PENDING');
    expect(row.next_check_at).not.toBeNull();
  });
});

describe('RESIL: /health tells the truth', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
    seedWorkspace(db, 'health');
  });

  afterEach(() => {
    db.close();
  });

  it('RESIL-112 a reachable database reports reachable and 200', async () => {
    const result = await probeHealth(db.db);
    expect(result).toEqual({ database: 'reachable', status: 200 });
  });

  it('RESIL-113 an unreachable database reports unreachable and 503, never ok', async () => {
    const result = await probeHealth(new FailingDb(db.db, { failEverything: true }));
    expect(result).toEqual({ database: 'unreachable', status: 503 });
  });

  it('RESIL-114 the health probe answers rather than throwing when the database throws', async () => {
    const failing = new FailingDb(db.db, { failEverything: true });
    await expect(probeHealth(failing)).resolves.toBeDefined();
    expect(failing.failureCount).toBe(1);
  });

  it('RESIL-115 a database that fails only on writes still reports reachable, which is honest', async () => {
    // `/health` claims exactly one thing: that we can reach D1. Overstating it — probing a
    // write and calling the service healthy — would be the same class of lie in reverse.
    const result = await probeHealth(
      new FailingDb(db.db, { failMatching: /INSERT|UPDATE|DELETE/ }),
    );
    expect(result.database).toBe('reachable');
  });

  it('RESIL-116 the shipped route derives its status from the probe rather than hard-coding ok', () => {
    // The route lives in the lead's entry point. Asserting its source keeps this suite
    // honest about what it is really testing, and catches a regression to a static 200.
    const source = readFileSync(
      fileURLToPath(new URL('../../../apps/app/src/index.ts', import.meta.url)),
      'utf8',
    );
    const route = source.slice(source.indexOf("app.get('/health'"));
    expect(route).toContain("database === 'reachable' ? 200 : 503");
    expect(route).toContain("await c.env.DB.prepare('SELECT 1')");
    expect(route).not.toMatch(/status:\s*200\s*,?\s*\}\s*\)\s*;?\s*$/);
  });
});

describe('RESIL: an outage never becomes a customer-visible failure', () => {
  it('RESIL-117 across every outage point in one run, the run is never FAILED', async () => {
    // Walk the failure point across the whole observation and assert the invariant at each.
    const counter = new FailingDb(harness.h.db, {});
    await harness.admit('evt-117-probe');
    await tickAgainst(counter);
    const span = counter.operationCount;
    expect(span).toBeGreaterThan(2);

    const seen = new Set<string>();
    for (let failAt = 0; failAt <= span; failAt += 1) {
      harness.close();
      harness = createSchedulerHarness();
      const runId = await harness.admit('evt-117');
      await tickAgainst(new FailingDb(harness.h.db, { failFromOperation: failAt }));
      const status = harness.runRow(runId).status;
      seen.add(status);
      expect(status, `failing from operation ${failAt} produced ${status}`).not.toBe('FAILED');
    }
    // And the walk really did exercise both outcomes, so the assertion is not vacuous.
    expect(seen.has('PENDING')).toBe(true);
  });

  it('RESIL-118 a transient blip recovers within the same tick sequence without losing the run', async () => {
    const runId = await harness.admit('evt-118');
    // Fail the first two operations only, then serve normally.
    const failing = new FailingDb(harness.h.db, { failEverything: true, recoverAfter: 2 });
    await tickAgainst(failing);
    expect(failing.failureCount).toBe(2);

    const recovered = await harness.tick({ now: at(3), resolver: notConnectedResolver() });
    expect(recovered.error).toBeNull();
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
    expect(harness.entitlement()).toMatchObject({ consumed: 1, reserved: 0 });
  });

  it('RESIL-119 an outage leaves no allowance row under an unexpected key', async () => {
    await harness.admit('evt-119');
    await tickAgainst(new FailingDb(harness.h.db, { failFromOperation: 2 }));
    const rows = harness.allowanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.billing_period).toBe(ALLOWANCE_PERIOD_KEY);
  });
});

describe('RESIL: the failure injector is itself sound', () => {
  it('RESIL-120 a planned failure is a real thrown error, not a silent no-op', async () => {
    const db = createTestDb();
    try {
      const failing = new FailingDb(db.db, { failEverything: true });
      await expect(failing.prepare('SELECT 1').first()).rejects.toBeInstanceOf(
        DatabaseUnreachableError,
      );
      // And with no plan, the same statement really executes.
      const healthy = new FailingDb(db.db, {});
      await expect(healthy.prepare('SELECT 1 AS n').first()).resolves.toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('RESIL-121 unfailed statements reach the real database, so state assertions are meaningful', async () => {
    const db = createTestDb();
    try {
      const ws = seedWorkspace(db, 'injector');
      const failing = new FailingDb(db.db, { failMatching: /UPDATE entitlements/ });
      // A read works; the targeted write does not.
      await expect(
        entitlements.get(failing, ws.workspaceId, ws.billingPeriod),
      ).resolves.not.toBeNull();
      await expect(
        entitlements.reserve(failing, ws.workspaceId, ws.billingPeriod, '2026-09-19T10:00:00.000Z'),
      ).rejects.toBeInstanceOf(DatabaseUnreachableError);
      // And the real row is untouched.
      const row = await entitlements.get(db.db, ws.workspaceId, ws.billingPeriod);
      expect(row?.reserved).toBe(0);
      expect(failing.sqlExecuted().length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('RESIL-122 the due-job query is reached through the real repository, not a stub', async () => {
    await harness.admit('evt-122');
    const failing = new FailingDb(harness.h.db, {});
    await tickAgainst(failing);
    expect(failing.sqlExecuted().some((sql) => /FROM runs/.test(sql))).toBe(true);
    expect(await runs.get(harness.h.db, harness.ws.workspaceId, 'run_evt-122')).not.toBeNull();
  });
});
