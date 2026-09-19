/**
 * The model transport.
 *
 * Small on purpose. Its entire job is: send exactly what the server assembled, wait no
 * longer than the configured timeout, and return either a parsed answer or a typed
 * failure. It has three prohibitions:
 *
 *  - **It never invents an answer.** A provider error becomes `ok: false` with a reason.
 *    Nothing in this file can produce text that did not come from the provider.
 *  - **It never retries into a different model or a different tier.** A free-mode outage
 *    is an outage. There is no parameter here that could express "fall back to the paid
 *    one", which is why `BUDGET-027` can assert it structurally.
 *  - **It never logs or returns the key.** The key is a field of the request and is used
 *    once, in a header.
 *
 * The request shape is OpenAI-compatible `POST /chat/completions`, which is what
 * OpenRouter serves at `https://openrouter.ai/api/v1` (confirmed 2026-09-19 against
 * https://openrouter.ai/docs/api-reference/overview: "Completions Request Format — details
 * the POST request schema to `/api/v1/chat/completions`").
 */
import type { ModelOutcome, ModelRequest, ModelToolCall } from './types.js';

export type FetchLike = typeof fetch;

interface ChoiceMessage {
  readonly content?: unknown;
  readonly tool_calls?: unknown;
}

function readToolCalls(raw: unknown): ModelToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelToolCall[] = [];
  for (const item of raw.slice(0, 8)) {
    if (item === null || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    const fn = call['function'];
    if (fn === null || typeof fn !== 'object') continue;
    const fnRecord = fn as Record<string, unknown>;
    const name = fnRecord['name'];
    if (typeof name !== 'string') continue;
    let parsedArguments: unknown = {};
    const rawArguments = fnRecord['arguments'];
    if (typeof rawArguments === 'string') {
      try {
        parsedArguments = JSON.parse(rawArguments);
      } catch {
        // Unparseable arguments are handed on as-is; the validator refuses them, which is
        // a refusal we want visible rather than a silent drop.
        parsedArguments = { __unparseable: true };
      }
    } else if (rawArguments !== null && typeof rawArguments === 'object') {
      parsedArguments = rawArguments;
    }
    out.push({
      id: typeof call['id'] === 'string' ? call['id'] : name,
      name,
      arguments: parsedArguments,
    });
  }
  return out;
}

function readUsage(raw: unknown): { prompt: number; completion: number } {
  if (raw === null || typeof raw !== 'object') return { prompt: 0, completion: 0 };
  const usage = raw as Record<string, unknown>;
  const prompt = usage['prompt_tokens'];
  const completion = usage['completion_tokens'];
  return {
    prompt: typeof prompt === 'number' && Number.isFinite(prompt) ? Math.trunc(prompt) : 0,
    completion:
      typeof completion === 'number' && Number.isFinite(completion) ? Math.trunc(completion) : 0,
  };
}

/**
 * One request. One model. One outcome.
 *
 * `fetchImpl` is injected so tests never touch the network — the global fetch guard in
 * `tests/setup.ts` would fail the run if they did, which is the point.
 */
export async function callModel(
  request: ModelRequest,
  fetchImpl: FetchLike,
): Promise<ModelOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  const body = {
    model: request.modelId,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_tokens: request.maxOutputTokens,
    // Tool definitions are the server's, verbatim from `TOOL_SCHEMAS`.
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
  };

  try {
    const response = await fetchImpl(`${request.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });

    if (response.status === 429 || response.status >= 500) {
      return {
        ok: false,
        reason: 'PROVIDER_UNAVAILABLE',
        detail: `provider responded ${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'PROVIDER_ERROR',
        detail: `provider responded ${response.status}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, reason: 'PROVIDER_ERROR', detail: 'provider body was not JSON' };
    }

    const choices = (parsed as Record<string, unknown>)['choices'];
    const first = Array.isArray(choices) ? choices[0] : undefined;
    if (first === null || typeof first !== 'object') {
      return { ok: false, reason: 'PROVIDER_ERROR', detail: 'provider returned no choices' };
    }
    const message = (first as Record<string, unknown>)['message'] as ChoiceMessage | undefined;
    const content = message?.content;
    const usage = readUsage((parsed as Record<string, unknown>)['usage']);

    return {
      ok: true,
      text: typeof content === 'string' ? content : '',
      toolCalls: readToolCalls(message?.tool_calls),
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      detail: error instanceof Error ? error.name : 'unknown transport failure',
    };
  } finally {
    clearTimeout(timer);
  }
}
