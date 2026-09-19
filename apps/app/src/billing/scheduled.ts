/**
 * The billing work the cron tick must drive, behind one call.
 *
 * ## Why one entry point rather than two exported jobs
 *
 * `reconcileSubscriptions()` and `expirePaymentRecoveryWindows()` were both correct and
 * both had no caller, so day 8 never arrived and the reconciliation half of the resume
 * promise never ran. Handing A03 two functions plus a cadence to remember is how that
 * recurs. This is one function, called every tick, that owns its own cadence — because the
 * cadence is a money decision, not a scheduling one.
 *
 * A03's tick calls `runBillingMaintenance(runtime, { now })` and does nothing else.
 *
 * ## The cadences, and why
 *
 * | Job | Cadence | Why |
 * | --- | --- | --- |
 * | Payment-recovery expiry (day 8) | hourly | The window is seven *days*. Running it every minute would be 60× the scans for at most an hour's less latency on a boundary measured in days. Idempotent, so cadence only affects latency. |
 * | Subscription reconciliation | every 15 minutes | It makes one provider call per subscription, so it is the expensive one. It is also the safety net for a missed webhook and the second route by which a payment can resume, so hours of latency would be felt by a paying customer. |
 *
 * Both are skipped entirely when billing is not configured, so an unconfigured development
 * Worker does no provider work on its tick.
 */
import { expirePaymentRecoveryWindows, type RecoverySweepReport } from './recovery';
import { reconcileSubscriptions, type ReconciliationReport } from './reconcile';
import type { BillingRuntime } from './runtime';

/** Reconciliation runs when the minute is divisible by this. */
export const RECONCILE_EVERY_MINUTES = 15;

/** The minute of the hour the day-8 sweep runs on. Off the hour, away from renewal spikes. */
export const RECOVERY_SWEEP_MINUTE = 7;

export interface BillingMaintenanceOptions {
  /** The tick instant. Defaults to the runtime clock. */
  readonly now?: string;
  /** Run every job regardless of the minute. For tests and for a manual owner trigger. */
  readonly force?: boolean;
  readonly reconcileLimit?: number;
  readonly sweepLimit?: number;
}

export interface BillingMaintenanceReport {
  readonly at: string;
  readonly ranReconciliation: boolean;
  readonly ranRecoverySweep: boolean;
  readonly reconciliation: ReconciliationReport | null;
  readonly recoverySweep: RecoverySweepReport | null;
  /** Non-fatal failures. One job failing must never stop the other. */
  readonly failures: readonly { readonly job: string; readonly error: string }[];
}

/**
 * Run whatever billing maintenance is due at this tick.
 *
 * Never throws. A cron tick that throws stops every other job in the same tick, so each
 * job is isolated and its failure is reported rather than propagated — the scheduler's
 * other work is not ours to break.
 */
export async function runBillingMaintenance(
  deps: BillingRuntime,
  options: BillingMaintenanceOptions = {},
): Promise<BillingMaintenanceReport> {
  const at = options.now ?? deps.now();
  const minute = new Date(at).getUTCMinutes();
  const force = options.force ?? false;

  const dueReconcile = force || minute % RECONCILE_EVERY_MINUTES === 0;
  const dueSweep = force || minute === RECOVERY_SWEEP_MINUTE;

  const failures: { job: string; error: string }[] = [];
  let reconciliation: ReconciliationReport | null = null;
  let recoverySweep: RecoverySweepReport | null = null;

  if (dueSweep) {
    try {
      recoverySweep = await expirePaymentRecoveryWindows(deps, {
        limit: options.sweepLimit ?? 100,
        ...(deps.billingContact === undefined
          ? {}
          : { billingContact: deps.billingContact }),
      });
    } catch (error) {
      failures.push({ job: 'payment_recovery_sweep', error: describe(error) });
    }
  }

  if (dueReconcile) {
    try {
      reconciliation = await reconcileSubscriptions(deps, {
        limit: options.reconcileLimit ?? 50,
      });
    } catch (error) {
      failures.push({ job: 'subscription_reconciliation', error: describe(error) });
    }
  }

  return {
    at,
    ranReconciliation: dueReconcile,
    ranRecoverySweep: dueSweep,
    reconciliation,
    recoverySweep,
    failures,
  };
}

/**
 * Notifications the tick should enqueue, flattened out of the report.
 *
 * Building one sends nothing; A09's `sendNotification` claims the key and does the sending,
 * once ever. Returned rather than sent here so the scheduler keeps one place where outbound
 * mail happens.
 */
export function maintenanceNotifications(report: BillingMaintenanceReport) {
  return report.recoverySweep?.notifications ?? [];
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error;
}
