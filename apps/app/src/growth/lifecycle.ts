/**
 * Campaign lifecycle — a pure state machine over `CAMPAIGN_STATE`.
 *
 * Two rules, and the file exists to make both impossible to get wrong by accident:
 *
 *  1. **API acceptance is never `active`.** A provider returning 2xx to a create call
 *     means it stored something. It does not mean an ad is being shown to anybody. The
 *     only event that may produce `active`, `paused`, `ended`, `rejected`, `in_review` or
 *     `scheduled` is `reconciled` — a read of the provider's own status.
 *  2. **Reconcile before retrying a timed-out creation.** A create that timed out may
 *     have succeeded. Retrying it blind is how you end up paying for two campaigns out of
 *     a £15 budget. `planCreation` will not return `create` for a campaign whose previous
 *     attempt's outcome is unknown.
 *
 * No I/O, no clock of its own, no storage. Everything is a function of its arguments.
 */
import type { CampaignState } from '@verify/contracts';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Statuses a provider read can return, normalised. `unknown` is a real answer. */
export type ProviderCampaignStatus =
  'not_found' | 'in_review' | 'rejected' | 'scheduled' | 'active' | 'paused' | 'ended' | 'unknown';

export type CampaignEvent =
  | { readonly type: 'packet_drafted' }
  | { readonly type: 'sent_for_owner_approval' }
  | { readonly type: 'owner_approved' }
  | { readonly type: 'packet_edited' }
  | { readonly type: 'approval_revoked' }
  /** We (or a human) submitted. Local knowledge only. */
  | { readonly type: 'submission_attempted'; readonly idempotency_key: string }
  /** The provider's API returned success. Still not delivery. */
  | { readonly type: 'provider_accepted'; readonly external_id: string }
  /** The create call timed out. Outcome genuinely unknown. */
  | { readonly type: 'submission_timed_out'; readonly idempotency_key: string }
  /** The only event that may report delivery. */
  | {
      readonly type: 'reconciled';
      readonly provider_status: ProviderCampaignStatus;
      readonly external_id: string | null;
      readonly observed_at: string;
    }
  | { readonly type: 'pause_requested' }
  | { readonly type: 'owner_confirmed_paused'; readonly observed_at: string };

export interface CampaignLifecycle {
  readonly state: CampaignState;
  readonly external_id: string | null;
  /** Idempotency keys we have already used. A key is never reused for a second create. */
  readonly attempted_keys: readonly string[];
  /** True when a submission's outcome is unknown and must be reconciled before any retry. */
  readonly outcome_unknown: boolean;
  readonly pause_requested: boolean;
  readonly last_observed_at: string | null;
}

export function initialLifecycle(): CampaignLifecycle {
  return {
    state: 'draft',
    external_id: null,
    attempted_keys: [],
    outcome_unknown: false,
    pause_requested: false,
    last_observed_at: null,
  };
}

export type TransitionResult =
  | { readonly ok: true; readonly next: CampaignLifecycle }
  | { readonly ok: false; readonly reason: string; readonly next: CampaignLifecycle };

// ---------------------------------------------------------------------------
// Which states a reconcile may produce
// ---------------------------------------------------------------------------

const PROVIDER_STATUS_TO_STATE: Readonly<Record<ProviderCampaignStatus, CampaignState>> = {
  not_found: 'draft',
  in_review: 'in_review',
  rejected: 'rejected',
  scheduled: 'scheduled',
  active: 'active',
  paused: 'paused',
  ended: 'ended',
  unknown: 'unknown',
};

