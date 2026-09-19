/**
 * `POST /api/v1/runner/*` — the outbound-polling maintenance API.
 *
 * Mount it from the lead's `apps/app/src/index.ts`:
 *
 *     import { createRunnerRoutes } from './maintenance/routes.js';
 *     app.route('/api/v1/runner', createRunnerRoutes({ db: (c) => c.env.DB }));
 *
 * Every route here is called **by** the owner's local runner. None of them calls out to it.
 * There is no endpoint in this file, or anywhere in this codebase, that opens a connection
 * towards the owner's machine — the hosted service cannot initiate anything, which is the
 * honest shape of this feature and the reason it is labelled a *connector*, not control.
 *
 * Status codes follow the brief: 401 for an unauthenticated device, 403 for a revoked one,
 * 404 when there is no job, 409 when a lease no longer holds, 422 for a payload that does
 * not match its schema, 200 for a duplicate result (the original outcome).
 */
import { Hono } from 'hono';
import type { Db } from '../db/d1.js';
import { authenticateRunner, completePairing, readRunnerHeaders } from './devices.js';
import { leaseOneJob, recordJobResult, runnerStatus } from './jobs.js';
import { runnerDevices } from './store.js';

export interface RunnerRouteDeps {
  /** Resolve the database for a request. Injected so tests can pass the SQLite harness. */
  readonly db: (c: { env: unknown }) => Db;
  readonly now?: () => string;
}

const AUTH_STATUS: Record<string, number> = {
  MISSING_HEADERS: 401,
  UNKNOWN_DEVICE: 401,
  BAD_SIGNATURE: 401,
  TIMESTAMP_STALE: 401,
  DEVICE_NOT_ACTIVE: 403,
  DEVICE_REVOKED: 403,
};

export function createRunnerRoutes(deps: RunnerRouteDeps): Hono {
  const app = new Hono();
  const clock = deps.now ?? (() => new Date().toISOString());

  /**
   * Redeem a one-time pairing code. Unsigned by necessity — this is the request in which
   * the device first presents its public key — and protected instead by the code being
   * single-use, hashed at rest and short-lived.
   */
  app.post('/pair', async (c) => {
    const db = deps.db(c as unknown as { env: unknown });
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_BODY', message: 'expected JSON' } }, 400);
    }
    const source = (body ?? {}) as Record<string, unknown>;
    const code = source['code'];
    const publicKey = source['public_key'];
    if (typeof code !== 'string' || typeof publicKey !== 'string') {
      return c.json(
        { error: { code: 'INVALID_BODY', message: 'code and public_key are required' } },
        422,
      );
    }
    const result = await completePairing(db, { code, publicKey, now: clock() });
    if (!result.ok) {
      return c.json({ error: { code: result.reason, message: result.detail } }, 403);
    }
    return c.json({ device_id: result.device.id, label: result.device.label, status: 'active' });
  });

  /** Heartbeat. Updates presence and nothing else — it never extends a job lease. */
  app.post('/heartbeat', async (c) => {
    const db = deps.db(c as unknown as { env: unknown });
    const raw = await c.req.text();
    const auth = await authenticate(db, c.req.raw.headers, 'POST', '/heartbeat', raw);
    if (!auth.ok) return c.json({ error: { code: auth.reason } }, statusFor(auth.reason));
    const now = clock();
    await runnerDevices.heartbeat(db, auth.device.id, now);
    return c.json({ acknowledged_at: now });
  });

  /**
   * Claim exactly one job. The compare-and-set lives in `store.ts`; two devices polling at
   * the same instant produce exactly one claim.
   */
  app.post('/lease', async (c) => {
    const db = deps.db(c as unknown as { env: unknown });
    const raw = await c.req.text();
    const auth = await authenticate(db, c.req.raw.headers, 'POST', '/lease', raw);
    if (!auth.ok) return c.json({ error: { code: auth.reason } }, statusFor(auth.reason));

    const now = clock();
    // A lease request is also a sign of life; presence should not depend on a separate call.
    await runnerDevices.heartbeat(db, auth.device.id, now);

    const lease = await leaseOneJob({ db, deviceId: auth.device.id, now });
    // 200 with an explicit `job: null`, not 204: a body that says "there is no work" is
    // unambiguous for a poller, and 204 forbids one.
    if (!lease.ok) return c.json({ job: null });
    return c.json({ job: lease.job });
  });

  /** Post the result for a leased job. Lease-bound, schema-validated, redacted, idempotent. */
  app.post('/jobs/:id/result', async (c) => {
    const db = deps.db(c as unknown as { env: unknown });
    const jobId = c.req.param('id');
    const raw = await c.req.text();
    const auth = await authenticate(db, c.req.raw.headers, 'POST', `/jobs/${jobId}/result`, raw);
    if (!auth.ok) return c.json({ error: { code: auth.reason } }, statusFor(auth.reason));

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: 'INVALID_BODY', message: 'expected JSON' } }, 400);
    }
    const source = (body ?? {}) as Record<string, unknown>;
    const nonce = source['lease_nonce'];
    if (typeof nonce !== 'string' || nonce.length === 0) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'lease_nonce is required' } }, 422);
    }

    const outcome = await recordJobResult({
      db,
      jobId,
      deviceId: auth.device.id,
      nonce,
      body: source['result'],
      now: clock(),
    });
    if (!outcome.ok) {
      const status =
        outcome.reason === 'JOB_NOT_FOUND'
          ? 404
          : outcome.reason === 'INVALID_RESULT'
            ? 422
            : outcome.reason === 'DEVICE_REVOKED'
              ? 403
              : 409;
      return c.json({ error: { code: outcome.reason, message: outcome.detail } }, status);
    }
    return c.json({ state: outcome.state, duplicate: outcome.duplicate });
  });

  /**
   * The owner's view. Read-only and safe to render on every dashboard load.
   *
   * Access control is the owner middleware A07 mounts in front of this router; this handler
   * deliberately does not invent its own, so there is exactly one owner gate in the app.
   */
  app.get('/status', async (c) => {
    const db = deps.db(c as unknown as { env: unknown });
    return c.json(await runnerStatus(db, clock()));
  });

  return app;
}

function statusFor(reason: string): 401 | 403 {
  return (AUTH_STATUS[reason] ?? 401) === 403 ? 403 : 401;
}

async function authenticate(
  db: Db,
  headers: Headers,
  method: string,
  path: string,
  rawBody: string,
) {
  return authenticateRunner(db, readRunnerHeaders(headers, method, path, rawBody), Date.now());
}
