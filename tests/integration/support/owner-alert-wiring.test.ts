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

  it('OWNER-498 a healthy deployment sends nothing at all', async () => {
    const s = scene();

    const report = await s.tick();

    expect(s.calls.length).toBe(0);
    expect(report.ownerAlert?.attempted).toBe(false);
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
