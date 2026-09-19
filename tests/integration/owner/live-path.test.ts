/**
 * Does a real request actually reach the control?
 *
 * ## The defect class this file exists for
 *
 * The auditor found that `claimApproval` — correct, and proved single-use by eight unit
 * cases including a stale-read loser — was reached by exactly one call site, in the
 * in-memory port. `D1ApprovalClaims` existed, was exported, used the shared statement, and
 * **nothing consumed it**. The tests passed because they called the function directly.
 *
 * That is the same shape as the allowance bug found in the same pass, and it is the
 * dominant defect class on this project: correct code, thoroughly tested, reached by
 * nothing. A unit test proves a function behaves; only a request proves it is wired.
 *
 * So every case below starts at an HTTP request, goes through the real router, the real
 * authorisation, the real CSRF check and the real port, and asserts on **rows in a
 * database** rather than on a return value.
 *
 * Case ids `OWNER-300..319`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { MemoryOwnerDataPort, syntheticOwnerPrincipal } from '@app/owner/memory';
import { D1ApprovalClaims } from '@app/db/approvalClaims';
import { D1QualityArtifactStore } from '@app/owner/quality';
import { CLAIM_APPROVAL_SQL } from '@app/owner/approvals';
import type { OwnerPrincipal } from '@app/owner/access';
import type { RouteBindings } from '@app/routes/public/shared';
import { createTestDb, type TestDb } from '../db/harness';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-owner-live-path-tests';
const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

const MIGRATION_0003 = readFileSync(
  fileURLToPath(new URL('../../../migrations/0003_quality_artifacts.sql', import.meta.url)),
  'utf8',
);

/**
 * Apply `0003` only if the harness has not already.
 *
 * It applied `0001` alone when this file was written and now applies every migration, so a
 * second unconditional `exec` fails with "table already exists". Asking the schema rather
 * than assuming a harness version means this keeps working whichever is true — and the
 * failure it replaces was a real one that only appeared because the harness improved.
 */
function ensureQualityArtifactsTable(): void {
  const existing = h.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quality_artifacts'")
    .get();
  if (existing === undefined) h.exec(MIGRATION_0003);
}

function ownerPrincipal(): OwnerPrincipal {
  return { ...syntheticOwnerPrincipal(NOW), csrfToken: CSRF };
}

let h: TestDb;

beforeEach(() => {
  h = createTestDb();
});

afterEach(() => {
  h.close();
});

interface Harness {
  readonly port: MemoryOwnerDataPort;
  get(path: string): Promise<Response>;
  post(path: string, fields?: Record<string, string>): Promise<Response>;
}

