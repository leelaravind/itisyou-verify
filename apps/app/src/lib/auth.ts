/**
 * Authentication: magic links, TOTP, recovery codes, the one-time owner bootstrap, and
 * the scoped automation identity.
 *
 * Every single-use property in this file is a **single conditional statement whose
 * `meta.changes` is the answer**. That is not a style preference. Each of these has an
 * obvious read-then-write shape that passes every test written against one caller and
 * fails silently under two:
 *
 *  - Redeeming a magic link: `UPDATE … WHERE consumed_at IS NULL … RETURNING`. Two
 *    browsers opening the same emailed link race on one statement and exactly one gets a
 *    row back.
 *  - Accepting a TOTP counter: an upsert with `WHERE excluded > stored`. A correct code
 *    is arithmetically correct for its whole step and the neighbouring ones, so the
 *    arithmetic cannot tell a first use from a second. The stored counter can.
 *  - Consuming a recovery code: `UPDATE … WHERE retired_at IS NULL`.
 *  - Promoting the platform owner: `UPDATE … WHERE NOT EXISTS (an owner)`. The path
 *    closes behind itself as a property of the data, not of a flag somebody could reset.
 *
 * Nothing here stores a bearer value. Link tokens, session cookies and recovery codes are
 * all stored as domain-separated SHA-256, so a database dump is not a set of logins.
 */
import { AppError } from '@verify/contracts';
import {
  createRecoveryCodes,
  createTotpEnrolment,
  hashRecoveryCode,
  hashToken,
  openCredentialFor,
  randomBytes,
  sealCredentialFor,
  toBase64Url,
  verifyTotpCode,
  type TotpCheck,
  type TotpEnrolment,
} from '@verify/security';
import { auditEvents, credentials, loginTokens, sessions, settings, users } from '../db';
import type { Db } from '../db/d1';
import type { Env } from './context';
import { ID_PREFIX, newId } from './ids';
import { addSecondsIso, nowIso } from './time';
import { newSessionValue, sessionIdFor, SESSION_TTL_SECONDS } from './session';

/* -------------------------------------------------------------------------- */
/* constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long an emailed sign-in link lives. Minutes, not hours.
 *
 * A magic link is a bearer credential sitting in an inbox: it survives mail forwarding,
 * shared mailboxes, and a laptop left open. Ten minutes is long enough to walk to the
 * other machine and short enough that a stale inbox is not a standing key.
 */
export const SIGN_IN_LINK_TTL_SECONDS = 10 * 60;

/** Sign-in requests allowed per address per window, before we stop sending. */
export const SIGN_IN_RATE_LIMIT = 5;
export const SIGN_IN_RATE_WINDOW_SECONDS = 15 * 60;

/** The longest an automation identity may live. Mirrors A07's AUTOMATION_MAX_LIFETIME. */
export const AUTOMATION_MAX_LIFETIME_SECONDS = 12 * 60 * 60;

/** AAD purposes. Distinct strings, so a TOTP secret cannot be opened as a recovery code. */
const PURPOSE_TOTP = 'totp_seed';
const PURPOSE_RECOVERY = 'recovery_code';

/** The AAD provider for user-scoped material. Not a connector; named so it reads right. */
const PROVIDER_IDENTITY = 'identity';

/** Same normalisation A07's bootstrap uses, so the two cannot disagree on an address. */
export function normaliseAuthSubject(value: string): string {
  return (value ?? '').trim().toLowerCase();
}

function credentialKey(env: Env): { keyBase64: string; keyVersion: number } {
  const keyBase64 = env.CREDENTIAL_KEY_V1;
  if (keyBase64 === undefined || keyBase64.length === 0) {
    throw new AppError(
      503,
      'IDENTITY_NOT_CONFIGURED',
      'Two-factor enrolment is unavailable on this deployment.',
    );
  }
  return { keyBase64, keyVersion: 1 };
}

/* -------------------------------------------------------------------------- */
/* magic links                                                                 */
/* -------------------------------------------------------------------------- */

export type SignInPurpose = 'signin' | 'invite' | 'owner_bootstrap';

