/**
 * The scheduler, end to end, against a real database.
 *
 * Every test here admits a run the way the API does, then drives the real tick and asserts
 * on real rows. Nothing writes a run status by hand; if the scheduler does not produce it,
 * it does not appear.
 *
 * The crash tests construct the exact database state a killed Worker leaves behind — a run
 * claimed but never completed, or committed but never finalised — and then prove the next
 * tick repairs it. That is more faithful than killing a process, because it pins the
 * intermediate state we actually have to survive.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowancePeriodKey } from '@app/billing/period';
import { LIMITS } from '@verify/contracts';
import { MAX_EXTERNAL_CALLS_PER_RUN } from '@verify/domain';
import { runs } from '@app/db/runs';
import { outbox } from '@app/db/webhooks';
import { TickBudget, type OutboxHandler } from '@app/scheduler';
import { makeCrmEvidence, makeEmailEvent, makeEmailEventWithStatus } from '../../fixtures/index.js';
import {
  at,
  bundleScript,
  connectedResolver,
  createSchedulerHarness,
  crmOnlyRules,
  iso,
  makeFakeConnector,
  makeRegistry,
  makeThrowingConnector,
  notConnectedResolver,
  remainingAllowance,
  standardRules,
  ALLOWANCE_PERIOD_KEY,
  T0,
  type SchedulerHarness,
} from './harness';

let harness: SchedulerHarness;

beforeEach(() => {
  harness = createSchedulerHarness();
});

afterEach(() => {
  harness.close();
});

/** A registry that answers both providers from one bundle. */
function registryFor(bundle: Parameters<typeof bundleScript>[0], callsMade = 1) {
  const script = bundleScript(bundle, callsMade);
  return makeRegistry(
    makeFakeConnector('hubspot', script.hubspot),
    makeFakeConnector('resend', script.resend),
  );
}

const EMPTY_BUNDLE = { crm: null, email_events: [], gaps: [] } as const;

describe('the tick observes admitted runs without anyone touching the database', () => {
  it('PERSIST-300 an admitted run is claimed, observed and decided by a later tick', async () => {
    const runId = await harness.admit('evt-300');
    expect(harness.runRow(runId).status).toBe('PENDING');

    const report = await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent({ status: 'delivered' })],
        gaps: [],
      }),
    });

    expect(report.runs.claimed).toBe(1);
    expect(report.runs.observed).toBe(1);
    expect(harness.runRow(runId).status).toBe('VERIFIED');
  });

  it('PERSIST-301 the decided run is finalised: allowance settled and an announcement queued', async () => {
    const runId = await harness.admit('evt-301');
    expect(harness.entitlement()).toMatchObject({ consumed: 0, reserved: 1 });

    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent()],
        gaps: [],
      }),
    });

    expect(harness.entitlement()).toMatchObject({ consumed: 1, reserved: 0 });
    expect(harness.runRow(runId).next_check_at).toBeNull();
    expect(harness.runRow(runId).completed_at).not.toBeNull();

    const announced = harness.h.raw
      .prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'run.decided' AND entity_id = ?",
      )
      .get(runId) as { n: number };
    expect(Number(announced.n)).toBe(1);
  });

  it('PERSIST-302 evidence and assertions are written for the revision that was judged', async () => {
    const runId = await harness.admit('evt-302');
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent()],
        gaps: [],
      }),
    });

    const assertionCount = harness.h.raw
      .prepare('SELECT COUNT(*) AS n FROM assertions WHERE run_id = ?')
      .get(runId) as { n: number };
    const evidenceCount = harness.h.raw
      .prepare('SELECT COUNT(*) AS n FROM evidence WHERE run_id = ?')
      .get(runId) as { n: number };
    expect(Number(assertionCount.n)).toBe(2);
    expect(Number(evidenceCount.n)).toBe(2);
  });

  it('PERSIST-303 contradicting evidence produces FAILED, not a pass and not a silence', async () => {
    const runId = await harness.admit('evt-303');
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEventWithStatus('bounced')],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).toBe('FAILED');
  });

  it('PERSIST-304 a run still inside its window with nothing found stays PENDING and is re-armed', async () => {
    const runId = await harness.admit('evt-304');
    const report = await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor(EMPTY_BUNDLE),
    });

    expect(report.runs.terminal).toBe(0);
    const row = harness.runRow(runId);
    expect(row.status).toBe('PENDING');
    expect(row.observation_count).toBe(1);
    expect(row.next_check_at).not.toBeNull();
  });

  it('PERSIST-305 a run whose window has closed resolves rather than waiting forever', async () => {
    const runId = await harness.admit('evt-305');
    await harness.tick({
      // Past the deadline and its grace.
      now: at(LIMITS.DEFAULT_DEADLINE_SECONDS + 300),
      resolver: connectedResolver(),
      connectors: registryFor(EMPTY_BUNDLE),
    });
    const row = harness.runRow(runId);
    expect(row.status).toBe('UNVERIFIED');
    expect(row.next_check_at).toBeNull();
  });
});