function mount(
  options: { port?: MemoryOwnerDataPort; artifacts?: D1QualityArtifactStore } = {},
): Harness {
  const port =
    options.port ??
    new MemoryOwnerDataPort({
      principal: ownerPrincipal(),
      now: () => NOW,
      // The real compare-and-set, over the real database.
      claims: new D1ApprovalClaims(h.db),
    });
  const app = new Hono<RouteBindings>();
  app.route(
    '/',
    createOwnerRoutes({
      resolvePort: async () => port,
      now: () => NOW,
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    }),
  );
  const cookie = `verify_csrf=${CSRF}`;
  return {
    port,
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

/** An owner and a granted approval, written as real rows. */
function seedApproval(id: string, hash: string): void {
  h.exec(
    `INSERT INTO users (id, auth_subject, is_platform_owner, created_at)
     VALUES ('usr_synthetic_owner', 'owner@example.invalid', 1, '${NOW.toISOString()}')`,
  );
  h.exec(
    `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor,
                            currency, status, note, created_at, expires_at)
     VALUES ('${id}', 'usr_synthetic_owner', 'refund_issue', '${hash}', 4900,
             'GBP', 'granted', 'Refund September in full', '${NOW.toISOString()}',
             '${new Date(NOW.getTime() + 86_400_000).toISOString()}')`,
  );
}

function approvalRow(id: string): { status: string; consumed_at: string | null } | undefined {
  return h.raw.prepare('SELECT status, consumed_at FROM approvals WHERE id = ?').get(id) as
    { status: string; consumed_at: string | null } | undefined;
}

const REFUND_FORM = {
  workspace_id: 'ws_1',
  order_id: 'ord_1',
  amount: '49.00',
  policy_rule: 'unused_period_within_14_days',
  reason: 'the connection never worked',
};

describe('a real request reaches the approval compare-and-set', () => {
  /**
   * Grant through the route so the stored hash is the one the server computed, then seed
   * the same approval as a real row. The route is the only thing that knows the hash, which
   * is the point: a test that computed it itself would be testing its own arithmetic.
   */
  async function grantThenMirror(app: Harness): Promise<string> {
    await app.post('/owner/approvals', {
      action_type: 'refund_issue',
      summary: 'Refund September in full — the connection never worked',
      maximum_amount: '49.00',
      payload_json: JSON.stringify({
        workspace_id: 'ws_1',
        order_id: 'ord_1',
        amount_minor: 4900,
        currency: 'GBP',
        policy_rule: 'unused_period_within_14_days',
        reason: 'the connection never worked',
      }),
    });
    const approval = (await app.port.approvals())[0];
    if (approval === undefined) throw new Error('the grant route did not record an approval');
    seedApproval(approval.id, approval.canonical_payload_hash);
    return approval.id;
  }

  it('OWNER-300 a POST to the refund route moves the approval row to consumed in the database', async () => {
    const app = mount();
    const id = await grantThenMirror(app);
    expect(approvalRow(id)?.status).toBe('granted');

    await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });

    // The assertion that matters: a row, not a return value.
    const after = approvalRow(id);
    expect(after?.status).toBe('consumed');
    expect(after?.consumed_at).toBe(NOW.toISOString());
  });

  it('OWNER-301 a replayed request finds the row already spent and is refused', async () => {
    const app = mount();
    const id = await grantThenMirror(app);
    await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });

    const replay = await app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id });
    expect(replay.status).toBe(422);
    expect(await replay.text()).toMatch(/already been used/i);
    // Still exactly one consumption, with the original instant.
    expect(approvalRow(id)?.consumed_at).toBe(NOW.toISOString());
  });

  it('OWNER-302 two concurrent requests on one approval produce exactly one consumption', async () => {
    const app = mount();
    const id = await grantThenMirror(app);

    const [a, b] = await Promise.all([
      app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id }),
      app.post('/owner/refunds', { ...REFUND_FORM, approval_id: id }),
    ]);
    const bodies = [await a.text(), await b.text()];
    const refused = bodies.filter((body) => /already been used/i.test(body));
    expect(refused).toHaveLength(1);
    expect(approvalRow(id)?.status).toBe('consumed');
  });

  it('OWNER-303 a request whose amount differs by a penny consumes nothing at all', async () => {
    const app = mount();
    const id = await grantThenMirror(app);

    await app.post('/owner/refunds', { ...REFUND_FORM, amount: '49.01', approval_id: id });

    // The approval is untouched, so the owner can still use it on the right amount.
    const after = approvalRow(id);
    expect(after?.status).toBe('granted');
    expect(after?.consumed_at).toBeNull();
  });

  it('OWNER-304 an unauthenticated request never reaches the statement', async () => {
    const app = mount();
    const id = await grantThenMirror(app);

    const anonymous = new Hono<RouteBindings>();
    anonymous.route('/', createOwnerRoutes({ now: () => NOW }));
    const response = await anonymous.request(
      `${ORIGIN}/owner/refunds`,
      {
        method: 'POST',
        body: new URLSearchParams({ csrf_token: CSRF, ...REFUND_FORM, approval_id: id }).toString(),
        headers: {
          cookie: `verify_csrf=${CSRF}`,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
      },
      ENV,
    );
    expect(response.status).toBe(404);
    expect(approvalRow(id)?.status).toBe('granted');
  });

  it('OWNER-305 the statement the route runs is the one exported beside the rules', () => {
    // If anybody writes a second spelling, the shared constant stops being the only one and
    // the guarantee quietly becomes two guarantees that can drift.
    const source = readFileSync(
      fileURLToPath(new URL('../../../apps/app/src/db/approvalClaims.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('CLAIM_APPROVAL_SQL');
    expect(source).not.toMatch(/UPDATE\s+approvals\s+SET\s+status/i);
    expect(CLAIM_APPROVAL_SQL).toMatch(/status\s*=\s*'granted'/);
  });
});

describe('a real request reaches the evidence pack', () => {
  function seedPack(): void {
    ensureQualityArtifactsTable();
    h.exec(
      `INSERT INTO quality_artifacts (id, part, body, commit_sha, generated_at, uploaded_at)
       VALUES ('test-report.md', 0, '# ITISYOU Verify — test report', 'abc123def456',
               '${NOW.toISOString()}', '${NOW.toISOString()}')`,
    );
    h.exec(
      `INSERT INTO quality_artifacts (id, part, body, commit_sha, generated_at, uploaded_at)
       VALUES ('test-report.md', 1, e'\n2026 passed', 'abc123def456',
               '${NOW.toISOString()}', '${NOW.toISOString()}')`.replace("e'\n", "'\n"),
    );
  }

  it('OWNER-306 a GET download serves the stored pack, reassembled from its parts', async () => {
    seedPack();
    const app = mount({ artifacts: new D1QualityArtifactStore(h.db) });

    const response = await app.get('/owner/quality/report/test-report.md');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('ITISYOU Verify — test report');
    expect(body).toContain('2026 passed');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('x-report-generated-at')).toBe(NOW.toISOString());
  });

  it('OWNER-307 the quality page stops reporting a dependency once a pack is stored', async () => {
    seedPack();
    const app = mount({ artifacts: new D1QualityArtifactStore(h.db) });
    const body = await (await app.get('/owner/quality')).text();
    expect(body).toContain('/owner/quality/report/test-report.md');
    expect(body).not.toContain('data-dependency="true"');
  });

  it('OWNER-308 with the table present but empty, the page says upload rather than migrate', async () => {
    ensureQualityArtifactsTable();
    const app = mount({ artifacts: new D1QualityArtifactStore(h.db) });
    const body = await (await app.get('/owner/quality')).text();
    expect(body).toContain('data-dependency="true"');
    expect(body).toMatch(/no evidence pack has been uploaded/i);
    expect(body).not.toMatch(/quality_artifacts table/);
  });

  it('OWNER-309 an anonymous request cannot download a stored pack', async () => {
    seedPack();
    const anonymous = new Hono<RouteBindings>();
    anonymous.route(
      '/',
      createOwnerRoutes({ now: () => NOW, artifacts: new D1QualityArtifactStore(h.db) }),
    );
    const response = await anonymous.request(
      `${ORIGIN}/owner/quality/report/test-report.md`,
      {},
      ENV,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('2026 passed');
  });
});
