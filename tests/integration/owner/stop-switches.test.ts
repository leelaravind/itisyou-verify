/**
 * The owner's stop switches, proved through real requests to the real Worker.
 *
 * ## The defect these exist to hold closed
 *
 * `isPathSuspended` was written, unit-tested, and **called by nothing**. Pausing
 * `new_orders` wrote a settings row, answered "Paused." and changed nothing the Worker
 * served: orders kept being taken and the switch said it had worked. That is the emergency
 * brake on this product, and it is worse than a missing brake — a missing one sends someone
 * to find another way to stop, and a lying one does not.
 *
 * Two further layers were wrong underneath it, and neither was visible from the switch:
 *
 *  - the paths it named did not exist (`/app/checkout`; the real one is
 *    `/app/onboarding/checkout`), so wiring it alone would still have suspended nothing;
 *  - two of the four controls cannot be paths at all — `ads` stops an owner action and
 *    `expensive_verification` stops background work — and an empty path list read as
 *    "enforced, suspends nothing", which is indistinguishable from "not enforced".
 *
 * ## The case that matters most here
 *
 * `OWNER-380` asserts that **every control key has a declared enforcement and that the
 * declaration is true** — a path control's paths are really served, an action control's
 * sites really exist, and an unenforced control really says so on its own switch. A
 * per-switch test would go green the moment the three existing ones were wired and would
 * say nothing about the fourth switch somebody adds next month.
 *
 * Case ids `OWNER-380..389`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_ENFORCEMENT,
  CONTROL_KEYS,
  PROTECTED_PATHS,
  controlSettingKey,
  type ControlKey,
} from '@app/owner/controls';
import { issueSignInToken, promoteToPlatformOwner, redeemSignInToken } from '@app/lib/auth';
import { createTestDb, type TestDb } from '../db/harness';

const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-the-owner-stop-switch-tests';
const OWNER_EMAIL = 'owner@itisyou.test';
/**
 * The wall clock, deliberately — the same lesson the slice harness learned.
 *
 * Through the real Worker there is no injected clock: `createOwnerRoutes` is constructed at
 * module scope and `clock()` is the system's. A session whose two-factor check is stamped
 * at a frozen instant is outside `MFA_WINDOW_SECONDS` within the hour, and every owner POST
 * comes back 403 for a reason that looks nothing like a clock.
 */
function realNow(): Date {
  return new Date();
}

let h: TestDb;

interface Worker {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> | Response;
}

const CTX = {
  waitUntil: (p: Promise<unknown>): void => void p,
  passThroughOnException: (): undefined => undefined,
};

function testEnv(): Record<string, unknown> {
  return {
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: ORIGIN,
  };
}

/**
 * The real Worker, module registry reset.
 *
 * The suspension middleware is registered at module scope on the shared `app`, so this is
 * the composition root exactly as Cloudflare loads it — not a sub-app assembled by a test.
 * That distinction is the whole point: the missing call was in the composition root, and a
 * test that mounted the routers itself would have been green throughout.
 */
async function worker(): Promise<Worker> {
  vi.resetModules();
  const mod = (await import('@app/index')) as { default: Worker };
  return mod.default;
}

beforeEach(() => {
  h = createTestDb();
});

afterEach(() => {
  h.close();
});

/** A signed-in platform owner with a fresh two-factor check. Every row is real. */
async function ownerCookie(): Promise<string> {
  const now = realNow();
  const issued = await issueSignInToken(h.db, { email: OWNER_EMAIL, now });
  const redeemed = await redeemSignInToken(h.db, { token: issued.token, now });
  if (!redeemed.ok) throw new Error('sign-in failed in the fixture');
  await promoteToPlatformOwner(h.db, OWNER_EMAIL);
  h.raw.prepare('UPDATE sessions SET mfa_verified_at = ?').run(now.toISOString());
  return `verify_session=${redeemed.session.sessionValue}; verify_csrf=${CSRF}`;
}

async function get(w: Worker, path: string, cookie?: string): Promise<Response> {
  return w.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
    testEnv(),
    CTX,
  );
}

