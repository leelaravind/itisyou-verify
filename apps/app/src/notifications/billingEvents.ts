/**
 * Which customer notifications a Stripe delivery earns.
 *
 * ## Why the mapping lives here and not in `billing/events.ts`
 *
 * `billing/events.ts` answers a money question: what does this event mean for the
 * subscription, the order and the allowance. It already builds the one notification that
 * is inseparable from that answer — `payment_problem`, which needs the recovery window it
 * has just computed. Everything else a customer should hear about is a *presentation*
 * decision over state the money path has already committed, and putting it there would
 * mean the money path grew a second reason to change.
 *
 * It is also a boundary the current ownership split requires: the money path is A16's and
 * is being actively reshaped. This file reads the event envelope and the `EventOutcome`
 * the money path returns, and writes nothing.
 *
 * ## The cancellation trigger, and why it fires exactly once
 *
 * Stripe reports a cancellation twice for the ordinary case. The customer clicks cancel in
 * the billing portal and we get `customer.subscription.updated` with
 * `cancel_at_period_end: true`; a month later the period ends and we get
 * `customer.subscription.deleted`. Both are the same cancellation, and two emails saying
 * "your subscription is cancelled" for one decision is exactly the alert fatigue
 * `grouping.ts` exists to prevent.
 *
 * So both map to **one key**, `cancellation_confirmed:<workspace>:<subscription>`. The
 * first to arrive sends; the second claims a key that already exists and sends nothing.
 * That gives the customer the confirmation at the moment they asked for it, with the
 * correct `timing`, and silence at the moment it takes effect — which is the right way
 * round, because the first is the one they are waiting for.
 *
 * A support-led immediate cancellation produces only the `deleted` event, which then sends
 * with `timing: 'immediately'`. The template's two branches say materially different
 * things, so this is not cosmetic: promising a paid-for period to someone whose access has
 * already stopped is a false statement in a transactional email.
 */
import type { EventOutcome, StripeEventShape } from '../billing/events';
import { unixToIso } from '../billing/state';
import type { BillingContactLookup } from '../billing/runtime';
import type { AnyNotificationRequest } from './delivery';
import { notificationKey } from './send';

/**
 * Effects from `billing/events.ts` that mean a subscription row was actually written.
 *
 * An event the money path ignored — stale, duplicate, already terminal, wrong mode —
 * changed nothing, and announcing a change we did not make is worse than saying nothing.
 */
const APPLIED_SUBSCRIPTION_EFFECTS: ReadonlySet<string> = new Set([
  'subscription_created',
  'subscription_updated',
]);

export interface StripeNotificationContext {
  readonly event: StripeEventShape;
  readonly outcome: EventOutcome;
  /** How to reach the billing contact. Absent or `null` simply produces no notification. */
  readonly billingContact?: BillingContactLookup | undefined;
}

/**
 * Every notification this delivery should produce.
 *
 * Returns the money path's own `payment_problem` requests unchanged, plus anything this
 * file derives from the event envelope. Never throws: a contact lookup that fails costs
 * the notification, not the webhook's 200.
 */
export async function notificationsForStripeEvent(
  context: StripeNotificationContext,
): Promise<readonly AnyNotificationRequest[]> {
  const { event, outcome } = context;

  // Built by `handleInvoicePaymentFailed`, which owns the recovery window the key is
  // derived from. Passed through untouched — re-deriving the key here would be a second
  // spelling of the same idempotency decision.
  const requests: AnyNotificationRequest[] = [...(outcome.notifications ?? [])];

  const cancellation = await cancellationRequest(context);
  if (cancellation !== null) requests.push(cancellation);

  void event;
  return requests;
}

async function cancellationRequest(
  context: StripeNotificationContext,
): Promise<AnyNotificationRequest | null> {
  const { event, outcome, billingContact } = context;
  if (billingContact === undefined) return null;
  if (outcome.workspaceId === null) return null;

  const object = event.data.object;
  const subscriptionId = readString(object, 'id');
  if (subscriptionId === null) return null;

  const deleted = event.type === 'customer.subscription.deleted';
  const scheduled =
    event.type === 'customer.subscription.updated' && object['cancel_at_period_end'] === true;
  if (!deleted && !scheduled) return null;

  // Only when the money path actually wrote the row. `subscription_already_cancelled`,
  // `subscription_event_stale` and `subscription_event_duplicate` all mean nothing changed.
  if (!APPLIED_SUBSCRIPTION_EFFECTS.has(outcome.effect)) return null;

  let contact;
  try {
    contact = await billingContact(outcome.workspaceId);
  } catch {
    // A contact lookup that fails must not fail the webhook. The cancellation is already
    // recorded; the customer can see it in the application.
    return null;
  }
  if (contact === null) return null;

  const periodEnd = subscriptionPeriodEnd(object);
  // `cancel_at_period_end` with a known period end is the only case where the customer
  // keeps paid-for access. A deletion with neither is access that has already stopped.
  const keepsPaidPeriod = object['cancel_at_period_end'] === true && periodEnd !== null;
  const accessEndsAt = keepsPaidPeriod
    ? (periodEnd as string)
    : (endedAt(object) ?? unixToIso(event.created) ?? '');
  if (accessEndsAt.length === 0) return null;

  return {
    // One key for the whole cancellation, so the `updated` that schedules it and the
    // `deleted` that completes it cannot both send.
    notificationKey: notificationKey('cancellation_confirmed', outcome.workspaceId, subscriptionId),
    workspaceId: outcome.workspaceId,
    recipientEmail: contact.email,
    template: 'cancellation_confirmed',
    vars: {
      workspaceName: contact.workspaceName,
      accessEndsAt,
      timing: keepsPaidPeriod ? 'period_end' : 'immediately',
    },
  };
}

/** `items.data[0].current_period_end` in the current API shape, then the legacy field. */
function subscriptionPeriodEnd(object: Record<string, unknown>): string | null {
  const items = object['items'];
  if (items !== null && typeof items === 'object') {
    const data = (items as Record<string, unknown>)['data'];
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (first !== null && typeof first === 'object') {
        const value = (first as Record<string, unknown>)['current_period_end'];
        if (typeof value === 'number') return unixToIso(value);
      }
    }
  }
  const legacy = object['current_period_end'];
  return typeof legacy === 'number' ? unixToIso(legacy) : null;
}

/** When access actually stopped, for an immediate cancellation. */
function endedAt(object: Record<string, unknown>): string | null {
  for (const key of ['ended_at', 'canceled_at']) {
    const value = object[key];
    if (typeof value === 'number') return unixToIso(value);
  }
  return null;
}

function readString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
