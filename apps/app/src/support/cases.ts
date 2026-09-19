/**
 * Support cases: create, list, categorise, transition.
 *
 * **Redaction happens on the way in.** The `support_cases` table has one body column and
 * it is called `body_redacted`. A customer pastes an API key into a support form roughly
 * as often as they paste a stack trace; if the raw text is stored and redacted on the way
 * out, then the key is in the database, in every backup taken since, and in whatever
 * debugging query somebody runs at 2am. Redacting on read is a display convention.
 * Redacting on write is a control.
 *
 * The state machine matches the `CHECK` constraint in `migrations/0001_init.sql` exactly:
 * `open`, `awaiting_owner`, `answered`, `escalated`, `closed`. There is no sixth state.
 */
import { AppError } from '@verify/contracts';
import { maskEmail } from '@verify/security';
import { ID_PREFIX, newId } from '../lib/ids';
import { toIso } from '../lib/time';
import {
  SUPPORT_CATEGORY,
  type SupportCasePage,
  type SupportCaseRecord,
  type SupportCaseState,
  type SupportCategory,
  type SupportDataPort,
  type SupportPriority,
} from './port';
import { triage, type TriageDecision } from './triage';

/* -------------------------------------------------------------------------- */
/* limits                                                                     */
/* -------------------------------------------------------------------------- */

export const SUPPORT_LIMITS = {
  MAX_SUBJECT_CHARS: 200,
  MAX_BODY_CHARS: 4_000,
  /** Hard byte cap applied by `form.ts` before anything else touches the text. */
  MAX_BODY_BYTES: 16 * 1024,
  MAX_EMAIL_CHARS: 254,
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
} as const;

/* -------------------------------------------------------------------------- */
/* redaction                                                                  */
/* -------------------------------------------------------------------------- */

export const REDACTION_KIND = [
  'email_address',
  'credential',
  'bearer_token',
  'url_query',
  'payment_card',
  'truncated',
  'control_characters',
] as const;
export type RedactionKind = (typeof REDACTION_KIND)[number];

export interface RedactionResult {
  readonly text: string;
  /** What was removed, so the owner queue can say "there was a key here" honestly. */
  readonly kinds: readonly RedactionKind[];
}

/** `Bearer eyJhbGciOi…` — the separator is a space, so this needs its own pattern. */
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** `api_key: abc…`, `client_secret = "…"`. Requires an assignment, so prose survives. */
const NAMED_SECRET_RE =
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi;

/** Provider key prefixes recognisable on sight: Stripe, Resend, GitHub, Slack. */
const PROVIDER_KEY_RE = /\b(?:sk|rk|pk|re|pat|ghp|gho|xoxb|xoxp)[_-][A-Za-z0-9]{12,}\b/gi;

/** An unlabelled blob nobody named: 28+ characters, mixed letters and digits. */
const LONG_OPAQUE_RE =
  /\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{28,}={0,2}\b/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_WITH_QUERY_RE = /(https?:\/\/[^\s?#]+)\?[^\s#]*/gi;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Everything unprintable except tab and newline, which carry meaning in a support body. */
/**
 * Replace every unprintable character with a space, keeping tab and newline, which carry
 * meaning in a support body.
 *
 * Written as a scan rather than a regular expression on purpose: a character class full
 * of control-character escapes is unreadable, trips `no-control-regex`, and is exactly
 * the kind of thing that silently loses a range when somebody edits it.
 */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const keep = ch === '\n' || ch === '\t' || (code >= 0x20 && code !== 0x7f);
    out += keep ? ch : ' ';
  }
  return out;
}

/**
 * Redact a support body before it is stored.
 *
 * Order matters and is deliberate:
 *  1. line endings and control characters — they break every later pattern and every
 *     terminal that prints the result;
 *  2. URL query strings — a magic-link or OAuth `?code=` is a credential in a URL's clothing;
 *  3. `Bearer …`, named secrets, recognisable provider keys;
 *  4. long opaque strings — anything key-shaped that nobody labelled;
 *  5. payment-card-shaped digit runs;
 *  6. email addresses — masked rather than removed, because "the address is wrong" is a
 *     common support subject and `a**@example.com` still lets a person see the domain.
 *
 * This is a denylist of shapes to remove, which is weaker than an allowlist of shapes to
 * keep. That trade is made knowingly: a support body is prose, and prose cannot be
 * allowlisted without destroying it. The mitigations are that this text is only ever read
 * by the owner, never used to decide anything, and deleted on the schedule in
 * `privacy/retention.ts`.
 */
