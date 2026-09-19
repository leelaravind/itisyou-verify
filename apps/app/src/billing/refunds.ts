/**
 * Refunds.
 *
 * The standing policy, until the founder approves something else: **the system
 * recommends, the owner decides.** Every refund request lands in `queued_for_owner` and
 * stays there until a human with a recorded approval moves it. There is no code path in
 * this file that submits a refund without an `approvalId`.
 *
 * Seven distinct states, because collapsing any two of them is how a customer gets told
 * they were refunded when they were not:
 *
 * | State | Means |
 * | --- | --- |
 * | `requested` | We have written the request down. Nothing has been decided. |
 * | `queued_for_owner` | Waiting for the owner. This is where every request sits. |
 * | `submitted` | Sent to Stripe. We have not yet had a usable answer. |
 * | `pending` | Stripe accepted it and is still moving the money. |
 * | `succeeded` | Stripe says the money went back. Only this one may be called "refunded". |
 * | `failed` | Stripe could not do it. The customer still has a claim. |
 * | `rejected` | The owner declined, with a reason. |
 *
 * The Stripe call carries the refund's own `idempotency_key`, which is also the row's
 * unique key. A second approval of the same refund therefore reaches Stripe with the same
 * key and returns the original refund object instead of moving money twice.
 */
import { AppError } from '@verify/contracts';
import type { RefundRecord, RefundState } from './port';
import type { BillingRuntime } from './runtime';

// ---------------------------------------------------------------------------
// pure: the refund state machine
// ---------------------------------------------------------------------------

export type RefundEvent =
  | { readonly kind: 'queue_for_owner' }
  | { readonly kind: 'owner_approved' }
  | { readonly kind: 'owner_rejected' }
  | { readonly kind: 'provider_accepted' }
  | { readonly kind: 'provider_succeeded' }
  | { readonly kind: 'provider_failed' };

export type RefundTransition =
  | { readonly allowed: true; readonly next: RefundState }
  | { readonly allowed: false; readonly from: RefundState; readonly event: RefundEvent['kind'] };

/** Legal moves only. Everything else is refused rather than quietly applied. */
export function refundTransition(from: RefundState, event: RefundEvent): RefundTransition {
  const no = (): RefundTransition => ({ allowed: false, from, event: event.kind });
  switch (event.kind) {
    case 'queue_for_owner':
      return from === 'requested' ? { allowed: true, next: 'queued_for_owner' } : no();
    case 'owner_approved':
      // `submitted` is re-enterable: a retry after a transport failure uses the same
      // Stripe idempotency key and so cannot move money a second time.
      return from === 'queued_for_owner' || from === 'submitted'
        ? { allowed: true, next: 'submitted' }
        : no();
    case 'owner_rejected':
      return from === 'queued_for_owner' || from === 'requested'
        ? { allowed: true, next: 'rejected' }
        : no();
    case 'provider_accepted':
      return from === 'submitted' || from === 'pending' ? { allowed: true, next: 'pending' } : no();
    case 'provider_succeeded':
      return from === 'submitted' || from === 'pending' || from === 'succeeded'
        ? { allowed: true, next: 'succeeded' }
        : no();
    case 'provider_failed':
      return from === 'submitted' || from === 'pending' ? { allowed: true, next: 'failed' } : no();
    default: {
      const exhaustive: never = event;
      return { allowed: false, from, event: (exhaustive as RefundEvent).kind };
    }
  }
}

/**
 * What the customer is allowed to be told.
 *
 * Nothing but `succeeded` produces the word "refunded". A request that has merely been
 * submitted says so, because a button press is not money moving.
 */
export function customerVisibleRefundState(state: RefundState): string {
  switch (state) {
    case 'requested':
    case 'queued_for_owner':
      return 'Refund requested — under review';
    case 'submitted':
    case 'pending':
      return 'Refund in progress with our payment provider';
    case 'succeeded':
      return 'Refunded';
    case 'failed':
      return 'Refund could not be completed — we are looking at it';
    case 'rejected':
      return 'Refund request declined';
    default: {
      const exhaustive: never = state;
      return String(exhaustive);
    }
  }
}

/**
 * The system's recommendation. Advisory only — nothing consumes it to act.
 *
 * Deliberately conservative: it never recommends a refund it could not justify from
 * evidence we hold, and no branch of `decideRefund` reads it.
 */
export type RefundRecommendation = 'recommend_refund' | 'recommend_decline' | 'no_recommendation';

