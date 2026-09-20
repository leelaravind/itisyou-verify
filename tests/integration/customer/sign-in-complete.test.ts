/**
 * A sign-in link has somewhere to land.
 *
 * ## Why this file exists
 *
 * `redeemSignInToken` was written, tested and reachable from nothing. There was no
 * completion route on either side, so the link in an owner's email answered **404** and
 * the customer's sign-in never minted a token at all. The whole customer journey was a
 * dead end at step one.
 *
 * The sequence is worth recording because it is the more interesting failure. On
 * 19 September the auditor found `/admin/login` claiming "a link is on its way" when
 * nothing sent one, and I fixed that by wiring the transport -- so the product began
 * sending a real email containing a URL that 404s. Removing a false claim is not the same
 * as making the thing work, and I shipped the first while reporting the second.
 *
 * So these cases drive the actual HTTP routes rather than the redeem function, which is
 * the only way a missing route is visible at all.
 *
 * Case ids `AUTH-490..AUTH-494`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import { issueSignInToken } from '@app/lib/auth';
import { createTestDb, seedWorkspace, type SeededWorkspace, type TestDb } from '../db/harness';

const BASE = 'https://verify.test';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(h: TestDb): never {
  return {
    DB: h.db,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

function get(h: TestDb, path: string, cookie?: string): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
    envFor(h),
    ctx,
  ) as Promise<Response>;
}

let h: TestDb;
let ws: SeededWorkspace;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'alpha');
});
afterEach(() => {
  h.close();
});

describe('a sign-in link can actually be completed', () => {
  it('AUTH-490 the customer completion route exists and is not a 404', async () => {
    // The assertion that would have caught the whole defect: the URL we put in an email
    // resolves to something. It may refuse the token; it may not be absent.
    const response = await get(h, '/app/sign-in/complete?token=nonsense');
    expect(response.status, 'the link we email customers must resolve to a route').not.toBe(404);
  });

  it('AUTH-491 the owner completion route exists and is not a 404', async () => {
    const response = await get(h, '/admin/login/complete?token=nonsense');
    expect(response.status, 'the link we email owners must resolve to a route').not.toBe(404);
  });

  it('AUTH-492 a valid link signs the customer in and sets a session cookie', async () => {
    const issued = await issueSignInToken(h.db, {
      email: `owner-${ws.workspaceId}@example.test`,
      now: new Date(),
    });

    const response = await get(
      h,
      `/app/sign-in/complete?token=${encodeURIComponent(issued.token)}`,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/app');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/verify_session=/);
    // A session row exists, so the cookie refers to something rather than being decoration.
    expect(
      (h.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it('AUTH-493 a link works once: the second attempt is refused and sets no cookie', async () => {
    const issued = await issueSignInToken(h.db, {
      email: `reuse-${ws.workspaceId}@example.test`,
      now: new Date(),
    });
    const url = `/app/sign-in/complete?token=${encodeURIComponent(issued.token)}`;

    expect((await get(h, url)).status).toBe(303);

    const second = await get(h, url);
    expect(second.status).toBe(401);
    expect(second.headers.get('set-cookie') ?? '').not.toMatch(/verify_session=[^;]/);
  });

  it('AUTH-494 an unknown, an expired and an empty token all answer the same way', async () => {
    const expired = await issueSignInToken(h.db, {
      email: `expired-${ws.workspaceId}@example.test`,
      now: new Date(Date.now() - 60 * 60 * 1000),
      ttlSeconds: 1,
    });

    const bodies = await Promise.all(
      [
        '/app/sign-in/complete?token=never-issued',
        `/app/sign-in/complete?token=${encodeURIComponent(expired.token)}`,
        '/app/sign-in/complete?token=',
      ].map(async (path) => {
        const response = await get(h, path);
        expect(response.status).toBe(401);
        // Normalise the per-render CSRF token -- it is base64url, not hex, which is how
        // the first version of this case failed on a difference that was not a leak.
        return (await response.text()).replace(
          /name="csrf_token" value="[^"]+"/g,
          'name="csrf_token" value="T"',
        );
      }),
    );

    // Distinguishing "expired" from "never existed" tells an unauthenticated caller which
    // addresses have accounts, one probe at a time.
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });
});
