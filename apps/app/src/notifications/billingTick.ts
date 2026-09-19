/**
 * The cron half of the notification wiring.
 *
 * ## What had no caller
 *
 * `billing/scheduled.ts` states its own contract in its docblock: *"A03's tick calls
 * `runBillingMaintenance(runtime, { now })` and does nothing else."* Nothing did. So
 * `expirePaymentRecoveryWindows()` never ran — day 8 of the payment-recovery window never
 * arrived, no subscription was ever marked `unpaid`, and the day-8 `payment_problem`
 * notification was built by a function with no caller. `reconcileSubscriptions()` never ran
 * either, which is why `templates.ts` carries a written-in qualification telling customers
 * the automatic resume check is unfinished.
 *
 * This file is that caller, plus the delivery of what it produces.
 *
 * ## What it deliberately does not do
 *
 *  - It does not decide the cadence. `runBillingMaintenance` owns that, because the cadence
 *    is a money decision (`RECOVERY_SWEEP_MINUTE`, `RECONCILE_EVERY_MINUTES`), not a
 *    scheduling one.
 *  - It does not reconcile allowances, re-key billing periods, or write a subscription.
 *    Every write in the pass belongs to the money path and is reached through its own
 *    functions, unchanged.
 *  - It does not run at all on a deployment without Stripe secrets. An unconfigured Worker
 *    makes no provider calls on its tick.
 *
 * ## Why a failure here is a number, not an exception
 *
 * A scheduled handler that rejects buys a retry we do not control. Every branch returns a
 * report; `skipped` and a populated `failures` list are how the operator sees a tick that
 * did nothing, which is otherwise indistinguishable from a tick that ran cleanly.
 */
import { createStripeClient } from '@verify/connectors/stripe';
import {
  runBillingMaintenance,
  maintenanceNotifications,
  type BillingMaintenanceReport,
} from '../billing/scheduled';
import { checkBillingSecrets, createBillingRuntime, type BillingEnv } from '../billing/mount';
import type { BillingDataPort } from '../billing/port';
import type { BillingContactLookup } from '../billing/runtime';
import type { SupportDataPort } from '../support/port';
import {
  createNotificationDelivery,
  type DeliveryLog,
  type DeliveryReport,
  type NotificationDelivery,
  type NotificationDeliveryEnv,
} from './delivery';

export interface BillingNotificationEnv extends BillingEnv, NotificationDeliveryEnv {}

export interface BillingNotificationTickReport {
  /** Why nothing ran, or `null` when the pass ran. */
  readonly skipped: 'billing_not_configured' | null;
  readonly maintenance: BillingMaintenanceReport | null;
  readonly delivery: DeliveryReport | null;
  readonly failures: readonly { readonly job: string; readonly error: string }[];
}

const SKIPPED: BillingNotificationTickReport = {
  skipped: 'billing_not_configured',
  maintenance: null,
  delivery: null,
  failures: [],
};

export interface BillingNotificationTickDeps {
  readonly env: BillingNotificationEnv;
  readonly billingData: BillingDataPort;
  readonly supportPort: SupportDataPort;
  readonly billingContact: BillingContactLookup;
  readonly newId: (prefix: string) => string;
  /** The tick instant, ISO-8601 UTC. Production passes the cron's own scheduled time. */
  readonly now: string;
  /** Overridden in tests so no Resend client is built and no transport is constructed. */
  readonly delivery?: NotificationDelivery | undefined;
  readonly log?: DeliveryLog | undefined;
  /** Run every job regardless of the minute. Tests and the owner's manual trigger. */
  readonly force?: boolean;
}

/**
 * Run the billing maintenance the tick owes, and send what it produces.
 *
 * The day-8 `payment_problem` notification is keyed on
 * `payment_problem:<workspace>:<window start>:suspended`, which contains no clock. So an
 * hourly sweep that finds the same expired window on the next pass — or a sweep that
 * overlaps a webhook reporting the same failure — claims a key that already exists and
 * sends nothing. Cadence affects latency here and never the number of emails.
 */
export async function runBillingNotificationTick(
  deps: BillingNotificationTickDeps,
): Promise<BillingNotificationTickReport> {
  if (!checkBillingSecrets(deps.env).ready) return SKIPPED;

  const failures: { job: string; error: string }[] = [];

  let runtime;
  try {
    runtime = createBillingRuntime(deps.env, {
      data: deps.billingData,
      // Built from the configured secret. `runBillingMaintenance`'s reconciliation pass is
      // the only thing that calls it, and it is the second route by which a confirmed
      // payment can resume a paused workspace.
      gateway: createStripeClient({ secretKey: deps.env.STRIPE_SECRET_KEY ?? '' }),
      billingContact: deps.billingContact,
      newId: deps.newId,
      now: () => deps.now,
    });
  } catch (error) {
    // `buildBillingConfig` throws on a malformed price id or base URL. A tick must not.
    return {
      skipped: null,
      maintenance: null,
      delivery: null,
      failures: [{ job: 'billing_runtime', error: describe(error) }],
    };
  }

  let maintenance: BillingMaintenanceReport | null = null;
  try {
    maintenance = await runBillingMaintenance(runtime, {
      now: deps.now,
      ...(deps.force === undefined ? {} : { force: deps.force }),
    });
    failures.push(...maintenance.failures);
  } catch (error) {
    failures.push({ job: 'billing_maintenance', error: describe(error) });
  }

  if (maintenance === null) {
    return { skipped: null, maintenance: null, delivery: null, failures };
  }

  const requests = maintenanceNotifications(maintenance);
  if (requests.length === 0) {
    return { skipped: null, maintenance, delivery: null, failures };
  }

  const delivery =
    deps.delivery ??
    createNotificationDelivery(deps.env, deps.supportPort, {
      now: () => new Date(deps.now),
    });

  let report: DeliveryReport | null = null;
  try {
    report = await delivery.deliver(requests, deps.log);
  } catch (error) {
    failures.push({ job: 'notification_delivery', error: describe(error) });
  }

  return { skipped: null, maintenance, delivery: report, failures };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error;
}
