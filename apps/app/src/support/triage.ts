/**
 * Deterministic support triage.
 *
 * **No model is involved, and none may be.** Triage decides how urgently a person hears
 * about a customer's problem, and whether money, deletion or a security report goes
 * straight to the owner. Engineering rule 9 — model output can never decide access
 * rights, charges or refunds — applies here in full. This file runs identically with the
 * assistant switched off, which is its default state.
 *
 * The design is a fixed, ordered rule table over a fixed taxonomy. It is deliberately
 * blunt:
 *
 *  - It matches on words a customer actually types, not on inferred intent.
 *  - Where two categories match, the more serious one wins and the conflict is recorded.
 *  - Where nothing matches, the answer is not "other, low priority". It is **escalate**,
 *    because a message we cannot categorise is a message whose customer impact we do not
 *    understand, and guessing low is how a serious problem sits unread for a week.
 *
 * Escalation is a typed decision carrying a reason. There is no free-text "seems
 * important" anywhere in this file.
 */
import type { SupportCategory, SupportCaseState, SupportPriority } from './port';

export const ESCALATION_REASON = [
  'billing_dispute_needs_a_person',
  'deletion_request_needs_a_person',
  'security_report_needs_a_person',
  'cancellation_must_not_be_delayed',
  'customer_impact_unclear',
  'conflicting_signals',
] as const;
export type EscalationReason = (typeof ESCALATION_REASON)[number];

export interface TriageInput {
  readonly subject: string;
  /** The already-redacted body. Triage never sees the raw text. */
  readonly bodyRedacted: string;
  /** Null for a signed-out submission. */
  readonly workspaceId: string | null;
  /** Set when the submitter named a run. Raises confidence, never lowers priority. */
  readonly linkedRunId?: string | null;
}

