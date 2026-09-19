/**
 * `POST /api/v1/webhooks/stripe/:opaqueId`
 *
 * The only door through which a provider can change money state. Everything it does is in
 * the order it does it, and the order is the security property:
 *
 *  1. Read the body as **bytes**, not as JSON and not as text-then-reparse. Stripe's own
 *     documentation is explicit: "Stripe requires the raw body of the request to perform
 *     signature verification… Any manipulation to the raw body of the request causes the
 *     verification to fail" (https://docs.stripe.com/webhooks, checked 2026-09-19).
 *  2. Enforce a size cap **before** parsing, on the declared length and again on what
 *     actually arrived.
 *  3. Verify the signature against those bytes. Only then parse.
 *  4. Reject an event from the wrong Stripe mode.
 *  5. Claim the event id, backed by `UNIQUE (provider, event_id)` on `webhook_receipts`.
 *     A redelivery is a 200 with no second effect.
 *  6. Dispatch to a typed handler; an unknown type is recorded and dropped.
 *
 * Status codes, and why:
 *
 *  - **400** for a bad or missing signature, an unparseable body, an oversized body, or a
 *    mode mismatch. Never 200 — a 200 tells Stripe we accepted something we rejected.
 *  - **200** for a duplicate, for an in-flight duplicate, and for an unhandled type.
 *  - **500** when our own handler threw. The receipt is released first so Stripe's retry
 *    is a fresh attempt rather than a deduplicated no-op.
 *
 * The opaque path id is never confirmed or denied. An unknown id takes the same path as a
 * bad signature — verification runs against a decoy secret so the response, the status and
 * the work done are indistinguishable, and the body says only "invalid signature".
 */
import { Hono } from 'hono';
import { sha256Hex } from '@verify/security';
import { verifyStripeSignature } from '@verify/security';
import { handleStripeEvent, type StripeEventShape } from '../../billing/events';
import { MAX_WEBHOOK_BODY_BYTES } from '../../billing/config';
import { providerModeMatches } from '../../billing/state';
import type { BillingRuntime } from '../../billing/runtime';

/** Resolve the endpoint signing secret for an opaque path id, or `null` if unknown. */
export type StripeEndpointSecretResolver = (opaqueId: string) => Promise<string | null>;

export interface StripeWebhookDeps extends BillingRuntime {
  readonly resolveEndpointSecret: StripeEndpointSecretResolver;
  /** Injected in tests. Defaults to the real verifier over raw bytes. */
  readonly verifySignature?: typeof verifyStripeSignature;
  readonly maxBodyBytes?: number;
  /** Structured log sink. Never receives a payload or a secret. */
  readonly log?: (entry: Record<string, string | number | boolean>) => void;
}

/**
 * A constant used when the opaque id is unknown.
 *
 * Verification then runs and fails exactly as it would for a real endpoint with a wrong
 * signature, so a prober cannot distinguish "no such endpoint" from "wrong secret" by
 * response, status or timing shape.
 */
const DECOY_SECRET = 'whsec_unknown_endpoint_decoy_secret_value_0000000000';

