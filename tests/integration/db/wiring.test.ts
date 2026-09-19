/**
 * Three things that were built and reached by nothing.
 *
 * The pattern the auditor named: correct code, thoroughly tested, never on a real path.
 * The tests passed because they called the function directly. So every case here starts
 * from the **caller a request actually goes through** — `usage()`, the billing port's own
 * methods, and A06's `decideRefund` — rather than from the primitive underneath.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { allowancePeriodKey, isAllowancePeriodKey } from '@app/billing/period';
import { decideRefund, refundApprovalPayload } from '@app/billing/refunds';
import { grantOwnerApproval } from '@app/owner/approvals';
import { buildBillingConfig } from '@app/billing/config';
import { systemClock } from '@app/billing/runtime';
import {
  D1BillingDataPort,
  D1CustomerDataPort,
  createRefundApprovalConsumer,
  entitlements,
} from '@app/db';
import { calendarMonthNotAnAllowanceKey } from '@app/db/customerPort';
import { issueSignInToken, redeemSignInToken } from '@app/lib/auth';
import type { Env } from '@app/lib/context';
import { countRows, createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');
/** A customer who subscribed on the 19th, so a calendar month is eleven days wrong. */
const PERIOD_END = '2026-10-19T09:00:00.000Z';
const PERIOD_KEY = '2026-10-19';

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    STRIPE_MODE: 'test',
    ...overrides,
  };
}

/** Sign a member of `ws` in and hand back a port bound to that session. */
async function customerPort(h: TestDb, ws: SeededWorkspace): Promise<D1CustomerDataPort> {
  const issued = await issueSignInToken(h.db, { email: `${ws.workspaceId}@example.com`, now: NOW });
  const redeemed = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
  if (!redeemed.ok) throw new Error('fixture sign-in failed');
  // The seeded member owns the workspace; sign in as them.
  h.raw.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(ws.userId, redeemed.session.sessionId);
  return new D1CustomerDataPort({
    db: h.db,
    env: env(),
    request: {
      headers: new Headers({ cookie: `verify_session=${redeemed.session.sessionValue}` }),
      url: 'http://localhost:8787/app/usage',
    },
    now: NOW,
  });
}

function seedSubscription(h: TestDb, ws: SeededWorkspace): void {
  h.raw
    .prepare(
      `INSERT INTO subscriptions (id, workspace_id, provider_subscription_id, environment, status, current_period_end, provider_event_created, updated_at)
       VALUES (?, ?, ?, 'test', 'active', ?, 1000, ?)`,
    )
    .run(`sub_${ws.workspaceId}`, ws.workspaceId, `sub_stripe_${ws.workspaceId}`, PERIOD_END, T0);
}

describe('the customer usage page reads the row billing actually wrote', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha', { billingPeriod: PERIOD_KEY, runLimit: 500 });
    seedSubscription(h, ws);
  });
  afterEach(() => {
    h.close();
  });

  it('BILL-260 usage() resolves the key from the subscription, not from the calendar', async () => {
    // Billing wrote this row. Before the fix, usage() looked up '2026-09' and found nothing.
    h.raw
      .prepare('UPDATE entitlements SET consumed = 120, reserved = 5 WHERE workspace_id = ? AND billing_period = ?')
      .run(ws.workspaceId, PERIOD_KEY);

    const port = await customerPort(h, ws);
    const view = await port.usage();

    // 125 used, not the 0 the calendar-month key reported forever.
    expect(view.runsUsed).toBe(125);
    expect(view.runsIncluded).toBe(500);
    expect(view.subscriptionStatus).toBe('active');
    expect(view.periodEnd).toBe(PERIOD_END);
  });

  it('BILL-261 a customer at their limit is reported blocked, which is the bug that mattered', async () => {
    h.raw
      .prepare('UPDATE entitlements SET consumed = 500 WHERE workspace_id = ? AND billing_period = ?')
      .run(ws.workspaceId, PERIOD_KEY);
    const view = await (await customerPort(h, ws)).usage();
    // The old behaviour: 0 used, 500 remaining, unblocked — while admission refused them.
    expect(view.runsUsed).toBe(500);
    expect(view.admissionBlocked).toBe(true);
  });

  it('BILL-262 with no subscription there is no paid period, and none is invented', async () => {
    h.raw.prepare('DELETE FROM subscriptions').run();
    const view = await (await customerPort(h, ws)).usage();
    expect(view.runsUsed).toBe(0);
    expect(view.admissionBlocked).toBe(false);
    expect(view.subscriptionStatus).toBeNull();
  });

  it('BILL-263 the old calendar-month function is renamed and is not an allowance key', () => {
    const wrong = calendarMonthNotAnAllowanceKey(NOW);
    expect(wrong).toBe('2026-09');
    // The whole finding in one line: this shape never matches a row billing wrote.
    expect(isAllowancePeriodKey(wrong)).toBe(false);
    expect(isAllowancePeriodKey(allowancePeriodKey(PERIOD_END))).toBe(true);
    expect(wrong).not.toBe(PERIOD_KEY);
  });
});

