/**
 * The payment-recovery window in motion: who to tell, and what happens on day 8.
 *
 * The policy itself is in `policy.ts` and is pure. This file is the part that needs a
 * clock and a data port — the scheduled sweep that moves a subscription whose window has
 * run out to `unpaid`, and the notification requests that tell the customer their runs are
 * paused.
 *
 * Three things this file deliberately does **not** do:
 *
 *  - It never cancels. Day 8 marks the subscription `unpaid`; it does not end it. The
 *    customer chooses whether to leave.
 *  - It never deletes. There is no non-payment deletion path anywhere in the billing
 *    subsystem; retention follows `docs/privacy-retention.md` and nothing else.
 *  - It never resumes. Nothing here can move a subscription back to a serving state —
 *    only a signature-verified webhook or a reconciliation read against Stripe's own
 *    records can do that, and both go through `reconcileSubscription`'s guards.
 */
import { notificationKey } from '../notifications/send';
import type { SendRequest } from '../notifications/send';
import { portalReturnUrl } from './config';
import type { SubscriptionRecord } from './port';
import {
  PAYMENT_RECOVERY_POLICY,
  paymentRecoveryWindow,
  recoveryStatement,
  type PaymentRecoveryWindow,
} from './policy';
import type { BillingRuntime } from './runtime';

export type PaymentProblemNotification = SendRequest<'payment_problem'>;

/**
 * The notification asking the customer to fix their card.
 *
 * The key is derived from the **window**, not the clock: every duplicate
 * `invoice.payment_failed` for the same unpaid period produces the same key, so Stripe's
 * retries cannot turn into a stream of identical emails. A09's `sendNotification` claims
 * the key once, ever.
 *
 * `reasonSentence` carries Stripe's own wording through untouched. What the customer
 * needs to know about *us* — that new runs are not being checked — comes from
 * `recoveryStatement()`, which is the same sentence the dashboard shows.
 */
export function paymentProblemNotification(params: {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly recipientEmail: string;
  readonly publicBaseUrl: string;
  readonly window: PaymentRecoveryWindow;
  /** Stripe's stated reason, if the event carried one. */
  readonly providerReason?: string | null;
  /** Distinguishes the day-one pause from the day-eight suspension. */
  readonly stage: 'paused' | 'suspended';
}): PaymentProblemNotification {
  const anchor = params.window.startedAt ?? 'no_anchor';
  return {
    notificationKey: notificationKey(
      'payment_problem',
      params.workspaceId,
      anchor,
      params.stage,
    ),
    workspaceId: params.workspaceId,
    recipientEmail: params.recipientEmail,
    template: 'payment_problem',
    vars: {
      workspaceName: params.workspaceName,
      billingPortalUrl: `${params.publicBaseUrl}/app/billing`,
      reasonSentence: reasonSentenceFor(params.providerReason, params.window),
    },
  };
}

/**
 * What goes into the template's one pass-through sentence.
 *
 * A09's `payment_problem` template currently opens with "We have not suspended anything
 * yet", which was true when it was written and is no longer true under the approved
 * policy — new runs *are* paused from the first failure. I do not own that file, so the
 * consequence the customer cares about is carried here instead, and the wording change to
 * `templates.ts` is described in the handoff for the lead to route.
 */
function reasonSentenceFor(
  providerReason: string | null | undefined,
  window: PaymentRecoveryWindow,
): string {
  const provider =
    typeof providerReason === 'string' && providerReason.trim().length > 0
      ? `${providerReason.trim().replace(/\.?$/, '.')} `
      : '';
  return `${provider}${recoveryStatement(window)}`;
}

export interface SuspendedSubscription {
  readonly workspaceId: string;
  readonly subscriptionId: string;
  readonly providerSubscriptionId: string;
  readonly windowStartedAt: string | null;
  readonly windowEndedAt: string | null;
}

