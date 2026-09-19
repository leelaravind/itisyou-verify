/**
 * Campaign state machine.
 *
 * Two properties, repeatedly: a provider saying "accepted" is not a provider saying
 * "running", and a create whose outcome we do not know is reconciled before it is retried.
 * The second one is what stops a £15 budget becoming a £30 budget.
 */
import { describe, expect, it } from 'vitest';
import {
  type CampaignLifecycle,
  RECONCILE_ONLY_STATES,
  applyAll,
  initialLifecycle,
  planCreation,
  resolveAfterReconcile,
  transition,
} from '@app/growth/lifecycle';

const OBSERVED = '2026-10-06T09:00:00.000Z';

/** Walk a packet from draft to ready_to_submit the legitimate way. */
function readyToSubmit(): CampaignLifecycle {
  const { lifecycle, rejected } = applyAll(initialLifecycle(), [
    { type: 'packet_drafted' },
    { type: 'sent_for_owner_approval' },
    { type: 'owner_approved' },
  ]);
  expect(rejected).toEqual([]);
  expect(lifecycle.state).toBe('ready_to_submit');
  return lifecycle;
}

function accepted(): CampaignLifecycle {
  return applyAll(readyToSubmit(), [
    { type: 'submission_attempted', idempotency_key: 'k1' },
    { type: 'provider_accepted', external_id: 'ext_9' },
  ]).lifecycle;
}

function timedOut(): CampaignLifecycle {
  return applyAll(readyToSubmit(), [
    { type: 'submission_attempted', idempotency_key: 'k1' },
    { type: 'submission_timed_out', idempotency_key: 'k1' },
  ]).lifecycle;
}

