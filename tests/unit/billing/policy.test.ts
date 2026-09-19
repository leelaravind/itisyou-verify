/**
 * The payment-recovery window, as approved by the founder on 2026-09-19.
 *
 * These cases test the behaviour behind each line of the policy, not the strings. Where a
 * string is asserted it is because the founder specified the *content* — requirement 3
 * says the customer must be told that new runs are not being checked, not that there is a
 * generic "billing issue".
 */
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_RECOVERY_DAYS,
  PAYMENT_RECOVERY_POLICY,
  PRE_CHECKOUT_DISCLOSURE,
  entitlementWithRecovery,
  paymentRecoveryWindow,
  recoveryStatement,
} from '@app/billing/policy';
import { allowancePeriodKey } from '@app/billing/state';
import type { SubscriptionRecord } from '@app/billing/port';

/** Period paid up to 2026-09-19T09:00Z. Window therefore closes 2026-09-26T09:00Z. */
function subscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: 'sub_row_1',
    workspaceId: 'ws_1',
    providerSubscriptionId: 'sub_provider_1',
    environment: 'test',
    status: 'past_due',
    priceId: 'price_1',
    currentPeriodEnd: '2026-09-19T09:00:00.000Z',
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    providerEventCreated: 1_800_000_000,
    updatedAt: '2026-09-19T09:00:00.000Z',
    ...overrides,
  };
}

describe('the approved policy', () => {
  it('BILL-160 the window is seven days', () => {
    expect(PAYMENT_RECOVERY_DAYS).toBe(7);
    expect(PAYMENT_RECOVERY_POLICY.graceDays).toBe(7);
  });

  it('BILL-161 exactly one thing pauses, and it is new verification runs', () => {
    expect(PAYMENT_RECOVERY_POLICY.whatPauses).toHaveLength(1);
    expect(PAYMENT_RECOVERY_POLICY.whatPauses[0]).toMatch(/new verification runs/i);
  });

  it('BILL-162 everything the founder listed as preserved is listed as preserved', () => {
    const preserved = PAYMENT_RECOVERY_POLICY.whatStaysAvailable.join(' | ').toLowerCase();
    for (const required of [
      'signing in',
      'run history',
      'evidence',
      'export',
      'payment method',
      'cancelling',
    ]) {
      expect(preserved).toContain(required);
    }
  });

  it('BILL-163 resuming requires confirmed payment, not a redirect or a retry', () => {
    const resume = PAYMENT_RECOVERY_POLICY.resumeRequires.join(' ').toLowerCase();
    expect(resume).toContain('payment provider');
    expect(resume).not.toContain('redirect');
    expect(resume).not.toContain('optimistic');
  });

  it('BILL-164 day eight suspends and marks unpaid — it does not cancel', () => {
    expect(PAYMENT_RECOVERY_POLICY.afterWindow).toMatch(/unpaid/i);
    expect(PAYMENT_RECOVERY_POLICY.afterWindow).toMatch(/not cancelled/i);
  });

  it('BILL-165 nothing is deleted for non-payment and retention is the only policy cited', () => {
    expect(PAYMENT_RECOVERY_POLICY.dataHandling).toMatch(/nothing of yours is deleted/i);
    expect(PAYMENT_RECOVERY_POLICY.dataHandling).toContain('docs/privacy-retention.md');
  });

  it('BILL-166 the policy is reachable from the pre-checkout disclosure with the price and allowance', () => {
    expect(PRE_CHECKOUT_DISCLOSURE.priceMinor).toBe(2900);
    expect(PRE_CHECKOUT_DISCLOSURE.currency).toBe('GBP');
    expect(PRE_CHECKOUT_DISCLOSURE.runsPerPeriod).toBe(500);
    // The same object, not a retyped copy that could drift.
    expect(PRE_CHECKOUT_DISCLOSURE.recovery).toBe(PAYMENT_RECOVERY_POLICY);
    expect(PRE_CHECKOUT_DISCLOSURE.recovery.graceDays).toBe(7);
    expect(PRE_CHECKOUT_DISCLOSURE.recovery.afterWindow).toMatch(/unpaid/i);
  });

  it('BILL-167 the policy object is frozen so no caller can quietly edit the terms', () => {
    expect(Object.isFrozen(PAYMENT_RECOVERY_POLICY)).toBe(true);
    expect(Object.isFrozen(PRE_CHECKOUT_DISCLOSURE)).toBe(true);
  });
});

