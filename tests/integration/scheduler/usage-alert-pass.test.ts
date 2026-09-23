/**
 * The usage warning's retry, on a path that does not need another admission.
 *
 * The owner put the gap precisely: releasing a dedupe key is not a retry. The admission path
 * evaluates the warning after a successful admission, which is correct and insufficient —
 * the two moments a customer most needs this warning are the two where admissions have
 * stopped. At an exhausted allowance nothing is admitted ever again, so a first attempt that
 * failed could never be attempted again, which is precisely when the customer is least aware
 * and most affected. Same shape at a customer ceiling.
 *
 * These cases run the scheduler pass with NO admission in between.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUsageAlertPass } from '@app/scheduler/usageAlertPass';
import { MAX_USAGE_ALERT_ATTEMPTS } from '@app/db/usageAlerts';
import { createTestDb, seedWorkspace, type SeededWorkspace, type TestDb } from '../db/harness';

let h: TestDb;
let ws: SeededWorkspace;

const PERIOD = '2026-10-05';

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'alertpass');
  h.raw
    .prepare(
      `INSERT INTO entitlements (id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at)
       VALUES ('ent_pass', ?, ?, 1, ?, ?, 0, '2026-09-23T00:00:00.000Z')`,
    )
    .run(ws.workspaceId, PERIOD, 10, 10); // fully exhausted: 10 of 10
});
afterEach(() => {
  h.close();
});

/** Unique across sender instances: two senders in one case still write distinct rows. */
let rowSeq = 0;

/** Records every attempt the way the real dispatcher would, so the bound is measurable. */
function sender(outcome: 'sent' | 'failed') {
  const seen: string[] = [];
  return {
    seen,
    send: async (request: { notificationKey: string; workspaceId: string }) => {
      seen.push(request.notificationKey);
      h.raw
        .prepare(
          `INSERT INTO notification_deliveries
             (id, workspace_id, notification_key, channel, recipient_hash, template, state, attempt_count, created_at)
           VALUES (?, ?, ?, 'email', 'hash', 'allowance_reached', ?, 1, '2026-09-23T00:00:00.000Z')`,
        )
        .run(
          `nd_${String((rowSeq += 1))}`,
          request.workspaceId,
          request.notificationKey,
          outcome,
        );
      return { outcome };
    },
  };
}

function pass(send: ReturnType<typeof sender>['send']) {
  return runUsageAlertPass({
    db: h.db,
    // The one sanctioned source: the pass asks `resolveAllowancePeriodKey`, never derives.
    billing: {
      findSubscriptionForWorkspace: async () => ({
        currentPeriodEnd: '2026-10-05T00:00:00.000Z',
      }),
    },
    billingEnvironment: 'test',
    now: new Date('2026-09-23T00:00:00.000Z'),
    billingContact: async () => ({ workspaceName: 'Alert pass', email: 'ada@example.test' }),
    send,
  });
}

describe('the usage warning retries without another admission', () => {
  it('BUDGET-911 an exhausted allowance still gets its warning attempted by the scheduler', async () => {
    const t = sender('sent');
    const report = await pass(t.send);

    // No event was admitted here — nothing can be, the allowance is spent. The pass is the
    // only thing that could have sent this, and it did.
    expect(report.attempted).toBe(1);
    expect(report.sent).toBe(1);
    expect(t.seen[0]).toContain(':100#1');
  });

  it('BUDGET-912 a failed attempt is retried on a later tick, still with no admission', async () => {
    const failing = sender('failed');
    await pass(failing.send);
    expect(failing.seen).toHaveLength(1);

    // A second tick. Nothing has been admitted; the warning is still owed.
    await pass(failing.send);
    expect(failing.seen).toHaveLength(2);
    // A different key each time, which is what makes the attempts countable.
    expect(failing.seen[1]).not.toBe(failing.seen[0]);
  });

  it('BUDGET-913 retries are bounded, so a dead provider is not retried all month', async () => {
    const failing = sender('failed');
    for (let tick = 0; tick < MAX_USAGE_ALERT_ATTEMPTS + 3; tick += 1) {
      await pass(failing.send);
    }
    expect(failing.seen).toHaveLength(MAX_USAGE_ALERT_ATTEMPTS);
  });

  it('BUDGET-914 a delivered warning ends the series, so no later tick sends it again', async () => {
    const failing = sender('failed');
    await pass(failing.send);

    const ok = sender('sent');
    await pass(ok.send);
    expect(ok.seen).toHaveLength(1);

    // Two further ticks, and nothing more is attempted.
    const after = sender('sent');
    await pass(after.send);
    await pass(after.send);
    expect(after.seen).toHaveLength(0);
  });

  it('BUDGET-915 a workspace at its customer ceiling is reached the same way', async () => {
    // The ceiling stops admissions well below the plan; the warning still has to arrive.
    h.raw
      .prepare('UPDATE entitlements SET consumed = ?, run_limit = ? WHERE workspace_id = ?')
      .run(8, 10, ws.workspaceId);
    h.raw
      .prepare('UPDATE workflows SET admission_limit_per_period = 8 WHERE workspace_id = ?')
      .run(ws.workspaceId);

    const t = sender('sent');
    const report = await pass(t.send);
    expect(report.attempted).toBe(1);
    expect(t.seen[0]).toContain(':75#1');
  });
});

/**
 * The wiring, asserted as source rather than as intention.
 *
 * An optional dependency declared and never supplied is how this project has repeatedly
 * ended up with correct, tested code that nothing calls: the payment-recovery pass, the
 * owner alerts, the allowance templates. This feature made the same mistake twice — once in
 * the events route, caught by an audit, and once in `handleScheduled`, caught by checking
 * the deployed site rather than the test suite. This case is the thing that would have
 * caught both.
 */
describe('the usage-alert pass is actually wired into the production tick', () => {
  it('BUDGET-916 handleScheduled supplies the sender and the contact, not just the type', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../../apps/app/src/scheduler/tick.ts', import.meta.url)),
      'utf8',
    );
    // The tick body may consult the dependency; what matters is that the entry point HANDS
    // it one. Both must appear inside the runSchedulerTick call handleScheduled makes.
    const call = source.slice(source.indexOf('const report = await runSchedulerTick({'));
    const body = call.slice(0, call.indexOf('\n  });'));
    expect(body, 'handleScheduled does not supply sendUsageAlert').toContain('sendUsageAlert:');
    expect(body, 'handleScheduled does not supply billingContact').toContain('billingContact:');
  });
});
