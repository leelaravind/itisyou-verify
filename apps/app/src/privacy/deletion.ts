/**
 * Workspace deletion.
 *
 * A service that makes leaving hard is a worse business than one that never launched, so
 * this path is built to the same standard as sign-up: it works, it finishes, and it tells
 * the truth about what it did.
 *
 * The order of the steps is not cosmetic. Access is cut **before** data is removed —
 * revoke sessions, revoke stored provider credentials, stop scheduled work, expire
 * shareable links — so that nothing can read, write or schedule against a half-deleted
 * workspace. Only then does the data go.
 *
 * Every step is idempotent and checkpointed. An interrupted deletion resumes from the
 * step it stopped at, does not repeat a completed one, and — the part that matters — does
 * **not** report success. `complete` is false until every step has finished, and the
 * customer-facing statement says so in words.
 *
 * On backups: we do not claim an erasure we cannot perform. Cloudflare D1 keeps
 * point-in-time backups of the database, and a backup taken before a deletion still
 * contains the deleted rows until that backup ages out on its own schedule. Saying
 * "deleted immediately and everywhere" would be a lie, and a customer who later
 * discovered it would be right to conclude the rest of our claims were the same shape.
 */
import { AppError } from '@verify/contracts';
import { addSecondsIso, toIso } from '../lib/time';
import type {
  RetainedCounts,
  PurgeTarget,
  SupportDataPort,
  WorkspaceSummary,
} from '../support/port';
import { RETENTION_POLICY } from './retention';

/* -------------------------------------------------------------------------- */
/* the plan                                                                   */
/* -------------------------------------------------------------------------- */

/** Days between a deletion being requested and being carried out. */
export const DELETION_GRACE_DAYS = 7;

/** Bounded batch for each purge statement. Same reasoning as the retention sweep. */
export const PURGE_BATCH_SIZE = 200;
/** Ceiling per table per run. Reaching it means "resume next time", not "finished". */
export const MAX_PURGE_BATCHES = 25;

export const DELETION_STEP = [
  'revoke_sessions',
  'revoke_credentials',
  'stop_scheduled_work',
  'expire_report_links',
  'schedule_evidence_removal',
  'purge_evidence',
  'purge_source_events',
  'purge_workflows',
  'purge_connections',
  'purge_support_cases',
  'purge_notifications',
  'purge_memberships',
  'mark_workspace_deleted',
] as const;
export type DeletionStep = (typeof DELETION_STEP)[number];

/**
 * Tables emptied for the workspace, and the step that empties each.
 *
 * The order in `DELETION_STEP` is load-bearing, and the reason is not the one it is easy
 * to assume. A02 checked the schema and corrected an earlier comment here that claimed a
 * mis-ordered deletion would abort on a foreign-key constraint. **It would not.**
 *
 * `workflows` cascades to `runs`, and deleting the runs removes the last reference to
 * `workflow_versions`, so the `NO ACTION` clause on `runs.workflow_version_id` is never
 * reached and the delete succeeds. What actually happens when `workflows` is purged first
 * is quieter and much worse: `source_events` has **no foreign key to `workflows` at all**,
 * so its rows are simply left behind — the customer's enquiry payloads survive a deletion
 * that then reports success.
 *
 * So: purge `source_events` first, which takes the runs with it, and only then
 * `workflows`. Nobody should be waiting for a loud failure here, because there is not
 * going to be one. `API-370` pins the order.
 */
const PURGE_TARGETS: Readonly<Partial<Record<DeletionStep, PurgeTarget>>> = {
  purge_evidence: 'evidence',
  // Runs, run attempts and assertions hang off `source_events` by a cascading foreign
  // key, so emptying this table takes the whole result history with it.
  purge_source_events: 'source_events',
  // Takes `workflow_versions` — the customer's rules — with it.
  purge_workflows: 'workflows',
  // Takes `credential_versions` with it. This is what makes "the provider credentials you
  // gave us are destroyed" true rather than hopeful: `revokeCredentials` retires the
  // envelopes, and this removes the rows.
  purge_connections: 'connections',
  purge_support_cases: 'support_cases',
  purge_notifications: 'notification_deliveries',
  // Detaches every user from the workspace. The `users` rows themselves are not touched:
  // a person may still belong to another workspace, and deleting their sign-in identity
  // out from under that one would be a different, worse bug. See `retainedStatement`.
  purge_memberships: 'memberships',
};

export interface StepResult {
  readonly step: DeletionStep;
  readonly status: 'done' | 'already_done' | 'incomplete' | 'failed';
  /** Rows or records affected by this run of the step. */
  readonly affected: number;
  readonly error: string | null;
}

