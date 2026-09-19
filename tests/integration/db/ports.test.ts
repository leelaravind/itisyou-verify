/**
 * The three ports against real D1 statements.
 *
 * The point of these cases is that the tenant boundary holds **through the port**, not
 * merely through the repository underneath. A05's `CustomerDataPort` takes no workspace
 * id anywhere, so this is directly provable: build a port bound to workspace A's session
 * and ask it for workspace B's ids. Every answer must be empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@verify/security';
import {
  D1BillingDataPort,
  D1CustomerDataPort,
  D1RateLimiter,
  D1SupportDataPort,
  EXPORT_PAGE_COLUMNS,
  entitlements,
  webhookReceipts,
} from '@app/db';
import { EXPORT_COLUMNS } from '@app/privacy/export';
import { EXPORT_SECTION } from '@app/support/port';
import type { Env } from '@app/lib/context';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  T0,
  type SeededWorkspace,
  type TestDb,
} from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');
/** A paid period that ends on the 19th. Never a calendar month — see A13-010. */
const ALLOWANCE_PERIOD = '2026-10-19';
const LATER = '2026-09-19T11:00:00.000Z';

function fakeEnv(db: unknown): Env {
  return {
    DB: db as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    STRIPE_MODE: 'test',
  };
}

/** Sign a workspace's user in and return a port bound to that session. */
async function signIn(h: TestDb, ws: SeededWorkspace): Promise<D1CustomerDataPort> {
  const cookieValue = `session-value-for-${ws.workspaceId}`;
  const idHash = await hashToken(cookieValue, 'session');
  h.raw
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(idHash, ws.userId, T0, '2026-09-20T10:00:00.000Z', T0);

  return new D1CustomerDataPort({
    db: h.db,
    env: fakeEnv(h.db),
    request: {
      // http origin, so the cookie is the unprefixed development name (see lib/session.ts)
      headers: new Headers({ cookie: `verify_session=${cookieValue}` }),
      url: 'http://localhost:8787/app/runs',
    },
    now: NOW,
  });
}

/* -------------------------------------------------------------------------- */

