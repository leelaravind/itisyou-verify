/**
 * `BillingGatewayPort` — the narrow slice of Stripe the orchestration layer is allowed to
 * reach for.
 *
 * Why a port rather than importing `packages/connectors/src/stripe.ts` directly: the
 * connector package's barrel (`src/index.ts`) is A04's and does not exist yet, so a direct
 * `@verify/connectors` import from `apps/app` would not resolve today. Beyond that, the
 * orchestration is easier to reason about when the only provider surface it can see is
 * seven methods, and every billing test injects a stub rather than a whole client.
 *
 * The connector's `StripeClient` satisfies this interface structurally. Wiring is one
 * line in the composition root:
 *
 * ```ts
 * const gateway: BillingGatewayPort = createStripeClient({ secretKey: env.STRIPE_SECRET_KEY });
 * ```
 */

export interface GatewayCustomer {
  readonly id: string;
  readonly livemode: boolean;
}

export interface GatewayCheckoutSession {
  readonly id: string;
  readonly url: string | null;
  readonly livemode: boolean;
}

export interface GatewayPortalSession {
  readonly id: string;
  readonly url: string;
  readonly livemode: boolean;
}

export interface GatewaySubscriptionItem {
  readonly current_period_end?: number;
  readonly price?: { readonly id: string };
}

export interface GatewaySubscription {
  readonly id: string;
  readonly status: string;
  readonly customer: string;
  readonly cancel_at_period_end: boolean;
  readonly livemode: boolean;
  readonly items?: { readonly data: readonly GatewaySubscriptionItem[] };
  readonly current_period_end?: number;
}

export interface GatewayRefund {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string | null;
}

export interface BillingGatewayPort {
  createCustomer(params: {
    readonly idempotencyKey: string;
    readonly email?: string;
    readonly metadata?: Record<string, string>;
  }): Promise<GatewayCustomer>;

  createCheckoutSession(params: {
    readonly idempotencyKey: string;
    readonly priceId: string;
    readonly customerId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
    readonly clientReferenceId: string;
    readonly metadata?: Record<string, string>;
    readonly subscriptionMetadata?: Record<string, string>;
  }): Promise<GatewayCheckoutSession>;

  createBillingPortalSession(params: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<GatewayPortalSession>;

  retrieveSubscription(subscriptionId: string): Promise<GatewaySubscription>;

  cancelSubscription(params: {
    readonly subscriptionId: string;
    readonly idempotencyKey: string;
    readonly when: 'immediately' | 'period_end';
  }): Promise<GatewaySubscription>;

  createRefund(params: {
    readonly idempotencyKey: string;
    readonly amountMinor: number;
    readonly paymentIntentId?: string;
    readonly chargeId?: string;
    readonly reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    readonly metadata?: Record<string, string>;
  }): Promise<GatewayRefund>;
}
