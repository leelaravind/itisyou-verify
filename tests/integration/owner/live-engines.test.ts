/**
 * The three engines, reached from a real HTTP request, against a real database.
 *
 * ## Why this file exists
 *
 * `apps/app/src/owner/quality.ts`, `apps/app/src/owner/cleanup.ts` and the campaign
 * approval binding in `apps/app/src/growth/approval.ts` are implemented, unit-tested and —
 * until now — **reached by nothing in production**. `D1OwnerDataPort.dispatchQuality`
 * returned `NO_RUNNER`, `cleanupPreview`/`cleanupExecute` returned `NO_CLEANUP`, and
 * `campaigns()` returned an empty list while `activateCampaign` refused without ever
 * consuming the approval that the owner's £15 advertising allocation depends on.
 *
 * That is the dominant defect class on this project: correct code, thoroughly tested,
 * reached by nothing. So every case below starts at an HTTP POST, goes through the real
 * router, the real authorisation, the real CSRF check and the **live D1 port**, and
 * asserts on rows in a database rather than on a return value.
 *
 * Three rules every case here follows:
 *
 *  1. **Assert on rows.** A return value can be produced by a stub; a row cannot.
 *  2. **Never pass vacuously.** A case that would be satisfied by the thing not existing
 *     is a case that goes green while the gap stays invisible.
 *  3. **A failure underneath must surface as a failure above.** A control that reports
 *     success without acting is worse than a control that is missing.
 *
 * Case ids `OWNER-350..372`.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { D1OwnerDataPort } from '@app/db/ownerPort';
import { issueSignInToken, promoteToPlatformOwner, redeemSignInToken } from '@app/lib/auth';
import { packetHash, type CampaignPacket } from '@app/growth/approval';
import { ownerPayloadHash } from '@app/owner/approvals';
import type { Env } from '@app/lib/context';
import type { RouteBindings } from '@app/routes/public/shared';
import { createTestDb, type TestDb } from '../db/harness';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ISO = NOW.toISOString();
const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-the-owner-live-engine-tests';
const OWNER_EMAIL = 'owner@itisyou.test';
const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

/** Minutes, as milliseconds, for building fixture timestamps that are clearly past. */
function agoIso(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

function aheadIso(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

let h: TestDb;

beforeEach(() => {
  h = createTestDb();
});

afterEach(() => {
  h.close();
});

interface Harness {
  /** The signed-in owner's cookies, for the few cases that call the port directly. */
  readonly cookie: string;
  get(path: string): Promise<Response>;
  post(path: string, fields?: Record<string, string>): Promise<Response>;
}

/**
 * A signed-in platform owner with a fresh strong-auth check, over the live D1 port.
 *
 * Everything here is a real row: the user, the session, the MFA timestamp. Nothing is
 * injected past the authorisation layer, which is the point — `OWNER-304` already proves
 * an anonymous request never reaches any of this.
 */
async function signIn(): Promise<string> {
  const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now: NOW });
  const redeemed = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
  if (!redeemed.ok) throw new Error('sign-in failed in the fixture');
  await promoteToPlatformOwner(h.db, OWNER_EMAIL);
  // A recent two-factor check. Every consequential capability needs one.
  h.raw.prepare('UPDATE sessions SET mfa_verified_at = ?').run(ISO);
  return `verify_session=${redeemed.session.sessionValue}`;
}

async function mount(): Promise<Harness> {
  const session = await signIn();
  const cookie = `${session}; verify_csrf=${CSRF}`;
  const app = new Hono<RouteBindings>();
  app.route(
    '/',
    createOwnerRoutes({
      now: () => NOW,
      resolvePort: async (c) =>
        new D1OwnerDataPort({
          db: h.db,
          env: { ...(c.env as Env), DB: h.db as unknown as Env['DB'] },
          request: c.req.raw,
          now: NOW,
        }),
    }),
  );
  return {
    cookie,
    get: async (path) => app.request(`${ORIGIN}${path}`, { headers: { cookie } }, ENV),
    post: async (path, fields = {}) =>
      app.request(
        `${ORIGIN}${path}`,
        {
          method: 'POST',
          body: new URLSearchParams({ csrf_token: CSRF, ...fields }).toString(),
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        },
        ENV,
      ),
  };
}

function rows<T>(sql: string, ...bind: readonly unknown[]): T[] {
  return h.raw.prepare(sql).all(...(bind as never[])) as T[];
}

