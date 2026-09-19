import { describe, expect, it } from 'vitest';
import {
  csrfCookie,
  generateCsrfToken,
  isSameOriginRequest,
  isStateChangingMethod,
  validateCsrfToken,
} from '@verify/security';

const ORIGIN = 'https://verify.itisyou.app';

function request(headers: Record<string, string>, method = 'POST') {
  return { headers: new Headers(headers), method };
}

describe('CSRF double submit', () => {
  it('API-100 generates opaque, unpredictable tokens', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('API-101 accepts a matching pair', () => {
    const token = generateCsrfToken();
    expect(validateCsrfToken(token, token)).toBe(true);
  });

  it('API-102 rejects a mismatched, missing or truncated pair', () => {
    const token = generateCsrfToken();
    expect(validateCsrfToken(token, generateCsrfToken())).toBe(false);
    expect(validateCsrfToken(token, null)).toBe(false);
    expect(validateCsrfToken(null, token)).toBe(false);
    expect(validateCsrfToken(token, token.slice(0, -1))).toBe(false);
    expect(validateCsrfToken('short', 'short')).toBe(false);
  });

  it('API-103 issues a host-locked, SameSite cookie', () => {
    const cookie = csrfCookie('abc');
    expect(cookie).toContain('__Host-verify_csrf=abc');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(csrfCookie('abc', { secure: false })).not.toContain('Secure');
  });

  it('API-104 classifies methods correctly', () => {
    expect(isStateChangingMethod('GET')).toBe(false);
    expect(isStateChangingMethod('head')).toBe(false);
    expect(isStateChangingMethod('OPTIONS')).toBe(false);
    expect(isStateChangingMethod('POST')).toBe(true);
    expect(isStateChangingMethod('delete')).toBe(true);
  });
});

describe('same-origin check', () => {
  it('API-105 accepts a matching Origin', () => {
    expect(isSameOriginRequest(request({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(isSameOriginRequest(request({ origin: `${ORIGIN}` }), `${ORIGIN}/app/runs`)).toBe(true);
  });

  it('API-106 rejects a different Origin, even a look-alike host', () => {
    expect(isSameOriginRequest(request({ origin: 'https://verify.itisyou.app.evil.com' }), ORIGIN)).toBe(
      false,
    );
    expect(isSameOriginRequest(request({ origin: 'http://verify.itisyou.app' }), ORIGIN)).toBe(false);
  });

  it('API-107 falls back to Referer only when Origin is absent', () => {
    expect(isSameOriginRequest(request({ referer: `${ORIGIN}/app/settings` }), ORIGIN)).toBe(true);
    // A present-but-wrong Origin wins over a correct Referer.
    expect(
      isSameOriginRequest(
        request({ origin: 'https://evil.example', referer: `${ORIGIN}/app` }),
        ORIGIN,
      ),
    ).toBe(false);
  });

  it('API-108 rejects when neither header is present on a state-changing request', () => {
    expect(isSameOriginRequest(request({}), ORIGIN)).toBe(false);
  });

  it('API-109 rejects the opaque "null" origin and unparseable values', () => {
    expect(isSameOriginRequest(request({ origin: 'null' }), ORIGIN)).toBe(false);
    expect(isSameOriginRequest(request({ origin: 'not a url' }), ORIGIN)).toBe(false);
    expect(isSameOriginRequest(request({ referer: 'not a url' }), ORIGIN)).toBe(false);
    expect(isSameOriginRequest(request({ origin: ORIGIN }), 'not a url')).toBe(false);
  });
});
