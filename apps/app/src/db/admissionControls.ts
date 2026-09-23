/**
 * The customer's own controls over what their workflow admits.
 *
 * `billing/admission.ts` answers whether WE should be doing work for this workspace: is it
 * subscribed, is a payment recovering, is the plan allowance spent. This answers a different
 * question the customer owns: have they asked us to stop, and have they set a ceiling below
 * their plan for the period.
 *
 * It is deliberately a separate gate, for the same reason the billing one sits outside
 * `admitOnce`: the refusals are different answers and the customer needs to know which.
 * "You paused this" is something they undo in one click. "Your automation has hit the
 * ceiling you set" is a safety catch that did its job. Neither is "you have used your plan".
 *
 * ## What pausing does and does not do
 *
 * Pausing stops NEW admissions. It does not touch runs already admitted: those keep their
 * reservation, keep being checked and still reach a verdict. Cancelling them would throw
 * away allowance already spent and evidence already gathered, and would turn a safety
 * control into a destructive one. Every surface that offers the pause has to say this,
 * because "paused" reads to most people as "everything stops".
 *
 * ## Why rejected events are safe to retry
 *
 * A refusal here happens BEFORE `admitOnce`, so nothing is written and no allowance moves.
 * The customer's automation may send the same `event_id` again once they resume, and it
 * will be admitted then — the id is what makes it exactly-once, not the arrival. That is
 * why the refusal is a 429-shaped "not now" rather than a 4xx meaning "never".
 */
import type { Db } from './d1';

export type AdmissionControlRefusal = 'customer_paused' | 'customer_limit_reached';

export interface AdmissionControlVerdict {
  readonly admit: boolean;
  readonly refusal: AdmissionControlRefusal | null;
  /** Plain language for the automation's developer, safe to return in an error body. */
  readonly message: string | null;
  /**
   * The customer's ceiling, handed on to `admitOnce` so the SAME conditional update that
   * arbitrates the plan allowance also arbitrates this. The read below is the policy
   * answer; the reservation is what actually decides under concurrency.
   */
  readonly limitPerPeriod: number | null;
}

const ADMITTED: AdmissionControlVerdict = {
  admit: true,
  refusal: null,
  message: null,
  limitPerPeriod: null,
};

/**
 * Ask whether this workflow is accepting new automatic admissions right now.
 *
 * Reads only. It reserves nothing and writes nothing, so a refusal leaves the workspace
 * exactly as it was and the same event id can be sent again later.
 */
export async function checkCustomerAdmissionControls(
  db: Db,
  params: {
    readonly workspaceId: string;
    readonly workflowId: string;
    /** The allowance period key `checkAdmission` resolved. Never derived here. */
    readonly billingPeriod: string;
    /** The arriving event's id, so a replay of admitted work is not mistaken for new work. */
    readonly externalEventId: string;
  },
): Promise<AdmissionControlVerdict> {
  /*
   * A replay is not new work.
   *
   * Pausing and the ceiling are both about admitting NEW events. An automation retrying
   * something already admitted — which every well-behaved one does — must still get its own
   * result back, not a 429. Refusing it would make a retry of settled, already-paid-for work
   * look like a failure. `admitOnce` will return the existing run; this only has to get out
   * of the way. Proved by BILL-906/907, which both got 429 before this existed.
   */
  const already = await db
    .prepare(
      `SELECT 1 AS hit FROM source_events
        WHERE workspace_id = ? AND external_event_id = ? LIMIT 1`,
    )
    .bind(params.workspaceId, params.externalEventId)
    .first<{ hit: number }>();
  if (already != null) return ADMITTED;

  const row = await db
    .prepare(
      `SELECT admissions_paused_at, admission_limit_per_period
         FROM workflows WHERE workspace_id = ? AND id = ?`,
    )
    .bind(params.workspaceId, params.workflowId)
    .first<{ admissions_paused_at: string | null; admission_limit_per_period: number | null }>();

  if (row == null) return ADMITTED;

  if (row.admissions_paused_at !== null) {
    return {
      admit: false,
      refusal: 'customer_paused',
      limitPerPeriod: null,
      message:
        'New verifications are paused for this workflow by the account owner. Nothing has been charged and nothing was written, so you can send this same event id again once they resume and it will be accepted then. Runs already under way are unaffected and will still reach a verdict.',
    };
  }

  const limit = row.admission_limit_per_period;
  if (limit === null) return ADMITTED;

  /*
   * Counted from the entitlement row for this period, not from a date comparison on `runs`.
   *
   * The first version of this compared `created_at >= <period start>` and was silently
   * always zero, because what the route has is the period KEY — a date like `2026-10-05`,
   * the period's END — and no period START is exported anywhere. Deriving one here would be
   * a second spelling of the boundary arithmetic, which is precisely the A13-010 defect:
   * the usage page read `YYYY-MM` while billing wrote `YYYY-MM-DD` and reported 0 used
   * forever. `consumed + reserved` on the period's own row is the authoritative count and
   * needs no arithmetic at all.
   *
   * It therefore counts every admission in the period, test verifications included. That is
   * the honest reading of a ceiling whose purpose is "my allowance cannot drain without me
   * noticing": a run is a run, whoever started it.
   */
  const entitlement = await db
    .prepare(
      `SELECT consumed, reserved FROM entitlements
        WHERE workspace_id = ? AND billing_period = ?`,
    )
    .bind(params.workspaceId, params.billingPeriod)
    .first<{ consumed: number; reserved: number }>();

  const admitted = Number(entitlement?.consumed ?? 0) + Number(entitlement?.reserved ?? 0);
  if (admitted < limit) return { admit: true, refusal: null, message: null, limitPerPeriod: limit };

  return {
    admit: false,
    refusal: 'customer_limit_reached',
    limitPerPeriod: limit,
    message: `This workflow has reached the limit of ${String(limit)} verifications the account owner set for this billing period. Nothing has been charged and nothing was written, so this event id can be sent again once the limit is raised or the period rolls over. Runs already under way are unaffected.`,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Whether a usage warning should be sent, and under which key.
 *
 * Thresholds are crossings, not states: a workspace at 92% is past 75% and past 90%, and a
 * customer needs one warning, not one per event for the rest of the month. The key records
 * the highest threshold already announced for this period, so the send is at-most-once per
 * threshold per period — the same "remember what you already did" shape as the outbox's
 * unique event key.
 *
 * Returns null when nothing should be sent, which is the common case by a wide margin.
 */
export const USAGE_ALERT_THRESHOLDS = [75, 90, 100] as const;

export function usageAlertKeyFor(
  billingPeriod: string,
  used: number,
  limit: number,
  alreadySent: string | null,
): { key: string; threshold: number } | null {
  if (limit <= 0) return null;
  const percent = Math.floor((used / limit) * 100);
  let crossed: number | null = null;
  for (const threshold of USAGE_ALERT_THRESHOLDS) {
    if (percent >= threshold) crossed = threshold;
  }
  if (crossed === null) return null;

  const key = `${billingPeriod}:${String(crossed)}`;
  if (alreadySent === key) return null;

  // A lower threshold than one already announced this period is not news. Comparing the
  // stored threshold rather than the whole key means a period rollover still alerts.
  if (alreadySent !== null) {
    const [sentPeriod, sentThreshold] = alreadySent.split(':');
    if (sentPeriod === billingPeriod && Number(sentThreshold ?? 0) >= crossed) return null;
  }
  return { key, threshold: crossed };
}
