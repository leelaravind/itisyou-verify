/**
 * A signed-in customer, served by the real Worker.
 *
 * The dominant defect on this project is *correct code, thoroughly tested, reached by
 * nothing*. Calling `UsagePage()` or `ConnectPage()` and asserting the string it returns
 * proves the template is right and proves nothing about the bytes `GET /app/usage` puts on
 * the wire — the arithmetic, the router, the layout and the session gate all sit between
 * the two. So everything here builds a real `Request`, hands it to the default export of
 * `apps/app/src/index.ts` (the object Cloudflare itself invokes), and reads the body.
 *
 * The database is the same `node:sqlite` harness the repository tests use, with the real
 * migrations applied, so the customer port runs its real SQL. Fixtures are written with raw
 * SQL rather than through the repositories: a fixture built out of the code under test
 * would hide a bug in that code.
 */
import { hashToken } from '@verify/security';
import worker from '../../../apps/app/src/index.js';
import { allowancePeriodKey } from '../../../apps/app/src/billing/period.js';
import {
  createTestDb,
  seedRun,
  seedWorkspace,
  type SeededWorkspace,
  type TestDb,
} from '../db/harness.js';

export const BASE = 'https://verify.itisyou.app';
export const NOW = '2026-09-19T10:00:00.000Z';
/** Comfortably in the future, so the seeded subscription period is the current one. */
export const PERIOD_END = '2026-10-19T10:00:00.000Z';

/** A bearer value with no meaning in it — the row id is its hash, exactly as in production. */
export const SESSION_VALUE = 'test-session-value-customer-integration';

export interface SignedIn {
  readonly h: TestDb;
  readonly ws: SeededWorkspace;
  readonly workspaceId: string;
  readonly userId: string;
  readonly workflowId: string;
}

export interface SignedInOptions {
  /** Runs consumed against the allowance. Omit for a workspace with no subscription at all. */
  readonly consumed?: number;
  readonly runLimit?: number;
  /** Seed a subscription and an allowance row keyed on the paid period end. */
  readonly subscribed?: boolean;
}

/** A workspace with a live session cookie, ready to be fetched as. */
export async function signedInWorkspace(options: SignedInOptions = {}): Promise<SignedIn> {
  const runLimit = options.runLimit ?? 500;
  const h = createTestDb();
  const ws = seedWorkspace(h, 'cust', { runLimit, createdAt: NOW });

  const sessionId = await hashToken(SESSION_VALUE, 'session');
  h.raw
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, ws.userId, NOW, '2099-01-01T00:00:00.000Z', NOW);

  if (options.subscribed !== false && options.consumed !== undefined) {
    h.raw
      .prepare(
        `INSERT INTO subscriptions
           (id, workspace_id, provider_subscription_id, environment, status, current_period_end, updated_at)
         VALUES (?, ?, ?, 'test', 'active', ?, ?)`,
      )
      .run('sub_cust', ws.workspaceId, 'sub_provider_cust', PERIOD_END, NOW);

    // Keyed by the paid period END, the one spelling `apps/app/src/billing/period.ts` owns.
    // `seedWorkspace` opens a calendar-month row, which the usage page correctly ignores.
    h.raw
      .prepare(
        `INSERT INTO entitlements
           (id, workspace_id, billing_period, plan_version, run_limit, consumed, reserved, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, 0, ?)`,
      )
      .run(
        'ent_cust_period',
        ws.workspaceId,
        allowancePeriodKey(PERIOD_END),
        runLimit,
        options.consumed,
        NOW,
      );
  }

  return {
    h,
    ws,
    workspaceId: ws.workspaceId,
    userId: ws.userId,
    workflowId: ws.workflowId,
  };
}

/** Put runs in the workspace. Re-exported so a test does not reach past this harness. */
export function seedRunsFor(
  session: SignedIn,
  runs: readonly { readonly id: string; readonly status: string }[],
): void {
  for (const run of runs) {
    seedRun(session.h, session.ws, run.id, { status: run.status });
  }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(h: TestDb): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

export interface Served {
  readonly status: number;
  readonly html: string;
}

/** `GET path` carrying the seeded session cookie, through the Worker entry point. */
export async function getSignedIn(session: SignedIn, path: string): Promise<Served> {
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: { cookie: `__Host-verify_session=${SESSION_VALUE}` },
    }),
    envFor(session.h),
    ctx,
  );
  return { status: response.status, html: await response.text() };
}

/** Visible text, entities resolved and whitespace collapsed — what a reader actually sees. */
export function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
