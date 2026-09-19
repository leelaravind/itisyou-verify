/**
 * Hashing, HMAC and constant-time comparison.
 *
 * Every primitive here is Web Crypto (`crypto.subtle`), which exists in both Cloudflare
 * Workers and Node 22, so there is exactly one implementation to review.
 */
import { concatBytes, toBytes, toHex, utf8Bytes } from './bytes';

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBytes(input) as BufferSource);
  return toHex(new Uint8Array(digest));
}

async function importHmacKey(key: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toBytes(key) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function hmacSha256Bytes(
  key: string | Uint8Array,
  message: string | Uint8Array | ArrayBuffer,
): Promise<Uint8Array> {
  const cryptoKey = await importHmacKey(key);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, toBytes(message) as BufferSource);
  return new Uint8Array(signature);
}

export async function hmacSha256Hex(
  key: string | Uint8Array,
  message: string | Uint8Array | ArrayBuffer,
): Promise<string> {
  return toHex(await hmacSha256Bytes(key, message));
}

/**
 * Constant-time string comparison.
 *
 * On a length mismatch the comparison still runs to completion over a fixed number of
 * characters before returning false, so the failure mode does not leak length by timing.
 * Never throws — a caller comparing against a missing header must not get an exception.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  // Fixed cost: always walk the longer of the two, with a floor so an empty input is
  // not measurably cheaper than a populated one.
  const width = Math.max(left.length, right.length, 32);
  let diff = left.length ^ right.length;
  for (let i = 0; i < width; i += 1) {
    const l = left.charCodeAt(i % (left.length || 1)) | 0;
    const r = right.charCodeAt(i % (right.length || 1)) | 0;
    const inRange = i < left.length && i < right.length ? 1 : 0;
    diff |= (l ^ r) * inRange;
  }
  return diff === 0;
}

/**
 * One-way hash for anything we store that is really a bearer token: session cookie
 * values, magic-link tokens, invitation tokens. The domain prefix stops a hash computed
 * for one purpose being replayed as another.
 */
export async function hashToken(token: string, domain = 'session'): Promise<string> {
  return sha256Hex(concatBytes(utf8Bytes(`verify.token.v1.${domain}:`), utf8Bytes(token)));
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/**
 * Deterministic JSON with sorted object keys, for canonical payload hashes.
 *
 * Two structurally equal payloads always produce the same string regardless of key
 * insertion order, so a payload hash is stable across serialisers. `undefined` object
 * members are dropped exactly as `JSON.stringify` drops them; non-finite numbers throw
 * rather than silently becoming `null`.
 */
export function stableStringify(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, seen: Set<unknown>): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`stableStringify cannot encode the non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'bigint') throw new TypeError('stableStringify cannot encode a bigint');
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (seen.has(value)) throw new TypeError('stableStringify cannot encode a circular structure');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => write(item, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol')
      .sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export type { Json as StableJson };
