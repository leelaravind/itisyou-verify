/**
 * `ResendWebhookDataPort` and the endpoint resolver, against D1.
 *
 * The two properties A04 marked load-bearing, plus the tenant boundary through the
 * resolver — which is the one place an opaque id from the public internet becomes a
 * workspace.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmailEventEvidence } from '@verify/contracts';
import { buildAad, randomBytes, sealCredentialFor, toBase64 } from '@verify/security';
import {
  D1ResendWebhookDataPort,
  assignWebhookPathId,
  createResendEndpointResolver,
  credentials,
  newWebhookPathId,
} from '@app/db';
import type { Env } from '@app/lib/context';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

const NOW = '2026-09-19T10:00:00.000Z';
// secret-scan:allow ephemeral per-run wrapping key; wraps nothing in the repository
const KEY = toBase64(randomBytes(32));
// secret-scan:allow synthetic Svix secret for this test only
const SIGNING_SECRET = `whsec_${toBase64(randomBytes(24))}`;

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

function seedConnection(h: TestDb, ws: SeededWorkspace, id: string, status = 'testing'): void {
  h.raw
    .prepare(
      `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at, external_account_id)
       VALUES (?, ?, 'resend', ?, '[]', ?, ?)`,
    )
    .run(id, ws.workspaceId, status, T0, `acct_${id}`);
}

async function seedSecret(h: TestDb, ws: SeededWorkspace, connectionId: string): Promise<void> {
  const sealed = await sealCredentialFor(
    SIGNING_SECRET,
    { workspaceId: ws.workspaceId, provider: 'resend', purpose: 'webhook_secret' },
    { keyBase64: KEY, keyVersion: 1 },
  );
  await credentials.store(h.db, {
    id: `cred_${connectionId}`,
    ownerScope: `connection:${connectionId}`,
    connectionId,
    keyVersion: sealed.key_version,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    aad: sealed.aad,
    createdAt: T0,
  });
}

describe('the opaque webhook path id', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
    seedConnection(h, ws, 'conn_a');
  });
  afterEach(() => {
    h.close();
  });

  it('CONN-300 carries far more than 128 bits and is derived from nothing', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) ids.add(newWebhookPathId());
    expect(ids.size).toBe(200);

    const id = newWebhookPathId();
    // 32 bytes base64url — 256 bits, well past the 128 the brief requires.
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // It appears in a URL the customer pastes into somebody else's dashboard, so it must
    // say nothing about whose it is.
    expect(id).not.toContain(ws.workspaceId);
    expect(id).not.toContain('conn_a');
    expect(id).not.toContain('resend');
  });

  it('CONN-301 is issued once and not silently replaced on a second connect', async () => {
    const first = await assignWebhookPathId(h.db, {
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
    });
    expect(first).not.toBeNull();
    // A re-connect must not invalidate a URL the customer has already pasted into Resend.
    const second = await assignWebhookPathId(h.db, {
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
    });
    expect(second).toBe(first);

    // Rotation is explicit, and only then does the id change.
    const rotated = await assignWebhookPathId(h.db, {
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      rotate: true,
    });
    expect(rotated).not.toBe(first);
  });

  it('AUTH-460 cannot be issued for another workspace’s connection', async () => {
    const other = seedWorkspace(h, 'beta');
    expect(
      await assignWebhookPathId(h.db, {
        workspaceId: other.workspaceId,
        connectionId: 'conn_a',
      }),
    ).toBeNull();
    const row = h.raw
      .prepare('SELECT webhook_path_id FROM connections WHERE id = ?')
      .get('conn_a') as { webhook_path_id: string | null };
    expect(row.webhook_path_id).toBeNull();
  });

  it('CONN-302 a revoked connection is never issued one', async () => {
    // UNIQUE (workspace_id, provider) means a second resend connection needs its own tenant.
    const dead = seedWorkspace(h, 'dead');
    seedConnection(h, dead, 'conn_dead', 'revoked');
    expect(
      await assignWebhookPathId(h.db, {
        workspaceId: dead.workspaceId,
        connectionId: 'conn_dead',
      }),
    ).toBeNull();
  });
});

describe('the endpoint resolver', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  let pathId: string;

  beforeEach(async () => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
    seedConnection(h, ws, 'conn_a');
    await seedSecret(h, ws, 'conn_a');
    pathId = (await assignWebhookPathId(h.db, {
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
    })) as string;
  });
  afterEach(() => {
    h.close();
  });

  it('CONN-303 resolves a known id and decrypts its signing secret', async () => {
    const resolve = createResendEndpointResolver(h.db, env());
    const endpoint = await resolve(pathId);
    expect(endpoint).not.toBeNull();
    expect(endpoint?.workspaceId).toBe(ws.workspaceId);
    expect(endpoint?.connectionId).toBe('conn_a');
    expect(endpoint?.signingSecret).toBe(SIGNING_SECRET);
    expect(endpoint?.status).toBe('testing');
    expect(endpoint?.externalAccountId).toBe('acct_conn_a');
  });

  it('CONN-304 returns null for an id we never issued — the route refuses on THIS, not on the signature', async () => {
    const resolve = createResendEndpointResolver(h.db, env());
    expect(await resolve(newWebhookPathId())).toBeNull();
    expect(await resolve('')).toBeNull();
    expect(await resolve('short')).toBeNull();
    // A finding this ordering exists to close: a valid signature over an unknown endpoint
    // id must still be refused, so the lookup has to fail first.
    expect(await resolve(`${pathId}x`)).toBeNull();
  });

  it('CONN-305 hands back an empty secret rather than throwing when it cannot be opened', async () => {
    // secret-scan:allow a second ephemeral key, so the envelope will not open
    const wrongKey = toBase64(randomBytes(32));
    const resolve = createResendEndpointResolver(h.db, env({ CREDENTIAL_KEY_V1: wrongKey }));
    const endpoint = await resolve(pathId);
    // Not null — the endpoint exists — but nothing can be verified with it, which the
    // route turns into a failed verification rather than a 500.
    expect(endpoint).not.toBeNull();
    expect(endpoint?.signingSecret).toBe('');

    const unconfigured = createResendEndpointResolver(h.db, env({ CREDENTIAL_KEY_V1: '' }));
    expect((await unconfigured(pathId))?.signingSecret).toBe('');
  });

  it('AUTH-461 a secret sealed for one workspace does not open under another', async () => {
    const other = seedWorkspace(h, 'beta');
    seedConnection(h, other, 'conn_b');
    // Copy alpha's envelope wholesale onto beta's connection, AAD column included.
    const row = h.raw
      .prepare('SELECT ciphertext, nonce, aad, key_version FROM credential_versions WHERE id = ?')
      .get('cred_conn_a') as {
      ciphertext: string;
      nonce: string;
      aad: string;
      key_version: number;
    };
    await credentials.store(h.db, {
      id: 'cred_stolen',
      ownerScope: 'connection:conn_b',
      connectionId: 'conn_b',
      keyVersion: row.key_version,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      aad: row.aad,
      createdAt: T0,
    });
    const otherPath = (await assignWebhookPathId(h.db, {
      workspaceId: other.workspaceId,
      connectionId: 'conn_b',
    })) as string;

    const endpoint = await createResendEndpointResolver(h.db, env())(otherPath);
    // The AAD binds the secret to alpha, so beta gets nothing usable.
    expect(endpoint?.workspaceId).toBe(other.workspaceId);
    expect(endpoint?.signingSecret).toBe('');
    expect(row.aad).toContain(ws.workspaceId);
    expect(row.aad).toBe(
      (
        await sealCredentialFor(
          'x',
          { workspaceId: ws.workspaceId, provider: 'resend', purpose: 'webhook_secret' },
          { keyBase64: KEY, keyVersion: 1 },
        )
      ).aad,
    );
    expect(row.aad).not.toContain(other.workspaceId);
    expect(
      buildAad({ workspaceId: ws.workspaceId, provider: 'resend', purpose: 'webhook_secret' }),
    ).toContain(ws.workspaceId);
  });
});

describe('the webhook data port', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  let port: D1ResendWebhookDataPort;

  const emailEvent = (
    messageId: string,
    status: EmailEventEvidence['status'],
  ): EmailEventEvidence => ({
    kind: 'email_event',
    origin: 'provider_webhook',
    provider: 'resend',
    provider_account_id: 'acct_conn_a',
    message_id: messageId,
    recipient: 'ada@example.com',
    status,
    occurred_at: NOW,
    observed_at: NOW,
  });

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
    seedConnection(h, ws, 'conn_a');
    port = new D1ResendWebhookDataPort(h.db);
  });
  afterEach(() => {
    h.close();
  });

  it('CONN-310 a revoked connection is never promoted to ready by a callback that verifies', async () => {
    h.raw
      .prepare("UPDATE connections SET status = 'revoked', revoked_at = ? WHERE id = ?")
      .run(T0, 'conn_a');

    // The route checks the status too. This is the check that cannot be forgotten, because
    // it is the write: a customer who withdrew access does not get it back by a delivery
    // event arriving with a still-valid signing secret.
    expect(
      await port.markConnectionWebhookVerified({
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
        verifiedAt: NOW,
      }),
    ).toBe(false);

    const row = h.raw.prepare('SELECT status FROM connections WHERE id = ?').get('conn_a') as {
      status: string;
    };
    expect(row.status).toBe('revoked');
  });

  it('CONN-311 a live connection IS promoted, and the error code is cleared', async () => {
    h.raw
      .prepare("UPDATE connections SET last_error_code = 'AUTH_EXPIRED' WHERE id = ?")
      .run('conn_a');
    expect(
      await port.markConnectionWebhookVerified({
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
        verifiedAt: NOW,
      }),
    ).toBe(true);
    const row = h.raw
      .prepare('SELECT status, last_check_at, last_error_code FROM connections WHERE id = ?')
      .get('conn_a') as { status: string; last_check_at: string; last_error_code: string | null };
    expect(row.status).toBe('ready');
    expect(row.last_check_at).toBe(NOW);
    expect(row.last_error_code).toBeNull();
  });

  it('AUTH-462 promotion cannot be driven from another workspace', async () => {
    const other = seedWorkspace(h, 'beta');
    expect(
      await port.markConnectionWebhookVerified({
        workspaceId: other.workspaceId,
        connectionId: 'conn_a',
        verifiedAt: NOW,
      }),
    ).toBe(false);
    expect(
      (
        h.raw.prepare('SELECT status FROM connections WHERE id = ?').get('conn_a') as {
          status: string;
        }
      ).status,
    ).toBe('testing');
  });

  it('CONN-312 the receipt gate distinguishes in-flight from completed, and can be given back', async () => {
    const claim = (id: string) =>
      port.beginWebhookProcessing({
        receiptId: id,
        provider: 'resend',
        eventId: 'evt_1',
        payloadHash: 'hash',
        receivedAt: NOW,
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
      });

    expect((await claim('whr_1')).outcome).toBe('fresh');
    expect((await claim('whr_2')).outcome).toBe('in_flight');
    await port.abandonWebhookProcessing('evt_1');
    expect(countRows(h, 'webhook_receipts')).toBe(0);
    expect((await claim('whr_3')).outcome).toBe('fresh');
    await port.completeWebhookProcessing('whr_3', 'processed', ws.workspaceId);
    expect((await claim('whr_4')).outcome).toBe('already_processed');
  });

  it('CONN-313 email evidence is stored idempotently and carries no raw payload', async () => {
    seedRun(h, ws, 'run_a', { nextCheckAt: null });
    const record = () =>
      port.recordEmailEvidence({
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
        eventId: 'evt_1',
        evidence: emailEvent('msg_1', 'delivered'),
        receivedAt: NOW,
      });

    await record();
    await record();
    await record();
    expect(countRows(h, 'evidence')).toBe(1);

    const row = h.raw
      .prepare(
        'SELECT workspace_id, provider, origin, provider_record_id, redacted_summary FROM evidence',
      )
      .get() as {
      workspace_id: string;
      provider: string;
      origin: string;
      provider_record_id: string;
      redacted_summary: string;
    };
    expect(row.workspace_id).toBe(ws.workspaceId);
    expect(row.origin).toBe('provider_webhook');
    expect(row.provider_record_id).toBe('msg_1');
    // The recipient address is not in the stored summary.
    expect(row.redacted_summary).not.toContain('ada@example.com');
    expect(JSON.parse(row.redacted_summary)).toMatchObject({
      kind: 'email_event',
      status: 'delivered',
      message_id: 'msg_1',
    });
  });

  it('CONN-314 a different status for the same message is a distinct observation', async () => {
    seedRun(h, ws, 'run_a', { nextCheckAt: null });
    for (const status of ['accepted', 'delivered'] as const) {
      await port.recordEmailEvidence({
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
        eventId: `evt_${status}`,
        evidence: emailEvent('msg_1', status),
        receivedAt: NOW,
      });
    }
    // `accepted` is not `delivered`; collapsing them would lose the distinction the whole
    // product rests on.
    expect(countRows(h, 'evidence')).toBe(2);
  });
});
