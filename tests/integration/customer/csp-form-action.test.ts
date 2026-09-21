/**
 * The Content-Security-Policy as the Worker actually serves it, on the point that stopped
 * the first production checkout.
 *
 * `POST /app/onboarding/checkout` answers 303 to Stripe's hosted page. Chrome enforces
 * `form-action` on the redirect that follows a form submission, so `form-action 'self'`
 * silently swallowed that 303: the server created the Checkout Session, the customer
 * stayed on the review page, and nothing said why. Found 21 September 2026 on the owner's
 * first production checkout attempt; the code comment beside the directive had asserted
 * the opposite for a day.
 *
 * Case id `CUST-483`.
 */
import { describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import { createTestDb } from '../db/harness';

const BASE = 'https://verify.test';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function directives(csp: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    map.set(name ?? '', rest.join(' '));
  }
  return map;
}

describe('the served Content-Security-Policy lets a form post reach Stripe and nothing else', () => {
  it('CUST-483 form-action names self and exactly the two Stripe pages a post may redirect to', async () => {
    const h = createTestDb();
    try {
      const response = (await worker.fetch(
        new Request(`${BASE}/pricing`),
        {
          DB: h.db,
          ASSETS: { fetch: async () => new Response('', { status: 404 }) },
          ENVIRONMENT: 'test',
          PUBLIC_BASE_URL: BASE,
          STRIPE_MODE: 'test',
        } as never,
        ctx,
      )) as Response;
      expect(response.status).toBe(200);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp.length, 'no CSP header served').toBeGreaterThan(0);
      const map = directives(csp);
      const formAction = (map.get('form-action') ?? '').split(/\s+/).sort();
      expect(formAction).toEqual(
        ["'self'", 'https://billing.stripe.com', 'https://checkout.stripe.com'].sort(),
      );
      // The widening is confined to form-action. Nothing else gained a third party.
      expect(map.get('default-src')).toBe("'none'");
      expect(map.get('connect-src')).toBe("'self'");
      expect(map.get('frame-ancestors')).toBe("'none'");
      expect(map.get('base-uri')).toBe("'none'");
      expect(csp).not.toContain('unsafe-inline');
    } finally {
      h.close();
    }
  });
});
