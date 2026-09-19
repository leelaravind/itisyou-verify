/**
 * Admission of customer source events — the most safety-critical write in the product.
 *
 * `admitOnce` must satisfy four rules simultaneously:
 *
 *  1. Exactly one run per `(workspace_id, external_event_id)`.
 *  2. Exactly one unit of plan allowance consumed per admitted event, never two for a
 *     retry.
 *  3. The run and its outbox row are committed together with the source event, so the
 *     scheduler can never see a run that the outbox does not know about (or the reverse).
 *  4. The same external id presented with a *different* payload is a conflict, not an
 *     overwrite. Silently accepting the second body would let a customer rewrite history.
 *
 * All of that happens in one `db.batch()`, which D1 documents as a single transaction
 * that rolls the whole sequence back if any statement fails.
 *
 * The allowance guard deserves a note. A conditional `UPDATE ... WHERE available >= 1`
 * inside a batch cannot abort the batch when it matches nothing — it simply reports zero
 * changes, and by then the inserts have already committed. So the reservation is written
 * as an assignment that becomes `NULL` when there is no allowance:
 *
 *     SET reserved = CASE WHEN (run_limit - consumed - reserved) >= 1 THEN reserved + 1 ELSE NULL END
 *
 * `entitlements.reserved` is `INTEGER NOT NULL`, so the exhausted case raises a NOT NULL
 * constraint failure and the entire batch — source event, run and outbox row — rolls
 * back. The "no entitlement row at all" case is caught by making every insert conditional
 * on that row existing, so nothing is written and the counts report it.
 */
import { AppError, type RunStatus } from '@verify/contracts';
import { changesAt, type Db, toSqlBool } from './d1';

export type SourceEventSource = 'signed_customer_event' | 'synthetic_demo' | 'owner_test';

export interface SourceEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly workflow_id: string;
  readonly source: SourceEventSource;
  readonly external_event_id: string;
  readonly received_at: string;
  readonly occurred_at: string;
  readonly correlation_key_hash: string;
  readonly payload_hash: string;
  readonly payload_json: string;
}

const SOURCE_EVENT_COLUMNS =
  'id, workspace_id, workflow_id, source, external_event_id, received_at, occurred_at, correlation_key_hash, payload_hash, payload_json';

export interface AdmitParams {
  readonly workspaceId: string;
  readonly billingPeriod: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly externalEventId: string;
  readonly source: SourceEventSource;
  readonly sourceEventId: string;
  readonly runId: string;
  readonly outboxId: string;
  readonly receivedAt: string;
  readonly occurredAt: string;
  readonly correlationKeyHash: string;
  readonly payloadHash: string;
  readonly payloadJson: string;
  readonly deadlineAt: string;
  /** When the scheduler should first look at this run. */
  readonly nextCheckAt: string;
  readonly isSynthetic?: boolean;
  readonly outboxEventType?: string;
  readonly outboxPayloadJson?: string;
}

export interface AdmitResult {
  readonly runId: string;
  readonly sourceEventId: string;
  readonly status: RunStatus;
  readonly deadlineAt: string;
  /** True when this call returned an existing run rather than creating one. */
  readonly duplicate: boolean;
}

interface ExistingRow {
  readonly source_event_id: string;
  readonly payload_hash: string;
  readonly run_id: string | null;
  readonly status: RunStatus | null;
  readonly deadline_at: string | null;
}

async function findExisting(
  db: Db,
  workspaceId: string,
  externalEventId: string,
): Promise<ExistingRow | null> {
  return db
    .prepare(
      `SELECT se.id AS source_event_id, se.payload_hash,
              r.id AS run_id, r.status, r.deadline_at
         FROM source_events se
         LEFT JOIN runs r ON r.source_event_id = se.id AND r.workspace_id = se.workspace_id
        WHERE se.workspace_id = ? AND se.external_event_id = ?`,
    )
    .bind(workspaceId, externalEventId)
    .first<ExistingRow>();
}

function duplicateResult(existing: ExistingRow, expectedPayloadHash: string): AdmitResult {
  if (existing.payload_hash !== expectedPayloadHash) {
    throw new AppError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'That event id has already been accepted with a different body.',
    );
  }
  if (existing.run_id === null || existing.status === null || existing.deadline_at === null) {
    // A source event with no run means a previous admission was interrupted between the
    // two inserts, which the batch makes impossible. Treat it as a hard fault rather than
    // inventing a run id.
    throw new Error('source event exists without a run; database is inconsistent');
  }
  return {
    runId: existing.run_id,
    sourceEventId: existing.source_event_id,
    status: existing.status,
    deadlineAt: existing.deadline_at,
    duplicate: true,
  };
}

