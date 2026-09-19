/**
 * The assertion evaluator — plan §16.2/§16.3.
 *
 * Pure. No I/O, no database, no `fetch`, no `Date.now()`. Every instant is injected so a
 * run can be replayed years later and produce byte-identical results.
 *
 * Deliberate property: evaluation depends on `ctx.occurredAt` (the business event) and the
 * evidence itself, never on wall-clock `now`. Re-evaluating the same bundle tomorrow gives
 * the same answer. `ctx.now` is carried for callers and future use, not consulted here.
 *
 * The honesty rules this file exists to enforce:
 *   - Absence of evidence is never SUPPORTED.
 *   - A customer's own claim is a locator, never a fact.
 *   - A record belonging to another provider account is not our customer's record.
 *   - `accepted` is not `delivered`; `opened` proves neither delivery nor reading.
 */
import {
  AppError,
  DELIVERY_CONTRADICTING_STATUSES,
  DELIVERY_PROVING_STATUSES,
  EMAIL_STATUS,
  LIMITS,
  type AssertionSpec,
  type AssertionStatus,
  type CrmRecordEvidence,
  type EmailEventEvidence,
  type EmailStatus,
  type EvidenceBundle,
  type EvidenceGap,
  type EvidenceOrigin,
  type ReasonCode,
  type WorkflowRules,
} from '@verify/contracts';

/** One assertion's verdict, ready to store and to render. */
export interface AssertionResult {
  readonly rule_id: string;
  readonly label: string;
  readonly mandatory: boolean;
  readonly status: AssertionStatus;
  readonly reason_code: ReasonCode;
  /** What the rule asked for, in words a customer can read. */
  readonly expected_display: string;
  /** What we actually saw, or null when we saw nothing. */
  readonly observed_display: string | null;
  /**
   * The *provider event's own* timestamp for the evidence that decided this assertion
   * (email `occurred_at`, CRM `created_at`), falling back to when we observed it.
   * This is the timestamp that distinguishes a late completion from a late observation.
   */
  readonly observed_at: string | null;
  /** Stable locator for the evidence row that decided this assertion. */
  readonly evidence_ref: string | null;
}

export interface EvaluationContext {
  /** The business event's own timestamp. All time windows are measured from here. */
  readonly occurredAt: Date;
  /** Wall clock at evaluation time. Carried for callers; the verdicts do not depend on it. */
  readonly now: Date;
  /**
   * The provider account id of the *connected* CRM. When supplied, any record carrying a
   * different account id is CONTRADICTED with RECORD_WRONG_ACCOUNT. When omitted the caller
   * is asserting nothing about ownership and the check is skipped — connectors (A04) and the
   * scheduler must always supply it for a real run.
   */
  readonly connectedCrmAccountId?: string | null;
  /** As above, for the connected email provider account. */
  readonly connectedEmailAccountId?: string | null;
}

/**
 * Reason codes that mean "the connector looked and authoritatively established absence".
 * Only these may turn a mandatory UNKNOWN into FAILED at the deadline. See `decide.ts`.
 */
export const AUTHORITATIVE_ABSENCE_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'RECORD_NOT_FOUND',
  'EVENT_NOT_OBSERVED',
]);

export function isAuthoritativeAbsence(reason: ReasonCode): boolean {
  return AUTHORITATIVE_ABSENCE_REASONS.has(reason);
}

const CRM_FIELDS: ReadonlySet<string> = new Set([
  'record.id',
  'record.email',
  'record.correlation_id',
  'record.created_at',
  'record.property',
]);

const EMAIL_FIELDS: ReadonlySet<string> = new Set([
  'message.id',
  'message.recipient',
  'message.status',
  'message.occurred_at',
]);

const EMAIL_ADDRESS_FIELDS: ReadonlySet<string> = new Set(['record.email', 'message.recipient']);

const EMAIL_STATUS_SET: ReadonlySet<string> = new Set(EMAIL_STATUS);

