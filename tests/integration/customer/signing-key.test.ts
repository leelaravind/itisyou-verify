/**
 * Issuing a workflow signing key — through the real Worker entry point.
 *
 * ## Why this file exists
 *
 * `workflows.signing_key_hash` and `signing_key_ref` have been in the schema since
 * migration 0001. `workflows.setSigningKey` has existed to write them.
 * `issueWorkflowSigningKey` exists and is unit-tested. **Nothing a browser could reach had
 * ever called any of it**, so no customer could hold a key and no customer could send a
 * signed event. The activation page rendered `signingKeyHint` over a column that was
 * always NULL. This is the project's dominant defect class — correct code, thoroughly
 * tested, reached by nothing — found here for the fifth time.
 *
 * So every case below builds a real `Request`, hands it to the default export of
 * `apps/app/src/index.ts` (the object Cloudflare itself invokes), and then reads the
 * **database** rather than trusting the response. Where a response is asserted, it is
 * because the response is the product (the one-time secret display) or because the status
 * is the safety property (503 on a missing root key, never 500 and never a silent success).
 *
 * ## The root key
 *
 * Generated per run from `randomBytes(32)`. It is never written to a file, never committed,
 * never logged and never sent anywhere. Production provisioning is the owner's.
 *
 * ## One caution about the entry point
 *
 * `index.ts` caches the money app per isolate, capturing `env.DB` and the root key on the
 * first request to `/api/v1/events`. In production that is one environment per isolate and
 * correct. In a test file it means only ONE case may drive `/api/v1/events`, or the second
 * would silently hit the first case's database. `CUST-404` is that case.
 *
 * Case ids `CUST-400..CUST-408`.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken, signRequest } from '@verify/security';
import worker from '../../../apps/app/src/index.js';
import type { TestDb } from '../db/harness.js';
import { BASE, SESSION_VALUE, signedInWorkspace, visibleText, type SignedIn } from './harness.js';

/** Local-only, for this process. Regenerated every run so nothing can depend on its value. */
const ROOT_KEY = randomBytes(32).toString('hex');

const ACTIVATION_PATH = '/app/onboarding/activation';
const ISSUE_PATH = '/app/onboarding/activation/signing-key';
const HASH_DOMAIN = 'workflow_signing';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(h: TestDb, rootKey: string | null): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
    ...(rootKey === null ? {} : { EVENT_SIGNING_ROOT_KEY: rootKey }),
  } as never;
}

interface Served {
  readonly status: number;
  readonly html: string;
  readonly text: string;
  readonly headers: Headers;
}

async function serve(response: Response): Promise<Served> {
  const html = await response.text();
  return { status: response.status, html, text: visibleText(html), headers: response.headers };
}

async function get(s: SignedIn, path: string, rootKey: string | null = ROOT_KEY): Promise<Served> {
  return serve(
    await worker.fetch(
      new Request(`${BASE}${path}`, {
        headers: { cookie: `__Host-verify_session=${SESSION_VALUE}` },
      }),
      envFor(s.h, rootKey),
      ctx,
    ),
  );
}

interface PostOptions {
  readonly rootKey?: string | null;
  /** `undefined` sends the site's own origin; `null` sends no Origin and no Referer. */
  readonly origin?: string | null;
  readonly signedIn?: boolean;
}

/** A browser-shaped form POST to the issue/rotate route. */
async function postIssue(s: SignedIn, options: PostOptions = {}): Promise<Served> {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  if (options.signedIn !== false) headers.set('cookie', `__Host-verify_session=${SESSION_VALUE}`);
  if (options.origin !== null) headers.set('origin', options.origin ?? BASE);
  return serve(
    await worker.fetch(
      new Request(`${BASE}${ISSUE_PATH}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ csrf_token: 'form-token', intent: 'issue' }).toString(),
      }),
      envFor(s.h, options.rootKey === undefined ? ROOT_KEY : options.rootKey),
      ctx,
    ),
  );
}

/** The one-time display carries two stable hooks; nothing else on the page may. */
function issuedKey(html: string): { keyId: string; secret: string } {
  const keyId = /data-signing-key-id[^>]*>\s*([A-Za-z0-9_]+)\s*</.exec(html)?.[1];
  const secret = /data-signing-secret[^>]*>\s*([0-9a-f]{64})\s*</.exec(html)?.[1];
  if (keyId === undefined || secret === undefined) {
    throw new Error(`the response did not show an issued key once: status text was\n${visibleText(html).slice(0, 400)}`);
  }
  return { keyId, secret };
}

function keyRow(s: SignedIn): { signing_key_ref: string | null; signing_key_hash: string | null } {
  return s.h.raw
    .prepare('SELECT signing_key_ref, signing_key_hash FROM workflows WHERE workspace_id = ? AND id = ?')
    .get(s.workspaceId, s.workflowId) as { signing_key_ref: string | null; signing_key_hash: string | null };
}

function auditRows(s: SignedIn): { action: string; target: string | null; redacted_metadata: string | null }[] {
  return s.h.raw
    .prepare(
      "SELECT action, target, redacted_metadata FROM audit_events WHERE workspace_id = ? AND action LIKE 'workflow.signing_key%' ORDER BY occurred_at, id",
    )
    .all(s.workspaceId) as { action: string; target: string | null; redacted_metadata: string | null }[];
}

/** Every value in every table, as one string. The secret must not be a substring of it. */
function everythingStored(h: TestDb): string {
  const tables = h.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const chunks: string[] = [];
  for (const table of tables) {
    const rows = h.raw.prepare(`SELECT * FROM "${table.name}"`).all();
    chunks.push(
      `${table.name}: ${JSON.stringify(rows, (_key, value: unknown) =>
        typeof value === 'bigint' ? Number(value) : value,
      )}`,
    );
  }
  return chunks.join('\n');
}

/** A signed source event for the seeded workflow, through the real intake. */
async function postEvent(
  s: SignedIn,
  key: { keyId: string; secret: string },
  eventId: string,
): Promise<Response> {
  const raw = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    workflow_id: s.workflowId,
    // The real mount uses the wall clock and must, so the signature and the event are
    // dated from it too — a frozen 10:00 would be hours outside the tolerance window.
    occurred_at: new Date().toISOString(),
    correlation_id: `enq_${eventId}`,
    expected: { email_recipient: 'ada@example.test' },
  });
  const signature = await signRequest({
    secret: key.secret,
    rawBody: raw,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return worker.fetch(
    new Request(`${BASE}/api/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-verify-key-id': key.keyId,
        'x-verify-signature': signature,
      },
      body: raw,
    }),
    envFor(s.h, ROOT_KEY),
    ctx,
  );
}

