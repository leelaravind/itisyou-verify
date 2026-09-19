/**
 * Budget movements. Money is integer minor units; a cap must never be crossed, and a
 * retry must never move money twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { budget } from '@app/db';
import { budgetAvailableMinor, canReserve } from '@verify/contracts';
import { countRows, createTestDb, seedBudgetAccount, T0, type TestDb } from './harness';

const ACCOUNT = 'bac_ads';

const reserve = (h: TestDb, amountMinor: number, key: string, entryId = `bce_${key}`) =>
  budget.reserve(h.db, {
    entryId,
    accountId: ACCOUNT,
    amountMinor,
    source: 'ads',
    idempotencyKey: key,
    at: T0,
  });

describe('budget', () => {
  let h: TestDb;
  beforeEach(() => {
    h = createTestDb();
    seedBudgetAccount(h, ACCOUNT, { limitMinor: 1_500, safetyBufferMinor: 500 });
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-120 reserves within the available balance', async () => {
    const outcome = await reserve(h, 400, 'k1');
    expect(outcome).toEqual({ ok: true, idempotent: false, entryId: 'bce_k1' });
    const account = await budget.getAccount(h.db, ACCOUNT);
    expect(account?.reserved_minor).toBe(400);
    expect(await budget.available(h.db, ACCOUNT)).toBe(600);
  });

  it('PERSIST-121 respects the safety buffer: the buffer is not spendable', async () => {
    // limit 1500, buffer 500 -> only 1000 is available.
    expect(await budget.available(h.db, ACCOUNT)).toBe(1_000);
    const refused = await reserve(h, 1_001, 'k1');
    expect(refused).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    const allowed = await reserve(h, 1_000, 'k2');
    expect(allowed.ok).toBe(true);
  });

  it('PERSIST-122 writes nothing at all when the funds are not there', async () => {
    const refused = await reserve(h, 5_000, 'k1');
    expect(refused).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect(countRows(h, 'budget_entries')).toBe(0);
    const account = await budget.getAccount(h.db, ACCOUNT);
    expect(account?.reserved_minor).toBe(0);
    expect(account?.revision).toBe(1);
  });

  it('PERSIST-123 a retry with the same idempotency key is a no-op', async () => {
    const first = await reserve(h, 400, 'same-key');
    const retry = await reserve(h, 400, 'same-key', 'bce_other_id');
    expect(first).toMatchObject({ ok: true, idempotent: false });
    expect(retry).toEqual({ ok: true, idempotent: true, entryId: 'bce_same-key' });
    expect(countRows(h, 'budget_entries')).toBe(1);
    expect((await budget.getAccount(h.db, ACCOUNT))?.reserved_minor).toBe(400);
  });

  it('PERSIST-124 two concurrent requests for the last pound: exactly one succeeds', async () => {
    seedBudgetAccount(h, 'bac_tight', { limitMinor: 100 });
    const attempt = (key: string) =>
      budget.reserve(h.db, {
        entryId: `bce_${key}`,
        accountId: 'bac_tight',
        amountMinor: 100,
        source: 'ads',
        idempotencyKey: key,
        at: T0,
      });
    const [a, b] = await Promise.all([attempt('a'), attempt('b')]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'INSUFFICIENT_FUNDS' }]);
    const account = await budget.getAccount(h.db, 'bac_tight');
    expect(account?.reserved_minor).toBe(100);
    expect(countRows(h, 'budget_entries', 'account_id = ?', 'bac_tight')).toBe(1);
  });

  it('PERSIST-125 five concurrent reservations against a balance that fits two', async () => {
    seedBudgetAccount(h, 'bac_two', { limitMinor: 200 });
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((key) =>
        budget.reserve(h.db, {
          entryId: `bce_two_${key}`,
          accountId: 'bac_two',
          amountMinor: 100,
          source: 'ads',
          idempotencyKey: `two-${key}`,
          at: T0,
        }),
      ),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    const account = await budget.getAccount(h.db, 'bac_two');
    expect(account?.reserved_minor).toBe(200);
    expect(budgetAvailableMinor({
      authorised_limit_minor: account?.authorised_limit_minor ?? 0,
      spent_minor: account?.spent_minor ?? 0,
      reserved_minor: account?.reserved_minor ?? 0,
      committed_minor: account?.committed_minor ?? 0,
      safety_buffer_minor: account?.safety_buffer_minor ?? 0,
      currency: 'GBP',
    })).toBe(0);
  });

  it('PERSIST-126 release hands a reservation back and cannot release more than is held', async () => {
    await reserve(h, 400, 'r1');
    const released = await budget.release(h.db, {
      entryId: 'bce_rel',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'rel-1',
      at: T0,
    });
    expect(released.ok).toBe(true);
    expect((await budget.getAccount(h.db, ACCOUNT))?.reserved_minor).toBe(0);

    const overRelease = await budget.release(h.db, {
      entryId: 'bce_rel2',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'rel-2',
      at: T0,
    });
    expect(overRelease).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect((await budget.getAccount(h.db, ACCOUNT))?.reserved_minor).toBe(0);
  });

  it('PERSIST-127 settle turns a reservation into spend without changing the total committed', async () => {
    await reserve(h, 400, 's1');
    const settled = await budget.settle(h.db, {
      entryId: 'bce_set',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'set-1',
      at: T0,
    });
    expect(settled.ok).toBe(true);
    const account = await budget.getAccount(h.db, ACCOUNT);
    expect(account).toMatchObject({ reserved_minor: 0, spent_minor: 400, committed_minor: 0 });
    // Spent money is gone: availability drops by the settled amount.
    expect(await budget.available(h.db, ACCOUNT)).toBe(600);
  });

  it('PERSIST-128 settle is idempotent, so a retried callback cannot double-spend', async () => {
    await reserve(h, 400, 's1');
    await budget.settle(h.db, {
      entryId: 'bce_set',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'set-1',
      at: T0,
    });
    const retry = await budget.settle(h.db, {
      entryId: 'bce_set_retry',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'set-1',
      at: T0,
    });
    expect(retry).toEqual({ ok: true, idempotent: true, entryId: 'bce_set' });
    expect((await budget.getAccount(h.db, ACCOUNT))?.spent_minor).toBe(400);
    expect(countRows(h, 'budget_entries', "kind = 'spend'")).toBe(1);
  });

  it('PERSIST-129 commit moves a reservation to a committed obligation', async () => {
    await reserve(h, 400, 'c1');
    const committed = await budget.commit(h.db, {
      entryId: 'bce_com',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'com-1',
      at: T0,
    });
    expect(committed.ok).toBe(true);
    const account = await budget.getAccount(h.db, ACCOUNT);
    expect(account).toMatchObject({ reserved_minor: 0, committed_minor: 400, spent_minor: 0 });
    // Committed money is still unavailable — that is the point of the column.
    expect(await budget.available(h.db, ACCOUNT)).toBe(600);
  });

  it('PERSIST-130 reports a missing account distinctly from insufficient funds', async () => {
    const outcome = await budget.reserve(h.db, {
      entryId: 'bce_x',
      accountId: 'bac_does_not_exist',
      amountMinor: 1,
      source: 'ads',
      idempotencyKey: 'missing-1',
      at: T0,
    });
    expect(outcome).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' });
    expect(countRows(h, 'budget_entries')).toBe(0);
  });

  it('PERSIST-131 rejects non-integer and non-positive amounts before touching the database', async () => {
    await expect(reserve(h, 0, 'z1')).rejects.toThrow(TypeError);
    await expect(reserve(h, -100, 'z2')).rejects.toThrow(TypeError);
    await expect(reserve(h, 10.5, 'z3')).rejects.toThrow(TypeError);
    expect(countRows(h, 'budget_entries')).toBe(0);
  });

  it('PERSIST-132 every movement leaves an auditable ledger entry', async () => {
    await reserve(h, 400, 'l1');
    await budget.settle(h.db, {
      entryId: 'bce_l2',
      accountId: ACCOUNT,
      amountMinor: 400,
      source: 'ads',
      idempotencyKey: 'l2',
      at: T0,
    });
    const entries = await budget.listEntries(h.db, ACCOUNT);
    expect(entries.map((e) => e.kind).sort()).toEqual(['reserve', 'spend']);
    expect(entries.every((e) => e.amount_minor === 400)).toBe(true);
    expect(await budget.markReconciled(h.db, 'bce_l2', T0)).toBe(true);
    expect(await budget.markReconciled(h.db, 'bce_l2', T0)).toBe(false);
  });

  it('PERSIST-133 the contracts helper and the SQL guard agree on availability', async () => {
    const account = await budget.getAccount(h.db, ACCOUNT);
    const state = {
      authorised_limit_minor: account?.authorised_limit_minor ?? 0,
      spent_minor: account?.spent_minor ?? 0,
      reserved_minor: account?.reserved_minor ?? 0,
      committed_minor: account?.committed_minor ?? 0,
      safety_buffer_minor: account?.safety_buffer_minor ?? 0,
      currency: 'GBP' as const,
    };
    expect(budgetAvailableMinor(state)).toBe(await budget.available(h.db, ACCOUNT));
    expect(canReserve(state, 1_000)).toBe(true);
    expect(canReserve(state, 1_001)).toBe(false);
    expect((await reserve(h, 1_001, 'agree')).ok).toBe(false);
    expect((await reserve(h, 1_000, 'agree2')).ok).toBe(true);
  });
});
