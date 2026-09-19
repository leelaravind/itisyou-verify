/**
 * The overview's money and freshness rules.
 *
 * One property, applied everywhere: unknown propagates. A total built from a figure nobody
 * measured is itself unknown, and never the sum of the parts that happen to be there.
 */
import { describe, expect, it } from 'vitest';
import {
  NET_RECEIPTS_CAVEAT,
  STALE_METRIC_SECONDS,
  describeAge,
  displayMinor,
  estimatedNetReceiptsMinor,
  freshness,
  subtractUnknownAware,
  summariseFinance,
  type FinanceInputs,
} from '@app/owner/finance';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function inputs(overrides: Partial<FinanceInputs> = {}): FinanceInputs {
  return {
    currency: 'GBP',
    cashRevenueMinor: 9800,
    refundsMinor: 4900,
    variableCostsMinor: 1200,
    outstandingCommitmentsMinor: 1500,
    startupCashRemainingMinor: 6300,
    lastRefreshAt: new Date(NOW.getTime() - 300_000).toISOString(),
    estimatedFields: [],
    ...overrides,
  };
}

describe('owner overview figures', () => {
  it('OWNER-110 net receipts is revenue minus refunds minus billed costs', () => {
    expect(estimatedNetReceiptsMinor(inputs())).toBe(9800 - 4900 - 1200);
  });

  it('OWNER-111 an unknown cost makes net receipts unknown, not flattering', () => {
    expect(estimatedNetReceiptsMinor(inputs({ variableCostsMinor: null }))).toBeNull();
  });

  it('OWNER-112 an unknown refund figure makes net receipts unknown', () => {
    expect(estimatedNetReceiptsMinor(inputs({ refundsMinor: null }))).toBeNull();
  });

  it('OWNER-113 unknown propagates through the subtraction helper in any position', () => {
    expect(subtractUnknownAware(100, 10, 5)).toBe(85);
    expect(subtractUnknownAware(null, 10)).toBeNull();
    expect(subtractUnknownAware(100, null)).toBeNull();
    expect(subtractUnknownAware()).toBeNull();
  });

  it('OWNER-114 an unknown figure displays as "unknown", never as zero', () => {
    expect(displayMinor(null, 'GBP')).toBe('unknown');
    expect(displayMinor(0, 'GBP')).toBe('£0.00');
  });

  it('OWNER-115 the net line is labelled as receipts and carries the not-profit caveat', () => {
    const summary = summariseFinance(inputs());
    const net = summary.lines.find((l) => l.key === 'net_receipts');
    expect(net?.label).toBe('Estimated net receipts');
    expect(net?.caveat).toBe(NET_RECEIPTS_CAVEAT);
    expect(NET_RECEIPTS_CAVEAT).toMatch(/not profit/i);
    for (const line of summary.lines) expect(line.label.toLowerCase()).not.toContain('profit');
  });

  it('OWNER-116 a figure derived from an estimate is itself marked as an estimate', () => {
    const summary = summariseFinance(inputs({ estimatedFields: ['variable_costs'] }));
    expect(summary.lines.find((l) => l.key === 'net_receipts')?.estimated).toBe(true);
    expect(summary.anyEstimated).toBe(true);
  });

  it('OWNER-117 the summary reports whether anything at all is unknown', () => {
    expect(summariseFinance(inputs()).anyUnknown).toBe(false);
    expect(summariseFinance(inputs({ startupCashRemainingMinor: null })).anyUnknown).toBe(true);
  });

  it('OWNER-118 the last-refresh time travels with the summary', () => {
    const summary = summariseFinance(inputs());
    expect(summary.lastRefreshAt).toBe(inputs().lastRefreshAt);
  });

  it('OWNER-119 a figure with no observation time is stale by definition', () => {
    const state = freshness(null, NOW);
    expect(state.stale).toBe(true);
    expect(state.label).toMatch(/treat this as unknown/i);
  });

  it('OWNER-120 a metric older than the staleness window is marked out of date', () => {
    const old = new Date(NOW.getTime() - (STALE_METRIC_SECONDS + 60) * 1000).toISOString();
    const state = freshness(old, NOW);
    expect(state.stale).toBe(true);
    expect(state.label).toMatch(/out of date/);
  });

  it('OWNER-121 a recent metric is not marked stale', () => {
    const recent = new Date(NOW.getTime() - 120_000).toISOString();
    expect(freshness(recent, NOW).stale).toBe(false);
  });

  it('OWNER-122 an unparseable timestamp is stale rather than trusted', () => {
    const state = freshness('the day before yesterday', NOW);
    expect(state.stale).toBe(true);
    expect(state.ageSeconds).toBeNull();
  });

  it('OWNER-123 ages are described in units a person reads', () => {
    expect(describeAge(30)).toBe('30 seconds');
    expect(describeAge(600)).toBe('10 minutes');
    expect(describeAge(7200)).toBe('2 hours');
    expect(describeAge(172_800)).toBe('2 days');
  });
});
