/**
 * Who may see the owner panel, and who may act inside it.
 *
 * Three independent gates, in this order. Each one exists because the others can fail:
 *
 *  1. **Is this principal allowed in the panel at all?** Anonymous visitors and signed-in
 *     customers are not. A refusal at this gate is reported as an ordinary `404` — never a
 *     `403` — so a scanner walking `/owner`, `/owner/quality`, `/admin/approvals` learns
 *     nothing it did not already know. A10 asked for this explicitly (T-OWN-01).
 *  2. **Does this principal hold the capability the action needs?** The scoped automation
 *     test identity is a legitimate principal in the panel — it can sign in and read — so a
 *     capability denial for it is a `403` with a reason. That leaks nothing new: the
 *     identity has already proved the routes exist by using them. The 404 rule is about
 *     people who should not be here at all.
 *  3. **Is the strong authentication recent?** `mfa_verified_at` within
 *     {@link MFA_WINDOW_SECONDS}. "Signed in on Tuesday" is not strong authentication
 *     (T-OWN-04). Read-only viewing does not need it; every consequential action does.
 *
 * ## What `RESTRICTED_ENTRY` is not
 *
 * `ACCESS_MODE` may be set to `RESTRICTED_ENTRY`, which hides the admin entry point from
 * the public navigation and answers an unauthenticated probe of `/admin` with the same 404
 * everything else gets. That reduces drive-by scanning noise. **It is not access control**
 * and nothing in this file consults it: every decision below is made on the session, the
 * platform-owner flag and the strong-auth timestamp, and would be made identically if the
 * entry point were advertised on the home page. See {@link ACCESS_MODE_NOTE}.
 */
import type { AccessMode } from '@verify/contracts';

/** How recent `mfa_verified_at` must be for a consequential action. 15 minutes. */
export const MFA_WINDOW_SECONDS = 15 * 60;

/**
 * The longest life a scoped automation identity may be issued with. A browser test that
 * needs longer than this is a browser test that should sign in again.
 */
export const AUTOMATION_MAX_LIFETIME_SECONDS = 12 * 60 * 60;

/** Stated once, rendered on the settings page, and never quietly contradicted in code. */
export const ACCESS_MODE_NOTE =
  'Restricted entry only hides the sign-in link and stops the address being advertised. ' +
  'It reduces scanning noise. It is not a security control: every owner page checks your ' +
  'session, your platform-owner flag and your recent two-factor check regardless of this setting.';

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

export type PrincipalKind = 'anonymous' | 'customer' | 'automation' | 'owner';

export interface OwnerPrincipal {
  readonly kind: PrincipalKind;
  readonly userId: string | null;
  /** Shown back to the person who owns it, and to nobody else. */
  readonly email: string | null;
  readonly isPlatformOwner: boolean;
  readonly isAutomation: boolean;
  /** ISO-8601 UTC of the last successful TOTP check on THIS session, or null. */
  readonly mfaVerifiedAt: string | null;
  readonly sessionCreatedAt: string | null;
  readonly sessionExpiresAt: string | null;
  /** Double-submit token for every form the panel renders. A02 owns generation. */
  readonly csrfToken: string;
}

