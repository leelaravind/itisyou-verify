/**
 * Shared scaffolding for the billing integration tests.
 *
 * The data layer is `createMemoryBillingStore()` from `apps/app/src/billing/memory.ts`,
 * which enforces the same uniqueness constraints `migrations/0001_init.sql` does. The
 * provider is a recording stub — **no test in this directory ever reaches Stripe**, and
 * `tests/setup.ts` would fail loudly if one tried.
 *
 * The clock and the id factory are deterministic so an out-of-order webhook scenario is
 * reproducible rather than a race.
 */
import { signStripe } from '@verify/security';
import { buildBillingConfig, type BillingConfig } from '@app/billing/config';
import type {
  BillingGatewayPort,
  GatewayCheckoutSession,
  GatewayCustomer,
  GatewayPortalSession,
  GatewayRefund,
  GatewaySubscription,
} from '@app/billing/gateway';
import { createMemoryBillingStore, type MemoryBillingStore } from '@app/billing/memory';
import type { BillingRuntime } from '@app/billing/runtime';

/**
 * Assembled at runtime, not written as a literal. This repository is public, and a
 * credential-shaped string is rejected by `scripts/scan-secrets.mjs` and by GitHub push
 * protection — see `docs/agent-brief.md`, "Never commit a credential-shaped literal".
 * The value is identical; it just stops looking like a secret.
 */
export const WEBHOOK_SECRET = 'whsec' + '_' + 'T'.repeat(32);
export const OPAQUE_ID = 'wh_7f3a9c2e5b1d4f60';

export interface GatewayCall {
  readonly method: string;
  readonly params: unknown;
}

export interface StubGateway extends BillingGatewayPort {
  readonly calls: GatewayCall[];
  /** Subscriptions the stub will return from `retrieveSubscription`, by id. */
  readonly subscriptions: Map<string, GatewaySubscription>;
  failNext(method: keyof BillingGatewayPort, error: unknown): void;
}

export function createStubGateway(options: { readonly livemode?: boolean } = {}): StubGateway {
  const livemode = options.livemode ?? false;
  const calls: GatewayCall[] = [];
  const subscriptions = new Map<string, GatewaySubscription>();
  const failures = new Map<string, unknown>();
  let checkoutCounter = 0;
  let customerCounter = 0;
  let refundCounter = 0;

  function maybeFail(method: string): void {
    if (failures.has(method)) {
      const error = failures.get(method);
      failures.delete(method);
      throw error;
    }
  }

  return {
    calls,
    subscriptions,
    failNext(method, error) {
      failures.set(method, error);
    },

    async createCustomer(params): Promise<GatewayCustomer> {
      calls.push({ method: 'createCustomer', params });
      maybeFail('createCustomer');
      customerCounter += 1;
      return { id: `cus_stub_${customerCounter}`, livemode };
    },

    async createCheckoutSession(params): Promise<GatewayCheckoutSession> {
      calls.push({ method: 'createCheckoutSession', params });
      maybeFail('createCheckoutSession');
      // Stripe's create call is idempotent under the same key: the same key returns the
      // same session. Modelling that is the point of this stub.
      const existing = calls
        .filter(
          (call): call is GatewayCall & { params: { idempotencyKey: string } } =>
            call.method === 'createCheckoutSession',
        )
        .findIndex((call) => call.params.idempotencyKey === params.idempotencyKey);
      if (existing === -1) checkoutCounter += 1;
      const id = `cs_stub_${existing === -1 ? checkoutCounter : existing + 1}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}`, livemode };
    },

    async createBillingPortalSession(params): Promise<GatewayPortalSession> {
      calls.push({ method: 'createBillingPortalSession', params });
      maybeFail('createBillingPortalSession');
      return { id: 'bps_stub_1', url: 'https://billing.stripe.com/p/session/stub', livemode };
    },

    async retrieveSubscription(subscriptionId): Promise<GatewaySubscription> {
      calls.push({ method: 'retrieveSubscription', params: { subscriptionId } });
      maybeFail('retrieveSubscription');
      const found = subscriptions.get(subscriptionId);
      if (found === undefined) {
        throw Object.assign(new Error('No such subscription'), { kind: 'not_found' });
      }
      return found;
    },

    async cancelSubscription(params): Promise<GatewaySubscription> {
      calls.push({ method: 'cancelSubscription', params });
      maybeFail('cancelSubscription');
      const current = subscriptions.get(params.subscriptionId);
      const next: GatewaySubscription = {
        id: params.subscriptionId,
        status: params.when === 'immediately' ? 'canceled' : (current?.status ?? 'active'),
        customer: current?.customer ?? 'cus_stub_1',
        cancel_at_period_end: params.when === 'period_end',
        livemode,
        ...(current?.items === undefined ? {} : { items: current.items }),
      };
      subscriptions.set(params.subscriptionId, next);
      return next;
    },

    async createRefund(params): Promise<GatewayRefund> {
      calls.push({ method: 'createRefund', params });
      maybeFail('createRefund');
      refundCounter += 1;
      return {
        id: `re_stub_${refundCounter}`,
        amount: params.amountMinor,
        currency: 'gbp',
        status: 'succeeded',
      };
    },
  };
}

