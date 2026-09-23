/**
 * The usage warning's retry, on a path that does not need another admission.
 *
 * ## The gap this closes
 *
 * The admission path evaluates the warning after a successful admission, which is the one
 * moment usage changes. That is correct and it is not sufficient: the two moments a customer
 * most needs this warning are the two where admissions have stopped.
 *
 *  - **Allowance exhausted.** Nothing is admitted any more, so the "you have reached your
 *    allowance" warning, if its first attempt failed, could never be attempted again.
 *  - **Customer ceiling reached.** Same shape, for the same reason.
 *
 * A retry that only fires on the next successful admission is therefore no retry at all
 * exactly when it matters. This pass runs on the scheduler tick, which keeps running when
 * admissions have stopped.
 *
 * ## Bounded, and still deduplicated
 *
 * Each attempt carries its own notification key, `usage:<ws>:<period>:<threshold>#<n>`. The
 * delivery rows are therefore the attempt count: the dispatcher still refuses to send one
 * key twice, a `sent` row anywhere in the series ends the series for good, and
 * `MAX_USAGE_ALERT_ATTEMPTS` bounds the rest. Nothing is released and nothing is deleted, so
 * the history a bound is computed from cannot be erased by the retry itself.
 */
import { workflows } from '../db/workflows';
import { resolveAllowancePeriodKey, type SubscriptionPeriodSource } from '../billing/period';
import { recordUsageAlertSent, usageAlertFor, type UsageAlertRequest } from '../db/usageAlerts';
import type { Db } from '../db/d1';

export interface UsageAlertPassReport {
  readonly examined: number;
  readonly attempted: number;
  readonly sent: number;
}

export interface UsageAlertPassDeps {
  readonly db: Db;
  /**
   * The subscription source the period key is read from.
   *
   * Asked rather than derived. Nothing under `scheduler/` may compute an allowance period
   * key of its own — three modules each computing one from a different input is the
   * A13-010 defect, and PERSIST-375 enforces the absence by name. `resolveAllowancePeriodKey`
   * is the one module that owns it, and PERSIST-376 blesses exactly this call.
   */
  readonly billing: SubscriptionPeriodSource;
  readonly billingEnvironment: 'test' | 'live';
  /** Injected clock: nothing here reads a wall clock for business time. */
  readonly now: Date;
  readonly billingContact: (
    workspaceId: string,
  ) => Promise<{ workspaceName: string; email: string } | null>;
  readonly send: (
    request: UsageAlertRequest,
  ) => Promise<{ outcome: 'sent' | 'duplicate' | 'suppressed' | 'failed' }>;
  /** Kept small: this is a courtesy pass sharing a tick with the work that earns money. */
  readonly limit?: number;
}

const EMPTY: UsageAlertPassReport = { examined: 0, attempted: 0, sent: 0 };

export async function runUsageAlertPass(
  deps: UsageAlertPassDeps,
): Promise<UsageAlertPassReport> {
  const limit = deps.limit ?? 20;
  const candidates = await workflows.listActiveForAlerts(deps.db, limit);
  if (candidates.length === 0) return EMPTY;

  let attempted = 0;
  let sent = 0;

  for (const candidate of candidates) {
    const period = await resolveAllowancePeriodKey(deps.billing, {
      workspaceId: candidate.workspace_id,
      atIso: deps.now.toISOString(),
      environment: deps.billingEnvironment,
    });
    // No subscription means no allowance row, so there is nothing a warning could be about.
    if (period.key === null) continue;
    const billingPeriod = period.key;

    const alert = await usageAlertFor(deps.db, {
      workspaceId: candidate.workspace_id,
      workflowId: candidate.id,
      billingPeriod,
      billingContact: deps.billingContact,
    });
    // Null is the overwhelmingly common answer: nothing crossed, already delivered, or the
    // attempt bound is spent. All three mean this pass has nothing to do here.
    if (alert === null) continue;

    attempted += 1;
    const outcome = await deps.send(alert);
    if (outcome.outcome === 'sent') {
      sent += 1;
      await recordUsageAlertSent(deps.db, {
        workspaceId: candidate.workspace_id,
        workflowId: candidate.id,
        alertKey: alert.alertKey,
      });
    }
  }

  return { examined: candidates.length, attempted, sent };
}
