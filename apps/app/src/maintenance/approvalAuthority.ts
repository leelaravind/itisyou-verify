/**
 * How a maintenance job proves it was approved.
 *
 * `execute_approved_release` is the one job kind that changes what customers are served,
 * so it is approval-bound. Being approval-bound has to mean four things, in this order,
 * and `enqueueJob` does them in this order:
 *
 *  1. **Load** the approval the payload names. A string that matches no row is `not_found`.
 *  2. **Stand**: the row must be `granted`, unrevoked and unexpired, right now.
 *  3. **Cover**: the approval's action type must be one that binds an approval to *this*
 *     release. An approval granted for a refund, a cleanup or a budget change does not
 *     authorise a release however valid it is — that was the live shape of today's restore
 *     defect, where a `cleanup_execute` approval read as permission to replace the code.
 *  4. **Spend** it, through the single compare-and-set in `apps/app/src/owner/approvals.ts`
 *     (`CLAIM_APPROVAL_SQL`, executed by `D1ApprovalClaims`), *before* the job row exists.
 *     `meta.changes === 1` is the permission; the loser of a double-submit gets zero rows
 *     and no job.
 *
 * ## What is honestly missing, stated here so the code cannot imply otherwise
 *
 * `OWNER_ACTION_TYPES` in `owner/approvals.ts` is a closed set of four —
 * `campaign_launch`, `refund_issue`, `budget_limit_change`, `cleanup_execute` — and none of
 * them describes a release. Adding one is a product decision the lead makes, not a fix an
 * agent applies, so this module does **not** add it. The consequence is deliberate and
 * fail-closed: {@link noActionTypeCoversRelease} refuses every approval at step 3 with a
 * detail that names the gap, so today no string of any kind can queue a release. When the
 * lead rules on a release action type, the `covers` step becomes `checkOwnerApproval` over
 * that type's canonical payload and nothing else in the enqueue path changes.
 *
 * The one read-only `SELECT` on `approvals` below is the only SQL in this file. The
 * statement that spends an approval is not respelled here — a second spelling of it
 * anywhere is a defect, per the note beside `CLAIM_APPROVAL_SQL`.
 */
import type { Currency } from '@verify/contracts';
import { createApprovalClaims } from '../db/approvalClaims.js';
import type { Db } from '../db/d1.js';
import {
  isOwnerActionType,
  type ApprovalClaimStore,
  type OwnerApproval,
} from '../owner/approvals.js';
import type { MaintenancePayload } from './kinds.js';

export type ReleasePayload = Extract<
  MaintenancePayload,
  { readonly kind: 'execute_approved_release' }
>;

/** Why an approval did not authorise a release. Every member is a refusal, never a pass. */
export type ReleaseApprovalRejection =
  | 'not_found'
  | 'status_not_granted'
  | 'already_consumed'
  | 'withdrawn'
  | 'expired'
  | 'action_type_mismatch'
  | 'payload_changed';

export type ReleaseCoverage =
  | { readonly covers: true }
  | {
      readonly covers: false;
      readonly reason: 'action_type_mismatch' | 'payload_changed';
      readonly detail: string;
    };

/**
 * The three things `enqueueJob` needs from the approvals store, as a port so the job
 * module stays free of approvals SQL and so a test can prove the spend happens before the
 * write by wrapping `claims`.
 */
export interface ReleaseApprovalAuthority {
  /** The approval as it stands in the database, or `null` when no such row exists. */
  load(approvalId: string): Promise<OwnerApproval | null>;
  /**
   * Does this granted, unexpired approval bind to exactly this release? Pure: spends
   * nothing, so a refusal here leaves the owner's approval intact for what it was for.
   */
  covers(approval: OwnerApproval, payload: ReleasePayload): Promise<ReleaseCoverage>;
  /** The compare-and-set that spends an approval. `true` means this caller spent it. */
  readonly claims: ApprovalClaimStore;
}

/**
 * The production `covers`: no owner action type binds an approval to a release, so no
 * approval covers one. The detail says exactly that, naming what the approval *was* for,
 * because the owner reading the refusal has done nothing wrong.
 */
export function noActionTypeCoversRelease(
  approval: OwnerApproval,
  payload: ReleasePayload,
): ReleaseCoverage {
  return {
    covers: false,
    reason: 'action_type_mismatch',
    detail:
      `approval ${approval.id} was granted for ${approval.action_type}, which does not authorise a release to ` +
      `${payload.environment}. No owner action type on this deployment binds an approval to a release, so at ` +
      'present nothing can authorise this job: that is a missing action type, not a mistake in the request. ' +
      'The approval has not been used.',
  };
}

interface ApprovalRow {
  readonly id: string;
  readonly owner_id: string;
  readonly action_type: string;
  readonly canonical_payload_hash: string;
  readonly maximum_amount_minor: number | null;
  readonly currency: string | null;
  readonly status: string;
  readonly note: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

/**
 * Read one approval. A row whose `action_type` is outside the closed set is reported as
 * absent, the same decision `D1OwnerDataPort.approval` makes: a type this code does not
 * know cannot be reasoned about, and "unknown" must fail closed.
 */
async function loadApproval(db: Db, approvalId: string): Promise<OwnerApproval | null> {
  const row = await db
    .prepare(
      `SELECT id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency,
              status, note, created_at, expires_at, consumed_at
         FROM approvals WHERE id = ?`,
    )
    .bind(approvalId)
    .first<ApprovalRow>();
  if (row === null || !isOwnerActionType(row.action_type)) return null;
  return {
    id: row.id,
    action_type: row.action_type,
    owner_id: row.owner_id,
    canonical_payload_hash: row.canonical_payload_hash,
    maximum_amount_minor:
      row.maximum_amount_minor === null ? null : Number(row.maximum_amount_minor),
    currency: (row.currency as Currency | null) ?? null,
    status: row.status as OwnerApproval['status'],
    summary: row.note ?? '',
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

/** The live authority over D1: real rows in, the real compare-and-set out. */
export function createD1ReleaseApprovalAuthority(db: Db): ReleaseApprovalAuthority {
  return {
    load: (approvalId) => loadApproval(db, approvalId),
    covers: async (approval, payload) => noActionTypeCoversRelease(approval, payload),
    claims: createApprovalClaims(db),
  };
}