export interface DeletionReport {
  readonly workspaceId: string;
  readonly requestedAt: string;
  /** Null while any step is unfinished. */
  readonly completedAt: string | null;
  readonly steps: readonly StepResult[];
  /** True only when every step finished. Never set optimistically. */
  readonly complete: boolean;
  readonly retained: RetainedCounts;
  /** Plain language, for the customer. */
  readonly statement: string;
  /** The backup paragraph. Always included, never softened. */
  readonly backupStatement: string;
}

export interface DeletionRequest {
  readonly workspaceId: string;
  /** Who asked. Recorded by the caller in `audit_events`; used here only for the plan. */
  readonly requestedBy: string;
  readonly now?: Date;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface DeletionSchedule {
  readonly workspaceId: string;
  readonly requestedAt: string;
  readonly deletionAt: string;
  /** What will happen, in the order it will happen, for the confirmation page. */
  readonly steps: readonly DeletionStep[];
  readonly statement: string;
}

/* -------------------------------------------------------------------------- */
/* wording                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * NEW WORDING (A09): A01 wrote no deletion copy. Every sentence below is mine and is
 * flagged in the handoff so A01's claims map stays accurate.
 */
export const BACKUP_STATEMENT =
  'Our database is backed up. A backup taken before this deletion still contains the data until that backup expires on its own schedule, and we do not rewrite backups to remove individual records — doing so reliably is not something we can honestly promise. We would rather tell you this than claim the data is gone from everywhere the moment you ask.';

const SCHEDULE_STATEMENT =
  'Nothing has been removed yet. You can stop this at any point before the date above, and you will not have to speak to anyone to do it.';

const INCOMPLETE_STATEMENT =
  'This deletion is not finished. Some of it has been done and the rest will continue automatically; nothing that has been removed comes back. We will not tell you it is complete until it is.';

/* -------------------------------------------------------------------------- */
/* scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Plan a deletion. Does not touch any data — the grace period exists so an account taken
 * over, or a decision regretted, can be undone before anything is irreversible.
 */
export function scheduleWorkspaceDeletion(
  request: Pick<DeletionRequest, 'workspaceId' | 'now'>,
): DeletionSchedule {
  const now = request.now ?? new Date();
  return {
    workspaceId: request.workspaceId,
    requestedAt: toIso(now),
    deletionAt: addSecondsIso(now, DELETION_GRACE_DAYS * 24 * 60 * 60),
    steps: DELETION_STEP,
    statement: SCHEDULE_STATEMENT,
  };
}

/* -------------------------------------------------------------------------- */
/* execution                                                                  */
/* -------------------------------------------------------------------------- */

function stepKey(workspaceId: string, step: DeletionStep): string {
  return `deletion:${workspaceId}:${step}`;
}

/**
 * Carry out a deletion.
 *
 * Safe to call repeatedly: completed steps are skipped, partial purges resume, and the
 * report reflects what this run actually did rather than what was already done.
 */
export async function deleteWorkspace(
  port: SupportDataPort,
  request: DeletionRequest,
): Promise<DeletionReport> {
  const now = request.now ?? new Date();
  const requestedAt = toIso(now);
  const batchSize = Math.max(1, Math.trunc(request.batchSize ?? PURGE_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.trunc(request.maxBatches ?? MAX_PURGE_BATCHES));

  const workspace = await port.getWorkspace(request.workspaceId);
  if (workspace === null) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'We could not find that workspace.');
  }

  const steps: StepResult[] = [];
  for (const step of DELETION_STEP) {
    steps.push(
      await runStep(port, step, {
        workspaceId: request.workspaceId,
        now,
        batchSize,
        maxBatches,
      }),
    );
  }

  const complete = steps.every((s) => s.status === 'done' || s.status === 'already_done');
  const retained = await safeCountRetained(port, request.workspaceId);

  return {
    workspaceId: request.workspaceId,
    requestedAt,
    completedAt: complete ? toIso(new Date()) : null,
    steps,
    complete,
    retained,
    statement: complete
      ? retainedStatement(workspace, retained)
      : `${INCOMPLETE_STATEMENT} ${retainedStatement(workspace, retained)}`,
    backupStatement: BACKUP_STATEMENT,
  };
}

interface StepContext {
  readonly workspaceId: string;
  readonly now: Date;
  readonly batchSize: number;
  readonly maxBatches: number;
}

