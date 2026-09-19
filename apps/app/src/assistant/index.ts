/**
 * The optional assistant.
 *
 * `off` is the default and the shipped configuration. Nothing in this directory is on the
 * request path of verification, billing, notifications, support or any owner control, and
 * `tests/unit/assistant/off-mode.test.ts` proves it by running the owner-facing surface
 * with no key, no catalogue and no model and asserting that nothing degrades.
 *
 * The assistant reads aggregates and proposes. Server code authorises.
 */
export {
  ASSISTANT_LIMITS,
  ASSISTANT_MODES,
  ASSISTANT_SETTINGS_KEY,
  DEFAULT_ASSISTANT_CONFIG,
  isAssistantMode,
  type AssistantActor,
  type AssistantAnswer,
  type AssistantConfig,
  type AssistantMessage,
  type AssistantMode,
  type AssistantResult,
  type AssistantUnavailable,
  type AssistantUnavailableReason,
  type ContextSection,
  type ModelOutcome,
  type ModelRequest,
  type ModelToolCall,
  type Proposal,
  type PublicAssistantConfig,
  type RefusedToolCall,
  type ToolSchema,
} from './types.js';

export {
  loadAssistantConfig,
  parseAssistantConfig,
  publicAssistantConfig,
  saveAssistantConfig,
  validateAssistantConfig,
} from './settings.js';

export {
  CatalogueCache,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODELS_PATH,
  fetchCatalogue,
  isDefinitelyFree,
  parseCatalogue,
  selectFreeModel,
  type CatalogueEntry,
  type CatalogueOutcome,
  type CatalogueSnapshot,
  type FreeModelDecision,
} from './catalogue.js';

export {
  SYSTEM_PROMPT,
  buildMessages,
  fenceUntrusted,
  neutraliseUntrusted,
  stripControlCharacters,
  systemMessageOf,
  truncate,
  type BuiltContext,
} from './prompt.js';

export {
  PROPOSAL_TOOLS,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  dispatchToolCall,
  encodeToolResult,
  validateToolArguments,
  type ToolContext,
  type ToolName,
  type ToolOutcome,
} from './tools.js';

export {
  capDecision,
  estimateRequestCostMinor,
  reconcileAfterCall,
  releaseReservation,
  reserveForCall,
  type BudgetRefusal,
  type ReservationOutcome,
} from './budget.js';

export { callModel, type FetchLike } from './client.js';

export {
  D1AssistantDataPort,
  type AssistantDataPort,
  type AssistantIncident,
  type AssistantRunExplanation,
  type AssistantSummary,
  type CampaignFacts,
} from './port.js';

export { ask, type AskOptions, type AssistantDeps, type PaidPricing } from './service.js';