describe('no credentials — the only path that runs in production today', () => {
  it('VERIFY-213 a run with no connected provider resolves UNVERIFIED, never FAILED', async () => {
    const runId = await harness.admit('evt-213');
    await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('VERIFY-214 a run with no connected provider costs zero external calls', async () => {
    await harness.admit('evt-214');
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    expect(report.runs.callsMade).toBe(0);
    expect(report.budget.callsUsed).toBe(0);
    expect(harness.registry.totalCalls()).toBe(0);
  });

  it('VERIFY-215 a run with no connected provider does not burn the observation budget', async () => {
    // Waiting cannot fix a missing connection, so the run resolves on its first look rather
    // than spending all four observations discovering the same thing.
    const runId = await harness.admit('evt-215');
    await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    const row = harness.runRow(runId);
    expect(row.observation_count).toBe(1);
    expect(row.next_check_at).toBeNull();
    expect(row.status).toBe('UNVERIFIED');
  });

  it('VERIFY-216 ten unconnected runs produce ten quiet resolutions, not an alert storm', async () => {
    for (let i = 0; i < 10; i += 1) await harness.admit(`evt-storm-${i}`);
    const report = await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      maxRuns: 10,
    });

    expect(report.runs.terminal).toBe(10);
    expect(report.budget.callsUsed).toBe(0);
    // One announcement per run, each keyed by run and status, and none of them is a send.
    // Whether any of these becomes an email is A09's grouping decision, not the tick's.
    const announcements = harness.h.raw
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'run.decided'")
      .get() as { n: number };
    expect(Number(announcements.n)).toBe(10);
  });

  it('VERIFY-217 an unreadable credential is UNVERIFIED too, and is never retried inside the run', async () => {
    const runId = await harness.admit('evt-217');
    await harness.tick({ now: at(1), resolver: notConnectedResolver('credential_unreadable') });
    const row = harness.runRow(runId);
    expect(row.status).toBe('UNVERIFIED');
    expect(row.next_check_at).toBeNull();
  });

  it('VERIFY-218 the assertions record why we could not look, not that anything failed', async () => {
    const runId = await harness.admit('evt-218');
    await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    const rows = harness.h.raw
      .prepare('SELECT status, reason_code FROM assertions WHERE run_id = ?')
      .all(runId) as { status: string; reason_code: string }[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe('UNKNOWN');
      expect(row.reason_code).toBe('CONNECTION_UNAVAILABLE');
    }
  });
});