describe('the D1 billing port refuses a wrong period key loudly', () => {
  let h: TestDb;
  let ws: SeededWorkspace;
  let port: D1BillingDataPort;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha', { billingPeriod: PERIOD_KEY, runLimit: 2 });
    port = new D1BillingDataPort(h.db);
  });
  afterEach(() => {
    h.close();
  });

  it('BILL-264 every allowance method throws on a YYYY-MM key rather than missing silently', async () => {
    const wrong = '2026-09';
    // A silent miss is how A13-010 survived review. A crash in a test beats a
    // quietly-unbilled customer in production.
    await expect(port.findAllowance(ws.workspaceId, wrong)).rejects.toBeInstanceOf(AppError);
    await expect(port.reserveRun(ws.workspaceId, wrong, T0)).rejects.toBeInstanceOf(AppError);
    await expect(port.settleReservedRun(ws.workspaceId, wrong, T0)).rejects.toBeInstanceOf(AppError);
    await expect(port.releaseReservedRun(ws.workspaceId, wrong, T0)).rejects.toBeInstanceOf(AppError);
    await expect(
      port.openAllowancePeriod({
        id: 'ent_x',
        workspaceId: ws.workspaceId,
        billingPeriod: wrong,
        planVersion: 1,
        runLimit: 500,
        consumed: 0,
        reserved: 0,
        updatedAt: T0,
      }),
    ).rejects.toBeInstanceOf(AppError);
    // Nothing was written by any of the refusals.
    expect((await entitlements.get(h.db, ws.workspaceId, PERIOD_KEY))?.reserved).toBe(0);
    expect(countRows(h, 'entitlements')).toBe(1);
  });

  it('BILL-265 a correct key still works end to end through the port', async () => {
    expect(await port.reserveRun(ws.workspaceId, PERIOD_KEY, T0)).toBe(true);
    expect((await port.findAllowance(ws.workspaceId, PERIOD_KEY))?.reserved).toBe(1);
    expect(await port.settleReservedRun(ws.workspaceId, PERIOD_KEY, T0)).toBe(true);
    expect(await port.findAllowance(ws.workspaceId, PERIOD_KEY)).toMatchObject({
      reserved: 0,
      consumed: 1,
    });
  });
});

