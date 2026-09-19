/**
 * `BillingDataPort` — the exact set of reads and writes the money paths need.
 *
 * A02 owns `apps/app/src/db/` and is still writing the commerce repositories, so the
 * billing subsystem codes against this interface instead of against SQL. The lead wires
 * A02's repositories to it; `memory.ts` in this directory is a faithful in-memory
 * implementation so the integration tests run today.
 *
 * Method names describe the *business* act, not the statement. `reserveRun` is not
 * "update entitlements set reserved = reserved + 1" — it is "take one unit of this
 * workspace's allowance, or tell me there wasn't one". That distinction is what lets the
 * implementation stay a single conditional statement.
 *
 * Contract every implementation must keep:
 *
 *  1. **Tenant scope.** Every customer-scoped method takes `workspaceId` and includes it
 *     in the `WHERE` clause. There is no "by id" without a workspace.
 *  2. **Conditional writes report through `changes`, never a re-read.** `reserveRun`,
 *     `settleReservedRun` and `releaseReservedRun` must each be one statement whose
 *     `WHERE` carries the condition, so two concurrent callers cannot both succeed.
 *  3. **Insert-once methods return whether they inserted.** `openOrderOnce`,
 *     `openRefundOnce`, `rememberBillingCustomer` and `beginWebhookProcessing` are
 *     `INSERT … ON CONFLICT DO NOTHING` plus `changes`, and a duplicate returns the
 *     existing row rather than a second effect.
 *  4. **No method here decides anything.** Deciding lives in `state.ts` and
 *     `entitlements.ts`, which are pure. The port only persists what was decided.
 */
import type { OrderStatus, SubscriptionStatus } from '@verify/contracts';
import type { BillingEnvironment } from './config';

export type RefundState =
  'requested' | 'queued_for_owner' | 'submitted' | 'pending' | 'succeeded' | 'failed' | 'rejected';

export interface BillingCustomerRecord {
  readonly workspaceId: string;
  readonly stripeCustomerId: string;
  readonly environment: BillingEnvironment;
  readonly createdAt: string;
}

export interface OrderRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: OrderStatus;
  readonly rejectionReason: string | null;
  readonly priceId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly checkoutSessionId: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerSubscriptionId: string;
  readonly environment: BillingEnvironment;
  readonly status: SubscriptionStatus;
  readonly priceId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly reconciledAt: string | null;
  /**
   * The payment a refund would be issued against, and the period it covered.
   *
   * Stripe refunds a specific payment, never "a subscription", so `decideRefund` requires
   * one of these. We learn it from `invoice.paid` and it is overwritten each period, so it
   * names the MOST RECENT paid period only. `issueRefund` compares the period before using
   * it rather than refunding whatever happens to be latest.
   */
  readonly latestPaymentIntentId: string | null;
  readonly latestPaymentPeriodEnd: string | null;
  /**
   * Unix seconds of the provider event that last wrote this row. The monotonic guard: an
   * event with a smaller value may never overwrite the row. Column exists in
   * `migrations/0001_init.sql`.
   */
  readonly providerEventCreated: number;
  readonly updatedAt: string;
}

export interface AllowanceRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly billingPeriod: string;
  readonly planVersion: number;
  readonly runLimit: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly updatedAt: string;
}

export interface RefundRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly orderId: string | null;
  readonly providerRefundId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: RefundState;
  readonly reason: string | null;
  readonly idempotencyKey: string;
  readonly approvalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Whether this provider event may be processed now.
 *
 * `fresh` — first sight, go ahead.
 * `in_flight` — another delivery of the same event is mid-processing. Acknowledge 200 and
 *   do nothing; doing the work twice is worse than doing it once.
 * `already_processed` — a completed receipt exists. Acknowledge 200, no second effect.
 */
export type WebhookAdmission =
  | { readonly outcome: 'fresh'; readonly receiptId: string }
  | { readonly outcome: 'in_flight'; readonly receiptId: string }
  | { readonly outcome: 'already_processed'; readonly receiptId: string };

export type WebhookProcessingStatus =
  'received' | 'processed' | 'ignored' | 'invalid' | 'duplicate';

export interface BillingDataPort {
  // -- billing customer -----------------------------------------------------

  /** The Stripe customer this workspace is bound to, if any. */
  findBillingCustomer(
    workspaceId: string,
    environment: BillingEnvironment,
  ): Promise<BillingCustomerRecord | null>;

  /**
   * Bind a workspace to a Stripe customer, once. A second call for the same workspace
   * returns the binding that already exists — it must never rebind, because the second
   * customer would be an orphan holding a card.
   */
  rememberBillingCustomer(record: BillingCustomerRecord): Promise<{
    readonly created: boolean;
    readonly customer: BillingCustomerRecord;
  }>;

  /** Reverse lookup used by webhooks, which arrive carrying a Stripe customer id. */
  findWorkspaceForBillingCustomer(
    stripeCustomerId: string,
    environment: BillingEnvironment,
  ): Promise<BillingCustomerRecord | null>;

  // -- orders ---------------------------------------------------------------

  /**
   * Open an order, once, under a deterministic idempotency key. Two concurrent checkout
   * attempts for one workspace present the same key and exactly one of them inserts.
   */
  openOrderOnce(record: OrderRecord): Promise<{
    readonly created: boolean;
    readonly order: OrderRecord;
  }>;

  findOrder(workspaceId: string, orderId: string): Promise<OrderRecord | null>;