export function createStripeWebhookRoute(deps: StripeWebhookDeps): Hono {
  const app = new Hono();
  const verify = deps.verifySignature ?? verifyStripeSignature;
  const maxBytes = deps.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;
  const log = deps.log ?? (() => undefined);

  app.post('/api/v1/webhooks/stripe/:opaqueId', async (c) => {
    const opaqueId = c.req.param('opaqueId');

    // (2) Size cap, on the declared length first so an oversized body is refused before
    // it is read into memory.
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > maxBytes) {
      log({ event: 'stripe_webhook_rejected', reason: 'body_too_large_declared' });
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large.' } }, 413);
    }

    // (1) Raw bytes. Nothing between the socket and the verifier.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > maxBytes) {
      log({ event: 'stripe_webhook_rejected', reason: 'body_too_large' });
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large.' } }, 413);
    }

    // (3) Signature, against those exact bytes.
    const secret = (await deps.resolveEndpointSecret(opaqueId)) ?? DECOY_SECRET;
    const signature = c.req.header('stripe-signature') ?? null;
    const verified = await verify(raw, signature, secret, Date.parse(deps.now()));
    if (!verified.valid) {
      // `reason` is logged, never returned: the caller learns only that it was invalid.
      log({ event: 'stripe_webhook_rejected', reason: `signature_${verified.reason}` });
      return c.json(
        { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } },
        400,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      log({ event: 'stripe_webhook_rejected', reason: 'unparseable_json' });
      return c.json({ error: { code: 'INVALID_PAYLOAD', message: 'Invalid payload.' } }, 400);
    }

    const event = asStripeEvent(parsed);
    if (event === null) {
      log({ event: 'stripe_webhook_rejected', reason: 'unexpected_envelope' });
      return c.json({ error: { code: 'INVALID_PAYLOAD', message: 'Invalid payload.' } }, 400);
    }

    // (4) Mode. A test event delivered to a live endpoint is a misconfiguration, and
    // acting on it would let anyone with a Stripe sandbox author our state.
    if (!providerModeMatches(event.livemode, deps.config.environment)) {
      log({
        event: 'stripe_webhook_rejected',
        reason: 'mode_mismatch',
        event_id: event.id,
        event_livemode: event.livemode,
      });
      return c.json({ error: { code: 'MODE_MISMATCH', message: 'Invalid payload.' } }, 400);
    }

    // (5) Claim the event id.
    const payloadHash = await sha256Hex(raw);
    const receivedAt = deps.now();
    const admission = await deps.data.beginWebhookProcessing({
      receiptId: deps.newId('whr'),
      provider: 'stripe',
      eventId: event.id,
      payloadHash,
      receivedAt,
    });

    if (admission.outcome !== 'fresh') {
      log({
        event: 'stripe_webhook_duplicate',
        event_id: event.id,
        outcome: admission.outcome,
      });
      return c.json({ received: true, duplicate: true }, 200);
    }

    // (6) Dispatch.
    try {
      const outcome = await handleStripeEvent(deps, event);
      await deps.data.completeWebhookProcessing(
        admission.receiptId,
        outcome.status === 'processed' ? 'processed' : 'ignored',
        outcome.workspaceId,
      );
      log({
        event: 'stripe_webhook_handled',
        event_id: event.id,
        event_type: event.type,
        effect: outcome.effect,
        status: outcome.status,
      });
      return c.json({ received: true, duplicate: false }, 200);
    } catch (error) {
      // Give the event back so the retry is a fresh attempt. Without this, one internal
      // error would permanently swallow a paid invoice behind the dedupe constraint.
      await deps.data.abandonWebhookProcessing(event.id);
      log({
        event: 'stripe_webhook_failed',
        event_id: event.id,
        event_type: event.type,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
      return c.json(
        { error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Not processed. Please retry.' } },
        500,
      );
    }
  });

  return app;
}

/**
 * Narrow the parsed body to the event envelope.
 *
 * Only the five fields we act on are required. `data.object` is left as an opaque record
 * because its shape differs per event type and each handler reads it defensively — a
 * schema that claimed to know every field would be a lie that breaks on the next API
 * version.
 */
export function asStripeEvent(value: unknown): StripeEventShape | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const type = record['type'];
  const created = record['created'];
  const livemode = record['livemode'];
  const data = record['data'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof created !== 'number' || !Number.isFinite(created)) return null;
  if (typeof livemode !== 'boolean') return null;
  if (data === null || typeof data !== 'object') return null;
  const object = (data as Record<string, unknown>)['object'];
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return null;
  return {
    id,
    type,
    created: Math.trunc(created),
    livemode,
    data: { object: object as Record<string, unknown> },
  };
}
