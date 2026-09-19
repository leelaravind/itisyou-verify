/**
 * The Resend webhook route.
 *
 * Two properties are under test here, and most of the cases exist to defend one of them:
 *
 *  1. **A bad signature, an unknown endpoint and a revoked connection are one answer.**
 *     Same status, same body, same work done. The only difference is a log line the caller
 *     never sees. A06's SEC-431 was exactly this going wrong on the Stripe route.
 *  2. **Promotion to `ready` happens once, on the verified and fresh path only.** A replay
 *     cannot re-promote, and a revoked connection cannot be revived by a callback that was
 *     captured earlier.
 *
 * No provider is contacted: every request is constructed here and signed with a synthetic
 * secret through `@verify/security`'s own signer, which is the same code path the verifier
 * uses in production.
 */
import { describe, expect, it } from 'vitest';
import { signSvix } from '@verify/security';
import { createResendWebhookRoute, type ResendEndpoint } from '@app/routes/webhooks/resend';

/** Synthetic, assembled at runtime so no credential-shaped literal reaches git (SEC-633). */
const SECRET = 'whsec' + '_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const WRONG_SECRET = 'whsec' + '_' + 'B'.repeat(32);
const OPAQUE_ID = 'wep_7f3a9c21d40b48e6a1f5';
const WORKSPACE = 'ws_00000000000000000001';
const CONNECTION = 'con_00000000000000000001';
const ACCOUNT = 'resend-key-0123456789abcdef';
const MESSAGE_ID = '56761188-7520-42d8-8898-ff6fc54ce618';
const NOW = '2026-03-01T12:03:00.000Z';

function endpoint(overrides: Partial<ResendEndpoint> = {}): ResendEndpoint {
  return {
    connectionId: CONNECTION,
    workspaceId: WORKSPACE,
    signingSecret: SECRET,
    status: 'testing',
    externalAccountId: ACCOUNT,
    webhookVerifiedAt: null,
    ...overrides,
  };
}

function body(type = 'email.delivered', overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: '2026-03-01T12:02:00.126Z',
    data: {
      created_at: '2026-03-01T12:01:00.894Z',
      email_id: MESSAGE_ID,
      from: 'Acme <ack@example.test>',
      to: ['ada@example.test'],
      subject: 'Thanks for your enquiry',
      ...overrides,
    },
  });
}

interface Recorder {
  readonly begins: unknown[];
  readonly completes: unknown[];
  readonly abandons: string[];
  readonly evidence: unknown[];
  readonly promotions: unknown[];
  readonly logs: Record<string, string | number | boolean>[];
}

function harness(
  options: {
    endpoint?: ResendEndpoint | null;
    resolveThrows?: boolean;
    admission?: 'fresh' | 'in_flight' | 'already_processed';
    recordThrows?: boolean;
    abandonThrows?: boolean;
    maxBodyBytes?: number;
    promotionSucceeds?: boolean;
  } = {},
) {
  const rec: Recorder = {
    begins: [],
    completes: [],
    abandons: [],
    evidence: [],
    promotions: [],
    logs: [],
  };
  const app = createResendWebhookRoute({
    resolveEndpoint: async () => {
      if (options.resolveThrows === true) throw new Error('d1 unavailable');
      return options.endpoint === undefined ? endpoint() : options.endpoint;
    },
    data: {
      beginWebhookProcessing: async (params) => {
        rec.begins.push(params);
        return { outcome: options.admission ?? 'fresh', receiptId: params.receiptId };
      },
      completeWebhookProcessing: async (receiptId, status, workspaceId) => {
        rec.completes.push({ receiptId, status, workspaceId });
      },
      abandonWebhookProcessing: async (eventId) => {
        if (options.abandonThrows === true) throw new Error('delete failed');
        rec.abandons.push(eventId);
      },
      recordEmailEvidence: async (params) => {
        if (options.recordThrows === true) throw new Error('write failed');
        rec.evidence.push(params);
      },
      markConnectionWebhookVerified: async (params) => {
        rec.promotions.push(params);
        return options.promotionSucceeds ?? true;
      },
    },
    now: () => NOW,
    newId: (prefix: string) => `${prefix}_test`,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    log: (entry) => rec.logs.push(entry),
  });
  return { app, rec };
}