export function recommendRefund(input: {
  readonly runsConsumedInPeriod: number;
  readonly daysSincePayment: number;
  readonly serviceOutageMinutes: number;
}): { readonly recommendation: RefundRecommendation; readonly because: string } {
  if (input.runsConsumedInPeriod === 0 && input.daysSincePayment <= 14) {
    return {
      recommendation: 'recommend_refund',
      because: 'No runs were consumed in this period and the payment is recent.',
    };
  }
  if (input.serviceOutageMinutes >= 24 * 60) {
    return {
      recommendation: 'recommend_refund',
      because: 'Recorded service unavailability exceeded a day in this period.',
    };
  }
  if (input.runsConsumedInPeriod > 0 && input.daysSincePayment > 30) {
    return {
      recommendation: 'recommend_decline',
      because: 'The period was used and the payment is outside the stated window.',
    };
  }
  return { recommendation: 'no_recommendation', because: 'Needs a human look.' };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * The refund's stable key. It is both our unique row key and the `Idempotency-Key` we
 * send to Stripe, so the two can never disagree about what "the same refund" means.
 */
export function refundIdempotencyKey(params: {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly requestKey?: string;
}): string {
  const suffix = params.requestKey === undefined ? 'full' : params.requestKey;
  return `refund:${params.workspaceId}:${params.orderId}:${params.amountMinor}:${suffix}`;
}

export interface RequestRefundParams {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason?: string;
  /** Lets a customer raise a genuinely separate second request for the same amount. */
  readonly requestKey?: string;
}

export interface RequestRefundResult {
  readonly refund: RefundRecord;
  readonly created: boolean;
  readonly customerMessage: string;
}

/**
 * Record a refund request and queue it for the owner.
 *
 * Returns the original record on a repeat, so a double-clicked button, a retried API call
 * and a resubmitted form all produce one queued refund.
 */
export async function requestRefund(
  deps: BillingRuntime,
  params: RequestRefundParams,
): Promise<RequestRefundResult> {
  const { data, now, newId } = deps;
  if (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new AppError(422, 'REFUND_AMOUNT_INVALID', 'A refund amount must be a positive integer.');
  }
  const order = await data.findOrder(params.workspaceId, params.orderId);
  if (order === null) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'That order does not belong to this workspace.');
  }
  if (order.amountMinor !== null && params.amountMinor > order.amountMinor) {
    throw new AppError(
      422,
      'REFUND_AMOUNT_EXCEEDS_ORDER',
      'A refund cannot exceed what was charged.',
    );
  }

  const at = now();
  const idempotencyKey = refundIdempotencyKey(params);
  const opened = await data.openRefundOnce({
    id: newId('ref'),
    workspaceId: params.workspaceId,
    orderId: params.orderId,
    providerRefundId: null,
    amountMinor: params.amountMinor,
    currency: params.currency,
    state: 'requested',
    reason: params.reason ?? null,
    idempotencyKey,
    approvalId: null,
    createdAt: at,
    updatedAt: at,
  });

  if (!opened.created) {
    return {
      refund: opened.refund,
      created: false,
      customerMessage: customerVisibleRefundState(opened.refund.state),
    };
  }

  const transition = refundTransition(opened.refund.state, { kind: 'queue_for_owner' });
  const queued = transition.allowed
    ? ((await data.recordRefundState({
        workspaceId: params.workspaceId,
        refundId: opened.refund.id,
        state: transition.next,
        at,
      })) ?? opened.refund)
    : opened.refund;

  return {
    refund: queued,
    created: true,
    customerMessage: customerVisibleRefundState(queued.state),
  };
}

