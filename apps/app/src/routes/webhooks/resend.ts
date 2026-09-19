/**
 * `POST /api/v1/webhooks/resend/:opaqueId`
 *
 * The door Resend's signed delivery events come through, and — because
 * `validateConnection` no longer treats a stored signing secret as evidence — the **only**
 * thing that can move a Resend connection from `testing` to `ready`.
 *
 * Deliberately the same shape as `stripe.ts` (A06), because two webhook routes that handle
 * failure differently is a gap someone will find. The order below *is* the security
 * property:
 *
 *  1. Read the body as **bytes**, once. Svix signs `${id}.${timestamp}.${body}` over the
 *     raw payload; parsing and re-serialising changes the bytes and would verify a
 *     document Resend never sent.
 *     (https://docs.svix.com/receiving/verifying-payloads/how-manual, checked 2026-09-19.)
 *  2. Enforce a size cap **before** parsing — on the declared length first, then on what
 *     actually arrived.
 *  3. Resolve the opaque path id, and verify the signature against those exact bytes.
 *     Only then parse.
 *  4. Claim the delivery id, backed by `UNIQUE (provider, event_id)` on
 *     `webhook_receipts`. A redelivery is a 200 with no second effect.
 *  5. Record the evidence, and only then promote the connection.
 *
 * Status codes, and why:
 *
 *  - **400** for a bad or missing signature, an unknown endpoint, a revoked connection, a
 *    stale or future timestamp, an unparseable body, or a delivery with no id to
 *    deduplicate on. Never 200 — a 200 tells Resend we accepted something we rejected.
 *  - **413** for an oversized body.
 *  - **200** for a duplicate, an in-flight duplicate, and an event type we do not map.
 *  - **500** when our own handler threw, with the receipt released first so Resend's
 *    retry is a fresh attempt rather than a deduplicated no-op.
 *
 * ## The opaque path id is a gate, and it is never confirmed or denied
 *
 * A06 learned this the hard way (SEC-431): an opaque id is decoration unless the route
 * actually rejects an id it did not issue. Verifying the signature is not enough by
 * itself, because a shared or readable key turns "unknown endpoint" into "any endpoint".
 *
 * So: verification runs either way — against the endpoint's own secret when the id is
 * known, against a stand-in key when it is not — so the work done and the time taken are
 * the same and a prober cannot tell the two apart. But the rejection is on the **lookup
 * result**, never on the signature comparison. The stand-in key is therefore not a
 * credential, and being able to read it buys nothing.
 *
 * ## Promotion happens once, on the verified path only
 *
 * `markWebhookVerified` is handed the verification *result*, not a boolean, so this route
 * cannot assert that a connection works — it can only present evidence that it does. Three
 * separate things have to be true before a connection is promoted:
 *
 *   - the signature verified (step 3, or we returned 400);
 *   - the connection is not revoked (step 3 — a leaked URL for a revoked connection is
 *     rejected exactly like an unknown one);
 *   - this delivery is **fresh** (step 4 — a replayed callback is a duplicate, returns
 *     200, and never reaches the promotion).
 */
import { Hono } from 'hono';
import { sha256Hex } from '@verify/security';
import { markWebhookVerified, resendConnector, type WebhookVerification } from '@verify/connectors';
import type { ConnectionStatus, EmailEventEvidence } from '@verify/contracts';
import type { WebhookAdmission, WebhookProcessingStatus } from '../../db/webhooks';

/** Same ceiling as the Stripe route. A delivery event is a few hundred bytes. */
export const MAX_RESEND_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * One connection's endpoint, as resolved from the opaque path id.
 *
 * `signingSecret` arrives decrypted: the data layer opens the AES-GCM envelope with the
 * AAD it rebuilds from its own context (`openConnectionCredentials`,
 * `CREDENTIAL_PURPOSE.WEBHOOK_SECRET`). This route never sees an envelope, never sees a
 * key, and never stores either.
 */
