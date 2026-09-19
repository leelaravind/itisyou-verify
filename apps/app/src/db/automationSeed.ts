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
import {
  csrfCookieName,
  generateCsrfToken,
  hashToken,
  randomBytes,
  toBase64Url,
} from '@verify/security';
import { AUTOMATION_MAX_LIFETIME_SECONDS } from '../lib/auth';
import { ID_PREFIX, newId } from '../lib/ids';
import { sessionCookieName } from '../lib/session';
import { addSecondsIso, nowIso } from '../lib/time';
import type { Db } from './d1';
import { auditEvents, memberships, sessions, users, workspaces } from './index';

/** The address the automation identity signs in as. Never a real person's. */
export const AUTOMATION_AUTH_SUBJECT = 'automation@itisyou.test';

/**
 * The synthetic workspace the customer pages render for the browser suite.
 *
 * Stable, so a re-seed reuses it rather than accumulating workspaces. `is_synthetic = 1`,
 * so every count, list and owner view that filters synthetic data keeps excluding it and
 * nobody mistakes it for a customer.
 */
export const AUTOMATION_WORKSPACE_ID = 'ws_automation_test';

/**
 * Read-only, deliberately.
 *
 * A test identity that can change a customer's configuration is a standing credential that
 * can change a customer's configuration, sitting in an environment variable. `viewer` gives
 * the suite a surface to measure without that. A scoped write, if one is ever genuinely
 * needed, gets its own narrowly-scoped identity and a stated reason.
 */
export const AUTOMATION_WORKSPACE_ROLE = 'workspace_viewer' as const;

export interface AutomationSeedRequest {
  /** The deployment being seeded. `production` throws, before anything is minted. */
  readonly environment: string;
  /** The origin the browser will send the cookie to. Decides the cookie NAME. */
  readonly baseUrl: string;
  readonly now?: Date;
  readonly lifetimeSeconds?: number;
  readonly authSubject?: string;
}

/**
 * A separate, narrowly-scoped identity that CAN configure a workflow — authorised because
 * the viewer identity above cannot, and nothing could be configured through the real UI
 * without one.
 *
 * The owner's written reason, verbatim:
 *
 * > Without an identity that can configure a workflow, no workflow can be configured in any
 * > test, so the vertical slice can never be proven, so the product would ship on unit tests
 * > alone. This project has now found five separate workstreams whose code was correct,
 * > thoroughly tested and reachable by no request. Shipping on that basis is the specific
 * > failure the slice exists to prevent, and it is a larger risk than a scoped admin
 * > credential.
 *
 * It is never the viewer identity elevated — a distinct subject, a distinct user row, a
 * distinct session — and it is scoped to `AUTOMATION_WORKSPACE_ID`, the same synthetic
 * workspace, and nothing else. `AUTH-460` asserts it holds no membership anywhere a real
 * workspace could be. It exists only when a caller (`scripts/seed-automation-identity.mjs`
 * behind `SEED_WORKFLOW_ADMIN=1`, or a test) explicitly asks for it — nothing here seeds it
 * automatically, the same way nothing seeds `seedAutomationIdentity` automatically.
 */
export const AUTOMATION_ADMIN_AUTH_SUBJECT = 'automation-admin@itisyou.test';
export const AUTOMATION_ADMIN_WORKSPACE_ROLE = 'workspace_admin' as const;

