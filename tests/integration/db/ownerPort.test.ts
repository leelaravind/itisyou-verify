/**
 * `OwnerDataPort` and `OwnerAuthPort` against D1.
 *
 * The acceptance properties the lead named, proved against the real implementation rather
 * than against A07's in-memory reference.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { hashToken, randomBytes, toBase64 } from '@verify/security';
import { D1OwnerAuth, D1OwnerDataPort, users } from '@app/db';
import { ANONYMOUS_PRINCIPAL, authorise } from '@app/owner/access';
import {
  issueSignInToken,
  promoteToPlatformOwner,
  provisionAutomationIdentity,
  redeemSignInToken,
} from '@app/lib/auth';
import type { Env } from '@app/lib/context';
import { countRows, createTestDb, seedWorkspace, T0, type TestDb } from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');
const OWNER_EMAIL = 'kpleelaaravind@gmail.com';
// secret-scan:allow ephemeral per-run key; wraps nothing in the repository
const KEY = toBase64(randomBytes(32));
// secret-scan:allow synthetic deployment token for this test only
const BOOTSTRAP_TOKEN = ['bootstrap', 'token', 'for', 'tests'].join('-');

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: 'staging',
    PUBLIC_BASE_URL: 'https://verify-itisyou-staging.kpleelaaravind.workers.dev',
    STRIPE_MODE: 'test',
    CREDENTIAL_KEY_V1: KEY,
    ...overrides,
  };
}

function request(cookie?: string) {
  return {
    headers: new Headers(cookie === undefined ? {} : { cookie }),
    url: 'https://verify-itisyou-staging.kpleelaaravind.workers.dev/owner',
  };
}

/** Sign a user in and return the cookie header a browser would send back. */
async function signedInCookie(h: TestDb, email: string): Promise<string> {
  const issued = await issueSignInToken(h.db, { email, now: NOW });
  const result = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
  if (!result.ok) throw new Error('sign-in failed in fixture');
  // https origin, so the production cookie name.
  return `__Host-verify_session=${result.session.sessionValue}`;
}

describe('owner principal resolution', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-400 an anonymous request is anonymous, and access.ts turns that into a 404', async () => {
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(), now: NOW });
    const principal = await port.principal();
    expect(principal).toEqual(ANONYMOUS_PRINCIPAL);
    const decision = authorise(principal, 'owner.view', NOW);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(404);
    expect(decision.refusal).toBe('not_found');
  });

  it('AUTH-401 a signed-in customer is still a 404 in the owner panel', async () => {
    const cookie = await signedInCookie(h, 'customer@example.com');
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const principal = await port.principal();
    expect(principal.kind).toBe('customer');
    expect(principal.isPlatformOwner).toBe(false);
    const decision = authorise(principal, 'owner.view', NOW);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(404);
  });

  it('AUTH-402 the platform owner resolves as owner, from the user row and nothing else', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const principal = await port.principal();
    expect(principal.kind).toBe('owner');
    expect(principal.isPlatformOwner).toBe(true);
    expect(principal.isAutomation).toBe(false);
    expect(principal.email).toBe(OWNER_EMAIL);
    expect(principal.csrfToken.length).toBeGreaterThanOrEqual(32);
    expect(authorise(principal, 'owner.view', NOW).ok).toBe(true);
  });

  it('AUTH-403 a revoked session drops straight back to anonymous', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    h.raw.prepare('UPDATE sessions SET revoked_at = ?').run(NOW.toISOString());
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    expect((await port.principal()).kind).toBe('anonymous');
  });

  it('AUTH-404 an automation session resolves as automation, not as owner', async () => {
    const identity = await provisionAutomationIdentity(h.db, {
      authSubject: 'automation@itisyou.test',
      now: NOW,
    });
    // Even if somebody marked the row a platform owner, the session decides the kind.
    h.raw.prepare('UPDATE users SET is_platform_owner = 1 WHERE id = ?').run(identity.userId);
    const port = new D1OwnerDataPort({
      db: h.db,
      env: env(),
      request: request(`__Host-verify_session=${identity.sessionValue}`),
      now: NOW,
    });
    const principal = await port.principal();
    expect(principal.kind).toBe('automation');
    expect(principal.isAutomation).toBe(true);
  });
});

