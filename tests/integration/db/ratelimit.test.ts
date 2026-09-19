import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consume, purgeExpired } from '@app/lib/ratelimit';
import { createTestDb, type TestDb } from './harness';

const T0 = new Date('2026-09-19T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('fixed-window rate limiter', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('API-200 allows exactly up to the limit', async () => {
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await consume(h.db, 'events:ws_a', 3, 60, T0));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);
    expect(results.map((r) => r.retryAfterSeconds)).toEqual([0, 0, 0]);
  });

  it('API-201 denies past the limit and reports a usable Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) await consume(h.db, 'events:ws_a', 3, 60, T0);
    const denied = await consume(h.db, 'events:ws_a', 3, 60, at(10));
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBe(50);
  });

  it('API-202 resets after the window rolls', async () => {
    for (let i = 0; i < 3; i += 1) await consume(h.db, 'events:ws_a', 3, 60, T0);
    expect((await consume(h.db, 'events:ws_a', 3, 60, at(30))).allowed).toBe(false);
    const fresh = await consume(h.db, 'events:ws_a', 3, 60, at(61));
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1);
    expect(fresh.remaining).toBe(2);
  });

  it('API-203 keeps buckets independent', async () => {
    for (let i = 0; i < 3; i += 1) await consume(h.db, 'events:ws_a', 3, 60, T0);
    const other = await consume(h.db, 'events:ws_b', 3, 60, T0);
    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });

  it('PERSIST-010 counts every concurrent consumer exactly once', async () => {
    // Ten callers hit the same bucket. The limiter is a single atomic statement, so the
    // counts it returns must be exactly 1..10 with no duplicates — which is what a
    // read-then-write limiter gets wrong.
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => consume(h.db, 'events:ws_a', 4, 60, T0)),
    );
    const counts = decisions.map((d) => d.count).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(4);
  });

  it('API-204 rejects nonsensical configuration rather than allowing everything', async () => {
    await expect(consume(h.db, 'b', 0, 60, T0)).rejects.toThrow(TypeError);
    await expect(consume(h.db, 'b', 5, 0, T0)).rejects.toThrow(TypeError);
    await expect(consume(h.db, 'b', 1.5, 60, T0)).rejects.toThrow(TypeError);
  });

  it('PERSIST-011 purges only expired buckets', async () => {
    await consume(h.db, 'old', 5, 60, T0);
    await consume(h.db, 'new', 5, 60, at(100));
    const removed = await purgeExpired(h.db, at(150));
    expect(removed).toBe(1);
    const remaining = await h.db.prepare('SELECT bucket FROM rate_limits').all<{ bucket: string }>();
    expect(remaining.results.map((r) => r.bucket)).toEqual(['new']);
  });
});
