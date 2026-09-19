/**
 * The pure order machine and subscription reconciliation.
 *
 * These are the cases where getting it wrong is a chargeback rather than a 500, so they
 * are tested against the functions directly, with no database and no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_ORDER_STATUSES,
  asSubscriptionStatus,
  billingPeriodKey,
  entitlementFor,
  graceDeadline,
  orderTransition,
  providerModeMatches,
  reconcileSubscription,
  unixToIso,
  type ProviderSubscriptionSnapshot,
} from '@app/billing/state';
import type { SubscriptionRecord } from '@app/billing/port';

function storedSubscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: 'sub_row_1',
    workspaceId: 'ws_1',
    providerSubscriptionId: 'sub_provider_1',
    environment: 'test',
    status: 'active',
    priceId: 'price_1',
    currentPeriodEnd: '2026-10-19T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    providerEventCreated: 1_000,
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function incoming(
  overrides: Partial<ProviderSubscriptionSnapshot> = {},
): ProviderSubscriptionSnapshot {
  return {
    providerSubscriptionId: 'sub_provider_1',
    environment: 'test',
    status: 'active',
    priceId: 'price_1',
    currentPeriodEnd: '2026-10-19T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    providerEventCreated: 1_000,
    ...overrides,
  };
}

describe('order state machine', () => {
  it('BILL-001 a draft order that passes eligibility becomes compatible', () => {
    const result = orderTransition('draft', { kind: 'eligibility_passed' });
    expect(result).toEqual({ allowed: true, next: 'compatible' });
  });

  it('BILL-002 eligibility failure rejects the order before payment and carries the reason', () => {
    const result = orderTransition('draft', {
      kind: 'eligibility_failed',
      reason: 'hubspot_not_connected',
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('unreachable');
    expect(result.next).toBe('rejected');
    expect(result.rejectionReason).toBe('hubspot_not_connected');
  });

  it('BILL-003 a compatible order can start a checkout', () => {
    expect(
      orderTransition('compatible', { kind: 'checkout_created', checkoutSessionId: 'cs_1' }),
    ).toEqual({ allowed: true, next: 'checkout_created' });
  });

  it('BILL-004 a draft order cannot start a checkout without passing eligibility', () => {
    const result = orderTransition('draft', {
      kind: 'checkout_created',
      checkoutSessionId: 'cs_1',
    });
    expect(result.allowed).toBe(false);
  });

  it('BILL-005 payment success moves an open checkout to active', () => {
    expect(orderTransition('checkout_created', { kind: 'payment_succeeded' })).toEqual({
      allowed: true,
      next: 'active',
    });
  });

  it('BILL-006 a redelivered payment success on an active order is a no-op, not a rejection', () => {
    const result = orderTransition('active', { kind: 'payment_succeeded' });
    expect(result).toEqual({ allowed: true, next: 'active' });
  });

  it('BILL-007 an abandoned checkout expires', () => {
    expect(orderTransition('checkout_created', { kind: 'checkout_expired' })).toEqual({
      allowed: true,
      next: 'expired',
    });
  });

  it('BILL-008 an expired order cannot later be marked paid', () => {
    expect(orderTransition('expired', { kind: 'payment_succeeded' }).allowed).toBe(false);
  });

  it('BILL-009 an active order is cancelled when the subscription ends', () => {
    expect(orderTransition('active', { kind: 'subscription_cancelled' })).toEqual({
      allowed: true,
      next: 'cancelled',
    });
  });

  it('BILL-010 a cancelled order can still be refunded', () => {
    expect(orderTransition('cancelled', { kind: 'refund_succeeded' })).toEqual({
      allowed: true,
      next: 'refunded',
    });
  });

  it('BILL-011 a rejected order cannot jump straight to a checkout', () => {
    const result = orderTransition('rejected', {
      kind: 'checkout_created',
      checkoutSessionId: 'cs_1',
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.from).toBe('rejected');
  });

  it('BILL-012 a completed-but-unpaid checkout becomes payment_pending, never active', () => {
    expect(orderTransition('checkout_created', { kind: 'checkout_completed_unpaid' })).toEqual({
      allowed: true,
      next: 'payment_pending',
    });
  });

  it('BILL-013 the terminal order statuses are exactly the four that end the story', () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual([
      'cancelled',
      'expired',
      'refunded',
      'rejected',
    ]);
  });
});

describe('subscription reconciliation', () => {
  it('BILL-014 a subscription we have never seen is inserted', () => {
    expect(reconcileSubscription(null, incoming())).toEqual({
      action: 'insert',
      next: incoming(),
    });
  });

  it('BILL-015 a newer provider event is applied', () => {
    const decision = reconcileSubscription(
      storedSubscription({ providerEventCreated: 1_000 }),
      incoming({ status: 'past_due', providerEventCreated: 2_000 }),
    );
    expect(decision.action).toBe('apply');
  });

  it('BILL-016 an older provider event is ignored as stale', () => {
    const decision = reconcileSubscription(
      storedSubscription({ status: 'past_due', providerEventCreated: 2_000 }),
      incoming({ status: 'active', providerEventCreated: 1_000 }),
    );
    expect(decision).toEqual({ action: 'ignore_stale', storedEventCreated: 2_000 });
  });

  it('BILL-017 an identical redelivery changes nothing', () => {
    expect(reconcileSubscription(storedSubscription(), incoming())).toEqual({
      action: 'ignore_duplicate',
    });
  });

  it('BILL-018 a stale customer.subscription.updated cannot re-enable a cancelled subscription', () => {
    // The exact scenario from the brief: the deletion landed, then an older `updated`
    // carrying `active` arrives out of order.
    const decision = reconcileSubscription(
      storedSubscription({ status: 'canceled', providerEventCreated: 5_000 }),
      incoming({ status: 'active', providerEventCreated: 4_000 }),
    );
    expect(decision).toEqual({ action: 'ignore_terminal', storedStatus: 'canceled' });
  });

  it('BILL-019 a same-second update after a deletion cannot re-enable it either', () => {
    // Stripe warns that distinct events can share a `created` second, so the monotonic
    // guard alone would let this one through. The terminal guard is what stops it.
    const decision = reconcileSubscription(
      storedSubscription({ status: 'canceled', providerEventCreated: 5_000 }),
      incoming({ status: 'active', providerEventCreated: 5_000 }),
    );
    expect(decision.action).toBe('ignore_terminal');
  });

  it('BILL-020 even a later-timestamped update cannot re-enable a cancelled subscription', () => {
    const decision = reconcileSubscription(
      storedSubscription({ status: 'canceled', providerEventCreated: 5_000 }),
      incoming({ status: 'active', providerEventCreated: 9_999 }),
    );
    expect(decision.action).toBe('ignore_terminal');
  });

  it('BILL-021 a cancelled subscription still accepts a later cancelled snapshot', () => {
    const decision = reconcileSubscription(
      storedSubscription({ status: 'canceled', providerEventCreated: 5_000 }),
      incoming({ status: 'canceled', cancelAtPeriodEnd: true, providerEventCreated: 6_000 }),
    );
    expect(decision.action).toBe('apply');
  });

  it('BILL-022 a live-mode snapshot is refused against a test-mode row', () => {
    const decision = reconcileSubscription(
      storedSubscription({ environment: 'test' }),
      incoming({ environment: 'live', providerEventCreated: 9_000 }),
    );
    expect(decision).toEqual({ action: 'reject_environment_mismatch', storedEnvironment: 'test' });
  });

  it('BILL-023 a same-second event carrying a different period end is applied, not dropped', () => {
    const decision = reconcileSubscription(
      storedSubscription({ providerEventCreated: 1_000 }),
      incoming({ currentPeriodEnd: '2026-11-19T00:00:00.000Z', providerEventCreated: 1_000 }),
    );
    expect(decision.action).toBe('apply');
  });
});

describe('entitlement derived from provider evidence', () => {
  it('BILL-024 an active subscription admits new runs', () => {
    const view = entitlementFor(storedSubscription({ status: 'active' }));
    expect(view.level).toBe('serving');
    expect(view.admitsNewRuns).toBe(true);
  });

  it('BILL-025 a trialing subscription is served too', () => {
    expect(entitlementFor(storedSubscription({ status: 'trialing' })).level).toBe('serving');
  });

  it('BILL-026 a past_due subscription pauses new runs but keeps access and cancellation', () => {
    const view = entitlementFor(storedSubscription({ status: 'past_due' }));
    expect(view.level).toBe('paused_payment');
    expect(view.admitsNewRuns).toBe(false);
    expect(view.accountAccessible).toBe(true);
    expect(view.cancellationAvailable).toBe(true);
  });

  it('BILL-027 a cancelled subscription is not entitled', () => {
    const view = entitlementFor(storedSubscription({ status: 'canceled' }));
    expect(view.level).toBe('not_entitled');
    expect(view.admitsNewRuns).toBe(false);
  });

  it('BILL-028 no subscription at all is not entitled and the account is still reachable', () => {
    const view = entitlementFor(null);
    expect(view).toMatchObject({
      level: 'not_entitled',
      admitsNewRuns: false,
      accountAccessible: true,
      reason: 'no_subscription',
    });
  });

  it('BILL-029 a subscription set to cancel at period end is still served until then', () => {
    const view = entitlementFor(storedSubscription({ cancelAtPeriodEnd: true }));
    expect(view.level).toBe('serving');
    expect(view.reason).toBe('serving_until_period_end');
  });

  it('BILL-030 an unpaid subscription pauses rather than terminating access', () => {
    expect(entitlementFor(storedSubscription({ status: 'unpaid' })).level).toBe('paused_payment');
  });
});

describe('vocabulary and time helpers', () => {
  it('BILL-031 an unrecognised provider status is not coerced into the frozen vocabulary', () => {
    expect(asSubscriptionStatus('active')).toBe('active');
    expect(asSubscriptionStatus('super_active')).toBeNull();
    expect(asSubscriptionStatus(undefined)).toBeNull();
  });

  it('BILL-032 the allowance period key is the UTC date the period started', () => {
    expect(billingPeriodKey('2026-09-19T14:03:00.000Z')).toBe('2026-09-19');
  });

  it('BILL-033 a period key cannot be built from something that is not an instant', () => {
    expect(() => billingPeriodKey('September')).toThrow(TypeError);
  });

  it('BILL-034 unix seconds convert to an ISO instant and nothing else does', () => {
    expect(unixToIso(1_758_240_000)).toBe('2025-09-19T00:00:00.000Z');
    expect(unixToIso(null)).toBeNull();
    expect(unixToIso(undefined)).toBeNull();
  });

  it('BILL-035 the grace deadline runs from the failure, not from the period end', () => {
    expect(graceDeadline('2026-09-19T00:00:00.000Z', 7)).toBe('2026-09-26T00:00:00.000Z');
  });

  it('BILL-036 a test-mode event does not match a live configuration', () => {
    expect(providerModeMatches(false, 'test')).toBe(true);
    expect(providerModeMatches(true, 'live')).toBe(true);
    expect(providerModeMatches(false, 'live')).toBe(false);
    expect(providerModeMatches(true, 'test')).toBe(false);
  });
});
