import { describe, expect, it } from 'vitest';
import { maskEmail, maskToken, maskValue, neutraliseCsvField, redactObject } from '@verify/security';

describe('maskEmail', () => {
  it('API-080 masks the local part to a fixed width', () => {
    expect(maskEmail('ada@example.com')).toBe('a**@example.com');
    expect(maskEmail('alexander.lovelace@example.co.uk')).toBe('a**@example.co.uk');
  });

  it('API-081 does not leak the length of the local part', () => {
    expect(maskEmail('ab@x.com')).toBe('a**@x.com');
    expect(maskEmail('abcdefghijklmnop@x.com')).toBe('a**@x.com');
  });

  it('API-082 masks a single-character local part entirely', () => {
    expect(maskEmail('a@example.com')).toBe('***@example.com');
  });

  it('API-083 masks anything that is not shaped like an address', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('ada@')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });

  it('API-084 uses the last @ so a local part containing @ cannot hide the domain', () => {
    expect(maskEmail('we"ird@thing@example.com')).toBe('w**@example.com');
  });
});

describe('maskToken', () => {
  it('API-085 masks short values entirely', () => {
    expect(maskToken('abc')).toBe('********');
    expect(maskToken('12345678')).toBe('********');
    expect(maskToken('')).toBe('********');
  });

  it('API-086 keeps only a short suffix of a long value', () => {
    expect(maskToken('sk_live_0123456789abcdef')).toBe('********cdef');
    expect(maskToken('sk_live_0123456789abcdef')).not.toContain('sk_live');
  });
});

describe('redactObject', () => {
  it('API-087 returns only allowlisted keys', () => {
    // secret-scan:allow — invented string proving redaction works; not a real credential
    const input = { email: 'ada@example.com', api_key: 'sk_live_super_secret_value', count: 3 };
    expect(redactObject(input, ['email', 'count'])).toEqual({
      email: 'a**@example.com',
      count: 3,
    });
  });

  it('API-088 drops a key nobody allowlisted, even a dangerous one', () => {
    const out = redactObject({ password: 'hunter2' }, ['email']);
    expect(out).toEqual({});
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('API-089 masks values by type', () => {
    const out = redactObject(
      {
        token: 'abcdefghijklmnopqrstuvwxyz', // secret-scan:allow — synthetic alphabet, not a credential
        email: 'ada@example.com',
        amount_minor: 2900,
        ok: true,
        nothing: null,
        nested: { a: 1 },
      },
      ['token', 'email', 'amount_minor', 'ok', 'nothing', 'nested'],
    );
    expect(out).toEqual({
      token: '********wxyz',
      email: 'a**@example.com',
      amount_minor: 2900,
      ok: true,
      nothing: null,
      nested: '[object]',
    });
  });

  it('API-090 returns an empty object for non-objects', () => {
    expect(redactObject(null, ['a'])).toEqual({});
    expect(redactObject('string', ['a'])).toEqual({});
    expect(redactObject([1, 2], ['a'])).toEqual({});
  });

  it('API-091 does not pick up inherited properties', () => {
    const base = { secret: 'inherited' };
    const child = Object.create(base) as Record<string, unknown>;
    child['own'] = 'value-long-enough';
    expect(redactObject(child, ['secret', 'own'])).toEqual({ own: '********ough' });
  });

  it('API-092 masks array members rather than passing them through', () => {
    expect(maskValue(['ada@example.com', 'abcdefghijklmnop'])).toEqual([
      'a**@example.com',
      '********mnop',
    ]);
  });
});

describe('neutraliseCsvField', () => {
  it('API-093 prefixes = + - @ so a spreadsheet treats them as text', () => {
    expect(neutraliseCsvField('=cmd|/c calc')).toBe("'=cmd|/c calc");
    expect(neutraliseCsvField('+1')).toBe("'+1");
    expect(neutraliseCsvField('-1')).toBe("'-1");
    expect(neutraliseCsvField('@x')).toBe("'@x");
  });

  it('API-094 prefixes a leading tab and a leading carriage return', () => {
    expect(neutraliseCsvField('\tSUM(A1)')).toBe("'\tSUM(A1)");
    expect(neutraliseCsvField('\r=1+1')).toBe("'\r=1+1");
  });

  it('API-095 leaves ordinary values untouched', () => {
    expect(neutraliseCsvField('VERIFIED')).toBe('VERIFIED');
    expect(neutraliseCsvField('2026-09-19T10:00:00.000Z')).toBe('2026-09-19T10:00:00.000Z');
    expect(neutraliseCsvField('a=b')).toBe('a=b');
    expect(neutraliseCsvField(' =1')).toBe(' =1');
    expect(neutraliseCsvField('')).toBe('');
  });

  it('API-096 coerces non-strings and never returns undefined', () => {
    expect(neutraliseCsvField(null)).toBe('');
    expect(neutraliseCsvField(undefined)).toBe('');
    expect(neutraliseCsvField(2900)).toBe('2900');
    expect(neutraliseCsvField(-1)).toBe("'-1");
    expect(neutraliseCsvField(true)).toBe('true');
  });
});
