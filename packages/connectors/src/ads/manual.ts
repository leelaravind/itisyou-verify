/**
 * The manual advertising adapter — the only one we can honestly ship today.
 *
 * We hold no advertising account, no billing method and no approved API credentials.
 * So this adapter does not integrate with anything. It:
 *
 *  - writes down, in order, exactly what a human must do in the platform's own UI;
 *  - records the external campaign id the owner pastes back;
 *  - records *observations* — a reconciled provider read, or an explicit owner
 *    confirmation — and reports status **only** from those.
 *
 * The rule the whole file is built around: **we never report `active` on our own say-so.**
 * If nobody has looked at the platform since we asked for something, the answer is
 * `unknown`. If we asked for a pause and nobody has confirmed it took effect, the answer
 * is `pause_pending`. Neither is a failure; both are the truth.
 *
 * There is no `fetch` in this file, and there must never be one.
 */
import type { CampaignState, Currency } from '@verify/contracts';
import {
  type AccessCheck,
  type AdCampaignAdapter,
  type AdPlatformId,
  type AdsFailure,
  type CampaignRef,
  type CreateDraftRequest,
  type DraftResult,
  type ManualStep,
  type PauseResult,
  type PlatformCapFacts,
  type PublishRequest,
  type PublishResult,
  type SpendResult,
  type StatusResult,
  type StatusSource,
  assertMinor,
  fail,
  isStale,
} from './types';

// ---------------------------------------------------------------------------
// The record a manual campaign keeps
// ---------------------------------------------------------------------------

/** How an observation reached us. `local_intent` is explicitly *not* an observation source. */
export type ObservationSource = 'reconciled_provider_read' | 'owner_confirmation';

export interface ManualObservation {
  readonly source: ObservationSource;
  /** What the provider (or the owner, reading the provider) actually said. */
  readonly state: CampaignState;
  readonly spend_minor: number | null;
  readonly currency: Currency;
  /** When the human or the read actually looked. Not when the row was written. */
  readonly observed_at: string;
  readonly note: string;
}

export interface ManualCampaignRecord {
  readonly local_id: string;
  readonly platform: AdPlatformId;
  readonly external_id: string | null;
  readonly approved_payload_hash: string | null;
  readonly approval_id: string | null;
  readonly budget_minor: number;
  readonly currency: Currency;
  readonly idempotency_key: string | null;
  /** Every submission we have *intended*. Used to prove we never submit twice. */
  readonly submission_attempts: readonly string[];
  /** True once the owner has been asked to pause. Still not proof delivery stopped. */
  readonly pause_requested: boolean;
  /** Newest last. Status is always read from the last entry. */
  readonly observations: readonly ManualObservation[];
}

/** Persistence is injected so this package stays free of D1 and of the Worker runtime. */
export interface ManualAdsStore {
  get(localId: string): Promise<ManualCampaignRecord | null>;
  put(record: ManualCampaignRecord): Promise<void>;
}

/** A store that lives for one process. Real callers pass a D1-backed one. */
export function inMemoryManualStore(seed: readonly ManualCampaignRecord[] = []): ManualAdsStore {
  const rows = new Map<string, ManualCampaignRecord>(seed.map((r) => [r.local_id, r]));
  return {
    async get(localId) {
      return rows.get(localId) ?? null;
    },
    async put(record) {
      rows.set(record.local_id, record);
    },
  };
}

