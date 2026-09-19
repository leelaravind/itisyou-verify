/**
 * The allowance period key. **One function, one spelling, one place.**
 *
 * ## The defect this file exists to end (A13-010)
 *
 * Billing opened allowance rows keyed `YYYY-MM-DD` (the date the paid period ends). The
 * scheduler settled them keyed `YYYY-MM` (the calendar month of the run), and the customer
 * usage page read them the same way. The keys never matched, so `settleReservation` never
 * found the row it was settling: reservations were never converted to consumption, and a
 * workspace sitting at its limit reported itself unblocked. Two spellings of one key is the
 * same class of defect as two hashes of one payload.
 *
 * Nothing outside this file may derive an allowance period key. If you find yourself
 * writing `.slice(0, 7)` or `.slice(0, 10)` against a date to get one, that is the bug.
 *
 * ## Why the period *end*, and why not the calendar month
 *
 * A calendar month is wrong on the facts. Stripe anchors a subscription's billing cycle to
 * the day it started, so a customer who subscribes on the 20th is billed 20th to 20th. A
 * `YYYY-MM` key would roll their allowance over on the 1st — a week early, twice: once
 * giving them runs they have not paid for, and once cutting them off before their period
 * actually ends.
 *
 * The end rather than the start, because the two Stripe sources that describe one period
 * both report the end *exactly* — `customer.subscription.*` carries
 * `items.data[].current_period_end` and `invoice.paid` carries its line item's
 * `period.end` — while neither carries a start the other agrees with. Deriving a start by
 * stepping a month backwards lands on a 30- or 31-day boundary depending on the month, so
 * the two sources produced two different keys for one period and
 * `UNIQUE (workspace_id, billing_period)` let both rows exist. That was 1,000 runs sold for
 * one £29 payment.
 *
 * ## The two entry points
 *
 * - `allowancePeriodKey(periodEndIso)` — when you are holding provider evidence of the
 *   period end. This is what opens the row.
 * - `allowancePeriodKeyAt(atIso, currentPeriodEndIso)` — when you are holding an instant
 *   and need the period that contained it. This is what settles and releases.
 *
 * They agree by construction: for any `at` inside the current period,
 * `allowancePeriodKeyAt(at, end) === allowancePeriodKey(end)`. And `...At` keeps working
 * after the subscription has rolled forward, because boundaries are computed from the
 * anchor day rather than by subtracting elapsed time — which is also how Stripe computes
 * them (a 31st anchor gives 31 Jan, 28 Feb, 31 Mar).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The key an allowance period is stored under: the UTC date the paid period ends.
 *
 * The one primitive. `billingPeriodKey` in `state.ts` is the generic date extractor this
 * is built on; this is the named-for-purpose entry point, and it is what every caller
 * should use.
 */
export function allowancePeriodKey(periodEndIso: string): string {
  const day = periodEndIso.slice(0, 10);
  if (!ISO_DATE.test(day)) {
    throw new TypeError(
      `allowancePeriodKey needs an ISO-8601 instant, received: ${String(periodEndIso)}`,
    );
  }
  return day;
}

interface Anchor {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly ms: number;
}

function anchorOf(currentPeriodEndIso: string): Anchor {
  const parsed = Date.parse(currentPeriodEndIso);
  if (Number.isNaN(parsed)) {
    throw new TypeError(
      `allowancePeriodKeyAt needs an ISO-8601 period end, received: ${String(currentPeriodEndIso)}`,
    );
  }
  const date = new Date(parsed);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    // Time-of-day carried as milliseconds past midnight, so boundaries keep their instant.
    ms:
      date.getUTCHours() * 3_600_000 +
      date.getUTCMinutes() * 60_000 +
      date.getUTCSeconds() * 1_000 +
      date.getUTCMilliseconds(),
  };
}

/**
 * The `k`-th billing boundary from the anchor, in epoch milliseconds.
 *
 * The day is clamped into the target month rather than allowed to overflow, so a 31st
 * anchor gives 28 February and then 31 March — never 3 March. Stripe does the same, and a
 * boundary that drifted would silently move a customer's renewal date.
 */
