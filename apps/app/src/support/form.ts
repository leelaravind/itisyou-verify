/**
 * The public support submission path.
 *
 * Four properties, all of them load-bearing:
 *
 *  1. **Available signed out.** A person locked out of their account is exactly the person
 *     who most needs support. `workspaceId` is `null` for them and every downstream path
 *     copes with that.
 *  2. **Reachable while the service is paused.** `servicePaused` reaches this module and
 *     is used for one thing only: a sentence in the acknowledgement telling the person
 *     the pause does not affect their message arriving. There is deliberately no branch
 *     in this file that refuses a submission because of it. A service that goes down and
 *     takes its own support channel with it has removed the customer's last option.
 *  3. **Bounded.** Size-capped in bytes before anything is parsed, field-validated, and
 *     rate-limited on two independent dimensions so neither alone is an oracle or a
 *     flood vector.
 *  4. **Honest.** If the rules-based FAQ matcher has an answer, it is offered *alongside*
 *     the case, never instead of it. Nothing here closes a case automatically, and
 *     nothing here generates a sentence of its own.
 */
import { AppError } from '@verify/contracts';
import { createCase, SUPPORT_LIMITS, type CreatedCase } from './cases';
import { matchFaq, type FaqLookup } from './faq';
import type { RateLimiter, SupportDataPort } from './port';

/* -------------------------------------------------------------------------- */
/* limits                                                                     */
/* -------------------------------------------------------------------------- */

export const FORM_LIMITS = {
  /** Whole-payload cap, applied to the raw bytes before anything is parsed. */
  MAX_PAYLOAD_BYTES: 32 * 1024,
  /** Per client identity (a hashed IP), per window. */
  PER_CLIENT_PER_HOUR: 5,
  /** Per contact address, per window. Stops one address being used to flood us. */
  PER_EMAIL_PER_HOUR: 3,
  WINDOW_SECONDS: 3_600,
} as const;

/* -------------------------------------------------------------------------- */
/* validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface SupportFormFields {
  readonly email: string;
  readonly subject: string;
  readonly message: string;
  readonly runId: string | null;
}

export interface FieldError {
  readonly field: 'email' | 'subject' | 'message' | 'runId' | 'payload';
  readonly code: string;
  /** Shown to the person. Says what to do, not what the validator thinks. */
  readonly message: string;
}

export type FormValidation =
  | { readonly ok: true; readonly value: SupportFormFields }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RUN_ID_SHAPE = /^run_[0-9A-Z]{26}$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Validate a submitted form.
 *
 * Pure and exception-free so A05 can render field errors without a try/catch, and so the
 * same rules can be unit-tested without a database. `submitSupportForm` uses it and turns
 * a failure into a typed `AppError`.
 *
 * NEW WORDING (A09): A01 wrote no form-validation copy. Flagged in the handoff.
 */
export function validateSupportForm(raw: unknown): FormValidation {
  const errors: FieldError[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          field: 'payload',
          code: 'not_an_object',
          message: 'We could not read that submission. Please try again.',
        },
      ],
    };
  }

  const source = raw as Record<string, unknown>;
  const email = asString(source['email']).trim().toLowerCase();
  const subject = asString(source['subject']).trim();
  const message = asString(source['message']);
  const runIdRaw = asString(source['runId']).trim();

  if (email.length === 0) {
    errors.push({
      field: 'email',
      code: 'required',
      message: 'We need an email address so we can reply.',
    });
  } else if (email.length > SUPPORT_LIMITS.MAX_EMAIL_CHARS || !EMAIL_SHAPE.test(email)) {
    errors.push({
      field: 'email',
      code: 'invalid',
      message: 'That does not look like an email address we could reply to.',
    });
  }

  if (subject.length === 0) {
    errors.push({
      field: 'subject',
      code: 'required',
      message: 'Give your message a short subject.',
    });
  } else if (subject.length > SUPPORT_LIMITS.MAX_SUBJECT_CHARS) {
    errors.push({
      field: 'subject',
      code: 'too_long',
      message: `Please keep the subject under ${String(SUPPORT_LIMITS.MAX_SUBJECT_CHARS)} characters.`,
    });
  }

  if (message.trim().length === 0) {
    errors.push({
      field: 'message',
      code: 'required',
      message: 'Tell us what has happened.',
    });
  } else if (byteLength(message) > SUPPORT_LIMITS.MAX_BODY_BYTES) {
    errors.push({
      field: 'message',
      code: 'too_long',
      message:
        'That message is too long to send here. Please summarise it and attach anything long as a follow-up.',
    });
  }

  if (runIdRaw.length > 0 && !RUN_ID_SHAPE.test(runIdRaw)) {
    errors.push({
      field: 'runId',
      code: 'invalid',
      message: 'That does not look like one of our run references. Leave it blank if unsure.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      email,
      subject,
      message,
      runId: runIdRaw.length > 0 ? runIdRaw : null,
    },
  };
}

