/**
 * The remaining repositories: identity, sessions, login tokens, credentials rotation,
 * webhook receipts, workflow publishing, pagination, audit and settings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditEvents,
  connections,
  connectionScope,
  credentials,
  decodeCursor,
  loginTokens,
  memberships,
  runs,
  sessions,
  settings,
  users,
  webhookReceipts,
  workflows,
  workflowVersions,
  workspaces,
} from '@app/db';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

const LATER = '2026-09-19T11:00:00.000Z';

describe('identity', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-160 createOrGet is idempotent on the normalised email', async () => {
    const first = await users.createOrGet(h.db, {
      id: 'usr_1',
      authSubject: 'ada@example.com',
      createdAt: T0,
    });
    const second = await users.createOrGet(h.db, {
      id: 'usr_2',
      authSubject: 'ada@example.com',
      createdAt: LATER,
    });
    expect(second.id).toBe(first.id);
    expect(countRows(h, 'users')).toBe(1);
  });

  it('PERSIST-161 concurrent first sign-ins produce one user, not two', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c'].map((s) =>
        users.createOrGet(h.db, { id: `usr_${s}`, authSubject: 'ada@example.com', createdAt: T0 }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(countRows(h, 'users')).toBe(1);
  });

  it('PERSIST-162 a workspace and its owning membership are created together', async () => {
    await users.createOrGet(h.db, { id: 'usr_1', authSubject: 'ada@example.com', createdAt: T0 });
    await workspaces.createWithOwner(h.db, {
      workspaceId: 'ws_1',
      name: 'Acme',
      userId: 'usr_1',
      createdAt: T0,
    });
    expect(await memberships.roleFor(h.db, 'ws_1', 'usr_1')).toBe('workspace_admin');
    expect(await workspaces.listForUser(h.db, 'usr_1')).toHaveLength(1);
  });

  it('PERSIST-163 a failed workspace creation leaves no orphan workspace', async () => {
    // The membership insert violates its foreign key, so the batch rolls back.
    await expect(
      workspaces.createWithOwner(h.db, {
        workspaceId: 'ws_orphan',
        name: 'Acme',
        userId: 'usr_does_not_exist',
        createdAt: T0,
      }),
    ).rejects.toThrow();
    expect(countRows(h, 'workspaces')).toBe(0);
    expect(countRows(h, 'memberships')).toBe(0);
  });

  it('PERSIST-164 a soft-deleted workspace disappears from a user’s list', async () => {
    await users.createOrGet(h.db, { id: 'usr_1', authSubject: 'ada@example.com', createdAt: T0 });
    await workspaces.createWithOwner(h.db, {
      workspaceId: 'ws_1',
      name: 'Acme',
      userId: 'usr_1',
      createdAt: T0,
    });
    expect(await workspaces.softDelete(h.db, 'ws_1', LATER)).toBe(true);
    expect(await workspaces.softDelete(h.db, 'ws_1', LATER)).toBe(false);
    expect(await workspaces.listForUser(h.db, 'usr_1')).toHaveLength(0);
  });
});

describe('sessions and login tokens', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-220 a live session resolves; an expired or revoked one does not', async () => {
    await sessions.create(h.db, {
      idHash: 'hash_live',
      userId: ws.userId,
      createdAt: T0,
      expiresAt: LATER,
    });
    expect(await sessions.findLive(h.db, 'hash_live', T0)).not.toBeNull();
    // After expiry.
    expect(await sessions.findLive(h.db, 'hash_live', '2026-09-20T00:00:00.000Z')).toBeNull();
    expect(await sessions.revoke(h.db, 'hash_live', T0)).toBe(true);
    expect(await sessions.findLive(h.db, 'hash_live', T0)).toBeNull();
    // Revoking twice is not a second effect.
    expect(await sessions.revoke(h.db, 'hash_live', T0)).toBe(false);
  });

  it('AUTH-221 sign-out-everywhere revokes every live session for that user only', async () => {
    const other = seedWorkspace(h, 'beta');
    await sessions.create(h.db, { idHash: 's1', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    await sessions.create(h.db, { idHash: 's2', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    await sessions.create(h.db, { idHash: 's3', userId: other.userId, createdAt: T0, expiresAt: LATER });
    expect(await sessions.revokeAllForUser(h.db, ws.userId, LATER)).toBe(2);
    expect(await sessions.findLive(h.db, 's3', T0)).not.toBeNull();
  });

  it('AUTH-222 mfa verification and last-seen are recorded without resurrecting a revoked session', async () => {
    await sessions.create(h.db, { idHash: 's1', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    expect(await sessions.markMfaVerified(h.db, 's1', T0)).toBe(true);
    await sessions.touch(h.db, 's1', LATER);
    expect((await sessions.findLive(h.db, 's1', T0))?.last_seen_at).toBe(LATER);
    await sessions.revoke(h.db, 's1', LATER);
    expect(await sessions.markMfaVerified(h.db, 's1', LATER)).toBe(false);
  });

  it('AUTH-226 a privilege transition issues a NEW session id (fixation)', async () => {
    await sessions.create(h.db, { idHash: 'old', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    const rotated = await sessions.rotate(h.db, {
      oldIdHash: 'old',
      newIdHash: 'new',
      userId: ws.userId,
      now: T0,
      expiresAt: LATER,
      mfaVerifiedAt: T0,
    });
    expect(rotated).toBe(true);
    // The planted id is dead; only the freshly minted one works.
    expect(await sessions.findLive(h.db, 'old', T0)).toBeNull();
    const live = await sessions.findLive(h.db, 'new', T0);
    expect(live?.user_id).toBe(ws.userId);
    expect(live?.mfa_verified_at).toBe(T0);
  });

  it('AUTH-227 rotation cannot mint a session from a revoked, expired or foreign one', async () => {
    const other = seedWorkspace(h, 'beta');
    await sessions.create(h.db, { idHash: 'revoked', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    await sessions.revoke(h.db, 'revoked', T0);
    expect(
      await sessions.rotate(h.db, {
        oldIdHash: 'revoked',
        newIdHash: 'n1',
        userId: ws.userId,
        now: T0,
        expiresAt: LATER,
      }),
    ).toBe(false);
    expect(await sessions.findLive(h.db, 'n1', T0)).toBeNull();

    await sessions.create(h.db, { idHash: 'expired', userId: ws.userId, createdAt: T0, expiresAt: T0 });
    expect(
      await sessions.rotate(h.db, {
        oldIdHash: 'expired',
        newIdHash: 'n2',
        userId: ws.userId,
        now: LATER,
        expiresAt: LATER,
      }),
    ).toBe(false);
    expect(await sessions.findLive(h.db, 'n2', LATER)).toBeNull();

    // Another user's live session cannot be rotated into one of mine.
    await sessions.create(h.db, { idHash: 'theirs', userId: other.userId, createdAt: T0, expiresAt: LATER });
    expect(
      await sessions.rotate(h.db, {
        oldIdHash: 'theirs',
        newIdHash: 'n3',
        userId: ws.userId,
        now: T0,
        expiresAt: LATER,
      }),
    ).toBe(false);
    expect(await sessions.findLive(h.db, 'n3', T0)).toBeNull();
    expect(await sessions.findLive(h.db, 'theirs', T0)).not.toBeNull();
  });

  it('AUTH-228 a failed rotation leaves the old session exactly as it was', async () => {
    await sessions.create(h.db, { idHash: 'old', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    // A duplicate new id makes the insert fail, so the batch must roll the revoke back.
    await sessions.create(h.db, { idHash: 'taken', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    await expect(
      sessions.rotate(h.db, {
        oldIdHash: 'old',
        newIdHash: 'taken',
        userId: ws.userId,
        now: T0,
        expiresAt: LATER,
      }),
    ).rejects.toThrow();
    expect(await sessions.findLive(h.db, 'old', T0)).not.toBeNull();
  });

  it('AUTH-229 two concurrent rotations of one session mint only one successor', async () => {
    await sessions.create(h.db, { idHash: 'old', userId: ws.userId, createdAt: T0, expiresAt: LATER });
    const results = await Promise.all(
      ['a', 'b'].map((suffix) =>
        sessions.rotate(h.db, {
          oldIdHash: 'old',
          newIdHash: `new_${suffix}`,
          userId: ws.userId,
          now: T0,
          expiresAt: LATER,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(countRows(h, 'sessions', 'revoked_at IS NULL')).toBe(1);
  });

  it('AUTH-223 a magic-link token is consumable exactly once', async () => {
    await loginTokens.issue(h.db, {
      tokenHash: 'token_hash',
      email: 'ada@example.com',
      purpose: 'signin',
      createdAt: T0,
      expiresAt: LATER,
    });
    const first = await loginTokens.consumeOnce(h.db, 'token_hash', T0);
    expect(first).toEqual({ email: 'ada@example.com', purpose: 'signin' });
    expect(await loginTokens.consumeOnce(h.db, 'token_hash', T0)).toBeNull();
  });

  it('AUTH-224 two browsers opening the same link: only one consumes it', async () => {
    await loginTokens.issue(h.db, {
      tokenHash: 'token_hash',
      email: 'ada@example.com',
      purpose: 'signin',
      createdAt: T0,
      expiresAt: LATER,
    });
    const results = await Promise.all([
      loginTokens.consumeOnce(h.db, 'token_hash', T0),
      loginTokens.consumeOnce(h.db, 'token_hash', T0),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('AUTH-225 an expired token cannot be consumed, and an unknown one is silent', async () => {
    await loginTokens.issue(h.db, {
      tokenHash: 'expired',
      email: 'ada@example.com',
      purpose: 'signin',
      createdAt: T0,
      expiresAt: T0,
    });
    expect(await loginTokens.consumeOnce(h.db, 'expired', LATER)).toBeNull();
    expect(await loginTokens.consumeOnce(h.db, 'never-existed', T0)).toBeNull();
    await loginTokens.purgeExpired(h.db, LATER);
    expect(countRows(h, 'login_tokens')).toBe(0);
  });
});

describe('connections and credential rotation', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-170 re-authorising updates the single connection rather than adding one', async () => {
    await connections.upsert(h.db, {
      id: 'conn_1',
      workspaceId: ws.workspaceId,
      provider: 'hubspot',
      status: 'authorising',
      createdAt: T0,
    });
    const again = await connections.upsert(h.db, {
      id: 'conn_2',
      workspaceId: ws.workspaceId,
      provider: 'hubspot',
      status: 'ready',
      externalAccountId: 'hub-123',
      scopes: ['crm.objects.contacts.read'],
      createdAt: LATER,
    });
    expect(again.id).toBe('conn_1');
    expect(again.status).toBe('ready');
    expect(again.external_account_id).toBe('hub-123');
    expect(countRows(h, 'connections')).toBe(1);
  });

  it('PERSIST-171 storing a new credential retires the previous one atomically', async () => {
    await connections.upsert(h.db, {
      id: 'conn_1',
      workspaceId: ws.workspaceId,
      provider: 'hubspot',
      status: 'ready',
      createdAt: T0,
    });
    const scope = connectionScope('conn_1');
    await credentials.store(h.db, {
      id: 'cred_1',
      ownerScope: scope,
      connectionId: 'conn_1',
      keyVersion: 1,
      // secret-scan:allow synthetic base64; not a real envelope
      ciphertext: 'Y2lwaGVyMQ==',
      nonce: 'bm9uY2Vub25jZQ==',
      aad: 'v1|ws=ws_alpha|provider=hubspot|purpose=api_token',
      createdAt: T0,
    });
    await credentials.store(h.db, {
      id: 'cred_2',
      ownerScope: scope,
      connectionId: 'conn_1',
      keyVersion: 2,
      // secret-scan:allow synthetic base64; not a real envelope
      ciphertext: 'Y2lwaGVyMg==',
      nonce: 'bm9uY2Vub25jZQ==',
      aad: 'v1|ws=ws_alpha|provider=hubspot|purpose=api_token',
      createdAt: LATER,
    });
    const active = await credentials.activeForConnection(h.db, ws.workspaceId, 'conn_1');
    expect(active?.id).toBe('cred_2');
    expect(active?.key_version).toBe(2);
    expect(countRows(h, 'credential_versions', 'retired_at IS NULL')).toBe(1);
  });

  it('PERSIST-172 revoking a connection retires every credential it holds', async () => {
    await connections.upsert(h.db, {
      id: 'conn_1',
      workspaceId: ws.workspaceId,
      provider: 'resend',
      status: 'ready',
      createdAt: T0,
    });
    await credentials.store(h.db, {
      id: 'cred_1',
      ownerScope: connectionScope('conn_1'),
      connectionId: 'conn_1',
      keyVersion: 1,
      // secret-scan:allow base64 of the literal word 'cipher'; not a real envelope
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2Vub25jZQ==',
      aad: 'v1|ws=ws_alpha|provider=resend|purpose=api_token',
      createdAt: T0,
    });
    expect(await connections.revoke(h.db, ws.workspaceId, 'conn_1', LATER)).toBe(true);
    expect(await credentials.activeForConnection(h.db, ws.workspaceId, 'conn_1')).toBeNull();
    expect((await connections.getById(h.db, ws.workspaceId, 'conn_1'))?.status).toBe('revoked');
    // Revoking twice is not a second effect.
    expect(await connections.revoke(h.db, ws.workspaceId, 'conn_1', LATER)).toBe(false);
  });

  it('PERSIST-173 a credential row never carries plaintext back out', async () => {
    await connections.upsert(h.db, {
      id: 'conn_1',
      workspaceId: ws.workspaceId,
      provider: 'hubspot',
      status: 'ready',
      createdAt: T0,
    });
    await credentials.store(h.db, {
      id: 'cred_1',
      ownerScope: connectionScope('conn_1'),
      connectionId: 'conn_1',
      keyVersion: 1,
      // secret-scan:allow base64 of the literal word 'cipher'; not a real envelope
      ciphertext: 'Y2lwaGVy',
      nonce: 'bm9uY2Vub25jZQ==',
      aad: 'v1|ws=ws_alpha|provider=hubspot|purpose=api_token',
      createdAt: T0,
    });
    const row = await credentials.activeForConnection(h.db, ws.workspaceId, 'conn_1');
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ['aad', 'ciphertext', 'connection_id', 'created_at', 'id', 'key_version', 'nonce', 'owner_scope'].sort(),
    );
  });
});

describe('workflow publishing', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-180 publishing creates an immutable version and repoints the workflow', async () => {
    await workflowVersions.publish(h.db, {
      id: 'wfv_2',
      workspaceId: ws.workspaceId,
      workflowId: ws.workflowId,
      rulesJson: '{"schema_version":1}',
      rulesHash: 'hash2',
      deadlineSeconds: 900,
      schemaVersion: 1,
      createdBy: ws.userId,
      createdAt: LATER,
    });
    const versions = await workflowVersions.listForWorkflow(h.db, ws.workspaceId, ws.workflowId);
    expect(versions.map((v) => v.version_number)).toEqual([2, 1]);
    const active = await workflows.getActiveWithVersion(h.db, ws.workspaceId, ws.workflowId);
    expect(active?.version_id).toBe('wfv_2');
    expect(active?.deadline_seconds).toBe(900);
    // Version 1 is untouched, so an old report still shows the rules that applied.
    expect((await workflowVersions.get(h.db, ws.workspaceId, ws.workflowVersionId))?.rules_hash).toBe(
      'hash',
    );
  });

  it('PERSIST-181 publishing into another workspace’s workflow writes nothing', async () => {
    const other = seedWorkspace(h, 'beta');
    await expect(
      workflowVersions.publish(h.db, {
        id: 'wfv_x',
        workspaceId: other.workspaceId,
        workflowId: ws.workflowId,
        rulesJson: '{}',
        rulesHash: 'h',
        deadlineSeconds: 600,
        schemaVersion: 1,
        createdBy: other.userId,
        createdAt: LATER,
      }),
    ).rejects.toThrow(/not found/);
    expect(countRows(h, 'workflow_versions')).toBe(2);
  });

  it('PERSIST-182 a paused or archived workflow cannot start a run', async () => {
    expect(await workflows.getActiveWithVersion(h.db, ws.workspaceId, ws.workflowId)).not.toBeNull();
    await workflows.setStatus(h.db, ws.workspaceId, ws.workflowId, 'paused');
    expect(await workflows.getActiveWithVersion(h.db, ws.workspaceId, ws.workflowId)).toBeNull();
    await workflows.setStatus(h.db, ws.workspaceId, ws.workflowId, 'active');
    await workflows.archive(h.db, ws.workspaceId, ws.workflowId, LATER);
    expect(await workflows.getActiveWithVersion(h.db, ws.workspaceId, ws.workflowId)).toBeNull();
    expect(await workflows.archive(h.db, ws.workspaceId, ws.workflowId, LATER)).toBe(false);
  });

  it('PERSIST-183 touchLastEvent only ever moves forward', async () => {
    await workflows.touchLastEvent(h.db, ws.workspaceId, ws.workflowId, LATER);
    await workflows.touchLastEvent(h.db, ws.workspaceId, ws.workflowId, T0);
    expect((await workflows.get(h.db, ws.workspaceId, ws.workflowId))?.last_event_at).toBe(LATER);
  });
});

describe('webhook receipts', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-190 a retry while the first delivery is still working is in flight, not done', async () => {
    const claim = (id: string, at: string) =>
      webhookReceipts.recordOnce(h.db, {
        id,
        provider: 'stripe',
        eventId: 'evt_123',
        payloadHash: 'hash',
        receivedAt: at,
      });

    expect(await claim('whr_1', T0)).toEqual({
      outcome: 'fresh',
      receiptId: 'whr_1',
      fresh: true,
    });

    // The distinction this test exists to pin: the first handler has claimed the receipt
    // and has not finished, so the retry is 'in_flight' — "we started and died" — and not
    // 'already_processed'. Collapsing the two is how a crash permanently swallows a paid
    // invoice, because the provider's retry looks like a duplicate.
    expect(await claim('whr_2', LATER)).toEqual({
      outcome: 'in_flight',
      receiptId: 'whr_1',
      fresh: false,
    });

    await webhookReceipts.setStatus(h.db, 'whr_1', 'processed');
    expect(await claim('whr_3', LATER)).toEqual({
      outcome: 'already_processed',
      receiptId: 'whr_1',
      fresh: false,
    });

    expect(countRows(h, 'webhook_receipts')).toBe(1);
  });

  it('PERSIST-193 abandoning a claimed receipt makes the provider retry a fresh attempt', async () => {
    const claim = (id: string) =>
      webhookReceipts.recordOnce(h.db, {
        id,
        provider: 'stripe',
        eventId: 'evt_crash',
        payloadHash: 'hash',
        receivedAt: T0,
      });
    expect((await claim('whr_1')).outcome).toBe('fresh');
    // The handler threw after claiming. Without the abandon, this event is gone forever.
    expect(await webhookReceipts.abandon(h.db, 'stripe', 'evt_crash')).toBe(true);
    expect(countRows(h, 'webhook_receipts')).toBe(0);
    expect((await claim('whr_2')).outcome).toBe('fresh');
    // Abandoning something that is not there is not an error, so a retry of the retry is safe.
    expect(await webhookReceipts.abandon(h.db, 'stripe', 'never_existed')).toBe(false);
  });

  it('PERSIST-191 concurrent deliveries of one event yield exactly one fresh receipt', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((s) =>
        webhookReceipts.recordOnce(h.db, {
          id: `whr_${s}`,
          provider: 'resend',
          eventId: 'evt_dup',
          payloadHash: 'hash',
          receivedAt: T0,
        }),
      ),
    );
    expect(results.filter((r) => r.fresh)).toHaveLength(1);
    expect(new Set(results.map((r) => r.receiptId)).size).toBe(1);
  });

  it('PERSIST-192 the same event id from two providers is two distinct events', async () => {
    await webhookReceipts.recordOnce(h.db, {
      id: 'whr_1',
      provider: 'stripe',
      eventId: 'evt_1',
      payloadHash: 'h',
      receivedAt: T0,
    });
    const other = await webhookReceipts.recordOnce(h.db, {
      id: 'whr_2',
      provider: 'resend',
      eventId: 'evt_1',
      payloadHash: 'h',
      receivedAt: T0,
    });
    expect(other.fresh).toBe(true);
    expect(await webhookReceipts.setStatus(h.db, 'whr_2', 'processed')).toBe(true);
  });
});

describe('pagination, audit and settings', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-200 pages through runs without repeating or skipping a row', async () => {
    for (let i = 0; i < 7; i += 1) {
      seedRun(h, ws, `run_${i}`, {
        createdAt: `2026-09-19T10:0${i}:00.000Z`,
        nextCheckAt: null,
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await runs.listByWorkspace(h.db, ws.workspaceId, { limit: 3, cursor });
      seen.push(...result.items.map((r) => r.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['run_6', 'run_5', 'run_4', 'run_3', 'run_2', 'run_1', 'run_0']);
    expect(new Set(seen).size).toBe(7);
    expect(cursor).toBeNull();
  });

  it('PERSIST-201 a page cursor is opaque and round-trips through the repository', async () => {
    for (let i = 0; i < 4; i += 1) {
      seedRun(h, ws, `run_${i}`, { createdAt: `2026-09-19T10:0${i}:00.000Z`, nextCheckAt: null });
    }
    const first = await runs.listByWorkspace(h.db, ws.workspaceId, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor)).toEqual({
      createdAt: '2026-09-19T10:02:00.000Z',
      id: 'run_2',
    });
  });

  it('PERSIST-202 a status filter composes with the cursor', async () => {
    seedRun(h, ws, 'run_a', { status: 'VERIFIED', nextCheckAt: null, createdAt: T0 });
    seedRun(h, ws, 'run_b', { status: 'FAILED', nextCheckAt: null, createdAt: T0 });
    seedRun(h, ws, 'run_c', { status: 'VERIFIED', nextCheckAt: null, createdAt: LATER });
    const page = await runs.listByWorkspace(h.db, ws.workspaceId, { limit: 10, status: 'VERIFIED' });
    expect(page.items.map((r) => r.id)).toEqual(['run_c', 'run_a']);
  });

  it('PERSIST-203 countByStatus reports the dashboard summary for one workspace only', async () => {
    const other = seedWorkspace(h, 'beta');
    seedRun(h, ws, 'run_a', { status: 'VERIFIED', nextCheckAt: null });
    seedRun(h, ws, 'run_b', { status: 'VERIFIED', nextCheckAt: null });
    seedRun(h, ws, 'run_c', { status: 'UNVERIFIED', nextCheckAt: null });
    seedRun(h, other, 'run_d', { status: 'FAILED', nextCheckAt: null });
    expect(await runs.countByStatus(h.db, ws.workspaceId, '2026-01-01T00:00:00.000Z')).toEqual({
      VERIFIED: 2,
      UNVERIFIED: 1,
    });
  });

  it('PERSIST-204 audit rows are workspace-scoped and page in reverse time order', async () => {
    const other = seedWorkspace(h, 'beta');
    await auditEvents.record(h.db, {
      id: 'aud_1',
      actor: ws.userId,
      actorKind: 'user',
      action: 'workflow.published',
      occurredAt: T0,
      workspaceId: ws.workspaceId,
      requestId: 'req_1',
      redactedMetadata: '{"email":"a**@example.com"}',
    });
    await auditEvents.record(h.db, {
      id: 'aud_2',
      actor: ws.userId,
      actorKind: 'user',
      action: 'connection.revoked',
      occurredAt: LATER,
      workspaceId: ws.workspaceId,
    });
    await auditEvents.record(h.db, {
      id: 'aud_3',
      actor: other.userId,
      actorKind: 'user',
      action: 'workflow.published',
      occurredAt: LATER,
      workspaceId: other.workspaceId,
    });
    const page = await auditEvents.listForWorkspace(h.db, ws.workspaceId, { limit: 10 });
    expect(page.items.map((r) => r.id)).toEqual(['aud_2', 'aud_1']);
    expect(await auditEvents.listPlatform(h.db, 10)).toHaveLength(3);
  });

  it('PERSIST-205 settings upsert and survive a corrupted value', async () => {
    await settings.set(h.db, { key: 'access_mode', valueJson: '"PUBLIC_LOGIN"', updatedAt: T0 });
    expect(await settings.getJson(h.db, 'access_mode', 'RESTRICTED_ENTRY')).toBe('PUBLIC_LOGIN');
    await settings.set(h.db, {
      key: 'access_mode',
      valueJson: 'not json',
      updatedAt: LATER,
      updatedBy: ws.userId,
    });
    expect(await settings.getJson(h.db, 'access_mode', 'RESTRICTED_ENTRY')).toBe('RESTRICTED_ENTRY');
    expect(await settings.getJson(h.db, 'never_set', 42)).toBe(42);
    expect(countRows(h, 'settings')).toBe(1);
    expect(await settings.list(h.db)).toHaveLength(1);
  });
});