describe('owner data reads', () => {
  let h: TestDb;
  let port: D1OwnerDataPort;

  beforeEach(async () => {
    h = createTestDb();
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
  });
  afterEach(() => {
    h.close();
  });

  it('OWNER-300 the overview reports unknown rather than zero for what it cannot measure', async () => {
    const view = await port.overview(NOW);
    // Costs have never been billed to us in a readable form. Unknown, not £0.00 — an
    // owner who reads zero costs believes the business is more profitable than it is.
    expect(view.finance.variableCostsMinor).toBeNull();
    expect(view.finance.outstandingCommitmentsMinor).toBeNull();
    // Health has no probe wired, and says so rather than claiming ok.
    expect(view.health.every((h2) => h2.state === 'unknown')).toBe(true);
    expect(view.assembledAt).toBe(NOW.toISOString());
  });

  it('OWNER-301 the four launch numbers are kept apart', async () => {
    h.raw
      .prepare(
        `INSERT INTO visit_sessions (id, first_seen_at, last_seen_at, landing_path, classification, expires_at, utm_campaign)
         VALUES (?, ?, ?, '/', 'external', ?, ?)`,
      )
      .run('vs_1', T0, T0, '2026-10-19T10:00:00.000Z', 'launch');
    h.raw
      .prepare(
        `INSERT INTO visit_sessions (id, first_seen_at, last_seen_at, landing_path, classification, expires_at)
         VALUES (?, ?, ?, '/', 'external', ?)`,
      )
      .run('vs_2', T0, T0, '2026-10-19T10:00:00.000Z');
    h.raw
      .prepare(
        `INSERT INTO visit_sessions (id, first_seen_at, last_seen_at, landing_path, classification, expires_at)
         VALUES (?, ?, ?, '/', 'bot_suspected', ?)`,
      )
      .run('vs_bot', T0, T0, '2026-10-19T10:00:00.000Z');

    const view = await port.overview(NOW);
    // The bot is excluded; the attributed visit is a subset of the total, not a second one.
    expect(view.launch.totalVisits.value).toBe(2);
    expect(view.launch.adAttributedVisits.value).toBe(1);
    // A visit is not a signup, and a signup is not income.
    expect(view.launch.qualifiedSignups.value).toBe(0);
    expect(view.launch.payingCustomers.value).toBe(0);
  });

  it('OWNER-302 customers are listed across tenants with a freshly generated contact mask', async () => {
    const a = seedWorkspace(h, 'alpha');
    seedWorkspace(h, 'beta');
    const rows = await port.customers();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const alpha = rows.find((r) => r.workspaceId === a.workspaceId);
    expect(alpha?.contactMask).toBe('a**@example.com');
    // The full address is never in the payload.
    expect(JSON.stringify(rows)).not.toContain('alpha@example.com');
    expect(alpha?.eligible).toBe(false);
    expect(alpha?.ineligibleReason).toContain('connections are ready');
  });

  it('OWNER-303 every money-moving action refuses honestly instead of faking a success', async () => {
    const ws = seedWorkspace(h, 'alpha');
    const ctx = {
      principal: await port.principal(),
      capability: 'refund.issue' as const,
      now: NOW,
      requestId: 'req_1',
    };
    const cancelled = await port.cancelSubscription(ctx, ws.workspaceId);
    expect(cancelled.ok).toBe(false);
    expect(cancelled.message).toContain('has no subscription');

    const refunded = await port.issueRefund(ctx, {
      workspaceId: ws.workspaceId,
      orderId: 'ord_1',
      amountMinor: 2900,
      policyRule: 'goodwill',
      reason: 'test',
      approvalId: 'apr_missing',
    });
    expect(refunded.ok).toBe(false);
    expect(refunded.message).toContain('approval is not usable');

    const campaign = await port.activateCampaign(ctx, 'cmp_1', 'apr_1');
    expect(campaign.ok).toBe(false);
    expect(campaign.dependency).toContain('No advertising provider');
  });

  it('OWNER-304 an approval is granted, listed, revoked, and audited', async () => {
    const ctx = {
      principal: await port.principal(),
      capability: 'approval.grant' as const,
      now: NOW,
      requestId: 'req_1',
    };
    const granted = await port.grantApproval(ctx, {
      actionType: 'refund_issue',
      payloadJson: '{"marker":"payload-body-never-stored","amount_minor":2900}',
      maximumAmountMinor: 2900,
      summary: 'Refund the September charge for workspace alpha.',
    });
    expect(granted.ok).toBe(true);

    const list = await port.approvals();
    expect(list).toHaveLength(1);
    expect(list[0]?.summary).toContain('Refund the September charge');
    // The payload hash is stored, never the payload.
    expect(list[0]?.canonical_payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(list)).not.toContain('payload-body-never-stored');

    const revoked = await port.revokeApproval(ctx, list[0]?.id ?? '');
    expect(revoked.ok).toBe(true);
    expect((await port.approvals())[0]?.status).toBe('revoked');
    expect(await port.revokeApproval(ctx, list[0]?.id ?? '')).toMatchObject({ ok: false });

    const audit = await port.auditTrail(20);
    expect(audit.map((a) => a.action)).toContain('owner.approval.granted');
    expect(audit.map((a) => a.action)).toContain('owner.approval.revoked');
  });

  it('OWNER-305 controls round-trip through settings and are audited', async () => {
    const ctx = {
      principal: await port.principal(),
      capability: 'controls.toggle' as const,
      now: NOW,
      requestId: 'req_1',
    };
    expect((await port.controls()).ads.paused).toBe(false);
    const paused = await port.setControl(ctx, 'ads', true, 'Spend looked wrong.');
    expect(paused.ok).toBe(true);
    const controls = await port.controls();
    expect(controls.ads.paused).toBe(true);
    expect(controls.ads.note).toBe('Spend looked wrong.');
    expect(await port.setControl(ctx, 'not_a_control', true, null)).toMatchObject({ ok: false });
  });

  it('OWNER-306 notification health is answered from real rows, not a stand-in', async () => {
    h.raw
      .prepare(
        `INSERT INTO notification_deliveries (id, workspace_id, notification_key, channel, recipient_hash, template, state, attempt_count, created_at)
         VALUES (?, NULL, ?, 'email', 'hash', 'run_failed', 'pending', 1, ?)`,
      )
      .run('ntf_stuck', 'k1', new Date(NOW.getTime() - 60 * 60 * 1000).toISOString());
    h.raw
      .prepare(
        `INSERT INTO notification_deliveries (id, workspace_id, notification_key, channel, recipient_hash, template, state, attempt_count, created_at)
         VALUES (?, NULL, ?, 'email', 'hash', 'run_failed', 'pending', 0, ?)`,
      )
      .run('ntf_fresh', 'k2', NOW.toISOString());

    const ops = await port.operations(NOW);
    // An empty list here would mean "nothing wrong"; it must only ever mean that.
    expect(ops.notifications.unavailableReason).toBeNull();
    expect(ops.notifications.stuck.map((s) => s.id)).toEqual(['ntf_stuck']);
    expect(ops.notifications.stuck[0]?.ageSeconds).toBe(3600);
    expect(ops.notifications.inFlight).toBe(1);
    expect(ops.runner.connected).toBe(false);
    expect(ops.runner.unavailableReason).not.toBeNull();
  });

  it('OWNER-307 revoking a connection is genuinely done, not blocked', async () => {
    const ws = seedWorkspace(h, 'alpha');
    h.raw
      .prepare(
        `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at, external_account_id)
         VALUES ('conn_a', ?, 'hubspot', 'ready', '["crm.read"]', ?, 'hub-12345678')`,
      )
      .run(ws.workspaceId, T0);
    h.raw
      .prepare(
        `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
         VALUES ('cred_a', 'conn_a', 'connection:conn_a', 1, 'Y2lwaGVy', 'bm9uY2U=', 'v1|kv=1|ws=x', ?)`,
      )
      .run(T0);

    const listed = await port.connections();
    expect(listed[0]?.maskHint).toBe('********5678');
    expect(JSON.stringify(listed)).not.toContain('hub-12345678');
    expect(listed[0]?.scopes).toEqual(['crm.read']);

    const ctx = {
      principal: await port.principal(),
      capability: 'connection.revoke' as const,
      now: NOW,
      requestId: 'req_1',
    };
    const revoked = await port.revokeConnection(ctx, 'conn_a');
    expect(revoked.ok).toBe(true);
    expect(countRows(h, 'credential_versions', 'retired_at IS NOT NULL')).toBe(1);
    // Rotation, which needs the provider, still refuses honestly.
    expect(await port.rotateConnection(ctx, 'conn_a')).toMatchObject({ ok: false });
  });
});