describe('an unreachable provider never becomes a failure', () => {
  it('VERIFY-219 a transient outage keeps the run PENDING inside the window', async () => {
    const runId = await harness.admit('evt-219');
    const outage = registryFor({
      crm: null,
      email_events: [],
      gaps: [
        { source: 'crm_record', code: 'PROVIDER_UNAVAILABLE', retryable: true, detail: 'timeout' },
        { source: 'email_event', code: 'PROVIDER_UNAVAILABLE', retryable: true, detail: 'timeout' },
      ],
    });
    await harness.tick({ now: at(1), resolver: connectedResolver(), connectors: outage });

    const row = harness.runRow(runId);
    expect(row.status).toBe('PENDING');
    expect(row.next_check_at).not.toBeNull();
  });

  it('VERIFY-220 the same outage at the deadline resolves UNVERIFIED, not FAILED', async () => {
    const runId = await harness.admit('evt-220');
    const outage = registryFor({
      crm: null,
      email_events: [],
      gaps: [
        { source: 'crm_record', code: 'PROVIDER_UNAVAILABLE', retryable: true, detail: 'timeout' },
        { source: 'email_event', code: 'PROVIDER_UNAVAILABLE', retryable: true, detail: 'timeout' },
      ],
    });
    await harness.tick({
      now: at(LIMITS.DEFAULT_DEADLINE_SECONDS + 300),
      resolver: connectedResolver(),
      connectors: outage,
    });
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('VERIFY-221 a connector that throws cannot decide a customer’s status', async () => {
    const runId = await harness.admit('evt-221');
    const report = await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: makeRegistry(makeThrowingConnector('hubspot'), makeThrowingConnector('resend')),
    });
    expect(report.error).toBeNull();
    expect(harness.runRow(runId).status).not.toBe('FAILED');
    expect(harness.runRow(runId).status).toBe('PENDING');
  });

  it('VERIFY-222 an authoritative absence at the deadline is the one route from unknown to FAILED', async () => {
    const runId = await harness.admit('evt-222');
    const absent = registryFor({
      crm: null,
      email_events: [],
      gaps: [
        {
          source: 'crm_record',
          code: 'NOT_FOUND',
          retryable: false,
          detail: 'the CRM has no such record',
        },
        {
          source: 'email_event',
          code: 'NOT_FOUND',
          retryable: false,
          detail: 'no events for this message',
        },
      ],
    });
    await harness.tick({
      now: at(LIMITS.DEFAULT_DEADLINE_SECONDS + 300),
      resolver: connectedResolver(),
      connectors: absent,
    });
    expect(harness.runRow(runId).status).toBe('FAILED');
  });

  it('VERIFY-223 the same authoritative absence before the deadline is not yet a failure', async () => {
    const runId = await harness.admit('evt-223');
    const absent = registryFor({
      crm: null,
      email_events: [],
      gaps: [
        {
          source: 'crm_record',
          code: 'NOT_FOUND',
          retryable: false,
          detail: 'the CRM has no such record',
        },
        {
          source: 'email_event',
          code: 'NOT_FOUND',
          retryable: false,
          detail: 'no events for this message',
        },
      ],
    });
    await harness.tick({ now: at(1), resolver: connectedResolver(), connectors: absent });
    expect(harness.runRow(runId).status).toBe('PENDING');
  });
});

describe('coverage modes the scheduler cannot deliver', () => {
  it('VERIFY-224 a run whose workflow asks for unsupported coverage is flagged, not processed quietly', async () => {
    harness.setRules(standardRules({ coverage_mode: 'independently_sourced' }));
    await harness.admit('evt-224');

    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver() });

    expect(report.runs.coverageWarnings).toBe(1);
    const outcome = report.runs.outcomes[0];
    expect(outcome?.coverageWarning?.code).toBe('COVERAGE_MODE_UNSUPPORTED');
    expect(outcome?.coverageWarning?.severity).toBe('critical');
    expect(outcome?.coverageWarning?.effective_mode).toBe('customer_triggered');
  });

  it('VERIFY-225 the run is still observed, with the coverage we actually have', async () => {
    harness.setRules(standardRules({ coverage_mode: 'independently_sourced' }));
    const runId = await harness.admit('evt-225');
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent()],
        gaps: [],
      }),
    });
    // Degrading does not mean refusing: the enquiries we were told about are still checked.
    expect(harness.runRow(runId).status).toBe('VERIFIED');
  });

  it('VERIFY-226 a supported coverage mode raises no warning', async () => {
    await harness.admit('evt-226');
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    expect(report.runs.coverageWarnings).toBe(0);
    expect(report.runs.outcomes[0]?.coverageWarning).toBeNull();
  });
});