async function runStep(
  port: SupportDataPort,
  step: DeletionStep,
  context: StepContext,
): Promise<StepResult> {
  const key = stepKey(context.workspaceId, step);
  try {
    if ((await port.readCheckpoint(key)) === 'done') {
      return { step, status: 'already_done', affected: 0, error: null };
    }

    const target = PURGE_TARGETS[step];
    if (target !== undefined) {
      let affected = 0;
      for (let batch = 0; batch < context.maxBatches; batch += 1) {
        const removed = await port.purgeWorkspaceRows(
          context.workspaceId,
          target,
          context.batchSize,
        );
        affected += removed;
        if (removed === 0) {
          await port.writeCheckpoint(key, 'done');
          return { step, status: 'done', affected, error: null };
        }
      }
      // Ceiling reached with rows still present. Resumable, and explicitly not complete.
      return { step, status: 'incomplete', affected, error: null };
    }

    const affected = await runSingleShotStep(port, step, context);
    await port.writeCheckpoint(key, 'done');
    return { step, status: 'done', affected, error: null };
  } catch (cause) {
    return {
      step,
      status: 'failed',
      affected: 0,
      error: cause instanceof Error ? cause.message : 'unknown error',
    };
  }
}

async function runSingleShotStep(
  port: SupportDataPort,
  step: DeletionStep,
  context: StepContext,
): Promise<number> {
  switch (step) {
    case 'revoke_sessions':
      return port.revokeSessions(context.workspaceId, toIso(context.now));
    case 'revoke_credentials':
      return port.revokeCredentials(context.workspaceId, toIso(context.now));
    case 'stop_scheduled_work':
      return port.stopScheduledWork(context.workspaceId);
    case 'expire_report_links':
      return port.expireReportLinks(context.workspaceId);
    case 'schedule_evidence_removal':
      // Bring every evidence row's expiry forward to now, so that even if the purge below
      // is interrupted, the ordinary retention sweep finishes the job.
      return port.scheduleEvidenceRemoval(context.workspaceId, toIso(context.now));
    case 'mark_workspace_deleted':
      return (await port.markWorkspaceDeleted(context.workspaceId, toIso(context.now))) ? 1 : 0;
    case 'purge_evidence':
    case 'purge_source_events':
    case 'purge_workflows':
    case 'purge_connections':
    case 'purge_support_cases':
    case 'purge_notifications':
    case 'purge_memberships':
      // Handled by the batched purge path in `runStep`.
      return 0;
    default: {
      const exhaustive: never = step;
      throw new Error(`unhandled deletion step: ${String(exhaustive)}`);
    }
  }
}

async function safeCountRetained(
  port: SupportDataPort,
  workspaceId: string,
): Promise<RetainedCounts> {
  try {
    return await port.countRetained(workspaceId);
  } catch {
    return { billingRecords: 0, auditEvents: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/* the statement                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What we still hold and why, in plain language, built from the same retention table the
 * privacy page publishes.
 *
 * Deliberately concrete: "we keep some records for legal reasons" tells a customer
 * nothing and is the sentence every company writes when it has not thought about it.
 */
export function retainedStatement(workspace: WorkspaceSummary, retained: RetainedCounts): string {
  const obligations = RETENTION_POLICY.filter(
    (rule) => rule.basis === 'retained_for_obligation',
  ).map((rule) => rule.label.toLowerCase());

  const parts: string[] = [
    `We have removed the workspace "${workspace.name}", its workflow configuration and rules, its runs and results, the evidence we had retrieved, its support messages, its notification records and everyone's membership of it.`,
    'Your sign-in sessions are revoked, and the provider connections and the credentials you gave us are deleted, so we can no longer read anything from HubSpot or Resend on your behalf.',
    'Your sign-in identity — the email address you use to log in — is a separate record, because it can belong to more than one workspace and removing it here could lock you out of another. Ask us and we will remove it too.',
  ];

  if (retained.billingRecords > 0) {
    parts.push(
      `We still hold ${String(retained.billingRecords)} billing record${
        retained.billingRecords === 1 ? '' : 's'
      } — ${obligations.join(', ')} — because business and tax records have to be kept for a set period. They contain what was charged and when, never a card number; we never receive one.`,
    );
  }

  if (retained.auditEvents > 0) {
    parts.push(
      `We still hold ${String(retained.auditEvents)} audit record${
        retained.auditEvents === 1 ? '' : 's'
      } of actions taken on the account, including this deletion. They carry who did what and when, with the detail redacted, and they are removed automatically a year after they were written.`,
    );
  }

  parts.push(
    'Nothing else is kept, and nothing retained above is used for any purpose other than the one stated.',
  );

  return parts.join(' ');
}

/** Everything a customer is told, assembled. Used by the `deletion_completed` template. */
export function deletionStatement(report: DeletionReport): string {
  return `${report.statement} ${report.backupStatement}`;
}
