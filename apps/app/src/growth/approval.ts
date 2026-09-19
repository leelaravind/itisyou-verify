/**
 * Approval binding — plan §25.1.
 *
 * An approval is not a boolean and not a timestamp. It is a **hash over the exact thing
 * the owner read**. If any of budget, audience, creative, destination or duration moves,
 * the hash moves, and the approval stops applying. Nobody has to remember to re-check.
 *
 * The hash is computed with `stableStringify` + `sha256Hex` from `@verify/security`, so
 * key insertion order and whitespace cannot change it: an approval cannot be invalidated
 * by a serialiser, and — more importantly — a changed number cannot be hidden by
 * reordering keys.
 *
 * Two fields are bound *outside* the hash, as their own columns on the approval row:
 * `platform` and `currency`. That is deliberate. Changing either is a real change, but
 * reporting it as "the hash no longer matches" tells the owner nothing; reporting it as
 * `platform_mismatch` tells them what happened. The `approvals` table already carries
 * `currency` and `maximum_amount_minor` as columns for exactly this reason.
 *
 * What is allowed to change without re-approval: a bid *reduction*, and a pause. Both
 * shrink exposure. Everything that expands exposure or alters a claim needs a new approval.
 */
import { type BudgetAccountState, type Currency, canReserve } from '@verify/contracts';
import { sha256Hex, stableStringify } from '@verify/security';

// ---------------------------------------------------------------------------
// The packet
// ---------------------------------------------------------------------------

export interface PacketAudience {
  /** Free-text description of who we are trying to reach, as approved. */
  readonly description: string;
  /** Placements/communities/keywords, whichever the platform uses. */
  readonly targets: readonly string[];
  readonly negatives: readonly string[];
  /** ISO 3166-1 alpha-2, e.g. `['GB']`. */
  readonly geography: readonly string[];
  readonly languages: readonly string[];
}

export interface PacketCreative {
  readonly headline: string;
  readonly body: string;
  readonly call_to_action: string;
}

export interface PacketDestination {
  /** Absolute https URL including UTM parameters, exactly as it will be pasted. */
  readonly url: string;
  /** What we will count as the conversion. Not "a click". */
  readonly conversion_definition: string;
}

export interface PacketDuration {
  readonly starts_at: string;
  readonly ends_at: string;
  /** IANA zone. The platform's schedule field is set in this zone, not in local time. */
  readonly timezone: string;
}

export interface PacketBidding {
  /** Maximum cost per click we will allow, integer minor units. `null` = platform-managed. */
  readonly max_cpc_minor: number | null;
  readonly strategy: string;
}

export interface CampaignPacket {
  readonly platform: string;
  /** The **net** ceiling the owner approved, integer minor units. Never a float. */
  readonly budget_minor: number;
  readonly currency: Currency;
  readonly audience: PacketAudience;
  readonly creative: PacketCreative;
  readonly destination: PacketDestination;
  readonly duration: PacketDuration;
  readonly bidding: PacketBidding;
}

// ---------------------------------------------------------------------------
// Canonical payload
// ---------------------------------------------------------------------------

/**
 * Exactly the five fields the approval covers, in a shape `stableStringify` will sort.
 * Arrays keep their order — order is meaningful in a keyword list — but object keys do not.
 */
export function canonicalApprovalPayload(packet: CampaignPacket): Record<string, unknown> {
  return {
    budget_minor: packet.budget_minor,
    audience: {
      description: packet.audience.description,
      targets: [...packet.audience.targets],
      negatives: [...packet.audience.negatives],
      geography: [...packet.audience.geography],
      languages: [...packet.audience.languages],
    },
    creative: {
      headline: packet.creative.headline,
      body: packet.creative.body,
      call_to_action: packet.creative.call_to_action,
    },
    destination: {
      url: packet.destination.url,
      conversion_definition: packet.destination.conversion_definition,
    },
    duration: {
      starts_at: packet.duration.starts_at,
      ends_at: packet.duration.ends_at,
      timezone: packet.duration.timezone,
    },
  };
}

