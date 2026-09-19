/**
 * API-43x — can a signed-out person actually reach us, through an HTTP request?
 *
 * `docs/privacy-retention.md` §0 recorded two rows against this path, and both are the
 * same defect class as the unreached notification templates: code that is written, tested,
 * and that nothing calls.
 *
 *   - *"A signed-out visitor being able to reach support (§5) — the only support form is
 *     behind sign-in, at `/app/support`. A signed-out person currently has no route to us
 *     at all."* `recordAnonymousSupportCase` existed for exactly this and had no caller.
 *   - *"Support bodies being stripped of credentials … **before** storage — the redaction
 *     is written and tested, and the mounted support route does not call it."* That one was
 *     marked release-blocking.
 *
 * `tests/integration/db/supportWrite.test.ts` proves the *write path* redacts and triages,
 * by calling the port. It is exactly that shape of proof — correct function, no caller —
 * that let the defect survive. So every case here starts at an HTTP request to a mounted
 * router and finishes by reading `support_cases` out of a real SQLite database with the
 * real migrations applied. Nothing here calls `createCase`, `redactSupportBody` or
 * `triageSupportCase`.
 *
 * **These cases fail before the fix by construction**: `support/publicRoute.ts` did not
 * exist, so there was no router to mount and no signed-out request that could reach a
 * person.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createPublicSupportRoute } from '@app/support/publicRoute';
import { createTestDb, type TestDb } from '../db/harness';

let dbs: TestDb[] = [];

afterEach(() => {
  for (const h of dbs) h.close();
  dbs = [];
});

/**
 * A credential-shaped value, assembled at runtime so the literal never appears in this
 * file. See `docs/agent-brief.md` and SEC-633: a fixture needs the right *kind* of value,
 * never the right *shape*.
 */
const PASTED_KEY = ['sk', 'test', '9'.repeat(28)].join('_');

interface Scene {
  readonly h: TestDb;
  post(fields: Record<string, string>): Promise<Response>;
  get(path: string): Promise<Response>;
  cases(): Record<string, unknown>[];
}

function scene(): Scene {
  const h = createTestDb();
  dbs.push(h);
  const app = new Hono();
  app.route(
    '/',
    createPublicSupportRoute({
      db: () => h.db,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    }),
  );
  const env = { ENVIRONMENT: 'test', PUBLIC_BASE_URL: 'https://verify.example' };
  return {
    h,
    post: (fields) =>
      app.request(
        '/support',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
        },
        env,
      ),
    get: (path) => app.request(path, {}, env),
    cases: () =>
      h.raw.prepare('SELECT * FROM support_cases ORDER BY created_at').all() as Record<
        string,
        unknown
      >[],
  };
}

describe('API-43x the signed-out support route', () => {
  it('API-431 a signed-out request reaches a person and the case carries no workspace', async () => {
    const s = scene();

    const response = await s.post({
      contactEmail: 'locked.out@example.test',
      subject: 'I cannot sign in',
      body: 'The sign-in link never arrives and I need to cancel my plan before I am charged again.',
    });

    expect(response.status).toBe(200);
    const rows = s.cases();
    expect(rows, 'no support case was written').toHaveLength(1);
    // NULL, which `supportCases.get` treats as a real scope rather than a wildcard.
    expect(rows[0]?.['workspace_id']).toBeNull();
    expect(rows[0]?.['contact_email']).toBe('locked.out@example.test');

    // The reference is shown back so the person can quote it.
    expect(await response.text()).toContain(String(rows[0]?.['id']));
  });

  it('API-432 the route redacts BEFORE storage — a pasted key never reaches body_redacted', async () => {
    const s = scene();

    await s.post({
      contactEmail: 'paster@example.test',
      subject: 'Connection keeps failing',
      body: `Here is the key I used, in case it helps: ${PASTED_KEY} — please take a look.`,
    });

    const row = s.cases()[0];
    expect(row, 'no support case was written').toBeDefined();
    const stored = String(row?.['body_redacted'] ?? '');
    expect(stored, 'the pasted credential reached the stored column').not.toContain(PASTED_KEY);
    // And not anywhere else on the row either — a column named `body_redacted` asserting
    // something the subject line then contradicts is the same lie in a different place.
    expect(JSON.stringify(row)).not.toContain(PASTED_KEY);
    // The message is still useful: redaction replaces, it does not delete the sentence.
    expect(stored).toContain('please take a look');
  });

  it('API-433 the route triages — a deletion request does not land as category "other"', async () => {
    const s = scene();

    await s.post({
      contactEmail: 'leaving@example.test',
      subject: 'Please delete my account and all my data',
      body: 'I would like my workspace and everything you hold about it deleted under UK GDPR.',
    });

    const row = s.cases()[0];
    expect(row?.['category'], 'a deletion request was filed as ordinary').not.toBe('other');
    expect(String(row?.['category'])).toMatch(/delet/i);
  });

  it('API-434 a security report escalates rather than joining the ordinary queue', async () => {
    const s = scene();

    await s.post({
      contactEmail: 'researcher@example.test',
      subject: 'Security vulnerability in your sign-in flow',
      body: 'I can see another account’s run history by changing a value in the URL. Please respond.',
    });

    const row = s.cases()[0];
    expect(row?.['state'], 'a security report sat in the ordinary queue').not.toBe('open');
    expect(['high', 'urgent']).toContain(String(row?.['priority']));
  });

  it('API-435 a message we could never reply to is refused, and nothing is stored', async () => {
    const s = scene();

    const response = await s.post({
      contactEmail: 'not-an-address',
      subject: 'Hello there',
      body: 'This is a long enough message to pass the length check on its own merits.',
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('reply to');
    expect(s.cases(), 'an unreplyable message was stored anyway').toHaveLength(0);
  });

  it('API-436 the form takes no workspace id, so a stranger cannot attach a case to one', async () => {
    const s = scene();

    await s.post({
      contactEmail: 'stranger@example.test',
      subject: 'Just asking a question',
      body: 'Nothing suspicious here, I am only asking how the evidence retention works.',
      // Fields an attacker would try. None is read.
      workspaceId: 'ws_someone_else',
      workspace_id: 'ws_someone_else',
      runId: 'run_someone_else',
    });

    const row = s.cases()[0];
    expect(row?.['workspace_id'], 'a form field set the workspace scope').toBeNull();
    expect(row?.['linked_run_id']).toBeNull();
  });

  it('API-437 the signed-out form is rendered, and says what happens to the message', async () => {
    const s = scene();
    const response = await s.get('/support/contact');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('name="contactEmail"');
    expect(body).toContain('method="post"');
    // The promise that makes the warning above it actionable rather than decorative.
    expect(body).toMatch(/removed before it is written down/i);
    expect(body).toMatch(/do not need an account/i);
  });
});
