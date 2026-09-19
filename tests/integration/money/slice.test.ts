/**
 * The vertical slice, through the **real Worker entry point**.
 *
 * ## What is different about this file
 *
 * A16's `events-route.test.ts` proves the events route thoroughly — all five denial modes
 * and the tick settlement — and every one of its cases builds `createEventsRoute(...)`
 * directly. That is the right unit for those properties and it is not the deployed path.
 * The composition root is `apps/app/src/index.ts`: it binds the signing-key store, reads
 * `EVENT_SIGNING_ROOT_KEY` off `env`, caches the money app per isolate, and constructs the
 * billing gateway. The last of those is exactly where a real defect lived a few hours ago —
 * `createStripeClient` throws on an empty key, so every request to the intake was a 500 on
 * any deployment without Stripe, and the route's own tests could not see it "because they
 * construct the runtime directly and never take this branch".
 *
 * So every case here goes through `worker.fetch(...)` and `worker.scheduled(...)` — the two
 * functions Cloudflare calls — and asserts on rows.
 *
 * ## What this file is NOT
 *
 * **The workflow here is seeded with SQL. That is not step 1.** Step 1 is a real sign-in
 * configuring a workflow through the real UI and obtaining a `signing_key_ref` from it, and
 * it belongs to the authenticated-flows owner. What this file is, is the replayable request
 * record steps 2, 3 and 5 need — so that when a genuinely configured workflow exists, the
 * slice is a re-run and not a fresh investigation.
 *
 * ## The root key
 *
 * Generated per run from `randomBytes(32)`. It is never written to a file, never committed,
 * never logged and never sent anywhere. Production provisioning is the owner's.
 *
 * ## Replay record — what the auditor re-issues, verbatim
 *
 * Every case below is one `POST https://<deployment>/api/v1/events`. Nothing else is
 * needed: no cookie, no session, no CSRF. Two headers carry the whole credential.
 *
 *     POST /api/v1/events
 *     content-type:       application/json
 *     x-verify-key-id:    <workflows.signing_key_ref>        the public reference
 *     x-verify-signature: t=<unix seconds>,v1=<hex>
 *
 *     v1  = HMAC-SHA-256(secret, `${t}.${rawBody}`)                as lowercase hex
 *     secret = HMAC-SHA-256(EVENT_SIGNING_ROOT_KEY,
 *                           `verify.event_signing.v1:${workspaceId}:${workflowId}:${keyRef}`)
 *
 * `rawBody` is **the exact bytes sent**. Re-serialising the JSON changes the document and
 * the signature will not verify — that is the point of the scheme, not an inconvenience.
 *
 * The body, minimal and complete:
 *
 *     {"schema_version":1,"event_id":"<=128 chars, [A-Za-z0-9._:-]>",
 *      "workflow_id":"<must equal the key's workflow>","occurred_at":"<ISO-8601 UTC>",
 *      "correlation_id":"<the value expected in the CRM property>",
 *      "expected":{"email_recipient":"<address>"}}
 *
 * Two clocks, both real, and both enforced:
 *   - `t` must be within `SIGNATURE_TOLERANCE_SECONDS` (300) of the server's clock;
 *   - `occurred_at` within `EVENT_FRESHNESS_WINDOW_SECONDS` (900).
 * There is no injected clock at this entry point — see `realNow` below for why that
 * matters and how the first draft of this file got it wrong.
 *
 * Expected responses, one line each, and each one is asserted below:
 *
 *   | case       | condition                                  | status | code                   |
 *   | ---------- | ------------------------------------------ | ------ | ---------------------- |
 *   | SLICE-001  | correctly signed, allowance available      | 202    | — (`duplicate: false`) |
 *   | SLICE-010  | byte-identical replay                      | 200    | — (`duplicate: true`)  |
 *   | SLICE-010b | same `event_id`, different body            | 409    | IDEMPOTENCY_CONFLICT   |
 *   | SLICE-011  | signature made with the wrong secret       | 401    | SIGNATURE_INVALID      |
 *   | SLICE-012  | `workflow_id` not the credential's         | 403    | WORKFLOW_MISMATCH      |
 *   | SLICE-013  | workspace at its allowance                 | 429    | ALLOWANCE_EXHAUSTED    |
 *   | SLICE-014  | workspace with no subscription             | 402    | NO_SUBSCRIPTION        |
 *   | SLICE-015  | subscription `past_due`                    | 402    | PAYMENT_RECOVERY_PAUSED|
 *   | SLICE-020  | real key id, no `EVENT_SIGNING_ROOT_KEY`   | 503    | SIGNING_KEY_UNREADABLE |
 *   | SLICE-021  | unknown key id                             | 401    | SIGNATURE_INVALID      |
 *
 * 401 is deliberately the same body for every authentication failure; the distinguishing
 * reason is logged and never returned. 503 is the exception and must stay one: it says the
 * fault is ours.
 *
 * Case ids `SLICE-001..022`.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signRequest } from '@verify/security';
import { allowancePeriodKey } from '@app/billing/period';
import { issueWorkflowSigningKey } from '@app/money/signingKeys';
import { createTestDb, seedWorkspace, type SeededWorkspace, type TestDb } from '../db/harness';

/**
 * **The wall clock, deliberately.**
 *
 * Every other money test injects `now`. The real mount does not, and must not: production
 * has one clock and it is the system's. So this file signs with the real current time and
 * dates `occurred_at` from it, which is the only way a signature that passes here would
 * also pass on a deployment. The first draft of this file froze the clock at 10:00 and
 * every correctly signed request came back 401 — six hours outside
 * `SIGNATURE_TOLERANCE_SECONDS`. That is a property of testing the entry point rather than
 * the route, and it is worth keeping visible.
 */
