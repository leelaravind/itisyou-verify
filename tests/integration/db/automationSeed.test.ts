/**
 * The automation seed, and the approval compare-and-set.
 *
 * The seed's whole value is that it unblocks A07's browser suite **without** weakening a
 * guard. So the cases below check the shape A07 depends on, and check that the identity
 * still cannot do the four things it must never do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppError } from '@verify/contracts';
import { hashToken } from '@verify/security';
import {
  automationSeedExports,
  buildAutomationSeed,
  createApprovalClaims,
  seedAutomationIdentity,
  users,
} from '@app/db';
import { CLAIM_APPROVAL_SQL } from '@app/owner/approvals';
import {
  AUTOMATION_CAPABILITIES,
  AUTOMATION_DENIED,
  AUTOMATION_MAX_LIFETIME_SECONDS,
  authorise,
  automationLifetimeExceeded,
  capabilitiesFor,
} from '@app/owner/access';
import { D1CustomerDataPort, D1OwnerDataPort } from '@app/db';
import type { Env } from '@app/lib/context';
import { countRows, createTestDb, type TestDb } from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');
const HTTP_ORIGIN = 'http://127.0.0.1:8788';
const HTTPS_ORIGIN = 'https://verify-itisyou-staging.kpleelaaravind.workers.dev';

function env(baseUrl: string, environment = 'development'): Env {
  return {
    DB: undefined as unknown as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: environment,
    PUBLIC_BASE_URL: baseUrl,
    STRIPE_MODE: 'test',
  };
}

describe('the automation seed', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-440 emits the cookie name that matches the origin, which A07 must not assume', () => {
    const local = buildAutomationSeed({
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });
    const remote = buildAutomationSeed({ environment: 'staging', baseUrl: HTTPS_ORIGIN, now: NOW });

    // A07 assumed `__Host-verify_session`. Over http the browser rejects that cookie
    // outright, so the suite would silently behave as though it were signed out.
    expect(local.sessionCookieName).toBe('verify_session');
    expect(local.csrfCookieName).toBe('verify_csrf');
    expect(local.secure).toBe(false);

    expect(remote.sessionCookieName).toBe('__Host-verify_session');
    expect(remote.csrfCookieName).toBe('__Host-verify_csrf');
    expect(remote.secure).toBe(true);
  });

  it('AUTH-441 refuses production before it mints anything at all', () => {
    expect(() =>
      buildAutomationSeed({ environment: 'production', baseUrl: HTTPS_ORIGIN, now: NOW }),
    ).toThrow(AppError);
    // And the seeding path refuses too, without writing a row.
    return expect(
      seedAutomationIdentity(h.db, {
        environment: 'production',
        baseUrl: HTTPS_ORIGIN,
        now: NOW,
      }),
    )
      .rejects.toBeInstanceOf(AppError)
      .then(() => {
        expect(countRows(h, 'sessions')).toBe(0);
        expect(countRows(h, 'users')).toBe(0);
      });
  });

  it('AUTH-442 creates exactly the session shape A07 depends on', async () => {
    const seed = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });

    const row = h.raw
      .prepare(
        'SELECT is_automation, mfa_verified_at, created_at, expires_at, revoked_at FROM sessions WHERE id = ?',
      )
      .get(seed.sessionId) as {
      is_automation: number;
      mfa_verified_at: string | null;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
    };

    expect(row.is_automation).toBe(1);
    // Stamped at creation, so the first consequential action is not refused for stale MFA.
    expect(row.mfa_verified_at).toBe(NOW.toISOString());
    expect(row.revoked_at).toBeNull();

    const lifetime = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 1000;
    expect(lifetime).toBeLessThanOrEqual(12 * 60 * 60);
    expect(lifetime).toBe(AUTOMATION_MAX_LIFETIME_SECONDS);

    // The stored id is the hash; the cookie value is never in the row.
    expect(seed.sessionId).toBe(await hashToken(seed.sessionCookieValue, 'session'));
    const dump = JSON.stringify(h.raw.prepare('SELECT * FROM sessions').all());
    expect(dump).not.toContain(seed.sessionCookieValue);
  });

  it('AUTH-443 the identity is never a platform owner and holds only three capabilities', async () => {
    const seed = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });
    const user = await users.findById(h.db, seed.userId);
    expect(user?.is_platform_owner).toBe(0);

    const port = new D1OwnerDataPort({
      db: h.db,
      env: env(HTTP_ORIGIN),
      request: {
        headers: new Headers({ cookie: `${seed.sessionCookieName}=${seed.sessionCookieValue}` }),
        url: `${HTTP_ORIGIN}/owner`,
      },
      now: NOW,
    });
    const principal = await port.principal();
    expect(principal.kind).toBe('automation');
    expect(principal.isAutomation).toBe(true);
    expect(principal.isPlatformOwner).toBe(false);

    // It can view the panel…
    expect(authorise(principal, 'owner.view', NOW).ok).toBe(true);
    // …and cannot do any of the four, because they are absent from the set.
    const capabilities = capabilitiesFor(principal);
    expect(capabilities).toEqual(AUTOMATION_CAPABILITIES);
    for (const denied of AUTOMATION_DENIED) {
      expect(capabilities.has(denied), denied).toBe(false);
      const decision = authorise(principal, denied, NOW);
      expect(decision.ok, denied).toBe(false);
    }
  });

  it('AUTH-444 a lifetime A07 would refuse is capped rather than issued', async () => {
    const seed = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
      lifetimeSeconds: 24 * 60 * 60,
    });
    const port = new D1OwnerDataPort({
      db: h.db,
      env: env(HTTP_ORIGIN),
      request: {
        headers: new Headers({ cookie: `${seed.sessionCookieName}=${seed.sessionCookieValue}` }),
        url: `${HTTP_ORIGIN}/owner`,
      },
      now: NOW,
    });
    // A 24-hour convenience session would 404 the whole suite rather than failing loudly.
    expect(automationLifetimeExceeded(await port.principal())).toBe(false);
  });

  it('AUTH-445 seeding twice reuses the user and mints a fresh session', async () => {
    const first = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });
    const second = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.userId).toBe(first.userId);
    expect(second.sessionCookieValue).not.toBe(first.sessionCookieValue);
    expect(countRows(h, 'users')).toBe(1);
    expect(countRows(h, 'sessions')).toBe(2);
  });

  it('AUTH-448 seeds a synthetic workspace the customer pages can actually render', async () => {
    const seed = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });

    // The missing row that made /app answer 401 while /owner answered 200.
    const ws = h.raw
      .prepare('SELECT id, status, is_synthetic FROM workspaces WHERE id = ?')
      .get(seed.workspaceId) as { id: string; status: string; is_synthetic: number };
    expect(ws.status).toBe('active');
    // Synthetic, so every count and owner view that filters it keeps excluding it.
    expect(ws.is_synthetic).toBe(1);

    const membership = h.raw
      .prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?')
      .get(seed.workspaceId, seed.userId) as { role: string };
    // Read-only. A standing credential in an environment variable must not be able to
    // change a customer's configuration.
    expect(membership.role).toBe('workspace_viewer');
    expect(seed.workspaceRole).toBe('workspace_viewer');
  });

  it('AUTH-449 the customer port resolves a workspace for the seeded session', async () => {
    const seed = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });
    const port = new D1CustomerDataPort({
      db: h.db,
      env: env(HTTP_ORIGIN),
      request: {
        headers: new Headers({ cookie: `${seed.sessionCookieName}=${seed.sessionCookieValue}` }),
        url: `${HTTP_ORIGIN}/app`,
      },
      now: NOW,
    });
    const session = await port.session();
    // This is what `/app` needs and did not have.
    expect(session).not.toBeNull();
    expect(session?.workspaceId).toBe(seed.workspaceId);
    expect(session?.role).toBe('workspace_viewer');
  });

  it('AUTH-450 re-seeding keeps the workspace read-only and does not accumulate rows', async () => {
    await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });
    // Somebody widened it by hand between runs.
    h.raw
      .prepare("UPDATE memberships SET role = 'workspace_admin' WHERE workspace_id = ?")
      .run('ws_automation_test');
    await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(countRows(h, 'workspaces')).toBe(1);
    expect(countRows(h, 'memberships')).toBe(1);
    // Asserted on every seed, not assumed from the last one.
    const role = (h.raw.prepare('SELECT role FROM memberships').get() as { role: string }).role;
    expect(role).toBe('workspace_viewer');
  });

  it('AUTH-446 the exported handshake names every variable the suite reads', async () => {
    const seed = await seedAutomationIdentity(h.db, {
      environment: 'development',
      baseUrl: HTTP_ORIGIN,
      now: NOW,
    });
    const exported = automationSeedExports(seed);
    expect(exported).toContain(`export E2E_AUTOMATION_SESSION=${seed.sessionCookieValue}`);
    expect(exported).toContain(`export E2E_AUTOMATION_COOKIE_NAME=${seed.sessionCookieName}`);
    expect(exported).toContain(`export E2E_AUTOMATION_CSRF=${seed.csrfToken}`);
    // The row id is a hash of a live credential and has no business in a shell export.
    expect(exported).not.toContain(seed.sessionId);
  });

  it('AUTH-447 the shell script derives the same names, ceiling and workspace as the module', () => {
    // The script cannot import TypeScript, so its arithmetic is duplicated. This pins the
    // two together: if one changes and the other does not, the suite signs itself out.
    const script = readFileSync('scripts/seed-automation-identity.mjs', 'utf8');
    expect(script).toContain("secure ? '__Host-verify_session' : 'verify_session'");
    expect(script).toContain("secure ? '__Host-verify_csrf' : 'verify_csrf'");
    expect(script).toContain('const MAX_LIFETIME_SECONDS = 12 * 60 * 60;');
    expect(script).toContain('verify.token.v1.${domain}:');
    // Production is refused, and the refusal is in the argument check before any minting.
    expect(script).toContain("!['local', 'staging'].includes(env)");
    expect(script).toContain('is_automation');
    expect(script).toContain('is_platform_owner = 0');
    // The two must agree on the workspace and its role, or the suite measures nothing.
    expect(script).toContain(`const WORKSPACE_ID = '${'ws_automation_test'}';`);
    expect(script).toContain("'workspace_viewer'");
    expect(script).toContain('is_synthetic');
    // `--command` is broken on Windows once a shell is involved: the SQL splits on
    // whitespace and wrangler rejects it. The file form has no quoting to get wrong.
    expect(script).toContain("'--file'");
    expect(script).not.toContain("'--command'");
  });
});

describe('the approval claim store', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
    h.raw
      .prepare(
        `INSERT INTO users (id, auth_subject, is_platform_owner, created_at)
         VALUES ('usr_owner', 'owner@example.com', 1, ?)`,
      )
      .run(NOW.toISOString());
  });
  afterEach(() => {
    h.close();
  });

  function grant(id: string, status = 'granted', expiresAt = '2026-09-20T10:00:00.000Z'): void {
    h.raw
      .prepare(
        `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency, status, note, created_at, expires_at)
         VALUES (?, 'usr_owner', 'refund_issue', 'hash', 2900, 'GBP', ?, 'note', ?, ?)`,
      )
      .run(id, status, NOW.toISOString(), expiresAt);
  }

  it('OWNER-620 the store runs the statement A07 exported, not a second spelling of it', async () => {
    // The control IS the statement. A re-spelling anywhere is the defect, so this asserts
    // the import rather than the behaviour alone.
    const source = readFileSync('apps/app/src/db/approvalClaims.ts', 'utf8');
    expect(source).toContain('CLAIM_APPROVAL_SQL');
    expect(source).toContain("from '../owner/approvals'");
    // No UPDATE of its own anywhere in the file.
    expect(source).not.toMatch(/UPDATE\s+approvals/i);
    expect(CLAIM_APPROVAL_SQL).toMatch(/UPDATE approvals SET status = 'consumed'/);
  });

  it('OWNER-621 spends a granted approval exactly once', async () => {
    grant('apr_1');
    const store = createApprovalClaims(h.db);
    expect(await store.claim({ approvalId: 'apr_1', at: NOW.toISOString() })).toBe(true);
    // The second call is not a permission, whatever the caller believes.
    expect(await store.claim({ approvalId: 'apr_1', at: NOW.toISOString() })).toBe(false);
    const row = h.raw
      .prepare('SELECT status, consumed_at FROM approvals WHERE id = ?')
      .get('apr_1') as {
      status: string;
      consumed_at: string;
    };
    expect(row.status).toBe('consumed');
    expect(row.consumed_at).toBe(NOW.toISOString());
  });

  it('OWNER-622 two concurrent claims of one approval: exactly one holds the permission', async () => {
    grant('apr_1');
    const store = createApprovalClaims(h.db);
    const results = await Promise.all([
      store.claim({ approvalId: 'apr_1', at: NOW.toISOString() }),
      store.claim({ approvalId: 'apr_1', at: NOW.toISOString() }),
      store.claim({ approvalId: 'apr_1', at: NOW.toISOString() }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('OWNER-623 refuses a revoked, an expired and an absent approval alike', async () => {
    grant('apr_revoked', 'revoked');
    grant('apr_expired', 'granted', '2026-09-19T09:00:00.000Z');
    const store = createApprovalClaims(h.db);
    expect(await store.claim({ approvalId: 'apr_revoked', at: NOW.toISOString() })).toBe(false);
    expect(await store.claim({ approvalId: 'apr_expired', at: NOW.toISOString() })).toBe(false);
    expect(await store.claim({ approvalId: 'apr_absent', at: NOW.toISOString() })).toBe(false);
    // Nothing was consumed by a refusal.
    expect(countRows(h, 'approvals', "status = 'consumed'")).toBe(0);
  });

  it('OWNER-624 an approval expiring exactly now is refused, not accepted', async () => {
    grant('apr_edge', 'granted', NOW.toISOString());
    const store = createApprovalClaims(h.db);
    // `expires_at > ?` is strict: a window that has just closed is closed.
    expect(await store.claim({ approvalId: 'apr_edge', at: NOW.toISOString() })).toBe(false);
  });
});