describe('decideRefund reaches the D1 approval store', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  const config = buildBillingConfig({
    environment: 'test',
    priceId: 'price_abc123',
    publicBaseUrl: 'https://verify.itisyou.app',
  });

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha', { billingPeriod: PERIOD_KEY });
    h.raw
      .prepare(
        `INSERT INTO users (id, auth_subject, is_platform_owner, created_at)
         VALUES ('usr_owner', 'owner@example.com', 1, ?)`,
      )
      .run(T0);
    h.raw
      .prepare(
        `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency, status, note, created_at, expires_at)
         VALUES ('apr_1', 'usr_owner', 'refund_issue', 'hash', 2900, 'GBP', 'granted', 'note', ?, ?)`,
      )
      .run(T0, '2026-09-20T10:00:00.000Z');
  });
  afterEach(() => {
    h.close();
  });

  function seedRefund(id: string): void {
    h.raw
      .prepare(
        `INSERT INTO refunds (id, workspace_id, order_id, amount_minor, currency, state, idempotency_key, created_at, updated_at)
         VALUES (?, ?, NULL, 2900, 'GBP', 'queued_for_owner', ?, ?, ?)`,
      )
      .run(id, ws.workspaceId, `refund:${id}`, T0, T0);
  }

  it('BILL-270 the consumer spends the approval and records which refund spent it', async () => {
    seedRefund('ref_1');
    const consume = createRefundApprovalConsumer(h.db, { workspaceId: ws.workspaceId, now: () => NOW });
    const approval = { id: 'apr_1' } as Parameters<typeof consume>[0]['approval'];

    expect(await consume({ approval, refundId: 'ref_1' })).toBe(true);

    const row = h.raw.prepare('SELECT status, consumed_at FROM approvals WHERE id = ?').get('apr_1') as {
      status: string;
      consumed_at: string;
    };
    expect(row.status).toBe('consumed');
    expect(row.consumed_at).toBe(NOW.toISOString());
    const refund = h.raw.prepare('SELECT approval_id FROM refunds WHERE id = ?').get('ref_1') as {
      approval_id: string;
    };
    expect(refund.approval_id).toBe('apr_1');
  });

  it('BILL-271 the documented retry for the SAME refund succeeds', async () => {
    seedRefund('ref_1');
    const consume = createRefundApprovalConsumer(h.db, { workspaceId: ws.workspaceId, now: () => NOW });
    const approval = { id: 'apr_1' } as Parameters<typeof consume>[0]['approval'];

    expect(await consume({ approval, refundId: 'ref_1' })).toBe(true);
    // The transport failed and the owner retried. Refusing here would make the documented
    // retry impossible to complete.
    expect(await consume({ approval, refundId: 'ref_1' })).toBe(true);
    expect(await consume({ approval, refundId: 'ref_1' })).toBe(true);
  });

  it('BILL-272 a DIFFERENT refund reaching for the spent approval is refused', async () => {
    seedRefund('ref_1');
    seedRefund('ref_2');
    const consume = createRefundApprovalConsumer(h.db, { workspaceId: ws.workspaceId, now: () => NOW });
    const approval = { id: 'apr_1' } as Parameters<typeof consume>[0]['approval'];

    expect(await consume({ approval, refundId: 'ref_1' })).toBe(true);
    expect(await consume({ approval, refundId: 'ref_2' })).toBe(false);
    // And the second refund was never stamped with somebody else's approval.
    const refund = h.raw.prepare('SELECT approval_id FROM refunds WHERE id = ?').get('ref_2') as {
      approval_id: string | null;
    };
    expect(refund.approval_id).toBeNull();
  });

  it('BILL-273 two concurrent refunds racing one approval: exactly one wins', async () => {
    seedRefund('ref_1');
    seedRefund('ref_2');
    const consume = createRefundApprovalConsumer(h.db, { workspaceId: ws.workspaceId, now: () => NOW });
    const approval = { id: 'apr_1' } as Parameters<typeof consume>[0]['approval'];
    const results = await Promise.all([
      consume({ approval, refundId: 'ref_1' }),
      consume({ approval, refundId: 'ref_2' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('BILL-274 decideRefund itself reaches this store, before the provider call', async () => {
    seedRefund('ref_1');
    const order: string[] = [];
    const data = new D1BillingDataPort(h.db);

    // A real approval over the real payload, so `checkOwnerApproval` passes and the call
    // genuinely travels the path a refund takes rather than stopping at a validation.
    const refund = await data.findRefund(ws.workspaceId, 'ref_1');
    if (refund === null) throw new Error('fixture refund missing');
    const approval = await grantOwnerApproval(
      refundApprovalPayload(refund, 'goodwill_owner_discretion'),
      {
        id: 'apr_1',
        owner_id: 'usr_owner',
        maximum_amount_minor: 2900,
        currency: 'GBP',
        summary: 'Refund the September charge.',
        created_at: T0,
        expires_at: '2026-09-20T10:00:00.000Z',
      },
    );
    h.raw
      .prepare('UPDATE approvals SET canonical_payload_hash = ? WHERE id = ?')
      .run(approval.canonical_payload_hash, 'apr_1');

    // The interleaving is recorded as data: a future reordering fails this case loudly.
    const consumeApproval = async (params: {
      approval: { id: string };
      refundId: string;
    }): Promise<boolean> => {
      order.push('consume');
      return createRefundApprovalConsumer(h.db, {
        workspaceId: ws.workspaceId,
        now: () => NOW,
      })(params as Parameters<ReturnType<typeof createRefundApprovalConsumer>>[0]);
    };

    const gateway = {
      createRefund: async () => {
        order.push('gateway');
        return { id: 're_1', status: 'succeeded' as const, amountMinor: 2900, currency: 'GBP' };
      },
    };

    await decideRefund(
      {
        config,
        data,
        gateway: gateway as never,
        now: systemClock,
        newId: (prefix: string) => `${prefix}_test`,
      },
      {
        workspaceId: ws.workspaceId,
        refundId: 'ref_1',
        decision: 'approve',
        approval,
        policyRule: 'goodwill_owner_discretion',
        consumeApproval: consumeApproval as never,
        paymentIntentId: 'pi_1',
      },
    ).catch(() => {
      /* the gateway stub is minimal; what matters is the ordering below */
    });

    // The approval is spent, and it was spent BEFORE the provider was called.
    expect(order[0]).toBe('consume');
    const row = h.raw.prepare('SELECT status FROM approvals WHERE id = ?').get('apr_1') as {
      status: string;
    };
    expect(row.status).toBe('consumed');
  });
});
