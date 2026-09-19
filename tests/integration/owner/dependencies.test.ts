/**
 * Controls that became real, and dependencies that became sharper.
 *
 * ## The id block
 *
 * `OWNER-001..199` is full and A08 holds `OWNER-201..224`. This continuation takes
 * **`OWNER-230..279`**, leaving `225..229` as a gap so A08 can extend its own block without
 * meeting mine. Flagged to the lead rather than assumed.
 *
 * ## What is under test
 *
 * Every case here is about the same property, from both sides: a control either does a real
 * thing that can be observed afterwards, or it names a dependency that is genuinely
 * outstanding. Nothing renders a success it did not earn, and nothing renders a vague
 * blocker where a specific one is knowable.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { MemoryOwnerDataPort, syntheticOwnerPrincipal } from '@app/owner/memory';
import {
  D1QualityArtifactStore,
  QUALITY_ARTIFACTS_MIGRATION_HINT,
  StaticQualityArtifactStore,
  UnboundQualityArtifactStore,
  type ArtifactQueryable,
} from '@app/owner/quality';
import {
  NOTIFICATION_STUCK_AFTER_SECONDS,
  NotificationHealthUnavailable,
  StaticNotificationHealth,
  SupportNotificationHealth,
  suggestedActionFor,
} from '@app/owner/notifications';
import type { MaintenanceRunnerPort, RunnerJobView, RunnerStatus } from '@app/owner/runner';
import type { OwnerPrincipal } from '@app/owner/access';
import type { RouteBindings } from '@app/routes/public/shared';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-owner-dependency-tests';
const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

function ownerPrincipal(): OwnerPrincipal {
  return { ...syntheticOwnerPrincipal(NOW), csrfToken: CSRF };
}

/** A runner that is genuinely there. The point of the fixture is that jobs get claimed. */
class ConnectedRunner implements MaintenanceRunnerPort {
  readonly enqueued: { kind: string; idempotencyKey: string }[] = [];
  #jobs: RunnerJobView[] = [];
  #counter = 0;

  async status(): Promise<RunnerStatus> {
    return {
      connected: true,
      deviceLabel: 'the founder laptop',
      lastHeartbeatAt: new Date(NOW.getTime() - 20_000).toISOString(),
      heartbeatAgeSeconds: 20,
      currentJob: null,
      lastSuccessAt: new Date(NOW.getTime() - 600_000).toISOString(),
      queuedJobs: this.#jobs.length,
      unavailableReason: null,
    };
  }

  async listJobs(limit: number): Promise<readonly RunnerJobView[]> {
    return this.#jobs.slice(0, limit);
  }

  async enqueue(input: {
    readonly kind: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly idempotencyKey: string;
  }) {
    const existing = this.enqueued.find((e) => e.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) {
      const job = this.#jobs.find((j) => j.kind === existing.kind);
      if (job !== undefined) return { ok: true as const, job, deduplicated: true };
    }
    this.#counter += 1;
    const job: RunnerJobView = {
      id: `mjb_${this.#counter}`,
      kind: input.kind,
      state: 'queued',
      requestedBy: input.requestedBy,
      createdAt: input.at,
      startedAt: null,
      endedAt: null,
      blockedReason: null,
    };
    this.#jobs.unshift(job);
    this.enqueued.push({ kind: input.kind, idempotencyKey: input.idempotencyKey });
    return { ok: true as const, job, deduplicated: false };
  }
}

interface Harness {
  readonly app: Hono<RouteBindings>;
  readonly port: MemoryOwnerDataPort;
  get(path: string): Promise<Response>;
  post(path: string, fields?: Record<string, string>): Promise<Response>;
}

function harness(options: { port?: MemoryOwnerDataPort; artifacts?: UnboundQualityArtifactStore | StaticQualityArtifactStore | D1QualityArtifactStore } = {}): Harness {
  const port = options.port ?? new MemoryOwnerDataPort({ principal: ownerPrincipal(), now: () => NOW });
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
    app,
    port,
    get: async (path) => app.request(`${ORIGIN}${path}`, { headers: { cookie } }, ENV),
    post: async (path, fields = {}) => {
      const body = new URLSearchParams({ csrf_token: CSRF, ...fields });
      return app.request(
        `${ORIGIN}${path}`,
        {
          method: 'POST',
          body: body.toString(),
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        },
        ENV,
      );
    },
  };
}

