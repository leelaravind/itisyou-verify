/**
 * Coverage honesty — plan §13.3, the missing-trigger problem.
 *
 * The uncomfortable truth this module exists to state out loud: when a workflow is
 * `customer_triggered`, we only ever see the enquiries the customer's own automation tells
 * us about. If the automation stops firing, we receive nothing — and receiving nothing must
 * never render as a perfect score. A dashboard showing "100%" over zero runs is a lie that
 * the customer will only discover when it costs them a deal.
 *
 * ---------------------------------------------------------------------------
 * `independently_sourced` IS NOT IMPLEMENTED, AND MUST NOT BE OFFERED
 * ---------------------------------------------------------------------------
 * This module used to describe `independently_sourced` as though it worked. It does not.
 * No connector can enumerate records it was never told about — HubSpot's adapter has three
 * read operations and the closest, `contact_search`, answers "is this specific record
 * there", never "what exists that nobody mentioned". No scheduler pass lists anything.
 *
 * That made it the worst defect this product could ship: not a wrong display of real data,
 * but a promised capability with nothing behind it, sold to customers whose whole reason
 * for buying is that silence should not be mistaken for success.
 *
 * So the mode stays in the contract — it is a real planned capability — and is marked
 * unsupported here, as *data* the onboarding UI reads rather than a comment somebody has
 * to remember. `describeCoverage` degrades an unsupported mode to the coverage we actually
 * have and attaches a warning that cannot be rendered away. `COVERAGE_MODE_REQUIREMENTS`
 * states what would have to exist first, so the test that binds those requirements to real
 * connector capabilities and real scheduler passes fails the moment a claim drifts ahead of
 * its implementation again.
 */
import type { CoverageMode } from '@verify/contracts';

/**
 * What a coverage mode needs before it can honestly be offered.
 *
 * Deliberately expressed as plain strings rather than imported types: this package is pure
 * and depends on nothing but the contracts. The binding to real connector capabilities and
 * real scheduler passes happens in the test, which is exactly where a drift between claim
 * and implementation should be caught.
 */
export interface CoverageModeRequirement {
  readonly mode: CoverageMode;
  /**
   * A connector capability flag that must be true on at least one adapter, or null when the
   * mode needs nothing from a connector.
   */
  readonly connector_capability: string | null;
  /** The scheduler pass that would have to exist to deliver this mode. */
  readonly scheduler_pass: string;
}

export const COVERAGE_MODE_REQUIREMENTS: Readonly<Record<CoverageMode, CoverageModeRequirement>> = {
  customer_triggered: {
    mode: 'customer_triggered',
    // Nothing beyond receiving the customer's own events and verifying them independently.
    connector_capability: null,
    scheduler_pass: 'due_job',
  },
  independently_sourced: {
    mode: 'independently_sourced',
    // No adapter declares this, because no adapter can do it. It is not a flag somebody
    // forgot to set; there is no operation behind it.
    connector_capability: 'can_enumerate_records',
    scheduler_pass: 'enumeration',
  },
};

export interface CoverageModeSupport {
  readonly mode: CoverageMode;
  /** True when code exists that actually delivers this mode. */
  readonly supported: boolean;
  /** True when onboarding may offer it. Never true while `supported` is false. */
  readonly selectable: boolean;
  /** Why it cannot be offered, in words a customer would understand. Null when it can. */
  readonly unavailable_reason: string | null;
  /** What would have to be built first. For the roadmap, not for the customer. */
  readonly requires: readonly string[];
}

export const COVERAGE_MODE_SUPPORT: Readonly<Record<CoverageMode, CoverageModeSupport>> = {
  customer_triggered: {
    mode: 'customer_triggered',
    supported: true,
    selectable: true,
    unavailable_reason: null,
    requires: [],
  },
  independently_sourced: {
    mode: 'independently_sourced',
    supported: false,
    selectable: false,
    unavailable_reason:
      'We cannot offer this yet. It would mean listing enquiries out of your connected system ourselves, and we have not built that — so choosing it would mean promising to spot enquiries your automation never reported while having no way to see them.',
    requires: [
      'a connector operation that enumerates records we were never told about',
      'a scheduler pass that reconciles what we enumerated against the runs we received',
    ],
  },
};

/** The modes onboarding may offer. A05 reads this instead of listing the enum. */
export const SELECTABLE_COVERAGE_MODES: readonly CoverageMode[] = Object.values(
  COVERAGE_MODE_SUPPORT,
)
  .filter((support) => support.selectable)
  .map((support) => support.mode);

/** The modes anything in the system can actually deliver. */
export const SUPPORTED_COVERAGE_MODES: readonly CoverageMode[] = Object.values(
  COVERAGE_MODE_SUPPORT,
)
  .filter((support) => support.supported)
  .map((support) => support.mode);