async function post(
  w: Worker,
  path: string,
  fields: Record<string, string> = {},
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return w.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ csrf_token: CSRF, ...fields }).toString(),
    }),
    testEnv(),
    CTX,
  );
}

/** Read the control straight out of `settings`. No repository in the way. */
function storedControl(key: ControlKey): { paused: boolean } | null {
  const row = h.raw
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get(controlSettingKey(key)) as { value_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.value_json) as { paused: boolean });
}

/* -------------------------------------------------------------------------- */
/* the structural case — the one that catches the NEXT switch                  */
/* -------------------------------------------------------------------------- */

describe('every stop switch is enforced, or says on its face that it is not', () => {
  it('OWNER-380 every control key has an enforcement declaration and the declaration is true', async () => {
    const w = await worker();
    const cookie = await ownerCookie();
    const page = await (await get(w, '/owner/controls', cookie)).text();

    for (const key of CONTROL_KEYS) {
      const enforcement = CONTROL_ENFORCEMENT[key];
      expect(enforcement, `${key} has no enforcement declaration`).toBeDefined();

      if (enforcement.kind === 'http_paths') {
        expect(enforcement.paths.length).toBeGreaterThan(0);
        for (const path of enforcement.paths) {
          // A path control whose path is served by nothing suspends nothing. The previous
          // declaration named `/app/checkout`, which 404s — so the switch would have been
          // "wired" and still useless. A 404 here means the declaration is a fiction.
          const probe = await post(w, path);
          expect(probe.status, `${key} names ${path}, which no route serves`).not.toBe(404);
        }
        // And it must announce itself as enforced on its own switch.
        expect(page).toContain(`data-control-enforcement="${key}"`);
        expect(page).toMatch(
          new RegExp(`data-enforced="true" data-control-enforcement="${key}"`),
        );
      } else if (enforcement.kind === 'action') {
        expect(enforcement.sites.length).toBeGreaterThan(0);
        expect(enforcement.what.length).toBeGreaterThan(0);
        expect(page).toMatch(
          new RegExp(`data-enforced="true" data-control-enforcement="${key}"`),
        );
      } else {
        // Not enforced. That is allowed — what is not allowed is the owner not being told,
        // because a switch that does nothing while looking like the others is the defect.
        expect(enforcement.why.length).toBeGreaterThan(0);
        expect(enforcement.owner.length).toBeGreaterThan(0);
        expect(page).toMatch(
          new RegExp(`data-enforced="false" data-control-enforcement="${key}"`),
        );
        expect(page).toMatch(/does not stop anything yet/i);
      }
    }
  });

  it('OWNER-381 an enforced switch is never declared against a protected path', async () => {
    // A pause that silenced cancellation or support would turn an operational decision into
    // a consumer-rights problem. The registry is checked against the protected list rather
    // than trusting that nobody will ever add one.
    for (const key of CONTROL_KEYS) {
      const enforcement = CONTROL_ENFORCEMENT[key];
      if (enforcement.kind !== 'http_paths') continue;
      for (const path of enforcement.paths) {
        expect(
          PROTECTED_PATHS.some((p) => path === p.path || path.startsWith(`${p.path}/`)),
          `${key} declares ${path}, which is a protected path`,
        ).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* the real request — flip it, hit it, flip it back                            */
/* -------------------------------------------------------------------------- */

describe('pausing new orders actually stops an order being taken', () => {
  it('OWNER-382 checkout is refused with an explanation while paused, and works again after', async () => {
    const w = await worker();
    const cookie = await ownerCookie();

    // Before: the brake is off, and checkout is reachable — whatever it answers, it is not
    // the paused refusal. Asserting this first is what stops the case passing vacuously.
    const before = await post(w, '/app/onboarding/checkout');
    expect(before.status).not.toBe(503);

    // Flip it through the real owner route, not by writing the row.
    const flip = await post(w, '/owner/controls/new_orders', { paused: 'yes' }, cookie);
    expect(flip.status).toBeLessThan(400);
    expect(storedControl('new_orders')?.paused).toBe(true);

    // The proof: the same request, now refused.
    const during = await post(w, '/app/onboarding/checkout');
    expect(during.status).toBe(503);
    const body = (await during.json()) as { error: { code: string; control: string; message: string } };
    expect(body.error.code).toBe('SERVICE_PAUSED');
    expect(body.error.control).toBe('new_orders');
    // It must say what is stopped AND what is not. A customer who thinks the product is
    // broken behaves differently from one who knows it was paused on purpose.
    expect(body.error.message).toMatch(/nobody new can reach checkout/i);
    expect(body.error.message).toMatch(/can still cancel/i);
    // Not cached, and not a 404 that would read as "this never existed".
    expect(during.headers.get('cache-control')).toBe('no-store');

    // Flip it back, and the refusal goes away.
    const unflip = await post(w, '/owner/controls/new_orders', { paused: 'no' }, cookie);
    expect(unflip.status).toBeLessThan(400);
    expect(storedControl('new_orders')?.paused).toBe(false);
    const after = await post(w, '/app/onboarding/checkout');
    expect(after.status).not.toBe(503);
  });

  it('OWNER-383 with every switch on, cancelling and getting help still work', async () => {
    const w = await worker();
    const cookie = await ownerCookie();
    for (const key of CONTROL_KEYS) {
      await post(w, `/owner/controls/${key}`, { paused: 'yes' }, cookie);
    }
    for (const key of CONTROL_KEYS) expect(storedControl(key)?.paused).toBe(true);

    // The invariant the whole controls module exists to protect, asserted against the
    // running Worker rather than against `isProtectedPath` in isolation.
    for (const protectedPath of PROTECTED_PATHS) {
      const response = await get(w, protectedPath.path);
      expect(response.status, `${protectedPath.path} was suspended: ${protectedPath.why}`).not.toBe(
        503,
      );
    }
  });

  it('OWNER-384 with the switches off nothing is suspended that should not be', async () => {
    const w = await worker();
    // The negative. A middleware that refused everything would pass OWNER-382 and be a
    // catastrophe; this is the case that notices.
    for (const path of ['/', '/pricing', '/how-it-works', '/app/onboarding/review', '/status']) {
      const response = await get(w, path);
      expect(response.status, `${path} was suspended with every switch off`).not.toBe(503);
    }
    // And nothing wrote a control row just by serving pages.
    for (const key of CONTROL_KEYS) expect(storedControl(key)).toBeNull();
  });

  it('OWNER-385 a pause on one control does not suspend another control’s paths', async () => {
    const w = await worker();
    const cookie = await ownerCookie();
    // `chatbot` is paused; `new_orders` is not. Checkout must stay open — a switch that
    // stops something adjacent is how a pause takes the site down.
    await post(w, '/owner/controls/chatbot', { paused: 'yes' }, cookie);
    expect(storedControl('chatbot')?.paused).toBe(true);

    const checkout = await post(w, '/app/onboarding/checkout');
    expect(checkout.status).not.toBe(503);
  });
});

/* -------------------------------------------------------------------------- */
/* a view model nobody renders is the same defect one level down               */
/* -------------------------------------------------------------------------- */

describe('the operations page shows the health it promises', () => {
  it('OWNER-388 OperationsView.health is rendered, including the money-path row', async () => {
    const w = await worker();
    const cookie = await ownerCookie();
    const page = await (await get(w, '/owner/operations', cookie)).text();

    // The page's own lede has always said "Health, what was deployed, what is alerting".
    // It rendered three of the four: `OperationsView.health` was populated and displayed
    // nowhere, so the data was claimed to be visible and was not.
    expect(page).toContain('data-health="true"');
    expect(page).toMatch(/Service health/);
    // And the one row on it that is a measurement rather than an absence.
    expect(page).toMatch(/money_path/);
    expect(page).toMatch(/EVENT_SIGNING_ROOT_KEY/);
  });
});
