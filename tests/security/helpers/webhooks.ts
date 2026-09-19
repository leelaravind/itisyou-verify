/**
 * Provider webhook signature verification — TEST-ONLY REFERENCE, owned by A10.
 *
 * Verified against current vendor documentation on 2026-09-19:
 *
 * STRIPE — https://docs.stripe.com/webhooks (section "Verify manually")
 *   Header: `Stripe-Signature: t=<unix seconds>,v1=<hex>,v0=<hex>`
 *   signed_payload = `${t}.${rawBody}`; HMAC-SHA256 keyed with the `whsec_...` secret
 *   USED AS AN OPAQUE ASCII STRING (Stripe does NOT base64-decode its secret).
 *   Signature is lowercase hex. Stripe's own libraries use a 5-minute (300s) tolerance
 *   and the docs say explicitly: "To prevent downgrade attacks, ignore all schemes that
 *   aren't v1" — a `v0` signature is sent for test events and must never be accepted.
 *   Multiple `v1` values can be present during a secret roll; accept if ANY matches.
 *   "Stripe requires the raw body of the request" — parsing and re-serialising breaks it.
 *   Duplicates: "Track event IDs to identify duplicate deliveries"; ordering is NOT
 *   guaranteed and `created` must not be used for ordering or dedupe.
 *
 * RESEND — https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 *   Resend signs with Svix, which implements the Standard Webhooks specification
 *   (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
 *   Headers: `svix-id`, `svix-timestamp`, `svix-signature` (Svix-branded aliases of
 *   `webhook-id` / `webhook-timestamp` / `webhook-signature`).
 *   signed_content = `${id}.${timestamp}.${rawBody}`; HMAC-SHA256; signature is
 *   BASE64, presented as `v1,<base64>` and possibly several space-separated values.
 *   The secret is `whsec_` + BASE64 — the prefix is stripped and the remainder is
 *   base64-DECODED to key bytes. This differs from Stripe and getting it wrong yields a
 *   verifier that rejects every legitimate call (and tempts someone to "fix" it by
 *   disabling verification).
 *   Spec requires a timestamp tolerance and a constant-time comparison.
 *
 * A06/A04 must adopt these. Two details that will bite:
 *   1. Read the body ONCE as bytes (`await request.arrayBuffer()`), verify over those
 *      bytes, and only then `JSON.parse`. Hono's `c.req.json()` consumes the body.
 *   2. Verification failure is 400 with no detail. Never 200, never an error that
 *      distinguishes "bad signature" from "unknown event id".
 */

export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'no_supported_scheme'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export type SignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SignatureFailure };

/** Stripe's documented library default. Never use 0 — that disables the recency check. */
export const STRIPE_TOLERANCE_SECONDS = 300;
/** Standard Webhooks / Svix recommended tolerance. */
export const SVIX_TOLERANCE_SECONDS = 300;

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Copies into a plain ArrayBuffer so the WebCrypto types line up on every runtime. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

async function hmacSha256(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, toArrayBuffer(message));
  return new Uint8Array(sig);
}

const enc = new TextEncoder();

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface StripeVerifyInput {
  /** RAW request bytes. Never a re-serialised object. */
  readonly rawBody: Uint8Array;
  readonly header: string | null;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}

export async function verifyStripeSignature(input: StripeVerifyInput): Promise<SignatureResult> {
  if (input.header === null || input.header.trim() === '') return { ok: false, reason: 'missing_header' };
  let timestamp: number | null = null;
  const v1Signatures: string[] = [];
  for (const element of input.header.split(',')) {
    const eq = element.indexOf('=');
    if (eq === -1) continue;
    const prefix = element.slice(0, eq).trim();
    const value = element.slice(eq + 1).trim();
    if (prefix === 't') {
      if (!/^[0-9]+$/.test(value)) return { ok: false, reason: 'malformed_header' };
      timestamp = Number.parseInt(value, 10);
    } else if (prefix === 'v1') {
      v1Signatures.push(value);
    }
    // Every other scheme — v0 included — is deliberately discarded. Stripe docs:
    // "To prevent downgrade attacks, ignore all schemes that aren't v1."
  }
  if (timestamp === null) return { ok: false, reason: 'malformed_header' };
  if (v1Signatures.length === 0) return { ok: false, reason: 'no_supported_scheme' };
  const tolerance = input.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  // signed_payload = timestamp + "." + raw body bytes
  const message = concatBytes(enc.encode(`${timestamp}.`), input.rawBody);
  const expected = await hmacSha256(enc.encode(input.secret), message);
  for (const candidate of v1Signatures) {
    const bytes = hexToBytes(candidate);
    if (bytes !== null && timingSafeEqualBytes(expected, bytes)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/** Test helper: produce a header Stripe would have produced. */
export async function signStripe(
  rawBody: Uint8Array,
  secret: string,
  timestamp: number,
): Promise<string> {
  const message = concatBytes(enc.encode(`${timestamp}.`), rawBody);
  const mac = await hmacSha256(enc.encode(secret), message);
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

export interface SvixVerifyInput {
  readonly rawBody: Uint8Array;
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signatureHeader: string | null;
  /** `whsec_<base64>`; the base64 remainder is DECODED to key bytes. */
  readonly secret: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}

export async function verifySvixSignature(input: SvixVerifyInput): Promise<SignatureResult> {
  if (!input.id || !input.timestamp || !input.signatureHeader) {
    return { ok: false, reason: 'missing_header' };
  }
  if (!/^[0-9]+$/.test(input.timestamp)) return { ok: false, reason: 'malformed_header' };
  const ts = Number.parseInt(input.timestamp, 10);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - ts) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const rawSecret = input.secret.startsWith('whsec_') ? input.secret.slice('whsec_'.length) : input.secret;
  const keyBytes = base64ToBytes(rawSecret);
  if (keyBytes === null) return { ok: false, reason: 'malformed_header' };

  const candidates: string[] = [];
  for (const part of input.signatureHeader.split(' ')) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    const version = part.slice(0, comma);
    if (version !== 'v1') continue; // ignore unknown / future / downgrade schemes
    candidates.push(part.slice(comma + 1));
  }
  if (candidates.length === 0) return { ok: false, reason: 'no_supported_scheme' };

  // signed_content = id . timestamp . raw body bytes
  const message = concatBytes(enc.encode(`${input.id}.${ts}.`), input.rawBody);
  const expected = await hmacSha256(keyBytes, message);
  for (const candidate of candidates) {
    const bytes = base64ToBytes(candidate);
    if (bytes !== null && timingSafeEqualBytes(expected, bytes)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/** Test helper: produce the `svix-signature` value Svix would have produced. */
export async function signSvix(
  rawBody: Uint8Array,
  secret: string,
  id: string,
  timestamp: number,
): Promise<string> {
  const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keyBytes = base64ToBytes(rawSecret);
  if (keyBytes === null) throw new TypeError('signSvix: secret is not base64');
  const message = concatBytes(enc.encode(`${id}.${timestamp}.`), rawBody);
  const mac = await hmacSha256(keyBytes, message);
  return `v1,${bytesToBase64(mac)}`;
}
