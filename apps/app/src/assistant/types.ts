/**
 * The optional assistant — shared types and bounds.
 *
 * The governing rule, from `docs/agent-brief.md` §9 and `docs/threat-model.md` T-AI-01:
 * **the product must work completely with no model API configured.** `off` is the shipped
 * default, every owner control and every customer operation works in that mode, and
 * nothing in this directory is on the request path of verification, billing, support or
 * notifications.
 *
 * A model never writes. It reads aggregates and it *proposes*. A proposal is re-derived
 * and re-priced by server code, hashed from the server's own payload, and executed only
 * after a human confirms.
 */

export const ASSISTANT_MODES = ['off', 'openrouter_free', 'paid_api'] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

/** The `settings` row this module reads. Absent row means `off`. */
export const ASSISTANT_SETTINGS_KEY = 'assistant.config';

/**
 * Hard bounds. Every one of these is enforced in code, not merely documented — an
 * unbounded conversation history is a cost bug and a context-poisoning surface at once.
 */
export const ASSISTANT_LIMITS = {
  /** Messages kept from the conversation, most recent first. Older turns are dropped. */
  MAX_HISTORY_MESSAGES: 12,
  /** Per-message character cap applied to history and to the current question. */
  MAX_MESSAGE_CHARS: 4_000,
  /** A tool result is truncated before it is handed back to the model. */
  MAX_TOOL_RESULT_CHARS: 4_000,
  /** An untrusted data section is truncated before it is delimited. */
  MAX_UNTRUSTED_CHARS: 2_000,
  /** Model output cap. Also the basis of the paid-mode cost estimate. */
  MAX_OUTPUT_TOKENS: 1_024,
  /** Wall-clock cap on one model request. */
  REQUEST_TIMEOUT_MS: 20_000,
  /** How long a fetched catalogue snapshot may be reused before revalidation. */
  CATALOGUE_TTL_MS: 10 * 60 * 1_000,
  /** Tool-call rounds per turn. Two is enough for read-then-answer; it is not an agent. */
  MAX_TOOL_ROUNDS: 2,
  /** Tool calls executed per turn, across all rounds. */
  MAX_TOOL_CALLS: 4,
} as const;

/**
 * Stored assistant configuration.
 *
 * There is deliberately **no key field**. A provider key lives in the Worker's secret
 * store (`ASSISTANT_API_KEY`), is read at request time, and is never written into
 * `settings`, never logged and never returned to a browser. `apiKeyPresent` is derived at
 * runtime and is the only thing the UI ever learns about it.
 */
export interface AssistantConfig {
  readonly mode: AssistantMode;
  /** `openrouter_free`: the chosen catalogue entry id, verbatim. Never suffixed by us. */
  readonly freeModelId: string | null;
  /** `paid_api`: an explicitly named provider and model. No defaults, no inference. */
  readonly paidProvider: string | null;
  readonly paidModelId: string | null;
  /** Per-request ceiling, integer minor units. A request estimated above this is refused. */
  readonly perRequestCapMinor: number;
  /** Cumulative ceiling across the account's whole life, integer minor units. */
  readonly cumulativeCapMinor: number;
  /** A02's budget account this assistant draws on. `null` means paid mode cannot run. */
  readonly budgetAccountId: string | null;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
}

/** The default. Nothing is on, nothing is configured, and everything else still works. */
export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  mode: 'off',
  freeModelId: null,
  paidProvider: null,
  paidModelId: null,
  perRequestCapMinor: 0,
  cumulativeCapMinor: 0,
  budgetAccountId: null,
  maxOutputTokens: ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS,
  requestTimeoutMs: ASSISTANT_LIMITS.REQUEST_TIMEOUT_MS,
};

/** What the browser is allowed to see. No key, not even a masked one. */
export interface PublicAssistantConfig {
  readonly mode: AssistantMode;
  readonly model_id: string | null;
  readonly provider: string | null;
  readonly api_key_present: boolean;
  readonly per_request_cap_minor: number;
  readonly cumulative_cap_minor: number;
}

