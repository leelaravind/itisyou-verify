/**
 * Stripe adapter — a thin, typed layer over the Stripe REST API using `fetch`.
 *
 * Owned by A06 (Commerce). A04 owns the rest of `packages/connectors/`; this file only
 * *imports* A04's URL guard (`./url-guard`) so every outbound request is checked against
 * the same fixed host allowlist the other connectors use. Nothing else in this package is
 * touched.
 *
 * Why no `stripe` npm package: it is a large dependency built around Node's `http` stack
 * and its own retry/telemetry machinery. A Worker needs eight endpoints and `fetch`.
 * Fewer bytes, no new dependency, and every request shape is visible in this file.
 *
 * ## Verified against the current Stripe documentation on 2026-09-19
 *
 * | What                          | Source                                                    |
 * | ----------------------------- | --------------------------------------------------------- |
 * | API version `2026-08-26.dahlia` | https://docs.stripe.com/api/versioning                   |
 * | `POST /v1/customers`          | https://docs.stripe.com/api/customers/create              |
 * | `POST /v1/checkout/sessions`  | https://docs.stripe.com/api/checkout/sessions/create      |
 * | `POST /v1/billing_portal/sessions` | https://docs.stripe.com/api/customer_portal/sessions/create |
 * | `GET/DELETE /v1/subscriptions/:id` | https://docs.stripe.com/api/subscriptions/cancel     |
 * | `POST /v1/refunds`            | https://docs.stripe.com/api/refunds/create                |
 * | `GET /v1/events`              | https://docs.stripe.com/api/events/list                   |
 * | `POST /v1/products`, `POST /v1/prices` | https://docs.stripe.com/api/prices/create        |
 * | `Idempotency-Key` header      | https://docs.stripe.com/api/idempotent_requests           |
 * | Webhook signature scheme      | https://docs.stripe.com/webhooks                          |
 *
 * Two shape changes in the current API version that this file deliberately encodes:
 *
 *  - A Subscription no longer carries a top-level `current_period_end`. It lives on each
 *    subscription item (`items.data[].current_period_end`). `subscriptionPeriodEnd()`
 *    reads the item and falls back to the legacy top-level field so an event generated
 *    under an older account API version still parses.
 *  - An Invoice no longer carries a top-level `subscription`. It lives at
 *    `parent.subscription_details.subscription`. `invoiceSubscriptionId()` reads both.
 *
 * ## Secrets
 *
 * The secret key is never interpolated into a message, a URL, a log line or an error.
 * `StripeError` runs every message through `scrubSecret()` before it is stored, so even a
 * provider error that echoed the key back could not escape through a thrown value.
 *
 * ## No real calls
 *
 * Nothing in this file has ever been run against Stripe. There is no key in the
 * repository. Every test injects `fetchImpl`. Treat this adapter as *unproven against the
 * live API* until the owner supplies a test key and `ensureProductAndPrice` is run once.
 */
import { checkUrl, CONNECTOR_URL_GUARD_OPTIONS } from './url-guard';

/** The API version this adapter was written and verified against, 2026-09-19. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

/** Fixed. Never read from configuration, a database row or a provider response. */
export const STRIPE_API_BASE = 'https://api.stripe.com';

/** A response larger than this is refused unread. Stripe objects are kilobytes. */
export const STRIPE_MAX_RESPONSE_BYTES = 512 * 1024;

export type StripeEnvironment = 'test' | 'live';

export type StripeFailureKind =
  | 'configuration'
  | 'authentication'
  | 'invalid_request'
  | 'not_found'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'malformed_response'
  | 'blocked_url'
  | 'response_too_large';

/**
 * Every failure this adapter can produce, with the transport detail flattened into a
 * `kind` the billing layer can branch on without re-reading HTTP status codes.
 *
 * `message` is scrubbed of the secret key at construction time.
 */
