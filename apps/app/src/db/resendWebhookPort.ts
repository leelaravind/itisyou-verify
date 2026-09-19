/**
 * `ResendWebhookDataPort` and `ResendEndpointResolver` against D1.
 *
 * A04's route writes no SQL on purpose — a webhook route with its own SQL is a second
 * place tenant scoping has to be remembered — so everything it needs to touch the database
 * arrives through here.
 *
 * Two properties are load-bearing and neither is a formality:
 *
 * **The opaque path id is a lookup key, not a credential.** `resolveEndpoint` returns
 * `null` for an id we did not issue, and the route refuses on that result rather than on
 * the signature comparison. That ordering came from a finding where a valid signature over
 * an unknown endpoint id was accepted. `webhook_path_id` carries at least 128 bits of
 * randomness and is never derived from a workspace or connection id, because it lives in a
 * URL the customer pastes into somebody else's dashboard — it travels further than any
 * other identifier we hold and must say nothing about whose it is.
 *
 * **`markConnectionWebhookVerified` is a conditional write, not a check.** A revoked
 * connection can never be promoted back to `ready` by a callback that happens to verify.
 * The route checks this too; a route check is a check, and `WHERE status != 'revoked'` on
 * the statement itself is a guarantee. Withdrawal of access has to be final, or "revoke"
 * is advice rather than a control.
 */
import type { EmailEventEvidence } from '@verify/contracts';
import { openCredentialFor, randomBytes, sha256Hex, toBase64Url } from '@verify/security';
import { CREDENTIAL_PURPOSE } from '@verify/connectors';
import type { ResendEndpoint, ResendWebhookDataPort } from '../routes/webhooks/resend';
import type { WebhookAdmission, WebhookProcessingStatus } from './webhooks';
import type { Env } from '../lib/context';
import { addSecondsIso } from '../lib/time';
import { credentials } from './connections';
import type { Db } from './d1';
import { evidence } from './runs';
import { webhookReceipts } from './webhooks';

/**
 * The three distinct answers correlation can give.
 *
 * `unmatched` and `ambiguous` are deliberately not the same value. When both were `null`,
 * an ambiguous message id was indistinguishable from an unknown one, and the caller
 * treated "we cannot tell which of these two" as "we found nothing" and carried on to a
 * weaker handle. Neither is a match, and they are not the same problem.
 */
export type EvidenceCorrelation =
  | { readonly outcome: 'matched'; readonly runId: string }
  | { readonly outcome: 'unmatched'; readonly reason: string }
  | { readonly outcome: 'ambiguous'; readonly reason: string };

/** Per-workspace cap on parked callbacks. Oldest are evicted first once it is reached. */
const INBOX_MAX_ROWS_PER_WORKSPACE = 500;

/** How many parked rows one run will claim in a single pass. Bounded work per run. */
const INBOX_CLAIM_BATCH = 20;

/** How long an email-evidence row is kept. Mirrors `LIMITS.EVIDENCE_RETENTION_DAYS`. */
const EVIDENCE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Mint an opaque webhook path segment.
 *
 * 32 random bytes — 256 bits, comfortably past the 128 the brief requires — base64url, with
 * no prefix that would hint at what it addresses. It is derived from nothing: not the
 * workspace, not the connection, not the provider, not the time.
 */
