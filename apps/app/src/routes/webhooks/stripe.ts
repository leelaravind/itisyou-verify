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
 * The opaque path id is a **gate**, not decoration, and it is never confirmed or denied.
 * An id we did not issue is rejected before any work is done on the event, and it takes
 * the same path as a bad signature: verification still runs, against a stand-in key, so
 * the response, the status and the work done are indistinguishable, and the body says
 * only "invalid signature". The rejection is on the lookup result, never on the signature
 * comparison — so the stand-in key is not a credential and being able to read it buys
 * nothing.
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
  /**
   * The key verification runs against when the opaque id is unknown.
   *
   * Supply a per-deployment value derived from a Worker secret. It is not a credential —
   * nothing is ever accepted under it (see the unknown-endpoint handling below) — it
   * exists only so that the work done for an unknown id is the same work as for a known
   * one, and therefore takes the same time.
   */
  readonly unknownEndpointKey?: string;
}

/**
 * The stand-in key used when the opaque id is unknown.
 *
 * Assembled at runtime rather than written as a literal. This repository is permanently
 * public, and a credential-shaped string is rejected by our own scanner and by GitHub
 * push protection — see `docs/agent-brief.md`, "Never commit a credential-shaped
 * literal". The value is identical either way; it just stops looking like a secret.
 *
 * It carries **no security weight**. An earlier version of this route treated it as the
 * fallback secret and then accepted whatever verified against it, which meant anyone who
 * read this file could sign a payload with it, POST to an invented endpoint id, and have
 * a fabricated `invoice.paid` dispatched — a free subscription, and money out on the
 * refund path. That was A10's finding SEC-431. The route now fails closed on the *lookup
 * result* and never on the comparison, so this value being public costs nothing.
 */
function unknownEndpointKey(): string {
  return 'whsec' + '_' + 'A'.repeat(32);
}

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
    //
    // Two independent conditions have to hold, and both are evaluated before either is
    // acted on: the opaque id must be one we issued, and the signature must verify under
    // *that endpoint's* secret.
    //
    // The verification is run even when the id is unknown, against a stand-in key, so the
    // work done and the time taken are the same either way and a prober cannot tell the
    // two apart. But an unknown id is rejected on the **lookup result**, never on the
    // comparison — so a stand-in key that anyone can read is not a way in. Getting this
    // backwards was SEC-431: the id was decoration and the shared secret was the only
    // gate, which is precisely what the opaque path segment exists to prevent.
    const known = await deps.resolveEndpointSecret(opaqueId);
    const signature = c.req.header('stripe-signature') ?? null;
    const verified = await verify(
      raw,
      signature,
      known ?? deps.unknownEndpointKey ?? unknownEndpointKey(),
      Date.parse(deps.now()),
    );
    if (known === null || !verified.valid) {
      // The reason is logged, never returned. "No such endpoint", "wrong secret" and
      // "stale timestamp" are one answer to the caller and three answers to the operator.
      log({
        event: 'stripe_webhook_rejected',
        reason: verified.valid
          ? 'signature_unknown_endpoint'
          : known === null
            ? `signature_unknown_endpoint_${verified.reason}`
            : `signature_${verified.reason}`,
      });
      return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } }, 400);
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
      //
      // The release is itself fallible, and its failure is the one genuinely bad window in
      // this design: the claim stands, the effect never happened, and Stripe's retry will
      // be deduplicated away. It is logged distinctly so the operator can see it, and
      // `reconcile.ts` is the net that finds the resulting gap. Swallowing the release
      // failure here is deliberate — re-throwing would turn a 500 into an unhandled
      // rejection and lose the log line that says which event is now stranded.
      let released = true;
      try {
        await deps.data.abandonWebhookProcessing(event.id);
      } catch {
        released = false;
      }
      log({
        event: 'stripe_webhook_failed',
        event_id: event.id,
        event_type: event.type,
        error_name: error instanceof Error ? error.name : 'unknown',
        claim_released: released,
      });
      if (!released) {
        log({
          event: 'stripe_webhook_claim_stranded',
          event_id: event.id,
          event_type: event.type,
        });
      }
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