describe('the runner turns queued-forever into genuinely queued', () => {
  it('OWNER-230 with a connected runner a test suite dispatch really queues a job', async () => {
    const runner = new ConnectedRunner();
    const port = new MemoryOwnerDataPort({ principal: ownerPrincipal(), now: () => NOW, runner });
    const h = harness({ port });

    // The quality centre re-renders rather than redirecting, so the owner sees the run it
    // just started on the same screen.
    const response = await h.post('/owner/quality/run', { suite_id: 'unit' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('data-job-state="queued"');
    expect(body).not.toContain('data-job-state="awaiting_runner"');

    const runs = await port.qualityRuns(10);
    expect(runs[0]?.state).toBe('queued');
    expect(runs[0]?.blockedReason).toBeNull();
    // The real artefact: something was actually asked to run it.
    expect(runner.enqueued.map((e) => e.kind)).toEqual(['run_test_suite']);
  });

  it('OWNER-231 with no runner the same dispatch queues and names the runner’s own reason', async () => {
    const h = harness();
    const response = await h.post('/owner/quality/run', { suite_id: 'unit' });
    expect(response.status).toBe(202);
    const runs = await h.port.qualityRuns(10);
    expect(runs[0]?.state).toBe('awaiting_runner');
    // Not a sentence this panel made up — the runner port's own explanation.
    expect(runs[0]?.blockedReason).toMatch(/No maintenance runner is paired/i);
    expect(runs[0]?.passed).toBeNull();
  });

  it('OWNER-232 executor availability is read from the runner, not hard-coded', async () => {
    const connected = new MemoryOwnerDataPort({
      principal: ownerPrincipal(),
      now: () => NOW,
      runner: new ConnectedRunner(),
    });
    const offline = new MemoryOwnerDataPort({ principal: ownerPrincipal(), now: () => NOW });

    await harness({ port: connected }).post('/owner/quality/run', { suite_id: 'security' });
    await harness({ port: offline }).post('/owner/quality/run', { suite_id: 'security' });

    expect((await connected.qualityRuns(1))[0]?.state).toBe('queued');
    expect((await offline.qualityRuns(1))[0]?.state).toBe('awaiting_runner');
  });

  it('OWNER-233 a dedupe key survives the runner hand-off, so a double press queues one job', async () => {
    const runner = new ConnectedRunner();
    const port = new MemoryOwnerDataPort({ principal: ownerPrincipal(), now: () => NOW, runner });
    const h = harness({ port });
    await h.post('/owner/quality/run', { suite_id: 'unit' });
    await h.post('/owner/quality/run', { suite_id: 'unit' });
    expect(await port.qualityRuns(10)).toHaveLength(1);
    expect(runner.enqueued).toHaveLength(1);
  });

  it('OWNER-234 running health checks is a real action once a runner is connected', async () => {
    const runner = new ConnectedRunner();
    const port = new MemoryOwnerDataPort({ principal: ownerPrincipal(), now: () => NOW, runner });
    const h = harness({ port });

    const response = await h.post('/owner/operations/jobs/run_health_checks');
    expect(response.status).toBe(303);
    expect(runner.enqueued.map((e) => e.kind)).toContain('run_health_checks');
    expect((await port.auditTrail(10)).map((row) => row.action)).toContain('owner.maintenance.enqueue');
  });

  it('OWNER-235 with no runner the job is still written down and says what it waits for', async () => {
    const h = harness();
    const response = await h.post('/owner/operations/jobs/collect_redacted_diagnostics');
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('data-dependency="true"');
    expect(body).toMatch(/will run when a runner is connected/i);
    expect(body).toMatch(/nothing has run yet/i);
  });

  it('OWNER-236 a job kind outside the one-press list is a 404, not a refusal that maps the vocabulary', async () => {
    const h = harness();
    expect((await h.post('/owner/operations/jobs/execute_approved_release')).status).toBe(404);
    expect((await h.post('/owner/operations/jobs/prepare_patch')).status).toBe(404);
    expect((await h.post('/owner/operations/jobs/rm%20-rf')).status).toBe(404);
  });

  it('OWNER-237 the operations page shows a connected runner as connected, with its device and last success', async () => {
    const port = new MemoryOwnerDataPort({
      principal: ownerPrincipal(),
      now: () => NOW,
      runner: new ConnectedRunner(),
    });
    const body = await (await harness({ port }).get('/owner/operations')).text();
    expect(body).toContain('data-runner-state="connected"');
    expect(body).toContain('the founder laptop');
    expect(body).not.toMatch(/No maintenance runner is paired/i);
  });
});

describe('restoring a deployment names what is actually missing', () => {
  it('OWNER-240 a restore with no approval is refused for that reason, not a vague dependency', async () => {
    const h = harness();
    const response = await h.post('/owner/operations/restore', { deployment_id: 'dep_0001', confirm: 'restore' });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toMatch(/needs an approval bound to the exact deployment/i);
    expect(body).not.toContain('data-dependency="true"');
  });

  it('OWNER-241 a restore quoting an expired approval says the approval lapsed', async () => {
    const h = harness();
    await h.post('/owner/approvals', {
      action_type: 'cleanup_execute',
      summary: 'Restore the previous deployment',
      maximum_amount: '',
      payload_json: JSON.stringify({ categories: [], inventory_hash: 'dep_0001', resource_count: 0, environment: 'development' }),
    });
    const id = (await h.port.approvals())[0]?.id ?? '';
    await h.post(`/owner/approvals/${id}/revoke`);

    const response = await h.post('/owner/operations/restore', {
      deployment_id: 'dep_0001',
      approval_id: id,
      confirm: 'restore',
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/withdrawn/i);
  });

  it('OWNER-242 with everything checkable checked, the remaining gap is named as one field', async () => {
    const h = harness();
    await h.post('/owner/approvals', {
      action_type: 'cleanup_execute',
      summary: 'Restore the previous deployment',
      maximum_amount: '',
      payload_json: JSON.stringify({ categories: [], inventory_hash: 'dep_0001', resource_count: 0, environment: 'development' }),
    });
    const id = (await h.port.approvals())[0]?.id ?? '';
    const response = await h.post('/owner/operations/restore', {
      deployment_id: 'dep_0001',
      approval_id: id,
      confirm: 'restore',
    });
    const body = await response.text();
    expect(body).toContain('data-dependency="true"');
    expect(body).toMatch(/does not carry one/i);
    expect(body).toMatch(/wrangler rollback/);
    expect(body).toMatch(/nothing is pretending to have been/i);
  });

  it('OWNER-243 the restore form asks for the approval rather than discovering it too late', async () => {
    const body = await (await harness().get('/owner/operations')).text();
    expect(body).toMatch(/name="approval_id"/);
    expect(body).toMatch(/changes what every customer is served/i);
  });
});

describe('the evidence pack has a real home', () => {
  const PACK = [
    { id: 'test-report.md' as const, body: '# report\n1498 passed\n', generatedAt: NOW.toISOString(), commitSha: 'abc123def456' },
  ];

  function d1(rows: Record<string, { body: string; commit_sha: string | null; generated_at: string | null }[]> | null): ArtifactQueryable {
    return {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async all<T>(): Promise<{ results: T[] }> {
                if (rows === null) throw new Error('no such table: quality_artifacts');
                if (sql.includes('LIMIT 1')) {
                  const any = Object.values(rows).flat();
                  return { results: any.slice(0, 1) as T[] };
                }
                const id = String(values[0] ?? '');
                return { results: (rows[id] ?? []) as T[] };
              },
            };
          },
        };
      },
    };
  }

  it('OWNER-250 a missing table is reported as a missing migration, not as an empty pack', async () => {
    const store = new D1QualityArtifactStore(d1(null));
    expect(await store.get('test-report.md')).toBeNull();
    expect(await store.unavailableReason()).toBe(QUALITY_ARTIFACTS_MIGRATION_HINT);
    expect(QUALITY_ARTIFACTS_MIGRATION_HINT).toMatch(/quality_artifacts table/);
  });

  it('OWNER-251 an empty table is reported as "upload a pack", which is a different instruction', async () => {
    const store = new D1QualityArtifactStore(d1({}));
    const reason = await store.unavailableReason();
    expect(reason).toMatch(/no evidence pack has been uploaded/i);
    expect(reason).not.toBe(QUALITY_ARTIFACTS_MIGRATION_HINT);
  });

  it('OWNER-252 a stored artifact is reassembled from its parts in order', async () => {
    const store = new D1QualityArtifactStore(
      d1({
        'test-results.json': [
          { body: '{"a":', commit_sha: 'abc', generated_at: NOW.toISOString() },
          { body: '1}', commit_sha: 'abc', generated_at: NOW.toISOString() },
        ],
      }),
    );
    const stored = await store.get('test-results.json');
    expect(stored?.body).toBe('{"a":1}');
    expect(stored?.commitSha).toBe('abc');
    expect(await store.unavailableReason()).toBeNull();
  });

  it('OWNER-253 a bound pack downloads authenticated, with the commit it was produced from', async () => {
    const h = harness({ artifacts: new StaticQualityArtifactStore(PACK) });
    const response = await h.get('/owner/quality/report/test-report.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-report-generated-at')).toBe(NOW.toISOString());
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(await response.text()).toContain('1498 passed');
  });

  it('OWNER-254 the quality page names the migration when that is what is missing', async () => {
    const h = harness({ artifacts: new D1QualityArtifactStore(d1(null)) });
    const body = await (await h.get('/owner/quality')).text();
    expect(body).toContain('data-dependency="true"');
    expect(body).toMatch(/quality_artifacts table/);
  });

  it('OWNER-255 an unbound store still refuses to serve an empty file', async () => {
    const h = harness({ artifacts: new UnboundQualityArtifactStore() });
    const response = await h.get('/owner/quality/report/junit.xml');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('<?xml');
  });
});

