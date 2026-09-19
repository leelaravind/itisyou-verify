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

  it('AUTH-019 cannot be issued for another workspace’s connection', async () => {
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

  /**
   * The regression this pair exists for.
   *
   * The resolver used to report `last_check_at` as `webhookVerifiedAt`. Every test seeded a
   * connection without `last_check_at`, so it read NULL and the substitution looked right.
   * Every *real* connection has `last_check_at` written the moment its credentials validate,
   * so in production it was never NULL — and the route's promotion test, `webhookVerifiedAt
   * === null`, could never be true. A Resend connection stayed `testing` for ever no matter
   * how many correctly signed deliveries it handled.
   *
   * So the first of these sets `last_check_at` the way a real connect does. That single line
   * is the whole difference between a test that catches this and one that does not.
   */
  it('CONN-315 a connection that has been checked but never called back is still unverified', async () => {
    h.raw.prepare('UPDATE connections SET last_check_at = ? WHERE id = ?').run(NOW, 'conn_a');
    const resolve = createResendEndpointResolver(h.db, env());
    const endpoint = await resolve(pathId);
    expect(endpoint).not.toBeNull();
    // Validating a token says the key works. It says nothing about the webhook.
    expect(endpoint?.webhookVerifiedAt).toBeNull();
  });

  it('CONN-316 once a callback has been verified the resolver reports that instant, so the promotion is not repeated', async () => {
    const port = new D1ResendWebhookDataPort(h.db);
    await port.markConnectionWebhookVerified({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      verifiedAt: NOW,
    });
    const endpoint = await createResendEndpointResolver(h.db, env())(pathId);
    expect(endpoint?.webhookVerifiedAt).toBe(NOW);
    expect(endpoint?.status).toBe('ready');
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
    seedRun(h, ws, 'run_a', {
      nextCheckAt: null,
      emailRecipient: 'ada@example.com',
      // The enquiry names the message it is waiting for; an address alone no longer binds.
      emailMessageId: 'msg_1',
    });
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




  /**
   * The owner's reproduction, ported into the real application.
   *
   * `ITISYOU_Verify_Correlation_Reproduction.py` models the correlation logic in isolation
   * and fails four of its eight cases against the first fix. Those four were right, and
   * they all reduce to one rule the first fix did not have:
   *
   *   **an address is evidence about an address, not about an enquiry.**
   *
   * Two enquiries to the same customer share a recipient and are still two enquiries. So
   * the provider's message id is the only thing that binds, and a failed or ambiguous id
   * lookup may not fall onward to the address -- not when the id is unknown (R03), not
   * when it is ambiguous (R04), not when the only id match is an already-decided run
   * (R05), and not when the run named no id at all (R06).
   *
   * Ids below mirror the reproduction's R01..R08 so the two can be read side by side.
   * These run against D1 and the real port, which the reproduction deliberately does not:
   * passing the Python file proves nothing about this deployment.
   */
  const deliver = (messageId: string, recipient: string) =>
    port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: `evt_${messageId}_${recipient}`,
      evidence: { ...emailEvent(messageId, 'delivered'), recipient },
      receivedAt: NOW,
    });

  const boundRun = (): string | null => {
    const rows = h.raw.prepare('SELECT run_id FROM evidence').all() as { run_id: string }[];
    return rows.length === 1 ? (rows[0]?.run_id ?? null) : null;
  };

  it('CONN-330 (R01) an exact message id selects its own run', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    await deliver('M1', 'a@example.test');
    expect(boundRun()).toBe('A');
  });

  it('CONN-331 (R02) the same recipient with different ids still selects the right run', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    seedRun(h, ws, 'B', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M2' });
    await deliver('M2', 'a@example.test');
    expect(boundRun()).toBe('B');
  });

  it('CONN-332 (R03) a wrong message id cannot fall back to a matching address', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    await deliver('UNRELATED', 'a@example.test');
    // The address matches perfectly and proves nothing: this run is waiting for M1.
    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-333 (R04) an ambiguous message id cannot be disambiguated by an address', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    seedRun(h, ws, 'B', { nextCheckAt: null, emailRecipient: 'b@example.test', emailMessageId: 'M1' });
    await deliver('M1', 'a@example.test');
    // Only A's address matches, which is exactly the coincidence that must not resolve it.
    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-334 (R05) an old delivery cannot attach to a newer run sharing the address', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, status: 'VERIFIED', emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    seedRun(h, ws, 'B', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M2' });
    await deliver('M1', 'a@example.test');
    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-335 (R06) an address alone never binds an enquiry', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test' });
    await deliver('UNRELATED', 'a@example.test');
    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-336 (R07) the right id with the wrong recipient still binds, so the assertion can contradict it', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    await deliver('M1', 'wrong@example.test');
    // Binding is not a verdict. Reaching A is what lets the evaluator call the recipient
    // assertion CONTRADICTED; dropping it here would turn a contradiction into a silence.
    expect(boundRun()).toBe('A');
  });

  it('CONN-337 (R08) two address-only candidates stay unbound', async () => {
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test' });
    seedRun(h, ws, 'B', { nextCheckAt: null, emailRecipient: 'a@example.test' });
    await deliver('UNRELATED', 'a@example.test');
    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-338 unmatched and ambiguous are reported as different answers, not both as nothing', async () => {
    const misses: { outcome: string; reason: string }[] = [];
    const observed = new D1ResendWebhookDataPort(h.db, 'resend', (m) =>
      misses.push({ outcome: m.outcome, reason: m.reason }),
    );
    seedRun(h, ws, 'A', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M1' });
    seedRun(h, ws, 'B', { nextCheckAt: null, emailRecipient: 'b@example.test', emailMessageId: 'M1' });

    const send = (messageId: string) =>
      observed.recordEmailEvidence({
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
        eventId: `evt_${messageId}`,
        evidence: { ...emailEvent(messageId, 'delivered'), recipient: 'a@example.test' },
        receivedAt: NOW,
      });

    await send('M1');
    await send('NOBODY_EXPECTS_THIS');

    // Collapsing these to one value is what let "we cannot tell which of two" be handled
    // as "we found none" and fall through to the weaker handle.
    expect(misses.map((m) => m.outcome)).toEqual(['ambiguous', 'unmatched']);
    expect(new Set(misses.map((m) => m.reason)).size).toBe(2);
  });

  /**
   * The inbox, and the case it exists for.
   *
   * A delivery event can legitimately arrive BEFORE the signed source event that describes
   * the enquiry: the customer's automation sends the mail, the provider fires `email.sent`
   * within milliseconds, and the event describing the enquiry arrives afterwards. Under the
   * id-only rule that callback matches nothing, and discarding it throws away the only
   * record that the message was ever delivered -- which would turn a real delivery into an
   * UNVERIFIED run for a reason that is entirely our own doing.
   *
   * So it is parked, addressed by the provider's message id, and claimed by the run that
   * turns out to have been waiting for it.
   */
  it('CONN-340 a callback that arrives before its run is parked rather than discarded', async () => {
    await port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: 'evt_early',
      evidence: { ...emailEvent('M_EARLY', 'delivered'), recipient: 'a@example.test' },
      receivedAt: NOW,
    });

    expect(countRows(h, 'evidence')).toBe(0);
    const parked = h.raw
      .prepare('SELECT message_id, reason, claimed_at, redacted_summary FROM evidence_inbox')
      .all() as { message_id: string; reason: string; claimed_at: string | null; redacted_summary: string }[];
    expect(parked).toHaveLength(1);
    expect(parked[0]?.message_id).toBe('M_EARLY');
    expect(parked[0]?.reason).toBe('unmatched');
    expect(parked[0]?.claimed_at).toBeNull();
    // Masked exactly as an evidence row would be: no recipient, no raw payload.
    expect(parked[0]?.redacted_summary).not.toContain('a@example.test');
  });

  it('CONN-341 the run it was waiting for claims it, once', async () => {
    await port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: 'evt_early',
      evidence: { ...emailEvent('M_EARLY', 'delivered'), recipient: 'a@example.test' },
      receivedAt: NOW,
    });
    seedRun(h, ws, 'late', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M_EARLY' });

    const first = await port.claimInboxForRun({
      workspaceId: ws.workspaceId,
      runId: 'late',
      messageId: 'M_EARLY',
      now: NOW,
    });
    expect(first).toBe(1);

    const rows = h.raw.prepare('SELECT run_id FROM evidence').all() as { run_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.run_id).toBe('late');

    // Claiming again writes nothing: the row is marked claimed and the evidence id is
    // derived from the same digest, so a second attempt collides rather than duplicating.
    const second = await port.claimInboxForRun({
      workspaceId: ws.workspaceId,
      runId: 'late',
      messageId: 'M_EARLY',
      now: NOW,
    });
    expect(second).toBe(0);
    expect(countRows(h, 'evidence')).toBe(1);
  });

  it('CONN-342 an ambiguous callback is parked but never claimed', async () => {
    seedRun(h, ws, 'one', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M_DUP' });
    seedRun(h, ws, 'two', { nextCheckAt: null, emailRecipient: 'b@example.test', emailMessageId: 'M_DUP' });

    await port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: 'evt_ambiguous',
      evidence: { ...emailEvent('M_DUP', 'delivered'), recipient: 'a@example.test' },
      receivedAt: NOW,
    });

    const reason = (h.raw.prepare('SELECT reason FROM evidence_inbox').get() as { reason: string }).reason;
    expect(reason).toBe('ambiguous');

    // An ambiguity does not become resolvable later just because one candidate asks.
    const claimed = await port.claimInboxForRun({
      workspaceId: ws.workspaceId,
      runId: 'one',
      messageId: 'M_DUP',
      now: NOW,
    });
    expect(claimed).toBe(0);
    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-343 a provider replaying the same callback writes one parked row', async () => {
    const send = () =>
      port.recordEmailEvidence({
        workspaceId: ws.workspaceId,
        connectionId: 'conn_a',
        eventId: 'evt_replayed',
        evidence: { ...emailEvent('M_REPLAY', 'delivered'), recipient: 'a@example.test' },
        receivedAt: NOW,
      });
    await send();
    await send();
    await send();
    expect(countRows(h, 'evidence_inbox')).toBe(1);
  });

  it('CONN-344 another workspace cannot claim this workspace’s parked callback', async () => {
    await port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: 'evt_early',
      evidence: { ...emailEvent('M_EARLY', 'delivered'), recipient: 'a@example.test' },
      receivedAt: NOW,
    });
    const other = seedWorkspace(h, 'beta');
    seedRun(h, other, 'theirs', { nextCheckAt: null, emailRecipient: 'a@example.test', emailMessageId: 'M_EARLY' });

    const claimed = await port.claimInboxForRun({
      workspaceId: other.workspaceId,
      runId: 'theirs',
      messageId: 'M_EARLY',
      now: NOW,
    });
    expect(claimed).toBe(0);
    expect(countRows(h, 'evidence')).toBe(0);
    expect(
      (h.raw.prepare('SELECT claimed_at FROM evidence_inbox').get() as { claimed_at: string | null })
        .claimed_at,
    ).toBeNull();
  });

  it('CONN-050 a decided run is not reopened by a late delivery event', async () => {
    seedRun(h, ws, 'run_done', {
      nextCheckAt: null,
      status: 'VERIFIED',
      emailRecipient: 'ada@example.com',
    });

    await port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: 'evt_late',
      evidence: emailEvent('msg_late', 'delivered'),
      receivedAt: NOW,
    });

    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-051 a run in another workspace never receives this workspace’s evidence', async () => {
    const other = seedWorkspace(h, 'beta');
    seedRun(h, other, 'run_theirs', { nextCheckAt: null, emailRecipient: 'ada@example.com' });

    await port.recordEmailEvidence({
      workspaceId: ws.workspaceId,
      connectionId: 'conn_a',
      eventId: 'evt_cross',
      evidence: emailEvent('msg_cross', 'delivered'),
      receivedAt: NOW,
    });

    expect(countRows(h, 'evidence')).toBe(0);
  });

  it('CONN-314 a different status for the same message is a distinct observation', async () => {
    seedRun(h, ws, 'run_a', {
      nextCheckAt: null,
      emailRecipient: 'ada@example.com',
      // The enquiry names the message it is waiting for; an address alone no longer binds.
      emailMessageId: 'msg_1',
    });
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