export interface IssuedSignInLink {
  /**
   * The bearer token that goes in the email. Held in memory for the length of one
   * request and never stored — only `hashToken(token, 'login')` reaches the database.
   */
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Issue a single-use sign-in token.
 *
 * Returns the token so the caller can put it in an email. The caller must not log it, and
 * must not return it to the browser outside the staging-only completion route below.
 */
export async function issueSignInToken(
  db: Db,
  params: {
    email: string;
    purpose?: SignInPurpose;
    now: Date;
    ttlSeconds?: number;
  },
): Promise<IssuedSignInLink> {
  const email = normaliseAuthSubject(params.email);
  const token = toBase64Url(randomBytes(32));
  const expiresAt = addSecondsIso(params.now, params.ttlSeconds ?? SIGN_IN_LINK_TTL_SECONDS);
  await loginTokens.issue(db, {
    tokenHash: await hashToken(token, 'login'),
    email,
    purpose: params.purpose ?? 'signin',
    createdAt: nowIso(params.now),
    expiresAt,
  });
  return { token, expiresAt };
}

export type RedeemRefusal = 'unknown_or_used' | 'rate_limited';

export interface RedeemedSignIn {
  readonly userId: string;
  readonly authSubject: string;
  readonly purpose: SignInPurpose;
  /** The new session cookie value. The ONLY time it exists outside the browser. */
  readonly sessionValue: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export type RedeemResult =
  | { readonly ok: true; readonly session: RedeemedSignIn }
  | { readonly ok: false; readonly refusal: RedeemRefusal };

/**
 * Redeem a sign-in link and establish a session.
 *
 * **One answer for three different failures.** A token that never existed, a token that
 * expired and a token somebody already used all return `unknown_or_used`. There is no
 * timing branch and no distinct message, because telling them apart tells an attacker
 * which guesses were close.
 *
 * **Session fixation is structurally impossible here.** A brand-new cookie value is minted
 * unconditionally, and any session the browser presented is revoked in the same batch that
 * creates the new one (`sessions.rotate`). The id after sign-in is never the id before it,
 * whether or not the caller remembered to pass the old one.
 */
export async function redeemSignInToken(
  db: Db,
  params: {
    token: string;
    now: Date;
    /** The session id the browser already had, if any. Revoked as part of the rotation. */
    presentedSessionId?: string | null;
    userAgentHash?: string | null;
    sessionTtlSeconds?: number;
  },
): Promise<RedeemResult> {
  const at = nowIso(params.now);
  const tokenHash = await hashToken(params.token, 'login');

  // One conditional statement. Two browsers opening the same link race here, and the
  // loser sees `consumed_at IS NOT NULL` and gets nothing.
  const consumed = await loginTokens.consumeOnce(db, tokenHash, at);
  if (consumed === null) return { ok: false, refusal: 'unknown_or_used' };

  const authSubject = normaliseAuthSubject(consumed.email);
  const user = await users.createOrGet(db, {
    id: newId(ID_PREFIX.user, params.now.getTime()),
    authSubject,
    createdAt: at,
  });
  if (user.disabled_at !== null) {
    // A disabled account gets the same answer as an unknown token. Saying "your account
    // is disabled" to an unauthenticated caller confirms the address exists.
    return { ok: false, refusal: 'unknown_or_used' };
  }

  const sessionValue = newSessionValue();
  const sessionId = await sessionIdFor(sessionValue);
  const expiresAt = addSecondsIso(params.now, params.sessionTtlSeconds ?? SESSION_TTL_SECONDS);

  const presented =
    params.presentedSessionId === undefined || params.presentedSessionId === null
      ? null
      : params.presentedSessionId;

  // Rotate when there is something to rotate from; otherwise create. Either way the id is
  // freshly minted, so the value the browser presented can never survive a sign-in.
  let rotated = false;
  if (presented !== null) {
    rotated = await sessions.rotate(db, {
      oldIdHash: presented,
      newIdHash: sessionId,
      userId: user.id,
      now: at,
      expiresAt,
      ...(params.userAgentHash !== undefined ? { userAgentHash: params.userAgentHash } : {}),
    });
  }
  if (!rotated) {
    // Either there was no prior session, or it was not this user's / not live. A stale
    // cookie must not stop a valid link working — but it must not be carried forward
    // either, so it is simply abandoned and a new session is created.
    await sessions.create(db, {
      idHash: sessionId,
      userId: user.id,
      createdAt: at,
      expiresAt,
      ...(params.userAgentHash !== undefined ? { userAgentHash: params.userAgentHash } : {}),
    });
    if (presented !== null) await sessions.revoke(db, presented, at);
  }

  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, params.now.getTime()),
    actor: user.id,
    actorKind: 'user',
    action: 'auth.signin',
    target: consumed.purpose,
    occurredAt: at,
  });

  return {
    ok: true,
    session: {
      userId: user.id,
      authSubject,
      purpose: consumed.purpose,
      sessionValue,
      sessionId,
      expiresAt,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* TOTP                                                                        */
/* -------------------------------------------------------------------------- */

/** `credential_versions.owner_scope` for a user's TOTP seed. */
export function totpScope(userId: string): string {
  return `user:${userId}`;
}

/** `credential_versions.owner_scope` for a user's recovery codes. */
export function recoveryScope(userId: string): string {
  return `user:${userId}:recovery`;
}

function totpAad(userId: string) {
  return { workspaceId: userId, provider: PROVIDER_IDENTITY, purpose: PURPOSE_TOTP };
}

function recoveryAad(userId: string) {
  return { workspaceId: userId, provider: PROVIDER_IDENTITY, purpose: PURPOSE_RECOVERY };
}

export interface TotpEnrolmentResult {
  /** Shown exactly once. There is no route that can produce it again. */
  readonly provisioningUri: string;
  readonly secretBase32: string;
  /** Shown exactly once. Only hashes reach the database. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Enrol a user in TOTP and issue their recovery codes.
 *
 * The seed is sealed under the user-scoped AAD before it touches the database, so a row
 * lifted into another user's scope will not open. The URI and the codes are returned once
 * and there is deliberately no function anywhere that re-reads them for display: if the
 * owner loses them, they re-enrol.
 *
 * Re-enrolling retires the previous seed and every unused recovery code, so an old
 * authenticator app and an old printout both stop working at the same instant.
 */
export async function enrolTotp(
  db: Db,
  env: Env,
  params: { userId: string; accountName: string; now: Date; issuer?: string },
): Promise<TotpEnrolmentResult> {
  const key = credentialKey(env);
  const at = nowIso(params.now);
  const enrolment: TotpEnrolment = createTotpEnrolment({
    issuer: params.issuer ?? 'ITISYOU Verify',
    accountName: params.accountName,
  });

  const sealed = await sealCredentialFor(enrolment.secretBase32, totpAad(params.userId), key);
  const credentialId = newId(ID_PREFIX.credential, params.now.getTime());
  await credentials.store(db, {
    id: credentialId,
    ownerScope: totpScope(params.userId),
    keyVersion: sealed.key_version,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    aad: sealed.aad,
    createdAt: at,
  });
  await users.setTotpReference(db, params.userId, { secretRef: credentialId, enrolledAt: at });

  // A fresh enrolment invalidates the old printout. Retiring rather than deleting keeps
  // the audit trail of how many codes existed.
  await credentials.retireAllForScope(db, recoveryScope(params.userId), at);
  const recovery = await createRecoveryCodes();
  for (let i = 0; i < recovery.hashes.length; i += 1) {
    const hash = recovery.hashes[i] as string;
    const marker = await sealCredentialFor(
      JSON.stringify({ issued_at: at, index: i }),
      recoveryAad(params.userId),
      key,
    );
    await credentials.insertRecoveryCode(db, {
      rowId: recoveryRowId(hash),
      ownerScope: recoveryScope(params.userId),
      keyVersion: marker.key_version,
      ciphertext: marker.ciphertext,
      nonce: marker.nonce,
      aad: marker.aad,
      createdAt: at,
    });
  }

  // The counter starts fresh so a code minted during enrolment cannot be replayed after.
  await resetTotpCounter(db, params.userId, params.now);

  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, params.now.getTime()),
    actor: params.userId,
    actorKind: 'user',
    action: 'auth.totp.enrolled',
    occurredAt: at,
    redactedMetadata: JSON.stringify({ recovery_codes_issued: recovery.codes.length }),
  });

  return {
    provisioningUri: enrolment.provisioningUri,
    secretBase32: enrolment.secretBase32,
    recoveryCodes: recovery.codes,
  };
}

