/**
 * Retention as executable policy.
 *
 * `docs/privacy-retention.md` is generated from the table in this file, so the published
 * promise and the code that enforces it cannot drift. If you change a number here, the
 * document changes; if you change the document by hand, the test that compares them
 * fails. That is the whole point: a retention policy that lives only in prose is a
 * statement of intent, and a statement of intent is not a control.
 *
 * Four rules the sweep itself keeps:
 *
 *  1. **Small, indexed batches.** Every read is a keyset scan —
 *     `WHERE <expiry> <= ? AND id > ? ORDER BY id LIMIT ?` — over an index that already
 *     exists in `migrations/0001_init.sql`. There is no `OFFSET`, no full-table scan and
 *     no rewrite. On D1 a full-table delete is not merely slow; it is how a cron job
 *     starts timing out and silently stops running.
 *  2. **Idempotent.** Running the sweep twice removes nothing the second time. The
 *     eligibility test is the row's own expiry column, so a row that has already gone
 *     cannot be deleted again and a row that has not expired cannot be deleted early.
 *  3. **Resumable.** The keyset position is checkpointed per target. An interrupted sweep
 *     resumes where it stopped instead of restarting, and it does not delete anything
 *     twice on the way back.
 *  4. **Bounded, and honest about it.** A sweep does a fixed maximum of batches per
 *     target. When it hits that ceiling with work left, the report says `complete: false`.
 *     It never reports success it did not achieve.
 */
import { LIMITS } from '@verify/contracts';
import { toIso } from '../lib/time';
import type { RetentionTarget, SupportDataPort } from '../support/port';

/* -------------------------------------------------------------------------- */
/* the policy table                                                           */
/* -------------------------------------------------------------------------- */

export type RetentionBasis =
  /** Never written to storage at all. The strongest form of retention limit. */
  | 'discarded_before_storage'
  /** Deleted by the sweep once the row's expiry column has passed. */
  | 'swept_on_expiry'
  /** Kept while the account exists; removed by `deletion.ts` when it does not. */
  | 'lifetime_of_account'
  /** Kept beyond account deletion because we are required to keep it. */
  | 'retained_for_obligation';

/**
 * How the eligibility cut-off is computed for a swept target.
 *
 * Getting this wrong is the classic retention bug, and it fails in the dangerous
 * direction: treating an already-absolute `expires_at` as an age would keep evidence for
 * sixty days while the privacy page promises thirty.
 */
export type ExpiryColumnKind =
  /** The column already holds the instant the row becomes eligible (`expires_at`). */
  | 'absolute_expiry'
  /** The column holds when the row was created; the period is measured from it. */
  | 'age_from_column';

export interface RetentionRule {
  /** `null` for rules that describe data we never store. */
  readonly target: RetentionTarget | null;
  /** Plain-language name used in `docs/privacy-retention.md`. */
  readonly label: string;
  /** What is actually in it, in customer language. */
  readonly contents: string;
  readonly basis: RetentionBasis;
  /** `null` when the basis is not a fixed period. */
  readonly retentionDays: number | null;
  /** The column A02's implementation compares against. `null` for unswept rules. */
  readonly expiryColumn: string | null;
  readonly columnKind: ExpiryColumnKind | null;
  /**
   * Days to wait after the row becomes eligible before removing it. Only meaningful for
   * `absolute_expiry`, where the row is already useless and the delay simply avoids
   * racing a request that is still holding it.
   */
  readonly graceDays: number;
  /** Why this number and not another. Published verbatim. */
  readonly reason: string;
}

/**
 * The retention table.
 *
 * NEW WORDING (A09): A01 published two retention claims — "Evidence is kept for 30 days
 * by default and then removed" and `EVIDENCE_RETENTION_NOTE`. Every other line below is
 * mine and is flagged in the handoff so A01's claims map can absorb it.
 */
