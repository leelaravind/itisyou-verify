import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_NAME_INSECURE,
  csrfCookie,
  csrfCookieName,
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

  it('API-103 issues a host-locked, SameSite cookie in production', () => {
    const cookie = csrfCookie('abc');
    expect(cookie).toContain('__Host-verify_csrf=abc');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain=');
  });

  it('API-110 never emits a __Host- cookie without Secure (A10 AUTH-018)', () => {
    // Browsers discard a __Host- cookie that is not Secure, so an insecure origin would
    // get no CSRF cookie at all — and the tempting "fix" is to switch CSRF off.
    const insecure = csrfCookie('abc', { secure: false });
    expect(insecure).not.toContain('Secure');
    expect(insecure.startsWith('__Host-')).toBe(false);
    expect(insecure).toContain(`${CSRF_COOKIE_NAME_INSECURE}=abc`);
    expect(insecure).toContain('Path=/');
    expect(insecure).toContain('SameSite=Lax');
  });

  it('API-111 the prefix and Secure always travel together', () => {
    for (const secure of [true, false]) {
      const cookie = csrfCookie('abc', { secure });
      expect(cookie.startsWith('__Host-')).toBe(cookie.includes('Secure'));
      expect(cookie.startsWith(`${csrfCookieName(secure)}=`)).toBe(true);
    }
    expect(csrfCookieName(true)).toBe(CSRF_COOKIE_NAME);
    expect(csrfCookieName()).toBe(CSRF_COOKIE_NAME);
    expect(csrfCookieName(false)).toBe(CSRF_COOKIE_NAME_INSECURE);
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
    expect(
      isSameOriginRequest(request({ origin: 'https://verify.itisyou.app.evil.com' }), ORIGIN),
    ).toBe(false);
    expect(isSameOriginRequest(request({ origin: 'http://verify.itisyou.app' }), ORIGIN)).toBe(
      false,
    );
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
