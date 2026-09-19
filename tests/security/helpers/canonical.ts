/**
 * Canonical payload hashing — TEST-ONLY REFERENCE implementation, owned by A10.
 *
 * Threat (APPROVAL-01, ADS-01): `approvals.canonical_payload_hash` and
 * `campaigns.approved_payload_hash` are the entire defence against an approval being
 * reused for a different action. If the hash is computed over `JSON.stringify(payload)`
 * with insertion-ordered keys, then an attacker — or a buggy assistant tool call, or a
 * retried request that rebuilt the object in a different order — produces a DIFFERENT
 * hash for the SAME action (approval silently rejected, availability bug) or, far worse,
 * an implementation that hashes only a subset of fields produces the SAME hash for a
 * DIFFERENT action: approve £15 of ads, spend £1,500.
 *
 * An approval must bind to every field that changes what the money buys:
 * budget, audience, creative, destination and duration. If a field is not in the hash,
 * it is not approved.
 *
 * A07 (owner approvals), A08 (assistant) and A12 (campaigns) must use one shared
 * canonicaliser. Put it in `packages/security/` (A02) and import it everywhere —
 * two implementations of "canonical" is the same as none.
 */

/**
 * Deterministic JSON: object keys sorted by code unit, no insignificant whitespace,
 * arrays keep their order (order is meaning), and anything that cannot round-trip is
 * rejected loudly rather than silently coerced.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('canonicalJson: non-finite number is not representable');
    }
    if (!Number.isInteger(value as number)) {
      // Money is integer minor units everywhere in this system (brief rule 2). A float in
      // an approval payload means someone bypassed the Money helpers.
      throw new TypeError('canonicalJson: non-integer number rejected; use integer minor units');
    }
    return String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'undefined') throw new TypeError('canonicalJson: undefined is not representable');
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalJson: ${t} is not representable`);
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue; // absent and explicitly-undefined must hash alike
    parts.push(`${JSON.stringify(key)}:${encode(v)}`);
  }
  return `{${parts.join(',')}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The fields an ad-spend approval binds to. Every one of these changes what the money
 * buys, so every one of them is in the hash. Adding a field here is a breaking change to
 * stored approvals — that is correct: old approvals must stop matching.
 */
export interface AdApprovalPayload {
  readonly action_type: 'campaign.launch' | 'campaign.budget_increase' | 'refund.issue';
  readonly budget_minor: number;
  readonly currency: 'GBP' | 'USD' | 'EUR';
  readonly audience_key: string;
  readonly creative_hash: string;
  readonly destination_url: string;
  readonly duration_days: number;
}

export async function approvalPayloadHash(payload: AdApprovalPayload): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Constant-time comparison of two hex strings. Length is compared first and is not
 * secret; the content comparison does not short-circuit.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
