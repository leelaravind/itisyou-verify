/**
 * Plain-language reasons — plan §16.7.
 *
 * Rules for every sentence in this file:
 *   - Say what we actually know, and what we do not.
 *   - Never imply a failure we have not evidenced, and never imply a pass we have not proven.
 *   - Never blame the customer for our own outage, and never blame a provider for a rule
 *     the customer wrote.
 *   - "Pending" is not an explanation. "We could not reach HubSpot, so this check is
 *     unverified rather than failed" is.
 *   - Offer a next step only where one genuinely exists. A next step that does nothing is
 *     worse than silence.
 */
import type { AssertionStatus, ReasonCode, RunStatus } from '@verify/contracts';
import type { AssertionResult } from './evaluate.js';

export interface ReasonExplanation {
  readonly code: ReasonCode;
  /** One honest sentence about what we found. */
  readonly sentence: string;
  /** What the customer can actually do, or null when there is nothing useful to suggest. */
  readonly next_step: string | null;
}

/**
 * Every reason code, exhaustively. The `Record<ReasonCode, …>` type means adding a code to
 * the contract will not compile until it has an honest sentence here.
 */
const REASON_TEXT: Record<ReasonCode, { sentence: string; next_step: string | null }> = {
  MATCHED: {
    sentence:
      'We retrieved this from the connected system and it matches what you asked us to check.',
    next_step: null,
  },
  VALUE_MISMATCH: {
    sentence:
      'We retrieved this from the connected system and the value is not the one your rule expects.',
    next_step:
      'Compare the expected and observed values below; if the rule is the thing that is out of date, edit the check.',
  },
  RECORD_NOT_FOUND: {
    sentence: 'We searched the connected CRM and it has no record carrying this enquiry reference.',
    next_step:
      'Check that your automation writes the correlation reference onto the record it creates.',
  },
  RECORD_AMBIGUOUS: {
    sentence:
      'More than one CRM record carries this enquiry reference, so we cannot tell which one your automation created. We will not guess.',
    next_step: 'Make the correlation reference unique per enquiry, then re-run the check.',
  },
  RECORD_WRONG_ACCOUNT: {
    sentence:
      'The record we were pointed at belongs to a different provider account from the one connected here.',
    next_step:
      'Connect the account that actually holds these records, or point the automation at the connected account.',
  },
  EVENT_NOT_OBSERVED: {
    sentence: 'We asked the email provider for events on this message and it reported none.',
    next_step:
      'Check that your automation actually sent the acknowledgement, and that it used the connected sending account.',
  },
  STATUS_NOT_REACHED: {
    sentence:
      'The email provider has not reported the delivery state your rule requires. Being accepted for sending, opened or clicked is not the same as being delivered.',
    next_step:
      'If this keeps happening for one recipient domain, that domain is likely rejecting or delaying your mail.',
  },
  OUTSIDE_TIME_WINDOW: {
    sentence:
      'We found the evidence, but its own timestamp falls outside the window your rule allows.',
    next_step:
      'Widen the window if the automation is meant to take longer, or look at what is delaying it.',
  },
  EVIDENCE_UNAVAILABLE: {
    sentence:
      'We could not retrieve the evidence this check needs, so it is unverified rather than failed.',
    next_step: 'Nothing to do yet. We will look again while the completion window is open.',
  },
  EVIDENCE_NOT_RETURNED: {
    sentence:
      'The connected system answered us, but its answer did not include this field, so there was nothing for us to check against.',
    next_step:
      'Check that the connected account is allowed to read this field, and that the field is actually in use.',
  },
  CLAIM_NOT_INDEPENDENT: {
    sentence:
      'The only account of this came from your own automation. We are not doubting it — we simply check everything against the connected systems ourselves, and a system telling us about its own work is not something we can count as proof either way.',
    next_step:
      'Make sure the connected account can see the record or message involved, so the next check can confirm this independently.',
  },
  CONNECTION_UNAVAILABLE: {
    sentence:
      'We could not reach the connected system, so this check is unverified rather than failed. We are not saying your automation went wrong; we are saying we could not look.',
    next_step:
      'Reconnect the provider from the Connections page if it is showing as expired or missing permission.',
  },
  DEADLINE_PASSED: {
    sentence: 'The agreed completion window closed before we could confirm this check.',
    next_step:
      'If your automation legitimately takes longer than this, raise the completion window for this workflow.',
  },
  AWAITING_EVIDENCE: {
    sentence: 'We have not received the evidence for this check yet.',
    next_step: 'Nothing to do yet. We will look again while the completion window is open.',
  },
  CORRELATION_MISSING: {
    sentence:
      'The record we found does not carry the enquiry reference we use to tie it to this enquiry.',
    next_step:
      'Set the correlation property on the record your automation creates so we can match it with confidence.',
  },
  RULE_UNSUPPORTED: {
    sentence:
      'This check is configured in a way we cannot evaluate, so we have not judged it either way.',
    next_step: 'Edit the check: its field, operator and expected value do not fit together.',
  },
};