/**
 * The row id of a recovery code.
 *
 * The hash IS the address. Storing it as the primary key is what makes consumption a
 * single conditional UPDATE rather than a scan-then-write, and a SHA-256 of a 100-bit code
 * is not reversible by anyone who can read the table.
 */
function recoveryRowId(hash: string): string {
  return `rcv_${hash}`;
}

/** `settings` key holding the highest TOTP counter accepted for a user. */
export function totpCounterKey(userId: string): string {
  return `auth.totp_counter:${userId}`;
}

async function resetTotpCounter(db: Db, userId: string, now: Date): Promise<void> {
  await settings.set(db, {
    key: totpCounterKey(userId),
    valueJson: '0',
    updatedAt: nowIso(now),
  });
}

async function readTotpCounter(db: Db, userId: string): Promise<number | null> {
  return settings.readCounter(db, totpCounterKey(userId));
}

/**
 * Claim a TOTP counter, once.
 *
 * One statement. The upsert only writes when the presented counter is strictly greater
 * than the stored one, so `meta.changes === 1` means "this counter had never been accepted
 * and now has been". Two concurrent submissions of the same correct code race here and
 * exactly one wins — which is the property the whole replay defence rests on, and the one
 * a read-then-write silently loses.
 */
async function claimTotpCounter(
  db: Db,
  userId: string,
  counter: number,
  now: Date,
): Promise<boolean> {
  return settings.claimMonotonicCounter(db, {
    key: totpCounterKey(userId),
    counter,
    at: nowIso(now),
  });
}

