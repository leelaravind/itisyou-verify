/**
 * Everything the composition root needs to mount the money paths, and every check that
 * must fail loudly before it does.
 *
 * This file exists so the lead mounts one line rather than assembling seven collaborators
 * by hand, and so the conditions under which mounting is *unsafe* are expressed as code
 * that throws rather than as a paragraph somebody has to remember.
 *
 * ## Why `resolveEndpointSecret` does not read D1
 *
 * The lead asked how it should reach the database. My answer is that it should not, and
 * the reasoning is worth writing down rather than quietly implementing the other thing:
 *
 *  - There is exactly one Stripe endpoint per deployment. One Worker, one environment, one
 *    signing secret. A lookup table with one row is a database round trip added to the
 *    hottest untrusted path in the system, on every delivery, including every forged one.
 *    That is a free amplification factor for anyone who wants to spend our D1 reads.
 *  - `migrations/0001_init.sql` has no table for webhook endpoints, and adding one would
 *    mean putting a signing key in a database row. Stored credentials in this system live
 *    in AES-GCM envelopes (`packages/security`), which exist for credentials we must hand
 *    back to a provider. A webhook signing secret never leaves the Worker, so the Worker
 *    secret store is the right home and an envelope would be ceremony around a weaker
 *    outcome.
 *  - The opaque id is compared in constant time against the configured value. A lookup by
 *    id in SQLite is not constant time and leaks through timing what the id is not.
 *
 * If a second endpoint ever exists — the real case is the 24-hour dual-secret window
 * during a secret roll — the fix is to let the resolver return *several* candidate
 * secrets, not to move it into the database. See `docs/billing.md` §9.
 */
import { timingSafeEqual } from '@verify/security';
import { secretKeyIsUsable } from '@verify/connectors/stripe';
import { buildBillingConfig, type BillingConfig, type BillingEnvironment } from './config';
import type { BillingGatewayPort } from './gateway';
import type { BillingDataPort } from './port';
import type { BillingContactLookup, BillingRuntime } from './runtime';
import { systemClock } from './runtime';
import type { StripeEndpointSecretResolver, StripeWebhookDeps } from '../routes/webhooks/stripe';

/**
 * The bindings the billing subsystem reads. A subset of the Worker's `Env`, declared
 * structurally so this file does not depend on `index.ts` and `index.ts` can depend on it.
 */
export interface BillingEnv {
  readonly ENVIRONMENT: string;
  readonly PUBLIC_BASE_URL: string;
  /** `test` or `live`. Anything else is refused. */
  readonly STRIPE_MODE?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_PRICE_ID?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  /** The opaque path segment we issued. Not a secret, but not public either. */
  readonly STRIPE_WEBHOOK_PATH_ID?: string | undefined;
  /**
   * The key verification runs against when the path id is unknown. Not a credential —
   * nothing is ever accepted under it — but it must be per-deployment and unguessable so
   * the unknown-endpoint path cannot be characterised from outside.
   */
  readonly STRIPE_WEBHOOK_UNKNOWN_KEY?: string | undefined;
}

/**
 * The secret names to provision. Named here so the lead and this code cannot disagree
 * about spelling, and so a rename is a compile error rather than a silent 400 in
 * production.
 */
export const BILLING_SECRET_NAMES = Object.freeze({
  secretKey: 'STRIPE_SECRET_KEY',
  priceId: 'STRIPE_PRICE_ID',
  webhookSecret: 'STRIPE_WEBHOOK_SECRET',
  webhookPathId: 'STRIPE_WEBHOOK_PATH_ID',
  webhookUnknownKey: 'STRIPE_WEBHOOK_UNKNOWN_KEY',
} as const);

export class BillingConfigurationError extends Error {
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = 'BillingConfigurationError';
    this.missing = missing;
  }
}

/** Environments where a missing secret must stop the deployment rather than degrade it. */
function isProductionLike(env: BillingEnv): boolean {
  return env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'staging';
}

export function billingEnvironmentOf(env: BillingEnv): BillingEnvironment {
  const mode = env.STRIPE_MODE ?? 'test';
  if (mode !== 'test' && mode !== 'live') {
    throw new BillingConfigurationError(
      `STRIPE_MODE must be "test" or "live", received "${mode}".`,
    );
  }
  return mode;
}

/**
 * Check every billing secret is present, and throw naming the missing ones.
 *
 * Call this at module scope in the composition root, before mounting. A stand-in key that
 * silently defaults is how SEC-431 reopens, so in a production-like environment an absent
 * `STRIPE_WEBHOOK_UNKNOWN_KEY` is a hard failure, not a fallback.
 *
 * Outside production the missing names are returned rather than thrown, so a developer
 * with no Stripe key can still boot the Worker and use every non-money page.
 */
