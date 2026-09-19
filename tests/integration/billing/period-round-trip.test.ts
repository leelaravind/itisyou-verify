/**
 * A13-010 — the allowance period key, across the whole round trip.
 *
 * The defect: billing opened allowance rows keyed `YYYY-MM-DD`, the scheduler settled them
 * keyed `YYYY-MM`. They never matched, so `settleReservation` never found the row it was
 * settling, reservations never became consumption, and a workspace at its limit reported
 * itself unblocked.
 *
 * **The real finding was the missing test, not the mismatched key.** Every existing case
 * exercised one side or the other — billing's tests opened and read rows with billing's
 * key, the scheduler's tests settled with the scheduler's key — and each passed in
 * isolation. This file crosses the boundary: it opens a period the way billing does,
 * reserves the way admission does, settles the way the scheduler does, and asserts the row
 * actually moved.
 *
 * It runs against the real SQLite-backed D1 harness and A02's real repositories, not
 * against the in-memory port. A fixture built out of one side's own code would hide exactly
 * this class of bug.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entitlements, sourceEvents } from '@app/db';
import {
  allowancePeriodKey,
  allowancePeriodKeyAt,
  isAllowancePeriodKey,
  resolveAllowancePeriodKey,
} from '@app/billing/period';
// Renamed from `billingPeriodFor` (A13-010 follow-up): the old name looked like an
// allowance key and is not one. Nothing correct calls it; this case locks the regression.
import { calendarMonthNotAnAllowanceKey } from '@app/db/customerPort';
import { createTestDb, seedWorkspace, type SeededWorkspace, type TestDb } from '../db/harness';

/**
 * The subscription this workspace is on: a period ending 2026-10-19T09:00Z, i.e. a customer
 * who subscribed on the 19th. A calendar-month key would roll their allowance on the 1st —
 * eleven days early, every month.
 */
const PERIOD_END = '2026-10-19T09:00:00.000Z';
const PERIOD_KEY = '2026-10-19';
const RUN_CREATED_AT = '2026-09-25T11:30:00.000Z';

function admitParams(ws: SeededWorkspace, billingPeriod: string, suffix = 'a') {
  return {
    workspaceId: ws.workspaceId,
    billingPeriod,
    workflowId: ws.workflowId,
    workflowVersionId: ws.workflowVersionId,
    externalEventId: `customer-event-${suffix}`,
    source: 'signed_customer_event' as const,
    sourceEventId: `sev_${suffix}`,
    runId: `run_${suffix}`,
    outboxId: `obx_${suffix}`,
    receivedAt: RUN_CREATED_AT,
    occurredAt: RUN_CREATED_AT,
    correlationKeyHash: `corr-${suffix}`,
    payloadHash: `payload-${suffix}`,
    payloadJson: '{"event_id":"x"}',
    deadlineAt: '2026-09-25T12:30:00.000Z',
    nextCheckAt: '2026-09-25T11:31:00.000Z',
  };
}

