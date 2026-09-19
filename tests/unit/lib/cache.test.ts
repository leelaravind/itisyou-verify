/**
 * Cache posture. Cloudflare does not cache HTML or JSON by default, so today we are
 * private by accident of content type; these cases make it an instruction instead.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPrivateCacheHeaders,
  privateCacheHeaders,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  withPrivateCacheHeaders,
} from '@app/lib/cache';

describe('private cache headers', () => {
  it('API-220 marks an unlabelled response private, no-store and Vary: Cookie', () => {
    const headers = new Headers({ 'content-type': 'text/html' });
    applyPrivateCacheHeaders(headers);
    expect(headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    expect(headers.get('cache-control')).toContain('private');
    expect(headers.get('cache-control')).toContain('no-store');
    expect(headers.get('vary')).toBe('Cookie');
  });

  it('API-221 leaves a deliberate public Cache-Control alone but still varies by cookie', () => {
    const headers = new Headers({ 'cache-control': PUBLIC_CACHE_CONTROL });
    applyPrivateCacheHeaders(headers);
    expect(headers.get('cache-control')).toBe(PUBLIC_CACHE_CONTROL);
    expect(headers.get('vary')).toBe('Cookie');
  });

  it('API-222 merges into an existing Vary rather than overwriting it', () => {
    const headers = new Headers({ vary: 'Accept-Encoding' });
    applyPrivateCacheHeaders(headers);
    expect(headers.get('vary')).toBe('Accept-Encoding, Cookie');
  });

  it('API-223 does not duplicate Cookie, and respects Vary: *', () => {
    const already = new Headers({ vary: 'Accept-Encoding, Cookie' });
    applyPrivateCacheHeaders(already);
    expect(already.get('vary')).toBe('Accept-Encoding, Cookie');

    const wildcard = new Headers({ vary: '*' });
    applyPrivateCacheHeaders(wildcard);
    expect(wildcard.get('vary')).toBe('*');
  });

  it('API-224 withPrivateCacheHeaders preserves status and body', async () => {
    const original = new Response('{"run_id":"run_1"}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = withPrivateCacheHeaders(original);
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get('content-type')).toBe('application/json');
    expect(wrapped.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    expect(await wrapped.text()).toBe('{"run_id":"run_1"}');
  });

  it('API-225 the middleware stamps whatever the handler produced, errors included', async () => {
    const middleware = privateCacheHeaders();
    const context = { res: new Response('nope', { status: 500 }) };
    await middleware(context, async () => {});
    expect(context.res.status).toBe(500);
    expect(context.res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    expect(context.res.headers.get('vary')).toBe('Cookie');
  });

  it('API-226 the middleware rebuilds a response whose headers are immutable', async () => {
    const middleware = privateCacheHeaders();
    // `Response.redirect` produces immutable headers in a spec-compliant runtime.
    const context = { res: Response.redirect('https://verify.itisyou.app/app', 302) };
    await middleware(context, async () => {});
    expect(context.res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    expect(context.res.headers.get('location')).toBe('https://verify.itisyou.app/app');
  });
});
