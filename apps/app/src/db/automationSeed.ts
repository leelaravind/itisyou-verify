/**
 * The scoped automation test identity, as a seedable session.
 *
 * A07's browser suite signs in the way a person does and skips when it cannot, which is
 * why `CUST-092/093/094` and `ADS-026/027` are unmeasured: `/owner` and `/app` correctly
 * require a session and A07 refused to add a backdoor, a test-only route or a relaxed
 * guard. It was right to refuse. This is the handshake that unblocks it **without** any of
 * those three: a real row, in the real `sessions` table, read by the same
 * `resolveIdentity` every other request goes through. Nothing about the guards changes.
 *
 * The shape, exactly as A07 needs it:
 *
 *  - a real session cookie value, and **the cookie name that goes with the origin** —
 *    see the note below, because this is the part that fails silently;
 *  - `is_automation = 1`, so `capabilitiesFor()` returns the automation set;
 *  - `mfa_verified_at` stamped at creation, so a consequential action is not refused for
 *    stale strong auth the moment the suite starts;
 *  - `expires_at − created_at ≤ 12h`, because A07's `automationLifetimeExceeded` refuses
 *    anything longer and a 24-hour convenience session would 404 the whole suite rather
 *    than failing loudly;
 *  - a matching CSRF cookie, because every mutation needs the double-submit pair;
 *  - `is_platform_owner = 0`. It gets `owner.view`, `quality.dispatch`, `cleanup.preview`
 *    and nothing else, and that denial is structural — `capabilitiesFor` tests
 *    `isAutomation` before `isPlatformOwner`, so there is no flag here that could widen it.
 *
 * ## The cookie name, which A07 should correct
 *
 * A07 assumed `__Host-verify_session`. That is right for the **https** staging origin and
 * wrong for the local suite, which runs against `http://127.0.0.1:8788`. A `__Host-`
 * cookie without `Secure` is rejected outright by the browser, so seeding it over http
 * sets nothing at all and the suite silently signs itself out — the exact failure mode
 * `csrfCookieName(secure)` already exists to avoid. So the name is emitted alongside the
 * value and must be read from the seed, never assumed.
 *
 * The server side is tolerant either way: `resolveIdentity` reads the name for the
 * request's own scheme and then falls back to the other one, so a mismatch cannot lock
 * anyone out server-side. It is the browser that refuses.
 *
 * ## Not in production
 *
 * `buildAutomationSeed` throws for a production environment **before it mints anything**,
 * the same ordering as `issueStagingSignInLink`: there is no value to leak even if a
 * caller ignores the error.
 */
import { AppError } from '@verify/contracts';
import { csrfCookieName, generateCsrfToken, hashToken, randomBytes, toBase64Url } from '@verify/security';
import { AUTOMATION_MAX_LIFETIME_SECONDS } from '../lib/auth';
import { ID_PREFIX, newId } from '../lib/ids';
import { sessionCookieName } from '../lib/session';
import { addSecondsIso, nowIso } from '../lib/time';
import type { Db } from './d1';
import { auditEvents, sessions, users } from './index';

/** The address the automation identity signs in as. Never a real person's. */
export const AUTOMATION_AUTH_SUBJECT = 'automation@itisyou.test';

export interface AutomationSeedRequest {
  /** The deployment being seeded. `production` throws, before anything is minted. */
  readonly environment: string;
  /** The origin the browser will send the cookie to. Decides the cookie NAME. */
  readonly baseUrl: string;
  readonly now?: Date;
  readonly lifetimeSeconds?: number;
  readonly authSubject?: string;
}

export interface AutomationSeed {
  readonly userId: string;
  /** `verify_session` over http, `__Host-verify_session` over https. Read it; do not assume. */
  readonly sessionCookieName: string;
  readonly sessionCookieValue: string;
  /** SHA-256 of the value. What is actually stored; never sent to a browser. */
  readonly sessionId: string;
  readonly csrfCookieName: string;
  readonly csrfToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lifetimeSeconds: number;
  readonly secure: boolean;
}

