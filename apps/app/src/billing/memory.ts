/**
 * An in-memory `BillingDataPort`.
 *
 * Purpose: the billing integration tests must run today, while A02's commerce
 * repositories are still being written. It is not a fake that agrees with whatever the
 * test wants — it enforces the same constraints the schema does, because those
 * constraints *are* the idempotency design:
 *
 *  - `UNIQUE (workspace_id)` on `billing_customers`
 *  - `UNIQUE (orders.idempotency_key)`
 *  - `UNIQUE (subscriptions.provider_subscription_id, environment)`
 *  - `UNIQUE (entitlements.workspace_id, billing_period)`
 *  - `UNIQUE (refunds.idempotency_key)`
 *  - `UNIQUE (webhook_receipts.provider, event_id)`
 *
 * `reserveRun`, `settleReservedRun` and `releaseReservedRun` are written as single
 * check-and-write steps with no `await` between the read and the write, which is the
 * in-memory equivalent of the one conditional statement the real implementation must use.
 *
 * Not for production. Never imported by `index.ts`.
 */
import type { BillingEnvironment } from './config';
import { isAllowancePeriodKey } from './period';
import type {
  AllowanceRecord,
  BillingCustomerRecord,
  BillingDataPort,
  OrderRecord,
  RefundRecord,
  SubscriptionRecord,
  WebhookAdmission,
  WebhookProcessingStatus,
} from './port';

interface ReceiptRow {
  readonly receiptId: string;
  readonly provider: string;
  readonly eventId: string;
  readonly payloadHash: string;
  readonly receivedAt: string;
  workspaceId: string | null;
  status: WebhookProcessingStatus;
}

export interface MemoryBillingStore extends BillingDataPort {
  /** Test-only introspection. Never part of `BillingDataPort`. */
  readonly debug: {
    orders(): readonly OrderRecord[];
    subscriptions(): readonly SubscriptionRecord[];
    allowances(): readonly AllowanceRecord[];
    refunds(): readonly RefundRecord[];
    receipts(): readonly ReceiptRow[];
    customers(): readonly BillingCustomerRecord[];
  };
}

