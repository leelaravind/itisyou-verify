/**
 * `BillingDataPort` against D1.
 *
 * A thin, boring adapter over `commerce.ts`, `entitlements.ts` and `webhooks.ts`. Boring
 * is the requirement: every interesting decision lives in A06's pure modules, and every
 * atomicity guarantee lives in the repository statements. This file only maps snake_case
 * rows to camelCase records and back.
 *
 * The four contract points A06 marked load-bearing are honoured by the repositories:
 *  - `openOrderOnce` / `openRefundOnce` — `ON CONFLICT(idempotency_key) DO NOTHING` plus
 *    `meta.changes`, returning the existing row on a duplicate.
 *  - `rememberBillingCustomer` — `DO NOTHING`, never a rebind.
 *  - `saveSubscriptionSnapshot` — the upsert carries
 *    `WHERE excluded.provider_event_created >= subscriptions.provider_event_created`, so a
 *    stale provider event cannot re-enable a cancelled subscription. The method returns
 *    the row as STORED, which may be the older one; A06 must read the result rather than
 *    assume its write won.
 *  - `reserveRun` — one conditional UPDATE, success through `meta.changes`.
 */
import type { OrderStatus, SubscriptionStatus } from '@verify/contracts';
import { AppError } from '@verify/contracts';
import type { BillingEnvironment } from '../billing/config';
import { isAllowancePeriodKey } from '../billing/period';
import type {
  AllowanceRecord,
  BillingCustomerRecord,
  BillingDataPort,
  OrderRecord,
  RefundRecord,
  RefundState,
  SubscriptionRecord,
  WebhookAdmission,
  WebhookProcessingStatus,
} from '../billing/port';
import {
  billingCustomers,
  orders,
  refunds,
  subscriptions,
  type BillingCustomerRow,
  type OrderRow,
  type RefundRow,
  type SubscriptionRow,
} from './commerce';
import type { Db } from './d1';
import { entitlements, type EntitlementRow } from './entitlements';
import { webhookReceipts } from './webhooks';

const toCustomer = (row: BillingCustomerRow): BillingCustomerRecord => ({
  workspaceId: row.workspace_id,
  stripeCustomerId: row.stripe_customer_id,
  environment: row.environment,
  createdAt: row.created_at,
});

const toOrder = (row: OrderRow): OrderRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  status: row.status,
  rejectionReason: row.rejection_reason,
  priceId: row.price_id,
  amountMinor: row.amount_minor,
  currency: row.currency,
  checkoutSessionId: row.checkout_session_id,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const fromOrder = (record: OrderRecord): OrderRow => ({
  id: record.id,
  workspace_id: record.workspaceId,
  status: record.status,
  rejection_reason: record.rejectionReason,
  price_id: record.priceId,
  amount_minor: record.amountMinor,
  currency: record.currency,
  checkout_session_id: record.checkoutSessionId,
  idempotency_key: record.idempotencyKey,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
});

const toSubscription = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  providerSubscriptionId: row.provider_subscription_id,
  environment: row.environment,
  status: row.status as SubscriptionStatus,
  priceId: row.price_id,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  latestPaymentIntentId: row.latest_payment_intent_id,
  latestPaymentPeriodEnd: row.latest_payment_period_end,
  reconciledAt: row.reconciled_at,
  providerEventCreated: row.provider_event_created,
  updatedAt: row.updated_at,
});

const fromSubscription = (record: SubscriptionRecord): SubscriptionRow => ({
  id: record.id,
  workspace_id: record.workspaceId,
  provider_subscription_id: record.providerSubscriptionId,
  environment: record.environment,
  status: record.status,
  price_id: record.priceId,
  current_period_end: record.currentPeriodEnd,
  cancel_at_period_end: record.cancelAtPeriodEnd ? 1 : 0,
  latest_payment_intent_id: record.latestPaymentIntentId,
  latest_payment_period_end: record.latestPaymentPeriodEnd,
  reconciled_at: record.reconciledAt,
  provider_event_created: record.providerEventCreated,
  updated_at: record.updatedAt,
});

