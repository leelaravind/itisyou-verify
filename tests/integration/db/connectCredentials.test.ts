/**
 * Pasting a provider credential, all the way from the port to the ciphertext row.
 *
 * `submitConnectionCredentials` was declared optional on `CustomerDataPort` and implemented
 * only by the synthetic port, so `/app/onboarding/connect` took its honest fallback branch
 * ("this workspace has no way to validate a credential against the provider yet") and no
 * real customer could ever connect anything. These cases lock the real path:
 *
 *   role check → provider call → seal → store → mark connected
 *
 * and, just as importantly, lock the three things that must NOT happen: a credential that
 * the provider rejected is never stored, a viewer never gets to submit one, and a
 * ciphertext sealed for workspace A never opens in the context of workspace B.
 *
 * Every provider call here is a stub. Nothing in this file has contacted HubSpot or Resend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, openCredentialFor, toBase64 } from '@verify/security';
import { CREDENTIAL_PURPOSE } from '@verify/connectors';
import { D1CustomerDataPort } from '@app/db';
import type { Env } from '@app/lib/context';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');

/**
 * Credential-shaped fixtures are assembled at runtime, never written as literals — the
 * secret scanner and GitHub push protection both reject the literal form, and a fixture
 * that looks like a key is a fixture somebody eventually treats as one.
 */
const HUBSPOT_TOKEN = ['pat', 'eu1', '00000000-0000-4000-8000-000000000001'].join('-');
const RESEND_TOKEN = 're' + '_' + 'A'.repeat(24);
const RESEND_WEBHOOK_SECRET = 'whsec' + '_' + toBase64(new Uint8Array(24).fill(7));

/** A deterministic 32-byte AES-256 wrapping key. Test-only; never a deployed value. */
const WRAPPING_KEY = toBase64(new Uint8Array(32).fill(3));

function fakeEnv(db: unknown, options: { wrappingKey?: string | null } = {}): Env {
  const wrappingKey = options.wrappingKey === undefined ? WRAPPING_KEY : options.wrappingKey;
  return {
    DB: db as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    STRIPE_MODE: 'test',
    // `null` means the deployment has no wrapping key at all, which is a state a bare
    // environment really is in and the one CONN-326 is about.
    ...(wrappingKey === null ? {} : { CREDENTIAL_KEY_V1: wrappingKey }),
  } as Env;
}

