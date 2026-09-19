/**
 * Metrics sync persistence and the launch-metrics read.
 *
 * Two properties dominate: a failed sync never overwrites good figures with zeros, and an
 * unreadable figure renders as unknown rather than as zero. Both exist so the founder can
 * tell "nothing happened" from "nothing was measured".
 */
import { describe, expect, it } from 'vitest';
import { createMemoryGrowthPort } from '@app/growth/memory';
import { applyMetricsSync, settlementFor, spendIdempotencyKey } from '@app/growth/sync';
import { readLaunchMetrics, LAUNCH_METRIC_STALE_SECONDS } from '@app/growth/launchMetrics';
import { EXTERNAL_VISIT_TARGET, type VisitSession } from '@app/growth/analytics';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const FRESH = '2026-10-08T11:55:00.000Z';
const CAMPAIGN = 'cmp_1';
const UTM = 'verify_first_test';

const INTERVAL = { intervalStart: '2026-10-06T00:00:00.000Z', intervalEnd: '2026-10-07T00:00:00.000Z' } as const;

const session = (over: Partial<VisitSession>): VisitSession => ({
  id: `s_${Math.random().toString(36).slice(2)}`,
  first_seen_at: '2026-10-07T10:00:00.000Z',
  last_seen_at: '2026-10-07T10:00:00.000Z',
  landing_path: '/',
  utm_source: 'reddit',
  utm_medium: 'cpc',
  utm_campaign: UTM,
  classification: 'external',
  page_views: 1,
  expires_at: '2026-10-21T10:00:00.000Z',
  ...over,
});

async function seed(port: ReturnType<typeof createMemoryGrowthPort>, sessions: readonly VisitSession[]) {
  for (const s of sessions) await port.recordVisit(s, s.first_seen_at);
}

