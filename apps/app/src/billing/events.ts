/**
 * Typed handlers for the Stripe events that change money state.
 *
 * Everything reaching this module has already had its signature verified against the raw
 * request bytes and has already been deduplicated on Stripe's event id. What is left is
 * the business question: what does this event mean, and does it still mean it given what
 * we already know?
 *
 * Ordering is not assumed anywhere. Stripe says outright that it "doesn't guarantee the
 * delivery of events in the order that they're generated" and that "distinct events can
 * share a timestamp" (https://docs.stripe.com/webhooks, checked 2026-09-19), so every
 * write to a subscription goes through `reconcileSubscription()` in `state.ts`, which
 * holds both the monotonic guard and the terminal-cancellation guard.
 *
 * Field paths follow the **current** API shape and fall back to the legacy one:
 *  - period end lives on `items.data[0].current_period_end`, not on the subscription;
 *  - an invoice's subscription lives at `parent.subscription_details.subscription`.
 */
import { rollover } from './entitlements';
import type { AllowanceRecord, SubscriptionRecord } from './port';
import { applyProviderRefund } from './refunds';
import type { BillingRuntime } from './runtime';
import { allowancePeriodKey } from './period';
import {
  asSubscriptionStatus,
  entitlementFor,
  orderTransition,
  reconcileSubscription,
  unixToIso,
  SERVING_SUBSCRIPTION_STATUSES,
  type ProviderSubscriptionSnapshot,
} from './state';
import { paymentRecoveryWindow } from './policy';
import { paymentProblemNotification, type PaymentProblemNotification } from './recovery';

export interface StripeEventShape {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly data: { readonly object: Record<string, unknown> };
}

export interface EventOutcome {
  /** What the receipt should record. `ignored` is a success, not a failure. */
  readonly status: 'processed' | 'ignored';
  /** Machine tag for logs and tests. */
  readonly effect: string;
  readonly workspaceId: string | null;
  readonly detail?: string;
  /**
   * Notifications the caller should enqueue. Building one sends nothing — A09's
   * `sendNotification` claims the key and does the sending, once ever.
   */
  readonly notifications?: readonly PaymentProblemNotification[];
}

const ignored = (
  effect: string,
  workspaceId: string | null = null,
  detail?: string,
): EventOutcome =>
  detail === undefined
    ? { status: 'ignored', effect, workspaceId }
    : { status: 'ignored', effect, workspaceId, detail };

const processed = (
  effect: string,
  workspaceId: string | null = null,
  detail?: string,
): EventOutcome =>
  detail === undefined
    ? { status: 'processed', effect, workspaceId }
    : { status: 'processed', effect, workspaceId, detail };

/** The event types this integration subscribes to. Anything else is recorded and dropped. */
export const HANDLED_EVENT_TYPES: readonly string[] = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
]);