describe('A13-010 the allowance period key round trip', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    // The allowance row is opened the way billing opens it: keyed by the period END.
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha', { runLimit: 3, billingPeriod: PERIOD_KEY });
  });
  afterEach(() => {
    h.close();
  });

  it('BILL-243 a run reserved at admission is settled by the scheduler against the same row', async () => {
    // THE case whose absence was the finding.
    //
    // 1. Billing opened the period.
    const openedKey = allowancePeriodKey(PERIOD_END);
    expect(openedKey).toBe(ws.billingPeriod);

    // 2. Admission reserves, using the key resolved the one permitted way.
    const admitted = await sourceEvents.admitOnce(h.db, admitParams(ws, openedKey));
    expect(admitted.duplicate).toBe(false);
    expect(admitted.runId).toBe('run_a');

    const afterReserve = await entitlements.get(h.db, ws.workspaceId, openedKey);
    expect(afterReserve).toMatchObject({ reserved: 1, consumed: 0 });

    // 3. The scheduler settles. It holds the run's creation instant and nothing else about
    //    billing, so it resolves the key through the same function.
    const settleKey = allowancePeriodKeyAt(RUN_CREATED_AT, PERIOD_END);
    expect(settleKey).toBe(openedKey);

    const settled = await entitlements.settleReservation(
      h.db,
      ws.workspaceId,
      settleKey,
      '2026-09-25T11:45:00.000Z',
    );

    // 4. The row actually moved.
    expect(settled).toBe(true);
    const afterSettle = await entitlements.get(h.db, ws.workspaceId, openedKey);
    expect(afterSettle).toMatchObject({ reserved: 0, consumed: 1 });
  });

  it('BILL-244 the scheduler’s old calendar-month key does not settle anything — the regression, locked', async () => {
    // This is the defect reproduced. `billingPeriodFor` is what the scheduler and the
    // customer usage view still call today; it must never be used for an allowance row.
    const openedKey = allowancePeriodKey(PERIOD_END);
    await sourceEvents.admitOnce(h.db, admitParams(ws, openedKey));
    expect(await entitlements.get(h.db, ws.workspaceId, openedKey)).toMatchObject({
      reserved: 1,
    });

    const calendarMonthKey = calendarMonthNotAnAllowanceKey(new Date(RUN_CREATED_AT));
    expect(calendarMonthKey).toBe('2026-09');
    expect(calendarMonthKey).not.toBe(openedKey);
    expect(isAllowancePeriodKey(calendarMonthKey)).toBe(false);

    const settled = await entitlements.settleReservation(
      h.db,
      ws.workspaceId,
      calendarMonthKey,
      '2026-09-25T11:45:00.000Z',
    );

    // Silently false. Nothing raised, nothing logged, the reservation held forever, and the
    // workspace edges towards its limit while reporting itself clear.
    expect(settled).toBe(false);
    expect(await entitlements.get(h.db, ws.workspaceId, openedKey)).toMatchObject({
      reserved: 1,
      consumed: 0,
    });
  });

  it('BILL-245 a release goes back to the same row too', async () => {
    const key = allowancePeriodKey(PERIOD_END);
    await sourceEvents.admitOnce(h.db, admitParams(ws, key));
    const released = await entitlements.releaseReservation(
      h.db,
      ws.workspaceId,
      allowancePeriodKeyAt(RUN_CREATED_AT, PERIOD_END),
      '2026-09-25T11:45:00.000Z',
    );
    expect(released).toBe(true);
    expect(await entitlements.get(h.db, ws.workspaceId, key)).toMatchObject({
      reserved: 0,
      consumed: 0,
    });
  });

  it('BILL-246 exhausting the allowance actually blocks, once settlement works', async () => {
    // The customer-visible consequence of the bug: with settlement broken, `consumed` never
    // rises. With it working, the third run exhausts the limit and the fourth is refused.
    const key = allowancePeriodKey(PERIOD_END);
    for (const suffix of ['a', 'b', 'c']) {
      const admitted = await sourceEvents.admitOnce(h.db, admitParams(ws, key, suffix));
      expect(admitted.duplicate).toBe(false);
      await entitlements.settleReservation(h.db, ws.workspaceId, key, RUN_CREATED_AT);
    }
    expect(await entitlements.get(h.db, ws.workspaceId, key)).toMatchObject({
      reserved: 0,
      consumed: 3,
    });
    expect(await entitlements.remaining(h.db, ws.workspaceId, key)).toBe(0);

    // A02's admission refuses by raising rather than returning a flag: the reservation is
    // a conditional UPDATE whose exhausted branch violates NOT NULL, which is what makes
    // two concurrent admissions unable to share the last unit.
    const overflow = await sourceEvents
      .admitOnce(h.db, admitParams(ws, key, 'd'))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(overflow).not.toBeNull();
  });

  it('BILL-247 a settle that happens after the subscription rolled still finds the run’s own period', async () => {
    // The window that makes `allowancePeriodKeyAt` worth having: the run was admitted in
    // September's period, the renewal landed, and only then did the run settle. The key
    // must be the period that CONTAINED the run, not the one current at settle time.
    const key = allowancePeriodKey(PERIOD_END);
    await sourceEvents.admitOnce(h.db, admitParams(ws, key));

    const rolledForward = '2026-11-19T09:00:00.000Z';
    const settleKey = allowancePeriodKeyAt(RUN_CREATED_AT, rolledForward);
    expect(settleKey).toBe(key);

    expect(
      await entitlements.settleReservation(
        h.db,
        ws.workspaceId,
        settleKey,
        '2026-10-20T00:00:00.000Z',
      ),
    ).toBe(true);
    expect(await entitlements.get(h.db, ws.workspaceId, key)).toMatchObject({ consumed: 1 });
  });

  it('BILL-248 the resolver gives the scheduler the key from a workspace and an instant alone', async () => {
    const source = {
      async findSubscriptionForWorkspace() {
        return { currentPeriodEnd: PERIOD_END };
      },
    };
    const resolved = await resolveAllowancePeriodKey(source, {
      workspaceId: ws.workspaceId,
      atIso: RUN_CREATED_AT,
      environment: 'test' as const,
    });
    expect(resolved).toEqual({ key: PERIOD_KEY, reason: 'resolved' });
  });

  it('BILL-249 a workspace with no subscription resolves to no key rather than an invented one', async () => {
    const none = await resolveAllowancePeriodKey(
      {
        async findSubscriptionForWorkspace() {
          return null;
        },
      },
      { workspaceId: ws.workspaceId, atIso: RUN_CREATED_AT, environment: 'test' },
    );
    expect(none).toEqual({ key: null, reason: 'no_subscription' });

    const noEnd = await resolveAllowancePeriodKey(
      {
        async findSubscriptionForWorkspace() {
          return { currentPeriodEnd: null };
        },
      },
      { workspaceId: ws.workspaceId, atIso: RUN_CREATED_AT, environment: 'test' },
    );
    expect(noEnd).toEqual({ key: null, reason: 'no_period_end' });
  });
});

