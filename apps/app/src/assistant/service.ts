/**
 * The assistant turn.
 *
 * Read the first branch before anything else: **when the mode is `off`, this function
 * returns before it has touched the network, the catalogue, the budget, a tool or a
 * model.** That is the shipped default, and every owner control, support path and customer
 * operation is expected to work with exactly this return value and nothing else.
 *
 * The rest of the function is the convenience layer. It is arranged so every unhappy path
 * ends in an honest `AssistantUnavailable` and never in an invented answer:
 *
 *   off                    -> ASSISTANT_OFF
 *   no key                 -> NOT_CONFIGURED
 *   free, pricing unknown  -> FREE_PRICING_UNKNOWN   (never a paid call)
 *   free, no longer free   -> FREE_MODEL_NOT_FREE    (never a paid call)
 *   paid, over a cap       -> PER_REQUEST_CAP_EXCEEDED / CUMULATIVE_CAP_REACHED
 *   paid, no accounting    -> BUDGET_UNAVAILABLE
 *   provider failed        -> PROVIDER_* , and the reservation is released
 */
import { CatalogueCache, OPENROUTER_BASE_URL, selectFreeModel } from './catalogue.js';
import { callModel, type FetchLike } from './client.js';
import {
  estimateRequestCostMinor,
  reconcileAfterCall,
  releaseReservation,
  reserveForCall,
  type ReservationOutcome,
} from './budget.js';
import { buildMessages, fenceUntrusted } from './prompt.js';
import { loadAssistantConfig } from './settings.js';
import { dispatchToolCall, PROPOSAL_TOOLS, TOOL_SCHEMAS } from './tools.js';
import type { AssistantDataPort } from './port.js';
import type { Db } from '../db/d1.js';
import {
  ASSISTANT_LIMITS,
  type AssistantActor,
  type AssistantConfig,
  type AssistantMessage,
  type AssistantResult,
  type ContextSection,
  type Proposal,
  type RefusedToolCall,
} from './types.js';

/** Owner-supplied unit prices for the named paid model. Never inferred, never from a model. */
export interface PaidPricing {
  readonly inputPricePerMillionMinor: number;
  readonly outputPricePerMillionMinor: number;
}

export interface AssistantDeps {
  readonly db: Db;
  readonly port: AssistantDataPort;
  readonly fetchImpl: FetchLike;
  /** Read from the Worker secret store at request time. Never persisted, never returned. */
  readonly apiKey: string | null;
  readonly now: () => string;
  readonly requestId: string;
  readonly catalogue?: CatalogueCache;
  readonly baseUrl?: string;
  readonly paidBaseUrl?: string;
  readonly paidPricing?: PaidPricing;
  /** Injected only by tests; production always uses `callModel`. */
  readonly modelCall?: typeof callModel;
}

export interface AskOptions {
  readonly history?: readonly AssistantMessage[];
  readonly sections?: readonly ContextSection[];
}

const OFF_MESSAGE =
  'The assistant is switched off. Every part of this service works without it: verification, billing, notifications, support and every owner control.';

function unavailable(
  reason: Exclude<AssistantResult, { available: true }>['reason'],
  message: string,
): AssistantResult {
  return { available: false, reason, message };
}

/**
 * Run one turn.
 *
 * `config` may be passed in by a caller that already read it (an owner screen rendering
 * both the assistant and its settings); otherwise it is loaded here. Either way the `off`
 * check happens before anything else.
 */
