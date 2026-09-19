/**
 * Pricing page copy. The price and allowance are read from @verify/contracts's LIMITS —
 * never retyped — so this file cannot silently drift from the frozen contract.
 */
import { LIMITS, formatMoney, money } from '@verify/contracts';

export const PLAN_NAME = 'Verify';

/** Rendered from the frozen contract constant, e.g. "£29.00". */
export const PLAN_PRICE_DISPLAY = formatMoney(money(LIMITS.PLAN_PRICE_PENCE, 'GBP'));

export const PLAN_BILLING_PERIOD = 'per month';

export interface PricingAllowanceLine {
  readonly label: string;
  readonly value: string;
}

/** What the plan includes, read from LIMITS rather than retyped. */
export const PLAN_ALLOWANCE: readonly PricingAllowanceLine[] = [
  { label: 'Workflows', value: 'One workflow' },
  { label: 'Runs included', value: `${LIMITS.PLAN_RUNS_PER_PERIOD} per month` },
  { label: 'Workspaces', value: 'One workspace' },
  { label: 'Seats', value: 'One owner, plus one invited viewer' },
  { label: 'Evidence retention', value: `${LIMITS.EVIDENCE_RETENTION_DAYS} days` },
];

/** What happens once the monthly run allowance is used. No surprise overage. */
export const PLAN_AT_ALLOWANCE = `Once you reach ${LIMITS.PLAN_RUNS_PER_PERIOD} runs in a billing period, we stop accepting new events for that workflow until your next period starts. We do not charge you for going over, and we do not silently keep running and bill you afterwards — you get a plain notice that the period's allowance is used.`;

export const PLAN_RENEWAL_WORDING =
  'Your plan renews automatically each month at the same price, on the date you first subscribed, until you cancel.';

export const PLAN_CANCELLATION_WORDING =
  'You can cancel at any time from the billing portal. Cancelling stops the next renewal; you keep access for the rest of the period you already paid for. We do not offer partial refunds for the unused part of a period unless required by law.';

export const PLAN_TAXES_NOTE = `${PLAN_PRICE_DISPLAY} is the price shown at checkout; any tax required by law (for example VAT) is calculated and added by our payment provider based on your billing details, so the amount charged may be higher than the headline price.`;
