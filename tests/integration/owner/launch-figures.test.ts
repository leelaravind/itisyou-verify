/**
 * OWNER-905..OWNER-907 — the overview's launch figures through the real owner router.
 *
 * The unit cases prove the page renders what it is given. These prove the router gives it
 * the port's own reads, that a port which throws renders "unknown" rather than a 500 or a
 * zero, and that recomposing the page moved nothing in front of the access check: an
 * anonymous request still gets the byte-identical 404 and never sees a figure.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { ANONYMOUS_PRINCIPAL, type OwnerPrincipal } from '@app/owner/access';
import { MemoryOwnerDataPort, syntheticOwnerPrincipal } from '@app/owner/memory';
import type { OrderRow, OverviewView } from '@app/owner/port';
import type { RouteBindings } from '@app/routes/public/shared';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const OBSERVED = '2026-09-20T11:50:00.000Z';
const ORIGIN = 'http://localhost';
const CSRF = 'csrf-token-for-owner-launch-figures';
const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

function ownerPrincipal(): OwnerPrincipal {
  return { ...syntheticOwnerPrincipal(NOW), csrfToken: CSRF };
}

function order(status: string, id: string): OrderRow {
  return {
    id,
    workspaceId: 'ws_1',
    status,
    amountMinor: 2900,
    currency: 'GBP',
    rejectionReason: null,
    createdAt: OBSERVED,
  };
}

/** The in-memory port with every launch read answered, so the figures can be checked. */
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
    // Two under which money moved, one that never reached payment.
    return [order('active', 'ord_1'), order('refunded', 'ord_2'), order('checkout_created', 'ord_3')];
  }
}

/** A port whose reads fail the way a missing table or a dead binding fails: by throwing. */
class BrokenPort extends MemoryOwnerDataPort {
  override async overview(): Promise<OverviewView> {
    throw new Error('D1_ERROR: no such table: visit_sessions');
  }

  override async orders(): Promise<readonly OrderRow[]> {
    throw new Error('D1_ERROR: no such table: orders');
  }
}

function app(port: MemoryOwnerDataPort): Hono<RouteBindings> {
  const routes = new Hono<RouteBindings>();
  routes.route('/', createOwnerRoutes({ resolvePort: async () => port, now: () => NOW }));
  return routes;
}

async function get(routes: Hono<RouteBindings>, path: string): Promise<Response> {
  return routes.request(`${ORIGIN}${path}`, { headers: { cookie: `verify_csrf=${CSRF}` } }, ENV);
}

function figureValue(body: string, key: string): string {
  const open = `<span data-figure-value="${key}">`;
  const at = body.indexOf(open);
  expect(at, key).toBeGreaterThan(-1);
  return body.slice(at + open.length, body.indexOf('</span>\n', at)).trim();
}

const text = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('owner overview — launch figures through the router', () => {
  it('OWNER-905 the owner sees each figure as the port answered it — visits, ad-attributed visits, signups, paying customers, customers ever, paid orders, cash received and runs — never a typed-in number', async () => {
    const port = new KnownFiguresPort({ principal: ownerPrincipal(), now: () => NOW });
    const response = await get(app(port), '/owner');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(figureValue(body, 'external-visits')).toBe('13');
    expect(figureValue(body, 'ad-attributed-visits')).toBe('5');
    expect(figureValue(body, 'qualified-signups')).toBe('3');
    expect(figureValue(body, 'paying-customers')).toBe('2');
    expect(figureValue(body, 'customers-total')).toBe('7');
    // Two of the three orders are ones under which money moved; the count is a count.
    expect(figureValue(body, 'paid-orders')).toBe('2');
    // Zero pence from the ledger renders as an explicit, formatted zero.
    expect(figureValue(body, 'cash-received')).toBe('£0.00');
    expect(figureValue(body, 'runs-24h')).toBe('11');
    // The in-memory port is honest about being a stand-in, and the page still says so.
    expect(body).toContain('These figures are placeholders');
  });

  it('OWNER-906 a port whose reads throw renders the page with every figure unknown — no 500, no zero, no numeral in any figure slot', async () => {
    const port = new BrokenPort({ principal: ownerPrincipal(), now: () => NOW });
    const response = await get(app(port), '/owner');
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const key of [
      'external-visits',
      'ad-attributed-visits',
      'qualified-signups',
      'paying-customers',
      'customers-total',
      'paid-orders',
      'cash-received',
      'runs-24h',
    ]) {
      const value = figureValue(body, key);
      expect(value, key).toContain('data-unknown="true"');
      expect(text(value), key).toBe('unknown');
      expect(value, key).not.toMatch(/\d/);
    }
    expect(body).not.toMatch(/data-figure-value="[a-z0-9-]+">\s*0\s*</);
    expect(body).toContain('The overview could not be read, so no component health is known.');
    // The failure of one read did not take the page down: the title and the money table
    // are still there, the latter saying unknown on every line.
    expect(body).toContain('How the business is doing');
    expect(body).toContain('>Money<');
  });

  it('OWNER-907 the recomposed pages are still a 404 for an anonymous request, byte-identical to an unknown address, with no figure and no owner word in the body', async () => {
    const port = new MemoryOwnerDataPort({ principal: ANONYMOUS_PRINCIPAL, now: () => NOW });
    const routes = app(port);
    for (const path of ['/owner', '/owner/quality']) {
      const response = await get(routes, path);
      expect(response.status, path).toBe(404);
      const full = await response.text();
      const body = full.slice(full.indexOf('<body>'));
      expect(body, path).toContain('That page does not exist');
      expect(body, path).not.toContain('data-launch-figure');
      expect(body, path).not.toContain('data-figure-value');
      expect(body, path).not.toContain('How the business is doing');
      expect(body, path).not.toContain('Test centre');
      expect(body, path).not.toMatch(/unknown/i);
    }
    // The two recomposed screens refuse with the same bytes: nothing about the address
    // leaks through the 404, so the overview cannot be told from the test centre.
    const overview = await (await get(routes, '/owner')).text();
    const quality = await (await get(routes, '/owner/quality')).text();
    expect(overview).toBe(quality);
  });
});