async function post(
  app: ReturnType<typeof harness>['app'],
  raw: string,
  headers: Record<string, string>,
  path = `/api/v1/webhooks/resend/${OPAQUE_ID}`,
): Promise<Response> {
  return app.fetch(new Request(`https://verify.example${path}`, { method: 'POST', body: raw, headers }));
}

async function signedHeaders(
  raw: string,
  secret = SECRET,
  atSeconds = Math.floor(Date.parse(NOW) / 1000),
  id = 'msg_0001',
): Promise<Record<string, string>> {
  return {
    'svix-id': id,
    'svix-timestamp': String(atSeconds),
    'svix-signature': await signSvix(raw, id, atSeconds, secret),
    'content-type': 'application/json',
  };
}

// ---------------------------------------------------------------------------

describe('Resend webhook — the accepted path', () => {
  it('CONN-218 accepts a correctly signed delivery event and records the evidence', async () => {
    const { app, rec } = harness();
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false, handled: true });
    expect(rec.evidence).toHaveLength(1);
    expect(rec.completes[0]).toMatchObject({ status: 'processed', workspaceId: WORKSPACE });
  });

  it('CONN-219 stamps the evidence with the connected account and the webhook origin', async () => {
    const { app, rec } = harness();
    const raw = body();
    await post(app, raw, await signedHeaders(raw));

    const stored = rec.evidence[0] as { evidence: { provider_account_id: string; origin: string; status: string } };
    expect(stored.evidence.provider_account_id).toBe(ACCOUNT);
    expect(stored.evidence.origin).toBe('provider_webhook');
    expect(stored.evidence.status).toBe('delivered');
  });

  it('CONN-220 promotes the connection to ready on the first verified callback', async () => {
    const { app, rec } = harness();
    const raw = body();
    await post(app, raw, await signedHeaders(raw));

    expect(rec.promotions).toHaveLength(1);
    expect(rec.promotions[0]).toMatchObject({
      workspaceId: WORKSPACE,
      connectionId: CONNECTION,
      verifiedAt: NOW,
    });
  });

  it('CONN-221 does not promote again once the connection is already proven', async () => {
    const { app, rec } = harness({ endpoint: endpoint({ webhookVerifiedAt: '2026-02-01T00:00:00.000Z' }) });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(200);
    expect(rec.evidence).toHaveLength(1);
    expect(rec.promotions).toHaveLength(0);
  });

  it('CONN-222 claims the delivery under the connection and workspace it belongs to', async () => {
    const { app, rec } = harness();
    const raw = body();
    await post(app, raw, await signedHeaders(raw));

    expect(rec.begins[0]).toMatchObject({
      provider: 'resend',
      eventId: 'msg_0001',
      workspaceId: WORKSPACE,
      connectionId: CONNECTION,
    });
  });
});

