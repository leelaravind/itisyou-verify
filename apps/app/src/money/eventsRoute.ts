/**
 * `POST /api/v1/events` — the door the product is named for.
 *
 * ## Why this file exists
 *
 * Every piece of this path was written, tested and green, and **the route was never
 * mounted**. `apps/app/src/db/customerPort.ts:540` renders the endpoint to the customer as
 * the address to send to; nothing served it. So `admitOnce`, the allowance reservation,
 * the scheduler's due-job pass and the entire verification engine were reachable by
 * nothing from outside. "No route consults an entitlement" was true for the plainest
 * possible reason: there was no route.
 *
 * ## The order of operations is the security property
 *
 * Deliberately the same shape as `routes/webhooks/stripe.ts` and `routes/webhooks/resend.ts`,
 * because three untrusted doors that handle failure differently is a gap somebody will
 * find.
 *
 *  1. **Size cap before parsing.** Declared `content-length` first, then what actually
 *     arrived. 32 KiB, from `LIMITS.MAX_SOURCE_EVENT_BYTES`.
 *  2. **Raw bytes, read once.** The signature covers `${timestamp}.${rawBody}`. Parsing
 *     and re-serialising changes the bytes and would verify a document nobody sent.
 *  3. **Resolve the key, verify the signature.** The workspace comes from the credential,
 *     never from the payload — a signing key proves who submitted the expectation, and
 *     claiming a workspace is not proving one.
 *  4. **Validate against the frozen schema**, then enforce `EVENT_FRESHNESS_WINDOW_SECONDS`
 *     on `occurred_at`.
 *  5. **`checkAdmission` — the money question — before `admitOnce`, not inside it.**
 *  6. **`admitOnce`**, which is the atomic reservation.
 *  7. **202 with the run id**, after the write has committed and not before.
 *
 * ### Why the entitlement check sits outside the reservation
 *
 * A06's reasoning, preserved because it is right. `admitOnce`'s conditional `UPDATE` is
 * the atomic gate on the *allowance* — it is what stops two simultaneous events being sold
 * the same last unit. Entitlement is the prior question of whether we should be doing work
 * for this workspace at all, and answering it inside the reservation would mean taking a
 * unit from a workspace we have already decided not to serve. The two refusals are also
 * different answers: **402** is about the account ("a payment failed, new runs are paused")
 * and **429** is about this period ("you have used your 500 runs"), and a customer needs to
 * know which because the two need different actions from them.
 *
 * `checkAdmission` also returns the billing period key, resolved by `billing/period.ts`.
 * That is the other half of the A13-010 fix: the admission side cannot derive its own
 * spelling of the key, because it never derives one at all.
 *
 * ## What the caller is told, and what it is not
 *
 * Every authentication failure — missing header, malformed header, unknown key id, stale
 * timestamp, future timestamp, wrong signature — returns **the same 401 body**. The reason
 * is logged, never returned. Telling a prober that the key id was right but the signature
 * was wrong is a free oracle on which ids exist.
 *
 * A key we cannot *open* is a 503, not a 401: the caller did nothing wrong and retrying is
 * the correct behaviour. That distinction is visible from outside, and it should be — it is
 * our fault, and saying "your signature is invalid" when our wrapping key is missing would
 * send a customer hunting for a bug they do not have.
 *
 * ## 202, never 200
 *
 * We have accepted the event for verification. We have not verified anything. 202 is the
 * honest code and it is the same distinction the product sells. A duplicate returns 200
 * with `duplicate: true` and the existing run — it is not new work, and it does not take a
 * second unit of allowance.
 */
import { Hono } from 'hono';
import {
  AppError,
  EVENT_FRESHNESS_WINDOW_SECONDS,
  LIMITS,
  sourceEventSchema,
  type SourceEvent,
} from '@verify/contracts';
import { sha256Hex, verifyRequest } from '@verify/security';
import { checkAdmission, type AdmissionVerdict } from '../billing/admission';
import type { BillingRuntime } from '../billing/runtime';
import type { Db } from '../db/d1';
import { sourceEvents, type AdmitResult } from '../db/sourceEvents';
import { workflows } from '../db/workflows';
import { ID_PREFIX, newId } from '../lib/ids';
import { addSecondsIso, toIso } from '../lib/time';
import type { SigningKeyResolver, ResolvedSigningKey } from './signingKeys';