export function checkBillingSecrets(env: BillingEnv): {
  readonly ready: boolean;
  readonly missing: readonly string[];
} {
  const present: Record<string, string | undefined> = {
    [BILLING_SECRET_NAMES.secretKey]: env.STRIPE_SECRET_KEY,
    [BILLING_SECRET_NAMES.priceId]: env.STRIPE_PRICE_ID,
    [BILLING_SECRET_NAMES.webhookSecret]: env.STRIPE_WEBHOOK_SECRET,
    [BILLING_SECRET_NAMES.webhookPathId]: env.STRIPE_WEBHOOK_PATH_ID,
    [BILLING_SECRET_NAMES.webhookUnknownKey]: env.STRIPE_WEBHOOK_UNKNOWN_KEY,
  };
  const missing: string[] = [];
  for (const name of Object.values(BILLING_SECRET_NAMES)) {
    const value = present[name];
    if (typeof value !== 'string' || value.trim().length === 0) missing.push(name);
  }
  // Present is not the same as usable. This function gates the scheduler's money pass,
  // which then calls `createStripeClient` -- and that throws on a key which is neither test
  // nor live. Staging held exactly such a key, so every tick reported the pass ready and
  // then failed inside it. Counting a malformed key as missing is the honest answer to the
  // question this function is actually asked: can this deployment take money.
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (secretKey.length > 0 && !secretKeyIsUsable(secretKey)) {
    missing.push(BILLING_SECRET_NAMES.secretKey);
  }
  return { ready: missing.length === 0, missing };
}

export function assertBillingSecrets(env: BillingEnv): void {
  const { ready, missing } = checkBillingSecrets(env);
  if (ready) return;
  if (!isProductionLike(env)) return;
  throw new BillingConfigurationError(
    `Billing cannot be mounted in ${env.ENVIRONMENT}: missing ${missing.join(', ')}. ` +
      'Provision these as Worker secrets. Nothing about the money path degrades gracefully.',
    missing,
  );
}

/**
 * The endpoint-secret resolver.
 *
 * Constant-time on the path id, so an attacker cannot learn the id a character at a time
 * from response timing. Returns `null` for anything else, and the route rejects on that
 * `null` rather than on the signature comparison.
 */
export function createEndpointSecretResolver(env: BillingEnv): StripeEndpointSecretResolver {
  const configuredId = env.STRIPE_WEBHOOK_PATH_ID ?? '';
  const secret = env.STRIPE_WEBHOOK_SECRET ?? '';
  return async (opaqueId: string): Promise<string | null> => {
    if (configuredId.length === 0 || secret.length === 0) return null;
    // `timingSafeEqual` compares equal-length strings in constant time and returns false
    // for a length mismatch, which is all the leak an opaque id can afford.
    return timingSafeEqual(configuredId, opaqueId) ? secret : null;
  };
}

export function billingConfigFromEnv(env: BillingEnv): BillingConfig {
  const environment = billingEnvironmentOf(env);
  // Trimmed where it is READ, not only where it is checked. A secret set by piping a value
  // into `wrangler secret put` carries the trailing newline the generating command printed,
  // and a validator that trims while the consumer does not is worse than no validator: the
  // check passes and the provider gets a value with a newline in it.
  const priceId = (env.STRIPE_PRICE_ID ?? '').trim();
  return buildBillingConfig({
    environment,
    priceId,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  });
}

export interface BillingRuntimeParts {
  readonly data: BillingDataPort;
  readonly gateway: BillingGatewayPort;
  readonly billingContact?: BillingContactLookup;
  readonly newId: (prefix: string) => string;
  readonly now?: () => string;
}

/** Assemble the runtime the orchestration functions take. */
export function createBillingRuntime(env: BillingEnv, parts: BillingRuntimeParts): BillingRuntime {
  return {
    config: billingConfigFromEnv(env),
    data: parts.data,
    gateway: parts.gateway,
    now: parts.now ?? systemClock,
    newId: parts.newId,
    ...(parts.billingContact === undefined ? {} : { billingContact: parts.billingContact }),
  };
}

/**
 * Assemble the webhook route's dependencies.
 *
 * Throws in a production-like environment when a secret is missing. In development it
 * still builds, but `resolveEndpointSecret` returns `null` for every id, so every delivery
 * is a 400 — which is the correct degraded behaviour for an unconfigured money path.
 */
export function createStripeWebhookDeps(
  env: BillingEnv,
  parts: BillingRuntimeParts,
): StripeWebhookDeps {
  assertBillingSecrets(env);
  const runtime = createBillingRuntime(env, parts);
  const unknownKey = env.STRIPE_WEBHOOK_UNKNOWN_KEY;
  return {
    ...runtime,
    resolveEndpointSecret: createEndpointSecretResolver(env),
    ...(typeof unknownKey === 'string' && unknownKey.length > 0
      ? { unknownEndpointKey: unknownKey }
      : {}),
  };
}