describe('the key function itself', () => {
  it('BILL-250 inside the current period, both entry points agree by construction', () => {
    for (const at of [
      '2026-09-19T09:00:00.001Z',
      '2026-09-30T23:59:59.999Z',
      '2026-10-19T08:59:59.999Z',
    ]) {
      expect(allowancePeriodKeyAt(at, PERIOD_END)).toBe(allowancePeriodKey(PERIOD_END));
    }
  });

  it('BILL-251 a period is half-open: the end instant already belongs to the next one', () => {
    // Stripe's period is [start, end), and `current_period_end` is the instant the NEXT
    // period begins — it is the same number as the next period's start. So a run at
    // exactly the end belongs to the next period, and one millisecond earlier does not.
    // I asserted the opposite first; the implementation was right and the assertion wrong.
    expect(allowancePeriodKeyAt('2026-10-19T08:59:59.999Z', PERIOD_END)).toBe('2026-10-19');
    expect(allowancePeriodKeyAt(PERIOD_END, PERIOD_END)).toBe('2026-11-19');
  });

  it('BILL-252 a 31st anchor clamps into short months instead of drifting into the next', () => {
    // Stripe does the same: 31 Jan, 28 Feb, 31 Mar — never 3 March. A drifting boundary
    // would silently move a customer's renewal date.
    const anchor = '2027-01-31T12:00:00.000Z';
    expect(allowancePeriodKeyAt('2027-01-15T00:00:00.000Z', anchor)).toBe('2027-01-31');
    expect(allowancePeriodKeyAt('2027-02-10T00:00:00.000Z', anchor)).toBe('2027-02-28');
    expect(allowancePeriodKeyAt('2027-03-10T00:00:00.000Z', anchor)).toBe('2027-03-31');
    expect(allowancePeriodKeyAt('2027-04-10T00:00:00.000Z', anchor)).toBe('2027-04-30');
  });

  it('BILL-253 a 29 February anchor survives a non-leap year', () => {
    const anchor = '2028-02-29T00:00:00.000Z';
    expect(allowancePeriodKeyAt('2029-02-10T00:00:00.000Z', anchor)).toBe('2029-02-28');
  });

  it('BILL-254 it walks backwards across a year boundary without drifting', () => {
    const anchor = '2027-03-19T09:00:00.000Z';
    expect(allowancePeriodKeyAt('2026-12-25T00:00:00.000Z', anchor)).toBe('2027-01-19');
    expect(allowancePeriodKeyAt('2026-11-01T00:00:00.000Z', anchor)).toBe('2026-11-19');
  });

  it('BILL-255 a calendar-month string is refused as an allowance key', () => {
    expect(isAllowancePeriodKey('2026-10-19')).toBe(true);
    expect(isAllowancePeriodKey('2026-10')).toBe(false);
    expect(() => allowancePeriodKey('2026-10')).toThrow(TypeError);
  });

  it('BILL-256 a nonsense instant is refused rather than silently keyed', () => {
    expect(() => allowancePeriodKeyAt('not a date', PERIOD_END)).toThrow(TypeError);
    expect(() => allowancePeriodKeyAt(RUN_CREATED_AT, 'not a date')).toThrow(TypeError);
  });
});