function boundaryAt(anchor: Anchor, k: number): number {
  const absolute = anchor.year * 12 + anchor.month + k;
  const year = Math.floor(absolute / 12);
  const month = ((absolute % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(anchor.day, daysInMonth)) + anchor.ms;
}

/** How far the search may walk before we call it a bug rather than a long gap. */
const MAX_BOUNDARY_STEPS = 1_200; // a century either way

/**
 * The allowance period key for the period that contained `atIso`.
 *
 * A run belongs to the period ending at the **first boundary strictly after** it, which is
 * the same rule Stripe bills on. In the normal case — a run admitted inside the current
 * period — this returns exactly `allowancePeriodKey(currentPeriodEndIso)`. After the
 * subscription has rolled forward it steps back to the boundary that contained the run, so
 * a settle that happens after a renewal still finds the row the reservation was taken from.
 */
export function allowancePeriodKeyAt(atIso: string, currentPeriodEndIso: string): string {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) {
    throw new TypeError(
      `allowancePeriodKeyAt needs an ISO-8601 instant, received: ${String(atIso)}`,
    );
  }
  const anchor = anchorOf(currentPeriodEndIso);

  // Start from a close estimate, then correct. Both loops are bounded; an unbounded walk
  // over a corrupt date is a hang, and a hang on the settle path is an outage.
  const atDate = new Date(at);
  let k = (atDate.getUTCFullYear() - anchor.year) * 12 + (atDate.getUTCMonth() - anchor.month) - 1;

  let steps = 0;
  while (boundaryAt(anchor, k) <= at) {
    k += 1;
    if ((steps += 1) > MAX_BOUNDARY_STEPS) {
      throw new RangeError('allowancePeriodKeyAt could not find a boundary; check the inputs');
    }
  }
  steps = 0;
  while (boundaryAt(anchor, k - 1) > at) {
    k -= 1;
    if ((steps += 1) > MAX_BOUNDARY_STEPS) {
      throw new RangeError('allowancePeriodKeyAt could not find a boundary; check the inputs');
    }
  }

  return allowancePeriodKey(new Date(boundaryAt(anchor, k)).toISOString());
}

/**
 * The narrowest slice of `BillingDataPort` the resolver needs.
 *
 * Declared structurally so the scheduler can pass `D1BillingDataPort` without depending on
 * the billing module's whole surface.
 */
export interface SubscriptionPeriodSource {
  findSubscriptionForWorkspace(
    workspaceId: string,
    environment: 'test' | 'live',
  ): Promise<{ readonly currentPeriodEnd: string | null } | null>;
}

export type AllowancePeriodResolution =
  | { readonly key: string; readonly reason: 'resolved' }
  | { readonly key: null; readonly reason: 'no_subscription' | 'no_period_end' };

/**
 * One call for a caller holding only a workspace and an instant.
 *
 * This is the shape the scheduler's settle and release paths should use: they know the run
 * and its creation time, and nothing else about billing.
 *
 * Returns `null` with a reason rather than throwing or guessing. A workspace with no
 * subscription has no allowance row either, so there is nothing to settle — and inventing a
 * key would write to a row that should not exist.
 */
export async function resolveAllowancePeriodKey(
  source: SubscriptionPeriodSource,
  params: {
    readonly workspaceId: string;
    readonly atIso: string;
    readonly environment: 'test' | 'live';
  },
): Promise<AllowancePeriodResolution> {
  const subscription = await source.findSubscriptionForWorkspace(
    params.workspaceId,
    params.environment,
  );
  if (subscription === null) return { key: null, reason: 'no_subscription' };
  if (subscription.currentPeriodEnd === null) return { key: null, reason: 'no_period_end' };
  return {
    key: allowancePeriodKeyAt(params.atIso, subscription.currentPeriodEnd),
    reason: 'resolved',
  };
}

/**
 * True when a string is shaped like an allowance period key.
 *
 * Exported so a caller that receives a key from elsewhere can refuse a `YYYY-MM` before it
 * writes it — which is the exact failure A13-010 was. Cheap, and it turns a silent
 * mismatch into a loud one.
 */
export function isAllowancePeriodKey(value: string): boolean {
  return ISO_DATE.test(value);
}
