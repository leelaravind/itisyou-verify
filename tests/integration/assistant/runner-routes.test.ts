/**
 * The runner HTTP surface, through the real Hono router, against a real database.
 *
 * Two facts an audit found on 2026-09-19 and these cases pin:
 *
 *  1. `GET /api/v1/runner/status` was unauthenticated. Its comment said an owner middleware
 *     stood in front of it; none did, and the composition root mounts the router bare. It
 *     is now device-signed like every other runner endpoint.
 *  2. No production code could mint a pairing code, because there was no database-backed
 *     `RunnerPairingPort`. `D1RunnerPairingPort` is that port. The composition root still
 *     has to pass it to the owner routes — that is the lead's file — but the port itself
 *     mints a code the real `/pair` endpoint redeems, exactly once.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, utf8Bytes } from '@verify/security';
import {
  D1RunnerPairingPort,
  RUNNER_HEADERS,
  canonicalRunnerString,
  createRunnerRoutes,
} from '@app/maintenance/index';
import { createTestDb, type TestDb } from '../db/harness';

const NOW = new Date('2026-09-19T12:00:00.000Z');

async function keypair() {
  const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return { pair, publicKeyBase64: Buffer.from(raw).toString('base64') };
}

/** Sign a request the way `tools/maintenance-runner/identity.mjs` does. */
async function signedHeaders(
  deviceId: string,
  privateKey: CryptoKey,
  method: string,
  path: string,
  rawBody: string,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const message = canonicalRunnerString({
    deviceId,
    timestamp,
    method,
    path,
    bodyHashHex: await sha256Hex(utf8Bytes(rawBody)),
  });
  const signature = new Uint8Array(
    await webcrypto.subtle.sign('Ed25519', privateKey, Buffer.from(message, 'utf8')),
  );
  return {
    [RUNNER_HEADERS.device]: deviceId,
    [RUNNER_HEADERS.timestamp]: timestamp,
    [RUNNER_HEADERS.signature]: Buffer.from(signature).toString('base64'),
  };
}

describe('runner routes — signed everywhere, and pairing can actually begin', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
    h.raw
      .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
      .run('usr_owner', 'owner@example.com', NOW.toISOString());
  });
  afterEach(() => {
    h.close();
  });

  it('OWNER-245 GET /status refuses an unsigned request and admits a paired device', async () => {
    const app = createRunnerRoutes({ db: () => h.db, now: () => NOW.toISOString() });

    // Unsigned: refused, and the body says nothing about devices or jobs.
    const anonymous = await app.request('/status');
    expect(anonymous.status).toBe(401);
    const refused = (await anonymous.json()) as { error: { code: string } };
    expect(refused.error.code).toBe('MISSING_HEADERS');
    expect(JSON.stringify(refused)).not.toContain('devices');

    // Pair a device through the real port and the real endpoint.
    const pairing = new D1RunnerPairingPort(h.db);
    const opened = await pairing.openPairing({ label: 'laptop', ownerId: 'usr_owner', now: NOW });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.dependency);
    const { pair, publicKeyBase64 } = await keypair();
    const paired = await app.request('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: opened.invitation.code, public_key: publicKeyBase64 }),
    });
    expect(paired.status).toBe(200);

    // A forged signature from an unknown device is refused too.
    const stranger = await keypair();
    const forged = await app.request('/status', {
      headers: await signedHeaders('rdv_nobody', stranger.pair.privateKey, 'GET', '/status', ''),
    });
    expect(forged.status).toBe(401);

    // The paired device, correctly signed: admitted.
    const signed = await app.request('/status', {
      headers: await signedHeaders(
        opened.invitation.deviceId,
        pair.privateKey,
        'GET',
        '/status',
        '',
      ),
    });
    expect(signed.status).toBe(200);
    const view = (await signed.json()) as {
      hosted_service_unaffected: boolean;
      devices: { id: string; status: string }[];
    };
    expect(view.hosted_service_unaffected).toBe(true);
    expect(view.devices.map((d) => d.id)).toEqual([opened.invitation.deviceId]);
  });

  it('OWNER-246 D1RunnerPairingPort mints a code the real /pair endpoint redeems exactly once, storing only its hash', async () => {
    const app = createRunnerRoutes({ db: () => h.db, now: () => NOW.toISOString() });
    const pairing = new D1RunnerPairingPort(h.db);

    const opened = await pairing.openPairing({ label: 'desk machine', ownerId: 'usr_owner', now: NOW });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.dependency);
    expect(opened.invitation.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(opened.invitation.expiresAt).toBe('2026-09-19T12:10:00.000Z');

    // The database holds a hash, never the code.
    const pending = h.raw
      .prepare('SELECT status, pairing_code_hash, public_key, label FROM runner_devices WHERE id = ?')
      .get(opened.invitation.deviceId) as {
      status: string;
      pairing_code_hash: string | null;
      public_key: string;
      label: string;
    };
    expect(pending.status).toBe('pending_pair');
    expect(pending.label).toBe('desk machine');
    expect(pending.pairing_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.pairing_code_hash).not.toContain(opened.invitation.code);
    expect(pending.public_key).toBe('');

    const { publicKeyBase64 } = await keypair();
    const first = await app.request('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: opened.invitation.code, public_key: publicKeyBase64 }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      device_id: opened.invitation.deviceId,
      label: 'desk machine',
      status: 'active',
    });

    // Second redemption of the same code, by another machine: refused, nothing changes.
    const second = await app.request('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: opened.invitation.code,
        public_key: (await keypair()).publicKeyBase64,
      }),
    });
    expect(second.status).toBe(403);

    const active = h.raw
      .prepare('SELECT status, pairing_code_hash, public_key FROM runner_devices WHERE id = ?')
      .get(opened.invitation.deviceId) as {
      status: string;
      pairing_code_hash: string | null;
      public_key: string;
    };
    expect(active).toEqual({ status: 'active', pairing_code_hash: null, public_key: publicKeyBase64 });

    // A principal with no user row cannot open a pairing: the FK refuses, the port says so
    // in plain words, and no half-written device row exists.
    const orphan = await pairing.openPairing({ label: 'x', ownerId: 'unknown', now: NOW });
    expect(orphan.ok).toBe(false);
    if (orphan.ok) throw new Error('unreachable');
    expect(orphan.dependency).toContain('no pairing code has been created');
    expect(
      (h.raw.prepare('SELECT COUNT(*) AS n FROM runner_devices').get() as { n: number }).n,
    ).toBe(1);
  });
});
