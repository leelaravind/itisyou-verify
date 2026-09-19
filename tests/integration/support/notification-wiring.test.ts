/**
 * Does a real request, or a real scheduled tick, cause a notification to be sent?
 *
 * Every test in this file answers that question and nothing else. `notifications.test.ts`
 * next door already proves the sender is correct — at-most-once on the key, bounded
 * retries, never claiming delivery — by calling `sendNotification` directly. That is
 * exactly why the defect survived: twelve templates and a proven sender, and **no caller**.
 * `templates.ts` says so in its own header, audited 2026-09-19: *"no template in this file
 * has a live send path"*.
 *
 * So nothing here calls `sendNotification`, `deliverNotifications` or
 * `runBillingMaintenance`. Each test starts from the outside — a signed Stripe delivery to
 * the mounted route, or `handleScheduled`, which is the export the Worker's `scheduled()`
 * handler calls — and finishes by reading `notification_deliveries` out of a real SQLite
 * database with the real migrations applied.
 *
 * The transport is a stub `fetch`. No test in this repository may send a real email, and
 * `tests/setup.ts` blocks the global anyway; `fetchImpl` is injected so the *real*
 * `ResendEmailTransport` is the code under test rather than a mock standing in for it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildBillingConfig } from '@app/billing/config';
import { D1BillingDataPort, createBillingContactLookup } from '@app/db/billingPort';
import { D1SupportDataPort } from '@app/db/supportPort';
import { createNotificationDelivery } from '@app/notifications/delivery';
import { createStripeWebhookRoute } from '@app/routes/webhooks/stripe';
import { handleScheduled } from '@app/scheduler/index';
import { createTestDb, seedWorkspace, type TestDb } from '../db/harness';
import {
  OPAQUE_ID,
  WEBHOOK_SECRET,
  createStubGateway,
  invoiceObject,
  signedDelivery,
  stripeEvent,
  subscriptionObject,
} from '../billing/harness';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Assembled at runtime, never written as a literal. This repository is public and a
 * credential-shaped string is rejected by `scripts/scan-secrets.mjs` and by GitHub push
 * protection — see `docs/agent-brief.md`. The values are identical; they just stop looking
 * like credentials.
 */
const RESEND_KEY = ['re', 'test', '0'.repeat(24)].join('_');
const STRIPE_KEY = ['sk', 'test', '0'.repeat(24)].join('_');
const FROM_ADDRESS = 'verify@example.test';

const PATH = `/api/v1/webhooks/stripe/${OPAQUE_ID}`;
const SUBSCRIPTION_ID = 'sub_notif_1';
const CUSTOMER_ID = 'cus_notif_1';
const PRICE_ID = 'price_planv1stub';

/** The end of the period the customer actually paid for. The recovery window's anchor. */
const PERIOD_END = '2026-09-25T00:00:00.000Z';
const PERIOD_END_UNIX = Math.floor(Date.parse(PERIOD_END) / 1000);

let dbs: TestDb[] = [];

afterEach(() => {
  for (const h of dbs) h.close();
  dbs = [];
});

interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly from: string;
}