export function redactSupportBody(raw: string): RedactionResult {
  const kinds = new Set<RedactionKind>();
  let text = typeof raw === 'string' ? raw : '';

  const withoutControls = stripControlCharacters(text.replace(/\r\n?/g, '\n'));
  if (withoutControls !== text) kinds.add('control_characters');
  text = withoutControls;

  text = text.replace(URL_WITH_QUERY_RE, (_match, origin: string) => {
    kinds.add('url_query');
    return `${origin}?[redacted:url-query]`;
  });

  text = text.replace(BEARER_RE, () => {
    kinds.add('bearer_token');
    return '[redacted:bearer-token]';
  });

  text = text.replace(NAMED_SECRET_RE, () => {
    kinds.add('credential');
    return '[redacted:credential]';
  });

  text = text.replace(PROVIDER_KEY_RE, () => {
    kinds.add('credential');
    return '[redacted:credential]';
  });

  text = text.replace(LONG_OPAQUE_RE, () => {
    kinds.add('bearer_token');
    return '[redacted:token]';
  });

  text = text.replace(CARD_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    kinds.add('payment_card');
    return '[redacted:card]';
  });

  text = text.replace(EMAIL_RE, (match) => {
    kinds.add('email_address');
    return maskEmail(match);
  });

  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length > SUPPORT_LIMITS.MAX_BODY_CHARS) {
    kinds.add('truncated');
    text = `${text.slice(0, SUPPORT_LIMITS.MAX_BODY_CHARS)}\n[truncated by ${String(
      SUPPORT_LIMITS.MAX_BODY_CHARS,
    )}-character limit]`;
  }

  return { text, kinds: [...kinds] };
}

/* -------------------------------------------------------------------------- */
/* creation                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateCaseInput {
  /** Null for a signed-out submission. Support is reachable without an account. */
  readonly workspaceId: string | null;
  readonly contactEmail: string;
  readonly subject: string;
  /** Raw, as typed. Redacted here, before it reaches the port. */
  readonly body: string;
  readonly linkedRunId?: string | null;
  /**
   * Set when the service is paused. Recorded in the acknowledgement; it never blocks
   * submission. A paused service is exactly when people most need to reach us.
   */
  readonly servicePaused?: boolean;
}

export interface CreatedCase {
  readonly record: SupportCaseRecord;
  readonly triage: TriageDecision;
  readonly redactions: readonly RedactionKind[];
  /** What to say back to the customer. Never invents an answer. */
  readonly acknowledgement: string;
}

/**
 * NEW WORDING (A09): A01 wrote no support acknowledgement copy. Flagged in the handoff.
 */
const ACKNOWLEDGEMENT_DEFAULT =
  'We have your message and a person will read it. We do not send an automated answer pretending to be one.';
const ACKNOWLEDGEMENT_ESCALATED =
  'We have your message and it has gone straight to the owner rather than into a queue. We do not send an automated answer pretending to be one.';
const ACKNOWLEDGEMENT_PAUSED_SUFFIX =
  ' The service is currently paused, which does not affect this message reaching us.';

export async function createCase(
  port: SupportDataPort,
  input: CreateCaseInput,
  now: Date = new Date(),
): Promise<CreatedCase> {
  const contactEmail = normaliseEmail(input.contactEmail);
  const subject = normaliseSubject(input.subject);
  const { text: bodyRedacted, kinds } = redactSupportBody(input.body);

  if (bodyRedacted.length === 0) {
    throw new AppError(422, 'SUPPORT_BODY_EMPTY', 'Tell us what has happened.');
  }

  const decision = triage({
    subject,
    bodyRedacted,
    workspaceId: input.workspaceId,
    linkedRunId: input.linkedRunId ?? null,
  });

  const at = toIso(now);
  const record: SupportCaseRecord = {
    id: newId(ID_PREFIX.supportCase, now.getTime()),
    workspaceId: input.workspaceId,
    contactEmail,
    subject,
    bodyRedacted,
    category: decision.category,
    priority: decision.priority,
    state: decision.initialState,
    linkedRunId: input.linkedRunId ?? null,
    createdAt: at,
    updatedAt: at,
  };

  const stored = await port.insertCase(record);

  const base = decision.escalate ? ACKNOWLEDGEMENT_ESCALATED : ACKNOWLEDGEMENT_DEFAULT;
  return {
    record: stored,
    triage: decision,
    redactions: kinds,
    acknowledgement:
      input.servicePaused === true ? `${base}${ACKNOWLEDGEMENT_PAUSED_SUFFIX}` : base,
  };
}