export async function handleStripeEvent(
  deps: BillingRuntime,
  event: StripeEventShape,
): Promise<EventOutcome> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(deps, event);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionChanged(deps, event, false);
    case 'customer.subscription.deleted':
      return handleSubscriptionChanged(deps, event, true);
    case 'invoice.paid':
      return handleInvoicePaid(deps, event);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(deps, event);
    case 'charge.refunded':
      return handleChargeRefunded(deps, event);
    default:
      // Recorded by the caller, then dropped. An event type we do not understand is not
      // an error and must not produce a non-2xx, or Stripe will retry it for three days.
      return ignored('unhandled_event_type', null, event.type);
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  deps: BillingRuntime,
  event: StripeEventShape,
): Promise<EventOutcome> {
  const { config, data, gateway, now } = deps;
  const session = event.data.object;
  const at = now();

  if (readString(session, 'mode') !== 'subscription') {
    return ignored('checkout_not_subscription_mode');
  }

  // `client_reference_id` is *our own* workspace id, set when we created the session and
  // returned inside a signed event. It is not a browser-supplied value.
  const workspaceId =
    readString(session, 'client_reference_id') ?? readMetadata(session, 'workspace_id');
  if (workspaceId === null) return ignored('checkout_without_workspace_reference');

  const sessionId = readString(session, 'id');
  const customerId = readId(session, 'customer');
  const subscriptionId = readId(session, 'subscription');
  const paymentStatus = readString(session, 'payment_status');

  if (customerId !== null) {
    // Insert-once. If the workspace is already bound, this returns the existing binding
    // and never rebinds — a second customer holding a card is not something to create.
    await data.rememberBillingCustomer({
      workspaceId,
      stripeCustomerId: customerId,
      environment: config.environment,
      createdAt: at,
    });
  }

  // Move the order, if we can find it. The order is our record of the purchase attempt;
  // entitlement still comes from the subscription, never from here.
  const orderId = readMetadata(session, 'order_id');
  const order =
    (sessionId === null ? null : await data.findOrderByCheckoutSession(sessionId)) ??
    (orderId === null ? null : await data.findOrder(workspaceId, orderId));
  if (order !== null) {
    const transition = orderTransition(
      order.status,
      paymentStatus === 'paid'
        ? { kind: 'payment_succeeded' }
        : { kind: 'checkout_completed_unpaid' },
    );
    if (transition.allowed) {
      await data.recordOrderStatus({
        workspaceId,
        orderId: order.id,
        status: transition.next,
        ...(sessionId === null ? {} : { checkoutSessionId: sessionId }),
        at,
      });
    }
  }

  if (subscriptionId === null) {
    return processed('checkout_completed_without_subscription', workspaceId);
  }

  const stored = await data.findSubscriptionByProviderId(subscriptionId, config.environment);
  if (stored !== null) {
    // The subscription events already told us the real state; do not overwrite it with a
    // guess derived from a checkout session.
    return processed('checkout_completed_subscription_already_known', workspaceId);
  }

  // No row yet. Read the subscription from Stripe rather than inventing a status — a
  // read against the provider's own records is one of the only two things allowed to
  // establish entitlement.
  let snapshot: ProviderSubscriptionSnapshot;
  try {
    const provider = await gateway.retrieveSubscription(subscriptionId);
    const status = asSubscriptionStatus(provider.status);
    if (status === null) {
      return processed('checkout_completed_unknown_provider_status', workspaceId, provider.status);
    }
    snapshot = {
      providerSubscriptionId: provider.id,
      environment: provider.livemode ? 'live' : 'test',
      status,
      priceId: provider.items?.data?.[0]?.price?.id ?? null,
      currentPeriodEnd:
        unixToIso(provider.items?.data?.[0]?.current_period_end) ??
        unixToIso(provider.current_period_end),
      cancelAtPeriodEnd: provider.cancel_at_period_end,
      providerEventCreated: event.created,
    };
  } catch {
    // Not fatal and not a fabricated success: the subscription events and the scheduled
    // reconciliation both still reach this subscription.
    return processed('checkout_completed_subscription_unreadable', workspaceId, subscriptionId);
  }

  if (snapshot.environment !== config.environment) {
    return ignored('checkout_completed_mode_mismatch', workspaceId);
  }

  await persistSubscription(deps, workspaceId, snapshot, at);
  return processed('checkout_completed_subscription_linked', workspaceId);
}

// ---------------------------------------------------------------------------
// customer.subscription.created / updated / deleted
// ---------------------------------------------------------------------------

