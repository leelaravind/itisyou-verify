import { describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import {
  BASE_BACKOFF_SECONDS,
  DEADLINE_GRACE_SECONDS,
  MAX_EXTERNAL_CALLS_PER_RUN,
  backoffSeconds,
  maxExternalCallsPerRun,
  planNextObservation,
  planNextRetry,
} from '@verify/domain';
import { T_DEADLINE, T_EVENT, dateAfter, makeGap } from '../../fixtures/index.js';

const BASE = {
  observationCount: 0,
  deadlineAt: T_DEADLINE,
  now: T_EVENT,
  attemptsUsed: 0,
} as const;

function secondsFromNow(at: Date, now: Date): number {
  return Math.round((at.getTime() - now.getTime()) / 1000);
}

describe('planNextObservation', () => {
  it('VERIFY-138 schedules the first re-check inside the completion window', () => {
    const plan = planNextObservation({ ...BASE });
    expect(plan.nextCheckAt).not.toBeNull();
    expect(plan.nextCheckAt!.getTime()).toBeGreaterThan(T_EVENT.getTime());
    expect(plan.nextCheckAt!.getTime()).toBeLessThanOrEqual(T_DEADLINE.getTime());
  });

  it('VERIFY-139 backs off exponentially as observations are spent', () => {
    const first = planNextObservation({ ...BASE, observationCount: 0, jitterSeed: 0.5 });
    const second = planNextObservation({ ...BASE, observationCount: 1, jitterSeed: 0.5 });
    const third = planNextObservation({ ...BASE, observationCount: 2, jitterSeed: 0.5, deadlineAt: dateAfter(T_EVENT, 3600) });
    expect(secondsFromNow(first.nextCheckAt!, T_EVENT)).toBe(BASE_BACKOFF_SECONDS);
    expect(secondsFromNow(second.nextCheckAt!, T_EVENT)).toBe(BASE_BACKOFF_SECONDS * 2);
    expect(secondsFromNow(third.nextCheckAt!, T_EVENT)).toBe(BASE_BACKOFF_SECONDS * 4);
  });

  it('VERIFY-140 applies jitter within a bounded spread and never below the floor', () => {
    const low = backoffSeconds(0, 0);
    const mid = backoffSeconds(0, 0.5);
    const high = backoffSeconds(0, 0.999);
    expect(low).toBe(Math.round(BASE_BACKOFF_SECONDS * 0.8));
    expect(mid).toBe(BASE_BACKOFF_SECONDS);
    expect(high).toBeLessThanOrEqual(Math.round(BASE_BACKOFF_SECONDS * 1.2));
    expect(low).toBeLessThan(high);
  });

  it('VERIFY-141 is deterministic: identical inputs produce an identical schedule', () => {
    const a = planNextObservation({ ...BASE, observationCount: 1, attemptsUsed: 2 });
    const b = planNextObservation({ ...BASE, observationCount: 1, attemptsUsed: 2 });
    expect(a.nextCheckAt?.toISOString()).toBe(b.nextCheckAt?.toISOString());
  });

  it('VERIFY-142 honours a provider Retry-After as a floor, not a ceiling', () => {
    const plan = planNextObservation({ ...BASE, retryAfterSeconds: 120, jitterSeed: 0.5 });
    expect(secondsFromNow(plan.nextCheckAt!, T_EVENT)).toBe(120);
    expect(plan.reason).toContain('asked us to wait');
  });

  it('VERIFY-143 a Retry-After shorter than the backoff does not shorten the wait', () => {
    const plan = planNextObservation({ ...BASE, retryAfterSeconds: 5, jitterSeed: 0.5 });
    expect(secondsFromNow(plan.nextCheckAt!, T_EVENT)).toBe(BASE_BACKOFF_SECONDS);
  });

  it('VERIFY-144 stops scheduling once the observation budget is spent', () => {
    const plan = planNextObservation({ ...BASE, observationCount: LIMITS.MAX_OBSERVATIONS_PER_RUN });
    expect(plan.nextCheckAt).toBeNull();
    expect(plan.reason).toContain('every check it is allowed');
  });

  it('VERIFY-145 stops scheduling once the run is decided', () => {
    const plan = planNextObservation({ ...BASE, decided: true });
    expect(plan.nextCheckAt).toBeNull();
    expect(plan.reason).toContain('final result');
  });

  it('VERIFY-146 stops scheduling when the connector problem cannot be fixed by retrying', () => {
    for (const code of ['AUTH_EXPIRED', 'PERMISSION_MISSING', 'UNSUPPORTED_CAPABILITY']) {
      const plan = planNextObservation({
        ...BASE,
        lastGap: makeGap({ code, retryable: false }),
      });
      expect(plan.nextCheckAt).toBeNull();
    }
  });

  it('VERIFY-147 keeps retrying a transient provider outage', () => {
    const plan = planNextObservation({
      ...BASE,
      lastGap: makeGap({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    });
    expect(plan.nextCheckAt).not.toBeNull();
  });

  it('VERIFY-148 never schedules a check beyond the deadline plus its grace', () => {
    // Four minutes of backoff left with five seconds of window remaining.
    const plan = planNextObservation({ ...BASE, observationCount: 3, now: dateAfter(T_DEADLINE, -5) });
    expect(plan.nextCheckAt).toBeNull();
    expect(plan.reason).toContain('after the completion window');
  });

  it('VERIFY-149 allows a final check that lands inside the grace period', () => {
    const plan = planNextObservation({
      ...BASE,
      now: dateAfter(T_DEADLINE, -20),
      jitterSeed: 0,
    });
    expect(plan.nextCheckAt).not.toBeNull();
    expect(plan.nextCheckAt!.getTime()).toBeLessThanOrEqual(
      T_DEADLINE.getTime() + DEADLINE_GRACE_SECONDS * 1000,
    );
  });

  it('VERIFY-150 stops entirely once the grace period has passed', () => {
    const plan = planNextObservation({ ...BASE, now: dateAfter(T_DEADLINE, DEADLINE_GRACE_SECONDS + 1) });
    expect(plan.nextCheckAt).toBeNull();
    expect(plan.reason).toContain('completion window has closed');
  });

  it('VERIFY-151 the budget check wins even when a Retry-After asks for another attempt', () => {
    const plan = planNextObservation({
      ...BASE,
      observationCount: LIMITS.MAX_OBSERVATIONS_PER_RUN,
      retryAfterSeconds: 1,
    });
    expect(plan.nextCheckAt).toBeNull();
  });
});

describe('planNextRetry', () => {
  it('VERIFY-152 schedules a bounded transport retry inside one observation', () => {
    const plan = planNextRetry({ attemptsUsed: 0, now: T_EVENT, jitterSeed: 0.5 });
    expect(plan.nextAttemptAt).not.toBeNull();
    expect(secondsFromNow(plan.nextAttemptAt!, T_EVENT)).toBe(1);
  });

  it('VERIFY-153 the transport retry budget is capped per observation', () => {
    const plan = planNextRetry({
      attemptsUsed: LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION,
      now: T_EVENT,
    });
    expect(plan.nextAttemptAt).toBeNull();
    expect(plan.reason).toContain('used its transport retries');
  });

  it('VERIFY-154 a terminal connector problem stops the retry loop immediately', () => {
    const plan = planNextRetry({
      attemptsUsed: 0,
      now: T_EVENT,
      lastGap: makeGap({ code: 'PERMISSION_MISSING', retryable: false }),
    });
    expect(plan.nextAttemptAt).toBeNull();
  });

  it('VERIFY-155 a transport retry honours Retry-After as a floor', () => {
    const plan = planNextRetry({ attemptsUsed: 0, now: T_EVENT, retryAfterSeconds: 45, jitterSeed: 0.5 });
    expect(secondsFromNow(plan.nextAttemptAt!, T_EVENT)).toBe(45);
  });
});

describe('nested budgets', () => {
  it('VERIFY-156 exhausting the retry budget never buys an extra observation', () => {
    const plan = planNextObservation({
      ...BASE,
      observationCount: LIMITS.MAX_OBSERVATIONS_PER_RUN,
      attemptsUsed: LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION,
    });
    expect(plan.nextCheckAt).toBeNull();
  });

  it('VERIFY-157 the total external-call ceiling is observations times (one attempt plus its retries)', () => {
    expect(MAX_EXTERNAL_CALLS_PER_RUN).toBe(
      LIMITS.MAX_OBSERVATIONS_PER_RUN * (1 + LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION),
    );
    expect(maxExternalCallsPerRun()).toBe(MAX_EXTERNAL_CALLS_PER_RUN);
    expect(MAX_EXTERNAL_CALLS_PER_RUN).toBe(16);
  });

  it('VERIFY-158 driving the scheduler to exhaustion cannot exceed the proven call ceiling', () => {
    // Simulate the worst case: every provider call fails transiently, forever, and the
    // deadline is generous enough never to intervene. The budgets alone must stop us.
    const deadlineAt = dateAfter(T_EVENT, LIMITS.MAX_DEADLINE_SECONDS);
    const gap = makeGap({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    let now = T_EVENT;
    let observationCount = 0;
    let externalCalls = 0;
    let observationsStarted = 0;
    let guard = 0;

    for (;;) {
      guard += 1;
      if (guard > 1000) throw new Error('the scheduler failed to terminate');

      // One observation: the initial call plus its bounded transport retries.
      observationsStarted += 1;
      externalCalls += 1;
      let attemptsUsed = 0;
      for (;;) {
        const retry = planNextRetry({ attemptsUsed, now, lastGap: gap });
        if (retry.nextAttemptAt === null) break;
        attemptsUsed += 1;
        externalCalls += 1;
        now = retry.nextAttemptAt;
      }
      observationCount += 1;

      const plan = planNextObservation({ observationCount, deadlineAt, now, attemptsUsed, lastGap: gap });
      if (plan.nextCheckAt === null) break;
      now = plan.nextCheckAt;
    }

    expect(observationsStarted).toBe(LIMITS.MAX_OBSERVATIONS_PER_RUN);
    expect(externalCalls).toBe(MAX_EXTERNAL_CALLS_PER_RUN);
    expect(externalCalls).toBeLessThanOrEqual(MAX_EXTERNAL_CALLS_PER_RUN);
  });

  it('VERIFY-159 a decided run is terminal for the scheduler regardless of remaining budget', () => {
    const plan = planNextObservation({ ...BASE, observationCount: 0, attemptsUsed: 0, decided: true });
    expect(plan.nextCheckAt).toBeNull();
  });
});
