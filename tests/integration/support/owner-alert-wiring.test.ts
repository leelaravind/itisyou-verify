/**
 * Does anything in the application actually ping the owner?
 *
 * ## Why this file exists
 *
 * `notifications/telegram.ts` is one of the most carefully built files in the repository.
 * A kind allowlist that is default-deny. A shape guard over the assembled text that
 * refuses rather than redacts, so its failures cannot be silent. A one-method API
 * allowlist protecting a poller belonging to somebody else's system. A named builder,
 * `paymentGatewayReadyAlert`, written for one situation because — in its own words — "the
 * founder is waiting to do something, and a ping five minutes later is worth more than a
 * dashboard row they will check tomorrow".
 *
 * And on 20 September 2026 a search for callers of `sendOwnerAlert` across the whole of
 * `apps/app/src` returned nothing. The owner asked to be pinged when something needed
 * them, and the code that would do it could not be reached by any request or any tick.
 * The dominant defect class, landing on the one path whose entire value is timing.
 *
 * So nothing here calls `sendOwnerAlert`. Every case starts at `handleScheduled` — the
 * export the Worker's `scheduled()` handler calls — with a stub `fetch`, and finishes by
 * reading what was actually sent.
 *
 * Case ids `OWNER-495..OWNER-499`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { handleScheduled } from '@app/scheduler/index';
import { createTestDb, seedWorkspace, type TestDb } from '../db/harness';

const TICK_AT = new Date('2026-10-03T09:07:00.000Z');
const GOOD_KEY = ['sk', 'test', '0'.repeat(24)].join('_');
const WEBHOOK = ['whsec', 'A'.repeat(32)].join('_');

interface Call {
  readonly url: string;
  readonly body: string;
}

/** A fetch that answers as the Telegram Bot API would, and records what it was asked. */
function telegramStub(calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function env(h: TestDb, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: h.db,
    ENVIRONMENT: 'test',
    STRIPE_MODE: 'test',
    PUBLIC_BASE_URL: 'https://verify.itisyou.example',
    STRIPE_SECRET_KEY: GOOD_KEY,
    STRIPE_PRICE_ID: 'price_planv1stub',
    STRIPE_WEBHOOK_SECRET: WEBHOOK,
    STRIPE_WEBHOOK_PATH_ID: 'opaque_path_id',
    STRIPE_WEBHOOK_UNKNOWN_KEY: WEBHOOK,
    TELEGRAM_BOT_TOKEN: ['1234567890', 'A'.repeat(35)].join(':'),
    TELEGRAM_OWNER_CHAT_ID: '55555555',
    ...overrides,
  };
}