export function emptyManualRecord(
  localId: string,
  platform: AdPlatformId,
  budgetMinor: number,
  currency: Currency,
): ManualCampaignRecord {
  return {
    local_id: localId,
    platform,
    external_id: null,
    approved_payload_hash: null,
    approval_id: null,
    budget_minor: budgetMinor,
    currency,
    idempotency_key: null,
    submission_attempts: [],
    pause_requested: false,
    observations: [],
  };
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function draftSteps(platform: AdPlatformId, request: CreateDraftRequest): readonly ManualStep[] {
  const steps: readonly string[][] = [
    [
      `Open the ${platform} ads manager signed in as the owner account, with MFA already enrolled.`,
      'Screenshot of the account page showing the account id and the owner as the only user.',
    ],
    [
      'Create the campaign as a DRAFT. Do not set it live at any point in this step.',
      'The platform shows the campaign in a draft/paused state with no delivery.',
    ],
    [
      `Set the total/lifetime budget to exactly ${request.budget_minor} minor units of ${request.currency}. If the platform offers only an average daily budget, stop and return to the owner: the packet assumed a total ceiling.`,
      'Screenshot of the budget field showing the exact figure and the budget type.',
    ],
    [
      `Set the schedule to start ${request.starts_at} and end ${request.ends_at}, in the campaign timezone stated in the packet.`,
      'Screenshot of the schedule fields including the timezone selector.',
    ],
    [
      'Paste the approved headline and body verbatim from docs/campaign-packet.md. Do not let the platform auto-generate, auto-translate or "optimise" the text into new claims.',
      'Character counts match the packet, and no asset-enhancement / auto-asset toggle is enabled.',
    ],
    [
      'Paste the destination URL including its UTM parameters exactly as written in the packet.',
      'Click the preview link and confirm it loads the landing page over HTTPS with the UTMs intact.',
    ],
    [
      `Copy the platform's campaign id back into the packet record for local id ${request.ref.local_id}.`,
      'The id is recorded here; without it we can never reconcile, pause or prove spend.',
    ],
  ];
  return steps.map(([instruction, verified], i) => ({
    ordinal: i + 1,
    instruction: instruction ?? '',
    verified_by: verified ?? '',
  }));
}

function publishSteps(request: PublishRequest): readonly ManualStep[] {
  const steps: readonly string[][] = [
    [
      'Re-read the approval record and confirm the hash on screen matches the one in the packet before touching anything.',
      `Approval ${request.approval_id} is still 'granted', not expired or revoked.`,
    ],
    [
      `Confirm the total budget field still reads exactly ${request.budget_minor} minor units of ${request.currency} and nothing has been rounded or converted.`,
      'Screenshot immediately before submission.',
    ],
    [
      'Submit the campaign for review. This is the only step that can cause money to be spent.',
      'The platform shows the campaign as submitted / in review.',
    ],
    [
      'Record the submission time and the external campaign id here.',
      'A reconcile run returns the same external id and does not find a second campaign.',
    ],
  ];
  return steps.map(([instruction, verified], i) => ({
    ordinal: i + 1,
    instruction: instruction ?? '',
    verified_by: verified ?? '',
  }));
}

function pauseSteps(ref: CampaignRef): readonly ManualStep[] {
  const steps: readonly string[][] = [
    [
      `Open campaign ${ref.external_id ?? '(external id not recorded, find it by name)'} in the ${ref.platform} ads manager and set it to paused.`,
      'The campaign row shows Paused.',
    ],
    [
      'Reload the page after at least one minute and confirm the state is still Paused.',
      'A second, independent read shows Paused: one read is a screenshot, two are evidence.',
    ],
    [
      'Check the delivery/spend column stops increasing over the next reporting interval.',
      'Spend at T+1 interval equals spend at T. Until then the state here stays pause_pending.',
    ],
    [
      'Record the pause confirmation here with the time you actually observed it.',
      'Only this recorded observation moves the state from pause_pending to paused.',
    ],
  ];
  return steps.map(([instruction, verified], i) => ({
    ordinal: i + 1,
    instruction: instruction ?? '',
    verified_by: verified ?? '',
  }));
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ManualAdapterOptions {
  readonly platform: AdPlatformId;
  readonly capFacts: PlatformCapFacts;
  readonly store: ManualAdsStore;
  /** Blockers a human must clear before this platform could be used at all. */
  readonly blockers: readonly string[];
}

/**
 * The state the last observation supports, and where it came from.
 * With no observations at all the answer is `unknown` from source `none` — never `draft`,
 * because "we have not looked" and "it is a draft" are different claims.
 */
function latestObservation(record: ManualCampaignRecord): ManualObservation | null {
  return record.observations.length === 0
    ? null
    : (record.observations[record.observations.length - 1] ?? null);
}

export function createManualAdsAdapter(options: ManualAdapterOptions): AdCampaignAdapter {
  const { platform, capFacts, store, blockers } = options;

  const iso = (now: Date) => now.toISOString();

  return {
    platform,
    mode: 'manual',
    capFacts,

    async validateAccess(now = new Date()): Promise<AccessCheck> {
      // There is nothing to validate: we hold no credentials, so we cannot be "usable".
      // Saying so plainly is the point of this adapter.
      return {
        platform,
        usable: false,
        blockers,
        checked_at: iso(now),
      };
    },

    async createDraft(
      request: CreateDraftRequest,
      now = new Date(),
    ): Promise<DraftResult | AdsFailure> {
      const bad = assertMinor(request.budget_minor, 'budget_minor');
      if (bad !== null) return bad;
      if (request.ref.platform !== platform) {
        return fail(
          'REQUIRES_HUMAN',
          `ref.platform ${request.ref.platform} does not match adapter ${platform}`,
        );
      }

      const existing = await store.get(request.ref.local_id);
      const record: ManualCampaignRecord = {
        ...(existing ??
          emptyManualRecord(
            request.ref.local_id,
            platform,
            request.budget_minor,
            request.currency,
          )),
        approved_payload_hash: request.approved_payload_hash,
        budget_minor: request.budget_minor,
        currency: request.currency,
        idempotency_key: request.idempotency_key,
      };
      await store.put(record);

      return {
        ok: true,
        ref: { ...request.ref, external_id: record.external_id },
        // A draft we wrote down is awaiting the owner, not "ready": the owner has not
        // seen the packet yet at this point in the flow.
        state: 'awaiting_owner',
        manual_steps: draftSteps(platform, request),
        created_at: iso(now),
      };
    },

    async publishApproved(
      request: PublishRequest,
      now = new Date(),
    ): Promise<PublishResult | AdsFailure> {
      const bad = assertMinor(request.budget_minor, 'budget_minor');
      if (bad !== null) return bad;
      const badMax = assertMinor(request.approved_maximum_minor, 'approved_maximum_minor');
      if (badMax !== null) return badMax;
      if (request.approval_id.length === 0) {
        return fail(
          'NOT_APPROVED',
          'no approval id supplied; refusing to produce publish instructions',
        );
      }
      // Integer comparison only. No division, no percentage, no float.
      if (request.budget_minor > request.approved_maximum_minor) {
        return fail(
          'BUDGET_EXCEEDS_APPROVAL',
          `budget ${request.budget_minor} exceeds the approved maximum ${request.approved_maximum_minor}`,
        );
      }

      const existing = await store.get(request.ref.local_id);
      const attempts = existing?.submission_attempts ?? [];
      // Idempotency: the same key never produces a second submission instruction set.
      const alreadyAsked = attempts.includes(request.idempotency_key);

      const record: ManualCampaignRecord = {
        ...(existing ??
          emptyManualRecord(
            request.ref.local_id,
            platform,
            request.budget_minor,
            request.currency,
          )),
        approval_id: request.approval_id,
        approved_payload_hash: request.approved_payload_hash,
        budget_minor: request.budget_minor,
        currency: request.currency,
        idempotency_key: request.idempotency_key,
        submission_attempts: alreadyAsked ? attempts : [...attempts, request.idempotency_key],
      };
      await store.put(record);

      return {
        ok: true,
        ref: { ...request.ref, external_id: record.external_id },
        // We submitted nothing. A person will, or will not.
        accepted_by_provider: false,
        state: alreadyAsked && record.external_id !== null ? 'submitted' : 'ready_to_submit',
        manual_steps: alreadyAsked && record.external_id !== null ? [] : publishSteps(request),
        idempotency_key: request.idempotency_key,
        at: iso(now),
      };
    },

    async getStatus(ref: CampaignRef, now = new Date()): Promise<StatusResult | AdsFailure> {
      const record = await store.get(ref.local_id);
      if (record === null) {
        return fail('EXTERNAL_ID_UNKNOWN', `no local record for ${ref.local_id}`);
      }
      const observation = latestObservation(record);
      if (observation === null) {
        return {
          ok: true,
          ref: { ...ref, external_id: record.external_id },
          // Nobody has looked. That is `unknown`, and it is not a bug.
          state: 'unknown',
          source: 'none',
          observed_at: null,
          stale: true,
          note: record.pause_requested
            ? 'a pause was requested and has never been confirmed against the platform'
            : 'no reconciled read and no owner confirmation exists for this campaign',
        };
      }
      // A pause we asked for but the observation does not yet show is pause_pending —
      // we downgrade the observation rather than reporting what we hoped for.
      const pausePending =
        record.pause_requested && observation.state !== 'paused' && observation.state !== 'ended';
      const state: CampaignState = pausePending ? 'pause_pending' : observation.state;
      const source: StatusSource = observation.source;
      return {
        ok: true,
        ref: { ...ref, external_id: record.external_id },
        state,
        source,
        observed_at: observation.observed_at,
        stale: isStale(observation.observed_at, now),
        note: pausePending
          ? `pause requested; last observation at ${observation.observed_at} still showed ${observation.state}`
          : observation.note,
      };
    },

    async getSpend(ref: CampaignRef, now = new Date()): Promise<SpendResult | AdsFailure> {
      const record = await store.get(ref.local_id);
      if (record === null) {
        return fail('EXTERNAL_ID_UNKNOWN', `no local record for ${ref.local_id}`);
      }
      const withSpend =
        [...record.observations].reverse().find((o) => o.spend_minor !== null) ?? null;
      if (withSpend === null) {
        // Unknown is not zero. Reporting £0.00 here would be a fabricated success.
        return {
          ok: true,
          ref: { ...ref, external_id: record.external_id },
          spend_minor: null,
          currency: record.currency,
          source: 'none',
          observed_at: null,
          stale: true,
        };
      }
      return {
        ok: true,
        ref: { ...ref, external_id: record.external_id },
        spend_minor: withSpend.spend_minor,
        currency: withSpend.currency,
        source: withSpend.source,
        observed_at: withSpend.observed_at,
        stale: isStale(withSpend.observed_at, now),
      };
    },

    async pause(ref: CampaignRef, now = new Date()): Promise<PauseResult | AdsFailure> {
      const record = await store.get(ref.local_id);
      if (record === null) {
        return fail('EXTERNAL_ID_UNKNOWN', `no local record for ${ref.local_id}`);
      }
      await store.put({ ...record, pause_requested: true });

      const observation = latestObservation(record);
      // Only an observation can say `paused`. Our own request cannot.
      if (
        observation !== null &&
        (observation.state === 'paused' || observation.state === 'ended')
      ) {
        return {
          ok: true,
          ref: { ...ref, external_id: record.external_id },
          state: observation.state === 'ended' ? 'paused' : 'paused',
          source: observation.source,
          manual_steps: [],
          at: now.toISOString(),
        };
      }
      return {
        ok: true,
        ref: { ...ref, external_id: record.external_id },
        // We have asked a human to pause it. Nothing has confirmed delivery stopped.
        state: record.external_id === null ? 'unknown' : 'pause_pending',
        source: 'local_intent',
        manual_steps: pauseSteps({ ...ref, external_id: record.external_id }),
        at: now.toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Recording what a human found
// ---------------------------------------------------------------------------

/** The owner pastes the platform's campaign id back. Idempotent; a conflicting id is refused. */
export async function recordExternalId(
  store: ManualAdsStore,
  localId: string,
  externalId: string,
): Promise<ManualCampaignRecord | AdsFailure> {
  const record = await store.get(localId);
  if (record === null) return fail('EXTERNAL_ID_UNKNOWN', `no local record for ${localId}`);
  if (record.external_id !== null && record.external_id !== externalId) {
    return fail(
      'REQUIRES_HUMAN',
      `local record ${localId} already points at ${record.external_id}; two external ids means two campaigns: stop and check the platform`,
    );
  }
  const updated: ManualCampaignRecord = { ...record, external_id: externalId };
  await store.put(updated);
  return updated;
}

/** Record a reconciled read or an owner confirmation. This is the only way state moves. */
export async function recordObservation(
  store: ManualAdsStore,
  localId: string,
  observation: ManualObservation,
): Promise<ManualCampaignRecord | AdsFailure> {
  const record = await store.get(localId);
  if (record === null) return fail('EXTERNAL_ID_UNKNOWN', `no local record for ${localId}`);
  if (observation.spend_minor !== null) {
    const bad = assertMinor(observation.spend_minor, 'observation.spend_minor');
    if (bad !== null) return bad;
  }
  if (observation.state === 'active' && record.external_id === null) {
    return fail(
      'EXTERNAL_ID_UNKNOWN',
      'refusing to record an active observation for a campaign with no external id: there is nothing to have observed',
    );
  }
  const clearsPause = observation.state === 'paused' || observation.state === 'ended';
  const updated: ManualCampaignRecord = {
    ...record,
    pause_requested: clearsPause ? false : record.pause_requested,
    observations: [...record.observations, observation],
  };
  await store.put(updated);
  return updated;
}
