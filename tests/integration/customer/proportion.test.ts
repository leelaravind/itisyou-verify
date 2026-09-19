/**
 * CUST-350..CUST-353 — a proportion is never allowed to round up.
 *
 * ## The scar this defends
 *
 * A 33% verification rate once drew as a full green bar: the width travelled in an inline
 * `style` attribute, the Worker's `style-src-attr 'none'` dropped it, and a dropped width
 * falls back to the element's natural full width. The fix was predefined fill classes that
 * round *down* (`meterFillClass`, `packages/ui/src/components/evidence.ts`).
 *
 * That fixed the transport and left the arithmetic alone. Every caller still computed its
 * percentage with `Math.round`, so 499 of 500 runs used — 99.8% — became the integer 100,
 * which selects `meter__fill--100` and fills the bar completely. The customer is told,
 * in a bar and in a spoken label, that an allowance they have not finished is finished.
 * Same defect, one layer up: a partial result that looks complete.
 *
 * ## Why these go through the Worker entry point
 *
 * Calling `UsagePage()` and asserting the string it returns proves the template is right
 * and proves nothing about the bytes `GET /app/usage` puts on the wire — the arithmetic
 * that rounds up lives in the route file, not the component. So every case here builds a
 * real `Request`, hands it to the default export of `apps/app/src/index.ts`, and reads the
 * response body.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import worker from '../../../apps/app/src/index.js';
import { allowancePeriodKey } from '../../../apps/app/src/billing/period.js';
import { createTestDb, seedWorkspace, type TestDb } from '../db/harness.js';

const BASE = 'https://verify.itisyou.app';
const NOW = '2026-09-19T10:00:00.000Z';
/** Comfortably in the future, so the seeded subscription period is the current one. */
const PERIOD_END = '2026-10-19T10:00:00.000Z';

/** A bearer value with no meaning in it — the row id is its hash, as in production. */
const SESSION_VALUE = 'test-session-value-CUST-350';

let open: TestDb | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

/**
 * A signed-in workspace whose allowance is `consumed` of `runLimit`.
 *
 * Seeded with raw SQL rather than through the repositories: a fixture built out of the
 * code under test would hide a bug in that code.
 */
async function signedInWorkspace(options: {
  readonly consumed: number;
  readonly runLimit: number;
}): Promise<TestDb> {
  const h = createTestDb();
  open = h;
  const ws = seedWorkspace(h, 'prop', { runLimit: options.runLimit, createdAt: NOW });

  const sessionId = await hashToken(SESSION_VALUE, 'session');
  h.raw
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, ws.userId, NOW, '2099-01-01T00:00:00.000Z', NOW);

  h.raw
    .prepare(
      `INSERT INTO subscriptions
         (id, workspace_id, provider_subscription_id, environment, status, current_period_end, updated_at)
       VALUES (?, ?, ?, 'test', 'active', ?, ?)`,
    )
    .run('sub_prop', ws.workspaceId, 'sub_provider_prop', PERIOD_END, NOW);

  // Keyed by the paid period END, which is the one spelling `apps/app/src/billing/period.ts`
  // owns. `seedWorkspace` opens a calendar-month row the usage page correctly ignores.
  h.raw
    .prepare(
      `INSERT INTO entitlements
         (id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, 0, ?)`,
    )
    .run(
      'ent_prop_period',
      ws.workspaceId,
      allowancePeriodKey(PERIOD_END),
      options.runLimit,
      options.consumed,
      NOW,
    );

  return h;
}

function envFor(h: TestDb): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

async function getSignedIn(h: TestDb, path: string): Promise<{ status: number; html: string }> {
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: { cookie: `__Host-verify_session=${SESSION_VALUE}` },
    }),
    envFor(h),
    ctx,
  );
  return { status: response.status, html: await response.text() };
}

/** The meter fill modifier actually served, e.g. `95` from `meter__fill--95`. */
function fillStep(html: string): string | null {
  const match = /meter__fill meter__fill--(\d+)/.exec(html);
  return match?.[1] ?? null;
}

describe('a proportion never rounds up', () => {
  it('CUST-350 GET /app/usage does not fill the meter at 499 of 500 runs used', async () => {
    const h = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    const { status, html } = await getSignedIn(h, '/app/usage');

    expect(status).toBe(200);
    // Proof the fixture reached the page at all, rather than a signed-out shell.
    expect(html).toContain('499');
    // 99.8% is not 100%. A full bar here says an allowance that is not finished is.
    expect(fillStep(html)).not.toBe('100');
    expect(fillStep(html)).toBe('95');
  });

  it('CUST-351 GET /app/usage does not announce 100 per cent at 499 of 500', async () => {
    const h = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    const { html } = await getSignedIn(h, '/app/usage');

    // The bar's accessible name is the only reading a screen-reader user gets. Rounding it
    // up tells them the allowance is spent while a run remains.
    expect(html).not.toContain('100 per cent');
    expect(html).toContain('99 per cent');
  });

  it('CUST-352 GET /app does not print 100% at 499 of 500', async () => {
    const h = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    const { status, html } = await getSignedIn(h, '/app');

    expect(status).toBe(200);
    expect(html).toContain('499 of 500');
    expect(html).not.toContain('499 of 500 (100%)');
    expect(html).toContain('499 of 500 (99%)');
  });

  it('CUST-353 a genuinely full allowance still fills the meter', async () => {
    const h = await signedInWorkspace({ consumed: 500, runLimit: 500 });
    const { html } = await getSignedIn(h, '/app/usage');

    // Rounding down must not become "never reaches the end": a true 100% is a true 100%.
    expect(fillStep(html)).toBe('100');
    expect(html).toContain('100 per cent');
  });
});
