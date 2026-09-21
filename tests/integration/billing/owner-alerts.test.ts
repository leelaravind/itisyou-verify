/**
 * Requirement L7: two owner alerts that did not exist before — `spending_decision` on a
 * live checkout, `critical_incident` on a live renewal failure.
 *
 * Same discipline as `notification-wiring.test.ts` and `owner-alert-wiring.test.ts` next
 * door: nothing here calls `sendOwnerAlert`, `dispatchNotification` or any sender
 * directly. Every case starts at a signed Stripe delivery to the mounted webhook route —
 * the same entry `apps/app/src/routes/webhooks/stripe.ts` calls, which calls
 * `handleStripeEvent` — and finishes by reading `notification_deliveries` out of a real
 * SQLite database with the real migrations applied. The one exception is the pair of
 * cases explicitly proving the notification-key idempotency independently of the
 * webhook-receipt layer, which call `handleStripeEvent` directly — still the real
 * function, not a mock of it, and still the exact entry the route itself calls.
 *
 * `sendOwnerAlert` is wired to the real `TelegramTransport` from
 * `notifications/telegram.ts` over a stub `fetch`, and to a real `D1SupportDataPort` over
 * the same SQLite database the billing rows live in — so a row appearing in
 * `notification_deliveries` here is the real at-most-once claim-and-settle path, not a
 * count kept by the test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildBillingConfig, type BillingConfig } from '@app/billing/config';
import {
  handleStripeEvent,
  type BillingRuntimeWithOwnerAlerts,
  type StripeEventShape,
} from '@app/billing/events';
import { D1BillingDataPort } from '@app/db/billingPort';
import { D1SupportDataPort } from '@app/db/supportPort';
import { createStripeWebhookRoute, type StripeWebhookDeps } from '@app/routes/webhooks/stripe';
import {
  sendOwnerAlert as realSendOwnerAlert,
  TelegramTransport,
  TELEGRAM_API_BASE,
  type OwnerAlert,
  type TelegramFetch,
} from '@app/notifications/telegram';
import type { SendResult } from '@app/notifications/send';
import { createTestDb, seedWorkspace, type TestDb } from '../db/harness';
import {
  OPAQUE_ID,
  WEBHOOK_SECRET,
  createStubGateway,
  invoiceObject,
  signedDelivery,
  stripeEvent,
} from './harness';

const PATH = `/api/v1/webhooks/stripe/${OPAQUE_ID}`;
const PRICE_ID = 'price_planv1stub';
const SUBSCRIPTION_ID = 'sub_owner_alert_1';
const CUSTOMER_ID = 'cus_owner_alert_1';

/** Shaped like a real Telegram bot token; never a genuine secret. */
const TEST_TELEGRAM_TOKEN = ['1234567890', 'B'.repeat(35)].join(':');

interface TelegramCall {
  readonly url: string;
  readonly body: string;
}

