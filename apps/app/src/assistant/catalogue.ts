/**
 * The OpenRouter free-model catalogue.
 *
 * WHAT WAS CONFIRMED, AND WHERE
 * -----------------------------
 * Checked 2026-09-19 against OpenRouter's own documentation:
 *
 *  - `GET https://openrouter.ai/api/v1/models`, base URL `https://openrouter.ai/api/v1`
 *    (https://openrouter.ai/docs/api-reference/overview,
 *     https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
 *  - The response envelope puts the array under a `data` key, alongside `total_count` and
 *    `links` (same page).
 *  - Each model object carries `id`, `canonical_slug`, `name`, `created`, `pricing`,
 *    `context_length`, `architecture`, `top_provider`, `supported_parameters`,
 *    `description` (same page).
 *  - `pricing` holds `prompt`, `completion`, `request`, `image`, `web_search`,
 *    `internal_reasoning`, `input_cache_read`, `input_cache_write` and `overrides`.
 *    **Every value is a string.** The docs state: *"All pricing values are in USD per
 *    token/request/unit. A value of `"0"` indicates the feature is free."*
 *    (https://openrouter.ai/docs/guides/overview/models).
 *  - On id suffixes the docs say: *"Catalog variants such as `:free` return that variant's
 *    own entry"*, while routing variants such as `:nitro` resolve to the base model.
 *    So `:free` is a **catalogue entry that either exists or does not** — which is exactly
 *    why this module never appends `:free` to a model name. It reads what the catalogue
 *    actually returns and filters on the price it actually reports.
 *  - Listing requires an `Authorization: Bearer <key>` header.
 *
 * THE RULE THIS MODULE ENFORCES
 * -----------------------------
 * A model is eligible in `openrouter_free` **only** when its input and output prices are
 * both present, both parse as finite numbers, and both are exactly zero — and any
 * per-request charge is zero too. Anything else, including a missing field, an
 * unparseable field or a catalogue we could not reach, means *ineligible*. There is no
 * silent fallback to a paid model and no assumption that a name containing "free" is free.
 *
 * Nothing here ever calls the network on its own: the caller injects `fetchImpl`, which is
 * how the test suite proves the behaviour without a key and without spending anything.
 */
import { ASSISTANT_LIMITS } from './types.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_MODELS_PATH = '/models';

/** The subset of a catalogue entry this product reads. */
export interface CatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
  /** The raw pricing map, strings as the provider sent them. Kept for the audit trail. */
  readonly pricing: Readonly<Record<string, string>>;
}

export interface CatalogueSnapshot {
  /** ISO-8601 UTC. The recorded fetch time, used for staleness and for the owner screen. */
  readonly fetchedAt: string;
  /** Only entries proved free by `isDefinitelyFree`. */
  readonly freeModels: readonly CatalogueEntry[];
  /** How many entries the catalogue returned in total, free or not. */
  readonly totalEntries: number;
}

export type CatalogueOutcome =
  | { readonly ok: true; readonly snapshot: CatalogueSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'UNREACHABLE' | 'BAD_STATUS' | 'MALFORMED' | 'NO_KEY';
      readonly detail: string;
    };

/**
 * The price fields that must be zero for a model to count as free.
 *
 * `prompt` is input, `completion` is output — the two the brief names. `request` is a flat
 * per-call charge and is included because a model with free tokens and a paid request is
 * not a free model.
 */
const MUST_BE_ZERO = ['prompt', 'completion', 'request'] as const;

/**
 * True only when every price that must be zero is *demonstrably* zero.
 *
 * `prompt` and `completion` must be present. `request` is optional in the sense that older
 * entries may omit it — but if present it must parse and be zero. An unparseable value is
 * never treated as zero.
 */
export function isDefinitelyFree(pricing: unknown): boolean {
  if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) return false;
  const source = pricing as Record<string, unknown>;

  for (const field of MUST_BE_ZERO) {
    const raw = source[field];
    if (raw === undefined || raw === null) {
      // Input and output prices are mandatory. A catalogue entry without them tells us
      // nothing, and "nothing" is not "free".
      if (field === 'request') continue;
      return false;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return false;
    const text = String(raw).trim();
    if (text.length === 0) return false;
    const value = Number(text);
    if (!Number.isFinite(value) || value !== 0) return false;
  }
  return true;
}

function readPricing(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = String(raw);
  }
  return out;
}

/** Parse the documented envelope. Anything that is not the documented shape is MALFORMED. */
export function parseCatalogue(body: unknown, fetchedAt: string): CatalogueOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'MALFORMED', detail: 'response was not a JSON object' };
  }
  const data = (body as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) {
    return { ok: false, reason: 'MALFORMED', detail: 'response had no `data` array' };
  }

  const freeModels: CatalogueEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) continue;
    if (!isDefinitelyFree(entry['pricing'])) continue;
    const name = entry['name'];
    const contextLength = entry['context_length'];
    freeModels.push({
      id,
      name: typeof name === 'string' ? name.slice(0, 200) : id,
      contextLength:
        typeof contextLength === 'number' && Number.isSafeInteger(contextLength)
          ? contextLength
          : null,
      pricing: readPricing(entry['pricing']),
    });
  }

  return {
    ok: true,
    snapshot: { fetchedAt, freeModels, totalEntries: data.length },
  };
}