describe('owner auth port', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-420 a sign-in request answers identically whether or not the account exists', async () => {
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    await expect(auth.requestSignInLink(OWNER_EMAIL)).resolves.toBeUndefined();
    await expect(auth.requestSignInLink('nobody@example.com')).resolves.toBeUndefined();
    // Both minted a token; neither told the caller anything.
    expect(countRows(h, 'login_tokens')).toBe(2);
  });

  it('AUTH-421 repeated sign-in requests are rate limited, still without telling the caller', async () => {
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    for (let i = 0; i < 8; i += 1) await auth.requestSignInLink(OWNER_EMAIL);
    // Five allowed in the window; the rest are dropped silently.
    expect(countRows(h, 'login_tokens')).toBe(5);
  });

  it('AUTH-422 the staging completion link works in staging and is impossible in production', async () => {
    const staging = new D1OwnerAuth({ db: h.db, env: env({ ENVIRONMENT: 'staging' }) });
    const url = await staging.issueStagingSignInLink(OWNER_EMAIL, NOW);
    expect(url).toContain('/admin/login/complete?token=');
    expect(countRows(h, 'login_tokens')).toBe(1);

    const production = new D1OwnerAuth({ db: h.db, env: env({ ENVIRONMENT: 'production' }) });
    await expect(production.issueStagingSignInLink(OWNER_EMAIL, NOW)).rejects.toBeInstanceOf(AppError);
    // The guard runs before a token is minted, so there is nothing to leak.
    expect(countRows(h, 'login_tokens')).toBe(1);
  });

  it('AUTH-423 the staging link actually completes a sign-in', async () => {
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    const url = await auth.issueStagingSignInLink(OWNER_EMAIL, NOW);
    const token = new URL(url).searchParams.get('token') ?? '';
    const result = await redeemSignInToken(h.db, { token, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.authSubject).toBe(OWNER_EMAIL);
    // And it is single-use, like every other link.
    expect(await redeemSignInToken(h.db, { token, now: NOW })).toMatchObject({ ok: false });
  });

  it('AUTH-424 bootstrap refuses without a configured token, and never touches the database', async () => {
    const auth = new D1OwnerAuth({ db: h.db, env: env({ OWNER_BOOTSTRAP_TOKEN: undefined }) });
    const result = await auth.bootstrap(
      { presentedToken: 'anything', verifiedAuthSubject: OWNER_EMAIL },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, refusal: 'not_configured' });
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(0);
  });

  it('AUTH-425 bootstrap refuses a token that is not the deployment token', async () => {
    const auth = new D1OwnerAuth({
      db: h.db,
      env: env({ OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN, OWNER_BOOTSTRAP_EMAIL: OWNER_EMAIL }),
    });
    const result = await auth.bootstrap(
      { presentedToken: 'not-the-token', verifiedAuthSubject: OWNER_EMAIL },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, refusal: 'token_mismatch' });
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(0);
  });

  it('AUTH-426 a bootstrap token is not an identity', async () => {
    const auth = new D1OwnerAuth({
      db: h.db,
      env: env({ OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN, OWNER_BOOTSTRAP_EMAIL: OWNER_EMAIL }),
    });
    expect(
      await auth.bootstrap({ presentedToken: BOOTSTRAP_TOKEN, verifiedAuthSubject: null }, NOW),
    ).toMatchObject({ ok: false, refusal: 'unverified_subject' });
    expect(
      await auth.bootstrap(
        { presentedToken: BOOTSTRAP_TOKEN, verifiedAuthSubject: 'someone@else.example' },
        NOW,
      ),
    ).toMatchObject({ ok: false, refusal: 'subject_mismatch' });
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(0);
  });

  it('AUTH-427 the whole bootstrap works once and closes permanently', async () => {
    const auth = new D1OwnerAuth({
      db: h.db,
      env: env({ OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN, OWNER_BOOTSTRAP_EMAIL: OWNER_EMAIL }),
    });
    // The address must already have been proved by redeeming a link.
    await signedInCookie(h, OWNER_EMAIL);

    const first = await auth.bootstrap(
      { presentedToken: BOOTSTRAP_TOKEN, verifiedAuthSubject: OWNER_EMAIL },
      NOW,
    );
    expect(first.ok).toBe(true);
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(1);

    // The deployment secret is still present, and is now permanently useless.
    const second = await auth.bootstrap(
      { presentedToken: BOOTSTRAP_TOKEN, verifiedAuthSubject: OWNER_EMAIL },
      NOW,
    );
    expect(second).toMatchObject({ ok: false, refusal: 'already_bootstrapped' });
    expect(countRows(h, 'users', 'is_platform_owner = 1')).toBe(1);
  });

  it('AUTH-428 every bootstrap outcome, including each refusal, is audited', async () => {
    const auth = new D1OwnerAuth({
      db: h.db,
      env: env({ OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN, OWNER_BOOTSTRAP_EMAIL: OWNER_EMAIL }),
    });
    await auth.bootstrap({ presentedToken: 'wrong', verifiedAuthSubject: OWNER_EMAIL }, NOW);
    await auth.bootstrap({ presentedToken: BOOTSTRAP_TOKEN, verifiedAuthSubject: null }, NOW);
    const rows = h.raw
      .prepare("SELECT target FROM audit_events WHERE action = 'owner.bootstrap' ORDER BY rowid")
      .all() as { target: string }[];
    expect(rows.map((r) => r.target)).toEqual(['token_mismatch', 'unverified_subject']);
    // The presented token is never written anywhere.
    const dump = JSON.stringify(h.raw.prepare('SELECT * FROM audit_events').all());
    expect(dump).not.toContain(BOOTSTRAP_TOKEN);
  });

  it('AUTH-429 signing out revokes every session for that user', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    const principal = await port.principal();
    await auth.signOut(principal);
    expect(countRows(h, 'sessions', 'revoked_at IS NULL')).toBe(0);
  });

  it('AUTH-430 verifyTotp reports the dependency rather than pretending a wrong code', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    const result = await auth.verifyTotp(await port.principal(), '123456', NOW);
    expect(result.ok).toBe(false);
    expect(result.dependency).toContain('no authenticator enrolled');
  });

  it('AUTH-431 accessMode is read from settings and defaults safely', async () => {
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    expect(await auth.accessMode()).toBe('PUBLIC_LOGIN');
    h.raw
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('owner.access_mode', JSON.stringify({ mode: 'RESTRICTED_ENTRY' }), NOW.toISOString());
    expect(await auth.accessMode()).toBe('RESTRICTED_ENTRY');
  });

  it('AUTH-432 a session cookie value never appears in any row', async () => {
    const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
    const result = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dump = JSON.stringify([
      h.raw.prepare('SELECT * FROM sessions').all(),
      h.raw.prepare('SELECT * FROM login_tokens').all(),
      h.raw.prepare('SELECT * FROM audit_events').all(),
    ]);
    expect(dump).not.toContain(result.session.sessionValue);
    expect(dump).not.toContain(issued.token);
    // What IS stored is the hash, and it matches.
    expect(dump).toContain(await hashToken(result.session.sessionValue, 'session'));
  });
});
