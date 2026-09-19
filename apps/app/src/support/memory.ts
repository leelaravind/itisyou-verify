/**
 * An in-memory `SupportDataPort`.
 *
 * This exists so the support, notification and privacy logic can be tested today, while
 * A02 is still writing the repositories that will back it in production. It is a test
 * double, and it is labelled as one: passing these tests proves the *logic* is right, not
 * that the SQL is. The integration tests A02 wires up against real D1 are what prove the
 * second thing, and this file's contract docblocks in `port.ts` are what they must match.
 *
 * It is deliberately faithful about the three behaviours the logic depends on:
 *
 *  - `claimNotification` really is insert-once on `notificationKey`, and returns the
 *    existing row on a duplicate rather than overwriting it;
 *  - `transitionCase` really does check the expected state and report through a change
 *    count, so an optimistic-concurrency test means something;
 *  - `listExpired` really is a keyset scan ordered by id, so a resumption test means
 *    something.
 *
 * Anything a test wants to make fail — a cross-tenant row in an export page, a delete
 * that throws — is settable, because those are the paths worth proving.
 */
import type {
  ClaimNotificationParams,
  ClaimNotificationResult,
  ExpiredRowRef,
  ExportPage,
  ExportSection,
  ExportValue,
  ListExpiredParams,
  NotificationDeliveryRecord,
  NotificationHistoryQuery,
  ReadExportPageParams,
  RetainedCounts,
  RetentionTarget,
  SettleNotificationParams,
  SupportCaseListQuery,
  SupportCasePage,
  SupportCaseRecord,
  SupportDataPort,
  TransitionCaseParams,
  WorkspaceSummary,
} from './port';

/** One row in a sweepable table. `expiryValue` is whatever that table's expiry column holds. */
export interface MemoryRow {
  readonly id: string;
  readonly workspaceId: string | null;
  /** ISO-8601. Compared against the sweep's cut-off with `<=`. */
  readonly expiryValue: string;
}

export interface MemoryExportSection {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ExportValue[])[];
}

export class InMemorySupportData implements SupportDataPort {
  readonly cases = new Map<string, SupportCaseRecord>();
  /** Keyed by `notification_key`, mirroring the `UNIQUE` constraint. */
  readonly notifications = new Map<string, NotificationDeliveryRecord>();
  readonly checkpoints = new Map<string, string>();
  readonly tables = new Map<RetentionTarget, MemoryRow[]>();
  readonly exportSections = new Map<ExportSection, MemoryExportSection>();
  readonly workspaces = new Map<string, WorkspaceSummary>();

  /** Side-effect counters, so a deletion test can assert the steps actually ran. */
  readonly effects = {
    revokedSessions: 0,
    revokedCredentials: 0,
    stoppedScheduledWork: 0,
    expiredReportLinks: 0,
    evidenceBroughtForward: 0,
    markedDeleted: 0,
  };

  /** Seedable counts for the retained-data statement. */
  retained: RetainedCounts = { billingRecords: 0, auditEvents: 0 };

  /** Set to make the next `deleteRows` or `purgeWorkspaceRows` throw once. */
  failNextDelete: string | null = null;

  /* ---------------------------------------------------------------------- */
  /* support cases                                                          */
  /* ---------------------------------------------------------------------- */

  insertCase(record: SupportCaseRecord): Promise<SupportCaseRecord> {
    this.cases.set(record.id, record);
    return Promise.resolve(record);
  }

  getCase(id: string, workspaceId: string | null): Promise<SupportCaseRecord | null> {
    const found = this.cases.get(id);
    if (found === undefined) return Promise.resolve(null);
    // Tenant scope: a mismatch is `null`, never the row. 404, not 403.
    return Promise.resolve(found.workspaceId === workspaceId ? found : null);
  }

  getCaseForOwner(id: string): Promise<SupportCaseRecord | null> {
    return Promise.resolve(this.cases.get(id) ?? null);
  }

  listCases(query: SupportCaseListQuery): Promise<SupportCasePage> {
    const all = [...this.cases.values()]
      .filter((c) => (query.workspaceId === undefined ? true : c.workspaceId === query.workspaceId))
      .filter((c) => (query.state === undefined ? true : c.state === query.state))
      .sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1,
      );

