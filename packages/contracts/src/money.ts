/**
 * Frozen contract v1 — money.
 * Integer minor units only. Floating point must never enforce a financial cap. See plan §14.
 */

export type Currency = 'GBP' | 'USD' | 'EUR';

/** An amount in the smallest unit of its currency (pence for GBP). */
export interface Money {
  readonly amount_minor: number;
  readonly currency: Currency;
}

export function money(amount_minor: number, currency: Currency = 'GBP'): Money {
  if (!Number.isSafeInteger(amount_minor)) {
    throw new TypeError(`money amount must be a safe integer minor unit, received: ${amount_minor}`);
  }
  return { amount_minor, currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount_minor + b.amount_minor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount_minor - b.amount_minor, a.currency);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function formatMoney(m: Money): string {
  const sign = m.amount_minor < 0 ? '-' : '';
  const abs = Math.abs(m.amount_minor);
  const symbol = m.currency === 'GBP' ? '£' : m.currency === 'USD' ? '$' : '€';
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Budget availability, computed the one way the whole system agrees on. See plan §22.
 * Everything is a minor-unit integer so a cap can never drift by a rounding error.
 */
export interface BudgetAccountState {
  readonly authorised_limit_minor: number;
  readonly spent_minor: number;
  readonly reserved_minor: number;
  readonly committed_minor: number;
  readonly safety_buffer_minor: number;
  readonly currency: Currency;
}

export function budgetAvailableMinor(s: BudgetAccountState): number {
  return (
    s.authorised_limit_minor - s.spent_minor - s.reserved_minor - s.committed_minor - s.safety_buffer_minor
  );
}

export function canReserve(s: BudgetAccountState, requestMinor: number): boolean {
  if (!Number.isSafeInteger(requestMinor) || requestMinor < 0) return false;
  return budgetAvailableMinor(s) >= requestMinor;
}

/** The founder's approved startup budget, in pence. Plan §1. */
export const BUDGET = {
  TOTAL_INITIAL_PENCE: 10_000,
  CONTINGENCY_GATED_PENCE: 3_000,
  ALLOC_INFRASTRUCTURE_PENCE: 2_000,
  ALLOC_MODEL_API_PENCE: 1_000,
  ALLOC_EMAIL_OPS_PENCE: 500,
  ALLOC_ADVERTISING_PENCE: 1_500,
  ALLOC_RESERVE_PENCE: 5_000,
} as const;