export interface RecoverySweepReport {
  readonly checkedAt: string;
  readonly examined: number;
  /** Subscriptions still inside the window. Nothing was done to them. */
  readonly inWindow: number;
  /** Subscriptions moved to `unpaid` on this pass. */
  readonly suspended: readonly SuspendedSubscription[];
  /** Notifications the caller should enqueue. Building one sends nothing. */
  readonly notifications: readonly PaymentProblemNotification[];
}

export interface RecoverySweepOptions {
  readonly limit?: number;
  /**
   * How to reach the billing contact. Owned outside billing; when it is not supplied, or
   * returns null, the suspension still happens and simply produces no notification.
   */
  readonly billingContact?: (
    workspaceId: string,
  ) => Promise<{ readonly email: string; readonly workspaceName: string } | null>;
}

/**
 * Move every subscription whose recovery window has run out to `unpaid`.
 *
 * Runs on the minute tick. Idempotent: a subscription already `unpaid` reports
 * `needsSuspension: false`, so a second pass finds nothing to do.
 *
 * The write keeps the row's existing `provider_event_created` rather than stamping it
 * with the sweep time. That matters: a genuine later Stripe event — the customer paying —
 * still has a larger timestamp and still wins, so a local suspension can never block a
 * real recovery. An *older* event still loses, which is the out-of-order case the founder
 * asked to be tested.
 */
export async function expirePaymentRecoveryWindows(
  deps: BillingRuntime,
  options: RecoverySweepOptions = {},
): Promise<RecoverySweepReport> {
  const { config, data, now } = deps;
  const checkedAt = now();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const candidates = await data.listSubscriptionsForReconciliation(config.environment, limit);

  const suspended: SuspendedSubscription[] = [];
  const notifications: PaymentProblemNotification[] = [];
  let inWindow = 0;

  for (const subscription of candidates) {
    const window = paymentRecoveryWindow(subscription, checkedAt, config.gracePeriodDays);
    if (window.phase === 'in_recovery_window') {
      inWindow += 1;
      continue;
    }
    if (!window.needsSuspension) continue;

    const next: SubscriptionRecord = {
      ...subscription,
      status: 'unpaid',
      // Unchanged on purpose — see the docblock above.
      providerEventCreated: subscription.providerEventCreated,
      updatedAt: checkedAt,
    };
    await data.saveSubscriptionSnapshot(next);
    suspended.push({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      providerSubscriptionId: subscription.providerSubscriptionId,
      windowStartedAt: window.startedAt,
      windowEndedAt: window.endsAt,
    });

    if (options.billingContact !== undefined) {
      const contact = await options.billingContact(subscription.workspaceId);
      if (contact !== null) {
        notifications.push(
          paymentProblemNotification({
            workspaceId: subscription.workspaceId,
            workspaceName: contact.workspaceName,
            recipientEmail: contact.email,
            publicBaseUrl: config.publicBaseUrl,
            window: paymentRecoveryWindow(next, checkedAt, config.gracePeriodDays),
            stage: 'suspended',
          }),
        );
      }
    }
  }

  return { checkedAt, examined: candidates.length, inWindow, suspended, notifications };
}

/**
 * The whole policy, plus where this workspace currently stands in it.
 *
 * What A05 renders on the billing page during a payment problem, and what the pre-checkout
 * disclosure renders before there is one.
 */
export interface RecoveryStatusView {
  readonly window: PaymentRecoveryWindow;
  readonly statement: string;
  readonly policy: typeof PAYMENT_RECOVERY_POLICY;
  readonly billingPortalPath: string;
  /** Always true. Cancellation is never harder during a payment problem. */
  readonly cancellationAvailable: true;
}

export function recoveryStatus(
  deps: Pick<BillingRuntime, 'config'>,
  subscription: SubscriptionRecord | null,
  nowIso: string,
): RecoveryStatusView {
  const window = paymentRecoveryWindow(subscription, nowIso, deps.config.gracePeriodDays);
  return {
    window,
    statement: recoveryStatement(window),
    policy: PAYMENT_RECOVERY_POLICY,
    billingPortalPath: portalReturnUrl(deps.config),
    cancellationAvailable: true,
  };
}
