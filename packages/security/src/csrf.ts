/**
 * CSRF defence for the server-rendered application.
 *
 * Two independent checks, both required on a state-changing request:
 *
 * 1. Double-submit: a random token is set in a cookie and echoed in a hidden form field.
 *    An attacker on another origin can make the browser send the cookie but cannot read
 *    it, so they cannot produce the matching field.
 * 2. Origin check: `Origin`, falling back to `Referer`. A state-changing request with
 *    neither header is rejected rather than trusted.
 */
import { randomBytes, toBase64Url } from './bytes';
import { timingSafeEqual } from './hash';

/**
 * Name used for the double-submit cookie in production.
 *
 * The `__Host-` prefix is a browser-enforced guarantee: the cookie must be `Secure`, must
 * have `Path=/` and must carry no `Domain`, so a subdomain cannot set or overwrite it.
 */
export const CSRF_COOKIE_NAME = '__Host-verify_csrf';

/**
 * Name used when the connection is not HTTPS (local development over
 * http://localhost:8787).
 *
 * AUTH-137: a `__Host-` cookie without `Secure` is rejected outright by every browser, so
 * emitting one in development means no CSRF cookie at all, every form post fails, and the
 * obvious "fix" a hurried developer reaches for is turning the CSRF check off. Dropping
 * the prefix on an insecure origin keeps the mechanism working in development while
 * production keeps the strict, browser-enforced name.
 */
export const CSRF_COOKIE_NAME_INSECURE = 'verify_csrf';

export const CSRF_FIELD_NAME = 'csrf_token';

/** The cookie name for a given transport. Read the cookie back under the same name. */
export function csrfCookieName(secure = true): string {
  return secure ? CSRF_COOKIE_NAME : CSRF_COOKIE_NAME_INSECURE;
}

/** HTTP methods that cannot change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has((method ?? '').toUpperCase());
}

/** 32 random bytes, base64url. Opaque, and never derived from the session id. */
export function generateCsrfToken(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * Validate the double-submit pair. Both halves must be present and equal; comparison is
 * constant-time so a token cannot be discovered a character at a time.
 */
export function validateCsrfToken(
  cookieToken: string | null | undefined,
  submittedToken: string | null | undefined,
): boolean {
  if (typeof cookieToken !== 'string' || cookieToken.length < 16) return false;
  if (typeof submittedToken !== 'string' || submittedToken.length < 16) return false;
  return timingSafeEqual(cookieToken, submittedToken);
}

/**
 * `Set-Cookie` value for the double-submit cookie. Not HttpOnly — the form must echo it.
 *
 * `Secure` and the `__Host-` prefix move together: either both are present (production)
 * or neither is (local http development). They must never be separated, because a
 * `__Host-` cookie without `Secure` is silently discarded by the browser.
 */
export function csrfCookie(token: string, { secure = true }: { secure?: boolean } = {}): string {
  const parts = [
    `${csrfCookieName(secure)}=${token}`,
    'Path=/',
    'SameSite=Lax',
    'Max-Age=43200',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function originOf(value: string | null): string | null {
  if (value === null || value.length === 0 || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * True when the request demonstrably comes from `allowedOrigin`.
 *
 * `Origin` is preferred. When it is absent (some older clients omit it on same-origin
 * form posts) `Referer` is used and only its origin is considered. When neither header
 * is present the request is rejected: on a state-changing request, absence of proof is
 * not proof of absence.
 */
export function isSameOriginRequest(
  request: { readonly headers: Headers; readonly method: string },
  allowedOrigin: string,
): boolean {
  const expected = originOf(allowedOrigin);
  if (expected === null) return false;

  const origin = originOf(request.headers.get('origin'));
  if (origin !== null) return origin === expected;

  const referer = originOf(request.headers.get('referer'));
  if (referer !== null) return referer === expected;

  return false;
}