export type TotpVerifyOutcome =
  | { readonly ok: true; readonly method: 'totp' | 'recovery'; readonly counter: number | null }
  | {
      readonly ok: false;
      readonly refusal: 'not_enrolled' | 'malformed' | 'mismatch' | 'replayed' | 'unavailable';
      readonly dependency: string | null;
    };

/**
 * Verify a TOTP code, or a recovery code, and mark the session strongly authenticated.
 *
 * Order matters: a six-digit input is treated as a TOTP code and never as a recovery code,
 * so a recovery code cannot be brute-forced through the TOTP field and the two failure
 * paths cannot be used to probe each other.
 */
export async function verifyTotpForUser(
  db: Db,
  env: Env,
  params: {
    userId: string;
    code: string;
    now: Date;
    /** When supplied, a success stamps `mfa_verified_at` on this session. */
    sessionId?: string | null;
    accountName?: string;
  },
): Promise<TotpVerifyOutcome> {
  const at = nowIso(params.now);
  const trimmed = (params.code ?? '').trim();

  // A recovery code is not six digits, so the two inputs cannot be confused.
  if (trimmed.length > 0 && !/^[0-9]{6}$/.test(trimmed)) {
    return consumeRecoveryCode(db, params.userId, trimmed, params.now, params.sessionId ?? null);
  }

  const envelope = await credentials.activeForUser(db, params.userId);
  if (envelope === null) {
    return {
      ok: false,
      refusal: 'not_enrolled',
      dependency:
        'This account has no authenticator enrolled, so there is no code to check. Nothing has been accepted.',
    };
  }

  let secretBase32: string;
  try {
    secretBase32 = await openCredentialFor(
      {
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
        aad: envelope.aad,
        key_version: envelope.key_version,
      },
      totpAad(params.userId),
      credentialKey(env),
    );
  } catch {
    return {
      ok: false,
      refusal: 'unavailable',
      dependency:
        'The stored authenticator seed could not be read with this deployment’s key, so the code could not be checked. Nothing has been accepted.',
    };
  }

  const last = await readTotpCounter(db, params.userId);
  const check: TotpCheck = verifyTotpCode({
    secretBase32,
    code: trimmed,
    now: params.now,
    lastAcceptedCounter: last,
    ...(params.accountName !== undefined ? { accountName: params.accountName } : {}),
  });
  if (!check.ok) {
    await recordMfaAudit(db, params.userId, `auth.totp.${check.refusal}`, params.now);
    return { ok: false, refusal: check.refusal, dependency: null };
  }

  // The arithmetic said yes; the database decides whether it is a first use.
  if (!(await claimTotpCounter(db, params.userId, check.counter, params.now))) {
    await recordMfaAudit(db, params.userId, 'auth.totp.replayed', params.now);
    return { ok: false, refusal: 'replayed', dependency: null };
  }

  if (params.sessionId !== undefined && params.sessionId !== null) {
    await sessions.markMfaVerified(db, params.sessionId, at);
  }
  await recordMfaAudit(db, params.userId, 'auth.totp.accepted', params.now);
  return { ok: true, method: 'totp', counter: check.counter };
}

async function recordMfaAudit(db: Db, userId: string, action: string, now: Date): Promise<void> {
  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, now.getTime()),
    actor: userId,
    actorKind: 'user',
    action,
    occurredAt: nowIso(now),
  });
}

/**
 * Consume a recovery code, once.
 *
 * `UPDATE … WHERE retired_at IS NULL` on a row addressed by the code's own hash. Two
 * people presenting the same printed code race on that statement; the loser is told the
 * code is wrong, which is true — it is no longer a code.
 */
