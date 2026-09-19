/**
 * Commerce repositories: billing customers, orders, subscriptions, refunds.
 *
 * These four tables carry money, so every write here is insert-once or conditional. The
 * rule that shapes the file: a second attempt must return the first attempt's row, never
 * produce a second effect. A duplicated Stripe customer is an orphan holding a card; a
 * duplicated refund is money leaving twice.
 */
import type { OrderStatus } from '@verify/contracts';
import { type Db, orNull } from './d1';

export type Environment = 'test' | 'live';

export type RefundState =
  'requested' | 'queued_for_owner' | 'submitted' | 'pending' | 'succeeded' | 'failed' | 'rejected';

// ---------------------------------------------------------------------------
// billing customers
// ---------------------------------------------------------------------------

export interface BillingCustomerRow {
  readonly workspace_id: string;
  readonly stripe_customer_id: string;
  readonly environment: Environment;
  readonly created_at: string;
}

const BILLING_CUSTOMER_COLUMNS = 'workspace_id, stripe_customer_id, environment, created_at';

export const billingCustomers = {
  async get(
    db: Db,
    workspaceId: string,
    environment: Environment,
  ): Promise<BillingCustomerRow | null> {
    return db
      .prepare(
        `SELECT ${BILLING_CUSTOMER_COLUMNS} FROM billing_customers
          WHERE workspace_id = ? AND environment = ?`,
      )
      .bind(workspaceId, environment)
      .first<BillingCustomerRow>();
  },

  /**
   * Bind a workspace to a Stripe customer, once.
   *
   * `DO NOTHING` rather than `DO UPDATE`: rebinding would strand the first customer, and
   * that customer is the one holding the card. A second call returns the existing
   * binding, whatever id it names.
   */
  async rememberOnce(
    db: Db,
    row: BillingCustomerRow,
  ): Promise<{ created: boolean; customer: BillingCustomerRow }> {
    const result = await db
      .prepare(
        `INSERT INTO billing_customers (workspace_id, stripe_customer_id, environment, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO NOTHING`,
      )
      .bind(row.workspace_id, row.stripe_customer_id, row.environment, row.created_at)
      .run();
    if (result.meta.changes === 1) return { created: true, customer: row };

    const existing = await billingCustomers.get(db, row.workspace_id, row.environment);
    if (existing !== null) return { created: false, customer: existing };

    // A row exists for this workspace in the *other* environment. Returning the caller's
    // record would be a lie, so say nothing was created and hand back what is stored.
    const anyEnvironment = await db
      .prepare(`SELECT ${BILLING_CUSTOMER_COLUMNS} FROM billing_customers WHERE workspace_id = ?`)
      .bind(row.workspace_id)
      .first<BillingCustomerRow>();
    return { created: false, customer: anyEnvironment ?? row };
  },

  /** Reverse lookup for webhooks, which arrive carrying a Stripe customer id. */
  async findByStripeCustomer(
    db: Db,
    stripeCustomerId: string,
    environment: Environment,
  ): Promise<BillingCustomerRow | null> {
    return db
      .prepare(
        `SELECT ${BILLING_CUSTOMER_COLUMNS} FROM billing_customers
          WHERE stripe_customer_id = ? AND environment = ?`,
      )
      .bind(stripeCustomerId, environment)
      .first<BillingCustomerRow>();
  },
};

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

export interface OrderRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: OrderStatus;
  readonly rejection_reason: string | null;
  readonly price_id: string | null;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly checkout_session_id: string | null;
  readonly idempotency_key: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const ORDER_COLUMNS =
  'id, workspace_id, status, rejection_reason, price_id, amount_minor, currency, checkout_session_id, idempotency_key, created_at, updated_at';

