/**
 * Automatic stop rules — plan §25.4.
 *
 * Everything here is integer arithmetic over minor units. No percentage is computed as a
 * float and compared against a cap; where a proportion is needed it is expressed as an
 * integer numerator and denominator so the comparison is exact.
 *
 * The other rule this file enforces: **a local pause flag is not proof delivery stopped.**
 * `verifyPause` returns `paused` only from a reconciled provider read or an explicit owner
 * confirmation. Everything else is `pause_pending` or `unknown`, and both are surfaced
 * rather than smoothed over.
 */
import type { CampaignState } from '@verify/contracts';

export type StopReasonCode =
  | 'allocated_exposure_reached'
  | 'allocated_exposure_approaching'
  | 'landing_page_broken'
  | 'checkout_broken'
  | 'billing_anomaly'
  | 'approval_revoked'
  | 'owner_command'
  | 'critical_incident'
  | 'spend_unknown_too_long';

export type StopSeverity = 'halt' | 'warn';

export interface StopDecision {
  readonly stop: boolean;
  readonly reason: StopReasonCode;
  readonly severity: StopSeverity;
  readonly detail: string;
  /** True when the decision rests on a metric we know is out of date. */
  readonly on_stale_evidence: boolean;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SpendSnapshot {
  /** `null` means we do not know. Never substitute zero. */
  readonly spend_minor: number | null;
  /** When the provider (or the human reading it) actually observed this figure. */
  readonly observed_at: string | null;
  /** Where the figure came from. A locally-guessed figure is not admissible. */
  readonly source: 'reconciled_provider_read' | 'owner_confirmation' | 'none';
}

export interface StopInput {
  readonly campaign_state: CampaignState;
  /** The net allocation the owner approved, integer minor units. */
  readonly allocated_minor: number;
  /** Stop-early buffer, integer minor units. Reaching `allocated - buffer` warns. */
  readonly buffer_minor: number;
  readonly spend: SpendSnapshot;
  /** An observation older than this is stale; a stop decision on it says so. */
  readonly max_metric_age_seconds: number;
  readonly landing_page_healthy: boolean;
  readonly checkout_healthy: boolean;
  /** e.g. a declined card, an unexpected currency, a charge we did not authorise. */
  readonly billing_anomaly: string | null;
  readonly approval_status: 'granted' | 'consumed' | 'expired' | 'revoked';
  readonly owner_stop_command: boolean;
  readonly critical_incident: string | null;
  readonly now: Date;
}

/**
 * Default buffer for the first experiment: stop warning at £3 of headroom on a £15
 * allocation. Integer pence, stated once, never recomputed from a percentage.
 */
export const DEFAULT_BUFFER_MINOR = 300;

/** How long we tolerate not knowing what has been spent before that itself is a stop. */
export const MAX_SPEND_UNKNOWN_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function ageSeconds(observedAt: string | null, now: Date): number | null {
  if (observedAt === null) return null;
  const parsed = Date.parse(observedAt);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((now.getTime() - parsed) / 1000);
}

export function isMetricStale(snapshot: SpendSnapshot, maxAgeSeconds: number, now: Date): boolean {
  const age = ageSeconds(snapshot.observed_at, now);
  if (age === null) return true;
  return age > maxAgeSeconds;
}

/**
 * Every stop rule, evaluated. Returns every decision that fired, most severe first, so a
 * caller can log all of them rather than only the one that happened to be checked first.
 */
export function evaluateStops(input: StopInput): readonly StopDecision[] {
  const decisions: StopDecision[] = [];
  const stale = isMetricStale(input.spend, input.max_metric_age_seconds, input.now);

  // --- owner and approval ---------------------------------------------------
  if (input.owner_stop_command) {
    decisions.push({
      stop: true,
      reason: 'owner_command',
      severity: 'halt',
      detail: 'the owner asked for this campaign to stop',
      on_stale_evidence: false,
    });
  }
  if (input.approval_status === 'revoked' || input.approval_status === 'expired') {
    decisions.push({
      stop: true,
      reason: 'approval_revoked',
      severity: 'halt',
      detail: `approval is ${input.approval_status}; nothing may keep running on it`,
      on_stale_evidence: false,
    });
  }

  // --- money ----------------------------------------------------------------
  if (
    !Number.isSafeInteger(input.allocated_minor) ||
    !Number.isSafeInteger(input.buffer_minor) ||
    input.allocated_minor < 0 ||
    input.buffer_minor < 0
  ) {
    decisions.push({
      stop: true,
      reason: 'billing_anomaly',
      severity: 'halt',
      detail: 'allocation or buffer is not a non-negative integer number of minor units',
      on_stale_evidence: false,
    });
  } else if (input.spend.spend_minor === null || input.spend.source === 'none') {
    const age = ageSeconds(input.spend.observed_at, input.now);
    if (age === null || age > MAX_SPEND_UNKNOWN_SECONDS) {
      decisions.push({
        stop: true,
        reason: 'spend_unknown_too_long',
        severity: 'halt',
        detail:
          'we do not know what this campaign has spent and have not known for too long; not knowing is not the same as zero',
        on_stale_evidence: true,
      });
    }
  } else if (!Number.isSafeInteger(input.spend.spend_minor)) {
    decisions.push({
      stop: true,
      reason: 'billing_anomaly',
      severity: 'halt',
      detail: 'reported spend is not an integer number of minor units',
      on_stale_evidence: stale,
    });
  } else if (input.spend.spend_minor < 0) {
    decisions.push({
      stop: true,
      reason: 'billing_anomaly',
      severity: 'halt',
      detail: 'reported spend is negative',
      on_stale_evidence: stale,
    });
  } else if (input.spend.spend_minor >= input.allocated_minor) {
    decisions.push({
      stop: true,
      reason: 'allocated_exposure_reached',
      severity: 'halt',
      detail: `spend ${input.spend.spend_minor} has reached the allocation ${input.allocated_minor}`,
      on_stale_evidence: stale,
    });
  } else if (input.spend.spend_minor >= input.allocated_minor - input.buffer_minor) {
    decisions.push({
      stop: true,
      reason: 'allocated_exposure_approaching',
      severity: 'warn',
      detail: `spend ${input.spend.spend_minor} is within the ${input.buffer_minor} buffer of the allocation ${input.allocated_minor}`,
      on_stale_evidence: stale,
    });
  }

  if (input.billing_anomaly !== null) {
    decisions.push({
      stop: true,
      reason: 'billing_anomaly',
      severity: 'halt',
      detail: input.billing_anomaly,
      on_stale_evidence: false,
    });
  }

  // --- the thing the click lands on ----------------------------------------
  if (!input.landing_page_healthy) {
    decisions.push({
      stop: true,
      reason: 'landing_page_broken',
      severity: 'halt',
      detail:
        'the landing page is not serving; paying for clicks into a broken page is indefensible',
      on_stale_evidence: false,
    });
  }
  if (!input.checkout_healthy) {
    decisions.push({
      stop: true,
      reason: 'checkout_broken',
      severity: 'halt',
      detail:
        'checkout is not working; we would be paying to send people to a purchase they cannot complete',
      on_stale_evidence: false,
    });
  }

  if (input.critical_incident !== null) {
    decisions.push({
      stop: true,
      reason: 'critical_incident',
      severity: 'halt',
      detail: input.critical_incident,
      on_stale_evidence: false,
    });
  }

  return decisions.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'halt' ? -1 : 1));
}

