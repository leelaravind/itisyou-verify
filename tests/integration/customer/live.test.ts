/**
 * Live pages: does a run page, and the workspace, move without a reload?
 *
 * ## What was wrong
 *
 * The run page told the customer "this page does not move on its own; reload it". A test
 * verification checked on a minute cron, with a backoff from thirty seconds, so the reader
 * pressed a button, landed on a page that said "still checking", and saw nothing happen.
 * The workspace counters were a snapshot too, and by default counted only automation runs,
 * so three pending TEST runs sat behind "0 pending".
 *
 * What is asserted here:
 *  - admitting a test verification starts its first check at once, not at the next tick;
 *  - the run's live endpoint reports the row as it is, checks a DUE run and leaves a run
 *    that is not due alone, and is scoped to the caller's workspace;
 *  - the workspace endpoint's fingerprint moves when a run is admitted, and names pending
 *    test runs separately; the automation view says in words that tests are still checking;
 *  - pages carry the live root and the one hash-pinned script, and the CSP carries its hash;
 *    a re-render answering a form post does not claim to be live.
 *
 * Case ids `VERIFY-920..VERIFY-927`.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_SCRIPT } from '@verify/ui';
import { hashToken, toBase64 } from '@verify/security';
import { seedWorkspace } from '../db/harness.js';
import {
  BASE,
  SESSION_VALUE,
  getSignedIn,
  postSignedIn,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness.js';
import worker from '../../../apps/app/src/index.js';
import { standardRules } from '../scheduler/harness.js';

const HUBSPOT_TOKEN = ['pat', 'eu1', '00000000-0000-4000-8000-000000000041'].join('-');
const RESEND_KEY = ['re', '0000000000000000000000000000000041'].join('_');
const ENV = { CREDENTIAL_KEY_V1: toBase64(new Uint8Array(32).fill(41)) } as const;
const PROPERTY = 'verify_correlation_id';
const MESSAGE = '5a0c1f7e-5a41-4c0e-9d3a-2f6b7c8d9e41';

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
  vi.unstubAllGlobals();
});

/** Providers that answer: HubSpot has the contact, Resend has the message delivered. */
function stubProviders(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(`${url.hostname}${url.pathname}`);
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname.endsWith('/access-token-info'))
      return json({ hubId: 4141, scopes: ['crm.objects.contacts.read'] });
    if (url.pathname === '/domains') return json({ data: [] });
    if (url.pathname.startsWith('/crm/v3/objects/contacts/')) {
      return json({
        id: '4101',
        properties: {
          [PROPERTY]: 'ENQ-LIVE-1',
          email: 'ada@example.test',
          createdate: '2026-09-19T09:00:00.000Z',
        },
        createdAt: '2026-09-19T09:00:00.000Z',
        archived: false,
      });
    }
    if (url.pathname === `/emails/${MESSAGE}`) {
      return json({
        id: MESSAGE,
        to: ['ada@example.test'],
        created_at: '2026-09-19T09:00:05.000Z',
        last_event: 'delivered',
      });
    }
    return new Response('{}', { status: 404 });
  });
  return { calls };
}

async function ready(): Promise<SignedIn> {
  open = await signedInWorkspace({ consumed: 0 });
  open.h.raw
    .prepare('UPDATE workflow_versions SET rules_json = ? WHERE workspace_id = ?')
    // A real rule set, one check per provider: an empty one is decided without reading
    // either, which would make every assertion below about a run nobody looked at.
    .run(JSON.stringify(standardRules()), open.workspaceId);
  for (const [provider, access_token] of [
    ['hubspot', HUBSPOT_TOKEN],
    ['resend', RESEND_KEY],
  ] as const) {
    stubProviders();
    const served = await postSignedIn(
      open,
      '/app/onboarding/connect',
      { provider, intent: 'credentials', access_token },
      { env: ENV },
    );
    expect(served.status).toBe(200);
    vi.unstubAllGlobals();
  }
  return open;
}

