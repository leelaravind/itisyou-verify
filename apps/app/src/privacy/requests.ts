/**
 * The privacy request layer — the thing that was missing.
 *
 * ## What this file closes
 *
 * `export.ts` and `deletion.ts` were complete, tested and **reached by nothing**.
 * `buildExport` exported only pure functions; nothing produced a download URL and an
 * expiry, so `exportLinkExpiry()` in `notifications/send.ts` had no caller at all.
 * `scheduleWorkspaceDeletion`, `deleteWorkspace` and `retainedStatement` all existed and
 * built nothing. Three of the twelve notification templates — `data_export_ready`,
 * `deletion_scheduled` and `deletion_completed` — had no event that could ever produce
 * them. `docs/privacy-retention.md` §0 names every one of those rows.
 *
 * A template with no trigger is a feature that does not exist for a customer, however well
 * tested it is. This file is the trigger: it turns a customer action into an export, a
 * schedule or a completed deletion, and hands the resulting notification to the same
 * `deliverNotifications` chain that `payment_problem` and `cancellation_confirmed` already
 * use. No new sender, no new idempotency scheme, no new copy.
 *
 * ## The workspace id never comes from the request
 *
 * Every function here takes an already-resolved `workspaceId` and an already-resolved
 * recipient address. Neither may be read from a form field or a query string — rule 5 of
 * the engineering brief — and the download-token path below resolves the workspace from
 * the *stored* record rather than from anything the browser sends.
 *
 * ## What each notification interpolates, stated explicitly
 *
 * Nothing here may carry a credential, a card detail, a payment-method id or another
 * tenant's data. What actually goes into each message:
 *
 *  - `data_export_ready` — `workspaceName` (this workspace's own name), `downloadUrl`
 *    (our own base URL plus a freshly minted opaque token; only its SHA-256 is stored, and
 *    the token is not a session, not a provider credential and not derived from one), and
 *    `expiresAt` (an ISO instant). The export bytes themselves are never attached and
 *    never stored: the link is redeemed later and the export is rebuilt then, scoped to
 *    the workspace recorded against the token. `export.ts` already refuses any forbidden
 *    column and any credential-shaped value, so the file the customer downloads carries no
 *    credential either — not even masked.
 *  - `deletion_scheduled` — `workspaceName`, `deletionAt` (an ISO instant) and `cancelUrl`
 *    (our own base URL plus the same kind of opaque token). No counts, no row contents.
 *  - `deletion_completed` — `workspaceName` and `retainedStatement`, which is
 *    `deletion.ts`'s own sentence built from two integers (billing records and audit
 *    events retained). Two counts belonging to this workspace, and no row from either.
 *
 * `API-38x` asserts all of that against the rendered bodies rather than trusting this
 * comment, because a comment is what let the support-route redaction defect survive review.
 *
 * ## Where the state lives
 *
 * There is no migration here — `migrations/` is the lead's and additive-only — so both the
 * pending-deletion schedule and the link tokens are held in the `settings` table through
 * `SupportDataPort.readCheckpoint`/`writeCheckpoint`, under their own key prefixes. That
 * store is a key-value read, not a scan, so a small bounded index key lists the workspaces
 * with a deletion pending. Deletions are rare and the index is capped; if this ever needs
 * to be a table, it needs a migration and that is the lead's call.
 */
import { AppError } from '@verify/contracts';
import { hashToken } from '@verify/security';
import { addSecondsIso, isBefore } from '../lib/time';
import type { SupportDataPort, WorkspaceSummary } from '../support/port';
import type { AnyNotificationRequest, DeliveryReport } from '../notifications/delivery';
import { notificationKey, exportLinkExpiry } from '../notifications/send';
import { buildExport, type ExportFormat, type ExportResult } from './export';
import {
  DELETION_GRACE_DAYS,
  deleteWorkspace,
  retainedStatement,
  scheduleWorkspaceDeletion,
  type DeletionReport,
  type DeletionSchedule,
} from './deletion';

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How long an export download link stays usable.
 *
 * Twenty-four hours. Long enough that a link opened the next morning still works, short
 * enough that a forwarded email is not a standing key to a copy of the workspace. The
 * value is the one argument `exportLinkExpiry` has always wanted and never been given.
 */