/**
 * Email normalisation — the judgement calls, stated plainly.
 *
 *  - Whitespace is trimmed.
 *  - `Display Name <addr@host>` and `<addr@host>` reduce to `addr@host`.
 *  - The whole address is lowercased. RFC 5321 permits a case-sensitive local part, but no
 *    mail provider in production treats one as significant, and treating `Ann@x.com` as a
 *    different mailbox from `ann@x.com` would produce false failures.
 *  - A single trailing dot on the domain (the DNS root) is removed.
 *  - **`+tag` is NOT stripped.** `boss+anything@corp.com` is a different mailbox from
 *    `boss@corp.com` at most providers, and stripping it would let a customer satisfy
 *    "we emailed the enquirer" with an address they control. Verification must never widen
 *    an equivalence class; widening is how a false VERIFIED gets made.
 *  - Dots in the local part are NOT removed. That equivalence is Gmail-specific and wrong
 *    everywhere else.
 */
export function normaliseEmailAddress(raw: string): string {
  let s = raw.trim();
  const angled = /<([^<>]*)>\s*$/.exec(s);
  if (angled && angled[1] !== undefined) s = angled[1];
  s = s
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return s.toLowerCase();
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).replace(/\.$/, '');
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

interface Verdict {
  readonly status: AssertionStatus;
  readonly reason: ReasonCode;
}

const SUPPORTED: Verdict = { status: 'SUPPORTED', reason: 'MATCHED' };

function unknown(reason: ReasonCode): Verdict {
  return { status: 'UNKNOWN', reason };
}

function contradicted(reason: ReasonCode): Verdict {
  return { status: 'CONTRADICTED', reason };
}

/** One addressable observation drawn from one piece of evidence. */
interface Candidate {
  readonly ref: string;
  readonly origin: EvidenceOrigin;
  readonly accountId: string;
  /**
   * `undefined` — the provider did not return this field at all.
   * `null` or `''` — the provider returned the field and it is empty (an authoritative empty).
   */
  readonly value: string | null | undefined;
  /** The provider event's own timestamp, for `observed_at`. */
  readonly at: string | null;
}

