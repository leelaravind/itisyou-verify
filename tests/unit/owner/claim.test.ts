/**
 * Consuming an approval — the fix for A10's `AUTH-511`.
 *
 * The defect: `approvals.status` had a `consumed` state that nothing ever wrote, so
 * `checkOwnerApproval` was a check-then-act. Two callers holding the same approval both saw
 * `granted`, both passed, and both proceeded. It was bounded by `refunds.idempotency_key`
 * being `UNIQUE`, so nobody was going to be charged twice today — but a single-use control
 * that is not single-use is not a control, and `consumed_at` was a missing audit fact.
 *
 * The property under test throughout: **there is no way to obtain permission without having
 * spent it.** The check and the claim are one call, and the row count is the permission.
 *
 * Case ids `OWNER-290..299`.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_APPROVAL_SQL,
  claimApproval,
  explainApprovalRejection,
  grantOwnerApproval,
  type ApprovalClaimStore,
  type OwnerApproval,
  type OwnerApprovalPayload,
} from '@app/owner/approvals';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const EXPIRES = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();

const PAYLOAD: OwnerApprovalPayload = {
  action_type: 'refund_issue',
  payload: {
    workspace_id: 'ws_1',
    order_id: 'ord_1',
    amount_minor: 4900,
    currency: 'GBP',
    policy_rule: 'unused_period_within_14_days',
    reason: 'the connection never worked',
  },
};

async function granted(): Promise<OwnerApproval> {
  return grantOwnerApproval(PAYLOAD, {
    id: 'apr_1',
    owner_id: 'usr_owner',
    maximum_amount_minor: 4900,
    currency: 'GBP',
    summary: 'Refund September in full',
    created_at: NOW.toISOString(),
    expires_at: EXPIRES,
  });
}

/**
 * A faithful stand-in for the real statement: it moves `granted` → `consumed` under the
 * same guard and reports whether THIS call moved it. Deliberately not a re-read.
 */
function store(rows: OwnerApproval[]): ApprovalClaimStore & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async claim({ approvalId, at }) {
      calls.push(calls.length);
      const index = rows.findIndex((r) => r.id === approvalId);
      const row = index === -1 ? undefined : rows[index];
      if (row === undefined) return false;
      if (row.status !== 'granted') return false;
      if (Date.parse(row.expires_at) <= Date.parse(at)) return false;
      rows[index] = { ...row, status: 'consumed', consumed_at: at };
      return true;
    },
  };
}

describe('an approval is spent, not merely checked', () => {
  it('OWNER-290 the canonical statement is a compare-and-set on granted, not an unconditional write', () => {
    expect(CLAIM_APPROVAL_SQL).toMatch(/UPDATE\s+approvals\s+SET/i);
    expect(CLAIM_APPROVAL_SQL).toMatch(/status\s*=\s*'consumed'/);
    expect(CLAIM_APPROVAL_SQL).toMatch(/consumed_at\s*=/);
    // The guard is what makes the row count a permission.
    expect(CLAIM_APPROVAL_SQL).toMatch(
      /WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*'granted'\s+AND\s+expires_at\s*>\s*\?/i,
    );
  });

  it('OWNER-291 a valid approval is consumed by the act of authorising', async () => {
    const rows = [await granted()];
    const claim = await claimApproval(rows[0] as OwnerApproval, PAYLOAD, {
      store: store(rows),
      now: NOW,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('unreachable');
    expect(claim.consumedAt).toBe(NOW.toISOString());
    expect(rows[0]?.status).toBe('consumed');
    expect(rows[0]?.consumed_at).toBe(NOW.toISOString());
  });

  it('OWNER-292 a second attempt on the same approval loses and stops', async () => {
    const rows = [await granted()];
    const approval = rows[0] as OwnerApproval;
    const claims = store(rows);
    const first = await claimApproval(approval, PAYLOAD, { store: claims, now: NOW });
    // The second caller still holds the ORIGINAL record, which says `granted` — exactly the
    // stale read that made check-then-act unsafe. It must still lose.
    const second = await claimApproval(approval, PAYLOAD, { store: claims, now: NOW });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.reason).toBe('already_consumed');
  });

  it('OWNER-293 two simultaneous callers produce exactly one winner', async () => {
    const rows = [await granted()];
    const approval = rows[0] as OwnerApproval;
    const claims = store(rows);
    const results = await Promise.all([
      claimApproval(approval, PAYLOAD, { store: claims, now: NOW }),
      claimApproval(approval, PAYLOAD, { store: claims, now: NOW }),
      claimApproval(approval, PAYLOAD, { store: claims, now: NOW }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(rows[0]?.status).toBe('consumed');
  });

  it('OWNER-294 a payload that changed by a penny never reaches the claim at all', async () => {
    const rows = [await granted()];
    const claims = store(rows);
    const moved: OwnerApprovalPayload = {
      action_type: 'refund_issue',
      payload: { ...PAYLOAD.payload, amount_minor: 4901 },
    };
    const claim = await claimApproval(rows[0] as OwnerApproval, moved, { store: claims, now: NOW });
    expect(claim.ok).toBe(false);
    if (claim.ok) throw new Error('unreachable');
    expect(claim.reason).toBe('payload_changed');
    // Nothing was spent, so the owner's approval is still there to use on the right payload.
    expect(claims.calls).toHaveLength(0);
    expect(rows[0]?.status).toBe('granted');
  });

  it('OWNER-295 an expired approval is not consumed, so it cannot be burned by a late attempt', async () => {
    const rows = [await granted()];
    const claims = store(rows);
    const claim = await claimApproval(rows[0] as OwnerApproval, PAYLOAD, {
      store: claims,
      now: new Date(Date.parse(EXPIRES) + 1000),
    });
    if (claim.ok) throw new Error('unreachable');
    expect(claim.reason).toBe('expired');
    expect(claims.calls).toHaveLength(0);
  });

  it('OWNER-296 a claim whose row vanished is refused rather than assumed', async () => {
    const approval = await granted();
    const claim = await claimApproval(approval, PAYLOAD, { store: store([]), now: NOW });
    expect(claim.ok).toBe(false);
    if (claim.ok) throw new Error('unreachable');
    expect(claim.reason).toBe('already_consumed');
  });

  it('OWNER-297 every rejection, including the new one, has a sentence an owner can act on', () => {
    for (const reason of [
      'already_consumed',
      'expired',
      'payload_changed',
      'status_not_granted',
      'action_type_mismatch',
      'currency_mismatch',
      'amount_exceeds_approved_maximum',
    ] as const) {
      const text = explainApprovalRejection(reason);
      expect(text.length).toBeGreaterThan(30);
      expect(text).not.toContain('_');
    }
  });
});
