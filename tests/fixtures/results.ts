/**
 * Builders for assertion results and run revisions, so decision-table and state-machine
 * tests do not have to go through the evaluator to construct an evidence state.
 */
import type { AssertionResult, RunRevision } from '@verify/domain';
import type { AssertionStatus, ReasonCode } from '@verify/contracts';
import { T_DEADLINE, T_EVENT, isoAfter } from './time.js';

export function makeResult(overrides: Partial<AssertionResult> = {}): AssertionResult {
  return {
    rule_id: 'rule_1',
    label: 'A required check',
    mandatory: true,
    status: 'SUPPORTED',
    reason_code: 'MATCHED',
    expected_display: 'present',
    observed_display: 'crm-rec-1',
    observed_at: isoAfter(T_EVENT, 30),
    evidence_ref: 'crm_record:hubspot:crm-rec-1',
    ...overrides,
  };
}

/** Shorthand: a mandatory result with a given status and reason. */
export function mandatoryResult(
  rule_id: string,
  status: AssertionStatus,
  reason_code: ReasonCode,
): AssertionResult {
  return makeResult({ rule_id, status, reason_code, mandatory: true });
}

/** Shorthand: an optional result, which must never change an outcome. */
export function optionalResult(
  rule_id: string,
  status: AssertionStatus,
  reason_code: ReasonCode,
): AssertionResult {
  return makeResult({ rule_id, status, reason_code, mandatory: false });
}

export function makeRunRevision(overrides: Partial<RunRevision> = {}): RunRevision {
  return {
    run_id: 'run-1',
    revision: 1,
    status: 'UNVERIFIED',
    reason: 'The deadline passed with some required checks still unproven.',
    results: [mandatoryResult('rule_1', 'UNKNOWN', 'AWAITING_EVIDENCE')],
    rules_ref: 'wf-1@v3',
    rules_schema_version: 1,
    occurred_at: T_EVENT.toISOString(),
    deadline_at: T_DEADLINE.toISOString(),
    observed_at: isoAfter(T_EVENT, 600),
    decided_at: isoAfter(T_EVENT, 600),
    late_observation: false,
    late_completion: false,
    supersedes_revision: null,
    ...overrides,
  };
}
