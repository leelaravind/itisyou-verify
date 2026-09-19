/**
 * Campaign creation through the manual adapter, and the cap arithmetic that decides which
 * platform we could use at all.
 *
 * The adapter is exercised end to end against an in-memory store. No network is touched;
 * the global fetch guard in `tests/setup.ts` would fail the suite if it were.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_ADS_FACTS,
  LINKEDIN_FACTS,
  LONGEST_MONTH_DAYS,
  META_FACTS,
  MICROSOFT_ADS_FACTS,
  REDDIT_FACTS,
  type CampaignRef,
  type ManualAdsStore,
  type PublishRequest,
  capVerdict,
  createManualAdsAdapter,
  createRedditPlannerAdapter,
  inMemoryManualStore,
  isAdsFailure,
  planCampaignCreation,
  recordExternalId,
  recordObservation,
} from '../../../packages/connectors/src/ads';
import {
  type CampaignPacket,
  bindApproval,
  canFundCampaign,
  isApprovalValidFor,
} from '@app/growth/approval';
import { BUDGET } from '@verify/contracts';

const NOW = new Date('2026-10-05T09:00:00.000Z');
const LATER = new Date('2026-10-05T09:20:00.000Z');

const REF: CampaignRef = { local_id: 'cmp_1', external_id: null, platform: 'reddit' };

const PACKET: CampaignPacket = {
  platform: 'reddit',
  budget_minor: 1_150,
  currency: 'GBP',
  audience: {
    description: 'People who build and maintain automations for their own clients',
    targets: ['r/n8n', 'r/msp'],
    negatives: ['job', 'course'],
    geography: ['GB'],
    languages: ['en'],
  },
  creative: {
    headline: 'Did your automation finish the job?',
    body: 'Check CRM records and email outcomes against your rules.',
    call_to_action: 'Explore ITISYOU Verify',
  },
  destination: {
    url: 'https://verify.itisyou.app/?utm_campaign=verify_first_test',
    conversion_definition: 'a workspace is created and its HubSpot connection reaches ready',
  },
  duration: {
    starts_at: '2026-10-06T09:00:00.000Z',
    ends_at: '2026-10-13T09:00:00.000Z',
    timezone: 'Europe/London',
  },
  bidding: { max_cpc_minor: 160, strategy: 'manual_cpc' },
};

const PUBLISH: PublishRequest = {
  ref: REF,
  packet_json: JSON.stringify(PACKET),
  approved_payload_hash: 'a'.repeat(64),
  budget_minor: PACKET.budget_minor,
  currency: 'GBP',
  starts_at: PACKET.duration.starts_at,
  ends_at: PACKET.duration.ends_at,
  idempotency_key: 'idem_1',
  approval_id: 'apr_1',
  approved_maximum_minor: 1_422,
};

function adapter(store: ManualAdsStore = inMemoryManualStore()) {
  return {
    store,
    ads: createManualAdsAdapter({
      platform: 'reddit',
      capFacts: REDDIT_FACTS,
      store,
      blockers: ['no account', 'no billing method', 'no API access'],
    }),
  };
}

describe('campaign lifecycle through the manual adapter', () => {
  it('ADS-013 creating a campaign requires an owner approval bound to the exact packet hash', async () => {
    const { ads } = adapter();
    // No approval id at all: refused outright, and no submission instructions are produced.
    const noApproval = await ads.publishApproved({ ...PUBLISH, approval_id: '' }, NOW);
    expect(isAdsFailure(noApproval)).toBe(true);
    if (isAdsFailure(noApproval)) expect(noApproval.code).toBe('NOT_APPROVED');

    // A real approval, bound to this packet, validates it.
    const approval = await bindApproval(PACKET, {
      id: 'apr_1',
      owner_id: 'usr_owner',
      maximum_amount_minor: 1_422,
      created_at: '2026-09-19T10:00:00.000Z',
      expires_at: '2026-10-19T10:00:00.000Z',
    });
    await expect(isApprovalValidFor(approval, PACKET, NOW)).resolves.toMatchObject({ valid: true });
  });

  it('ADS-014 changing a packet after approval invalidates the approval and a fresh one is required', async () => {
    const approval = await bindApproval(PACKET, {
      id: 'apr_1',
      owner_id: 'usr_owner',
      maximum_amount_minor: 1_422,
      created_at: '2026-09-19T10:00:00.000Z',
      expires_at: '2026-10-19T10:00:00.000Z',
    });
    const edited: CampaignPacket = { ...PACKET, budget_minor: PACKET.budget_minor + 1 };
    const check = await isApprovalValidFor(approval, edited, NOW);
    expect(check).toMatchObject({ valid: false, reason: 'payload_changed' });

    // A fresh approval over the edited packet produces a different hash.
    const reapproved = await bindApproval(edited, {
      id: 'apr_2',
      owner_id: 'usr_owner',
      maximum_amount_minor: 1_422,
      created_at: '2026-09-19T11:00:00.000Z',
      expires_at: '2026-10-19T11:00:00.000Z',
    });
    expect(reapproved.canonical_payload_hash).not.toBe(approval.canonical_payload_hash);
    await expect(isApprovalValidFor(reapproved, edited, NOW)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('ADS-015 a retried creation with the same idempotency key does not produce a second campaign', async () => {
    const { ads, store } = adapter();
    await ads.publishApproved(PUBLISH, NOW);
    await recordExternalId(store, 'cmp_1', 't2_reddit_99');

    const again = await ads.publishApproved(PUBLISH, LATER);
    expect(isAdsFailure(again)).toBe(false);
    if (isAdsFailure(again)) return;
    expect(again.manual_steps).toEqual([]);
    expect(again.state).toBe('submitted');
    expect(again.ref.external_id).toBe('t2_reddit_99');

    const record = await store.get('cmp_1');
    expect(record?.submission_attempts).toEqual(['idem_1']);
  });

  it('ADS-016 a campaign cannot be created when the allocation has insufficient available budget', async () => {
    const committed = {
      authorised_limit_minor: BUDGET.ALLOC_ADVERTISING_PENCE,
      spent_minor: 600,
      reserved_minor: 0,
      committed_minor: 0,
      safety_buffer_minor: 0,
      currency: 'GBP' as const,
    };
    expect(canFundCampaign(committed, PACKET)).toBe(false);

    // And the adapter refuses anything above the approved maximum, so no instruction set
    // that could lead to a provider call is produced.
    const { ads } = adapter();
    const over = await ads.publishApproved({ ...PUBLISH, budget_minor: 1_423 }, NOW);
    expect(isAdsFailure(over)).toBe(true);
    if (isAdsFailure(over)) expect(over.code).toBe('BUDGET_EXCEEDS_APPROVAL');
  });

  it('ADS-018 a campaign at its budget cap passes through pause_pending and shows paused only after confirmation', async () => {
    const { ads, store } = adapter();
    await ads.createDraft(PUBLISH, NOW);
    await recordExternalId(store, 'cmp_1', 't2_reddit_99');
    await recordObservation(store, 'cmp_1', {
      source: 'reconciled_provider_read',
      state: 'active',
      spend_minor: PACKET.budget_minor,
      currency: 'GBP',
      observed_at: NOW.toISOString(),
      note: 'spend has reached the cap',
    });

    const requested = await ads.pause(REF, LATER);
    expect(isAdsFailure(requested)).toBe(false);
    if (isAdsFailure(requested)) return;
    expect(requested.state).toBe('pause_pending');
    expect(requested.source).toBe('local_intent');

    const duringPending = await ads.getStatus(REF, LATER);
    expect(isAdsFailure(duringPending)).toBe(false);
    if (isAdsFailure(duringPending)) return;
    expect(duringPending.state).toBe('pause_pending');

    await recordObservation(store, 'cmp_1', {
      source: 'owner_confirmation',
      state: 'paused',
      spend_minor: PACKET.budget_minor,
      currency: 'GBP',
      observed_at: LATER.toISOString(),
      note: 'owner reloaded twice, both showed Paused',
    });
    const confirmed = await ads.getStatus(REF, LATER);
    expect(isAdsFailure(confirmed)).toBe(false);
    if (isAdsFailure(confirmed)) return;
    expect(confirmed.state).toBe('paused');
    expect(confirmed.source).toBe('owner_confirmation');
  });

  it('ADS-069 validateAccess reports the adapter is not usable and lists what a human must clear', async () => {
    const { ads } = adapter();
    const check = await ads.validateAccess(NOW);
    expect(check.usable).toBe(false);
    expect(check.blockers.length).toBeGreaterThan(0);
    expect(check.checked_at).toBe(NOW.toISOString());
  });

  it('ADS-070 createDraft produces ordered, individually verifiable instructions and spends nothing', async () => {
    const { ads } = adapter();
    const draft = await ads.createDraft(PUBLISH, NOW);
    expect(isAdsFailure(draft)).toBe(false);
    if (isAdsFailure(draft)) return;
    expect(draft.state).toBe('awaiting_owner');
    expect(draft.manual_steps.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(draft.manual_steps.every((s) => s.verified_by.length > 0)).toBe(true);
    expect(draft.manual_steps[2]?.instruction).toContain(String(PACKET.budget_minor));
  });

  it('ADS-071 publishApproved never reports acceptance by a provider, because we submit nothing', async () => {
    const { ads } = adapter();
    const result = await ads.publishApproved(PUBLISH, NOW);
    expect(isAdsFailure(result)).toBe(false);
    if (isAdsFailure(result)) return;
    expect(result.accepted_by_provider).toBe(false);
    expect(result.state).toBe('ready_to_submit');
  });

  it('ADS-072 a non-integer budget is refused at the adapter boundary', async () => {
    const { ads } = adapter();
    const result = await ads.publishApproved({ ...PUBLISH, budget_minor: 1_150.01 }, NOW);
    expect(isAdsFailure(result)).toBe(true);
    if (isAdsFailure(result)) expect(result.code).toBe('INVALID_AMOUNT');
  });

  it('ADS-073 getStatus with nothing observed is unknown from source none — never draft and never active', async () => {
    const { ads } = adapter();
    await ads.createDraft(PUBLISH, NOW);
    const status = await ads.getStatus(REF, NOW);
    expect(isAdsFailure(status)).toBe(false);
    if (isAdsFailure(status)) return;
    expect(status.state).toBe('unknown');
    expect(status.source).toBe('none');
    expect(status.stale).toBe(true);
  });

  it('ADS-074 only a reconciled read or an owner confirmation can make the adapter say active', async () => {
    const { ads, store } = adapter();
    await ads.createDraft(PUBLISH, NOW);
    await recordExternalId(store, 'cmp_1', 't2_reddit_99');
    await recordObservation(store, 'cmp_1', {
      source: 'reconciled_provider_read',
      state: 'active',
      spend_minor: 240,
      currency: 'GBP',
      observed_at: LATER.toISOString(),
      note: 'ads manager showed delivering',
    });
    const status = await ads.getStatus(REF, LATER);
    expect(isAdsFailure(status)).toBe(false);
    if (isAdsFailure(status)) return;
    expect(status.state).toBe('active');
    expect(status.source).toBe('reconciled_provider_read');
    expect(status.observed_at).toBe(LATER.toISOString());
  });

  it('ADS-075 an active observation is refused when no external id has ever been recorded', async () => {
    const { ads, store } = adapter();
    await ads.createDraft(PUBLISH, NOW);
    const result = await recordObservation(store, 'cmp_1', {
      source: 'owner_confirmation',
      state: 'active',
      spend_minor: null,
      currency: 'GBP',
      observed_at: LATER.toISOString(),
      note: 'owner said it looked live',
    });
    expect(isAdsFailure(result)).toBe(true);
    if (isAdsFailure(result)) expect(result.code).toBe('EXTERNAL_ID_UNKNOWN');
  });

  it('ADS-076 a second, conflicting external id is refused — two ids means two campaigns', async () => {
    const { ads, store } = adapter();
    await ads.createDraft(PUBLISH, NOW);
    await recordExternalId(store, 'cmp_1', 't2_reddit_99');
    const clash = await recordExternalId(store, 'cmp_1', 't2_reddit_100');
    expect(isAdsFailure(clash)).toBe(true);
    if (isAdsFailure(clash)) expect(clash.message).toMatch(/two external ids/);
  });

  it('ADS-077 the whole adapter flow touches no network', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    try {
      const { ads, store } = adapter();
      await ads.validateAccess(NOW);
      await ads.createDraft(PUBLISH, NOW);
      await ads.publishApproved(PUBLISH, NOW);
      await recordExternalId(store, 'cmp_1', 't2_reddit_99');
      await ads.getStatus(REF, NOW);
      await ads.getSpend(REF, NOW);
      await ads.pause(REF, NOW);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('reddit planner', () => {
  it('ADS-078 every method refuses, because we hold no credentials and no API access', async () => {
    const planner = createRedditPlannerAdapter();
    for (const result of [
      await planner.createDraft(PUBLISH),
      await planner.publishApproved(PUBLISH),
      await planner.getStatus(REF),
      await planner.getSpend(REF),
      await planner.pause(REF),
    ]) {
      expect(isAdsFailure(result)).toBe(true);
      if (isAdsFailure(result)) expect(result.code).toBe('NO_CREDENTIALS');
    }
    expect((await planner.validateAccess(NOW)).usable).toBe(false);
  });

  it('ADS-079 the plan describes a reconcile read and carries the budget as integer minor units', () => {
    const plan = planCampaignCreation(PUBLISH);
    const budgetBody = plan.requests.find((r) => r.body !== null && 'goal_value_minor' in r.body);
    expect(budgetBody?.body?.['goal_value_minor']).toBe(PACKET.budget_minor);
    expect(plan.requests.some((r) => r.purpose.includes('reconcile'))).toBe(true);
    expect(plan.prerequisites.length).toBeGreaterThan(0);
  });
});

describe('cap enforceability', () => {
  const ALLOCATION = BUDGET.ALLOC_ADVERTISING_PENCE;

  it('ADS-080 the advertising allocation is £15 in integer pence, taken from the frozen contract', () => {
    expect(ALLOCATION).toBe(1_500);
    expect(Number.isSafeInteger(ALLOCATION)).toBe(true);
    expect(BUDGET.CONTINGENCY_GATED_PENCE).toBe(3_000);
  });

  it('ADS-081 Google Ads cannot enforce £15 as a true maximum — only a monthly limit exists', () => {
    const verdict = capVerdict(GOOGLE_ADS_FACTS, ALLOCATION);
    expect(GOOGLE_ADS_FACTS.cap_enforcement).toBe('monthly_only');
    expect(verdict.enforceable).toBe(false);
    // floor(1500 / 31) = 48 pence a day. Integer division; never a float.
    expect(verdict.max_average_daily_minor).toBe(Math.floor(ALLOCATION / LONGEST_MONTH_DAYS));
    expect(verdict.max_average_daily_minor).toBe(48);
    expect(GOOGLE_ADS_FACTS.cap_behaviour).toMatch(/30\.4 times your average daily budget/);
  });

  it('ADS-082 Microsoft Advertising is monthly-only, but its GBP floor fits inside the allocation', () => {
    const verdict = capVerdict(MICROSOFT_ADS_FACTS, ALLOCATION);
    // Still not a *total* ceiling, so `enforceable` stays false — the guarantee is monthly.
    expect(verdict.enforceable).toBe(false);
    expect(MICROSOFT_ADS_FACTS.cap_behaviour).toMatch(/paused automatically/);

    // But unlike every other candidate, the minimums are primary-sourced and in sterling:
    // GBP 0.05 minimum daily budget, GBP 5.00 minimum monthly budget.
    expect(MICROSOFT_ADS_FACTS.minimums_provenance).toBe('primary');
    expect(MICROSOFT_ADS_FACTS.currency).toBe('GBP');
    expect(MICROSOFT_ADS_FACTS.minimum_daily_minor).toBe(5);
    expect(MICROSOFT_ADS_FACTS.minimum_monthly_minor).toBe(500);
    // The floor fits, so the reason given is about the monthly guarantee, not the minimum.
    expect(verdict.reason).toMatch(/no total ceiling exists/);
    expect(verdict.max_average_daily_minor).toBe(48);
  });

  it('ADS-111 a monthly-only platform whose minimum monthly budget exceeds the allocation is refused on the floor', () => {
    const pricey = { ...MICROSOFT_ADS_FACTS, minimum_monthly_minor: 2_000 };
    const verdict = capVerdict(pricey, ALLOCATION);
    expect(verdict.enforceable).toBe(false);
    expect(verdict.reason).toMatch(
      /minimum monthly budget of 2000 minor units is above the 1500 allocated/,
    );
  });

  it('ADS-112 Reddit’s minimums are recorded as requiring a signed-in account, not as unresearched', () => {
    // Every public route was tried on 2026-09-19 and none serves the figure. Recording
    // that as a distinct state stops it being mistaken for a number nobody looked for.
    expect(REDDIT_FACTS.minimums_provenance).toBe('requires_account');
    expect(REDDIT_FACTS.minimums_source_url).toBeNull();
    expect(GOOGLE_ADS_FACTS.minimums_provenance).toBe('not_published');
    expect(META_FACTS.minimums_provenance).toBe('secondary');
    expect(LINKEDIN_FACTS.minimums_provenance).toBe('primary');
  });

  it('ADS-083 LinkedIn enforces a total budget but its floor is above the whole allocation', () => {
    const verdict = capVerdict(LINKEDIN_FACTS, ALLOCATION);
    expect(LINKEDIN_FACTS.cap_enforcement).toBe('total_budget');
    expect(verdict.enforceable).toBe(false);
    expect(verdict.reason).toMatch(/minimum of 10000 minor units/);
  });

  it('ADS-084 Reddit and Meta are the only candidates whose documented cap is a total ceiling', () => {
    expect(REDDIT_FACTS.cap_enforcement).toBe('total_budget');
    expect(META_FACTS.cap_enforcement).toBe('total_budget');
    expect(capVerdict(META_FACTS, ALLOCATION).enforceable).toBe(true);
  });

  it('ADS-085 Reddit’s stored minimum total budget is flagged as an unverified secondary figure', () => {
    // $25 is above £15 at any plausible rate; this is the single figure that decides
    // whether the experiment can run at all, and we could not read it from Reddit itself.
    expect(REDDIT_FACTS.primary_source).toBe(false);
    expect(REDDIT_FACTS.minimum_lifetime_minor).toBe(2_500);
    const verdict = capVerdict(REDDIT_FACTS, ALLOCATION);
    expect(verdict.enforceable).toBe(false);
    expect(verdict.reason).toMatch(/above the 1500 allocated/);
  });

  it('ADS-086 an allocation that is not a positive integer is refused by the cap arithmetic', () => {
    expect(capVerdict(REDDIT_FACTS, 15.5).enforceable).toBe(false);
    expect(capVerdict(REDDIT_FACTS, 0).enforceable).toBe(false);
  });
});
