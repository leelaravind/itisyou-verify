/**
 * The maintenance connector, hosted side, against a real database.
 *
 * The cases that matter most are the ones about what happens when the runner is **not**
 * there — because that is the normal state of a laptop, and the product has to be correct
 * in it.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNNER_HEADERS,
  authenticateRunner,
  canonicalRunnerString,
  completePairing,
  enqueueJob,
  generatePairingCode,
  hashPairingCode,
  leaseOneJob,
  markBriefReviewed,
  openPairing,
  presenceOf,
  recordJobResult,
  runnerAvailability,
  runnerDevices,
  runnerStatus,
  maintenanceJobs,
} from '@app/maintenance/index';
import { briefFromNaturalLanguage } from '@app/maintenance/kinds';
import { D1AssistantStatusPort, D1MaintenanceRunnerPort } from '@app/maintenance/ownerPort';
import { runs, entitlements, settings } from '@app/db/index';
import {
  createTestDb,
  seedBudgetAccount,
  seedRun,
  seedWorkspace,
  type TestDb,
} from '../db/harness';

const NOW = '2026-09-19T12:00:00.000Z';
const LATER = '2026-09-19T12:30:00.000Z';

async function keypair() {
  const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return { pair, publicKeyBase64: Buffer.from(raw).toString('base64') };
}

async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = new Uint8Array(
    await webcrypto.subtle.sign('Ed25519', privateKey, Buffer.from(message, 'utf8')),
  );
  return Buffer.from(signature).toString('base64');
}

function seedOwner(h: TestDb): void {
  h.raw
    .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
    .run('usr_owner', 'owner@example.com', NOW);
}

async function pairDevice(h: TestDb, deviceId: string) {
  const { pair, publicKeyBase64 } = await keypair();
  const invitation = await openPairing(h.db, {
    deviceId,
    ownerId: 'usr_owner',
    label: `device ${deviceId}`,
    now: NOW,
  });
  const result = await completePairing(h.db, {
    code: invitation.code,
    publicKey: publicKeyBase64,
    now: NOW,
  });
  if (!result.ok) throw new Error('pairing failed in fixture');
  return { deviceId, privateKey: pair.privateKey, code: invitation.code, publicKeyBase64 };
}

describe('maintenance runner', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
    seedOwner(h);
  });
  afterEach(() => {
    h.close();
  });

  it('OWNER-201 a device pairs only with a valid, unexpired code and becomes active', async () => {
    const { publicKeyBase64 } = await keypair();
    const invitation = await openPairing(h.db, {
      deviceId: 'dev_1',
      ownerId: 'usr_owner',
      label: 'laptop',
      now: NOW,
    });
    expect(invitation.code).toMatch(/^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/);

    const wrong = await completePairing(h.db, {
      code: generatePairingCode(),
      publicKey: publicKeyBase64,
      now: NOW,
    });
    expect(wrong).toMatchObject({ ok: false, reason: 'INVALID_CODE' });

    const ok = await completePairing(h.db, {
      code: invitation.code,
      publicKey: publicKeyBase64,
      now: NOW,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.device.status).toBe('active');
    expect(ok.device.public_key).toBe(publicKeyBase64);
  });

  it('OWNER-202 a pairing code is stored only as a hash, and a bad public key is refused', async () => {
    const invitation = await openPairing(h.db, {
      deviceId: 'dev_1',
      ownerId: 'usr_owner',
      label: 'laptop',
      now: NOW,
    });
    const row = h.raw
      .prepare('SELECT pairing_code_hash FROM runner_devices WHERE id = ?')
      .get('dev_1') as { pairing_code_hash: string };
    expect(row.pairing_code_hash).not.toBe(invitation.code);
    expect(row.pairing_code_hash).toBe(await hashPairingCode(invitation.code));
    expect(row.pairing_code_hash).toMatch(/^[0-9a-f]{64}$/);

    // A key that is not a 32-byte Ed25519 public key never reaches the database.
    const refused = await completePairing(h.db, {
      code: invitation.code,
      publicKey: 'not-a-key',
      now: NOW,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'INVALID_PUBLIC_KEY' });
  });

  it('OWNER-203 a pairing code is single-use and expires', async () => {
    const { publicKeyBase64 } = await keypair();
    const invitation = await openPairing(h.db, {
      deviceId: 'dev_1',
      ownerId: 'usr_owner',
      label: 'laptop',
      now: NOW,
    });
    expect(
      (await completePairing(h.db, { code: invitation.code, publicKey: publicKeyBase64, now: NOW }))
        .ok,
    ).toBe(true);
    // A second redemption of the same code finds nothing to update.
    expect(
      await completePairing(h.db, { code: invitation.code, publicKey: publicKeyBase64, now: NOW }),
    ).toMatchObject({ ok: false, reason: 'INVALID_CODE' });

    // And an unredeemed code is dead once its window closes.
    const stale = await openPairing(h.db, {
      deviceId: 'dev_2',
      ownerId: 'usr_owner',
      label: 'desktop',
      now: NOW,
    });
    expect(
      await completePairing(h.db, {
        code: stale.code,
        publicKey: publicKeyBase64,
        now: '2026-09-19T12:59:00.000Z',
      }),
    ).toMatchObject({ ok: false, reason: 'INVALID_CODE' });
  });

  it('OWNER-204 an Ed25519-signed request authenticates, and any tampering does not', async () => {
    const device = await pairDevice(h, 'dev_1');
    const body = JSON.stringify({ hello: 'world' });
    const timestamp = String(Math.floor(Date.parse(NOW) / 1000));
    const bodyHashHex = Buffer.from(
      await webcrypto.subtle.digest('SHA-256', Buffer.from(body, 'utf8')),
    ).toString('hex');
    const message = canonicalRunnerString({
      deviceId: 'dev_1',
      timestamp,
      method: 'POST',
      path: '/lease',
      bodyHashHex,
    });
    const signature = await sign(device.privateKey, message);

    const parts = {
      deviceId: 'dev_1',
      timestamp,
      signature,
      method: 'POST',
      path: '/lease',
      rawBody: body,
    };
    expect(await authenticateRunner(h.db, parts, Date.parse(NOW))).toMatchObject({ ok: true });

    // A different body, a different path and a stale clock all fail.
    expect(
      await authenticateRunner(h.db, { ...parts, rawBody: '{"hello":"evil"}' }, Date.parse(NOW)),
    ).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(
      await authenticateRunner(h.db, { ...parts, path: '/jobs/x/result' }, Date.parse(NOW)),
    ).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(await authenticateRunner(h.db, parts, Date.parse(NOW) + 3_600_000)).toMatchObject({
      ok: false,
      reason: 'TIMESTAMP_STALE',
    });
    expect(
      await authenticateRunner(
        h.db,
        { ...parts, deviceId: null, signature: null, timestamp: null },
        Date.parse(NOW),
      ),
    ).toMatchObject({ ok: false, reason: 'MISSING_HEADERS' });
    expect(Object.values(RUNNER_HEADERS)).toContain('x-runner-signature');
  });

  it('OWNER-205 a revoked device cannot claim a job or post a result', async () => {
    const device = await pairDevice(h, 'dev_1');
    await enqueueJob({
      db: h.db,
      kind: 'run_health_checks',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });
    const lease = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('unreachable');

    await runnerDevices.revoke(h.db, 'dev_1', NOW);

    // Authentication refuses it before anything else considers the request.
    const timestamp = String(Math.floor(Date.parse(NOW) / 1000));
    const bodyHashHex = Buffer.from(
      await webcrypto.subtle.digest('SHA-256', Buffer.from('', 'utf8')),
    ).toString('hex');
    const signature = await sign(
      device.privateKey,
      canonicalRunnerString({
        deviceId: 'dev_1',
        timestamp,
        method: 'POST',
        path: '/lease',
        bodyHashHex,
      }),
    );
    expect(
      await authenticateRunner(
        h.db,
        { deviceId: 'dev_1', timestamp, signature, method: 'POST', path: '/lease', rawBody: '' },
        Date.parse(NOW),
      ),
    ).toMatchObject({ ok: false, reason: 'DEVICE_REVOKED' });

    // And the result path refuses it independently, so neither gate is load-bearing alone.
    const posted = await recordJobResult({
      db: h.db,
      jobId: lease.job.job_id,
      deviceId: 'dev_1',
      nonce: lease.job.lease_nonce,
      body: { outcome: 'passed', summary: 'all good' },
      now: NOW,
    });
    expect(posted).toMatchObject({ ok: false, reason: 'DEVICE_REVOKED' });
  });

  it('OWNER-206 two runners racing for one job produce exactly one claim', async () => {
    await pairDevice(h, 'dev_1');
    await pairDevice(h, 'dev_2');
    await enqueueJob({
      db: h.db,
      kind: 'run_test_suite',
      payload: { suite: 'unit' },
      requestedBy: 'usr_owner',
      now: NOW,
    });

    const [first, second] = await Promise.all([
      leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW }),
      leaseOneJob({ db: h.db, deviceId: 'dev_2', now: NOW }),
    ]);
    const winners = [first, second].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const row = h.raw.prepare('SELECT state, lease_device_id FROM maintenance_jobs').get() as {
      state: string;
      lease_device_id: string;
    };
    expect(row.state).toBe('leased');
    expect(['dev_1', 'dev_2']).toContain(row.lease_device_id);

    // Ten more attempts find nothing left to claim.
    for (let i = 0; i < 10; i += 1) {
      expect((await leaseOneJob({ db: h.db, deviceId: 'dev_2', now: NOW })).ok).toBe(false);
    }
  });

  it('OWNER-207 an expired lease is reclaimable, and the stale holder cannot post a result', async () => {
    await pairDevice(h, 'dev_1');
    await pairDevice(h, 'dev_2');
    await enqueueJob({
      db: h.db,
      kind: 'run_health_checks',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });

    const first = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW, leaseSeconds: 60 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    // Still held, so nobody else gets it.
    expect((await leaseOneJob({ db: h.db, deviceId: 'dev_2', now: NOW })).ok).toBe(false);

    // Half an hour later the lease has expired and the job returns to service.
    const second = await leaseOneJob({ db: h.db, deviceId: 'dev_2', now: LATER });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.job.job_id).toBe(first.job.job_id);
    expect(second.job.lease_nonce).not.toBe(first.job.lease_nonce);

    // The original holder waking up late cannot overwrite the new lease.
    const stale = await recordJobResult({
      db: h.db,
      jobId: first.job.job_id,
      deviceId: 'dev_1',
      nonce: first.job.lease_nonce,
      body: { outcome: 'passed', summary: 'stale' },
      now: LATER,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'LEASE_MISMATCH' });
  });

  it('OWNER-208 a duplicate job result is idempotent and returns the original outcome', async () => {
    await pairDevice(h, 'dev_1');
    await enqueueJob({
      db: h.db,
      kind: 'run_health_checks',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });
    const lease = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW });
    if (!lease.ok) throw new Error('unreachable');

    const body = { outcome: 'failed', summary: 'typecheck reported 3 errors' };
    const first = await recordJobResult({
      db: h.db,
      jobId: lease.job.job_id,
      deviceId: 'dev_1',
      nonce: lease.job.lease_nonce,
      body,
      now: NOW,
    });
    expect(first).toEqual({ ok: true, state: 'failed', duplicate: false });

    // The same POST again — a retried network call — reports the original, changes nothing.
    const again = await recordJobResult({
      db: h.db,
      jobId: lease.job.job_id,
      deviceId: 'dev_1',
      nonce: lease.job.lease_nonce,
      body: { outcome: 'passed', summary: 'a different story' },
      now: LATER,
    });
    expect(again).toEqual({ ok: true, state: 'failed', duplicate: true });

    const row = await maintenanceJobs.get(h.db, lease.job.job_id);
    expect(row?.state).toBe('failed');
    expect(row?.result_json).toContain('typecheck reported 3 errors');
    expect(row?.result_json).not.toContain('a different story');
  });

  it('OWNER-209 a result from another device, or with an invalid schema, is refused', async () => {
    await pairDevice(h, 'dev_1');
    await pairDevice(h, 'dev_2');
    await enqueueJob({
      db: h.db,
      kind: 'run_health_checks',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });
    const lease = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW });
    if (!lease.ok) throw new Error('unreachable');

    expect(
      await recordJobResult({
        db: h.db,
        jobId: lease.job.job_id,
        deviceId: 'dev_2',
        nonce: lease.job.lease_nonce,
        body: { outcome: 'passed', summary: 'not mine to report' },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'LEASE_MISMATCH' });

    expect(
      await recordJobResult({
        db: h.db,
        jobId: lease.job.job_id,
        deviceId: 'dev_1',
        nonce: lease.job.lease_nonce,
        body: { outcome: 'definitely_fine' },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'INVALID_RESULT' });

    expect(
      await recordJobResult({
        db: h.db,
        jobId: 'mjb_nope',
        deviceId: 'dev_1',
        nonce: lease.job.lease_nonce,
        body: { outcome: 'passed' },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'JOB_NOT_FOUND' });

    // The job is still leased and still runnable. A refused result strands nothing.
    expect((await maintenanceJobs.get(h.db, lease.job.job_id))?.state).toBe('leased');
  });

  it('OWNER-210 a heartbeat updates presence without extending a job lease', async () => {
    await pairDevice(h, 'dev_1');
    await enqueueJob({
      db: h.db,
      kind: 'run_health_checks',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });
    const lease = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW, leaseSeconds: 60 });
    if (!lease.ok) throw new Error('unreachable');
    const before = (await maintenanceJobs.get(h.db, lease.job.job_id))?.lease_expires_at;

    expect(await runnerDevices.heartbeat(h.db, 'dev_1', LATER)).toBe(true);
    const after = (await maintenanceJobs.get(h.db, lease.job.job_id))?.lease_expires_at;
    expect(after).toBe(before);

    const device = await runnerDevices.get(h.db, 'dev_1');
    expect(device?.last_heartbeat_at).toBe(LATER);
    expect(presenceOf(device!, LATER)).toBe('online');
    expect(presenceOf(device!, '2026-09-19T13:30:00.000Z')).toBe('offline');

    // A revoked device's heartbeat is ignored entirely.
    await runnerDevices.revoke(h.db, 'dev_1', LATER);
    expect(await runnerDevices.heartbeat(h.db, 'dev_1', '2026-09-19T12:31:00.000Z')).toBe(false);
  });

  it('OWNER-211 with no device paired a job queues, and the UI is told exactly why', async () => {
    const availability = await runnerAvailability(h.db, NOW);
    expect(availability.online).toBe(false);
    expect(availability.reason).toContain('No maintenance runner is paired');

    const queued = await enqueueJob({
      db: h.db,
      kind: 'run_test_suite',
      payload: { suite: 'unit' },
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) throw new Error('unreachable');
    expect(queued.state).toBe('queued');
    expect(queued.queuedBecause).toContain('No maintenance runner is paired');

    // Paired but silent for an hour: still queued, with a different, accurate reason.
    await pairDevice(h, 'dev_1');
    await runnerDevices.heartbeat(h.db, 'dev_1', NOW);
    const offline = await runnerAvailability(h.db, '2026-09-19T13:00:00.000Z');
    expect(offline.online).toBe(false);
    expect(offline.reason).toContain('offline');

    const status = await runnerStatus(h.db, '2026-09-19T13:00:00.000Z');
    expect(status.hosted_service_unaffected).toBe(true);
    expect(status.devices[0]?.presence).toBe('offline');
    expect(status.jobs_by_state['queued']).toBe(1);
    expect(status.last_successful_job).toBeNull();
  });

  it('OWNER-212 customer service is completely unaffected while the runner is offline', async () => {
    const ws = seedWorkspace(h, 'live');
    seedRun(h, ws, 'run_live0000000000000000000');

    // A full queue of maintenance work, and no runner anywhere.
    for (const kind of ['run_health_checks', 'collect_redacted_diagnostics'] as const) {
      const outcome = await enqueueJob({
        db: h.db,
        kind,
        payload: kind === 'collect_redacted_diagnostics' ? { area: 'database' } : {},
        requestedBy: 'usr_owner',
        now: NOW,
      });
      expect(outcome.ok).toBe(true);
    }
    expect((await runnerAvailability(h.db, NOW)).online).toBe(false);

    // Verification, entitlement accounting and the scheduler all behave exactly as normal.
    const run = await runs.get(h.db, ws.workspaceId, 'run_live0000000000000000000');
    expect(run?.status).toBe('PENDING');
    const claimed = await runs.claimDue(h.db, {
      now: NOW,
      limit: 10,
      leaseSeconds: 60,
      leaseUntil: LATER,
    });
    expect(claimed.map((r) => r.id)).toContain('run_live0000000000000000000');
    expect(await entitlements.reserve(h.db, ws.workspaceId, ws.billingPeriod, NOW)).toBe(true);

    // And nothing about the queue changed as a result of any of that.
    const counts = await maintenanceJobs.countByState(h.db);
    expect(counts['queued']).toBe(2);
  });

  it('OWNER-213 a coding-agent job cannot be queued while its brief is unreviewed', async () => {
    const brief = briefFromNaturalLanguage({
      summary: 'look into the webhook backlog',
      context: 'started after Tuesday',
    });
    const refused = await enqueueJob({
      db: h.db,
      kind: 'investigate_incident',
      payload: { incident_ref: 'inc_1', brief, paths: ['apps/app/src'] },
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.refusal.code).toBe('BRIEF_NOT_REVIEWED');

    const accepted = await enqueueJob({
      db: h.db,
      kind: 'investigate_incident',
      payload: {
        incident_ref: 'inc_1',
        brief: markBriefReviewed(brief, 'usr_owner'),
        paths: ['apps/app/src'],
      },
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(accepted.ok).toBe(true);
  });

  it('OWNER-214 a release job cannot be queued without a bound approval, and naming an approval is not the same as holding one', async () => {
    const refused = await enqueueJob({
      db: h.db,
      kind: 'execute_approved_release',
      payload: { environment: 'production', approval_id: 'apr_1' },
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.refusal.code).toBe('APPROVAL_REQUIRED');

    // This case used to assert the opposite: that `approvalId: 'apr_1'` — a string matching
    // no row — was ACCEPTED and produced a job. That codified the hole. The approval is now
    // loaded, and a string that is not an approval is refused with no job row. The accepted
    // path, with the approval genuinely spent first, is `release-approval.test.ts`.
    const fabricated = await enqueueJob({
      db: h.db,
      kind: 'execute_approved_release',
      payload: { environment: 'production', approval_id: 'apr_1' },
      requestedBy: 'usr_owner',
      now: NOW,
      approvalId: 'apr_1',
    });
    expect(fabricated.ok).toBe(false);
    if (fabricated.ok) throw new Error('a fabricated approval id queued a release');
    expect(fabricated.refusal.code).toBe('APPROVAL_INVALID');

    const counts = await maintenanceJobs.countByState(h.db);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
    const audit = h.raw
      .prepare(
        "SELECT action, redacted_metadata FROM audit_events WHERE action = 'maintenance.job.enqueued'",
      )
      .all() as { action: string; redacted_metadata: string }[];
    // Neither refusal wrote a job, so neither wrote an enqueue event.
    expect(audit).toHaveLength(0);
  });

  it("OWNER-223 A07's owner port reports the real state and never invents a heartbeat", async () => {
    const port = new D1MaintenanceRunnerPort(h.db, () => NOW);

    // Nothing paired: not connected, no heartbeat, and a reason rather than a blank.
    const empty = await port.status();
    expect(empty.connected).toBe(false);
    expect(empty.lastHeartbeatAt).toBeNull();
    expect(empty.heartbeatAgeSeconds).toBeNull();
    expect(empty.unavailableReason).toContain('No maintenance runner is paired');
    expect(empty.queuedJobs).toBe(0);

    // A queued job carries the same reason through to the job row the page renders.
    const enqueued = await port.enqueue({
      kind: 'run_health_checks',
      requestedBy: 'usr_owner',
      at: NOW,
      idempotencyKey: 'k1',
    });
    expect(enqueued.ok).toBe(true);
    if (!enqueued.ok) throw new Error('unreachable');
    expect(enqueued.job.state).toBe('queued');
    expect(enqueued.job.blockedReason).toContain('No maintenance runner is paired');

    // The same submission again is deduplicated rather than queued twice.
    const twice = await port.enqueue({
      kind: 'run_health_checks',
      requestedBy: 'usr_owner',
      at: NOW,
      idempotencyKey: 'k1',
    });
    expect(twice).toMatchObject({ ok: true, deduplicated: true });
    expect(await maintenanceJobs.countByState(h.db)).toEqual({ queued: 1 });

    // An unknown kind is refused by the port, not turned into a job.
    expect(
      await port.enqueue({
        kind: 'rm_minus_rf',
        requestedBy: 'usr_owner',
        at: NOW,
        idempotencyKey: 'k2',
      }),
    ).toMatchObject({ ok: false, reason: 'kind_not_allowed' });

    // Once a device is paired and has just reported, the page says connected.
    await pairDevice(h, 'dev_1');
    await runnerDevices.heartbeat(h.db, 'dev_1', NOW);
    const live = await port.status();
    expect(live.connected).toBe(true);
    expect(live.deviceLabel).toBe('device dev_1');
    expect(live.heartbeatAgeSeconds).toBe(0);
    expect(live.unavailableReason).toBeNull();

    // A heartbeat older than A07's freshness window is not a heartbeat.
    const stale = new D1MaintenanceRunnerPort(h.db, () => '2026-09-19T12:05:00.000Z').status();
    expect((await stale).connected).toBe(false);
    expect((await stale).heartbeatAgeSeconds).toBe(300);
  });

  it('OWNER-224 the assistant status port reports "unmeasured" as null, never as zero', async () => {
    const port = new D1AssistantStatusPort(h.db);

    const off = await port.status();
    expect(off.mode).toBe('off');
    expect(off.enabled).toBe(false);
    // Not zero: we have not measured it, and the panel must be able to say so.
    expect(off.spentMinor).toBeNull();
    expect(off.budgetMinor).toBeNull();
    expect(off.unavailableReason).toContain('switched off');

    await settings.set(h.db, {
      key: 'assistant.config',
      valueJson: JSON.stringify({
        mode: 'paid_api',
        paidProvider: 'openrouter',
        paidModelId: 'vendor/model',
        perRequestCapMinor: 50,
        cumulativeCapMinor: 1_000,
        budgetAccountId: 'bac_assistant',
      }),
      updatedAt: NOW,
      updatedBy: 'usr_owner',
    });

    // Configured, but the account does not exist yet: still null, still not zero.
    const unmeasured = await port.status();
    expect(unmeasured.mode).toBe('paid_api');
    expect(unmeasured.spentMinor).toBeNull();
    expect(unmeasured.budgetMinor).toBe(1_000);

    seedBudgetAccount(h, 'bac_assistant', {
      scope: 'assistant',
      limitMinor: 10_000,
      spentMinor: 42,
    });
    const measured = await port.status();
    expect(measured.spentMinor).toBe(42);
  });
});