export function explainReasonCode(code: ReasonCode): ReasonExplanation {
  const text = REASON_TEXT[code];
  return { code, sentence: text.sentence, next_step: text.next_step };
}

const ASSERTION_LEAD: Record<AssertionStatus, string> = {
  SUPPORTED: 'Confirmed',
  CONTRADICTED: 'Not as expected',
  UNKNOWN: 'Could not confirm',
  PENDING: 'Still checking',
};

export interface AssertionExplanation {
  readonly rule_id: string;
  readonly headline: string;
  readonly sentence: string;
  readonly next_step: string | null;
  readonly detail: string | null;
}

/** A customer-facing explanation of one assertion result. */
export function explainAssertion(result: AssertionResult): AssertionExplanation {
  const reason = explainReasonCode(result.reason_code);
  const detail =
    result.observed_display === null
      ? `We expected ${result.expected_display}. We did not retrieve a value.`
      : `We expected ${result.expected_display}. We observed ${result.observed_display}.`;
  return {
    rule_id: result.rule_id,
    headline: `${ASSERTION_LEAD[result.status]}: ${result.label}`,
    sentence: reason.sentence,
    next_step: result.status === 'SUPPORTED' ? null : reason.next_step,
    detail,
  };
}

export interface RunExplanation {
  readonly status: RunStatus;
  readonly headline: string;
  readonly sentence: string;
  readonly next_step: string | null;
}

const RUN_TEXT: Record<
  RunStatus,
  { headline: string; sentence: string; next_step: string | null }
> = {
  VERIFIED: {
    headline: 'Verified',
    sentence: 'We independently retrieved evidence for every required check and all of it matched.',
    next_step: null,
  },
  FAILED: {
    headline: 'Failed',
    sentence: 'We retrieved the evidence and it contradicts at least one of your required checks.',
    next_step:
      'Open the checks below to see exactly which one, what we expected and what we found.',
  },
  UNVERIFIED: {
    headline: 'Unverified',
    sentence:
      'We could not get enough evidence to say either way. This is not a failure — it means we could not look, or what we could see was not conclusive.',
    next_step:
      'Check the connection status for the provider named below; if it is healthy, no action is needed.',
  },
  PENDING: {
    headline: 'Still checking',
    sentence:
      'The agreed completion window is still open, so we are continuing to look for evidence.',
    next_step: null,
  },
};

export function explainRunStatus(status: RunStatus): RunExplanation {
  const text = RUN_TEXT[status];
  return { status, headline: text.headline, sentence: text.sentence, next_step: text.next_step };
}

/** Everything a report page needs for one run, in plain language. */
export function explainRun(
  status: RunStatus,
  results: readonly AssertionResult[],
): { run: RunExplanation; assertions: readonly AssertionExplanation[] } {
  return { run: explainRunStatus(status), assertions: results.map(explainAssertion) };
}
