import { describe, expect, it } from 'vitest';
import {
  addSeconds,
  addSecondsIso,
  hasElapsed,
  isBefore,
  nowIso,
  parseIso,
  retryAfterSeconds,
  secondsBetween,
  toIso,
} from '@app/lib/time';

const T = '2026-09-19T10:00:00.000Z';

describe('time', () => {
  it('API-120 nowIso and toIso always produce a UTC instant', () => {
    expect(nowIso(new Date(Date.UTC(2026, 8, 19, 10, 0, 0)))).toBe(T);
    expect(toIso(new Date(Date.UTC(2026, 8, 19, 10, 0, 0)))).toMatch(/Z$/);
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('API-121 normalises an offset instant to UTC rather than keeping local time', () => {
    expect(toIso('2026-09-19T11:00:00+01:00')).toBe(T);
  });

  it('API-122 parseIso throws on anything ambiguous', () => {
    expect(() => parseIso('2026-09-19')).toThrow(TypeError);
    expect(() => parseIso('2026-09-19T10:00:00')).toThrow(TypeError);
    expect(() => parseIso('19/09/2026')).toThrow(TypeError);
    expect(() => parseIso('')).toThrow(TypeError);
    expect(() => parseIso('2026-13-19T10:00:00Z')).toThrow(TypeError);
    expect(parseIso(T).toISOString()).toBe(T);
  });

  it('API-123 addSeconds moves forward and backward without touching the date object', () => {
    const base = parseIso(T);
    expect(toIso(addSeconds(base, 600))).toBe('2026-09-19T10:10:00.000Z');
    expect(toIso(addSeconds(base, -600))).toBe('2026-09-19T09:50:00.000Z');
    expect(base.toISOString()).toBe(T);
    expect(addSecondsIso(T, 60)).toBe('2026-09-19T10:01:00.000Z');
  });

  it('API-124 addSeconds crosses a DST boundary without shifting the wall of UTC', () => {
    // 2026-10-25 is the UK DST change. In UTC nothing special happens, which is the point.
    expect(addSecondsIso('2026-10-25T00:30:00.000Z', 3600)).toBe('2026-10-25T01:30:00.000Z');
  });

  it('API-125 isBefore is strict', () => {
    expect(isBefore(T, '2026-09-19T10:00:01.000Z')).toBe(true);
    expect(isBefore(T, T)).toBe(false);
    expect(isBefore('2026-09-19T10:00:01.000Z', T)).toBe(false);
  });

  it('API-126 secondsBetween is signed and truncates to whole seconds', () => {
    expect(secondsBetween(T, '2026-09-19T10:10:00.000Z')).toBe(600);
    expect(secondsBetween('2026-09-19T10:10:00.000Z', T)).toBe(-600);
    expect(secondsBetween(T, '2026-09-19T10:00:00.999Z')).toBe(0);
  });

  it('API-127 hasElapsed treats an exactly-reached deadline as elapsed', () => {
    expect(hasElapsed(T, T)).toBe(true);
    expect(hasElapsed('2026-09-19T10:00:01.000Z', T)).toBe(false);
  });

  it('API-128 retryAfterSeconds rounds up and never goes negative', () => {
    expect(retryAfterSeconds(T, '2026-09-19T10:00:00.001Z')).toBe(1);
    expect(retryAfterSeconds(T, '2026-09-19T10:00:30.500Z')).toBe(31);
    expect(retryAfterSeconds(T, T)).toBe(0);
    expect(retryAfterSeconds('2026-09-19T10:01:00.000Z', T)).toBe(0);
  });

  it('API-129 rejects non-finite offsets and invalid dates', () => {
    expect(() => addSeconds(T, Number.NaN)).toThrow(TypeError);
    expect(() => toIso(new Date('nonsense'))).toThrow(TypeError);
  });
});