export const orders = {
  /**
   * Open an order once under its idempotency key. Two concurrent checkout attempts for
   * one workspace present the same key and exactly one inserts.
   */
  async openOnce(db: Db, row: OrderRow): Promise<{ created: boolean; order: OrderRow }> {
    const result = await db
      .prepare(
        `INSERT INTO orders (id, workspace_id, status, rejection_reason, price_id, amount_minor, currency, checkout_session_id, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(
        row.id,
        row.workspace_id,
        row.status,
        orNull(row.rejection_reason),
        orNull(row.price_id),
        orNull(row.amount_minor),
        orNull(row.currency),
        orNull(row.checkout_session_id),
        orNull(row.idempotency_key),
        row.created_at,
        row.updated_at,
      )
      .run();
    if (result.meta.changes === 1) return { created: true, order: row };

    // This key is OURS, not a provider's, and the caller already knows the workspace — so
    // it gets a real workspace predicate rather than an exemption. (A06's
    // `checkoutIdempotencyKey` is `checkout:v<plan>:<workspaceId>`: server-derived, with
    // the workspace embedded and nothing browser-supplied in it.)
    const existing =
      row.idempotency_key === null
        ? null
        : await db
            .prepare(
              `SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = ? AND workspace_id = ?`,
            )
            .bind(row.idempotency_key, row.workspace_id)
            .first<OrderRow>();
    if (existing !== null) return { created: false, order: existing };

    // The insert lost the UNIQUE race but the key is not this workspace's. That is not
    // possible while the key embeds the workspace id, so it means the key scheme changed.
    // Returning the caller's unsaved row here would report a draft order as persisted.
    throw new Error('orders.openOnce: idempotency key is held by another workspace');
  },

  async get(db: Db, workspaceId: string, orderId: string): Promise<OrderRow | null> {
    return db
      .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, orderId)
      .first<OrderRow>();
  },

  /**
   * Resolves the workspace FROM a provider-issued, globally unique key.
   *
   * A workspace predicate is impossible here: discovering that value is the whole purpose
   * of the lookup, and adding one would mean a prior query for the answer it returns. What
   * makes it safe is not a predicate but the key itself — Stripe issues it, it is globally
   * unique, and it reaches us only on a signature-verified provider callback, never from a
   * browser. Every call after this one carries the resolved workspace_id.
   */
  async findByCheckoutSession(db: Db, checkoutSessionId: string): Promise<OrderRow | null> {
    // tenant-scope:exempt resolves the workspace from a provider-issued unique key.
    return db
      .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE checkout_session_id = ?`)
      .bind(checkoutSessionId)
      .first<OrderRow>();
  },

  async listForWorkspace(db: Db, workspaceId: string, limit = 20): Promise<OrderRow[]> {
    const result = await db
      .prepare(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE workspace_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(workspaceId, Math.min(Math.max(1, limit), 100))
      .all<OrderRow>();
    return result.results;
  },

  /** Persist a transition the pure state machine already decided was legal. */
  async recordStatus(
    db: Db,
    params: {
      workspaceId: string;
      orderId: string;
      status: OrderStatus;
      rejectionReason?: string | null;
      checkoutSessionId?: string | null;
      at: string;
    },
  ): Promise<OrderRow | null> {
    const result = await db
      .prepare(
        `UPDATE orders
            SET status = ?,
                rejection_reason = COALESCE(?, rejection_reason),
                checkout_session_id = COALESCE(?, checkout_session_id),
                updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(
        params.status,
        orNull(params.rejectionReason),
        orNull(params.checkoutSessionId),
        params.at,
        params.workspaceId,
        params.orderId,
      )
      .run();
    if (result.meta.changes !== 1) return null;
    return orders.get(db, params.workspaceId, params.orderId);
  },
};

// ---------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider_subscription_id: string;
  readonly environment: Environment;
  readonly status: string;
  readonly price_id: string | null;
  readonly current_period_end: string | null;
  readonly cancel_at_period_end: number;
  readonly reconciled_at: string | null;
  readonly provider_event_created: number;
  readonly updated_at: string;
}

const SUBSCRIPTION_COLUMNS =
  'id, workspace_id, provider_subscription_id, environment, status, price_id, current_period_end, cancel_at_period_end, reconciled_at, provider_event_created, updated_at';

export const subscriptions = {
  async getForWorkspace(
    db: Db,
    workspaceId: string,
    environment: Environment,
  ): Promise<SubscriptionRow | null> {
    return db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
          WHERE workspace_id = ? AND environment = ?
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(workspaceId, environment)
      .first<SubscriptionRow>();
  },

  /**
   * Resolves the workspace FROM a provider-issued, globally unique key.
   *
   * A workspace predicate is impossible here: discovering that value is the whole purpose
   * of the lookup, and adding one would mean a prior query for the answer it returns. What
   * makes it safe is not a predicate but the key itself — Stripe issues it, it is globally
   * unique, and it reaches us only on a signature-verified provider callback, never from a
   * browser. Every call after this one carries the resolved workspace_id.
   */
  async getByProviderId(
    db: Db,
    providerSubscriptionId: string,
    environment: Environment,
  ): Promise<SubscriptionRow | null> {
    // tenant-scope:exempt resolves the workspace from a provider-issued unique key.
    return db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
          WHERE provider_subscription_id = ? AND environment = ?`,
      )
      .bind(providerSubscriptionId, environment)
      .first<SubscriptionRow>();
  },

  /**
   * Write a snapshot, under the monotonic guard.
   *
   * `provider_event_created` is the Stripe event's own timestamp. Stripe does not
   * guarantee delivery order, so a `customer.subscription.updated` from before a
   * cancellation can arrive after it. The `WHERE excluded.provider_event_created >=`
   * clause in the upsert is what stops that stale event re-enabling a cancelled
   * subscription — which would mean continuing to serve someone who has stopped paying,
   * or worse, billing someone who cancelled.
   *
   * Returns the row as it stands afterwards, which may be the OLDER one when the guard
   * rejected this event. The caller must read the result rather than assume it won.
   */
  async saveSnapshot(db: Db, row: SubscriptionRow): Promise<SubscriptionRow> {
    await db
      .prepare(
        `INSERT INTO subscriptions
           (id, workspace_id, provider_subscription_id, environment, status, price_id,
            current_period_end, cancel_at_period_end, reconciled_at, provider_event_created, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_subscription_id, environment) DO UPDATE SET
           status                 = excluded.status,
           price_id               = excluded.price_id,
           current_period_end     = excluded.current_period_end,
           cancel_at_period_end   = excluded.cancel_at_period_end,
           provider_event_created = excluded.provider_event_created,
           updated_at             = excluded.updated_at
         WHERE excluded.provider_event_created >= subscriptions.provider_event_created`,
      )
      .bind(
        row.id,
        row.workspace_id,
        row.provider_subscription_id,
        row.environment,
        row.status,
        orNull(row.price_id),
        orNull(row.current_period_end),
        row.cancel_at_period_end,
        orNull(row.reconciled_at),
        row.provider_event_created,
        row.updated_at,
      )
      .run();

    const stored = await subscriptions.getByProviderId(
      db,
      row.provider_subscription_id,
      row.environment,
    );
    if (stored === null) throw new Error('subscriptions.saveSnapshot wrote no row');
    return stored;
  },

  /**
   * The rows the scheduled reconciliation walks.
   *
   * tenant-scope:exempt platform-wide reconciliation sweep; rows carry their workspace_id.
   */
  async listForReconciliation(
    db: Db,
    environment: Environment,
    limit = 50,
  ): Promise<SubscriptionRow[]> {
    const result = await db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
          WHERE environment = ?
          ORDER BY COALESCE(reconciled_at, '') ASC, id ASC
          LIMIT ?`,
      )
      .bind(environment, Math.min(Math.max(1, limit), 200))
      .all<SubscriptionRow>();
    return result.results;
  },

  async markReconciled(db: Db, subscriptionId: string, at: string): Promise<boolean> {
    // tenant-scope:exempt — stamps a row the platform-wide reconciliation sweep just
    // read by its provider subscription id. There is no workspace in scope at this point
    // and the column it writes is internal bookkeeping no customer can see.
    const result = await db
      .prepare('UPDATE subscriptions SET reconciled_at = ? WHERE id = ?')
      .bind(at, subscriptionId)
      .run();
    return result.meta.changes === 1;
  },
};

// ---------------------------------------------------------------------------
// refunds
// ---------------------------------------------------------------------------

export interface RefundRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly order_id: string | null;
  readonly provider_refund_id: string | null;
  readonly amount_minor: number;
  readonly currency: string;
  readonly state: RefundState;
  readonly reason: string | null;
  readonly idempotency_key: string;
  readonly approval_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const REFUND_COLUMNS =
  'id, workspace_id, order_id, provider_refund_id, amount_minor, currency, state, reason, idempotency_key, approval_id, created_at, updated_at';

export const refunds = {
  /** Record a refund request once. The same key twice returns the original refund. */
  async openOnce(db: Db, row: RefundRow): Promise<{ created: boolean; refund: RefundRow }> {
    const result = await db
      .prepare(
        `INSERT INTO refunds (id, workspace_id, order_id, provider_refund_id, amount_minor, currency, state, reason, idempotency_key, approval_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(
        row.id,
        row.workspace_id,
        orNull(row.order_id),
        orNull(row.provider_refund_id),
        row.amount_minor,
        row.currency,
        row.state,
        orNull(row.reason),
        row.idempotency_key,
        orNull(row.approval_id),
        row.created_at,
        row.updated_at,
      )
      .run();
    if (result.meta.changes === 1) return { created: true, refund: row };

    const existing = await refunds.findByIdempotencyKey(db, row.idempotency_key);
    return { created: false, refund: existing ?? row };
  },

  async get(db: Db, workspaceId: string, refundId: string): Promise<RefundRow | null> {
    return db
      .prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, refundId)
      .first<RefundRow>();
  },

  /**
   * Keyed by OUR idempotency key, not a provider's — so it is safe for a different reason
   * from the provider lookups above. A06 builds it as
   * `refund:<workspaceId>:<orderId>:<amount>:<suffix>`, so the workspace id is inside the
   * key and a cross-tenant collision cannot be constructed. It is exempt rather than
   * scoped only because `BillingDataPort.findRefundByIdempotencyKey(key)` takes no
   * workspace argument; noted in the handoff as a port-shape observation, not a defect.
   */
  async findByIdempotencyKey(db: Db, idempotencyKey: string): Promise<RefundRow | null> {
    // tenant-scope:exempt our own key, with the workspace id built into it.
    return db
      .prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE idempotency_key = ?`)
      .bind(idempotencyKey)
      .first<RefundRow>();
  },

  /**
   * Resolves the workspace FROM a provider-issued, globally unique key.
   *
   * A workspace predicate is impossible here: discovering that value is the whole purpose
   * of the lookup, and adding one would mean a prior query for the answer it returns. What
   * makes it safe is not a predicate but the key itself — Stripe issues it, it is globally
   * unique, and it reaches us only on a signature-verified provider callback, never from a
   * browser. Every call after this one carries the resolved workspace_id.
   */
  async findByProviderId(db: Db, providerRefundId: string): Promise<RefundRow | null> {
    // tenant-scope:exempt resolves the workspace from a provider-issued unique key.
    return db
      .prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE provider_refund_id = ?`)
      .bind(providerRefundId)
      .first<RefundRow>();
  },

  async recordState(
    db: Db,
    params: {
      workspaceId: string;
      refundId: string;
      state: RefundState;
      providerRefundId?: string | null;
      approvalId?: string | null;
      at: string;
    },
  ): Promise<RefundRow | null> {
    const result = await db
      .prepare(
        `UPDATE refunds
            SET state = ?,
                provider_refund_id = COALESCE(?, provider_refund_id),
                approval_id = COALESCE(?, approval_id),
                updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(
        params.state,
        orNull(params.providerRefundId),
        orNull(params.approvalId),
        params.at,
        params.workspaceId,
        params.refundId,
      )
      .run();
    if (result.meta.changes !== 1) return null;
    return refunds.get(db, params.workspaceId, params.refundId);
  },

  /**
   * The owner's approval queue.
   *
   * tenant-scope:exempt platform-owner queue; rows carry their own workspace_id.
   */
  async listAwaitingOwner(db: Db, limit = 25): Promise<RefundRow[]> {
    const result = await db
      .prepare(
        `SELECT ${REFUND_COLUMNS} FROM refunds WHERE state = 'queued_for_owner'
          ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .bind(Math.min(Math.max(1, limit), 100))
      .all<RefundRow>();
    return result.results;
  },
};