function realNow(): Date {
  return new Date();
}

/**
 * The subscription's period end, a month out from whenever this runs.
 *
 * Chosen relative to the clock rather than as a literal so the allowance key can never be
 * the current calendar month — which is exactly the coincidence that let a re-derived key
 * pass for two green suites.
 */
const PERIOD_END = new Date(Date.now() + 16 * 24 * 3600 * 1000).toISOString();
const ALLOWANCE_KEY = allowancePeriodKey(PERIOD_END);
const ORIGIN = 'https://verify.example';

/**
 * Local-only, for this process. 32 random bytes as hex.
 *
 * Regenerated on every run precisely so that nothing can come to depend on its value, and
 * so there is no constant here for anyone to mistake for a provisioned secret.
 */
const ROOT_KEY = randomBytes(32).toString('hex');

let h: TestDb;
let ws: SeededWorkspace;

function testEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: ORIGIN,
    EVENT_SIGNING_ROOT_KEY: ROOT_KEY,
    STRIPE_MODE: 'test',
    ...overrides,
  };
}

interface Worker {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> | Response;
  scheduled(event: unknown, env: unknown, ctx?: unknown): Promise<void>;
}

/**
 * A fresh module instance of the Worker.
 *
 * `apps/app/src/index.ts` caches the money app in a module-level `let`, built from the
 * first request's `env`. That is correct for a Worker isolate, and it means a scenario that
 * changes `EVENT_SIGNING_ROOT_KEY` between requests would otherwise be answered by the
 * previous build. Resetting the module registry is what makes each scenario a cold start.
 */
async function freshWorker(): Promise<Worker> {
  vi.resetModules();
  const mod = (await import('@app/index')) as { default: Worker };
  return mod.default;
}

const CTX = {
  waitUntil: (p: Promise<unknown>): void => void p,
  passThroughOnException: (): undefined => undefined,
};

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'slice', { createdAt: realNow().toISOString(), billingPeriod: ALLOWANCE_KEY });
  h.raw
    .prepare(
      `INSERT INTO subscriptions
         (id, workspace_id, provider_subscription_id, environment, status, price_id,
          current_period_end, cancel_at_period_end, provider_event_created, updated_at)
       VALUES ('sub_slice', ?, 'sub_provider_slice', 'test', 'active', 'price_test123', ?, 0, 0, ?)`,
    )
    .run(ws.workspaceId, PERIOD_END, realNow().toISOString());
});

afterEach(() => {
  h.close();
});

/** Issue a signing key the way the activation page will. Returns the public id and secret. */
async function issueKey(): Promise<{ keyId: string; secret: string }> {
  const issued = await issueWorkflowSigningKey(
    { db: h.db, rootKey: ROOT_KEY, now: realNow().toISOString() },
    { workspaceId: ws.workspaceId, workflowId: ws.workflowId },
  );
  return { keyId: issued.keyId, secret: issued.secret };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    event_id: 'evt-slice-00000001',
    workflow_id: ws.workflowId,
    occurred_at: realNow().toISOString(),
    correlation_id: 'enq_0000000000000001',
    expected: { email_recipient: 'ada@example.test' },
    ...overrides,
  });
}