/** A `TelegramFetch` that answers as the Bot API would, and records what it was asked. */
function telegramStub(calls: TelegramCall[]): TelegramFetch {
  return async (url, init) => {
    calls.push({ url, body: init.body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
    };
  };
}

/**
 * The one seam `billing/events.ts` needs to send an owner alert directly:
 * `BillingRuntimeWithOwnerAlerts.sendOwnerAlert`. Bound here to the REAL
 * `sendOwnerAlert` from `notifications/telegram.ts`, a real `D1SupportDataPort` and a
 * real `TelegramTransport` — only the socket is a stub, exactly the discipline
 * `notification-wiring.test.ts` uses for the email transport.
 */
function ownerAlertSender(
  port: D1SupportDataPort,
  calls: TelegramCall[],
  clock: { value: string },
): (alert: OwnerAlert) => Promise<SendResult> {
  const transport = new TelegramTransport(
    { token: TEST_TELEGRAM_TOKEN, ownerChatId: '555555555', apiBase: TELEGRAM_API_BASE },
    telegramStub(calls),
  );
  return (alert) => realSendOwnerAlert({ port, transport, now: () => new Date(clock.value) }, alert);
}

let dbs: TestDb[] = [];
afterEach(() => {
  for (const h of dbs) h.close();
  dbs = [];
});

interface Scene {
  readonly h: TestDb;
  readonly workspaceId: string;
  readonly billingData: D1BillingDataPort;
  readonly config: BillingConfig;
  readonly calls: TelegramCall[];
  readonly clock: { value: string };
  deliver(event: Record<string, unknown>): Promise<Response>;
  /** Every owner-channel row, straight out of SQLite. */
  ownerRows(): Record<string, unknown>[];
  runtime(): BillingRuntimeWithOwnerAlerts;
}

async function scene(environment: 'test' | 'live'): Promise<Scene> {
  const h = createTestDb();
  dbs.push(h);
  const ws = seedWorkspace(h, `owneralert_${environment}`);
  const billingData = new D1BillingDataPort(h.db);
  const supportPort = new D1SupportDataPort(h.db);
  const calls: TelegramCall[] = [];
  const clock = { value: '2026-09-26T09:00:00.000Z' };
  const config = buildBillingConfig({
    environment,
    priceId: PRICE_ID,
    publicBaseUrl: 'https://verify.itisyou.example',
  });

  const counters = new Map<string, number>();
  const newId = (prefix: string): string => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, '0')}`;
  };

  const runtimeOf = (): BillingRuntimeWithOwnerAlerts => ({
    config,
    data: billingData,
    gateway: createStubGateway({ livemode: environment === 'live' }),
    now: () => clock.value,
    newId,
    sendOwnerAlert: ownerAlertSender(supportPort, calls, clock),
  });

  const deps: StripeWebhookDeps = {
    ...runtimeOf(),
    resolveEndpointSecret: async (id) => (id === OPAQUE_ID ? WEBHOOK_SECRET : null),
  };
  const route = createStripeWebhookRoute(deps);

  return {
    h,
    workspaceId: ws.workspaceId,
    billingData,
    config,
    calls,
    clock,
    async deliver(event) {
      const { body, headers } = await signedDelivery(event, clock.value, WEBHOOK_SECRET);
      return route.request(PATH, { method: 'POST', headers, body });
    },
    ownerRows: () =>
      h.raw
        .prepare("SELECT * FROM notification_deliveries WHERE channel = 'telegram' ORDER BY id")
        .all() as Record<string, unknown>[],
    runtime: runtimeOf,
  };
}

function checkoutSession(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'cs_owner_alert_1',
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    customer: CUSTOMER_ID,
    // No subscription id: the alert must not depend on the subscription-linking half of
    // the handler succeeding, only on the checkout itself having completed.
    subscription: null,
    client_reference_id: workspaceId,
    currency: 'gbp',
    amount_total: 2900,
    metadata: { workspace_id: workspaceId },
    ...overrides,
  };
}

async function seedOrder(
  billingData: D1BillingDataPort,
  workspaceId: string,
  at: string,
  environment: 'test' | 'live' = 'test',
): Promise<void> {
  await billingData.rememberBillingCustomer({
    workspaceId,
    stripeCustomerId: CUSTOMER_ID,
    environment,
    createdAt: at,
  });
  await billingData.openOrderOnce({
    id: 'ord_owner_alert_1',
    workspaceId,
    status: 'checkout_created',
    rejectionReason: null,
    priceId: PRICE_ID,
    amountMinor: 2900,
    currency: 'GBP',
    checkoutSessionId: 'cs_owner_alert_1',
    paymentIntentId: null,
    idempotencyKey: `checkout:v1:${workspaceId}`,
    createdAt: at,
    updatedAt: at,
  });
}

function failedRenewal(
  eventId: string,
  overrides: { readonly invoiceId?: string; readonly livemode?: boolean } = {},
): Record<string, unknown> {
  return {
    ...stripeEvent(
      'invoice.payment_failed',
      {
        ...invoiceObject({
          id: overrides.invoiceId ?? 'in_owner_alert_1',
          subscriptionId: SUBSCRIPTION_ID,
          customer: CUSTOMER_ID,
          billingReason: 'subscription_cycle',
        }),
        status: 'open',
        last_finalization_error: { message: 'Your card was declined.' },
      },
      { id: eventId, livemode: overrides.livemode ?? true },
    ),
  };
}

async function seedSubscription(
  billingData: D1BillingDataPort,
  workspaceId: string,
  environment: 'test' | 'live',
  at: string,
): Promise<void> {
  await billingData.rememberBillingCustomer({
    workspaceId,
    stripeCustomerId: CUSTOMER_ID,
    environment,
    createdAt: at,
  });
  await billingData.saveSubscriptionSnapshot({
    id: 'sub_row_owner_alert_1',
    workspaceId,
    providerSubscriptionId: SUBSCRIPTION_ID,
    environment,
    status: 'active',
    priceId: PRICE_ID,
    currentPeriodEnd: '2026-10-25T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    reconciledAt: null,
    latestPaymentIntentId: null,
    latestPaymentPeriodEnd: null,
    providerEventCreated: 1_700_000_000,
    updatedAt: at,
  });
}

describe('checkout.session.completed: spending_decision', () => {
  it('BILL-654 a live-mode checkout sends exactly one spending_decision alert', async () => {
    const s = await scene('live');
    await seedOrder(s.billingData, s.workspaceId, s.clock.value, 'live');

    const event = stripeEvent('checkout.session.completed', checkoutSession(s.workspaceId), {
      id: 'evt_owner_alert_live_1',
      livemode: true,
    });

    const response = await s.deliver(event);
    expect(response.status).toBe(200);

    const rows = s.ownerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['template']).toBe('spending_decision');
    expect(rows[0]?.['channel']).toBe('telegram');
    expect(rows[0]?.['state']).toBe('sent');
    expect(rows[0]?.['workspace_id']).toBe(s.workspaceId);
    // Never the chat id in the clear — `recipient_hash` is a hash column.
    expect(String(rows[0]?.['recipient_hash'])).not.toContain('555555555');

    // And something actually went to Telegram.
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.body).toContain('Live checkout completed');
    expect(s.calls[0]?.body).toContain('29.00 GBP');
    expect(s.calls[0]?.body).toContain('ord_owner_alert_1');
    // Never a raw Stripe session id, a customer id or a card detail.
    expect(s.calls[0]?.body).not.toContain('cs_owner_alert_1');
    expect(s.calls[0]?.body).not.toContain(CUSTOMER_ID);
  });

  it('BILL-655 a redelivery of the same live event still sends exactly one alert', async () => {
    const s = await scene('live');
    await seedOrder(s.billingData, s.workspaceId, s.clock.value, 'live');
    const event = stripeEvent('checkout.session.completed', checkoutSession(s.workspaceId), {
      id: 'evt_owner_alert_live_dupe',
      livemode: true,
    });

    const first = await s.deliver(event);
    const second = await s.deliver(event);

    expect(await first.json()).toEqual({ received: true, duplicate: false });
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(s.ownerRows()).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
  });

  it('BILL-656 the same checkout under two different event ids still sends exactly one alert, proving the notification-key claim, not just the webhook-receipt layer', async () => {
    // The literal redelivery case above is also caught by `webhook_receipts` before
    // `handleStripeEvent` ever runs a second time, so it alone does not prove this file's
    // own idempotency. Here the two events have DIFFERENT ids — so the receipt layer does
    // NOT deduplicate them — and it is `notificationKey`, claimed once by
    // `notification_deliveries.notification_key`, that must still hold the count at one.
    // `handleStripeEvent` is called directly: it is the exact function the route calls,
    // not a stand-in for it.
    const s = await scene('live');
    await seedOrder(s.billingData, s.workspaceId, s.clock.value, 'live');
    const runtime = s.runtime();

    const parsed = (body: Record<string, unknown>): StripeEventShape => ({
      id: String(body['id']),
      type: String(body['type']),
      created: Number(body['created']),
      livemode: Boolean(body['livemode']),
      data: body['data'] as { object: Record<string, unknown> },
    });

    const first = stripeEvent('checkout.session.completed', checkoutSession(s.workspaceId), {
      id: 'evt_owner_alert_live_a',
      livemode: true,
    });
    const second = stripeEvent('checkout.session.completed', checkoutSession(s.workspaceId), {
      id: 'evt_owner_alert_live_b',
      livemode: true,
    });
    expect(first['id']).not.toBe(second['id']);

    const firstOutcome = await handleStripeEvent(runtime, parsed(first));
    const secondOutcome = await handleStripeEvent(runtime, parsed(second));

    expect(firstOutcome.status).toBe('processed');
    expect(secondOutcome.status).toBe('processed');
    expect(s.ownerRows()).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
  });

  it('BILL-657 a test-mode checkout sends zero owner alerts', async () => {
    const s = await scene('test');
    await seedOrder(s.billingData, s.workspaceId, s.clock.value);

    const event = stripeEvent('checkout.session.completed', checkoutSession(s.workspaceId), {
      id: 'evt_owner_alert_test_1',
      livemode: false,
    });

    const response = await s.deliver(event);
    expect(response.status).toBe(200);
    expect(s.ownerRows()).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it('BILL-662 the gate reads the SIGNED livemode flag, not the deployment environment', async () => {
    /*
     * The case the other eight could not make.
     *
     * Every fixture above ties `config.environment` and `event.livemode` together: a
     * `scene('live')` always sends `livemode: true`, a `scene('test')` always sends
     * `livemode: false`. So all eight stay green if the gate is rewritten from
     * `event.livemode` to `config.environment === 'live'`, and the L7 evidence cell was
     * citing them for a property they do not test. An independent meta-audit found that,
     * and it is the right kind of finding: the tests were not wrong, the claim about what
     * they proved was.
     *
     * This drives the two apart. The deployment says live; the event Stripe signed says
     * test. `handleStripeEvent` is called directly, because the webhook route refuses a
     * mode mismatch with a 400 before the handler ever runs (`providerModeMatches`), and
     * that refusal is a different guard from this one.
     *
     * Reading the environment would raise an alert here. Reading the signed field does
     * not, and the signed field is the one Stripe actually vouches for.
     */
    const s = await scene('live');
    await seedOrder(s.billingData, s.workspaceId, s.clock.value, 'live');
    const runtime = s.runtime();

    const body = stripeEvent('checkout.session.completed', checkoutSession(s.workspaceId), {
      id: 'evt_owner_alert_mode_split_1',
      livemode: false,
    });
    const parsed: StripeEventShape = {
      id: String(body['id']),
      type: String(body['type']),
      created: Number(body['created']),
      livemode: Boolean(body['livemode']),
      data: body['data'] as { object: Record<string, unknown> },
    };
    expect(parsed.livemode, 'the fixture must carry a test-mode signed flag').toBe(false);

    await handleStripeEvent(runtime, parsed);

    expect(
      s.ownerRows(),
      'a test-mode event raised an owner alert on a live deployment, so the gate is reading the environment rather than the signed livemode flag',
    ).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });
});

describe('invoice.payment_failed: critical_incident', () => {
  it('BILL-658 a live-mode renewal failure sends exactly one critical_incident alert', async () => {
    const s = await scene('live');
    await seedSubscription(s.billingData, s.workspaceId, 'live', s.clock.value);

    const response = await s.deliver(failedRenewal('evt_owner_alert_invoice_1'));
    expect(response.status).toBe(200);

    const rows = s.ownerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['template']).toBe('critical_incident');
    expect(rows[0]?.['channel']).toBe('telegram');
    expect(rows[0]?.['state']).toBe('sent');
    expect(rows[0]?.['workspace_id']).toBe(s.workspaceId);

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.body).toContain('Live payment failed');
    expect(s.calls[0]?.body).toContain('sub_row_owner_alert_1');
    expect(s.calls[0]?.body).toContain('29.00 GBP');
    // Never Stripe's own ids, the customer id, or the decline reason (a customer-facing
    // sentence, not owner-channel content).
    expect(s.calls[0]?.body).not.toContain(SUBSCRIPTION_ID);
    expect(s.calls[0]?.body).not.toContain(CUSTOMER_ID);
    expect(s.calls[0]?.body).not.toContain('in_owner_alert_1');
    expect(s.calls[0]?.body).not.toContain('declined');
  });

  it('BILL-659 a second, distinct retry event for the SAME invoice sends no further alert (once per invoice, not per attempt)', async () => {
    const s = await scene('live');
    await seedSubscription(s.billingData, s.workspaceId, 'live', s.clock.value);

    await s.deliver(failedRenewal('evt_owner_alert_invoice_retry_a'));
    s.clock.value = '2026-09-27T09:00:00.000Z';
    await s.deliver(failedRenewal('evt_owner_alert_invoice_retry_b'));

    // Two distinct webhook receipts — Stripe really did redeliver two different events —
    // and still one alert, because both retries name the same invoice id.
    const receipts = s.h.raw
      .prepare("SELECT COUNT(*) AS n FROM webhook_receipts WHERE provider = 'stripe'")
      .get() as { n: number };
    expect(receipts.n).toBe(2);
    expect(s.ownerRows()).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
  });

  it('BILL-660 a DIFFERENT invoice on the same subscription earns its own alert', async () => {
    const s = await scene('live');
    await seedSubscription(s.billingData, s.workspaceId, 'live', s.clock.value);

    await s.deliver(failedRenewal('evt_owner_alert_invoice_x', { invoiceId: 'in_owner_alert_x' }));
    await s.deliver(failedRenewal('evt_owner_alert_invoice_y', { invoiceId: 'in_owner_alert_y' }));

    expect(s.ownerRows()).toHaveLength(2);
    expect(s.calls).toHaveLength(2);
  });

  it('BILL-661 a test-mode renewal failure sends zero owner alerts', async () => {
    const s = await scene('test');
    await seedSubscription(s.billingData, s.workspaceId, 'test', s.clock.value);

    const response = await s.deliver(
      failedRenewal('evt_owner_alert_test_invoice_1', { livemode: false }),
    );
    expect(response.status).toBe(200);
    expect(s.ownerRows()).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });
});
