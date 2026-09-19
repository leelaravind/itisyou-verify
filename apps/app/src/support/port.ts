/**
 * `SupportDataPort` — the exact set of reads and writes the support, notification and
 * privacy paths need from the database.
 *
 * A02 owns `apps/app/src/db/`. Rather than reach into someone else's SQL (or worse, write
 * my own), everything in `support/`, `notifications/` and `privacy/` codes against this
 * interface. `memory.ts` in this directory is a faithful in-memory implementation so the
 * tests run today; the lead wires A02's repositories to the same shape.
 *
 * Contract every implementation must keep:
 *
 *  1. **Tenant scope.** Every method that touches a customer-scoped table takes
 *     `workspaceId` and puts it in the `WHERE` clause of the same statement that fetches
 *     the row. There is no "by id" without a workspace, except `getCaseForOwner`, which
 *     is the platform owner's queue and is documented as cross-tenant.
 *  2. **Insert-once means insert-once.** `claimNotification` is
 *     `INSERT … ON CONFLICT(notification_key) DO NOTHING` plus `meta.changes`. A duplicate
 *     returns `{ inserted: false }` and the *existing* row — never a second row and never
 *     a second side effect.
 *  3. **Conditional writes report through `changes`, never a re-read.**
 *     `transitionCase` carries the expected state in its `WHERE`, so two concurrent
 *     callers cannot both win.
 *  4. **Retention reads are indexed and bounded.** `listExpired` must be
 *     `WHERE <expiry column> <= ? AND id > ? ORDER BY id LIMIT ?` — a keyset scan on an
 *     existing index, never an `OFFSET`, never a full-table read.
 *  5. **Export pages return exactly the declared columns.** `readExportPage` returns the
 *     column list it actually produced; `export.ts` rejects any page whose columns are
 *     not the allowlist for that section. A credential column reaching an export is a
 *     product-ending bug, so it is checked on both sides of this interface.
 *  6. **Nothing here decides anything.** Categorisation, escalation, suppression and the
 *     retention policy are pure functions in `triage.ts`, `grouping.ts` and
 *     `retention.ts`. The port only persists what was decided.
 */

/* -------------------------------------------------------------------------- */
/* support cases                                                              */
/* -------------------------------------------------------------------------- */

/** Matches the `state` CHECK constraint on `support_cases` in `migrations/0001_init.sql`. */
export const SUPPORT_CASE_STATE = [
  'open',
  'awaiting_owner',
  'answered',
  'escalated',
  'closed',
] as const;
export type SupportCaseState = (typeof SUPPORT_CASE_STATE)[number];

/** Matches the `priority` CHECK constraint on `support_cases`. */
export const SUPPORT_PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITY)[number];

/**
 * The fixed support taxonomy. `category` is a free-form `TEXT` column in the schema, so
 * this list is the only thing keeping it from becoming a pile of near-duplicates.
 */
