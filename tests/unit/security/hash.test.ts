import { describe, expect, it } from 'vitest';
import {
  hashToken,
  hmacSha256Hex,
  sha256Hex,
  stableStringify,
  timingSafeEqual,
} from '@verify/security';

describe('hashing', () => {
  it('API-020 sha256Hex matches the published vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('API-021 sha256Hex matches the published vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('API-022 hmacSha256Hex matches RFC 4231 test case 1', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(await hmacSha256Hex(key, 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('API-023 hmacSha256Hex changes when a single body byte changes', async () => {
    const a = await hmacSha256Hex('secret', '{"amount":100}');
    const b = await hmacSha256Hex('secret', '{"amount":101}');
    expect(a).not.toBe(b);
  });

  it('API-024 hashToken is stable, one-way and domain-separated', async () => {
    const token = 'opaque-session-value';
    expect(await hashToken(token)).toBe(await hashToken(token));
    expect(await hashToken(token)).not.toContain(token);
    expect(await hashToken(token, 'session')).not.toBe(await hashToken(token, 'login'));
  });
});

describe('timingSafeEqual', () => {
  it('API-025 returns true for identical strings', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
  });

  it('API-026 returns false for equal-length strings that differ', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
  });

  it('API-027 returns false for different lengths and does not throw', () => {
    expect(() => timingSafeEqual('short', 'considerably-longer-value')).not.toThrow();
    expect(timingSafeEqual('short', 'considerably-longer-value')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('API-028 tolerates empty and missing-shaped inputs without throwing', () => {
    expect(() => timingSafeEqual('', 'x')).not.toThrow();
    expect(timingSafeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual('x', '')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('API-029 is not fooled by a prefix', () => {
    expect(timingSafeEqual('abcdef', 'abc')).toBe(false);
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('stableStringify', () => {
  it('API-030 orders object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: 2, b: 1 })).toBe(stableStringify({ b: 1, a: 2 }));
  });

  it('API-031 orders nested keys too and preserves array order', () => {
    const left = stableStringify({ z: { y: 1, x: [3, 1, 2] } });
    const right = stableStringify({ z: { x: [3, 1, 2], y: 1 } });
    expect(left).toBe(right);
    expect(left).toBe('{"z":{"x":[3,1,2],"y":1}}');
  });

  it('API-032 drops undefined members exactly as JSON.stringify does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('API-033 gives two structurally equal payloads the same hash input', async () => {
    const one = { event_id: 'e1', expected: { email_recipient: 'a@b.com' }, schema_version: 1 };
    const two = { schema_version: 1, expected: { email_recipient: 'a@b.com' }, event_id: 'e1' };
    expect(await sha256Hex(stableStringify(one))).toBe(await sha256Hex(stableStringify(two)));
  });

  it('API-034 refuses non-finite numbers and circular structures', () => {
    expect(() => stableStringify({ a: Number.NaN })).toThrow(TypeError);
    expect(() => stableStringify({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(TypeError);
  });

  it('API-035 escapes strings so a key cannot forge a delimiter', () => {
    expect(stableStringify({ 'a"b': 'c"d' })).toBe('{"a\\"b":"c\\"d"}');
  });
});
