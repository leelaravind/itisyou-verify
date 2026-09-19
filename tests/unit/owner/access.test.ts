/**
 * Who gets into the owner panel, and what they may do once they are in.
 *
 * The property under test throughout: a refusal never teaches the person refused anything
 * they did not already know. An anonymous probe and a signed-in customer both get the same
 * `not_found`, whatever address they asked for; only a principal that already belongs in
 * the panel is ever told what it cannot do.
 */
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_PRINCIPAL,
  AUTOMATION_CAPABILITIES,
  AUTOMATION_DENIED,
  AUTOMATION_MAX_LIFETIME_SECONDS,
  ACCESS_MODE_NOTE,
  MFA_WINDOW_SECONDS,
  OWNER_CAPABILITIES,
  authorise,
  automationLifetimeExceeded,
  capabilitiesFor,
  describeAccessMode,
  hasRecentMfa,
  isConsequential,
  isSessionLive,
  mfaSecondsRemaining,
  type OwnerPrincipal,
} from '@app/owner/access';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function owner(overrides: Partial<OwnerPrincipal> = {}): OwnerPrincipal {
  return {
    kind: 'owner',
    userId: 'usr_owner',
    email: 'owner@example.invalid',
    isPlatformOwner: true,
    isAutomation: false,
    mfaVerifiedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    sessionCreatedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    sessionExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    csrfToken: 'csrf-token-for-tests-0123456789',
    ...overrides,
  };
}

function customer(overrides: Partial<OwnerPrincipal> = {}): OwnerPrincipal {
  return owner({
    kind: 'customer',
    userId: 'usr_customer',
    email: 'customer@example.invalid',
    isPlatformOwner: false,
    ...overrides,
  });
}

function automation(overrides: Partial<OwnerPrincipal> = {}): OwnerPrincipal {
  return owner({
    kind: 'automation',
    userId: 'usr_automation',
    email: 'automation@example.invalid',
    isPlatformOwner: false,
    isAutomation: true,
    mfaVerifiedAt: NOW.toISOString(),
    sessionCreatedAt: NOW.toISOString(),
    sessionExpiresAt: new Date(NOW.getTime() + 1_800_000).toISOString(),
    ...overrides,
  });
}