/** The first halting decision, or `null`. */
export function firstHalt(decisions: readonly StopDecision[]): StopDecision | null {
  return decisions.find((d) => d.severity === 'halt') ?? null;
}

// ---------------------------------------------------------------------------
// Pause verification
// ---------------------------------------------------------------------------

export interface PauseEvidence {
  /** We asked. Proves nothing on its own. */
  readonly pause_requested_at: string | null;
  /** What the last reconciled provider read said, if any. */
  readonly provider_state: CampaignState | null;
  readonly provider_observed_at: string | null;
  /** An explicit owner confirmation that they looked and it was paused. */
  readonly owner_confirmed_at: string | null;
  /** Two consecutive spend readings. Equal values are corroboration, not proof. */
  readonly spend_minor_previous: number | null;
  readonly spend_minor_latest: number | null;
}

export type PauseVerdict = 'paused' | 'pause_pending' | 'unknown';

export interface PauseAssessment {
  readonly verdict: PauseVerdict;
  readonly detail: string;
  /** What would move this to `paused`. Empty when it already is. */
  readonly outstanding: readonly string[];
}

/**
 * The only way to conclude `paused`.
 *
 * Not `paused`: we set a flag; we called an API that returned 200; spend happens to look
 * flat. Those are `pause_pending`. With nothing at all — no request, no read — the answer
 * is `unknown`, because we have not even asked.
 */