  findOrderByCheckoutSession(checkoutSessionId: string): Promise<OrderRecord | null>;

  /** The most recent order for a workspace, newest first. */
  listOrdersForWorkspace(workspaceId: string, limit: number): Promise<readonly OrderRecord[]>;

  /** Persist a transition `state.ts` already decided was legal. */
  recordOrderStatus(params: {
    readonly workspaceId: string;
    readonly orderId: string;
    readonly status: OrderStatus;
    readonly rejectionReason?: string | null;
    readonly checkoutSessionId?: string | null;
    readonly at: string;
  }): Promise<OrderRecord | null>;

  // -- subscriptions --------------------------------------------------------

  findSubscriptionForWorkspace(
    workspaceId: string,
    environment: BillingEnvironment,
  ): Promise<SubscriptionRecord | null>;

  /** Record the payment that just succeeded, so a refund has something to aim at. */
  recordPaymentTarget(params: {
    readonly workspaceId: string;
    readonly providerSubscriptionId: string;
    readonly environment: BillingEnvironment;
    readonly paymentIntentId: string;
    readonly periodEnd: string | null;
  }): Promise<void>;

  findSubscriptionByProviderId(
    providerSubscriptionId: string,
    environment: BillingEnvironment,
  ): Promise<SubscriptionRecord | null>;

  /**
   * Write the snapshot `reconcileSubscription()` produced. Insert or replace; the caller
   * has already applied the monotonic guard, so this is a straight write.
   */
  saveSubscriptionSnapshot(record: SubscriptionRecord): Promise<SubscriptionRecord>;

  /** Cross-tenant, owner-facing: the rows the scheduled reconciliation walks. */
  listSubscriptionsForReconciliation(
    environment: BillingEnvironment,
    limit: number,
  ): Promise<readonly SubscriptionRecord[]>;

  markSubscriptionReconciled(subscriptionId: string, at: string): Promise<void>;

  // -- allowance ------------------------------------------------------------

  findAllowance(workspaceId: string, billingPeriod: string): Promise<AllowanceRecord | null>;

  /**
   * Make sure this workspace has an allowance row for this billing period. Idempotent: a
   * second call refreshes the limit and plan version and never the counters.
   */
  openAllowancePeriod(record: AllowanceRecord): Promise<AllowanceRecord>;

  /**
   * Take one unit of allowance, atomically. Returns false when there is none left —
   * which is the "at allowance" signal, not an error.
   *
   * MUST be one conditional statement:
   *   UPDATE entitlements SET reserved = reserved + 1, updated_at = ?
   *    WHERE workspace_id = ? AND billing_period = ? AND (run_limit - consumed - reserved) >= 1
   */
  reserveRun(workspaceId: string, billingPeriod: string, at: string): Promise<boolean>;

  /** A run reached a terminal state: the reservation becomes a consumption. */
  settleReservedRun(workspaceId: string, billingPeriod: string, at: string): Promise<boolean>;

  /** A run will never execute: hand the unit back. See `docs/billing.md` for which cases. */
  releaseReservedRun(workspaceId: string, billingPeriod: string, at: string): Promise<boolean>;

  // -- refunds --------------------------------------------------------------

  /**
   * Record a refund request, once, under its idempotency key. The same key twice returns
   * the original refund — never a second one.
   */
  openRefundOnce(record: RefundRecord): Promise<{
    readonly created: boolean;
    readonly refund: RefundRecord;
  }>;

  findRefund(workspaceId: string, refundId: string): Promise<RefundRecord | null>;

  /**
   * Our own refund key, scoped.
   *
   * The key already embeds the workspace (`refund:<workspaceId>:<orderId>:<amount>:…`),
   * so a cross-tenant collision cannot be constructed — but a key-only signature gives the
   * implementation nothing to put in a `WHERE` clause, which left it needing a
   * tenant-scope exemption it did not deserve. Taking the workspace explicitly removes the
   * exemption: an exemption that exists only because of a function signature is worth
   * deleting. (A02's observation, 2026-09-19.)
   */
  findRefundByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<RefundRecord | null>;

  findRefundByProviderId(providerRefundId: string): Promise<RefundRecord | null>;

  recordRefundState(params: {
    readonly workspaceId: string;
    readonly refundId: string;
    readonly state: RefundState;
    readonly providerRefundId?: string | null;
    readonly approvalId?: string | null;
    readonly at: string;
  }): Promise<RefundRecord | null>;

  /** Owner queue. Cross-tenant by design; rows carry their own workspace. */
  listRefundsAwaitingOwner(limit: number): Promise<readonly RefundRecord[]>;

  // -- webhook receipts -----------------------------------------------------

  /**
   * Claim this provider event for processing. Backed by
   * `UNIQUE (provider, event_id)` on `webhook_receipts`.
   */
  beginWebhookProcessing(params: {
    readonly receiptId: string;
    readonly provider: string;
    readonly eventId: string;
    readonly payloadHash: string;
    readonly receivedAt: string;
    readonly workspaceId?: string | null;
  }): Promise<WebhookAdmission>;

  completeWebhookProcessing(
    receiptId: string,
    status: WebhookProcessingStatus,
    workspaceId?: string | null,
  ): Promise<void>;

  /**
   * Give the event back.
   *
   * Called when a handler threw after the receipt was claimed. Deleting the receipt is
   * what makes Stripe's retry a fresh attempt instead of a deduplicated no-op — without
   * this, an internal error would permanently swallow a paid invoice.
   */
  abandonWebhookProcessing(eventId: string): Promise<void>;
}
