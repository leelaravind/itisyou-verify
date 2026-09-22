/**
 * Usage warnings, and why they need a memory.
 *
 * A threshold is a crossing, not a state. A workspace at 92% is past 75% and past 90%, and
 * stays past both for the rest of the period — so an alert that fires on "is past 90%" fires
 * on every admission until the month rolls over. That is how one runaway automation produces
 * two hundred identical emails, which is the failure the owner asked to be designed out
 * rather than designed in.
 */
import { describe, expect, it } from 'vitest';
import { usageAlertKeyFor, USAGE_ALERT_THRESHOLDS } from '@app/db/admissionControls';

const PERIOD = '2026-10-05';

describe('usage alert deduplication', () => {
  it('BUDGET-901 says nothing below the first threshold', () => {
    expect(usageAlertKeyFor(PERIOD, 74, 100, null)).toBeNull();
  });

  it('BUDGET-902 announces the highest threshold crossed, once', () => {
    const first = usageAlertKeyFor(PERIOD, 92, 100, null);
    expect(first).toEqual({ key: `${PERIOD}:90`, threshold: 90 });

    // The same reading again is not news, and neither is any further admission at 92%.
    expect(usageAlertKeyFor(PERIOD, 92, 100, first!.key)).toBeNull();
    expect(usageAlertKeyFor(PERIOD, 95, 100, first!.key)).toBeNull();
  });

  it('BUDGET-903 a higher threshold later in the same period is news again', () => {
    const at90 = usageAlertKeyFor(PERIOD, 92, 100, null)!;
    const at100 = usageAlertKeyFor(PERIOD, 100, 100, at90.key);
    expect(at100).toEqual({ key: `${PERIOD}:100`, threshold: 100 });
  });

  it('BUDGET-904 a new period alerts again from scratch', () => {
    const lastPeriod = `2026-09-05:100`;
    expect(usageAlertKeyFor(PERIOD, 80, 100, lastPeriod)).toEqual({
      key: `${PERIOD}:75`,
      threshold: 75,
    });
  });

  it('BUDGET-905 a zero or negative limit is never a percentage', () => {
    // Dividing by it would produce Infinity and alert forever on a workspace with no plan.
    expect(usageAlertKeyFor(PERIOD, 5, 0, null)).toBeNull();
    expect(usageAlertKeyFor(PERIOD, 5, -1, null)).toBeNull();
  });

  it('BUDGET-906 the thresholds are ordered, so "highest crossed" means what it says', () => {
    const ordered = [...USAGE_ALERT_THRESHOLDS].every(
      (value, index, all) => index === 0 || all[index - 1]! < value,
    );
    expect(ordered).toBe(true);
  });
});