async function handleSubscriptionChanged(
  deps: BillingRuntime,
  event: StripeEventShape,
  deleted: boolean,
): Promise<EventOutcome> {
  const { config, data, now } = deps;
  const object = event.data.object;
  const at = now();

  const providerSubscriptionId = readString(object, 'id');
  if (providerSubscriptionId === null) return ignored('subscription_without_id');

  const stored = await data.findSubscriptionByProviderId(
    providerSubscriptionId,
    config.environment,
  );

  const workspaceId = await resolveWorkspace(deps, object, stored);
  if (workspaceId === null) {
    return ignored('subscription_for_unknown_workspace', null, providerSubscriptionId);
  }

  // A deletion is always `canceled`, whatever the payload happens to carry.
  const status = deleted ? 'canceled' : asSubscriptionStatus(readString(object, 'status'));
  if (status === null) {
    return ignored('subscription_unknown_status', workspaceId, readString(object, 'status') ?? '');
  }

  const items = readItems(object);
  const snapshot: ProviderSubscriptionSnapshot = {
    providerSubscriptionId,
    environment: readBool(object, 'livemode') ? 'live' : 'test',
    status,
    priceId: items.priceId,
    currentPeriodEnd: items.currentPeriodEnd ?? unixToIso(readNumber(object, 'current_period_end')),
    cancelAtPeriodEnd: readBool(object, 'cancel_at_period_end'),
    providerEventCreated: event.created,
  };

  if (snapshot.environment !== config.environment) {
    return ignored('subscription_mode_mismatch', workspaceId);
  }

  const decision = reconcileSubscription(stored, snapshot);
  switch (decision.action) {
    case 'ignore_stale':
      return processed(
        'subscription_event_stale',
        workspaceId,
        String(decision.storedEventCreated),
      );
    case 'ignore_duplicate':
      return processed('subscription_event_duplicate', workspaceId);
    case 'ignore_terminal':
      // The scenario this exists for: a `customer.subscription.updated` carrying `active`
      // arriving after the `deleted` that cancelled it. Never re-enable.
      return processed('subscription_already_cancelled', workspaceId, decision.storedStatus);
    case 'reject_environment_mismatch':
      return ignored('subscription_mode_mismatch', workspaceId, decision.storedEnvironment);
    case 'insert':
    case 'apply': {
      const saved = await persistSubscription(deps, workspaceId, decision.next, at, stored);
      await moveOrderForSubscription(deps, workspaceId, saved, at);
      return processed(
        decision.action === 'insert' ? 'subscription_created' : 'subscription_updated',
        workspaceId,
        saved.status,
      );
    }
    default: {
      const exhaustive: never = decision;
      return ignored('subscription_undecided', workspaceId, String(exhaustive));
    }
  }
}

// ---------------------------------------------------------------------------
// invoice.paid / invoice.payment_failed
// ---------------------------------------------------------------------------

async function handleInvoicePaid(
  deps: BillingRuntime,
  event: StripeEventShape,
): Promise<EventOutcome> {
  const { config, data, now } = deps;
  const invoice = event.data.object;
  const at = now();

  const subscriptionId = invoiceSubscriptionId(invoice);
  const customerId = readId(invoice, 'customer');

  const stored =
    subscriptionId === null
      ? null
      : await data.findSubscriptionByProviderId(subscriptionId, config.environment);

  let workspaceId = stored?.workspaceId ?? null;
  if (workspaceId === null && customerId !== null) {
    const binding = await data.findWorkspaceForBillingCustomer(customerId, config.environment);
    workspaceId = binding?.workspaceId ?? null;
  }
  if (workspaceId === null) {
    // An invoice for a customer we have never seen. Not an error — the owner may have
    // created something in the dashboard — but nothing is invented either.
    return ignored('invoice_for_unknown_customer', null, customerId ?? 'no_customer');
  }

  // Roll the allowance forward for the period this invoice pays for. `openAllowancePeriod`
  // is idempotent and keyed by the period END, so a redelivered invoice, an out-of-order
  // one, and the subscription event describing the same period all land on one row and
  // hand out one allowance.
  const periodEnd = invoicePeriodEnd(invoice);
  if (periodEnd !== null) {
    const fresh = rollover(config.plan.runsPerPeriod);
    const record: AllowanceRecord = {
      id: deps.newId('ent'),
      workspaceId,
      billingPeriod: allowancePeriodKey(periodEnd),
      planVersion: config.plan.version,
      runLimit: fresh.runLimit,
      consumed: fresh.consumed,
      reserved: fresh.reserved,
      updatedAt: at,
    };
    await data.openAllowancePeriod(record);
  }

  if (stored !== null) {
    const order = await latestOrder(deps, workspaceId);
    if (order !== null) {
      const transition = orderTransition(order.status, { kind: 'payment_succeeded' });
      if (transition.allowed) {
        await data.recordOrderStatus({
          workspaceId,
          orderId: order.id,
          status: transition.next,
          at,
        });
      }
    }
  }

  return processed('invoice_paid', workspaceId, readString(invoice, 'billing_reason') ?? '');
}