interface SendOptions {
  readonly keyId?: string | null;
  readonly secret?: string;
  readonly signature?: string | null;
  readonly timestamp?: number;
  readonly envOverrides?: Record<string, unknown>;
  /** Reuse an already-built worker, so a duplicate really is a second request to one isolate. */
  readonly worker?: Worker;
}

/** POST through the real Worker fetch handler. */
async function send(raw: string, options: SendOptions = {}): Promise<Response> {
  const worker = options.worker ?? (await freshWorker());
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.keyId !== null) headers['x-verify-key-id'] = options.keyId ?? '';
  if (options.signature === undefined) {
    headers['x-verify-signature'] = await signRequest({
      secret: options.secret ?? '',
      rawBody: raw,
      timestamp: options.timestamp ?? Math.floor(realNow().getTime() / 1000),
    });
  } else if (options.signature !== null) {
    headers['x-verify-signature'] = options.signature;
  }

  return worker.fetch(
    new Request(`${ORIGIN}/api/v1/events`, { method: 'POST', headers, body: raw }),
    testEnv(options.envOverrides),
    CTX,
  );
}

function rows<T>(sql: string, ...bind: readonly unknown[]): T[] {
  return h.raw.prepare(sql).all(...(bind as never[])) as T[];
}

function counts(): Record<string, number> {
  const n = (table: string): number =>
    (h.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    source_events: n('source_events'),
    runs: n('runs'),
    outbox: n('outbox'),
    entitlements: n('entitlements'),
    notification_deliveries: n('notification_deliveries'),
  };
}

function allowance(): { billing_period: string; reserved: number; consumed: number } | undefined {
  return h.raw
    .prepare('SELECT billing_period, reserved, consumed FROM entitlements WHERE workspace_id = ?')
    .get(ws.workspaceId) as { billing_period: string; reserved: number; consumed: number };
}

/* -------------------------------------------------------------------------- */
/* Step 2 and 3 — admission, and the four rows                                 */
/* -------------------------------------------------------------------------- */

