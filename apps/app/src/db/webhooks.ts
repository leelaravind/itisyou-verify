/**
 * Inbound provider webhooks and the outbound dispatch queue.
 *
 * `webhook_receipts` is the at-most-once gate for provider callbacks: providers retry,
 * and a retried Stripe or Resend event must not be processed twice. `outbox` is the
 * bridge between "the row is committed" and "the job has been dispatched", which is why
 * outbox rows are written inside the same batch as the work that produced them.
 */
import { type Db, orNull } from './d1';

export type WebhookProcessingStatus =
  | 'received'
  | 'processed'
  | 'ignored'
  | 'invalid'
  | 'duplicate';

export interface WebhookReceiptRow {
  readonly id: string;
  readonly provider: string;
  readonly connection_id: string | null;
  readonly workspace_id: string | null;
  readonly event_id: string;
  readonly payload_hash: string;
  readonly received_at: string;
  readonly processing_status: WebhookProcessingStatus;
}

const RECEIPT_COLUMNS =
  'id, provider, connection_id, workspace_id, event_id, payload_hash, received_at, processing_status';

export const webhookReceipts = {
  /**
   * Record a receipt, once. Returns `{ fresh: false }` when this provider event id has
   * already been seen — the caller must then acknowledge with 200 and do nothing else.
   *
   * `ON CONFLICT DO NOTHING` plus `meta.changes` is the whole test: no read-then-write,
   * so two concurrent deliveries of the same event cannot both be fresh.
   */
  async recordOnce(
    db: Db,
    params: {
      id: string;
      provider: string;
      eventId: string;
      payloadHash: string;
      receivedAt: string;
      workspaceId?: string | null;
      connectionId?: string | null;
    },
  ): Promise<{ fresh: boolean; receiptId: string }> {
    const result = await db
      .prepare(
        `INSERT INTO webhook_receipts (id, provider, connection_id, workspace_id, event_id, payload_hash, received_at, processing_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'received')
         ON CONFLICT(provider, event_id) DO NOTHING`,
      )
      .bind(
        params.id,
        params.provider,
        orNull(params.connectionId),
        orNull(params.workspaceId),
        params.eventId,
        params.payloadHash,
        params.receivedAt,
      )
      .run();
    if (result.meta.changes === 1) return { fresh: true, receiptId: params.id };

    const existing = await db
      .prepare('SELECT id FROM webhook_receipts WHERE provider = ? AND event_id = ?')
      .bind(params.provider, params.eventId)
      .first<{ id: string }>();
    return { fresh: false, receiptId: existing?.id ?? params.id };
  },

  async setStatus(
    db: Db,
    receiptId: string,
    status: WebhookProcessingStatus,
  ): Promise<boolean> {
    const result = await db
      .prepare('UPDATE webhook_receipts SET processing_status = ? WHERE id = ?')
      .bind(status, receiptId)
      .run();
    return result.meta.changes === 1;
  },

  /** Workspace-scoped listing for the customer-visible connection health page. */
  async listForWorkspace(
    db: Db,
    workspaceId: string,
    limit = 25,
  ): Promise<WebhookReceiptRow[]> {
    const result = await db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM webhook_receipts
          WHERE workspace_id = ? ORDER BY received_at DESC LIMIT ?`,
      )
      .bind(workspaceId, Math.min(Math.max(1, limit), 100))
      .all<WebhookReceiptRow>();
    return result.results;
  },
};

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

export type DispatchState = 'pending' | 'dispatched' | 'failed' | 'dead';

export interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly event_type: string;
  readonly entity_id: string;
  readonly unique_event_key: string;
  readonly payload_json: string;
  readonly dispatch_state: DispatchState;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly last_error: string | null;
  readonly created_at: string;
}

const OUTBOX_COLUMNS =
  'id, workspace_id, event_type, entity_id, unique_event_key, payload_json, dispatch_state, attempts, next_attempt_at, last_error, created_at';

export const outbox = {
  /**
   * Enqueue, keyed by `unique_event_key`. A duplicate enqueue is a no-op, which is what
   * makes "commit then dispatch" safe to retry.
   *
   * Prefer adding the statement to the caller's own batch when the enqueue must be atomic
   * with a business write — `sourceEvents.admitOnce` does exactly that.
   */
  async enqueue(
    db: Db,
    params: {
      id: string;
      workspaceId?: string | null;
      eventType: string;
      entityId: string;
      uniqueEventKey: string;
      payloadJson: string;
      nextAttemptAt: string;
      createdAt: string;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, event_type, entity_id, unique_event_key, payload_json, dispatch_state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(unique_event_key) DO NOTHING`,
      )
      .bind(
        params.id,
        orNull(params.workspaceId),
        params.eventType,
        params.entityId,
        params.uniqueEventKey,
        params.payloadJson,
        params.nextAttemptAt,
        params.createdAt,
      )
      .run();
    return result.meta.changes === 1;
  },

  /** Bounded due query against `idx_outbox_due`. Cross-tenant; rows carry their scope. */
  async listDue(db: Db, now: string, limit = 25): Promise<OutboxRow[]> {
    const result = await db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox
          WHERE dispatch_state = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC LIMIT ?`,
      )
      .bind(now, Math.min(Math.max(1, limit), 100))
      .all<OutboxRow>();
    return result.results;
  },

  /**
   * Compare-and-set claim on `(id, attempts)`, mirroring the run lease: two dispatchers
   * in the same tick cannot both take one row.
   */
  async tryClaim(
    db: Db,
    params: { id: string; expectedAttempts: number; leaseUntil: string },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?
          WHERE id = ? AND attempts = ? AND dispatch_state = 'pending'`,
      )
      .bind(params.leaseUntil, params.id, params.expectedAttempts)
      .run();
    return result.meta.changes === 1;
  },

  async markDispatched(db: Db, id: string): Promise<boolean> {
    const result = await db
      .prepare("UPDATE outbox SET dispatch_state = 'dispatched', last_error = NULL WHERE id = ?")
      .bind(id)
      .run();
    return result.meta.changes === 1;
  },

  /** A bounded failure: re-arm for another attempt, or bury it once the budget is spent. */
  async markFailed(
    db: Db,
    params: { id: string; error: string; nextAttemptAt: string; maxAttempts: number },
  ): Promise<DispatchState> {
    const row = await db
      .prepare(
        `UPDATE outbox
            SET dispatch_state = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
                last_error = ?, next_attempt_at = ?
          WHERE id = ?
          RETURNING dispatch_state`,
      )
      .bind(params.maxAttempts, params.error.slice(0, 500), params.nextAttemptAt, params.id)
      .first<{ dispatch_state: DispatchState }>();
    if (row === null) throw new Error('outbox.markFailed: row not found');
    return row.dispatch_state;
  },
};
