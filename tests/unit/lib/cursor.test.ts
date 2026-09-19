import { describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import {
  buildPage,
  clampLimit,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_SIZE,
} from '@app/db/cursor';

const row = (id: string, created_at: string) => ({ id, created_at });

describe('cursor pagination', () => {
  it('API-180 caps the page size no matter what a caller asks for', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(MAX_PAGE_SIZE + 1_000)).toBe(MAX_PAGE_SIZE);
    expect(clampLimit(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(-5)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(2.5)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('API-181 round-trips a cursor', () => {
    const cursor = { createdAt: '2026-09-19T10:00:00.000Z', id: 'run_01' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('API-182 keeps the cursor opaque', () => {
    const encoded = encodeCursor({ createdAt: '2026-09-19T10:00:00.000Z', id: 'run_01' });
    expect(encoded).not.toContain('2026');
    expect(encoded).not.toContain('run_01');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('API-183 treats a malformed cursor as a 400, never as a silent reset', () => {
    expect(() => decodeCursor('!!!not base64!!!')).toThrow(AppError);
    expect(() => decodeCursor('YWJj')).toThrow(AppError); // decodes, but wrong shape
    try {
      decodeCursor('YWJj');
    } catch (error) {
      expect((error as AppError).httpStatus).toBe(400);
      expect((error as AppError).code).toBe('INVALID_CURSOR');
    }
  });

  it('API-184 treats absent and empty cursors as "first page"', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('API-185 builds a page and only emits a cursor when another page exists', () => {
    const rows = [row('a', 't3'), row('b', 't2'), row('c', 't1')];
    const exact = buildPage(rows, 3);
    expect(exact.items).toHaveLength(3);
    expect(exact.nextCursor).toBeNull();

    const more = buildPage(rows, 2);
    expect(more.items).toHaveLength(2);
    expect(more.nextCursor).not.toBeNull();
    expect(decodeCursor(more.nextCursor)).toEqual({ createdAt: 't2', id: 'b' });
  });

  it('API-186 never returns the look-ahead row', () => {
    const rows = [row('a', 't2'), row('b', 't1')];
    expect(buildPage(rows, 1).items.map((r) => r.id)).toEqual(['a']);
  });
});
