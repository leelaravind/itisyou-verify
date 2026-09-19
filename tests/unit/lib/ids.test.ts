import { describe, expect, it } from 'vitest';
import { ID_PREFIX, isId, newId } from '@app/lib/ids';

describe('ids', () => {
  it('API-140 mints a prefixed, fixed-width, opaque id', () => {
    const id = newId(ID_PREFIX.run);
    expect(id.startsWith('run_')).toBe(true);
    expect(id).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('API-141 does not leak a count: 500 ids are all distinct and non-sequential', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) ids.add(newId(ID_PREFIX.run));
    expect(ids.size).toBe(500);
    // No id is the numeric successor of another: the random tail dominates.
    const tails = [...ids].map((id) => id.slice(-16));
    expect(new Set(tails).size).toBe(500);
  });

  it('API-142 sorts by creation time on the time prefix', () => {
    const early = newId(ID_PREFIX.run, Date.UTC(2026, 0, 1));
    const late = newId(ID_PREFIX.run, Date.UTC(2026, 8, 19));
    expect(early < late).toBe(true);
    const sameMs = [newId(ID_PREFIX.run, 1_700_000_000_000), newId(ID_PREFIX.run, 1_700_000_000_000)];
    expect(sameMs[0]?.slice(4, 14)).toBe(sameMs[1]?.slice(4, 14));
  });

  it('API-143 rejects a prefix that is not a short lowercase word', () => {
    expect(() => newId('Run')).toThrow(TypeError);
    expect(() => newId('')).toThrow(TypeError);
    expect(() => newId('run_id')).toThrow(TypeError);
    expect(() => newId('averyverylongprefix')).toThrow(TypeError);
  });

  it('API-144 isId checks shape and, optionally, prefix', () => {
    const id = newId(ID_PREFIX.evidence);
    expect(isId(id)).toBe(true);
    expect(isId(id, ID_PREFIX.evidence)).toBe(true);
    expect(isId(id, ID_PREFIX.run)).toBe(false);
    expect(isId('run_short')).toBe(false);
    expect(isId('nounderscore')).toBe(false);
    expect(isId(42)).toBe(false);
    expect(isId(null)).toBe(false);
    // 'I', 'L', 'O' and 'U' are excluded from Crockford base32 to avoid confusion.
    expect(isId(`run_${'I'.repeat(26)}`)).toBe(false);
  });

  it('API-145 exposes one canonical prefix per entity', () => {
    const values = Object.values(ID_PREFIX);
    expect(new Set(values).size).toBe(values.length);
    for (const prefix of values) expect(prefix).toMatch(/^[a-z]{2,4}$/);
  });
});