    const start = query.cursor === undefined || query.cursor === null ? 0 : Number(query.cursor);
    const items = all.slice(start, start + query.limit);
    const next = start + items.length;
    return Promise.resolve({
      items,
      nextCursor: next < all.length ? String(next) : null,
    });
  }

  transitionCase(params: TransitionCaseParams): Promise<boolean> {
    const found = this.cases.get(params.id);
    if (found === undefined) return Promise.resolve(false);
    if (params.workspaceId !== undefined && found.workspaceId !== params.workspaceId) {
      return Promise.resolve(false);
    }
    // The expected state is the condition, exactly as it is in the `WHERE` clause.
    if (found.state !== params.expectedState) return Promise.resolve(false);
    this.cases.set(params.id, {
      ...found,
      state: params.nextState,
      priority: params.priority ?? found.priority,
      updatedAt: params.updatedAt,
    });
    return Promise.resolve(true);
  }

  /* ---------------------------------------------------------------------- */
  /* notifications                                                          */
  /* ---------------------------------------------------------------------- */

  claimNotification(params: ClaimNotificationParams): Promise<ClaimNotificationResult> {
    const existing = this.notifications.get(params.notificationKey);
    if (existing !== undefined) {
      return Promise.resolve({ inserted: false, record: existing });
    }
    const record: NotificationDeliveryRecord = {
      id: params.id,
      workspaceId: params.workspaceId,
      notificationKey: params.notificationKey,
      channel: params.channel,
      recipientHash: params.recipientHash,
      template: params.template,
      state: 'pending',
      attemptCount: 0,
      providerStatus: null,
      createdAt: params.createdAt,
      sentAt: null,
    };
    this.notifications.set(params.notificationKey, record);
    return Promise.resolve({ inserted: true, record });
  }

  settleNotification(params: SettleNotificationParams): Promise<void> {
    const existing = this.notifications.get(params.notificationKey);
    if (existing === undefined) return Promise.resolve();
    this.notifications.set(params.notificationKey, {
      ...existing,
      state: params.state,
      attemptCount: params.attemptCount,
      providerStatus: params.providerStatus,
      sentAt: params.state === 'sent' ? params.settledAt : existing.sentAt,
    });
    return Promise.resolve();
  }

  getNotification(notificationKey: string): Promise<NotificationDeliveryRecord | null> {
    return Promise.resolve(this.notifications.get(notificationKey) ?? null);
  }

  findNotifications(
    query: NotificationHistoryQuery,
  ): Promise<readonly NotificationDeliveryRecord[]> {
    const rows = [...this.notifications.values()]
      .filter((n) => n.workspaceId === query.workspaceId)
      .filter((n) => n.template === query.template)
      .filter((n) => n.createdAt >= query.since)
      .filter((n) =>
        query.keyPrefix === undefined ? true : n.notificationKey.startsWith(query.keyPrefix),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return Promise.resolve(rows);
  }

  /* ---------------------------------------------------------------------- */
  /* retention                                                              */
  /* ---------------------------------------------------------------------- */

  /** Seed a sweepable table. Rows are stored sorted by id, as an index would keep them. */
  seedTable(target: RetentionTarget, rows: readonly MemoryRow[]): void {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.tables.set(target, sorted);
  }

  rowsIn(target: RetentionTarget): readonly MemoryRow[] {
    return this.tables.get(target) ?? [];
  }

  listExpired(params: ListExpiredParams): Promise<readonly ExpiredRowRef[]> {
    const rows = this.tables.get(params.target) ?? [];
    const page = rows
      .filter((row) => row.expiryValue <= params.expiredAt)
      .filter((row) => (params.afterId === null ? true : row.id > params.afterId))
      .filter((row) =>
        params.workspaceId === undefined ? true : row.workspaceId === params.workspaceId,
      )
      .slice(0, params.limit)
      .map((row) => ({ id: row.id, workspaceId: row.workspaceId }));
    return Promise.resolve(page);
  }

  deleteRows(target: RetentionTarget, ids: readonly string[]): Promise<number> {
    if (this.failNextDelete !== null) {
      const message = this.failNextDelete;
      this.failNextDelete = null;
      return Promise.reject(new Error(message));
    }
    const rows = this.tables.get(target) ?? [];
    const doomed = new Set(ids);
    const kept = rows.filter((row) => !doomed.has(row.id));
    this.tables.set(target, kept);
    return Promise.resolve(rows.length - kept.length);
  }

  purgeWorkspaceRows(workspaceId: string, target: RetentionTarget, limit: number): Promise<number> {
    if (this.failNextDelete !== null) {
      const message = this.failNextDelete;
      this.failNextDelete = null;
      return Promise.reject(new Error(message));
    }
    const rows = this.tables.get(target) ?? [];
    const doomed = new Set(
      rows
        .filter((row) => row.workspaceId === workspaceId)
        .slice(0, limit)
        .map((r) => r.id),
    );
    this.tables.set(
      target,
      rows.filter((row) => !doomed.has(row.id)),
    );
    return Promise.resolve(doomed.size);
  }

  readCheckpoint(key: string): Promise<string | null> {
    return Promise.resolve(this.checkpoints.get(key) ?? null);
  }

  writeCheckpoint(key: string, value: string | null): Promise<void> {
    if (value === null) this.checkpoints.delete(key);
    else this.checkpoints.set(key, value);
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------------- */
  /* export                                                                 */
  /* ---------------------------------------------------------------------- */

  seedExportSection(section: ExportSection, page: MemoryExportSection): void {
    this.exportSections.set(section, page);
  }

  readExportPage(params: ReadExportPageParams): Promise<ExportPage> {
    const seeded = this.exportSections.get(params.section);
    if (seeded === undefined) {
      return Promise.resolve({
        section: params.section,
        columns: [],
        rows: [],
        nextCursor: null,
      });
    }
    const offset = params.cursor === null ? 0 : Number(params.cursor);
    const rows = seeded.rows.slice(offset, offset + params.limit);
    const next = offset + rows.length;
    return Promise.resolve({
      section: params.section,
      columns: seeded.columns,
      rows,
      nextCursor: next < seeded.rows.length ? String(next) : null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* deletion                                                               */
  /* ---------------------------------------------------------------------- */

  seedWorkspace(workspace: WorkspaceSummary): void {
    this.workspaces.set(workspace.id, workspace);
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null> {
    return Promise.resolve(this.workspaces.get(workspaceId) ?? null);
  }

  revokeSessions(_workspaceId: string): Promise<number> {
    this.effects.revokedSessions += 1;
    return Promise.resolve(1);
  }

  revokeCredentials(_workspaceId: string): Promise<number> {
    this.effects.revokedCredentials += 1;
    return Promise.resolve(1);
  }

  stopScheduledWork(_workspaceId: string): Promise<number> {
    this.effects.stoppedScheduledWork += 1;
    return Promise.resolve(1);
  }

  expireReportLinks(_workspaceId: string): Promise<number> {
    this.effects.expiredReportLinks += 1;
    // Zero is the honest answer: `migrations/0001_init.sql` has no public-link table yet.
    return Promise.resolve(0);
  }

  scheduleEvidenceRemoval(workspaceId: string, expiresAt: string): Promise<number> {
    this.effects.evidenceBroughtForward += 1;
    const rows = this.tables.get('evidence') ?? [];
    let changed = 0;
    const updated = rows.map((row) => {
      if (row.workspaceId !== workspaceId) return row;
      changed += 1;
      return { ...row, expiryValue: expiresAt };
    });
    this.tables.set('evidence', updated);
    return Promise.resolve(changed);
  }

  markWorkspaceDeleted(workspaceId: string, at: string): Promise<boolean> {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) return Promise.resolve(false);
    this.effects.markedDeleted += 1;
    this.workspaces.set(workspaceId, {
      ...workspace,
      status: 'deleted',
      deletedAt: at,
    });
    return Promise.resolve(true);
  }

  countRetained(_workspaceId: string): Promise<RetainedCounts> {
    return Promise.resolve(this.retained);
  }
}

/* -------------------------------------------------------------------------- */
/* collaborators                                                              */
/* -------------------------------------------------------------------------- */

/** A fixed-window rate limiter with the same shape as A02's, in memory. */
export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();

  consume(
    bucket: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const ms = now.getTime();
    const existing = this.buckets.get(bucket);
    const windowMs = windowSeconds * 1_000;
    const current =
      existing === undefined || ms - existing.start >= windowMs
        ? { start: ms, count: 0 }
        : existing;
    current.count += 1;
    this.buckets.set(bucket, current);
    const allowed = current.count <= limit;
    return Promise.resolve({
      allowed,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((current.start + windowMs - ms) / 1_000)),
    });
  }
}

export interface RecordedMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * A transport that records instead of sending. It never touches the network — the test
 * setup blocks `fetch` anyway, and no test in this repository may send a real email.
 */
export class RecordingTransport {
  readonly sent: RecordedMessage[] = [];
  /** Queue of outcomes, consumed in order. Falls back to acceptance when empty. */
  readonly outcomes: {
    accepted: boolean;
    providerStatus: string;
    retryable: boolean;
  }[] = [];

  send(message: RecordedMessage): Promise<{
    accepted: boolean;
    providerStatus: string;
    retryable: boolean;
  }> {
    this.sent.push(message);
    const next = this.outcomes.shift();
    return Promise.resolve(
      next ?? { accepted: true, providerStatus: 'accepted', retryable: false },
    );
  }
}