describe('Resend webhook — one answer for every rejection', () => {
  const rejected = { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } };

  it('CONN-223 rejects an opaque id we never issued, with 400 and never 200', async () => {
    const { app, rec } = harness({ endpoint: null });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(rejected);
    // Nothing was claimed, stored or promoted for an endpoint that does not exist.
    expect(rec.begins).toHaveLength(0);
    expect(rec.evidence).toHaveLength(0);
    expect(rec.promotions).toHaveLength(0);
  });

  it('CONN-224 rejects a payload signed with the wrong secret', async () => {
    const { app, rec } = harness();
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw, WRONG_SECRET));

    expect(response.status).toBe(400);
    expect(rec.begins).toHaveLength(0);
  });

  it('CONN-225 rejects a body modified after signing', async () => {
    const { app } = harness();
    const raw = body();
    const headers = await signedHeaders(raw);
    const tampered = raw.replace('email.delivered', 'email.deliveret');
    expect(tampered).not.toBe(raw);

    const response = await post(app, tampered, headers);
    expect(response.status).toBe(400);
  });

  it('CONN-226 rejects a stale timestamp', async () => {
    const { app } = harness();
    const raw = body();
    const stale = Math.floor(Date.parse(NOW) / 1000) - 3600;
    const response = await post(app, raw, await signedHeaders(raw, SECRET, stale));
    expect(response.status).toBe(400);
  });

  it('CONN-227 rejects a request with no Svix headers at all', async () => {
    const { app } = harness();
    const response = await post(app, body(), { 'content-type': 'application/json' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(rejected);
  });

  it('CONN-228 rejects a revoked connection, so a leaked URL cannot revive it', async () => {
    const { app, rec } = harness({
      endpoint: endpoint({ status: 'revoked', webhookVerifiedAt: '2026-02-01T00:00:00.000Z' }),
    });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(400);
    expect(rec.promotions).toHaveLength(0);
    expect(rec.evidence).toHaveLength(0);
    expect(rec.begins).toHaveLength(0);
  });

  it('CONN-229 rejects an endpoint holding no usable signing secret', async () => {
    const { app, rec } = harness({ endpoint: endpoint({ signingSecret: '' }) });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));
    expect(response.status).toBe(400);
    expect(rec.begins).toHaveLength(0);
  });

  it('CONN-230 answers identically for an unknown endpoint, a wrong secret and a revoked connection', async () => {
    const raw = body();
    const good = await signedHeaders(raw);
    const responses = await Promise.all([
      post(harness({ endpoint: null }).app, raw, good),
      post(harness().app, raw, await signedHeaders(raw, WRONG_SECRET)),
      post(harness({ endpoint: endpoint({ status: 'revoked' }) }).app, raw, good),
    ]);

    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(new Set(bodies).size, 'the three rejections must be indistinguishable').toBe(1);
  });

  it('CONN-231 distinguishes the three only in the log, which the caller never sees', async () => {
    const unknown = harness({ endpoint: null });
    const revokedRun = harness({ endpoint: endpoint({ status: 'revoked' }) });
    const raw = body();
    const headers = await signedHeaders(raw);

    await post(unknown.app, raw, headers);
    await post(revokedRun.app, raw, headers);

    expect(unknown.rec.logs[0]?.['reason']).toBe('unknown_endpoint');
    expect(revokedRun.rec.logs[0]?.['reason']).toBe('connection_revoked');
  });

  it('CONN-232 still verifies the signature when the endpoint is unknown, so the paths cost the same', async () => {
    let verifyCalls = 0;
    const app = createResendWebhookRoute({
      resolveEndpoint: async () => null,
      data: {
        beginWebhookProcessing: async (p) => ({ outcome: 'fresh', receiptId: p.receiptId }),
        completeWebhookProcessing: async () => undefined,
        abandonWebhookProcessing: async () => undefined,
        recordEmailEvidence: async () => undefined,
        markConnectionWebhookVerified: async () => true,
      },
      now: () => NOW,
      newId: (p) => `${p}_t`,
      verifyWebhook: async (input) => {
        verifyCalls += 1;
        // The stand-in key must be a syntactically valid Svix secret, or the unknown path
        // would be measurably cheaper than the known one.
        expect(input.secret.startsWith('whsec' + '_')).toBe(true);
        return { valid: false, reason: 'signature_mismatch' };
      },
    });
    const raw = body();
    const response = await app.fetch(
      new Request(`https://verify.example/api/v1/webhooks/resend/${OPAQUE_ID}`, {
        method: 'POST',
        body: raw,
        headers: await signedHeaders(raw),
      }),
    );
    expect(response.status).toBe(400);
    expect(verifyCalls).toBe(1);
  });

  it('CONN-233 rejects a verified delivery that carries no id to deduplicate on', async () => {
    const { app, rec } = harness();
    const raw = body();
    const app2 = createResendWebhookRoute({
      resolveEndpoint: async () => endpoint(),
      data: {
        beginWebhookProcessing: async (p) => {
          rec.begins.push(p);
          return { outcome: 'fresh', receiptId: p.receiptId };
        },
        completeWebhookProcessing: async () => undefined,
        abandonWebhookProcessing: async () => undefined,
        recordEmailEvidence: async () => undefined,
        markConnectionWebhookVerified: async () => true,
      },
      now: () => NOW,
      newId: (p) => `${p}_t`,
      verifyWebhook: async () => ({
        valid: true,
        evidence: [],
        gaps: [],
        event_id: null,
        event_type: 'email.delivered',
      }),
    });
    void app;
    const response = await app2.fetch(
      new Request(`https://verify.example/api/v1/webhooks/resend/${OPAQUE_ID}`, {
        method: 'POST',
        body: raw,
        headers: await signedHeaders(raw),
      }),
    );
    expect(response.status).toBe(400);
    expect(rec.begins).toHaveLength(0);
  });
});

