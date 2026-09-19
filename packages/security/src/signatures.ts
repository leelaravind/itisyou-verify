/**
 * Request and webhook signature verification.
 *
 * Three schemes live here, all HMAC-SHA-256 over raw bytes:
 *
 * 1. Our own scheme for `POST /api/v1/events`. Header `t=<unix>,v1=<hex>` over
 *    `${timestamp}.${rawBody}`. Tolerance comes from `SIGNATURE_TOLERANCE_SECONDS` in
 *    `@verify/contracts` so the client and the server cannot drift apart.
 * 2. Stripe. Confirmed 2026-09-19 against
 *    https://docs.stripe.com/webhooks?verify=verify-manually — header
 *    `t=<unix>,v1=<hex>[,v0=<hex>]`, signed payload `${timestamp}.${rawBody}`,
 *    HMAC-SHA-256 hex keyed by the endpoint signing secret, all schemes other than `v1`
 *    ignored to prevent downgrade, default tolerance 5 minutes, verification must run
 *    against the unmodified raw body.
 * 3. Svix, which is what Resend uses. Confirmed 2026-09-19 against
 *    https://docs.svix.com/receiving/verifying-payloads/how-manual and
 *    https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests — headers
 *    `svix-id`, `svix-timestamp`, `svix-signature`; signed content
 *    `${id}.${timestamp}.${body}`; the secret is `whsec_` + base64 and the base64 part is
 *    decoded to raw key bytes; the signature is base64 (not hex); the header holds
 *    space-delimited `v1,<sig>` entries and non-`v1` versions are ignored.
 *
 * Every failure returns a distinct machine reason so a route can log precisely what was
 * wrong without telling the caller more than "invalid signature".
 */
import { SIGNATURE_TOLERANCE_SECONDS } from '@verify/contracts';
import { concatBytes, fromBase64, toBase64, toBytes, utf8Bytes } from './bytes';
import { hmacSha256Bytes, hmacSha256Hex, timingSafeEqual } from './hash';

export type SignatureFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'missing_signature'
  | 'timestamp_stale'
  | 'timestamp_in_future'
  | 'signature_mismatch'
  | 'malformed_secret';

export type SignatureResult =
  | { readonly valid: true; readonly timestamp: number }
  | { readonly valid: false; readonly reason: SignatureFailureReason };

const ok = (timestamp: number): SignatureResult => ({ valid: true, timestamp });
const fail = (reason: SignatureFailureReason): SignatureResult => ({ valid: false, reason });

/** Stripe's documented library default. Also a sane default for our own scheme. */
export const STRIPE_TOLERANCE_SECONDS = 300;
/** Svix's recommended tolerance. */
export const SVIX_TOLERANCE_SECONDS = 300;

function unixSeconds(now: Date | number): number {
  return Math.floor((typeof now === 'number' ? now : now.getTime()) / 1000);
}

/**
 * Parse a `t=...,v1=...` style header into its timestamp and the list of `v1` values.
 * Unknown schemes are dropped rather than accepted, which is what prevents a downgrade
 * to Stripe's test-only `v0` scheme.
 */
function parseTimestampedHeader(
  header: string,
  signatureScheme: string,
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (name === 't') {
      if (timestamp !== null) return null;
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (name === signatureScheme) {
      if (value.length === 0) return null;
      signatures.push(value);
    }
  }
  if (timestamp === null) return null;
  return { timestamp, signatures };
}

function checkFreshness(
  timestamp: number,
  now: Date | number,
  toleranceSeconds: number,
): SignatureFailureReason | null {
  const current = unixSeconds(now);
  if (timestamp > current + toleranceSeconds) return 'timestamp_in_future';
  if (timestamp < current - toleranceSeconds) return 'timestamp_stale';
  return null;
}

function signedPayloadBytes(timestamp: number, rawBody: string | Uint8Array): Uint8Array {
  return concatBytes(utf8Bytes(`${timestamp}.`), toBytes(rawBody));
}

// ---------------------------------------------------------------------------
// Our own scheme: POST /api/v1/events
// ---------------------------------------------------------------------------

export interface SignRequestOptions {
  readonly secret: string;
  readonly rawBody: string | Uint8Array;
  /** Unix seconds. Defaults to now. */
  readonly timestamp?: number;
}

/** Produce the value for our `X-Verify-Signature` header: `t=<unix>,v1=<hex>`. */
export async function signRequest({
  secret,
  rawBody,
  timestamp,
}: SignRequestOptions): Promise<string> {
  const t = timestamp ?? unixSeconds(Date.now());
  const hex = await hmacSha256Hex(secret, signedPayloadBytes(t, rawBody));
  return `t=${t},v1=${hex}`;
}

export interface VerifyRequestOptions {
  readonly secret: string;
  readonly header: string | null | undefined;
  readonly rawBody: string | Uint8Array;
  readonly now?: Date | number;
  readonly toleranceSeconds?: number;
}

/**
 * Verify our own request signature.
 *
 * Rejects, with a distinct reason each: a missing header, a header that does not parse,
 * a header with no `v1` value, a timestamp older than the tolerance, a timestamp further
 * into the future than the tolerance, and a signature that does not match. The timestamp
 * is inside the signed payload, so a replay cannot be re-stamped without the secret.
 */