export function newWebhookPathId(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * Issue (or re-issue) the opaque path id for a connection.
 *
 * Scoped by workspace, and `WHERE webhook_path_id IS NULL` unless `rotate` is set, so a
 * second connect attempt does not silently invalidate a URL the customer has already
 * pasted into Resend.
 */
export async function assignWebhookPathId(
  db: Db,
  params: {
    workspaceId: string;
    connectionId: string;
    pathId?: string;
    rotate?: boolean;
  },
): Promise<string | null> {
  const pathId = params.pathId ?? newWebhookPathId();
  const sql =
    params.rotate === true
      ? `UPDATE connections SET webhook_path_id = ?
          WHERE workspace_id = ? AND id = ? AND status != 'revoked'`
      : `UPDATE connections SET webhook_path_id = ?
          WHERE workspace_id = ? AND id = ? AND status != 'revoked' AND webhook_path_id IS NULL`;
  const result = await db.prepare(sql).bind(pathId, params.workspaceId, params.connectionId).run();
  if (result.meta.changes === 1) return pathId;

  // Either it already had one, or the connection is revoked. Report what is stored.
  const row = await db
    .prepare('SELECT webhook_path_id FROM connections WHERE workspace_id = ? AND id = ?')
    .bind(params.workspaceId, params.connectionId)
    .first<{ webhook_path_id: string | null }>();
  return row?.webhook_path_id ?? null;
}

/**
 * Resolve an opaque path id to the connection it was issued for.
 *
 * Returns `null` for an id we never issued — which is what the route refuses on. The
 * signing secret is decrypted here, with the AAD rebuilt from this row's own workspace,
 * provider and purpose, so a ciphertext moved between tenants yields nothing. A connection
 * that holds no usable secret returns an empty string rather than throwing: the route then
 * fails verification, which is the same answer a wrong secret gives.
 *
 * The lookup is by opaque id alone: resolving the workspace is its whole purpose, so a
 * workspace predicate here is impossible and would be theatre. The row carries its
 * workspace_id and every call the route makes afterwards passes it back in.
 */
export function createResendEndpointResolver(
  db: Db,
  env: Env,
): (opaqueId: string) => Promise<ResendEndpoint | null> {
  return async (opaqueId: string) => {
    if (typeof opaqueId !== 'string' || opaqueId.length < 16) return null;

    // tenant-scope:exempt resolves the workspace FROM a provider-posted opaque id.
    const row = await db
      .prepare(
        `SELECT id, workspace_id, status, external_account_id, webhook_verified_at, webhook_path_id
           FROM connections
          WHERE webhook_path_id = ? AND provider = 'resend'`,
      )
      .bind(opaqueId)
      .first<{
        id: string;
        workspace_id: string;
        status: ResendEndpoint['status'];
        external_account_id: string | null;
        webhook_verified_at: string | null;
      }>();
    if (row === null) return null;

    return {
      connectionId: row.id,
      workspaceId: row.workspace_id,
      signingSecret: await openWebhookSecret(db, env, row.workspace_id, row.id),
      status: row.status,
      externalAccountId: row.external_account_id,
      // The real column, not `last_check_at`. `last_check_at` is written when credentials
      // are validated, so it is never NULL once a connection exists -- substituting it here
      // made the route's `webhookVerifiedAt === null` promotion test permanently false.
      webhookVerifiedAt: row.webhook_verified_at,
    };
  };
}

/**
 * Open the stored Svix signing secret for one connection.
 *
 * Returns `''` when there is nothing usable — no envelope, no deployment key, or an
 * envelope that will not open. The route treats that as a failed verification, which is
 * the honest outcome: we cannot check the signature, so we do not accept the event.
 */
async function openWebhookSecret(
  db: Db,
  env: Env,
  workspaceId: string,
  connectionId: string,
): Promise<string> {
  const keyBase64 = env.CREDENTIAL_KEY_V1;
  if (keyBase64 === undefined || keyBase64.length === 0) return '';

  const envelope = await credentials.activeForScope(
    db,
    workspaceId,
    connectionId,
    CREDENTIAL_PURPOSE.WEBHOOK_SECRET,
  );
  if (envelope === null) return '';

  try {
    return await openCredentialFor(
      {
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
        aad: envelope.aad,
        key_version: envelope.key_version,
      },
      { workspaceId, provider: 'resend', purpose: CREDENTIAL_PURPOSE.WEBHOOK_SECRET },
      { keyBase64 },
    );
  } catch {
    // A secret we cannot open is not a secret we can verify with. Never a partial answer.
    return '';
  }
}

export class D1ResendWebhookDataPort implements ResendWebhookDataPort {
  constructor(
    private readonly db: Db,
    private readonly provider = 'resend',
    /**
     * Called when a delivery event could not be bound to a run.
     *
     * Optional, and never throws into the webhook path: a provider callback must not fail
     * because we could not tell whose it was. It exists so that "nothing correlated" is
     * observable. A workspace whose automation never sends `expected.email_message_id`
     * will bind no evidence at all and every run will end UNVERIFIED -- which is the
     * correct verdict, and is a configuration problem that should be visible rather than
     * looking like a quiet success.
     */
    readonly onCorrelationMiss?: (miss: {
      workspaceId: string;
      connectionId: string;
      outcome: 'unmatched' | 'ambiguous';
      reason: string;
      messageId: string;
    }) => void,
  ) {}

  async beginWebhookProcessing(params: {
    receiptId: string;
    provider: string;
    eventId: string;
    payloadHash: string;
    receivedAt: string;
    workspaceId?: string | null;
    connectionId?: string | null;
  }): Promise<WebhookAdmission> {
    const admission = await webhookReceipts.recordOnce(this.db, {
      id: params.receiptId,
      provider: params.provider,
      eventId: params.eventId,
      payloadHash: params.payloadHash,
      receivedAt: params.receivedAt,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
      ...(params.connectionId !== undefined ? { connectionId: params.connectionId } : {}),
    });
    return { outcome: admission.outcome, receiptId: admission.receiptId };
  }

  async completeWebhookProcessing(
    receiptId: string,
    status: WebhookProcessingStatus,
    workspaceId?: string | null,
  ): Promise<void> {
    await webhookReceipts.setStatus(this.db, receiptId, status);
    if (workspaceId !== undefined && workspaceId !== null) {
      await webhookReceipts.attachWorkspace(this.db, receiptId, workspaceId);
    }
  }

  /**
   * Give the event back so the provider's retry is a fresh attempt.
   *
   * Without this, a handler that threw after claiming the receipt would make every retry
   * look like a duplicate, and the delivery event would be lost permanently.
   */
  async abandonWebhookProcessing(eventId: string): Promise<void> {
    await webhookReceipts.abandon(this.db, this.provider, eventId);
  }

  /**
   * Persist one verified email event, idempotently on `(workspaceId, eventId)`.
   *
   * The evidence row is not attached to a run here. A delivery event arrives before,
   * during or after the run it belongs to, and guessing which run it correlates with is
   * the evaluator's job, not a webhook's. The row carries its message id and its provider
   * account so the evaluator can find it.
   *
   * `redacted_summary` is built from normalised fields only and the recipient is masked
   * before it is stored — a whole provider payload must never reach that column.
   */
  async recordEmailEvidence(params: {
    workspaceId: string;
    connectionId: string;
    eventId: string;
    evidence: EmailEventEvidence;
    receivedAt: string;
  }): Promise<void> {
    const digest = await sha256Hex(
      `${params.workspaceId}|${params.eventId}|${params.evidence.message_id}|${params.evidence.status}`,
    );
    // The id is derived from the digest, so a repeated call writes the same primary key
    // and `DO NOTHING` makes the second one a no-op rather than a second row.
    const id = `evd_${digest.slice(0, 32)}`;

    const correlation = await this.#correlateEmailEvidence(
      params.workspaceId,
      params.connectionId,
      params.evidence,
    );
    if (correlation.outcome !== 'matched') {
      // Nothing is written. Evidence we cannot place is not evidence about any particular
      // enquiry, and the run it would otherwise land on is somebody's real one. Missing
      // evidence reads as UNVERIFIED; misattributed evidence reads as a pass.
      //
      // The reason is surfaced rather than swallowed: a connection whose customer never
      // sends `expected.email_message_id` will correlate nothing at all, and that should be
      // visible as a configuration problem instead of looking like quiet success.
      // Parked, not dropped. A delivery event can legitimately arrive before the signed
      // source event that describes the enquiry -- the provider fires `email.sent` in
      // milliseconds and the customer's automation reports the enquiry afterwards -- and
      // this is the only record that the message was ever delivered.
      await this.#parkUnmatched({
        workspaceId: params.workspaceId,
        connectionId: params.connectionId,
        eventId: params.eventId,
        reason: correlation.outcome,
        digest,
        evidence: params.evidence,
        receivedAt: params.receivedAt,
      });
      this.onCorrelationMiss?.({
        workspaceId: params.workspaceId,
        connectionId: params.connectionId,
        outcome: correlation.outcome,
        reason: correlation.reason,
        // The provider's own id, which is not a secret and is the only way to trace one.
        messageId: params.evidence.message_id,
      });
      return;
    }
    const runId = correlation.runId;

    await evidence.recordProviderEvent(this.db, {
      id,
      runId,
      workspaceId: params.workspaceId,
      provider: params.evidence.provider,
      origin: params.evidence.origin,
      providerRecordId: params.evidence.message_id,
      observedAt: params.evidence.observed_at,
      contentDigest: digest,
      redactedSummary: JSON.stringify({
        kind: params.evidence.kind,
        status: params.evidence.status,
        message_id: params.evidence.message_id,
        provider_account_id: params.evidence.provider_account_id,
        occurred_at: params.evidence.occurred_at,
      }),
      expiresAt: addSecondsIso(params.receivedAt, EVIDENCE_RETENTION_SECONDS),
    });
  }

  /**
   * Find the one run this delivery event is about, or say why we cannot.
   *
   * **The provider's message id is the only thing that binds. The recipient never binds.**
   *
   * An earlier version tried the message id and, failing that, fell back to matching the
   * recipient address. That fallback is wrong in four distinct ways, each of which lets a
   * delivery attach to an enquiry it has nothing to do with:
   *
   *  - A run naming message M1 would accept a delivery for some unrelated message, because
   *    the unrelated id matched nothing and the address then matched everything.
   *  - Two runs naming the SAME id -- genuinely ambiguous -- were disambiguated by address,
   *    which is to say the ambiguity was resolved by a fact that says nothing about it.
   *  - A delivery for an already-decided run fell through to a newer pending run sharing
   *    the address, so an old callback silently answered a new enquiry.
   *  - A run naming no id at all accepted any delivery to its address.
   *
   * The single rule that closes all four: an address is evidence about an address, not
   * about an enquiry. Two enquiries to the same customer share a recipient and are still
   * two enquiries. So recipient equality is an **assertion the evaluator makes after
   * binding**, never a substitute for the binding itself -- which is why binding on the
   * right id with the wrong recipient is correct here and produces a CONTRADICTED
   * assertion downstream, rather than being quietly dropped as a mismatch.
   *
   * Zero matches and several matches are returned as different answers rather than both as
   * null. Collapsing them is what allowed "ambiguous" to be treated as "not found" and fall
   * onward to the address.
   *
   * Only `PENDING` runs are considered: a decided run is not waiting on anything, and
   * re-opening one on a late webhook would change a verdict already published.
   */
  async #correlateEmailEvidence(
    workspaceId: string,
    connectionId: string,
    item: EmailEventEvidence,
  ): Promise<EvidenceCorrelation> {
    const messageId = (item.message_id ?? '').trim();
    if (messageId === '') {
      // No handle at all. There is nothing to bind on, and the address is not one.
      return { outcome: 'unmatched', reason: 'event_carries_no_message_id' };
    }

    // Tenant AND connection ownership. The endpoint resolver reads both from one
    // connections row so they agree by construction; asserting it here means a future
    // caller that assembles them separately cannot bind across a boundary by accident.
    const owns = await this.db
      .prepare(`SELECT 1 AS ok FROM connections WHERE id = ? AND workspace_id = ?`)
      .bind(connectionId, workspaceId)
      .first<{ ok: number }>();
    if (owns === null) {
      return { outcome: 'unmatched', reason: 'connection_not_owned_by_workspace' };
    }

    const result = await this.db
      .prepare(
        `SELECT r.id AS id
           FROM runs r
           JOIN source_events se
             ON se.id = r.source_event_id AND se.workspace_id = r.workspace_id
          WHERE r.workspace_id = ?
            AND r.status = 'PENDING'
            AND json_extract(se.payload_json, '$.expected.email_message_id') = ?
          LIMIT 2`,
      )
      .bind(workspaceId, messageId)
      .all<{ id: string }>();

    const rows = result.results;
    // LIMIT 2 exists so that "more than one" is observable. A LIMIT 1 would return the
    // first of several and look exactly like a clean single match.
    if (rows.length === 0) return { outcome: 'unmatched', reason: 'no_run_expects_this_message' };
    if (rows.length > 1) return { outcome: 'ambiguous', reason: 'several_runs_expect_this_message' };

    const id = rows[0]?.id;
    return id === undefined
      ? { outcome: 'unmatched', reason: 'no_run_expects_this_message' }
      : { outcome: 'matched', runId: id };
  }

  /**
   * Park an authenticated callback we could not bind, and keep the inbox bounded.
   *
   * Three bounds, because an inbox nobody empties fills a disk:
   *   * `UNIQUE (workspace_id, provider, provider_event_id)` -- a provider replaying the
   *     same delivery writes one row, so a retry storm cannot inflate it.
   *   * `expires_at` -- swept on the evidence retention schedule.
   *   * a per-workspace row cap, oldest evicted first, so one noisy tenant cannot consume
   *     the table on behalf of the others.
   *
   * Nothing here can fail the webhook. A provider callback must not be retried forever
   * because our inbox was full, so eviction happens before the insert rather than the
   * insert being refused.
   */
  async #parkUnmatched(params: {
    workspaceId: string;
    connectionId: string;
    eventId: string;
    reason: 'unmatched' | 'ambiguous';
    digest: string;
    evidence: EmailEventEvidence;
    receivedAt: string;
  }): Promise<void> {
    const messageId = (params.evidence.message_id ?? '').trim();
    // Nothing addressable means nothing claimable. Parking it would only grow the table.
    if (messageId === '') return;

    await this.db
      .prepare(
        `DELETE FROM evidence_inbox
          WHERE workspace_id = ?
            AND id NOT IN (
              SELECT id FROM evidence_inbox
               WHERE workspace_id = ?
               ORDER BY received_at DESC
               LIMIT ?
            )`,
      )
      .bind(params.workspaceId, params.workspaceId, INBOX_MAX_ROWS_PER_WORKSPACE - 1)
      .run();

    await this.db
      .prepare(
        `INSERT INTO evidence_inbox
           (id, workspace_id, connection_id, provider, provider_event_id, message_id,
            reason, content_digest, redacted_summary, observed_at, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, provider, provider_event_id) DO NOTHING`,
      )
      .bind(
        `ebx_${params.digest.slice(0, 32)}`,
        params.workspaceId,
        params.connectionId,
        this.provider,
        params.eventId,
        messageId,
        params.reason,
        params.digest,
        // The same masked summary the evidence row would carry. No recipient, no payload.
        JSON.stringify({
          kind: params.evidence.kind,
          status: params.evidence.status,
          message_id: params.evidence.message_id,
          provider_account_id: params.evidence.provider_account_id,
          occurred_at: params.evidence.occurred_at,
        }),
        params.evidence.observed_at,
        params.receivedAt,
        addSecondsIso(params.receivedAt, EVIDENCE_RETENTION_SECONDS),
      )
      .run();
  }

  /**
   * Claim parked callbacks for a run that turns out to have been waiting for them.
   *
   * This is the recovery path for the out-of-order case, and it applies the same rule the
   * live path does: only the message id binds, and only an unambiguous match. Rows parked
   * as `ambiguous` are never claimed -- an ambiguity does not become resolvable later just
   * because one of its candidates asked.
   *
   * Idempotent. The evidence id is derived from the same digest the live path uses, so a
   * claim that races a live write collides on the primary key and does nothing rather than
   * writing a second row for one observation.
   */
  async claimInboxForRun(params: {
    workspaceId: string;
    runId: string;
    messageId: string;
    now: string;
  }): Promise<number> {
    const messageId = (params.messageId ?? '').trim();
    if (messageId === '') return 0;

    const parked = await this.db
      .prepare(
        `SELECT id, provider, content_digest, redacted_summary, observed_at, expires_at
           FROM evidence_inbox
          WHERE workspace_id = ?
            AND message_id = ?
            AND reason = 'unmatched'
            AND claimed_at IS NULL
            AND expires_at > ?
          ORDER BY received_at ASC
          LIMIT ?`,
      )
      .bind(params.workspaceId, messageId, params.now, INBOX_CLAIM_BATCH)
      .all<{
        id: string;
        provider: string;
        content_digest: string;
        redacted_summary: string;
        observed_at: string;
        expires_at: string;
      }>();

    let claimed = 0;
    for (const row of parked.results) {
      const written = await evidence.recordProviderEvent(this.db, {
        id: `evd_${row.content_digest.slice(0, 32)}`,
        runId: params.runId,
        workspaceId: params.workspaceId,
        provider: row.provider,
        origin: 'provider_webhook',
        providerRecordId: messageId,
        observedAt: row.observed_at,
        contentDigest: row.content_digest,
        redactedSummary: row.redacted_summary,
        expiresAt: row.expires_at,
      });
      // Marked claimed either way: a collision means the live path already wrote this
      // observation, so the parked copy has done its job and must not be retried forever.
      await this.db
        .prepare(
          `UPDATE evidence_inbox
              SET claimed_at = ?, claimed_run_id = ?
            WHERE id = ? AND workspace_id = ? AND claimed_at IS NULL`,
        )
        .bind(params.now, params.runId, row.id, params.workspaceId)
        .run();
      if (written) claimed += 1;
    }
    return claimed;
  }

  /**
   * Promote a connection to `ready` because a signed callback arrived and was understood.
   *
   * **`AND status != 'revoked'` is the point of this method.** A customer who withdrew our
   * access must not have it restored by a callback that happens to verify — a revoked
   * connection whose signing secret is still valid at the provider would otherwise
   * resurrect itself on the next delivery event. The route checks the status too; this is
   * the check that cannot be forgotten, because it is the write.
   */
  async markConnectionWebhookVerified(params: {
    workspaceId: string;
    connectionId: string;
    verifiedAt: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE connections
            SET status = 'ready',
                last_check_at = ?,
                webhook_verified_at = ?,
                last_error_code = NULL
          WHERE workspace_id = ? AND id = ? AND status != 'revoked' AND revoked_at IS NULL`,
      )
      .bind(params.verifiedAt, params.verifiedAt, params.workspaceId, params.connectionId)
      .run();
    return result.meta.changes === 1;
  }
}

/** Factory for the composition root. */
export function createResendWebhookData(db: Db): D1ResendWebhookDataPort {
  return new D1ResendWebhookDataPort(db);
}
