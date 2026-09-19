/**
 * Campaign packet validation and approval binding.
 *
 * The property under test throughout: an approval is a statement about one exact packet.
 * Move a penny and it stops applying; move a key and nothing happens. Anything that can
 * expand exposure or change a published claim needs the owner again; anything that shrinks
 * exposure does not, because a safety action must never be blocked on a human being awake.
 */
import { describe, expect, it } from 'vitest';
import {
  type CampaignPacket,
  FORBIDDEN_AD_PHRASES,
  SUPPORTED_CONNECTOR_NAMES,
  bindApproval,
  canFundCampaign,
  canonicalApprovalPayload,
  classifyChange,
  forbiddenClaimsIn,
  isApprovalValidFor,
  packetHash,
  validateCampaignPacket,
} from '@app/growth/approval';
import { BUDGET } from '@verify/contracts';
import { stableStringify } from '@verify/security';

const ALLOCATION = { allocation_minor: BUDGET.ALLOC_ADVERTISING_PENCE };

const PACKET: CampaignPacket = {
  platform: 'reddit',
  budget_minor: 1_150,
  currency: 'GBP',
  audience: {
    description: 'People who build and maintain automations for their own clients',
    targets: ['r/n8n', 'r/Zapier', 'r/automate', 'r/msp'],
    negatives: ['job', 'hiring', 'course', 'free'],
    geography: ['GB'],
    languages: ['en'],
  },
  creative: {
    headline: 'Did your automation finish the job?',
    body: 'Check CRM records and email outcomes against your rules. See evidence when a run passes, fails or cannot be verified. HubSpot and Resend only, one workflow shape.',
    call_to_action: 'Explore ITISYOU Verify',
  },
  destination: {
    url: 'https://verify.itisyou.app/?utm_source=reddit&utm_medium=cpc&utm_campaign=verify_first_test',
    conversion_definition: 'a workspace is created and its HubSpot connection reaches ready',
  },
  duration: {
    starts_at: '2026-10-05T09:00:00.000Z',
    ends_at: '2026-10-11T23:59:00.000Z',
    timezone: 'Europe/London',
  },
  bidding: { max_cpc_minor: 160, strategy: 'manual_cpc' },
};

const BIND = {
  id: 'apr_1',
  owner_id: 'usr_owner',
  maximum_amount_minor: 1_422,
  created_at: '2026-09-19T10:00:00.000Z',
  expires_at: '2026-10-03T10:00:00.000Z',
};

const NOW = new Date('2026-09-20T10:00:00.000Z');

const codes = (packet: CampaignPacket) => validateCampaignPacket(packet, ALLOCATION).map((d) => d.code);

describe('campaign packet validation', () => {
  it('ADS-001 a budget above the advertising allocation is refused, naming the ceiling', () => {
    const over = { ...PACKET, budget_minor: 2_000 };
    const defects = validateCampaignPacket(over, ALLOCATION);
    expect(defects.map((d) => d.code)).toContain('budget_exceeds_allocation');
    expect(defects.find((d) => d.code === 'budget_exceeds_allocation')?.detail).toContain(
      String(BUDGET.ALLOC_ADVERTISING_PENCE),
    );
    // And exactly at the allocation is fine — the ceiling is inclusive.
    expect(codes({ ...PACKET, budget_minor: BUDGET.ALLOC_ADVERTISING_PENCE })).toEqual([]);
  });

  it('ADS-002 a packet with no end date is refused', () => {
    expect(codes({ ...PACKET, duration: { ...PACKET.duration, ends_at: '' } })).toContain('missing_end_date');
    expect(
      codes({ ...PACKET, duration: { ...PACKET.duration, ends_at: '2026-10-01T00:00:00.000Z' } }),
    ).toContain('end_not_after_start');
  });

  it('ADS-003 creative text is checked against the forbidden-claims list, naming the term', () => {
    const defects = validateCampaignPacket(
      {
        ...PACKET,
        creative: { ...PACKET.creative, headline: 'Guaranteed accuracy for your automations' },
      },
      ALLOCATION,
    );
    const forbidden = defects.find((d) => d.code === 'forbidden_claim');
    expect(forbidden).toBeDefined();
    expect(forbidden?.detail).toContain('guaranteed accuracy');
    expect(FORBIDDEN_AD_PHRASES).toContain('never lose a lead');
    expect(FORBIDDEN_AD_PHRASES).toContain('certified secure');
  });

  it('ADS-004 a packet may not claim a connector the product does not have', () => {
    const defects = validateCampaignPacket(
      {
        ...PACKET,
        creative: { ...PACKET.creative, body: 'Works with Salesforce, Pipedrive and any CRM you already use.' },
      },
      ALLOCATION,
    );
    const claims = defects.filter((d) => d.code === 'unsupported_connector_claim');
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims[0]?.detail).toContain(SUPPORTED_CONNECTOR_NAMES.join(', '));
    // The approved copy names only what we have.
    expect(codes(PACKET)).toEqual([]);
  });

  it('ADS-028 the destination must be https and must carry a utm_campaign', () => {
    expect(codes({ ...PACKET, destination: { ...PACKET.destination, url: 'http://verify.example/?utm_campaign=x' } })).toContain(
      'destination_not_https',
    );
    expect(codes({ ...PACKET, destination: { ...PACKET.destination, url: 'https://verify.example/' } })).toContain(
      'destination_missing_utm',
    );
  });

  it('ADS-029 a non-integer or non-positive budget is a defect, never rounded', () => {
    expect(codes({ ...PACKET, budget_minor: 11.5 })).toContain('budget_not_integer_minor');
    expect(codes({ ...PACKET, budget_minor: 0 })).toContain('budget_not_positive');
  });

  it('ADS-030 a packet with no audience targets is refused', () => {
    expect(codes({ ...PACKET, audience: { ...PACKET.audience, targets: [] } })).toContain('no_targets');
  });

  it('ADS-031 a campaign cannot be funded from an allocation that is already committed', () => {
    const state = {
      authorised_limit_minor: BUDGET.ALLOC_ADVERTISING_PENCE,
      spent_minor: 0,
      reserved_minor: 0,
      committed_minor: 500,
      safety_buffer_minor: 0,
      currency: 'GBP' as const,
    };
    expect(canFundCampaign(state, PACKET)).toBe(false);
    expect(canFundCampaign({ ...state, committed_minor: 0 }, PACKET)).toBe(true);
    // A currency mismatch is never silently converted.
    expect(canFundCampaign({ ...state, committed_minor: 0, currency: 'USD' }, PACKET)).toBe(false);
  });
});