export interface TriageDecision {
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  readonly escalate: boolean;
  readonly escalationReason: EscalationReason | null;
  /** Where the case starts. `escalated` when `escalate` is true — never both ways round. */
  readonly initialState: SupportCaseState;
  /** Exactly which rule ids fired, so a triage decision can be argued with. */
  readonly matchedRules: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* the rule table                                                             */
/* -------------------------------------------------------------------------- */

interface Rule {
  readonly id: string;
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  /**
   * Higher wins when several rules match. Deliberately sparse so inserting a rule between
   * two existing ones does not require renumbering the table.
   */
  readonly severity: number;
  readonly escalationReason: EscalationReason | null;
  /** Lowercased phrases. A phrase matches on a word boundary, not a substring. */
  readonly phrases: readonly string[];
}

/**
 * Ordered by severity, highest first, for readability. `triage` does not rely on the
 * array order — it compares `severity` — so the table can be reordered safely.
 */
const RULES: readonly Rule[] = [
  {
    id: 'security_report',
    category: 'security_report',
    priority: 'urgent',
    severity: 100,
    escalationReason: 'security_report_needs_a_person',
    phrases: [
      'vulnerability',
      'vulnerabilities',
      'security issue',
      'security problem',
      'security report',
      'exploit',
      'xss',
      'csrf',
      'sql injection',
      'injection',
      'idor',
      'data breach',
      'breach',
      'leaked',
      'leak',
      'exposed',
      'responsible disclosure',
      'penetration test',
      'someone else',
      "another customer's",
      'not my data',
      'saw data',
    ],
  },
  {
    id: 'billing_dispute',
    category: 'billing_dispute',
    priority: 'urgent',
    severity: 90,
    escalationReason: 'billing_dispute_needs_a_person',
    phrases: [
      'charged twice',
      'double charged',
      'overcharged',
      'wrong amount',
      'unauthorised',
      'unauthorized',
      'chargeback',
      'dispute',
      'disputed',
      'refund',
      'i want my money back',
      'money back',
      'fraud',
      'did not authorise',
      'did not authorize',
      'should not have been charged',
      'still being charged',
      'charged after',
    ],
  },
  {
    id: 'data_deletion',
    category: 'data_deletion',
    priority: 'high',
    severity: 80,
    escalationReason: 'deletion_request_needs_a_person',
    phrases: [
      'delete my data',
      'delete my account',
      'delete our data',
      'delete everything',
      'erase my data',
      'erasure',
      'right to be forgotten',
      'remove my data',
      'remove my account',
      'wipe',
      'gdpr request',
      'data subject request',
      'close my account',
    ],
  },
  {
    id: 'cancellation',
    category: 'cancellation',
    priority: 'high',
    severity: 70,
    escalationReason: 'cancellation_must_not_be_delayed',
    phrases: [
      'cancel',
      'cancellation',
      'cancel my subscription',
      'stop my subscription',
      'end my subscription',
      'unsubscribe',
      'stop billing',
      'do not renew',
      "don't renew",
    ],
  },
  {
    id: 'data_export',
    category: 'data_export',
    priority: 'normal',
    severity: 60,
    escalationReason: null,
    phrases: [
      'export my data',
      'export our data',
      'data export',
      'download my data',
      'copy of my data',
      'subject access',
      'send me my data',
    ],
  },
  {
    id: 'connection_problem',
    category: 'connection_problem',
    priority: 'high',
    severity: 50,
    escalationReason: null,
    phrases: [
      'reconnect',
      'disconnected',
      'connection expired',
      'cannot connect',
      "can't connect",
      'authorisation expired',
      'authorization expired',
      'oauth',
      'token expired',
      'lost access',
      'permission denied',
      'hubspot connection',
      'resend connection',
    ],
  },
  {
    id: 'unexpected_result',
    category: 'unexpected_result',
    priority: 'normal',
    severity: 40,
    escalationReason: null,
    phrases: [
      'unverified',
      'wrong result',
      'should be verified',
      'says failed',
      'marked failed',
      'false failure',
      'false pass',
      'incorrect status',
      'result is wrong',
      'why is this failing',
    ],
  },
  {
    id: 'billing_question',
    category: 'billing_question',
    priority: 'normal',
    severity: 30,
    escalationReason: null,
    phrases: [
      'invoice',
      'vat',
      'receipt',
      'billing address',
      'payment method',
      'change my card',
      'how much',
      'price',
      'pricing',
      'tax',
    ],
  },
  {
    id: 'setup_help',
    category: 'setup_help',
    priority: 'normal',
    severity: 20,
    escalationReason: null,
    phrases: [
      'how do i set up',
      'how do i connect',
      'getting started',
      'onboarding',
      'correlation',
      'signed event',
      'webhook',
      'first workflow',
      'set up a workflow',
      'where do i',
    ],
  },
  {
    id: 'feature_request',
    category: 'feature_request',
    priority: 'low',
    severity: 10,
    escalationReason: null,
    phrases: [
      'feature request',
      'would be great if',
      'do you support',
      'will you support',
      'roadmap',
      'salesforce',
      'pipedrive',
      'mailgun',
      'sendgrid',
      'any plans to',
    ],
  },
];

/** Exported so the owner queue can show what triage is actually looking for. */
export const TRIAGE_RULE_IDS: readonly string[] = RULES.map((r) => r.id);

/* -------------------------------------------------------------------------- */
/* matching                                                                   */
/* -------------------------------------------------------------------------- */

/** Collapse punctuation and whitespace so phrase matching is not defeated by formatting. */
function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = ` ${phrase
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  if (needle.trim().length === 0) return false;
  return haystack.includes(needle);
}

/* -------------------------------------------------------------------------- */
/* triage                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Categorise, prioritise and decide escalation. Pure, total and deterministic: the same
 * input always produces the same decision, with no clock, no randomness and no network.
 */
export function triage(input: TriageInput): TriageDecision {
  const haystack = normalise(`${input.subject} ${input.bodyRedacted}`);

  const matched = RULES.filter((rule) =>
    rule.phrases.some((phrase) => containsPhrase(haystack, phrase)),
  );

  if (matched.length === 0) {
    // The important branch. We do not understand this message, so we do not get to
    // decide it is unimportant.
    return {
      category: 'other',
      priority: 'normal',
      escalate: true,
      escalationReason: 'customer_impact_unclear',
      initialState: 'escalated',
      matchedRules: [],
    };
  }

  const winner = matched.reduce((best, rule) => (rule.severity > best.severity ? rule : best));

  const matchedRules = matched.map((r) => r.id);

  // Two serious-but-different things in one message: a refund demand inside a security
  // report, a deletion request inside a billing dispute. A person reads that, not a rule.
  const seriousMatches = matched.filter((r) => r.escalationReason !== null);
  const conflicting =
    seriousMatches.length > 1 && seriousMatches.some((r) => r.category !== winner.category);

  const escalationReason: EscalationReason | null = conflicting
    ? 'conflicting_signals'
    : winner.escalationReason;

  const escalate = escalationReason !== null;

  // A conflict is never quieter than the loudest thing in it.
  const priority: SupportPriority = conflicting
    ? highestPriority(seriousMatches.map((r) => r.priority))
    : winner.priority;

  return {
    category: winner.category,
    priority,
    escalate,
    escalationReason,
    initialState: escalate ? 'escalated' : 'open',
    matchedRules,
  };
}

const PRIORITY_ORDER: readonly SupportPriority[] = ['low', 'normal', 'high', 'urgent'];

function highestPriority(values: readonly SupportPriority[]): SupportPriority {
  let best: SupportPriority = 'low';
  for (const value of values) {
    if (PRIORITY_ORDER.indexOf(value) > PRIORITY_ORDER.indexOf(best)) best = value;
  }
  return best;
}

/**
 * Plain-language explanation of an escalation, for the owner queue and for the customer's
 * acknowledgement.
 *
 * NEW WORDING (A09): A01 wrote no support copy. Flagged in the handoff.
 */
export const ESCALATION_STATEMENT: Readonly<Record<EscalationReason, string>> = {
  billing_dispute_needs_a_person:
    'This is about money that has already been taken, so it goes to a person rather than an automatic answer.',
  deletion_request_needs_a_person:
    'This asks us to delete data. We never action that from a keyword match — a person confirms who is asking and what is covered.',
  security_report_needs_a_person:
    'This reports a possible security problem. It goes straight to the owner, unanswered by any automation.',
  cancellation_must_not_be_delayed:
    'This is about cancelling. It goes to a person immediately so nobody is kept subscribed by a slow reply.',
  customer_impact_unclear:
    'We could not tell from the message how badly this affects you, so we have not guessed. A person will read it.',
  conflicting_signals:
    'This message raises more than one serious matter at once, so a person reads the whole thing rather than a rule picking one.',
};