export interface AutomationSeed {
  readonly userId: string;
  readonly workspaceId: string;
  /** `workspace_viewer` from `seedAutomationIdentity`, `workspace_admin` from the workflow-admin variant. */
  readonly workspaceRole: 'workspace_viewer' | 'workspace_admin';
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
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }

  const now = request.now ?? new Date();
  const requested = request.lifetimeSeconds ?? AUTOMATION_MAX_LIFETIME_SECONDS;
  // The ceiling is applied here rather than trusted: A07 refuses a longer-lived identity
  // by 404-ing every owner route, which looks like a broken suite rather than a bad seed.
  const lifetimeSeconds = Math.min(Math.max(60, requested), AUTOMATION_MAX_LIFETIME_SECONDS);
  const secure = isSecureOrigin(request.baseUrl);

  return {
    userId: newId(ID_PREFIX.user, now.getTime()),
    workspaceId: AUTOMATION_WORKSPACE_ID,
    workspaceRole: AUTOMATION_WORKSPACE_ROLE,
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

  // The workspace is the part whose absence made `/app` answer 401 while `/owner`
  // answered 200: `resolveSession` requires a membership, and there was none. One missing
  // row presented as sixteen failing customer cases.
  await workspaces
    .createWithOwner(db, {
      workspaceId: AUTOMATION_WORKSPACE_ID,
      name: 'Automation test workspace',
      userId: user.id,
      createdAt: draft.createdAt,
      isSynthetic: true,
    })
    .catch(async () => {
      // Already seeded. Re-assert the row's shape rather than assuming a previous run left
      // it correct — a database somebody had edited must not silently widen this identity.
      await db
        .prepare("UPDATE workspaces SET status = 'active', is_synthetic = 1 WHERE id = ?")
        .bind(AUTOMATION_WORKSPACE_ID)
        .run();
    });

  // Read-only, asserted on every seed. `createWithOwner` binds the creator as admin, which
  // is right for a real signup and wrong for this identity.
  await memberships.add(db, {
    workspaceId: AUTOMATION_WORKSPACE_ID,
    userId: user.id,
    role: AUTOMATION_WORKSPACE_ROLE,
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
 * Create the workflow-admin identity and its session — the same shape as
 * `seedAutomationIdentity`, with two deliberate differences: a distinct subject/user, and
 * `workspace_admin` rather than `workspace_viewer` on the membership row.
 *
 * Never call this from anywhere that is not explicitly asking for a write-capable identity.
 * There is no environment-variable check inside this function on purpose — the same reason
 * `seedAutomationIdentity` has none: gating belongs to the caller that decides whether this
 * identity should exist at all (`scripts/seed-automation-identity.mjs`'s
 * `SEED_WORKFLOW_ADMIN`, or a test that says so by calling this directly).
 */
export async function seedAutomationWorkflowAdmin(
  db: Db,
  request: AutomationSeedRequest,
): Promise<AutomationSeed> {
  const draft = buildAutomationSeed(request);
  const now = request.now ?? new Date();
  const authSubject = (request.authSubject ?? AUTOMATION_ADMIN_AUTH_SUBJECT).trim().toLowerCase();

  const user = await users.createOrGet(db, {
    id: draft.userId,
    authSubject,
    displayName: 'Automation workflow-admin test identity',
    createdAt: draft.createdAt,
  });

  // The same synthetic workspace the viewer identity uses — never a second one. Scoping
  // this identity to a workspace that is `is_synthetic = 1`, and to no other membership row
  // at all, is what "cannot touch a real one" means in practice.
  await workspaces
    .createWithOwner(db, {
      workspaceId: AUTOMATION_WORKSPACE_ID,
      name: 'Automation test workspace',
      userId: user.id,
      createdAt: draft.createdAt,
      isSynthetic: true,
    })
    .catch(async () => {
      await db
        .prepare("UPDATE workspaces SET status = 'active', is_synthetic = 1 WHERE id = ?")
        .bind(AUTOMATION_WORKSPACE_ID)
        .run();
    });

  await memberships.add(db, {
    workspaceId: AUTOMATION_WORKSPACE_ID,
    userId: user.id,
    role: AUTOMATION_ADMIN_WORKSPACE_ROLE,
    createdAt: draft.createdAt,
  });

  const sessionId = await hashToken(draft.sessionCookieValue, 'session');
  await sessions.create(db, {
    idHash: sessionId,
    userId: user.id,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    isAutomation: true,
    mfaVerifiedAt: draft.createdAt,
  });

  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, now.getTime()),
    actor: user.id,
    actorKind: 'automation',
    action: 'auth.automation_admin.seeded',
    occurredAt: draft.createdAt,
    redactedMetadata: JSON.stringify({
      lifetime_seconds: draft.lifetimeSeconds,
      environment: request.environment,
      secure: draft.secure,
    }),
  });

  return {
    ...draft,
    userId: user.id,
    sessionId,
    workspaceRole: AUTOMATION_ADMIN_WORKSPACE_ROLE,
  };
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