describe('approval binding', () => {
  it('ADS-032 changing the budget by one penny changes the approval hash', async () => {
    const before = await packetHash(PACKET);
    const after = await packetHash({ ...PACKET, budget_minor: PACKET.budget_minor + 1 });
    expect(after).not.toBe(before);
  });

  it('ADS-033 reordering the keys of the packet does not change the hash', async () => {
    const reordered: CampaignPacket = {
      bidding: PACKET.bidding,
      duration: {
        timezone: PACKET.duration.timezone,
        ends_at: PACKET.duration.ends_at,
        starts_at: PACKET.duration.starts_at,
      },
      destination: {
        conversion_definition: PACKET.destination.conversion_definition,
        url: PACKET.destination.url,
      },
      creative: {
        call_to_action: PACKET.creative.call_to_action,
        body: PACKET.creative.body,
        headline: PACKET.creative.headline,
      },
      audience: {
        languages: PACKET.audience.languages,
        geography: PACKET.audience.geography,
        negatives: PACKET.audience.negatives,
        targets: PACKET.audience.targets,
        description: PACKET.audience.description,
      },
      currency: PACKET.currency,
      budget_minor: PACKET.budget_minor,
      platform: PACKET.platform,
    };
    expect(await packetHash(reordered)).toBe(await packetHash(PACKET));
  });

  it('ADS-034 reordering a keyword list DOES change the hash, because list order is meaningful', async () => {
    const swapped: CampaignPacket = {
      ...PACKET,
      audience: { ...PACKET.audience, targets: ['r/Zapier', 'r/n8n', 'r/automate', 'r/msp'] },
    };
    expect(await packetHash(swapped)).not.toBe(await packetHash(PACKET));
  });

  it('ADS-035 the canonical payload contains exactly the five approved fields', () => {
    expect(Object.keys(canonicalApprovalPayload(PACKET)).sort()).toEqual([
      'audience',
      'budget_minor',
      'creative',
      'destination',
      'duration',
    ]);
  });

  it('ADS-036 a bound approval validates the packet it was bound to, and rejects a raised budget', async () => {
    const approval = await bindApproval(PACKET, BIND);
    await expect(isApprovalValidFor(approval, PACKET, NOW)).resolves.toMatchObject({ valid: true });
    await expect(
      isApprovalValidFor(approval, { ...PACKET, budget_minor: PACKET.budget_minor + 1 }, NOW),
    ).resolves.toMatchObject({ valid: false, reason: 'payload_changed' });
  });

  it('ADS-037 a bid reduction inside an approved campaign keeps the approval valid', async () => {
    const approval = await bindApproval(PACKET, BIND);
    const cheaper: CampaignPacket = { ...PACKET, bidding: { max_cpc_minor: 90, strategy: 'manual_cpc' } };
    await expect(isApprovalValidFor(approval, cheaper, NOW)).resolves.toMatchObject({ valid: true });
    expect(classifyChange(PACKET, cheaper)).toMatchObject({
      classification: 'reduces_exposure',
      allowed_under_existing_approval: true,
    });
  });

  it('ADS-038 raising the bid cap needs a fresh approval even though the budget is unchanged', () => {
    const dearer: CampaignPacket = { ...PACKET, bidding: { max_cpc_minor: 400, strategy: 'manual_cpc' } };
    expect(classifyChange(PACKET, dearer)).toMatchObject({
      classification: 'expands_exposure',
      allowed_under_existing_approval: false,
    });
  });

  it('ADS-039 raising the budget is classified as expanding exposure, not as a reduction', () => {
    const verdict = classifyChange(PACKET, { ...PACKET, budget_minor: 1_400 });
    expect(verdict.classification).toBe('expands_exposure');
    expect(verdict.changed_fields).toContain('budget_minor');
  });

  it('ADS-040 lowering the budget and narrowing the audience is allowed under the existing approval', () => {
    const narrower: CampaignPacket = {
      ...PACKET,
      budget_minor: 900,
      audience: {
        ...PACKET.audience,
        targets: ['r/n8n'],
        negatives: [...PACKET.audience.negatives, 'tutorial'],
      },
    };
    expect(classifyChange(PACKET, narrower)).toMatchObject({
      classification: 'reduces_exposure',
      allowed_under_existing_approval: true,
    });
  });

  it('ADS-041 adding a community that was never approved expands exposure', () => {
    const wider: CampaignPacket = {
      ...PACKET,
      audience: { ...PACKET.audience, targets: [...PACKET.audience.targets, 'r/smallbusiness'] },
    };
    expect(classifyChange(PACKET, wider).classification).toBe('expands_exposure');
  });

  it('ADS-042 changing one word of the ad body is an altered claim, never a reduction', () => {
    const edited: CampaignPacket = {
      ...PACKET,
      creative: { ...PACKET.creative, body: `${PACKET.creative.body} Guaranteed accuracy.` },
    };
    expect(classifyChange(PACKET, edited)).toMatchObject({
      classification: 'alters_claim',
      allowed_under_existing_approval: false,
    });
  });

  it('ADS-043 changing the destination URL is an altered claim', () => {
    const redirected: CampaignPacket = {
      ...PACKET,
      destination: { ...PACKET.destination, url: 'https://verify.itisyou.app/pricing?utm_campaign=x' },
    };
    expect(classifyChange(PACKET, redirected).classification).toBe('alters_claim');
  });

  it('ADS-044 a revoked or expired approval fails before the hash is even compared', async () => {
    const approval = await bindApproval(PACKET, BIND);
    await expect(isApprovalValidFor({ ...approval, status: 'revoked' }, PACKET, NOW)).resolves.toMatchObject({
      valid: false,
      reason: 'status_not_granted',
    });
    await expect(
      isApprovalValidFor(approval, PACKET, new Date('2026-11-01T00:00:00.000Z')),
    ).resolves.toMatchObject({ valid: false, reason: 'expired' });
  });

  it('ADS-045 changing the platform or the currency is reported by name, not as an opaque hash mismatch', async () => {
    const approval = await bindApproval(PACKET, BIND);
    await expect(
      isApprovalValidFor(approval, { ...PACKET, platform: 'google_ads' }, NOW),
    ).resolves.toMatchObject({ valid: false, reason: 'platform_mismatch' });
    await expect(isApprovalValidFor(approval, { ...PACKET, currency: 'USD' }, NOW)).resolves.toMatchObject({
      valid: false,
      reason: 'currency_mismatch',
    });
  });

  it('ADS-046 an approval cannot be bound for less than the packet it approves', async () => {
    await expect(bindApproval(PACKET, { ...BIND, maximum_amount_minor: 1_000 })).rejects.toThrow(
      /below the packet budget/,
    );
  });

  it('ADS-047 a non-integer budget is refused before it can reach a hash or a cap', async () => {
    await expect(packetHash({ ...PACKET, budget_minor: 11.5 })).rejects.toThrow(/integer/);
  });

  it('ADS-048 the hash is domain-prefixed, so it is not a bare digest of the canonical payload', async () => {
    const bare = stableStringify(canonicalApprovalPayload(PACKET));
    const hash = await packetHash(PACKET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(bare);
  });

  it('ADS-049 a forbidden phrase is found regardless of case and reported with its field', () => {
    expect(
      forbiddenClaimsIn({
        headline: 'CERTIFIED SECURE verification',
        body: 'Works with every AI you already use.',
        call_to_action: 'Start now',
      }),
    ).toEqual(
      expect.arrayContaining([
        { field: 'headline', phrase: 'certified secure' },
        { field: 'body', phrase: 'works with every ai' },
      ]),
    );
    expect(forbiddenClaimsIn(PACKET.creative)).toEqual([]);
  });
});