function one<T>(sql: string, ...bind: readonly unknown[]): T | undefined {
  return h.raw.prepare(sql).get(...(bind as never[])) as T | undefined;
}

/* -------------------------------------------------------------------------- */
/* quality dispatch                                                            */
/* -------------------------------------------------------------------------- */

describe('the test centre dispatch reaches the quality engine', () => {
  it('OWNER-350 a dispatch writes a real quality_runs row and reports the missing executor', async () => {
    const app = await mount();
    const response = await app.post('/owner/quality/run', { suite_id: 'unit' });

    const run = one<{ suite_id: string; state: string; limitations: string; dedupe_key: string }>(
      'SELECT suite_id, state, limitations, dedupe_key FROM quality_runs',
    );
    expect(run, 'the dispatch never reached quality_runs').toBeDefined();
    expect(run?.suite_id).toBe('unit');
    // No executor is paired, so the run is saved and waiting — never reported as passed.
    expect(run?.state).toBe('awaiting_runner');
    expect(run?.limitations).toMatch(/has not executed/i);
    expect(run?.dedupe_key).toMatch(/^[0-9a-f]{64}$/);

    // The page says a dependency, not a result.
    const body = await response.text();
    expect(body).toContain('data-dependency="true"');
    expect(body).not.toMatch(/passed/i);
  });

  it('OWNER-351 a double-submitted dispatch is the same request, not a second run', async () => {
    const app = await mount();
    await app.post('/owner/quality/run', { suite_id: 'integration' });
    await app.post('/owner/quality/run', { suite_id: 'integration' });

    expect(rows('SELECT id FROM quality_runs')).toHaveLength(1);
  });

  it('OWNER-352 a suite id that is not on the allowlist records nothing at all', async () => {
    const app = await mount();
    const response = await app.post('/owner/quality/run', { suite_id: 'unit; rm -rf /' });

    expect(response.status).toBe(422);
    expect(rows('SELECT id FROM quality_runs')).toHaveLength(0);
  });

  it('OWNER-353 a failure in the store surfaces as a failure, never as a queued run', async () => {
    const app = await mount();
    // The store refuses the write — a full disk, a constraint, a broken migration. The
    // owner must be told, not shown a green tick over a run that was never recorded.
    h.exec(
      `CREATE TRIGGER quality_runs_refuse_writes BEFORE INSERT ON quality_runs
       BEGIN SELECT RAISE(ABORT, 'the store refused the write'); END`,
    );

    const response = await app.post('/owner/quality/run', { suite_id: 'unit' });
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).toMatch(/could not be recorded|nothing has been dispatched/i);
    expect(body).not.toMatch(/data-run-state="queued"/);
    expect(rows('SELECT id FROM quality_runs')).toHaveLength(0);
  });

  it('OWNER-354 with a runner actually paired the dispatch queues a job for that suite', async () => {
    const app = await mount();
    h.exec(
      `INSERT INTO runner_devices (id, owner_id, label, public_key, status, last_heartbeat_at, created_at)
       SELECT 'dev_1', id, 'the laptop', 'pk', 'active', '${agoIso(10)}', '${ISO}' FROM users LIMIT 1`,
    );

    await app.post('/owner/quality/run', { suite_id: 'unit' });

    const job = one<{ typed_kind: string; payload_json: string }>(
      'SELECT typed_kind, payload_json FROM maintenance_jobs',
    );
    expect(job, 'a paired runner was never asked to run anything').toBeDefined();
    expect(job?.typed_kind).toBe('run_test_suite');
    // The suite the owner asked for, not a different one.
    expect(JSON.parse(job?.payload_json ?? '{}')).toMatchObject({ suite: 'unit' });
    expect(one<{ state: string }>('SELECT state FROM quality_runs')?.state).toBe('queued');
  });
});

/* -------------------------------------------------------------------------- */
/* cleanup                                                                     */
/* -------------------------------------------------------------------------- */