async function handleInvoicePaymentFailed(
  deps: BillingRuntime,
  event: StripeEventShape,
): Promise<EventOutcome> {
  const { config, data, now } = deps;
  const invoice = event.data.object;
  const at = now();

  const subscriptionId = invoiceSubscriptionId(invoice);
  const customerId = readId(invoice, 'customer');
  const stored =
    subscriptionId === null
      ? null
      : await data.findSubscriptionByProviderId(subscriptionId, config.environment);

  let workspaceId = stored?.workspaceId ?? null;
  if (workspaceId === null && customerId !== null) {
    const binding = await data.findWorkspaceForBillingCustomer(customerId, config.environment);
    workspaceId = binding?.workspaceId ?? null;
  }
  if (workspaceId === null) {
    return ignored('invoice_for_unknown_customer', null, customerId ?? 'no_customer');
  }

  // The subscription status itself is not written here — Stripe sends
  // The founder's requirement 1: new runs pause on renewal failure, not when a second
  // event happens to turn up. A failed *renewal* invoice on a subscription we are
  // currently serving is provider evidence that the renewal did not go through, so we
  // record `past_due` — through `reconcileSubscription`, with both guards, stamped with
  // this event's own `created`. A genuine later Stripe event still overwrites it, and a
  // genuine earlier one still loses.
  //
  // Only a renewal. A first invoice failing means `incomplete`, not `past_due`, and
  // inventing the wrong status would be worse than waiting for the subscription event.
  const billingReason = readString(invoice, 'billing_reason') ?? '';
  const isRenewal =
    billingReason === 'subscription_cycle' || billingReason === 'subscription_update';
  let current = stored;
  if (stored !== null && isRenewal && SERVING_SUBSCRIPTION_STATUSES.has(stored.status)) {
    const decision = reconcileSubscription(stored, {
      providerSubscriptionId: stored.providerSubscriptionId,
      environment: stored.environment,
      status: 'past_due',
      priceId: stored.priceId,
      currentPeriodEnd: stored.currentPeriodEnd,
      cancelAtPeriodEnd: stored.cancelAtPeriodEnd,
      providerEventCreated: event.created,
    });
    if (decision.action === 'apply' || decision.action === 'insert') {
      current = await persistSubscription(deps, workspaceId, decision.next, at, stored);
    }
  }

  const window = paymentRecoveryWindow(current, at, config.gracePeriodDays);

  const order = await latestOrder(deps, workspaceId);
  if (order !== null) {
    const transition = orderTransition(order.status, { kind: 'payment_failed' });
    if (transition.allowed) {
      await data.recordOrderStatus({
        workspaceId,
        orderId: order.id,
        status: transition.next,
        at,
      });
    }
  }

  // Requirement 3: tell them the thing they care about — new runs are not being checked.
  // The key is derived from the window, so Stripe's retries cannot become a stream of
  // identical emails.
  const notifications: PaymentProblemNotification[] = [];
  if (deps.billingContact !== undefined) {
    const contact = await deps.billingContact(workspaceId);
    if (contact !== null) {
      notifications.push(
        paymentProblemNotification({
          workspaceId,
          workspaceName: contact.workspaceName,
          recipientEmail: contact.email,
          publicBaseUrl: config.publicBaseUrl,
          window,
          providerReason: readProviderReason(invoice),
          stage: 'paused',
        }),
      );
    }
  }

  return {
    status: 'processed',
    effect: 'invoice_payment_failed',
    workspaceId,
    detail: window.endsAt ?? 'no_window_anchor',
    notifications,
  };
}

