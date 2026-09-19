/**
 * Mode selection and spending, end to end through `ask`, against a real SQLite database.
 *
 * Nothing here reaches a provider. `fetchImpl` is a stub in every case, and the global
 * guard in `tests/setup.ts` fails the run if anything escapes it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_CONFIG,
  ask,
  saveAssistantConfig,
  type AssistantActor,
  type AssistantConfig,
  type AssistantDataPort,
  type ModelRequest,
} from '@app/assistant/index';
import { budget } from '@app/db/index';
import { createTestDb, seedBudgetAccount, type TestDb } from '../db/harness';

const NOW = '2026-09-19T12:00:00.000Z';
const OWNER: AssistantActor = { userId: 'usr_owner', workspaceId: 'ws_1', isPlatformOwner: true };

const PORT: AssistantDataPort = {
  summary: async () => ({
    window_days: 7,
    runs_by_status: {},
    total_runs: 0,
    connections_total: 0,
    connections_degraded: 0,
    generated_at: NOW,
  }),
  incidents: async () => [],
  explainRun: async () => null,
  campaignFacts: async () => null,
  maintenanceKindEnabled: async () => true,
};

function catalogueFetch(
  models: { id: string; prompt: string; completion: string }[],
): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        data: models.map((m) => ({
          id: m.id,
          name: m.id,
          context_length: 8_192,
          pricing: { prompt: m.prompt, completion: m.completion, request: '0' },
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

function okModel(captured: ModelRequest[]) {
  return (async (request: ModelRequest) => {
    captured.push(request);
    return {
      ok: true as const,
      text: 'Four runs verified in the last week.',
      toolCalls: [],
      promptTokens: 1_000,
      completionTokens: 40,
    };
  }) as never;
}

const PAID: AssistantConfig = {
  ...DEFAULT_ASSISTANT_CONFIG,
  mode: 'paid_api',
  paidProvider: 'openrouter',
  paidModelId: 'vendor/paid-model',
  perRequestCapMinor: 50,
  cumulativeCapMinor: 1_000,
  budgetAccountId: 'bac_assistant',
};

describe('assistant model routing', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('BUDGET-025 in openrouter_free mode only zero-cost models are selectable', async () => {
    const config: AssistantConfig = {
      ...DEFAULT_ASSISTANT_CONFIG,
      mode: 'openrouter_free',
      freeModelId: 'vendor/free-one',
    };
    const captured: ModelRequest[] = [];
    const answer = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([
          { id: 'vendor/free-one', prompt: '0', completion: '0' },
          { id: 'vendor/paid-one', prompt: '0.00003', completion: '0.00006' },
        ]),
        apiKey: 'or-key',
        now: () => NOW,
        requestId: 'req_free_ok',
        modelCall: okModel(captured),
      },
      OWNER,
      'how are we doing?',
      {},
      config,
    );
    expect(answer.available).toBe(true);
    if (!answer.available) throw new Error('unreachable');
    expect(answer.model_id).toBe('vendor/free-one');
    expect(answer.cost_minor).toBeNull();

    // Choosing the paid entry while in free mode is refused, not silently honoured.
    const refused = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([{ id: 'vendor/paid-one', prompt: '0.00003', completion: '0' }]),
        apiKey: 'or-key',
        now: () => NOW,
        requestId: 'req_free_paid',
        modelCall: okModel([]),
      },
      OWNER,
      'q',
      {},
      { ...config, freeModelId: 'vendor/paid-one' },
    );
    expect(refused.available).toBe(false);
    if (refused.available) throw new Error('unreachable');
    expect(refused.reason).toBe('FREE_MODEL_NOT_FREE');
  });

  it('BUDGET-026 a paid model call requires a budget reservation before the request is made', async () => {
    seedBudgetAccount(h, 'bac_assistant', { scope: 'assistant', limitMinor: 10_000 });

    const captured: ModelRequest[] = [];
    let reservedWhenCalled = -1;
    const model = (async (request: ModelRequest) => {
      captured.push(request);
      const account = await budget.getAccount(h.db, 'bac_assistant');
      reservedWhenCalled = account?.reserved_minor ?? -1;
      return {
        ok: true as const,
        text: 'ok',
        toolCalls: [],
        promptTokens: 1_000,
        completionTokens: 40,
      };
    }) as never;

    const answer = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([]),
        apiKey: 'paid-key',
        now: () => NOW,
        requestId: 'req_paid_1',
        paidPricing: { inputPricePerMillionMinor: 10_000, outputPricePerMillionMinor: 20_000 },
        modelCall: model,
      },
      OWNER,
      'summarise the week',
      {},
      PAID,
    );
    expect(answer.available).toBe(true);
    // The reservation existed while the provider request was in flight, which is the
    // ordering the rule is about.
    expect(reservedWhenCalled).toBeGreaterThan(0);

    const after = await budget.getAccount(h.db, 'bac_assistant');
    expect(after?.reserved_minor).toBe(0);
    expect(after?.spent_minor).toBeGreaterThan(0);
  });

  it('BUDGET-027 an unavailable free model never falls back upward into a paid tier', async () => {
    const attempted: string[] = [];
    const model = (async (request: ModelRequest) => {
      attempted.push(request.modelId);
      return { ok: false as const, reason: 'PROVIDER_UNAVAILABLE' as const, detail: '503' };
    }) as never;

    const answer = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([{ id: 'vendor/free-one', prompt: '0', completion: '0' }]),
        apiKey: 'or-key',
        now: () => NOW,
        requestId: 'req_free_out',
        paidPricing: { inputPricePerMillionMinor: 10_000, outputPricePerMillionMinor: 20_000 },
        modelCall: model,
      },
      OWNER,
      'q',
      {},
      { ...DEFAULT_ASSISTANT_CONFIG, mode: 'openrouter_free', freeModelId: 'vendor/free-one' },
    );

    expect(answer.available).toBe(false);
    if (answer.available) throw new Error('unreachable');
    expect(answer.reason).toBe('PROVIDER_UNAVAILABLE');
    expect(answer.message).toContain('No answer has been invented');
    // Exactly one attempt, at the free model. No second, paid attempt exists.
    expect(attempted).toEqual(['vendor/free-one']);
    // And no money moved: the free path never reserves.
    expect(await budget.getAccount(h.db, 'bac_assistant')).toBeNull();
  });

  it('BUDGET-028 a model request carries a bounded timeout and token cap', async () => {
    const captured: ModelRequest[] = [];
    await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([{ id: 'vendor/free-one', prompt: '0', completion: '0' }]),
        apiKey: 'or-key',
        now: () => NOW,
        requestId: 'req_bounds',
        modelCall: okModel(captured),
      },
      OWNER,
      'q',
      {},
      { ...DEFAULT_ASSISTANT_CONFIG, mode: 'openrouter_free', freeModelId: 'vendor/free-one' },
    );
    const request = captured[0];
    expect(request).toBeDefined();
    expect(request?.maxOutputTokens).toBeGreaterThan(0);
    expect(request?.maxOutputTokens).toBeLessThanOrEqual(1_024);
    expect(request?.timeoutMs).toBeGreaterThan(0);
    expect(request?.timeoutMs).toBeLessThanOrEqual(20_000);
    // The tool list handed to the provider is the server's registry, not a caller's.
    expect(request?.tools.map((t) => t.name)).toContain('propose_pause');
  });

  it('BUDGET-029 a model provider error never becomes a fabricated assistant answer', async () => {
    seedBudgetAccount(h, 'bac_assistant', { scope: 'assistant', limitMinor: 10_000 });
    for (const failure of ['PROVIDER_TIMEOUT', 'PROVIDER_ERROR', 'PROVIDER_UNAVAILABLE'] as const) {
      const answer = await ask(
        {
          db: h.db,
          port: PORT,
          fetchImpl: catalogueFetch([]),
          apiKey: 'paid-key',
          now: () => NOW,
          requestId: `req_fail_${failure}`,
          paidPricing: { inputPricePerMillionMinor: 10_000, outputPricePerMillionMinor: 20_000 },
          modelCall: (async () => ({ ok: false, reason: failure, detail: 'upstream' })) as never,
        },
        OWNER,
        'did the refund go through?',
        {},
        PAID,
      );
      expect(answer.available).toBe(false);
      if (answer.available) throw new Error('unreachable');
      expect(answer.reason).toBe(failure);
      expect(answer.message).toContain('nothing has changed');
    }
    // BUDGET-053 in spirit: every failed call handed its reservation back.
    const account = await budget.getAccount(h.db, 'bac_assistant');
    expect(account?.reserved_minor).toBe(0);
    expect(account?.spent_minor).toBe(0);
  });

  it('BUDGET-051 free mode stops entirely when pricing cannot be confirmed', async () => {
    const unreachable = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    const attempted: string[] = [];
    const answer = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: unreachable,
        apiKey: 'or-key',
        now: () => NOW,
        requestId: 'req_unknown_pricing',
        paidPricing: { inputPricePerMillionMinor: 1, outputPricePerMillionMinor: 1 },
        modelCall: (async (request: ModelRequest) => {
          attempted.push(request.modelId);
          return { ok: true, text: 'x', toolCalls: [], promptTokens: 0, completionTokens: 0 };
        }) as never,
      },
      OWNER,
      'q',
      {},
      { ...DEFAULT_ASSISTANT_CONFIG, mode: 'openrouter_free', freeModelId: 'vendor/free-one' },
    );
    expect(answer.available).toBe(false);
    if (answer.available) throw new Error('unreachable');
    expect(answer.reason).toBe('FREE_PRICING_UNKNOWN');
    expect(answer.message).toContain('will not make a paid call');
    // No model was called at all — not the free one, and certainly not a paid one.
    expect(attempted).toEqual([]);
  });

  it('BUDGET-052 the cumulative cap blocks the call that would exceed it, and nothing is sent', async () => {
    // 995 of the 1000 cumulative cap is already spent.
    seedBudgetAccount(h, 'bac_assistant', {
      scope: 'assistant',
      limitMinor: 100_000,
      spentMinor: 995,
    });
    const attempted: string[] = [];
    const answer = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([]),
        apiKey: 'paid-key',
        now: () => NOW,
        requestId: 'req_cap',
        // Prices chosen so the estimate (11) is well inside the per-request cap of 50 but
        // more than the 5 minor units left under the cumulative cap. This is the boundary
        // the case is about: the *cumulative* rule must be the one that refuses.
        paidPricing: { inputPricePerMillionMinor: 0, outputPricePerMillionMinor: 10_000 },
        modelCall: (async (request: ModelRequest) => {
          attempted.push(request.modelId);
          return { ok: true, text: 'x', toolCalls: [], promptTokens: 0, completionTokens: 0 };
        }) as never,
      },
      OWNER,
      'q',
      {},
      PAID,
    );
    expect(answer.available).toBe(false);
    if (answer.available) throw new Error('unreachable');
    expect(answer.reason).toBe('CUMULATIVE_CAP_REACHED');
    expect(attempted).toEqual([]);
    const account = await budget.getAccount(h.db, 'bac_assistant');
    expect(account?.reserved_minor).toBe(0);
  });

  it('BUDGET-053 paid mode fails closed when budget accounting is unavailable', async () => {
    // No account row exists, so availability cannot be established.
    const attempted: string[] = [];
    const answer = await ask(
      {
        db: h.db,
        port: PORT,
        fetchImpl: catalogueFetch([]),
        apiKey: 'paid-key',
        now: () => NOW,
        requestId: 'req_no_account',
        paidPricing: { inputPricePerMillionMinor: 10, outputPricePerMillionMinor: 10 },
        modelCall: (async (request: ModelRequest) => {
          attempted.push(request.modelId);
          return { ok: true, text: 'x', toolCalls: [], promptTokens: 0, completionTokens: 0 };
        }) as never,
      },
      OWNER,
      'q',
      {},
      PAID,
    );
    expect(answer.available).toBe(false);
    if (answer.available) throw new Error('unreachable');
    expect(answer.reason).toBe('BUDGET_UNAVAILABLE');
    expect(attempted).toEqual([]);
  });

  it('BUDGET-054 a saved configuration never contains a key, in any mode', async () => {
    const saved = await saveAssistantConfig(
      h.db,
      { ...PAID },
      { updatedAt: NOW, updatedBy: 'usr_owner' },
    );
    expect(saved.ok).toBe(true);
    const row = h.raw
      .prepare("SELECT value_json FROM settings WHERE key = 'assistant.config'")
      .get() as { value_json: string };
    // No secret value, and no field that could ever carry one. (`maxOutputTokens` is a
    // count, which is why this asserts on the field set rather than on a word.)
    const stored = JSON.parse(row.value_json) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'budgetAccountId',
      'cumulativeCapMinor',
      'freeModelId',
      'maxOutputTokens',
      'mode',
      'paidModelId',
      'paidProvider',
      'perRequestCapMinor',
      'requestTimeoutMs',
    ]);
    expect(row.value_json).not.toMatch(/sk-|whsec_|Bearer /i);
    expect(stored['mode']).toBe('paid_api');
  });
});
