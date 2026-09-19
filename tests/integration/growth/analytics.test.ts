/**
 * Attribution and growth reporting.
 *
 * The properties: our own testing and suspected crawlers are never attributed to a campaign
 * and never count toward the ten; the aggregate view holds counts and nothing that could
 * reconstruct one visitor's journey; and figures from different systems are reported side
 * by side rather than forced to agree.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_WINDOW_DAYS,
  EXTERNAL_VISIT_TARGET,
  VISIT_RETENTION_DAYS,
  type PlatformMetrics,
  type VisitSession,
  aggregateOnly,
  attributeSignup,
  summariseGrowth,
  targetProgress,
} from '@app/growth/analytics';

const NOW = new Date('2026-10-07T10:00:00.000Z');
const CAMPAIGN = 'verify_first_test';

const session = (over: Partial<VisitSession>): VisitSession => ({
  id: `s_${Math.random().toString(36).slice(2)}`,
  first_seen_at: '2026-10-07T10:00:00.000Z',
  last_seen_at: '2026-10-07T10:00:00.000Z',
  landing_path: '/',
  utm_source: 'reddit',
  utm_medium: 'cpc',
  utm_campaign: CAMPAIGN,
  classification: 'external',
  page_views: 1,
  expires_at: '2026-11-06T10:00:00.000Z',
  ...over,
});

const report = (
  sessions: readonly VisitSession[],
  platform: PlatformMetrics = {
    impressions: 900,
    clicks: 12,
    spend_minor: 1_150,
    retrieved_at: '2026-10-07T09:55:00.000Z',
  },
) =>
  summariseGrowth({
    sessions,
    platform,
    campaign_utm: CAMPAIGN,
    qualified_signups: 0,
    paid_customers: 0,
    max_metric_age_seconds: 3_600,
    now: NOW,
  });

describe('attribution', () => {
  it('ADS-022 a signup is attributed only inside the documented attribution window', () => {
    const visit = session({ first_seen_at: '2026-10-01T09:00:00.000Z' });
    const inside = attributeSignup(visit, '2026-10-10T09:00:00.000Z', CAMPAIGN);
    expect(inside).toMatchObject({ attributed: true, campaign: CAMPAIGN });

    const outside = attributeSignup(visit, '2026-10-20T09:00:00.000Z', CAMPAIGN);
    expect(outside).toMatchObject({ attributed: false, reason: 'outside_window' });

    // The window can never exceed how long we keep the session, because attribution reads
    // a row A09's sweep will already have deleted.
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(14);
    expect(ATTRIBUTION_WINDOW_DAYS).toBeLessThanOrEqual(VISIT_RETENTION_DAYS);

    // A signup that happened before the visit is not caused by it.
    expect(attributeSignup(visit, '2026-09-30T09:00:00.000Z', CAMPAIGN)).toMatchObject({
      attributed: false,
      reason: 'signup_before_visit',
    });
  });

  it('ADS-023 attribution is never claimed for a visit classified internal_test or bot_suspected', () => {
    for (const classification of ['internal_test', 'bot_suspected', 'unknown'] as const) {
      const result = attributeSignup(
        session({ classification, first_seen_at: '2026-10-06T09:00:00.000Z' }),
        '2026-10-07T09:00:00.000Z',
        CAMPAIGN,
      );
      expect(result, classification).toMatchObject({ attributed: false, reason: 'not_external_traffic' });
    }
  });

  it('ADS-103 a session with a different campaign tag, or none, is not attributed to this campaign', () => {
    expect(attributeSignup(session({ utm_campaign: 'other' }), '2026-10-07T12:00:00.000Z', CAMPAIGN)).toMatchObject({
      attributed: false,
      reason: 'different_campaign',
    });
    expect(attributeSignup(session({ utm_campaign: null }), '2026-10-07T12:00:00.000Z', CAMPAIGN)).toMatchObject({
      attributed: false,
      reason: 'no_campaign_utm',
    });
  });
});

describe('growth reporting', () => {
  it('ADS-025 the aggregate view exposes counts only, never an individual visitor’s path', () => {
    const sessions = [
      session({ id: 'a', landing_path: '/pricing' }),
      session({ id: 'b', landing_path: '/demo' }),
      session({ id: 'c', classification: 'bot_suspected' }),
    ];
    const aggregate = aggregateOnly(report(sessions));
    const serialised = JSON.stringify(aggregate);
    expect(serialised).not.toContain('/pricing');
    expect(serialised).not.toContain('/demo');
    expect(serialised).not.toContain('"a"');
    expect(Object.values(aggregate).every((v) => typeof v === 'number')).toBe(true);
    expect(aggregate.external_sessions).toBe(2);
    expect(aggregate.excluded_bot_suspected).toBe(1);
  });

  it('ADS-104 a session with no UTM still counts as a visit but is not ad-attributed', () => {
    const r = report([
      session({ id: 'a' }),
      session({ id: 'b', utm_source: null, utm_medium: null, utm_campaign: null }),
    ]);
    expect(r.observed_landing_sessions).toBe(2);
    expect(r.ad_attributed_sessions).toBe(1);
    expect(r.unattributed_sessions).toBe(1);
  });

  it('ADS-105 platform clicks and observed sessions are reported separately and never reconciled', () => {
    const r = summariseGrowth({
      sessions: [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })],
      platform: { impressions: 1_200, clicks: 14, spend_minor: 1_150, retrieved_at: '2026-10-07T09:55:00.000Z' },
      campaign_utm: CAMPAIGN,
      qualified_signups: 1,
      paid_customers: 0,
      max_metric_age_seconds: 3_600,
      now: NOW,
    });
    expect(r.platform_clicks).toBe(14);
    expect(r.observed_landing_sessions).toBe(3);
    expect(r.qualified_signups).toBe(1);
    expect(r.paid_customers).toBe(0);
    expect(r.attribution_complete).toBe(false);
    expect(r.caveats.join(' ')).toMatch(/will not agree/);
  });

  it('ADS-106 repeated sessions with the same daily id are deduplicated and called an estimate', () => {
    const r = report([session({ id: 'same' }), session({ id: 'same' }), session({ id: 'other' })]);
    expect(r.observed_landing_sessions).toBe(2);
    expect(r.caveats.join(' ')).toMatch(/not a count of unique people/);
    expect(targetProgress(r).statement).toMatch(/sessions, not people/);
  });

  it('ADS-107 platform metrics never retrieved are reported unknown and stale, never zero', () => {
    const r = report([session({ id: 'a' })], {
      impressions: null,
      clicks: null,
      spend_minor: null,
      retrieved_at: null,
    });
    expect(r.platform_clicks).toBeNull();
    expect(r.platform_spend_minor).toBeNull();
    expect(r.platform_metrics_stale).toBe(true);
    expect(r.caveats.join(' ')).toMatch(/unknown, not zero/);
  });

  it('ADS-108 stale platform metrics are flagged with the time they were retrieved', () => {
    const r = report([session({ id: 'a' })], {
      impressions: 10,
      clicks: 1,
      spend_minor: 200,
      retrieved_at: '2026-10-01T09:00:00.000Z',
    });
    expect(r.platform_metrics_stale).toBe(true);
    expect(r.platform_metrics_retrieved_at).toBe('2026-10-01T09:00:00.000Z');
    expect(r.caveats.join(' ')).toMatch(/2026-10-01T09:00:00\.000Z/);
  });

  it('ADS-109 more landing sessions than platform clicks is surfaced as a caveat, not averaged away', () => {
    const r = report([session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })], {
      impressions: 40,
      clicks: 1,
      spend_minor: 90,
      retrieved_at: '2026-10-07T09:55:00.000Z',
    });
    expect(r.platform_clicks).toBe(1);
    expect(r.observed_landing_sessions).toBe(3);
    expect(r.caveats.join(' ')).toMatch(/do not attribute it to the campaign/);
  });

  it('ADS-110 the ten-visit target is met only by external sessions, and internal tests never count', () => {
    const nine: VisitSession[] = [
      ...Array.from({ length: 9 }, (_, i) => session({ id: `e${i}` })),
      session({ id: 'internal', classification: 'internal_test' }),
      session({ id: 'bot', classification: 'bot_suspected' }),
      session({ id: 'unknown', classification: 'unknown' }),
    ];
    expect(EXTERNAL_VISIT_TARGET).toBe(10);

    const short = report(nine);
    expect(short.observed_landing_sessions).toBe(9);
    expect(short.excluded).toEqual({ bot_suspected: 1, internal_test: 1, unknown: 1 });
    expect(targetProgress(short).met).toBe(false);

    const met = report([...nine, session({ id: 'e9' })]);
    expect(targetProgress(met)).toMatchObject({ met: true, observed_external_sessions: 10 });
  });
});
