/**
 * The owner's refund control, through the live port, with a transport.
 *
 * ## Why this file exists
 *
 * The independent auditor found on 20 September 2026 that this control could not submit a
 * refund on any deployment. `decideRefund` requires exactly one of a payment intent or a
 * charge -- Stripe refunds a specific payment, never "a subscription" -- and the port
 * passed neither. Every attempt returned `REFUND_TARGET_REQUIRED` and left an orphan
 * `queued_for_owner` row that the owner's own control could not then action.
 *
 * No test caught it, and the reason is the important part: `D1OwnerDataPort` had no
 * injectable transport, so no test could reach the branch where it talks to Stripe at all.
 * The suite was green over a dead control. The port now accepts `fetchImpl`, which is what
 * makes this file possible, and the asymmetry with `customerPort` -- which always had one
 * -- is what let the two diverge unnoticed.
 *
 * Case ids `BILL-400..BILL-403`, `AUTH-480`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1OwnerDataPort } from '@app/db';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from './harness';

const NOW = new Date('2026-09-19T12:00:00.000Z');
// secret-scan:allow synthetic test-mode key; no account behind it
const STRIPE_KEY = `sk_test_${'0'.repeat(24)}`;
const PERIOD_END = '2026-10-19T00:00:00.000Z';

/** A real-shaped owner action context; the audit trail reads `principal.userId`. */
const CTX = {
  principal: { userId: 'usr_owner_x', email: 'owner@example.invalid', mfaRecent: true },
  capability: 'consequential',
  now: NOW,
  requestId: 'req_test_1',
} as never;

interface Captured {
  readonly url: string;
  readonly body: string;
}

function stripeStub(captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, body: String(init?.body ?? '') });
    return new Response(
      JSON.stringify({
        id: 're_test_1',
        object: 'refund',
        status: 'succeeded',
        amount: 4900,
        currency: 'gbp',
        livemode: false,
        payment_intent: 'pi_test_1',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

function port(h: TestDb, fetchImpl?: typeof fetch): D1OwnerDataPort {
  return new D1OwnerDataPort({
    db: h.db,
    env: {
      DB: h.db,
      ASSETS: { fetch: async () => new Response('', { status: 404 }) },
      ENVIRONMENT: 'test',
      PUBLIC_BASE_URL: 'https://verify.test',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_PRICE_ID: 'price_0000000000test',
    } as never,
    request: { headers: new Headers(), url: 'https://verify.test/owner/refunds' },
    now: NOW,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

/** A paid order and a subscription, with or without a recorded payment target. */
function seedPaidOrder(h: TestDb, ws: SeededWorkspace, paymentIntentId: string | null): void {
  h.raw
    .prepare(
      `INSERT INTO orders (id, workspace_id, status, price_id, amount_minor, currency, idempotency_key, created_at, updated_at)
       VALUES ('ord_1', ?, 'active', 'price_0000000000test', 4900, 'GBP', 'k1', ?, ?)`,
    )
    .run(ws.workspaceId, T0, T0);
  h.raw
    .prepare(
      `INSERT INTO subscriptions (id, workspace_id, provider_subscription_id, environment, status, price_id, current_period_end, cancel_at_period_end, provider_event_created, updated_at, latest_payment_intent_id, latest_payment_period_end)
       VALUES ('sub_1', ?, 'sub_p_1', 'test', 'active', 'price_0000000000test', ?, 0, 1, ?, ?, ?)`,
    )
    .run(
      ws.workspaceId,
      PERIOD_END,
      T0,
      paymentIntentId,
      paymentIntentId === null ? null : PERIOD_END,
    );
}

/**
 * A granted approval, so a case can reach the checks that come after authorisation.
 *
 * The hash is deliberately not the real one: `claimApproval` recomputes it and would
 * refuse. Every case using this stops before that point, which is the point -- the policy
 * rule must be rejected before anything is claimed, not after.
 */
function seedApproval(h: TestDb, ws: SeededWorkspace, id = 'apr_1'): void {
  h.raw
    .prepare(
      `INSERT INTO users (id, auth_subject, created_at, is_platform_owner)
       VALUES ('usr_owner_x', 'owner@example.invalid', ?, 1)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(T0);
  h.raw
    .prepare(
      `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency, status, created_at, expires_at)
       VALUES (?, 'usr_owner_x', 'refund_issue', 'not-the-real-hash', 4900, 'GBP', 'granted', ?, ?)`,
    )
    .run(id, T0, '2027-01-01T00:00:00.000Z');
  void ws;
}

let h: TestDb;
let ws: SeededWorkspace;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'alpha');
});
afterEach(() => {
  h.close();
});

describe('the owner refund control reaches the provider', () => {
  it('BILL-400 with no recorded payment target it refuses, spends nothing and creates no refund row', async () => {
    seedPaidOrder(h, ws, null);
    // A granted approval, so the refusal cannot come from authorisation. Without this the
    // case stops at the approval lookup and never reaches the target check at all -- which
    // is how the first version of this test passed against the very defect it names.
    seedApproval(h, ws);
    const captured: Captured[] = [];

    const result = await port(h, stripeStub(captured)).issueRefund(CTX, {
      workspaceId: ws.workspaceId,
      orderId: 'ord_1',
      amountMinor: 4900,
      policyRule: 'goodwill_owner_discretion',
      reason: 'the connection never worked',
      approvalId: 'apr_1',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/payment to refund against/i);
    // The orphan row is the part that made the old behaviour worse than a plain refusal.
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM refunds').get() as { n: number }).n).toBe(0);
    expect(captured).toEqual([]);
  });

  it('BILL-401 the refusal happens before any provider call', async () => {
    seedPaidOrder(h, ws, null);
    seedApproval(h, ws);
    const captured: Captured[] = [];
    await port(h, stripeStub(captured)).issueRefund(CTX, {
      workspaceId: ws.workspaceId,
      orderId: 'ord_1',
      amountMinor: 4900,
      policyRule: 'goodwill_owner_discretion',
      reason: 'x',
      approvalId: 'apr_1',
    });
    // The old code reached `requestRefund` first and left a queued row behind.
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM refunds').get() as { n: number }).n).toBe(0);
    expect(captured, 'nothing may be sent to Stripe when we cannot complete the refund').toEqual(
      [],
    );
  });

  it('BILL-402 an unpublished policy rule is refused rather than hashed into an approval', async () => {
    seedPaidOrder(h, ws, 'pi_test_1');
    seedApproval(h, ws);
    const captured: Captured[] = [];

    const result = await port(h, stripeStub(captured)).issueRefund(CTX, {
      workspaceId: ws.workspaceId,
      orderId: 'ord_1',
      amountMinor: 4900,
      // Not one of REFUND_POLICY_RULES. It used to be cast straight into the union.
      policyRule: 'because_i_said_so',
      reason: 'x',
      approvalId: 'apr_1',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/published refund policy rule/i);
    expect(captured).toEqual([]);
  });

  it('AUTH-480 a refund for an order in another workspace touches nothing', async () => {
    seedPaidOrder(h, ws, 'pi_test_1');
    seedApproval(h, ws);
    const other = seedWorkspace(h, 'beta');
    const captured: Captured[] = [];

    const result = await port(h, stripeStub(captured)).issueRefund(CTX, {
      workspaceId: other.workspaceId,
      orderId: 'ord_1',
      amountMinor: 4900,
      policyRule: 'goodwill_owner_discretion',
      reason: 'x',
      approvalId: 'apr_1',
    });

    expect(result.ok).toBe(false);
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM refunds').get() as { n: number }).n).toBe(0);
    expect(captured).toEqual([]);
  });
});
