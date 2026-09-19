/**
 * The pre-checkout disclosure, ready to render.
 *
 * The founder's requirement was explicit: the recovery policy is **displayed before
 * checkout, not discovered afterwards**. A05 owns the review-and-price page, so this file
 * gives them the finished content — headings, lines, the formatted price — as a typed
 * structure with no copy left to write. A05 maps it to markup; they never restate a
 * number, a duration or a promise, because a restated promise is one that can drift out of
 * step with the code that keeps it.
 *
 * Everything here is derived from `PLAN`, `PAYMENT_RECOVERY_POLICY` and
 * `LIMITS`. Change the policy and this changes with it.
 */
import { formatMoney, money } from '@verify/contracts';
import { PLAN } from './config';
import { PAYMENT_RECOVERY_POLICY, PRE_CHECKOUT_DISCLOSURE } from './policy';

/** One labelled fact. Renders as a definition-list row, or a table row. */
export interface DisclosureFact {
  readonly label: string;
  readonly value: string;
}

/** A headed block of plain sentences or bullet lines. */
export interface DisclosureSection {
  readonly id: string;
  readonly heading: string;
  readonly lines: readonly string[];
  /** `list` renders as bullets; `prose` as paragraphs. */
  readonly style: 'list' | 'prose';
}

export interface PreCheckoutPanel {
  readonly heading: string;
  /** The headline price, already formatted. `£29.00` — never computed in a template. */
  readonly priceFormatted: string;
  readonly priceCadence: string;
  readonly facts: readonly DisclosureFact[];
  readonly sections: readonly DisclosureSection[];
  /**
   * The one sentence that must be visible without expanding anything. Everything else may
   * live behind a disclosure control; this may not.
   */
  readonly mustBeVisible: string;
}

/**
 * Build the panel. Pure, takes nothing, returns the same thing every time — so A05 can
 * snapshot it and a change to the policy shows up as a diff in their test too.
 */
export function preCheckoutPanel(): PreCheckoutPanel {
  const price = formatMoney(money(PLAN.amountMinor, PLAN.currency));
  const recovery = PAYMENT_RECOVERY_POLICY;

  return {
    heading: 'What you are signing up for',
    priceFormatted: price,
    priceCadence: 'per month',
    facts: [
      { label: 'Price', value: `${price} per month` },
      { label: 'Included', value: `${PLAN.runsPerPeriod} verification runs each month` },
      { label: 'Workflows', value: 'One workflow per workspace' },
      { label: 'Billing', value: 'Monthly, on the same day each month' },
      { label: 'Cancel', value: 'Any time, keeping the period you have paid for' },
    ],
    sections: [
      {
        id: 'allowance',
        heading: `When you reach ${PLAN.runsPerPeriod} runs`,
        style: 'prose',
        lines: [
          PRE_CHECKOUT_DISCLOSURE.allowanceBehaviour,
          'Runs already in progress finish normally. Everything else about your account keeps working.',
        ],
      },
      {
        id: 'payment-recovery',
        heading: `If a payment fails, you get ${recovery.graceDays} days`,
        style: 'prose',
        lines: [recovery.headline],
      },
      {
        id: 'payment-recovery-pauses',
        heading: 'What pauses during those days',
        style: 'list',
        lines: recovery.whatPauses,
      },
      {
        id: 'payment-recovery-preserved',
        heading: 'What keeps working',
        style: 'list',
        lines: recovery.whatStaysAvailable,
      },
      {
        id: 'payment-recovery-after',
        heading: `After ${recovery.graceDays} days`,
        style: 'prose',
        lines: [recovery.afterWindow, recovery.dataHandling],
      },
      {
        id: 'cancellation',
        heading: 'Cancelling',
        style: 'prose',
        lines: [PRE_CHECKOUT_DISCLOSURE.cancellationBehaviour],
      },
      {
        id: 'refunds',
        heading: 'Refunds',
        style: 'prose',
        lines: [PRE_CHECKOUT_DISCLOSURE.refundBehaviour],
      },
    ],
    mustBeVisible:
      `${price} a month for ${PLAN.runsPerPeriod} runs on one workflow. ` +
      `If a payment fails we pause checking new runs for ${recovery.graceDays} days and nothing else changes. ` +
      'Cancel any time.',
  };
}

/**
 * Every line the panel will render, flattened.
 *
 * For A05's accessibility and copy-review tests, and for the case asserting that the
 * recovery policy is genuinely reachable from the pre-checkout step rather than merely
 * present in a constant somewhere.
 */
export function preCheckoutDisclosureText(panel: PreCheckoutPanel = preCheckoutPanel()): string {
  return [
    panel.heading,
    panel.mustBeVisible,
    ...panel.facts.map((fact) => `${fact.label}: ${fact.value}`),
    ...panel.sections.flatMap((section) => [section.heading, ...section.lines]),
  ].join('\n');
}
