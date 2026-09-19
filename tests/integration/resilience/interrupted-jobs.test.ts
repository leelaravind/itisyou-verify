/**
 * RESIL-123..139 — work that stops halfway.
 *
 * A Worker invocation is killed wherever it happens to be. These cases construct the exact
 * database state each kill point leaves and prove the next tick repairs it — no job stuck
 * forever, no allowance stranded, no decision made twice, nothing announced that did not
 * happen.
 *
 * Distinct from the scheduler's own `PERSIST` cases: those assert the scheduler behaves as
 * designed. These assert the *service survives* being interrupted, which is a different
 * requirement with a different failure mode.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runs } from '@app/db/runs';
import { outbox } from '@app/db/webhooks';
import { TICK_DEFAULTS, type OutboxHandler, type RetentionSweeper } from '@app/scheduler';
import { FailingDb } from './harness';
import {
  at,
  createSchedulerHarness,
  iso,
  notConnectedResolver,
  remainingAllowance,
  type SchedulerHarness,
} from '../scheduler/harness';

let harness: SchedulerHarness;

beforeEach(() => {
  harness = createSchedulerHarness();
});

afterEach(() => {
  harness.close();
});

describe('RESIL: a tick killed mid-outbox', () => {
  it('RESIL-123 rows not yet reached stay pending and due', async () => {
    for (let i = 0; i < 4; i += 1) await harness.admit(`evt-123-${i}`);

    // A handler that dies partway through the batch, exactly as a killed Worker would.
    let handled = 0;
    const handlers = new Map<string, OutboxHandler>([
      [
        'run.created',
        {
          async handle() {
            handled += 1;
            if (handled > 2) throw new Error('worker killed');
            return true;
          },
        },
      ],
    ]);

    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver(), handlers });
    expect(report.outbox.dispatched).toBe(2);

    const states = harness.h.raw
      .prepare("SELECT dispatch_state, COUNT(*) AS n FROM outbox WHERE event_type = 'run.created' GROUP BY dispatch_state")
      .all() as { dispatch_state: string; n: number }[];
    const byState = Object.fromEntries(states.map((s) => [s.dispatch_state, Number(s.n)]));
    expect(byState.dispatched).toBe(2);
    expect(byState.pending).toBe(2);
  });

  it('RESIL-124 a row whose handler succeeded but whose record failed is redelivered, not lost', async () => {
    await harness.admit('evt-124');
    const delivered: string[] = [];
    const handlers = new Map<string, OutboxHandler>([
      [
        'run.created',
        {
          async handle(event) {
            delivered.push(event.uniqueEventKey);
            return true;
          },
        },
      ],
    ]);
    // The handler works; recording the dispatch does not. At-least-once is the guarantee,
    // and this is the case that makes idempotent handlers non-negotiable.
    const failing = new FailingDb(harness.h.db, { failMatching: /SET dispatch_state = 'dispatched'/ });
    const { runSchedulerTick } = await import('@app/scheduler');
    const { D1BillingDataPort } = await import('@app/db/billingPort');
    await runSchedulerTick({
      db: failing,
      now: at(1),
      resolver: notConnectedResolver(),
      billing: new D1BillingDataPort(failing),
      billingEnvironment: 'test',
      handlers,
      newId: harness.newId,
      digest: async () => 'digest',
    });

    expect(delivered.length).toBe(1);
    const row = harness.h.raw
      .prepare("SELECT dispatch_state FROM outbox WHERE event_type = 'run.created'")
      .get() as { dispatch_state: string };
    expect(row.dispatch_state).toBe('pending');

    // It is redelivered once the claim's lease has expired — the same mechanism that stops
    // a dispatcher which died holding a row from blocking it forever.
    await harness.tick({ now: at(TICK_DEFAULTS.LEASE_SECONDS + 80), resolver: notConnectedResolver(), handlers });
    expect(delivered.length).toBe(2);
  });

  it('RESIL-125 a dispatcher that died holding a row does not block it forever', async () => {
    await harness.admit('evt-125');
    const due = await outbox.listDue(harness.h.db, iso(1), 10);
    const row = due[0]!;

    // The claim is taken; the worker then dies without marking anything.
    const won = await outbox.tryClaim(harness.h.db, {
      id: row.id,
      expectedAttempts: row.attempts,
      leaseUntil: iso(1 + TICK_DEFAULTS.LEASE_SECONDS),
    });
    expect(won).toBe(true);

    // Inside the lease nobody else sees it.
    expect(await outbox.listDue(harness.h.db, iso(30), 10)).toHaveLength(0);
    // After the lease it is due again, and its attempt count records the lost try.
    const afterLease = await outbox.listDue(harness.h.db, iso(TICK_DEFAULTS.LEASE_SECONDS + 5), 10);
    expect(afterLease).toHaveLength(1);
    expect(afterLease[0]!.attempts).toBe(1);
  });

  it('RESIL-126 an interrupted dispatch never announces something that did not happen', async () => {
    // A run whose first check is still in the future: the tick runs, the dispatcher runs,
    // and no decision exists to announce. An announcement here would be an outcome the
    // service invented.
    const runId = await harness.admit('evt-126', { nextCheckAtSeconds: 300 });

    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver() });

    expect(report.runs.claimed).toBe(0);
    const decided = harness.h.raw
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'run.decided' AND entity_id = ?")
      .get(runId) as { n: number };
    expect(Number(decided.n)).toBe(0);
    expect(harness.runRow(runId).status).toBe('PENDING');
    expect(harness.entitlement().consumed).toBe(0);
  });
});

describe('RESIL: a lease expiring while its worker is still alive', () => {
  it('RESIL-127 the reclaiming tick wins and the original worker’s write is refused', async () => {
    const runId = await harness.admit('evt-127');

    // Worker A claims and is then delayed past its lease.
    const claimedByA = await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: TICK_DEFAULTS.LEASE_SECONDS,
      leaseUntil: iso(1 + TICK_DEFAULTS.LEASE_SECONDS),
    });
    expect(claimedByA).toHaveLength(1);

    // The lease expires; worker B reclaims and decides.
    const reportB = await harness.tick({
      now: at(TICK_DEFAULTS.LEASE_SECONDS + 10),
      resolver: notConnectedResolver(),
    });
    expect(reportB.runs.claimed).toBe(1);
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');

    // Worker A finally finishes. Its write is conditional on the revision it claimed, which
    // is no longer current, so it changes nothing.
    const aWrote = await runs.applyOutcome(harness.h.db, {
      workspaceId: harness.ws.workspaceId,
      runId,
      expectedRevision: claimedByA[0]!.revision,
      status: 'FAILED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: iso(500),
    });
    expect(aWrote).toBe(false);
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('RESIL-128 a run is never decided twice, so its allowance is never settled twice', async () => {
    await harness.admit('evt-128');
    const before = harness.entitlement();

    const claimedByA = await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: TICK_DEFAULTS.LEASE_SECONDS,
      leaseUntil: iso(1 + TICK_DEFAULTS.LEASE_SECONDS),
    });
    await harness.tick({ now: at(TICK_DEFAULTS.LEASE_SECONDS + 10), resolver: notConnectedResolver() });

    // A's late write is refused, so no second finalisation follows it.
    await runs.applyOutcome(harness.h.db, {
      workspaceId: harness.ws.workspaceId,
      runId: 'run_evt-128',
      expectedRevision: claimedByA[0]!.revision,
      status: 'VERIFIED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: iso(500),
    });

    const after = harness.entitlement();
    expect(after).toMatchObject({ consumed: 1, reserved: 0 });
    expect(remainingAllowance(after)).toBe(remainingAllowance(before));
  });

  it('RESIL-129 the stale worker discards rather than retrying, so it makes no second attempt', async () => {
    const runId = await harness.admit('evt-129');
    const claimed = await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: 120,
      leaseUntil: iso(121),
    });

    // Someone else decides the run.
    await runs.applyOutcome(harness.h.db, {
      workspaceId: harness.ws.workspaceId,
      runId,
      expectedRevision: claimed[0]!.revision,
      status: 'VERIFIED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: iso(2),
    });

    const attemptsBefore = Number(
      (harness.h.raw.prepare('SELECT COUNT(*) AS n FROM run_attempts WHERE run_id = ?').get(runId) as { n: number }).n,
    );
    // The run is no longer due, so no tick observes it again and no attempt is opened.
    const report = await harness.tick({ now: at(5), resolver: notConnectedResolver() });
    expect(report.runs.claimed).toBe(0);
    const attemptsAfter = Number(
      (harness.h.raw.prepare('SELECT COUNT(*) AS n FROM run_attempts WHERE run_id = ?').get(runId) as { n: number }).n,
    );
    expect(attemptsAfter).toBe(attemptsBefore);
  });

  it('RESIL-130 an attempt left open by a killed worker is visible rather than silently lost', async () => {
    // The audit trail has to show that something started and never finished, otherwise an
    // interrupted run is indistinguishable from one that was never tried.
    const runId = await harness.admit('evt-130');
    const failing = new FailingDb(harness.h.db, { failMatching: /UPDATE runs\s+SET status/ });
    const { runSchedulerTick } = await import('@app/scheduler');
    const { D1BillingDataPort } = await import('@app/db/billingPort');
    await runSchedulerTick({
      db: failing,
      now: at(1),
      resolver: notConnectedResolver(),
      billing: new D1BillingDataPort(failing),
      billingEnvironment: 'test',
      newId: harness.newId,
      digest: async () => 'digest',
    });

    const open = harness.h.raw
      .prepare('SELECT ended_at, outcome FROM run_attempts WHERE run_id = ?')
      .all(runId) as { ended_at: string | null; outcome: string | null }[];
    expect(open.length).toBeGreaterThan(0);
    expect(open.some((row) => row.ended_at === null)).toBe(true);
  });
});

describe('RESIL: a retention sweep interrupted part-way', () => {
  it('RESIL-131 an interrupted sweep does not fail the tick that verifies runs', async () => {
    const runId = await harness.admit('evt-131');
    const sweeper: RetentionSweeper = {
      async sweep() {
        throw new Error('worker killed mid-sweep');
      },
    };
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver(), sweeper });

    expect(report.retention.error).not.toBeNull();
    expect(report.error).toBeNull();
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('RESIL-132 an incomplete sweep is reported as incomplete rather than as done', async () => {
    const sweeper: RetentionSweeper = {
      async sweep() {
        return { removed: 12, complete: false };
      },
    };
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver(), sweeper });
    expect(report.retention.ran).toBe(true);
    expect(report.retention.removed).toBe(12);
    expect(report.retention.complete).toBe(false);
  });

  it('RESIL-133 a sweep interrupted after partial deletion resumes on the next tick', async () => {
    // The sweep is keyset-paged and bounded, so "interrupted" means "did some of the work".
    // The next tick asks again with the same bounds and continues from what is left.
    const seen: number[] = [];
    let remaining = 7;
    const sweeper: RetentionSweeper = {
      async sweep(input) {
        seen.push(input.batchSize);
        const removed = Math.min(remaining, 3);
        remaining -= removed;
        return { removed, complete: remaining === 0 };
      },
    };

    const first = await harness.tick({ now: at(1), resolver: notConnectedResolver(), sweeper });
    const second = await harness.tick({ now: at(2), resolver: notConnectedResolver(), sweeper });
    const third = await harness.tick({ now: at(3), resolver: notConnectedResolver(), sweeper });

    expect(first.retention.complete).toBe(false);
    expect(second.retention.complete).toBe(false);
    expect(third.retention.complete).toBe(true);
    expect(first.retention.removed + second.retention.removed + third.retention.removed).toBe(7);
    expect(seen).toHaveLength(3);
  });

  it('RESIL-134 an interrupted sweep deletes nothing it did not mean to', async () => {
    // The bound the tick asks for is small and fixed, so an interruption can never have
    // removed more than one bounded bite.
    const asked: { batchSize: number; maxBatches: number }[] = [];
    const sweeper: RetentionSweeper = {
      async sweep(input) {
        asked.push({ batchSize: input.batchSize, maxBatches: input.maxBatches });
        throw new Error('killed');
      },
    };
    await harness.tick({ now: at(1), resolver: notConnectedResolver(), sweeper });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.batchSize * asked[0]!.maxBatches).toBeLessThanOrEqual(
      TICK_DEFAULTS.RETENTION_BATCH_SIZE * TICK_DEFAULTS.RETENTION_MAX_BATCHES,
    );
  });

  it('RESIL-135 retention is skipped entirely rather than half-run when the tick is out of time', async () => {
    let elapsed = 0;
    let called = 0;
    const sweeper: RetentionSweeper = {
      async sweep() {
        called += 1;
        return { removed: 0, complete: true };
      },
    };
    const report = await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      wallClockMs: 5,
      elapsed: () => {
        elapsed += 50;
        return elapsed;
      },
      sweeper,
    });
    expect(called).toBe(0);
    expect(report.retention.ran).toBe(false);
  });
});

describe('RESIL: interruption never fabricates a customer-visible outcome', () => {
  it('RESIL-136 no interruption point produces a FAILED run', async () => {
    const patterns: RegExp[] = [
      /UPDATE runs\s+SET status/,
      /INSERT INTO evidence/,
      /INSERT INTO outbox/,
      /UPDATE entitlements/,
      /FROM workflow_versions/,
      /FROM source_events/,
    ];
    const { runSchedulerTick } = await import('@app/scheduler');
    const { D1BillingDataPort } = await import('@app/db/billingPort');

    for (const pattern of patterns) {
      harness.close();
      harness = createSchedulerHarness();
      const runId = await harness.admit('evt-136');
      const failing = new FailingDb(harness.h.db, { failMatching: pattern });
      await runSchedulerTick({
        db: failing,
        now: at(1),
        resolver: notConnectedResolver(),
        billing: new D1BillingDataPort(failing),
        billingEnvironment: 'test',
        newId: harness.newId,
        digest: async () => 'digest',
      });
      expect(harness.runRow(runId).status, `failing ${pattern}`).not.toBe('FAILED');
    }
  });

  it('RESIL-137 no interruption point strands allowance arithmetic', async () => {
    const patterns: RegExp[] = [/UPDATE runs\s+SET status/, /INSERT INTO outbox/, /UPDATE entitlements/];
    const { runSchedulerTick } = await import('@app/scheduler');
    const { D1BillingDataPort } = await import('@app/db/billingPort');

    for (const pattern of patterns) {
      harness.close();
      harness = createSchedulerHarness();
      await harness.admit('evt-137');
      const before = harness.entitlement();
      const failing = new FailingDb(harness.h.db, { failMatching: pattern });
      await runSchedulerTick({
        db: failing,
        now: at(1),
        resolver: notConnectedResolver(),
        billing: new D1BillingDataPort(failing),
        billingEnvironment: 'test',
        newId: harness.newId,
        digest: async () => 'digest',
      });
      const after = harness.entitlement();
      expect(remainingAllowance(after), `failing ${pattern}`).toBe(remainingAllowance(before));
    }
  });

  it('RESIL-138 every interrupted run is still reachable by a later tick', async () => {
    const patterns: RegExp[] = [/UPDATE runs\s+SET status/, /INSERT INTO evidence/, /INSERT INTO outbox/];
    const { runSchedulerTick } = await import('@app/scheduler');
    const { D1BillingDataPort } = await import('@app/db/billingPort');

    for (const pattern of patterns) {
      harness.close();
      harness = createSchedulerHarness();
      const runId = await harness.admit('evt-138');
      const failing = new FailingDb(harness.h.db, { failMatching: pattern });
      await runSchedulerTick({
        db: failing,
        now: at(1),
        resolver: notConnectedResolver(),
        billing: new D1BillingDataPort(failing),
        billingEnvironment: 'test',
        newId: harness.newId,
        digest: async () => 'digest',
      });

      const row = harness.runRow(runId);
      const reachable = row.next_check_at !== null || row.completed_at !== null;
      expect(reachable, `failing ${pattern} stranded the run`).toBe(true);
    }
  });

  it('RESIL-139 a tick interrupted before it claims anything changes nothing at all', async () => {
    const runId = await harness.admit('evt-139');
    const before = harness.runRow(runId);
    const entitlementBefore = harness.entitlement();

    const failing = new FailingDb(harness.h.db, { failMatching: /FROM runs\s+WHERE next_check_at/ });
    const { runSchedulerTick } = await import('@app/scheduler');
    const { D1BillingDataPort } = await import('@app/db/billingPort');
    const report = await runSchedulerTick({
      db: failing,
      now: at(1),
      resolver: notConnectedResolver(),
      billing: new D1BillingDataPort(failing),
      billingEnvironment: 'test',
      newId: harness.newId,
      digest: async () => 'digest',
    });

    expect(report.runs.claimed).toBe(0);
    expect(harness.runRow(runId)).toEqual(before);
    expect(harness.entitlement()).toEqual(entitlementBefore);
  });
});
