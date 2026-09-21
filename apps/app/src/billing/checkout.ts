/**
 * Checkout orchestration.
 *
 * Three rules this file exists to enforce:
 *
 *  1. **The price is ours.** `startCheckout` takes a workspace id resolved from the
 *     session and nothing else. There is no parameter for an amount, a price id, a
 *     currency, a customer id or a status, so a tampered request body has nothing to
 *     tamper with. A caller that wants to pass one has to change this signature, which is
 *     a review, not an accident.
 *  2. **Eligibility first.** An unsupported setup is rejected before a card is shown, with
 *     a reason the customer can act on. Payment must never mask a setup we cannot serve.
 *  3. **The success URL activates nothing.** `readCheckoutReturn` is a read. It reports
 *     what the stored state currently is — which, for a customer who has just been
 *     redirected, is normally "waiting for Stripe to confirm". Entitlement changes only
 *     when a signature-verified webhook or a reconciliation read says so.
 */
import { AppError } from '@verify/contracts';
import { checkoutReturnUrls, resolvePlan } from './config';
import type { OrderRecord } from './port';
import { entitlementFor, orderTransition, type EntitlementView } from './state';
import type { BillingRuntime, EligibilityCheck } from './runtime';

export interface StartCheckoutParams {
  /** Resolved from the server-side session. Never read from a request body. */
  readonly workspaceId: string;
  /** Optional, used only to prefill the Stripe customer record. */
  readonly customerEmail?: string;
}

export type StartCheckoutResult =
  | {
      readonly outcome: 'checkout_ready';
      readonly checkoutUrl: string;
      readonly order: OrderRecord;
      readonly reused: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
      readonly detail: string | undefined;
      readonly order: OrderRecord;
    }
  | {
      readonly outcome: 'already_subscribed';
      readonly entitlement: EntitlementView;
    };

export interface CheckoutDeps extends BillingRuntime {
  readonly checkEligibility: EligibilityCheck;
}

/**
 * The idempotency key for a checkout attempt.
 *
 * Scoped to the workspace and the plan version, with no time component: two requests from
 * two browser tabs in the same second, or ten minutes apart, present the same key and get
 * the same order and the same Stripe Checkout Session. That is what stops a
 * double-checkout producing two subscriptions.
 *
 * The key is regenerated only when the plan version changes, which is the one case where
 * a genuinely different purchase is being made.
 */
export function checkoutIdempotencyKey(workspaceId: string, planVersion: number): string {
  return `checkout:v${planVersion}:${workspaceId}`;
}

export async function startCheckout(
  deps: CheckoutDeps,
  params: StartCheckoutParams,
): Promise<StartCheckoutResult> {
  const { config, data, gateway, now, newId } = deps;
  const plan = resolvePlan();
  const at = now();

  // 1. Already served? Never create a second subscription for one workspace.
  const existing = await data.findSubscriptionForWorkspace(params.workspaceId, config.environment);
  const entitlement = entitlementFor(existing);
  if (entitlement.level === 'serving') {
    return { outcome: 'already_subscribed', entitlement };
  }

  // 2. Eligibility, before any money.
  const eligibility = await deps.checkEligibility(params.workspaceId);

  const idempotencyKey = checkoutIdempotencyKey(params.workspaceId, plan.version);
  const draft: OrderRecord = {
    id: newId('ord'),
    workspaceId: params.workspaceId,
    status: 'draft',
    rejectionReason: null,
    priceId: config.priceId,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    checkoutSessionId: null,
    paymentIntentId: null,
    idempotencyKey,
    createdAt: at,
    updatedAt: at,
  };
  const opened = await data.openOrderOnce(draft);
  const order = opened.order;

  if (!eligibility.eligible) {
    const reason = eligibility.reason ?? 'setup_incomplete';
    const transition = orderTransition(order.status, { kind: 'eligibility_failed', reason });
    const rejected = transition.allowed
      ? ((await data.recordOrderStatus({
          workspaceId: params.workspaceId,
          orderId: order.id,
          status: transition.next,
          rejectionReason: reason,
          at,
        })) ?? order)
      : order;
    return {
      outcome: 'rejected',
      reason,
      detail: eligibility.detail,
      order: rejected,
    };
  }

  // A previously rejected order must be re-openable once the customer fixes their setup,
  // and it keeps the same idempotency key, so move it forward explicitly.
  let current = order;
  if (current.status === 'rejected' || current.status === 'draft') {
    const pass = orderTransition(current.status === 'rejected' ? 'draft' : current.status, {
      kind: 'eligibility_passed',
    });
    if (pass.allowed) {
      current =
        (await data.recordOrderStatus({
          workspaceId: params.workspaceId,
          orderId: current.id,
          status: pass.next,
          rejectionReason: null,
          at,
        })) ?? current;
    }
  }

  // 3. A checkout session already exists for this order: hand back the same one.
  if (current.status === 'checkout_created' && current.checkoutSessionId !== null) {
    const url = await resumeCheckoutUrl(deps, current);
    return { outcome: 'checkout_ready', checkoutUrl: url, order: current, reused: true };
  }

  // 4. Bind the workspace to a Stripe customer, once.
  const bound = await data.findBillingCustomer(params.workspaceId, config.environment);
  let stripeCustomerId = bound?.stripeCustomerId ?? null;
  if (stripeCustomerId === null) {
    const created = await gateway.createCustomer({
      idempotencyKey: `customer:${params.workspaceId}`,
      ...(params.customerEmail === undefined ? {} : { email: params.customerEmail }),
      metadata: { workspace_id: params.workspaceId },
    });
    assertMode(created.livemode, config.environment, 'customer');
    const remembered = await data.rememberBillingCustomer({
      workspaceId: params.workspaceId,
      stripeCustomerId: created.id,
      environment: config.environment,
      createdAt: at,
    });
    stripeCustomerId = remembered.customer.stripeCustomerId;
  }

  // 5. Create the session. The price comes from configuration, never from the caller.
  const urls = checkoutReturnUrls(config);
  const session = await gateway.createCheckoutSession({
    idempotencyKey: `${idempotencyKey}:${current.id}`,
    priceId: config.priceId,
    customerId: stripeCustomerId,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    clientReferenceId: params.workspaceId,
    metadata: { workspace_id: params.workspaceId, order_id: current.id },
    subscriptionMetadata: { workspace_id: params.workspaceId, order_id: current.id },
  });
  assertMode(session.livemode, config.environment, 'checkout session');
  if (session.url === null) {
    throw new AppError(
      503,
      'BILLING_CHECKOUT_UNAVAILABLE',
      'Stripe did not return a checkout link. Nothing has been charged; please try again.',
    );
  }

  const transition = orderTransition(current.status, {
    kind: 'checkout_created',
    checkoutSessionId: session.id,
  });
  if (!transition.allowed) {
    throw new AppError(
      409,
      'BILLING_ORDER_STATE',
      'This order is not in a state that can start a checkout.',
    );
  }
  const updated =
    (await data.recordOrderStatus({
      workspaceId: params.workspaceId,
      orderId: current.id,
      status: transition.next,
      checkoutSessionId: session.id,
      at,
    })) ?? current;

  return { outcome: 'checkout_ready', checkoutUrl: session.url, order: updated, reused: false };
}