export function coverageModeSupport(mode: CoverageMode): CoverageModeSupport {
  return COVERAGE_MODE_SUPPORT[mode];
}

export function isCoverageModeSupported(mode: CoverageMode): boolean {
  return COVERAGE_MODE_SUPPORT[mode].supported;
}

/** The coverage we actually deliver for a requested mode. Never stronger than the truth. */
export function effectiveCoverageMode(requested: CoverageMode): CoverageMode {
  return isCoverageModeSupported(requested) ? requested : 'customer_triggered';
}

/**
 * A coverage claim that outran its implementation.
 *
 * Returned wherever an unsupported mode is encountered, so it cannot be handled silently.
 * `severity` is `critical` on purpose: a workflow configured for coverage we do not have is
 * not a cosmetic problem, it is a customer being told that silence is safe.
 */
export interface CoverageWarning {
  readonly code: 'COVERAGE_MODE_UNSUPPORTED';
  readonly severity: 'critical';
  readonly requested_mode: CoverageMode;
  readonly effective_mode: CoverageMode;
  readonly headline: string;
  readonly detail: string;
}

export function coverageWarningFor(requested: CoverageMode): CoverageWarning | null {
  if (isCoverageModeSupported(requested)) return null;
  return {
    code: 'COVERAGE_MODE_UNSUPPORTED',
    severity: 'critical',
    requested_mode: requested,
    effective_mode: effectiveCoverageMode(requested),
    headline: 'This workflow asks for coverage we do not have',
    detail:
      'It is set to have us find enquiries ourselves, which we have not built. We are only checking the enquiries your automation reports, so an enquiry that never reached us will not show up here as a problem. Treat a quiet period as unexplained, not as clean.',
  };
}

export interface CoverageDescription {
  /** The coverage actually in force. Never the unimplemented one. */
  readonly mode: CoverageMode;
  /** What the workflow asked for, which may differ from what we can do. */
  readonly requested_mode: CoverageMode;
  /** False when the requested mode is not implemented and we degraded to what is. */
  readonly supported: boolean;
  /** Whether this workflow can detect an enquiry that never reached us at all. */
  readonly can_detect_missing_runs: boolean;
  readonly headline: string;
  readonly detail: string;
  /** The honest limitation, or null when there is none worth stating. */
  readonly limitation: string | null;
  /** Non-null exactly when the requested mode is not implemented. Render it. */
  readonly warning: CoverageWarning | null;
}

/**
 * Describe a workflow's coverage, truthfully.
 *
 * An unsupported mode never gets its own description — it gets the description of the
 * coverage we actually provide, plus a warning saying so. While `independently_sourced` is
 * unsupported there is no argument to this function that produces the sentence "We find the
 * enquiries ourselves."
 */
export function describeCoverage(workflow: {
  readonly coverage_mode: CoverageMode;
}): CoverageDescription {
  const requested = workflow.coverage_mode;
  const warning = coverageWarningFor(requested);

  if (effectiveCoverageMode(requested) === 'independently_sourced') {
    return {
      mode: 'independently_sourced',
      requested_mode: requested,
      supported: true,
      can_detect_missing_runs: true,
      headline: 'We find the enquiries ourselves.',
      detail:
        'We list enquiries from the connected system on our own schedule rather than waiting to be told about them, so an enquiry your automation missed entirely still shows up here.',
      limitation:
        'We can only see enquiries the connected account can see. Anything outside that account is outside our view.',
      warning: null,
    };
  }

  return {
    mode: 'customer_triggered',
    requested_mode: requested,
    supported: warning === null,
    can_detect_missing_runs: false,
    headline: 'We check the enquiries your automation tells us about.',
    detail:
      'Your automation sends us an event for each enquiry, and we then verify it against the connected systems independently.',
    limitation:
      'If your automation stops sending events, we receive nothing — and nothing is not the same as everything passing. Watch the activity warning below, not the pass rate.',
    warning,
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

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - input.lastEventAt.getTime()) / 1000),
  );

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

  if (
    input.eventsInWindow !== undefined &&
    input.eventsInWindow < expectedActivity.minimum_events
  ) {
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
  'no_runs_received' | 'awaiting_first_result' | 'healthy' | 'attention' | 'degraded';

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

  /*
   * Floored, never rounded to nearest. 199 verified of 200 decided is 99.5%, and
   * `Math.round` made it the integer 100 — which the workspace page then printed as
   * "100%" and drew as a completely full bar (`meter__fill--100`), for a workflow with a
   * run that failed. This is the same defect as the 33%-drawn-as-100% meter and the
   * 499-of-500 usage figure, one layer further up: a partial result rendered as a
   * complete one. A figure that errs mean is survivable here; one that errs generous is
   * the exact lie the product exists to refuse. 100 is only ever reached when every
   * decided run really was verified.
   */
  const percentage = Math.floor((counts.verified / decided) * 100);

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