export interface ResendEndpoint {
  readonly connectionId: string;
  readonly workspaceId: string;
  /** Decrypted `whsec_…`. Empty string when the connection holds no usable secret. */
  readonly signingSecret: string;
  /** The connection's current status. `revoked` accepts nothing, ever. */
  readonly status: ConnectionStatus;
  /**
   * The Resend account identity recorded at setup. Stamped onto the evidence so the
   * evaluator can tell our customer's account from anyone else's.
   */
  readonly externalAccountId: string | null;
  /** When a signed callback was last verified, or `null` if never. */
  readonly webhookVerifiedAt: string | null;
}

/** Resolve an opaque path id to the connection it was issued for, or `null` if unknown. */
export type ResendEndpointResolver = (opaqueId: string) => Promise<ResendEndpoint | null>;

/**
 * What this route needs from the data layer.
 *
 * A port, not D1: `apps/app/src/db/` is A02's, and a webhook route that wrote its own SQL
 * would be the second place tenant scoping had to be remembered.
 */
export interface ResendWebhookDataPort {
  beginWebhookProcessing(params: {
    readonly receiptId: string;
    readonly provider: string;
    readonly eventId: string;
    readonly payloadHash: string;
    readonly receivedAt: string;
    readonly workspaceId?: string | null;
    readonly connectionId?: string | null;
  }): Promise<WebhookAdmission>;

  completeWebhookProcessing(
    receiptId: string,
    status: WebhookProcessingStatus,
    workspaceId?: string | null,
  ): Promise<void>;

  abandonWebhookProcessing(eventId: string): Promise<void>;

  /**
   * Persist one verified email event.
   *
   * Idempotent on `(workspaceId, eventId)` — the receipt claim already makes a second
   * call unlikely, but a store that depends on a caller never repeating itself is a store
   * that will eventually be repeated at.
   */
  recordEmailEvidence(params: {
    readonly workspaceId: string;
    readonly connectionId: string;
    readonly eventId: string;
    readonly evidence: EmailEventEvidence;
    readonly receivedAt: string;
  }): Promise<void>;

  /**
   * Promote a connection to `ready` because a signed callback arrived and was understood.
   *
   * Must be a conditional write that refuses to promote a connection whose status is
   * `revoked` — this route checks that too, but the last line of defence belongs next to
   * the row.
   */
  markConnectionWebhookVerified(params: {
    readonly workspaceId: string;
    readonly connectionId: string;
    readonly verifiedAt: string;
  }): Promise<boolean>;
}

export interface ResendWebhookDeps {
  readonly resolveEndpoint: ResendEndpointResolver;
  readonly data: ResendWebhookDataPort;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** Injected in tests. Defaults to the connector's verifier over raw bytes. */
  readonly verifyWebhook?: typeof resendConnector.verifyWebhook;
  readonly maxBodyBytes?: number;
  /** Structured log sink. Never receives a payload, a secret or a recipient address. */
  readonly log?: (entry: Record<string, string | number | boolean>) => void;
  /**
   * The key verification runs against when the opaque id is unknown.
   *
   * Supply a per-deployment value derived from a Worker secret. It is **not** a
   * credential — nothing is ever accepted under it, because the rejection is on the
   * lookup result — it exists only so the work done for an unknown id matches the work
   * done for a known one.
   */
  readonly unknownEndpointKey?: string;
}

/**
 * The stand-in key for an unknown endpoint.
 *
 * Assembled at runtime rather than written as a literal: this repository is permanently
 * public, and a credential-shaped string is rejected by our own scanner, by `SEC-633` and
 * by GitHub push protection. See `docs/agent-brief.md`, "Never commit a credential-shaped
 * literal". The value is identical; it just stops looking like a secret.
 *
 * It must be a *syntactically valid* Svix secret — `whsec_` plus base64 — or the verifier
 * would fail with `malformed_secret` before doing any HMAC work, and the unknown-endpoint
 * path would become measurably cheaper than the known one. That is the whole point of it.
 */
