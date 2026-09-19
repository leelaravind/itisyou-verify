/**
 * The run state machine — plan §16.5.
 *
 * A terminal run is an audit record. It is never rewritten. When evidence arrives after a
 * run has been decided we publish a *new revision* that references the rules it was judged
 * against, and the earlier revision keeps its status, its reason and its timing exactly as
 * the customer saw them.
 *
 * Two different kinds of "late" are kept apart on purpose:
 *   - **late observation** — we looked after the deadline. Our latency, not the customer's.
 *   - **late completion**  — the provider event's own timestamp is after the deadline. The
 *     automation genuinely finished late.
 * Collapsing these two would let our own slowness be reported as a customer's missed SLA.
 */
import { AppError, type RunStatus } from '@verify/contracts';
import type { AssertionResult } from './evaluate.js';
import { decideRunStatus, type DecisionContext } from './decide.js';

export const RUN_EVENT = [
  /** An observation completed and the run is still inside its window. */
  'OBSERVATION_RECORDED',
  /** Every mandatory assertion is supported. */
  'MANDATORY_SUPPORTED',
  /** A mandatory assertion is contradicted. */
  'MANDATORY_CONTRADICTED',
  /** The run resolved without sufficient evidence either way. */
  'EVIDENCE_INCONCLUSIVE',
  /** Evidence arrived for a run that is already decided. Never mutates; creates a revision. */
  'LATE_EVIDENCE_OBSERVED',
] as const;
export type RunEvent = (typeof RUN_EVENT)[number];

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['VERIFIED', 'FAILED', 'UNVERIFIED']);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The only legal state changes. Anything else throws rather than silently correcting itself —
 * a state machine that quietly accepts an impossible transition hides the bug that caused it.
 */
export function nextRunState(current: RunStatus, event: RunEvent): RunStatus {
  if (current === 'PENDING') {
    switch (event) {
      case 'OBSERVATION_RECORDED':
        return 'PENDING';
      case 'MANDATORY_SUPPORTED':
        return 'VERIFIED';
      case 'MANDATORY_CONTRADICTED':
        return 'FAILED';
      case 'EVIDENCE_INCONCLUSIVE':
        return 'UNVERIFIED';
      case 'LATE_EVIDENCE_OBSERVED':
        throw illegal(current, event, 'a run that is still pending has no decision to supersede');
      default:
        throw illegal(current, event, 'unknown event');
    }
  }

  // Terminal. The only thing that may happen is the arrival of late evidence, and even that
  // leaves this revision exactly as it is; the caller records a new revision instead.
  if (event === 'LATE_EVIDENCE_OBSERVED') return current;
  throw illegal(current, event, 'a decided run is an audit record and is never rewritten');
}

function illegal(current: RunStatus, event: RunEvent, why: string): AppError {
  return new AppError(
    409,
    'ILLEGAL_RUN_TRANSITION',
    `This verification result cannot change from ${current} in response to ${event}: ${why}.`,
  );
}

/** One immutable decision about a run. A run is an ordered list of these. */
export interface RunRevision {
  readonly run_id: string;
  /** 1 for the first decision, incrementing for every superseding revision. */
  readonly revision: number;
  readonly status: RunStatus;
  readonly reason: string;
  readonly results: readonly AssertionResult[];
  /** Identifier of the exact rule set this revision was judged against. */
  readonly rules_ref: string;
  readonly rules_schema_version: number;
  /** ISO-8601 UTC. When the business event happened. */
  readonly occurred_at: string;
  /** ISO-8601 UTC. The agreed completion deadline. */
  readonly deadline_at: string;
  /** ISO-8601 UTC. When we looked and produced this revision. */
  readonly observed_at: string;
  /** ISO-8601 UTC. When this revision's status was settled. */
  readonly decided_at: string;
  /** We looked after the deadline. Our latency. */
  readonly late_observation: boolean;
  /** The provider event's own timestamp is after the deadline. The work finished late. */
  readonly late_completion: boolean;
  /** The revision this one supersedes, or null for the first. */
  readonly supersedes_revision: number | null;
}

export type LateEvidenceOutcome =
  | { readonly changed: false; readonly reason: string; readonly revision: null }
  | { readonly changed: true; readonly reason: string; readonly revision: RunRevision };

export interface LateEvidenceContext {
  readonly now: Date;
  /** Defaults to true: late evidence that reached us implies the source answered. */
  readonly hasWorkingEvidenceAccess?: boolean;
}

export const LATE_EVIDENCE_REASON = {
  UNCHANGED: 'Later evidence did not change this result, so the original decision still stands.',
  SUPERSEDED:
    'Later evidence changed this result, so a new revision was recorded alongside the original.',
} as const;

/** True when any result's own provider timestamp falls after the deadline. */
export function detectLateCompletion(
  results: readonly AssertionResult[],
  deadlineAt: Date,
): boolean {
  const deadlineMs = deadlineAt.getTime();
  return results.some((r) => {
    if (r.observed_at === null) return false;
    const ms = Date.parse(r.observed_at);
    return !Number.isNaN(ms) && ms > deadlineMs;
  });
}

function sameVerdicts(a: readonly AssertionResult[], b: readonly AssertionResult[]): boolean {
  if (a.length !== b.length) return false;
  const index = new Map(a.map((r) => [r.rule_id, r] as const));
  return b.every((r) => {
    const prior = index.get(r.rule_id);
    return prior !== undefined && prior.status === r.status && prior.reason_code === r.reason_code;
  });
}

/**
 * Apply evidence that arrived after a run was decided.
 *
 * Returns either "no change" — the original revision stands untouched — or a brand new
 * revision that supersedes it. The original object is never mutated and its `decided_at`,
 * `observed_at` and `status` are preserved for the audit trail.
 */
export function applyLateEvidence(
  run: RunRevision,
  newResults: readonly AssertionResult[],
  ctx: LateEvidenceContext,
): LateEvidenceOutcome {
  if (!isTerminalRunStatus(run.status)) {
    throw new AppError(
      409,
      'ILLEGAL_RUN_TRANSITION',
      'Late evidence can only supersede a decided run; this run has not been decided yet.',
    );
  }
  // Proves the event is legal for this state and keeps the machine the single authority.
  nextRunState(run.status, 'LATE_EVIDENCE_OBSERVED');

  const deadlineAt = new Date(run.deadline_at);
  const decisionCtx: DecisionContext = {
    deadlineAt,
    now: ctx.now,
    hasWorkingEvidenceAccess: ctx.hasWorkingEvidenceAccess ?? true,
    // A decided run never gets more observations; the late evidence is what it is.
    observationsRemaining: 0,
  };
  const decision = decideRunStatus(newResults, decisionCtx);

  if (decision.status === run.status && sameVerdicts(run.results, newResults)) {
    return { changed: false, reason: LATE_EVIDENCE_REASON.UNCHANGED, revision: null };
  }

  const revision: RunRevision = {
    run_id: run.run_id,
    revision: run.revision + 1,
    status: decision.status,
    reason: decision.reason,
    results: [...newResults],
    rules_ref: run.rules_ref,
    rules_schema_version: run.rules_schema_version,
    occurred_at: run.occurred_at,
    deadline_at: run.deadline_at,
    observed_at: ctx.now.toISOString(),
    decided_at: ctx.now.toISOString(),
    late_observation: ctx.now.getTime() > deadlineAt.getTime(),
    late_completion: detectLateCompletion(newResults, deadlineAt),
    supersedes_revision: run.revision,
  };

  return { changed: true, reason: LATE_EVIDENCE_REASON.SUPERSEDED, revision };
}