const toRefund = (row: RefundRow): RefundRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  orderId: row.order_id,
  providerRefundId: row.provider_refund_id,
  amountMinor: row.amount_minor,
  currency: row.currency,
  state: row.state,
  reason: row.reason,
  idempotencyKey: row.idempotency_key,
  approvalId: row.approval_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const fromRefund = (record: RefundRecord): RefundRow => ({
  id: record.id,
  workspace_id: record.workspaceId,
  order_id: record.orderId,
  provider_refund_id: record.providerRefundId,
  amount_minor: record.amountMinor,
  currency: record.currency,
  state: record.state as RefundState,
  reason: record.reason,
  idempotency_key: record.idempotencyKey,
  approval_id: record.approvalId,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
});

const toAllowance = (row: EntitlementRow): AllowanceRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  billingPeriod: row.billing_period,
  planVersion: row.plan_version,
  runLimit: row.run_limit,
  consumed: row.consumed,
  reserved: row.reserved,
  updatedAt: row.updated_at,
});

/** The provider whose receipts this port claims. Stripe is the only one in v1. */
const PROVIDER = 'stripe';

export class D1BillingDataPort implements BillingDataPort {
  constructor(private readonly db: Db) {}

  // -- billing customer -----------------------------------------------------

  async findBillingCustomer(
    workspaceId: string,
    environment: BillingEnvironment,
  ): Promise<BillingCustomerRecord | null> {
    const row = await billingCustomers.get(this.db, workspaceId, environment);
    return row === null ? null : toCustomer(row);
  }

  async rememberBillingCustomer(
    record: BillingCustomerRecord,
  ): Promise<{ created: boolean; customer: BillingCustomerRecord }> {
    const result = await billingCustomers.rememberOnce(this.db, {
      workspace_id: record.workspaceId,
      stripe_customer_id: record.stripeCustomerId,
      environment: record.environment,
      created_at: record.createdAt,
    });
    return { created: result.created, customer: toCustomer(result.customer) };
  }

  async findWorkspaceForBillingCustomer(
    stripeCustomerId: string,
    environment: BillingEnvironment,
  ): Promise<BillingCustomerRecord | null> {
    const row = await billingCustomers.findByStripeCustomer(this.db, stripeCustomerId, environment);
    return row === null ? null : toCustomer(row);
  }

  // -- orders ---------------------------------------------------------------

  async recordPaymentTarget(params: {
    workspaceId: string;
    providerSubscriptionId: string;
    environment: BillingEnvironment;
    paymentIntentId: string;
    periodEnd: string | null;
  }): Promise<void> {
    await subscriptions.recordPaymentTarget(this.db, params);
  }

  async openOrderOnce(record: OrderRecord): Promise<{ created: boolean; order: OrderRecord }> {
    const result = await orders.openOnce(this.db, fromOrder(record));
    return { created: result.created, order: toOrder(result.order) };
  }

  async findOrder(workspaceId: string, orderId: string): Promise<OrderRecord | null> {
    const row = await orders.get(this.db, workspaceId, orderId);
    return row === null ? null : toOrder(row);
  }

  async findOrderByCheckoutSession(checkoutSessionId: string): Promise<OrderRecord | null> {
    const row = await orders.findByCheckoutSession(this.db, checkoutSessionId);
    return row === null ? null : toOrder(row);
  }

  async listOrdersForWorkspace(
    workspaceId: string,
    limit: number,
  ): Promise<readonly OrderRecord[]> {
    const rows = await orders.listForWorkspace(this.db, workspaceId, limit);
    return rows.map(toOrder);
  }

  async recordOrderStatus(params: {
    workspaceId: string;
    orderId: string;
    status: OrderStatus;
    rejectionReason?: string | null;
    checkoutSessionId?: string | null;
    at: string;
  }): Promise<OrderRecord | null> {
    const row = await orders.recordStatus(this.db, {
      workspaceId: params.workspaceId,
      orderId: params.orderId,
      status: params.status,
      ...(params.rejectionReason !== undefined ? { rejectionReason: params.rejectionReason } : {}),
      ...(params.checkoutSessionId !== undefined
        ? { checkoutSessionId: params.checkoutSessionId }
        : {}),
      at: params.at,
    });
    return row === null ? null : toOrder(row);
  }