let open: SignedIn | null = null;

afterEach(() => {
  open?.h.close();
  open = null;
  vi.restoreAllMocks();
});

async function workspace(options: Parameters<typeof signedInWorkspace>[0] = {}): Promise<SignedIn> {
  open = await signedInWorkspace(options);
  return open;
}

describe('obtaining a workflow signing key from the activation page', () => {
  it('CUST-400 before issuance the page says no key exists and offers to issue one; the row is NULL', async () => {
    const s = await workspace();
    expect(keyRow(s)).toEqual({ signing_key_ref: null, signing_key_hash: null });

    const served = await get(s, ACTIVATION_PATH);
    expect(served.status).toBe(200);
    expect(served.text).toContain('not issued yet');
    // A real submit control, posting to the real route. Not a link, not a disabled button.
    expect(served.html).toContain(`action="${ISSUE_PATH}"`);
    expect(served.html).toMatch(/<button[^>]*>\s*Issue signing key/);
    expect(served.html).not.toContain('data-signing-secret');
  });

  it('CUST-401 issuing writes the ref and the hash of the shown secret, and audits the ref only', async () => {
    const s = await workspace();
    const served = await postIssue(s);
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('no-store');

    const shown = issuedKey(served.html);
    expect(shown.keyId).toMatch(/^evk_/);
    // The secret appears exactly once in the markup: the one display, nowhere else.
    expect(served.html.split(shown.secret).length - 1).toBe(1);
    expect(served.text).toMatch(/will not be shown again/i);

    // The database, not the response.
    const row = keyRow(s);
    expect(row.signing_key_ref).toBe(shown.keyId);
    expect(row.signing_key_hash).toBe(await hashToken(shown.secret, HASH_DOMAIN));

    const audit = auditRows(s);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('workflow.signing_key_issued');
    expect(audit[0]?.target).toBe(s.workflowId);
    expect(JSON.parse(audit[0]?.redacted_metadata ?? '{}')).toEqual({ key_ref: shown.keyId });
  });

  it('CUST-402 the secret is not retrievable: the next GET shows the key id and a rotate control, never the secret', async () => {
    const s = await workspace();
    const shown = issuedKey((await postIssue(s)).html);

    const served = await get(s, ACTIVATION_PATH);
    expect(served.status).toBe(200);
    expect(served.html).not.toContain(shown.secret);
    expect(served.html).not.toContain('data-signing-secret');
    expect(served.text).toContain(shown.keyId);
    expect(served.html).toMatch(/<button[^>]*>\s*Rotate signing key/);
    expect(served.html).not.toMatch(/<button[^>]*>\s*Issue signing key/);
    expect(served.text).not.toContain('not issued yet');
  });

  it('CUST-403 after issuance the secret appears in no log line, no audit row and no stored row', async () => {
    const s = await workspace();
    const captured: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args);
      });
    }

    const shown = issuedKey((await postIssue(s)).html);
    // A second request, so anything the port or the page logs on a plain read is caught too.
    await get(s, ACTIVATION_PATH);

    const logged = JSON.stringify(captured, (_key, value: unknown) =>
      value instanceof Error ? `${value.message}\n${value.stack ?? ''}` : value,
    );
    expect(logged).not.toContain(shown.secret);

    const stored = everythingStored(s.h);
    expect(stored).not.toContain(shown.secret);
    // What IS stored is the domain-separated hash and the public reference.
    expect(stored).toContain(await hashToken(shown.secret, HASH_DOMAIN));
    expect(stored).toContain(shown.keyId);
    // Belt and braces on the two stores the brief names explicitly.
    expect(JSON.stringify(auditRows(s))).not.toContain(shown.secret);
    expect(
      JSON.stringify(s.h.raw.prepare('SELECT * FROM notifications').all()),
    ).not.toContain(shown.secret);
  });

  it('CUST-404 rotation is a new ref: the old key stops being accepted, the new one is, and the row says so', async () => {
    const s = await workspace({ consumed: 0 });

    const first = issuedKey((await postIssue(s)).html);
    const accepted = await postEvent(s, first, 'evt-000000000001');
    expect(accepted.status).toBe(202);

    const rotation = await postIssue(s);
    expect(rotation.status).toBe(200);
    expect(rotation.text).toMatch(/rotated/i);
    const second = issuedKey(rotation.html);
    expect(second.keyId).not.toBe(first.keyId);
    expect(second.secret).not.toBe(first.secret);

    const withOldKey = await postEvent(s, first, 'evt-000000000002');
    expect(withOldKey.status).toBe(401);
    expect(((await withOldKey.json()) as { error: { code: string } }).error.code).toBe(
      'SIGNATURE_INVALID',
    );

    const withNewKey = await postEvent(s, second, 'evt-000000000003');
    expect(withNewKey.status).toBe(202);

    // The row holds exactly one reference and it is the new one.
    const row = keyRow(s);
    expect(row.signing_key_ref).toBe(second.keyId);
    expect(row.signing_key_hash).toBe(await hashToken(second.secret, HASH_DOMAIN));
    expect(row.signing_key_hash).not.toBe(await hashToken(first.secret, HASH_DOMAIN));

    // Exactly the two accepted events became rows; the refused one left nothing behind.
    const events = s.h.raw
      .prepare('SELECT external_event_id FROM source_events WHERE workspace_id = ? ORDER BY received_at, id')
      .all(s.workspaceId) as { external_event_id: string }[];
    expect(events.map((e) => e.external_event_id)).toEqual(['evt-000000000001', 'evt-000000000003']);

    const audit = auditRows(s).map((a) => a.action);
    expect(audit).toEqual(['workflow.signing_key_issued', 'workflow.signing_key_rotated']);
  });

  it('CUST-405 with no EVENT_SIGNING_ROOT_KEY issuance answers 503 with an explicit configuration error and writes nothing', async () => {
    const s = await workspace();
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    const served = await postIssue(s, { rootKey: null });
    expect(served.status).toBe(503);
    expect(served.text).toContain('EVENT_SIGNING_ROOT_KEY');
    expect(served.text).toMatch(/nothing was changed/i);
    expect(served.html).not.toContain('data-signing-secret');

    // Not a 500 in disguise: the central handler did not see an unhandled throw.
    expect(JSON.stringify(errors)).not.toContain('unhandled');

    // Not a key derived from an empty string: the row is untouched and nothing was audited.
    expect(keyRow(s)).toEqual({ signing_key_ref: null, signing_key_hash: null });
    expect(auditRows(s)).toEqual([]);

    // And the page says so before anyone presses anything.
    const page = await get(s, ACTIVATION_PATH, null);
    expect(page.status).toBe(200);
    expect(page.text).toContain('EVENT_SIGNING_ROOT_KEY');
    expect(page.html).not.toMatch(/<button[^>]*>\s*Issue signing key/);
  });

  it('CUST-406 a workspace viewer cannot issue or rotate', async () => {
    const s = await workspace();
    s.h.raw
      .prepare("UPDATE memberships SET role = 'workspace_viewer' WHERE workspace_id = ? AND user_id = ?")
      .run(s.workspaceId, s.userId);

    const served = await postIssue(s);
    expect(served.status).toBe(403);
    expect(served.html).not.toContain('data-signing-secret');
    expect(keyRow(s)).toEqual({ signing_key_ref: null, signing_key_hash: null });
    expect(auditRows(s)).toEqual([]);
  });

  it('CUST-407 a cross-site POST cannot rotate a customer key out from under them', async () => {
    const s = await workspace();
    const shown = issuedKey((await postIssue(s)).html);

    const foreign = await postIssue(s, { origin: 'https://attacker.example' });
    expect(foreign.status).toBe(403);
    const headless = await postIssue(s, { origin: null });
    expect(headless.status).toBe(403);

    // The key the customer holds is still the key on the row.
    const row = keyRow(s);
    expect(row.signing_key_ref).toBe(shown.keyId);
    expect(auditRows(s)).toHaveLength(1);
  });

  it('CUST-408 signed out, the route is the sign-in page and nothing is written', async () => {
    const s = await workspace();
    const served = await postIssue(s, { signedIn: false });
    expect(served.status).toBe(401);
    expect(served.html).not.toContain('data-signing-secret');
    expect(keyRow(s)).toEqual({ signing_key_ref: null, signing_key_hash: null });
  });
});