/** States that may only ever be reached from a reconciled provider read. */
export const RECONCILE_ONLY_STATES: readonly CampaignState[] = [
  'in_review',
  'rejected',
  'scheduled',
  'active',
  'paused',
  'ended',
];

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export function transition(current: CampaignLifecycle, event: CampaignEvent): TransitionResult {
  const reject = (reason: string): TransitionResult => ({ ok: false, reason, next: current });

  switch (event.type) {
    case 'packet_drafted':
      return { ok: true, next: { ...current, state: 'draft' } };

    case 'sent_for_owner_approval':
      if (current.state !== 'draft' && current.state !== 'awaiting_owner') {
        return reject(`cannot ask the owner from ${current.state}`);
      }
      return { ok: true, next: { ...current, state: 'awaiting_owner' } };

    case 'owner_approved':
      if (current.state !== 'awaiting_owner') {
        return reject(`approval only applies to a packet awaiting the owner, not ${current.state}`);
      }
      return { ok: true, next: { ...current, state: 'ready_to_submit' } };

    case 'packet_edited':
      // Editing anything throws the campaign back to the owner. Approval is hash-bound;
      // see `approval.ts`. This is the state-machine half of the same rule.
      if (
        current.state === 'active' ||
        current.state === 'submitted' ||
        current.state === 'in_review'
      ) {
        return reject(
          `cannot edit the packet while the campaign is ${current.state}; pause and reconcile first`,
        );
      }
      return { ok: true, next: { ...current, state: 'awaiting_owner' } };

    case 'approval_revoked':
      if (
        current.state === 'active' ||
        current.state === 'submitted' ||
        current.state === 'in_review'
      ) {
        // Revocation does not stop delivery by itself. It requests a pause.
        return { ok: true, next: { ...current, pause_requested: true, state: 'pause_pending' } };
      }
      return { ok: true, next: { ...current, state: 'awaiting_owner' } };

    case 'submission_attempted': {
      // Key first: a replayed key is a more specific and more dangerous condition than a
      // wrong state, and the caller needs to be told which one it hit.
      if (current.attempted_keys.includes(event.idempotency_key)) {
        return reject(`idempotency key ${event.idempotency_key} has already been attempted`);
      }
      if (current.state !== 'ready_to_submit') {
        return reject(`cannot submit from ${current.state}`);
      }
      return {
        ok: true,
        next: {
          ...current,
          state: 'submitted',
          attempted_keys: [...current.attempted_keys, event.idempotency_key],
        },
      };
    }

    case 'provider_accepted': {
      if (current.state !== 'submitted' && current.state !== 'ready_to_submit') {
        return reject(`acceptance does not apply from ${current.state}`);
      }
      // The whole point: 2xx does not mean active.
      return {
        ok: true,
        next: {
          ...current,
          state: 'submitted',
          external_id: event.external_id,
          outcome_unknown: false,
        },
      };
    }

    case 'submission_timed_out': {
      return {
        ok: true,
        next: {
          ...current,
          state: 'unknown',
          outcome_unknown: true,
          attempted_keys: current.attempted_keys.includes(event.idempotency_key)
            ? current.attempted_keys
            : [...current.attempted_keys, event.idempotency_key],
        },
      };
    }

    case 'reconciled': {
      const observed = PROVIDER_STATUS_TO_STATE[event.provider_status];
      // A reconcile that found nothing does not erase an external id we already hold —
      // "not found" from one read is weaker evidence than an id a human pasted in.
      const externalId = event.external_id ?? current.external_id;
      if (event.provider_status === 'not_found' && current.external_id !== null) {
        return {
          ok: true,
          next: {
            ...current,
            state: 'unknown',
            outcome_unknown: true,
            last_observed_at: event.observed_at,
          },
        };
      }
      // A pause we asked for and the provider does not yet show is pause_pending.
      const state: CampaignState =
        current.pause_requested &&
        observed !== 'paused' &&
        observed !== 'ended' &&
        observed !== 'rejected'
          ? 'pause_pending'
          : observed;
      return {
        ok: true,
        next: {
          ...current,
          state,
          external_id: externalId,
          outcome_unknown: event.provider_status === 'unknown',
          pause_requested:
            observed === 'paused' || observed === 'ended' ? false : current.pause_requested,
          last_observed_at: event.observed_at,
        },
      };
    }

    case 'pause_requested':
      // Asking is not stopping.
      return {
        ok: true,
        next: {
          ...current,
          pause_requested: true,
          state:
            current.state === 'paused' || current.state === 'ended'
              ? current.state
              : 'pause_pending',
        },
      };

    case 'owner_confirmed_paused':
      if (current.external_id === null) {
        return reject(
          'cannot confirm a pause for a campaign with no external id — there is nothing to have paused',
        );
      }
      return {
        ok: true,
        next: {
          ...current,
          state: 'paused',
          pause_requested: false,
          last_observed_at: event.observed_at,
        },
      };
  }
}