export const RETENTION_POLICY: readonly RetentionRule[] = [
  {
    target: null,
    label: 'Raw webhook and event payloads',
    contents:
      'The exact bytes a provider or your automation sends us, before we check and normalise them.',
    basis: 'discarded_before_storage',
    retentionDays: 0,
    expiryColumn: null,
    columnKind: null,
    graceDays: 0,
    reason:
      'We verify the signature against the raw bytes, take the few fields our rules need, and discard the rest in the same request. We keep a hash so a duplicate can be recognised, and a minimal validated envelope — never the original payload. Data we never store cannot be leaked, subpoenaed or forgotten about.',
  },
  {
    target: 'evidence',
    label: 'Evidence',
    contents:
      'The CRM record fields and email status events your workflow rules reference, as we read them back from HubSpot and Resend.',
    basis: 'swept_on_expiry',
    retentionDays: LIMITS.EVIDENCE_RETENTION_DAYS,
    expiryColumn: 'evidence.expires_at',
    columnKind: 'absolute_expiry',
    graceDays: 0,
    reason:
      'This is the published default and a fixed system limit, not a per-customer setting. Thirty days is long enough to investigate a disputed result and short enough that we are not holding a shadow copy of your CRM.',
  },
  {
    target: 'source_events',
    label: 'Source events and run results',
    contents:
      'The validated envelope of each signed event your automation sent us, and the run, assertions and status that came from it.',
    basis: 'swept_on_expiry',
    retentionDays: 90,
    expiryColumn: 'source_events.received_at',
    columnKind: 'age_from_column',
    graceDays: 0,
    reason:
      'Ninety days gives you a quarter of result history to look back over. Runs are attached to their source event by a cascading foreign key, so the two cannot be given different periods — deleting the event deletes the run. Evidence inside those runs has already gone at thirty days, so a run older than a month shows its outcome and reasons without the underlying records.',
  },
  {
    target: 'webhook_receipts',
    label: 'Webhook receipts',
    contents: 'Provider name, event id, a payload hash and the processing outcome. No payload.',
    basis: 'swept_on_expiry',
    retentionDays: 30,
    expiryColumn: 'webhook_receipts.received_at',
    columnKind: 'age_from_column',
    graceDays: 0,
    reason:
      'This is what stops a redelivered provider event being processed twice. It has to outlive the longest redelivery window a provider uses, and thirty days comfortably does. It contains no customer content.',
  },
  {
    target: 'notification_deliveries',
    label: 'Notification records',
    contents:
      'Which template went to which hashed address, when, and what the sending service said. Never the message body, never the address itself.',
    basis: 'swept_on_expiry',
    retentionDays: 180,
    expiryColumn: 'notification_deliveries.created_at',
    columnKind: 'age_from_column',
    graceDays: 0,
    reason:
      'Six months so that "you never told me" can be answered with a record rather than a shrug, across a billing dispute that may surface months later. The recipient is stored as a hash, so this set cannot be turned back into a mailing list.',
  },
  {
    target: 'support_cases',
    label: 'Support cases',
    contents:
      'Your message with credentials, tokens, card-shaped numbers and other addresses removed before storage, plus the category and state.',
    basis: 'swept_on_expiry',
    retentionDays: 365,
    expiryColumn: 'support_cases.updated_at',
    columnKind: 'age_from_column',
    graceDays: 0,
    reason:
      'A year from the last update, so a conversation that restarts months later still has its history and a billing or consumer dispute can be answered. Bodies are redacted on the way in, not on the way out, so what is held for the year is already stripped.',
  },
  {
    target: 'audit_events',
    label: 'Audit records',
    contents:
      'Who did what and when — sign-ins, permission changes, deletions, owner actions — with metadata redacted.',
    basis: 'swept_on_expiry',
    retentionDays: 365,
    expiryColumn: 'audit_events.occurred_at',
    columnKind: 'age_from_column',
    graceDays: 0,
    reason:
      'A year, because a security question is usually asked long after the event, and an audit trail shorter than the period people ask about is not an audit trail. These records carry no message content and no credentials.',
  },
  {
    target: 'visit_sessions',
    label: 'Website analytics sessions',
    contents:
      'A salted daily hash, the landing path and campaign parameters. No IP address is ever stored.',
    basis: 'swept_on_expiry',
    retentionDays: 14,
    expiryColumn: 'visit_sessions.expires_at',
    columnKind: 'absolute_expiry',
    graceDays: 0,
    reason:
      'The shortest window that is still useful: a visit exists only to connect a sign-up to the campaign that produced it, and that connection happens within days. Fourteen days covers a fortnightly advertising cycle and nothing more. The identifier is a salted daily hash, so it is not durable across days in any case.',
  },
  {
    target: 'sessions',
    label: 'Sign-in sessions',
    contents: 'A hashed session token and its expiry.',
    basis: 'swept_on_expiry',
    retentionDays: 1,
    expiryColumn: 'sessions.expires_at',
    columnKind: 'absolute_expiry',
    graceDays: 1,
    reason:
      'Swept a day after expiry. An expired session is already useless; keeping the row longer only widens what a database compromise would reveal about when people were signed in.',
  },
  {
    target: 'login_tokens',
    label: 'Sign-in links',
    contents: 'A hashed one-time token and its expiry.',
    basis: 'swept_on_expiry',
    retentionDays: 1,
    expiryColumn: 'login_tokens.expires_at',
    columnKind: 'absolute_expiry',
    graceDays: 1,
    reason:
      'Swept a day after expiry, for the same reason as sessions. A used or expired magic link has no further purpose.',
  },
  {
    target: 'rate_limits',
    label: 'Rate limit counters',
    contents: 'A hashed bucket name and a count.',
    basis: 'swept_on_expiry',
    retentionDays: 1,
    expiryColumn: 'rate_limits.expires_at',
    columnKind: 'absolute_expiry',
    graceDays: 1,
    reason:
      'These exist for the length of one window. Sweeping them a day later keeps the table from growing without bound and holds nothing identifying.',
  },
  {
    target: null,
    label: 'Account records',
    contents: 'Your email address, workspace, membership and workflow configuration.',
    basis: 'lifetime_of_account',
    retentionDays: null,
    expiryColumn: null,
    columnKind: null,
    graceDays: 0,
    reason:
      'Kept while the account exists, because the account is made of them. Removed when you delete the workspace — see the deletion section.',
  },
  {
    target: null,
    label: 'Billing and tax records',
    contents:
      'Orders, subscriptions, refunds and the payment provider’s customer reference. Never a card number — we never receive one.',
    basis: 'retained_for_obligation',
    retentionDays: null,
    expiryColumn: null,
    columnKind: null,
    graceDays: 0,
    reason:
      'Kept after account deletion because business and tax records must be. The exact period is stated in docs/privacy-retention.md against a cited HMRC source rather than guessed at here.',
  },
];

