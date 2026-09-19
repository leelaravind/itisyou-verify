/**
 * The aggregate decision table — plan §16.4.
 *
 * | Evidence state                                              | Before deadline | At/after deadline |
 * | ----------------------------------------------------------- | --------------- | ----------------- |
 * | All mandatory supported                                      | VERIFIED        | VERIFIED          |
 * | Any mandatory contradicted                                   | FAILED          | FAILED            |
 * | Mandatory unknown, evidence source healthy                   | PENDING         | FAILED only if absence was authoritatively established, else UNVERIFIED |
 * | Provider inaccessible / permission missing / ambiguous match | PENDING         | UNVERIFIED        |
 * | Some pass, others unknown                                    | PENDING         | UNVERIFIED unless a mandatory failure already exists |
 *
 * There is no majority vote anywhere in this file. One contradicted mandatory assertion is
 * a failure no matter how many others passed. Optional assertions are never consulted.
 */
import { AppError, type RunStatus } from '@verify/contracts';
import { isAuthoritativeAbsence, type AssertionResult } from './evaluate.js';

export interface DecisionContext {
  /** The agreed completion deadline for this run. */
  readonly deadlineAt: Date;
  /** Wall clock at decision time, injected. */
  readonly now: Date;
  /**
   * True when every evidence source we needed answered us this observation. False when a
   * connector was unreachable, unauthorised, rate limited or returned an ambiguous match.
   */
  readonly hasWorkingEvidenceAccess: boolean;
  /** Observations still available inside the run's budget. Zero means we cannot look again. */
  readonly observationsRemaining: number;
}

export interface RunDecision {
  readonly status: RunStatus;
  /** A plain sentence, safe to show a customer. */
  readonly reason: string;
}

export const DECISION_REASON = {
  VERIFIED: 'Every required check has independent supporting evidence.',
  FAILED_CONTRADICTED: 'At least one required check is contradicted by the evidence we retrieved.',
  FAILED_ABSENT:
    'The deadline passed and the connected systems confirmed the expected record or message does not exist.',
  PENDING_WINDOW: 'The agreed completion window is still open, so we are still looking.',
  PENDING_ACCESS:
    'We could not reach a connected system yet. We will try again inside the completion window.',
  UNVERIFIED_ACCESS:
    'We could not retrieve the evidence needed to judge this run, so it is unverified rather than failed.',
  UNVERIFIED_INCOMPLETE:
    'The deadline passed with some required checks still unproven, so this run is unverified rather than failed.',
  UNVERIFIED_BUDGET:
    'We used every observation allowed for this run without proving the required checks, so it is unverified.',
} as const;

const UNRESOLVED: ReadonlySet<AssertionResult['status']> = new Set(['UNKNOWN', 'PENDING']);

/**
 * Decide a run's aggregate status from its assertion results.
 *
 * Throws `AppError(422)` when the results contain no mandatory assertion: an empty mandatory
 * set is a configuration error, and answering VERIFIED to "did anything have to be true?"
 * would be the single worst bug this product could ship.
 */
export function decideRunStatus(
  results: readonly AssertionResult[],
  ctx: DecisionContext,
): RunDecision {
  const mandatory = results.filter((r) => r.mandatory);
  if (mandatory.length === 0) {
    throw new AppError(
      422,
      'WORKFLOW_RULES_INVALID',
      'This run has no required checks, so it cannot be verified. Mark at least one check as required.',
    );
  }

  // 1. A definitive mandatory contradiction ends the question, before or after the deadline,
  //    regardless of how many other checks passed. No majority vote.
  if (mandatory.some((r) => r.status === 'CONTRADICTED')) {
    return { status: 'FAILED', reason: DECISION_REASON.FAILED_CONTRADICTED };
  }

  // 2. VERIFIED requires *every* mandatory assertion to be SUPPORTED. Success is never
  //    inferred from the absence of a contradiction.
  if (mandatory.every((r) => r.status === 'SUPPORTED')) {
    return { status: 'VERIFIED', reason: DECISION_REASON.VERIFIED };
  }

  const unresolved = mandatory.filter((r) => UNRESOLVED.has(r.status));
  const beforeDeadline = ctx.now.getTime() < ctx.deadlineAt.getTime();
  const canLookAgain = ctx.observationsRemaining > 0;

  // 3. Inside the window with budget left, the honest answer is "not yet".
  if (beforeDeadline && canLookAgain) {
    return {
      status: 'PENDING',
      reason: ctx.hasWorkingEvidenceAccess
        ? DECISION_REASON.PENDING_WINDOW
        : DECISION_REASON.PENDING_ACCESS,
    };
  }

  // 4. The run must resolve: either the deadline passed, or the observation budget is spent
  //    and waiting longer cannot change what we know.
  if (!ctx.hasWorkingEvidenceAccess) {
    return { status: 'UNVERIFIED', reason: DECISION_REASON.UNVERIFIED_ACCESS };
  }

  // The observation budget ran out while the window was still open. Absence is not yet a
  // failure — the record could still be created before the deadline — so this resolves as
  // unverified, never as failed.
  if (beforeDeadline) {
    return { status: 'UNVERIFIED', reason: DECISION_REASON.UNVERIFIED_BUDGET };
  }

  // The deadline has passed and evidence access is healthy. A connector that authoritatively
  // established absence — it asked the provider and the provider said the record or message
  // does not exist — is the only route from "unknown" to "failed".
  if (unresolved.length > 0 && unresolved.every((r) => isAuthoritativeAbsence(r.reason_code))) {
    return { status: 'FAILED', reason: DECISION_REASON.FAILED_ABSENT };
  }

  return { status: 'UNVERIFIED', reason: DECISION_REASON.UNVERIFIED_INCOMPLETE };
}

/** Convenience for reporting: counts that never include optional assertions in the outcome. */
export interface MandatorySummary {
  readonly total: number;
  readonly supported: number;
  readonly contradicted: number;
  readonly unresolved: number;
  readonly optional_total: number;
}

export function summariseMandatory(results: readonly AssertionResult[]): MandatorySummary {
  const mandatory = results.filter((r) => r.mandatory);
  return {
    total: mandatory.length,
    supported: mandatory.filter((r) => r.status === 'SUPPORTED').length,
    contradicted: mandatory.filter((r) => r.status === 'CONTRADICTED').length,
    unresolved: mandatory.filter((r) => UNRESOLVED.has(r.status)).length,
    optional_total: results.length - mandatory.length,
  };
}