/** Stripe's own words about why the charge failed, if the invoice carried any. */
function readProviderReason(invoice: Record<string, unknown>): string | null {
  const error = invoice['last_finalization_error'];
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

async function handleChargeRefunded(
  deps: BillingRuntime,
  event: StripeEventShape,
): Promise<EventOutcome> {
  const charge = event.data.object;
  const refunds = readRefundList(charge);
  if (refunds.length === 0) return ignored('charge_refunded_without_refund_objects');

  let updated = 0;
  let unmatched = 0;
  let workspaceId: string | null = null;
  for (const refund of refunds) {
    const providerRefundId = readString(refund, 'id');
    if (providerRefundId === null) continue;
    const result = await applyProviderRefund(deps, {
      providerRefundId,
      status: readString(refund, 'status'),
    });
    if (result.outcome === 'unmatched') unmatched += 1;
    else {
      workspaceId = result.refund.workspaceId;
      if (result.outcome === 'updated') updated += 1;
    }
  }

  if (updated === 0 && unmatched > 0) {
    // A refund issued straight from the Stripe dashboard. Reported, never fabricated.
    return ignored('refund_not_matched_locally', workspaceId, String(unmatched));
  }
  return processed('refund_state_updated', workspaceId, String(updated));
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

async function persistSubscription(
  deps: BillingRuntime,
  workspaceId: string,
  snapshot: ProviderSubscriptionSnapshot,
  at: string,
  stored?: SubscriptionRecord | null,
): Promise<SubscriptionRecord> {
  const { data, config, newId } = deps;
  const record: SubscriptionRecord = {
    id: stored?.id ?? newId('sub'),
    workspaceId,
    providerSubscriptionId: snapshot.providerSubscriptionId,
    environment: snapshot.environment,
    status: snapshot.status,
    priceId: snapshot.priceId,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    reconciledAt: stored?.reconciledAt ?? null,
    providerEventCreated: snapshot.providerEventCreated,
    updatedAt: at,
  };
  const saved = await data.saveSubscriptionSnapshot(record);

  // Opening the allowance is derived from provider evidence, never from a request, and
  // keyed by the period end so it cannot disagree with the key `invoice.paid` computes.
  // `openAllowancePeriod` refreshes the terms and never the counters, so a recovery
  // inside the payment window resumes on the allowance the customer already has.
  if (entitlementFor(saved).level === 'serving' && saved.currentPeriodEnd !== null) {
    const fresh = rollover(config.plan.runsPerPeriod);
    await data.openAllowancePeriod({
      id: newId('ent'),
      workspaceId,
      billingPeriod: allowancePeriodKey(saved.currentPeriodEnd),
      planVersion: config.plan.version,
      runLimit: fresh.runLimit,
      consumed: fresh.consumed,
      reserved: fresh.reserved,
      updatedAt: at,
    });
  }
  return saved;
}

async function moveOrderForSubscription(
  deps: BillingRuntime,
  workspaceId: string,
  subscription: SubscriptionRecord,
  at: string,
): Promise<void> {
  const order = await latestOrder(deps, workspaceId);
  if (order === null) return;
  const level = entitlementFor(subscription).level;
  const event =
    level === 'serving'
      ? ({ kind: 'payment_succeeded' } as const)
      : subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
        ? ({ kind: 'subscription_cancelled' } as const)
        : ({ kind: 'payment_failed' } as const);
  const transition = orderTransition(order.status, event);
  if (!transition.allowed || transition.next === order.status) return;
  await deps.data.recordOrderStatus({
    workspaceId,
    orderId: order.id,
    status: transition.next,
    at,
  });
}

async function latestOrder(deps: BillingRuntime, workspaceId: string) {
  const orders = await deps.data.listOrdersForWorkspace(workspaceId, 1);
  return orders[0] ?? null;
}

async function resolveWorkspace(
  deps: BillingRuntime,
  object: Record<string, unknown>,
  stored: SubscriptionRecord | null,
): Promise<string | null> {
  if (stored !== null) return stored.workspaceId;
  const fromMetadata = readMetadata(object, 'workspace_id');
  if (fromMetadata !== null) return fromMetadata;
  const customerId = readId(object, 'customer');
  if (customerId === null) return null;
  const binding = await deps.data.findWorkspaceForBillingCustomer(
    customerId,
    deps.config.environment,
  );
  return binding?.workspaceId ?? null;
}

/**
 * The subscription an invoice belongs to.
 *
 * Current API: `parent.subscription_details.subscription`. Legacy: a top-level
 * `subscription`. Both read, because an event generated under an older account API
 * version still arrives in the old shape.
 */
export function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice['parent'];
  if (parent !== null && typeof parent === 'object') {
    const details = (parent as Record<string, unknown>)['subscription_details'];
    if (details !== null && typeof details === 'object') {
      const id = asId((details as Record<string, unknown>)['subscription']);
      if (id !== null) return id;
    }
  }
  return asId(invoice['subscription']);
}

/**
 * The start of the service period an invoice covers.
 *
 * Prefers the line item's own period, which the documentation points at for the service
 * period, and falls back to the invoice's `period_start`. Reported, not used as a key —
 * see `invoicePeriodEnd`.
 */
export function invoicePeriodStart(invoice: Record<string, unknown>): string | null {
  return invoiceLinePeriod(invoice, 'start') ?? unixToIso(readNumber(invoice, 'period_start'));
}

/**
 * The end of the service period an invoice covers. **This is the allowance key.**
 *
 * It agrees exactly with the subscription's `items.data[].current_period_end` for the same
 * period, which is what stops one paid period ever producing two allowance rows.
 */
export function invoicePeriodEnd(invoice: Record<string, unknown>): string | null {
  return invoiceLinePeriod(invoice, 'end') ?? unixToIso(readNumber(invoice, 'period_end'));
}

function invoiceLinePeriod(invoice: Record<string, unknown>, edge: 'start' | 'end'): string | null {
  const lines = invoice['lines'];
  if (lines !== null && typeof lines === 'object') {
    const data = (lines as Record<string, unknown>)['data'];
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (first !== null && typeof first === 'object') {
        const period = (first as Record<string, unknown>)['period'];
        if (period !== null && typeof period === 'object') {
          const value = (period as Record<string, unknown>)[edge];
          if (typeof value === 'number') return unixToIso(value);
        }
      }
    }
  }
  return null;
}

function readRefundList(charge: Record<string, unknown>): readonly Record<string, unknown>[] {
  const refunds = charge['refunds'];
  if (refunds === null || typeof refunds !== 'object') return [];
  const data = (refunds as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
  );
}

function readItems(object: Record<string, unknown>): {
  priceId: string | null;
  currentPeriodEnd: string | null;
} {
  const items = object['items'];
  if (items !== null && typeof items === 'object') {
    const data = (items as Record<string, unknown>)['data'];
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (first !== null && typeof first === 'object') {
        const record = first as Record<string, unknown>;
        return {
          priceId: asId(record['price']),
          currentPeriodEnd: unixToIso(readNumber(record, 'current_period_end')),
        };
      }
    }
  }
  return { priceId: null, currentPeriodEnd: null };
}

function readString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBool(object: Record<string, unknown>, key: string): boolean {
  return object[key] === true;
}

/** An id that may arrive either as a string or as an expanded object. */
function readId(object: Record<string, unknown>, key: string): string | null {
  return asId(object[key]);
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== null && typeof value === 'object') {
    const id = (value as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function readMetadata(object: Record<string, unknown>, key: string): string | null {
  const metadata = object['metadata'];
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
