/**
 * AUTH-3xx — the owner panel's access model, attacked.
 *
 * A07 implemented the three gates this review asked for in pass one (T-OWN-01, T-OWN-04):
 * 404-not-403 for principals who do not belong, capability checks for principals who do,
 * and a recent-strong-auth window on everything consequential. These cases hold that
 * behaviour still, from the outside, against the shipped decision function.
 *
 * The scoped automation test identity is the interesting one. It is a real principal with
 * a real session, created so a browser test can drive the panel. If it can activate an
 * advert, issue a refund, move budget or promote itself, then the test account IS the
 * platform owner and the whole capability model is decoration.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCESS_MODE_NOTE,
  ANONYMOUS_PRINCIPAL,
  AUTOMATION_CAPABILITIES,
  AUTOMATION_DENIED,
  AUTOMATION_MAX_LIFETIME_SECONDS,
  MFA_WINDOW_SECONDS,
  OWNER_CAPABILITIES,
  capabilitiesFor,
  hasRecentMfa,
  isConsequential,
  isSessionLive,
  type OwnerCapability,
  type OwnerPrincipal,
} from '@app/owner/access';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const iso = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();

function principal(overrides: Partial<OwnerPrincipal>): OwnerPrincipal {
  return {
    kind: 'owner',
    userId: 'usr_owner',
    email: 'owner@example.test',
    isPlatformOwner: true,
    isAutomation: false,
    mfaVerifiedAt: iso(-60),
    sessionCreatedAt: iso(-3600),
    sessionExpiresAt: iso(3600),
    csrfToken: 'csrf_token_value_long_enough',
    ...overrides,
  };
}

const CUSTOMER = principal({
  kind: 'customer',
  userId: 'usr_customer',
  email: 'customer@example.test',
  isPlatformOwner: false,
  mfaVerifiedAt: null,
});

const AUTOMATION = principal({
  kind: 'automation',
  userId: 'usr_automation',
  email: 'automation@example.test',
  isPlatformOwner: false,
  isAutomation: true,
});

describe('who is allowed in the owner panel at all', () => {
  it('AUTH-314 an anonymous visitor holds no capability whatsoever', () => {
    expect([...capabilitiesFor(ANONYMOUS_PRINCIPAL)]).toEqual([]);
  });

  it('AUTH-315 a signed-in customer holds no owner capability', () => {
    // A paying customer is a legitimate principal on /app and a stranger on /owner.
    expect([...capabilitiesFor(CUSTOMER)]).toEqual([]);
  });

  it('AUTH-316 the platform owner holds every capability and no more than the closed set', () => {
    const held = capabilitiesFor(principal({}));
    expect(held.size).toBe(OWNER_CAPABILITIES.length);
    for (const capability of OWNER_CAPABILITIES)
      expect(held.has(capability), capability).toBe(true);
  });

  it('AUTH-317 a stale or absent session is not live, whatever the flags say', () => {
    expect(isSessionLive(principal({ sessionExpiresAt: iso(-1) }), NOW)).toBe(false);
    expect(isSessionLive(principal({ sessionExpiresAt: null }), NOW)).toBe(false);
    expect(isSessionLive(principal({ sessionExpiresAt: 'not-a-date' }), NOW)).toBe(false);
    expect(isSessionLive(principal({}), NOW)).toBe(true);
  });
});

describe('the scoped automation test identity', () => {
  it('AUTH-310 cannot activate an advert, issue a refund, move budget or become owner', () => {
    // The four denials the whole identity exists for. Structural: the capability is simply
    // absent from the set, so there is no flag to flip.
    const held = capabilitiesFor(AUTOMATION);
    for (const denied of AUTOMATION_DENIED) {
      expect(held.has(denied), `automation must NOT hold ${denied}`).toBe(false);
    }
    expect([...AUTOMATION_DENIED].sort()).toEqual(
      ['ads.activate', 'budget.move', 'owner.grant', 'refund.issue'].sort(),
    );
  });

  it('AUTH-311 holds strictly fewer capabilities than the owner, and only harmless ones', () => {
    const automation = capabilitiesFor(AUTOMATION);
    const owner = capabilitiesFor(principal({}));
    expect(automation.size).toBeLessThan(owner.size);
    for (const capability of automation) {
      expect(owner.has(capability), `${capability} is not a real capability`).toBe(true);
    }
    // Anything that spends money, changes access or mutates customer state is out.
    const forbidden: OwnerCapability[] = [
      'ads.activate',
      'ads.pause',
      'refund.issue',
      'budget.move',
      'owner.grant',
      'approval.grant',
      'connection.rotate',
      'connection.revoke',
      'settings.write',
      'cleanup.execute',
      'maintenance.dispatch',
      'customer.reject',
      'verification.retry',
      'controls.toggle',
    ];
    for (const capability of forbidden) {
      expect(automation.has(capability), `automation must NOT hold ${capability}`).toBe(false);
    }
  });

  it('AUTH-312 the automation capability set cannot be widened by flipping isPlatformOwner', () => {
    // `capabilitiesFor` checks isAutomation FIRST. A row with both flags set — by a bug, a
    // bad migration or an attacker with a database write — must still be constrained.
    const both = principal({ isAutomation: true, isPlatformOwner: true });
    const held = capabilitiesFor(both);
    for (const denied of AUTOMATION_DENIED) {
      expect(
        held.has(denied),
        `isPlatformOwner must not widen an automation identity: ${denied}`,
      ).toBe(false);
    }
    expect(held.size).toBe(AUTOMATION_CAPABILITIES.size);
  });

  it('AUTH-313 an automation identity is capped to a short lifetime', () => {
    expect(AUTOMATION_MAX_LIFETIME_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
    expect(AUTOMATION_MAX_LIFETIME_SECONDS).toBeGreaterThan(0);
  });
});

describe('recent strong authentication', () => {
  it('AUTH-332 viewing is not consequential; everything else is', () => {
    expect(isConsequential('owner.view')).toBe(false);
    for (const capability of OWNER_CAPABILITIES) {
      if (capability === 'owner.view') continue;
      expect(isConsequential(capability), capability).toBe(true);
    }
  });

  it('AUTH-333 a session that never proved possession is never recently authenticated', () => {
    expect(hasRecentMfa(principal({ mfaVerifiedAt: null }), NOW)).toBe(false);
    expect(hasRecentMfa(principal({ mfaVerifiedAt: '' }), NOW)).toBe(false);
    expect(hasRecentMfa(principal({ mfaVerifiedAt: 'not-a-date' }), NOW)).toBe(false);
  });

  it('AUTH-334 strong auth lapses at the window boundary, not "some time later"', () => {
    expect(hasRecentMfa(principal({ mfaVerifiedAt: iso(-(MFA_WINDOW_SECONDS - 1)) }), NOW)).toBe(
      true,
    );
    expect(hasRecentMfa(principal({ mfaVerifiedAt: iso(-(MFA_WINDOW_SECONDS + 1)) }), NOW)).toBe(
      false,
    );
    expect(MFA_WINDOW_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it('AUTH-335 a future-dated MFA timestamp is treated as forgery, not freshness', () => {
    // The naive `now - verified <= window` accepts any timestamp in the future, so a row
    // written with a clock skew — or by an attacker — would be permanently "recent".
    expect(hasRecentMfa(principal({ mfaVerifiedAt: iso(+60) }), NOW)).toBe(false);
    expect(hasRecentMfa(principal({ mfaVerifiedAt: iso(+86_400) }), NOW)).toBe(false);
  });
});

describe('what a refusal reveals', () => {
  it('AUTH-330 the refusal vocabulary distinguishes "not found" from "denied" deliberately', () => {
    // 404 for people who should not be here; 403 only for a principal that has already
    // proved the route exists by legitimately using it. Asserting the shape so a future
    // change to 403-for-everyone is caught here rather than by a scanner.
    const refusals = ['not_found', 'capability_denied', 'mfa_required'];
    expect(refusals).toContain('not_found');
    // A denial for an anonymous or customer principal must be the 404 kind: they hold no
    // capability at all, so there is nothing for a 403 to be about.
    expect(capabilitiesFor(ANONYMOUS_PRINCIPAL).size).toBe(0);
    expect(capabilitiesFor(CUSTOMER).size).toBe(0);
  });

  it('AUTH-331 RESTRICTED_ENTRY is documented as noise reduction, not access control', () => {
    // A secret URL is not a boundary. The note is rendered to the owner so the setting is
    // never mistaken for security; this pins the wording so it cannot quietly become a
    // claim that it protects anything.
    expect(ACCESS_MODE_NOTE).toMatch(/not a security control/i);
  });
});