export async function verifyRequest({
  secret,
  header,
  rawBody,
  now = Date.now(),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
}: VerifyRequestOptions): Promise<SignatureResult> {
  if (typeof header !== 'string' || header.trim().length === 0) return fail('missing_header');
  const parsed = parseTimestampedHeader(header, 'v1');
  if (parsed === null) return fail('malformed_header');
  if (parsed.signatures.length === 0) return fail('missing_signature');

  const freshness = checkFreshness(parsed.timestamp, now, toleranceSeconds);
  if (freshness !== null) return fail(freshness);

  const expected = await hmacSha256Hex(secret, signedPayloadBytes(parsed.timestamp, rawBody));
  for (const candidate of parsed.signatures) {
    if (timingSafeEqual(expected, candidate.toLowerCase())) return ok(parsed.timestamp);
  }
  return fail('signature_mismatch');
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/**
 * Verify a Stripe webhook against the raw request bytes.
 *
 * `rawBody` must be exactly what Stripe sent. Re-serialising parsed JSON changes the
 * bytes and the signature will not match — that is the intended behaviour, not a bug.
 */
export async function verifyStripeSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  now: Date | number = Date.now(),
  toleranceSeconds: number = STRIPE_TOLERANCE_SECONDS,
): Promise<SignatureResult> {
  if (typeof secret !== 'string' || secret.length === 0) return fail('malformed_secret');
  if (typeof header !== 'string' || header.trim().length === 0) return fail('missing_header');
  const parsed = parseTimestampedHeader(header, 'v1');
  if (parsed === null) return fail('malformed_header');
  // Stripe sends a fake `v0` for test events; ignoring every non-v1 scheme is what the
  // documentation asks for, so a header with only `v0` is a missing signature.
  if (parsed.signatures.length === 0) return fail('missing_signature');

  const freshness = checkFreshness(parsed.timestamp, now, toleranceSeconds);
  if (freshness !== null) return fail(freshness);

  const expected = await hmacSha256Hex(secret, signedPayloadBytes(parsed.timestamp, rawBody));
  for (const candidate of parsed.signatures) {
    if (timingSafeEqual(expected, candidate.toLowerCase())) return ok(parsed.timestamp);
  }
  return fail('signature_mismatch');
}

// ---------------------------------------------------------------------------
// Svix (Resend)
// ---------------------------------------------------------------------------

export interface SvixHeaders {
  readonly id: string | null | undefined;
  readonly timestamp: string | null | undefined;
  readonly signature: string | null | undefined;
}

/** Read the three Svix headers off a Request, tolerating the `webhook-` aliases. */
export function readSvixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get('svix-id') ?? headers.get('webhook-id'),
    timestamp: headers.get('svix-timestamp') ?? headers.get('webhook-timestamp'),
    signature: headers.get('svix-signature') ?? headers.get('webhook-signature'),
  };
}

/**
 * Verify a Svix-signed webhook (Resend). The signed content is `${id}.${timestamp}.${body}`
 * and the key is the base64 payload of the `whsec_`-prefixed secret.
 */
export async function verifySvixSignature(
  rawBody: string | Uint8Array,
  headers: SvixHeaders,
  secret: string,
  now: Date | number = Date.now(),
  toleranceSeconds: number = SVIX_TOLERANCE_SECONDS,
): Promise<SignatureResult> {
  const { id, timestamp, signature } = headers;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof timestamp !== 'string' ||
    timestamp.length === 0 ||
    typeof signature !== 'string' ||
    signature.trim().length === 0
  ) {
    return fail('missing_header');
  }
  if (!/^\d{1,15}$/.test(timestamp)) return fail('malformed_header');

  let keyBytes: Uint8Array;
  try {
    const material = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    if (material.length === 0) return fail('malformed_secret');
    keyBytes = fromBase64(material);
  } catch {
    return fail('malformed_secret');
  }

  const parsedTimestamp = Number(timestamp);
  const freshness = checkFreshness(parsedTimestamp, now, toleranceSeconds);
  if (freshness !== null) return fail(freshness);

  const candidates: string[] = [];
  for (const entry of signature.split(' ')) {
    const part = entry.trim();
    if (part.length === 0) continue;
    const comma = part.indexOf(',');
    if (comma <= 0) return fail('malformed_header');
    if (part.slice(0, comma) !== 'v1') continue; // ignore other versions
    const value = part.slice(comma + 1);
    if (value.length > 0) candidates.push(value);
  }
  if (candidates.length === 0) return fail('missing_signature');

  const content = concatBytes(utf8Bytes(`${id}.${timestamp}.`), toBytes(rawBody));
  const expected = toBase64(await hmacSha256Bytes(keyBytes, content));
  for (const candidate of candidates) {
    if (timingSafeEqual(expected, candidate)) return ok(parsedTimestamp);
  }
  return fail('signature_mismatch');
}

/** Produce a Svix-shaped signature; used by tests and by the webhook replay fixtures. */
export async function signSvix(
  rawBody: string | Uint8Array,
  id: string,
  timestamp: number,
  secret: string,
): Promise<string> {
  const material = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const content = concatBytes(utf8Bytes(`${id}.${timestamp}.`), toBytes(rawBody));
  return `v1,${toBase64(await hmacSha256Bytes(fromBase64(material), content))}`;
}

/** Produce a Stripe-shaped signature header; used by tests and local replay fixtures. */
export async function signStripe(
  rawBody: string | Uint8Array,
  timestamp: number,
  secret: string,
): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, signedPayloadBytes(timestamp, rawBody))}`;
}
