/**
 * Not a test of behaviour — a dump of the exact bytes the Worker serves for the two owner
 * screens composed to the approved designs, and for the four public screens whose
 * composition figure depends on a fresh capture, so they can be rendered in a real browser
 * at real viewports and screenshotted for `docs/screenshots/stitch/`.
 *
 * The owner screens cannot be reached by the browser suite without a seeded owner session
 * with recent MFA, and the "every figure known" state cannot be reached at all on the
 * in-memory port, so both are rendered here through the real router. Skipped, visibly,
 * unless `SHOT_DIR` is set — a case with no assertion must never read as a pass.
 *
 *   SHOT_DIR=<dir> node scripts/run-tests.mjs tests/integration/owner/screens-dump.test.ts
 */
import { Hono } from 'hono';
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { publicRoutes } from '@app/routes/public/index';
import { MemoryOwnerDataPort, syntheticOwnerPrincipal } from '@app/owner/memory';
import type { ActionContext, OrderRow, OverviewView } from '@app/owner/port';
import type { RouteBindings } from '@app/routes/public/shared';

const OUT = process.env['SHOT_DIR'] ?? '';
const NOW = new Date('2026-09-20T12:00:00.000Z');
const OBSERVED = '2026-09-20T11:50:00.000Z';
const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-owner-screen-dump';
const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

/** Every launch read answered, so the composed strip can be seen with figures on it. */
class KnownFiguresPort extends MemoryOwnerDataPort {
  override async overview(now: Date): Promise<OverviewView> {
    const base = await super.overview(now);
    return {
      ...base,
      finance: { ...base.finance, cashRevenueMinor: 0 },
      customersActive: 2,
      customersTotal: 7,
      runsLast24h: 11,
      launch: {
        totalVisits: { value: 13, observedAt: OBSERVED },
        adAttributedVisits: { value: 5, observedAt: OBSERVED },
        qualifiedSignups: { value: 3, observedAt: OBSERVED },
        payingCustomers: { value: 2, observedAt: OBSERVED },
      },
    };
  }

  override async orders(): Promise<readonly OrderRow[]> {
    return [
      {
        id: 'ord_1',
        workspaceId: 'ws_1',
        status: 'active',
        amountMinor: 2900,
        currency: 'GBP',
        rejectionReason: null,
        createdAt: OBSERVED,
      },
    ];
  }
}

describe('screen dump for the owner screenshot pass', () => {
  it.skipIf(OUT === '')('writes the owner overview, the test centre and the public screens as served', async () => {
    mkdirSync(OUT, { recursive: true });
    const write = (name: string, html: string): void =>
      writeFileSync(join(OUT, `${name}.html`), html, 'utf8');

    const principal = { ...syntheticOwnerPrincipal(NOW), csrfToken: CSRF };
    const serve = async (port: MemoryOwnerDataPort, path: string): Promise<string> => {
      const app = new Hono<RouteBindings>();
      app.route('/', createOwnerRoutes({ resolvePort: async () => port, now: () => NOW }));
      app.route('/', publicRoutes);
      const response = await app.request(
        `${ORIGIN}${path}`,
        { headers: { cookie: `verify_csrf=${CSRF}` } },
        ENV,
      );
      if (response.status !== 200) throw new Error(`${path} answered ${String(response.status)}`);
      return response.text();
    };

    // The in-memory port: every launch figure honestly unknown.
    const memory = new MemoryOwnerDataPort({ principal, now: () => NOW });
    write('owner', await serve(memory, '/owner'));
    // One suite dispatched with no executor, so the run table has a row that proved nothing.
    const ctx: ActionContext = {
      principal,
      capability: 'quality.dispatch',
      now: NOW,
      requestId: 'req_dump',
    };
    await memory.dispatchQuality(ctx, 'unit');
    write('owner-quality', await serve(memory, '/owner/quality'));

    // Every figure answered.
    write('owner-known', await serve(new KnownFiguresPort({ principal, now: () => NOW }), '/owner'));

    // Every owner screen that answers a GET, so the panel can be seen whole rather than
    // judged from two pages.
    for (const [name, path] of [
      ['owner-customers', '/owner/customers'],
      ['owner-verification', '/owner/verification'],
      ['owner-connections', '/owner/connections'],
      ['owner-ads', '/owner/ads'],
      ['owner-operations', '/owner/operations'],
      ['owner-controls', '/owner/controls'],
      ['owner-approvals', '/owner/approvals'],
      ['owner-settings', '/owner/settings'],
      ['owner-cleanup', '/owner/cleanup'],
      ['admin-login', '/admin/login'],
    ] as const) {
      write(name, await serve(memory, path));
    }

    for (const [name, path] of [
      ['home', '/'],
      ['pricing', '/pricing'],
      ['how-it-works', '/how-it-works'],
      ['demo', '/demo'],
    ] as const) {
      write(name, await serve(memory, path));
    }
  });
});
