/**
 * The money figures on the overview screen.
 *
 * Every number here is integer minor units, and every number here can be `null`.
 *
 * `null` means **unknown**, and it propagates: a total computed from an unknown input is
 * itself unknown, not the sum of the parts we happen to have. That is the whole design.
 * The failure this prevents is the one where a dashboard quietly shows £0 of refunds
 * because the refunds figure never arrived, and the owner reads it as "no refunds".
 *
 * ## Words that are not used here
 *
 * **Profit.** Nothing on this screen is profit. We know what money arrived, what went back
 * out, and what we have been billed for so far. We do not know tax, we do not know the
 * owner's own time, and we do not know what is still to be invoiced. The label is
 * "estimated net receipts", and {@link NET_RECEIPTS_CAVEAT} is rendered beside it every
 * single time — it is returned by this module rather than written on a page, so a second
 * page cannot render the figure without the caveat.
 */
import { formatMoney, money, type Currency } from '@verify/contracts';

export const NET_RECEIPTS_CAVEAT =
  'This is money in minus money refunded minus the costs we have actually been billed. ' +
  'It is not profit: it does not include tax, your own time, or anything invoiced later.';

export interface FinanceInputs {
  readonly currency: Currency;
  /** Money that actually arrived, settled, in the period. */
  readonly cashRevenueMinor: number | null;
  /** Refunds that actually left. */
  readonly refundsMinor: number | null;
  /** Provider fees and infrastructure costs we have been billed for. */
  readonly variableCostsMinor: number | null;
  /** Money committed but not yet spent — an accepted campaign, a signed-up-for month. */
  readonly outstandingCommitmentsMinor: number | null;
  /** What is left of the founder's approved startup cash. */
  readonly startupCashRemainingMinor: number | null;
  /** When these figures were last refreshed from their sources. Null if never. */
  readonly lastRefreshAt: string | null;
  /** Which of these figures is an estimate rather than a settled fact. */
  readonly estimatedFields: readonly string[];
}

export interface FinanceLine {
  readonly key: string;
  readonly label: string;
  readonly minor: number | null;
  /** Formatted, or the literal string `unknown`. Never `£0.00` standing in for unknown. */
  readonly display: string;
  readonly estimated: boolean;
  /** A sentence about what this figure is and is not. Null where the label suffices. */
  readonly caveat: string | null;
}

export interface FinanceSummary {
  readonly currency: Currency;
  readonly lines: readonly FinanceLine[];
  readonly lastRefreshAt: string | null;
  /** True when any line on the screen is an estimate. Drives the screen-level label. */
  readonly anyEstimated: boolean;
  /** True when any line is unknown. Drives the "some figures are missing" notice. */
  readonly anyUnknown: boolean;
}

/** Format, or say `unknown`. The one place that decision is made. */
export function displayMinor(minor: number | null, currency: Currency): string {
  return minor === null ? 'unknown' : formatMoney(money(minor, currency));
}

/** Subtract with unknown propagation: any unknown operand makes the result unknown. */
export function subtractUnknownAware(...values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  if (first === null || first === undefined) return null;
  let total = first;
  for (const value of rest) {
    if (value === null) return null;
    total -= value;
  }
  return total;
}

/**
 * Estimated net receipts. Unknown unless all three inputs are known — a figure that
 * silently treats an unmeasured cost as zero would flatter the business, which is the
 * direction an owner most needs protecting from.
 */
export function estimatedNetReceiptsMinor(inputs: FinanceInputs): number | null {
  return subtractUnknownAware(inputs.cashRevenueMinor, inputs.refundsMinor, inputs.variableCostsMinor);
}

export function summariseFinance(inputs: FinanceInputs): FinanceSummary {
  const estimated = new Set(inputs.estimatedFields);
  const net = estimatedNetReceiptsMinor(inputs);

  const lines: readonly FinanceLine[] = [
    {
      key: 'cash_revenue',
      label: 'Cash received',
      minor: inputs.cashRevenueMinor,
      display: displayMinor(inputs.cashRevenueMinor, inputs.currency),
      estimated: estimated.has('cash_revenue'),
      caveat: 'Payments that have actually settled. Not what has been invoiced.',
    },
    {
      key: 'refunds',
      label: 'Refunded',
      minor: inputs.refundsMinor,
      display: displayMinor(inputs.refundsMinor, inputs.currency),
      estimated: estimated.has('refunds'),
      caveat: null,
    },
    {
      key: 'variable_costs',
      label: 'Costs billed so far',
      minor: inputs.variableCostsMinor,
      display: displayMinor(inputs.variableCostsMinor, inputs.currency),
      estimated: estimated.has('variable_costs'),
      caveat: 'What providers have actually charged. Anything not yet invoiced is not in here.',
    },
    {
      key: 'net_receipts',
      label: 'Estimated net receipts',
      minor: net,
      display: displayMinor(net, inputs.currency),
      // A figure derived from an estimate is an estimate, whatever its own inputs claim.
      estimated:
        net === null ||
        estimated.has('cash_revenue') ||
        estimated.has('refunds') ||
        estimated.has('variable_costs'),
      caveat: NET_RECEIPTS_CAVEAT,
    },
    {
      key: 'commitments',
      label: 'Outstanding commitments',
      minor: inputs.outstandingCommitmentsMinor,
      display: displayMinor(inputs.outstandingCommitmentsMinor, inputs.currency),
      estimated: estimated.has('commitments'),
      caveat: 'Money we are on the hook for that has not left the account yet.',
    },
    {
      key: 'startup_cash',
      label: 'Startup cash remaining',
      minor: inputs.startupCashRemainingMinor,
      display: displayMinor(inputs.startupCashRemainingMinor, inputs.currency),
      estimated: estimated.has('startup_cash'),
      caveat: 'The approved starting budget, less everything spent, reserved and committed against it.',
    },
  ];

  return {
    currency: inputs.currency,
    lines,
    lastRefreshAt: inputs.lastRefreshAt,
    anyEstimated: lines.some((l) => l.estimated),
    anyUnknown: lines.some((l) => l.minor === null),
  };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** A metric older than this is marked stale wherever it appears. */
export const STALE_METRIC_SECONDS = 60 * 60;

export interface Freshness {
  readonly observedAt: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  /** What to show next to the figure. Never empty. */
  readonly label: string;
}

/**
 * How old is this figure, and should the page say so?
 *
 * An absent timestamp is stale by definition: a number with no observation time is a number
 * we cannot vouch for.
 */
export function freshness(
  observedAt: string | null,
  now: Date,
  staleAfterSeconds: number = STALE_METRIC_SECONDS,
): Freshness {
  if (observedAt === null || observedAt.length === 0) {
    return {
      observedAt: null,
      ageSeconds: null,
      stale: true,
      label: 'never refreshed — treat this as unknown',
    };
  }
  const ms = Date.parse(observedAt);
  if (Number.isNaN(ms)) {
    return { observedAt, ageSeconds: null, stale: true, label: 'refresh time not recorded' };
  }
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
  const stale = ageSeconds > staleAfterSeconds;
  return {
    observedAt,
    ageSeconds,
    stale,
    label: stale
      ? `last refreshed ${describeAge(ageSeconds)} ago — out of date`
      : `last refreshed ${describeAge(ageSeconds)} ago`,
  };
}

export function describeAge(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}