export class StripeError extends Error {
  readonly kind: StripeFailureKind;
  readonly httpStatus: number | null;
  readonly stripeCode: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(
    kind: StripeFailureKind,
    message: string,
    options: {
      readonly httpStatus?: number | null;
      readonly stripeCode?: string | null;
      readonly requestId?: string | null;
      readonly secret?: string;
    } = {},
  ) {
    super(scrubSecret(message, options.secret));
    this.name = 'StripeError';
    this.kind = kind;
    this.httpStatus = options.httpStatus ?? null;
    this.stripeCode = scrubSecret(options.stripeCode ?? '', options.secret) || null;
    this.requestId = options.requestId ?? null;
    this.retryable = kind === 'rate_limited' || kind === 'provider_unavailable';
  }
}

/**
 * Replace a secret key with a marker wherever it appears.
 *
 * Also catches any `sk_`/`rk_`/`whsec_` shaped token even when it is not *our* key, so a
 * pasted key in a provider error message cannot travel any further either.
 */
export function scrubSecret(value: string, secret?: string): string {
  let out = value;
  if (typeof secret === 'string' && secret.length >= 8) {
    out = out.split(secret).join('[redacted-stripe-key]');
  }
  return out.replace(/\b(?:sk|rk|whsec)_[A-Za-z0-9_]{6,}/g, '[redacted-stripe-key]');
}

/** `sk_test_…` / `rk_test_…` are test mode; `sk_live_…` / `rk_live_…` are live. */
export function environmentForSecretKey(secretKey: string): StripeEnvironment {
  if (/^(?:sk|rk)_test_/.test(secretKey)) return 'test';
  if (/^(?:sk|rk)_live_/.test(secretKey)) return 'live';
  throw new StripeError(
    'configuration',
    'Stripe secret key does not look like a test or live key.',
    { secret: secretKey },
  );
}

// ---------------------------------------------------------------------------
// form encoding
// ---------------------------------------------------------------------------

/** What a Stripe form parameter tree may contain. */
export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly FormValue[]
  | { readonly [key: string]: FormValue };

/**
 * Encode a nested object the way Stripe's form API expects:
 * `recurring[interval]=month`, `line_items[0][price]=price_…`, `metadata[key]=value`,
 * `expand[]=…` for repeated scalars under a list key.
 *
 * `undefined` and `null` members are dropped entirely — a `null` in a create call would
 * otherwise be sent as the literal string "null".
 */
export function encodeForm(params: Record<string, FormValue>): string {
  const parts: string[] = [];
  const push = (key: string, value: FormValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry !== null && typeof entry === 'object') push(`${key}[${index}]`, entry);
        else push(`${key}[]`, entry);
      });
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, FormValue>)) {
        push(`${key}[${childKey}]`, childValue);
      }
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params)) push(key, value);
  return parts.join('&');
}

/** Query-string encoding for GET endpoints. Same nesting rules. */
export function encodeQuery(params: Record<string, FormValue>): string {
  const encoded = encodeForm(params);
  return encoded.length === 0 ? '' : `?${encoded}`;
}

// ---------------------------------------------------------------------------
// response shapes — only the fields we actually read
// ---------------------------------------------------------------------------

export interface StripeCustomer {
  readonly id: string;
  readonly object: 'customer';
  readonly email?: string | null;
  readonly livemode: boolean;
  readonly metadata?: Record<string, string>;
}

export interface StripeCheckoutSession {
  readonly id: string;
  readonly object: 'checkout.session';
  readonly url: string | null;
  readonly mode: 'payment' | 'setup' | 'subscription';
  readonly status: 'open' | 'complete' | 'expired' | null;
  readonly payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  readonly customer: string | null;
  readonly subscription: string | null;
  readonly client_reference_id: string | null;
  readonly currency: string | null;
  readonly amount_total: number | null;
  readonly livemode: boolean;
  readonly metadata?: Record<string, string> | null;
}

export interface StripeBillingPortalSession {
  readonly id: string;
  readonly object: 'billing_portal.session';
  readonly url: string;
  readonly customer: string;
  readonly return_url: string | null;
  readonly livemode: boolean;
}

export interface StripeSubscriptionItem {
  readonly id: string;
  readonly current_period_start?: number;
  readonly current_period_end?: number;
  readonly price?: { readonly id: string };
}

