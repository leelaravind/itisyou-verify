/**
 * `@verify/domain` — the verification engine.
 *
 * Every export here is a pure function over injected values. There is no I/O, no database
 * handle, no `fetch` and no `Date.now()` anywhere in this package. That is not stylistic:
 * it is what lets a verification result be replayed, audited and defended months later.
 */
export {
  evaluateAssertions,
  assertEvaluableRules,
  normaliseEmailAddress,
  describeExpected,
  isAuthoritativeAbsence,
  AUTHORITATIVE_ABSENCE_REASONS,
  type AssertionResult,
  type EvaluationContext,
  type RunBindings,
} from './evaluate.js';

export {
  decideRunStatus,
  summariseMandatory,
  DECISION_REASON,
  type DecisionContext,
  type RunDecision,
  type MandatorySummary,
} from './decide.js';

export {
  nextRunState,
  applyLateEvidence,
  detectLateCompletion,
  isTerminalRunStatus,
  RUN_EVENT,
  LATE_EVIDENCE_REASON,
  type RunEvent,
  type RunRevision,
  type LateEvidenceOutcome,
  type LateEvidenceContext,
} from './transitions.js';

export {
  planNextObservation,
  planNextRetry,
  backoffSeconds,
  maxExternalCallsPerRun,
  MAX_EXTERNAL_CALLS_PER_RUN,
  BASE_BACKOFF_SECONDS,
  MAX_BACKOFF_SECONDS,
  DEADLINE_GRACE_SECONDS,
  JITTER_SPREAD,
  SCHEDULE_REASON,
  RETRY_REASON,
  type ObservationPlanInput,
  type ObservationPlan,
  type RetryPlanInput,
  type RetryPlan,
} from './schedule.js';

export {
  explainReasonCode,
  explainAssertion,
  explainRunStatus,
  explainRun,
  type ReasonExplanation,
  type AssertionExplanation,
  type RunExplanation,
} from './explain.js';

export {
  describeCoverage,
  detectInactivity,
  summariseWorkflowHealth,
  coverageModeSupport,
  coverageWarningFor,
  effectiveCoverageMode,
  isCoverageModeSupported,
  COVERAGE_MODE_REQUIREMENTS,
  COVERAGE_MODE_SUPPORT,
  SELECTABLE_COVERAGE_MODES,
  SUPPORTED_COVERAGE_MODES,
  type CoverageModeRequirement,
  type CoverageModeSupport,
  type CoverageWarning,
  type CoverageDescription,
  type ExpectedActivity,
  type InactivityInput,
  type InactivityReport,
  type InactivitySeverity,
  type RunCounts,
  type WorkflowHealth,
  type WorkflowHealthState,
} from './coverage.js';
