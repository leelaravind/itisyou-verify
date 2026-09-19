/**
 * Paid-mode caps. Integer minor units throughout; no float ever reaches a comparison.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_CONFIG,
  capDecision,
  estimateRequestCostMinor,
  validateAssistantConfig,
  type AssistantConfig,
} from '@app/assistant/index';

const PAID: AssistantConfig = {
  ...DEFAULT_ASSISTANT_CONFIG,
  mode: 'paid_api',
  paidProvider: 'openrouter',
  paidModelId: 'vendor/model',
  perRequestCapMinor: 50,
  cumulativeCapMinor: 1_000,
  budgetAccountId: 'bac_assistant',
};

describe('assistant spending caps', () => {
  it('BUDGET-047 an estimate above the per-request cap is refused before anything is reserved', () => {
    expect(capDecision(PAID, 50, 0)).toEqual({ allowed: true });
    expect(capDecision(PAID, 51, 0)).toEqual({
      allowed: false,
      reason: 'PER_REQUEST_CAP_EXCEEDED',
    });
  });

  it('BUDGET-048 the cumulative cap blocks the call that would exceed it, not the one after', () => {
    // 990 already committed, cap 1000: a 10 lands exactly on the cap and is allowed.
    expect(capDecision(PAID, 10, 990)).toEqual({ allowed: true });
    // One penny more crosses it and is refused. This is the boundary the brief names.
    expect(capDecision(PAID, 11, 990)).toEqual({
      allowed: false,
      reason: 'CUMULATIVE_CAP_REACHED',
    });
    expect(capDecision(PAID, 1, 1_000)).toEqual({
      allowed: false,
      reason: 'CUMULATIVE_CAP_REACHED',
    });
  });

  it('BUDGET-049 cost is integer minor units, rounded up, and a hostile number cannot pass', () => {
    // 1000 prompt tokens at 300 minor/million + 500 output at 1500 minor/million
    // = (300_000 + 750_000)/1e6 = 1.05 -> 2 (rounded up, never down).
    expect(
      estimateRequestCostMinor({
        promptTokens: 1_000,
        maxOutputTokens: 500,
        inputPricePerMillionMinor: 300,
        outputPricePerMillionMinor: 1_500,
      }),
    ).toBe(2);
    expect(
      Number.isInteger(
        estimateRequestCostMinor({
          promptTokens: 1,
          maxOutputTokens: 1,
          inputPricePerMillionMinor: 1,
          outputPricePerMillionMinor: 1,
        }),
      ),
    ).toBe(true);
    // Negative, fractional and NaN inputs contribute zero rather than a negative cost.
    expect(
      estimateRequestCostMinor({
        promptTokens: -5_000_000,
        maxOutputTokens: Number.NaN,
        inputPricePerMillionMinor: 1_000,
        outputPricePerMillionMinor: 1_000,
      }),
    ).toBe(0);
    expect(capDecision(PAID, Number.NaN, 0)).toEqual({
      allowed: false,
      reason: 'BUDGET_UNAVAILABLE',
    });
  });

  it('BUDGET-050 an incomplete paid configuration cannot be saved or used', () => {
    expect(validateAssistantConfig(PAID).ok).toBe(true);
    const missingAccount = validateAssistantConfig({ ...PAID, budgetAccountId: null });
    expect(missingAccount.ok).toBe(false);
    const inverted = validateAssistantConfig({ ...PAID, perRequestCapMinor: 2_000 });
    expect(inverted.ok).toBe(false);
    // And a half-configured paid mode refuses at the cap gate too, rather than at the call.
    expect(capDecision({ ...PAID, cumulativeCapMinor: 0 }, 1, 0)).toEqual({
      allowed: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(capDecision(DEFAULT_ASSISTANT_CONFIG, 1, 0)).toEqual({
      allowed: false,
      reason: 'NOT_CONFIGURED',
    });
  });
});