export const sourceEvents = {
  async admitOnce(db: Db, params: AdmitParams): Promise<AdmitResult> {
    // Fast path: a retry is the common case and should not go anywhere near a failed
    // batch or a wasted id.
    const existing = await findExisting(db, params.workspaceId, params.externalEventId);
    if (existing !== null) return duplicateResult(existing, params.payloadHash);

    const outboxEventType = params.outboxEventType ?? 'run.created';
    const outboxPayload =
      params.outboxPayloadJson ??
      JSON.stringify({
        run_id: params.runId,
        workspace_id: params.workspaceId,
        workflow_id: params.workflowId,
      });

    const statements = [
      // 1. The source event. Conditional on the billing period row existing, so a
      //    workspace with no entitlement record writes nothing at all.
      db
        .prepare(
          `INSERT INTO source_events
             (id, workspace_id, workflow_id, source, external_event_id, received_at, occurred_at, correlation_key_hash, payload_hash, payload_json)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM entitlements WHERE workspace_id = ? AND billing_period = ?)`,
        )
        .bind(
          params.sourceEventId,
          params.workspaceId,
          params.workflowId,
          params.source,
          params.externalEventId,
          params.receivedAt,
          params.occurredAt,
          params.correlationKeyHash,
          params.payloadHash,
          params.payloadJson,
          params.workspaceId,
          params.billingPeriod,
        ),

      // 2. The run, proven to hang off the source event we just wrote in this workspace.
      db
        .prepare(
          `INSERT INTO runs
             (id, workspace_id, workflow_id, workflow_version_id, source_event_id, status, revision, observation_count, deadline_at, next_check_at, is_synthetic, created_at)
           SELECT ?, ?, ?, ?, ?, 'PENDING', 1, 0, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM source_events WHERE id = ? AND workspace_id = ?)`,
        )
        .bind(
          params.runId,
          params.workspaceId,
          params.workflowId,
          params.workflowVersionId,
          params.sourceEventId,
          params.deadlineAt,
          params.nextCheckAt,
          toSqlBool(params.isSynthetic ?? false),
          params.receivedAt,
          params.sourceEventId,
          params.workspaceId,
        ),

      // 3. The outbox row, committed with the run so dispatch can never be lost.
      db
        .prepare(
          `INSERT INTO outbox
             (id, workspace_id, event_type, entity_id, unique_event_key, payload_json, dispatch_state, attempts, next_attempt_at, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?
            WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND workspace_id = ?)`,
        )
        .bind(
          params.outboxId,
          params.workspaceId,
          outboxEventType,
          params.runId,
          `${outboxEventType}:${params.runId}`,
          outboxPayload,
          params.nextCheckAt,
          params.receivedAt,
          params.runId,
          params.workspaceId,
        ),

      // 4. Reserve exactly one unit. Becomes a NOT NULL violation — and therefore a
      //    rollback of statements 1 to 3 — when there is no allowance left.
      db
        .prepare(
          `UPDATE entitlements
              SET reserved = CASE WHEN (run_limit - consumed - reserved) >= 1 THEN reserved + 1 ELSE NULL END,
                  updated_at = ?
            WHERE workspace_id = ? AND billing_period = ?`,
        )
        .bind(params.receivedAt, params.workspaceId, params.billingPeriod),
    ];

    let results;
    try {
      results = await db.batch(statements);
    } catch {
      // Either a concurrent caller won the unique constraint on (workspace_id,
      // external_event_id), or the allowance guard fired. Re-reading is how we tell them
      // apart without parsing a driver-specific message. The driver error itself is not
      // surfaced: it names tables and constraints.
      const now = await findExisting(db, params.workspaceId, params.externalEventId);
      if (now !== null) return duplicateResult(now, params.payloadHash);
      throw new AppError(
        402,
        'ALLOWANCE_EXHAUSTED',
        'This workspace has used its plan allowance for the current period.',
      );
    }

    if (changesAt(results, 0) !== 1) {
      const now = await findExisting(db, params.workspaceId, params.externalEventId);
      if (now !== null) return duplicateResult(now, params.payloadHash);
      throw new AppError(
        402,
        'ENTITLEMENT_MISSING',
        'This workspace has no active plan period. Start or renew a subscription to run verifications.',
      );
    }
    if (changesAt(results, 1) !== 1 || changesAt(results, 2) !== 1 || changesAt(results, 3) !== 1) {
      throw new Error('sourceEvents.admitOnce wrote a partial batch');
    }

    return {
      runId: params.runId,
      sourceEventId: params.sourceEventId,
      status: 'PENDING',
      deadlineAt: params.deadlineAt,
      duplicate: false,
    };
  },

  async getByExternalId(
    db: Db,
    workspaceId: string,
    externalEventId: string,
  ): Promise<SourceEventRow | null> {
    return db
      .prepare(
        `SELECT ${SOURCE_EVENT_COLUMNS} FROM source_events
          WHERE workspace_id = ? AND external_event_id = ?`,
      )
      .bind(workspaceId, externalEventId)
      .first<SourceEventRow>();
  },

  async getById(db: Db, workspaceId: string, id: string): Promise<SourceEventRow | null> {
    return db
      .prepare(`SELECT ${SOURCE_EVENT_COLUMNS} FROM source_events WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SourceEventRow>();
  },

  /** The envelope behind a run, proven to belong to the same workspace as the run. */
  async getForRun(db: Db, workspaceId: string, runId: string): Promise<SourceEventRow | null> {
    return db
      .prepare(
        `SELECT ${SOURCE_EVENT_COLUMNS.split(', ')
          .map((c) => `se.${c}`)
          .join(', ')}
           FROM source_events se
           JOIN runs r ON r.source_event_id = se.id AND r.workspace_id = se.workspace_id
          WHERE r.workspace_id = ? AND r.id = ?`,
      )
      .bind(workspaceId, runId)
      .first<SourceEventRow>();
  },
};
