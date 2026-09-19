/**
 * All the money work a cron tick must drive, behind **one call**.
 *
 * ## Why one call and not four
 *
 * Four functions were written, tested and correct, and between them they had zero callers:
 * `reconcileSubscriptions()`, `expirePaymentRecoveryWindows()`, `runBillingMaintenance()`
 * — which was itself written to be the single call and then never called — and now the
 * allowance repair. Day 8 never arrived. The reconciliation half of a promise made to
 * customers in `policy.ts` never ran.
 *
 * Handing A03 a list of jobs and a cadence to remember is how that recurs. This is one
 * function. `scheduler/tick.ts` calls it and does nothing else, and the report it returns
 * says what actually ran.
 *
 * ## What runs, and when
 *
 * | Job | Cadence | Why that cadence |
 * | --- | --- | --- |
 * | Payment-recovery expiry (day 8) | hourly | The window is seven *days*. A minute cadence would be 60× the scans for at most an hour less latency on a boundary measured in days. |
 * | Subscription reconciliation | every 15 minutes | One provider call per subscription, so it is the expensive one — and it is the second route by which a customer's payment can resume, so hours of latency would be felt by somebody who has paid. |
 * | Allowance repair | every 30 minutes | Idempotent and bounded. It exists to drain a finite backlog of rows damaged by A13-010, and it must keep running afterwards because the damage is only detectable by comparing counters to runs. |
 *
 * `runBillingMaintenance` owns the first two cadences; this owns the third and the
 * composition. The cadences live next to the money decisions rather than in the scheduler,
 * because how often you check whether a customer has been suspended is a money decision.
 *
 * ## It never throws
 *
 * A cron handler that rejects buys a retry we did not ask for and cannot bound, and an
 * unbounded retry on a minute cron is how a quiet bug becomes a bill. Every job is isolated
 * and its failure is reported. One job failing must not stop the others — least of all the
 * day-8 sweep, which is the one with a customer waiting on the other side of it.
 */
import { runBillingMaintenance, type BillingMaintenanceReport } from '../billing/scheduled';
import type { BillingRuntime } from '../billing/runtime';
import {
  reconcileAllowancePeriods,
  type AllowanceReconciliationReport,
} from './periodReconciliation';
import type { AllowanceRepairPort } from './ports';

/** The allowance repair runs when the minute is divisible by this. */
export const ALLOWANCE_REPAIR_EVERY_MINUTES = 30;

export interface MoneyMaintenanceDeps {
  readonly billing: BillingRuntime;
  /**
   * Optional. When absent the allowance repair is **skipped and reported as skipped**,
   * never silently treated as done — a deployment without the repair port is a deployment
   * where rows damaged by A13-010 are still damaged, and the report has to say so.
   */
  readonly allowanceRepair?: AllowanceRepairPort | undefined;
}

export interface MoneyMaintenanceOptions {
  readonly now?: string;
  /** Run every job regardless of the minute. For tests and for a manual owner trigger. */
  readonly force?: boolean;
  readonly workspaceLimit?: number;
}

export interface MoneyMaintenanceReport {
  readonly at: string;
  readonly billing: BillingMaintenanceReport;
  readonly ranAllowanceRepair: boolean;
  readonly allowanceRepair: AllowanceReconciliationReport | null;
  /**
   * Why the allowance repair did not run, when it did not. `null` when it did.
   * `'no_port'` is a configuration fact the owner needs, not an absence to shrug at.
   */
  readonly allowanceRepairSkipped: 'not_due' | 'no_port' | null;
  readonly failures: readonly { readonly job: string; readonly error: string }[];
}

/**
 * Run whatever money maintenance is due at this tick.
 *
 * **This is the export `scheduler/tick.ts` calls.** One line:
 *
 *     const money = await runMoneyMaintenance(deps.money, { now: toIso(deps.now) });
 */