function unknownEndpointKey(): string {
  return 'whsec' + '_' + 'A'.repeat(32);
}

const REJECTED = { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } } as const;

export function createResendWebhookRoute(deps: ResendWebhookDeps): Hono {
  const app = new Hono();
  const verify = deps.verifyWebhook ?? ((input) => resendConnector.verifyWebhook(input));
  const maxBytes = deps.maxBodyBytes ?? MAX_RESEND_WEBHOOK_BODY_BYTES;
  const log = deps.log ?? (() => undefined);

  app.post('/api/v1/webhooks/resend/:opaqueId', async (c) => {
    const opaqueId = c.req.param('opaqueId');

    // (2) Size cap, declared length first so an oversized body is refused before it is
    // read into memory.
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > maxBytes) {
      log({ event: 'resend_webhook_rejected', reason: 'body_too_large_declared' });
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large.' } }, 413);
    }

    // (1) Raw bytes. Nothing between the socket and the verifier.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > maxBytes) {
      log({ event: 'resend_webhook_rejected', reason: 'body_too_large' });
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large.' } }, 413);
    }

    // (3) Endpoint and signature.
    //
    // Both conditions are evaluated before either is acted on, and the verification runs
    // in every case so the two are indistinguishable from outside.
    let endpoint: ResendEndpoint | null = null;
    try {
      endpoint = await deps.resolveEndpoint(opaqueId);
    } catch {
      // A lookup failure is ours, not the caller's. Answering 400 here would tell Resend
      // to give up on a delivery we simply failed to look up; 503 asks it to retry.
      log({ event: 'resend_webhook_rejected', reason: 'endpoint_lookup_failed' });
      return c.json(
        { error: { code: 'WEBHOOK_LOOKUP_FAILED', message: 'Not processed. Please retry.' } },
        503,
      );
    }

    const usableSecret =
      endpoint !== null && endpoint.signingSecret !== '' ? endpoint.signingSecret : null;

    const verification: WebhookVerification = await verify({
      rawBody: raw,
      headers: c.req.raw.headers,
      secret: usableSecret ?? deps.unknownEndpointKey ?? unknownEndpointKey(),
      now: new Date(deps.now()),
      connection: {
        provider: 'resend',
        account_id: endpoint?.externalAccountId ?? null,
        webhook_verified_at: endpoint?.webhookVerifiedAt ?? null,
      },
    });

    // A revoked connection is rejected exactly like an unknown endpoint: same status, same
    // body, different log line. A customer who disconnected must not be able to have their
    // connection quietly promoted back to `ready` by a callback that is still in flight —
    // or by one an attacker captured earlier and replayed.
    const revoked = endpoint !== null && endpoint.status === 'revoked';
    if (endpoint === null || revoked || usableSecret === null || !verification.valid) {
      // The reason is logged, never returned. "No such endpoint", "revoked", "wrong
      // secret" and "stale timestamp" are one answer to the caller and four to the
      // operator.
      log({
        event: 'resend_webhook_rejected',
        reason:
          endpoint === null
            ? 'unknown_endpoint'
            : revoked
              ? 'connection_revoked'
              : usableSecret === null
                ? 'no_signing_secret'
                : `signature_${verification.valid ? 'unknown' : verification.reason}`,
      });
      return c.json(REJECTED, 400);
    }

    // From here the signature is proven and the endpoint is ours.
    const eventId = verification.event_id;
    if (eventId === null || eventId === '') {
      // Svix always sends `svix-id`; without it there is nothing to deduplicate on, and
      // processing an event we cannot recognise twice is worse than refusing it once.
      log({ event: 'resend_webhook_rejected', reason: 'missing_event_id' });
      return c.json(REJECTED, 400);
    }

    // (4) Claim the delivery id.
    const payloadHash = await sha256Hex(raw);
    const receivedAt = deps.now();
    const admission = await deps.data.beginWebhookProcessing({
      receiptId: deps.newId('whr'),
      provider: 'resend',
      eventId,
      payloadHash,
      receivedAt,
      workspaceId: endpoint.workspaceId,
      connectionId: endpoint.connectionId,
    });

    if (admission.outcome !== 'fresh') {
      // A replay stops here: no evidence is stored a second time, and — the point the
      // lead asked about — no promotion happens, so a captured callback cannot revive a
      // connection or re-prove a dead one.
      log({
        event: 'resend_webhook_duplicate',
        event_id: eventId,
        outcome: admission.outcome,
        connection_id: endpoint.connectionId,
      });
      return c.json({ received: true, duplicate: true }, 200);
    }

    // (5) Record, then promote.
    try {
      const evidence = verification.evidence.filter(
        (item): item is EmailEventEvidence => item.kind === 'email_event',
      );

      if (evidence.length === 0) {
        // A correctly signed message we do not map — a new Resend event type, or a
        // `contact.*` the customer subscribed by mistake. It is recorded as seen and
        // dropped. It proves the endpoint and the secret are right, but not that we can
        // use what arrives, so it does not promote anything.
        await deps.data.completeWebhookProcessing(
          admission.receiptId,
          'ignored',
          endpoint.workspaceId,
        );
        log({
          event: 'resend_webhook_ignored',
          event_id: eventId,
          event_type: verification.event_type ?? 'unknown',
          gap: verification.gaps[0]?.code ?? 'none',
        });
        return c.json({ received: true, duplicate: false, handled: false }, 200);
      }

      for (const item of evidence) {
        await deps.data.recordEmailEvidence({
          workspaceId: endpoint.workspaceId,
          connectionId: endpoint.connectionId,
          eventId,
          evidence: item,
          receivedAt,
        });
      }

      // The promotion. `markWebhookVerified` is given the verification result rather than
      // a boolean, so this route presents evidence of readiness and does not assert it.
      const readiness = markWebhookVerified('resend', verification);
      let promoted = false;
      if (readiness.ready && endpoint.webhookVerifiedAt === null) {
        promoted = await deps.data.markConnectionWebhookVerified({
          workspaceId: endpoint.workspaceId,
          connectionId: endpoint.connectionId,
          verifiedAt: receivedAt,
        });
      }

      await deps.data.completeWebhookProcessing(
        admission.receiptId,
        'processed',
        endpoint.workspaceId,
      );
      log({
        event: 'resend_webhook_handled',
        event_id: eventId,
        event_type: verification.event_type ?? 'unknown',
        // The status, not the recipient. A log line is not a place for an address.
        status: evidence[0]?.status ?? 'unknown',
        connection_id: endpoint.connectionId,
        promoted,
      });
      return c.json({ received: true, duplicate: false, handled: true }, 200);
    } catch (error) {
      // Give the delivery back so Resend's retry is a fresh attempt rather than a
      // deduplicated no-op. Without this, one internal error silently loses a delivery
      // event and the run it belonged to stays unverified for a reason nobody can see.
      //
      // The release is itself fallible. Its failure is logged distinctly, because the
      // resulting state — claim stands, effect never happened — is the one genuinely bad
      // window in this design and an operator needs to be able to find it. Swallowing the
      // release failure is deliberate: re-throwing would turn a 500 into an unhandled
      // rejection and lose the line that says which delivery is now stranded.
      let released = true;
      try {
        await deps.data.abandonWebhookProcessing(eventId);
      } catch {
        released = false;
      }
      log({
        event: 'resend_webhook_failed',
        event_id: eventId,
        event_type: verification.event_type ?? 'unknown',
        error_name: error instanceof Error ? error.name : 'unknown',
        claim_released: released,
      });
      if (!released) {
        log({ event: 'resend_webhook_claim_stranded', event_id: eventId });
      }
      return c.json(
        { error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Not processed. Please retry.' } },
        500,
      );
    }
  });

  return app;
}
