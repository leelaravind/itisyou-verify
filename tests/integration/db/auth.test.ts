/**
 * Authentication against the real database.
 *
 * Every case here targets a property that passes with one caller and fails with two, or
 * that looks correct until somebody replays it. The unit tests in
 * `tests/unit/security/totp.test.ts` prove the arithmetic; these prove the storage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeRecoveryCode,
  countRecoveryCodes,
  enrolTotp,
  issueSignInToken,
  normaliseAuthSubject,
  platformOwnerExists,
  promoteToPlatformOwner,
  provisionAutomationIdentity,
  recoveryScope,
  redeemSignInToken,
  SIGN_IN_LINK_TTL_SECONDS,
  totpScope,
  verifyTotpForUser,
  AUTOMATION_MAX_LIFETIME_SECONDS,
} from '@app/lib/auth';
import { sessions, users } from '@app/db';
import { generateTotpCode, randomBytes, toBase64 } from '@verify/security';
import { AUTOMATION_CAPABILITIES, AUTOMATION_DENIED, capabilitiesFor } from '@app/owner/access';
import type { Env } from '@app/lib/context';
import { countRows, createTestDb, type TestDb } from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const OWNER_EMAIL = 'kpleelaaravind@gmail.com';

// A 32-byte key generated per run. Nothing in the repository is wrapped with it.
// secret-scan:allow
const KEY = toBase64(randomBytes(32));

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    STRIPE_MODE: 'test',
    CREDENTIAL_KEY_V1: KEY,
    ...overrides,
  };
}

describe('magic-link sign-in', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-300 issues a token that is stored only as a hash', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    expect(issued.token.length).toBeGreaterThanOrEqual(40);
    const stored = h.raw.prepare('SELECT token_hash, email, purpose FROM login_tokens').get() as {
      token_hash: string;
      email: string;
      purpose: string;
    };
    // The bearer value must not be anywhere in the row.
    expect(stored.token_hash).not.toBe(issued.token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(stored.email).toBe(OWNER_EMAIL);
    expect(stored.purpose).toBe('signin');
  });

  it('AUTH-301 expires in minutes, not hours', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    const lifetime = (Date.parse(issued.expiresAt) - NOW.getTime()) / 1000;
    expect(lifetime).toBe(SIGN_IN_LINK_TTL_SECONDS);
    expect(lifetime).toBeLessThanOrEqual(15 * 60);
  });

  it('AUTH-302 redeems once and establishes a session', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    const result = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.authSubject).toBe(OWNER_EMAIL);
    expect(
      await sessions.findLive(h.db, result.session.sessionId, NOW.toISOString()),
    ).not.toBeNull();
    // The cookie value is not the row id.
    expect(result.session.sessionValue).not.toBe(result.session.sessionId);
  });

  it('AUTH-303 two people clicking the same link produce exactly one session', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    const results = await Promise.all([
      redeemSignInToken(h.db, { token: issued.token, now: NOW }),
      redeemSignInToken(h.db, { token: issued.token, now: NOW }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(countRows(h, 'sessions')).toBe(1);
    expect(countRows(h, 'users')).toBe(1);
  });

  it('AUTH-304 a consumed, an expired and a fabricated link are indistinguishable', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    await redeemSignInToken(h.db, { token: issued.token, now: NOW });

    const consumed = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
    const stale = await issueSignInToken(h.db, { email: 'other@example.com', now: NOW });
    const expired = await redeemSignInToken(h.db, {
      token: stale.token,
      now: at(SIGN_IN_LINK_TTL_SECONDS + 1),
    });
    const fabricated = await redeemSignInToken(h.db, { token: 'never-existed-at-all', now: NOW });

    // Byte-for-byte the same answer. No branch tells an attacker which guess was close.
    expect(consumed).toEqual({ ok: false, refusal: 'unknown_or_used' });
    expect(expired).toEqual({ ok: false, refusal: 'unknown_or_used' });
    expect(fabricated).toEqual({ ok: false, refusal: 'unknown_or_used' });
  });

  it('AUTH-305 the session id after sign-in is never the one before it', async () => {
    const first = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    const signedIn = await redeemSignInToken(h.db, { token: first.token, now: NOW });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;
    const planted = signedIn.session.sessionId;

    // The fixation attack: the browser presents a session the attacker already knows.
    const second = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: at(60) });
    const again = await redeemSignInToken(h.db, {
      token: second.token,
      now: at(60),
      presentedSessionId: planted,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    expect(again.session.sessionId).not.toBe(planted);
    // …and the planted one is dead, not merely superseded.
    expect(await sessions.findLive(h.db, planted, at(60).toISOString())).toBeNull();
    expect(
      await sessions.findLive(h.db, again.session.sessionId, at(60).toISOString()),
    ).not.toBeNull();
  });

  it('AUTH-306 a stale cookie does not stop a valid link, and is not carried forward', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    const result = await redeemSignInToken(h.db, {
      token: issued.token,
      now: NOW,
      presentedSessionId: 'a-session-that-never-existed',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.sessionId).not.toBe('a-session-that-never-existed');
    expect(countRows(h, 'sessions', 'revoked_at IS NULL')).toBe(1);
  });

  it('AUTH-307 a disabled account gets the same answer as an unknown token', async () => {
    await users.createOrGet(h.db, {
      id: 'usr_disabled',
      authSubject: OWNER_EMAIL,
      createdAt: NOW.toISOString(),
    });
    await users.disable(h.db, 'usr_disabled', NOW.toISOString());
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    expect(await redeemSignInToken(h.db, { token: issued.token, now: NOW })).toEqual({
      ok: false,
      refusal: 'unknown_or_used',
    });
    expect(countRows(h, 'sessions')).toBe(0);
  });

  it('AUTH-308 normalises the address the same way the bootstrap does', async () => {
    expect(normaliseAuthSubject('  KPLeeLaaravind@Gmail.COM ')).toBe(OWNER_EMAIL);
    const issued = await issueSignInToken(h.db, { email: '  OWNER@Example.COM ', now: NOW });
    const result = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
    expect(result.ok && result.session.authSubject).toBe('owner@example.com');
  });
});

describe('TOTP enrolment and verification', () => {
  let h: TestDb;
  let userId: string;

  beforeEach(async () => {
    h = createTestDb();
    const user = await users.createOrGet(h.db, {
      id: 'usr_owner',
      authSubject: OWNER_EMAIL,
      createdAt: NOW.toISOString(),
    });
    userId = user.id;
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-320 enrolment seals the secret and shows the URI exactly once', async () => {
    const result = await enrolTotp(h.db, env(), {
      userId,
      accountName: OWNER_EMAIL,
      now: NOW,
    });
    expect(result.provisioningUri).toContain('otpauth://totp/');
    expect(result.recoveryCodes).toHaveLength(10);

    const row = h.raw
      .prepare('SELECT ciphertext, aad, owner_scope FROM credential_versions WHERE owner_scope = ?')
      .get(totpScope(userId)) as { ciphertext: string; aad: string; owner_scope: string };
    // The seed is not recoverable from the row without the deployment key.
    expect(row.ciphertext).not.toContain(result.secretBase32);
    expect(row.aad).toContain('purpose=totp_seed');
    expect(row.aad).toContain(userId);

    // And the reference is on the user row, not the secret.
    const user = await users.findById(h.db, userId);
    expect(user?.totp_secret_ref).not.toBeNull();
    expect(user?.totp_enrolled_at).toBe(NOW.toISOString());
  });

  it('AUTH-321 accepts a correct code and stamps the session', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    await sessions.create(h.db, {
      idHash: 'sess_1',
      userId,
      createdAt: NOW.toISOString(),
      expiresAt: at(3600).toISOString(),
    });
    const code = generateTotpCode(enrolled.secretBase32, at(60));
    const outcome = await verifyTotpForUser(h.db, env(), {
      userId,
      code,
      now: at(60),
      sessionId: 'sess_1',
    });
    expect(outcome.ok).toBe(true);
    const session = await sessions.findLive(h.db, 'sess_1', at(60).toISOString());
    expect(session?.mfa_verified_at).toBe(at(60).toISOString());
  });

  it('AUTH-322 refuses a replayed code, even in the same second', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const code = generateTotpCode(enrolled.secretBase32, at(60));

    const first = await verifyTotpForUser(h.db, env(), { userId, code, now: at(60) });
    expect(first.ok).toBe(true);

    // Same code, same instant, from another browser. The arithmetic still says yes.
    const second = await verifyTotpForUser(h.db, env(), { userId, code, now: at(60) });
    expect(second).toMatchObject({ ok: false, refusal: 'replayed' });
  });

  it('AUTH-323 two concurrent submissions of one correct code: exactly one is accepted', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const code = generateTotpCode(enrolled.secretBase32, at(60));
    const outcomes = await Promise.all([
      verifyTotpForUser(h.db, env(), { userId, code, now: at(60) }),
      verifyTotpForUser(h.db, env(), { userId, code, now: at(60) }),
      verifyTotpForUser(h.db, env(), { userId, code, now: at(60) }),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.refusal === 'replayed')).toHaveLength(2);
  });

  it('AUTH-324 refuses a previous step still inside the drift window', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const current = generateTotpCode(enrolled.secretBase32, at(60));
    const previous = generateTotpCode(enrolled.secretBase32, at(30));
    expect((await verifyTotpForUser(h.db, env(), { userId, code: current, now: at(60) })).ok).toBe(
      true,
    );
    // `previous` still verifies arithmetically at at(60) under the ±1 window.
    expect(
      await verifyTotpForUser(h.db, env(), { userId, code: previous, now: at(60) }),
    ).toMatchObject({ ok: false, refusal: 'replayed' });
  });

  it('AUTH-325 accepts the next step after one was consumed', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    await verifyTotpForUser(h.db, env(), {
      userId,
      code: generateTotpCode(enrolled.secretBase32, at(60)),
      now: at(60),
    });
    const next = await verifyTotpForUser(h.db, env(), {
      userId,
      code: generateTotpCode(enrolled.secretBase32, at(120)),
      now: at(120),
    });
    expect(next.ok).toBe(true);
  });

  it('AUTH-326 says so when nobody is enrolled, rather than pretending a wrong code', async () => {
    const outcome = await verifyTotpForUser(h.db, env(), { userId, code: '123456', now: NOW });
    expect(outcome).toMatchObject({ ok: false, refusal: 'not_enrolled' });
    if (outcome.ok) return;
    expect(outcome.dependency).toContain('no authenticator enrolled');
  });

  it('AUTH-327 a seed sealed for one user does not open for another', async () => {
    await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const other = await users.createOrGet(h.db, {
      id: 'usr_other',
      authSubject: 'other@example.com',
      createdAt: NOW.toISOString(),
    });
    // Lift the row wholesale into the other user's scope, AAD column included.
    h.raw
      .prepare('UPDATE credential_versions SET owner_scope = ? WHERE owner_scope = ?')
      .run(totpScope(other.id), totpScope(userId));

    const outcome = await verifyTotpForUser(h.db, env(), {
      userId: other.id,
      code: '123456',
      now: NOW,
    });
    // The AAD binds the seed to the user it was sealed for, so the move is useless.
    expect(outcome).toMatchObject({ ok: false, refusal: 'unavailable' });
  });

  it('AUTH-328 a wrong deployment key cannot be mistaken for a wrong code', async () => {
    await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    // secret-scan:allow another ephemeral test key
    const otherKey = toBase64(randomBytes(32));
    const outcome = await verifyTotpForUser(h.db, env({ CREDENTIAL_KEY_V1: otherKey }), {
      userId,
      code: '123456',
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'unavailable' });
    if (outcome.ok) return;
    expect(outcome.dependency).toContain('could not be read');
  });
});

describe('recovery codes', () => {
  let h: TestDb;
  let userId: string;

  beforeEach(async () => {
    h = createTestDb();
    const user = await users.createOrGet(h.db, {
      id: 'usr_owner',
      authSubject: OWNER_EMAIL,
      createdAt: NOW.toISOString(),
    });
    userId = user.id;
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-340 stores only hashes, never the codes', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const rows = h.raw
      .prepare('SELECT id, ciphertext FROM credential_versions WHERE owner_scope = ?')
      .all(recoveryScope(userId)) as { id: string; ciphertext: string }[];
    expect(rows).toHaveLength(10);
    const dump = JSON.stringify(rows);
    for (const code of enrolled.recoveryCodes) {
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace(/-/g, ''));
    }
    expect(await countRecoveryCodes(h.db, userId)).toBe(10);
  });

  it('AUTH-341 a recovery code works exactly once', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const code = enrolled.recoveryCodes[0] as string;
    const first = await consumeRecoveryCode(h.db, userId, code, NOW, null);
    expect(first).toMatchObject({ ok: true, method: 'recovery' });
    const second = await consumeRecoveryCode(h.db, userId, code, NOW, null);
    expect(second).toMatchObject({ ok: false, refusal: 'mismatch' });
    expect(await countRecoveryCodes(h.db, userId)).toBe(9);
  });

  it('AUTH-342 two people presenting the same printed code: exactly one wins', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const code = enrolled.recoveryCodes[3] as string;
    const outcomes = await Promise.all([
      consumeRecoveryCode(h.db, userId, code, NOW, null),
      consumeRecoveryCode(h.db, userId, code, NOW, null),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(await countRecoveryCodes(h.db, userId)).toBe(9);
  });

  it('AUTH-343 consumption is audited', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    await consumeRecoveryCode(h.db, userId, enrolled.recoveryCodes[0] as string, NOW, null);
    const row = h.raw
      .prepare(
        "SELECT action, actor, redacted_metadata FROM audit_events WHERE action = 'auth.recovery.consumed'",
      )
      .get() as { action: string; actor: string; redacted_metadata: string };
    expect(row.actor).toBe(userId);
    expect(JSON.parse(row.redacted_metadata)).toEqual({ remaining: 9 });
    // The code itself is nowhere in the audit trail.
    expect(row.redacted_metadata).not.toContain(enrolled.recoveryCodes[0] as string);
  });

  it('AUTH-344 another user’s recovery code does not work on this account', async () => {
    const mine = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const other = await users.createOrGet(h.db, {
      id: 'usr_other',
      authSubject: 'other@example.com',
      createdAt: NOW.toISOString(),
    });
    const outcome = await consumeRecoveryCode(
      h.db,
      other.id,
      mine.recoveryCodes[0] as string,
      NOW,
      null,
    );
    expect(outcome).toMatchObject({ ok: false, refusal: 'mismatch' });
    // And it is still usable by its actual owner.
    expect(
      (await consumeRecoveryCode(h.db, userId, mine.recoveryCodes[0] as string, NOW, null)).ok,
    ).toBe(true);
  });

  it('AUTH-345 re-enrolling retires the old printout and the old authenticator together', async () => {
    const first = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const second = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: at(600) });
    expect(second.secretBase32).not.toBe(first.secretBase32);
    expect(await countRecoveryCodes(h.db, userId)).toBe(10);
    // A code from the old printout is dead.
    expect(
      await consumeRecoveryCode(h.db, userId, first.recoveryCodes[0] as string, at(600), null),
    ).toMatchObject({ ok: false, refusal: 'mismatch' });
    // A code from the new one works.
    expect(
      (await consumeRecoveryCode(h.db, userId, second.recoveryCodes[0] as string, at(600), null))
        .ok,
    ).toBe(true);
  });

  it('AUTH-346 a recovery code is routed to recovery, never to the TOTP field', async () => {
    const enrolled = await enrolTotp(h.db, env(), { userId, accountName: OWNER_EMAIL, now: NOW });
    const outcome = await verifyTotpForUser(h.db, env(), {
      userId,
      code: enrolled.recoveryCodes[0] as string,
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: true, method: 'recovery' });
  });
});

describe('owner bootstrap', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  async function verifiedOwner(): Promise<void> {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    await redeemSignInToken(h.db, { token: issued.token, now: NOW });
  }

  it('AUTH-360 promotes the verified subject exactly once', async () => {
    await verifiedOwner();
    expect(await platformOwnerExists(h.db)).toBe(false);
    const id = await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    expect(id).toMatch(/^usr_/);
    expect(await platformOwnerExists(h.db)).toBe(true);
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(1);
  });

  it('AUTH-361 the path closes behind itself: a second owner can never be minted', async () => {
    await verifiedOwner();
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);

    // A leaked deployment secret, used again with a different verified address.
    const other = await issueSignInToken(h.db, { email: 'attacker@example.com', now: at(60) });
    await redeemSignInToken(h.db, { token: other.token, now: at(60) });
    await expect(promoteToPlatformOwner(h.db, 'attacker@example.com')).rejects.toMatchObject({
      code: 'BOOTSTRAP_CLOSED',
    });
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(1);
    // …and not even the original address can be promoted a second time.
    await expect(promoteToPlatformOwner(h.db, OWNER_EMAIL)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CLOSED',
    });
  });

  it('AUTH-362 two concurrent bootstraps mint exactly one owner', async () => {
    await verifiedOwner();
    const other = await issueSignInToken(h.db, { email: 'second@example.com', now: NOW });
    await redeemSignInToken(h.db, { token: other.token, now: NOW });

    const outcomes = await Promise.allSettled([
      promoteToPlatformOwner(h.db, OWNER_EMAIL),
      promoteToPlatformOwner(h.db, 'second@example.com'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(1);
  });

  it('AUTH-363 an address nobody has verified cannot be promoted', async () => {
    // No user row exists for this address, because no link was ever redeemed for it.
    await expect(promoteToPlatformOwner(h.db, OWNER_EMAIL)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CLOSED',
    });
    expect(await platformOwnerExists(h.db)).toBe(false);
  });

  it('AUTH-364 a disabled account cannot be promoted', async () => {
    await verifiedOwner();
    const user = await users.findByAuthSubject(h.db, OWNER_EMAIL);
    await users.disable(h.db, user?.id ?? '', NOW.toISOString());
    await expect(promoteToPlatformOwner(h.db, OWNER_EMAIL)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CLOSED',
    });
  });
});

describe('the scoped automation identity', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-380 is provisioned as automation, with a bounded life', async () => {
    const identity = await provisionAutomationIdentity(h.db, {
      authSubject: 'automation@itisyou.test',
      now: NOW,
    });
    const row = h.raw
      .prepare('SELECT is_automation, expires_at FROM sessions WHERE id = ?')
      .get(identity.sessionId) as { is_automation: number; expires_at: string };
    expect(row.is_automation).toBe(1);
    const lifetime = (Date.parse(row.expires_at) - NOW.getTime()) / 1000;
    expect(lifetime).toBe(AUTOMATION_MAX_LIFETIME_SECONDS);
  });

  it('AUTH-381 caps a longer lifetime rather than trusting the caller', async () => {
    const identity = await provisionAutomationIdentity(h.db, {
      authSubject: 'automation@itisyou.test',
      now: NOW,
      lifetimeSeconds: 365 * 24 * 60 * 60,
    });
    const lifetime = (Date.parse(identity.expiresAt) - NOW.getTime()) / 1000;
    expect(lifetime).toBe(AUTOMATION_MAX_LIFETIME_SECONDS);
  });

  it('AUTH-382 is never a platform owner, and expires', async () => {
    const identity = await provisionAutomationIdentity(h.db, {
      authSubject: 'automation@itisyou.test',
      now: NOW,
    });
    const user = await users.findById(h.db, identity.userId);
    expect(user?.is_platform_owner).toBe(0);
    expect(await sessions.findLive(h.db, identity.sessionId, NOW.toISOString())).not.toBeNull();
    const afterExpiry = new Date(Date.parse(identity.expiresAt) + 1000).toISOString();
    expect(await sessions.findLive(h.db, identity.sessionId, afterExpiry)).toBeNull();
  });

  it('AUTH-383 cannot activate ads, issue a refund, move budget or become owner', async () => {
    const identity = await provisionAutomationIdentity(h.db, {
      authSubject: 'automation@itisyou.test',
      now: NOW,
    });
    const capabilities = capabilitiesFor({
      kind: 'automation',
      userId: identity.userId,
      email: 'automation@itisyou.test',
      isPlatformOwner: false,
      isAutomation: true,
      mfaVerifiedAt: NOW.toISOString(),
      sessionCreatedAt: NOW.toISOString(),
      sessionExpiresAt: identity.expiresAt,
      csrfToken: 'x',
    });
    for (const denied of AUTOMATION_DENIED) {
      expect(capabilities.has(denied), denied).toBe(false);
    }
    expect(capabilities).toEqual(AUTOMATION_CAPABILITIES);
  });

  it('AUTH-384 the denial survives even if the user row were somehow marked owner', async () => {
    const identity = await provisionAutomationIdentity(h.db, {
      authSubject: 'automation@itisyou.test',
      now: NOW,
    });
    // The structural property: `capabilitiesFor` tests isAutomation BEFORE
    // isPlatformOwner, so there is no flag an attacker could flip to widen this set.
    const capabilities = capabilitiesFor({
      kind: 'automation',
      userId: identity.userId,
      email: 'automation@itisyou.test',
      isPlatformOwner: true,
      isAutomation: true,
      mfaVerifiedAt: NOW.toISOString(),
      sessionCreatedAt: NOW.toISOString(),
      sessionExpiresAt: identity.expiresAt,
      csrfToken: 'x',
    });
    for (const denied of AUTOMATION_DENIED) {
      expect(capabilities.has(denied), denied).toBe(false);
    }
  });
});
