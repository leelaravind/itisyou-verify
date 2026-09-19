/**
 * The approval compare-and-set, against D1.
 *
 * This file executes exactly one statement and it is **not written here**:
 * `CLAIM_APPROVAL_SQL` is imported from `apps/app/src/owner/approvals.ts`, where it lives
 * beside the rules it enforces. A second spelling of it anywhere is a defect, because an
 * approval's single-use guarantee is the statement — `meta.changes === 1` **is** the
 * permission, not evidence of it.
 *
 * What this must never do: re-read the row and compare. Returning true because the
 * approval *looks* consumed afterwards reintroduces precisely the check-then-act race the
 * statement exists to remove — two callers holding one approval would both see `consumed`
 * and both believe they were the one who spent it.
 *
 * Sequencing, which A06 owns at the call site and which is the point of the design:
 * `decideRefund` claims **before** `gateway.createRefund`. Consume-after means a crash
 * between the provider call and the write leaves a spendable approval next to a refund
 * that already happened.
 */
import { CLAIM_APPROVAL_SQL, type ApprovalClaimStore, type OwnerApproval } from '../owner/approvals';
import type { Db } from './d1';


/**
 * Spend an approval, and say whether **this call** spent it.
 *
 * `true` means this caller holds the permission. `false` means the approval was already
 * consumed, revoked, expired or absent — the caller must stop, and must not ask why,
 * because the answer does not change what it has to do.
 */
export class D1ApprovalClaims implements ApprovalClaimStore {
  constructor(private readonly db: Db) {}

  async claim(params: { approvalId: string; at: string }): Promise<boolean> {
    const result = await this.db
      .prepare(CLAIM_APPROVAL_SQL)
      .bind(params.at, params.approvalId, params.at)
      .run();
    return result.meta.changes === 1;
  }
}

/** Factory, for the composition root. */
export function createApprovalClaims(db: Db): D1ApprovalClaims {
  return new D1ApprovalClaims(db);
}

/**
 * The consumer `decideRefund` requires, over the real D1 store.
 *
 * This is the call site the primitive was missing. `decideRefund` calls it strictly before
 * `gateway.createRefund`, so the approval is spent before the money moves — an approval
 * consumed afterwards is not single-use across a crash.
 *
 * ## The retry contract, which is the subtle part
 *
 * A06's rule: re-consuming for the **same** `refundId` must return `true`, or the
 * documented retry after a transport failure could never complete. `false` must mean the
 * approval was spent on a *different* refund.
 *
 * The `approvals` table records no refund id, so the link is read from the other side:
 * on a successful claim this stamps `refunds.approval_id`, and on a failed claim it asks
 * whether this very refund already carries this approval. Same refund retrying → `true`.
 * A second refund reaching for a spent approval → `false`.
 *
 * The stamp is `WHERE approval_id IS NULL`, so it can never re-point a refund at a second
 * approval.
 */
export function createRefundApprovalConsumer(
  db: Db,
  now: () => Date = () => new Date(),
): (params: { approval: OwnerApproval; refundId: string }) => Promise<boolean> {
  const store = new D1ApprovalClaims(db);

  return async ({ approval, refundId }) => {
    const at = now().toISOString();
    const claimed = await store.claim({ approvalId: approval.id, at });

    if (claimed) {
      // Record which refund spent it, so a retry of THIS refund can recognise itself.
      await db
        .prepare('UPDATE refunds SET approval_id = ?, updated_at = ? WHERE id = ? AND approval_id IS NULL')
        .bind(approval.id, at, refundId)
        .run();
      return true;
    }

    // Already spent. The only question left is whether it was spent on this refund.
    const existing = await db
      .prepare('SELECT approval_id FROM refunds WHERE id = ?')
      .bind(refundId)
      .first<{ approval_id: string | null }>();
    return existing?.approval_id === approval.id;
  };
}