export async function consumeRecoveryCode(
  db: Db,
  userId: string,
  code: string,
  now: Date,
  sessionId: string | null,
): Promise<TotpVerifyOutcome> {
  const at = nowIso(now);
  const hash = await hashRecoveryCode(code);
  const consumed = await credentials.consumeRecoveryCode(db, {
    rowId: recoveryRowId(hash),
    ownerScope: recoveryScope(userId),
    at,
  });

  if (!consumed) {
    await recordMfaAudit(db, userId, 'auth.recovery.rejected', now);
    return { ok: false, refusal: 'mismatch', dependency: null };
  }

  if (sessionId !== null) await sessions.markMfaVerified(db, sessionId, at);
  // Consumption is audited: a recovery code being used is exactly the event an owner
  // wants to see, whether or not it was them.
  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, now.getTime()),
    actor: userId,
    actorKind: 'user',
    action: 'auth.recovery.consumed',
    occurredAt: at,
    redactedMetadata: JSON.stringify({ remaining: await countRecoveryCodes(db, userId) }),
  });
  return { ok: true, method: 'recovery', counter: null };
}

/** How many unused recovery codes remain. Shown to the owner; never the codes themselves. */
export async function countRecoveryCodes(db: Db, userId: string): Promise<number> {
  return credentials.countActiveForScope(db, recoveryScope(userId));
}

/* -------------------------------------------------------------------------- */
/* platform owner bootstrap                                                    */
/* -------------------------------------------------------------------------- */

/** True when any platform owner exists. The permanent "bootstrap is closed" condition. */
export async function platformOwnerExists(db: Db): Promise<boolean> {
  return users.platformOwnerExists(db);
}

/**
 * Promote a verified user to platform owner, at most once for the life of the deployment.
 *
 * `AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_owner = 1)` is inside the same
 * statement as the write. Two bootstrap requests arriving together — the realistic case,
 * because a leaked deployment secret gets tried repeatedly — both evaluate that condition
 * against the same committed state and exactly one of them writes.
 *
 * This is what makes "the path disables itself" a property of the data rather than a flag
 * somebody could reset or a secret somebody forgot to delete.
 */
export async function promoteToPlatformOwner(db: Db, authSubject: string): Promise<string> {
  const userId = await users.promoteToPlatformOwnerOnce(db, normaliseAuthSubject(authSubject));
  if (userId === null) {
    throw new AppError(409, 'BOOTSTRAP_CLOSED', 'Bootstrap is not available.');
  }
  return userId;
}

/* -------------------------------------------------------------------------- */
/* the scoped automation identity                                              */
/* -------------------------------------------------------------------------- */

export interface AutomationIdentity {
  readonly userId: string;
  readonly sessionValue: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/**
 * Provision the scoped automation test identity.
 *
 * Four things it can never do — activate an advert, issue a refund, move budget, become
 * platform owner — and they are not enforced here. They are enforced by
 * `capabilitiesFor()` in `owner/access.ts`, which checks `isAutomation` **before**
 * `isPlatformOwner` and returns a set those four capabilities are simply absent from.
 * There is no flag to flip and no condition to get wrong, which is why this function can
 * be this short: the denial is structural, not defensive.
 *
 * It is created with `is_automation = 1` and a bounded lifetime, and its user row is left
 * with `is_platform_owner = 0`.
 */
export async function provisionAutomationIdentity(
  db: Db,
  params: { authSubject: string; now: Date; lifetimeSeconds?: number },
): Promise<AutomationIdentity> {
  const requested = params.lifetimeSeconds ?? AUTOMATION_MAX_LIFETIME_SECONDS;
  // The ceiling is applied here rather than trusted from the caller: a browser test that
  // needs longer than this is a browser test that should sign in again.
  const lifetime = Math.min(Math.max(60, requested), AUTOMATION_MAX_LIFETIME_SECONDS);
  const at = nowIso(params.now);
  const subject = normaliseAuthSubject(params.authSubject);

  const user = await users.createOrGet(db, {
    id: newId(ID_PREFIX.user, params.now.getTime()),
    authSubject: subject,
    displayName: 'Automation test identity',
    createdAt: at,
  });

  const sessionValue = newSessionValue();
  const sessionId = await sessionIdFor(sessionValue);
  const expiresAt = addSecondsIso(params.now, lifetime);
  await sessions.create(db, {
    idHash: sessionId,
    userId: user.id,
    createdAt: at,
    expiresAt,
    isAutomation: true,
  });

  await auditEvents.record(db, {
    id: newId(ID_PREFIX.auditEvent, params.now.getTime()),
    actor: user.id,
    actorKind: 'automation',
    action: 'auth.automation.provisioned',
    occurredAt: at,
    redactedMetadata: JSON.stringify({ lifetime_seconds: lifetime }),
  });

  return { userId: user.id, sessionValue, sessionId, expiresAt };
}