export const SIGNATURE_HEADER = 'x-verify-signature';
export const KEY_ID_HEADER = 'x-verify-key-id';

/** How soon after admission the scheduler should first look. Immediately. */
export const FIRST_CHECK_DELAY_SECONDS = 0;

/** Machine reasons, for the log only. None of these is ever returned to a caller. */
export type EventRejection =
  | 'body_too_large_declared'
  | 'body_too_large'
  | 'missing_key_id'
  | 'unknown_key'
  | 'key_unreadable'
  | 'signature_missing_header'
  | 'signature_malformed_header'
  | 'signature_missing_signature'
  | 'signature_timestamp_stale'
  | 'signature_timestamp_in_future'
  | 'signature_signature_mismatch'
  | 'signature_malformed_secret'
  | 'body_not_json'
  | 'schema_invalid'
  | 'workflow_mismatch'
  | 'occurred_at_stale'
  | 'occurred_at_in_future'
  | 'entitlement_refused'
  | 'storage_failed';

export type EventsLog = (entry: Record<string, unknown>) => void;

export interface EventsRouteDeps {
  readonly db: Db;
  /** Resolves the caller from the key id alone. See `signingKeys.ts`. */
  readonly resolveSigningKey: SigningKeyResolver;
  /**
   * The money question. Supplied as a runtime rather than a function so the route holds no
   * billing rules of its own — it asks, and acts on the verdict.
   */
  readonly billing: BillingRuntime;
  /** Injected clock. Nothing here reads a wall clock for business time. */
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
  readonly maxBodyBytes?: number;
  readonly log?: EventsLog;
}

/** One body for every authentication failure. The reason lives in the log. */
const UNAUTHENTICATED = {
  error: {
    code: 'SIGNATURE_INVALID',
    message: 'The request signature could not be verified.',
  },
} as const;

