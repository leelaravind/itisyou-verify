/**
 * Stop switches.
 *
 * The invariant worth more than all the others here: however much is paused, a customer can
 * still cancel and still ask for help. The test below turns every switch on at once and
 * checks it, because "we would never pause that" is exactly the sentence that precedes
 * pausing it.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTROL_DESCRIPTION,
  CONTROL_KEYS,
  PROTECTED_PATHS,
  adPauseView,
  applyControlChange,
  controlSettingKey,
  defaultControls,
  isControlKey,
  isPathSuspended,
  isProtectedPath,
  type Controls,
} from '@app/owner/controls';

const AT = '2026-09-19T12:00:00.000Z';

function allPaused(): Controls {
  const controls = defaultControls();
  const out = { ...controls };
  for (const key of CONTROL_KEYS) {
    out[key] = { key, paused: true, since: AT, by: 'usr_owner', note: 'emergency' };
  }
  return out;
}

describe('owner controls', () => {
  it('OWNER-040 pausing ads leaves cancellation reachable', () => {
    const controls = defaultControls();
    const paused = { ...controls, ads: { key: 'ads' as const, paused: true, since: AT, by: 'o', note: null } };
    expect(isPathSuspended('/app/cancel', paused)).toBe(false);
  });

  it('OWNER-041 pausing ads leaves support reachable', () => {
    const paused = {
      ...defaultControls(),
      ads: { key: 'ads' as const, paused: true, since: AT, by: 'o', note: null },
    };
    expect(isPathSuspended('/support', paused)).toBe(false);
    expect(isPathSuspended('/app/support', paused)).toBe(false);
  });

  it('OWNER-042 with every control paused, cancellation and support are still reachable', () => {
    const controls = allPaused();
    for (const entry of PROTECTED_PATHS) {
      expect(isPathSuspended(entry.path, controls)).toBe(false);
    }
  });

  it('OWNER-043 a nested path under a protected path is also protected', () => {
    expect(isProtectedPath('/app/cancel/confirm')).toBe(true);
    expect(isPathSuspended('/app/cancel/confirm', allPaused())).toBe(false);
  });

  it('OWNER-044 every protected path carries a stated reason, so nobody removes one by accident', () => {
    for (const entry of PROTECTED_PATHS) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
    expect(PROTECTED_PATHS.map((p) => p.path)).toContain('/app/cancel');
    expect(PROTECTED_PATHS.map((p) => p.path)).toContain('/support');
  });

  it('OWNER-045 pausing new orders does suspend checkout', () => {
    const paused = {
      ...defaultControls(),
      new_orders: { key: 'new_orders' as const, paused: true, since: AT, by: 'o', note: null },
    };
    expect(isPathSuspended('/app/checkout', paused)).toBe(true);
    expect(isPathSuspended('/app/cancel', paused)).toBe(false);
  });

  it('OWNER-046 nothing is suspended when nothing is paused', () => {
    const controls = defaultControls();
    expect(isPathSuspended('/app/checkout', controls)).toBe(false);
    expect(isPathSuspended('/app/assistant', controls)).toBe(false);
  });

  it('OWNER-047 every control says what it stops AND what it does not stop', () => {
    for (const key of CONTROL_KEYS) {
      const description = CONTROL_DESCRIPTION[key];
      expect(description.stops.length).toBeGreaterThan(20);
      expect(description.doesNotStop.length).toBeGreaterThan(20);
    }
  });

  it('OWNER-048 toggling a control records who paused it and when', () => {
    const result = applyControlChange(defaultControls(), {
      key: 'ads',
      paused: true,
      by: 'usr_owner',
      at: AT,
      note: 'spend looked wrong',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changed).toBe(true);
    expect(result.state.since).toBe(AT);
    expect(result.state.by).toBe('usr_owner');
    expect(result.state.note).toBe('spend looked wrong');
  });

  it('OWNER-049 setting a control to the value it already has is not a change', () => {
    const result = applyControlChange(defaultControls(), {
      key: 'ads',
      paused: false,
      by: 'usr_owner',
      at: AT,
      note: null,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.changed).toBe(false);
  });

  it('OWNER-050 control keys are a closed set with stable settings keys', () => {
    expect(isControlKey('ads')).toBe(true);
    expect(isControlKey('everything')).toBe(false);
    expect(controlSettingKey('chatbot')).toBe('controls.chatbot');
  });

  it('OWNER-051 a pause we requested shows as pause_pending, never as paused', () => {
    const view = adPauseView({
      pauseRequested: true,
      providerState: 'active',
      providerObservedAt: AT,
      ownerConfirmedPaused: false,
    });
    expect(view.state).toBe('pause_pending');
    expect(view.confirmedByPlatform).toBe(false);
    expect(view.explanation).toMatch(/may still be showing/i);
  });

  it('OWNER-052 only a provider read, or the owner reading the provider, produces paused', () => {
    const fromProvider = adPauseView({
      pauseRequested: true,
      providerState: 'paused',
      providerObservedAt: AT,
      ownerConfirmedPaused: false,
    });
    expect(fromProvider.state).toBe('paused');
    expect(fromProvider.confirmedByPlatform).toBe(true);

    const fromOwner = adPauseView({
      pauseRequested: true,
      providerState: null,
      providerObservedAt: null,
      ownerConfirmedPaused: true,
    });
    expect(fromOwner.state).toBe('paused');
    expect(fromOwner.confirmedByPlatform).toBe(false);
  });

  it('OWNER-053 with no provider read at all the state is unknown, not active', () => {
    const view = adPauseView({
      pauseRequested: false,
      providerState: null,
      providerObservedAt: null,
      ownerConfirmedPaused: false,
    });
    expect(view.state).toBe('unknown');
    expect(view.confirmedByPlatform).toBe(false);
  });
});