function normaliseEmail(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    trimmed.length === 0 ||
    trimmed.length > SUPPORT_LIMITS.MAX_EMAIL_CHARS ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
  ) {
    throw new AppError(422, 'SUPPORT_EMAIL_INVALID', 'We need an email address we can reply to.');
  }
  return trimmed;
}

function normaliseSubject(value: string): string {
  const cleaned = stripControlCharacters(typeof value === 'string' ? value : '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) {
    throw new AppError(422, 'SUPPORT_SUBJECT_EMPTY', 'Give your message a subject.');
  }
  return cleaned.slice(0, SUPPORT_LIMITS.MAX_SUBJECT_CHARS);
}

/* -------------------------------------------------------------------------- */
/* listing                                                                    */
/* -------------------------------------------------------------------------- */

export interface ListCasesInput {
  /** A string scopes to one workspace; `null` lists signed-out submissions. */
  readonly workspaceId: string | null;
  readonly state?: SupportCaseState;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export async function listCases(
  port: SupportDataPort,
  input: ListCasesInput,
): Promise<SupportCasePage> {
  return port.listCases({
    workspaceId: input.workspaceId,
    ...(input.state === undefined ? {} : { state: input.state }),
    limit: clampPageSize(input.limit),
    cursor: input.cursor ?? null,
  });
}

/**
 * The platform owner's queue. Cross-tenant by design, and named so that calling it by
 * accident from a customer path is a visible mistake rather than an invisible one.
 */
export async function listCasesForOwner(
  port: SupportDataPort,
  input: {
    readonly state?: SupportCaseState;
    readonly limit?: number;
    readonly cursor?: string | null;
  },
): Promise<SupportCasePage> {
  return port.listCases({
    ...(input.state === undefined ? {} : { state: input.state }),
    limit: clampPageSize(input.limit),
    cursor: input.cursor ?? null,
  });
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SUPPORT_LIMITS.DEFAULT_PAGE_SIZE;
  }
  return Math.min(SUPPORT_LIMITS.MAX_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}

/* -------------------------------------------------------------------------- */
/* transitions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The allowed moves. Anything not listed is rejected — including `closed -> answered`,
 * which would let a closed case quietly acquire a reply nobody is watching for.
 *
 * `closed -> open` exists because a customer replying to a closed case must reopen it
 * rather than vanish.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<SupportCaseState, readonly SupportCaseState[]>> =
  {
    open: ['awaiting_owner', 'answered', 'escalated', 'closed'],
    awaiting_owner: ['answered', 'escalated', 'closed'],
    answered: ['open', 'closed'],
    escalated: ['awaiting_owner', 'answered', 'closed'],
    closed: ['open'],
  };

export function canTransition(from: SupportCaseState, to: SupportCaseState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionInput {
  readonly id: string;
  /** Tenant scope. `null` on the signed-out and platform-owner paths. */
  readonly workspaceId: string | null;
  readonly from: SupportCaseState;
  readonly to: SupportCaseState;
  readonly priority?: SupportPriority;
}

export interface TransitionOutcome {
  readonly changed: boolean;
  /** Why not, when `changed` is false. */
  readonly reason: 'applied' | 'not_allowed' | 'state_moved_underneath';
}

/**
 * Move a case. The expected state travels into the `WHERE` clause, so two owners acting
 * on the same case at the same time cannot both succeed — the loser is told the state
 * moved rather than silently overwriting it.
 */
export async function transitionCase(
  port: SupportDataPort,
  input: TransitionInput,
  now: Date = new Date(),
): Promise<TransitionOutcome> {
  if (!canTransition(input.from, input.to)) {
    return { changed: false, reason: 'not_allowed' };
  }
  const changed = await port.transitionCase({
    id: input.id,
    workspaceId: input.workspaceId,
    expectedState: input.from,
    nextState: input.to,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    updatedAt: toIso(now),
  });
  return changed
    ? { changed: true, reason: 'applied' }
    : { changed: false, reason: 'state_moved_underneath' };
}

/** Re-categorise a case by hand. The taxonomy is fixed; free text is not accepted. */
export function isSupportCategory(value: string): value is SupportCategory {
  return (SUPPORT_CATEGORY as readonly string[]).includes(value);
}
