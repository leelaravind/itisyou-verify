/**
 * The free-model gate.
 *
 * Confirmed against OpenRouter's documentation on 2026-09-19:
 * `GET https://openrouter.ai/api/v1/models` returns `{ data: [...] }`; every `pricing`
 * value is a **string**; *"All pricing values are in USD per token/request/unit. A value
 * of `"0"` indicates the feature is free."* — https://openrouter.ai/docs/guides/overview/models
 * and https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.
 *
 * No test in this file reaches the network. The global guard in `tests/setup.ts` would
 * fail the run if one tried.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogueCache,
  fetchCatalogue,
  isDefinitelyFree,
  parseCatalogue,
  selectFreeModel,
} from '@app/assistant/catalogue';

const T0 = '2026-09-19T12:00:00.000Z';

function entry(id: string, pricing: Record<string, unknown>): Record<string, unknown> {
  return { id, name: id, context_length: 8_192, pricing };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('openrouter free catalogue', () => {
  it('BUDGET-039 a model whose input and output prices are both "0" is eligible', () => {
    expect(isDefinitelyFree({ prompt: '0', completion: '0', request: '0', image: '0' })).toBe(true);
    // The documented string form, and the numeric form some clients emit, both work.
    expect(isDefinitelyFree({ prompt: 0, completion: 0 })).toBe(true);
  });

  it('BUDGET-040 a non-zero output price disqualifies a model even when the input price is zero', () => {
    expect(isDefinitelyFree({ prompt: '0', completion: '0.0000006' })).toBe(false);
    expect(isDefinitelyFree({ prompt: '0.000001', completion: '0' })).toBe(false);
  });

  it('BUDGET-041 a missing price field is never treated as zero', () => {
    expect(isDefinitelyFree({ prompt: '0' })).toBe(false);
    expect(isDefinitelyFree({ completion: '0' })).toBe(false);
    expect(isDefinitelyFree({})).toBe(false);
    expect(isDefinitelyFree(null)).toBe(false);
    expect(isDefinitelyFree('free')).toBe(false);
  });

  it('BUDGET-042 an unparseable or empty price is not free', () => {
    expect(isDefinitelyFree({ prompt: 'free', completion: '0' })).toBe(false);
    expect(isDefinitelyFree({ prompt: '', completion: '0' })).toBe(false);
    expect(isDefinitelyFree({ prompt: '0', completion: 'NaN' })).toBe(false);
    // A per-request charge is a real cost even when the tokens are free.
    expect(isDefinitelyFree({ prompt: '0', completion: '0', request: '0.01' })).toBe(false);
  });

  it('BUDGET-043 the documented `data` envelope is parsed and the fetch time is recorded', () => {
    const outcome = parseCatalogue(
      {
        data: [
          entry('vendor/free-one:free', { prompt: '0', completion: '0', request: '0' }),
          entry('vendor/paid-one', { prompt: '0.00003', completion: '0.00006' }),
          entry('vendor/looks-free-but-is-not:free', { prompt: '0', completion: '0.00001' }),
        ],
        total_count: 3,
      },
      T0,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.snapshot.totalEntries).toBe(3);
    // The `:free` suffix in a name proves nothing; only the reported price does.
    expect(outcome.snapshot.freeModels.map((m) => m.id)).toEqual(['vendor/free-one:free']);
    expect(outcome.snapshot.fetchedAt).toBe(T0);
  });

  it('BUDGET-044 a malformed catalogue is reported as malformed, never as "no free models"', async () => {
    expect(parseCatalogue({ models: [] }, T0)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    expect(parseCatalogue('nope', T0)).toMatchObject({ ok: false, reason: 'MALFORMED' });

    const fetchImpl = vi.fn(async () => jsonResponse({ oops: true }));
    const outcome = await fetchCatalogue({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: T0,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED' });

    const bad = await fetchCatalogue({
      apiKey: 'k',
      fetchImpl: (async () => jsonResponse({}, 502)) as unknown as typeof fetch,
      now: T0,
    });
    expect(bad).toMatchObject({ ok: false, reason: 'BAD_STATUS' });

    const noKey = await fetchCatalogue({
      apiKey: null,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      now: T0,
    });
    expect(noKey).toMatchObject({ ok: false, reason: 'NO_KEY' });
  });

  it('BUDGET-045 the cache revalidates after its TTL and drops its snapshot when revalidation fails', async () => {
    const body = { data: [entry('vendor/free-one', { prompt: '0', completion: '0' })] };
    let calls = 0;
    const ok = (async () => {
      calls += 1;
      return jsonResponse(body);
    }) as unknown as typeof fetch;

    const cache = new CatalogueCache(60_000);
    await cache.revalidate({ apiKey: 'k', fetchImpl: ok, now: T0 });
    expect(calls).toBe(1);

    // Inside the TTL: reused, no second fetch.
    await cache.revalidate({ apiKey: 'k', fetchImpl: ok, now: '2026-09-19T12:00:30.000Z' });
    expect(calls).toBe(1);

    // Past the TTL: refetched.
    await cache.revalidate({ apiKey: 'k', fetchImpl: ok, now: '2026-09-19T12:02:00.000Z' });
    expect(calls).toBe(2);

    // A failed revalidation must not leave a stale price in place.
    const failing = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const outcome = await cache.revalidate({
      apiKey: 'k',
      fetchImpl: failing,
      now: '2026-09-19T12:05:00.000Z',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'UNREACHABLE' });
    expect(cache.snapshot).toBeNull();
  });

  it('BUDGET-046 unknown pricing and a no-longer-free model are both refusals, with distinct reasons', () => {
    const unknown = selectFreeModel(
      { ok: false, reason: 'UNREACHABLE', detail: 'network down' },
      'vendor/free-one',
    );
    expect(unknown).toMatchObject({ eligible: false, reason: 'PRICING_UNKNOWN' });

    const priced = parseCatalogue(
      { data: [entry('vendor/now-paid', { prompt: '0.00001', completion: '0' })] },
      T0,
    );
    expect(selectFreeModel(priced, 'vendor/now-paid')).toMatchObject({
      eligible: false,
      reason: 'NOT_FREE',
    });

    const none = parseCatalogue({ data: [] }, T0);
    expect(selectFreeModel(none, null)).toMatchObject({
      eligible: false,
      reason: 'NOT_IN_CATALOGUE',
    });

    const good = parseCatalogue(
      { data: [entry('vendor/free-one', { prompt: '0', completion: '0' })] },
      T0,
    );
    expect(selectFreeModel(good, 'vendor/free-one')).toMatchObject({ eligible: true });
  });
});