describe('Resend webhook — replay and duplicates', () => {
  it('CONN-234 returns 200 for a redelivery and does nothing a second time', async () => {
    const { app, rec } = harness({ admission: 'already_processed' });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: true });
    expect(rec.evidence).toHaveLength(0);
    expect(rec.promotions).toHaveLength(0);
  });

  it('CONN-235 returns 200 for an in-flight duplicate without racing the first delivery', async () => {
    const { app, rec } = harness({ admission: 'in_flight' });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));
    expect(response.status).toBe(200);
    expect(rec.evidence).toHaveLength(0);
    expect(rec.completes).toHaveLength(0);
  });

  it('CONN-236 a replayed callback never re-promotes a connection', async () => {
    const { app, rec } = harness({ admission: 'already_processed', endpoint: endpoint() });
    const raw = body();
    await post(app, raw, await signedHeaders(raw));
    await post(app, raw, await signedHeaders(raw));
    expect(rec.promotions).toHaveLength(0);
  });
});

describe('Resend webhook — events we do not map', () => {
  it('CONN-237 records an unmapped event type as seen and refuses to promote on it', async () => {
    const { app, rec } = harness();
    const raw = body('email.teleported');
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false, handled: false });
    expect(rec.completes[0]).toMatchObject({ status: 'ignored' });
    expect(rec.evidence).toHaveLength(0);
    expect(rec.promotions).toHaveLength(0);
  });

  it('CONN-238 records a contact event as ignored rather than treating it as delivery evidence', async () => {
    const { app, rec } = harness();
    const raw = body('contact.created');
    const response = await post(app, raw, await signedHeaders(raw));
    expect(response.status).toBe(200);
    expect(rec.evidence).toHaveLength(0);
  });
});

describe('Resend webhook — size, failure and method', () => {
  it('CONN-239 refuses an oversized body from its declared length, before reading it', async () => {
    const { app, rec } = harness({ maxBodyBytes: 64 });
    const raw = body();
    const response = await post(app, raw, {
      ...(await signedHeaders(raw)),
      'content-length': '999999',
    });
    expect(response.status).toBe(413);
    expect(rec.begins).toHaveLength(0);
  });

  it('CONN-240 refuses an oversized body that arrives without a declared length', async () => {
    const { app } = harness({ maxBodyBytes: 32 });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));
    expect(response.status).toBe(413);
  });

  it('CONN-241 answers 503, not 400, when our own endpoint lookup fails', async () => {
    // A 400 would tell Resend to stop retrying a delivery we merely failed to look up.
    const { app } = harness({ resolveThrows: true });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));
    expect(response.status).toBe(503);
  });

  it('CONN-242 releases the claim and answers 500 when storing the evidence throws', async () => {
    const { app, rec } = harness({ recordThrows: true });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(500);
    expect(rec.abandons).toEqual(['msg_0001']);
    expect(rec.promotions).toHaveLength(0);
  });

  it('CONN-243 still answers 500 and logs the stranded claim when the release also fails', async () => {
    const { app, rec } = harness({ recordThrows: true, abandonThrows: true });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));

    expect(response.status).toBe(500);
    expect(rec.logs.some((l) => l['event'] === 'resend_webhook_claim_stranded')).toBe(true);
  });

  it('CONN-244 does not answer a GET on the webhook path', async () => {
    const { app } = harness();
    const response = await app.fetch(
      new Request(`https://verify.example/api/v1/webhooks/resend/${OPAQUE_ID}`, { method: 'GET' }),
    );
    expect(response.status).not.toBe(200);
  });
});

describe('Resend webhook — nothing secret escapes', () => {
  it('CONN-245 never puts the signing secret in a response body or a log line', async () => {
    const { app, rec } = harness();
    const raw = body();
    const ok = await post(app, raw, await signedHeaders(raw));
    const bad = await post(app, raw, await signedHeaders(raw, WRONG_SECRET));

    const text = `${await ok.text()} ${await bad.text()} ${JSON.stringify(rec.logs)}`;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(WRONG_SECRET);
    expect(text).not.toContain('whsec' + '_');
  });

  it('CONN-246 never logs a recipient address', async () => {
    const { app, rec } = harness();
    const raw = body();
    await post(app, raw, await signedHeaders(raw));
    expect(JSON.stringify(rec.logs)).not.toContain('ada@example.test');
  });

  it('CONN-247 never reveals the opaque id in a rejection body', async () => {
    const { app } = harness({ endpoint: null });
    const raw = body();
    const response = await post(app, raw, await signedHeaders(raw));
    expect(await response.text()).not.toContain(OPAQUE_ID);
  });
});
