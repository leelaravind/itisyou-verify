/**
 * The public support page, as served.
 *
 * It showed the real support address and, beside it, "the support address has not been
 * published yet": a sentence written for the gap, printed after the gap had closed (audit,
 * 23 September). Case id `CUST-974`.
 */
import { describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import { OWNER_LEGAL_IDENTITY } from '@verify/ui';

describe('the public support page', () => {
  it('CUST-974 shows the published address without also saying it is unpublished', async () => {
    const response = await worker.fetch(
      new Request('https://verify.itisyou.app/support'),
      {
        ASSETS: { fetch: async () => new Response('', { status: 404 }) },
        ENVIRONMENT: 'test',
        PUBLIC_BASE_URL: 'https://verify.itisyou.app',
        STRIPE_MODE: 'test',
      } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(OWNER_LEGAL_IDENTITY.contactEmailForLegalNotices);
    expect(html).not.toContain('has not been published yet');
  });
});
