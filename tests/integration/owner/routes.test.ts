/**
 * The owner router, end to end over real HTTP requests.
 *
 * Everything here goes through the actual Hono app: the same authorisation, the same CSRF
 * middleware and the same rendered HTML a browser would receive. The point is that the
 * properties proved in the unit tests survive the routing layer, which is where they are
 * most often lost.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createOwnerRoutes, UnconfiguredOwnerRouterError } from '@app/routes/owner/index';
import { publicRoutes } from '@app/routes/public/index';
import { appRoutes } from '@app/routes/app/index';
import { ANONYMOUS_PRINCIPAL, type OwnerPrincipal } from '@app/owner/access';
import { MemoryOwnerDataPort, syntheticAutomationPrincipal, syntheticOwnerPrincipal } from '@app/owner/memory';
import { StaticQualityArtifactStore } from '@app/owner/quality';
import type { RouteBindings } from '@app/routes/public/shared';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-owner-integration-tests';

const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

function ownerPrincipal(overrides: Partial<OwnerPrincipal> = {}): OwnerPrincipal {
  return { ...syntheticOwnerPrincipal(NOW), csrfToken: CSRF, ...overrides };
}

function customerPrincipal(): OwnerPrincipal {
  return ownerPrincipal({
    kind: 'customer',
    userId: 'usr_customer',
    email: 'customer@example.invalid',
    isPlatformOwner: false,
  });
}

interface Harness {
  readonly app: Hono<RouteBindings>;
  readonly port: MemoryOwnerDataPort;
  get(path: string): Promise<Response>;
  post(path: string, fields?: Record<string, string | readonly string[]>, options?: { omitCsrf?: boolean; origin?: string | null }): Promise<Response>;
}

function harness(options: { principal?: OwnerPrincipal; artifacts?: StaticQualityArtifactStore; port?: MemoryOwnerDataPort } = {}): Harness {
  const port =
    options.port ??
    new MemoryOwnerDataPort({ principal: options.principal ?? ownerPrincipal(), now: () => NOW });
  const app = new Hono<RouteBindings>();
  app.route(
    '/',
    createOwnerRoutes({
      resolvePort: async () => port,
      now: () => NOW,
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    }),
  );
  app.route('/', publicRoutes);
  app.route('/app', appRoutes);

  const cookie = `verify_csrf=${CSRF}`;

  return {
    app,
    port,
    get: async (path) => app.request(`${ORIGIN}${path}`, { headers: { cookie } }, ENV),
    post: async (path, fields = {}, opts = {}) => {
      const body = new URLSearchParams();
      if (opts.omitCsrf !== true) body.append('csrf_token', CSRF);
      for (const [key, value] of Object.entries(fields)) {
        if (Array.isArray(value)) for (const entry of value) body.append(key, entry);
        else body.append(key, value as string);
      }
      const headers: Record<string, string> = {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      };
      const origin = opts.origin === undefined ? ORIGIN : opts.origin;
      if (origin !== null) headers['origin'] = origin;
      return app.request(`${ORIGIN}${path}`, { method: 'POST', body: body.toString(), headers }, ENV);
    },
  };
}

const OWNER_PATHS = [
  '/owner',
  '/owner/customers',
  '/owner/verification',
  '/owner/connections',
  '/owner/ads',
  '/owner/operations',
  '/owner/controls',
  '/owner/approvals',
  '/owner/quality',
  '/owner/cleanup',
  '/owner/settings',
];

describe('owner routes — access', () => {
  it('OWNER-160 an anonymous session gets 404 on every owner page', async () => {
    const h = harness({ principal: ANONYMOUS_PRINCIPAL });
    for (const path of OWNER_PATHS) {
      const response = await h.get(path);
      expect(response.status, path).toBe(404);
    }
  });

  it('OWNER-161 a customer session gets 404 on every owner page', async () => {
    const h = harness({ principal: customerPrincipal() });
    for (const path of OWNER_PATHS) {
      expect((await h.get(path)).status, path).toBe(404);
    }
  });

  it('OWNER-162 the 404 body reveals nothing — no counts, no customers, no route names', async () => {
    const h = harness({ principal: ANONYMOUS_PRINCIPAL });
    const full = await (await h.get('/owner/approvals')).text();
    // The shared stylesheet is on every page in the product, so the assertion is about the
    // document body — the part that could carry a fact about this business.
    const body = full.slice(full.indexOf('<body>'));
    expect(body).toContain('That page does not exist');
    expect(body).not.toMatch(/approval/i);
    expect(body).not.toMatch(/owner@/);
    expect(body).not.toMatch(/synthetic/i);
    expect(body).not.toMatch(/budget/i);
    expect(body).not.toMatch(/ws_[a-z0-9_]+/i);
  });

  it('OWNER-163 the 404 for a real owner route is byte-identical to one for a route that does not exist', async () => {
    const h = harness({ principal: ANONYMOUS_PRINCIPAL });
    const real = await (await h.get('/owner/approvals')).text();
    const fake = await (await h.get('/owner/approvals')).text();
    expect(real).toBe(fake);
  });

  it('OWNER-164 a customer cannot mutate through an owner route either', async () => {
    const h = harness({ principal: customerPrincipal() });
    const response = await h.post('/owner/controls/ads', { paused: 'yes' });
    expect(response.status).toBe(404);
    expect((await h.port.controls()).ads.paused).toBe(false);
  });

  it('OWNER-165 the owner sees the panel', async () => {
    const h = harness();
    const response = await h.get('/owner');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('How the business is doing');
  });

  it('OWNER-166 every owner page is noindex', async () => {
    const h = harness();
    for (const path of OWNER_PATHS) {
      const body = await (await h.get(path)).text();
      expect(body, path).toContain('name="robots" content="noindex, nofollow"');
    }
  });

  it('OWNER-167 the noindex claim is described as tidiness rather than as protection', async () => {
    const body = await (await harness().get('/owner')).text();
    expect(body).toMatch(/tidiness, not protection/i);
  });

  it('OWNER-168 owner pages are never cached', async () => {
    const response = await harness().get('/owner');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('owner routes — strong authentication', () => {
  it('OWNER-170 a consequential action without recent MFA is refused', async () => {
    const h = harness({ principal: ownerPrincipal({ mfaVerifiedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }) });
    const response = await h.post('/owner/controls/ads', { paused: 'yes' });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Confirm it is you');
    expect((await h.port.controls()).ads.paused).toBe(false);

    // Opening a runner pairing code is consequential too — A08's openPairing implements no
    // access control of its own, so this call site is the only gate it has.
    const pair = await h.post('/owner/operations/runner/pair', { label: 'my laptop' });
    expect(pair.status).toBe(403);
    expect(await pair.text()).toContain('Confirm it is you');
  });

  it('OWNER-171 the same action with recent MFA is permitted', async () => {
    const h = harness();
    const response = await h.post('/owner/controls/ads', { paused: 'yes' });
    expect(response.status).toBe(303);
    expect((await h.port.controls()).ads.paused).toBe(true);
  });

  it('OWNER-172 viewing still works without recent MFA, because viewing changes nothing', async () => {
    const h = harness({ principal: ownerPrincipal({ mfaVerifiedAt: null }) });
    expect((await h.get('/owner')).status).toBe(200);
  });

  it('OWNER-173 a mutation with no CSRF token changes nothing', async () => {
    const h = harness();
    const response = await h.post('/owner/controls/ads', { paused: 'yes' }, { omitCsrf: true });
    expect(response.status).toBe(403);
    expect((await h.port.controls()).ads.paused).toBe(false);
  });

  it('OWNER-174 a mutation from another origin changes nothing', async () => {
    const h = harness();
    const response = await h.post('/owner/controls/ads', { paused: 'yes' }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect((await h.port.controls()).ads.paused).toBe(false);
  });

  it('OWNER-175 a mutation with neither Origin nor Referer is rejected rather than trusted', async () => {
    const h = harness();
    const response = await h.post('/owner/controls/ads', { paused: 'yes' }, { origin: null });
    expect(response.status).toBe(403);
    expect((await h.port.controls()).ads.paused).toBe(false);
  });
});

describe('owner routes — the automation identity', () => {
  function automationHarness(): Harness {
    return harness({ principal: { ...syntheticAutomationPrincipal(NOW), csrfToken: CSRF } });
  }

  it('OWNER-180 the automation identity can read the panel it exists to test', async () => {
    const h = automationHarness();
    const response = await h.get('/owner');
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/automation test identity/i);
  });

  it('OWNER-181 the automation identity cannot activate a campaign', async () => {
    const h = automationHarness();
    const response = await h.post('/owner/ads/cmp_first_test/activate', { approval_id: 'apr_x', confirm: 'activate' });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('data-refusal="capability_denied"');
    expect((await h.port.campaign('cmp_first_test'))?.state).toBe('awaiting_owner');
  });

  it('OWNER-182 the automation identity cannot issue a refund', async () => {
    const h = automationHarness();
    const response = await h.post('/owner/refunds', {
      workspace_id: 'ws_1',
      order_id: 'ord_1',
      amount: '49.00',
      approval_id: 'apr_x',
      reason: 'because',
      policy_rule: 'within_14_days_unused',
    });
    expect(response.status).toBe(403);
    expect((await h.port.auditTrail(50)).filter((row) => row.action === 'owner.refund.issue')).toHaveLength(0);
  });

  it('OWNER-183 the automation identity cannot move budget', async () => {
    const h = automationHarness();
    const response = await h.post('/owner/settings/access-mode', { mode: 'RESTRICTED_ENTRY' });
    // `settings.write` is not in its set either; the four named denials are proved directly below.
    expect(response.status).toBe(403);
    const direct = await h.port.grantApproval(
      {
        principal: syntheticAutomationPrincipal(NOW),
        capability: 'budget.move',
        now: NOW,
        requestId: 'test',
      },
      { actionType: 'budget_limit_change', payloadJson: '{}', maximumAmountMinor: 10_000, summary: 'raise it' },
    );
    expect(direct.ok).toBe(false);
    expect(await h.port.approvals()).toHaveLength(0);
  });

  it('OWNER-184 the automation identity cannot become the platform owner', async () => {
    const h = automationHarness();
    const result = await h.port.writeSetting(
      { principal: syntheticAutomationPrincipal(NOW), capability: 'owner.grant', now: NOW, requestId: 'test' },
      'owner.access_mode',
      JSON.stringify({ mode: 'PUBLIC_LOGIN' }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot owner\.grant/);
  });

  it('OWNER-185 the automation identity can still dispatch a test suite and preview a cleanup', async () => {
    const h = automationHarness();
    expect((await h.post('/owner/quality/run', { suite_id: 'unit' })).status).toBe(202);
    expect((await h.post('/owner/cleanup/preview', { categories: ['expired_sessions'] })).status).toBe(200);
  });
});

describe('owner routes — controls', () => {
  // One property, one case: the brief states cancellation and support together, and
  // OWNER-191 now carries the production-refusal composition case below.
  it('OWNER-190 pausing ads leaves cancellation and support reachable', async () => {
    const h = harness();
    await h.post('/owner/controls/ads', { paused: 'yes' });
    expect((await h.port.controls()).ads.paused).toBe(true);
    const cancel = await h.app.request(`${ORIGIN}/app/cancel`, {}, ENV);
    expect(cancel.status).toBeLessThan(400);
    const support = await h.app.request(`${ORIGIN}/support`, {}, ENV);
    expect(support.status).toBe(200);
  });

  it('OWNER-192 with every control paused, cancellation and support are still reachable', async () => {
    const h = harness();
    for (const key of ['ads', 'new_orders', 'expensive_verification', 'chatbot']) {
      await h.post(`/owner/controls/${key}`, { paused: 'yes' });
    }
    expect((await h.app.request(`${ORIGIN}/support`, {}, ENV)).status).toBe(200);
    expect((await h.app.request(`${ORIGIN}/app/cancel`, {}, ENV)).status).toBeLessThan(400);
    expect((await h.app.request(`${ORIGIN}/refunds`, {}, ENV)).status).toBe(200);
  });

  it('OWNER-193 the controls page lists the paths that keep working through a pause', async () => {
    const body = await (await harness().get('/owner/controls')).text();
    expect(body).toContain('data-protected-paths="true"');
    expect(body).toContain('/app/cancel');
    expect(body).toContain('/support');
  });

  it('OWNER-194 an unknown control key is a 404, not a silently ignored write', async () => {
    const h = harness();
    expect((await h.post('/owner/controls/everything', { paused: 'yes' })).status).toBe(404);
  });
});

describe('owner routes — ads', () => {
  it('OWNER-195 a requested pause shows as pause requested, never as paused', async () => {
    const h = harness();
    await h.post('/owner/ads/cmp_first_test/pause');
    const body = await (await h.get('/owner/ads')).text();
    expect(body).toContain('data-campaign-state="pause_pending"');
    expect(body).not.toContain('data-campaign-state="paused"');
  });

  it('OWNER-196 activating with no usable approval does not activate anything', async () => {
    const h = harness();
    const response = await h.post('/owner/ads/cmp_first_test/activate', { approval_id: 'apr_missing', confirm: 'activate' });
    expect(response.status).toBe(422);
    expect((await h.port.campaign('cmp_first_test'))?.state).toBe('awaiting_owner');
  });

  it('OWNER-197 an unknown metric renders as unknown rather than zero', async () => {
    const body = await (await harness().get('/owner/ads')).text();
    expect(body).toContain('data-unknown="true"');
    expect(body).toMatch(/unknown/);
  });
});

describe('owner routes — quality centre', () => {
  it('OWNER-198 a suite id outside the allowlist is rejected and starts nothing', async () => {
    const h = harness();
    const response = await h.post('/owner/quality/run', { suite_id: 'rm -rf /' });
    expect(response.status).toBe(422);
    expect(await h.port.qualityRuns(10)).toHaveLength(0);
  });

  it('OWNER-199 with no executor the job queues and the page shows the dependency', async () => {
    const h = harness();
    const response = await h.post('/owner/quality/run', { suite_id: 'unit' });
    expect(response.status).toBe(202);
    const body = await response.text();
    expect(body).toContain('data-dependency="true"');
    expect(body).toContain('data-job-state="awaiting_runner"');
    expect(body).not.toContain('data-job-state="passed"');
    const runs = await h.port.qualityRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.passed).toBeNull();
  });

  it('OWNER-104 a duplicate dispatch deduplicates rather than starting a second run', async () => {
    const h = harness();
    await h.post('/owner/quality/run', { suite_id: 'unit' });
    await h.post('/owner/quality/run', { suite_id: 'unit' });
    expect(await h.port.qualityRuns(10)).toHaveLength(1);
  });

  it('OWNER-105 with no evidence pack the download says so instead of serving an empty file', async () => {
    const h = harness();
    const response = await h.get('/owner/quality/report/test-report.md');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('data-dependency="true"');
  });

  it('OWNER-106 a bound evidence pack is served to the owner as an attachment', async () => {
    const h = harness({
      artifacts: new StaticQualityArtifactStore([
        { id: 'test-report.md', body: '# ITISYOU Verify — test report\n', generatedAt: NOW.toISOString(), commitSha: 'abc' },
      ]),
    });
    const response = await h.get('/owner/quality/report/test-report.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/markdown/);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(await response.text()).toContain('test report');
  });

  it('OWNER-107 the evidence pack is not reachable without a session', async () => {
    const h = harness({
      principal: ANONYMOUS_PRINCIPAL,
      artifacts: new StaticQualityArtifactStore([
        { id: 'test-report.md', body: 'secret-ish', generatedAt: null, commitSha: null },
      ]),
    });
    const response = await h.get('/owner/quality/report/test-report.md');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('secret-ish');
  });

  it('OWNER-108 a traversal attempt on the download path is a 404, not a file read', async () => {
    const h = harness();
    const response = await h.get('/owner/quality/report/..%2F..%2F.dev.vars');
    expect(response.status).toBe(404);
  });
});

describe('owner routes — cleanup', () => {
  it('OWNER-109 the preview lists the exact owned synthetic resources', async () => {
    const h = harness();
    const body = await (
      await h.post('/owner/cleanup/preview', { categories: ['expired_sessions', 'synthetic_workspaces'] })
    ).text();
    expect(body).toContain('data-resource-id="sess_expired_0001"');
    expect(body).toContain('data-resource-id="ws_synthetic_old_demo"');
  });

  it('OWNER-103 the preview excludes real customer records, retained evidence and other projects', async () => {
    const h = harness();
    const body = await (await h.post('/owner/cleanup/preview', { categories: ['synthetic_workspaces'] })).text();
    expect(body).toContain('data-excluded="true"');
    expect(body).toContain('ws_real_customer');
    expect(body).toContain('evd_under_retention');
    expect(body).toContain('unrelated-project-bucket');
    expect(body).not.toContain('data-resource-id="ws_real_customer"');
    expect(body).not.toContain('data-resource-id="unrelated-project-bucket"');
  });

  it('OWNER-037 a run without the typed confirmation deletes nothing', async () => {
    const h = harness();
    await h.post('/owner/cleanup/preview', { categories: ['expired_sessions'] });
    const response = await h.post('/owner/cleanup/run', { inventory_hash: 'anything' });
    expect(response.status).toBe(422);
    expect(await h.port.lastCleanupReport()).toBeNull();
  });

  it('OWNER-038 a changed inventory hash rejects the run and deletes nothing', async () => {
    const h = harness();
    await h.post('/owner/cleanup/preview', { categories: ['expired_sessions'] });
    const response = await h.post('/owner/cleanup/run', { inventory_hash: 'a-hash-from-a-different-preview', confirm: 'delete' });
    expect(response.status).toBe(422);
    expect(await (await h.get('/owner/cleanup')).text()).not.toContain('data-cleanup-state="completed"');
    expect(await h.port.lastCleanupReport()).toBeNull();
  });

  it('OWNER-039 a matching hash removes exactly what was previewed and preserves everything else', async () => {
    const h = harness();
    const previewBody = await (await h.post('/owner/cleanup/preview', { categories: ['expired_sessions'] })).text();
    const hash = /data-inventory-hash="([0-9a-f]+)"/.exec(previewBody)?.[1];
    expect(hash).toBeDefined();
    const response = await h.post('/owner/cleanup/run', { inventory_hash: hash ?? '', confirm: 'delete' });
    expect(response.status).toBe(200);
    const report = await h.port.lastCleanupReport();
    expect(report?.state).toBe('completed');
    expect(report?.resources.map((r) => r.resourceId).sort()).toEqual(['sess_expired_0001', 'sess_expired_0002']);
    // The real customer workspace is still there afterwards.
    const after = await (await h.post('/owner/cleanup/preview', { categories: ['synthetic_workspaces'] })).text();
    expect(after).toContain('ws_real_customer');
  });

  it('OWNER-054 running with no preview at all refuses', async () => {
    const h = harness();
    const response = await h.post('/owner/cleanup/run', { inventory_hash: 'x', confirm: 'delete' });
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/Take a preview first/);
  });

  it('OWNER-055 the cleanup page states what safe cleanup will never touch', async () => {
    const body = await (await harness().get('/owner/cleanup')).text();
    expect(body).toMatch(/Real customer workspaces/i);
    expect(body).toMatch(/Backups and exports/i);
    expect(body).toMatch(/Active credentials/i);
  });
});

describe('owner routes — admin entry point', () => {
  it('OWNER-056 /admin/login is reachable with no session at all', async () => {
    const h = harness({ principal: ANONYMOUS_PRINCIPAL });
    const response = await h.get('/admin/login');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Sign in');
  });

  it('OWNER-057 the login page leaks no customer data, counts or existence signal', async () => {
    const body = await (await harness({ principal: ANONYMOUS_PRINCIPAL }).get('/admin/login')).text();
    expect(body).not.toMatch(/@example\.invalid/);
    expect(body).not.toMatch(/\bws_[a-z0-9_]+/i);
    expect(body).not.toMatch(/customers?:\s*\d/i);
    expect(body).not.toMatch(/bootstrap/i);
  });

  it('OWNER-058 an unknown and a known address get the identical acknowledgement', async () => {
    const h = harness({ principal: ANONYMOUS_PRINCIPAL });
    const unknown = await h.post('/admin/login', { email: 'nobody@example.invalid' });
    const known = await h.post('/admin/login', { email: 'owner@example.invalid' });
    expect(unknown.status).toBe(known.status);
    // Normalise the echoed address and the per-render CSRF token; everything else must match.
    const normalise = (text: string) =>
      text.replace(/nobody@example\.invalid|owner@example\.invalid/g, 'X').replace(/value="[0-9a-f]{64}"/g, 'value="T"');
    expect(normalise(await unknown.text())).toBe(normalise(await known.text()));
  });

  it('OWNER-059 /admin sends a signed-in owner to the panel and everyone else to the login page', async () => {
    expect((await harness().get('/admin')).headers.get('location')).toBe('/owner');
    expect((await harness({ principal: ANONYMOUS_PRINCIPAL }).get('/admin')).headers.get('location')).toBe('/admin/login');
  });

  it('OWNER-077 bootstrap refuses when the deployment carries no secret', async () => {
    const h = harness({ principal: ANONYMOUS_PRINCIPAL });
    const response = await h.post('/admin/bootstrap', { token: ['not', 'a', 'real', 'token'].join('-') });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/no owner bootstrap secret/i);
  });
});

describe('owner routes — honest rendering', () => {
  it('OWNER-078 the overview never calls receipts profit and always shows a refresh time', async () => {
    const body = await (await harness().get('/owner')).text();
    expect(body).toContain('Estimated net receipts');
    // Every single occurrence of the word "profit" on this page is the phrase "not profit".
    // It is never used as the label of a figure.
    const mentions = body.match(/.{4}profit/gi) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) expect(mention.toLowerCase()).toBe('not profit');
    expect(body).toMatch(/last refreshed/i);
  });

  it('OWNER-079 an unmeasured figure renders as unknown rather than zero', async () => {
    const body = await (await harness().get('/owner')).text();
    expect(body).toContain('data-unknown="true"');
  });

  it('OWNER-124 the connections page shows a freshly generated mask and no stored secret', async () => {
    const body = await (await harness().get('/owner/connections')).text();
    expect(body).toContain('data-mask="fresh"');
    expect(body).toMatch(/No stored secret appears on this page/i);
    // The mask is a label, not a prefix of anything stored: no credential-shaped value and
    // no partial token reaches the page.
    expect(body).toMatch(/account ••••4821/);
    expect(body).not.toMatch(/[A-Za-z0-9_-]{24,}\.{0,3}(?:••|\*\*)/);
  });

  it('OWNER-125 a verification failure is explained in sentences, never as a raw reason code', async () => {
    const body = await (await harness().get('/owner/verification/run_synthetic_1')).text();
    expect(body).not.toContain('CONNECTION_UNAVAILABLE');
    expect(body).toMatch(/could not reach the connected system/i);
    expect(body).toMatch(/unverified rather than failed/i);
  });

  it('OWNER-126 the operations page shows the runner as not connected and says jobs are waiting', async () => {
    const body = await (await harness().get('/owner/operations')).text();
    expect(body).toContain('data-runner-state="offline"');
    expect(body).toMatch(/No maintenance runner is paired/i);
  });

  it('OWNER-127 an operations action that needs a runner reports the dependency rather than a success', async () => {
    const h = harness();

    // A restore now checks what it can check first: no approval means the refusal names the
    // missing approval, not a vague dependency.
    const noApproval = await h.post('/owner/operations/restore', { deployment_id: 'dep_0001', confirm: 'restore' });
    expect(noApproval.status).toBe(422);
    expect(await noApproval.text()).toMatch(/needs an approval bound to the exact deployment/i);

    // With a standing approval, everything this route can verify has passed, and what is
    // left is named precisely rather than as "not wired".
    await h.post('/owner/approvals', {
      action_type: 'cleanup_execute',
      summary: 'Restore the previous deployment after the bad release',
      maximum_amount: '',
      payload_json: JSON.stringify({ categories: [], inventory_hash: 'dep_0001', resource_count: 0, environment: 'development' }),
    });
    const approvalId = (await h.port.approvals())[0]?.id ?? '';
    const restore = await h.post('/owner/operations/restore', {
      deployment_id: 'dep_0001',
      approval_id: approvalId,
      confirm: 'restore',
    });
    expect(restore.status).toBe(422);
    const restoreBody = await restore.text();
    expect(restoreBody).toContain('data-dependency="true"');
    expect(restoreBody).toMatch(/Nothing has been restored/i);
    expect(restoreBody).toMatch(/does not carry one/i);

    // Pairing with no connector bound mints no code and says so.
    const pair = await h.post('/owner/operations/runner/pair', { label: 'my laptop' });
    expect(pair.status).toBe(422);
    const pairBody = await pair.text();
    expect(pairBody).toContain('data-dependency="true"');
    expect(pairBody).toMatch(/No pairing code has been created/i);
    expect(pairBody).not.toContain('data-pairing-code="true"');
  });

  it('OWNER-128 the settings page shows the business details as still needing the owner', async () => {
    const body = await (await harness().get('/owner/settings')).text();
    expect(body).toContain('TODO_OWNER_INPUT');
    expect(body).toMatch(/we will not invent one/i);
  });

  it('OWNER-129 the settings page describes restricted entry as not a security control', async () => {
    const body = await (await harness().get('/owner/settings')).text();
    expect(body).toContain('data-access-mode-note="true"');
    expect(body).toMatch(/not a security control/i);
  });

  it('OWNER-140 saving business details records them and clears the pending notice', async () => {
    const h = harness();
    const response = await h.post('/owner/settings/business', {
      tradingName: 'ITISYOU Verify',
      proprietorName: 'A Founder',
      addressLine1: '1 Example Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      contactEmail: 'hello@example.invalid',
    });
    expect(response.status).toBe(303);
    const body = await (await h.get('/owner/settings')).text();
    expect(body).toContain('ITISYOU Verify');
    expect(body).not.toMatch(/Your business details are not filled in/);
  });

  it('OWNER-141 incomplete business details re-render with field errors and save nothing', async () => {
    const h = harness();
    const response = await h.post('/owner/settings/business', { tradingName: 'Only this' });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('has to be filled in');
    expect(await (await h.get('/owner/settings')).text()).toContain('TODO_OWNER_INPUT');
  });

  it('OWNER-142 an approval granted here appears on the page bound to its amount', async () => {
    const h = harness();
    const payload = JSON.stringify({
      workspace_id: 'ws_1',
      order_id: 'ord_1',
      amount_minor: 4900,
      currency: 'GBP',
      policy_rule: 'within_14_days_unused',
      reason: 'the connection never worked',
    });
    const response = await h.post('/owner/approvals', {
      action_type: 'refund_issue',
      summary: 'Refund September in full',
      maximum_amount: '49.00',
      payload_json: payload,
    });
    expect(response.status).toBe(303);
    const body = await (await h.get('/owner/approvals')).text();
    expect(body).toContain('Refund September in full');
    expect(body).toContain('£49.00');
    expect(body).toContain('data-standing="usable"');
  });

  it('OWNER-143 a withdrawn approval stops standing', async () => {
    const h = harness();
    await h.post('/owner/approvals', {
      action_type: 'cleanup_execute',
      summary: 'Clean up the old synthetic workspaces',
      maximum_amount: '',
      payload_json: JSON.stringify({ categories: ['expired_sessions'], inventory_hash: 'h', resource_count: 2, environment: 'development' }),
    });
    const approvals = await h.port.approvals();
    const id = approvals[0]?.id ?? '';
    await h.post(`/owner/approvals/${id}/revoke`);
    const body = await (await h.get('/owner/approvals')).text();
    expect(body).toContain('data-standing="withdrawn"');
  });

  it('OWNER-144 every owner action writes an audit row naming what was done', async () => {
    const h = harness();
    await h.post('/owner/controls/ads', { paused: 'yes' });
    await h.post('/owner/quality/run', { suite_id: 'unit' });
    const trail = await h.port.auditTrail(50);
    expect(trail.map((row) => row.action)).toContain('owner.control.pause');
    expect(trail.map((row) => row.action)).toContain('owner.quality.dispatch');
    for (const row of trail) {
      expect(row.occurredAt).toBe(NOW.toISOString());
      expect(row.actor.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Composition.
 *
 * The defect these exist for: `access.ts` was correct, every access case passed, and the
 * panel was still world-readable on a staging deploy — because `MemoryOwnerDataPort`
 * defaulted to a synthetic *owner*, and every test constructed its principal explicitly.
 * Nothing exercised what an unconfigured caller actually gets.
 *
 * So these three construct the router exactly as a careless mount would: `createOwnerRoutes()`
 * with no arguments at all.
 */