describe('the launch funnel is four numbers, never one', () => {
  it('OWNER-260 all four are rendered separately and labelled', async () => {
    const body = await (await harness().get('/owner')).text();
    expect(body).toContain('data-launch-metric="People who visited"');
    expect(body).toContain('data-launch-metric="Of those, arrived from an advert"');
    expect(body).toContain('data-launch-metric="Created a workspace and connected something"');
    expect(body).toContain('data-launch-metric="Paying customers"');
  });

  it('OWNER-261 the page says plainly that a visit is not interest and interest is not a customer', async () => {
    const body = await (await harness().get('/owner')).text();
    expect(body).toMatch(/A visit is not interest, and interest is not a\s+customer/);
    expect(body).toMatch(/only one of the four that is income/i);
  });

  it('OWNER-262 an unmeasured launch figure is unknown, never zero', async () => {
    const view = await harness().port.overview(NOW);
    expect(view.launch.totalVisits.value).toBeNull();
    expect(view.launch.adAttributedVisits.value).toBeNull();
    expect(view.launch.qualifiedSignups.value).toBeNull();
    expect(view.launch.payingCustomers.value).toBeNull();
    const body = await (await harness().get('/owner')).text();
    expect((body.match(/data-unknown="true"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('OWNER-263 ad-attributed visits are described as a subset, not a separate total', async () => {
    const body = await (await harness().get('/owner')).text();
    expect(body).toMatch(/subset of the figure above, not a separate total/i);
  });
});

describe('at-most-once sending makes the owner the retry', () => {
  const STUCK = [
    {
      id: 'ntf_1',
      template: 'deletion_complete',
      channel: 'email',
      workspaceId: 'ws_1',
      createdAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
      attemptCount: 1,
      providerStatus: null,
    },
    {
      id: 'ntf_2',
      template: 'export_ready',
      channel: 'email',
      workspaceId: 'ws_2',
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
      attemptCount: 1,
      providerStatus: 'accepted',
    },
  ];

  it('OWNER-270 a row older than the threshold is stuck; a recent one is still in flight', async () => {
    const health = await new StaticNotificationHealth(STUCK).health({
      now: NOW,
      stuckAfterSeconds: NOTIFICATION_STUCK_AFTER_SECONDS,
    });
    expect(health.stuck.map((row) => row.id)).toEqual(['ntf_1']);
    expect(health.inFlight).toBe(1);
    expect(health.unavailableReason).toBeNull();
  });

  it('OWNER-271 an unavailable read is reported as not-checked, never as nothing-wrong', async () => {
    const health = await new NotificationHealthUnavailable().health();
    expect(health.stuck).toHaveLength(0);
    expect(health.unavailableReason).toMatch(/nothing has been checked/i);
    expect(health.unavailableReason).toMatch(/not reassurance/i);
  });

  it('OWNER-272 the live read asks A09 for rows older than the threshold and orders the oldest first', async () => {
    const asked: { createdBefore: string; limit: number }[] = [];
    const port = new SupportNotificationHealth({
      async listStalePendingNotifications(query) {
        asked.push(query);
        return STUCK;
      },
    });
    const health = await port.health({ now: NOW, stuckAfterSeconds: NOTIFICATION_STUCK_AFTER_SECONDS });
    expect(asked[0]?.createdBefore).toBe(new Date(NOW.getTime() - NOTIFICATION_STUCK_AFTER_SECONDS * 1000).toISOString());
    expect(health.stuck[0]?.id).toBe('ntf_1');
    expect(health.stuck[0]?.ageSeconds).toBeGreaterThan(health.stuck[1]?.ageSeconds ?? 0);
  });

  it('OWNER-273 a read that throws is unknown, not an empty all-clear', async () => {
    const port = new SupportNotificationHealth({
      async listStalePendingNotifications() {
        throw new Error('database unavailable');
      },
    });
    const health = await port.health({ now: NOW, stuckAfterSeconds: NOTIFICATION_STUCK_AFTER_SECONDS });
    expect(health.unavailableReason).toMatch(/treat it as unknown/i);
    expect(health.stuck).toHaveLength(0);
  });

  it('OWNER-274 the operations page shows stuck rows with what to do about each one', async () => {
    const port = new MemoryOwnerDataPort({
      principal: ownerPrincipal(),
      now: () => NOW,
      notifications: new StaticNotificationHealth(STUCK),
    });
    const body = await (await harness({ port }).get('/owner/operations')).text();
    expect(body).toContain('data-notifications-state="stuck"');
    expect(body).toContain('deletion_complete');
    expect(body).toMatch(/You are the retry/i);
    expect(body).toMatch(/nothing will try again on its own/i);
    expect(body).toContain(suggestedActionFor('deletion_complete'));
  });

  it('OWNER-275 an unchecked queue says so on the page rather than showing an empty table', async () => {
    const body = await (await harness().get('/owner/operations')).text();
    expect(body).toContain('data-notifications-state="unknown"');
    expect(body).toContain('data-dependency="true"');
    expect(body).not.toMatch(/Nothing is stuck/);
  });

  it('OWNER-276 a checked and genuinely empty queue says it was actually checked', async () => {
    const port = new MemoryOwnerDataPort({
      principal: ownerPrincipal(),
      now: () => NOW,
      notifications: new StaticNotificationHealth([]),
    });
    const body = await (await harness({ port }).get('/owner/operations')).text();
    expect(body).toContain('data-notifications-state="clear"');
    expect(body).toMatch(/it is not an empty list from a read that did not run/i);
  });

  it('OWNER-277 no stuck row ever carries a recipient address', async () => {
    const port = new MemoryOwnerDataPort({
      principal: ownerPrincipal(),
      now: () => NOW,
      notifications: new StaticNotificationHealth(STUCK),
    });
    const body = await (await harness({ port }).get('/owner/operations')).text();
    // Scoped to the card itself: the page header legitimately shows the signed-in owner
    // their own address, and that is not what this case is about.
    const start = body.indexOf('data-notifications-state=');
    const card = body.slice(start, body.indexOf('Queued maintenance jobs', start));
    expect(card.length).toBeGreaterThan(100);
    // A09 hands us a hash, never an address, and nothing here reverses that.
    expect(card).not.toMatch(/[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});
