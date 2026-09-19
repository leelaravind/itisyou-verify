/**
 * `SupportDataPort` against D1, plus the two adapters A09 asked for.
 *
 * The four requirements A09 marked load-bearing are all in `supportData.ts`:
 * insert-once notifications, conditional `transitionCase`, keyset retention reads, and
 * export pages that return exactly the declared columns in order.
 *
 * The export contract is checked on both sides on purpose. `privacy/export.ts` refuses a
 * page whose columns are not its allowlist; `EXPORT_PAGE_COLUMNS` here is the list this
 * side actually produces. A test asserts the two are identical, so adding a column to one
 * without the other fails loudly instead of putting a new field in a customer's file.
 */
import { AppError } from '@verify/contracts';
import { fromBase64Url, toBase64Url } from '@verify/security';
import type {
  ClaimNotificationParams,
  ClaimNotificationResult,
  ExpiredRowRef,
  ExportPage,
  ExportSection,
  ListExpiredParams,
  NotificationDeliveryRecord,
  NotificationHistoryQuery,
  RateLimitOutcome,
  RateLimiter,
  PurgeTarget,
  ReadExportPageParams,
  RetainedCounts,
  RetentionTarget,
  SettleNotificationParams,
  StalePendingQuery,
  SupportCaseListQuery,
  SupportCasePage,
  SupportCaseRecord,
  SupportCategory,
  SupportDataPort,
  TransitionCaseParams,
  WorkspaceSummary,
} from '../support/port';
import { consume } from '../lib/ratelimit';
import type { Db } from './d1';
import { workspaces } from './identity';
import {
  EXPORT_PAGE_COLUMNS,
  exportPages,
  notifications,
  retention,
  supportCases,
  type NotificationRow,
  type SupportCaseRow,
} from './supportData';

/* -------------------------------------------------------------------------- */
/* cursors                                                                     */
/* -------------------------------------------------------------------------- */

/** Opaque keyset cursor over `(created_at, id)` for the case list. */
function encodeCaseCursor(createdAt: string, id: string): string {
  return toBase64Url(new TextEncoder().encode(`sc1|${createdAt}|${id}`));
}

function decodeCaseCursor(value: string | null | undefined): { createdAt: string; id: string } | null {
  if (value === undefined || value === null || value === '') return null;
  let text: string;
  try {
    text = new TextDecoder().decode(fromBase64Url(value));
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'That page cursor is not valid.');
  }
  const parts = text.split('|');
  if (parts.length !== 3 || parts[0] !== 'sc1' || !parts[1] || !parts[2]) {
    throw new AppError(400, 'INVALID_CURSOR', 'That page cursor is not valid.');
  }
  return { createdAt: parts[1], id: parts[2] };
}

/** Export cursors are just the last key seen; empty string starts at the beginning. */
function decodeExportCursor(value: string | null): string {
  return value === null || value === '' ? '' : value;
}

/* -------------------------------------------------------------------------- */
/* mapping                                                                     */
/* -------------------------------------------------------------------------- */

const toCase = (row: SupportCaseRow): SupportCaseRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  contactEmail: row.contact_email,
  subject: row.subject,
  bodyRedacted: row.body_redacted,
  category: row.category as SupportCategory,
  priority: row.priority,
  state: row.state,
  linkedRunId: row.linked_run_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toNotification = (row: NotificationRow): NotificationDeliveryRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  notificationKey: row.notification_key,
  channel: 'email',
  recipientHash: row.recipient_hash,
  template: row.template,
  state: row.state,
  attemptCount: row.attempt_count,
  providerStatus: row.provider_status,
  createdAt: row.created_at,
  sentAt: row.sent_at,
});

/* -------------------------------------------------------------------------- */
/* the port                                                                    */
/* -------------------------------------------------------------------------- */

export class D1SupportDataPort implements SupportDataPort {
  constructor(private readonly db: Db) {}

  /* --- support cases --- */