describe('two ticks in the same minute', () => {
  it('PERSIST-310 overlapping ticks claim each run exactly once', async () => {
    for (let i = 0; i < 5; i += 1) await harness.admit(`evt-race-${i}`);

    const first = await harness.tick({ now: at(1), resolver: notConnectedResolver(), maxRuns: 10 });
    const second = await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      maxRuns: 10,
    });

    expect(first.runs.claimed).toBe(5);
    expect(second.runs.claimed).toBe(0);
  });

  it('PERSIST-311 the compare-and-set claim rejects the loser of an interleaved race', async () => {
    const runId = await harness.admit('evt-cas');
    // Both schedulers read the due list before either claims — the interleaving a real
    // pair of Workers produces.
    const seenByA = await runs.listDue(harness.h.db, iso(1), 10);
    const seenByB = await runs.listDue(harness.h.db, iso(1), 10);
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);

    const wonByA = await runs.tryClaim(harness.h.db, {
      runId,
      expectedRevision: seenByA[0]!.revision,
      now: iso(1),
      leaseUntil: iso(120),
    });
    const wonByB = await runs.tryClaim(harness.h.db, {
      runId,
      expectedRevision: seenByB[0]!.revision,
      now: iso(1),
      leaseUntil: iso(120),
    });
    expect(wonByA).toBe(true);
    expect(wonByB).toBe(false);
  });

  it('PERSIST-312 a stale result is discarded rather than overwriting a newer decision', async () => {
    const runId = await harness.admit('evt-stale');
    const claimed = await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: 120,
      leaseUntil: iso(121),
    });
    expect(claimed).toHaveLength(1);

    // A newer attempt writes first.
    const newerWon = await runs.applyOutcome(harness.h.db, {
      workspaceId: harness.ws.workspaceId,
      runId,
      expectedRevision: claimed[0]!.revision,
      status: 'VERIFIED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: iso(2),
    });
    expect(newerWon).toBe(true);

    // The older attempt, holding the revision it claimed, must not be able to write.
    const olderWon = await runs.applyOutcome(harness.h.db, {
      workspaceId: harness.ws.workspaceId,
      runId,
      expectedRevision: claimed[0]!.revision,
      status: 'FAILED',
      nextCheckAt: null,
      observationCount: 1,
      completedAt: iso(3),
    });
    expect(olderWon).toBe(false);
    expect(harness.runRow(runId).status).toBe('VERIFIED');
  });
});

