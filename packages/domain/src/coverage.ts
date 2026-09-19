/**
 * Coverage honesty — plan §13.3, the missing-trigger problem.
 *
 * The uncomfortable truth this module exists to state out loud: when a workflow is
 * `customer_triggered`, we only ever see the enquiries the customer's own automation tells
 * us about. If the automation stops firing, we receive nothing — and receiving nothing must
 * never render as a perfect score. A dashboard showing "100%" over zero runs is a lie that
 * the customer will only discover when it costs them a deal.
 */
import type { CoverageMode } from '@verify/contracts';

export interface CoverageDescription {
  readonly mode: CoverageMode;
  /** Whether this workflow can detect an enquiry that never reached us at all. */
  readonly can_detect_missing_runs: boolean;
  readonly headline: string;
  readonly detail: string;
  /** The honest limitation, or null when there is none worth stating. */
  readonly limitation: string | null;
}

export function describeCoverage(workflow: { readonly coverage_mode: CoverageMode }): CoverageDescription {
  if (workflow.coverage_mode === 'independently_sourced') {
    return {
      mode: 'independently_sourced',
      can_detect_missing_runs: true,
      headline: 'We find the enquiries ourselves.',
      detail:
        'We list enquiries from the connected system on our own schedule rather than waiting to be told about them, so an enquiry your automation missed entirely still shows up here.',
      limitation:
        'We can only see enquiries the connected account can see. Anything outside that account is outside our view.',
    };
  }
  return {
    mode: 'customer_triggered',
    can_detect_missing_runs: false,
    headline: 'We check the enquiries your automation tells us about.',
    detail:
      'Your automation sends us an event for each enquiry, and we then verify it against the connected systems independently.',
    limitation:
      'If your automation stops sending events, we receive nothing — and nothing is not the same as everything passing. Watch the activity warning below, not the pass rate.',
  };
}

export interface ExpectedActivity {
  /** How long a quiet period may last before it is worth mentioning. */
  readonly window_seconds: number;
  /** How many runs you would normally expect inside that window. */
  readonly minimum_events: number;
}

export interface InactivityInput {
  readonly lastEventAt: Date | null;
  readonly expectedActivity: ExpectedActivity;
  readonly now: Date;
  /** Runs actually received inside the window, when the caller has counted them. */
  readonly eventsInWindow?: number;
}

export type InactivitySeverity = 'none' | 'warning';

export interface InactivityReport {
  readonly inactive: boolean;
  readonly severity: InactivitySeverity;
  readonly seconds_since_last_event: number | null;
  readonly headline: string;
  readonly detail: string;
}

/**
 * A distinct inactivity signal, deliberately separate from the pass rate. Silence is its own
 * finding; it is never folded into a percentage where it would disappear.
 */
export function detectInactivity(input: InactivityInput): InactivityReport {
  const { expectedActivity, now } = input;

  if (input.lastEventAt === null) {
    return {
      inactive: true,
      severity: 'warning',
      seconds_since_last_event: null,
      headline: 'No enquiries received yet',
      detail:
        'We have never received an enquiry for this workflow. Until one arrives there is nothing to verify, and no result here should be read as a pass.',
    };
  }

  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - input.lastEventAt.getTime()) / 1000));

  if (elapsedSeconds > expectedActivity.window_seconds) {
    return {
      inactive: true,
      severity: 'warning',
      seconds_since_last_event: elapsedSeconds,
      headline: 'No enquiries for longer than expected',
      detail:
        `We expected at least ${expectedActivity.minimum_events} enquiry event${expectedActivity.minimum_events === 1 ? '' : 's'} ` +
        `every ${expectedActivity.window_seconds} seconds, and we have had none for ${elapsedSeconds}. ` +
        'Either your business is quiet or your automation has stopped telling us. We cannot tell which from here.',
    };
  }

  if (input.eventsInWindow !== undefined && input.eventsInWindow < expectedActivity.minimum_events) {
    return {
      inactive: true,
      severity: 'warning',
      seconds_since_last_event: elapsedSeconds,
      headline: 'Fewer enquiries than expected',
      detail:
        `We received ${input.eventsInWindow} enquiry event${input.eventsInWindow === 1 ? '' : 's'} in the last ` +
        `${expectedActivity.window_seconds} seconds, against an expectation of at least ${expectedActivity.minimum_events}. ` +
        'Missing events are not visible as failures, so this warning is the only sign of them.',
    };
  }

  return {
    inactive: false,
    severity: 'none',
    seconds_since_last_event: elapsedSeconds,
    headline: 'Receiving enquiries as expected',
    detail: `The most recent enquiry reached us ${elapsedSeconds} seconds ago.`,
  };
}

export interface RunCounts {
  readonly verified: number;
  readonly failed: number;
  readonly unverified: number;
  readonly pending: number;
}

export type WorkflowHealthState =
  | 'no_runs_received'
  | 'awaiting_first_result'
  | 'healthy'
  | 'attention'
  | 'degraded';

export interface WorkflowHealth {
  readonly state: WorkflowHealthState;
  readonly total_runs: number;
  /** Runs that have reached a terminal status. The percentage's denominator. */
  readonly decided_runs: number;
  /** Null whenever there is nothing to compute a percentage from. Never 100 from zero. */
  readonly verified_percentage: number | null;
  readonly headline: string;
  readonly detail: string;
}

/**
 * Summarise a workflow's health without ever inventing a score.
 *
 * Zero runs is its own state with a null percentage, not 100%. Runs that are all still
 * pending are their own state too: an undecided run is not a passing run.
 */
export function summariseWorkflowHealth(counts: RunCounts): WorkflowHealth {
  const total = counts.verified + counts.failed + counts.unverified + counts.pending;
  const decided = counts.verified + counts.failed + counts.unverified;

  if (total === 0) {
    return {
      state: 'no_runs_received',
      total_runs: 0,
      decided_runs: 0,
      verified_percentage: null,
      headline: 'No runs received yet',
      detail:
        'There is nothing to score. An empty workflow is not a passing workflow — if you expected enquiries by now, your automation may not be reaching us.',
    };
  }

  if (decided === 0) {
    return {
      state: 'awaiting_first_result',
      total_runs: total,
      decided_runs: 0,
      verified_percentage: null,
      headline: 'Waiting for the first result',
      detail: `${total} run${total === 1 ? ' is' : 's are'} still inside the completion window, so there is no pass rate yet.`,
    };
  }

  const percentage = Math.round((counts.verified / decided) * 100);

  if (counts.failed > 0) {
    return {
      state: 'degraded',
      total_runs: total,
      decided_runs: decided,
      verified_percentage: percentage,
      headline: `${counts.failed} run${counts.failed === 1 ? '' : 's'} failed`,
      detail: `${percentage}% of decided runs were verified. Failed runs are ones where the evidence contradicted a required check.`,
    };
  }

  if (counts.unverified > 0) {
    return {
      state: 'attention',
      total_runs: total,
      decided_runs: decided,
      verified_percentage: percentage,
      headline: `${counts.unverified} run${counts.unverified === 1 ? '' : 's'} could not be verified`,
      detail: `${percentage}% of decided runs were verified. The rest are unverified, which means we could not get the evidence — not that your automation failed.`,
    };
  }

  return {
    state: 'healthy',
    total_runs: total,
    decided_runs: decided,
    verified_percentage: percentage,
    headline: 'All decided runs verified',
    detail: `${decided} run${decided === 1 ? '' : 's'} decided, all with independent supporting evidence.`,
  };
}