export interface StripeSubscription {
  readonly id: string;
  readonly object: 'subscription';
  readonly status:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused';
  readonly customer: string;
  readonly cancel_at_period_end: boolean;
  readonly cancel_at: number | null;
  readonly canceled_at: number | null;
  readonly livemode: boolean;
  readonly items?: { readonly data: readonly StripeSubscriptionItem[] };
  /** Removed from the Subscription object in current API versions; read via the item. */
  readonly current_period_end?: number;
  readonly metadata?: Record<string, string>;
}

export interface StripeRefund {
  readonly id: string;
  readonly object: 'refund';
  readonly amount: number;
  readonly currency: string;
  readonly charge: string | null;
  readonly payment_intent: string | null;
  readonly status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | null;
  readonly reason: string | null;
  readonly metadata?: Record<string, string>;
}

export interface StripeProduct {
  readonly id: string;
  readonly object: 'product';
  readonly name: string;
  readonly active: boolean;
  readonly livemode: boolean;
}

export interface StripePrice {
  readonly id: string;
  readonly object: 'price';
  readonly active: boolean;
  readonly currency: string;
  readonly unit_amount: number | null;
  readonly lookup_key: string | null;
  readonly product: string;
  readonly livemode: boolean;
  readonly recurring: { readonly interval: string; readonly interval_count: number } | null;
}

export interface StripeEventEnvelope {
  readonly id: string;
  readonly object: 'event';
  readonly api_version: string | null;
  readonly created: number;
  readonly livemode: boolean;
  readonly type: string;
  readonly data: { readonly object: Record<string, unknown> };
}

export interface StripeList<T> {
  readonly object: 'list';
  readonly data: readonly T[];
  readonly has_more: boolean;
  readonly url?: string;
}

/**
 * The service period end for a subscription.
 *
 * Current API versions put this on the subscription *item*; the legacy top-level field is
 * still present on events generated under an older account API version, so both are read.
 * Returns unix seconds, or `null` when neither is present.
 */
export function subscriptionPeriodEnd(subscription: StripeSubscription): number | null {
  const item = subscription.items?.data?.[0];
  if (item !== undefined && typeof item.current_period_end === 'number') {
    return item.current_period_end;
  }
  return typeof subscription.current_period_end === 'number'
    ? subscription.current_period_end
    : null;
}

/** The price id currently on a subscription, read from its first item. */
export function subscriptionPriceId(subscription: StripeSubscription): string | null {
  return subscription.items?.data?.[0]?.price?.id ?? null;
}

/**
 * The subscription id an invoice belongs to.
 *
 * Current API versions nest it under `parent.subscription_details.subscription`; older
 * ones put it at the top level. Both are read, and an expanded object (rather than an id
 * string) is unwrapped.
 */
export function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice['parent'];
  if (parent !== null && typeof parent === 'object') {
    const details = (parent as Record<string, unknown>)['subscription_details'];
    if (details !== null && typeof details === 'object') {
      const value = (details as Record<string, unknown>)['subscription'];
      const id = unwrapId(value);
      if (id !== null) return id;
    }
  }
  return unwrapId(invoice['subscription']);
}