export async function ask(
  deps: AssistantDeps,
  actor: AssistantActor,
  question: string,
  options: AskOptions = {},
  preloadedConfig?: AssistantConfig,
): Promise<AssistantResult> {
  const config = preloadedConfig ?? (await loadAssistantConfig(deps.db));

  // ---- The default path. Nothing below this line runs in a shipped installation. ----
  if (config.mode === 'off') return unavailable('ASSISTANT_OFF', OFF_MESSAGE);

  if (deps.apiKey === null || deps.apiKey.length === 0) {
    return unavailable(
      'NOT_CONFIGURED',
      'No model key is configured, so the assistant cannot answer. Nothing else is affected.',
    );
  }

  const now = deps.now();
  let modelId: string;
  let baseUrl: string;
  let reservation: Extract<ReservationOutcome, { ok: true }> | null = null;

  if (config.mode === 'openrouter_free') {
    // Revalidate before every turn. A cached belief about someone else's pricing is not
    // evidence, and the cache deliberately drops itself when revalidation fails.
    const cache = deps.catalogue ?? new CatalogueCache();
    const outcome = await cache.revalidate({
      apiKey: deps.apiKey,
      fetchImpl: deps.fetchImpl,
      now,
      ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
    });
    const decision = selectFreeModel(outcome, config.freeModelId);
    if (!decision.eligible) {
      // No paid fallback exists in this branch. There is nowhere for control to go except
      // out of the function with an honest reason.
      if (decision.reason === 'PRICING_UNKNOWN') {
        return unavailable(
          'FREE_PRICING_UNKNOWN',
          `The assistant is set to free models only, and the live price list could not be confirmed (${decision.detail}). It will not make a paid call, so it is unavailable until the catalogue is readable again.`,
        );
      }
      if (decision.reason === 'NOT_IN_CATALOGUE') {
        return unavailable(
          'FREE_MODEL_UNAVAILABLE',
          'No free model has been chosen. Pick one from the live catalogue in settings.',
        );
      }
      return unavailable(
        'FREE_MODEL_NOT_FREE',
        `${decision.detail}. The assistant will not switch to a paid model on its own, so it is unavailable until a free model is chosen.`,
      );
    }
    modelId = decision.entry.id;
    baseUrl = deps.baseUrl ?? OPENROUTER_BASE_URL;
  } else {
    if (config.paidModelId === null || deps.paidPricing === undefined) {
      return unavailable(
        'NOT_CONFIGURED',
        'Paid mode needs a named model and its unit prices before it can run.',
      );
    }
    modelId = config.paidModelId;
    baseUrl = deps.paidBaseUrl ?? deps.baseUrl ?? OPENROUTER_BASE_URL;
  }

  const context = buildMessages({
    history: options.history ?? [],
    question,
    sections: options.sections ?? [],
  });

  // ---- Paid mode: cap, then reserve, before a single byte leaves. ----
  if (config.mode === 'paid_api') {
    const pricing = deps.paidPricing as PaidPricing;
    const promptTokenEstimate = Math.ceil(
      context.messages.reduce((total, message) => total + message.content.length, 0) / 4,
    );
    const estimate = estimateRequestCostMinor({
      promptTokens: promptTokenEstimate,
      maxOutputTokens: config.maxOutputTokens,
      inputPricePerMillionMinor: pricing.inputPricePerMillionMinor,
      outputPricePerMillionMinor: pricing.outputPricePerMillionMinor,
    });
    const reserved = await reserveForCall({
      db: deps.db,
      config,
      estimateMinor: estimate,
      requestId: deps.requestId,
      now,
    });
    if (!reserved.ok) {
      return unavailable(
        reserved.reason === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : reserved.reason,
        reserved.detail,
      );
    }
    reservation = reserved;
  }

  const messages: AssistantMessage[] = [...context.messages];
  // Starts from the sections the caller supplied and only ever moves to `false`. A read
  // tool's result is text that passed through a customer's workflow definition or a
  // provider's error channel, so the moment one is fed back to the model this turn has
  // read untrusted text and — per the documented rule — cannot produce a proposal. The
  // flag is per turn: the next question starts clean.
  let proposalsAllowed = context.proposalsAllowed;
  const toolsUsed: string[] = [];
  const refusals: RefusedToolCall[] = [];
  const proposals: Proposal[] = [];
  let answerText = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCallBudget = ASSISTANT_LIMITS.MAX_TOOL_CALLS;

  const call = deps.modelCall ?? callModel;

  for (let round = 0; round < ASSISTANT_LIMITS.MAX_TOOL_ROUNDS; round += 1) {
    const outcome = await call(
      {
        baseUrl,
        apiKey: deps.apiKey,
        modelId,
        // A snapshot, not the live array. The loop appends tool results to `messages`
        // afterwards, and a request that mutated under the transport would make what was
        // actually sent unknowable — to a reviewer and to a test alike.
        messages: [...messages],
        tools: TOOL_SCHEMAS,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.requestTimeoutMs,
      },
      deps.fetchImpl,
    );

    if (!outcome.ok) {
      // The provider failed. Hand the money back and say what happened; never answer.
      if (reservation !== null) {
        await releaseReservation({
          db: deps.db,
          reservation,
          requestId: deps.requestId,
          now: deps.now(),
        });
      }
      return unavailable(
        outcome.reason === 'PROVIDER_TIMEOUT'
          ? 'PROVIDER_TIMEOUT'
          : outcome.reason === 'PROVIDER_UNAVAILABLE'
            ? 'PROVIDER_UNAVAILABLE'
            : 'PROVIDER_ERROR',
        `The model provider did not answer (${outcome.detail}). No answer has been invented and nothing has changed.`,
      );
    }

    promptTokens += outcome.promptTokens;
    completionTokens += outcome.completionTokens;
    answerText = outcome.text;

    if (outcome.toolCalls.length === 0) break;

    for (const toolCall of outcome.toolCalls) {
      if (toolCallBudget <= 0) {
        refusals.push({
          name: toolCall.name,
          reason: 'TOOL_BUDGET_EXHAUSTED',
          detail: 'this turn has already used its tool-call allowance',
        });
        continue;
      }
      toolCallBudget -= 1;
      const result = await dispatchToolCall(
        {
          db: deps.db,
          port: deps.port,
          actor,
          now: deps.now(),
          proposalsAllowed,
        },
        toolCall,
      );
      if (result.ok) {
        toolsUsed.push(toolCall.name);
        if (result.proposal !== null) proposals.push(result.proposal);
        if (PROPOSAL_TOOLS.has(toolCall.name)) {
          // A proposal echo is text this server composed from validated arguments.
          messages.push({
            role: 'user',
            content: `[tool result: ${toolCall.name}]\n${result.result}`,
          });
        } else {
          // A read result carries `reason_code`, `redacted_summary` and assertion labels —
          // strings that originated with a provider or a customer. It goes back to the
          // model the same way a support ticket would: fenced, neutralised, and with the
          // turn marked as having read untrusted text. `encodeToolResult` already capped
          // it at 4,000 characters; the cap is passed through rather than halved again.
          proposalsAllowed = false;
          messages.push({
            role: 'user',
            content: `[tool result: ${toolCall.name}]\n${fenceUntrusted(
              `tool_result_${toolCall.name}`,
              result.result,
              ASSISTANT_LIMITS.MAX_TOOL_RESULT_CHARS,
            )}`,
          });
        }
      } else {
        refusals.push(result.refusal);
        messages.push({
          role: 'user',
          content: `[tool refused: ${toolCall.name}] ${result.refusal.reason}`,
        });
      }
    }
  }

  let costMinor: number | null = null;
  if (reservation !== null) {
    const pricing = deps.paidPricing as PaidPricing;
    const actual = estimateRequestCostMinor({
      promptTokens,
      maxOutputTokens: completionTokens,
      inputPricePerMillionMinor: pricing.inputPricePerMillionMinor,
      outputPricePerMillionMinor: pricing.outputPricePerMillionMinor,
    });
    const reconciled = await reconcileAfterCall({
      db: deps.db,
      reservation,
      actualMinor: actual,
      requestId: deps.requestId,
      now: deps.now(),
    });
    costMinor = reconciled.settledMinor;
  }

  return {
    available: true,
    text: answerText,
    mode: config.mode,
    model_id: modelId,
    tools_used: toolsUsed,
    refused_tool_calls: refusals,
    proposals,
    cost_minor: costMinor,
  };
}
