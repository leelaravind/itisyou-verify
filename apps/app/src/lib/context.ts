/**
 * Per-request context and the Worker's binding surface.
 *
 * Everything a handler is allowed to know about its environment arrives here. Nothing
 * reads `process.env`; nothing reaches for a global. A request id is minted on the way in
 * and travels through logs, error envelopes and audit rows so one customer report can be
 * traced end to end without storing anything about the customer.
 */
import type { Db } from '../db/d1';
import { ID_PREFIX, newId } from './ids';
import { nowIso } from './time';

/**
 * Worker bindings and variables.
 *
 * Vars come from `wrangler.jsonc`. Secrets are optional at the type level on purpose: the
 * product must start and serve its public pages with commerce, email and the assistant
 * all unconfigured, so every consumer has to handle "not set" rather than assume.
 */
export interface Env {
  // --- bindings ---
  readonly DB: D1Database;
  readonly ASSETS: Fetcher;

  // --- vars ---
  readonly ENVIRONMENT: 'development' | 'staging' | 'production' | (string & {});
  readonly PUBLIC_BASE_URL: string;
  readonly STRIPE_MODE: 'test' | 'live' | (string & {});

  // --- secrets (see .dev.vars.example) ---
  readonly CREDENTIAL_KEY_V1?: string;
  readonly SESSION_SIGNING_KEY?: string;
  readonly ANALYTICS_SALT?: string;
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly STRIPE_PRICE_ID?: string;
  readonly RESEND_API_KEY?: string;
  readonly RESEND_WEBHOOK_SECRET?: string;
  readonly RESEND_FROM_ADDRESS?: string;
  /** HubSpot private-app token, read scope only. Used by the connector proof scripts. */
  readonly HUBSPOT_TEST_TOKEN?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly OWNER_BOOTSTRAP_EMAIL?: string;
  readonly OWNER_BOOTSTRAP_TOKEN?: string;
}

export interface RequestContext {
  /** Returned in every response and every error envelope. Opaque to the customer. */
  readonly requestId: string;
  /** Monotonic-ish start, used only for duration logging. */
  readonly startedAtMs: number;
  /** ISO-8601 UTC instant the request was accepted. */
  readonly startedAt: string;
  readonly environment: Env['ENVIRONMENT'];
  readonly publicBaseUrl: string;
  readonly db: Db;
  readonly env: Env;
  /** Present when the context was built from a real request. */
  readonly method: string;
  readonly path: string;
}

/** A caller-supplied request id is only honoured when it is safely shaped. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function createRequestContext(
  request: { readonly headers: Headers; readonly method: string; readonly url: string },
  env: Env,
  now: Date = new Date(),
): RequestContext {
  const inbound = request.headers.get('x-request-id');
  const requestId =
    inbound !== null && SAFE_REQUEST_ID.test(inbound)
      ? inbound
      : newId(ID_PREFIX.lease, now.getTime());

  let path = '/';
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = '/';
  }

  return {
    requestId,
    startedAtMs: now.getTime(),
    startedAt: nowIso(now),
    environment: env.ENVIRONMENT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    db: env.DB,
    env,
    method: request.method,
    path,
  };
}

/** True in the deployed production Worker only. Gates anything that can cost money. */
export function isProduction(env: Pick<Env, 'ENVIRONMENT'>): boolean {
  return env.ENVIRONMENT === 'production';
}

/**
 * Read a secret, failing loudly at the point of use rather than producing a subtly wrong
 * signature later. Returns `null` when the feature is simply not configured.
 */
export function optionalSecret(env: Env, name: keyof Env): string | null {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function requireSecret(env: Env, name: keyof Env): string {
  const value = optionalSecret(env, name);
  if (value === null) {
    throw new Error(`required secret ${String(name)} is not configured`);
  }
  return value;
}
