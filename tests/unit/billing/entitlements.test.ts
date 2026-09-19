/**
 * Allowance arithmetic.
 *
 * The behaviour these lock down is the one the customer feels: a run is either admitted
 * and paid for, or refused with a reason — never silently charged twice, and never
 * charged again for work they already bought.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import {
  admissionDecision,
  allowanceView,
  atAllowance,
  consume,
  release,
  remainingRuns,
  reserve,
  rollover,
  type AllowanceSnapshot,
} from '@app/billing/entitlements';

const fresh: AllowanceSnapshot = { runLimit: 500, consumed: 0, reserved: 0 };
const exhausted: AllowanceSnapshot = { runLimit: 500, consumed: 499, reserved: 1 };

describe('allowance arithmetic', () => {
  it('BILL-037 remaining is limit minus consumed minus reserved', () => {
    expect(remainingRuns({ runLimit: 500, consumed: 120, reserved: 3 })).toBe(377);
  });

  it('BILL-038 remaining never goes negative even if the counters drift', () => {
    expect(remainingRuns({ runLimit: 10, consumed: 9, reserved: 4 })).toBe(0);
  });

  it('BILL-039 reserving takes exactly one unit and consumes nothing', () => {
    const result = reserve(fresh);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.next).toEqual({ runLimit: 500, consumed: 0, reserved: 1 });
  });

  it('BILL-040 reserving at the allowance fails rather than going negative', () => {
    expect(reserve(exhausted)).toEqual({ ok: false, reason: 'at_allowance' });
  });

  it('BILL-041 a terminal run turns its reservation into a consumption', () => {
    const result = consume({ runLimit: 500, consumed: 4, reserved: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.next).toEqual({ runLimit: 500, consumed: 5, reserved: 1 });
  });

  it('BILL-042 consuming without a reservation held is refused, not fudged', () => {
    expect(consume(fresh)).toEqual({ ok: false, reason: 'no_reservation_held' });
  });

  it('BILL-043 releasing hands the unit back and never increments consumed', () => {
    const result = release({ runLimit: 500, consumed: 7, reserved: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.next).toEqual({ runLimit: 500, consumed: 7, reserved: 0 });
  });

  it('BILL-044 releasing without a reservation held is refused', () => {
    expect(release(fresh)).toEqual({ ok: false, reason: 'no_reservation_held' });
  });

  it('BILL-045 negative counters are rejected rather than arithmetic-ed over', () => {
    expect(reserve({ runLimit: 500, consumed: -1, reserved: 0 })).toEqual({
      ok: false,
      reason: 'invalid_snapshot',
    });
  });

  it('BILL-046 a period rollover resets both counters and keeps the plan allowance', () => {
    expect(rollover(LIMITS.PLAN_RUNS_PER_PERIOD)).toEqual({
      runLimit: 500,
      consumed: 0,
      reserved: 0,
    });
  });

  it('BILL-047 a rollover cannot be opened with a nonsense limit', () => {
    expect(() => rollover(-1)).toThrow(TypeError);
    expect(() => rollover(1.5)).toThrow(TypeError);
  });

  it('BILL-048 at the allowance the workspace reads as exhausted', () => {
    expect(atAllowance(exhausted)).toBe(true);
    expect(atAllowance(fresh)).toBe(false);
  });
});

describe('admission', () => {
  it('BILL-049 a new run with allowance left is admitted and reserves a unit', () => {
    expect(admissionDecision(fresh, 'new_run')).toEqual({
      admit: true,
      reserves: true,
      reason: 'allowance_available',
    });
  });

  it('BILL-050 a new run at the allowance is refused with no overage charge', () => {
    expect(admissionDecision(exhausted, 'new_run')).toEqual({
      admit: false,
      reserves: false,
      reason: 'at_allowance',
    });
  });

  it('BILL-051 a queue retry is never a fresh billable run, even at the allowance', () => {
    const decision = admissionDecision(exhausted, 'queue_retry');
    expect(decision.admit).toBe(true);
    expect(decision.reserves).toBe(false);
  });

  it('BILL-052 a provider callback is never a fresh billable run', () => {
    const decision = admissionDecision(exhausted, 'provider_callback');
    expect(decision.admit).toBe(true);
    expect(decision.reserves).toBe(false);
  });

  it('BILL-053 internal error recovery is never a fresh billable run', () => {
    const decision = admissionDecision(exhausted, 'internal_recovery');
    expect(decision.admit).toBe(true);
    expect(decision.reserves).toBe(false);
  });
});

describe('what the customer is shown', () => {
  it('BILL-054 the view reports used, in flight, remaining and a whole-number percentage', () => {
    expect(allowanceView({ runLimit: 500, consumed: 120, reserved: 5 })).toEqual({
      runLimit: 500,
      used: 120,
      inFlight: 5,
      remaining: 375,
      atAllowance: false,
      percentUsed: 25,
    });
  });

  it('BILL-055 an exhausted allowance reads as 100 per cent and zero remaining', () => {
    expect(allowanceView(exhausted)).toMatchObject({
      remaining: 0,
      atAllowance: true,
      percentUsed: 100,
    });
  });

  it('BILL-056 the plan allowance comes from the frozen contract, not from a literal', () => {
    expect(rollover(LIMITS.PLAN_RUNS_PER_PERIOD).runLimit).toBe(LIMITS.PLAN_RUNS_PER_PERIOD);
  });
});
