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
 * | `EVENT_SIGNING_ROOT_KEY` | No signing key can be issued or derived. Every signed event gets **503 SIGNING_KEY_UNREADABLE**, which says plainly that the fault is ours. |
 * | Stripe config | `checkAdmission` finds no subscription and refuses with **402 NO_SUBSCRIPTION**. Correct: nobody has paid. |
 * | An allowance row | **402 ENTITLEMENT_MISSING**. A workspace with no plan period is not served. |
 *
 * None of those is a 200. The route never invents a run id it did not write.
 */
import { createNotificationDelivery } from '../notifications/delivery';
import { D1SupportDataPort } from '../db/supportPort';
import type { EmailTransportEnv } from '../notifications/email';
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
import type { SigningKeyStore } from './ports';
import { createSigningKeyResolver } from './signingKeys';

/** The Worker bindings the money path reads. A structural subset of `Env`. */
/**
 * `EmailTransportEnv` is part of this because the events path now sends a usage warning.
 *
 * Declared rather than cast. The first version of the alert wiring passed `env as never`
 * into the delivery builder, which is precisely the hole that produced the production
 * sign-in failure API-247 exists for: a cast silenced the type, the transport was built
 * from an env that did not carry `RESEND_API_KEY`, and every notification would have been
 * recorded `no_email_transport_configured` while looking like it worked. Both fields are
 * optional, so a deployment with no transport still type-checks and still admits events —
 * it simply records the warning as suppressed, which is a supported configuration.
 */
export interface MoneyEnv extends BillingEnv, EmailTransportEnv {
  readonly DB: D1Database;
  /**
   * The Worker secret every workflow signing key is derived from. Absent on a deployment
   * that cannot verify a signed event; every signed request then answers 503, not 401.
   */
  readonly EVENT_SIGNING_ROOT_KEY?: string | undefined;
}

export interface MoneyMountParts {
  /**
   * The provider gateway. Required by the billing runtime's type, and **not called by the
   * events path at all** — admission is a pure read of our own tables. Supplying a client
   * built from an empty key is therefore safe here and is what an unconfigured deployment
   * does.
   */
  readonly gateway: BillingGatewayPort;
  /**
   * Where a workflow's signing key is read from. Supplied by the composition root rather
   * than built here, because the implementation is SQL and SQL lives in `apps/app/src/db/`
   * — see `money/ports.ts`. `createWorkflowSigningKeyStore(env.DB)` is the one to pass.
   */
  readonly signingKeyStore: SigningKeyStore;
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
      store: parts.signingKeyStore,
      rootKey: env.EVENT_SIGNING_ROOT_KEY ?? '',
    }),
    billing: createAdmissionRuntime(env, parts),
    /*
     * The usage warning's transport, wired here so the feature exists on the deployed site
     * rather than only in a test's captured array.
     *
     * `createNotificationDelivery` is the same builder the sign-in link uses, and it records
     * every attempt in `notification_deliveries` — which is the delivery evidence, and the
     * reason nobody has to check a mailbox to know whether this worked. With no
     * `RESEND_API_KEY` it records `suppressed` and throws nothing, so a deployment without a
     * transport still admits events and simply never warns.
     */
    sendUsageAlert: async (request) => {
      /*
       * No `releaseUndelivered` here, deliberately.
       *
       * An earlier version released the failed key before retrying, copying the owner-alert
       * pattern. That helper DELETES the row, and the row is now how attempts are counted —
       * releasing would reset the bound every time and produce the unbounded retry it was
       * meant to prevent. Each attempt carries its own key instead, so the history stays.
       */
      const supportPort = new D1SupportDataPort(db);
      const report = await createNotificationDelivery(env, supportPort).deliver([
        {
          notificationKey: request.notificationKey,
          workspaceId: request.workspaceId,
          recipientEmail: request.recipientEmail,
          template: request.template,
          vars: request.vars,
        },
      ]);
      const first = report.results[0];
      return { outcome: first?.outcome ?? 'failed' };
    },
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
  /** False when `EVENT_SIGNING_ROOT_KEY` is absent: no signature can be verified. */
  readonly canVerifySignatures: boolean;
  /** False when Stripe is unconfigured: nobody can hold a subscription. */
  readonly canTakePayment: boolean;
  readonly missingSecrets: readonly string[];
}

export function moneyPathReadiness(env: MoneyEnv): MoneyPathReadiness {
  const billing = checkBillingSecrets(env);
  return {
    routeMounted: true,
    canVerifySignatures: (env.EVENT_SIGNING_ROOT_KEY ?? '').length > 0,
    canTakePayment: billing.ready,
    missingSecrets: [
      ...((env.EVENT_SIGNING_ROOT_KEY ?? '').length > 0 ? [] : ['EVENT_SIGNING_ROOT_KEY']),
      ...billing.missing,
    ],
  };
}
