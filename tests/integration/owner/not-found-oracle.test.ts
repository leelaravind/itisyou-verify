/**
 * Unknown and refused owner addresses must be indistinguishable, through the real Worker.
 *
 * The owner sub-app is invoked with `.fetch()` from the Worker, so it never inherited the
 * Worker's not-found page: an invented path under /owner answered Hono's bare 13-byte
 * "404 Not Found" while a real but refused one answered the branded 404, and the difference
 * mapped the owner surface for anyone who asked (audit, 23 September). The owner routes'
 * own test harness mounts them with `app.route()`, which is why it could not see this; so
 * this case goes through the Worker's default export, the object Cloudflare invokes.
 *
 * Case id `OWNER-935`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getAnonymous, signedInWorkspace, type SignedIn } from '../customer/harness.js';

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
});

describe('owner not-found responses', () => {
  it('OWNER-935 an invented owner path and a real refused one return the same page to a stranger', async () => {
    open = await signedInWorkspace();
    const real = await getAnonymous(open, '/owner/customers');
    const invented = await getAnonymous(open, '/owner/no-such-page-at-all');
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    const strip = (html: string, path: string): string =>
      html
        .split(path)
        .join('P')
        .replace(/value="[0-9a-f]{64}"/g, 'value="T"');
    expect(strip(invented.html, '/owner/no-such-page-at-all')).toBe(
      strip(real.html, '/owner/customers'),
    );
    expect(invented.html.length).toBeGreaterThan(1000);
  });
});
