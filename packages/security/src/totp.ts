/**
 * Time-based one-time passwords, over `otpauth`.
 *
 * Nothing here is hand-rolled. `otpauth` does the RFC 6238 arithmetic; this module owns
 * the three decisions that a library cannot make for us and that are the ones that
 * actually go wrong:
 *
 *  1. **The drift window.** One step either side (±30s). Wide enough for a phone whose
 *     clock is a little out, narrow enough that an intercepted code is useful for
 *     seconds rather than minutes.
 *  2. **Replay.** A valid code stays arithmetically valid for its whole step, and for the
 *     neighbouring steps under the window. That means a code shoulder-surfed, read from a
 *     proxy log, or captured in a screen share can be used again by somebody else inside
 *     the same minute. `verifyTotpCode` therefore returns the exact counter it accepted,
 *     and the caller must refuse anything at or below the last accepted one. The check is
 *     useless unless that counter is stored somewhere shared across sessions — see
 *     `apps/app/src/lib/auth.ts`, where it is one conditional UPSERT.
 *  3. **Enrolment is show-once.** The provisioning URI carries the secret in the clear. It
 *     is returned exactly once, from `createTotpEnrolment`, and there is deliberately no
 *     function in this module that reads a secret back out of storage for display.
 */
import { Secret, TOTP } from 'otpauth';
import { randomBytes } from './bytes';
import { hashToken, timingSafeEqual } from './hash';

/** RFC 6238 defaults, and what every authenticator app actually implements. */
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

/**
 * Steps of drift accepted either side of now. One step is ±30 seconds.
 *
 * Deliberately not 2 or 3. Every extra step multiplies the window in which a captured
 * code is still usable, and buys nothing except tolerance for a clock nobody has fixed.
 */
export const TOTP_WINDOW_STEPS = 1;

/** Secret size in bytes. 20 is the RFC 4226 recommendation for HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;

export interface TotpEnrolment {
  /** Base32, as authenticator apps expect it. Shown once and never again. */
  readonly secretBase32: string;
  /** `otpauth://totp/...`. Rendered as a QR code once, then discarded. */
  readonly provisioningUri: string;
}

function totpFor(secretBase32: string, issuer: string, accountName: string): TOTP {
  return new TOTP({
    issuer,
    label: accountName,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

/**
 * Mint a new enrolment. The returned secret is the only copy that will ever be
 * displayable; the caller seals it immediately and shows the URI once.
 */
export function createTotpEnrolment(params: {
  readonly issuer: string;
  readonly accountName: string;
}): TotpEnrolment {
  const secret = new Secret({ size: TOTP_SECRET_BYTES });
  const totp = totpFor(secret.base32, params.issuer, params.accountName);
  return { secretBase32: secret.base32, provisioningUri: totp.toString() };
}

/** The RFC 6238 counter for an instant: whole 30-second steps since the epoch. */
export function totpCounterAt(now: Date | number): number {
  const ms = typeof now === 'number' ? now : now.getTime();
  return Math.floor(ms / 1000 / TOTP_PERIOD_SECONDS);
}

export type TotpRefusal =
  /** Not six digits. Refused before any comparison, so a malformed code costs nothing. */
  | 'malformed'
  /** The arithmetic does not match, at any offset inside the window. */
  | 'mismatch'
  /** Correct, but this counter has already been accepted. The replay guard. */
  | 'replayed';

export type TotpCheck =
  | { readonly ok: true; readonly counter: number }
  | { readonly ok: false; readonly refusal: TotpRefusal };

const SIX_DIGITS = /^[0-9]{6}$/;

/**
 * Verify a code and report the counter it belongs to.
 *
 * `lastAcceptedCounter` is the highest counter previously accepted for this user, or null
 * if none. A code whose counter is at or below it is refused as `replayed` even though it
 * is arithmetically perfect — which is the whole point: the arithmetic cannot tell a
 * second use from a first.
 *
 * The digit check runs first so a malformed code never reaches the HMAC.
 */
export function verifyTotpCode(params: {
  readonly secretBase32: string;
  readonly code: string;
  readonly now: Date | number;
  readonly lastAcceptedCounter: number | null;
  readonly issuer?: string;
  readonly accountName?: string;
  readonly windowSteps?: number;
}): TotpCheck {
  const code = (params.code ?? '').trim();
  if (!SIX_DIGITS.test(code)) return { ok: false, refusal: 'malformed' };

  let totp: TOTP;
  try {
    totp = totpFor(
      params.secretBase32,
      params.issuer ?? 'ITISYOU Verify',
      params.accountName ?? 'owner',
    );
  } catch {
    // A secret that will not parse is a storage problem, not a wrong code. Reported as a
    // mismatch so the caller's answer to the person typing is identical either way.
    return { ok: false, refusal: 'mismatch' };
  }

  const timestamp = typeof params.now === 'number' ? params.now : params.now.getTime();
  const delta = totp.validate({
    token: code,
    timestamp,
    window: params.windowSteps ?? TOTP_WINDOW_STEPS,
  });
  if (delta === null) return { ok: false, refusal: 'mismatch' };

  const counter = totpCounterAt(timestamp) + delta;
  if (params.lastAcceptedCounter !== null && counter <= params.lastAcceptedCounter) {
    return { ok: false, refusal: 'replayed' };
  }
  return { ok: true, counter };
}

/** Generate the code for a given instant. Test and enrolment-confirmation use only. */
export function generateTotpCode(secretBase32: string, now: Date | number): string {
  const timestamp = typeof now === 'number' ? now : now.getTime();
  return totpFor(secretBase32, 'ITISYOU Verify', 'owner').generate({ timestamp });
}

/* -------------------------------------------------------------------------- */
/* recovery codes                                                              */
/* -------------------------------------------------------------------------- */

/** How many recovery codes an enrolment issues. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford base32 — no I, L, O or U, so a code read off paper cannot be mistyped as a
 * different valid code. 32 characters divides 256 exactly, so indexing a random byte into
 * it carries no modulo bias.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters per code. 20 from a 32-symbol alphabet is 100 bits. */
const RECOVERY_CODE_CHARS = 20;

/** Groups of five, for a code somebody has to read off paper and type back in. */
function mintRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_CHARS);
  let out = '';
  for (const byte of bytes) out += RECOVERY_ALPHABET[byte % 32];
  return (out.match(/.{1,5}/g) ?? [out]).join('-');
}

/** Normalise what a human typed: case, spaces and hyphens are all forgiven. */
export function normaliseRecoveryCode(value: string): string {
  return (value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export interface RecoveryCodeSet {
  /** Shown to the owner once. Never stored in this form. */
  readonly codes: readonly string[];
  /** What goes to storage: one irreversible hash per code, in the same order. */
  readonly hashes: readonly string[];
}

/**
 * Mint a set of single-use recovery codes.
 *
 * Only the hashes are storable. The codes themselves exist for the length of one response
 * and are never recoverable — which is the point: a recovery code that can be read back
 * out of the database is a second password, not a recovery code.
 */
export async function createRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): Promise<RecoveryCodeSet> {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = mintRecoveryCode();
    codes.push(code);
    hashes.push(await hashRecoveryCode(code));
  }
  return { codes, hashes };
}

/** The storage address of a recovery code. Domain-separated from every other token hash. */
export function hashRecoveryCode(code: string): Promise<string> {
  return hashToken(normaliseRecoveryCode(code), 'recovery');
}

/** Constant-time compare for two recovery hashes. */
export function recoveryHashesMatch(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}
