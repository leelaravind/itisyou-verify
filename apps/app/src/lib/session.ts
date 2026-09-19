/**
 * The session cookie convention.
 *
 * Nobody owned this yet, and three subsystems were about to invent three different
 * answers. It lives here because it is request plumbing, next to CSRF and the request
 * context, and because exactly one place should know how a cookie value becomes a row.
 *
 * Shape of the scheme:
 *
 *  - The cookie carries a 32-byte random value, base64url. It is a bearer token and
 *    nothing else — it encodes no user id, no workspace, no expiry, so there is nothing
 *    in it to tamper with and nothing to leak if it is logged by a proxy.
 *  - The database stores `hashToken(value, 'session')`, never the value. A database dump
 *    cannot be replayed as a login.
 *  - `__Host-` + `Secure` + `HttpOnly` + `SameSite=Lax` in production; the prefix and
 *    `Secure` drop together on a plain-http origin for the same reason they do for CSRF
 *    (`csrf.ts`), because a `__Host-` cookie without `Secure` is silently discarded.
 *  - Resolution is a single scoped query. An expired or revoked session resolves to
 *    `null`, never to "signed in but stale".
 */
import { hashToken, randomBytes, toBase64Url } from '@verify/security';
import type { Role } from '@verify/contracts';
import type { Db } from '../db/d1';
import { memberships, sessions, users, workspaces } from '../db';
import { nowIso } from './time';

export const SESSION_COOKIE_NAME = '__Host-verify_session';
export const SESSION_COOKIE_NAME_INSECURE = 'verify_session';

/** Twelve hours. Short enough that a stolen cookie ages out, long enough to be usable. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function sessionCookieName(secure = true): string {
  return secure ? SESSION_COOKIE_NAME : SESSION_COOKIE_NAME_INSECURE;
}

/** Mint a fresh opaque cookie value. Never derived from anything about the user. */
export function newSessionValue(): string {
  return toBase64Url(randomBytes(32));
}

/** The row id for a cookie value. The value itself is never stored. */
export function sessionIdFor(cookieValue: string): Promise<string> {
  return hashToken(cookieValue, 'session');
}

export function sessionCookie(
  value: string,
  { secure = true, maxAgeSeconds = SESSION_TTL_SECONDS }: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  const parts = [
    `${sessionCookieName(secure)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** `Set-Cookie` that clears the session cookie. Used on sign-out. */
export function clearSessionCookie(secure = true): string {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

/**
 * Read a cookie by name from a raw `Cookie` header.
 *
 * Deliberately not a general cookie parser: it splits on `;`, takes the first `=`, and
 * ignores anything malformed rather than trying to be clever about quoting.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null || header.length === 0) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    return value.length === 0 ? null : value;
  }
  return null;
}

/** True when this request arrived over HTTPS, which decides the cookie name. */
export function isSecureRequest(request: { readonly url: string }, publicBaseUrl: string): boolean {
  try {
    if (new URL(publicBaseUrl).protocol === 'https:') return true;
  } catch {
    /* fall through to the request */
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

/** Everything a page needs to know about who is asking, resolved server-side. */
export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: Role;
  readonly mfaVerifiedAt: string | null;
  readonly isPlatformOwner: boolean;
}

/**
 * Resolve the signed-in identity, and the one workspace this request acts in.
 *
 * The workspace is resolved from membership, never from the request. When a user belongs
 * to several, the oldest is used — v1 has no workspace switcher, and inventing one here
 * would be a silent policy decision in the wrong file.
 */
export async function resolveSession(
  db: Db,
  request: { readonly headers: Headers; readonly url: string },
  publicBaseUrl: string,
  now: Date = new Date(),
): Promise<ResolvedSession | null> {
  const secure = isSecureRequest(request, publicBaseUrl);
  const cookieValue =
    readCookie(request.headers.get('cookie'), sessionCookieName(secure)) ??
    // Accept the other name too: a developer switching between http and https locally
    // should not be silently signed out with no explanation.
    readCookie(request.headers.get('cookie'), sessionCookieName(!secure));
  if (cookieValue === null) return null;

  const sessionId = await sessionIdFor(cookieValue);
  const row = await sessions.findLive(db, sessionId, nowIso(now));
  if (row === null) return null;

  const user = await users.findById(db, row.user_id);
  if (user === null || user.disabled_at !== null) return null;

  const memberOf = await workspaces.listForUser(db, user.id);
  const first = memberOf[0];
  if (first === undefined) return null;

  const role = await memberships.roleFor(db, first.id, user.id);
  if (role === null) return null;

  return {
    sessionId,
    userId: user.id,
    email: user.auth_subject,
    workspaceId: first.id,
    workspaceName: first.name,
    role,
    mfaVerifiedAt: row.mfa_verified_at,
    isPlatformOwner: user.is_platform_owner === 1,
  };
}
