/**
 * The hosted Billing Portal.
 *
 * Card details, plan changes and cancellation all happen on Stripe's pages. We hand the
 * customer a one-time link and learn what they did from a webhook — the portal never
 * calls back into our state, and opening it changes nothing here.
 *
 * Cancellation is offered through the portal even when the workspace is past due, because
 * a customer whose card failed must always be able to leave. That is a deliberate product
 * decision, stated in `docs/billing.md`.
 */
import { AppError } from '@verify/contracts';
import { portalReturnUrl } from './config';
import { entitlementFor, type EntitlementView } from './state';
import type { BillingRuntime } from './runtime';

export interface OpenPortalResult {
  readonly portalUrl: string;
  readonly entitlement: EntitlementView;
}

/**
 * Open a portal session for the workspace in the session.
 *
 * Takes no customer id from the caller: it is read from our own `billing_customers`
 * binding, so a request carrying someone else's `cus_…` reaches nothing.
 */
export async function openBillingPortal(
  deps: BillingRuntime,
  params: { readonly workspaceId: string },
): Promise<OpenPortalResult> {
  const { config, data, gateway } = deps;
  const bound = await data.findBillingCustomer(params.workspaceId, config.environment);
  if (bound === null) {
    throw new AppError(
      409,
      'BILLING_NOT_STARTED',
      'This workspace has no billing account yet. Subscribe first.',
    );
  }
  const session = await gateway.createBillingPortalSession({
    customerId: bound.stripeCustomerId,
    returnUrl: portalReturnUrl(config),
  });
  const objectEnvironment = session.livemode ? 'live' : 'test';
  if (objectEnvironment !== config.environment) {
    throw new AppError(
      422,
      'BILLING_MODE_MISMATCH',
      `Billing is misconfigured: Stripe returned a ${objectEnvironment}-mode portal session.`,
    );
  }
  const subscription = await data.findSubscriptionForWorkspace(
    params.workspaceId,
    config.environment,
  );
  return { portalUrl: session.url, entitlement: entitlementFor(subscription) };
}

export type CancellationTiming = 'period_end' | 'immediately';

export interface CancellationResult {
  readonly requested: CancellationTiming;
  /** What we believe now. The authoritative change arrives as a webhook. */
  readonly providerStatus: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly servedUntil: string | null;
  readonly note: string;
}

/**
 * Cancel, from our own UI rather than the portal.
 *
 * Default and recommended timing is `period_end`: the customer has paid for the period,
 * so they keep it. `immediately` exists for a support-led cancellation and does **not**
 * refund anything by itself — a refund is a separate, owner-decided act (`refunds.ts`).
 *
 * The local snapshot is not written here. The `customer.subscription.updated` (or
 * `.deleted`) event that follows is what changes stored state, so cancellation goes
 * through exactly the same monotonic guard as every other provider change.
 */
export async function cancelSubscription(
  deps: BillingRuntime,
  params: {
    readonly workspaceId: string;
    readonly when?: CancellationTiming;
  },
): Promise<CancellationResult> {
  const { config, data, gateway } = deps;
  const when: CancellationTiming = params.when ?? 'period_end';
  const subscription = await data.findSubscriptionForWorkspace(
    params.workspaceId,
    config.environment,
  );
  if (subscription === null) {
    throw new AppError(404, 'BILLING_NO_SUBSCRIPTION', 'There is no subscription to cancel.');
  }
  if (subscription.status === 'canceled') {
    return {
      requested: when,
      providerStatus: 'canceled',
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      servedUntil: subscription.currentPeriodEnd,
      note: 'This subscription was already cancelled. Nothing further was sent to Stripe.',
    };
  }

  const result = await gateway.cancelSubscription({
    subscriptionId: subscription.providerSubscriptionId,
    idempotencyKey: `cancel:${when}:${subscription.providerSubscriptionId}`,
    when,
  });

  return {
    requested: when,
    providerStatus: result.status,
    cancelAtPeriodEnd: result.cancel_at_period_end,
    servedUntil:
      when === 'period_end' ? subscription.currentPeriodEnd : null,
    note:
      when === 'period_end'
        ? 'Your plan stays active until the end of the period you have already paid for. No further payment will be taken.'
        : 'Your plan has been cancelled now. This does not itself issue a refund.',
  };
}