describe('CustomerDataPort against D1', () => {
  let h: TestDb;
  let a: SeededWorkspace;
  let b: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    a = seedWorkspace(h, 'alpha');
    b = seedWorkspace(h, 'beta');
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-240 resolves the workspace from the session, never from a parameter', async () => {
    const port = await signIn(h, a);
    const session = await port.session();
    expect(session?.workspaceId).toBe(a.workspaceId);
    expect(session?.email).toBe('alpha@example.com');
    expect(session?.role).toBe('workspace_admin');
    expect(port.synthetic).toBe(false);
    // A fresh CSRF token per render, never a stored one.
    const again = await port.session();
    expect(again?.csrfToken).not.toBe(session?.csrfToken);
  });

  it('AUTH-241 no signed-in session means no data at all, not a default workspace', async () => {
    const port = new D1CustomerDataPort({
      db: h.db,
      env: fakeEnv(h.db),
      request: { headers: new Headers(), url: 'http://localhost:8787/app' },
      now: NOW,
    });
    expect(await port.session()).toBeNull();
    expect(await port.workflow()).toBeNull();
    expect(await port.workflows()).toEqual([]);
    expect(await port.connections()).toEqual([]);
    expect((await port.listRuns({ limit: 10 })).items).toEqual([]);
    expect(await port.run('run_alpha_1')).toBeNull();
    expect((await port.usage()).runsUsed).toBe(0);
  });

  it('AUTH-242 a port bound to workspace A returns nothing for workspace B’s run id', async () => {
    seedRun(h, a, 'run_alpha_1', { nextCheckAt: null });
    seedRun(h, b, 'run_beta_1', { nextCheckAt: null });

    const portA = await signIn(h, a);
    expect(await portA.run('run_alpha_1')).not.toBeNull();
    // The boundary, through the port: B's run id is simply not there.
    expect(await portA.run('run_beta_1')).toBeNull();

    const portB = await signIn(h, b);
    expect(await portB.run('run_beta_1')).not.toBeNull();
    expect(await portB.run('run_alpha_1')).toBeNull();
  });

  it('AUTH-243 listRuns never leaks another tenant’s row', async () => {
    seedRun(h, a, 'run_alpha_1', { nextCheckAt: null });
    seedRun(h, a, 'run_alpha_2', { nextCheckAt: null });
    seedRun(h, b, 'run_beta_1', { nextCheckAt: null });

    const portA = await signIn(h, a);
    const page = await portA.listRuns({ limit: 50 });
    expect(page.items.map((r) => r.id).sort()).toEqual(['run_alpha_1', 'run_alpha_2']);
    expect(page.items.some((r) => r.id.includes('beta'))).toBe(false);
  });

  it('AUTH-244 the workflow, connections and usage views are all A’s only', async () => {
    h.raw
      .prepare(
        `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at, external_account_id)
         VALUES ('conn_b', ?, 'hubspot', 'ready', '[]', ?, 'hub-beta-account')`,
      )
      .run(b.workspaceId, T0);

    const portA = await signIn(h, a);
    const detail = await portA.workflow();
    expect(detail?.id).toBe(a.workflowId);

    // B's connection is ready; A's view must still say not_connected for both providers.
    const conns = await portA.connections();
    expect(conns.map((c) => c.status)).toEqual(['not_connected', 'not_connected']);
    expect(JSON.stringify(conns)).not.toContain('hub-beta-account');

    await entitlements.settleReservation(h.db, b.workspaceId, b.billingPeriod, T0);
    const usage = await portA.usage();
    expect(usage.runsUsed).toBe(0);
  });

  it('AUTH-245 a support request cannot link to another tenant’s run', async () => {
    seedRun(h, b, 'run_beta_1', { nextCheckAt: null });
    const portA = await signIn(h, a);
    const result = await portA.submitSupportRequest({
      subject: 'Something looks wrong',
      body: 'The acknowledgement email never showed up for this enquiry.',
      runId: 'run_beta_1',
    });
    expect(result.ok).toBe(true);
    expect(result.reference).not.toBeNull();
    const stored = h.raw
      .prepare('SELECT workspace_id, linked_run_id FROM support_cases WHERE id = ?')
      .get(result.reference as string) as { workspace_id: string; linked_run_id: string | null };
    expect(stored.workspace_id).toBe(a.workspaceId);
    // Dropped rather than stored: a support case must not become a pointer to B's run.
    expect(stored.linked_run_id).toBeNull();
  });

  it('API-240 refuses honestly where it cannot act, and never claims a charge', async () => {
    const port = await signIn(h, a);

    const checkout = await port.createCheckout();
    expect(checkout.ok).toBe(false);
    expect(checkout.message).toContain('no card was charged');

    const connect = await port.beginConnection('hubspot');
    expect(connect.ok).toBe(false);
    expect(connect.message).toContain('No authorisation was started');

    const proof = await port.runProof();
    expect(proof.ran).toBe(false);
    expect(proof.blockedReason).not.toBeNull();
    expect(proof.results).toEqual([]);

    const portal = await port.billingPortalLink();
    expect(portal.href).toBeNull();
    expect(portal.reason).not.toBeNull();

    const link = await port.requestSignInLink('ada@example.com');
    expect(link.ok).toBe(false);
    expect(link.message).toContain('No sign-in link was sent');
  });

  it('API-241 orderSummary resolves price and allowance server-side and lists real blockers', async () => {
    const port = await signIn(h, a);
    const summary = await port.orderSummary();
    expect(summary.priceDisplay).toBe('£29.00');
    expect(summary.runsIncluded).toBe(500);
    expect(summary.ready).toBe(false);
    expect(summary.blockers).toContain('Connect HubSpot so we can read the CRM record.');
    expect(summary.blockers).toContain('Payments are not enabled in this environment.');
  });

  it('AUTH-246 signing out revokes the session, and the port stops answering', async () => {
    const port = await signIn(h, a);
    expect(await port.session()).not.toBeNull();
    const result = await port.signOut();
    expect(result.ok).toBe(true);
    expect(countRows(h, 'sessions', 'revoked_at IS NOT NULL')).toBe(1);
    expect(await port.session()).toBeNull();
    expect(await port.run('run_alpha_1')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('BillingDataPort against D1', () => {
  let h: TestDb;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  let port: D1BillingDataPort;

  const order = (workspaceId: string, id: string, key: string) => ({
    id,
    workspaceId,
    status: 'draft' as const,
    rejectionReason: null,
    priceId: 'price_1',
    amountMinor: 2900,
    currency: 'GBP',
    checkoutSessionId: null,
    idempotencyKey: key,
    createdAt: T0,
    updatedAt: T0,
  });

  beforeEach(() => {
    h = createTestDb();
    // An allowance period key is the paid period END (`YYYY-MM-DD`), never a calendar
    // month. The port now throws on a `YYYY-MM`, which is the A13-010 guard doing its job.
    a = seedWorkspace(h, 'alpha', { runLimit: 2, billingPeriod: ALLOWANCE_PERIOD });
    b = seedWorkspace(h, 'beta', { runLimit: 2, billingPeriod: ALLOWANCE_PERIOD });
    port = new D1BillingDataPort(h.db);
  });
  afterEach(() => {
    h.close();
  });

  it('PERSIST-240 reserveRun is one conditional statement that stops at the limit', async () => {
    expect(await port.reserveRun(a.workspaceId, a.billingPeriod, T0)).toBe(true);
    expect(await port.reserveRun(a.workspaceId, a.billingPeriod, T0)).toBe(true);
    // run_limit is 2; the third has nothing to take.
    expect(await port.reserveRun(a.workspaceId, a.billingPeriod, T0)).toBe(false);
    expect((await port.findAllowance(a.workspaceId, a.billingPeriod))?.reserved).toBe(2);
  });

  it('PERSIST-241 two concurrent reserveRun calls for the last unit: exactly one wins', async () => {
    const tight = seedWorkspace(h, 'tight', { runLimit: 1, billingPeriod: ALLOWANCE_PERIOD });
    const [first, second] = await Promise.all([
      port.reserveRun(tight.workspaceId, tight.billingPeriod, T0),
      port.reserveRun(tight.workspaceId, tight.billingPeriod, T0),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await port.findAllowance(tight.workspaceId, tight.billingPeriod))?.reserved).toBe(1);
  });

  it('AUTH-250 allowance, orders and refunds are scoped to their own workspace', async () => {
    await port.openOrderOnce(order(a.workspaceId, 'ord_a', 'key-a'));
    expect(await port.findOrder(a.workspaceId, 'ord_a')).not.toBeNull();
    expect(await port.findOrder(b.workspaceId, 'ord_a')).toBeNull();
    expect(await port.listOrdersForWorkspace(b.workspaceId, 10)).toEqual([]);

    // Reserving against A must not move B.
    await port.reserveRun(a.workspaceId, a.billingPeriod, T0);
    expect((await port.findAllowance(b.workspaceId, b.billingPeriod))?.reserved).toBe(0);

    expect(
      await port.recordOrderStatus({
        workspaceId: b.workspaceId,
        orderId: 'ord_a',
        status: 'active',
        at: LATER,
      }),
    ).toBeNull();
    expect((await port.findOrder(a.workspaceId, 'ord_a'))?.status).toBe('draft');
  });

  it('PERSIST-242 openOrderOnce inserts once per idempotency key', async () => {
    const first = await port.openOrderOnce(order(a.workspaceId, 'ord_1', 'same-key'));
    const second = await port.openOrderOnce(order(a.workspaceId, 'ord_2', 'same-key'));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.order.id).toBe('ord_1');
    expect(countRows(h, 'orders')).toBe(1);
  });

  it('PERSIST-243 openRefundOnce inserts once and never refunds twice', async () => {
    const refund = {
      id: 'ref_1',
      workspaceId: a.workspaceId,
      orderId: null,
      providerRefundId: null,
      amountMinor: 2900,
      currency: 'GBP',
      state: 'requested' as const,
      reason: 'duplicate charge',
      idempotencyKey: 'refund-key',
      approvalId: null,
      createdAt: T0,
      updatedAt: T0,
    };
    const first = await port.openRefundOnce(refund);
    const second = await port.openRefundOnce({ ...refund, id: 'ref_2' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.refund.id).toBe('ref_1');
    expect(countRows(h, 'refunds')).toBe(1);
    expect((await port.findRefundByIdempotencyKey('refund-key'))?.id).toBe('ref_1');
  });

  it('PERSIST-244 rememberBillingCustomer never rebinds an existing mapping', async () => {
    const first = await port.rememberBillingCustomer({
      workspaceId: a.workspaceId,
      stripeCustomerId: 'cus_first',
      environment: 'test',
      createdAt: T0,
    });
    const second = await port.rememberBillingCustomer({
      workspaceId: a.workspaceId,
      stripeCustomerId: 'cus_second',
      environment: 'test',
      createdAt: LATER,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // The second customer would be an orphan holding a card; the binding must not move.
    expect(second.customer.stripeCustomerId).toBe('cus_first');
    expect((await port.findBillingCustomer(a.workspaceId, 'test'))?.stripeCustomerId).toBe(
      'cus_first',
    );
    expect(
      (await port.findWorkspaceForBillingCustomer('cus_first', 'test'))?.workspaceId,
    ).toBe(a.workspaceId);
    expect(await port.findWorkspaceForBillingCustomer('cus_second', 'test')).toBeNull();
  });

  it('PERSIST-245 a stale provider event cannot re-enable a cancelled subscription', async () => {
    const base = {
      id: 'sub_1',
      workspaceId: a.workspaceId,
      providerSubscriptionId: 'sub_stripe_1',
      environment: 'test' as const,
      status: 'active' as const,
      priceId: 'price_1',
      currentPeriodEnd: LATER,
      cancelAtPeriodEnd: false,
      reconciledAt: null,
      providerEventCreated: 1000,
      updatedAt: T0,
    };
    await port.saveSubscriptionSnapshot(base);
    // A later event cancels it.
    await port.saveSubscriptionSnapshot({
      ...base,
      status: 'canceled',
      providerEventCreated: 2000,
      updatedAt: LATER,
    });
    expect((await port.findSubscriptionByProviderId('sub_stripe_1', 'test'))?.status).toBe(
      'canceled',
    );

    // Stripe does not guarantee ordering: an older 'active' event arrives afterwards.
    const afterStale = await port.saveSubscriptionSnapshot({
      ...base,
      status: 'active',
      providerEventCreated: 1500,
      updatedAt: '2026-09-19T12:00:00.000Z',
    });
    expect(afterStale.status).toBe('canceled');
    expect((await port.findSubscriptionForWorkspace(a.workspaceId, 'test'))?.status).toBe(
      'canceled',
    );
  });

  it('PERSIST-246 an event at the same provider timestamp is applied, not dropped', async () => {
    const base = {
      id: 'sub_1',
      workspaceId: a.workspaceId,
      providerSubscriptionId: 'sub_stripe_1',
      environment: 'test' as const,
      status: 'active' as const,
      priceId: 'price_1',
      currentPeriodEnd: LATER,
      cancelAtPeriodEnd: false,
      reconciledAt: null,
      providerEventCreated: 1000,
      updatedAt: T0,
    };
    await port.saveSubscriptionSnapshot(base);
    const same = await port.saveSubscriptionSnapshot({
      ...base,
      status: 'past_due',
      providerEventCreated: 1000,
      updatedAt: LATER,
    });
    // Stripe records `created` in whole seconds, so two events can share one. Dropping
    // the second would lose a real state change.
    expect(same.status).toBe('past_due');
  });

  it('PERSIST-247 a crashed handler can be retried; a completed one cannot', async () => {
    const claim = () =>
      port.beginWebhookProcessing({
        receiptId: 'whr_1',
        provider: 'stripe',
        eventId: 'evt_1',
        payloadHash: 'hash',
        receivedAt: T0,
      });

    expect((await claim()).outcome).toBe('fresh');
    // A retry while the first delivery is still working: do nothing.
    expect((await claim()).outcome).toBe('in_flight');

    // The handler threw. Giving the receipt back is what makes Stripe's retry a fresh
    // attempt rather than a deduplicated no-op that swallows a paid invoice.
    await port.abandonWebhookProcessing('evt_1');
    expect(countRows(h, 'webhook_receipts')).toBe(0);
    expect((await claim()).outcome).toBe('fresh');

    await port.completeWebhookProcessing('whr_1', 'processed', a.workspaceId);
    expect((await claim()).outcome).toBe('already_processed');

    const receipt = await webhookReceipts.getByEventId(h.db, 'stripe', 'evt_1');
    expect(receipt?.processing_status).toBe('processed');
    expect(receipt?.workspace_id).toBe(a.workspaceId);
  });

  it('PERSIST-248 four concurrent deliveries of one event produce exactly one fresh claim', async () => {
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd'].map((s) =>
        port.beginWebhookProcessing({
          receiptId: `whr_${s}`,
          provider: 'stripe',
          eventId: 'evt_dup',
          payloadHash: 'hash',
          receivedAt: T0,
        }),
      ),
    );
    expect(outcomes.filter((o) => o.outcome === 'fresh')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'in_flight')).toHaveLength(3);
    expect(countRows(h, 'webhook_receipts')).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('SupportDataPort against D1', () => {
  let h: TestDb;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  let port: D1SupportDataPort;

  const supportCase = (workspaceId: string | null, id: string, at = T0) => ({
    id,
    workspaceId,
    contactEmail: 'ada@example.com',
    subject: 'Enquiry never verified',
    bodyRedacted: 'The a**@example.com enquiry did not verify.',
    category: 'unexpected_result' as const,
    priority: 'normal' as const,
    state: 'open' as const,
    linkedRunId: null,
    createdAt: at,
    updatedAt: at,
  });

  beforeEach(() => {
    h = createTestDb();
    a = seedWorkspace(h, 'alpha');
    b = seedWorkspace(h, 'beta');
    port = new D1SupportDataPort(h.db);
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-260 a case is invisible to another workspace, and to the anonymous scope', async () => {
    await port.insertCase(supportCase(a.workspaceId, 'sup_a'));
    expect(await port.getCase('sup_a', a.workspaceId)).not.toBeNull();
    expect(await port.getCase('sup_a', b.workspaceId)).toBeNull();
    expect(await port.getCase('sup_a', null)).toBeNull();
    // The owner queue is the documented exception.
    expect(await port.getCaseForOwner('sup_a')).not.toBeNull();
  });

  it('AUTH-261 listCases scopes to one workspace, to anonymous, or to all for the owner', async () => {
    await port.insertCase(supportCase(a.workspaceId, 'sup_a'));
    await port.insertCase(supportCase(b.workspaceId, 'sup_b'));
    await port.insertCase(supportCase(null, 'sup_anon'));

    expect(
      (await port.listCases({ workspaceId: a.workspaceId, limit: 10 })).items.map((c) => c.id),
    ).toEqual(['sup_a']);
    expect((await port.listCases({ workspaceId: null, limit: 10 })).items.map((c) => c.id)).toEqual([
      'sup_anon',
    ]);
    expect((await port.listCases({ limit: 10 })).items).toHaveLength(3);
  });

  it('PERSIST-260 transitionCase carries the expected state, so only one caller wins', async () => {
    await port.insertCase(supportCase(a.workspaceId, 'sup_a'));
    const results = await Promise.all([
      port.transitionCase({
        id: 'sup_a',
        workspaceId: a.workspaceId,
        expectedState: 'open',
        nextState: 'answered',
        updatedAt: LATER,
      }),
      port.transitionCase({
        id: 'sup_a',
        workspaceId: a.workspaceId,
        expectedState: 'open',
        nextState: 'escalated',
        updatedAt: LATER,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await port.getCase('sup_a', a.workspaceId);
    expect(['answered', 'escalated']).toContain(stored?.state);
  });

  it('AUTH-262 a transition cannot be applied from another workspace', async () => {
    await port.insertCase(supportCase(a.workspaceId, 'sup_a'));
    expect(
      await port.transitionCase({
        id: 'sup_a',
        workspaceId: b.workspaceId,
        expectedState: 'open',
        nextState: 'closed',
        updatedAt: LATER,
      }),
    ).toBe(false);
    expect((await port.getCase('sup_a', a.workspaceId))?.state).toBe('open');
  });

  it('PERSIST-261 claimNotification inserts once and returns the existing row on a duplicate', async () => {
    const params = {
      id: 'ntf_1',
      workspaceId: a.workspaceId,
      notificationKey: 'run-failed:run_1',
      channel: 'email' as const,
      recipientHash: 'hash',
      template: 'run_failed',
      createdAt: T0,
    };
    const first = await port.claimNotification(params);
    const second = await port.claimNotification({ ...params, id: 'ntf_2' });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    // The caller's next line sends an email; it must see the row that already exists.
    expect(second.record.id).toBe('ntf_1');
    expect(countRows(h, 'notification_deliveries')).toBe(1);
  });

  it('PERSIST-262 concurrent claims of one key yield exactly one sender', async () => {
    const claims = await Promise.all(
      ['a', 'b', 'c'].map((s) =>
        port.claimNotification({
          id: `ntf_${s}`,
          workspaceId: a.workspaceId,
          notificationKey: 'digest:2026-09-19',
          channel: 'email',
          recipientHash: 'hash',
          template: 'digest',
          createdAt: T0,
        }),
      ),
    );
    expect(claims.filter((c) => c.inserted)).toHaveLength(1);
    expect(new Set(claims.map((c) => c.record.id)).size).toBe(1);
  });

  it('PERSIST-263 settleNotification records the provider word and only stamps sent_at on sent', async () => {
    await port.claimNotification({
      id: 'ntf_1',
      workspaceId: a.workspaceId,
      notificationKey: 'k1',
      channel: 'email',
      recipientHash: 'hash',
      template: 'run_failed',
      createdAt: T0,
    });
    await port.settleNotification({
      notificationKey: 'k1',
      state: 'failed',
      attemptCount: 1,
      providerStatus: '502 from provider',
      settledAt: LATER,
    });
    let stored = await port.getNotification('k1');
    expect(stored?.state).toBe('failed');
    expect(stored?.sentAt).toBeNull();

    await port.settleNotification({
      notificationKey: 'k1',
      state: 'sent',
      attemptCount: 2,
      providerStatus: 'accepted',
      settledAt: LATER,
    });
    stored = await port.getNotification('k1');
    expect(stored?.state).toBe('sent');
    expect(stored?.sentAt).toBe(LATER);
    // 'accepted' is the sending service's word, never a delivery claim.
    expect(stored?.providerStatus).toBe('accepted');
  });

  it('PERSIST-264 listExpired is a resumable keyset scan, never an OFFSET', async () => {
    for (let i = 1; i <= 5; i += 1) {
      h.raw
        .prepare(
          `INSERT INTO evidence (id, workspace_id, run_id, provider, origin, observed_at, content_digest, redacted_summary, expires_at)
           VALUES (?, ?, ?, 'hubspot', 'provider_readback', ?, 'd', '{}', ?)`,
        )
        .run(`evd_${i}`, a.workspaceId, seedRunOnce(h, a, i), T0, '2026-09-01T00:00:00.000Z');
    }

    const first = await port.listExpired({
      target: 'evidence',
      expiredAt: T0,
      afterId: null,
      limit: 2,
    });
    expect(first.map((r) => r.id)).toEqual(['evd_1', 'evd_2']);

    const second = await port.listExpired({
      target: 'evidence',
      expiredAt: T0,
      afterId: 'evd_2',
      limit: 2,
    });
    expect(second.map((r) => r.id)).toEqual(['evd_3', 'evd_4']);
    expect(second.every((r) => r.workspaceId === a.workspaceId)).toBe(true);

    // Deleting the page it just read does not shift the next page, which is the whole
    // reason a sweep must not use OFFSET.
    expect(await port.deleteRows('evidence', ['evd_3', 'evd_4'])).toBe(2);
    const third = await port.listExpired({
      target: 'evidence',
      expiredAt: T0,
      afterId: 'evd_4',
      limit: 2,
    });
    expect(third.map((r) => r.id)).toEqual(['evd_5']);
  });

  it('PERSIST-265 listExpired handles the tables keyed by something other than id', async () => {
    h.raw
      .prepare('INSERT INTO rate_limits (bucket, window_start, count, expires_at) VALUES (?, ?, 1, ?)')
      .run('events:ws_a', T0, '2026-09-01T00:00:00.000Z');
    h.raw
      .prepare(
        "INSERT INTO login_tokens (token_hash, email, purpose, created_at, expires_at) VALUES (?, 'ada@example.com', 'signin', ?, ?)",
      )
      .run('tokenhash', T0, '2026-09-01T00:00:00.000Z');

    const buckets = await port.listExpired({
      target: 'rate_limits',
      expiredAt: T0,
      afterId: null,
      limit: 10,
    });
    expect(buckets.map((r) => r.id)).toEqual(['events:ws_a']);
    expect(buckets[0]?.workspaceId).toBeNull();
    expect(await port.deleteRows('rate_limits', ['events:ws_a'])).toBe(1);

    const tokens = await port.listExpired({
      target: 'login_tokens',
      expiredAt: T0,
      afterId: null,
      limit: 10,
    });
    expect(tokens.map((r) => r.id)).toEqual(['tokenhash']);
    expect(await port.deleteRows('login_tokens', ['tokenhash'])).toBe(1);
    expect(countRows(h, 'login_tokens')).toBe(0);
  });

  it('AUTH-263 a workspace purge removes only that workspace’s rows', async () => {
    seedRun(h, a, 'run_a', { nextCheckAt: null });
    seedRun(h, b, 'run_b', { nextCheckAt: null });
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 100)).toBe(1);
    expect(countRows(h, 'source_events', 'workspace_id = ?', b.workspaceId)).toBe(1);
    // And the cascade took A's run with it.
    expect(countRows(h, 'runs', 'workspace_id = ?', a.workspaceId)).toBe(0);
    expect(countRows(h, 'runs', 'workspace_id = ?', b.workspaceId)).toBe(1);
  });

  it('PERSIST-280 the NO ACTION foreign key on runs.workflow_version_id is real', async () => {
    seedRun(h, a, 'run_a', { nextCheckAt: null });
    // `runs.workflow_version_id` references `workflow_versions(id)` with no ON DELETE
    // clause, so it defaults to NO ACTION. Removing a version out from under a live run
    // is refused. This case exists so nobody reads that missing clause as decorative.
    await expect(
      h.db
        .prepare('DELETE FROM workflow_versions WHERE workspace_id = ? AND id = ?')
        .bind(a.workspaceId, a.workflowVersionId)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
    expect(countRows(h, 'workflow_versions', 'workspace_id = ?', a.workspaceId)).toBe(1);
  });

  it('PERSIST-284 purging workflows first does NOT abort — it silently strands source events', async () => {
    seedRun(h, a, 'run_a', { nextCheckAt: null });

    // The failure mode here is not the one the ordering rule is usually described by.
    // Deleting `workflows` first SUCCEEDS: the cascade on `runs.workflow_id` removes the
    // runs, which removes the last reference to the workflow versions, so the NO ACTION
    // constraint proved in PERSIST-280 is never reached.
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'workflows', 100)).toBe(1);
    expect(countRows(h, 'runs', 'workspace_id = ?', a.workspaceId)).toBe(0);
    expect(countRows(h, 'workflow_versions', 'workspace_id = ?', a.workspaceId)).toBe(0);

    // …and `source_events` is left behind, because it has no foreign key to `workflows` —
    // only to `workspaces`. A customer's enquiry payloads survive a deletion that reported
    // success. That is why A09's step order is load-bearing: not because the wrong order
    // aborts loudly, but because it completes quietly and leaves data the email promised
    // to remove.
    expect(countRows(h, 'source_events', 'workspace_id = ?', a.workspaceId)).toBe(1);

    // The sweep still removes it when run afterwards, so a deletion that used the wrong
    // order is recoverable — but only if somebody notices.
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 100)).toBe(1);
    expect(countRows(h, 'source_events', 'workspace_id = ?', a.workspaceId)).toBe(0);
  });

  it('PERSIST-281 the foreign-key order A09 sequences actually completes', async () => {
    seedRun(h, a, 'run_a', { nextCheckAt: null });
    seedRun(h, b, 'run_b', { nextCheckAt: null });

    // Exactly A09's step order: source events first (cascading to runs, attempts,
    // assertions and evidence), then workflows, then connections, then memberships.
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 100)).toBe(1);
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'workflows', 100)).toBe(1);
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'memberships', 100)).toBe(1);

    expect(countRows(h, 'workflows', 'workspace_id = ?', a.workspaceId)).toBe(0);
    expect(countRows(h, 'workflow_versions', 'workspace_id = ?', a.workspaceId)).toBe(0);
    expect(countRows(h, 'runs', 'workspace_id = ?', a.workspaceId)).toBe(0);
    expect(countRows(h, 'memberships', 'workspace_id = ?', a.workspaceId)).toBe(0);

    // The other tenant is entirely untouched.
    expect(countRows(h, 'workflows', 'workspace_id = ?', b.workspaceId)).toBe(1);
    expect(countRows(h, 'workflow_versions', 'workspace_id = ?', b.workspaceId)).toBe(1);
    expect(countRows(h, 'runs', 'workspace_id = ?', b.workspaceId)).toBe(1);
    expect(countRows(h, 'memberships', 'workspace_id = ?', b.workspaceId)).toBe(1);
  });

  it('PERSIST-282 purging connections cascades to the stored credential envelopes', async () => {
    for (const [ws, suffix] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      h.raw
        .prepare(
          `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at)
           VALUES (?, ?, 'hubspot', 'ready', '[]', ?)`,
        )
        .run(`conn_${suffix}`, ws.workspaceId, T0);
      h.raw
        .prepare(
          `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
           VALUES (?, ?, ?, 1, 'Y2lwaGVy', 'bm9uY2U=', 'v1|kv=1|ws=x', ?)`,
        )
        .run(`cred_${suffix}`, `conn_${suffix}`, `connection:conn_${suffix}`, T0);
    }
    expect(countRows(h, 'credential_versions')).toBe(2);

    expect(await port.purgeWorkspaceRows(a.workspaceId, 'connections', 100)).toBe(1);

    // This cascade is what makes "the credentials you gave us are deleted" a true
    // sentence rather than a hopeful one, so it is asserted rather than assumed.
    expect(countRows(h, 'connections', 'workspace_id = ?', a.workspaceId)).toBe(0);
    expect(countRows(h, 'credential_versions', 'id = ?', 'cred_a')).toBe(0);
    expect(countRows(h, 'credential_versions', 'id = ?', 'cred_b')).toBe(1);
  });

  it('PERSIST-283 a purge is bounded and resumable, and reports zero when done', async () => {
    for (let i = 1; i <= 5; i += 1) seedRun(h, a, `run_${i}`, { nextCheckAt: null });
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 2)).toBe(2);
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 2)).toBe(2);
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 2)).toBe(1);
    // Zero is the caller's stop signal.
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'source_events', 2)).toBe(0);
    expect(await port.purgeWorkspaceRows(a.workspaceId, 'connections', 10)).toBe(0);
  });

  it('API-260 every export section returns exactly the declared columns, in order', async () => {
    for (const section of EXPORT_SECTION) {
      const page = await port.readExportPage({
        workspaceId: a.workspaceId,
        section,
        cursor: null,
        limit: 10,
      });
      // Both sides of the contract: what this port produces, and what export.ts demands.
      expect(page.columns, section).toEqual(EXPORT_PAGE_COLUMNS[section]);
      expect(page.columns, section).toEqual(EXPORT_COLUMNS[section]);
      for (const row of page.rows) expect(row.length, section).toBe(page.columns.length);
    }
  });

  it('AUTH-264 an export page for workspace A contains no row belonging to B', async () => {
    seedRun(h, a, 'run_a', { nextCheckAt: null });
    seedRun(h, b, 'run_b', { nextCheckAt: null });
    await port.insertCase(supportCase(b.workspaceId, 'sup_b'));

    const runsPage = await port.readExportPage({
      workspaceId: a.workspaceId,
      section: 'runs',
      cursor: null,
      limit: 50,
    });
    expect(runsPage.rows.map((r) => r[0])).toEqual(['run_a']);
    expect(runsPage.rows.every((r) => r[1] === a.workspaceId)).toBe(true);

    const casesPage = await port.readExportPage({
      workspaceId: a.workspaceId,
      section: 'support_cases',
      cursor: null,
      limit: 50,
    });
    expect(casesPage.rows).toEqual([]);

    const workspacePage = await port.readExportPage({
      workspaceId: a.workspaceId,
      section: 'workspace',
      cursor: null,
      limit: 50,
    });
    expect(workspacePage.rows).toHaveLength(1);
    expect(workspacePage.rows[0]?.[0]).toBe(a.workspaceId);
  });

  it('PERSIST-266 export pages walk the whole section with a keyset cursor', async () => {
    for (let i = 1; i <= 5; i += 1) seedRun(h, a, `run_${i}`, { nextCheckAt: null });
    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const result = await port.readExportPage({
        workspaceId: a.workspaceId,
        section: 'runs',
        cursor,
        limit: 2,
      });
      seen.push(...result.rows.map((r) => r[0]));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['run_1', 'run_2', 'run_3', 'run_4', 'run_5']);
    expect(cursor).toBeNull();
  });

  it('PERSIST-267 deletion stops scheduled work, revokes access and reports what is kept', async () => {
    seedRun(h, a, 'run_a', { nextCheckAt: T0 });
    h.raw
      .prepare(
        `INSERT INTO outbox (id, workspace_id, event_type, entity_id, unique_event_key, payload_json, dispatch_state, next_attempt_at, created_at)
         VALUES ('obx_a', ?, 'run.created', 'run_a', 'run.created:run_a', '{}', 'pending', ?, ?)`,
      )
      .run(a.workspaceId, T0, T0);
    h.raw
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, is_automation)
         VALUES ('sess_a', ?, ?, ?, ?, 0)`,
      )
      .run(a.userId, T0, '2026-09-20T10:00:00.000Z', T0);
    h.raw
      .prepare(
        `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at)
         VALUES ('conn_a', ?, 'hubspot', 'ready', '[]', ?)`,
      )
      .run(a.workspaceId, T0);
    h.raw
      .prepare(
        `INSERT INTO credential_versions (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at)
         VALUES ('cred_a', 'conn_a', 'connection:conn_a', 1, 'Y2lwaGVy', 'bm9uY2U=', 'v1|kv=1|ws=x', ?)`,
      )
      .run(T0);
    h.raw
      .prepare(
        `INSERT INTO orders (id, workspace_id, status, idempotency_key, created_at, updated_at)
         VALUES ('ord_a', ?, 'active', 'k', ?, ?)`,
      )
      .run(a.workspaceId, T0, T0);

    expect(await port.stopScheduledWork(a.workspaceId)).toBe(2);
    expect(countRows(h, 'runs', 'workspace_id = ? AND next_check_at IS NULL', a.workspaceId)).toBe(1);
    expect(countRows(h, 'outbox', "dispatch_state = 'dead'")).toBe(1);
    expect(await port.revokeSessions(a.workspaceId)).toBe(1);
    expect(await port.revokeCredentials(a.workspaceId)).toBe(1);
    expect(await port.expireReportLinks(a.workspaceId)).toBe(0);
    expect(await port.scheduleEvidenceRemoval(a.workspaceId, T0)).toBe(0);

    expect(await port.markWorkspaceDeleted(a.workspaceId, LATER)).toBe(true);
    // Idempotent: a resumed deletion must not report failure.
    expect(await port.markWorkspaceDeleted(a.workspaceId, LATER)).toBe(true);
    expect((await port.getWorkspace(a.workspaceId))?.status).toBe('deleted');

    const retained = await port.countRetained(a.workspaceId);
    expect(retained.billingRecords).toBe(1);
    expect(retained.auditEvents).toBe(0);
  });

  it('PERSIST-268 checkpoints make an interrupted sweep resumable', async () => {
    expect(await port.readCheckpoint('evidence')).toBeNull();
    await port.writeCheckpoint('evidence', 'evd_42');
    expect(await port.readCheckpoint('evidence')).toBe('evd_42');
    await port.writeCheckpoint('evidence', 'evd_99');
    expect(await port.readCheckpoint('evidence')).toBe('evd_99');
    await port.writeCheckpoint('evidence', null);
    expect(await port.readCheckpoint('evidence')).toBeNull();
  });

  it('API-261 the rate-limit adapter satisfies A09 s RateLimiter', async () => {
    const limiter = new D1RateLimiter(h.db);
    expect(await limiter.consume('support:form', 2, 60, NOW)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await limiter.consume('support:form', 2, 60, NOW);
    const denied = await limiter.consume('support:form', 2, 60, NOW);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });
});

/** Seed a run for an evidence fixture, once per index. */
function seedRunOnce(h: TestDb, ws: SeededWorkspace, i: number): string {
  const id = `run_ev_${i}`;
  seedRun(h, ws, id, { nextCheckAt: null });
  return id;
}