const dbs: TestDb[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

function scene(overrides: Record<string, unknown> = {}): {
  h: TestDb;
  calls: Call[];
  tick: () => Promise<Awaited<ReturnType<typeof handleScheduled>>>;
} {
  const h = createTestDb();
  dbs.push(h);
  seedWorkspace(h, 'alert');
  const calls: Call[] = [];
  return {
    h,
    calls,
    tick: () =>
      handleScheduled(env(h, overrides) as never, {
        now: TICK_AT,
        ownerAlertFetch: telegramStub(calls),
      }),
  };
}

describe('a cron tick pings the owner when only the owner can act', () => {
  it('OWNER-495 a malformed Stripe key causes a real Telegram send', async () => {
    const s = scene({ STRIPE_SECRET_KEY: 'not-a-stripe-key' });

    const report = await s.tick();

    // The assertion whose absence let the whole channel stay unreachable: an HTTP call
    // was made to Telegram by a tick, not by a test calling the sender directly.
    expect(s.calls.length, 'no request was made to the Telegram API').toBe(1);
    expect(s.calls[0]?.url).toContain('/sendMessage');
    expect(report.ownerAlert?.attempted).toBe(true);
    expect(report.ownerAlert?.outcome).toBe('sent');
  });

  it('OWNER-496 the message names the secret and carries no value', async () => {
    const s = scene({ STRIPE_SECRET_KEY: 'not-a-stripe-key' });

    await s.tick();
    const body = s.calls[0]?.body ?? '';

    expect(body).toContain('STRIPE_SECRET_KEY');
    // A secret NAME is a variable name. The value must never be here, and neither must
    // the chat's own contents be described.
    expect(body).not.toContain('not-a-stripe-key');
    expect(body).toContain('ITISYOU Verify');
  });

  it('OWNER-497 a five-minute cron does not buzz a phone every five minutes', async () => {
    const s = scene({ STRIPE_SECRET_KEY: 'not-a-stripe-key' });

    await s.tick();
    const second = await s.tick();

    // The key is derived from the environment and the secret names, never the clock, so
    // the same unchanged problem sends once. This is the case that decides whether the
    // feature is usable or a reason to mute the bot.
    expect(s.calls.length, 'the same problem sent twice').toBe(1);
    expect(second.ownerAlert?.outcome).toBe('duplicate');
  });

  it('OWNER-498 a healthy deployment never sends the cannot-take-payment alert', async () => {
    const s = scene();

    await s.tick();

    // The premise of this case changed deliberately when the milestone was wired: a healthy
    // sandbox now sends ONE line saying so. What must never happen is the failure alert
    // going out on a deployment that is fine, so that is what is asserted, rather than the
    // weaker "nothing was sent" that no longer describes the intended behaviour.
    const bodies = s.calls.map((call) => call.body).join(' ');
    expect(bodies).not.toContain('cannot take payment');
    expect(bodies).not.toContain('STRIPE_SECRET_KEY');
  });

  it('OWNER-503 a healthy sandbox says so once, and not once per tick', async () => {
    const s = scene();

    const first = await s.tick();
    const second = await s.tick();

    expect(first.ownerAlert?.outcome).toBe('sent');
    expect(second.ownerAlert?.outcome, 'the milestone repeated').toBe('duplicate');
    expect(s.calls.length).toBe(1);
    expect(s.calls[0]?.body).toContain('Sandbox payments configured');
  });

  it('OWNER-499 with no Telegram configured the tick still succeeds and records why', async () => {
    const s = scene({
      STRIPE_SECRET_KEY: 'not-a-stripe-key',
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_OWNER_CHAT_ID: undefined,
    });

    const report = await s.tick();

    // A missing channel is ordinary, not an error: the tick must not reject, because a
    // rejected scheduled handler buys a cron retry nobody asked for.
    expect(s.calls.length).toBe(0);
    expect(report.ownerAlert?.outcome).toBe('suppressed');
    expect(report.error).toBeNull();
  });
});

/**
 * A standing condition gets another chance; a delivered message does not.
 *
 * `dispatchNotification` claims the notification key BEFORE sending and settles the
 * outcome onto that same row, so a send that failed left the key permanently taken. Every
 * later tick answered `duplicate` and nothing was ever sent again. For a one-off customer
 * event that is correct and conservative. For "this deployment cannot take payment" — which
 * stays true until a person acts — it meant one transient failure silenced the channel
 * for good.
 *
 * It was not hypothetical. The auditor read both live databases and found production and
 * staging each holding exactly one `failed` row for this alert, from the first tick after
 * it was wired, with no path back. The cause was a `fetch` passed unbound, which no test
 * could reproduce because every test injects a plain function.
 *
 * Case ids `OWNER-500..OWNER-502`.
 */
describe('a failed owner alert can be sent again; a delivered one cannot', () => {
  it('OWNER-500 a tick whose send fails is retried by the next tick', async () => {
    const h = createTestDb();
    dbs.push(h);
    seedWorkspace(h, 'retry');
    const calls: Call[] = [];
    let failNext = true;

    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: String(init?.body ?? '') });
      if (failNext) return new Response('upstream down', { status: 503 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const run = (): Promise<Awaited<ReturnType<typeof handleScheduled>>> =>
      handleScheduled(env(h, { STRIPE_SECRET_KEY: 'not-a-stripe-key' }) as never, {
        now: TICK_AT,
        ownerAlertFetch: flaky,
      });

    const first = await run();
    expect(first.ownerAlert?.outcome, 'the failing send should be recorded as failed').toBe(
      'failed',
    );

    failNext = false;
    const second = await run();

    // The assertion that was missing. Before `releaseUndelivered` this was `duplicate`
    // and the owner was never told, on a deployment that genuinely could not take money.
    expect(second.ownerAlert?.outcome, 'the retry was refused as a duplicate').toBe('sent');
  });

  it('OWNER-501 a delivered alert is never sent a second time', async () => {
    const s = scene({ STRIPE_SECRET_KEY: 'not-a-stripe-key' });

    const first = await s.tick();
    const second = await s.tick();

    // The other half, and the one that matters for a phone. `releaseUndelivered` refuses
    // to touch a `sent` row in SQL rather than by the caller remembering to check.
    expect(first.ownerAlert?.outcome).toBe('sent');
    expect(second.ownerAlert?.outcome).toBe('duplicate');
    expect(s.calls.length, 'the owner was messaged twice about one thing').toBe(1);
  });

  it('OWNER-502 an alert suppressed for want of a channel sends once the channel exists', async () => {
    const h = createTestDb();
    dbs.push(h);
    seedWorkspace(h, 'late');
    const calls: Call[] = [];

    const withoutChannel = await handleScheduled(
      env(h, {
        STRIPE_SECRET_KEY: 'not-a-stripe-key',
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_OWNER_CHAT_ID: undefined,
      }) as never,
      { now: TICK_AT, ownerAlertFetch: telegramStub(calls) },
    );
    expect(withoutChannel.ownerAlert?.outcome).toBe('suppressed');

    // Configuring Telegram after the first tick is the ordinary order of events for an
    // operator. A suppressed row must not have burned the key on the way past.
    const withChannel = await handleScheduled(
      env(h, { STRIPE_SECRET_KEY: 'not-a-stripe-key' }) as never,
      { now: TICK_AT, ownerAlertFetch: telegramStub(calls) },
    );

    expect(withChannel.ownerAlert?.outcome).toBe('sent');
    expect(calls.length).toBe(1);
  });
});