describe('campaign state machine', () => {
  it('ADS-005 API acceptance moves a campaign to submitted, never straight to active', () => {
    const lifecycle = accepted();
    expect(lifecycle.state).toBe('submitted');
    expect(lifecycle.state).not.toBe('active');
    expect(lifecycle.external_id).toBe('ext_9');
  });

  it('ADS-006 a campaign rejected by the provider ends in rejected and is not resubmitted automatically', () => {
    const rejectedByProvider = transition(accepted(), {
      type: 'reconciled',
      provider_status: 'rejected',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    }).next;
    expect(rejectedByProvider.state).toBe('rejected');

    // No resubmission without a fresh approval: the machine refuses the attempt outright,
    // and the creation planner refuses too.
    const resubmit = transition(rejectedByProvider, { type: 'submission_attempted', idempotency_key: 'k2' });
    expect(resubmit.ok).toBe(false);
    expect(resubmit.next.state).toBe('rejected');
    expect(planCreation(rejectedByProvider, 'k2')).toMatchObject({ action: 'adopt_existing' });
  });

  it('ADS-007 a pause request moves to pause_pending and becomes paused only after a confirming sync', () => {
    const active = transition(accepted(), {
      type: 'reconciled',
      provider_status: 'active',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    }).next;

    const asked = transition(active, { type: 'pause_requested' });
    expect(asked.next.state).toBe('pause_pending');
    expect(asked.next.pause_requested).toBe(true);

    // A sync that still shows active leaves it pending, not paused.
    const stillActive = transition(asked.next, {
      type: 'reconciled',
      provider_status: 'active',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    });
    expect(stillActive.next.state).toBe('pause_pending');

    const confirmed = transition(stillActive.next, {
      type: 'reconciled',
      provider_status: 'paused',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    });
    expect(confirmed.next.state).toBe('paused');
    expect(confirmed.next.pause_requested).toBe(false);
  });

  it('ADS-008 a campaign whose provider state cannot be read becomes unknown rather than keeping its last state', () => {
    const active = transition(accepted(), {
      type: 'reconciled',
      provider_status: 'active',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    }).next;
    expect(active.state).toBe('active');

    const unreadable = transition(active, {
      type: 'reconciled',
      provider_status: 'unknown',
      external_id: 'ext_9',
      observed_at: '2026-10-06T10:00:00.000Z',
    });
    expect(unreadable.next.state).toBe('unknown');
    expect(unreadable.next.state).not.toBe('active');
    expect(unreadable.next.outcome_unknown).toBe(true);
    expect(unreadable.next.last_observed_at).toBe('2026-10-06T10:00:00.000Z');
  });

  it('ADS-050 a fresh campaign starts as draft with no external id and no unknown outcome', () => {
    expect(initialLifecycle()).toMatchObject({ state: 'draft', external_id: null, outcome_unknown: false });
  });

  it('ADS-051 the owner cannot approve a packet that was never sent to them', () => {
    const result = transition(initialLifecycle(), { type: 'owner_approved' });
    expect(result.ok).toBe(false);
    expect(result.next.state).toBe('draft');
  });

  it('ADS-052 only a reconciled provider read can produce active, and the set is declared', () => {
    const reconciled = transition(accepted(), {
      type: 'reconciled',
      provider_status: 'active',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    });
    expect(reconciled.next.state).toBe('active');
    for (const state of ['active', 'paused', 'rejected', 'in_review', 'scheduled', 'ended']) {
      expect(RECONCILE_ONLY_STATES).toContain(state);
    }
  });

  it('ADS-053 the same idempotency key is never used for a second submission', () => {
    const once = transition(readyToSubmit(), { type: 'submission_attempted', idempotency_key: 'k1' });
    expect(once.ok).toBe(true);
    const twice = transition(once.next, { type: 'submission_attempted', idempotency_key: 'k1' });
    expect(twice.ok).toBe(false);
    if (twice.ok) throw new Error('expected the replayed idempotency key to be rejected');
    expect(twice.reason).toMatch(/already been attempted/);
  });

  it('ADS-054 a timed-out creation leaves the campaign unknown with its outcome flagged', () => {
    expect(timedOut()).toMatchObject({ state: 'unknown', outcome_unknown: true });
  });

  it('ADS-055 a timed-out creation is reconciled before any retry, never re-created blind', () => {
    expect(planCreation(timedOut(), 'k2')).toMatchObject({
      action: 'reconcile_first',
      reason: 'previous_attempt_outcome_unknown',
    });
  });

  it('ADS-056 a reconcile that finds the campaign adopts it and does not create a second', () => {
    const resolved = resolveAfterReconcile(
      timedOut(),
      { found: true, external_id: 'ext_9', provider_status: 'in_review', observed_at: OBSERVED },
      'k2',
    );
    expect(resolved.plan).toEqual({ action: 'adopt_existing', external_id: 'ext_9' });
    expect(resolved.lifecycle.external_id).toBe('ext_9');
    expect(resolved.lifecycle.state).toBe('in_review');
  });

  it('ADS-057 a reconcile that authoritatively finds nothing permits exactly one create', () => {
    const resolved = resolveAfterReconcile(
      timedOut(),
      { found: false, external_id: null, provider_status: 'not_found', observed_at: OBSERVED },
      'k2',
    );
    expect(resolved.plan).toEqual({ action: 'create', idempotency_key: 'k2' });
    expect(resolved.lifecycle.outcome_unknown).toBe(false);
    const adopted = transition(resolved.lifecycle, {
      type: 'reconciled',
      provider_status: 'scheduled',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    }).next;
    expect(planCreation(adopted, 'k3')).toEqual({ action: 'adopt_existing', external_id: 'ext_9' });
  });

  it('ADS-058 a reconcile that cannot determine anything refuses to create a possible duplicate', () => {
    const resolved = resolveAfterReconcile(
      timedOut(),
      { found: false, external_id: null, provider_status: 'unknown', observed_at: OBSERVED },
      'k2',
    );
    expect(resolved.plan).toMatchObject({ action: 'refuse' });
  });

  it('ADS-059 a not_found reconcile does not erase an external id a human already recorded', () => {
    const missed = transition(accepted(), {
      type: 'reconciled',
      provider_status: 'not_found',
      external_id: null,
      observed_at: OBSERVED,
    });
    expect(missed.next.external_id).toBe('ext_9');
    expect(missed.next.state).toBe('unknown');
  });

  it('ADS-060 a pause cannot be confirmed for a campaign that has no external id', () => {
    const result = transition(readyToSubmit(), { type: 'owner_confirmed_paused', observed_at: OBSERVED });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the pause confirmation to be rejected');
    expect(result.reason).toMatch(/no external id/);
  });

  it('ADS-061 revoking the approval on a live campaign requests a pause rather than claiming it stopped', () => {
    const live = applyAll(accepted(), [
      { type: 'reconciled', provider_status: 'active', external_id: 'ext_9', observed_at: OBSERVED },
      { type: 'approval_revoked' },
    ]).lifecycle;
    expect(live.state).toBe('pause_pending');
    expect(live.pause_requested).toBe(true);
  });

  it('ADS-062 the packet cannot be edited while the campaign is live', () => {
    const live = transition(accepted(), {
      type: 'reconciled',
      provider_status: 'active',
      external_id: 'ext_9',
      observed_at: OBSERVED,
    }).next;
    const edit = transition(live, { type: 'packet_edited' });
    expect(edit.ok).toBe(false);
    expect(edit.next.state).toBe('active');
  });

  it('ADS-063 an owner confirmation is the other route to paused, and records when they looked', () => {
    const confirmed = transition(accepted(), { type: 'owner_confirmed_paused', observed_at: OBSERVED });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.next.state).toBe('paused');
    expect(confirmed.next.last_observed_at).toBe(OBSERVED);
  });
});