function unwrapId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== null && typeof value === 'object') {
    const id = (value as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface StripeClientOptions {
  readonly secretKey: string;
  /** Injected in every test. Defaults to the ambient `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Overridable only so a test can point at a stub host; never customer input. */
  readonly apiBase?: string;
  readonly apiVersion?: string;
  readonly maxResponseBytes?: number;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: Record<string, FormValue>;
  readonly query?: Record<string, FormValue>;
  /** Required on every mutating call. Ignored by Stripe on GET/DELETE. */
  readonly idempotencyKey?: string;
}

export interface StripeClient {
  readonly environment: StripeEnvironment;
  createCustomer(params: CreateCustomerParams): Promise<StripeCustomer>;
  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<StripeCheckoutSession>;
  createBillingPortalSession(
    params: CreateBillingPortalSessionParams,
  ): Promise<StripeBillingPortalSession>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
  cancelSubscription(params: CancelSubscriptionParams): Promise<StripeSubscription>;
  createRefund(params: CreateRefundParams): Promise<StripeRefund>;
  listEvents(params?: ListEventsParams): Promise<StripeList<StripeEventEnvelope>>;
  ensureProductAndPrice(params: EnsureProductAndPriceParams): Promise<EnsureProductAndPriceResult>;
}

export interface CreateCustomerParams {
  readonly idempotencyKey: string;
  readonly email?: string;
  readonly name?: string;
  readonly metadata?: Record<string, string>;
}

export interface CreateCheckoutSessionParams {
  readonly idempotencyKey: string;
  /** Chosen server-side from approved configuration. Never a browser value. */
  readonly priceId: string;
  readonly customerId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Our workspace id. Comes back on the event so we can correlate. */
  readonly clientReferenceId: string;
  readonly metadata?: Record<string, string>;
  readonly subscriptionMetadata?: Record<string, string>;
}

export interface CreateBillingPortalSessionParams {
  readonly customerId: string;
  readonly returnUrl: string;
  readonly configurationId?: string;
}

export interface CancelSubscriptionParams {
  readonly subscriptionId: string;
  readonly idempotencyKey: string;
  /** `period_end` leaves the customer served until they stop paying for. */
  readonly when: 'immediately' | 'period_end';
  readonly comment?: string;
}

export interface CreateRefundParams {
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly paymentIntentId?: string;
  readonly chargeId?: string;
  /** Stripe's closed set. `requested_by_customer` is the only one we send in v1. */
  readonly reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  readonly metadata?: Record<string, string>;
}

export interface ListEventsParams {
  readonly types?: readonly string[];
  readonly createdGte?: number;
  readonly limit?: number;
  readonly startingAfter?: string;
}

export interface EnsureProductAndPriceParams {
  readonly idempotencyKey: string;
  readonly lookupKey: string;
  readonly productName: string;
  readonly productDescription?: string;
  readonly unitAmountMinor: number;
  readonly currency: 'gbp' | 'usd' | 'eur';
  readonly interval?: 'month' | 'year';
}

export interface EnsureProductAndPriceResult {
  readonly priceId: string;
  readonly productId: string;
  readonly created: boolean;
  readonly environment: StripeEnvironment;
  readonly unitAmountMinor: number;
  readonly currency: string;
}

/**
 * Build a client. Does no I/O; the first request happens when a method is called.
 */
export function createStripeClient(options: StripeClientOptions): StripeClient {
  const secretKey = options.secretKey;
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw new StripeError('configuration', 'Stripe secret key is missing.');
  }
  const environment = environmentForSecretKey(secretKey);
  const apiBase = options.apiBase ?? STRIPE_API_BASE;
  const apiVersion = options.apiVersion ?? STRIPE_API_VERSION;
  const maxResponseBytes = options.maxResponseBytes ?? STRIPE_MAX_RESPONSE_BYTES;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(opts: RequestOptions): Promise<T> {
    const url = `${apiBase}/v1${opts.path}${opts.query ? encodeQuery(opts.query) : ''}`;

    // Brief rule 8. The host is compiled in, but the check costs nothing and means a
    // mistyped base can never become an outbound request to somewhere else.
    const guarded = checkUrl(url, CONNECTOR_URL_GUARD_OPTIONS);
    if (!guarded.ok) {
      throw new StripeError('blocked_url', `Stripe request URL rejected: ${guarded.reason}`, {
        secret: secretKey,
      });
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      'stripe-version': apiVersion,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (opts.method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(opts.body ?? {});
      if (opts.idempotencyKey === undefined || opts.idempotencyKey.length === 0) {
        throw new StripeError(
          'configuration',
          `Refusing to send a mutating Stripe request without an Idempotency-Key: ${opts.path}`,
        );
      }
      // https://docs.stripe.com/api/idempotent_requests — keys are up to 255 characters.
      if (opts.idempotencyKey.length > 255) {
        throw new StripeError('configuration', 'Idempotency-Key exceeds 255 characters.');
      }
      headers['idempotency-key'] = opts.idempotencyKey;
    }

    let response: Response;
    try {
      response = await doFetch(guarded.url.href, {
        method: opts.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      throw new StripeError(
        'provider_unavailable',
        `Stripe request failed before a response: ${describe(cause)}`,
        { secret: secretKey },
      );
    }

    const requestId = response.headers.get('request-id');
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > maxResponseBytes) {
      throw new StripeError('response_too_large', 'Stripe response exceeded the size cap.', {
        httpStatus: response.status,
        requestId,
        secret: secretKey,
      });
    }

    const text = await response.text();
    if (text.length > maxResponseBytes) {
      throw new StripeError('response_too_large', 'Stripe response exceeded the size cap.', {
        httpStatus: response.status,
        requestId,
        secret: secretKey,
      });
    }

    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown);
    } catch {
      throw new StripeError('malformed_response', 'Stripe returned a body that is not JSON.', {
        httpStatus: response.status,
        requestId,
        secret: secretKey,
      });
    }

    if (!response.ok) throw toStripeError(response.status, parsed, requestId, secretKey);
    if (parsed === null || typeof parsed !== 'object') {
      throw new StripeError('malformed_response', 'Stripe returned a non-object body.', {
        httpStatus: response.status,
        requestId,
        secret: secretKey,
      });
    }
    return parsed as T;
  }

  function assertEnvironment(livemode: boolean, what: string): void {
    const objectEnvironment: StripeEnvironment = livemode ? 'live' : 'test';
    if (objectEnvironment !== environment) {
      throw new StripeError(
        'configuration',
        `Stripe returned a ${objectEnvironment}-mode ${what} to a ${environment}-mode key.`,
      );
    }
  }

  return {
    environment,

    async createCustomer(params) {
      const customer = await request<StripeCustomer>({
        method: 'POST',
        path: '/customers',
        idempotencyKey: params.idempotencyKey,
        body: {
          ...(params.email === undefined ? {} : { email: params.email }),
          ...(params.name === undefined ? {} : { name: params.name }),
          ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
        },
      });
      assertEnvironment(customer.livemode, 'customer');
      return customer;
    },

    async createCheckoutSession(params) {
      const session = await request<StripeCheckoutSession>({
        method: 'POST',
        path: '/checkout/sessions',
        idempotencyKey: params.idempotencyKey,
        body: {
          mode: 'subscription',
          customer: params.customerId,
          client_reference_id: params.clientReferenceId,
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          line_items: [{ price: params.priceId, quantity: 1 }],
          ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
          ...(params.subscriptionMetadata === undefined
            ? {}
            : { subscription_data: { metadata: params.subscriptionMetadata } }),
        },
      });
      assertEnvironment(session.livemode, 'checkout session');
      return session;
    },

    async createBillingPortalSession(params) {
      // A portal session is a read/manage surface, not a mutation of our own state, but
      // Stripe still accepts an idempotency key and sending one costs nothing.
      const session = await request<StripeBillingPortalSession>({
        method: 'POST',
        path: '/billing_portal/sessions',
        idempotencyKey: `portal:${params.customerId}:${params.returnUrl}`.slice(0, 255),
        body: {
          customer: params.customerId,
          return_url: params.returnUrl,
          ...(params.configurationId === undefined
            ? {}
            : { configuration: params.configurationId }),
        },
      });
      assertEnvironment(session.livemode, 'billing portal session');
      return session;
    },

    async retrieveSubscription(subscriptionId) {
      const subscription = await request<StripeSubscription>({
        method: 'GET',
        path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      });
      assertEnvironment(subscription.livemode, 'subscription');
      return subscription;
    },

    async cancelSubscription(params) {
      // https://docs.stripe.com/api/subscriptions/cancel — DELETE cancels now; setting
      // `cancel_at_period_end` on the update endpoint cancels at the end of the period.
      const subscription =
        params.when === 'immediately'
          ? await request<StripeSubscription>({
              method: 'DELETE',
              path: `/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
            })
          : await request<StripeSubscription>({
              method: 'POST',
              path: `/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
              idempotencyKey: params.idempotencyKey,
              body: {
                cancel_at_period_end: true,
                ...(params.comment === undefined
                  ? {}
                  : { cancellation_details: { comment: params.comment } }),
              },
            });
      assertEnvironment(subscription.livemode, 'subscription');
      return subscription;
    },

    async createRefund(params) {
      if (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0) {
        throw new StripeError('configuration', 'Refund amount must be a positive integer.');
      }
      if (
        (params.paymentIntentId === undefined) === (params.chargeId === undefined)
      ) {
        throw new StripeError(
          'configuration',
          'A refund needs exactly one of paymentIntentId or chargeId.',
        );
      }
      return request<StripeRefund>({
        method: 'POST',
        path: '/refunds',
        idempotencyKey: params.idempotencyKey,
        body: {
          amount: params.amountMinor,
          ...(params.paymentIntentId === undefined
            ? {}
            : { payment_intent: params.paymentIntentId }),
          ...(params.chargeId === undefined ? {} : { charge: params.chargeId }),
          ...(params.reason === undefined ? {} : { reason: params.reason }),
          ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
        },
      });
    },

    async listEvents(params = {}) {
      // https://docs.stripe.com/api/events/list — events go back up to 30 days, limit 1..100.
      return request<StripeList<StripeEventEnvelope>>({
        method: 'GET',
        path: '/events',
        query: {
          limit: Math.min(Math.max(params.limit ?? 25, 1), 100),
          ...(params.types === undefined ? {} : { types: params.types }),
          ...(params.createdGte === undefined ? {} : { created: { gte: params.createdGte } }),
          ...(params.startingAfter === undefined ? {} : { starting_after: params.startingAfter }),
        },
      });
    },

    /**
     * Bootstrap the plan's product and price, once.
     *
     * Idempotent through the price `lookup_key`: a second run finds the existing active
     * price and returns its id rather than creating a duplicate. That matters — two
     * prices for "the £29 plan" is exactly how a customer ends up on the wrong one.
     */
    async ensureProductAndPrice(params) {
      const existing = await request<StripeList<StripePrice>>({
        method: 'GET',
        path: '/prices',
        query: { lookup_keys: [params.lookupKey], active: 'true', limit: 2 },
      });
      const match = existing.data.find(
        (price) =>
          price.active &&
          price.lookup_key === params.lookupKey &&
          price.currency === params.currency &&
          price.unit_amount === params.unitAmountMinor,
      );
      if (match !== undefined) {
        assertEnvironment(match.livemode, 'price');
        return {
          priceId: match.id,
          productId: match.product,
          created: false,
          environment,
          unitAmountMinor: match.unit_amount ?? params.unitAmountMinor,
          currency: match.currency,
        };
      }
      if (existing.data.length > 0) {
        throw new StripeError(
          'configuration',
          `A price already uses lookup_key "${params.lookupKey}" with different terms. ` +
            'Refusing to create a second one; resolve it in the Stripe dashboard first.',
        );
      }

      const product = await request<StripeProduct>({
        method: 'POST',
        path: '/products',
        idempotencyKey: `${params.idempotencyKey}:product`,
        body: {
          name: params.productName,
          ...(params.productDescription === undefined
            ? {}
            : { description: params.productDescription }),
        },
      });
      assertEnvironment(product.livemode, 'product');

      const price = await request<StripePrice>({
        method: 'POST',
        path: '/prices',
        idempotencyKey: `${params.idempotencyKey}:price`,
        body: {
          product: product.id,
          currency: params.currency,
          unit_amount: params.unitAmountMinor,
          lookup_key: params.lookupKey,
          recurring: { interval: params.interval ?? 'month', interval_count: 1 },
        },
      });
      assertEnvironment(price.livemode, 'price');

      return {
        priceId: price.id,
        productId: product.id,
        created: true,
        environment,
        unitAmountMinor: price.unit_amount ?? params.unitAmountMinor,
        currency: price.currency,
      };
    },
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return typeof cause;
}

function toStripeError(
  status: number,
  parsed: unknown,
  requestId: string | null,
  secret: string,
): StripeError {
  let message = `Stripe returned HTTP ${status}.`;
  let code: string | null = null;
  if (parsed !== null && typeof parsed === 'object') {
    const error = (parsed as Record<string, unknown>)['error'];
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      if (typeof record['message'] === 'string') message = record['message'];
      if (typeof record['code'] === 'string') code = record['code'];
      else if (typeof record['type'] === 'string') code = record['type'];
    }
  }
  const kind: StripeFailureKind =
    status === 401 || status === 403
      ? 'authentication'
      : status === 404
        ? 'not_found'
        : status === 409
          ? 'idempotency_conflict'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'provider_unavailable'
              : 'invalid_request';
  return new StripeError(kind, message, {
    httpStatus: status,
    stripeCode: code,
    requestId,
    secret,
  });
}