/** Index by target so a sweep can look a rule up without scanning the table. */
const RULE_BY_TARGET = new Map<RetentionTarget, RetentionRule>(
  RETENTION_POLICY.flatMap((rule) => (rule.target === null ? [] : [[rule.target, rule] as const])),
);

export function ruleFor(target: RetentionTarget): RetentionRule | undefined {
  return RULE_BY_TARGET.get(target);
}

/** Every target the scheduled sweep touches, in the order it touches them. */
export const SWEPT_TARGETS: readonly RetentionTarget[] = RETENTION_POLICY.flatMap((rule) =>
  rule.target !== null && rule.basis === 'swept_on_expiry' ? [rule.target] : [],
);

/* -------------------------------------------------------------------------- */
/* raw payload discarding                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keep only the fields we actually validated, and return a new object.
 *
 * This is the executable form of the first row of the retention table. A webhook or event
 * handler calls it immediately after signature verification, and whatever it returns is
 * the only thing that may be persisted. An allowlist, never a denylist: a field nobody
 * thought about is dropped rather than stored.
 */
export function discardRawPayload(
  raw: unknown,
  allowlist: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of allowlist) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* the sweep                                                                  */
/* -------------------------------------------------------------------------- */

export const SWEEP_DEFAULTS = {
  /** Rows per statement. Small enough that one batch is never the slow query. */
  BATCH_SIZE: 100,
  MAX_BATCH_SIZE: 500,
  /** Ceiling per target per sweep. 20 x 100 = 2,000 rows, then we stop and say so. */
  MAX_BATCHES_PER_TARGET: 20,
} as const;

export interface SweepOptions {
  /** Defaults to every `swept_on_expiry` target. */
  readonly targets?: readonly RetentionTarget[];
  readonly batchSize?: number;
  readonly maxBatchesPerTarget?: number;
  readonly now?: Date;
  /** Restrict to one workspace. Used by deletion, never by the cron sweep. */
  readonly workspaceId?: string;
}

export interface TargetReport {
  readonly target: RetentionTarget;
  /** Rows the scan found eligible. */
  readonly examined: number;
  /** Rows the database actually removed. Never inferred from `examined`. */
  readonly removed: number;
  readonly batches: number;
  /** False when the batch ceiling was reached with work still to do. */
  readonly complete: boolean;
  /** Where the next sweep resumes. `null` once the target is finished. */
  readonly resumeAfterId: string | null;
  /** Set when the sweep stopped early because something failed. */
  readonly error: string | null;
}

export interface RetentionReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly targets: readonly TargetReport[];
  readonly totalRemoved: number;
  /** True only when every target finished. */
  readonly complete: boolean;
}

function checkpointKey(target: RetentionTarget, workspaceId?: string): string {
  return workspaceId === undefined
    ? `retention:cursor:${target}`
    : `retention:cursor:${target}:${workspaceId}`;
}

function daysBefore(now: Date, days: number): string {
  return toIso(new Date(now.getTime() - days * 24 * 60 * 60 * 1_000));
}

/**
 * The instant a row's expiry column must be at or before to be eligible.
 *
 * An `absolute_expiry` column already holds the deadline, so the cut-off is now (less any
 * grace). An `age_from_column` column holds a creation time, so the cut-off is the
 * retention period ago. Conflating the two is the bug that silently doubles a published
 * retention period, which is why it is one exported function with its own test.
 */
