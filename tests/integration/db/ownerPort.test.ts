/**
 * `OwnerDataPort` and `OwnerAuthPort` against D1.
 *
 * The acceptance properties the lead named, proved against the real implementation rather
 * than against A07's in-memory reference.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { generateTotpCode, hashToken, randomBytes, toBase64 } from '@verify/security';
import { D1OwnerAuth, D1OwnerDataPort } from '@app/db';
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

  it('OWNER-600 the overview reports unknown rather than zero for what it cannot measure', async () => {
    const view = await port.overview(NOW);
    // Costs have never been billed to us in a readable form. Unknown, not £0.00 — an
    // owner who reads zero costs believes the business is more profitable than it is.
    expect(view.finance.variableCostsMinor).toBeNull();
    expect(view.finance.outstandingCommitmentsMinor).toBeNull();
    // Health has no probe wired, and says so rather than claiming ok — for everything
    // except the money path, which is not a probe at all. `moneyPathReadiness` reads what
    // the running Worker is *able* to do from its own configuration, so it is knowable
    // without asking anything, and reporting it as "unknown" would be its own false
    // modesty. The property this case is really about is that nothing defaults optimistic,
    // and that holds for it too: with no secrets present it must not read `ok`.
    const money = view.health.filter((h2) => h2.component === 'money_path');
    expect(money).toHaveLength(1);
    expect(money[0]?.state).not.toBe('ok');
    expect(money[0]?.detail).toMatch(/EVENT_SIGNING_ROOT_KEY/);
    expect(
      view.health
        .filter((h2) => h2.component !== 'money_path')
        .every((h2) => h2.state === 'unknown'),
    ).toBe(true);
    expect(view.assembledAt).toBe(NOW.toISOString());
  });

  it('OWNER-601 the four launch numbers are kept apart', async () => {
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

  it('OWNER-602 customers are listed across tenants with a freshly generated contact mask', async () => {
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

  it('OWNER-603 every money-moving action refuses honestly instead of faking a success', async () => {
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

    // Campaigns are now backed by a real table, so an id nobody issued is refused by
    // name rather than by dependency. Either way it never reports a success it did not
    // achieve, which is what this case is for.
    const campaign = await port.activateCampaign(ctx, 'cmp_1', 'apr_1');
    expect(campaign.ok).toBe(false);
    expect(campaign.message ?? campaign.dependency).not.toBeNull();
  });

  it('OWNER-604 an approval is granted, listed, revoked, and audited', async () => {
    const ctx = {
      principal: await port.principal(),
      capability: 'approval.grant' as const,
      now: NOW,
      requestId: 'req_1',
    };
    const granted = await port.grantApproval(ctx, {
      actionType: 'refund_issue',
      // Carries a published `policy_rule` because a refund approval now binds one and the
      // grant path validates it. The marker is what this case is actually about: the
      // payload body is hashed and never stored.
      payloadJson:
        '{"marker":"payload-body-never-stored","amount_minor":2900,"policy_rule":"goodwill_owner_discretion"}',
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

  it('OWNER-605 controls round-trip through settings and are audited', async () => {
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

  it('OWNER-606 notification health is answered from real rows, not a stand-in', async () => {
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

  it('OWNER-926 an unanswered support message reaches the exception queue, not only an escalated one', async () => {
    /*
     * Nothing pushes a support case anywhere. The six owner alert kinds are deliberately six
     * and none of them is support, so this queue is the only place an unanswered message
     * becomes visible to the owner. It listed escalated cases only, which meant an ordinary
     * open case sat in the database unseen.
     */
    const ws = await seedWorkspace(h);
    for (const [id, state, subject] of [
      ['case_open', 'open', 'A customer asked why a run is unverified'],
      ['case_esc', 'escalated', 'A customer says they were charged twice'],
      ['case_closed', 'closed', 'Answered last week'],
    ] as const) {
      h.raw
        .prepare(
          `INSERT INTO support_cases
             (id, workspace_id, contact_email, subject, body_redacted, category, priority, state, created_at, updated_at)
           VALUES (?, ?, 'a@example.test', ?, 'redacted', 'other', 'normal', ?, ?, ?)`,
        )
        .run(id, ws.workspaceId, subject, state, T0, T0);
    }

    const queue = await port.exceptions();
    const support = queue.filter((row) => row.kind.startsWith('support_'));
    expect(support.map((row) => row.id).sort()).toEqual(['case_esc', 'case_open']);

    // Escalated first: it is the one that is already past patience.
    expect(support[0]?.kind).toBe('support_escalated');
    const open = support.find((row) => row.id === 'case_open');
    expect(open?.kind).toBe('support_open');
    expect(open?.summary).toContain('why a run is unverified');
    // The suggested action says the true thing about how this case became visible.
    expect(open?.suggestedAction ?? '').toContain('Nobody is alerted');
    // A closed case is not an exception.
    expect(queue.some((row) => row.id === 'case_closed')).toBe(false);
  });

  it('OWNER-607 revoking a connection is genuinely done, not blocked', async () => {
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
    // The assertion is EQUALITY, not a particular value. This used to assert `undefined`,
    // which passed for a method that returned nothing whatever it did -- and that method
    // was minting tokens it never emailed while the page said a link was on its way. What
    // must never vary is the answer for a known address versus an unknown one; what may
    // vary is whether this deployment can send at all.
    const known = await auth.requestSignInLink(OWNER_EMAIL);
    const unknown = await auth.requestSignInLink('nobody@example.com');
    expect(known).toEqual(unknown);
    // Both minted a token; neither told the caller which was which.
    expect(countRows(h, 'login_tokens')).toBe(2);
  });

  it('AUTH-434 a deployment that CAN send but fails says so, rather than blaming configuration', async () => {
    // A transport is configured and the send fails. The first version of this outcome had
    // only `sent | no_transport`, so this rendered "no email delivery configured" on
    // production, which has both secrets -- a false configuration statement added while
    // removing five others.
    // The transport is stubbed to REFUSE, so `send_failed` here is caused by the transport.
    // Before 20 September this case passed for a different reason: the request shape was
    // wrong, `.trim()` threw on an undefined recipient, and the throw was swallowed as
    // `failed` before any row was written. The row assertion below is what tells the two
    // apart, and it is the assertion this case lacked.
    const auth = new D1OwnerAuth({
      db: h.db,
      env: env({
        // secret-scan:allow synthetic; never sent anywhere
        RESEND_API_KEY: 're_0000000000000000000000',
        RESEND_FROM_ADDRESS: 'verify@example.invalid',
      }),
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });
    expect(await auth.requestSignInLink(OWNER_EMAIL)).toEqual({ delivery: 'send_failed' });
    // The token is still minted, so a retry does not silently lose the attempt.
    expect(countRows(h, 'login_tokens')).toBe(1);
    // And the attempt is a recorded fact, not a silent throw.
    expect(countRows(h, 'notification_deliveries')).toBe(1);
  });

  it('AUTH-436 a deployment that can send does send, and the message carries the admin link', async () => {
    const calls: string[] = [];
    const auth = new D1OwnerAuth({
      db: h.db,
      env: env({
        // secret-scan:allow synthetic; the stub never lets it leave the process
        RESEND_API_KEY: 're_0000000000000000000000',
        RESEND_FROM_ADDRESS: 'verify@example.invalid',
      }),
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ id: 'stub_msg_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    expect(await auth.requestSignInLink(OWNER_EMAIL)).toEqual({ delivery: 'sent' });
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('/admin/login/complete?token=');
    expect(countRows(h, 'notification_deliveries')).toBe(1);
  });

  it('AUTH-433 a deployment with no mail transport says nothing was sent, rather than claiming one was', async () => {
    // `env()` here configures no RESEND_API_KEY or RESEND_FROM_ADDRESS.
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    expect(await auth.requestSignInLink(OWNER_EMAIL)).toEqual({ delivery: 'no_transport' });
    // The token is still minted and still expires. It simply was not delivered, and the
    // difference between "not delivered" and "delivered" is now reportable.
    expect(countRows(h, 'login_tokens')).toBe(1);
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
    await expect(production.issueStagingSignInLink(OWNER_EMAIL, NOW)).rejects.toBeInstanceOf(
      AppError,
    );
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
    // No OWNER_BOOTSTRAP_TOKEN on this deployment at all.
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
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

  /**
   * AUTH-437..AUTH-439 — the supported way a workspace comes to exist on production.
   *
   * On 20 September 2026 production had zero workspaces. Signup is closed, the automation
   * seed refuses production by design, and the owner's own sign-in created a user with no
   * membership, so `/app` showed the sign-in page again. These cases prove the owner-panel
   * action writes exactly the rows `resolveSession` needs, attaches to a user who signed in
   * first rather than duplicating them, and is refused to the automation identity.
   */
  function ownerCtx(principal: Awaited<ReturnType<D1OwnerDataPort['principal']>>) {
    return {
      principal: { ...principal, mfaVerifiedAt: NOW.toISOString() },
      capability: 'workspace.create' as const,
      now: NOW,
      requestId: 'req_ws_create',
    };
  }

  it('AUTH-437 creating a workspace writes the workspace, the admin membership and an audit row, and nothing else', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const before = { users: countRows(h, 'users'), workspaces: countRows(h, 'workspaces') };

    const result = await port.createCustomerWorkspace(ownerCtx(await port.principal()), {
      email: 'Customer+verify-test@Example.com',
      name: 'Customer test workspace',
      synthetic: true,
    });

    expect(result.ok, result.message ?? '').toBe(true);
    expect(result.redirectTo).toBe('/owner/customers');
    expect(countRows(h, 'users')).toBe(before.users + 1);
    expect(countRows(h, 'workspaces')).toBe(before.workspaces + 1);
    const ws = h.raw
      .prepare(
        "SELECT id, name, status, is_synthetic FROM workspaces WHERE name = 'Customer test workspace'",
      )
      .get() as { id: string; name: string; status: string; is_synthetic: number };
    expect(ws.status).toBe('active');
    expect(ws.is_synthetic).toBe(1);
    const member = h.raw
      .prepare(
        `SELECT m.role, u.auth_subject FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?`,
      )
      .get(ws.id) as { role: string; auth_subject: string };
    expect(member.role).toBe('workspace_admin');
    // Normalised exactly as redeemSignInToken normalises, so the sign-in that follows lands on this user.
    expect(member.auth_subject).toBe('customer+verify-test@example.com');
    expect(
      countRows(h, 'audit_events', "action = 'owner.workspace.created' AND target = ?", ws.id),
    ).toBe(1);
    // The message never carries the full address.
    expect(result.message).not.toContain('customer+verify-test@example.com');
  });

  it('AUTH-438 an admin who signed in before any workspace existed gets the membership on their existing user', async () => {
    // The production state on 20 September: the owner redeemed a sign-in link, a user row
    // existed, no membership did, and /app said "no workspace".
    const firstSignIn = await redeemSignInToken(h.db, {
      token: (await issueSignInToken(h.db, { email: 'early@example.com', now: NOW })).token,
      now: NOW,
    });
    expect(firstSignIn.ok).toBe(true);

    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    // Counted after the owner's own sign-in, so the only change measured is the one this action makes.
    const usersBefore = countRows(h, 'users');
    const result = await port.createCustomerWorkspace(ownerCtx(await port.principal()), {
      email: 'EARLY@example.com',
      name: 'Early workspace',
      synthetic: false,
    });
    expect(result.ok, result.message ?? '').toBe(true);
    // No second user for the same address.
    expect(countRows(h, 'users')).toBe(usersBefore);
    const memberships = h.raw
      .prepare(
        `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.auth_subject = 'early@example.com'`,
      )
      .all() as { workspace_id: string }[];
    expect(memberships).toHaveLength(1);
    // And the workspace is a real one, listed without the synthetic badge.
    const listed = (await port.customers()).find((row) => row.name === 'Early workspace');
    expect(listed?.isSynthetic).toBe(false);
  });

  it('AUTH-439 the automation identity cannot create a workspace even if a route forgot to authorise', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const owner = await port.principal();
    const before = countRows(h, 'workspaces');
    const result = await port.createCustomerWorkspace(
      {
        ...ownerCtx(owner),
        principal: { ...owner, isAutomation: true, mfaVerifiedAt: NOW.toISOString() },
      },
      { email: 'auto@example.com', name: 'Automation-made', synthetic: true },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('cannot workspace.create');
    expect(countRows(h, 'workspaces')).toBe(before);
    expect(countRows(h, 'audit_events', "action = 'owner.workspace.create_refused'")).toBe(1);
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
    const result = await auth.verifyTotp(await port.principal(), '123456', NOW, null);
    expect(result.ok).toBe(false);
    expect(result.dependency).toContain('no authenticator enrolled');
  });

  /**
   * AUTH-451..AUTH-453 — the two-factor gate can actually be passed.
   *
   * Until 20 September 2026 it could not, on any deployment: `enrolTotp` had no caller, and
   * `D1OwnerAuth.verifyTotp` called `verifyTotpForUser` without a session id, so a correct
   * code was accepted and audited and stamped nothing. `authorise()` then refused every
   * consequential action with "Confirm it is you", forever. AUTH-430 above passed the whole
   * time, because it only asserted the not-enrolled dependency.
   */
  it('AUTH-451 enrol, then a correct code stamps THIS session, and the consequential gate opens', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    const owner = await port.principal();

    expect(await auth.authenticatorEnrolled(owner)).toBe(false);
    expect(authorise(owner, 'workspace.create', NOW).ok).toBe(false);

    const issued = await auth.enrolAuthenticator(owner, NOW);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.secretBase32.length).toBeGreaterThanOrEqual(16);
    expect(issued.provisioningUri.startsWith('otpauth://totp/')).toBe(true);
    expect(issued.recoveryCodes).toHaveLength(10);
    expect(await auth.authenticatorEnrolled(owner)).toBe(true);
    // Neither the seed nor a recovery code is stored in the clear anywhere.
    const dump = JSON.stringify([
      h.raw.prepare('SELECT * FROM users').all(),
      h.raw.prepare('SELECT * FROM credential_versions').all(),
      h.raw.prepare('SELECT * FROM audit_events').all(),
    ]);
    expect(dump).not.toContain(issued.secretBase32);
    for (const code of issued.recoveryCodes) expect(dump).not.toContain(code);

    const later = new Date(NOW.getTime() + 60_000);
    const sessionId = await hashToken(cookie.split('=')[1] ?? '', 'session');
    const code = generateTotpCode(issued.secretBase32, later);
    const verified = await auth.verifyTotp(owner, code, later, sessionId);
    expect(verified.ok, verified.dependency ?? '').toBe(true);

    // The row this session reads is stamped, and the gate that refused now permits.
    const stamped = new D1OwnerDataPort({
      db: h.db,
      env: env(),
      request: request(cookie),
      now: later,
    });
    const principal = await stamped.principal();
    expect(principal.mfaVerifiedAt).toBe(later.toISOString());
    expect(authorise(principal, 'workspace.create', later).ok).toBe(true);
  });

  it('AUTH-452 a correct code with no session id stamps nothing — the exact production defect, kept as a tripwire', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    const owner = await port.principal();
    const issued = await auth.enrolAuthenticator(owner, NOW);
    if (!issued.ok) throw new Error('enrolment failed in fixture');
    const later = new Date(NOW.getTime() + 60_000);
    const verified = await auth.verifyTotp(
      owner,
      generateTotpCode(issued.secretBase32, later),
      later,
      null,
    );
    expect(verified.ok).toBe(true);
    const again = await new D1OwnerDataPort({
      db: h.db,
      env: env(),
      request: request(cookie),
      now: later,
    }).principal();
    expect(again.mfaVerifiedAt).toBeNull();
    expect(authorise(again, 'workspace.create', later).ok).toBe(false);
  });

  it('AUTH-453 a code that is right for a different session does not stamp this one', async () => {
    const cookie = await signedInCookie(h, OWNER_EMAIL);
    await promoteToPlatformOwner(h.db, OWNER_EMAIL);
    const port = new D1OwnerDataPort({ db: h.db, env: env(), request: request(cookie), now: NOW });
    const auth = new D1OwnerAuth({ db: h.db, env: env() });
    const owner = await port.principal();
    const issued = await auth.enrolAuthenticator(owner, NOW);
    if (!issued.ok) throw new Error('enrolment failed in fixture');
    const later = new Date(NOW.getTime() + 60_000);
    const otherSession = await hashToken('not-the-cookie-this-browser-holds', 'session');
    const verified = await auth.verifyTotp(
      owner,
      generateTotpCode(issued.secretBase32, later),
      later,
      otherSession,
    );
    // The code is consumed either way (it was correct), but this browser's row is untouched.
    expect(verified.ok).toBe(true);
    const again = await new D1OwnerDataPort({
      db: h.db,
      env: env(),
      request: request(cookie),
      now: later,
    }).principal();
    expect(again.mfaVerifiedAt).toBeNull();
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