describe('campaign metrics persistence', () => {
  it('ADS-019 metrics are stored once per (campaign, interval) and a re-sync does not duplicate them', async () => {
    const port = createMemoryGrowthPort();

    const first = await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: 900, clicks: 11, spendMinor: 640, currency: 'GBP' },
      FRESH,
    );
    expect(first).toMatchObject({ applied: true, inserted: true });
    expect(port.metrics.length).toBe(1);

    // The platform restates the interval, as ad platforms routinely do.
    const second = await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: 940, clicks: 12, spendMinor: 705, currency: 'GBP' },
      '2026-10-08T11:58:00.000Z',
    );
    expect(second).toMatchObject({ applied: true, inserted: false });
    expect(port.metrics.length).toBe(1);
    expect(port.metrics[0]?.clicks).toBe(12);
    expect(port.metrics[0]?.spendMinor).toBe(705);
  });

  it('ADS-021 a failed sync records last_sync_error and does not overwrite the figures with zeros', async () => {
    const port = createMemoryGrowthPort();
    await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: 900, clicks: 11, spendMinor: 640, currency: 'GBP' },
      FRESH,
    );

    const failed = await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'failed', error: 'provider returned 503' },
      '2026-10-08T12:00:00.000Z',
    );

    expect(failed.applied).toBe(false);
    if (failed.applied) throw new Error('expected the sync to have failed');
    expect(failed.error).toBe('provider returned 503');
    expect(failed.retainedIsStale).toBe(true);

    // The figures are exactly as they were. Not zeroed, not deleted, not a fresh-looking 0.
    expect(port.metrics.length).toBe(1);
    expect(port.metrics[0]?.clicks).toBe(11);
    expect(port.metrics[0]?.spendMinor).toBe(640);
    expect(failed.retained?.spendMinor).toBe(640);

    // And the failure is recorded against the campaign so the panel can label it.
    expect(await port.campaignSyncState(CAMPAIGN)).toEqual({
      lastSyncAt: '2026-10-08T12:00:00.000Z',
      lastSyncError: 'provider returned 503',
    });
  });

  it('ADS-128 a later successful sync clears the recorded error', async () => {
    const port = createMemoryGrowthPort();
    await applyMetricsSync(port, CAMPAIGN, { kind: 'failed', error: 'timeout' }, FRESH);
    expect((await port.campaignSyncState(CAMPAIGN))?.lastSyncError).toBe('timeout');

    await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: 10, clicks: 1, spendMinor: 90, currency: 'GBP' },
      '2026-10-08T12:05:00.000Z',
    );
    expect(await port.campaignSyncState(CAMPAIGN)).toEqual({
      lastSyncAt: '2026-10-08T12:05:00.000Z',
      lastSyncError: null,
    });
  });

  it('ADS-129 a figure the provider did not report stays null and is never written as zero', async () => {
    const port = createMemoryGrowthPort();
    await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: null, clicks: null, spendMinor: null, currency: null },
      FRESH,
    );
    expect(port.metrics[0]).toMatchObject({ impressions: null, clicks: null, spendMinor: null });
  });

  it('ADS-130 a non-integer or negative spend figure is refused rather than rounded', async () => {
    const port = createMemoryGrowthPort();
    await expect(
      applyMetricsSync(
        port,
        CAMPAIGN,
        { kind: 'observed', ...INTERVAL, impressions: 1, clicks: 1, spendMinor: 6.4, currency: 'GBP' },
        FRESH,
      ),
    ).rejects.toThrow(/integer/);
    await expect(
      applyMetricsSync(
        port,
        CAMPAIGN,
        { kind: 'observed', ...INTERVAL, impressions: 1, clicks: 1, spendMinor: -5, currency: 'GBP' },
        FRESH,
      ),
    ).rejects.toThrow(/negative/);
    expect(port.metrics.length).toBe(0);
  });

  it('ADS-017 campaign spend settles against the budget ledger idempotently on the interval', async () => {
    const port = createMemoryGrowthPort();
    const applied = await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: 900, clicks: 11, spendMinor: 340, currency: 'GBP' },
      FRESH,
    );
    expect(applied.applied).toBe(true);
    if (!applied.applied) return;

    const settlement = settlementFor(applied.row);
    expect(settlement).not.toBeNull();
    expect(settlement?.amountMinor).toBe(340);
    expect(Number.isSafeInteger(settlement?.amountMinor ?? NaN)).toBe(true);

    // The key is derived from the campaign and the interval only, so restating the same
    // interval settles under the same key and A06's ledger returns `idempotent: true`
    // rather than deducting a second time.
    expect(settlement?.idempotencyKey).toBe(
      spendIdempotencyKey(CAMPAIGN, INTERVAL.intervalStart, INTERVAL.intervalEnd),
    );
    const restated = await applyMetricsSync(
      port,
      CAMPAIGN,
      { kind: 'observed', ...INTERVAL, impressions: 940, clicks: 12, spendMinor: 380, currency: 'GBP' },
      '2026-10-08T12:10:00.000Z',
    );
    expect(restated.applied).toBe(true);
    if (!restated.applied) return;
    expect(settlementFor(restated.row)?.idempotencyKey).toBe(settlement?.idempotencyKey);

    // A different interval is a different key, so real new spend is not swallowed.
    const next = spendIdempotencyKey(CAMPAIGN, INTERVAL.intervalEnd, '2026-10-08T00:00:00.000Z');
    expect(next).not.toBe(settlement?.idempotencyKey);
  });

  it('ADS-131 unknown or zero spend produces no ledger entry at all', async () => {
    const base = {
      campaignId: CAMPAIGN,
      ...INTERVAL,
      impressions: 10,
      clicks: 1,
      currency: 'GBP',
      receivedAt: FRESH,
    };
    // "We have not been told what this cost" and "this cost nothing" are different
    // statements, and neither one is a ledger movement.
    expect(settlementFor({ ...base, spendMinor: null })).toBeNull();
    expect(settlementFor({ ...base, spendMinor: 0 })).toBeNull();
    expect(settlementFor({ ...base, spendMinor: 1 })?.amountMinor).toBe(1);
  });
});