export interface OwnerDecisionParams {
  readonly workspaceId: string;
  readonly refundId: string;
  readonly decision: 'approve' | 'reject';
  /**
   * The row id of the owner's recorded approval (`approvals` table). Required to approve.
   * There is no "auto" value and no default.
   */
  readonly approvalId?: string;
  /** Stripe needs one of these to know what to refund against. */
  readonly paymentIntentId?: string;
  readonly chargeId?: string;
  readonly providerReason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

/**
 * The owner's decision. The only way a refund leaves the queue.
 *
 * Approving without an `approvalId` is refused, not defaulted — an approval that nobody
 * recorded is not an approval.
 */
export async function decideRefund(
  deps: BillingRuntime,
  params: OwnerDecisionParams,
): Promise<RefundRecord> {
  const { data, gateway, now } = deps;
  const at = now();
  const refund = await data.findRefund(params.workspaceId, params.refundId);
  if (refund === null) {
    throw new AppError(404, 'REFUND_NOT_FOUND', 'That refund does not belong to this workspace.');
  }

  if (params.decision === 'reject') {
    const transition = refundTransition(refund.state, { kind: 'owner_rejected' });
    if (!transition.allowed) {
      throw new AppError(
        409,
        'REFUND_STATE',
        `A refund in state ${refund.state} cannot be declined.`,
      );
    }
    return (
      (await data.recordRefundState({
        workspaceId: params.workspaceId,
        refundId: refund.id,
        state: transition.next,
        ...(params.approvalId === undefined ? {} : { approvalId: params.approvalId }),
        at,
      })) ?? refund
    );
  }

  if (params.approvalId === undefined || params.approvalId.length === 0) {
    throw new AppError(
      422,
      'REFUND_APPROVAL_REQUIRED',
      'A refund can only be submitted against a recorded owner approval.',
    );
  }
  if ((params.paymentIntentId === undefined) === (params.chargeId === undefined)) {
    throw new AppError(
      422,
      'REFUND_TARGET_REQUIRED',
      'A refund needs exactly one of a payment intent or a charge to refund against.',
    );
  }

  const approved = refundTransition(refund.state, { kind: 'owner_approved' });
  if (!approved.allowed) {
    throw new AppError(409, 'REFUND_STATE', `A refund in state ${refund.state} cannot be approved.`);
  }
  const submitted =
    (await data.recordRefundState({
      workspaceId: params.workspaceId,
      refundId: refund.id,
      state: approved.next,
      approvalId: params.approvalId,
      at,
    })) ?? refund;

  // The row's own key goes to Stripe. A retry after any failure below cannot double-refund.
  const result = await gateway.createRefund({
    idempotencyKey: refund.idempotencyKey,
    amountMinor: refund.amountMinor,
    ...(params.paymentIntentId === undefined ? {} : { paymentIntentId: params.paymentIntentId }),
    ...(params.chargeId === undefined ? {} : { chargeId: params.chargeId }),
    ...(params.providerReason === undefined ? {} : { reason: params.providerReason }),
    metadata: { workspace_id: params.workspaceId, refund_id: refund.id },
  });

  const event = providerRefundEvent(result.status);
  const applied = refundTransition(submitted.state, event);
  if (!applied.allowed) return submitted;
  return (
    (await data.recordRefundState({
      workspaceId: params.workspaceId,
      refundId: refund.id,
      state: applied.next,
      providerRefundId: result.id,
      at,
    })) ?? submitted
  );
}

/** Map Stripe's refund status onto our machine. Anything unknown stays `pending`. */
export function providerRefundEvent(status: string | null): RefundEvent {
  switch (status) {
    case 'succeeded':
      return { kind: 'provider_succeeded' };
    case 'failed':
    case 'canceled':
      return { kind: 'provider_failed' };
    default:
      return { kind: 'provider_accepted' };
  }
}

/**
 * Apply provider evidence arriving as a webhook (`charge.refunded`, refund updates).
 *
 * A refund we have no record of is *not* an error: the owner may have issued it straight
 * from the Stripe dashboard. It is reported so reconciliation can surface it, and nothing
 * is fabricated locally.
 */
export async function applyProviderRefund(
  deps: BillingRuntime,
  params: {
    readonly providerRefundId: string;
    /**
     * The fallback lookup, for a refund we submitted but never recorded a provider id
     * against. Workspace and key travel together so the read stays tenant-scoped.
     */
    readonly expected?: { readonly workspaceId: string; readonly idempotencyKey: string };
    readonly status: string | null;
  },
): Promise<
  | { readonly outcome: 'updated'; readonly refund: RefundRecord }
  | { readonly outcome: 'unmatched'; readonly providerRefundId: string }
  | { readonly outcome: 'no_change'; readonly refund: RefundRecord }
> {
  const { data, now } = deps;
  const byProvider = await data.findRefundByProviderId(params.providerRefundId);
  const refund =
    byProvider ??
    (params.expected === undefined
      ? null
      : await data.findRefundByIdempotencyKey(
          params.expected.workspaceId,
          params.expected.idempotencyKey,
        ));
  if (refund === null) return { outcome: 'unmatched', providerRefundId: params.providerRefundId };

  const transition = refundTransition(refund.state, providerRefundEvent(params.status));
  if (!transition.allowed || transition.next === refund.state) {
    return { outcome: 'no_change', refund };
  }
  const updated =
    (await data.recordRefundState({
      workspaceId: refund.workspaceId,
      refundId: refund.id,
      state: transition.next,
      providerRefundId: params.providerRefundId,
      at: now(),
    })) ?? refund;
  return { outcome: 'updated', refund: updated };
}