export interface FetchCatalogueOptions {
  readonly apiKey: string | null;
  readonly fetchImpl: typeof fetch;
  readonly now: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Fetch and filter the live catalogue.
 *
 * Note the failure discipline: every failure is a distinct, reported reason. None of them
 * returns a stale-but-plausible list, and none of them returns an empty list that a caller
 * might mistake for "the catalogue says there are no free models".
 */
export async function fetchCatalogue(options: FetchCatalogueOptions): Promise<CatalogueOutcome> {
  if (options.apiKey === null || options.apiKey.length === 0) {
    return {
      ok: false,
      reason: 'NO_KEY',
      detail: 'listing the catalogue requires an OpenRouter key; none is configured',
    };
  }

  const url = `${options.baseUrl ?? OPENROUTER_BASE_URL}${OPENROUTER_MODELS_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? ASSISTANT_LIMITS.REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await options.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      return { ok: false, reason: 'BAD_STATUS', detail: `catalogue responded ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'MALFORMED', detail: 'catalogue body was not JSON' };
    }
    return parseCatalogue(body, options.now);
  } catch (error) {
    const detail = error instanceof Error ? error.name : 'unknown error';
    return { ok: false, reason: 'UNREACHABLE', detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short-lived in-memory cache with a recorded fetch time.
 *
 * Deliberately not durable: a cached price is a claim about someone else's billing, and it
 * should not survive a deployment. `staleAt` is how the owner screen can say exactly how
 * old the pricing it is showing is.
 */
export class CatalogueCache {
  #snapshot: CatalogueSnapshot | null = null;

  constructor(private readonly ttlMs: number = ASSISTANT_LIMITS.CATALOGUE_TTL_MS) {}

  get snapshot(): CatalogueSnapshot | null {
    return this.#snapshot;
  }

  put(snapshot: CatalogueSnapshot): void {
    this.#snapshot = snapshot;
  }

  clear(): void {
    this.#snapshot = null;
  }

  isFresh(nowIso: string): boolean {
    if (this.#snapshot === null) return false;
    const fetched = Date.parse(this.#snapshot.fetchedAt);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(fetched) || !Number.isFinite(now)) return false;
    return now >= fetched && now - fetched < this.ttlMs;
  }

  /** Reuse a fresh snapshot; otherwise fetch a new one and record when it arrived. */
  async revalidate(options: FetchCatalogueOptions): Promise<CatalogueOutcome> {
    const cached = this.#snapshot;
    if (cached !== null && this.isFresh(options.now)) return { ok: true, snapshot: cached };
    const outcome = await fetchCatalogue(options);
    if (outcome.ok) this.#snapshot = outcome.snapshot;
    // A failed revalidation deliberately does NOT fall back to the stale snapshot. Pricing
    // we cannot confirm right now is pricing we do not know, and "unknown" stops free mode.
    else this.#snapshot = null;
    return outcome;
  }
}

export type FreeModelDecision =
  | { readonly eligible: true; readonly entry: CatalogueEntry; readonly verifiedAt: string }
  | {
      readonly eligible: false;
      readonly reason: 'PRICING_UNKNOWN' | 'NOT_FREE' | 'NOT_IN_CATALOGUE';
      readonly detail: string;
    };

/**
 * The gate every free-mode request passes through, immediately before the call.
 *
 * `catalogue` is the outcome of a revalidation, not a cached belief. If the revalidation
 * failed for any reason at all, the answer is `PRICING_UNKNOWN` — and the caller's only
 * legal response to that is an honest "unavailable", never a paid call.
 */
export function selectFreeModel(
  catalogue: CatalogueOutcome,
  requestedModelId: string | null,
): FreeModelDecision {
  if (!catalogue.ok) {
    return {
      eligible: false,
      reason: 'PRICING_UNKNOWN',
      detail: `could not confirm pricing (${catalogue.reason}: ${catalogue.detail})`,
    };
  }
  if (requestedModelId === null) {
    return { eligible: false, reason: 'NOT_IN_CATALOGUE', detail: 'no free model is chosen' };
  }
  const entry = catalogue.snapshot.freeModels.find((model) => model.id === requestedModelId);
  if (entry === undefined) {
    // Either the id is not in the catalogue at all, or it is there and is no longer free.
    // Both are refusals; we distinguish them only so the owner gets an accurate message.
    return {
      eligible: false,
      reason: 'NOT_FREE',
      detail: `${requestedModelId} is not listed at zero input and output price right now`,
    };
  }
  return { eligible: true, entry, verifiedAt: catalogue.snapshot.fetchedAt };
}