async function startTest(session: SignedIn): Promise<string> {
  const served = await postSignedIn(
    session,
    '/app/test-verification',
    {
      crmRecordId: '4101',
      correlationValue: 'ENQ-LIVE-1',
      messageId: MESSAGE,
      expectedRecipient: 'ada@example.test',
      submissionId: crypto.randomUUID(),
    },
    { csrfSourcePath: '/app', env: ENV },
  );
  // A successful start answers 303 to the run; the harness does not follow redirects.
  expect(served.status, visibleText(served.html).slice(0, 400)).toBe(303);
  const row = session.h.raw
    .prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 1')
    .get() as { id: string };
  return row.id;
}

function runRow(
  session: SignedIn,
  id: string,
): { status: string; observation_count: number; revision: number; next_check_at: string | null } {
  return session.h.raw
    .prepare('SELECT status, observation_count, revision, next_check_at FROM runs WHERE id = ?')
    .get(id) as never;
}

/** Background work is not awaited by the harness; wait for its effect instead. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function getJson(
  session: SignedIn,
  path: string,
  cookie = `__Host-verify_session=${SESSION_VALUE}`,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, { headers: { cookie, accept: 'application/json' } }),
    {
      ASSETS: { fetch: async () => new Response('', { status: 404 }) },
      DB: session.h.db,
      ENVIRONMENT: 'test',
      PUBLIC_BASE_URL: BASE,
      STRIPE_MODE: 'test',
      ...ENV,
    } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { html: text };
  }
  return { status: response.status, body };
}

describe('live pages', () => {
  it('VERIFY-920 admitting a test verification starts its first check at once, not at the next tick', async () => {
    const session = await ready();
    const provider = stubProviders();
    const id = await startTest(session);
    await until(() => runRow(session, id).observation_count >= 1);
    // The providers were read before any tick could have run: the harness has no cron.
    expect(provider.calls.some((call) => call.startsWith('api.hubapi.com'))).toBe(true);
  });

  it('VERIFY-921 the run live endpoint reports the row as it is, and its token moves when the run does', async () => {
    const session = await ready();
    stubProviders();
    const id = await startTest(session);
    await until(() => runRow(session, id).observation_count >= 1);
    const row = runRow(session, id);

    const live = await getJson(session, `/app/runs/${id}/live`);
    expect(live.status).toBe(200);
    expect(live.body['token']).toBe(`${String(row.revision)}:${row.status}`);
    expect(live.body['checks']).toBe(row.observation_count);
    expect(live.body['active']).toBe(row.status === 'PENDING');
  });

  it('VERIFY-922 polling checks a DUE run and leaves a run that is not due alone', async () => {
    const session = await ready();
    const provider = stubProviders();
    const id = await startTest(session);
    await until(() => runRow(session, id).observation_count >= 1);
    // Keep it pending and make its next check far away: polling must not buy a check.
    session.h.raw
      .prepare(
        "UPDATE runs SET status = 'PENDING', next_check_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(id);
    const before = provider.calls.length;
    const countBefore = runRow(session, id).observation_count;
    for (let poll = 0; poll < 5; poll += 1) await getJson(session, `/app/runs/${id}/live`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.calls.length, 'a poll bought a check that was not due').toBe(before);
    expect(runRow(session, id).observation_count).toBe(countBefore);

    // Now due: one poll starts the check.
    session.h.raw
      .prepare("UPDATE runs SET next_check_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(id);
    await getJson(session, `/app/runs/${id}/live`);
    await until(() => runRow(session, id).observation_count > countBefore);
  });

  it("VERIFY-923 another workspace's run, or no session, gets nothing from the live endpoints", async () => {
    const session = await ready();
    stubProviders();
    const id = await startTest(session);
    const signedOut = await getJson(session, `/app/runs/${id}/live`, '');
    expect(signedOut.status).toBe(401);
    // Another tenant: a second workspace with its own member and session, asking for
    // this workspace's run id.
    const other = seedWorkspace(session.h, 'other', { createdAt: '2026-09-19T10:00:00.000Z' });
    const otherSession = await hashToken('other-tenant-session', 'session');
    session.h.raw
      .prepare(
        'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        otherSession,
        other.userId,
        '2026-09-19T10:00:00.000Z',
        '2099-01-01T00:00:00.000Z',
        '2026-09-19T10:00:00.000Z',
      );
    const foreign = await getJson(
      session,
      `/app/runs/${id}/live`,
      '__Host-verify_session=other-tenant-session',
    );
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(id);
  });

  it('VERIFY-924 the workspace fingerprint moves when a run is admitted, and names pending tests separately', async () => {
    const session = await ready();
    const before = await getJson(session, '/app/live');
    expect(before.status).toBe(200);
    expect(before.body['active']).toBe(false);

    stubProviders();
    const id = await startTest(session);
    session.h.raw
      .prepare(
        "UPDATE runs SET status = 'PENDING', next_check_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(id);
    const after = await getJson(session, '/app/live');
    expect(after.body['token']).not.toBe(before.body['token']);
    expect(after.body['active']).toBe(true);
    expect(after.body['pendingTests']).toBe(1);
    expect(after.body['pendingAutomation']).toBe(0);

    // The automation view does not count the test, and says so in words.
    const served = await getSignedIn(session, '/app');
    expect(visibleText(served.html)).toContain('1 test run is still being checked');
  });

  it('VERIFY-925 a pending run page carries the live root and the one hash-pinned script, and the CSP allows exactly it', async () => {
    const session = await ready();
    stubProviders();
    const id = await startTest(session);
    session.h.raw
      .prepare(
        "UPDATE runs SET status = 'PENDING', next_check_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(id);
    const response = await worker.fetch(
      new Request(`${BASE}/app/runs/${id}`, {
        headers: { cookie: `__Host-verify_session=${SESSION_VALUE}` },
      }),
      {
        ASSETS: { fetch: async () => new Response('', { status: 404 }) },
        DB: session.h.db,
        ENVIRONMENT: 'test',
        PUBLIC_BASE_URL: BASE,
        STRIPE_MODE: 'test',
        ...ENV,
      } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    const html = await response.text();
    expect(html).toContain(`data-live="/app/runs/${id}/live"`);
    expect(html).toContain('data-status="PENDING"');
    expect(html).toContain('data-live-status');
    expect(html).not.toContain('this page does not move on its own');
    expect(html).toContain(`<script>${LIVE_SCRIPT}</script>`);
    const hash = createHash('sha256').update(LIVE_SCRIPT).digest('base64');
    expect(response.headers.get('content-security-policy')).toContain(`'sha256-${hash}'`);
  });

  it('VERIFY-926 a settled run page carries no script, so nothing polls a decided run', async () => {
    const session = await ready();
    stubProviders();
    const id = await startTest(session);
    session.h.raw
      .prepare("UPDATE runs SET status = 'VERIFIED', next_check_at = NULL WHERE id = ?")
      .run(id);
    const served = await getSignedIn(session, `/app/runs/${id}`);
    expect(served.html).toContain('data-status="VERIFIED"');
    expect(served.html).not.toContain('<script>(function(){\nvar started');
  });

  it('VERIFY-927 the workspace is live on a GET, and a re-render answering a form post does not claim to be', async () => {
    const session = await ready();
    const served = await getSignedIn(session, '/app');
    expect(served.html).toContain('data-live="/app/live"');
    expect(served.html).toContain(`<script>${LIVE_SCRIPT}</script>`);
    const posted = await postSignedIn(
      session,
      '/app/test-verification/lookup',
      { lookup: 'enter' },
      { csrfSourcePath: '/app', env: ENV },
    );
    expect(posted.status).toBe(200);
    expect(posted.html).not.toContain('data-live="/app/live"');
  });
});