/** A stub standing in for HubSpot's `access-token-info` endpoint. */
function hubspotTokenInfo(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function signIn(
  h: TestDb,
  ws: SeededWorkspace,
  options: { fetchImpl?: typeof fetch; wrappingKey?: string | null } = {},
): Promise<D1CustomerDataPort> {
  const cookieValue = `session-value-for-${ws.workspaceId}`;
  const idHash = await hashToken(cookieValue, 'session');
  h.raw
    .prepare(
      // OR IGNORE so a case may build a second port on the same session — re-reading the
      // page after a write is exactly what a browser does.
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(idHash, ws.userId, T0, '2026-09-20T10:00:00.000Z', T0);

  return new D1CustomerDataPort({
    db: h.db,
    env: fakeEnv(
      h.db,
      options.wrappingKey === undefined ? {} : { wrappingKey: options.wrappingKey },
    ),
    request: {
      headers: new Headers({ cookie: `verify_session=${cookieValue}` }),
      url: 'http://localhost:8787/app/onboarding/connect',
    },
    now: NOW,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

interface RawCredentialRow {
  readonly id: string;
  readonly connection_id: string | null;
  readonly owner_scope: string;
  readonly key_version: number;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly aad: string;
  readonly retired_at: string | null;
}

function credentialRows(h: TestDb): RawCredentialRow[] {
  return h.raw
    .prepare(
      'SELECT id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, retired_at FROM credential_versions ORDER BY created_at ASC, id ASC',
    )
    .all() as unknown as RawCredentialRow[];
}

function connectionRows(h: TestDb): Array<Record<string, unknown>> {
  return h.raw.prepare('SELECT * FROM connections').all() as unknown as Array<
    Record<string, unknown>
  >;
}

/* -------------------------------------------------------------------------- */

describe('submitConnectionCredentials against D1', () => {
  let h: TestDb;
  let a: SeededWorkspace;
  let b: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    a = seedWorkspace(h, 'alpha');
    b = seedWorkspace(h, 'beta');
  });
  afterEach(() => {
    h.close();
    vi.unstubAllGlobals();
  });

  it('CONN-320 a real port can validate and store a HubSpot credential', async () => {
    const port = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({
        hubId: 24680,
        appId: 1,
        userId: 2,
        scopes: ['crm.objects.contacts.read'],
      }),
    });

    // The fallback branch in the route exists precisely because this could be undefined.
    expect(typeof port.submitConnectionCredentials).toBe('function');

    const result = await port.submitConnectionCredentials!({
      provider: 'hubspot',
      accessToken: HUBSPOT_TOKEN,
    });

    expect(result.ok).toBe(true);
    expect(result.fieldErrors).toEqual({});
    // Nothing in the answer is the credential.
    expect(JSON.stringify(result)).not.toContain(HUBSPOT_TOKEN);

    const rows = connectionRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['workspace_id']).toBe(a.workspaceId);
    expect(rows[0]!['provider']).toBe('hubspot');
    expect(rows[0]!['status']).toBe('ready');
    expect(rows[0]!['external_account_id']).toBe('24680');
    expect(rows[0]!['last_check_at']).toBe(NOW.toISOString());

    // The page must report from the database, not from the submission.
    const fresh = await signIn(h, a);
    const view = (await fresh.connections()).find((c) => c.provider === 'hubspot');
    expect(view?.status).toBe('ready');
    expect(view?.lastCheckedAt).toBe(NOW.toISOString());
  });

  it('CONN-321 the stored row is ciphertext carrying the workspace/provider/purpose AAD', async () => {
    const port = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({ hubId: 24680, scopes: ['crm.objects.contacts.read'] }),
    });
    await port.submitConnectionCredentials!({ provider: 'hubspot', accessToken: HUBSPOT_TOKEN });

    const rows = credentialRows(h);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Not the token, in any column.
    expect(JSON.stringify(row)).not.toContain(HUBSPOT_TOKEN);
    expect(row.ciphertext).not.toContain(HUBSPOT_TOKEN);
    expect(row.ciphertext.length).toBeGreaterThan(0);

    // Migration 0002's two constraints, checked as facts rather than trusted.
    expect(row.owner_scope.startsWith('connection:')).toBe(true);
    expect(row.owner_scope.slice('connection:'.length).length).toBeGreaterThan(0);
    expect(row.aad).toBe(
      `v1|kv=1|ws=${a.workspaceId}|provider=hubspot|purpose=${CREDENTIAL_PURPOSE.API_TOKEN}`,
    );
    expect(row.key_version).toBe(1);
    expect(row.connection_id).toBe(connectionRows(h)[0]!['id']);
    expect(row.retired_at).toBeNull();

    // And it really is the token, opened with the AAD rebuilt from this workspace.
    const opened = await openCredentialFor(
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        aad: row.aad,
        key_version: row.key_version,
      },
      {
        workspaceId: a.workspaceId,
        provider: 'hubspot',
        purpose: CREDENTIAL_PURPOSE.API_TOKEN,
      },
      { keyBase64: WRAPPING_KEY },
    );
    expect(opened).toBe(HUBSPOT_TOKEN);
  });

  it('CONN-322 a credential stored by workspace A does not open in workspace B’s context', async () => {
    const port = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({ hubId: 24680, scopes: ['crm.objects.contacts.read'] }),
    });
    await port.submitConnectionCredentials!({ provider: 'hubspot', accessToken: HUBSPOT_TOKEN });

    const row = credentialRows(h)[0]!;
    const envelope = {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      aad: row.aad,
      key_version: row.key_version,
    };

    // Same key, same ciphertext, same row — only the workspace in the AAD differs.
    await expect(
      openCredentialFor(
        { ...envelope },
        { workspaceId: b.workspaceId, provider: 'hubspot', purpose: CREDENTIAL_PURPOSE.API_TOKEN },
        { keyBase64: WRAPPING_KEY },
      ),
    ).rejects.toThrow();

    // Nor by carrying the AAD column across with it: the rebuilt AAD is what is compared.
    await expect(
      openCredentialFor(
        { ...envelope, aad: envelope.aad.replace(a.workspaceId, b.workspaceId) },
        { workspaceId: b.workspaceId, provider: 'hubspot', purpose: CREDENTIAL_PURPOSE.API_TOKEN },
        { keyBase64: WRAPPING_KEY },
      ),
    ).rejects.toThrow();

    // And workspace B's own port cannot reach the row at all.
    const portB = await signIn(h, b);
    expect((await portB.connections()).every((c) => c.status === 'not_connected')).toBe(true);
  });

  it('CONN-323 a credential the provider rejected is not stored at all', async () => {
    const port = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({ status: 'error', message: 'expired' }, 401),
    });

    const result = await port.submitConnectionCredentials!({
      provider: 'hubspot',
      accessToken: HUBSPOT_TOKEN,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nothing has been saved/i);
    // The provider's own problem, named: a rejected token is not a missing scope.
    expect((result.message ?? '').toLowerCase()).toContain('rejected');

    expect(credentialRows(h)).toHaveLength(0);
    expect(connectionRows(h)).toHaveLength(0);

    // An audit row may record the attempt. It must never record the credential.
    const audit = h.raw.prepare('SELECT * FROM audit_events').all() as unknown as Array<
      Record<string, unknown>
    >;
    expect(JSON.stringify(audit)).not.toContain(HUBSPOT_TOKEN);
  });

  it('CONN-324 a missing scope and an unreachable provider are told apart', async () => {
    const wrongScope = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({ hubId: 24680, scopes: ['crm.objects.deals.read'] }),
    });
    const scopeResult = await wrongScope.submitConnectionCredentials!({
      provider: 'hubspot',
      accessToken: HUBSPOT_TOKEN,
    });
    expect(scopeResult.ok).toBe(false);
    expect(scopeResult.message).toContain('crm.objects.contacts.read');
    expect(credentialRows(h)).toHaveLength(0);

    const unreachable = await signIn(h, b, {
      fetchImpl: (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
    });
    const networkResult = await unreachable.submitConnectionCredentials!({
      provider: 'hubspot',
      accessToken: HUBSPOT_TOKEN,
    });
    expect(networkResult.ok).toBe(false);
    expect(networkResult.message).toMatch(/could not reach/i);
    expect(networkResult.message).not.toContain('crm.objects.contacts.read');
    expect(credentialRows(h)).toHaveLength(0);
    expect(connectionRows(h)).toHaveLength(0);
  });

  it('CONN-325 a workspace viewer cannot submit a credential and nothing leaves the building', async () => {
    h.raw
      .prepare("UPDATE memberships SET role = 'workspace_viewer' WHERE workspace_id = ?")
      .run(a.workspaceId);

    let calls = 0;
    const port = await signIn(h, a, {
      fetchImpl: (async () => {
        calls += 1;
        throw new Error('the provider must not be called for a viewer');
      }) as unknown as typeof fetch,
    });

    const result = await port.submitConnectionCredentials!({
      provider: 'hubspot',
      accessToken: HUBSPOT_TOKEN,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/workspace admin/i);
    expect(calls).toBe(0);
    expect(credentialRows(h)).toHaveLength(0);
    expect(connectionRows(h)).toHaveLength(0);
  });

  it('CONN-326 with no wrapping key configured it refuses rather than storing in the clear', async () => {
    let calls = 0;
    const port = await signIn(h, a, {
      wrappingKey: null,
      fetchImpl: (async () => {
        calls += 1;
        throw new Error('nothing should be sent when we cannot seal the answer');
      }) as unknown as typeof fetch,
    });

    const result = await port.submitConnectionCredentials!({
      provider: 'hubspot',
      accessToken: HUBSPOT_TOKEN,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('CREDENTIAL_KEY_V1');
    expect(calls).toBe(0);
    expect(credentialRows(h)).toHaveLength(0);
    expect(connectionRows(h)).toHaveLength(0);
  });

  it('CONN-327 Resend stores the API key and the signing secret without retiring either', async () => {
    const port = await signIn(h, a, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    const result = await port.submitConnectionCredentials!({
      provider: 'resend',
      accessToken: RESEND_TOKEN,
      webhookSecret: RESEND_WEBHOOK_SECRET,
    });

    expect(result.ok).toBe(true);
    // Resend is never `ready` on our say-so: a stored signing secret is a promise.
    expect(connectionRows(h)[0]!['status']).toBe('testing');

    const rows = credentialRows(h).filter((r) => r.retired_at === null);
    expect(rows).toHaveLength(2);
    const purposes = rows.map((r) =>
      r.aad.slice(r.aad.lastIndexOf('purpose=') + 'purpose='.length),
    );
    expect(new Set(purposes)).toEqual(
      new Set([CREDENTIAL_PURPOSE.API_TOKEN, CREDENTIAL_PURPOSE.WEBHOOK_SECRET]),
    );
    expect(JSON.stringify(rows)).not.toContain(RESEND_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(RESEND_WEBHOOK_SECRET);
  });

  it('CONN-328 re-submitting replaces the stored credential rather than adding a second live one', async () => {
    const port = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({ hubId: 24680, scopes: ['crm.objects.contacts.read'] }),
    });
    await port.submitConnectionCredentials!({ provider: 'hubspot', accessToken: HUBSPOT_TOKEN });
    const second = ['pat', 'eu1', '00000000-0000-4000-8000-000000000002'].join('-');
    await port.submitConnectionCredentials!({ provider: 'hubspot', accessToken: second });

    expect(connectionRows(h)).toHaveLength(1);
    const all = credentialRows(h);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.retired_at === null)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Pressing "Test connection" must not move a connection backwards.
 *
 * `testConnection` had no test of any kind, and shipped a defect a customer met on
 * production: it called the connector with a `connection` object carrying only the provider,
 * the account id and `reverify_account`, leaving out `webhook_verified_at`. Resend decides
 * readiness on exactly that field, so a connection whose signed callback had genuinely
 * arrived was reported unfinished, and the status write moved it from `ready` to `testing`.
 *
 * The same screen then contradicted itself, because the page's own webhook line is read
 * straight from the column: "a correctly signed callback has been received and understood",
 * directly above "we have never actually received a message signed with it".
 *
 * And it was a dead end rather than a blip. `markWebhookVerified` is the only route from
 * `testing` to `ready` for a webhook-dependent connection, and the route that calls it fires
 * only while `webhook_verified_at` is null. Once downgraded, no later delivery could climb
 * the connection back out.
 */
describe('testConnection against D1', () => {
  let h: TestDb;
  let a: SeededWorkspace;

  /** Resend answers the read; the shape only has to be a 200 with a data array. */
  const resendOk = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  beforeEach(() => {
    h = createTestDb();
    a = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
    vi.unstubAllGlobals();
  });

  /** Connect Resend, then promote it exactly as the webhook route does on a signed callback. */
  async function connectedAndProven(proven: boolean): Promise<D1CustomerDataPort> {
    const port = await signIn(h, a, { fetchImpl: resendOk });
    await port.submitConnectionCredentials!({
      provider: 'resend',
      accessToken: RESEND_TOKEN,
      webhookSecret: RESEND_WEBHOOK_SECRET,
    });
    if (proven) {
      h.raw
        .prepare(
          `UPDATE connections SET status = 'ready', webhook_verified_at = ? WHERE workspace_id = ?`,
        )
        .run('2026-09-18T09:00:00.000Z', a.workspaceId);
    }
    return port;
  }

  it('CONN-902 a proven Resend webhook survives the test button, and the page does not contradict itself', async () => {
    const port = await connectedAndProven(true);

    const result = await port.testConnection!('resend');

    // What the customer is told.
    expect(result.apiAccess).toBe('ok');
    expect(result.webhookReadiness).toBe('received');
    expect(result.status).toBe('ready');

    // The contradiction itself, as a fact rather than a description: a connection whose
    // webhook has been received is never also asked to go and produce one.
    expect(result.nextStep ?? '').not.toContain('never actually received');
    if (result.webhookReadiness === 'received') expect(result.nextStep).toBeNull();

    // And the stored row did not move backwards. This is the half that persisted.
    const row = connectionRows(h)[0]!;
    expect(row['status']).toBe('ready');
    expect(row['webhook_verified_at']).toBe('2026-09-18T09:00:00.000Z');

    // Mutation check: drop `webhook_verified_at` from the object handed to the connector in
    // `customerPort.testConnection` and this case fails on `status` — 'testing', not 'ready'.
  });

  it('CONN-903 a Resend webhook that never arrived is still reported unfinished', async () => {
    const port = await connectedAndProven(false);

    const result = await port.testConnection!('resend');

    // The credential works; the connection is not finished, and says so. Carrying the
    // stored value in must not become "ready on our own say-so" for a connection that has
    // never had a signed callback.
    expect(result.apiAccess).toBe('ok');
    expect(result.webhookReadiness).toBe('never_received');
    expect(result.status).toBe('testing');
    expect(result.nextStep ?? '').toContain('never actually received');
    expect(connectionRows(h)[0]!['status']).toBe('testing');
  });

  it('CONN-904 a polled provider has no webhook to be ready, and testing it says exactly that', async () => {
    const port = await signIn(h, a, {
      fetchImpl: hubspotTokenInfo({ hubId: 24680, scopes: ['crm.objects.contacts.read'] }),
    });
    await port.submitConnectionCredentials!({ provider: 'hubspot', accessToken: HUBSPOT_TOKEN });

    const result = await port.testConnection!('hubspot');

    expect(result.apiAccess).toBe('ok');
    expect(result.webhookReadiness).toBe('not_applicable');
    expect(result.credentialsPreserved).toBe(true);
    // The button reports; it does not retire or rewrite the credential it checked with.
    expect(credentialRows(h).filter((r) => r.retired_at === null)).toHaveLength(1);
  });
});