/**
 * Re-create the hosted link for an order that already has a session.
 *
 * Stripe's create call is idempotent under the same key, so presenting the same key
 * returns the original session rather than a second one. That is the mechanism that makes
 * two concurrent checkouts converge on one subscription.
 */
async function resumeCheckoutUrl(deps: CheckoutDeps, order: OrderRecord): Promise<string> {
  const { config, gateway, data } = deps;
  const bound = await data.findBillingCustomer(order.workspaceId, config.environment);
  if (bound === null) {
    throw new AppError(
      409,
      'BILLING_CUSTOMER_MISSING',
      'This workspace has an open order but no billing customer. Contact support.',
    );
  }
  const urls = checkoutReturnUrls(config);
  const session = await gateway.createCheckoutSession({
    idempotencyKey: `${checkoutIdempotencyKey(order.workspaceId, config.plan.version)}:${order.id}`,
    priceId: config.priceId,
    customerId: bound.stripeCustomerId,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    clientReferenceId: order.workspaceId,
    metadata: { workspace_id: order.workspaceId, order_id: order.id },
    subscriptionMetadata: { workspace_id: order.workspaceId, order_id: order.id },
  });
  if (session.url === null) {
    throw new AppError(
      503,
      'BILLING_CHECKOUT_UNAVAILABLE',
      'Stripe did not return a checkout link. Nothing has been charged; please try again.',
    );
  }
  return session.url;
}

export interface CheckoutReturnView {
  readonly orderStatus: OrderRecord['status'] | 'unknown';
  readonly entitlement: EntitlementView;
  /** True while we are waiting for Stripe to tell us what happened. */
  readonly awaitingConfirmation: boolean;
  readonly message: string;
}

/**
 * What to render on the success URL.
 *
 * This function performs **no writes**. It cannot activate a subscription, grant an
 * allowance or move an order forward, and there is no code path from the success URL that
 * can. A customer who bookmarks the URL, replays it, or crafts it by hand gets exactly
 * this read.
 */
export async function readCheckoutReturn(
  deps: BillingRuntime,
  params: { readonly workspaceId: string },
): Promise<CheckoutReturnView> {
  const { config, data } = deps;
  const subscription = await data.findSubscriptionForWorkspace(
    params.workspaceId,
    config.environment,
  );
  const entitlement = entitlementFor(subscription);
  const orders = await data.listOrdersForWorkspace(params.workspaceId, 1);
  const orderStatus = orders[0]?.status ?? 'unknown';
  const awaitingConfirmation = entitlement.level !== 'serving';
  return {
    orderStatus,
    entitlement,
    awaitingConfirmation,
    message: awaitingConfirmation
      ? 'Your payment is with Stripe. This page updates once Stripe confirms it, usually within a few seconds.'
      : 'Your subscription is active.',
  };
}

function assertMode(livemode: boolean, environment: string, what: string): void {
  const objectEnvironment = livemode ? 'live' : 'test';
  if (objectEnvironment !== environment) {
    throw new AppError(
      422,
      'BILLING_MODE_MISMATCH',
      `Billing is misconfigured: Stripe returned a ${objectEnvironment}-mode ${what}.`,
    );
  }
}