export function createEventsRoute(deps: EventsRouteDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? ((): Date => new Date());
  const mint = deps.newId ?? ((prefix: string) => newId(prefix));
  const maxBytes = deps.maxBodyBytes ?? LIMITS.MAX_SOURCE_EVENT_BYTES;
  const log = deps.log ?? ((): void => undefined);
  const reject = (entry: Record<string, unknown>): void => {
    log({ event: 'source_event_rejected', ...entry });
  };

  app.post('/api/v1/events', async (c) => {
    // (1) Size cap. The declared length first, so an oversized body is refused before it
    // is pulled into memory.
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > maxBytes) {
      reject({ reason: 'body_too_large_declared' satisfies EventRejection });
      return c.json(
        { error: { code: 'PAYLOAD_TOO_LARGE', message: 'That event is too large.' } },
        413,
      );
    }

    // (2) Raw bytes, once. Nothing between the socket and the verifier.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > maxBytes) {
      reject({ reason: 'body_too_large' satisfies EventRejection });
      return c.json(
        { error: { code: 'PAYLOAD_TOO_LARGE', message: 'That event is too large.' } },
        413,
      );
    }

    // (3) Who is this? The key id is public; holding it proves nothing on its own.
    const keyId = (c.req.header(KEY_ID_HEADER) ?? '').trim();
    if (keyId.length === 0) {
      reject({ reason: 'missing_key_id' satisfies EventRejection });
      return c.json(UNAUTHENTICATED, 401);
    }

    const resolution = await deps.resolveSigningKey(keyId);
    if (resolution.outcome === 'unreadable') {
      // Our wrapping key is missing or wrong. The caller did nothing wrong and a retry is
      // the right behaviour, so this must not read as a bad signature.
      reject({ reason: 'key_unreadable' satisfies EventRejection, key_id: keyId });
      return c.json(
        {
          error: {
            code: 'SIGNING_KEY_UNREADABLE',
            message: 'This deployment cannot read the signing key. Not processed; please retry.',
          },
        },
        503,
      );
    }
    if (resolution.outcome === 'unknown') {
      reject({ reason: 'unknown_key' satisfies EventRejection, key_id: keyId });
      return c.json(UNAUTHENTICATED, 401);
    }
    const key: ResolvedSigningKey = resolution.key;

    const verified = await verifyRequest({
      secret: key.secret,
      header: c.req.header(SIGNATURE_HEADER) ?? null,
      rawBody: raw,
      now: now(),
    });
    if (!verified.valid) {
      // Six distinct reasons in the log, one answer to the caller.
      reject({
        reason: `signature_${verified.reason}` satisfies EventRejection,
        key_id: keyId,
        workspace_id: key.workspaceId,
      });
      return c.json(UNAUTHENTICATED, 401);
    }

    // From here the caller is proven. Everything below is about the content.

    // (4) The frozen contract.
    let parsed: SourceEvent;
    try {
      parsed = sourceEventSchema.parse(JSON.parse(decodeUtf8(raw)));
    } catch (error) {
      const reason: EventRejection =
        error instanceof SyntaxError ? 'body_not_json' : 'schema_invalid';
      reject({ reason, workspace_id: key.workspaceId });
      return c.json(
        {
          error: {
            code: 'EVENT_INVALID',
            message:
              'That event does not match the documented envelope. Check schema_version, event_id, ' +
              'workflow_id, occurred_at, correlation_id and expected.email_recipient.',
          },
        },
        422,
      );
    }

    // The payload names a workflow; the credential names one too. They must agree. The
    // credential is the authority — this check exists so a mismatch is a clear 403 rather
    // than a run silently attributed to the wrong workflow.
    if (parsed.workflow_id !== key.workflowId) {
      reject({
        reason: 'workflow_mismatch' satisfies EventRejection,
        workspace_id: key.workspaceId,
      });
      return c.json(
        {
          error: {
            code: 'WORKFLOW_MISMATCH',
            message: 'That signing key does not belong to the workflow named in the event.',
          },
        },
        403,
      );
    }

    // (4b) Freshness on the business timestamp, which is a different clock from the
    // signature's. A signature can be minutes old and legitimate; an `occurred_at` from
    // last week is an event we cannot usefully verify, because the evidence window has
    // moved on.
    const at = now();
    const skewSeconds = (Date.parse(parsed.occurred_at) - at.getTime()) / 1000;
    if (Number.isNaN(skewSeconds) || skewSeconds < -EVENT_FRESHNESS_WINDOW_SECONDS) {
      reject({ reason: 'occurred_at_stale' satisfies EventRejection, workspace_id: key.workspaceId });
      return c.json(
        {
          error: {
            code: 'EVENT_STALE',
            message: `occurred_at is older than the ${String(
              EVENT_FRESHNESS_WINDOW_SECONDS / 60,
            )}-minute freshness window, so there is nothing useful left to observe.`,
          },
        },
        422,
      );
    }
    if (skewSeconds > EVENT_FRESHNESS_WINDOW_SECONDS) {
      reject({
        reason: 'occurred_at_in_future' satisfies EventRejection,
        workspace_id: key.workspaceId,
      });
      return c.json(
        {
          error: {
            code: 'EVENT_IN_FUTURE',
            message: 'occurred_at is in the future. Check the sending system’s clock.',
          },
        },
        422,
      );
    }

    // (5) The money question, asked before anything is written and answered from the
    // workspace the credential proved — never from the payload.
    let verdict: AdmissionVerdict;
    try {
      verdict = await checkAdmission(deps.billing, {
        workspaceId: key.workspaceId,
        kind: 'new_run',
        atIso: toIso(at),
      });
    } catch (error) {
      log({
        event: 'source_event_admission_failed',
        workspace_id: key.workspaceId,
        message: shortMessage(error),
      });
      return c.json(
        {
          error: {
            code: 'ADMISSION_UNAVAILABLE',
            message: 'We could not check this workspace’s plan. Not processed; please retry.',
          },
        },
        503,
      );
    }

    if (!verdict.admit || verdict.billingPeriod === null) {
      reject({
        reason: 'entitlement_refused' satisfies EventRejection,
        workspace_id: key.workspaceId,
        refusal: verdict.refusal,
        admission_reason: verdict.reason,
      });
      const headers: Record<string, string> = { 'cache-control': 'no-store' };
      if (verdict.retryAfterIso !== null) headers['retry-after-at'] = verdict.retryAfterIso;
      return c.json(
        {
          error: {
            code: refusalCode(verdict),
            message: verdict.customerMessage,
          },
        },
        verdict.httpStatus === 200 ? 402 : verdict.httpStatus,
        headers,
      );
    }

    // (6) The atomic write: source event, run, outbox row and the one unit of allowance,
    // in a single batch. The period key is the one `checkAdmission` resolved; this route
    // never derives one.
    const receivedAt = toIso(at);
    const payloadJson = JSON.stringify(parsed);
    let admitted: AdmitResult;
    try {
      admitted = await sourceEvents.admitOnce(deps.db, {
        workspaceId: key.workspaceId,
        billingPeriod: verdict.billingPeriod,
        workflowId: key.workflowId,
        workflowVersionId: key.workflowVersionId,
        externalEventId: parsed.event_id,
        source: 'signed_customer_event',
        sourceEventId: mint(ID_PREFIX.sourceEvent),
        runId: mint(ID_PREFIX.run),
        outboxId: mint(ID_PREFIX.outbox),
        receivedAt,
        occurredAt: parsed.occurred_at,
        correlationKeyHash: await sha256Hex(
          `verify.correlation.v1:${key.workspaceId}:${parsed.correlation_id}`,
        ),
        payloadHash: await sha256Hex(payloadJson),
        payloadJson,
        deadlineAt: addSecondsIso(at, key.deadlineSeconds),
        nextCheckAt: addSecondsIso(at, FIRST_CHECK_DELAY_SECONDS),
      });
    } catch (error) {
      if (error instanceof AppError) {
        // 402 ALLOWANCE_EXHAUSTED / ENTITLEMENT_MISSING, or 409 IDEMPOTENCY_CONFLICT.
        // The allowance ones can still happen after a clean `checkAdmission`: the last
        // unit may have gone to a concurrent event in between. That race is expected and
        // correct — the gate is the policy answer, the reservation is the arbiter.
        reject({
          reason: 'entitlement_refused' satisfies EventRejection,
          workspace_id: key.workspaceId,
          code: error.code,
        });
        return c.json(
          { error: { code: error.code, message: error.publicMessage } },
          error.httpStatus === 409 ? 409 : 402,
          { 'cache-control': 'no-store' },
        );
      }
      // Storage failed. A retryable failure, never a 200 with a fabricated run id.
      log({
        event: 'source_event_storage_failed',
        workspace_id: key.workspaceId,
        message: shortMessage(error),
      });
      return c.json(
        {
          error: {
            code: 'EVENT_NOT_STORED',
            message: 'That event was not stored. Nothing was accepted; please retry.',
          },
        },
        503,
      );
    }

    // Best-effort, and deliberately after the durable write: the inactivity warning is a
    // convenience and must never be the reason an accepted event reports a failure.
    try {
      await workflows.touchLastEvent(deps.db, key.workspaceId, key.workflowId, receivedAt);
    } catch {
      // Swallowed on purpose. The run is committed; `last_event_at` is cosmetic.
    }

    log({
      event: 'source_event_admitted',
      workspace_id: key.workspaceId,
      workflow_id: key.workflowId,
      run_id: admitted.runId,
      duplicate: admitted.duplicate,
      billing_period: verdict.billingPeriod,
    });

    // (7) 202: accepted for verification, and nothing more is claimed. A duplicate is 200
    // — it is not new work and it took no second unit of allowance.
    return c.json(
      {
        run_id: admitted.runId,
        status: admitted.status,
        duplicate: admitted.duplicate,
        deadline_at: admitted.deadlineAt,
      },
      admitted.duplicate ? 200 : 202,
      { 'cache-control': 'no-store' },
    );
  });

  return app;
}

function refusalCode(verdict: AdmissionVerdict): string {
  switch (verdict.refusal) {
    case 'payment_paused':
      return 'PAYMENT_RECOVERY_PAUSED';
    case 'not_subscribed':
      return 'NO_SUBSCRIPTION';
    case 'subscription_inactive':
      return 'SUBSCRIPTION_INACTIVE';
    case 'at_allowance':
      return 'ALLOWANCE_EXHAUSTED';
    case 'no_allowance_period':
      return 'ENTITLEMENT_MISSING';
    default:
      return 'NOT_ADMITTED';
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** The error name only. A driver message names tables and constraints. */
function shortMessage(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