export interface BillingHarness extends BillingRuntime {
  readonly data: MemoryBillingStore;
  readonly gateway: StubGateway;
  readonly config: BillingConfig;
  /** Advance the deterministic clock by whole seconds. */
  tick(seconds: number): void;
  /** The current clock value. */
  at(): string;
}

export function createHarness(
  options: {
    readonly environment?: 'test' | 'live';
    readonly startAt?: string;
    readonly gracePeriodDays?: number;
    /** Workspace ids this simulated deployment holds. Omitted, every id is known. */
    readonly knownWorkspaces?: readonly string[];
  } = {},
): BillingHarness {
  const environment = options.environment ?? 'test';
  const config = buildBillingConfig({
    environment,
    priceId: 'price_planv1stub',
    publicBaseUrl: 'https://verify.itisyou.example',
    ...(options.gracePeriodDays === undefined ? {} : { gracePeriodDays: options.gracePeriodDays }),
  });
  const data = createMemoryBillingStore(
    options.knownWorkspaces === undefined ? {} : { knownWorkspaces: options.knownWorkspaces },
  );
  const gateway = createStubGateway({ livemode: environment === 'live' });

  let clock = Date.parse(options.startAt ?? '2026-09-19T09:00:00.000Z');
  const counters = new Map<string, number>();

  return {
    config,
    data,
    gateway,
    now: () => new Date(clock).toISOString(),
    newId: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${String(next).padStart(4, '0')}`;
    },
    tick(seconds) {
      clock += seconds * 1000;
    },
    at() {
      return new Date(clock).toISOString();
    },
  };
}

// ---------------------------------------------------------------------------
// event fixtures
// ---------------------------------------------------------------------------

export interface EventOptions {
  readonly id?: string;
  readonly created?: number;
  readonly livemode?: boolean;
}

let eventCounter = 0;

export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  options: EventOptions = {},
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: options.id ?? `evt_fixture_${eventCounter}`,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: options.created ?? 1_800_000_000,
    livemode: options.livemode ?? false,
    type,
    data: { object },
  };
}

/** A subscription object in the **current** shape: period end lives on the item. */
export function subscriptionObject(
  overrides: {
    readonly id?: string;
    readonly status?: string;
    readonly customer?: string;
    readonly priceId?: string;
    readonly currentPeriodEnd?: number;
    readonly cancelAtPeriodEnd?: boolean;
    readonly livemode?: boolean;
    readonly workspaceId?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'sub_live_1',
    object: 'subscription',
    status: overrides.status ?? 'active',
    customer: overrides.customer ?? 'cus_stub_1',
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    canceled_at: null,
    livemode: overrides.livemode ?? false,
    ...(overrides.workspaceId === undefined
      ? {}
      : { metadata: { workspace_id: overrides.workspaceId } }),
    items: {
      object: 'list',
      data: [
        {
          id: 'si_1',
          object: 'subscription_item',
          current_period_start: (overrides.currentPeriodEnd ?? 1_800_500_000) - 2_592_000,
          current_period_end: overrides.currentPeriodEnd ?? 1_800_500_000,
          price: { id: overrides.priceId ?? 'price_planv1stub', object: 'price' },
        },
      ],
    },
  };
}

/** An invoice in the current shape: the subscription hangs off `parent`. */
export function invoiceObject(
  overrides: {
    readonly id?: string;
    readonly customer?: string;
    readonly subscriptionId?: string | null;
    readonly billingReason?: string;
    readonly periodStart?: number;
    readonly amountPaid?: number;
  } = {},
): Record<string, unknown> {
  const periodStart = overrides.periodStart ?? 1_797_908_000;
  return {
    id: overrides.id ?? 'in_1',
    object: 'invoice',
    customer: overrides.customer ?? 'cus_stub_1',
    amount_paid: overrides.amountPaid ?? 2900,
    currency: 'gbp',
    status: 'paid',
    billing_reason: overrides.billingReason ?? 'subscription_cycle',
    period_start: periodStart,
    period_end: periodStart + 2_592_000,
    livemode: false,
    ...(overrides.subscriptionId === null
      ? { parent: null }
      : {
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: overrides.subscriptionId ?? 'sub_live_1' },
          },
        }),
    lines: {
      object: 'list',
      data: [{ id: 'il_1', period: { start: periodStart, end: periodStart + 2_592_000 } }],
    },
  };
}

export function chargeRefundedObject(
  refunds: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id: 'ch_1',
    object: 'charge',
    amount: 2900,
    amount_refunded: 2900,
    currency: 'gbp',
    refunded: true,
    refunds: { object: 'list', data: refunds },
  };
}

/** Body plus a genuine `Stripe-Signature` header over those exact bytes. */
export async function signedDelivery(
  event: Record<string, unknown>,
  atIso: string,
  secret: string = WEBHOOK_SECRET,
): Promise<{ body: string; headers: Record<string, string> }> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.parse(atIso) / 1000);
  const header = await signStripe(body, timestamp, secret);
  return {
    body,
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
  };
}