export const ANONYMOUS_PRINCIPAL: OwnerPrincipal = {
  kind: 'anonymous',
  userId: null,
  email: null,
  isPlatformOwner: false,
  isAutomation: false,
  mfaVerifiedAt: null,
  sessionCreatedAt: null,
  sessionExpiresAt: null,
  csrfToken: '',
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The closed set of things anybody can do in this panel. A new button adds a capability
 * here first; there is deliberately no "admin: true" that grows silently.
 */
export const OWNER_CAPABILITIES = [
  'owner.view',
  'ads.activate',
  'ads.pause',
  'refund.issue',
  'budget.move',
  'owner.grant',
  'approval.grant',
  'controls.toggle',
  'connection.rotate',
  'connection.revoke',
  'settings.write',
  'quality.dispatch',
  'cleanup.preview',
  'cleanup.execute',
  'maintenance.dispatch',
  'customer.reject',
  'verification.retry',
] as const;

export type OwnerCapability = (typeof OWNER_CAPABILITIES)[number];

/** Viewing is not consequential. Everything else is, and everything else needs recent MFA. */
const READ_ONLY_CAPABILITIES: ReadonlySet<OwnerCapability> = new Set<OwnerCapability>(['owner.view']);

export function isConsequential(capability: OwnerCapability): boolean {
  return !READ_ONLY_CAPABILITIES.has(capability);
}

/**
 * What the scoped automation test identity may do — and, far more importantly, what it may
 * not. It exists so a browser test can drive the panel without any possibility of
 * activating an advert, moving money or promoting itself. The four denials are structural:
 * the capability is simply absent from this set, so there is no flag to flip and no
 * condition to get wrong.
 */
export const AUTOMATION_CAPABILITIES: ReadonlySet<OwnerCapability> = new Set<OwnerCapability>([
  'owner.view',
  'quality.dispatch',
  'cleanup.preview',
]);

/** Named so a test and a page can both say precisely what the automation identity cannot do. */
export const AUTOMATION_DENIED: readonly OwnerCapability[] = [
  'ads.activate',
  'refund.issue',
  'budget.move',
  'owner.grant',
];

export function capabilitiesFor(principal: OwnerPrincipal): ReadonlySet<OwnerCapability> {
  if (principal.isAutomation) return AUTOMATION_CAPABILITIES;
  if (principal.isPlatformOwner) return new Set(OWNER_CAPABILITIES);
  return new Set<OwnerCapability>();
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type AccessRefusal =
  /** Rendered as an ordinary 404. Reveals nothing about the route or the account. */
  | 'not_found'
  /** A principal that belongs in the panel asked for something its identity cannot do. */
  | 'capability_denied'
  /** The owner is genuine but has not proved possession recently enough. */
  | 'mfa_required';

export interface AccessDenied {
  readonly ok: false;
  readonly refusal: AccessRefusal;
  readonly status: 404 | 403;
  /** Safe to log and to show to the principal it was shown to. Never shown on a 404. */
  readonly detail: string;
}

export interface AccessGranted {
  readonly ok: true;
  readonly principal: OwnerPrincipal;
  readonly capability: OwnerCapability;
}

export type AccessDecision = AccessGranted | AccessDenied;

function notFound(detail: string): AccessDenied {
  return { ok: false, refusal: 'not_found', status: 404, detail };
}

function parseMs(iso: string | null): number | null {
  if (iso === null || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when the session itself is still usable at `now`. */
export function isSessionLive(principal: OwnerPrincipal, now: Date): boolean {
  const expires = parseMs(principal.sessionExpiresAt);
  if (expires === null) return false;
  return expires > now.getTime();
}

/**
 * True when this session's strong authentication is recent enough to act on.
 *
 * A session with no `mfa_verified_at` is not "probably fine" — it is a session that has
 * never proved possession, and it returns false.
 */
export function hasRecentMfa(
  principal: OwnerPrincipal,
  now: Date,
  windowSeconds: number = MFA_WINDOW_SECONDS,
): boolean {
  const verified = parseMs(principal.mfaVerifiedAt);
  if (verified === null) return false;
  const age = now.getTime() - verified;
  // A timestamp in the future is a clock problem or a forgery. Either way it is not proof.
  if (age < 0) return false;
  return age <= windowSeconds * 1000;
}

/** Seconds until the current strong-auth window lapses. Zero when it already has. */
export function mfaSecondsRemaining(
  principal: OwnerPrincipal,
  now: Date,
  windowSeconds: number = MFA_WINDOW_SECONDS,
): number {
  const verified = parseMs(principal.mfaVerifiedAt);
  if (verified === null) return 0;
  const remaining = verified + windowSeconds * 1000 - now.getTime();
  return remaining <= 0 ? 0 : Math.floor(remaining / 1000);
}

/**
 * True when an automation identity was issued with a lifetime longer than we permit.
 * Checked at authorisation time as well as at issue time, because a row written by an
 * older build must not become a long-lived credential by surviving a deploy.
 */
export function automationLifetimeExceeded(
  principal: OwnerPrincipal,
  maxSeconds: number = AUTOMATION_MAX_LIFETIME_SECONDS,
): boolean {
  if (!principal.isAutomation) return false;
  const created = parseMs(principal.sessionCreatedAt);
  const expires = parseMs(principal.sessionExpiresAt);
  if (created === null || expires === null) return true;
  return expires - created > maxSeconds * 1000;
}

/**
 * The one function every owner route calls before doing anything at all.
 *
 * It never throws and never returns a partially-allowed state: either there is a principal
 * holding the capability with recent strong auth, or there is a refusal carrying the status
 * the route must answer with.
 */
export function authorise(
  principal: OwnerPrincipal,
  capability: OwnerCapability,
  now: Date,
  options: { readonly mfaWindowSeconds?: number } = {},
): AccessDecision {
  // Gate 1 — does this principal belong in the panel? Everything here answers 404.
  if (principal.kind === 'anonymous') return notFound('no session');
  if (!isSessionLive(principal, now)) return notFound('session expired or revoked');
  if (!principal.isPlatformOwner && !principal.isAutomation) return notFound('not a platform principal');
  if (automationLifetimeExceeded(principal)) return notFound('automation identity issued beyond its permitted lifetime');

  // Gate 2 — capability. A principal that got this far may be told what it cannot do.
  const held = capabilitiesFor(principal);
  if (!held.has(capability)) {
    if (principal.isAutomation) {
      // 403 here, not 404, and that is not an inconsistency with gate 1. This principal has
      // already proved the route exists by reading it, so naming the refusal leaks nothing
      // new — and a browser test needs to tell "denied" apart from "route missing" to be
      // worth writing. The 404 rule protects people who should not be in the panel at all.
      return {
        ok: false,
        refusal: 'capability_denied',
        status: 403,
        detail:
          `The automation test identity cannot ${capability}. This identity exists to drive browser ` +
          'tests and is structurally unable to activate an advert, issue a refund, move budget or become platform owner.',
      };
    }
    return notFound(`principal does not hold ${capability}`);
  }

  // Gate 3 — recent strong authentication, for anything consequential.
  if (isConsequential(capability)) {
    const window = options.mfaWindowSeconds ?? MFA_WINDOW_SECONDS;
    if (!hasRecentMfa(principal, now, window)) {
      return {
        ok: false,
        refusal: 'mfa_required',
        status: 403,
        detail:
          'This action changes something, so it needs a fresh two-factor check. ' +
          `Your last one was ${principal.mfaVerifiedAt ?? 'never'}; we require one within the last ${Math.round(window / 60)} minutes.`,
      };
    }
  }

  return { ok: true, principal, capability };
}

// ---------------------------------------------------------------------------
// Access mode
// ---------------------------------------------------------------------------

export interface AccessModeView {
  readonly mode: AccessMode;
  readonly label: string;
  /** Deliberately the same sentence wherever this is rendered. */
  readonly honestDescription: string;
}

export function describeAccessMode(mode: AccessMode): AccessModeView {
  return mode === 'RESTRICTED_ENTRY'
    ? {
        mode,
        label: 'Restricted entry (sign-in link hidden)',
        honestDescription: ACCESS_MODE_NOTE,
      }
    : {
        mode,
        label: 'Public login (sign-in link shown)',
        honestDescription:
          'The sign-in page is linked publicly. It shows nothing about customers, counts or whether an ' +
          'address has an account. Access is decided by your session and your two-factor check, exactly as it is in restricted entry.',
      };
}
