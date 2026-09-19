/**
 * Metric freshness, automatic stop rules and pause verification.
 *
 * The money assertions here are deliberately blunt: every figure crossing a cap is an
 * integer number of pence, and a non-integer is a billing anomaly rather than something to
 * round. There is also a source-level check that no floating-point arithmetic exists
 * anywhere in the file that enforces the cap.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUFFER_MINOR,
  type StopInput,
  evaluateStops,
  firstHalt,
  isMetricStale,
  markStale,
  verifyPause,
} from '@app/growth/stops';
import {
  type CampaignRef,
  type PublishRequest,
  REDDIT_FACTS,
  createManualAdsAdapter,
  inMemoryManualStore,
  isAdsFailure,
  recordExternalId,
  recordObservation,
} from '../../../packages/connectors/src/ads';
import { BUDGET } from '@verify/contracts';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const FRESH = '2026-10-08T11:55:00.000Z';
const ANCIENT = '2026-10-01T09:00:00.000Z';

const BASE: StopInput = {
  campaign_state: 'active',
  allocated_minor: BUDGET.ALLOC_ADVERTISING_PENCE,
  buffer_minor: DEFAULT_BUFFER_MINOR,
  spend: { spend_minor: 500, observed_at: FRESH, source: 'reconciled_provider_read' },
  max_metric_age_seconds: 3_600,
  landing_page_healthy: true,
  checkout_healthy: true,
  billing_anomaly: null,
  approval_status: 'granted',
  owner_stop_command: false,
  critical_incident: null,
  now: NOW,
};

const reasons = (input: StopInput) => evaluateStops(input).map((d) => d.reason);

const REF: CampaignRef = { local_id: 'cmp_1', external_id: null, platform: 'reddit' };

const PUBLISH: PublishRequest = {
  ref: REF,
  packet_json: '{}',
  approved_payload_hash: 'a'.repeat(64),
  budget_minor: 1_150,
  currency: 'GBP',
  starts_at: '2026-10-06T09:00:00.000Z',
  ends_at: '2026-10-13T09:00:00.000Z',
  idempotency_key: 'idem_1',
  approval_id: 'apr_1',
  approved_maximum_minor: 1_422,
};

describe('metric freshness', () => {
  it('ADS-020 metrics older than the freshness threshold are marked stale with the time they were retrieved', () => {
    const stale = markStale(1_200, ANCIENT, 3_600, NOW);
    expect(stale).toMatchObject({ value: 1_200, stale: true, retrieved_at: ANCIENT });
    expect(stale.age_seconds).toBeGreaterThan(3_600);

    const fresh = markStale(1_200, FRESH, 3_600, NOW);
    expect(fresh).toMatchObject({ value: 1_200, stale: false, retrieved_at: FRESH });

    // Never retrieved is stale, and carries a null retrieval time rather than a made-up one.
    const never = markStale(1_200, null, 3_600, NOW);
    expect(never).toMatchObject({ stale: true, retrieved_at: null, age_seconds: null });
    expect(isMetricStale({ spend_minor: 0, observed_at: null, source: 'none' }, 3_600, NOW)).toBe(
      true,
    );
  });

  it('ADS-087 an observed spend older than the freshness budget is returned but marked stale', async () => {
    const store = inMemoryManualStore();
    const ads = createManualAdsAdapter({
      platform: 'reddit',
      capFacts: REDDIT_FACTS,
      store,
      blockers: [],
    });
    await ads.createDraft(PUBLISH, NOW);
    await recordExternalId(store, 'cmp_1', 't2_reddit_99');
    await recordObservation(store, 'cmp_1', {
      source: 'reconciled_provider_read',
      state: 'active',
      spend_minor: 812,
      currency: 'GBP',
      observed_at: ANCIENT,
      note: 'last week’s read',
    });
    const spend = await ads.getSpend(REF, NOW);
    expect(isAdsFailure(spend)).toBe(false);
    if (isAdsFailure(spend)) return;
    expect(spend.spend_minor).toBe(812);
    expect(spend.stale).toBe(true);
    expect(spend.observed_at).toBe(ANCIENT);
  });

  it('ADS-088 unknown spend is reported as null, never as zero', async () => {
    const store = inMemoryManualStore();
    const ads = createManualAdsAdapter({
      platform: 'reddit',
      capFacts: REDDIT_FACTS,
      store,
      blockers: [],
    });
    await ads.createDraft(PUBLISH, NOW);
    const spend = await ads.getSpend(REF, NOW);
    expect(isAdsFailure(spend)).toBe(false);
    if (isAdsFailure(spend)) return;
    expect(spend.spend_minor).toBeNull();
    expect(spend.source).toBe('none');
    expect(spend.stale).toBe(true);
  });
});

describe('automatic stop rules', () => {
  it('ADS-089 a healthy campaign well inside its allocation produces no stop', () => {
    expect(evaluateStops(BASE)).toEqual([]);
  });

  it('ADS-090 reaching the allocated exposure halts, using integer pence throughout', () => {
    const at = { ...BASE, spend: { ...BASE.spend, spend_minor: BUDGET.ALLOC_ADVERTISING_PENCE } };
    const halt = firstHalt(evaluateStops(at));
    expect(halt?.reason).toBe('allocated_exposure_reached');
    expect(halt?.severity).toBe('halt');
    expect(Number.isSafeInteger(BUDGET.ALLOC_ADVERTISING_PENCE)).toBe(true);
  });

  it('ADS-091 one penny below the allocation minus the buffer does not warn; reaching it does', () => {
    const threshold = BUDGET.ALLOC_ADVERTISING_PENCE - DEFAULT_BUFFER_MINOR;
    expect(reasons({ ...BASE, spend: { ...BASE.spend, spend_minor: threshold - 1 } })).toEqual([]);
    expect(reasons({ ...BASE, spend: { ...BASE.spend, spend_minor: threshold } })).toEqual([
      'allocated_exposure_approaching',
    ]);
  });

  it('ADS-092 a non-integer spend figure is a billing anomaly, never something to round', () => {
    const halt = firstHalt(
      evaluateStops({ ...BASE, spend: { ...BASE.spend, spend_minor: 1_499.5 } }),
    );
    expect(halt?.reason).toBe('billing_anomaly');
    expect(halt?.detail).toMatch(/integer/);
  });

  it('ADS-093 a negative spend figure halts rather than being treated as headroom', () => {
    expect(reasons({ ...BASE, spend: { ...BASE.spend, spend_minor: -100 } })).toContain(
      'billing_anomaly',
    );
  });

  it('ADS-094 unknown spend is not zero spend, and staying unknown too long is itself a stop', () => {
    const unknown = {
      ...BASE,
      spend: { spend_minor: null, observed_at: null, source: 'none' as const },
    };
    const halt = firstHalt(evaluateStops(unknown));
    expect(halt?.reason).toBe('spend_unknown_too_long');
    expect(halt?.on_stale_evidence).toBe(true);
  });

  it('ADS-095 a broken landing page or a broken checkout halts the campaign', () => {
    expect(reasons({ ...BASE, landing_page_healthy: false })).toContain('landing_page_broken');
    expect(reasons({ ...BASE, checkout_healthy: false })).toContain('checkout_broken');
  });

  it('ADS-096 a revoked approval, an owner command and a critical incident each halt', () => {
    expect(reasons({ ...BASE, approval_status: 'revoked' })).toContain('approval_revoked');
    expect(reasons({ ...BASE, approval_status: 'expired' })).toContain('approval_revoked');
    expect(reasons({ ...BASE, owner_stop_command: true })).toContain('owner_command');
    expect(reasons({ ...BASE, critical_incident: 'evidence connector leaking tokens' })).toContain(
      'critical_incident',
    );
  });

  it('ADS-097 a stop decided on a stale spend reading says so on the decision', () => {
    const stale: StopInput = {
      ...BASE,
      spend: {
        spend_minor: BUDGET.ALLOC_ADVERTISING_PENCE,
        observed_at: ANCIENT,
        source: 'reconciled_provider_read',
      },
    };
    const halt = firstHalt(evaluateStops(stale));
    expect(halt?.reason).toBe('allocated_exposure_reached');
    expect(halt?.on_stale_evidence).toBe(true);
  });

  it('ADS-098 no floating-point arithmetic appears in the module that enforces the cap', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../apps/app/src/growth/stops.ts', import.meta.url)),
      'utf8',
    );
    // Strip comments before scanning, so prose about money does not fail the check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      /parseFloat/,
      /toFixed/,
      /Math\.round/,
      /Math\.ceil/,
      /\*\s*0\./,
      /\*\s*1\./,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // No decimal literal appears anywhere in the code at all.
    expect(code).not.toMatch(/\b\d+\.\d+\b/);
    // The only division in the file converts milliseconds to seconds. Money is never divided.
    const divisions = code.match(/\/\s*[0-9_]+/g) ?? [];
    expect(divisions.length).toBeGreaterThan(0);
    expect(divisions.every((d) => d.replace(/\s|_/g, '') === '/1000')).toBe(true);
  });
});

describe('pause verification', () => {
  it('ADS-099 a pause we only requested is pause_pending, never paused', () => {
    const verdict = verifyPause(
      {
        pause_requested_at: FRESH,
        provider_state: 'active',
        provider_observed_at: FRESH,
        owner_confirmed_at: null,
        spend_minor_previous: 500,
        spend_minor_latest: 620,
      },
      3_600,
      NOW,
    );
    expect(verdict.verdict).toBe('pause_pending');
    expect(verdict.outstanding).toContain('two consecutive equal spend readings');
  });

  it('ADS-100 flat spend alone does not prove a pause', () => {
    expect(
      verifyPause(
        {
          pause_requested_at: FRESH,
          provider_state: null,
          provider_observed_at: null,
          owner_confirmed_at: null,
          spend_minor_previous: 500,
          spend_minor_latest: 500,
        },
        3_600,
        NOW,
      ).verdict,
    ).toBe('pause_pending');
  });

  it('ADS-101 a fresh reconciled read showing paused is the only automatic route to paused', () => {
    expect(
      verifyPause(
        {
          pause_requested_at: FRESH,
          provider_state: 'paused',
          provider_observed_at: FRESH,
          owner_confirmed_at: null,
          spend_minor_previous: 500,
          spend_minor_latest: 500,
        },
        3_600,
        NOW,
      ).verdict,
    ).toBe('paused');
    // The same read, gone stale, is no longer good enough.
    expect(
      verifyPause(
        {
          pause_requested_at: FRESH,
          provider_state: 'paused',
          provider_observed_at: ANCIENT,
          owner_confirmed_at: null,
          spend_minor_previous: 500,
          spend_minor_latest: 500,
        },
        3_600,
        NOW,
      ).verdict,
    ).toBe('pause_pending');
  });

  it('ADS-102 with nothing asked and nothing read the honest answer is unknown', () => {
    const verdict = verifyPause(
      {
        pause_requested_at: null,
        provider_state: null,
        provider_observed_at: null,
        owner_confirmed_at: null,
        spend_minor_previous: null,
        spend_minor_latest: null,
      },
      3_600,
      NOW,
    );
    expect(verdict.verdict).toBe('unknown');
    expect(verdict.outstanding.length).toBeGreaterThan(0);
  });
});