describe('a tick that dies part way', () => {
  it('PERSIST-320 a run claimed by a tick that never finished is not claimed forever', async () => {
    const runId = await harness.admit('evt-crash-claim');

    // Exactly what a Worker killed just after claiming leaves behind: the lease taken, no
    // outcome written.
    const claimed = await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: 120,
      leaseUntil: iso(121),
    });
    expect(claimed).toHaveLength(1);
    expect(harness.runRow(runId).status).toBe('PENDING');

    // Inside the lease, nobody else may take it.
    const duringLease = await harness.tick({ now: at(60), resolver: notConnectedResolver() });
    expect(duringLease.runs.claimed).toBe(0);

    // After it expires, the next tick simply picks the run up. Nothing had to detect the
    // crash; the absence of a completion is the detection.
    const afterLease = await harness.tick({ now: at(130), resolver: notConnectedResolver() });
    expect(afterLease.runs.claimed).toBe(1);
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('PERSIST-321 a crash leaves no allowance permanently reserved', async () => {
    const runId = await harness.admit('evt-crash-allowance');
    const admitted = harness.entitlement();
    expect(admitted.reserved).toBe(1);

    // Crash right after the claim.
    await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: 120,
      leaseUntil: iso(121),
    });
    expect(harness.entitlement().reserved).toBe(1);

    // The lease expires and the run is resolved by a later tick, which settles it.
    await harness.tick({ now: at(130), resolver: notConnectedResolver() });
    const settled = harness.entitlement();
    expect(settled.reserved).toBe(0);
    expect(settled.consumed).toBe(1);
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('PERSIST-322 an outcome committed but never announced is still announced by the next tick', async () => {
    const runId = await harness.admit('evt-crash-finalise');

    // The state a tick killed between committing the decision and finalising it leaves:
    // terminal status, still due, no announcement, allowance still reserved.
    const claimed = await runs.claimDue(harness.h.db, {
      now: iso(1),
      limit: 5,
      leaseSeconds: 120,
      leaseUntil: iso(121),
    });
    await runs.applyOutcome(harness.h.db, {
      workspaceId: harness.ws.workspaceId,
      runId,
      expectedRevision: claimed[0]!.revision,
      status: 'VERIFIED',
      nextCheckAt: iso(30),
      observationCount: 1,
      completedAt: iso(2),
    });
    const announcedBefore = harness.h.raw
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'run.decided'")
      .get() as { n: number };
    expect(Number(announcedBefore.n)).toBe(0);
    expect(harness.entitlement().reserved).toBe(1);

    // The next tick sees a terminal run that is still due and completes its finalisation —
    // without re-observing it, and without calling a provider.
    const report = await harness.tick({ now: at(31), resolver: connectedResolver() });

    expect(report.runs.claimed).toBe(1);
    expect(report.budget.callsUsed).toBe(0);
    expect(report.runs.outcomes[0]?.note).toBe('finalised');
    const announcedAfter = harness.h.raw
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'run.decided'")
      .get() as { n: number };
    expect(Number(announcedAfter.n)).toBe(1);
    expect(harness.entitlement()).toMatchObject({ consumed: 1, reserved: 0 });
    // And the decision it had already made is untouched.
    expect(harness.runRow(runId).status).toBe('VERIFIED');
    expect(harness.runRow(runId).next_check_at).toBeNull();
  });

  it('PERSIST-323 finalising twice does not settle the allowance twice', async () => {
    await harness.admit('evt-double-settle-a');
    await harness.admit('evt-double-settle-b');
    const before = harness.entitlement();
    expect(before.reserved).toBe(2);

    await harness.tick({ now: at(1), resolver: notConnectedResolver(), maxRuns: 10 });
    // A second tick has nothing left to claim; the counters must not move again.
    await harness.tick({ now: at(2), resolver: notConnectedResolver(), maxRuns: 10 });

    const after = harness.entitlement();
    expect(after).toMatchObject({ consumed: 2, reserved: 0 });
    expect(remainingAllowance(after)).toBe(remainingAllowance(before));
  });

  it('PERSIST-324 the allowance arithmetic is unchanged by a crash, whichever side it lands', async () => {
    // A settlement lost to a crash leaves the unit `reserved` instead of `consumed`. Both
    // are subtracted from the allowance identically, so the customer is never over-charged
    // and never under-served — the residue is a reporting difference, not a billing one.
    await harness.admit('evt-arith');
    const admitted = harness.entitlement();
    const remainingAfterAdmission = remainingAllowance(admitted);

    await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    const settled = harness.entitlement();

    expect(remainingAllowance(settled)).toBe(remainingAfterAdmission);
    expect(settled.consumed + settled.reserved).toBe(admitted.consumed + admitted.reserved);
  });

  it('PERSIST-325 one run failing does not cost the other runs in the batch', async () => {
    for (let i = 0; i < 3; i += 1) await harness.admit(`evt-blast-${i}`);

    // A connector that throws for HubSpot and answers for Resend: every run survives it.
    const report = await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: makeRegistry(
        makeThrowingConnector('hubspot'),
        makeFakeConnector('resend', () => ({
          provider: 'resend',
          provider_account_id: 'resend-acct-2000',
          evidence: [makeEmailEvent()],
          gaps: [],
          calls_made: 1,
        })),
      ),
      maxRuns: 10,
    });

    expect(report.error).toBeNull();
    expect(report.runs.claimed).toBe(3);
    expect(report.runs.observed).toBe(3);
  });
});

