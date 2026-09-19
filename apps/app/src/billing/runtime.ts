/**
 * The non-business collaborators every billing orchestration needs: a clock, an id
 * factory, a data port, a provider gateway and the approved configuration.
 *
 * Passing the clock and the id factory in rather than calling `Date.now()` and
 * `crypto.randomUUID()` inline is what makes the idempotency keys deterministic in a test
 * and the out-of-order scenarios reproducible.
 */
import type { BillingConfig } from './config';
import type { BillingGatewayPort } from './gateway';
import type { BillingDataPort } from './port';

/** Returns an ISO-8601 UTC instant. */
export type BillingClock = () => string;

/** Returns a fresh opaque id for the given entity prefix (`ord`, `sub`, `ref`, …). */
export type BillingIdFactory = (prefix: string) => string;

/**
 * Whether a workspace is technically able to be served, checked *before* payment.
 *
 * Owned outside billing — the connection and workflow state belongs to A02/A05. Billing
 * only asks the question and refuses to take money when the answer is no. `reason` is
 * shown to the customer, so it must be something they can act on.
 */
export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reason?: string;
  readonly detail?: string;
}

export type EligibilityCheck = (workspaceId: string) => Promise<EligibilityResult>;

/**
 * Who to tell when a payment fails. Owned outside billing — identity and workspace names
 * are A02's and A05's. Optional: when it is absent, or returns null, the money paths still
 * do their work and simply produce no notification request. A missing address must never
 * stop a subscription being suspended correctly.
 */
export type BillingContactLookup = (workspaceId: string) => Promise<{
  readonly email: string;
  readonly workspaceName: string;
} | null>;

export interface BillingRuntime {
  readonly config: BillingConfig;
  readonly data: BillingDataPort;
  readonly gateway: BillingGatewayPort;
  readonly now: BillingClock;
  readonly newId: BillingIdFactory;
  readonly billingContact?: BillingContactLookup;
}

/** A real clock. Kept here so no orchestration file reaches for `Date` itself. */
export const systemClock: BillingClock = () => new Date().toISOString();