  // -- subscriptions --------------------------------------------------------

  async findSubscriptionForWorkspace(
    workspaceId: string,
    environment: BillingEnvironment,
  ): Promise<SubscriptionRecord | null> {
    const row = await subscriptions.getForWorkspace(this.db, workspaceId, environment);
    return row === null ? null : toSubscription(row);
  }

  async findSubscriptionByProviderId(
    providerSubscriptionId: string,
    environment: BillingEnvironment,
  ): Promise<SubscriptionRecord | null> {
    const row = await subscriptions.getByProviderId(this.db, providerSubscriptionId, environment);
    return row === null ? null : toSubscription(row);
  }

  /**
   * Note the return value. The monotonic guard lives in the SQL, so a stale event writes
   * nothing and this returns the row that is actually stored — not the one passed in.
   */
  async saveSubscriptionSnapshot(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    return toSubscription(await subscriptions.saveSnapshot(this.db, fromSubscription(record)));
  }

  async listSubscriptionsForReconciliation(
    environment: BillingEnvironment,
    limit: number,
  ): Promise<readonly SubscriptionRecord[]> {
    const rows = await subscriptions.listForReconciliation(this.db, environment, limit);
    return rows.map(toSubscription);
  }

  async markSubscriptionReconciled(subscriptionId: string, at: string): Promise<void> {
    await subscriptions.markReconciled(this.db, subscriptionId, at);
  }

  // -- allowance ------------------------------------------------------------