describe('owner panel access', () => {
  it('OWNER-001 an anonymous principal is refused with not_found, never with a 403', () => {
    const decision = authorise(ANONYMOUS_PRINCIPAL, 'owner.view', NOW);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal).toBe('not_found');
    expect(decision.status).toBe(404);
  });

  // "A customer is refused, and the refusal tells them nothing" is one property. OWNER-003
  // was the second half of it and now carries the unconfigured-mount composition case in
  // tests/integration/owner/routes.test.ts.
  it('OWNER-002 a signed-in customer is refused with an identical not_found that confirms nothing', () => {
    const decision = authorise(customer(), 'owner.view', NOW);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.status).toBe(404);

    const forRefund = authorise(customer(), 'refund.issue', NOW);
    if (forRefund.ok) throw new Error('unreachable');
    expect(forRefund.refusal).toBe('not_found');
    // A customer asking for a refund route must not be told the capability exists.
    expect(forRefund.detail).not.toContain('refund.issue');
  });

  it('OWNER-004 an expired session is refused with not_found even for a genuine owner', () => {
    const expired = owner({ sessionExpiresAt: new Date(NOW.getTime() - 1_000).toISOString() });
    const decision = authorise(expired, 'owner.view', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.status).toBe(404);
    expect(isSessionLive(expired, NOW)).toBe(false);
  });

  it('OWNER-005 the owner can view with no recent MFA, because viewing changes nothing', () => {
    const stale = owner({ mfaVerifiedAt: new Date(NOW.getTime() - 86_400_000).toISOString() });
    expect(authorise(stale, 'owner.view', NOW).ok).toBe(true);
  });

  it('OWNER-006 a consequential action without recent MFA is refused', () => {
    const stale = owner({ mfaVerifiedAt: new Date(NOW.getTime() - (MFA_WINDOW_SECONDS + 60) * 1000).toISOString() });
    const decision = authorise(stale, 'refund.issue', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal).toBe('mfa_required');
    expect(decision.status).toBe(403);
  });

  it('OWNER-007 the same action with MFA inside the window is permitted', () => {
    const fresh = owner({ mfaVerifiedAt: new Date(NOW.getTime() - (MFA_WINDOW_SECONDS - 60) * 1000).toISOString() });
    expect(authorise(fresh, 'refund.issue', NOW).ok).toBe(true);
  });

  it('OWNER-008 a session that has never verified MFA is not "probably fine"', () => {
    const never = owner({ mfaVerifiedAt: null });
    expect(hasRecentMfa(never, NOW)).toBe(false);
    expect(authorise(never, 'budget.move', NOW).ok).toBe(false);
  });

  it('OWNER-009 an MFA timestamp in the future is not accepted as proof', () => {
    const future = owner({ mfaVerifiedAt: new Date(NOW.getTime() + 60_000).toISOString() });
    expect(hasRecentMfa(future, NOW)).toBe(false);
  });

  it('OWNER-010 the remaining strong-auth window counts down and floors at zero', () => {
    const fresh = owner({ mfaVerifiedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(mfaSecondsRemaining(fresh, NOW)).toBe(MFA_WINDOW_SECONDS - 60);
    const lapsed = owner({ mfaVerifiedAt: new Date(NOW.getTime() - 7_200_000).toISOString() });
    expect(mfaSecondsRemaining(lapsed, NOW)).toBe(0);
  });

  it('OWNER-011 viewing is the only capability that is not consequential', () => {
    const consequential = OWNER_CAPABILITIES.filter(isConsequential);
    expect(consequential).not.toContain('owner.view');
    expect(consequential.length).toBe(OWNER_CAPABILITIES.length - 1);
  });

  it('OWNER-012 the automation identity cannot activate an advert', () => {
    const decision = authorise(automation(), 'ads.activate', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal).toBe('capability_denied');
    expect(AUTOMATION_CAPABILITIES.has('ads.activate')).toBe(false);
  });

  it('OWNER-013 the automation identity cannot issue a refund', () => {
    const decision = authorise(automation(), 'refund.issue', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal).toBe('capability_denied');
    expect(AUTOMATION_CAPABILITIES.has('refund.issue')).toBe(false);
  });

  it('OWNER-014 the automation identity cannot move budget', () => {
    const decision = authorise(automation(), 'budget.move', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal).toBe('capability_denied');
    expect(AUTOMATION_CAPABILITIES.has('budget.move')).toBe(false);
  });

  it('OWNER-015 the automation identity cannot become the platform owner', () => {
    const decision = authorise(automation(), 'owner.grant', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal).toBe('capability_denied');
    expect(AUTOMATION_CAPABILITIES.has('owner.grant')).toBe(false);
    // The four denials are a published list, so a page can state them and a test can pin them.
    expect([...AUTOMATION_DENIED].sort()).toEqual(['ads.activate', 'budget.move', 'owner.grant', 'refund.issue']);
  });

  it('OWNER-016 the automation identity can still drive the panel it exists to test', () => {
    expect(authorise(automation(), 'owner.view', NOW).ok).toBe(true);
    expect(authorise(automation(), 'quality.dispatch', NOW).ok).toBe(true);
    expect(authorise(automation(), 'cleanup.preview', NOW).ok).toBe(true);
  });

  it('OWNER-017 an automation session issued beyond its permitted lifetime is refused as not_found', () => {
    const tooLong = automation({
      sessionCreatedAt: NOW.toISOString(),
      sessionExpiresAt: new Date(NOW.getTime() + (AUTOMATION_MAX_LIFETIME_SECONDS + 3600) * 1000).toISOString(),
    });
    expect(automationLifetimeExceeded(tooLong)).toBe(true);
    const decision = authorise(tooLong, 'owner.view', NOW);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.status).toBe(404);
  });

  it('OWNER-018 an expired automation session cannot act at all', () => {
    const expired = automation({ sessionExpiresAt: new Date(NOW.getTime() - 1).toISOString() });
    expect(authorise(expired, 'quality.dispatch', NOW).ok).toBe(false);
  });

  it('OWNER-019 a platform owner holds every capability; nobody else holds any', () => {
    expect(capabilitiesFor(owner()).size).toBe(OWNER_CAPABILITIES.length);
    expect(capabilitiesFor(customer()).size).toBe(0);
    expect(capabilitiesFor(ANONYMOUS_PRINCIPAL).size).toBe(0);
  });

  it('OWNER-020 restricted entry is described as noise reduction and never as access control', () => {
    const restricted = describeAccessMode('RESTRICTED_ENTRY');
    expect(restricted.honestDescription).toBe(ACCESS_MODE_NOTE);
    expect(restricted.honestDescription).toMatch(/not a security control/i);
    // And it changes no decision: the same principal gets the same answer either way.
    expect(authorise(customer(), 'owner.view', NOW).ok).toBe(false);
    expect(authorise(owner(), 'owner.view', NOW).ok).toBe(true);
  });
});
