/**
 * Approvals.
 *
 * The property: an approval is a statement about one exact payload, made by one person, at
 * one time, and it stops being true when any of that changes. A penny, a day, a category.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LIFETIME_SECONDS,
  approvalStanding,
  bindCampaignApproval,
  canonicalOwnerPayload,
  checkCampaignApproval,
  checkOwnerApproval,
  explainApprovalRejection,
  grantOwnerApproval,
  isOwnerActionType,
  ownerPayloadHash,
  OWNER_ACTION_TYPES,
  type OwnerApprovalPayload,
} from '@app/owner/approvals';
import type { CampaignPacket } from '@app/growth/approval';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + APPROVAL_LIFETIME_SECONDS * 1000 + 1000);

const REFUND: OwnerApprovalPayload = {
  action_type: 'refund_issue',
  payload: {
    workspace_id: 'ws_1',
    order_id: 'ord_1',
    amount_minor: 4900,
    currency: 'GBP',
    policy_rule: 'within_14_days_unused',
    reason: 'HubSpot connection never worked, customer never got a verified run',
  },
};

function grantInput(overrides: Partial<Parameters<typeof grantOwnerApproval>[1]> = {}) {
  return {
    id: 'apr_1',
    owner_id: 'usr_owner',
    maximum_amount_minor: 4900,
    currency: 'GBP' as const,
    summary: 'Refund September in full — the connection never worked',
    created_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + APPROVAL_LIFETIME_SECONDS * 1000).toISOString(),
    ...overrides,
  };
}

const PACKET: CampaignPacket = {
  platform: 'reddit',
  budget_minor: 1500,
  currency: 'GBP',
  audience: {
    description: 'People who build automations',
    targets: ['r/n8n'],
    negatives: ['hiring'],
    geography: ['GB'],
    languages: ['en'],
  },
  creative: {
    headline: 'Did your automation finish the job?',
    body: 'Check CRM records and email outcomes against your rules.',
    call_to_action: 'Explore ITISYOU Verify',
  },
  destination: {
    url: 'https://verify.itisyou.app/?utm_source=reddit',
    conversion_definition: 'a workspace is created',
  },
  duration: {
    starts_at: '2026-10-05T09:00:00.000Z',
    ends_at: '2026-10-12T09:00:00.000Z',
    timezone: 'Europe/London',
  },
  bidding: { max_cpc_minor: 60, strategy: 'manual_cpc' },
};

describe('owner approvals', () => {
  it('OWNER-021 an approval records the action, the amount, who approved and when', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    expect(approval.action_type).toBe('refund_issue');
    expect(approval.maximum_amount_minor).toBe(4900);
    expect(approval.owner_id).toBe('usr_owner');
    expect(approval.created_at).toBe(NOW.toISOString());
    expect(approval.summary.length).toBeGreaterThan(10);
  });

  it('OWNER-022 an approval authorises the exact payload it was bound to', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    const check = await checkOwnerApproval(approval, REFUND, NOW);
    expect(check.valid).toBe(true);
  });

  it('OWNER-023 an approval does not authorise a payload differing by one penny', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    const onePennyMore: OwnerApprovalPayload = {
      action_type: 'refund_issue',
      payload: { ...REFUND.payload, amount_minor: 4901 },
    };
    const check = await checkOwnerApproval(approval, onePennyMore, NOW);
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('payload_changed');
  });

  it('OWNER-024 a campaign approval does not authorise a packet differing by one penny', async () => {
    const approval = await bindCampaignApproval(PACKET, {
      id: 'apr_c',
      owner_id: 'usr_owner',
      maximum_amount_minor: 1800,
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
    });
    const check = await checkCampaignApproval(approval, { ...PACKET, budget_minor: 1501 }, NOW);
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('payload_changed');
  });

  it('OWNER-025 an expired approval authorises nothing, and says so before anything else', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    const check = await checkOwnerApproval(approval, REFUND, LATER);
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('expired');
  });

  it('OWNER-026 an expired approval reports expiry rather than a payload change', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    const changed: OwnerApprovalPayload = {
      action_type: 'refund_issue',
      payload: { ...REFUND.payload, amount_minor: 100 },
    };
    const check = await checkOwnerApproval(approval, changed, LATER);
    if (check.valid) throw new Error('unreachable');
    // Both are true; the owner needs to be told the one that is actionable.
    expect(check.reason).toBe('expired');
  });

  it('OWNER-027 a withdrawn approval authorises nothing', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    const check = await checkOwnerApproval({ ...approval, status: 'revoked' }, REFUND, NOW);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('status_not_granted');
  });

  it('OWNER-028 a refund approval cannot be replayed as a budget change with the same numbers', async () => {
    const budget: OwnerApprovalPayload = {
      action_type: 'budget_limit_change',
      payload: {
        account_scope: 'platform:advertising',
        current_limit_minor: 1500,
        proposed_limit_minor: 4900,
        currency: 'GBP',
        justification: 'first campaign',
      },
    };
    const approval = await grantOwnerApproval(REFUND, grantInput());
    const check = await checkOwnerApproval(approval, budget, NOW);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('action_type_mismatch');
    expect(await ownerPayloadHash(REFUND)).not.toBe(await ownerPayloadHash(budget));
  });

  it('OWNER-029 an approval cannot authorise less than the thing it approves', async () => {
    await expect(
      grantOwnerApproval(REFUND, grantInput({ maximum_amount_minor: 4899 })),
    ).rejects.toThrow(/below the refund amount/);
  });

  it('OWNER-030 an approval must expire after it is created', async () => {
    await expect(
      grantOwnerApproval(REFUND, grantInput({ expires_at: NOW.toISOString() })),
    ).rejects.toThrow(/expire after/);
  });

  it('OWNER-031 cleanup categories in a different order are the same approval', async () => {
    const a: OwnerApprovalPayload = {
      action_type: 'cleanup_execute',
      payload: {
        categories: ['expired_sessions', 'synthetic_workspaces'],
        inventory_hash: 'h',
        resource_count: 3,
        environment: 'staging',
      },
    };
    const b: OwnerApprovalPayload = {
      action_type: 'cleanup_execute',
      payload: {
        categories: ['synthetic_workspaces', 'expired_sessions'],
        inventory_hash: 'h',
        resource_count: 3,
        environment: 'staging',
      },
    };
    expect(await ownerPayloadHash(a)).toBe(await ownerPayloadHash(b));
  });

  it('OWNER-032 a cleanup approval stops applying when the inventory hash moves', async () => {
    const payload: OwnerApprovalPayload = {
      action_type: 'cleanup_execute',
      payload: {
        categories: ['expired_sessions'],
        inventory_hash: 'hash-a',
        resource_count: 2,
        environment: 'staging',
      },
    };
    const approval = await grantOwnerApproval(
      payload,
      grantInput({ maximum_amount_minor: null, currency: null }),
    );
    const moved: OwnerApprovalPayload = {
      action_type: 'cleanup_execute',
      payload: { ...payload.payload, inventory_hash: 'hash-b' },
    };
    const check = await checkOwnerApproval(approval, moved, NOW);
    if (check.valid) throw new Error('unreachable');
    expect(check.reason).toBe('payload_changed');
  });

  it('OWNER-033 a non-integer amount is refused rather than rounded', () => {
    expect(() =>
      canonicalOwnerPayload({
        action_type: 'refund_issue',
        payload: { ...REFUND.payload, amount_minor: 49.005 },
      }),
    ).toThrow(/integer/);
  });

  it('OWNER-034 every rejection has a sentence a non-technical owner can act on', () => {
    const reasons = [
      'action_type_mismatch',
      'status_not_granted',
      'expired',
      'payload_changed',
      'currency_mismatch',
      'amount_exceeds_approved_maximum',
    ] as const;
    for (const reason of reasons) {
      const text = explainApprovalRejection(reason);
      expect(text.length).toBeGreaterThan(30);
      expect(text).not.toContain('_');
    }
  });

  it('OWNER-035 approval standing distinguishes expired, used and withdrawn', async () => {
    const approval = await grantOwnerApproval(REFUND, grantInput());
    expect(approvalStanding(approval, NOW)).toBe('usable');
    expect(approvalStanding(approval, LATER)).toBe('expired');
    expect(approvalStanding({ ...approval, status: 'consumed' }, NOW)).toBe('used');
    expect(approvalStanding({ ...approval, status: 'revoked' }, NOW)).toBe('withdrawn');
  });

  it('OWNER-036 the action-type vocabulary is closed', () => {
    expect(isOwnerActionType('campaign_launch')).toBe(true);
    expect(isOwnerActionType('delete_everything')).toBe(false);
    expect(OWNER_ACTION_TYPES.length).toBe(4);
  });
});