export function eligibilityCutoff(rule: RetentionRule, now: Date): string | null {
  if (rule.retentionDays === null || rule.columnKind === null) return null;
  return rule.columnKind === 'absolute_expiry'
    ? daysBefore(now, rule.graceDays)
    : daysBefore(now, rule.retentionDays);
}

/**
 * Run the retention sweep.
 *
 * Never throws. A target that fails is reported with its error and the sweep carries on
 * to the next one, because one broken table must not stop every other table's data being
 * removed on time.
 */
export async function runRetentionSweep(
  port: SupportDataPort,
  options: SweepOptions = {},
): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const startedAt = toIso(now);
  const batchSize = Math.min(
    SWEEP_DEFAULTS.MAX_BATCH_SIZE,
    Math.max(1, Math.trunc(options.batchSize ?? SWEEP_DEFAULTS.BATCH_SIZE)),
  );
  const maxBatches = Math.max(
    1,
    Math.trunc(options.maxBatchesPerTarget ?? SWEEP_DEFAULTS.MAX_BATCHES_PER_TARGET),
  );
  const targets = options.targets ?? SWEPT_TARGETS;

  const reports: TargetReport[] = [];
  for (const target of targets) {
    reports.push(
      await sweepTarget(port, target, {
        now,
        batchSize,
        maxBatches,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      }),
    );
  }

  return {
    startedAt,
    finishedAt: toIso(new Date()),
    targets: reports,
    totalRemoved: reports.reduce((sum, r) => sum + r.removed, 0),
    complete: reports.every((r) => r.complete && r.error === null),
  };
}

interface TargetSweepOptions {
  readonly now: Date;
  readonly batchSize: number;
  readonly maxBatches: number;
  readonly workspaceId?: string;
}

async function sweepTarget(
  port: SupportDataPort,
  target: RetentionTarget,
  options: TargetSweepOptions,
): Promise<TargetReport> {
  const rule = RULE_BY_TARGET.get(target);
  const expiredAt = rule === undefined ? null : eligibilityCutoff(rule, options.now);
  if (rule === undefined || expiredAt === null) {
    return {
      target,
      examined: 0,
      removed: 0,
      batches: 0,
      complete: true,
      resumeAfterId: null,
      error: 'no retention period is defined for this target, so nothing was removed',
    };
  }

  const key = checkpointKey(target, options.workspaceId);

  let afterId: string | null = null;
  let examined = 0;
  let removed = 0;
  let batches = 0;

  try {
    afterId = await port.readCheckpoint(key);

    while (batches < options.maxBatches) {
      const page: readonly { readonly id: string }[] = await port.listExpired({
        target,
        expiredAt,
        afterId,
        limit: options.batchSize,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      });
      if (page.length === 0) {
        // Finished. Clearing the checkpoint means the next sweep starts from the
        // beginning and picks up rows that expire between now and then.
        await port.writeCheckpoint(key, null);
        return {
          target,
          examined,
          removed,
          batches,
          complete: true,
          resumeAfterId: null,
          error: null,
        };
      }

      batches += 1;
      examined += page.length;

      const ids = page.map((row) => row.id);
      removed += await port.deleteRows(target, ids);

      // Advance past the highest id we handled, whether or not every delete matched.
      // A row that was already gone must not make us scan it forever.
      const lastId = ids[ids.length - 1];
      afterId = lastId ?? afterId;
      await port.writeCheckpoint(key, afterId);
    }

    // Ceiling reached with rows possibly still eligible. Say so rather than implying the
    // table is clean.
    return {
      target,
      examined,
      removed,
      batches,
      complete: false,
      resumeAfterId: afterId,
      error: null,
    };
  } catch (cause) {
    return {
      target,
      examined,
      removed,
      batches,
      complete: false,
      resumeAfterId: afterId,
      error: cause instanceof Error ? cause.message : 'unknown error during sweep',
    };
  }
}

/**
 * One-line summary of a report, for the owner dashboard and the cron log.
 *
 * Says "incomplete" when it was incomplete. There is no formulation of this sentence that
 * reports a partial sweep as a success.
 */
export function summariseRetentionReport(report: RetentionReport): string {
  const parts = report.targets.map(
    (t) => `${t.target}: ${String(t.removed)} removed${t.complete ? '' : ' (incomplete)'}`,
  );
  const headline = report.complete
    ? `Retention sweep complete. ${String(report.totalRemoved)} rows removed.`
    : `Retention sweep incomplete — some targets still have expired rows. ${String(
        report.totalRemoved,
      )} rows removed so far.`;
  return `${headline} ${parts.join('; ')}.`;
}
