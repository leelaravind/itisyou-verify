/**
 * The advertising adapter interface — plan §25.
 *
 * This file exists to make three things structural rather than aspirational:
 *
 *  1. **Nothing here spends money.** No method on this interface returns "I have created
 *     and activated a campaign". `publishApproved` on the only adapter we can actually
 *     run (`manual`) returns a list of steps for a human, because we hold no advertising
 *     credentials and no approved developer token.
 *  2. **API acceptance is not delivery.** `PublishResult` carries `accepted_by_provider`,
 *     never `active`. The only values of `StatusResult.source` that may report `active`
 *     are `reconciled_provider_read` and `owner_confirmation`. A local flag is an
 *     intention; it is never evidence.
 *  3. **Money is integer minor units.** Every amount on this interface is
 *     `*_minor: number` and must be a safe integer. No adapter is permitted to return a
 *     float, a string amount, or a "pounds" figure.
 *
 * Adapters are pure over their injected dependencies. The `manual` adapter touches no
 * network at all. The `reddit` adapter is a *planner*: it can describe the request it
 * would send, and refuses every operation because we have no credentials to send it with.
 */
import type { CampaignState, Currency } from '@verify/contracts';

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/**
 * Platforms we researched for the first £15 experiment. Presence here is not an
 * endorsement — see `docs/advertising.md` for which one survives the cap test.
 */
export const AD_PLATFORMS = ['reddit', 'google_ads', 'microsoft_ads', 'meta', 'linkedin'] as const;
export type AdPlatformId = (typeof AD_PLATFORMS)[number];

/**
 * Whether a platform can enforce a **true total ceiling** — a number above which the
 * platform's own documentation says delivery stops — as opposed to an average daily
 * budget that is only bounded over a calendar month.
 *
 * `monthly_only` means: the documented guarantee is `daily x ~30.4 per calendar month`,
 * and a short campaign inside that month has no smaller documented ceiling.
 */
export type CapEnforcement = 'total_budget' | 'monthly_only' | 'unknown';

