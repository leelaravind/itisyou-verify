/**
 * A Stripe key the intake never uses must not be able to take the intake down.
 *
 * ## Why this file exists
 *
 * `POST /api/v1/events` is the route this product is named for. Admission is a pure read of
 * our own tables and never calls Stripe -- the mount in `index.ts` says so -- so the
 * billing gateway is constructed there only to satisfy a type.
 *
 * `createStripeClient` validates the key's shape and throws on one that is neither test nor
 * live. The mount guarded on `secretKey.length > 0`, which asks whether a key exists and
 * not whether it is usable. So a deployment holding a malformed `STRIPE_SECRET_KEY`
 * answered **500** to every single event its customers sent.
 *
 * That was not hypothetical. On 19 September 2026 both staging and production were in
 * exactly that state, and `wrangler tail` gave the reason in one line:
 * `StripeError: Stripe secret key does not look like a test or live key`. Every existing
 * test passed throughout, because they construct the money runtime directly and never take
 * the mount's branch -- the same reason the previous version of this bug survived.
 *
 * ## Why it has its own file
 *
 * `index.ts` caches the money app per isolate on the first request to `/api/v1/events`,
 * capturing that request's env. A second case in the same module would silently reuse the
 * first one's gateway and prove nothing, so each case here resets the module registry and
 * imports a fresh worker.
 *
 * Case ids `MONEY-470..MONEY-472`.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/harness.js';

const BASE = 'https://verify.test';
const ROOT_KEY = randomBytes(32).toString('hex');
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

/** secret-scan:allow not a credential -- the shapes this test asserts are rejected */
const MALFORMED_KEYS = ['pk_test_51AbcdefghijklmnopQ', 'not-a-key', ' sk_test_leadingspace'];

function envFor(h: TestDb, secretKey: string | undefined): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
    EVENT_SIGNING_ROOT_KEY: ROOT_KEY,
    ...(secretKey === undefined ? {} : { STRIPE_SECRET_KEY: secretKey }),
  } as never;
}

/** A fresh worker module, so the per-isolate money-app cache starts empty. */
async function freshWorker(): Promise<{ fetch: typeof fetch }> {
  vi.resetModules();
  const mod = await import('../../../apps/app/src/index.js');
  return mod.default as unknown as { fetch: typeof fetch };
}

async function postUnsignedEvent(h: TestDb, secretKey: string | undefined): Promise<Response> {
  const worker = await freshWorker();
  return (worker.fetch as never as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
    new Request(`${BASE}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-1', workflow_id: 'wf-1' }),
    }),
    envFor(h, secretKey),
    ctx,
  );
}

describe('the intake and the Stripe key', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
    // Silence the one structured warning the mount emits; assert on it where it matters.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.close();
  });

  it('MONEY-470 a malformed STRIPE_SECRET_KEY does not turn event intake into a 500', async () => {
    for (const key of MALFORMED_KEYS) {
      const response = await postUnsignedEvent(h, key);
      // The point is the absence of 500. What the route answers to an unsigned body is the
      // signature layer's business, and it gets to answer it.
      expect(response.status, `key shape ${JSON.stringify(key)}`).not.toBe(500);
      expect(response.status).toBeLessThan(500);
    }
  });

  it('MONEY-471 the refusal is the signature layer talking, not a crash wearing its clothes', async () => {
    const response = await postUnsignedEvent(h, MALFORMED_KEYS[0]);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('SIGNATURE_INVALID');
  });

  it('MONEY-472 an unusable key is reported once, loudly, and never by printing the key', async () => {
    const lines: unknown[][] = [];
    (console.log as unknown as { mockRestore: () => void }).mockRestore();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });

    // secret-scan:allow synthetic malformed value, rejected before it reaches Stripe
    const key = 'pk_test_thisIsNotASecretKey';
    await postUnsignedEvent(h, key);

    const serialised = JSON.stringify(lines);
    expect(serialised).toContain('stripe_secret_key_unusable');
    // A warning that leaks the value it is warning about is worse than no warning.
    expect(serialised).not.toContain(key);
  });

  it('MONEY-473 a well-formed key still builds a real gateway and changes nothing about intake', async () => {
    // secret-scan:allow synthetic test-mode key; never sent anywhere, no account behind it
    const response = await postUnsignedEvent(h, `sk_test_${'0'.repeat(24)}`);
    expect(response.status).toBe(401);
  });
});
