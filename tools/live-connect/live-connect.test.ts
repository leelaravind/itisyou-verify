/**
 * CONN-902 / CONN-903 — the paste flow against a real provider, through the real route.
 *
 * Everything else in this repository that touches HubSpot or Resend stubs `fetch`. This
 * one does not. It exists to answer the single question a stub cannot: does a credential
 * pasted into `/app/onboarding/connect` actually get validated by the provider and end up
 * as ciphertext in `credential_versions`?
 *
 * It drives the **real Worker entry point** — `apps/app/src/index.ts`'s `fetch` — over a
 * real SQLite database with the real migrations applied. Nothing about the route, the CSRF
 * middleware, the session resolution or the port is stubbed or bypassed. The only thing
 * that is not workerd is the D1 implementation, which is the same SQLite engine.
 *
 * The CSRF pair is obtained the way a browser obtains it: GET the page, keep the cookie the
 * server sets, read the hidden field out of the rendered HTML. The pair the seed script
 * prints cannot work here, and that is a real defect in the seed rather than in this file —
 * `session.csrfToken` is `generateCsrfToken()`, freshly random per render, and the server
 * overwrites the cookie with it on every response, so a token nobody rendered matches
 * nothing.
 *
 * SAFETY
 *  - Opt-in twice: `VERIFY_PROVIDER_PROOF=1` and `VERIFY_PROVIDER_ACCOUNT_KIND=test`.
 *  - The credential is read from `.dev.vars` and never printed, logged or asserted on by
 *    value. The assertions are about what must NOT appear.
 *  - Read-only: HubSpot's `access-token-info` and Resend's `GET /domains` are the only
 *    calls the connect flow can make. There is no write path in either connector.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashToken } from '@verify/security';
import type { Db, DbResult, DbStatement } from '@app/db/d1';
import worker from '@app/index';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const PROOF_ENABLED =
  process.env['VERIFY_PROVIDER_PROOF'] === '1' &&
  process.env['VERIFY_PROVIDER_ACCOUNT_KIND'] === 'test';

/** Read one key out of `.dev.vars` without ever putting the value anywhere else. */
function devVar(name: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    let value = trimmed.slice(name.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.length === 0 ? null : value;
  }
  return null;
}

/* ---------------------------------------------------------------- the database */

type Row = Record<string, unknown>;

function normalise(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

class Stmt implements DbStatement {
  #values: unknown[] = [];
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}
  bind(...values: unknown[]): DbStatement {
    const next = new Stmt(this.database, this.sql);
    next.#values = values.map((v) =>
      v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v,
    );
    return next;
  }
  execute<T>(): DbResult<T> {
    const prepared = this.database.prepare(this.sql);
    const rows = prepared.all(...(this.#values as never[])) as Row[];
    const counters = this.database
      .prepare('SELECT changes() AS c, last_insert_rowid() AS r')
      .get() as { c: number; r: number };
    return {
      success: true,
      results: rows.map(normalise) as T[],
      meta: {
        changes: Number(counters.c),
        last_row_id: Number(counters.r),
        rows_read: rows.length,
        rows_written: Number(counters.c),
      },
    };
  }
  async first<T = Row>(): Promise<T | null> {
    return this.execute<T>().results[0] ?? null;
  }
  async all<T = Row>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }
  async run<T = Row>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }
}

class Sqlite implements Db {
  constructor(private readonly database: DatabaseSync) {}
  prepare(query: string): DbStatement {
    return new Stmt(this.database, query);
  }
  async batch<T = Row>(statements: DbStatement[]): Promise<DbResult<T>[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map((s) => (s as Stmt).execute<T>());
      this.database.exec('COMMIT');
      return out;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function migratedDb(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const dir = join(ROOT, 'migrations');
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    database.exec(readFileSync(join(dir, name), 'utf8'));
  }
  return database;
}

/* ---------------------------------------------------------------- the fixture */

const AT = '2026-09-19T10:00:00.000Z';
const BASE = 'http://127.0.0.1:8787';

async function seed(
  database: DatabaseSync,
  suffix: string,
): Promise<{ cookie: string; workspaceId: string }> {
  const workspaceId = `ws_${suffix}`;
  const userId = `usr_${suffix}`;
  database
    .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
    .run(userId, `${suffix}@example.com`, AT);
  database
    .prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?, ?, 'active', ?)")
    .run(workspaceId, `Workspace ${suffix}`, AT);
  database
    .prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'workspace_admin', ?)",
    )
    .run(workspaceId, userId, AT);

  const cookieValue = `live-proof-session-${suffix}`;
  const sessionId = await hashToken(cookieValue, 'session');
  database
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(sessionId, userId, AT, new Date(Date.now() + 3_600_000).toISOString(), AT);

  return { cookie: `verify_session=${cookieValue}`, workspaceId };
}

