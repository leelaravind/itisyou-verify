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
import type {
  ResendEndpoint,
  ResendWebhookDataPort,
} from '../routes/webhooks/resend';
import type { WebhookAdmission, WebhookProcessingStatus } from './webhooks';
import type { Env } from '../lib/context';
import { addSecondsIso } from '../lib/time';
import { credentials } from './connections';
import type { Db } from './d1';
import { evidence } from './runs';
import { webhookReceipts } from './webhooks';

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
 * tenant-scope:exempt resolves the workspace FROM an opaque id the provider posted to,
 * which is the whole purpose of the lookup; the row carries its workspace_id and every
 * call the route makes afterwards passes it back in.
 */
export function createResendEndpointResolver(
  db: Db,
  env: Env,
): (opaqueId: string) => Promise<ResendEndpoint | null> {
  return async (opaqueId: string) => {
    if (typeof opaqueId !== 'string' || opaqueId.length < 16) return null;

    const row = await db
      .prepare(
        `SELECT id, workspace_id, status, external_account_id, last_check_at, webhook_path_id
           FROM connections
          WHERE webhook_path_id = ? AND provider = 'resend'`,
      )
      .bind(opaqueId)
      .first<{
        id: string;
        workspace_id: string;
        status: ResendEndpoint['status'];
        external_account_id: string | null;
        last_check_at: string | null;
      }>();
    if (row === null) return null;

    return {
      connectionId: row.id,
      workspaceId: row.workspace_id,
      signingSecret: await openWebhookSecret(db, env, row.workspace_id, row.id),
      status: row.status,
      externalAccountId: row.external_account_id,
      webhookVerifiedAt: row.last_check_at,
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

    await evidence.recordProviderEvent(this.db, {
      id,
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
            SET status = 'ready', last_check_at = ?, last_error_code = NULL
          WHERE workspace_id = ? AND id = ? AND status != 'revoked' AND revoked_at IS NULL`,
      )
      .bind(params.verifiedAt, params.workspaceId, params.connectionId)
      .run();
    return result.meta.changes === 1;
  }
}

/** Factory for the composition root. */
export function createResendWebhookData(db: Db): D1ResendWebhookDataPort {
  return new D1ResendWebhookDataPort(db);
}