export const SUPPORT_CATEGORY = [
  'billing_dispute',
  'billing_question',
  'cancellation',
  'data_deletion',
  'data_export',
  'security_report',
  'connection_problem',
  'unexpected_result',
  'setup_help',
  'feature_request',
  'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORY)[number];

export interface SupportCaseRecord {
  readonly id: string;
  /** Null for a signed-out submission. Support must work without an account. */
  readonly workspaceId: string | null;
  readonly contactEmail: string;
  readonly subject: string;
  /** Already redacted by `cases.ts` on the way in. Never a raw customer body. */
  readonly bodyRedacted: string;
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  readonly state: SupportCaseState;
  readonly linkedRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupportCaseListQuery {
  /**
   * `undefined` means "every workspace" and is the platform owner's queue only.
   * `null` means "submissions with no workspace" (signed-out). A string scopes to one
   * workspace.
   */
  readonly workspaceId?: string | null;
  readonly state?: SupportCaseState;
  readonly limit: number;
  /** Opaque keyset cursor over `(created_at DESC, id)`. */
  readonly cursor?: string | null;
}

export interface SupportCasePage {
  readonly items: readonly SupportCaseRecord[];
  readonly nextCursor: string | null;
}

export interface TransitionCaseParams {
  readonly id: string;
  /** Tenant scope. `undefined` only for the platform-owner queue. */
  readonly workspaceId?: string | null;
  /** The transition applies only if the row is still in this state. */
  readonly expectedState: SupportCaseState;
  readonly nextState: SupportCaseState;
  readonly priority?: SupportPriority;
  readonly updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* notifications                                                              */
/* -------------------------------------------------------------------------- */

/** Matches the `state` CHECK constraint on `notification_deliveries`. */
export const NOTIFICATION_STATE = ['pending', 'sent', 'failed', 'suppressed'] as const;
export type NotificationState = (typeof NOTIFICATION_STATE)[number];

export interface NotificationDeliveryRecord {
  readonly id: string;
  readonly workspaceId: string | null;
  /** The idempotency key. `UNIQUE` in the schema; this is the whole defence. */
  readonly notificationKey: string;
  readonly channel: 'email';
  /** Hashed, never the address. `recipient_hash` in the schema. */
  readonly recipientHash: string;
  readonly template: string;
  readonly state: NotificationState;
  readonly attemptCount: number;
  /**
   * What the sending service said. Never a delivery claim — see `send.ts`.
   * Also carries the suppression reason when `state` is `suppressed`.
   */
  readonly providerStatus: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

export interface ClaimNotificationParams {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly notificationKey: string;
  readonly channel: 'email';
  readonly recipientHash: string;
  readonly template: string;
  readonly createdAt: string;
}

export interface ClaimNotificationResult {
  /** False when the key already existed. The caller must then send nothing. */
  readonly inserted: boolean;
  readonly record: NotificationDeliveryRecord;
}

export interface SettleNotificationParams {
  readonly notificationKey: string;
  readonly state: NotificationState;
  readonly attemptCount: number;
  readonly providerStatus: string | null;
  readonly settledAt: string;
}

export interface NotificationHistoryQuery {
  readonly workspaceId: string | null;
  readonly template: string;
  /** Only deliveries created at or after this instant. */
  readonly since: string;
  /** Optional narrowing, used by grouping to find "the notification for *this* outage". */
  readonly keyPrefix?: string;
}

/* -------------------------------------------------------------------------- */
/* retention                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The tables retention sweeps. Each name maps to one table and one expiry column; the
 * mapping lives in `privacy/retention.ts` so the policy is readable in one place.
 */
export const RETENTION_TARGET = [
  'evidence',
  'visit_sessions',
  'rate_limits',
  'login_tokens',
  'sessions',
  'webhook_receipts',
  'source_events',
  'audit_events',
  'notification_deliveries',
  'support_cases',
] as const;
export type RetentionTarget = (typeof RETENTION_TARGET)[number];

/**
 * Tables that are never swept on a timer, but are emptied when a workspace is deleted.
 *
 * Kept separate from `RETENTION_TARGET` deliberately: the retention policy table in
 * `privacy/retention.ts` must list only things that actually expire, or the published
 * document grows rows that describe nothing.
 *
 * Each of these takes children with it through `ON DELETE CASCADE` in
 * `migrations/0001_init.sql`: `workflows` takes `workflow_versions`, and `connections`
 * takes `credential_versions` — which is what makes "the credentials you gave us are
 * destroyed" a true sentence rather than a hopeful one.
 */
export const PURGE_ONLY_TARGET = ['workflows', 'connections', 'memberships'] as const;
export type PurgeOnlyTarget = (typeof PURGE_ONLY_TARGET)[number];

/** Anything `purgeWorkspaceRows` may be asked to empty for one workspace. */
export type PurgeTarget = RetentionTarget | PurgeOnlyTarget;

export interface ExpiredRowRef {
  readonly id: string;
  readonly workspaceId: string | null;
}

export interface ListExpiredParams {
  readonly target: RetentionTarget;
  /** Rows whose expiry column is at or before this instant are eligible. */
  readonly expiredAt: string;
  /** Keyset position. Rows with `id > afterId` only. `null` starts at the beginning. */
  readonly afterId: string | null;
  readonly limit: number;
  /** Restrict the sweep to one workspace — used by deletion, not by the cron sweep. */
  readonly workspaceId?: string;
}

/* -------------------------------------------------------------------------- */
/* export                                                                     */
/* -------------------------------------------------------------------------- */

export const EXPORT_SECTION = [
  'workspace',
  'members',
  'workflows',
  'runs',
  'assertions',
  'evidence',
  'support_cases',
  'notifications',
  'audit_events',
  'billing',
] as const;
export type ExportSection = (typeof EXPORT_SECTION)[number];

/** A cell. Deliberately not `unknown` — an object in an export is a leak waiting to happen. */
export type ExportValue = string | number | boolean | null;

export interface ExportPage {
  readonly section: ExportSection;
  /** Exactly the allowlisted columns for this section, in order. Checked by `export.ts`. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ExportValue[])[];
  readonly nextCursor: string | null;
}

export interface ReadExportPageParams {
  readonly workspaceId: string;
  readonly section: ExportSection;
  readonly cursor: string | null;
  readonly limit: number;
}

/* -------------------------------------------------------------------------- */
/* deletion                                                                   */
/* -------------------------------------------------------------------------- */

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'paused' | 'suspended' | 'deleted';
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

export interface RetainedCounts {
  /** Rows kept deliberately, by table, with the reason stated in `deletion.ts`. */
  readonly billingRecords: number;
  readonly auditEvents: number;
}

/* -------------------------------------------------------------------------- */
/* the port                                                                   */
/* -------------------------------------------------------------------------- */

export interface SupportDataPort {
  /* --- support cases --- */

  /** Plain insert. The id is minted by the caller so the write is retry-safe. */
  insertCase(record: SupportCaseRecord): Promise<SupportCaseRecord>;

  /** Tenant-scoped read. A case belonging to another workspace must return `null`. */
  getCase(id: string, workspaceId: string | null): Promise<SupportCaseRecord | null>;

  /** Cross-tenant read, platform owner only. Named so nobody calls it by accident. */
  getCaseForOwner(id: string): Promise<SupportCaseRecord | null>;

  listCases(query: SupportCaseListQuery): Promise<SupportCasePage>;

  /**
   * One statement, expected state in the `WHERE`. Returns false when nothing changed —
   * which means somebody else already moved the case.
   */
  transitionCase(params: TransitionCaseParams): Promise<boolean>;

  /* --- notifications --- */

  claimNotification(params: ClaimNotificationParams): Promise<ClaimNotificationResult>;

  settleNotification(params: SettleNotificationParams): Promise<void>;

  getNotification(notificationKey: string): Promise<NotificationDeliveryRecord | null>;

  /** Newest first. Used by `grouping.ts` to answer "did we already tell them?". */
  findNotifications(
    query: NotificationHistoryQuery,
  ): Promise<readonly NotificationDeliveryRecord[]>;

  /* --- retention --- */

  listExpired(params: ListExpiredParams): Promise<readonly ExpiredRowRef[]>;

  /** Deletes exactly these ids from exactly this table. Returns rows actually removed. */
  deleteRows(target: RetentionTarget, ids: readonly string[]): Promise<number>;

  /**
   * Delete up to `limit` rows belonging to one workspace from one table, regardless of
   * expiry. Used only by `privacy/deletion.ts`.
   *
   * Must be one bounded statement — `WHERE workspace_id = ? ORDER BY id LIMIT ?` — so
   * deletion is resumable and never a full-table rewrite. Returns rows actually removed;
   * zero means the table is empty for this workspace and the caller stops.
   */
  purgeWorkspaceRows(workspaceId: string, target: PurgeTarget, limit: number): Promise<number>;

  /** Sweep checkpoint, stored in `settings`. Makes an interrupted sweep resumable. */
  readCheckpoint(key: string): Promise<string | null>;
  writeCheckpoint(key: string, value: string | null): Promise<void>;

  /* --- export --- */

  readExportPage(params: ReadExportPageParams): Promise<ExportPage>;

  /* --- deletion --- */

  getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null>;

  /** Revoke every session for every member of this workspace. Returns rows affected. */
  revokeSessions(workspaceId: string): Promise<number>;

  /** Retire every stored credential envelope for this workspace's connections. */
  revokeCredentials(workspaceId: string): Promise<number>;

  /** Clear `runs.next_check_at` and drain pending outbox rows so nothing runs again. */
  stopScheduledWork(workspaceId: string): Promise<number>;

  /**
   * Expire any shareable report link for this workspace.
   *
   * `migrations/0001_init.sql` has no public-link table, so a correct implementation
   * returns 0 today. It is in the port because the moment such a table is added, deletion
   * must expire it, and a method that already exists is harder to forget than a comment.
   */
  expireReportLinks(workspaceId: string): Promise<number>;

  /** Bring every evidence row for this workspace forward to `expiresAt`. */
  scheduleEvidenceRemoval(workspaceId: string, expiresAt: string): Promise<number>;

  /** `workspaces.status = 'deleted'`, `deleted_at = at`. Idempotent. */
  markWorkspaceDeleted(workspaceId: string, at: string): Promise<boolean>;

  /** What is still held after deletion, for the plain-language statement. */
  countRetained(workspaceId: string): Promise<RetainedCounts>;
}

/* -------------------------------------------------------------------------- */
/* collaborators that are not the database                                    */
/* -------------------------------------------------------------------------- */

export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

/**
 * The slice of A02's `lib/ratelimit.ts` the support form needs. Declaring it structurally
 * means the form can be tested without a database, and A02's `consume` satisfies it
 * through a one-line adapter.
 */
export interface RateLimiter {
  consume(
    bucket: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<RateLimitOutcome>;
}

export interface OutboundMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * What a transport is allowed to tell us.
 *
 * `providerStatus` is the sending service's own word. There is deliberately no
 * `delivered` field: this layer cannot observe delivery, and the product's entire thesis
 * is that we do not claim things we cannot observe.
 */
export interface TransportResult {
  readonly accepted: boolean;
  readonly providerStatus: string;
  /** True when a retry could plausibly succeed (5xx, 429, network). */
  readonly retryable: boolean;
}

export interface NotificationTransport {
  send(message: OutboundMessage): Promise<TransportResult>;
}
