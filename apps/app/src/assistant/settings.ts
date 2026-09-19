/**
 * Reading and writing the assistant's configuration.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **A missing, corrupt or hostile settings row yields `off`.** Never a paid mode, never
 *     a half-configured one. A configuration the parser does not fully understand is not a
 *     configuration; it is a reason to stay switched off.
 *  2. **No key ever passes through here.** The provider key lives in the Worker secret
 *     store and is read at request time. Nothing in `settings.value_json` is secret, so a
 *     settings export, an audit row or an owner screenshot cannot leak one.
 *  3. **The browser sees `publicAssistantConfig()` and nothing else** — a boolean for
 *     "a key is present", never the key, never a mask of it.
 */
import { settings } from '../db/index.js';
import type { Db } from '../db/d1.js';
import {
  ASSISTANT_LIMITS,
  ASSISTANT_SETTINGS_KEY,
  DEFAULT_ASSISTANT_CONFIG,
  isAssistantMode,
  type AssistantConfig,
  type AssistantMode,
  type PublicAssistantConfig,
} from './types.js';

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > 200 ? null : trimmed;
}

function readMinor(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  // Integer minor units only. A float near a cap is a bug waiting for a rounding error.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function readBounded(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Parse whatever was stored. Total function: it cannot throw and it cannot return a mode
 * the caller did not explicitly store.
 */
export function parseAssistantConfig(raw: unknown): AssistantConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_ASSISTANT_CONFIG;
  }
  const source = raw as Record<string, unknown>;
  const mode: AssistantMode = isAssistantMode(source['mode']) ? source['mode'] : 'off';
  if (mode === 'off') return DEFAULT_ASSISTANT_CONFIG;

  return {
    mode,
    freeModelId: readString(source, 'freeModelId'),
    paidProvider: readString(source, 'paidProvider'),
    paidModelId: readString(source, 'paidModelId'),
    perRequestCapMinor: readMinor(source, 'perRequestCapMinor'),
    cumulativeCapMinor: readMinor(source, 'cumulativeCapMinor'),
    budgetAccountId: readString(source, 'budgetAccountId'),
    maxOutputTokens: readBounded(
      source,
      'maxOutputTokens',
      ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS,
      64,
      ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS,
    ),
    requestTimeoutMs: readBounded(
      source,
      'requestTimeoutMs',
      ASSISTANT_LIMITS.REQUEST_TIMEOUT_MS,
      1_000,
      ASSISTANT_LIMITS.REQUEST_TIMEOUT_MS,
    ),
  };
}

/** Load from D1. A database error is not a reason to turn an assistant on. */
export async function loadAssistantConfig(db: Db): Promise<AssistantConfig> {
  try {
    const stored = await settings.getJson<unknown>(db, ASSISTANT_SETTINGS_KEY, null);
    return parseAssistantConfig(stored);
  } catch {
    return DEFAULT_ASSISTANT_CONFIG;
  }
}

/**
 * Persist. The caller has already proved platform ownership and recent strong auth
 * (T-OWN-04) — this function does not and must not be the access check.
 *
 * `paid_api` is refused unless it is complete: a named provider, a named model, a
 * non-zero per-request cap, a non-zero cumulative cap and a budget account. A partially
 * configured paid mode would fail open at the moment money is at stake.
 */
export function validateAssistantConfig(
  candidate: AssistantConfig,
): { ok: true } | { ok: false; problems: readonly string[] } {
  const problems: string[] = [];
  if (candidate.mode === 'openrouter_free' && candidate.freeModelId === null) {
    problems.push('openrouter_free needs a model id chosen from the live free catalogue');
  }
  if (candidate.mode === 'paid_api') {
    if (candidate.paidProvider === null) problems.push('paid_api needs a named provider');
    if (candidate.paidModelId === null) problems.push('paid_api needs a named model');
    if (candidate.perRequestCapMinor <= 0) problems.push('paid_api needs a per-request cap');
    if (candidate.cumulativeCapMinor <= 0) problems.push('paid_api needs a cumulative cap');
    if (candidate.budgetAccountId === null) problems.push('paid_api needs a budget account');
    if (candidate.perRequestCapMinor > candidate.cumulativeCapMinor) {
      problems.push('the per-request cap cannot exceed the cumulative cap');
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export async function saveAssistantConfig(
  db: Db,
  candidate: AssistantConfig,
  meta: { readonly updatedAt: string; readonly updatedBy: string },
): Promise<{ ok: true } | { ok: false; problems: readonly string[] }> {
  const validation = validateAssistantConfig(candidate);
  if (!validation.ok) return validation;
  // Explicit field list, so a future field on `AssistantConfig` cannot be persisted by
  // accident — including one that ever held a secret.
  const stored = {
    mode: candidate.mode,
    freeModelId: candidate.freeModelId,
    paidProvider: candidate.paidProvider,
    paidModelId: candidate.paidModelId,
    perRequestCapMinor: candidate.perRequestCapMinor,
    cumulativeCapMinor: candidate.cumulativeCapMinor,
    budgetAccountId: candidate.budgetAccountId,
    maxOutputTokens: candidate.maxOutputTokens,
    requestTimeoutMs: candidate.requestTimeoutMs,
  };
  await settings.set(db, {
    key: ASSISTANT_SETTINGS_KEY,
    valueJson: JSON.stringify(stored),
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
  });
  return { ok: true };
}

/**
 * The only shape that may cross the wire to a browser.
 *
 * `apiKeyPresent` is computed from the secret binding by the caller and passed in — this
 * function never touches the key itself, so there is no code path here that could
 * serialise one.
 */
export function publicAssistantConfig(
  config: AssistantConfig,
  apiKeyPresent: boolean,
): PublicAssistantConfig {
  return {
    mode: config.mode,
    model_id: config.mode === 'paid_api' ? config.paidModelId : config.freeModelId,
    provider:
      config.mode === 'paid_api'
        ? config.paidProvider
        : config.mode === 'openrouter_free'
          ? 'openrouter'
          : null,
    api_key_present: apiKeyPresent === true,
    per_request_cap_minor: config.perRequestCapMinor,
    cumulative_cap_minor: config.cumulativeCapMinor,
  };
}
