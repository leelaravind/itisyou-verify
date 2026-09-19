import { describe, expect, it } from 'vitest';
import { AppError, type RunStatus } from '@verify/contracts';
import {
  applyLateEvidence,
  detectLateCompletion,
  isTerminalRunStatus,
  nextRunState,
  RUN_EVENT,
  type RunEvent,
} from '@verify/domain';
import {
  T_AFTER_DEADLINE,
  T_DEADLINE,
  T_EVENT,
  T_INSIDE_WINDOW,
  dateAfter,
  isoAfter,
  makeResult,
  makeRunRevision,
  mandatoryResult,
} from '../../fixtures/index.js';

const TERMINALS: RunStatus[] = ['VERIFIED', 'FAILED', 'UNVERIFIED'];

describe('nextRunState', () => {
  it('VERIFY-116 an observation inside the window leaves the run pending', () => {
    expect(nextRunState('PENDING', 'OBSERVATION_RECORDED')).toBe('PENDING');
  });

  it('VERIFY-117 a pending run moves to VERIFIED when every mandatory check is supported', () => {
    expect(nextRunState('PENDING', 'MANDATORY_SUPPORTED')).toBe('VERIFIED');
  });

  it('VERIFY-118 a pending run moves to FAILED on a mandatory contradiction', () => {
    expect(nextRunState('PENDING', 'MANDATORY_CONTRADICTED')).toBe('FAILED');
  });

  it('VERIFY-119 a pending run moves to UNVERIFIED when the evidence was inconclusive', () => {
    expect(nextRunState('PENDING', 'EVIDENCE_INCONCLUSIVE')).toBe('UNVERIFIED');
  });

  it('VERIFY-120 a decided run is never rewritten by a later decision event', () => {
    for (const terminal of TERMINALS) {
      for (const event of RUN_EVENT) {
        if (event === 'LATE_EVIDENCE_OBSERVED') continue;
        expect(() => nextRunState(terminal, event)).toThrowError(AppError);
      }
    }
  });

  it('VERIFY-121 an illegal transition throws a typed 409, not a bare Error', () => {
    try {
      nextRunState('VERIFIED', 'MANDATORY_CONTRADICTED');
      throw new Error('expected a typed error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).httpStatus).toBe(409);
      expect((error as AppError).code).toBe('ILLEGAL_RUN_TRANSITION');
    }
  });

  it('VERIFY-122 late evidence leaves a terminal state exactly as it was', () => {
    for (const terminal of TERMINALS) {
      expect(nextRunState(terminal, 'LATE_EVIDENCE_OBSERVED')).toBe(terminal);
    }
  });

  it('VERIFY-123 a pending run has no decision for late evidence to supersede', () => {
    expect(() => nextRunState('PENDING', 'LATE_EVIDENCE_OBSERVED')).toThrowError(AppError);
  });

  it('VERIFY-124 only the three decided statuses are terminal', () => {
    expect(isTerminalRunStatus('PENDING')).toBe(false);
    for (const terminal of TERMINALS) expect(isTerminalRunStatus(terminal)).toBe(true);
  });

  it('VERIFY-125 an unrecognised event is rejected rather than silently ignored', () => {
    expect(() => nextRunState('PENDING', 'NOT_AN_EVENT' as RunEvent)).toThrowError(AppError);
  });
});

describe('applyLateEvidence', () => {
  const originalResults = [mandatoryResult('email_delivered', 'UNKNOWN', 'AWAITING_EVIDENCE')];

  it('VERIFY-126 late evidence cannot be applied to a run that has not been decided', () => {
    const run = makeRunRevision({ status: 'PENDING' });
    expect(() => applyLateEvidence(run, originalResults, { now: T_AFTER_DEADLINE })).toThrowError(
      AppError,
    );
  });

  it('VERIFY-127 evidence that changes nothing reports no change and leaves the original standing', () => {
    const run = makeRunRevision({ status: 'UNVERIFIED', results: originalResults });
    const outcome = applyLateEvidence(run, originalResults, { now: T_AFTER_DEADLINE });
    expect(outcome.changed).toBe(false);
    expect(outcome.revision).toBeNull();
    expect(outcome.reason).toContain('original decision still stands');
  });

  it('VERIFY-128 a late delivery event after a terminal state creates a new revision', () => {
    const run = makeRunRevision({ status: 'UNVERIFIED', results: originalResults });
    const later = [mandatoryResult('email_delivered', 'SUPPORTED', 'MATCHED')];
    const outcome = applyLateEvidence(run, later, { now: T_AFTER_DEADLINE });
    expect(outcome.changed).toBe(true);
    expect(outcome.revision?.status).toBe('VERIFIED');
    expect(outcome.revision?.revision).toBe(2);
    expect(outcome.revision?.supersedes_revision).toBe(1);
  });

  it('VERIFY-129 the original revision is preserved untouched, including its status and timing', () => {
    const run = makeRunRevision({ status: 'UNVERIFIED', results: originalResults });
    const snapshot = JSON.parse(JSON.stringify(run)) as unknown;
    applyLateEvidence(run, [mandatoryResult('email_delivered', 'SUPPORTED', 'MATCHED')], {
      now: T_AFTER_DEADLINE,
    });
    expect(JSON.parse(JSON.stringify(run))).toEqual(snapshot);
    expect(run.status).toBe('UNVERIFIED');
    expect(run.decided_at).toBe(isoAfter(T_EVENT, 600));
  });

  it('VERIFY-130 the new revision references the same rule set the original was judged against', () => {
    const run = makeRunRevision({
      status: 'UNVERIFIED',
      rules_ref: 'wf-1@v7',
      rules_schema_version: 1,
    });
    const outcome = applyLateEvidence(run, [mandatoryResult('rule_1', 'SUPPORTED', 'MATCHED')], {
      now: T_AFTER_DEADLINE,
    });
    expect(outcome.revision?.rules_ref).toBe('wf-1@v7');
    expect(outcome.revision?.rules_schema_version).toBe(1);
    expect(outcome.revision?.deadline_at).toBe(run.deadline_at);
    expect(outcome.revision?.occurred_at).toBe(run.occurred_at);
  });

  it('VERIFY-131 looking late is recorded as a late observation, not as a late completion', () => {
    const run = makeRunRevision({ status: 'UNVERIFIED' });
    const onTime = [
      makeResult({ rule_id: 'rule_1', status: 'SUPPORTED', observed_at: isoAfter(T_EVENT, 120) }),
    ];
    const outcome = applyLateEvidence(run, onTime, { now: T_AFTER_DEADLINE });
    expect(outcome.revision?.late_observation).toBe(true);
    expect(outcome.revision?.late_completion).toBe(false);
  });

  it('VERIFY-132 a provider event whose own timestamp missed the deadline is a late completion', () => {
    const run = makeRunRevision({ status: 'UNVERIFIED' });
    const lateWork = [
      makeResult({ rule_id: 'rule_1', status: 'SUPPORTED', observed_at: isoAfter(T_EVENT, 900) }),
    ];
    const outcome = applyLateEvidence(run, lateWork, { now: T_AFTER_DEADLINE });
    expect(outcome.revision?.late_completion).toBe(true);
    expect(outcome.revision?.late_observation).toBe(true);
  });

  it('VERIFY-133 a late completion is recognised even when we happened to look on time', () => {
    const run = makeRunRevision({ status: 'FAILED' });
    const lateWork = [
      makeResult({ rule_id: 'rule_1', status: 'SUPPORTED', observed_at: isoAfter(T_EVENT, 900) }),
    ];
    const outcome = applyLateEvidence(run, lateWork, { now: T_INSIDE_WINDOW });
    expect(outcome.revision?.late_observation).toBe(false);
    expect(outcome.revision?.late_completion).toBe(true);
  });

  it('VERIFY-134 late evidence that contradicts a previously verified run produces a FAILED revision', () => {
    const run = makeRunRevision({
      status: 'VERIFIED',
      results: [mandatoryResult('rule_1', 'SUPPORTED', 'MATCHED')],
    });
    const outcome = applyLateEvidence(
      run,
      [mandatoryResult('rule_1', 'CONTRADICTED', 'VALUE_MISMATCH')],
      {
        now: T_AFTER_DEADLINE,
      },
    );
    expect(outcome.revision?.status).toBe('FAILED');
    expect(run.status).toBe('VERIFIED');
  });

  it('VERIFY-135 revisions chain: a second late arrival supersedes the first revision, not the original', () => {
    const run = makeRunRevision({ status: 'UNVERIFIED' });
    const first = applyLateEvidence(run, [mandatoryResult('rule_1', 'SUPPORTED', 'MATCHED')], {
      now: T_AFTER_DEADLINE,
    });
    expect(first.revision).not.toBeNull();
    const second = applyLateEvidence(
      first.revision!,
      [mandatoryResult('rule_1', 'CONTRADICTED', 'VALUE_MISMATCH')],
      {
        now: dateAfter(T_AFTER_DEADLINE, 600),
      },
    );
    expect(second.revision?.revision).toBe(3);
    expect(second.revision?.supersedes_revision).toBe(2);
    expect(second.revision?.status).toBe('FAILED');
  });

  it('VERIFY-136 a same-status revision with different reasons is still recorded as a new revision', () => {
    const run = makeRunRevision({
      status: 'UNVERIFIED',
      results: [mandatoryResult('rule_1', 'UNKNOWN', 'CONNECTION_UNAVAILABLE')],
    });
    const outcome = applyLateEvidence(
      run,
      [mandatoryResult('rule_1', 'UNKNOWN', 'RECORD_AMBIGUOUS')],
      {
        now: T_AFTER_DEADLINE,
      },
    );
    expect(outcome.changed).toBe(true);
    expect(outcome.revision?.status).toBe('UNVERIFIED');
  });

  it('VERIFY-137 detectLateCompletion ignores results that carry no timestamp', () => {
    expect(detectLateCompletion([makeResult({ observed_at: null })], T_DEADLINE)).toBe(false);
    expect(detectLateCompletion([makeResult({ observed_at: 'nonsense' })], T_DEADLINE)).toBe(false);
    expect(
      detectLateCompletion([makeResult({ observed_at: isoAfter(T_EVENT, 601) })], T_DEADLINE),
    ).toBe(true);
    expect(
      detectLateCompletion([makeResult({ observed_at: isoAfter(T_EVENT, 600) })], T_DEADLINE),
    ).toBe(false);
  });
});
