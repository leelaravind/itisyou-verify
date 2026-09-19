/**
 * SEC-3xx — canonical payload hashing and approval binding.
 *
 * `approvals.canonical_payload_hash` is the only thing standing between "the owner
 * approved a £15 test campaign" and "£1,500 was spent". These cases pin the two
 * properties that matter and are easy to get wrong in opposite directions:
 *   - STABILITY: semantically identical payloads must hash the SAME, or valid approvals
 *     get rejected at random and someone will "fix" it by loosening the check.
 *   - SENSITIVITY: any change to what the money buys must hash DIFFERENTLY.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  sha256Hex,
  approvalPayloadHash,
  timingSafeEqualHex,
  type AdApprovalPayload,
} from '../helpers/canonical.js';

const BASE: AdApprovalPayload = {
  action_type: 'campaign.launch',
  budget_minor: 1500,
  currency: 'GBP',
  audience_key: 'uk:smb:operations',
  creative_hash: 'a3f1c0de',
  destination_url: 'https://verify.itisyou.app/?utm_source=ads',
  duration_days: 7,
};

describe('canonical JSON', () => {
  it('SEC-301 sorts object keys so insertion order cannot change the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('SEC-302 sorts nested keys too', () => {
    const one = canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const two = canonicalJson({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(one).toBe(two);
    expect(one).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('SEC-303 emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    expect(canonicalJson({ a: 1 })).not.toContain(' ');
  });

  it('SEC-304 preserves array order, because order is meaning', () => {
    expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
  });

  it('SEC-305 treats an absent key and an explicitly-undefined key identically', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('SEC-306 refuses values that cannot round-trip rather than coercing them', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 10n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });

  it('SEC-307 refuses a non-integer amount — money is integer minor units (brief rule 2)', () => {
    expect(() => canonicalJson({ budget_minor: 15.0001 })).toThrow(TypeError);
    expect(canonicalJson({ budget_minor: 1500 })).toBe('{"budget_minor":1500}');
  });
});

describe('approval binding', () => {
  it('SEC-310 is stable across key reordering and whitespace in the source object', async () => {
    const reordered: AdApprovalPayload = {
      duration_days: BASE.duration_days,
      destination_url: BASE.destination_url,
      creative_hash: BASE.creative_hash,
      audience_key: BASE.audience_key,
      currency: BASE.currency,
      budget_minor: BASE.budget_minor,
      action_type: BASE.action_type,
    };
    expect(await approvalPayloadHash(reordered)).toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-311 changes when the budget changes by one penny', async () => {
    const plusOne = { ...BASE, budget_minor: BASE.budget_minor + 1 };
    expect(await approvalPayloadHash(plusOne)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-312 changes when the audience changes', async () => {
    const other = { ...BASE, audience_key: 'us:enterprise:it' };
    expect(await approvalPayloadHash(other)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-313 changes when the creative changes', async () => {
    const other = { ...BASE, creative_hash: 'deadbeef' };
    expect(await approvalPayloadHash(other)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-314 changes when the destination changes', async () => {
    const other = { ...BASE, destination_url: 'https://verify.itisyou.app/?utm_source=other' };
    expect(await approvalPayloadHash(other)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-315 changes when the duration changes', async () => {
    const other = { ...BASE, duration_days: 8 };
    expect(await approvalPayloadHash(other)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-316 changes when the currency changes even though the number is identical', async () => {
    const other = { ...BASE, currency: 'USD' as const };
    expect(await approvalPayloadHash(other)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-317 changes when the action type changes — an approval is not transferable', async () => {
    const other = { ...BASE, action_type: 'refund.issue' as const };
    expect(await approvalPayloadHash(other)).not.toBe(await approvalPayloadHash(BASE));
  });

  it('SEC-318 produces a 64-character lowercase hex SHA-256', async () => {
    const h = await approvalPayloadHash(BASE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('constant-time comparison', () => {
  it('SEC-320 returns true only for identical hex strings', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });

  it('SEC-321 does not short-circuit on the first differing character', () => {
    // A source-level guard: the implementation must not use === or indexOf on the
    // secret-bearing comparison. This asserts the observable contract; a true timing
    // measurement is unreliable on a shared CI runner and is deliberately not attempted.
    const source = timingSafeEqualHex.toString();
    expect(source).toContain('^');
    expect(source).not.toMatch(/return\s+a\s*===\s*b/);
  });
});