/** Domain-prefixed so a campaign hash can never be replayed as some other approval type. */
export async function packetHash(packet: CampaignPacket): Promise<string> {
  if (!Number.isSafeInteger(packet.budget_minor)) {
    throw new TypeError('budget_minor must be an integer number of minor units');
  }
  return sha256Hex(
    `verify.approval.v1.campaign_launch:${stableStringify(canonicalApprovalPayload(packet))}`,
  );
}

// ---------------------------------------------------------------------------
// The approval record
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'granted' | 'consumed' | 'expired' | 'revoked';

export interface CampaignApproval {
  readonly id: string;
  readonly action_type: 'campaign_launch';
  readonly owner_id: string;
  readonly canonical_payload_hash: string;
  /** Gross ceiling including tax, integer minor units. Never below `budget_minor`. */
  readonly maximum_amount_minor: number;
  readonly currency: Currency;
  readonly platform: string;
  readonly status: ApprovalStatus;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface BindApprovalInput {
  readonly id: string;
  readonly owner_id: string;
  /** Gross ceiling the owner is accepting, including tax. Must be >= `packet.budget_minor`. */
  readonly maximum_amount_minor: number;
  readonly created_at: string;
  readonly expires_at: string;
}

export async function bindApproval(
  packet: CampaignPacket,
  input: BindApprovalInput,
): Promise<CampaignApproval> {
  if (!Number.isSafeInteger(input.maximum_amount_minor) || input.maximum_amount_minor < 0) {
    throw new TypeError(
      'maximum_amount_minor must be a non-negative integer number of minor units',
    );
  }
  if (input.maximum_amount_minor < packet.budget_minor) {
    throw new TypeError(
      `maximum_amount_minor ${input.maximum_amount_minor} is below the packet budget ${packet.budget_minor}; an approval cannot authorise less than the thing it approves`,
    );
  }
  return {
    id: input.id,
    action_type: 'campaign_launch',
    owner_id: input.owner_id,
    canonical_payload_hash: await packetHash(packet),
    maximum_amount_minor: input.maximum_amount_minor,
    currency: packet.currency,
    platform: packet.platform,
    status: 'granted',
    created_at: input.created_at,
    expires_at: input.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

export type ApprovalRejection =
  | 'action_type_mismatch'
  | 'status_not_granted'
  | 'expired'
  | 'payload_changed'
  | 'platform_mismatch'
  | 'currency_mismatch'
  | 'budget_exceeds_approved_maximum';

export type ApprovalCheck =
  | { readonly valid: true; readonly hash: string }
  | { readonly valid: false; readonly reason: ApprovalRejection; readonly detail: string };

export async function isApprovalValidFor(
  approval: CampaignApproval,
  packet: CampaignPacket,
  now: Date = new Date(),
): Promise<ApprovalCheck> {
  if (approval.action_type !== 'campaign_launch') {
    return {
      valid: false,
      reason: 'action_type_mismatch',
      detail: `action_type is ${approval.action_type}`,
    };
  }
  if (approval.status !== 'granted') {
    return {
      valid: false,
      reason: 'status_not_granted',
      detail: `approval status is ${approval.status}`,
    };
  }
  const expiry = Date.parse(approval.expires_at);
  if (Number.isNaN(expiry) || now.getTime() > expiry) {
    return {
      valid: false,
      reason: 'expired',
      detail: `approval expired at ${approval.expires_at}`,
    };
  }
  if (approval.platform !== packet.platform) {
    return {
      valid: false,
      reason: 'platform_mismatch',
      detail: `approved for ${approval.platform}, packet says ${packet.platform}`,
    };
  }
  if (approval.currency !== packet.currency) {
    return {
      valid: false,
      reason: 'currency_mismatch',
      detail: `approved in ${approval.currency}, packet says ${packet.currency}`,
    };
  }
  const hash = await packetHash(packet);
  if (hash !== approval.canonical_payload_hash) {
    return {
      valid: false,
      reason: 'payload_changed',
      detail: 'budget, audience, creative, destination or duration has changed since approval',
    };
  }
  // Integer comparison. Nothing here divides, multiplies or rounds.
  if (packet.budget_minor > approval.maximum_amount_minor) {
    return {
      valid: false,
      reason: 'budget_exceeds_approved_maximum',
      detail: `packet budget ${packet.budget_minor} exceeds approved maximum ${approval.maximum_amount_minor}`,
    };
  }
  return { valid: true, hash };
}

// ---------------------------------------------------------------------------
// In-flight changes
// ---------------------------------------------------------------------------

export type ChangeClass = 'no_change' | 'reduces_exposure' | 'expands_exposure' | 'alters_claim';

export interface ChangeVerdict {
  readonly classification: ChangeClass;
  /** True when the existing approval still covers the proposed packet. */
  readonly allowed_under_existing_approval: boolean;
  readonly changed_fields: readonly string[];
  readonly detail: string;
}

/**
 * Compare an approved packet with a proposed one and say whether the existing approval
 * still covers it.
 *
 * The asymmetry is the point: lowering a bid cap or shortening a run is a safety action
 * and must not require the owner to be awake. Raising a budget, widening an audience,
 * changing where the click lands, or changing a word of the ad text is a new promise to
 * the public and needs the owner again.
 */
export function classifyChange(approved: CampaignPacket, proposed: CampaignPacket): ChangeVerdict {
  const changed: string[] = [];

  if (approved.platform !== proposed.platform) changed.push('platform');
  if (approved.currency !== proposed.currency) changed.push('currency');
  if (approved.budget_minor !== proposed.budget_minor) changed.push('budget_minor');
  if (stableStringify(approved.audience) !== stableStringify(proposed.audience))
    changed.push('audience');
  if (stableStringify(approved.creative) !== stableStringify(proposed.creative))
    changed.push('creative');
  if (stableStringify(approved.destination) !== stableStringify(proposed.destination))
    changed.push('destination');
  if (stableStringify(approved.duration) !== stableStringify(proposed.duration))
    changed.push('duration');
  if (stableStringify(approved.bidding) !== stableStringify(proposed.bidding))
    changed.push('bidding');

  if (changed.length === 0) {
    return {
      classification: 'no_change',
      allowed_under_existing_approval: true,
      changed_fields: [],
      detail: 'packets are identical',
    };
  }

  // Any change to what the public sees, or where it lands, is a claim change.
  if (changed.includes('creative') || changed.includes('destination')) {
    return {
      classification: 'alters_claim',
      allowed_under_existing_approval: false,
      changed_fields: changed,
      detail:
        'the ad text or the destination changed; the owner approved specific words and a specific URL',
    };
  }

  // Everything else is judged on whether it can increase exposure.
  const expanding: string[] = [];
  if (changed.includes('platform')) expanding.push('platform');
  if (changed.includes('currency')) expanding.push('currency');
  if (proposed.budget_minor > approved.budget_minor) expanding.push('budget_minor');
  if (changed.includes('audience') && !audienceIsNarrower(approved.audience, proposed.audience)) {
    expanding.push('audience');
  }
  if (changed.includes('duration') && !durationIsShorter(approved.duration, proposed.duration)) {
    expanding.push('duration');
  }
  if (changed.includes('bidding') && !bidIsLower(approved.bidding, proposed.bidding)) {
    expanding.push('bidding');
  }

  if (expanding.length > 0) {
    return {
      classification: 'expands_exposure',
      allowed_under_existing_approval: false,
      changed_fields: changed,
      detail: `these changes can increase exposure and need a fresh approval: ${expanding.join(', ')}`,
    };
  }

  return {
    classification: 'reduces_exposure',
    allowed_under_existing_approval: true,
    changed_fields: changed,
    detail:
      'every change shrinks exposure (lower bid, lower budget, narrower audience or shorter run)',
  };
}

function bidIsLower(approved: PacketBidding, proposed: PacketBidding): boolean {
  if (approved.strategy !== proposed.strategy) return false;
  // Moving from platform-managed (null) to an explicit cap is a reduction; the reverse is not.
  if (approved.max_cpc_minor === null) return proposed.max_cpc_minor !== null;
  if (proposed.max_cpc_minor === null) return false;
  return proposed.max_cpc_minor < approved.max_cpc_minor;
}

function audienceIsNarrower(approved: PacketAudience, proposed: PacketAudience): boolean {
  if (approved.description !== proposed.description) return false;
  const approvedTargets = new Set(approved.targets);
  const approvedNegatives = new Set(approved.negatives);
  const approvedGeo = new Set(approved.geography);
  const approvedLang = new Set(approved.languages);
  // Every proposed target must already have been approved; negatives may only be added.
  if (!proposed.targets.every((t) => approvedTargets.has(t))) return false;
  if (!proposed.geography.every((g) => approvedGeo.has(g))) return false;
  if (!proposed.languages.every((l) => approvedLang.has(l))) return false;
  if (!approved.negatives.every((n) => proposed.negatives.includes(n))) return false;
  return proposed.negatives.length >= approvedNegatives.size;
}

function durationIsShorter(approved: PacketDuration, proposed: PacketDuration): boolean {
  if (approved.timezone !== proposed.timezone) return false;
  const aStart = Date.parse(approved.starts_at);
  const aEnd = Date.parse(approved.ends_at);
  const pStart = Date.parse(proposed.starts_at);
  const pEnd = Date.parse(proposed.ends_at);
  if ([aStart, aEnd, pStart, pEnd].some((n) => Number.isNaN(n))) return false;
  return pStart >= aStart && pEnd <= aEnd;
}

// ---------------------------------------------------------------------------
// Copy review
// ---------------------------------------------------------------------------

/**
 * Wording we will not publish, in any campaign, on any platform. This is a floor, not a
 * substitute for reading the ad: a claim can be false without matching a phrase here.
 */
export const FORBIDDEN_AD_PHRASES: readonly string[] = [
  'guaranteed accuracy',
  'guarantee accuracy',
  'certified secure',
  'works with every ai',
  'works with any ai',
  'never lose a lead',
  'never miss a lead',
  '100% uptime',
  'real-time verification',
  'instant results',
  'guaranteed income',
  'guaranteed revenue',
  'guaranteed results',
  'trusted by thousands',
  'trusted by hundreds',
  'join thousands of',
];

export interface CopyFinding {
  readonly field: 'headline' | 'body' | 'call_to_action';
  readonly phrase: string;
}

/** Case-insensitive substring scan over every piece of text that will be published. */
export function forbiddenClaimsIn(creative: PacketCreative): readonly CopyFinding[] {
  const fields: readonly (readonly [CopyFinding['field'], string])[] = [
    ['headline', creative.headline],
    ['body', creative.body],
    ['call_to_action', creative.call_to_action],
  ];
  const findings: CopyFinding[] = [];
  for (const [field, text] of fields) {
    const haystack = text.toLowerCase();
    for (const phrase of FORBIDDEN_AD_PHRASES) {
      if (haystack.includes(phrase)) findings.push({ field, phrase });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Packet validation
// ---------------------------------------------------------------------------

/**
 * Connectors the product actually has. An ad may not imply any other.
 * Mirrors `SUPPORTED_PROVIDERS` in the evidence connectors and
 * `docs/product-scope.md` section 4.
 */
export const SUPPORTED_CONNECTOR_NAMES: readonly string[] = ['hubspot', 'resend'];

/** Systems an ad must never name, because we cannot read evidence from them. */
export const UNSUPPORTED_CONNECTOR_NAMES: readonly string[] = [
  'salesforce',
  'pipedrive',
  'zoho',
  'monday',
  'airtable',
  'notion',
  'mailchimp',
  'sendgrid',
  'postmark',
  'mailgun',
  'klaviyo',
  'gmail',
  'outlook',
  'any crm',
  'every crm',
  'any email provider',
];

export type PacketDefectCode =
  | 'budget_exceeds_allocation'
  | 'budget_not_integer_minor'
  | 'budget_not_positive'
  | 'missing_end_date'
  | 'end_not_after_start'
  | 'unparseable_schedule'
  | 'forbidden_claim'
  | 'unsupported_connector_claim'
  | 'destination_not_https'
  | 'destination_missing_utm'
  | 'no_targets';

export interface PacketDefect {
  readonly code: PacketDefectCode;
  readonly detail: string;
}

export interface ValidatePacketOptions {
  /** The founder's advertising allocation in integer minor units, e.g. `BUDGET.ALLOC_ADVERTISING_PENCE`. */
  readonly allocation_minor: number;
}

/**
 * Everything that must be true before a packet may be shown to the owner at all.
 *
 * Returns every defect rather than the first, so one round trip tells the author
 * everything that is wrong. An empty array means the packet is *structurally* sound — it
 * does not mean the campaign is a good idea.
 */
export function validateCampaignPacket(
  packet: CampaignPacket,
  options: ValidatePacketOptions,
): readonly PacketDefect[] {
  const defects: PacketDefect[] = [];

  // --- money ---------------------------------------------------------------
  if (!Number.isSafeInteger(packet.budget_minor)) {
    defects.push({
      code: 'budget_not_integer_minor',
      detail: `budget_minor ${packet.budget_minor} is not an integer number of minor units`,
    });
  } else if (packet.budget_minor <= 0) {
    defects.push({ code: 'budget_not_positive', detail: 'budget_minor must be greater than zero' });
  } else if (packet.budget_minor > options.allocation_minor) {
    defects.push({
      code: 'budget_exceeds_allocation',
      detail: `budget_minor ${packet.budget_minor} exceeds the advertising allocation of ${options.allocation_minor} minor units`,
    });
  }

  // --- schedule ------------------------------------------------------------
  if (packet.duration.ends_at.length === 0) {
    defects.push({
      code: 'missing_end_date',
      detail: 'a campaign with no end date spends until somebody remembers to stop it',
    });
  } else {
    const start = Date.parse(packet.duration.starts_at);
    const end = Date.parse(packet.duration.ends_at);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      defects.push({
        code: 'unparseable_schedule',
        detail: 'starts_at and ends_at must both be ISO-8601 instants',
      });
    } else if (end <= start) {
      defects.push({ code: 'end_not_after_start', detail: 'ends_at must be after starts_at' });
    }
  }

  // --- what the public will read -------------------------------------------
  for (const finding of forbiddenClaimsIn(packet.creative)) {
    defects.push({
      code: 'forbidden_claim',
      detail: `the ${finding.field} contains the forbidden phrase "${finding.phrase}"`,
    });
  }

  const allCopy =
    `${packet.creative.headline} ${packet.creative.body} ${packet.creative.call_to_action}`.toLowerCase();
  for (const name of UNSUPPORTED_CONNECTOR_NAMES) {
    if (allCopy.includes(name)) {
      defects.push({
        code: 'unsupported_connector_claim',
        detail: `the creative names "${name}", which is not a connector this product has (supported: ${SUPPORTED_CONNECTOR_NAMES.join(', ')})`,
      });
    }
  }

  // --- where the click lands -----------------------------------------------
  if (!packet.destination.url.startsWith('https://')) {
    defects.push({ code: 'destination_not_https', detail: 'the destination URL must be https' });
  }
  if (!packet.destination.url.includes('utm_campaign=')) {
    defects.push({
      code: 'destination_missing_utm',
      detail:
        'the destination URL carries no utm_campaign, so nothing arriving from it can be attributed',
    });
  }

  if (packet.audience.targets.length === 0) {
    defects.push({ code: 'no_targets', detail: 'the packet names no audience targets' });
  }

  return defects;
}

/**
 * Can the advertising allocation actually fund this packet right now?
 *
 * Uses `canReserve` from the frozen contract so this agrees, to the penny, with how the
 * rest of the system computes availability. A campaign is never created against a budget
 * that is already committed elsewhere.
 */
export function canFundCampaign(state: BudgetAccountState, packet: CampaignPacket): boolean {
  if (state.currency !== packet.currency) return false;
  return canReserve(state, packet.budget_minor);
}
