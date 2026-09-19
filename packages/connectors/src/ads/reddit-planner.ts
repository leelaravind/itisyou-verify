/**
 * Reddit Ads — a *planner*, not an integration.
 *
 * We have no Reddit Ads account, no OAuth client and no approved API access. So this file
 * deliberately contains no transport: there is no `fetch`, no base URL constant that is
 * ever dereferenced, and every adapter method refuses with `NO_CREDENTIALS`.
 *
 * What it does provide is the *shape* of the calls a future integration would make, so
 * that when the owner does hold credentials, the work is "wire a transport into these
 * descriptors" rather than "design the integration from scratch". A request descriptor is
 * data. Turning one into a real HTTP call is a separate, explicitly budgeted change that
 * must go through `packages/connectors/src/http.ts`'s allowlist.
 *
 * Nothing in here may be presented to the owner as a working integration.
 */
import {
  type AccessCheck,
  type AdCampaignAdapter,
  type AdsFailure,
  type CampaignRef,
  type CreateDraftRequest,
  type PublishRequest,
  fail,
} from './types';
import { REDDIT_FACTS } from './facts';

/** A call we would make, described as data. Never executed by this package. */
export interface PlannedRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** Path only. No host: this package holds no advertising host in its allowlist. */
  readonly path: string;
  readonly purpose: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  /** The scope the OAuth client would need. Written down so the owner can see the ask. */
  readonly required_scope: string;
}

export interface RedditPlan {
  readonly platform: 'reddit';
  readonly requests: readonly PlannedRequest[];
  /** Everything that must exist before any of the above could be sent. */
  readonly prerequisites: readonly string[];
}

/**
 * The create-and-submit sequence, as it would be. Budget is carried as integer minor
 * units right up to the boundary; converting to the platform's own unit is the transport's
 * job and must be an integer operation there too.
 */
export function planCampaignCreation(request: CreateDraftRequest): RedditPlan {
  return {
    platform: 'reddit',
    requests: [
      {
        method: 'GET',
        path: '/api/v3/me',
        purpose: 'prove the token authenticates and resolve the ad account we are allowed to touch',
        body: null,
        required_scope: 'adsread',
      },
      {
        method: 'POST',
        path: '/api/v3/ad_accounts/{ad_account_id}/campaigns',
        purpose: 'create the campaign in a paused state',
        body: {
          name: `verify-${request.ref.local_id}`,
          objective: 'TRAFFIC',
          configured_status: 'PAUSED',
        },
        required_scope: 'adsedit',
      },
      {
        method: 'POST',
        path: '/api/v3/ad_accounts/{ad_account_id}/ad_groups',
        purpose:
          'attach the total (lifetime) budget and the schedule — the only real ceiling we have',
        body: {
          campaign_id: '{campaign_id}',
          goal_type: 'LIFETIME_SPEND',
          goal_value_minor: request.budget_minor,
          currency: request.currency,
          start_time: request.starts_at,
          end_time: request.ends_at,
          configured_status: 'PAUSED',
        },
        required_scope: 'adsedit',
      },
      {
        method: 'GET',
        path: '/api/v3/ad_accounts/{ad_account_id}/campaigns/{campaign_id}',
        purpose:
          'reconcile: read back what the platform actually stored. Only this read may report `active` — the POST above returning 200 may not.',
        body: null,
        required_scope: 'adsread',
      },
    ],
    prerequisites: [
      'A Reddit Ads account that has completed whatever identity and payment checks Reddit requires.',
      'An OAuth client registered against that account, with adsread and adsedit granted by the owner.',
      'A confirmed answer to whether Reddit will bill this account in GBP or USD — the packet cap is in pence.',
      'A confirmed on-screen reading of the minimum total budget Reddit will accept. Our stored figure is secondary and unverified.',
    ],
  };
}

/**
 * The adapter. Every method refuses. That is the honest state of this integration and the
 * refusals are typed so the caller cannot mistake one for a success.
 */
export function createRedditPlannerAdapter(): AdCampaignAdapter {
  const refusal = (): AdsFailure =>
    fail(
      'NO_CREDENTIALS',
      'Reddit Ads is not integrated: no account, no OAuth client, no approved API access. Use the manual adapter.',
    );

  return {
    platform: 'reddit',
    mode: 'api',
    capFacts: REDDIT_FACTS,

    async validateAccess(now = new Date()): Promise<AccessCheck> {
      return {
        platform: 'reddit',
        usable: false,
        blockers: planCampaignCreation({
          ref: { local_id: 'probe', external_id: null, platform: 'reddit' },
          packet_json: '{}',
          approved_payload_hash: '',
          budget_minor: 0,
          currency: 'GBP',
          starts_at: now.toISOString(),
          ends_at: now.toISOString(),
          idempotency_key: 'probe',
        }).prerequisites,
        checked_at: now.toISOString(),
      };
    },

    async createDraft(): Promise<AdsFailure> {
      return refusal();
    },
    async publishApproved(_request: PublishRequest): Promise<AdsFailure> {
      return refusal();
    },
    async getStatus(_ref: CampaignRef): Promise<AdsFailure> {
      return refusal();
    },
    async getSpend(_ref: CampaignRef): Promise<AdsFailure> {
      return refusal();
    },
    async pause(_ref: CampaignRef): Promise<AdsFailure> {
      return refusal();
    },
  };
}