/**
 * Whole-payload size guard, applied to raw bytes before parsing.
 *
 * Separate from field validation because it has to happen first: parsing a megabyte of
 * JSON to discover it is too big has already spent the CPU.
 */
export function payloadWithinLimit(rawBytes: number): boolean {
  return Number.isFinite(rawBytes) && rawBytes >= 0 && rawBytes <= FORM_LIMITS.MAX_PAYLOAD_BYTES;
}

/* -------------------------------------------------------------------------- */
/* submission                                                                 */
/* -------------------------------------------------------------------------- */

export interface SupportFormContext {
  readonly port: SupportDataPort;
  readonly rateLimiter: RateLimiter;
  /**
   * A hashed client identifier — A02's IP hash, never a raw address. Used only as a rate
   * limit bucket and never stored on the case.
   */
  readonly clientHash: string;
  /** Resolved from the session server-side. `null` for a signed-out visitor. */
  readonly workspaceId: string | null;
  /**
   * Whether the service is currently paused. Read for one sentence of acknowledgement
   * copy. It must never gate the submission.
   */
  readonly servicePaused: boolean;
  readonly now?: Date | undefined;
}

export interface SupportFormOutcome {
  readonly case: CreatedCase;
  /**
   * A published answer, when the rules-based matcher is confident. Offered as extra
   * information; the case is open either way and a person still reads it.
   */
  readonly suggestion: FaqLookup;
}

/**
 * Accept a support submission.
 *
 * Throws `AppError` for the cases the central handler already knows how to render: 422
 * for an invalid form, 413 for an oversized payload, 429 with `Retry-After` for a rate
 * limit. It never throws because the service is paused, because the visitor is signed
 * out, or because email is not configured.
 */
export async function submitSupportForm(
  context: SupportFormContext,
  raw: unknown,
  rawBytes?: number,
): Promise<SupportFormOutcome> {
  if (rawBytes !== undefined && !payloadWithinLimit(rawBytes)) {
    throw new AppError(
      413,
      'SUPPORT_PAYLOAD_TOO_LARGE',
      'That submission is larger than we accept. Please shorten it.',
    );
  }

  const parsed = validateSupportForm(raw);
  if (!parsed.ok) {
    const first = parsed.errors[0];
    throw new AppError(
      422,
      'SUPPORT_FORM_INVALID',
      first === undefined ? 'That submission is not valid.' : first.message,
    );
  }

  const now = context.now ?? new Date();

  // Two independent dimensions. Neither is sufficient alone: one address behind many
  // addresses, and many addresses behind one connection, are both flood shapes.
  const byClient = await context.rateLimiter.consume(
    `support-form:client:${context.clientHash}`,
    FORM_LIMITS.PER_CLIENT_PER_HOUR,
    FORM_LIMITS.WINDOW_SECONDS,
    now,
  );
  const byEmail = await context.rateLimiter.consume(
    `support-form:email:${parsed.value.email}`,
    FORM_LIMITS.PER_EMAIL_PER_HOUR,
    FORM_LIMITS.WINDOW_SECONDS,
    now,
  );

  if (!byClient.allowed || !byEmail.allowed) {
    const retryAfter = Math.max(
      byClient.allowed ? 0 : byClient.retryAfterSeconds,
      byEmail.allowed ? 0 : byEmail.retryAfterSeconds,
      1,
    );
    throw new AppError(
      429,
      'SUPPORT_FORM_RATE_LIMITED',
      'You have sent us several messages in a short time. Please wait a little and try again. We have the earlier ones.',
      retryAfter,
    );
  }

  const created = await createCase(
    context.port,
    {
      workspaceId: context.workspaceId,
      contactEmail: parsed.value.email,
      subject: parsed.value.subject,
      body: parsed.value.message,
      linkedRunId: parsed.value.runId,
      servicePaused: context.servicePaused,
    },
    now,
  );

  // A suggestion, never a substitute. The case stays in whatever state triage gave it.
  const suggestion = matchFaq(`${parsed.value.subject} ${parsed.value.message}`);

  return { case: created, suggestion };
}

/**
 * The paths that must stay reachable when everything else is switched off.
 *
 * Exported as data so A05 can build the paused page from the same list the tests assert
 * on, and so nobody has to remember which routes the pause middleware must skip.
 */
export const ALWAYS_REACHABLE_PATHS: readonly string[] = [
  '/support',
  '/support/submit',
  '/legal/privacy',
  '/legal/terms',
  '/account/cancel',
  '/account/delete',
];

/** True when a route must be served even though the service is paused. */
export function isReachableWhilePaused(path: string): boolean {
  const normalised = path.split('?')[0] ?? path;
  return ALWAYS_REACHABLE_PATHS.some(
    (allowed) => normalised === allowed || normalised.startsWith(`${allowed}/`),
  );
}
