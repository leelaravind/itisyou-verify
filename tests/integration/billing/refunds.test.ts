/**
 * Refunds.
 *
 * The standing policy under test: the system recommends, the owner decides. Nothing in
 * these tests can move money without a recorded approval, and nothing says "refunded"
 * until Stripe says the money went back.
 */
import { describe, expect, it } from 'vitest';
import {
  customerVisibleRefundState,
  decideRefund,
  listRefundQueue,
  recommendRefund,
  refundApprovalPayload,
  refundIdempotencyKey,
  refundTransition,
  requestRefund,
  type RefundPolicyRule,
} from '@app/billing/refunds';
import { grantOwnerApproval, type OwnerApproval } from '@app/owner/approvals';
import type { RefundRecord } from '@app/billing/port';
import { createHarness, type BillingHarness } from './harness';

/**
 * A genuine owner approval, granted over the same canonical payload the refund path will
 * rebuild and hash. Uses A07's real `grantOwnerApproval` — a hand-made object with a
 * plausible-looking hash would prove nothing.
 */
async function approvalFor(
  harness: BillingHarness,
  refund: RefundRecord,
  options: {
    readonly rule?: RefundPolicyRule;
    readonly amountMinorOverride?: number;
    readonly id?: string;
  } = {},
): Promise<OwnerApproval> {
  const rule = options.rule ?? 'unused_period_within_14_days';
  const payload = refundApprovalPayload(
    options.amountMinorOverride === undefined
      ? refund
      : { ...refund, amountMinor: options.amountMinorOverride },
    rule,
  );
  const maximum =
    payload.action_type === 'refund_issue' ? payload.payload.amount_minor : refund.amountMinor;
  return grantOwnerApproval(payload, {
    id: options.id ?? 'apr_0001',
    owner_id: 'usr_owner',
    maximum_amount_minor: maximum,
    currency: 'GBP',
    summary: 'Refund approved in test',
    created_at: harness.at(),
    expires_at: new Date(Date.parse(harness.at()) + 3_600_000).toISOString(),
  });
}

const WS = 'ws_customer_1';
const OTHER_WS = 'ws_someone_else';

async function seedOrder(harness: BillingHarness, workspaceId = WS, orderId = 'ord_0001') {
  return harness.data.openOrderOnce({
    id: orderId,
    workspaceId,
    status: 'active',
    rejectionReason: null,
    priceId: harness.config.priceId,
    amountMinor: 2900,
    currency: 'GBP',
    checkoutSessionId: 'cs_stub_1',
    idempotencyKey: `checkout:v1:${workspaceId}`,
    createdAt: harness.at(),
    updatedAt: harness.at(),
  });
}

describe('requesting a refund', () => {
  it('BILL-133 every refund request is queued for the owner, never refunded automatically', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    const result = await requestRefund(harness, {
      workspaceId: WS,
      orderId: 'ord_0001',
      amountMinor: 2900,
      currency: 'GBP',
      reason: 'Did not use the service',
    });
    expect(result.created).toBe(true);
    expect(result.refund.state).toBe('queued_for_owner');
    // Nothing was sent to Stripe by asking.
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-134 the same request twice returns the original refund, not a second one', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    const params = {
      workspaceId: WS,
      orderId: 'ord_0001',
      amountMinor: 2900,
      currency: 'GBP',
    } as const;
    const first = await requestRefund(harness, params);
    harness.tick(120);
    const second = await requestRefund(harness, params);

    expect(second.created).toBe(false);
    expect(second.refund.id).toBe(first.refund.id);
    expect(second.refund.idempotencyKey).toBe(first.refund.idempotencyKey);
    expect(harness.data.debug.refunds()).toHaveLength(1);
  });

  it('BILL-135 a genuinely separate second request needs an explicit request key', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    const base = {
      workspaceId: WS,
      orderId: 'ord_0001',
      amountMinor: 1000,
      currency: 'GBP',
    } as const;
    await requestRefund(harness, base);
    const second = await requestRefund(harness, { ...base, requestKey: 'second-claim' });
    expect(second.created).toBe(true);
    expect(harness.data.debug.refunds()).toHaveLength(2);
    expect(refundIdempotencyKey(base)).not.toBe(
      refundIdempotencyKey({ ...base, requestKey: 'second-claim' }),
    );
  });

  it('BILL-136 a refund larger than the order is refused', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    await expect(
      requestRefund(harness, {
        workspaceId: WS,
        orderId: 'ord_0001',
        amountMinor: 999_999,
        currency: 'GBP',
      }),
    ).rejects.toThrow(/cannot exceed/);
  });

  it('BILL-137 a refund against another workspace’s order is refused', async () => {
    const harness = createHarness();
    await seedOrder(harness, OTHER_WS, 'ord_other');
    await expect(
      requestRefund(harness, {
        workspaceId: WS,
        orderId: 'ord_other',
        amountMinor: 2900,
        currency: 'GBP',
      }),
    ).rejects.toThrow(/does not belong to this workspace/);
  });

  it('BILL-138 a zero or fractional refund amount is refused before anything is written', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    await expect(
      requestRefund(harness, { workspaceId: WS, orderId: 'ord_0001', amountMinor: 0, currency: 'GBP' }),
    ).rejects.toThrow(/positive integer/);
    expect(harness.data.debug.refunds()).toHaveLength(0);
  });
});

