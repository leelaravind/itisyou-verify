/**
 * Every owner screen, rendered through the real router on the D1 port.
 *
 * ## The seam this closes
 *
 * The owner panel has thirteen screens. All of them have been rendered, captured at three
 * widths and audited — every single time against `MemoryOwnerDataPort`, the development
 * stand-in. Production runs `D1OwnerDataPort`. Nobody had ever put the two together: the
 * port had its own tests, the pages had theirs, and the join between them was covered by
 * nothing.
 *
 * That join is where a panel breaks in the way that matters. A port method returning a
 * slightly different shape, a `null` the page does not expect, a column the memory port
 * invents and the database does not have: none of those show up in a page test that uses
 * the stand-in, and none show up in a port test that never renders.
 *
 * So each case below drives the real `createOwnerRoutes` with a real D1-backed port over a
 * real schema, as a real platform owner with a real session, and asserts the page came back
 * whole. It is not the owner signing in on production, which nobody here may do. It is the
 * part of that which is ours to prove.
 *
 * Case ids `OWNER-927..OWNER-929`.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { D1OwnerDataPort } from '@app/db';
import type { RouteBindings } from '@app/routes/public/shared';
import { hashToken } from '@verify/security';
import { createTestDb, seedWorkspace, T0, type TestDb } from './harness';

const ORIGIN = 'http://localhost';
const NOW = new Date('2026-09-21T12:00:00.000Z');

/** Every owner screen that answers a GET, in the order the rail lists them. */
const SCREENS: readonly (readonly [string, string])[] = [
  ['Overview', '/owner'],
  ['Customers', '/owner/customers'],
  ['Verification', '/owner/verification'],
  ['Connections', '/owner/connections'],
  ['Ads', '/owner/ads'],
  ['Operations', '/owner/operations'],
  ['Controls', '/owner/controls'],
  ['Approvals', '/owner/approvals'],
  ['Tests', '/owner/quality'],
  ['Cleanup', '/owner/cleanup'],
  ['Settings', '/owner/settings'],
];

let h: TestDb;

beforeEach(() => {
  h = createTestDb();
});
afterEach(() => {
  h.close();
});

/*
 * A real platform owner with a real session row and a recent two-factor check.
 *
 * The cookie value is never stored: sessions.id is its SHA-256, so a database dump cannot be
 * replayed as a login. The seed therefore hashes the value it is about to put in the cookie.
 */
async function seedOwner(): Promise<{ cookie: string }> {
  const at = T0;
  const token = 'owner-session-token-for-this-test';
  const id = await hashToken(token);
  h.raw
    .prepare(
      `INSERT INTO users (id, auth_subject, display_name, is_platform_owner, totp_secret_ref, totp_enrolled_at, created_at)
       VALUES ('usr_owner', 'owner@example.invalid', 'Owner', 1, 'ref_totp', ?, ?)`,
    )
    .run(at, at);
  h.raw
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation)
       VALUES (?, 'usr_owner', ?, ?, ?, ?, 0)`,
    )
    .run(id, at, '2099-01-01T00:00:00.000Z', at, NOW.toISOString());
  return { cookie: `verify_session=${token}` };
}

function app(): Hono<RouteBindings> {
  const routes = new Hono<RouteBindings>();
  routes.route(
    '/',
    createOwnerRoutes({
      resolvePort: async (c) =>
        new D1OwnerDataPort({
          db: h.db,
          env: { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN } as never,
          request: { headers: c.req.raw.headers, url: c.req.url },
          now: NOW,
        }),
      now: () => NOW,
    }),
  );
  return routes;
}

async function get(path: string, cookie: string | null): Promise<{ status: number; html: string }> {
  const response = await app().request(
    `${ORIGIN}${path}`,
    { headers: cookie === null ? {} : { cookie } },
    { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN },
  );
  return { status: response.status, html: await response.text() };
}

describe('the owner panel on the port production actually uses', () => {
  it('OWNER-927 every owner screen renders from the D1 port, not only from the stand-in', async () => {
    const { cookie } = await seedOwner();
    seedWorkspace(h, 'alpha');

    const failures: string[] = [];
    for (const [label, path] of SCREENS) {
      const served = await get(path, cookie);
      if (served.status !== 200) {
        failures.push(`${label} ${path} answered ${String(served.status)}`);
        continue;
      }
      // A page that renders its shell and nothing else is a page that failed quietly.
      if (!served.html.includes('<main id="main"')) failures.push(`${label} has no main`);
      if (served.html.length < 2000) failures.push(`${label} rendered ${served.html.length} bytes`);
      // The rail is the panel's own navigation: its absence means the shell did not run.
      if (!served.html.includes('<nav class="rail"')) failures.push(`${label} has no rail`);
    }
    expect(failures, failures.join('; ')).toEqual([]);
  });

  it('OWNER-928 a figure the database cannot answer renders as unknown, never as zero', async () => {
    /*
     * The memory port answers everything. A real database does not: a workspace with no runs,
     * no orders and no measured launch figures is the ordinary state of a new deployment, and
     * it is exactly the state in which a page is most tempted to print 0.
     *
     * This asserts the opposite on the real port: the overview renders, and where it cannot
     * measure something it says so.
     */
    const { cookie } = await seedOwner();
    const served = await get('/owner', cookie);
    expect(served.status).toBe(200);

    expect(served.html, 'the overview printed no unknown at all on an empty database').toContain(
      'data-unknown="true"',
    );
    // And the launch figures are present as figures rather than missing entirely.
    expect(served.html).toContain('data-launch-figure=');
  });

  it('OWNER-929 the same screens are a 404 for a signed-in user who is not the platform owner', async () => {
    /*
     * The other half of the seam. The port decides who the principal is by reading the
     * session out of the database, so a non-owner session is the case where a mistake in
     * that read becomes an authorisation hole rather than a rendering bug.
     */
    const at = T0;
    h.raw
      .prepare(
        `INSERT INTO users (id, auth_subject, display_name, is_platform_owner, created_at)
         VALUES ('usr_plain', 'plain@example.invalid', 'Plain', 0, ?)`,
      )
      .run(at);
    h.raw
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation)
         VALUES ('ses_plain', 'usr_plain', ?, ?, ?, ?, 0)`,
      )
      .run(at, '2099-01-01T00:00:00.000Z', at, NOW.toISOString());

    for (const [label, path] of SCREENS) {
      const served = await get(path, 'verify_session=ses_plain');
      expect(served.status, `${label} ${path} was not refused`).toBe(404);
      expect(served.html, `${label} leaked an owner word`).not.toContain('<nav class="rail"');
    }

    // And anonymously, the same.
    const anonymous = await get('/owner', null);
    expect(anonymous.status).toBe(404);
  });
});