  async insertCase(record: SupportCaseRecord): Promise<SupportCaseRecord> {
    await supportCases.insert(this.db, {
      id: record.id,
      workspace_id: record.workspaceId,
      contact_email: record.contactEmail,
      subject: record.subject,
      body_redacted: record.bodyRedacted,
      category: record.category,
      priority: record.priority,
      state: record.state,
      linked_run_id: record.linkedRunId,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
    return record;
  }

  async getCase(id: string, workspaceId: string | null): Promise<SupportCaseRecord | null> {
    const row = await supportCases.get(this.db, id, workspaceId);
    return row === null ? null : toCase(row);
  }

  async getCaseForOwner(id: string): Promise<SupportCaseRecord | null> {
    const row = await supportCases.getForOwner(this.db, id);
    return row === null ? null : toCase(row);
  }

  async listCases(query: SupportCaseListQuery): Promise<SupportCasePage> {
    const limit = Math.min(Math.max(1, query.limit), 100);
    const scope =
      query.workspaceId === undefined
        ? ({ kind: 'all' } as const)
        : query.workspaceId === null
          ? ({ kind: 'anonymous' } as const)
          : ({ kind: 'workspace', workspaceId: query.workspaceId } as const);

    const rows = await supportCases.list(this.db, {
      scope,
      ...(query.state !== undefined ? { state: query.state } : {}),
      limit: limit + 1,
      cursor: decodeCaseCursor(query.cursor),
    });

    const items = rows.slice(0, limit).map(toCase);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined ? encodeCaseCursor(last.createdAt, last.id) : null;
    return { items, nextCursor };
  }

  async transitionCase(params: TransitionCaseParams): Promise<boolean> {
    return supportCases.transition(this.db, {
      id: params.id,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
      expectedState: params.expectedState,
      nextState: params.nextState,
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      updatedAt: params.updatedAt,
    });
  }

  /* --- notifications --- */

  async claimNotification(params: ClaimNotificationParams): Promise<ClaimNotificationResult> {
    const result = await notifications.claim(this.db, {
      id: params.id,
      workspace_id: params.workspaceId,
      notification_key: params.notificationKey,
      channel: params.channel,
      recipient_hash: params.recipientHash,
      template: params.template,
      created_at: params.createdAt,
    });
    return { inserted: result.inserted, record: toNotification(result.record) };
  }

  async settleNotification(params: SettleNotificationParams): Promise<void> {
    await notifications.settle(this.db, {
      notificationKey: params.notificationKey,
      state: params.state,
      attemptCount: params.attemptCount,
      providerStatus: params.providerStatus,
      settledAt: params.settledAt,
    });
  }

  async getNotification(notificationKey: string): Promise<NotificationDeliveryRecord | null> {
    const row = await notifications.getByKey(this.db, notificationKey);
    return row === null ? null : toNotification(row);
  }

  async findNotifications(
    query: NotificationHistoryQuery,
  ): Promise<readonly NotificationDeliveryRecord[]> {
    const rows = await notifications.findHistory(this.db, {
      workspaceId: query.workspaceId,
      template: query.template,
      since: query.since,
      ...(query.keyPrefix !== undefined ? { keyPrefix: query.keyPrefix } : {}),
    });
    return rows.map(toNotification);
  }

  async listStalePendingNotifications(
    query: StalePendingQuery,
  ): Promise<readonly NotificationDeliveryRecord[]> {
    const rows = await notifications.listStalePending(this.db, {
      createdBefore: query.createdBefore,
      limit: query.limit,
      ...(query.afterId !== undefined ? { afterId: query.afterId } : {}),
      ...(query.channel !== undefined ? { channel: query.channel } : {}),
    });
    return rows.map(toNotification);
  }

  /* --- retention --- */

  async listExpired(params: ListExpiredParams): Promise<readonly ExpiredRowRef[]> {
    const rows = await retention.listExpired(this.db, {
      target: params.target,
      expiredAt: params.expiredAt,
      afterId: params.afterId,
      limit: params.limit,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
    });
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id }));
  }

  async deleteRows(target: RetentionTarget, ids: readonly string[]): Promise<number> {
    return retention.deleteRows(this.db, target, ids);
  }

  async purgeWorkspaceRows(
    workspaceId: string,
    target: PurgeTarget,
    limit: number,
  ): Promise<number> {
    return retention.purgeWorkspaceRows(this.db, workspaceId, target, limit);
  }

  /* --- checkpoints --- */

  async readCheckpoint(key: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .bind(`retention.checkpoint.${key}`)
      .first<{ value_json: string }>();
    if (row === null) return null;
    try {
      const parsed: unknown = JSON.parse(row.value_json);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  async writeCheckpoint(key: string, value: string | null): Promise<void> {
    const storageKey = `retention.checkpoint.${key}`;
    if (value === null) {
      await this.db.prepare('DELETE FROM settings WHERE key = ?').bind(storageKey).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(storageKey, JSON.stringify(value), new Date().toISOString())
      .run();
  }

  /* --- export --- */

  async readExportPage(params: ReadExportPageParams): Promise<ExportPage> {
    const limit = Math.min(Math.max(1, params.limit), 500);
    const { rows, lastId } = await exportPages.read(this.db, {
      workspaceId: params.workspaceId,
      section: params.section as ExportSection,
      afterId: decodeExportCursor(params.cursor),
      limit,
    });
    return {
      section: params.section,
      columns: EXPORT_PAGE_COLUMNS[params.section],
      rows,
      // A short page is the last page. Emitting a cursor for it would cost one extra
      // round trip per section on every export.
      nextCursor: rows.length < limit || lastId === null ? null : lastId,
    };
  }

  /* --- deletion --- */

  async getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null> {
    const row = await workspaces.findById(this.db, workspaceId);
    if (row === null) return null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    };
  }

  /** Sessions have no workspace column; membership is the join that scopes them. */
  async revokeSessions(workspaceId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE revoked_at IS NULL
            AND user_id IN (SELECT user_id FROM memberships WHERE workspace_id = ?)`,
      )
      .bind(new Date().toISOString(), workspaceId)
      .run();
    return result.meta.changes;
  }

  async revokeCredentials(workspaceId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE credential_versions SET retired_at = ?
          WHERE retired_at IS NULL
            AND connection_id IN (SELECT id FROM connections WHERE workspace_id = ?)`,
      )
      .bind(new Date().toISOString(), workspaceId)
      .run();
    return result.meta.changes;
  }

  /**
   * Stop anything that would run again: clear the due marker on every run and bury every
   * pending outbox row. Both in one batch, so there is no window in which the scheduler
   * picks up a run whose outbox row has just been buried.
   */
  async stopScheduledWork(workspaceId: string): Promise<number> {
    const results = await this.db.batch([
      this.db
        .prepare(
          'UPDATE runs SET next_check_at = NULL WHERE workspace_id = ? AND next_check_at IS NOT NULL',
        )
        .bind(workspaceId),
      this.db
        .prepare(
          "UPDATE outbox SET dispatch_state = 'dead' WHERE workspace_id = ? AND dispatch_state = 'pending'",
        )
        .bind(workspaceId),
    ]);
    let stopped = 0;
    for (const result of results) stopped += result.meta.changes;
    return stopped;
  }

  /**
   * There is no public-report-link table in `migrations/0001_init.sql`, so the honest
   * answer today is zero: nothing was expired because nothing exists to expire.
   *
   * Deliberately not stubbed out and deliberately not inventing a table. The moment
   * signed report links are added, this is where deletion expires them, and a method that
   * already exists is much harder to forget than a comment saying it will be needed.
   */
  async expireReportLinks(_workspaceId: string): Promise<number> {
    return 0;
  }

  async scheduleEvidenceRemoval(workspaceId: string, expiresAt: string): Promise<number> {
    const result = await this.db
      .prepare('UPDATE evidence SET expires_at = ? WHERE workspace_id = ? AND expires_at > ?')
      .bind(expiresAt, workspaceId, expiresAt)
      .run();
    return result.meta.changes;
  }

  /** Idempotent: true once the workspace is marked deleted, whoever marked it. */
  async markWorkspaceDeleted(workspaceId: string, at: string): Promise<boolean> {
    const changed = await workspaces.softDelete(this.db, workspaceId, at);
    if (changed) return true;
    const row = await workspaces.findById(this.db, workspaceId);
    return row !== null && row.deleted_at !== null;
  }

  /**
   * What is still held after deletion.
   *
   * Billing records and audit events survive because we are required to keep them, so the
   * plain-language statement has to be able to say how many — "we kept some" is not a
   * disclosure.
   */
  async countRetained(workspaceId: string): Promise<RetainedCounts> {
    const billing = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM orders WHERE workspace_id = ?)
         + (SELECT COUNT(*) FROM refunds WHERE workspace_id = ?)
         + (SELECT COUNT(*) FROM subscriptions WHERE workspace_id = ?)
         + (SELECT COUNT(*) FROM billing_customers WHERE workspace_id = ?) AS n`,
      )
      .bind(workspaceId, workspaceId, workspaceId, workspaceId)
      .first<{ n: number }>();
    const audit = await this.db
      .prepare('SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ?')
      .bind(workspaceId)
      .first<{ n: number }>();
    return {
      billingRecords: Number(billing?.n ?? 0),
      auditEvents: Number(audit?.n ?? 0),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* adapters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A09's `RateLimiter` over `lib/ratelimit.ts`.
 *
 * The shapes already agree; this only drops the fields the support form has no business
 * seeing (the raw count and the window start).
 */
export class D1RateLimiter implements RateLimiter {
  constructor(private readonly db: Db) {}

  async consume(
    bucket: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<RateLimitOutcome> {
    const decision = await consume(this.db, bucket, limit, windowSeconds, now);
    return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
  }
}