describe('the owner decides', () => {
  async function queued(harness: BillingHarness) {
    await seedOrder(harness);
    const result = await requestRefund(harness, {
      workspaceId: WS,
      orderId: 'ord_0001',
      amountMinor: 2900,
      currency: 'GBP',
    });
    return result.refund;
  }

  it('BILL-139 approving without a recorded approval is refused', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/recorded owner approval/);
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-140 an approved refund is submitted with the row’s own idempotency key', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    const result = await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'approve',
      approval: await approvalFor(harness, refund),
      policyRule: 'unused_period_within_14_days',
      chargeId: 'ch_1',
      providerReason: 'requested_by_customer',
    });
    expect(result.state).toBe('succeeded');
    expect(result.approvalId).toBe('apr_0001');
    const call = harness.gateway.calls.find((entry) => entry.method === 'createRefund');
    expect(call?.params).toMatchObject({
      idempotencyKey: refund.idempotencyKey,
      amountMinor: 2900,
    });
  });

  it('BILL-141 approving a refund that already succeeded is refused, not repeated', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'approve',
      approval: await approvalFor(harness, refund),
      policyRule: 'unused_period_within_14_days',
      chargeId: 'ch_1',
    });
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval: await approvalFor(harness, refund, { id: 'apr_0002' }),
        policyRule: 'unused_period_within_14_days',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/cannot be approved/);
    expect(harness.gateway.calls.filter((call) => call.method === 'createRefund')).toHaveLength(1);
  });

  it('BILL-142 a transport failure leaves the refund submitted and a retry reuses the same key', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    harness.gateway.failNext('createRefund', new Error('socket hang up'));

    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval: await approvalFor(harness, refund),
        policyRule: 'unused_period_within_14_days',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/socket hang up/);
    expect((await harness.data.findRefund(WS, refund.id))?.state).toBe('submitted');

    const retried = await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'approve',
      approval: await approvalFor(harness, refund),
      policyRule: 'unused_period_within_14_days',
      chargeId: 'ch_1',
    });
    expect(retried.state).toBe('succeeded');
    const keys = harness.gateway.calls
      .filter((call) => call.method === 'createRefund')
      .map((call) => (call.params as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('BILL-143 declining records a rejection and sends nothing to Stripe', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    const result = await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'reject',
      approval: await approvalFor(harness, refund, { id: 'apr_0003' }),
    });
    expect(result.state).toBe('rejected');
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-144 a refund needs exactly one of a charge or a payment intent to act against', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval: await approvalFor(harness, refund),
        policyRule: 'unused_period_within_14_days',
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('BILL-145 the owner queue holds exactly the refunds awaiting a decision', async () => {
    const harness = createHarness();
    const refund = await queued(harness);
    expect(await harness.data.listRefundsAwaitingOwner(10)).toHaveLength(1);
    await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'reject',
      approval: await approvalFor(harness, refund, { id: 'apr_0003' }),
    });
    expect(await harness.data.listRefundsAwaitingOwner(10)).toHaveLength(0);
  });
});

describe('what the customer is told', () => {
  it('BILL-146 only a succeeded refund is ever rendered as "Refunded"', () => {
    expect(customerVisibleRefundState('succeeded')).toBe('Refunded');
    for (const state of ['requested', 'queued_for_owner', 'submitted', 'pending', 'failed', 'rejected'] as const) {
      expect(customerVisibleRefundState(state)).not.toBe('Refunded');
      expect(customerVisibleRefundState(state).toLowerCase()).not.toMatch(/^refunded$/);
    }
  });

  it('BILL-147 a clicked button produces "under review", not "refunded"', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    const result = await requestRefund(harness, {
      workspaceId: WS,
      orderId: 'ord_0001',
      amountMinor: 2900,
      currency: 'GBP',
    });
    expect(result.customerMessage).toBe('Refund requested — under review');
  });

  it('BILL-148 the state machine refuses every move that would skip the owner', () => {
    expect(refundTransition('requested', { kind: 'owner_approved' }).allowed).toBe(false);
    expect(refundTransition('queued_for_owner', { kind: 'provider_succeeded' }).allowed).toBe(false);
    expect(refundTransition('rejected', { kind: 'owner_approved' }).allowed).toBe(false);
    expect(refundTransition('succeeded', { kind: 'provider_failed' }).allowed).toBe(false);
  });

  it('BILL-149 the recommendation is advisory and changes no state by itself', async () => {
    const harness = createHarness();
    await seedOrder(harness);
    const advice = recommendRefund({
      runsConsumedInPeriod: 0,
      daysSincePayment: 3,
      serviceOutageMinutes: 0,
    });
    expect(advice.recommendation).toBe('recommend_refund');
    // Asking for advice wrote nothing and sent nothing.
    expect(harness.data.debug.refunds()).toHaveLength(0);
    expect(harness.gateway.calls).toHaveLength(0);

    expect(
      recommendRefund({ runsConsumedInPeriod: 400, daysSincePayment: 45, serviceOutageMinutes: 0 })
        .recommendation,
    ).toBe('recommend_decline');
    expect(
      recommendRefund({ runsConsumedInPeriod: 10, daysSincePayment: 5, serviceOutageMinutes: 0 })
        .recommendation,
    ).toBe('no_recommendation');
  });
});