/** Who is asking. Resolved server-side from the session, never from the request body. */
export interface AssistantActor {
  readonly userId: string;
  readonly workspaceId: string | null;
  readonly isPlatformOwner: boolean;
}

/**
 * Why an assistant turn could not run. Every one of these is an honest, user-facing
 * unavailability — none of them is ever replaced by an invented answer, and none of them
 * causes a paid call in a free-mode configuration.
 */
export type AssistantUnavailableReason =
  | 'ASSISTANT_OFF'
  | 'NOT_CONFIGURED'
  | 'FREE_PRICING_UNKNOWN'
  | 'FREE_MODEL_NOT_FREE'
  | 'FREE_MODEL_UNAVAILABLE'
  | 'PER_REQUEST_CAP_EXCEEDED'
  | 'CUMULATIVE_CAP_REACHED'
  | 'BUDGET_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR';

export interface AssistantUnavailable {
  readonly available: false;
  readonly reason: AssistantUnavailableReason;
  /** Plain language for the owner. Never a fabricated answer to their question. */
  readonly message: string;
}

export interface AssistantAnswer {
  readonly available: true;
  readonly text: string;
  readonly mode: AssistantMode;
  readonly model_id: string;
  /** Tools that actually ran, in order. */
  readonly tools_used: readonly string[];
  /** Tool calls the server refused, with the reason. Surfaced, never swallowed. */
  readonly refused_tool_calls: readonly RefusedToolCall[];
  /** Proposals produced this turn. Each needs a human confirmation to do anything. */
  readonly proposals: readonly Proposal[];
  /** Paid mode only. `null` in every other mode. */
  readonly cost_minor: number | null;
}

export type AssistantResult = AssistantAnswer | AssistantUnavailable;

export interface RefusedToolCall {
  readonly name: string;
  readonly reason:
    | 'UNKNOWN_TOOL'
    | 'INVALID_ARGUMENTS'
    | 'NOT_PERMITTED'
    | 'PROPOSALS_DISABLED_UNTRUSTED_CONTEXT'
    | 'TOOL_BUDGET_EXHAUSTED';
  readonly detail: string;
}

/**
 * A proposal. Note what is *not* here: nothing the model wrote.
 *
 * `payload` is re-derived by server code from validated arguments and from the server's
 * own reading of the database. `canonical_payload_hash` is a SHA-256 over
 * `stableStringify(payload)` — the server's view — which is the same binding
 * `approvals.canonical_payload_hash` uses. `summary` is composed from the payload by a
 * template in `tools.ts`; it is not model prose.
 */
export interface Proposal {
  readonly proposal_id: string;
  readonly action_type: string;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly canonical_payload_hash: string;
  readonly requires_approval: true;
  readonly status: 'proposed';
  readonly created_at: string;
}

/** A section of context handed to the model, with its provenance recorded. */
export interface ContextSection {
  readonly label: string;
  /**
   * `trusted` is text this system composed. `untrusted` is anything that passed through a
   * customer, a provider, a support ticket or a retrieved document. The distinction is
   * structural: an untrusted section disables every proposal tool for that turn.
   */
  readonly trust: 'trusted' | 'untrusted';
  readonly text: string;
}

export interface AssistantMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ModelOutcome =
  | {
      readonly ok: true;
      readonly text: string;
      readonly toolCalls: readonly ModelToolCall[];
      readonly promptTokens: number;
      readonly completionTokens: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR';
      /** Operator-facing. Treated as untrusted data if it is ever shown to a model. */
      readonly detail: string;
    };

/** Everything a model request needs. Assembled by the server; never by the model. */
export interface ModelRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly messages: readonly AssistantMessage[];
  readonly tools: readonly ToolSchema[];
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

/** The JSON-schema fragment a tool advertises to a model. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export function isAssistantMode(value: unknown): value is AssistantMode {
  return typeof value === 'string' && (ASSISTANT_MODES as readonly string[]).includes(value);
}