export function createMemoryBillingStore(): MemoryBillingStore {
  const customers = new Map<string, BillingCustomerRecord>(); // workspaceId|env
  const orders = new Map<string, OrderRecord>(); // order id
  const orderKeys = new Map<string, string>(); // idempotency key -> order id
  const subscriptions = new Map<string, SubscriptionRecord>(); // providerId|env
  const allowances = new Map<string, AllowanceRecord>(); // workspaceId|period
  const refunds = new Map<string, RefundRecord>(); // refund id
  const refundKeys = new Map<string, string>(); // idempotency key -> refund id
  const receipts = new Map<string, ReceiptRow>(); // provider|eventId

  const customerKey = (workspaceId: string, environment: BillingEnvironment): string =>
    `${workspaceId}|${environment}`;
  const subscriptionKey = (providerId: string, environment: BillingEnvironment): string =>
    `${providerId}|${environment}`;
  /**
   * Every allowance lookup goes through here, and a key that is not an allowance period key
   * is refused loudly.
   *
   * A13-010 was two spellings of this key — `YYYY-MM-DD` on one side, `YYYY-MM` on the
   * other — silently failing to match, so `settleReservation` returned false forever and a
   * workspace at its limit reported itself clear. A mismatch must be a crash in a test, not
   * a `false` in production. A02 should add the same guard to the D1 implementation.
   */
  const allowanceKey = (workspaceId: string, period: string): string => {
    if (!isAllowancePeriodKey(period)) {
      throw new TypeError(
        `allowance period key must be YYYY-MM-DD (the date the paid period ends), received: ${period}. ` +
          'Derive it with allowancePeriodKey() or allowancePeriodKeyAt() — never by slicing a date.',
      );
    }
    return `${workspaceId}|${period}`;
  };
  const receiptKey = (provider: string, eventId: string): string => `${provider}|${eventId}`;

  return {
    debug: {
      orders: () => [...orders.values()],
      subscriptions: () => [...subscriptions.values()],
      allowances: () => [...allowances.values()],
      refunds: () => [...refunds.values()],
      receipts: () => [...receipts.values()],
      customers: () => [...customers.values()],
    },

    // -- billing customer ---------------------------------------------------

    async findBillingCustomer(workspaceId, environment) {
      return customers.get(customerKey(workspaceId, environment)) ?? null;
    },

    async rememberBillingCustomer(record) {
      const key = customerKey(record.workspaceId, record.environment);
      const existing = customers.get(key);
      if (existing !== undefined) return { created: false, customer: existing };
      customers.set(key, record);
      return { created: true, customer: record };
    },

    async findWorkspaceForBillingCustomer(stripeCustomerId, environment) {
      for (const record of customers.values()) {
        if (record.stripeCustomerId === stripeCustomerId && record.environment === environment) {
          return record;
        }
      }
      return null;
    },

    // -- orders -------------------------------------------------------------

    async openOrderOnce(record) {
      if (record.idempotencyKey !== null) {
        const existingId = orderKeys.get(record.idempotencyKey);
        if (existingId !== undefined) {
          const existing = orders.get(existingId);
          if (existing !== undefined) return { created: false, order: existing };
        }
        orderKeys.set(record.idempotencyKey, record.id);
      }
      orders.set(record.id, record);
      return { created: true, order: record };
    },

    async findOrder(workspaceId, orderId) {
      const order = orders.get(orderId);
      return order !== undefined && order.workspaceId === workspaceId ? order : null;
    },

    async findOrderByCheckoutSession(checkoutSessionId) {
      for (const order of orders.values()) {
        if (order.checkoutSessionId === checkoutSessionId) return order;
      }
      return null;
    },

    async listOrdersForWorkspace(workspaceId, limit) {
      return [...orders.values()]
        .filter((order) => order.workspaceId === workspaceId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, Math.max(1, limit));
    },

    async recordOrderStatus(params) {
      const order = orders.get(params.orderId);
      if (order === undefined || order.workspaceId !== params.workspaceId) return null;
      const next: OrderRecord = {
        ...order,
        status: params.status,
        rejectionReason:
          params.rejectionReason === undefined ? order.rejectionReason : params.rejectionReason,
        checkoutSessionId:
          params.checkoutSessionId === undefined
            ? order.checkoutSessionId
            : params.checkoutSessionId,
        updatedAt: params.at,
      };
      orders.set(order.id, next);
      return next;
    },

    // -- subscriptions ------------------------------------------------------

    async findSubscriptionForWorkspace(workspaceId, environment) {
      let newest: SubscriptionRecord | null = null;
      for (const record of subscriptions.values()) {
        if (record.workspaceId !== workspaceId || record.environment !== environment) continue;
        if (newest === null || record.updatedAt > newest.updatedAt) newest = record;
      }
      return newest;
    },

    async recordPaymentTarget(params) {
      for (const [key, row] of subscriptions) {
        if (
          row.workspaceId === params.workspaceId &&
          row.providerSubscriptionId === params.providerSubscriptionId &&
          row.environment === params.environment
        ) {
          subscriptions.set(key, {
            ...row,
            latestPaymentIntentId: params.paymentIntentId,
            latestPaymentPeriodEnd: params.periodEnd,
          });
        }
      }
    },

    async findSubscriptionByProviderId(providerSubscriptionId, environment) {
      return subscriptions.get(subscriptionKey(providerSubscriptionId, environment)) ?? null;
    },

    async saveSubscriptionSnapshot(record) {
      subscriptions.set(subscriptionKey(record.providerSubscriptionId, record.environment), record);
      return record;
    },

    async listSubscriptionsForReconciliation(environment, limit) {
      return [...subscriptions.values()]
        .filter((record) => record.environment === environment)
        .slice(0, Math.max(1, limit));
    },

    async markSubscriptionReconciled(subscriptionId, at) {
      for (const [key, record] of subscriptions) {
        if (record.id === subscriptionId) {
          subscriptions.set(key, { ...record, reconciledAt: at });
          return;
        }
      }
    },

    // -- allowance ----------------------------------------------------------

    async findAllowance(workspaceId, billingPeriod) {
      return allowances.get(allowanceKey(workspaceId, billingPeriod)) ?? null;
    },

    async openAllowancePeriod(record) {
      const key = allowanceKey(record.workspaceId, record.billingPeriod);
      const existing = allowances.get(key);
      if (existing !== undefined) {
        // Refresh terms, never the counters. Mirrors A02's ON CONFLICT DO UPDATE.
        const refreshed: AllowanceRecord = {
          ...existing,
          runLimit: record.runLimit,
          planVersion: record.planVersion,
          updatedAt: record.updatedAt,
        };
        allowances.set(key, refreshed);
        return refreshed;
      }
      allowances.set(key, record);
      return record;
    },

    async reserveRun(workspaceId, billingPeriod, at) {
      const key = allowanceKey(workspaceId, billingPeriod);
      const row = allowances.get(key);
      if (row === undefined) return false;
      if (row.runLimit - row.consumed - row.reserved < 1) return false;
      allowances.set(key, { ...row, reserved: row.reserved + 1, updatedAt: at });
      return true;
    },

    async settleReservedRun(workspaceId, billingPeriod, at) {
      const key = allowanceKey(workspaceId, billingPeriod);
      const row = allowances.get(key);
      if (row === undefined || row.reserved < 1) return false;
      allowances.set(key, {
        ...row,
        reserved: row.reserved - 1,
        consumed: row.consumed + 1,
        updatedAt: at,
      });
      return true;
    },

    async releaseReservedRun(workspaceId, billingPeriod, at) {
      const key = allowanceKey(workspaceId, billingPeriod);
      const row = allowances.get(key);
      if (row === undefined || row.reserved < 1) return false;
      allowances.set(key, { ...row, reserved: row.reserved - 1, updatedAt: at });
      return true;
    },

    // -- refunds ------------------------------------------------------------

    async openRefundOnce(record) {
      const existingId = refundKeys.get(record.idempotencyKey);
      if (existingId !== undefined) {
        const existing = refunds.get(existingId);
        if (existing !== undefined) return { created: false, refund: existing };
      }
      refundKeys.set(record.idempotencyKey, record.id);
      refunds.set(record.id, record);
      return { created: true, refund: record };
    },

    async findRefund(workspaceId, refundId) {
      const refund = refunds.get(refundId);
      return refund !== undefined && refund.workspaceId === workspaceId ? refund : null;
    },

    async findRefundByIdempotencyKey(workspaceId, idempotencyKey) {
      const id = refundKeys.get(idempotencyKey);
      if (id === undefined) return null;
      const refund = refunds.get(id);
      // Scoped, like the real implementation's WHERE clause.
      return refund !== undefined && refund.workspaceId === workspaceId ? refund : null;
    },

    async findRefundByProviderId(providerRefundId) {
      for (const refund of refunds.values()) {
        if (refund.providerRefundId === providerRefundId) return refund;
      }
      return null;
    },

    async recordRefundState(params) {
      const refund = refunds.get(params.refundId);
      if (refund === undefined || refund.workspaceId !== params.workspaceId) return null;
      const next: RefundRecord = {
        ...refund,
        state: params.state,
        providerRefundId:
          params.providerRefundId === undefined ? refund.providerRefundId : params.providerRefundId,
        approvalId: params.approvalId === undefined ? refund.approvalId : params.approvalId,
        updatedAt: params.at,
      };
      refunds.set(refund.id, next);
      return next;
    },

    async listRefundsAwaitingOwner(limit) {
      return [...refunds.values()]
        .filter((refund) => refund.state === 'queued_for_owner')
        .slice(0, Math.max(1, limit));
    },

    // -- webhook receipts ---------------------------------------------------

    async beginWebhookProcessing(params): Promise<WebhookAdmission> {
      const key = receiptKey(params.provider, params.eventId);
      const existing = receipts.get(key);
      if (existing !== undefined) {
        return existing.status === 'received'
          ? { outcome: 'in_flight', receiptId: existing.receiptId }
          : { outcome: 'already_processed', receiptId: existing.receiptId };
      }
      receipts.set(key, {
        receiptId: params.receiptId,
        provider: params.provider,
        eventId: params.eventId,
        payloadHash: params.payloadHash,
        receivedAt: params.receivedAt,
        workspaceId: params.workspaceId ?? null,
        status: 'received',
      });
      return { outcome: 'fresh', receiptId: params.receiptId };
    },

    async completeWebhookProcessing(receiptId, status, workspaceId) {
      for (const row of receipts.values()) {
        if (row.receiptId === receiptId) {
          row.status = status;
          if (workspaceId !== undefined) row.workspaceId = workspaceId;
          return;
        }
      }
    },

    async abandonWebhookProcessing(eventId) {
      for (const [key, row] of receipts) {
        if (row.eventId === eventId) {
          receipts.delete(key);
          return;
        }
      }
    },
  };
}