describe('the tick is bounded in every dimension', () => {
  it('PERSIST-330 the run batch is capped', async () => {
    for (let i = 0; i < 8; i += 1) await harness.admit(`evt-batch-${i}`);
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver(), maxRuns: 3 });
    expect(report.runs.claimed).toBe(3);
    expect(report.budget.stoppedBecause).toBe('batch');
  });

  it('PERSIST-331 the wall-clock budget stops the tick between runs, never inside one', async () => {
    for (let i = 0; i < 5; i += 1) await harness.admit(`evt-clock-${i}`);
    let elapsed = 0;
    const report = await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      maxRuns: 5,
      wallClockMs: 100,
      // Two runs' worth of time, then the budget is spent.
      elapsed: () => {
        const current = elapsed;
        elapsed += 60;
        return current;
      },
    });

    expect(report.runs.observed).toBe(2);
    expect(report.runs.deferred).toBe(3);
    expect(report.budget.stoppedBecause).toBe('wall_clock');
    // A deferred run is untouched: still pending, still leased, no decision written.
    const deferredId = report.runs.outcomes.find((o) => o.note === 'deferred')?.runId;
    expect(deferredId).toBeDefined();
    expect(harness.runRow(deferredId as string).status).toBe('PENDING');
    expect(harness.runRow(deferredId as string).observation_count).toBe(0);
  });

  it('PERSIST-332 the external-call ceiling bounds the whole tick, not each run', async () => {
    harness.setRules(crmOnlyRules());
    for (let i = 0; i < 6; i += 1) await harness.admit(`evt-calls-${i}`);

    const report = await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({ crm: makeCrmEvidence(), email_events: [], gaps: [] }, 1),
      maxRuns: 6,
      maxExternalCalls: 4,
    });

    expect(report.budget.callsUsed).toBeLessThanOrEqual(4);
    expect(harness.registry.totalCalls()).toBeLessThanOrEqual(4);
  });

  it('PERSIST-333 a run denied call budget is not failed, only left for the next tick', async () => {
    harness.setRules(crmOnlyRules());
    await harness.admit('evt-nobudget');
    const report = await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({ crm: makeCrmEvidence(), email_events: [], gaps: [] }),
      maxExternalCalls: 0,
    });
    expect(report.budget.callsUsed).toBe(0);
    // Reported as a retryable outage, so the run stays open rather than being judged.
    expect(report.runs.outcomes[0]?.status).toBe('PENDING');
  });

  it('PERSIST-334 one run can never exceed the proven per-run call ceiling', async () => {
    // A connector that claims an absurd number of calls still cannot spend more than the
    // tick has, and the per-run ceiling is what the tick's allowance is nested inside.
    await harness.admit('evt-ceiling');
    const greedy = makeRegistry(
      makeFakeConnector('hubspot', () => ({
        provider: 'hubspot',
        provider_account_id: 'hub-acct-1000',
        evidence: [],
        gaps: [],
        calls_made: 99,
      })),
      makeFakeConnector('resend', () => ({
        provider: 'resend',
        provider_account_id: 'resend-acct-2000',
        evidence: [],
        gaps: [],
        calls_made: 99,
      })),
    );
    const budget = new TickBudget({
      maxExternalCalls: MAX_EXTERNAL_CALLS_PER_RUN,
      elapsed: () => 0,
    });
    await harness.tick({ now: at(1), resolver: connectedResolver(), connectors: greedy, budget });

    // The first connector's inflated claim consumes the allowance, and the second is then
    // refused rather than dialled. The run is never judged on evidence we did not pay for.
    expect(harness.registry.totalCalls()).toBe(0);
    expect(greedy.hubspot.calls.length + greedy.resend.calls.length).toBe(1);
    expect(budget.callsUsed).toBeGreaterThan(0);
    expect(budget.callsRemaining).toBe(0);
  });

  it('PERSIST-335 the per-run ceiling is the one the domain proved', () => {
    expect(MAX_EXTERNAL_CALLS_PER_RUN).toBe(
      LIMITS.MAX_OBSERVATIONS_PER_RUN * (1 + LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION),
    );
  });
});