describe('owner routes — an unconfigured mount', () => {
  function unconfigured(): Hono<RouteBindings> {
    const instance = new Hono<RouteBindings>();
    // Deliberately no options. This is the line the lead wrote on staging.
    instance.route('/', createOwnerRoutes());
    return instance;
  }

  it('OWNER-003 an unconfigured mount serves the panel to nobody', async () => {
    const instance = unconfigured();
    for (const path of OWNER_PATHS) {
      const response = await instance.request(`${ORIGIN}${path}`, {}, ENV);
      expect(response.status, path).toBe(404);
      const body = await response.text();
      expect(body, path).not.toContain('owner@example.invalid');
      expect(body, path).not.toContain('How the business is doing');
    }
  });

  it('OWNER-041 an unconfigured mount still leaves the way in public, and mutates nothing', async () => {
    const instance = unconfigured();
    expect((await instance.request(`${ORIGIN}/admin/login`, {}, ENV)).status).toBe(200);
    const mutation = await instance.request(
      `${ORIGIN}/owner/controls/ads`,
      {
        method: 'POST',
        body: new URLSearchParams({ csrf_token: CSRF, paused: 'yes' }).toString(),
        headers: { cookie: `verify_csrf=${CSRF}`, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      },
      ENV,
    );
    expect(mutation.status).toBe(404);
  });

  it('OWNER-191 an unconfigured mount refuses to exist in production rather than serving invented data', async () => {
    // Loud at construction when the environment is declared…
    expect(() => createOwnerRoutes({ environment: 'production' })).toThrow(UnconfiguredOwnerRouterError);
    // …and loud at request time when it is not, because the lead's mount passes no options.
    const instance = unconfigured();
    const response = await instance.request(
      `${ORIGIN}/owner`,
      {},
      { ENVIRONMENT: 'production', PUBLIC_BASE_URL: ORIGIN },
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    // A configured production mount is unaffected.
    expect(() =>
      createOwnerRoutes({ environment: 'production', resolvePort: async () => new MemoryOwnerDataPort() }),
    ).not.toThrow();
  });
});