/** Fold a sequence of events, stopping at the first rejection. */
export function applyAll(
  start: CampaignLifecycle,
  events: readonly CampaignEvent[],
): { readonly lifecycle: CampaignLifecycle; readonly rejected: readonly string[] } {
  let lifecycle = start;
  const rejected: string[] = [];
  for (const event of events) {
    const result = transition(lifecycle, event);
    if (result.ok) {
      lifecycle = result.next;
    } else {
      rejected.push(`${event.type}: ${result.reason}`);
    }
  }
  return { lifecycle, rejected };
}

// ---------------------------------------------------------------------------
// Creation planning — the duplicate-campaign guard
// ---------------------------------------------------------------------------

export type CreationPlan =
  | { readonly action: 'create'; readonly idempotency_key: string }
  | {
      readonly action: 'reconcile_first';
      readonly reason: 'previous_attempt_outcome_unknown' | 'external_id_present_but_unverified';
      readonly lookup_by: 'external_id' | 'idempotency_key';
      readonly value: string;
    }
  | { readonly action: 'adopt_existing'; readonly external_id: string }
  | { readonly action: 'refuse'; readonly reason: string };

/**
 * Decide what to do about creating this campaign.
 *
 * The one thing this function will never do is return `create` when a previous attempt's
 * outcome is unknown. A timed-out create is not a failed create.
 */
export function planCreation(lifecycle: CampaignLifecycle, idempotencyKey: string): CreationPlan {
  if (lifecycle.external_id !== null) {
    return { action: 'adopt_existing', external_id: lifecycle.external_id };
  }
  if (lifecycle.outcome_unknown) {
    const key = lifecycle.attempted_keys[lifecycle.attempted_keys.length - 1] ?? idempotencyKey;
    return {
      action: 'reconcile_first',
      reason: 'previous_attempt_outcome_unknown',
      lookup_by: 'idempotency_key',
      value: key,
    };
  }
  if (lifecycle.attempted_keys.includes(idempotencyKey)) {
    return {
      action: 'reconcile_first',
      reason: 'previous_attempt_outcome_unknown',
      lookup_by: 'idempotency_key',
      value: idempotencyKey,
    };
  }
  if (lifecycle.state !== 'ready_to_submit') {
    return { action: 'refuse', reason: `campaign is ${lifecycle.state}, not ready_to_submit` };
  }
  return { action: 'create', idempotency_key: idempotencyKey };
}

/** What a reconcile found when we went looking before retrying. */
export interface ReconcileFinding {
  readonly found: boolean;
  readonly external_id: string | null;
  readonly provider_status: ProviderCampaignStatus;
  readonly observed_at: string;
}

/**
 * Resolve a `reconcile_first` plan with what the lookup actually returned. If a campaign
 * exists, we adopt it. Only a lookup that authoritatively found nothing permits a create.
 */
export function resolveAfterReconcile(
  lifecycle: CampaignLifecycle,
  finding: ReconcileFinding,
  idempotencyKey: string,
): { readonly plan: CreationPlan; readonly lifecycle: CampaignLifecycle } {
  const applied = transition(lifecycle, {
    type: 'reconciled',
    provider_status: finding.provider_status,
    external_id: finding.external_id,
    observed_at: finding.observed_at,
  });
  const next = applied.ok ? applied.next : lifecycle;

  if (finding.found && finding.external_id !== null) {
    return {
      plan: { action: 'adopt_existing', external_id: finding.external_id },
      lifecycle: next,
    };
  }
  if (finding.provider_status === 'unknown') {
    // We still do not know. Creating now is exactly the duplicate we are avoiding.
    return {
      plan: {
        action: 'refuse',
        reason:
          'reconcile could not determine whether a campaign exists; refusing to create a possible duplicate',
      },
      lifecycle: next,
    };
  }
  // Authoritatively nothing there. Safe to create, with a cleared unknown flag.
  const cleared: CampaignLifecycle = { ...next, state: 'ready_to_submit', outcome_unknown: false };
  return { plan: { action: 'create', idempotency_key: idempotencyKey }, lifecycle: cleared };
}