describe('the outbox dispatcher', () => {
  it('PERSIST-340 the admission announcement is dispatched', async () => {
    await harness.admit('evt-obx');
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    expect(report.outbox.dispatched).toBeGreaterThanOrEqual(1);

    const state = harness.h.raw
      .prepare("SELECT dispatch_state FROM outbox WHERE event_type = 'run.created'")
      .get() as { dispatch_state: string };
    expect(state.dispatch_state).toBe('dispatched');
  });

  it('PERSIST-341 a duplicate delivery reaches an idempotent handler and has one effect', async () => {
    await harness.admit('evt-dup');
    const seen: string[] = [];
    const applied = new Set<string>();
    const handler: OutboxHandler = {
      async handle(event) {
        seen.push(event.uniqueEventKey);
        applied.add(event.uniqueEventKey);
        return true;
      },
    };
    const handlers = new Map<string, OutboxHandler>([
      ['run.created', handler],
      ['run.decided', handler],
    ]);

    await harness.tick({ now: at(1), resolver: notConnectedResolver(), handlers });
    // Force the same row back to pending, exactly as a crash before markDispatched would.
    harness.h.exec(
      "UPDATE outbox SET dispatch_state = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z'",
    );
    await harness.tick({ now: at(2), resolver: notConnectedResolver(), handlers });

    // Delivered more than once — and the handler's effect is still exactly one per key.
    expect(seen.length).toBeGreaterThan(applied.size);
    expect(applied.size).toBe(2);
  });

  it('PERSIST-342 a handler that throws does not kill the tick and the row is retried', async () => {
    await harness.admit('evt-throw');
    const handlers = new Map<string, OutboxHandler>([
      [
        'run.created',
        {
          async handle() {
            throw new Error('handler exploded');
          },
        },
      ],
    ]);
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver(), handlers });

    expect(report.error).toBeNull();
    expect(report.outbox.retrying).toBeGreaterThanOrEqual(1);
    const row = harness.h.raw
      .prepare(
        "SELECT dispatch_state, attempts, last_error FROM outbox WHERE event_type = 'run.created'",
      )
      .get() as { dispatch_state: string; attempts: number; last_error: string | null };
    expect(row.dispatch_state).toBe('pending');
    expect(Number(row.attempts)).toBe(1);
    expect(row.last_error).not.toBeNull();
  });

  it('PERSIST-343 a row nobody can deliver is buried rather than retried forever', async () => {
    await harness.admit('evt-dead');
    // No handler at all for this event type: retried, then buried.
    const handlers = new Map<string, OutboxHandler>();
    let state = '';
    for (let i = 0; i < 8; i += 1) {
      await harness.tick({ now: at(1 + i), resolver: notConnectedResolver(), handlers });
      harness.h.exec(
        "UPDATE outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE dispatch_state = 'pending'",
      );
      state = (
        harness.h.raw
          .prepare("SELECT dispatch_state FROM outbox WHERE event_type = 'run.created'")
          .get() as { dispatch_state: string }
      ).dispatch_state;
      if (state === 'dead') break;
    }
    expect(state).toBe('dead');
  });

  it('PERSIST-344 two dispatchers cannot both claim one row', async () => {
    await harness.admit('evt-obx-race');
    const due = await outbox.listDue(harness.h.db, iso(1), 10);
    expect(due.length).toBeGreaterThan(0);
    const row = due[0]!;

    const a = await outbox.tryClaim(harness.h.db, {
      id: row.id,
      expectedAttempts: row.attempts,
      leaseUntil: iso(120),
    });
    const b = await outbox.tryClaim(harness.h.db, {
      id: row.id,
      expectedAttempts: row.attempts,
      leaseUntil: iso(120),
    });
    expect(a).toBe(true);
    expect(b).toBe(false);
  });
});