/** A 32-byte AES key minted for this run only. Never persisted, never a deployed value. */
function wrappingKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

function env(db: Db): Record<string, unknown> {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
    CREDENTIAL_KEY_V1: wrappingKey(),
  };
}

/** Everything a browser carries between the GET and the POST. */
function readSetCookies(response: Response): Map<string, string> {
  const out = new Map<string, string>();
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

function hiddenField(html: string, name: string): string | null {
  const re = new RegExp(
    `<input[^>]*name="${name}"[^>]*value="([^"]*)"|<input[^>]*value="([^"]*)"[^>]*name="${name}"`,
  );
  const match = re.exec(html);
  if (match === null) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Narrow, or fail with a sentence naming what was missing.
 *
 * A non-null assertion would say the same thing to the compiler and nothing at all to
 * whoever reads the failure — and this file exists to be read once, by someone deciding
 * whether a real credential is now stored.
 */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

function text(row: Record<string, unknown>, column: string): string {
  return String(row[column] ?? '');
}

/* ---------------------------------------------------------------- the proof */

describe('the paste flow against a real provider', () => {
  it.runIf(PROOF_ENABLED && devVar('HUBSPOT_TEST_TOKEN') !== null)(
    'CONN-902 a real HubSpot token posted to /app/onboarding/connect is validated and stored as ciphertext',
    async () => {
      const token = required(devVar('HUBSPOT_TEST_TOKEN'), 'HUBSPOT_TEST_TOKEN in .dev.vars');

      const database = migratedDb();
      const db = new Sqlite(database);
      const bindings = env(db);
      const { cookie, workspaceId } = await seed(database, 'liveproof');

      // --- 1. GET the page, exactly as a browser does ------------------------
      const getResponse = await worker.fetch(
        new Request(`${BASE}/app/onboarding/connect`, { headers: { cookie } }),
        bindings as never,
        {} as never,
      );
      expect(getResponse.status).toBe(200);
      const pageHtml = await getResponse.text();

      const cookies = readSetCookies(getResponse);
      // http, so the unprefixed development name; https would be `__Host-verify_csrf`.
      const csrfCookie = required(
        cookies.get('verify_csrf') ?? cookies.get('__Host-verify_csrf'),
        'the CSRF cookie the server must set on the GET',
      );
      const csrfField = required(
        hiddenField(pageHtml, 'csrf_token'),
        'the hidden csrf_token field the form must render',
      );
      // The pair is only a pair because both halves came from the same response.
      expect(csrfField).toBe(csrfCookie);

      // The page must NOT be claiming it cannot check a credential any more.
      expect(pageHtml).not.toContain('We cannot check a credential yet');

      // --- 2. POST the real credential --------------------------------------
      const form = new URLSearchParams({
        csrf_token: csrfField,
        provider: 'hubspot',
        intent: 'credentials',
        access_token: token,
      });
      const postResponse = await worker.fetch(
        new Request(`${BASE}/app/onboarding/connect`, {
          method: 'POST',
          headers: {
            cookie: `${cookie}; verify_csrf=${csrfCookie}`,
            origin: BASE,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        }),
        bindings as never,
        {} as never,
      );
      const postHtml = await postResponse.text();

      // Print the outcome WITHOUT the credential: status, and the page's own sentence.
      const message = /<p[^>]*role="alert"[^>]*>([\s\S]*?)<\/p>/.exec(postHtml)?.[1] ?? '';
      // eslint-disable-next-line no-console -- this file exists to report one observation
      console.log('live_connect_post', {
        status: postResponse.status,
        message: message
          .replace(/<[^>]*>/g, '')
          .trim()
          .slice(0, 400),
      });

      expect(postResponse.status).toBe(200);
      // Nothing on the page is the credential.
      expect(postHtml).not.toContain(token);

      // --- 3. the database, queried directly --------------------------------
      const connection = required(
        database.prepare('SELECT * FROM connections WHERE workspace_id = ?').get(workspaceId) as
          Record<string, unknown> | undefined,
        'a connections row for this workspace',
      );
      expect(connection['provider']).toBe('hubspot');
      expect(['ready', 'testing']).toContain(connection['status']);
      expect(connection['last_check_at']).toBeTruthy();
      expect(connection['external_account_id']).toBeTruthy();

      const credential = required(
        database.prepare('SELECT * FROM credential_versions WHERE retired_at IS NULL').get() as
          Record<string, unknown> | undefined,
        'an active credential_versions row',
      );
      expect(text(credential, 'ciphertext')).not.toContain(token);
      expect(text(credential, 'aad')).toBe(
        `v1|kv=1|ws=${workspaceId}|provider=hubspot|purpose=api_token`,
      );
      expect(text(credential, 'owner_scope').startsWith('connection:')).toBe(true);

      // eslint-disable-next-line no-console -- the point of the run
      console.log('live_connect_rows', {
        connection: {
          id: connection['id'],
          provider: connection['provider'],
          status: connection['status'],
          external_account_id: connection['external_account_id'],
          scopes: connection['scopes'],
          last_check_at: connection['last_check_at'],
        },
        credential: {
          id: credential['id'],
          owner_scope: credential['owner_scope'],
          key_version: credential['key_version'],
          aad: credential['aad'],
          ciphertext_prefix: text(credential, 'ciphertext').slice(0, 24),
          ciphertext_length: text(credential, 'ciphertext').length,
          nonce_length: text(credential, 'nonce').length,
        },
        audit: database
          .prepare('SELECT action, actor_kind, target, redacted_metadata FROM audit_events')
          .all(),
      });

      database.close();
    },
  );

  it.runIf(PROOF_ENABLED && devVar('RESEND_API_KEY') !== null)(
    'CONN-903 a real Resend key posted to /app/onboarding/connect is refused or stored on the provider’s own answer',
    async () => {
      const token = required(devVar('RESEND_API_KEY'), 'RESEND_API_KEY in .dev.vars');
      const database = migratedDb();
      const db = new Sqlite(database);
      const bindings = env(db);
      const { cookie, workspaceId } = await seed(database, 'liveresend');

      const getResponse = await worker.fetch(
        new Request(`${BASE}/app/onboarding/connect`, { headers: { cookie } }),
        bindings as never,
        {} as never,
      );
      const pageHtml = await getResponse.text();
      const csrfCookie = required(
        readSetCookies(getResponse).get('verify_csrf'),
        'the CSRF cookie the server must set on the GET',
      );
      const csrfField = required(
        hiddenField(pageHtml, 'csrf_token'),
        'the hidden csrf_token field the form must render',
      );

      const postResponse = await worker.fetch(
        new Request(`${BASE}/app/onboarding/connect`, {
          method: 'POST',
          headers: {
            cookie: `${cookie}; verify_csrf=${csrfCookie}`,
            origin: BASE,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            csrf_token: csrfField,
            provider: 'resend',
            intent: 'credentials',
            access_token: token,
          }).toString(),
        }),
        bindings as never,
        {} as never,
      );
      const postHtml = await postResponse.text();
      const message = /<p[^>]*role="alert"[^>]*>([\s\S]*?)<\/p>/.exec(postHtml)?.[1] ?? '';

      // eslint-disable-next-line no-console -- the point of the run
      console.log('live_connect_resend', {
        status: postResponse.status,
        message: message
          .replace(/<[^>]*>/g, '')
          .trim()
          .slice(0, 400),
        connections: database
          .prepare('SELECT provider, status, external_account_id, last_check_at FROM connections')
          .all(),
        credentials: database
          .prepare(
            'SELECT owner_scope, key_version, aad, length(ciphertext) AS ct_len FROM credential_versions',
          )
          .all(),
      });

      // Whatever Resend said, the credential is never on the page.
      expect(postHtml).not.toContain(token);
      // And a sending-only key must leave nothing behind.
      if (postResponse.status !== 200) {
        expect(
          database.prepare('SELECT COUNT(*) AS n FROM credential_versions').get() as { n: number },
        ).toEqual({ n: 0 });
        expect(
          database.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number },
        ).toEqual({
          n: 0,
        });
      }
      expect(workspaceId).toBeTruthy();
      database.close();
    },
  );
});