function parseInstant(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function crmFieldValue(crm: CrmRecordEvidence, spec: AssertionSpec): string | null | undefined {
  switch (spec.field) {
    case 'record.id':
      return crm.record_id;
    case 'record.email':
      return crm.email;
    case 'record.correlation_id':
      return crm.correlation_value;
    case 'record.created_at':
      return crm.created_at;
    case 'record.property': {
      const name = spec.property_name;
      if (name === undefined) return undefined;
      if (!Object.prototype.hasOwnProperty.call(crm.properties, name)) return undefined;
      return crm.properties[name];
    }
    default:
      return undefined;
  }
}

function emailFieldValue(event: EmailEventEvidence, field: string): string | null | undefined {
  switch (field) {
    case 'message.id':
      return event.message_id;
    case 'message.recipient':
      return event.recipient;
    case 'message.status':
      return event.status;
    case 'message.occurred_at':
      return event.occurred_at;
    default:
      return undefined;
  }
}

function crmRef(crm: CrmRecordEvidence): string {
  return `crm_record:${crm.provider}:${crm.record_id}`;
}

function emailRef(event: EmailEventEvidence): string {
  return `email_event:${event.provider}:${event.message_id}:${event.status}`;
}

/** A spec problem the evaluator cannot honestly act on. Null when the spec is usable. */
function specProblem(spec: AssertionSpec): string | null {
  const isCrmField = CRM_FIELDS.has(spec.field);
  const isEmailField = EMAIL_FIELDS.has(spec.field);
  if (!isCrmField && !isEmailField) return `unknown field: ${spec.field}`;
  if (isCrmField && spec.source !== 'crm_record') return 'field belongs to crm_record';
  if (isEmailField && spec.source !== 'email_event') return 'field belongs to email_event';
  if (spec.field === 'record.property' && spec.property_name === undefined) {
    return 'record.property requires property_name';
  }
  switch (spec.operator) {
    case 'occurred_within': {
      if (typeof spec.expected !== 'number' || !Number.isInteger(spec.expected)) {
        return 'occurred_within expects an integer number of seconds';
      }
      if (spec.expected < 0) return 'occurred_within expects a non-negative window';
      return null;
    }
    case 'one_of': {
      if (!Array.isArray(spec.expected) || spec.expected.length === 0) {
        return 'one_of expects a non-empty array of allowed values';
      }
      return null;
    }
    case 'provider_status_in': {
      if (!Array.isArray(spec.expected) || spec.expected.length === 0) {
        return 'provider_status_in expects a non-empty array of statuses';
      }
      if (spec.field !== 'message.status')
        return 'provider_status_in only addresses message.status';
      const unknownStatus = spec.expected.find((s) => !EMAIL_STATUS_SET.has(s));
      if (unknownStatus !== undefined) return `unknown email status: ${unknownStatus}`;
      return null;
    }
    case 'exists':
      return null;
    case 'equals':
    case 'not_equals':
    case 'normalised_email_equals': {
      if (typeof spec.expected !== 'string') return `${spec.operator} expects a string`;
      if (spec.expected.trim() === '') return `${spec.operator} expects a non-empty value`;
      return null;
    }
    default:
      return `unsupported operator: ${String(spec.operator)}`;
  }
}

export function describeExpected(spec: AssertionSpec): string {
  switch (spec.operator) {
    case 'exists':
      return 'present';
    case 'occurred_within':
      return typeof spec.expected === 'number'
        ? `within ${spec.expected} seconds of the enquiry`
        : String(spec.expected);
    case 'one_of':
    case 'provider_status_in':
      return Array.isArray(spec.expected)
        ? `one of: ${spec.expected.join(', ')}`
        : String(spec.expected);
    case 'not_equals':
      return `anything other than ${String(spec.expected)}`;
    default:
      return String(spec.expected);
  }
}

function compareStrings(field: string, a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  // Case-sensitive by default. Email address fields are the documented exception: address
  // case is not significant in practice and a case difference is not a business failure.
  if (EMAIL_ADDRESS_FIELDS.has(field)) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * Apply a single-value operator.
 *
 * The CONTRADICTED / UNKNOWN boundary, stated once:
 *   - `undefined` — the provider did not return the field. We cannot say the value is wrong,
 *     only that we do not have it. → UNKNOWN / EVIDENCE_NOT_RETURNED.
 *   - `null` or `''` — the provider returned the field and it is empty. That is an
 *     authoritative empty and it genuinely contradicts "this field should equal X".
 *     → CONTRADICTED / VALUE_MISMATCH.
 *   - `not_equals` is the exception: "the value is not X" can never be established from a
 *     value that is not there, so an absent value is UNKNOWN, never SUPPORTED. Success is
 *     never inferred from absence.
 *
 * Note which code is used: `EVIDENCE_NOT_RETURNED` means the provider answered and left this
 * field out. `EVIDENCE_UNAVAILABLE` means we could not reach the provider at all. Those are
 * two very different conversations to have with a customer, so they are two different codes.
 */
function applyOperator(
  spec: AssertionSpec,
  value: string | null | undefined,
  occurredAt: Date,
): Verdict {
  if (spec.operator === 'exists') {
    if (present(value)) return SUPPORTED;
    return contradicted(
      spec.field === 'record.correlation_id' ? 'CORRELATION_MISSING' : 'VALUE_MISMATCH',
    );
  }

  // The provider answered but left this field out of its response.
  if (value === undefined) return unknown('EVIDENCE_NOT_RETURNED');

  switch (spec.operator) {
    case 'equals': {
      if (!present(value)) return contradicted('VALUE_MISMATCH');
      return compareStrings(spec.field, value, String(spec.expected))
        ? SUPPORTED
        : contradicted('VALUE_MISMATCH');
    }
    case 'not_equals': {
      // An empty value is not proof that the value is not the forbidden one.
      if (!present(value)) return unknown('EVIDENCE_NOT_RETURNED');
      return compareStrings(spec.field, value, String(spec.expected))
        ? contradicted('VALUE_MISMATCH')
        : SUPPORTED;
    }
    case 'normalised_email_equals': {
      if (!present(value)) return contradicted('VALUE_MISMATCH');
      const observed = normaliseEmailAddress(value);
      const expected = normaliseEmailAddress(String(spec.expected));
      return observed === expected ? SUPPORTED : contradicted('VALUE_MISMATCH');
    }
    case 'one_of': {
      if (!present(value)) return contradicted('VALUE_MISMATCH');
      const allowed = Array.isArray(spec.expected) ? spec.expected : [];
      return allowed.some((a) => compareStrings(spec.field, value, a))
        ? SUPPORTED
        : contradicted('VALUE_MISMATCH');
    }
    case 'occurred_within': {
      const observedMs = parseInstant(value);
      // A corrupt or missing timestamp is not a late timestamp. We simply cannot tell — and
      // the provider did answer us, so this is an omission, not an outage.
      if (observedMs === null) return unknown('EVIDENCE_NOT_RETURNED');
      const windowSeconds = typeof spec.expected === 'number' ? spec.expected : 0;
      const deltaMs = observedMs - occurredAt.getTime();
      // Evidence that predates the business event cannot have been produced by it.
      if (deltaMs < 0) return contradicted('OUTSIDE_TIME_WINDOW');
      // Inclusive upper bound: "within N seconds" includes the Nth second exactly.
      if (deltaMs <= windowSeconds * 1000) return SUPPORTED;
      return contradicted('OUTSIDE_TIME_WINDOW');
    }
    default:
      return unknown('RULE_UNSUPPORTED');
  }
}

/** SUPPORTED beats CONTRADICTED beats UNKNOWN when several events address one rule. */
const COMBINE_RANK: Record<AssertionStatus, number> = {
  SUPPORTED: 3,
  CONTRADICTED: 2,
  UNKNOWN: 1,
  PENDING: 0,
};

function mapGapToReason(gap: EvidenceGap): ReasonCode {
  switch (gap.code) {
    case 'NOT_FOUND':
      // The connector looked and the provider answered "there is nothing here".
      return gap.source === 'crm_record' ? 'RECORD_NOT_FOUND' : 'EVENT_NOT_OBSERVED';
    case 'AMBIGUOUS_MATCH':
      return 'RECORD_AMBIGUOUS';
    case 'AUTH_EXPIRED':
    case 'PERMISSION_MISSING':
    case 'UNSUPPORTED_CAPABILITY':
      return 'CONNECTION_UNAVAILABLE';
    case 'INVALID_EVIDENCE':
      // The provider answered; what it sent could not be read as the field we needed.
      return 'EVIDENCE_NOT_RETURNED';
    case 'RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
      return 'EVIDENCE_UNAVAILABLE';
    default:
      // We do not know why the source failed, so we do not claim the provider answered.
      return 'EVIDENCE_UNAVAILABLE';
  }
}

function connectedAccountFor(
  spec: AssertionSpec,
  ctx: EvaluationContext,
): string | null | undefined {
  return spec.source === 'crm_record' ? ctx.connectedCrmAccountId : ctx.connectedEmailAccountId;
}

function buildResult(
  spec: AssertionSpec,
  verdict: Verdict,
  observedDisplay: string | null,
  observedAt: string | null,
  evidenceRef: string | null,
): AssertionResult {
  return {
    rule_id: spec.rule_id,
    label: spec.label,
    mandatory: spec.mandatory,
    status: verdict.status,
    reason_code: verdict.reason,
    expected_display: describeExpected(spec),
    observed_display: observedDisplay,
    observed_at: observedAt,
    evidence_ref: evidenceRef,
  };
}

function crmCandidates(crm: CrmRecordEvidence | null, spec: AssertionSpec): Candidate[] {
  if (crm === null) return [];
  return [
    {
      ref: crmRef(crm),
      origin: crm.origin,
      accountId: crm.provider_account_id,
      value: crmFieldValue(crm, spec),
      at: crm.created_at ?? crm.observed_at,
    },
  ];
}

function emailCandidates(events: readonly EmailEventEvidence[], spec: AssertionSpec): Candidate[] {
  return events.map((event) => ({
    ref: emailRef(event),
    origin: event.origin,
    accountId: event.provider_account_id,
    value: emailFieldValue(event, spec.field),
    at: event.occurred_at,
  }));
}

/**
 * `provider_status_in` reads the whole observed ladder, not one event.
 *
 *   - Any observed status in the allowed set → SUPPORTED.
 *   - Otherwise, if the rule requires a delivery-proving status and we observed a
 *     delivery-contradicting one (`bounced`, `failed`, `complained`) → CONTRADICTED.
 *   - Otherwise UNKNOWN: `accepted` means the sending service took it, `opened`/`clicked`
 *     are engagement signals. None of them proves delivery, and a later `delivered` event
 *     may still arrive, so this is "we do not know yet", not "it failed".
 */
function evaluateStatusLadder(
  spec: AssertionSpec,
  candidates: readonly Candidate[],
): {
  verdict: Verdict;
  chosen: Candidate | null;
} {
  const allowed = new Set(Array.isArray(spec.expected) ? spec.expected : []);
  const match = candidates.find((c) => typeof c.value === 'string' && allowed.has(c.value));
  if (match) return { verdict: SUPPORTED, chosen: match };

  const requiresDelivery = [...allowed].some((s) =>
    DELIVERY_PROVING_STATUSES.has(s as EmailStatus),
  );
  if (requiresDelivery) {
    const contradicting = candidates.find(
      (c) =>
        typeof c.value === 'string' && DELIVERY_CONTRADICTING_STATUSES.has(c.value as EmailStatus),
    );
    if (contradicting)
      return { verdict: contradicted('STATUS_NOT_REACHED'), chosen: contradicting };
  }

  const anyContradicting = candidates.find(
    (c) =>
      typeof c.value === 'string' && DELIVERY_CONTRADICTING_STATUSES.has(c.value as EmailStatus),
  );
  if (!requiresDelivery && anyContradicting && !allowed.has(String(anyContradicting.value))) {
    // The rule wants some non-delivery status; a hard failure event still contradicts it.
    return { verdict: contradicted('STATUS_NOT_REACHED'), chosen: anyContradicting };
  }

  const last = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  return { verdict: unknown('STATUS_NOT_REACHED'), chosen: last ?? null };
}

function evaluateOne(
  spec: AssertionSpec,
  bundle: EvidenceBundle,
  ctx: EvaluationContext,
): AssertionResult {
  // 1. A spec we cannot honestly act on never guesses.
  const problem = specProblem(spec);
  if (problem !== null) return buildResult(spec, unknown('RULE_UNSUPPORTED'), null, null, null);

  const gapsForSource = bundle.gaps.filter((g) => g.source === spec.source);

  // 2. Ambiguity beats everything, including a record we happen to hold: if we cannot tell
  //    which record is the customer's, nothing derived from it is trustworthy.
  if (gapsForSource.some((g) => g.code === 'AMBIGUOUS_MATCH')) {
    return buildResult(spec, unknown('RECORD_AMBIGUOUS'), null, null, null);
  }

  let candidates =
    spec.source === 'crm_record'
      ? crmCandidates(bundle.crm, spec)
      : emailCandidates(bundle.email_events, spec);

  // 3. Nothing to look at.
  if (candidates.length === 0) {
    const gap = gapsForSource[0];
    if (gap !== undefined) return buildResult(spec, unknown(mapGapToReason(gap)), null, null, null);
    // No evidence and no explanation: we cannot claim the connector established absence.
    return buildResult(spec, unknown('AWAITING_EVIDENCE'), null, null, null);
  }

  // 4. Account ownership. A customer-supplied record id is a locator, never a fact — a record
  //    that lives in a different provider account is not evidence about this workspace.
  const connectedAccount = connectedAccountFor(spec, ctx);
  if (present(connectedAccount)) {
    const owned = candidates.filter((c) => c.accountId === connectedAccount);
    if (owned.length === 0) {
      const foreign = candidates[0];
      return buildResult(
        spec,
        contradicted('RECORD_WRONG_ACCOUNT'),
        foreign?.value ?? null,
        foreign?.at ?? null,
        foreign?.ref ?? null,
      );
    }
    candidates = owned;
  }

  // 5. Origin gate. A customer's own claim may be displayed but may never support a mandatory
  //    assertion — otherwise the customer grades their own homework.
  if (spec.mandatory) {
    const independent = candidates.filter((c) => c.origin !== 'customer_claim');
    if (independent.length === 0) {
      const claimed = candidates[0];
      return buildResult(
        spec,
        unknown('CLAIM_NOT_INDEPENDENT'),
        claimed?.value ?? null,
        claimed?.at ?? null,
        claimed?.ref ?? null,
      );
    }
    candidates = independent;
  }

  // 6. Operator.
  if (spec.operator === 'provider_status_in') {
    const { verdict, chosen } = evaluateStatusLadder(spec, candidates);
    const observed = candidates
      .map((c) => (typeof c.value === 'string' ? c.value : null))
      .filter((v): v is string => v !== null)
      .join(', ');
    return buildResult(
      spec,
      verdict,
      observed === '' ? null : observed,
      chosen?.at ?? null,
      chosen?.ref ?? null,
    );
  }

  let best: { verdict: Verdict; candidate: Candidate } | null = null;
  for (const candidate of candidates) {
    const verdict = applyOperator(spec, candidate.value, ctx.occurredAt);
    if (best === null || COMBINE_RANK[verdict.status] > COMBINE_RANK[best.verdict.status]) {
      best = { verdict, candidate };
    }
  }
  /* c8 ignore next */
  if (best === null) return buildResult(spec, unknown('AWAITING_EVIDENCE'), null, null, null);

  const value = best.candidate.value;
  return buildResult(
    spec,
    best.verdict,
    value === undefined ? null : value,
    best.candidate.at,
    best.candidate.ref,
  );
}

/**
 * Configuration the evaluator refuses to run against. The Zod contract already rejects these;
 * the evaluator refuses independently so a hand-built or migrated rule set cannot slip past.
 */
export function assertEvaluableRules(rules: WorkflowRules): void {
  if (rules.assertions.length === 0) {
    throw new AppError(
      422,
      'WORKFLOW_RULES_INVALID',
      'This workflow has no checks, so there is nothing to verify.',
    );
  }
  if (rules.assertions.length > LIMITS.MAX_ASSERTIONS_PER_WORKFLOW) {
    throw new AppError(
      422,
      'WORKFLOW_RULES_INVALID',
      `A workflow may define at most ${LIMITS.MAX_ASSERTIONS_PER_WORKFLOW} checks.`,
    );
  }
  const seen = new Set<string>();
  for (const a of rules.assertions) {
    if (seen.has(a.rule_id)) {
      throw new AppError(
        422,
        'WORKFLOW_RULES_INVALID',
        'Two checks in this workflow share the same identifier.',
      );
    }
    seen.add(a.rule_id);
  }
  if (!rules.assertions.some((a) => a.mandatory)) {
    throw new AppError(
      422,
      'WORKFLOW_RULES_INVALID',
      'This workflow has no mandatory checks, so a pass would not mean anything. Mark at least one check as required.',
    );
  }
}

/**
 * Evaluate every assertion in a workflow against one evidence bundle.
 * Throws `AppError(422)` for a rule set that could never produce a meaningful VERIFIED.
 */
export function evaluateAssertions(
  rules: WorkflowRules,
  bundle: EvidenceBundle,
  ctx: EvaluationContext,
): AssertionResult[] {
  assertEvaluableRules(rules);
  return rules.assertions.map((spec) => evaluateOne(spec, bundle, ctx));
}