describe('the approval is bound to the exact payload', () => {
  async function queuedRefund(harness: BillingHarness, amountMinor = 2900) {
    await seedOrder(harness);
    const result = await requestRefund(harness, {
      workspaceId: WS,
      orderId: 'ord_0001',
      amountMinor,
      currency: 'GBP',
      reason: 'Did not use the service',
    });
    return result.refund;
  }

  it('BILL-211 a refund appears in the owner queue with what an approval must cover', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const queue = await listRefundQueue(harness);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      maximumAmountMinor: refund.amountMinor,
      currency: 'GBP',
    });
    expect(queue[0]?.summary).toContain('£29.00');
    expect(queue[0]?.refund.state).toBe('queued_for_owner');
  });

  it('BILL-212 an approval granted for this exact refund authorises it', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const result = await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'approve',
      approval: await approvalFor(harness, refund),
      policyRule: 'unused_period_within_14_days',
      chargeId: 'ch_1',
    });
    expect(result.state).toBe('succeeded');
    expect(result.approvalId).toBe('apr_0001');
  });

  it('BILL-213 an approval for an amount one penny different authorises nothing', async () => {
    // THE case. The owner read and approved £28.99; the refund on file is £29.00. The
    // payload is rebuilt from our stored row, so the hashes differ and the approval is
    // refused — there is no argument a caller could pass to paper over the difference.
    const harness = createHarness();
    const refund = await queuedRefund(harness, 2900);
    const approval = await approvalFor(harness, refund, { amountMinorOverride: 2899 });

    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval,
        policyRule: 'unused_period_within_14_days',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/does not authorise this refund/);

    expect((await harness.data.findRefund(WS, refund.id))?.state).toBe('queued_for_owner');
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-214 an approval citing a different policy rule authorises nothing', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const approval = await approvalFor(harness, refund, { rule: 'goodwill_owner_discretion' });
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval,
        policyRule: 'duplicate_charge',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/does not authorise this refund/);
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-215 an approval granted for another workspace’s refund authorises nothing', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const foreign = await approvalFor(
      harness,
      { ...refund, workspaceId: 'ws_someone_else' },
      {},
    );
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval: foreign,
        policyRule: 'unused_period_within_14_days',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/does not authorise this refund/);
  });

  it('BILL-216 an expired approval authorises nothing', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const approval = await approvalFor(harness, refund);
    harness.tick(2 * 3_600);
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval,
        policyRule: 'unused_period_within_14_days',
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/does not authorise this refund/);
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-217 an approval that is no longer granted authorises nothing', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const granted = await approvalFor(harness, refund);
    for (const status of ['consumed', 'expired', 'revoked'] as const) {
      await expect(
        decideRefund(harness, {
          workspaceId: WS,
          refundId: refund.id,
          decision: 'approve',
          approval: { ...granted, status },
          policyRule: 'unused_period_within_14_days',
          chargeId: 'ch_1',
        }),
      ).rejects.toThrow(/does not authorise this refund/);
    }
    expect(harness.gateway.calls).toHaveLength(0);
  });

  it('BILL-218 approving requires a named published policy rule', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    await expect(
      decideRefund(harness, {
        workspaceId: WS,
        refundId: refund.id,
        decision: 'approve',
        approval: await approvalFor(harness, refund),
        chargeId: 'ch_1',
      }),
    ).rejects.toThrow(/published refund rule/);
  });

  it('BILL-219 declining needs no approval and still sends nothing to Stripe', async () => {
    const harness = createHarness();
    const refund = await queuedRefund(harness);
    const result = await decideRefund(harness, {
      workspaceId: WS,
      refundId: refund.id,
      decision: 'reject',
    });
    expect(result.state).toBe('rejected');
    expect(harness.gateway.calls).toHaveLength(0);
  });
});