export interface PlatformCapFacts {
  readonly platform: AdPlatformId;
  readonly cap_enforcement: CapEnforcement;
  /** The platform's own words for what its budget setting guarantees. */
  readonly cap_behaviour: string;
  /** Minimum daily budget the platform will accept, in minor units of `currency`. */
  readonly minimum_daily_minor: number | null;
  /** Minimum lifetime/total budget, in minor units of `currency`. `null` = not offered. */
  readonly minimum_lifetime_minor: number | null;
  /**
   * Minimum *monthly* budget, in minor units of `currency`. Only meaningful on a platform
   * whose enforced ceiling is monthly — on those, this is the real floor, not the daily one.
   */
  readonly minimum_monthly_minor: number | null;
  readonly currency: Currency | 'USD_ONLY' | 'UNKNOWN';
  /** Source URL `cap_behaviour` was read from, and when. */
  readonly source_url: string;
  readonly checked_on: string;
  /** False when `cap_behaviour` came from a secondary source we could not confirm. */
  readonly primary_source: boolean;
  /**
   * Where the *minimum budget* figures came from. Tracked separately from
   * `primary_source` because a platform can document its cap behaviour publicly while
   * keeping its minimums behind a login.
   *
   * `requires_account` is not a failure to research — it is the finding. It means a human
   * must read the number on screen inside a signed-in advertising account, and no amount
   * of further public research will produce it.
   */
  readonly minimums_provenance: 'primary' | 'secondary' | 'requires_account' | 'not_published';
  /** Source URL the minimum figures were read from, when there is one. */
  readonly minimums_source_url: string | null;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** How a draft identifies itself to us and, later, to the provider. */
export interface CampaignRef {
  /** Our id. Always present. */
  readonly local_id: string;
  /**
   * The provider's id. `null` until a human pastes it back or a reconcile finds it.
   * A campaign with no external id can never be reported as `active`.
   */
  readonly external_id: string | null;
  readonly platform: AdPlatformId;
}

export interface CreateDraftRequest {
  readonly ref: CampaignRef;
  /** Canonical approved packet, already hashed by `apps/app/src/growth/approval.ts`. */
  readonly packet_json: string;
  readonly approved_payload_hash: string;
  readonly budget_minor: number;
  readonly currency: Currency;
  readonly starts_at: string;
  readonly ends_at: string;
  /** Stable across retries. A retry with the same key must not create a second campaign. */
  readonly idempotency_key: string;
}

export interface PublishRequest extends CreateDraftRequest {
  /** The approval row id. Absent means: refuse, do not publish. */
  readonly approval_id: string;
  /** Owner-side maximum. An adapter must refuse if `budget_minor` exceeds it. */
  readonly approved_maximum_minor: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type AdsFailureCode =
  | 'NO_CREDENTIALS'
  | 'NO_API_ACCESS'
  | 'NOT_APPROVED'
  | 'BUDGET_EXCEEDS_APPROVAL'
  | 'INVALID_AMOUNT'
  | 'REQUIRES_HUMAN'
  | 'EXTERNAL_ID_UNKNOWN'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT';

export interface AdsFailure {
  readonly ok: false;
  readonly code: AdsFailureCode;
  /** Safe to show the owner. Never contains a credential or a provider payload. */
  readonly message: string;
}

export interface AccessCheck {
  readonly platform: AdPlatformId;
  /** True only when we hold working credentials AND the provider answered. */
  readonly usable: boolean;
  /** What a human must do before this adapter could ever become usable. */
  readonly blockers: readonly string[];
  readonly checked_at: string;
}

/** One instruction a human performs in the platform UI. Ordered, and individually verifiable. */
export interface ManualStep {
  readonly ordinal: number;
  readonly instruction: string;
  /** How the owner proves this step actually happened. */
  readonly verified_by: string;
}

export interface DraftResult {
  readonly ok: true;
  readonly ref: CampaignRef;
  readonly state: Extract<CampaignState, 'draft' | 'awaiting_owner'>;
  readonly manual_steps: readonly ManualStep[];
  readonly created_at: string;
}

export interface PublishResult {
  readonly ok: true;
  readonly ref: CampaignRef;
  /**
   * `false` on the manual adapter, always: we did not submit anything, a person will.
   * `true` would mean a provider API returned 2xx — which is still not `active`.
   */
  readonly accepted_by_provider: boolean;
  /** Never `active`. Acceptance can only reach `submitted`; delivery needs a reconcile. */
  readonly state: Extract<CampaignState, 'ready_to_submit' | 'submitted' | 'awaiting_owner'>;
  readonly manual_steps: readonly ManualStep[];
  readonly idempotency_key: string;
  readonly at: string;
}

/**
 * Where a status claim came from. This is the single most important field in the file:
 * only `reconciled_provider_read` and `owner_confirmation` are permitted to carry
 * `active`. `local_intent` means "we asked for this", which proves nothing.
 */
export type StatusSource =
  'reconciled_provider_read' | 'owner_confirmation' | 'local_intent' | 'none';

export interface StatusResult {
  readonly ok: true;
  readonly ref: CampaignRef;
  readonly state: CampaignState;
  readonly source: StatusSource;
  /** When the underlying observation was made, not when this object was built. */
  readonly observed_at: string | null;
  /** True when `observed_at` is older than the caller's freshness budget. */
  readonly stale: boolean;
  readonly note: string;
}

export interface SpendResult {
  readonly ok: true;
  readonly ref: CampaignRef;
  /** `null` means unknown. Zero is a claim; unknown is not. */
  readonly spend_minor: number | null;
  readonly currency: Currency;
  readonly source: StatusSource;
  readonly observed_at: string | null;
  readonly stale: boolean;
}

export interface PauseResult {
  readonly ok: true;
  readonly ref: CampaignRef;
  /**
   * Never `paused` unless a reconciled read or an owner confirmation says so.
   * A request we sent and cannot confirm is `pause_pending`; a request we cannot even
   * place is `unknown`.
   */
  readonly state: Extract<CampaignState, 'paused' | 'pause_pending' | 'unknown'>;
  readonly source: StatusSource;
  readonly manual_steps: readonly ManualStep[];
  readonly at: string;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface AdCampaignAdapter {
  readonly platform: AdPlatformId;
  /** `manual` = a human operates the platform UI. `api` = we hold working credentials. */
  readonly mode: 'manual' | 'api';
  readonly capFacts: PlatformCapFacts;

  validateAccess(now?: Date): Promise<AccessCheck>;
  createDraft(request: CreateDraftRequest, now?: Date): Promise<DraftResult | AdsFailure>;
  publishApproved(request: PublishRequest, now?: Date): Promise<PublishResult | AdsFailure>;
  getStatus(ref: CampaignRef, now?: Date): Promise<StatusResult | AdsFailure>;
  getSpend(ref: CampaignRef, now?: Date): Promise<SpendResult | AdsFailure>;
  pause(ref: CampaignRef, now?: Date): Promise<PauseResult | AdsFailure>;
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

export function fail(code: AdsFailureCode, message: string): AdsFailure {
  return { ok: false, code, message };
}

export function isAdsFailure(value: unknown): value is AdsFailure {
  return (
    typeof value === 'object' && value !== null && (value as { readonly ok?: unknown }).ok === false
  );
}

/**
 * Every amount crossing this interface is checked here. A non-integer amount is a bug
 * upstream — reject it rather than letting a float reach a spending cap.
 */
export function assertMinor(amount: number, field: string): AdsFailure | null {
  if (!Number.isSafeInteger(amount)) {
    return fail('INVALID_AMOUNT', `${field} must be an integer number of minor units`);
  }
  if (amount < 0) {
    return fail('INVALID_AMOUNT', `${field} must not be negative`);
  }
  return null;
}

/** Freshness: an observation older than this is reported `stale`, never silently reused. */
export const STATUS_FRESHNESS_SECONDS = 900;

export function isStale(
  observedAt: string | null,
  now: Date,
  maxAgeSeconds = STATUS_FRESHNESS_SECONDS,
): boolean {
  if (observedAt === null) return true;
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return true;
  return now.getTime() - observed > maxAgeSeconds * 1000;
}
