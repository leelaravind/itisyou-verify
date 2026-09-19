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
import { CLAIM_APPROVAL_SQL, type ApprovalClaimStore } from '../owner/approvals';
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