export async function runMoneyMaintenance(
  deps: MoneyMaintenanceDeps,
  options: MoneyMaintenanceOptions = {},
): Promise<MoneyMaintenanceReport> {
  const at = options.now ?? deps.billing.now();
  const force = options.force ?? false;
  const failures: { job: string; error: string }[] = [];

  /*
   * THE TICK INSTANT IS THE ONLY CLOCK.
   *
   * `runBillingMaintenance` takes `now` and uses it to decide which jobs are *due*, but
   * the jobs themselves read `deps.now()` — so a runtime whose clock differs from the tick
   * instant decides the cadence from one clock and the seven-day boundary from another. In
   * production both are the system clock and the two agree, which is exactly why this
   * would never be noticed until it mattered: a replay, a backfill, or an owner-triggered
   * run at a chosen instant would sweep against the wrong day.
   *
   * Pinning the runtime's clock to the tick instant makes the two the same fact. Reported
   * to A06 as a latent defect in `billing/scheduled.ts`; this is not a workaround for it
   * but the correct shape either way — a scheduled job should have exactly one "now".
   */
  const pinned: BillingRuntime = { ...deps.billing, now: () => at };

  let billing: BillingMaintenanceReport;
  try {
    billing = await runBillingMaintenance(pinned, { now: at, force });
  } catch (error) {
    // `runBillingMaintenance` documents that it never throws. Belt and braces: if that
    // ever stops being true, the allowance repair still runs.
    failures.push({ job: 'billing_maintenance', error: describe(error) });
    billing = {
      at,
      ranReconciliation: false,
      ranRecoverySweep: false,
      reconciliation: null,
      recoverySweep: null,
      failures: [],
    };
  }
  failures.push(...billing.failures);

  const minute = new Date(at).getUTCMinutes();
  const due = force || minute % ALLOWANCE_REPAIR_EVERY_MINUTES === 0;

  if (deps.allowanceRepair === undefined) {
    return {
      at,
      billing,
      ranAllowanceRepair: false,
      allowanceRepair: null,
      allowanceRepairSkipped: 'no_port',
      failures,
    };
  }
  if (!due) {
    return {
      at,
      billing,
      ranAllowanceRepair: false,
      allowanceRepair: null,
      allowanceRepairSkipped: 'not_due',
      failures,
    };
  }

  let allowanceRepair: AllowanceReconciliationReport | null = null;
  try {
    allowanceRepair = await reconcileAllowancePeriods(deps.allowanceRepair, {
      now: at,
      environment: pinned.config.environment,
      ...(options.workspaceLimit === undefined ? {} : { workspaceLimit: options.workspaceLimit }),
    });
    failures.push(
      ...allowanceRepair.failures.map((failure) => ({
        job: `allowance_repair:${failure.workspaceId}`,
        error: failure.error,
      })),
    );
  } catch (error) {
    failures.push({ job: 'allowance_repair', error: describe(error) });
  }

  return {
    at,
    billing,
    ranAllowanceRepair: true,
    allowanceRepair,
    allowanceRepairSkipped: null,
    failures,
  };
}

/**
 * One structured line per tick, for the Worker log.
 *
 * A tick that did nothing still says so, because a silent scheduler and a stopped
 * scheduler look identical in a log.
 */
export function moneyMaintenanceLogLine(report: MoneyMaintenanceReport): Record<string, unknown> {
  return {
    at: report.at,
    reconciliation_ran: report.billing.ranReconciliation,
    subscriptions_examined: report.billing.reconciliation?.examined ?? 0,
    payments_recovered: report.billing.reconciliation?.recovered.length ?? 0,
    discrepancies: report.billing.reconciliation?.discrepancies.length ?? 0,
    recovery_sweep_ran: report.billing.ranRecoverySweep,
    suspended_on_day_eight: report.billing.recoverySweep?.suspended.length ?? 0,
    notifications_built: report.billing.recoverySweep?.notifications.length ?? 0,
    allowance_repair_ran: report.ranAllowanceRepair,
    allowance_repair_skipped: report.allowanceRepairSkipped,
    allowance_rows_folded: report.allowanceRepair?.folds.length ?? 0,
    allowance_rows_repaired:
      report.allowanceRepair?.repairs.filter((r) => r.outcome === 'repaired').length ?? 0,
    failures: report.failures.length,
  };
}

/**
 * The notifications this tick produced, for A09's sender to claim and dispatch.
 *
 * Returned rather than sent, so the scheduler keeps one place where outbound mail happens.
 * Building one sends nothing; `sendNotification` claims the key and sends at most once.
 */
export function moneyMaintenanceNotifications(report: MoneyMaintenanceReport) {
  return report.billing.recoverySweep?.notifications ?? [];
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
}
