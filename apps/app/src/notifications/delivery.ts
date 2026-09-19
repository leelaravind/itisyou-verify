/**
 * The last mile: the thing that turns a *built* notification into a *sent* one.
 *
 * ## The defect this file closes
 *
 * Twelve templates, an at-most-once sender, alert-storm grouping, a recorded-status
 * vocabulary that refuses to claim delivery — all of it correct, all of it tested, and
 * **none of it reachable**. `billing/events.ts` built a `payment_problem` request and
 * returned it in `EventOutcome.notifications`; `routes/webhooks/stripe.ts` logged the
 * outcome and dropped it on the floor. `billing/scheduled.ts` built the day-8 requests and
 * exported `maintenanceNotifications()` to hand them to a caller that did not exist.
 * From the customer's side the feature was absent.
 *
 * Everything here is wiring. No policy, no copy, no new idempotency scheme — the key is
 * already on the request, `sendNotification` already claims it exactly once, and this file
 * exists so that there is one place a request goes to become an email and one place a
 * failure to send is recorded.
 *
 * ## Two layers of idempotency, and why both are needed
 *
 * A Stripe redelivery is stopped twice over, and neither layer is redundant:
 *
 *  1. **`webhook_receipts`**, `UNIQUE (provider, event_id)`. The second delivery of event
 *     `evt_X` never reaches a handler at all, so no allowance is granted and no
 *     notification is built. This is the layer that protects *money*.
 *  2. **`notification_deliveries.notification_key`**, `UNIQUE`. The key is derived from the
 *     event — workspace, recovery-window anchor, stage — never from a clock. So a
 *     notification built twice from two *different* events describing the same situation
 *     (the webhook and the day-8 sweep both reporting the same unpaid period, say) still
 *     sends once. This is the layer that protects the *customer's inbox*.
 *
 * Layer 1 alone would let the scheduled path re-send what the webhook already sent. Layer 2
 * alone would let a duplicate event grant a second allowance. The proof for both is in
 * `tests/integration/support/notification-wiring.test.ts`.
 *
 * ## Failure is never propagated
 *
 * `deliverNotifications` does not throw, ever. A notification is an announcement about
 * something that already happened; if the announcement fails, the money state is still
 * correct and must stay committed. Turning a failed send into a 500 on the Stripe webhook
 * would make Stripe retry an event we already applied — the receipt would deduplicate it,
 * so the retry would achieve nothing except to mark a processed payment as failed in
 * Stripe's dashboard.
 */
import type { SendDependencies, SendRequest, SendResult } from './send';
import { sendNotification } from './send';
import type { NotificationTemplate } from './templates';
import { createEmailTransport, type EmailTransportEnv } from './email';
import type { SupportDataPort } from '../support/port';

/**
 * A send request for *some* template, as a discriminated union rather than a generic.
 *
 * A heterogeneous batch — one `payment_problem`, one `cancellation_confirmed` — cannot be
 * typed as `SendRequest<T>` for a single `T`. This mapped-then-indexed form keeps each
 * member's `template` pinned to its own `vars`, so a request carrying the wrong variables
 * for its template does not compile.
 */
export type AnyNotificationRequest = {
  [T in NotificationTemplate]: SendRequest<T>;
}[NotificationTemplate];

export interface DeliveryReport {
  readonly attempted: number;
  readonly sent: number;
  /** Key already claimed. Nothing was sent, and that is the correct outcome. */
  readonly duplicates: number;
  /** Deliberately not sent: grouping, a preference, or no transport configured. */
  readonly suppressed: number;
  readonly failed: number;
  readonly results: readonly SendResult[];
}

const EMPTY_REPORT: DeliveryReport = {
  attempted: 0,
  sent: 0,
  duplicates: 0,
  suppressed: 0,
  failed: 0,
  results: [],
};

/** Structured log sink. Receives keys, templates and statuses — never a body or an address. */
export type DeliveryLog = (entry: Record<string, string | number | boolean>) => void;

/**
 * Send a batch of already-built notifications.
 *
 * Sequential on purpose. These batches are small (one per failed renewal, one per
 * suspended subscription), and a cron tick that fans out a hundred concurrent sends is how
 * a Worker hits its subrequest limit and drops the tail of a batch silently. In order,
 * bounded, and each one's outcome recorded before the next begins.
 */
export async function deliverNotifications(
  deps: SendDependencies,
  requests: readonly AnyNotificationRequest[],
  log?: DeliveryLog,
): Promise<DeliveryReport> {
  if (requests.length === 0) return EMPTY_REPORT;

  const results: SendResult[] = [];
  let sent = 0;
  let duplicates = 0;
  let suppressed = 0;
  let failed = 0;

  for (const request of requests) {
    let result: SendResult;
    try {
      result = await sendNotification(deps, request);
    } catch (error) {
      // `sendNotification` is documented never to throw. If that ever stops being true,
      // one unsendable notification must still not cost the rest of the batch, and it must
      // not cost the caller's response.
      failed += 1;
      log?.({
        event: 'notification_delivery_threw',
        notification_key: request.notificationKey,
        template: request.template,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }

    results.push(result);
    if (result.outcome === 'sent') sent += 1;
    else if (result.outcome === 'duplicate') duplicates += 1;
    else if (result.outcome === 'suppressed') suppressed += 1;
    else failed += 1;

    log?.({
      event: 'notification_delivery',
      notification_key: result.notificationKey,
      template: request.template,
      outcome: result.outcome,
      state: result.state,
      attempts: result.attemptCount,
      provider_status: result.providerStatus ?? 'none',
    });
  }

  return { attempted: requests.length, sent, duplicates, suppressed, failed, results };
}

/**
 * The delivery collaborator a route or a tick holds.
 *
 * An interface rather than the raw `SendDependencies` so a caller cannot accidentally
 * reach past it into the transport, and so a test can hand in a recorder without building
 * a support port at all.
 */
export interface NotificationDelivery {
  deliver(requests: readonly AnyNotificationRequest[], log?: DeliveryLog): Promise<DeliveryReport>;
}

/**
 * The bindings the delivery collaborator reads.
 *
 * An alias rather than an extending interface: today the only transport is email, and a
 * second channel would add its own bindings here rather than to `EmailTransportEnv`. The
 * name is what callers depend on, so it stays stable when that happens.
 */
export type NotificationDeliveryEnv = EmailTransportEnv;

/**
 * Build the delivery collaborator from the Worker environment.
 *
 * `transport` is `undefined` when `RESEND_API_KEY` or `RESEND_FROM_ADDRESS` is unset. That
 * is a supported deployment: every notification is then claimed, recorded as
 * `no_email_transport_configured`, and visible in the owner's queue. The distinction that
 * matters is between "recorded as not sent" and "never happened", and this is the first
 * of those.
 */
export function createNotificationDelivery(
  env: NotificationDeliveryEnv,
  port: SupportDataPort,
  options: { readonly fetchImpl?: typeof fetch; readonly now?: () => Date } = {},
): NotificationDelivery {
  const transport = createEmailTransport(
    env,
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );
  const deps: SendDependencies = {
    port,
    ...(transport === undefined ? {} : { transport }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return {
    deliver: (requests, log) => deliverNotifications(deps, requests, log),
  };
}

/** A delivery collaborator that records and sends nothing. For a disabled deployment. */
export const NO_DELIVERY: NotificationDelivery = {
  deliver: () => Promise.resolve(EMPTY_REPORT),
};