/** Two expired sessions, one live one, one synthetic workspace and one real customer. */
function seedCleanupFixtures(): void {
  h.exec(
    `INSERT INTO users (id, auth_subject, is_platform_owner, created_at)
     VALUES ('usr_cleanup', 'someone@example.invalid', 0, '${ISO}')`,
  );
  for (const id of ['sess_expired_a', 'sess_expired_b']) {
    h.exec(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES ('${id}', 'usr_cleanup', '${agoIso(90_000)}', '${agoIso(3600)}', '${agoIso(4000)}')`,
    );
  }
  h.exec(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
     VALUES ('sess_live', 'usr_cleanup', '${ISO}', '${aheadIso(3600)}', '${ISO}')`,
  );
  h.exec(
    `INSERT INTO workspaces (id, name, status, is_synthetic, created_at)
     VALUES ('ws_synthetic_demo', 'Demo', 'active', 1, '${agoIso(90_000)}')`,
  );
  h.exec(
    `INSERT INTO workspaces (id, name, status, is_synthetic, created_at)
     VALUES ('ws_real_customer', 'A real customer', 'active', 0, '${agoIso(90_000)}')`,
  );
}

/** The hash the page rendered, which is the only hash a run is allowed to act on. */
function inventoryHashFrom(body: string): string {
  const hash = /data-inventory-hash="([0-9a-f]+)"/.exec(body)?.[1];
  if (hash === undefined) throw new Error('the preview page rendered no inventory hash');
  return hash;
}

/** Grant a cleanup approval bound to exactly this inventory, as a real row. */
async function grantCleanupApproval(
  app: Harness,
  input: { categories: readonly string[]; hash: string; count: number },
): Promise<string> {
  await app.post('/owner/approvals', {
    action_type: 'cleanup_execute',
    summary: 'Remove the expired sign-in sessions listed in this preview',
    maximum_amount: '',
    payload_json: JSON.stringify({
      categories: [...input.categories],
      inventory_hash: input.hash,
      resource_count: input.count,
      environment: 'development',
    }),
  });
  const row = one<{ id: string }>(
    "SELECT id FROM approvals WHERE action_type = 'cleanup_execute' ORDER BY created_at DESC",
  );
  if (row === undefined) throw new Error('the grant route recorded no approval');
  return row.id;
}

describe('safe cleanup reaches the inventory and deletion engine', () => {
  it('OWNER-355 a preview inventories the real expired rows and records the preview', async () => {
    seedCleanupFixtures();
    const app = await mount();

    const body = await (
      await app.post('/owner/cleanup/preview', { categories: 'expired_sessions' })
    ).text();

    expect(body).toContain('data-resource-id="sess_expired_a"');
    expect(body).toContain('data-resource-id="sess_expired_b"');
    // The live session is not expired, so it is not in the inventory.
    expect(body).not.toContain('data-resource-id="sess_live"');

    const preview = one<{ state: string; inventory_hash: string }>(
      'SELECT state, inventory_hash FROM cleanup_runs',
    );
    expect(preview, 'the preview was never recorded').toBeDefined();
    expect(preview?.state).toBe('preview');
    expect(preview?.inventory_hash).toBe(inventoryHashFrom(body));
  });

  it('OWNER-356 a real customer workspace is found, refused and shown as refused', async () => {
    seedCleanupFixtures();
    const app = await mount();

    const body = await (
      await app.post('/owner/cleanup/preview', { categories: 'synthetic_workspaces' })
    ).text();

    expect(body).toContain('data-resource-id="ws_synthetic_demo"');
    expect(body).toContain('data-excluded="true"');
    expect(body).toContain('ws_real_customer');
    expect(body).not.toContain('data-resource-id="ws_real_customer"');
  });

  it('OWNER-357 a run with no approval deletes nothing and says an approval is needed', async () => {
    seedCleanupFixtures();
    const app = await mount();
    const preview = await (
      await app.post('/owner/cleanup/preview', { categories: 'expired_sessions' })
    ).text();

    const response = await app.post('/owner/cleanup/run', {
      inventory_hash: inventoryHashFrom(preview),
      confirm: 'delete',
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/approval/i);
    // Four: the two expired rows, the live one, and the owner's own signed-in session.
    expect(rows('SELECT id FROM sessions')).toHaveLength(4);
  });

  it('OWNER-358 an approved run deletes exactly what was inventoried and spends the approval', async () => {
    seedCleanupFixtures();
    const app = await mount();
    const preview = await (
      await app.post('/owner/cleanup/preview', { categories: 'expired_sessions' })
    ).text();
    const hash = inventoryHashFrom(preview);
    const approvalId = await grantCleanupApproval(app, {
      categories: ['expired_sessions'],
      hash,
      count: 2,
    });

    const response = await app.post('/owner/cleanup/run', {
      inventory_hash: hash,
      confirm: 'delete',
    });
    expect(response.status).toBe(200);

    // The rows are gone, and only those rows.
    const remaining = rows<{ id: string }>('SELECT id FROM sessions ORDER BY id').map((r) => r.id);
    expect(remaining).not.toContain('sess_expired_a');
    expect(remaining).not.toContain('sess_expired_b');
    expect(remaining).toContain('sess_live');

    // The approval is spent, exactly once, at the instant of the run.
    const approval = one<{ status: string; consumed_at: string | null }>(
      'SELECT status, consumed_at FROM approvals WHERE id = ?',
      approvalId,
    );
    expect(approval?.status).toBe('consumed');
    expect(approval?.consumed_at).toBe(ISO);

    // And there is a report on the record, claiming completion only because it completed.
    const run = one<{ state: string; report_json: string | null }>(
      'SELECT state, report_json FROM cleanup_runs WHERE inventory_hash = ?',
      hash,
    );
    expect(run?.state).toBe('completed');
    expect(JSON.parse(run?.report_json ?? '{}')).toMatchObject({
      claimsComplete: true,
      deleted: 2,
    });
  });

  it('OWNER-359 a replayed run finds the approval already spent and deletes nothing more', async () => {
    seedCleanupFixtures();
    const app = await mount();
    const preview = await (
      await app.post('/owner/cleanup/preview', { categories: 'expired_sessions' })
    ).text();
    const hash = inventoryHashFrom(preview);
    await grantCleanupApproval(app, { categories: ['expired_sessions'], hash, count: 2 });

    await app.post('/owner/cleanup/run', { inventory_hash: hash, confirm: 'delete' });
    const replay = await app.post('/owner/cleanup/run', {
      inventory_hash: hash,
      confirm: 'delete',
    });

    expect(replay.status).toBe(422);
    // Only the live fixture session and the owner's own are left, and the replay took none.
    expect(rows('SELECT id FROM sessions')).toHaveLength(2);
    expect(
      rows("SELECT id FROM approvals WHERE status = 'consumed'"),
      'exactly one consumption',
    ).toHaveLength(1);
  });

  it('OWNER-360 a hash from a different preview deletes nothing and spends nothing', async () => {
    seedCleanupFixtures();
    const app = await mount();
    await app.post('/owner/cleanup/preview', { categories: 'expired_sessions' });

    const response = await app.post('/owner/cleanup/run', {
      inventory_hash: 'a'.repeat(64),
      confirm: 'delete',
    });

    expect(response.status).toBe(422);
    expect(rows('SELECT id FROM sessions')).toHaveLength(4);
    expect(rows("SELECT id FROM approvals WHERE status = 'consumed'")).toHaveLength(0);
  });

  it('OWNER-361 a delete that fails underneath is reported as failed, never as completed', async () => {
    seedCleanupFixtures();
    const app = await mount();
    const preview = await (
      await app.post('/owner/cleanup/preview', { categories: 'expired_sessions' })
    ).text();
    const hash = inventoryHashFrom(preview);
    await grantCleanupApproval(app, { categories: ['expired_sessions'], hash, count: 2 });

    // The underlying system breaks between the preview and the run.
    h.exec('DROP TABLE sessions');

    const response = await app.post('/owner/cleanup/run', {
      inventory_hash: hash,
      confirm: 'delete',
    });
    const body = await response.text();
    expect(body).not.toContain('data-cleanup-state="completed"');
    expect(body).toMatch(/could not|failed|not complete/i);
  });
});

/* -------------------------------------------------------------------------- */
/* campaigns                                                                   */
/* -------------------------------------------------------------------------- */

const PACKET: CampaignPacket = {
  platform: 'reddit_ads',
  budget_minor: 1500,
  currency: 'GBP',
  audience: {
    description: 'Small UK businesses running one automation they cannot check',
    targets: ['r/smallbusiness'],
    negatives: [],
    geography: ['GB'],
    languages: ['en'],
  },
  creative: {
    headline: 'Did your automation actually do it?',
    body: 'We check the CRM and the mailbox independently and tell you what we found.',
    call_to_action: 'See how it works',
  },
  destination: {
    url: 'https://verify.itisyou.example/?utm_source=reddit',
    conversion_definition: 'A workspace that connects a CRM and runs one verification',
  },
  duration: {
    starts_at: '2026-10-01T00:00:00.000Z',
    ends_at: '2026-10-15T00:00:00.000Z',
    timezone: 'Europe/London',
  },
  bidding: { max_cpc_minor: 40, strategy: 'manual_cpc' },
};

function seedCampaign(state = 'awaiting_owner', packet: CampaignPacket = PACKET): void {
  h.exec(
    `INSERT INTO campaigns (id, provider, external_id, state, approved_payload_hash, approval_id,
                            packet_json, budget_minor, currency, starts_at, ends_at, created_at, updated_at)
     VALUES ('cmp_first', 'reddit_ads', NULL, '${state}', NULL, NULL,
             '${JSON.stringify(packet).replace(/'/g, "''")}', ${packet.budget_minor}, 'GBP',
             '${packet.duration.starts_at}', '${packet.duration.ends_at}', '${ISO}', '${ISO}')`,
  );
}

/** A granted `campaign_launch` approval bound to this exact packet. */
async function seedCampaignApproval(packet: CampaignPacket = PACKET): Promise<string> {
  const hash = await packetHash(packet);
  const id = 'apr_campaign_1';
  h.exec(
    `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor,
                            currency, status, note, created_at, expires_at)
     SELECT '${id}', id, 'campaign_launch', '${hash}', 1500, 'GBP', 'granted',
            'Launch the £15 Reddit campaign exactly as written', '${ISO}', '${aheadIso(86_400)}'
       FROM users WHERE is_platform_owner = 1 LIMIT 1`,
  );
  return id;
}

function campaignRow():
  { state: string; approval_id: string | null; approved_payload_hash: string | null } | undefined {
  return one(
    'SELECT state, approval_id, approved_payload_hash FROM campaigns WHERE id = ?',
    'cmp_first',
  );
}

describe('campaign activation cannot happen without spending an approval', () => {
  it('OWNER-362 the ads page lists the real campaign rows', async () => {
    seedCampaign();
    const app = await mount();

    const body = await (await app.get('/owner/ads')).text();
    expect(body).toContain('Did your automation actually do it?');
    expect(body).toContain('£15.00');
  });

  it('OWNER-363 activation without an approval changes nothing and spends nothing', async () => {
    seedCampaign();
    const app = await mount();

    const response = await app.post('/owner/ads/cmp_first/activate', { approval_id: '' });

    expect(response.status).not.toBe(303);
    expect(campaignRow()?.state).toBe('awaiting_owner');
    expect(campaignRow()?.approval_id).toBeNull();
    expect(rows("SELECT id FROM approvals WHERE status = 'consumed'")).toHaveLength(0);
  });

  it('OWNER-364 a bound approval is consumed and the campaign is stamped with it', async () => {
    seedCampaign();
    const app = await mount();
    const approvalId = await seedCampaignApproval();

    const response = await app.post('/owner/ads/cmp_first/activate', { approval_id: approvalId });

    const approval = one<{ status: string; consumed_at: string | null }>(
      'SELECT status, consumed_at FROM approvals WHERE id = ?',
      approvalId,
    );
    expect(approval?.status).toBe('consumed');
    expect(approval?.consumed_at).toBe(ISO);

    const campaign = campaignRow();
    expect(campaign?.approval_id).toBe(approvalId);
    expect(campaign?.approved_payload_hash).toBe(await packetHash(PACKET));
    expect(campaign?.state).toBe('ready_to_submit');

    // Nothing was created at an ad platform, and the page says so rather than claiming a
    // live campaign. £15 is still £15.
    const body = await response.text();
    expect(body).toContain('data-dependency="true"');
    expect(body).not.toMatch(/data-campaign-state="active"/);
  });

  it('OWNER-365 a double-submitted activation consumes the approval exactly once', async () => {
    seedCampaign();
    const app = await mount();
    const approvalId = await seedCampaignApproval();

    const [a, b] = await Promise.all([
      app.post('/owner/ads/cmp_first/activate', { approval_id: approvalId }),
      app.post('/owner/ads/cmp_first/activate', { approval_id: approvalId }),
    ]);
    const bodies = [await a.text(), await b.text()];

    expect(rows("SELECT id FROM approvals WHERE status = 'consumed'")).toHaveLength(1);
    expect(bodies.filter((body) => /already been used|already used/i.test(body))).toHaveLength(1);
  });

  it('OWNER-366 an approval bound to a different budget authorises nothing', async () => {
    seedCampaign();
    const app = await mount();
    // The owner approved £15.00. The stored packet now says £15.01.
    const approvalId = await seedCampaignApproval({ ...PACKET, budget_minor: 1501 });

    const response = await app.post('/owner/ads/cmp_first/activate', { approval_id: approvalId });

    expect(response.status).not.toBe(303);
    expect(
      one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', approvalId)?.status,
    ).toBe('granted');
    expect(campaignRow()?.state).toBe('awaiting_owner');
  });
});

/* -------------------------------------------------------------------------- */
/* the refund button on the live port                                          */
/* -------------------------------------------------------------------------- */

const REFUND_PAYLOAD = {
  workspace_id: 'ws_refund',
  order_id: 'ord_refund',
  amount_minor: 4900,
  currency: 'GBP' as const,
  policy_rule: 'unused_period_within_14_days',
  reason: 'the connection never worked',
};

const REFUND_FORM = {
  workspace_id: REFUND_PAYLOAD.workspace_id,
  order_id: REFUND_PAYLOAD.order_id,
  amount: '49.00',
  policy_rule: REFUND_PAYLOAD.policy_rule,
  reason: REFUND_PAYLOAD.reason,
};

/** A granted refund approval, hashed the way the consumption path hashes it. */
async function seedRefundApproval(): Promise<string> {
  const hash = await ownerPayloadHash({ action_type: 'refund_issue', payload: REFUND_PAYLOAD });
  h.exec(
    `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor,
                            currency, status, note, created_at, expires_at)
     SELECT 'apr_refund_1', id, 'refund_issue', '${hash}', 4900, 'GBP', 'granted',
            'Refund September in full', '${ISO}', '${aheadIso(86_400)}'
       FROM users WHERE is_platform_owner = 1 LIMIT 1`,
  );
  return 'apr_refund_1';
}

describe("the owner panel's own refund button spends the approval", () => {
  it('OWNER-367 a refund through the live port moves the approval row to consumed', async () => {
    const app = await mount();
    const id = await seedRefundApproval();

    await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });

    const after = one<{ status: string; consumed_at: string | null }>(
      'SELECT status, consumed_at FROM approvals WHERE id = ?',
      id,
    );
    expect(after?.status).toBe('consumed');
    expect(after?.consumed_at).toBe(ISO);
  });

  it('OWNER-368 a replayed refund is refused and there is still exactly one consumption', async () => {
    const app = await mount();
    const id = await seedRefundApproval();
    await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });

    const replay = await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });
    expect(await replay.text()).toMatch(/already been used/i);
    expect(
      one<{ consumed_at: string }>('SELECT consumed_at FROM approvals WHERE id = ?', id)
        ?.consumed_at,
    ).toBe(ISO);
  });

  it('OWNER-369 a refund a penny different from the approved one consumes nothing', async () => {
    const app = await mount();
    const id = await seedRefundApproval();

    await app.post('/owner/refunds', { ...REFUND_FORM, amount: '49.01', approval_id: id });

    const after = one<{ status: string; consumed_at: string | null }>(
      'SELECT status, consumed_at FROM approvals WHERE id = ?',
      id,
    );
    expect(after?.status).toBe('granted');
    expect(after?.consumed_at).toBeNull();
  });

  it('OWNER-370 an approval granted in the panel is one the action can actually consume', async () => {
    const app = await mount();
    // Granted through the real route, so the stored hash is the one the server computed.
    await app.post('/owner/approvals', {
      action_type: 'refund_issue',
      summary: 'Refund September in full — the connection never worked',
      maximum_amount: '49.00',
      payload_json: JSON.stringify(REFUND_PAYLOAD),
    });
    const id = one<{ id: string }>('SELECT id FROM approvals ORDER BY created_at DESC')?.id ?? '';
    expect(id).not.toBe('');

    await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });

    // If the grant path and the consumption path hash differently, this stays `granted`
    // and every approval the owner grants in the panel is unusable.
    expect(one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', id)?.status).toBe(
      'consumed',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* the approval-required actions that are NOT refunds, campaigns or cleanups   */
/* -------------------------------------------------------------------------- */

/**
 * Enumerating the approval-required actions turned up two that no case covered.
 *
 * `OWNER_ACTION_TYPES` declares four. Three of them now consume — `refund_issue`,
 * `campaign_launch`, `cleanup_execute`, proven above against rows. The fourth,
 * `budget_limit_change`, has a canonical payload, a maximum check and **no action behind
 * it**: `owner.budget_limits` sat in the same `writeSetting` allowlist as the business
 * address, so a ceiling — including `platform:advertising`, the owner's reserved £15 — was
 * one ordinary settings save away from being raised with no approval at all. Nothing routed
 * to it today, which is exactly the shape of a gap that closes itself the first time
 * somebody adds a form.
 *
 * And `/owner/operations/restore` read an approval id, checked only that the row was
 * granted and unexpired, ignored the `deployment_id` field on its own form, and then told
 * the owner "the deployment id is recorded". Nothing read it and nothing wrote it.
 */
describe('the approval-required actions that had no case', () => {
  it('OWNER-371 a spending ceiling cannot be raised through the ordinary settings save', async () => {
    const app = await mount();
    const raised = JSON.stringify({
      currency: 'GBP',
      limits: { 'platform:advertising': 100_000 },
      safetyBufferMinor: 200,
    });

    // The port is the surface every route shares, and the principal is the real signed-in
    // owner rather than a fabricated one — so this is the same call any future budget form
    // would make, not a narrower one.
    const port = new D1OwnerDataPort({
      db: h.db,
      env: { ...ENV, DB: h.db } as unknown as Env,
      request: new Request(`${ORIGIN}/owner/settings`, { headers: { cookie: app.cookie } }),
      now: NOW,
    });
    const result = await port.writeSetting(
      {
        principal: await port.principal(),
        capability: 'settings.write',
        now: NOW,
        requestId: 'req-owner-371',
      },
      'owner.budget_limits',
      raised,
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/approval/i);
    // The row is the assertion: a refusal that still wrote the value would be the worst of
    // both, and a return value alone cannot tell the two apart.
    expect(
      one<{ value_json: string }>(
        'SELECT value_json FROM settings WHERE key = ?',
        'owner.budget_limits',
      ),
    ).toBeUndefined();

    // And an ordinary setting on the same path still saves, so this is a refusal of one
    // key and not a broken settings page.
    const ok = await app.post('/owner/settings/retention', {
      runRetentionDays: '90',
      evidenceRetentionDays: '90',
      auditRetentionDays: '365',
    });
    expect(ok.status).toBeLessThan(500);
  });

  it('OWNER-372 a restore refuses an approval granted for something else, and records nothing', async () => {
    const app = await mount();
    // A perfectly good refund approval. It is granted and unexpired, so the old
    // standing-only check read it as "the approval stands" on the page that replaces the
    // running code every customer is served.
    await app.post('/owner/approvals', {
      action_type: 'refund_issue',
      summary: 'Refund September in full — the connection never worked',
      maximum_amount: '49.00',
      payload_json: JSON.stringify(REFUND_PAYLOAD),
    });
    const id = one<{ id: string }>('SELECT id FROM approvals ORDER BY created_at DESC')?.id ?? '';
    expect(id).not.toBe('');

    const wrongType = await app.post('/owner/operations/restore', {
      confirm: 'restore',
      deployment_id: 'deployment-abc',
      approval_id: id,
    });
    expect(await wrongType.text()).toMatch(/does not authorise replacing the running code/i);
    // Refused before anything could be spent: the approval is still the owner's to use.
    expect(one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', id)?.status).toBe(
      'granted',
    );

    // `deployment_id` has been a field on this form all along and the route never read it.
    // An empty one used to sail past every check.
    const noDeployment = await app.post('/owner/operations/restore', {
      confirm: 'restore',
      deployment_id: '',
      approval_id: id,
    });
    expect(await noDeployment.text()).toMatch(/choose the deployment to restore/i);

    // Every action type the approvals page can mint is one of the four declared ones, and
    // every one of them is refused here. So today there is no approval a person can grant
    // that authorises a restore — the route fails closed, and says why rather than implying
    // the owner picked the wrong row. That is the state to report, not to paper over.
    for (const actionType of ['campaign_launch', 'budget_limit_change', 'cleanup_execute']) {
      h.raw
        .prepare(
          `UPDATE approvals SET action_type = ?, status = 'granted', consumed_at = NULL WHERE id = ?`,
        )
        .run(actionType, id);
      const refused = await app.post('/owner/operations/restore', {
        confirm: 'restore',
        deployment_id: 'deployment-abc',
        approval_id: id,
      });
      const refusedBody = await refused.text();
      expect(refusedBody).toMatch(/does not authorise replacing the running code/i);
      expect(refusedBody).toMatch(/missing action type/i);
      // Nothing recorded, nothing spent, for any of them.
      expect(refusedBody).not.toMatch(/deployment id is recorded/i);
      expect(
        one<{ status: string; consumed_at: string | null }>(
          'SELECT status, consumed_at FROM approvals WHERE id = ?',
          id,
        ),
      ).toMatchObject({ status: 'granted', consumed_at: null });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* the money path, as a fact the owner can read off the running Worker          */
/* -------------------------------------------------------------------------- */

describe('the owner can see whether this deployment can actually take money', () => {
  it('OWNER-373 the overview names the missing money-path secrets instead of showing nothing', async () => {
    const app = await mount();
    const body = await (await app.get('/owner')).text();

    // `moneyPathReadiness` documented itself as used by `/health` and by this view. It was
    // used by neither. This is the half of that claim the owner panel owns.
    expect(body).toMatch(/money_path/);
    // The state must never read as fine while a secret is absent — the test environment has
    // no EVENT_SIGNING_ROOT_KEY and no Stripe key, so both capabilities are lost.
    expect(body).toMatch(/money_path: degraded/i);
    expect(body).toMatch(/EVENT_SIGNING_ROOT_KEY/);
    // And it says what is lost, in the owner's terms, not just which names are missing.
    expect(body).toMatch(/no signed event can be verified/i);
    expect(body).toMatch(/wrangler secret put/);
  });

  it('OWNER-374 with both secrets present the same row reads ok, so it is a measurement not a constant', async () => {
    // Same code path, different configuration. A row that said "degraded" regardless would
    // pass the case above while telling the owner nothing.
    const port = new D1OwnerDataPort({
      db: h.db,
      env: {
        ...ENV,
        DB: h.db,
        // Presence-only placeholders. `checkBillingSecrets` tests for a non-empty string
        // and nothing here authenticates against anything — no request leaves the process
        // in this case. They are not credentials and must never be treated as any.
        EVENT_SIGNING_ROOT_KEY: 'a'.repeat(64),
        STRIPE_SECRET_KEY: 'present-not-a-credential',
        STRIPE_PRICE_ID: 'present-not-a-credential',
        STRIPE_WEBHOOK_SECRET: 'present-not-a-credential',
        STRIPE_WEBHOOK_PATH_ID: 'present-not-a-credential',
        STRIPE_WEBHOOK_UNKNOWN_KEY: 'present-not-a-credential',
        STRIPE_MODE: 'test',
      } as unknown as Env,
      request: new Request(`${ORIGIN}/owner`),
      now: NOW,
    });
    const view = await port.overview(NOW);
    const row = view.health.find((entry) => entry.component === 'money_path');
    expect(row?.state).toBe('ok');
    expect(row?.observedAt).toBe(NOW.toISOString());
  });
});

/* -------------------------------------------------------------------------- */
/* the advertising stop switch, which is the other half of the approval gate   */
/* -------------------------------------------------------------------------- */

describe('pausing advertising actually stops a campaign starting', () => {
  it('OWNER-386 a paused ads switch refuses activation before the approval is even read', async () => {
    seedCampaign();
    const app = await mount();
    const approvalId = await seedCampaignApproval();

    // The switch, through the real owner route.
    await app.post('/owner/controls/ads', { paused: 'yes' });

    const response = await app.post('/owner/ads/cmp_first/activate', {
      approval_id: approvalId,
    });
    const body = await response.text();
    expect(body).toMatch(/advertising is paused/i);

    // The campaign did not move, and — the part that matters — the approval was not spent.
    // The check runs before the approval is read precisely so that a pause never costs the
    // owner an authorisation they will need again when they un-pause.
    expect(
      one<{ state: string }>('SELECT state FROM campaigns WHERE id = ?', 'cmp_first')?.state,
    ).toBe('awaiting_owner');
    expect(
      one<{ status: string; consumed_at: string | null }>(
        'SELECT status, consumed_at FROM approvals WHERE id = ?',
        approvalId,
      ),
    ).toMatchObject({ status: 'granted', consumed_at: null });
  });

  it('OWNER-387 with the switch off the same request activates, so the refusal is the switch', async () => {
    seedCampaign();
    const app = await mount();
    const approvalId = await seedCampaignApproval();

    // No pause this time. Everything else is identical, which is what makes OWNER-386 a
    // statement about the switch rather than about the fixture.
    const response = await app.post('/owner/ads/cmp_first/activate', {
      approval_id: approvalId,
    });
    expect(await response.text()).not.toMatch(/advertising is paused/i);
    expect(
      one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', approvalId)?.status,
    ).toBe('consumed');
  });
});
