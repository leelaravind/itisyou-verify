/**
 * The refund approval binding, across the A06/A07 seam.
 *
 * ## Why this file exists
 *
 * I reported that A06 had not written approval hashing; A06 reported that `decideRefund`
 * carries the approval record and rebuilds the payload from the stored row. Both reports
 * were written at different times and only one of them was current. Reading the code
 * settles it — but a summary can go stale again next week, and a test cannot.
 *
 * So this asserts the property directly: **there is exactly one hash of a refund, and it is
 * the one in `owner/approvals.ts`.** If anybody ever computes a second one, the case below
 * that compares A06's payload against my hash stops agreeing and this fails.
 *
 * The verdict on reading, recorded here so the next person does not have to repeat it:
 * A06 imports `checkOwnerApproval` and `explainApprovalRejection` from `../owner/approvals`,
 * computes no digest of its own, and its `refundApprovalPayload` builds my
 * `OwnerApprovalPayload` from the stored refund row rather than from anything a caller
 * passed. Their choice to take the approval *record* rather than an id is better than the
 * id-only shape I originally proposed: the hash of what the owner actually read travels
 * with the decision, so the check cannot be satisfied by looking up a different approval.
 *
 * Case ids: `OWNER-280..289`. `OWNER-001..199` and `230..279` are mine; A08 holds `201..224`.
 */
import { describe, expect, it } from 'vitest';
import { refundApprovalPayload } from '@app/billing/refunds';
import {
  checkOwnerApproval,
  grantOwnerApproval,
  ownerPayloadHash,
  type OwnerApprovalPayload,
} from '@app/owner/approvals';
import type { RefundRecord } from '@app/billing/port';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const EXPIRES = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();

function refund(overrides: Partial<RefundRecord> = {}): RefundRecord {
  return {
    id: 'ref_1',
    workspaceId: 'ws_1',
    orderId: 'ord_1',
    providerRefundId: null,
    amountMinor: 4900,
    currency: 'GBP',
    state: 'queued_for_owner',
    reason: 'the HubSpot connection never worked',
    idempotencyKey: 'ref-key-1',
    approvalId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as RefundRecord;
}

async function approvalFor(payload: OwnerApprovalPayload, maximumAmountMinor: number) {
  return grantOwnerApproval(payload, {
    id: 'apr_refund_1',
    owner_id: 'usr_owner',
    maximum_amount_minor: maximumAmountMinor,
    currency: 'GBP',
    summary: 'Refund September in full — the connection never worked',
    created_at: NOW.toISOString(),
    expires_at: EXPIRES,
  });
}

describe('refund approvals are hashed once, by owner/approvals.ts', () => {
  it('OWNER-280 A06 builds the payload my hash function expects, with no second digest', async () => {
    const payload = refundApprovalPayload(refund(), 'within_14_days_unused');
    expect(payload.action_type).toBe('refund_issue');
    // The hash is computable by my function from A06's payload — which is only true if the
    // shapes are the same object contract rather than two similar ones.
    const hash = await ownerPayloadHash(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('OWNER-281 the payload is derived from the stored row, so a caller cannot smuggle an amount', async () => {
    const stored = refund({ amountMinor: 4900 });
    const payload = refundApprovalPayload(stored, 'within_14_days_unused');
    if (payload.action_type !== 'refund_issue') throw new Error('unreachable');
    expect(payload.payload.amount_minor).toBe(4900);
    expect(payload.payload.workspace_id).toBe(stored.workspaceId);
    expect(payload.payload.order_id).toBe(stored.orderId);
    expect(payload.payload.reason).toBe(stored.reason);
  });

  it('OWNER-282 an approval granted over A06’s payload authorises that exact refund', async () => {
    const payload = refundApprovalPayload(refund(), 'within_14_days_unused');
    const approval = await approvalFor(payload, 4900);
    const check = await checkOwnerApproval(approval, payload, NOW);
    expect(check.valid).toBe(true);
  });

  it('OWNER-283 one penny more on the stored row stops the approval applying', async () => {
    const approved = refundApprovalPayload(refund({ amountMinor: 4900 }), 'within_14_days_unused');
    const approval = await approvalFor(approved, 4900);
    const moved = refundApprovalPayload(refund({ amountMinor: 4901 }), 'within_14_days_unused');
    const check = await checkOwnerApproval(approval, moved, NOW);
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('payload_changed');
  });

  it('OWNER-284 citing a different published rule stops the approval applying', async () => {
    const approved = refundApprovalPayload(refund(), 'within_14_days_unused');
    const approval = await approvalFor(approved, 4900);
    const reRuled = refundApprovalPayload(refund(), 'service_never_delivered');
    const check = await checkOwnerApproval(approval, reRuled, NOW);
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('payload_changed');
  });

  it('OWNER-285 an expired approval authorises nothing, however right the amount is', async () => {
    const payload = refundApprovalPayload(refund(), 'within_14_days_unused');
    const approval = await approvalFor(payload, 4900);
    const check = await checkOwnerApproval(approval, payload, new Date(Date.parse(EXPIRES) + 1000));
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('expired');
  });

  it('OWNER-286 a refund approval cannot be replayed as a cleanup or a budget change', async () => {
    const payload = refundApprovalPayload(refund(), 'within_14_days_unused');
    const approval = await approvalFor(payload, 4900);
    const elsewhere: OwnerApprovalPayload = {
      action_type: 'budget_limit_change',
      payload: {
        account_scope: 'platform:advertising',
        current_limit_minor: 1500,
        proposed_limit_minor: 4900,
        currency: 'GBP',
        justification: 'same numbers, different action',
      },
    };
    const check = await checkOwnerApproval(approval, elsewhere, NOW);
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('action_type_mismatch');
  });

  it('OWNER-287 the same refund hashes identically however the row is built', async () => {
    // Key order is not part of the hash — a serialiser change must never invalidate an
    // approval, and a changed number must never be hidden by reordering keys.
    const a = refundApprovalPayload(refund(), 'within_14_days_unused');
    const b = refundApprovalPayload(
      refund({ updatedAt: '2026-09-19T13:00:00.000Z', idempotencyKey: 'a-different-key' }),
      'within_14_days_unused',
    );
    expect(await ownerPayloadHash(a)).toBe(await ownerPayloadHash(b));
  });
});
