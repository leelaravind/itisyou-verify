/**
 * Everything the composition root needs to mount the money path, behind two calls.
 *
 * ## The rule this file encodes
 *
 * The auditor's finding, and the reason this whole module exists: the dominant defect on
 * this project is *correct code, thoroughly tested, reached by nothing*. Four separate
 * findings had that shape and every one survived multiple rounds of review, because the
 * reviews read the logic and nobody traced a request to it.
 *
 * So the wiring is deliberately made as small as it can be. `index.ts` gets **one line**
 * for the HTTP door and **one line** for the cron; anything more and the odds of a
 * half-wired path go up. Everything that could be forgotten is assembled here instead of
 * there.
 *
 * ## What a missing secret does, and why it is not a failure
 *
 * The events route mounts with no Stripe key, no Resend key and no wrapping key. Each
 * absence produces a specific, honest refusal rather than a degraded success:
 *
 * | Absent | What happens |
 * | --- | --- |
 * | `CREDENTIAL_KEY_V1` | No signing key can be issued or opened. Every signed event gets **503 SIGNING_KEY_UNREADABLE**, which says the fault is ours. |
 * | Stripe config | `checkAdmission` finds no subscription and refuses with **402 NO_SUBSCRIPTION**. Correct: nobody has paid. |
 * | An allowance row | **402 ENTITLEMENT_MISSING**. A workspace with no plan period is not served. |
 *
 * None of those is a 200. The route never invents a run id it did not write.
 */
import {
  PAYMENT_FAILURE_GRACE_DAYS,
  PLAN,
  type BillingConfig,
  type BillingEnvironment,
} from '../billing/config';
import { billingEnvironmentOf, checkBillingSecrets, type BillingEnv } from '../billing/mount';
import type { BillingGatewayPort } from '../billing/gateway';
import type { BillingRuntime } from '../billing/runtime';
import { D1BillingDataPort } from '../db/billingPort';
import type { Db } from '../db/d1';
import { newId } from '../lib/ids';
import { createEventsRoute, type EventsLog } from './eventsRoute';
import { createSigningKeyResolver } from './signingKeys';

/** The Worker bindings the money path reads. A structural subset of `Env`. */
export interface MoneyEnv extends BillingEnv {
  readonly DB: D1Database;
  /** Base64 AES-GCM wrapping key. Absent on a deployment that holds no credentials. */
  readonly CREDENTIAL_KEY_V1?: string | undefined;
}

export interface MoneyMountParts {
  /**
   * The provider gateway. Required by the billing runtime's type, and **not called by the
   * events path at all** — admission is a pure read of our own tables. Supplying a client
   * built from an empty key is therefore safe here and is what an unconfigured deployment
   * does.
   */
  readonly gateway: BillingGatewayPort;
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
  readonly log?: EventsLog;
}

/**
 * The configuration the admission gate reads — and nothing more.
 *
 * `buildBillingConfig` deliberately **throws** without a valid Stripe price id, because a
 * checkout that cannot resolve a price must never run half-configured. That is right for
 * checkout and wrong here: admission signs nothing, calls no provider and reads no price.
 * It asks two questions of our own tables — is this workspace served, and has it any
 * allowance left — and a deployment with no Stripe key must still be able to answer them
 * ("no subscription"), rather than 503 on a door that is working correctly.
 *
 * So this builds the two fields admission actually reads and states plainly that the rest
 * are absent. `priceId` is the empty string, not a plausible-looking fake: anything that
 * accidentally reached checkout with this config fails immediately and visibly instead of
 * quoting a price nobody approved.
 *
 * If you need a runtime that can create a checkout session or a portal link, use
 * `billingConfigFromEnv` / `createStripeWebhookDeps` from `billing/mount.ts`. Not this.
 */
export function admissionOnlyConfig(env: BillingEnv): BillingConfig {
  const environment: BillingEnvironment = billingEnvironmentOf(env);
  return Object.freeze({
    environment,
    plan: PLAN,
    /** Intentionally empty. Admission never reads a price; checkout must never use this. */
    priceId: '',
    publicBaseUrl: env.PUBLIC_BASE_URL,
    gracePeriodDays: PAYMENT_FAILURE_GRACE_DAYS,
  });
}

/**
 * Build the billing runtime the admission gate reads.
 *
 * Separate from `createStripeWebhookDeps` on purpose: that one asserts every Stripe secret
 * and throws in production without them, because a webhook route with no signing secret
 * would accept forgeries. Admission has no such exposure and must keep working unconfigured.
 */
export function createAdmissionRuntime(env: MoneyEnv, parts: MoneyMountParts): BillingRuntime {
  const db = env.DB as unknown as Db;
  const clock = parts.now ?? ((): Date => new Date());
  return {
    config: admissionOnlyConfig(env),
    data: new D1BillingDataPort(db),
    gateway: parts.gateway,
    now: () => clock().toISOString(),
    newId: parts.newId ?? ((prefix: string) => newId(prefix)),
  };
}

/**
 * **The one line `index.ts` needs for the signed-event door.**
 *
 *     app.route('/', createMoneyRoutes(c.env, { gateway: createStripeClient({ secretKey: '' }) }));
 *
 * Mounted like the webhook routes — before the page routers, and with nothing parsing the
 * body first, because the signature covers the raw bytes and a re-serialised body is a
 * different document.
 */
export function createMoneyRoutes(env: MoneyEnv, parts: MoneyMountParts) {
  const db = env.DB as unknown as Db;
  return createEventsRoute({
    db,
    resolveSigningKey: createSigningKeyResolver({
      db,
      credentialKeyBase64: env.CREDENTIAL_KEY_V1 ?? '',
    }),
    billing: createAdmissionRuntime(env, parts),
    ...(parts.now === undefined ? {} : { now: parts.now }),
    ...(parts.newId === undefined ? {} : { newId: parts.newId }),
    ...(parts.log === undefined ? {} : { log: parts.log }),
  });
}

/**
 * What this deployment can and cannot do on the money path, as a readable fact.
 *
 * Used by `/health` and by the owner's operations view, so "the endpoint is live" is
 * something we can read off the running Worker rather than something a document asserts.
 */
export interface MoneyPathReadiness {
  /** The route is mounted and will answer. Independent of whether it can admit anything. */
  readonly routeMounted: true;
  /** False when `CREDENTIAL_KEY_V1` is absent: no signature can be verified. */
  readonly canVerifySignatures: boolean;
  /** False when Stripe is unconfigured: nobody can hold a subscription. */
  readonly canTakePayment: boolean;
  readonly missingSecrets: readonly string[];
}

export function moneyPathReadiness(env: MoneyEnv): MoneyPathReadiness {
  const billing = checkBillingSecrets(env);
  return {
    routeMounted: true,
    canVerifySignatures: (env.CREDENTIAL_KEY_V1 ?? '').length > 0,
    canTakePayment: billing.ready,
    missingSecrets: [
      ...((env.CREDENTIAL_KEY_V1 ?? '').length > 0 ? [] : ['CREDENTIAL_KEY_V1']),
      ...billing.missing,
    ],
  };
}