function isSecureOrigin(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    // An unparseable origin is treated as insecure: the failure that follows is a rejected
    // cookie somebody can see, rather than a `__Host-` cookie nobody can explain.
    return false;
  }
}

/**
 * Build the seed. Pure: no database, no side effect, so the script and the tests agree.
 *
 * The production guard runs first, before a cookie value exists.
 */
export function buildAutomationSeed(request: AutomationSeedRequest): AutomationSeed {
  if (request.environment === 'production') {
    throw new AppError(
      404,
      'NOT_FOUND',
      'Not found.',
    );
  }

  const now = request.now ?? new Date();
  const requested = request.lifetimeSeconds ?? AUTOMATION_MAX_LIFETIME_SECONDS;
  // The ceiling is applied here rather than trusted: A07 refuses a longer-lived identity
  // by 404-ing every owner route, which looks like a broken suite rather than a bad seed.
  const lifetimeSeconds = Math.min(Math.max(60, requested), AUTOMATION_MAX_LIFETIME_SECONDS);
  const secure = isSecureOrigin(request.baseUrl);

  return {
    userId: newId(ID_PREFIX.user, now.getTime()),
    sessionCookieName: sessionCookieName(secure),
    sessionCookieValue: toBase64Url(randomBytes(32)),
    sessionId: '',
    csrfCookieName: csrfCookieName(secure),
    csrfToken: generateCsrfToken(),
    createdAt: nowIso(now),
    expiresAt: addSecondsIso(now, lifetimeSeconds),
    lifetimeSeconds,
    secure,
  };
}

/**
 * Create the identity and its session, and return everything the browser suite needs.
 *
 * Idempotent on the user: the automation subject is created once and reused, so repeated
 * seeding does not accumulate accounts. A fresh session is minted each time, because a
 * session is the thing that expires.
 */
export async function seedAutomationIdentity(
  db: Db,
  request: AutomationSeedRequest,
): Promise<AutomationSeed> {
  const draft = buildAutomationSeed(request);
  const now = request.now ?? new Date();
  const authSubject = (request.authSubject ?? AUTOMATION_AUTH_SUBJECT).trim().toLowerCase();

  const user = await users.createOrGet(db, {
    id: draft.userId,
    authSubject,
    displayName: 'Automation test identity',
    createdAt: draft.createdAt,
  });

  const sessionId = await hashToken(draft.sessionCookieValue, 'session');
  await sessions.create(db, {
    idHash: sessionId,
    userId: user.id,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    isAutomation: true,
    // Stamped at creation so the suite is not refused for stale strong auth on its first
    // consequential action. It is still bounded by the session's own 12-hour life.
    mfaVerifiedAt: draft.createdAt,
  });

  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, now.getTime()),
    actor: user.id,
    actorKind: 'automation',
    action: 'auth.automation.seeded',
    occurredAt: draft.createdAt,
    redactedMetadata: JSON.stringify({
      lifetime_seconds: draft.lifetimeSeconds,
      environment: request.environment,
      secure: draft.secure,
    }),
  });

  return { ...draft, userId: user.id, sessionId };
}

/**
 * The seed as shell exports, for a script to print.
 *
 * The cookie VALUE is a live credential for the length of its session. It is emitted on
 * stdout deliberately — that is the handshake — but it is never written to an audit row,
 * never logged by the Worker, and the session it names dies within twelve hours.
 */
export function automationSeedExports(seed: AutomationSeed): string {
  return [
    `export E2E_AUTOMATION_SESSION=${seed.sessionCookieValue}`,
    `export E2E_AUTOMATION_COOKIE_NAME=${seed.sessionCookieName}`,
    `export E2E_AUTOMATION_CSRF=${seed.csrfToken}`,
    `export E2E_AUTOMATION_CSRF_COOKIE_NAME=${seed.csrfCookieName}`,
  ].join('\n');
}
