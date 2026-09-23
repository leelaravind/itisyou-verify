/**
 * The usage warning, wired to the path that actually changes usage.
 *
 * `allowance_approaching` and `allowance_reached` have existed as templates, with variables
 * and rendering, and **nothing has ever sent one**. That is the same shape as the
 * payment-recovery logic an auditor found earlier in this project: correct, tested, and
 * consulted by no request path. A warning nobody sends is a template in a file.
 *
 * This evaluates after a successful admission — the one moment usage changes — and hands
 * back a notification request, or null. It sends nothing itself, so the caller keeps control
 * of the transport and a failure here can never cost the event its 202.
 *
 * ## Why two layers of deduplication
 *
 * `sendNotification` already claims its `notificationKey` once ever, so the transport cannot
 * send the same key twice. The stored `usage_alert_key` on the workflow is the cheaper
 * short-circuit in front of it: without it, every admission for the rest of the period would
 * build and render a message purely to have the claim reject it. One of these is correctness
 * and the other is not doing pointless work; both are worth having, and neither is a
 * substitute for the other.
 */
import { usageAlertKeyFor } from './admissionControls';
import type { Db } from './d1';

/**
 * How many times one threshold's warning may be attempted before we stop.
 *
 * Bounded because the alternative is a warning that retries every scheduler tick for the
 * rest of the billing period against a provider that is not going to accept it.
 */
export const MAX_USAGE_ALERT_ATTEMPTS = 4;

export interface UsageAlertRequest {
  readonly notificationKey: string;
  readonly workspaceId: string;
  readonly recipientEmail: string;
  readonly template: 'allowance_approaching' | 'allowance_reached';
  readonly vars: {
    readonly workspaceName: string;
    readonly runsUsed: number;
    readonly periodEndsAt: string;
  };
  /** Written back only once the send has actually been attempted and not deduplicated. */
  readonly alertKey: string;
}

/** Where the workspace's billing contact comes from. Optional, exactly as owner alerts are. */
export type BillingContactResolver = (
  workspaceId: string,
) => Promise<{ workspaceName: string; email: string } | null>;

/**
 * Decide whether this admission should warn the customer, and about what.
 *
 * Reads only. Returns null in the overwhelmingly common case that nothing has been crossed.
 */
export async function usageAlertFor(
  db: Db,
  params: {
    readonly workspaceId: string;
    readonly workflowId: string;
    readonly billingPeriod: string;
    readonly billingContact: BillingContactResolver;
  },
): Promise<UsageAlertRequest | null> {
  const entitlement = await db
    .prepare(
      `SELECT run_limit, consumed, reserved FROM entitlements
        WHERE workspace_id = ? AND billing_period = ?`,
    )
    .bind(params.workspaceId, params.billingPeriod)
    .first<{ run_limit: number; consumed: number; reserved: number }>();
  if (entitlement == null) return null;

  const workflow = await db
    .prepare(`SELECT usage_alert_key FROM workflows WHERE workspace_id = ? AND id = ?`)
    .bind(params.workspaceId, params.workflowId)
    .first<{ usage_alert_key: string | null }>();

  const used = Number(entitlement.consumed) + Number(entitlement.reserved);
  const crossing = usageAlertKeyFor(
    params.billingPeriod,
    used,
    Number(entitlement.run_limit),
    workflow?.usage_alert_key ?? null,
  );
  if (crossing === null) return null;

  /*
   * Attempts, counted from the delivery rows themselves.
   *
   * `releaseUndelivered` DELETES the row it releases, so releasing a failed key and trying
   * again leaves no memory of having tried — an unbounded loop wearing the same name every
   * time. Each attempt instead gets its own key, `<base>#<n>`, so the rows ARE the count:
   * deduplication still holds within an attempt, a `sent` row anywhere in the series ends
   * the series, and the bound is arithmetic rather than a promise.
   */
  const base = `usage:${params.workspaceId}:${crossing.key}`;
  const attempts = await db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent
         FROM notification_deliveries
        WHERE workspace_id = ? AND notification_key LIKE ?`,
    )
    .bind(params.workspaceId, `${base}#%`)
    .first<{ n: number; sent: number | null }>();

  const made = Number(attempts?.n ?? 0);
  if (Number(attempts?.sent ?? 0) > 0) return null; // already delivered; never again
  if (made >= MAX_USAGE_ALERT_ATTEMPTS) return null; // bounded, and we stop

  const contact = await params.billingContact(params.workspaceId);
  // No contact is not an error and must not cost the event its 202. It is a workspace we
  // cannot write to, which the notification layer would record as unusable anyway.
  if (contact === null) return null;

  return {
    // Derived from the event — the period, the threshold and which attempt this is — never
    // from the clock, which is the rule `SendRequest.notificationKey` states. Two evaluations
    // of the same attempt produce the same key and the dispatcher sends once.
    notificationKey: `${base}#${String(made + 1)}`,
    workspaceId: params.workspaceId,
    recipientEmail: contact.email,
    template: crossing.threshold >= 100 ? 'allowance_reached' : 'allowance_approaching',
    vars: {
      workspaceName: contact.workspaceName,
      runsUsed: used,
      periodEndsAt: params.billingPeriod,
    },
    alertKey: crossing.key,
  };
}

/**
 * Record that this threshold has been announced.
 *
 * Written after the attempt rather than before it, and only when the transport did not
 * report a hard failure — so a send that failed can be tried again on the next admission
 * rather than being silently marked as done.
 */
export async function recordUsageAlertSent(
  db: Db,
  params: { workspaceId: string; workflowId: string; alertKey: string },
): Promise<void> {
  await db
    .prepare(`UPDATE workflows SET usage_alert_key = ? WHERE workspace_id = ? AND id = ?`)
    .bind(params.alertKey, params.workspaceId, params.workflowId)
    .run();
}