describe('the slice: a signed event through the deployed entry point', () => {
  it('SLICE-001 a correctly signed event is admitted through worker.fetch, and writes all four rows', async () => {
    const key = await issueKey();
    const response = await send(body(), { keyId: key.keyId, secret: key.secret });

    expect(response.status).toBe(202);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['duplicate']).toBe(false);
    expect(String(json['run_id'])).toMatch(/^run_/);

    // (a) one source_events row carrying the validated envelope
    const events = rows<{ external_event_id: string; payload_json: string; workspace_id: string }>(
      'SELECT external_event_id, payload_json, workspace_id FROM source_events',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.external_event_id).toBe('evt-slice-00000001');
    // The workspace is the credential's, never the payload's.
    expect(events[0]?.workspace_id).toBe(ws.workspaceId);
    expect(JSON.parse(events[0]?.payload_json ?? '{}')).toMatchObject({
      workflow_id: ws.workflowId,
      correlation_id: 'enq_0000000000000001',
    });

    // (b) exactly one run row, and it is the one the caller was told about
    const runRows = rows<{ id: string }>('SELECT id FROM runs');
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.id).toBe(json['run_id']);

    // (c) the allowance moved by exactly one unit, into `reserved`, under the paid-period
    // key — not the calendar month. A re-derived key fails here.
    expect(allowance()).toMatchObject({
      billing_period: ALLOWANCE_KEY,
      reserved: 1,
      consumed: 0,
    });

    // (d) one outbox row
    expect(rows('SELECT id FROM outbox')).toHaveLength(1);
  });

  it('SLICE-002 driving the real scheduled() handler settles the reservation into consumption', async () => {
    const key = await issueKey();
    await send(body(), { keyId: key.keyId, secret: key.secret });
    expect(allowance()).toMatchObject({ reserved: 1, consumed: 0 });

    const worker = await freshWorker();
    await worker.scheduled(
      { scheduledTime: realNow().getTime() + 60_000, cron: '* * * * *', noRetry: () => undefined },
      testEnv(),
      CTX,
    );

    // The reservation must settle into consumption under the SAME key it was taken under.
    const settled = allowance();
    expect(settled?.billing_period).toBe(ALLOWANCE_KEY);
    expect(settled?.reserved).toBe(0);
    expect(settled?.consumed).toBe(1);
    // And the total is still one unit — settling is a move, never a second grant.
    expect((settled?.reserved ?? 0) + (settled?.consumed ?? 0)).toBe(1);
  });

  it('SLICE-003 the tick reaches a terminal run without inventing a verdict', async () => {
    const key = await issueKey();
    await send(body(), { keyId: key.keyId, secret: key.secret });

    const worker = await freshWorker();
    await worker.scheduled(
      { scheduledTime: realNow().getTime() + 60_000, cron: '* * * * *', noRetry: () => undefined },
      testEnv(),
      CTX,
    );

    const run = rows<{ status: string; next_check_at: string | null }>(
      'SELECT status, next_check_at FROM runs',
    )[0];
    // With no provider credential configured the only honest terminal state is UNVERIFIED.
    // A VERIFIED here would mean the engine had decided something it could not observe.
    expect(run?.status).toBe('UNVERIFIED');
    expect(run?.next_check_at).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Step 5 — the five denial modes, each with a no-side-effect assertion         */
/* -------------------------------------------------------------------------- */

describe('the slice: each denial mode, and what it must not leave behind', () => {
  it('SLICE-010 duplicate event — 200 with the same run, one unit, no second row', async () => {
    const key = await issueKey();
    const worker = await freshWorker();
    // The **same bytes**, twice. `body()` stamps `occurred_at` from the clock, so calling it
    // twice would produce a different document under the same `event_id` — which is a
    // different question, asked below.
    const raw = body();
    const first = await send(raw, { keyId: key.keyId, secret: key.secret, worker });
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as Record<string, unknown>;
    const before = counts();

    const second = await send(raw, { keyId: key.keyId, secret: key.secret, worker });

    // The denial: a duplicate is 200 and says so, and hands back the existing run.
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as Record<string, unknown>;
    expect(secondJson['duplicate']).toBe(true);
    expect(secondJson['run_id']).toBe(firstJson['run_id']);

    // The absence: nothing new, and above all no second unit of allowance.
    expect(counts()).toEqual(before);
    expect(allowance()).toMatchObject({ reserved: 1, consumed: 0 });
  });

  it('SLICE-010b the same event id carrying a different body is a conflict, not an overwrite', async () => {
    const key = await issueKey();
    const worker = await freshWorker();
    const first = await send(body(), { keyId: key.keyId, secret: key.secret, worker });
    expect(first.status).toBe(202);
    const stored = rows<{ payload_json: string }>('SELECT payload_json FROM source_events')[0];
    const before = counts();

    // Same `event_id`, different `correlation_id`. Accepting this would silently rewrite
    // what the customer asked us to check while keeping the run they were told about.
    const second = await send(body({ correlation_id: 'enq_0000000000000002' }), {
      keyId: key.keyId,
      secret: key.secret,
      worker,
    });

    expect(second.status).toBe(409);
    expect(counts()).toEqual(before);
    // The first document is intact — not merged, not replaced.
    expect(rows<{ payload_json: string }>('SELECT payload_json FROM source_events')[0]).toEqual(
      stored,
    );
    expect(allowance()).toMatchObject({ reserved: 1, consumed: 0 });
  });

  it('SLICE-011 wrong signature — 401, and nothing at all is written', async () => {
    const key = await issueKey();
    const before = counts();

    const response = await send(body(), {
      keyId: key.keyId,
      secret: `${'f'.repeat(63)}0`,
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'SIGNATURE_INVALID' },
    });
    expect(counts()).toEqual(before);
    expect(allowance()).toMatchObject({ reserved: 0, consumed: 0 });
  });

  it('SLICE-012 wrong workspace — the payload cannot claim one, and a foreign workflow is 403', async () => {
    const key = await issueKey();
    const other = seedWorkspace(h, 'slice_other', {
      createdAt: realNow().toISOString(),
      billingPeriod: ALLOWANCE_KEY,
    });
    const before = counts();

    // The key proves workspace A; the payload names workspace B's workflow.
    const response = await send(body({ workflow_id: other.workflowId }), {
      keyId: key.keyId,
      secret: key.secret,
    });

    expect(response.status).toBe(403);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'WORKFLOW_MISMATCH' },
    });
    // Neither workspace gained anything: no run attributed to either, no unit taken.
    expect(counts()).toEqual(before);
    expect(
      h.raw
        .prepare('SELECT reserved, consumed FROM entitlements WHERE workspace_id = ?')
        .get(other.workspaceId),
    ).toMatchObject({ reserved: 0, consumed: 0 });
    expect(allowance()).toMatchObject({ reserved: 0, consumed: 0 });
  });

  it('SLICE-013 insufficient allowance — 429 about the period, and no unit is taken', async () => {
    const key = await issueKey();
    // The workspace is at its limit. Not a fabricated state: the same columns admission reads.
    h.raw
      .prepare(
        'UPDATE entitlements SET run_limit = 1, consumed = 1, reserved = 0 WHERE workspace_id = ?',
      )
      .run(ws.workspaceId);
    const before = counts();

    const response = await send(body(), { keyId: key.keyId, secret: key.secret });

    expect(response.status).toBe(429);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'ALLOWANCE_EXHAUSTED' },
    });
    // The refusal took nothing: still 1 of 1, not 2 of 1, and no run was opened.
    expect(counts()).toEqual(before);
    expect(allowance()).toMatchObject({ reserved: 0, consumed: 1 });
  });

  it('SLICE-014 provider/config failure — no subscription is 402 about the account, and writes nothing', async () => {
    const key = await issueKey();
    h.raw.prepare('DELETE FROM subscriptions WHERE workspace_id = ?').run(ws.workspaceId);
    const before = counts();

    const response = await send(body(), { keyId: key.keyId, secret: key.secret });

    // 402 is about the account and 429 is about the period; a customer needs to know which.
    expect(response.status).toBe(402);
    const json = (await response.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('NO_SUBSCRIPTION');
    expect(json.error.message.length).toBeGreaterThan(0);
    expect(counts()).toEqual(before);
    expect(allowance()).toMatchObject({ reserved: 0, consumed: 0 });
  });

  it('SLICE-015 a payment failure pauses new runs at the door without consuming anything', async () => {
    const key = await issueKey();
    h.raw
      .prepare("UPDATE subscriptions SET status = 'past_due' WHERE workspace_id = ?")
      .run(ws.workspaceId);
    const before = counts();

    const response = await send(body(), { keyId: key.keyId, secret: key.secret });

    // Asserted exactly, because the replay table above states it exactly and a table that
    // is looser than the test is a table nobody can re-issue against.
    expect(response.status).toBe(402);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'PAYMENT_RECOVERY_PAUSED' },
    });
    expect(counts()).toEqual(before);
    expect(allowance()).toMatchObject({ reserved: 0, consumed: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* The open question: 503 vs 401 when our own configuration is missing         */
/* -------------------------------------------------------------------------- */

describe('the slice: a fault of ours must not be reported as a fault of theirs', () => {
  it('SLICE-020 a REAL key id with no root key is 503 SIGNING_KEY_UNREADABLE, not 401', async () => {
    // The key is issued against a root key that this deployment then does not have. That is
    // the exact production shape: `wrangler secret put` was never run, or was run in one
    // environment and not another. Every previous probe used an unknown key id, which
    // short-circuits to 401 before the root key is ever read — so this had never been tested.
    const key = await issueKey();
    const before = counts();

    const response = await send(body(), {
      keyId: key.keyId,
      secret: key.secret,
      envOverrides: { EVENT_SIGNING_ROOT_KEY: '' },
    });

    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'SIGNING_KEY_UNREADABLE' },
    });
    expect(counts()).toEqual(before);
  });

  it('SLICE-021 an unknown key id is still 401, and is not distinguishable from a bad signature', async () => {
    const before = counts();
    const response = await send(body(), { keyId: 'evk_nothing_here', secret: 'deadbeef' });
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: 'SIGNATURE_INVALID' },
    });
    expect(counts()).toEqual(before);
  });

  it('SLICE-022 with no Stripe key configured the intake still answers, and never 500s', async () => {
    // The defect this holds the line on: `createStripeClient` throws on an empty key, and
    // mounting it unconditionally turned every request to the intake into a 500 on any
    // deployment without Stripe. `testEnv()` carries no STRIPE_SECRET_KEY at all.
    const key = await issueKey();
    const response = await send(body(), { keyId: key.keyId, secret: key.secret });
    expect(response.status).toBe(202);
    expect(rows('SELECT id FROM runs')).toHaveLength(1);

    // And an unsigned request on the same unconfigured deployment is an honest 401 rather
    // than a 500 — the refusal is about the caller, and it is reached.
    const unsigned = await send(body({ event_id: 'evt-slice-00000002' }), {
      keyId: key.keyId,
      signature: null,
    });
    expect(unsigned.status).toBe(401);
  });
});