export function verifyPause(
  evidence: PauseEvidence,
  maxAgeSeconds: number,
  now: Date,
): PauseAssessment {
  const providerFresh =
    evidence.provider_observed_at !== null &&
    (ageSeconds(evidence.provider_observed_at, now) ?? Number.POSITIVE_INFINITY) <= maxAgeSeconds;

  if (evidence.provider_state === 'paused' && providerFresh) {
    return {
      verdict: 'paused',
      detail: 'a fresh reconciled provider read reports paused',
      outstanding: [],
    };
  }
  if (evidence.provider_state === 'ended' && providerFresh) {
    return {
      verdict: 'paused',
      detail: 'a fresh reconciled provider read reports the campaign ended',
      outstanding: [],
    };
  }
  if (evidence.owner_confirmed_at !== null) {
    return {
      verdict: 'paused',
      detail: `the owner confirmed at ${evidence.owner_confirmed_at} that the platform shows it paused`,
      outstanding: [],
    };
  }
  if (evidence.pause_requested_at === null) {
    return {
      verdict: 'unknown',
      detail:
        'no pause has been requested and no provider read exists; we do not know what this campaign is doing',
      outstanding: ['request a pause', 'reconcile against the platform'],
    };
  }

  const outstanding: string[] = [];
  if (!providerFresh) outstanding.push('a reconciled provider read newer than the pause request');
  if (evidence.provider_state !== null && evidence.provider_state !== 'paused') {
    outstanding.push(`the provider still reports ${evidence.provider_state}`);
  }
  if (
    evidence.spend_minor_previous === null ||
    evidence.spend_minor_latest === null ||
    evidence.spend_minor_previous !== evidence.spend_minor_latest
  ) {
    outstanding.push('two consecutive equal spend readings');
  }
  return {
    verdict: 'pause_pending',
    detail: `a pause was requested at ${evidence.pause_requested_at} and has not been confirmed against the platform`,
    outstanding,
  };
}

// ---------------------------------------------------------------------------
// Metric freshness
// ---------------------------------------------------------------------------

export interface StaleMarked<T> {
  readonly value: T;
  readonly stale: boolean;
  /** When the figure was retrieved. Always reported alongside the figure. */
  readonly retrieved_at: string | null;
  readonly age_seconds: number | null;
}

/** Wrap any metric with its retrieval time and a staleness flag. Never hand out a bare number. */
export function markStale<T>(
  value: T,
  retrievedAt: string | null,
  maxAgeSeconds: number,
  now: Date,
): StaleMarked<T> {
  const age = ageSeconds(retrievedAt, now);
  return {
    value,
    stale: age === null || age > maxAgeSeconds,
    retrieved_at: retrievedAt,
    age_seconds: age,
  };
}