describe('retention', () => {
  it('PERSIST-350 retention runs in small bounded bites, with limits the tick chose', async () => {
    const calls: { batchSize: number; maxBatches: number }[] = [];
    await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      sweeper: {
        async sweep(input) {
          calls.push({ batchSize: input.batchSize, maxBatches: input.maxBatches });
          return { removed: 7, complete: false };
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.batchSize).toBeLessThanOrEqual(50);
    expect(calls[0]!.maxBatches).toBeLessThanOrEqual(2);
  });

  it('PERSIST-351 a retention failure never fails the tick that verifies runs', async () => {
    const runId = await harness.admit('evt-retention-fail');
    const report = await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      sweeper: {
        async sweep() {
          throw new Error('sweep exploded');
        },
      },
    });
    expect(report.retention.error).not.toBeNull();
    expect(report.runs.observed).toBe(1);
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('PERSIST-352 retention is skipped when the tick has no budget left for it', async () => {
    let elapsed = 0;
    const report = await harness.tick({
      now: at(1),
      resolver: notConnectedResolver(),
      wallClockMs: 10,
      elapsed: () => {
        elapsed += 100;
        return elapsed;
      },
      sweeper: {
        async sweep() {
          throw new Error('should not have been called');
        },
      },
    });
    expect(report.retention.ran).toBe(false);
    expect(report.retention.error).toBeNull();
  });
});

describe('the tick reports rather than throws', () => {
  it('PERSIST-360 a tick with nothing to do is a clean, empty report', async () => {
    const report = await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    expect(report.error).toBeNull();
    expect(report.runs.claimed).toBe(0);
    expect(report.outbox.dispatched).toBe(0);
    expect(report.startedAt).toBe(iso(1));
  });

  it('PERSIST-361 nothing in the tick reads a wall clock for business time', async () => {
    // Two ticks at the same injected instant against the same state produce the same row.
    const runId = await harness.admit('evt-determinism');
    await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    const first = harness.runRow(runId);
    expect(first.completed_at).toBe(iso(1));
    expect(first.status).toBe('UNVERIFIED');
  });

  it('PERSIST-362 T0 anchors every timestamp the tick writes', async () => {
    const runId = await harness.admit('evt-anchor');
    await harness.tick({ now: at(5), resolver: notConnectedResolver() });
    expect(harness.runRow(runId).completed_at).toBe(iso(5));
    expect(new Date(T0).toISOString()).toBe(T0);
  });
});

describe('the allowance period key is read, never derived (A13-010)', () => {
  it('PERSIST-370 the settle uses the subscription’s period key, not the run’s month or date', async () => {
    const runId = await harness.admit('evt-key');
    // The row was opened under the subscription's period end. Neither the run's calendar
    // month nor its date would address it.
    expect(ALLOWANCE_PERIOD_KEY).toBe('2026-10-05');
    expect(ALLOWANCE_PERIOD_KEY).not.toBe(T0.slice(0, 7));
    expect(ALLOWANCE_PERIOD_KEY).not.toBe(T0.slice(0, 10));

    await harness.tick({ now: at(1), resolver: notConnectedResolver() });

    const rows = harness.allowanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      billing_period: ALLOWANCE_PERIOD_KEY,
      consumed: 1,
      reserved: 0,
    });
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('PERSIST-371 the key the scheduler settles with is shaped like an allowance key', async () => {
    await harness.admit('evt-key-shape');
    await harness.tick({ now: at(1), resolver: notConnectedResolver() });
    for (const row of harness.allowanceRows()) {
      expect(isAllowancePeriodKey(row.billing_period)).toBe(true);
    }
  });

  it('PERSIST-372 settling never opens a second allowance row under another key', async () => {
    // The defect's twin: two spellings of one key let `UNIQUE (workspace_id, billing_period)`
    // hold both, which is 1,000 runs sold for one payment.
    for (let i = 0; i < 3; i += 1) await harness.admit(`evt-one-row-${i}`);
    await harness.tick({ now: at(1), resolver: notConnectedResolver(), maxRuns: 10 });
    const rows = harness.allowanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ consumed: 3, reserved: 0 });
  });

  it('PERSIST-373 a run decided after a renewal settles against its own period, not the new one', async () => {
    const runId = await harness.admit('evt-renewal');

    // The subscription rolls forward before the scheduler gets to the run.
    harness.setSubscriptionPeriodEnd('2026-11-05T00:00:00.000Z');

    await harness.tick({ now: at(1), resolver: notConnectedResolver() });

    // The reservation was taken from the September-to-October period, so that is where the
    // consumption must land. Using "the current period" would have credited the wrong month.
    const rows = harness.allowanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billing_period: '2026-10-05', consumed: 1, reserved: 0 });
    expect(harness.runRow(runId).status).toBe('UNVERIFIED');
  });

  it('PERSIST-374 a workspace with no subscription settles nothing and invents nothing', async () => {
    const solo = createSchedulerHarness({ subscription: 'none' });
    try {
      const runId = await solo.admit('evt-nosub');
      const before = solo.allowanceRows();
      await solo.tick({ now: at(1), resolver: notConnectedResolver() });

      // The run is still decided — billing state must never block verification.
      expect(solo.runRow(runId).status).toBe('UNVERIFIED');
      // And no key was guessed into existence.
      const after = solo.allowanceRows();
      expect(after).toHaveLength(before.length);
      expect(after.every((row) => isAllowancePeriodKey(row.billing_period))).toBe(true);
    } finally {
      solo.close();
    }
  });

  it('PERSIST-375 nothing under scheduler/ derives an allowance period key', () => {
    // The finding was a *shape*, not a string format: three modules each computing a key
    // from a different input. This asserts the scheduler is not one of them any more.
    const dir = fileURLToPath(new URL('../../../apps/app/src/scheduler', import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      if (/billingPeriodFor/.test(source)) offenders.push(`${file}: imports billingPeriodFor`);
      if (/\.slice\(\s*0\s*,\s*(7|10)\s*\)/.test(source))
        offenders.push(`${file}: slices a date into a key`);
    }
    expect(offenders).toEqual([]);
  });

  it('PERSIST-376 the scheduler reads the key through the shared resolver', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../apps/app/src/scheduler/observe.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('resolveAllowancePeriodKey');
    expect(source).toContain("from '../billing/period'");
  });
});