export const EXPORT_LINK_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long the "stop this deletion" link stays usable: the whole grace period, plus
 * nothing. A cancel link that outlives the thing it cancels is a dead link in an inbox.
 */
export const CANCEL_LINK_TTL_SECONDS = DELETION_GRACE_DAYS * 24 * 60 * 60;

/** Bounded so the index key cannot grow without limit. Deletions are rare. */
export const MAX_PENDING_DELETIONS = 500;

const EXPORT_LINK_PREFIX = 'privacy:export-link:';
const DELETION_PREFIX = 'privacy:deletion:';
const DELETION_INDEX_KEY = 'privacy:deletion-index';
const CANCEL_LINK_PREFIX = 'privacy:deletion-cancel:';

/* -------------------------------------------------------------------------- */
/* dependencies                                                               */
/* -------------------------------------------------------------------------- */

/** Only what this layer actually needs. Narrower than the whole delivery interface. */
export interface NotificationSink {
  deliver(requests: readonly AnyNotificationRequest[]): Promise<DeliveryReport>;
}

export interface PrivacyRequestDeps {
  readonly port: SupportDataPort;
  readonly notifications: NotificationSink;
  /**
   * The deployment's own origin, e.g. `https://verify.example`. Links are built from this
   * and never from a request header: an attacker-controlled `Host` in a password-reset
   * style email is the classic way a link ends up pointing somewhere else.
   */
  readonly baseUrl: string;
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* stored records                                                             */
/* -------------------------------------------------------------------------- */

interface ExportLinkRecord {
  readonly workspaceId: string;
  readonly format: ExportFormat;
  readonly expiresAt: string;
}

interface PendingDeletionRecord {
  readonly workspaceId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly deletionAt: string;
  readonly contactEmail: string;
  readonly cancelTokenHash: string;
}

async function readJson<T>(port: SupportDataPort, key: string): Promise<T | null> {
  const raw = await port.readCheckpoint(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const writeJson = (port: SupportDataPort, key: string, value: unknown): Promise<void> =>
  port.writeCheckpoint(key, JSON.stringify(value));

/**
 * Mint a link token.
 *
 * The token is returned to the caller once, to be put in the message, and only its hash is
 * stored — the same shape the sign-in link and session tokens use. A database read can
 * therefore never hand anyone a working link, which is the property that makes it safe to
 * keep these rows for as long as they are useful.
 */
async function mintToken(domain: string): Promise<{ token: string; hash: string }> {
  // 256 bits from the platform CSPRNG, which `crypto.randomUUID` is in both Workers and
  // Node 22. Not `newId`: an id carries a time component by design, and a link token must
  // be unguessable rather than sortable.
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  return { token, hash: await hashToken(token, domain) };
}

/* -------------------------------------------------------------------------- */
/* export                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportRequestInput {
  /** Resolved from the session by the caller. Never from a form field. */
  readonly workspaceId: string;
  /** Resolved from the session by the caller. Never from a form field. */
  readonly recipientEmail: string;
  readonly format?: ExportFormat;
}

export interface ExportRequestOutcome {
  readonly workspaceId: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
  /** What `buildExport` actually produced, so the caller can report size and completeness. */
  readonly export: ExportResult;
  readonly notification: DeliveryReport;
}

/**
 * The entry point for "a copy of everything we hold about your workspace".
 *
 * Builds the export first and only then mints a link: a link that promises a download we
 * have not proved we can produce is the wrong order, and `buildExport` is where a
 * forbidden column or a credential-shaped value is refused.
 */
export async function requestWorkspaceExport(
  deps: PrivacyRequestDeps,
  input: ExportRequestInput,
): Promise<ExportRequestOutcome> {
  const now = deps.now?.() ?? new Date();
  const workspace = await requireWorkspace(deps.port, input.workspaceId);
  const format: ExportFormat = input.format ?? 'json';

  const built = await buildExport(deps.port, {
    workspaceId: workspace.id,
    format,
    now,
  });

  const { token, hash } = await mintToken('privacy-export');
  // The one caller `exportLinkExpiry` has been waiting for since it was written.
  const expiresAt = exportLinkExpiry(now, EXPORT_LINK_TTL_SECONDS);
  const record: ExportLinkRecord = { workspaceId: workspace.id, format, expiresAt };
  await writeJson(deps.port, `${EXPORT_LINK_PREFIX}${hash}`, record);

  const downloadUrl = `${trimSlash(deps.baseUrl)}/app/export/${token}`;

  const notification = await deps.notifications.deliver([
    {
      // Keyed on the event, never the clock: one export request, one email, however many
      // times a retry re-enters this function with the same generated instant.
      notificationKey: notificationKey('data_export_ready', workspace.id, built.generatedAt),
      workspaceId: workspace.id,
      recipientEmail: input.recipientEmail,
      template: 'data_export_ready',
      vars: {
        workspaceName: workspace.name,
        downloadUrl,
        expiresAt,
      },
    },
  ]);

  return { workspaceId: workspace.id, downloadUrl, expiresAt, export: built, notification };
}

/**
 * Redeem a download token.
 *
 * Returns the export, rebuilt now, for the workspace recorded against the token — never
 * for a workspace named in the request. An expired or unknown token is a 404, not a 403:
 * confirming that a token *existed* is itself a small leak.
 */
export async function redeemExportLink(
  deps: Pick<PrivacyRequestDeps, 'port' | 'now'>,
  token: string,
): Promise<ExportResult> {
  const now = deps.now?.() ?? new Date();
  const hash = await hashToken(token, 'privacy-export');
  const record = await readJson<ExportLinkRecord>(deps.port, `${EXPORT_LINK_PREFIX}${hash}`);
  if (record === null || !isBefore(now, record.expiresAt)) {
    throw new AppError(404, 'EXPORT_LINK_UNUSABLE', 'That download link is no longer usable.');
  }
  return buildExport(deps.port, {
    workspaceId: record.workspaceId,
    format: record.format,
    now,
  });
}

/* -------------------------------------------------------------------------- */
/* deletion                                                                   */
/* -------------------------------------------------------------------------- */

export interface DeletionRequestInput {
  /** Resolved from the session by the caller. Never from a form field. */
  readonly workspaceId: string;
  /** Resolved from the session by the caller. Never from a form field. */
  readonly recipientEmail: string;
  /** For the audit trail. An id, never an address. */
  readonly requestedBy: string;
}

export interface DeletionRequestOutcome {
  readonly schedule: DeletionSchedule;
  readonly cancelUrl: string;
  readonly notification: DeliveryReport;
}

/**
 * The entry point for "delete your workspace and its data".
 *
 * Schedules only. Nothing is removed here, and the grace period is the whole point: an
 * account taken over, or a decision regretted, is recoverable right up to the moment the
 * sweep runs.
 */
export async function requestWorkspaceDeletion(
  deps: PrivacyRequestDeps,
  input: DeletionRequestInput,
): Promise<DeletionRequestOutcome> {
  const now = deps.now?.() ?? new Date();
  const workspace = await requireWorkspace(deps.port, input.workspaceId);

  const existing = await readJson<PendingDeletionRecord>(
    deps.port,
    `${DELETION_PREFIX}${workspace.id}`,
  );
  const schedule = scheduleWorkspaceDeletion({ workspaceId: workspace.id, now });

  // Re-requesting a deletion that is already pending must not move the date and must not
  // send a second email. The customer's clock started when they first asked.
  const effective: DeletionSchedule =
    existing === null
      ? schedule
      : { ...schedule, requestedAt: existing.requestedAt, deletionAt: existing.deletionAt };

  const { token, hash } =
    existing === null
      ? await mintToken('privacy-deletion-cancel')
      : { token: '', hash: existing.cancelTokenHash };

  if (existing === null) {
    const record: PendingDeletionRecord = {
      workspaceId: workspace.id,
      requestedAt: effective.requestedAt,
      requestedBy: input.requestedBy,
      deletionAt: effective.deletionAt,
      contactEmail: input.recipientEmail,
      cancelTokenHash: hash,
    };
    await writeJson(deps.port, `${DELETION_PREFIX}${workspace.id}`, record);
    await writeJson(deps.port, `${CANCEL_LINK_PREFIX}${hash}`, {
      workspaceId: workspace.id,
      expiresAt: addSecondsIso(now, CANCEL_LINK_TTL_SECONDS),
    });
    await addToDeletionIndex(deps.port, workspace.id);
  }

  const cancelUrl =
    token === ''
      ? `${trimSlash(deps.baseUrl)}/app/account`
      : `${trimSlash(deps.baseUrl)}/app/delete/cancel/${token}`;

  const notification = await deps.notifications.deliver([
    {
      // The requested-at instant is the event. A second request inside the grace period
      // reuses the stored one, so the key is identical and nothing is sent twice.
      notificationKey: notificationKey('deletion_scheduled', workspace.id, effective.requestedAt),
      workspaceId: workspace.id,
      recipientEmail: input.recipientEmail,
      template: 'deletion_scheduled',
      vars: {
        workspaceName: workspace.name,
        deletionAt: effective.deletionAt,
        cancelUrl,
      },
    },
  ]);

  return { schedule: effective, cancelUrl, notification };
}

/** Stop a scheduled deletion. Idempotent: cancelling twice is not an error. */
export async function cancelWorkspaceDeletion(
  deps: Pick<PrivacyRequestDeps, 'port' | 'now'>,
  token: string,
): Promise<{ readonly workspaceId: string; readonly cancelled: boolean }> {
  const now = deps.now?.() ?? new Date();
  const hash = await hashToken(token, 'privacy-deletion-cancel');
  const link = await readJson<{ workspaceId: string; expiresAt: string }>(
    deps.port,
    `${CANCEL_LINK_PREFIX}${hash}`,
  );
  if (link === null || !isBefore(now, link.expiresAt)) {
    throw new AppError(404, 'CANCEL_LINK_UNUSABLE', 'That link is no longer usable.');
  }
  const pending = await readJson<PendingDeletionRecord>(
    deps.port,
    `${DELETION_PREFIX}${link.workspaceId}`,
  );
  if (pending === null) return { workspaceId: link.workspaceId, cancelled: false };
  await deps.port.writeCheckpoint(`${DELETION_PREFIX}${link.workspaceId}`, null);
  await deps.port.writeCheckpoint(`${CANCEL_LINK_PREFIX}${hash}`, null);
  await removeFromDeletionIndex(deps.port, link.workspaceId);
  return { workspaceId: link.workspaceId, cancelled: true };
}

export interface DueDeletionOutcome {
  readonly workspaceId: string;
  readonly report: DeletionReport;
  readonly notification: DeliveryReport | null;
}

/**
 * Carry out every deletion whose grace period has expired.
 *
 * Built to be called from the cron tick. Nothing here throws on a single workspace: one
 * failed deletion must not stop the next one, and an incomplete deletion is reported as
 * incomplete and retried on the following tick rather than announced as done.
 *
 * `deletion_completed` is sent **only when `report.complete` is true**. That is the whole
 * reason `deleteWorkspace` returns the flag: a message saying "your data has been deleted"
 * sent after a partial purge is a false statement, and it is exactly the kind this project
 * refuses to make.
 */
export async function runDueWorkspaceDeletions(
  deps: PrivacyRequestDeps,
  options: { readonly limit?: number } = {},
): Promise<readonly DueDeletionOutcome[]> {
  const now = deps.now?.() ?? new Date();
  const limit = Math.max(1, Math.trunc(options.limit ?? 10));
  const index = (await readJson<string[]>(deps.port, DELETION_INDEX_KEY)) ?? [];
  const outcomes: DueDeletionOutcome[] = [];

  for (const workspaceId of index.slice(0, limit)) {
    const pending = await readJson<PendingDeletionRecord>(
      deps.port,
      `${DELETION_PREFIX}${workspaceId}`,
    );
    if (pending === null) {
      await removeFromDeletionIndex(deps.port, workspaceId);
      continue;
    }
    if (isBefore(now, pending.deletionAt)) continue;

    const workspace = await deps.port.getWorkspace(workspaceId);
    if (workspace === null) {
      await deps.port.writeCheckpoint(`${DELETION_PREFIX}${workspaceId}`, null);
      await removeFromDeletionIndex(deps.port, workspaceId);
      continue;
    }

    const report = await deleteWorkspace(deps.port, {
      workspaceId,
      requestedBy: pending.requestedBy,
      now,
    });

    if (!report.complete) {
      // Resumable. The schedule stays, the index stays, and nothing is announced.
      outcomes.push({ workspaceId, report, notification: null });
      continue;
    }

    const notification = await deps.notifications.deliver([
      {
        // The requested-at instant again: the deletion is one event however many ticks it
        // took to finish, so a resumed deletion still sends exactly one confirmation.
        notificationKey: notificationKey('deletion_completed', workspaceId, pending.requestedAt),
        workspaceId,
        recipientEmail: pending.contactEmail,
        template: 'deletion_completed',
        vars: {
          workspaceName: workspace.name,
          retainedStatement: retainedStatement(workspace, report.retained),
        },
      },
    ]);

    await deps.port.writeCheckpoint(`${DELETION_PREFIX}${workspaceId}`, null);
    await deps.port.writeCheckpoint(`${CANCEL_LINK_PREFIX}${pending.cancelTokenHash}`, null);
    await removeFromDeletionIndex(deps.port, workspaceId);
    outcomes.push({ workspaceId, report, notification });
  }

  return outcomes;
}

/** Read the pending schedule for one workspace, for the account page. */
export async function pendingDeletionFor(
  port: SupportDataPort,
  workspaceId: string,
): Promise<{ readonly requestedAt: string; readonly deletionAt: string } | null> {
  const record = await readJson<PendingDeletionRecord>(port, `${DELETION_PREFIX}${workspaceId}`);
  if (record === null) return null;
  return { requestedAt: record.requestedAt, deletionAt: record.deletionAt };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function requireWorkspace(
  port: SupportDataPort,
  workspaceId: string,
): Promise<WorkspaceSummary> {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new AppError(400, 'WORKSPACE_REQUIRED', 'We could not identify your workspace.');
  }
  const workspace = await port.getWorkspace(workspaceId);
  if (workspace === null) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'We could not find that workspace.');
  }
  return workspace;
}

async function addToDeletionIndex(port: SupportDataPort, workspaceId: string): Promise<void> {
  const index = (await readJson<string[]>(port, DELETION_INDEX_KEY)) ?? [];
  if (index.includes(workspaceId)) return;
  if (index.length >= MAX_PENDING_DELETIONS) {
    throw new AppError(
      503,
      'DELETION_QUEUE_FULL',
      'We could not schedule that deletion right now. Please contact support.',
    );
  }
  await writeJson(port, DELETION_INDEX_KEY, [...index, workspaceId]);
}

async function removeFromDeletionIndex(port: SupportDataPort, workspaceId: string): Promise<void> {
  const index = (await readJson<string[]>(port, DELETION_INDEX_KEY)) ?? [];
  const next = index.filter((id) => id !== workspaceId);
  if (next.length === index.length) return;
  await writeJson(port, DELETION_INDEX_KEY, next);
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');