describe('launch metrics read', () => {
  const input = (port: ReturnType<typeof createMemoryGrowthPort>, over: Record<string, unknown> = {}) => ({
    port,
    since: '2026-10-01T00:00:00.000Z',
    until: '2026-11-01T00:00:00.000Z',
    campaignUtm: UTM,
    qualifiedSignups: 2,
    qualifiedSignupsObservedAt: FRESH,
    payingCustomers: 0,
    payingCustomersObservedAt: FRESH,
    now: NOW,
    ...over,
  });

  it('ADS-132 the four figures are reported separately and none is derived from another', async () => {
    const port = createMemoryGrowthPort();
    await seed(port, [
      session({ id: 'a' }),
      session({ id: 'b' }),
      session({ id: 'c', utm_campaign: null, utm_source: null }),
      session({ id: 'bot', classification: 'bot_suspected' }),
      session({ id: 'mine', classification: 'internal_test' }),
    ]);

    const metrics = await readLaunchMetrics(input(port));

    expect(metrics.totalVisits.value).toBe(3);
    expect(metrics.adAttributedVisits.value).toBe(2);
    expect(metrics.qualifiedSignups.value).toBe(2);
    expect(metrics.payingCustomers.value).toBe(0);
    expect(metrics.excludedBotSuspected.value).toBe(1);
    expect(metrics.excludedInternalTest.value).toBe(1);

    // No conversion rate, no total, no ratio anywhere in the object.
    const keys = Object.keys(metrics).join(' ');
    expect(keys).not.toMatch(/rate|ratio|conversion|percent|perVisit|combined|overall/i);
    expect(metrics.caveats.join(' ')).toMatch(/reported separately and are never combined/);
  });

  it('ADS-133 an unreadable visit count renders as unknown, never as zero', async () => {
    const port = createMemoryGrowthPort({ failReads: true });
    const metrics = await readLaunchMetrics(input(port));

    expect(metrics.totalVisits.value).toBeNull();
    expect(metrics.totalVisits.known).toBe(false);
    expect(metrics.adAttributedVisits.known).toBe(false);
    expect(metrics.excludedBotSuspected.known).toBe(false);
    expect(metrics.caveats.join(' ')).toMatch(/UNKNOWN, which is not the same as zero/);
    // And a target cannot be reported as unmet when we cannot see the number.
    expect(metrics.target.met).toBeNull();
  });

  it('ADS-134 signups and paying customers are independently unknown-able', async () => {
    const port = createMemoryGrowthPort();
    await seed(port, [session({ id: 'a' })]);
    const metrics = await readLaunchMetrics(
      input(port, { qualifiedSignups: null, qualifiedSignupsObservedAt: null, payingCustomers: null, payingCustomersObservedAt: null }),
    );
    expect(metrics.totalVisits.known).toBe(true);
    expect(metrics.qualifiedSignups.known).toBe(false);
    expect(metrics.payingCustomers.known).toBe(false);
    expect(metrics.qualifiedSignups.value).toBeNull();
    expect(metrics.payingCustomers.value).toBeNull();
  });

  it('ADS-135 every figure carries its observation time and is marked stale when out of date', async () => {
    const port = createMemoryGrowthPort();
    await seed(port, [session({ id: 'a' })]);
    const metrics = await readLaunchMetrics(
      input(port, { qualifiedSignupsObservedAt: '2026-10-01T09:00:00.000Z' }),
    );
    expect(metrics.refreshedAt).toBe(NOW.toISOString());
    expect(metrics.qualifiedSignups.stale).toBe(true);
    expect(metrics.qualifiedSignups.observedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(metrics.payingCustomers.stale).toBe(false);
    expect(LAUNCH_METRIC_STALE_SECONDS).toBe(3_600);
  });

  it('ADS-136 with no campaign running, ad attribution is unknown rather than zero', async () => {
    const port = createMemoryGrowthPort();
    await seed(port, [session({ id: 'a' })]);
    const metrics = await readLaunchMetrics(input(port, { campaignUtm: undefined }));
    expect(metrics.totalVisits.value).toBe(1);
    expect(metrics.adAttributedVisits.known).toBe(false);
    expect(metrics.adAttributedVisits.note).toMatch(/No campaign is running/);
  });

  it('ADS-137 the ten-visit statement is a target and never reads as a forecast', async () => {
    const port = createMemoryGrowthPort();
    await seed(port, [session({ id: 'a' })]);
    const metrics = await readLaunchMetrics(input(port));

    expect(metrics.target.target).toBe(EXTERNAL_VISIT_TARGET);
    expect(metrics.target.met).toBe(false);
    expect(metrics.target.statement).toMatch(/target, not a forecast/);
    // Nothing anywhere in the rendered object may project, promise or expect traffic.
    const text = JSON.stringify(metrics).toLowerCase();
    for (const forbidden of ['we expect', 'projected', 'forecast of', 'will reach', 'guarantee']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('ADS-138 a read that throws is contained, so the owner panel still renders', async () => {
    const exploding = {
      ...createMemoryGrowthPort(),
      async countVisits() {
        throw new Error('D1 unavailable');
      },
    };
    const metrics = await readLaunchMetrics(input(exploding));
    expect(metrics.totalVisits.known).toBe(false);
    expect(metrics.target.met).toBeNull();
  });
});