/** A `fetch` that accepts every submission and records what was actually posted. */
function recordingFetch(sent: SentEmail[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({
      to: String((body['to'] as string[] | undefined)?.[0] ?? ''),
      subject: String(body['subject'] ?? ''),
      text: String(body['text'] ?? ''),
      html: String(body['html'] ?? ''),
      from: String(body['from'] ?? ''),
    });
    void input;
    return new Response(JSON.stringify({ id: 'msg_stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

interface Scene {
  readonly h: TestDb;
  readonly workspaceId: string;
  readonly billingData: D1BillingDataPort;
  readonly sent: SentEmail[];
  readonly clock: { value: string };
  /** Deliver a signed Stripe event to the mounted route. */
  deliver(event: Record<string, unknown>): Promise<Response>;
  /** Rows in `notification_deliveries`, read straight out of SQLite. */
  notificationRows(): Record<string, unknown>[];
  entitlementRows(): Record<string, unknown>[];
  subscriptionRow(): Record<string, unknown> | undefined;
}

async function scene(
  options: { readonly subscriptionStatus?: string; readonly startAt?: string } = {},
): Promise<Scene> {
  const h = createTestDb();
  dbs.push(h);
  const ws = seedWorkspace(h, 'notif');
  const billingData = new D1BillingDataPort(h.db);
  const supportPort = new D1SupportDataPort(h.db);
  const clock = { value: options.startAt ?? '2026-09-26T09:00:00.000Z' };
  const sent: SentEmail[] = [];

  await billingData.rememberBillingCustomer({
    workspaceId: ws.workspaceId,
    stripeCustomerId: CUSTOMER_ID,
    environment: 'test',
    createdAt: clock.value,
  });
  await billingData.saveSubscriptionSnapshot({
    id: 'sub_row_1',
    workspaceId: ws.workspaceId,
    providerSubscriptionId: SUBSCRIPTION_ID,
    environment: 'test',
    status: (options.subscriptionStatus ?? 'active') as 'active',
    priceId: PRICE_ID,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    providerEventCreated: 1_700_000_000,
    updatedAt: clock.value,
  });

  const counters = new Map<string, number>();
  const route = createStripeWebhookRoute({
    config: buildBillingConfig({
      environment: 'test',
      priceId: PRICE_ID,
      publicBaseUrl: 'https://verify.itisyou.example',
    }),
    data: billingData,
    gateway: createStubGateway(),
    now: () => clock.value,
    newId: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${String(next).padStart(4, '0')}`;
    },
    billingContact: createBillingContactLookup(h.db),
    resolveEndpointSecret: async (id) => (id === OPAQUE_ID ? WEBHOOK_SECRET : null),
    // The real factory and the real Resend transport. Only the socket is a stub.
    notifications: createNotificationDelivery(
      { RESEND_API_KEY: RESEND_KEY, RESEND_FROM_ADDRESS: FROM_ADDRESS },
      supportPort,
      { fetchImpl: recordingFetch(sent), now: () => new Date(clock.value) },
    ),
  });

  return {
    h,
    workspaceId: ws.workspaceId,
    billingData,
    sent,
    clock,
    async deliver(event) {
      const { body, headers } = await signedDelivery(event, clock.value, WEBHOOK_SECRET);
      return route.request(PATH, { method: 'POST', headers, body });
    },
    notificationRows() {
      return h.raw.prepare('SELECT * FROM notification_deliveries ORDER BY id').all() as Record<
        string,
        unknown
      >[];
    },
    entitlementRows() {
      return h.raw
        .prepare('SELECT * FROM entitlements WHERE workspace_id = ? ORDER BY billing_period')
        .all(ws.workspaceId) as Record<string, unknown>[];
    },
    subscriptionRow() {
      return h.raw
        .prepare('SELECT * FROM subscriptions WHERE provider_subscription_id = ?')
        .get(SUBSCRIPTION_ID) as Record<string, unknown> | undefined;
    },
  };
}

function failedRenewal(eventId: string): Record<string, unknown> {
  return stripeEvent(
    'invoice.payment_failed',
    {
      ...invoiceObject({
        subscriptionId: SUBSCRIPTION_ID,
        customer: CUSTOMER_ID,
        billingReason: 'subscription_cycle',
      }),
      status: 'open',
      last_finalization_error: { message: 'Your card was declined.' },
    },
    { id: eventId },
  );
}

function paidRenewal(eventId: string): Record<string, unknown> {
  return stripeEvent(
    'invoice.paid',
    invoiceObject({
      subscriptionId: SUBSCRIPTION_ID,
      customer: CUSTOMER_ID,
      billingReason: 'subscription_cycle',
      periodStart: PERIOD_END_UNIX,
    }),
    { id: eventId },
  );
}

/* -------------------------------------------------------------------------- */
/* the webhook path                                                            */
/* -------------------------------------------------------------------------- */

describe('a real Stripe delivery reaches a real customer', () => {
  it('CUST-360 a signed invoice.payment_failed sends the payment_problem notification', async () => {
    const s = await scene();

    const response = await s.deliver(failedRenewal('evt_failed_1'));
    expect(response.status).toBe(200);

    // The database, read directly. This is the assertion the old code could not pass:
    // `handleStripeEvent` built the request, the route logged the outcome and dropped it,
    // and `notification_deliveries` stayed empty forever.
    const rows = s.notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['template']).toBe('payment_problem');
    expect(rows[0]?.['channel']).toBe('email');
    expect(rows[0]?.['state']).toBe('sent');
    expect(rows[0]?.['workspace_id']).toBe(s.workspaceId);
    // Never a delivery claim, even though the stub answered 200.
    expect(rows[0]?.['provider_status']).toBe('accepted_by_sending_service');
    // The address is hashed in storage, never stored in the clear.
    expect(String(rows[0]?.['recipient_hash'])).not.toContain('@');

    // And something actually went out of the transport.
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.to).toBe('notif@example.com');
    expect(s.sent[0]?.from).toBe(FROM_ADDRESS);
    expect(s.sent[0]?.subject).toContain('new runs are paused after a failed payment');
  });

  it('CUST-361 the renewal failure pauses new runs and marks the subscription past_due', async () => {
    const s = await scene();
    await s.deliver(failedRenewal('evt_failed_2'));

    // Requirement 3, first half: new verification runs pause. The row the admission gate
    // reads says `past_due`, which is not a serving status.
    expect(s.subscriptionRow()?.['status']).toBe('past_due');
    // And nothing was deleted, cancelled or emptied to achieve it.
    expect(s.entitlementRows().length).toBeGreaterThan(0);
    expect(
      s.h.raw.prepare('SELECT status FROM workspaces WHERE id = ?').get(s.workspaceId),
    ).toEqual({ status: 'active' });
  });

  it('CUST-362 a duplicate delivery sends no second notification and grants no second allowance', async () => {
    const s = await scene();

    // Two deliveries of the SAME event. Stripe retries; duplicates are normal.
    const first = await s.deliver(failedRenewal('evt_dupe_1'));
    const second = await s.deliver(failedRenewal('evt_dupe_1'));

    expect(await first.json()).toEqual({ received: true, duplicate: false });
    expect(await second.json()).toEqual({ received: true, duplicate: true });

    // Exactly one notification row, and exactly one message out of the transport.
    const rows = s.notificationRows();
    expect(rows).toHaveLength(1);
    expect(s.sent).toHaveLength(1);

    // One webhook receipt, which is the layer that protects the money.
    const receipts = s.h.raw
      .prepare("SELECT * FROM webhook_receipts WHERE provider = 'stripe'")
      .all() as Record<string, unknown>[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.['event_id']).toBe('evt_dupe_1');

    // Now the allowance half, on the event that actually grants one.
    await s.deliver(paidRenewal('evt_paid_1'));
    const afterFirstPaid = s.entitlementRows();
    const granted = afterFirstPaid.filter((row) => row['billing_period'] === '2026-10-25');
    expect(granted).toHaveLength(1);
    expect(granted[0]?.['run_limit']).toBe(500);

    // Spend some of it, then redeliver the same invoice. A duplicate must grant nothing —
    // not a second row, and not a reset of the counters, which would be a free refill.
    s.h.raw
      .prepare(
        'UPDATE entitlements SET consumed = 12 WHERE workspace_id = ? AND billing_period = ?',
      )
      .run(s.workspaceId, '2026-10-25');

    const replay = await s.deliver(paidRenewal('evt_paid_1'));
    expect(await replay.json()).toEqual({ received: true, duplicate: true });

    const afterReplay = s.entitlementRows().filter((row) => row['billing_period'] === '2026-10-25');
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]?.['consumed']).toBe(12);
    expect(afterReplay[0]?.['run_limit']).toBe(500);
  });

  it('CUST-363 a second, distinct failure event for the same window still sends only one email', async () => {
    const s = await scene();

    // Stripe retries a card several times inside one unpaid period, and each attempt is a
    // *different* event id — so the receipt table does not deduplicate them. The
    // notification key does: it is derived from the recovery window, which has not moved.
    await s.deliver(failedRenewal('evt_failed_a'));
    s.clock.value = '2026-09-26T15:00:00.000Z';
    await s.deliver(failedRenewal('evt_failed_b'));

    const receipts = s.h.raw
      .prepare("SELECT COUNT(*) AS n FROM webhook_receipts WHERE provider = 'stripe'")
      .get() as { n: number };
    expect(receipts.n).toBe(2);

    expect(s.notificationRows()).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });

  it('CUST-364 a cancellation sends exactly one confirmation across both Stripe events', async () => {
    const s = await scene();

    // The customer clicks cancel in the portal: `updated` with cancel_at_period_end.
    const scheduled = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({
        id: SUBSCRIPTION_ID,
        customer: CUSTOMER_ID,
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: PERIOD_END_UNIX,
        priceId: PRICE_ID,
      }),
      { id: 'evt_cancel_scheduled', created: 1_800_100_000 },
    );
    await s.deliver(scheduled);

    const afterScheduled = s.notificationRows();
    expect(afterScheduled).toHaveLength(1);
    expect(afterScheduled[0]?.['template']).toBe('cancellation_confirmed');
    expect(s.sent).toHaveLength(1);
    // The paid-for period is promised only when there actually is one.
    expect(s.sent[0]?.text).toContain('You keep access until');
    expect(s.sent[0]?.text).toContain(PERIOD_END);

    // A month later the period ends and Stripe sends `deleted`. Same cancellation, same
    // key, so the customer is not told twice.
    s.clock.value = '2026-10-25T00:01:00.000Z';
    const deleted = stripeEvent(
      'customer.subscription.deleted',
      subscriptionObject({
        id: SUBSCRIPTION_ID,
        customer: CUSTOMER_ID,
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: PERIOD_END_UNIX,
        priceId: PRICE_ID,
      }),
      { id: 'evt_cancel_deleted', created: 1_800_200_000 },
    );
    await s.deliver(deleted);

    expect(s.notificationRows()).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    expect(s.subscriptionRow()?.['status']).toBe('canceled');
  });

  it('CUST-365 an event the money path ignored announces nothing', async () => {
    const s = await scene();

    // A stale `updated` — an older `created` than the row already holds. The money path
    // ignores it, so there is nothing to announce, and announcing a change we did not make
    // is worse than silence.
    const stale = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({
        id: SUBSCRIPTION_ID,
        customer: CUSTOMER_ID,
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: PERIOD_END_UNIX,
        priceId: PRICE_ID,
      }),
      { id: 'evt_stale_1', created: 1_600_000_000 },
    );
    const response = await s.deliver(stale);

    expect(response.status).toBe(200);
    expect(s.notificationRows()).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    expect(s.subscriptionRow()?.['status']).toBe('active');
  });

  it('CUST-366 a notification body carries no card detail, no credential and no other tenant', async () => {
    const s = await scene();
    await s.deliver(failedRenewal('evt_privacy_1'));

    const body = `${s.sent[0]?.text ?? ''}\n${s.sent[0]?.html ?? ''}`;
    // Stripe's own reason is passed through; nothing about the instrument is.
    expect(body).toContain('Your card was declined.');
    for (const forbidden of [
      RESEND_KEY,
      STRIPE_KEY,
      WEBHOOK_SECRET,
      CUSTOMER_ID,
      SUBSCRIPTION_ID,
      'last4',
      'exp_month',
      'pm_',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    // The workspace it is about, and no identifier for any other.
    expect(body).toContain('Workspace notif');
  });
});

/* -------------------------------------------------------------------------- */
/* the scheduled path                                                          */
/* -------------------------------------------------------------------------- */

/** The Worker bindings `handleScheduled` reads, with billing fully configured. */
function scheduledEnv(h: TestDb, sent: SentEmail[]): Record<string, unknown> {
  return {
    DB: h.db,
    ENVIRONMENT: 'test',
    STRIPE_MODE: 'test',
    PUBLIC_BASE_URL: 'https://verify.itisyou.example',
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_PRICE_ID: PRICE_ID,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_WEBHOOK_PATH_ID: OPAQUE_ID,
    STRIPE_WEBHOOK_UNKNOWN_KEY: 'whsec' + '_' + 'A'.repeat(32),
    RESEND_API_KEY: RESEND_KEY,
    RESEND_FROM_ADDRESS: FROM_ADDRESS,
    __sent: sent,
  };
}

describe('a real cron tick reaches a real customer', () => {
  /**
   * Minute 7 of the hour: `RECOVERY_SWEEP_MINUTE`. The reconciliation job runs on minutes
   * divisible by 15, so this tick runs the day-8 sweep and makes no provider call at all —
   * which is also why no network stub is needed for Stripe here.
   */
  const TICK_AT = new Date('2026-10-03T09:07:00.000Z');

  async function pastDueScene(): Promise<{
    h: TestDb;
    workspaceId: string;
    sent: SentEmail[];
    env: Record<string, unknown>;
    rows: () => Record<string, unknown>[];
    status: () => unknown;
  }> {
    const h = createTestDb();
    dbs.push(h);
    const ws = seedWorkspace(h, 'sweep');
    const billingData = new D1BillingDataPort(h.db);
    await billingData.saveSubscriptionSnapshot({
      id: 'sub_row_sweep',
      workspaceId: ws.workspaceId,
      providerSubscriptionId: 'sub_sweep_1',
      environment: 'test',
      status: 'past_due',
      priceId: PRICE_ID,
      // Paid up to 25 September; the seven-day window therefore ran out on 2 October.
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      reconciledAt: null,
      providerEventCreated: 1_700_000_000,
      updatedAt: PERIOD_END,
    });
    const sent: SentEmail[] = [];
    return {
      h,
      workspaceId: ws.workspaceId,
      sent,
      env: scheduledEnv(h, sent),
      rows: () =>
        h.raw.prepare('SELECT * FROM notification_deliveries ORDER BY id').all() as Record<
          string,
          unknown
        >[],
      status: () =>
        (
          h.raw
            .prepare('SELECT status FROM subscriptions WHERE provider_subscription_id = ?')
            .get('sub_sweep_1') as { status: string } | undefined
        )?.status,
    };
  }

  function delivery(h: TestDb, sent: SentEmail[]) {
    return createNotificationDelivery(
      { RESEND_API_KEY: RESEND_KEY, RESEND_FROM_ADDRESS: FROM_ADDRESS },
      new D1SupportDataPort(h.db),
      { fetchImpl: recordingFetch(sent), now: () => TICK_AT },
    );
  }

  it('CUST-367 day eight of the recovery window suspends the subscription and tells the customer', async () => {
    const s = await pastDueScene();

    const report = await handleScheduled(s.env as never, {
      now: TICK_AT,
      notifications: delivery(s.h, s.sent),
    });

    // The pass ran at all. Before this wiring `report.billing` did not exist and
    // `runBillingMaintenance` had no caller anywhere in the repository.
    expect(report.billing?.skipped).toBeNull();
    expect(report.billing?.failures).toEqual([]);
    expect(report.billing?.maintenance?.ranRecoverySweep).toBe(true);
    expect(report.billing?.maintenance?.recoverySweep?.suspended).toHaveLength(1);

    // Requirement: after seven unpaid days the subscription is marked unpaid and
    // verification stays suspended. It is NOT cancelled and nothing is deleted.
    expect(s.status()).toBe('unpaid');
    expect(
      s.h.raw.prepare('SELECT status FROM workspaces WHERE id = ?').get(s.workspaceId),
    ).toEqual({ status: 'active' });
    expect(
      (
        s.h.raw
          .prepare('SELECT COUNT(*) AS n FROM entitlements WHERE workspace_id = ?')
          .get(s.workspaceId) as { n: number }
      ).n,
    ).toBeGreaterThan(0);

    // And the customer was told, through the real sender and the real transport.
    const rows = s.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['template']).toBe('payment_problem');
    expect(rows[0]?.['state']).toBe('sent');
    expect(String(rows[0]?.['notification_key'])).toContain(':suspended');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.to).toBe('sweep@example.com');
  });

  it('CUST-368 a second tick over the same expired window sends nothing further', async () => {
    const s = await pastDueScene();

    await handleScheduled(s.env as never, {
      now: TICK_AT,
      notifications: delivery(s.h, s.sent),
    });
    const second = await handleScheduled(s.env as never, {
      now: new Date('2026-10-03T10:07:00.000Z'),
      notifications: delivery(s.h, s.sent),
    });

    // The sweep is idempotent: an already-`unpaid` subscription reports no suspension, so
    // the hourly cadence costs latency and never a second email.
    expect(second.billing?.maintenance?.recoverySweep?.suspended).toHaveLength(0);
    expect(s.rows()).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    expect(s.status()).toBe('unpaid');
  });

  it('CUST-369 an unconfigured deployment skips the pass and makes no provider call', async () => {
    const s = await pastDueScene();

    const report = await handleScheduled({ DB: s.h.db, ENVIRONMENT: 'test' } as never, {
      now: TICK_AT,
      notifications: delivery(s.h, s.sent),
    });

    expect(report.billing?.skipped).toBe('billing_not_configured');
    expect(s.rows()).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    // Nothing was written on the way past, either.
    expect(s.status()).toBe('past_due');
  });
});