  /**
   * Refuse a key that is not an allowance period key, loudly.
   *
   * A13-010 survived several rounds of review because the mismatch was **silent**: a
   * `YYYY-MM` key simply found no row, `settleReservation` returned `false`, and nothing
   * anywhere said so. A workspace at its limit reported itself unblocked.
   *
   * So this throws rather than returning a miss. A wrong key is a programming error, and a
   * programming error should stop a test, not quietly under-bill a customer in production.
   */
  #assertPeriodKey(billingPeriod: string, method: string): void {
    if (!isAllowancePeriodKey(billingPeriod)) {
      throw new AppError(
        500,
        'ALLOWANCE_PERIOD_KEY_INVALID',
        'We could not read this workspace’s allowance.',
      );
    }
    void method;
  }

  async findAllowance(workspaceId: string, billingPeriod: string): Promise<AllowanceRecord | null> {
    this.#assertPeriodKey(billingPeriod, 'findAllowance');
    const row = await entitlements.get(this.db, workspaceId, billingPeriod);
    return row === null ? null : toAllowance(row);
  }

  async openAllowancePeriod(record: AllowanceRecord): Promise<AllowanceRecord> {
    this.#assertPeriodKey(record.billingPeriod, 'openAllowancePeriod');
    const row = await entitlements.ensurePeriod(this.db, {
      id: record.id,
      workspaceId: record.workspaceId,
      billingPeriod: record.billingPeriod,
      planVersion: record.planVersion,
      runLimit: record.runLimit,
      updatedAt: record.updatedAt,
    });
    return toAllowance(row);
  }

  async reserveRun(workspaceId: string, billingPeriod: string, at: string): Promise<boolean> {
    this.#assertPeriodKey(billingPeriod, 'reserveRun');
    return entitlements.reserve(this.db, workspaceId, billingPeriod, at);
  }

  async settleReservedRun(
    workspaceId: string,
    billingPeriod: string,
    at: string,
  ): Promise<boolean> {
    this.#assertPeriodKey(billingPeriod, 'settleReservedRun');
    return entitlements.settleReservation(this.db, workspaceId, billingPeriod, at);
  }

  async releaseReservedRun(
    workspaceId: string,
    billingPeriod: string,
    at: string,
  ): Promise<boolean> {
    this.#assertPeriodKey(billingPeriod, 'releaseReservedRun');
    return entitlements.releaseReservation(this.db, workspaceId, billingPeriod, at);
  }

  // -- refunds --------------------------------------------------------------

  async openRefundOnce(record: RefundRecord): Promise<{ created: boolean; refund: RefundRecord }> {
    const result = await refunds.openOnce(this.db, fromRefund(record));
    return { created: result.created, refund: toRefund(result.refund) };
  }

  async findRefund(workspaceId: string, refundId: string): Promise<RefundRecord | null> {
    const row = await refunds.get(this.db, workspaceId, refundId);
    return row === null ? null : toRefund(row);
  }

  async findRefundByIdempotencyKey(idempotencyKey: string): Promise<RefundRecord | null> {
    const row = await refunds.findByIdempotencyKey(this.db, idempotencyKey);
    return row === null ? null : toRefund(row);
  }

  async findRefundByProviderId(providerRefundId: string): Promise<RefundRecord | null> {
    const row = await refunds.findByProviderId(this.db, providerRefundId);
    return row === null ? null : toRefund(row);
  }

  async recordRefundState(params: {
    workspaceId: string;
    refundId: string;
    state: RefundState;
    providerRefundId?: string | null;
    approvalId?: string | null;
    at: string;
  }): Promise<RefundRecord | null> {
    const row = await refunds.recordState(this.db, {
      workspaceId: params.workspaceId,
      refundId: params.refundId,
      state: params.state,
      ...(params.providerRefundId !== undefined
        ? { providerRefundId: params.providerRefundId }
        : {}),
      ...(params.approvalId !== undefined ? { approvalId: params.approvalId } : {}),
      at: params.at,
    });
    return row === null ? null : toRefund(row);
  }

  async listRefundsAwaitingOwner(limit: number): Promise<readonly RefundRecord[]> {
    const rows = await refunds.listAwaitingOwner(this.db, limit);
    return rows.map(toRefund);
  }

  // -- webhook receipts -----------------------------------------------------

  async beginWebhookProcessing(params: {
    receiptId: string;
    provider: string;
    eventId: string;
    payloadHash: string;
    receivedAt: string;
    workspaceId?: string | null;
  }): Promise<WebhookAdmission> {
    const admission = await webhookReceipts.recordOnce(this.db, {
      id: params.receiptId,
      provider: params.provider,
      eventId: params.eventId,
      payloadHash: params.payloadHash,
      receivedAt: params.receivedAt,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
    });
    return { outcome: admission.outcome, receiptId: admission.receiptId };
  }

  async completeWebhookProcessing(
    receiptId: string,
    status: WebhookProcessingStatus,
    workspaceId?: string | null,
  ): Promise<void> {
    await webhookReceipts.setStatus(this.db, receiptId, status);
    if (workspaceId !== undefined && workspaceId !== null) {
      await webhookReceipts.attachWorkspace(this.db, receiptId, workspaceId);
    }
  }

  /**
   * Keyed on the provider event id, because the caller that needs to abandon is the one
   * holding the event id and often nothing else — the thing that threw is why.
   */
  async abandonWebhookProcessing(eventId: string): Promise<void> {
    await webhookReceipts.abandon(this.db, PROVIDER, eventId);
  }
}

/**
 * Who to tell when a payment fails.
 *
 * Supplies A06's optional `BillingRuntime.billingContact` hook. Without it no
 * payment-failure email is ever built, because billing deliberately owns no view of
 * identity — workspace names and member addresses are this layer's.
 *
 * It stays optional on their side on purpose, and this implementation keeps that spirit:
 * it returns `null` rather than throwing when there is no admin to write to. A workspace
 * with no reachable contact must still be suspended correctly; failing here would make a
 * missing address stop a subscription transition, which is exactly backwards.
 *
 * The oldest workspace_admin is chosen — the person who created the workspace — because
 * "whichever member the query happened to return first" is not a rule anyone could
 * predict or explain to a customer.
 */
export function createBillingContactLookup(
  db: Db,
): (workspaceId: string) => Promise<{ email: string; workspaceName: string } | null> {
  return async (workspaceId: string) => {
    const row = await db
      .prepare(
        `SELECT u.auth_subject AS email, w.name AS workspace_name
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.workspace_id = ?
            AND m.role = 'workspace_admin'
            AND u.disabled_at IS NULL
          ORDER BY m.created_at ASC, m.user_id ASC
          LIMIT 1`,
      )
      .bind(workspaceId)
      .first<{ email: string; workspace_name: string }>();
    if (row === null) return null;
    return { email: row.email, workspaceName: row.workspace_name };
  };
}