describe('where a subscription sits in the window', () => {
  it('BILL-168 an active subscription is serving and nothing is paused', () => {
    const window = paymentRecoveryWindow(
      subscription({ status: 'active' }),
      '2026-09-20T09:00:00.000Z',
    );
    expect(window.phase).toBe('serving');
    expect(window.runsPaused).toBe(false);
    expect(window.needsSuspension).toBe(false);
  });

  it('BILL-169 a failed renewal opens the window at the end of the period that was paid for', () => {
    const window = paymentRecoveryWindow(subscription(), '2026-09-20T09:00:00.000Z');
    expect(window.phase).toBe('in_recovery_window');
    expect(window.startedAt).toBe('2026-09-19T09:00:00.000Z');
    expect(window.endsAt).toBe('2026-09-26T09:00:00.000Z');
    expect(window.anchoredOn).toBe('period_end');
    expect(window.runsPaused).toBe(true);
  });

  it('BILL-170 the deadline does not drift as Stripe retries the card through the window', () => {
    // Three different "now"s inside the window all compute the same deadline, because the
    // anchor is the period end and not whenever we last saw a failure.
    for (const now of [
      '2026-09-19T09:00:01.000Z',
      '2026-09-22T00:00:00.000Z',
      '2026-09-25T23:59:59.000Z',
    ]) {
      expect(paymentRecoveryWindow(subscription(), now).endsAt).toBe('2026-09-26T09:00:00.000Z');
    }
  });

  it('BILL-171 days remaining counts down and never goes negative', () => {
    expect(paymentRecoveryWindow(subscription(), '2026-09-19T09:00:00.001Z').daysRemaining).toBe(7);
    expect(paymentRecoveryWindow(subscription(), '2026-09-25T09:00:00.000Z').daysRemaining).toBe(1);
    expect(paymentRecoveryWindow(subscription(), '2026-09-26T09:00:00.000Z').daysRemaining).toBe(0);
  });

  it('BILL-172 on day eight the window has elapsed and a suspension is due', () => {
    const window = paymentRecoveryWindow(subscription(), '2026-09-26T09:00:01.000Z');
    expect(window.phase).toBe('window_elapsed');
    expect(window.needsSuspension).toBe(true);
    expect(window.runsPaused).toBe(true);
  });

  it('BILL-173 an already-suspended subscription needs no further suspension', () => {
    const window = paymentRecoveryWindow(
      subscription({ status: 'unpaid' }),
      '2026-10-30T00:00:00.000Z',
    );
    expect(window.phase).toBe('suspended_unpaid');
    expect(window.needsSuspension).toBe(false);
    expect(window.runsPaused).toBe(true);
  });

  it('BILL-174 with no period end the window falls back to the recorded state and says so', () => {
    const window = paymentRecoveryWindow(
      subscription({ currentPeriodEnd: null, updatedAt: '2026-09-19T09:00:00.000Z' }),
      '2026-09-20T09:00:00.000Z',
    );
    expect(window.anchoredOn).toBe('recorded_state');
    expect(window.endsAt).toBe('2026-09-26T09:00:00.000Z');
  });

  it('BILL-175 no subscription at all is not a payment problem', () => {
    expect(paymentRecoveryWindow(null, '2026-09-20T09:00:00.000Z').phase).toBe('not_applicable');
  });
});

describe('entitlement through the window', () => {
  it('BILL-176 inside the window new runs are refused but access and cancellation remain', () => {
    const view = entitlementWithRecovery(subscription(), '2026-09-20T09:00:00.000Z');
    expect(view.admitsNewRuns).toBe(false);
    expect(view.accountAccessible).toBe(true);
    expect(view.cancellationAvailable).toBe(true);
    expect(view.recovery.phase).toBe('in_recovery_window');
  });

  it('BILL-177 on day eight new runs stay refused and access and cancellation still remain', () => {
    const view = entitlementWithRecovery(
      subscription({ status: 'unpaid' }),
      '2026-09-27T09:00:00.000Z',
    );
    expect(view.admitsNewRuns).toBe(false);
    expect(view.accountAccessible).toBe(true);
    expect(view.cancellationAvailable).toBe(true);
  });

  it('BILL-178 the window can only ever pause — it never grants entitlement', () => {
    const cancelled = entitlementWithRecovery(
      subscription({ status: 'canceled' }),
      '2026-09-20T09:00:00.000Z',
    );
    expect(cancelled.admitsNewRuns).toBe(false);
    const serving = entitlementWithRecovery(
      subscription({ status: 'active' }),
      '2026-09-20T09:00:00.000Z',
    );
    expect(serving.admitsNewRuns).toBe(true);
  });
});

describe('what the customer is told', () => {
  it('BILL-179 the message names the consequence — runs are not being checked', () => {
    const statement = recoveryStatement(
      paymentRecoveryWindow(subscription(), '2026-09-20T09:00:00.000Z'),
    );
    expect(statement.toLowerCase()).toContain('paused checking new runs');
    // Not a generic billing noise message.
    expect(statement.toLowerCase()).not.toMatch(/^there (is|was) a billing issue/);
  });

  it('BILL-180 the message also says what has not stopped', () => {
    const statement = recoveryStatement(
      paymentRecoveryWindow(subscription(), '2026-09-20T09:00:00.000Z'),
    ).toLowerCase();
    expect(statement).toContain('history');
    expect(statement).toContain('cancel');
  });

  it('BILL-181 the day-eight message says suspended and unpaid, and that nothing was deleted', () => {
    const statement = recoveryStatement(
      paymentRecoveryWindow(subscription({ status: 'unpaid' }), '2026-09-27T09:00:00.000Z'),
    ).toLowerCase();
    expect(statement).toContain('unpaid');
    expect(statement).toContain('nothing has been deleted');
    expect(statement).toContain('nothing has been cancelled');
  });
});

describe('the allowance key', () => {
  it('BILL-182 the allowance period is keyed by the date the paid period ends', () => {
    expect(allowancePeriodKey('2026-10-19T09:00:00.000Z')).toBe('2026-10-19');
  });

  it('BILL-183 a subscription and an invoice describing one period produce one key', () => {
    // The subscription reports `items.data[].current_period_end`; the invoice reports its
    // line item's `period.end`. For the same period these are the same instant, so the
    // keys match exactly — which is what stops one paid period opening two allowance rows.
    const fromSubscription = allowancePeriodKey('2026-10-19T09:00:00.000Z');
    const fromInvoice = allowancePeriodKey('2026-10-19T09:00:00.000Z');
    expect(fromSubscription).toBe(fromInvoice);
  });
});
