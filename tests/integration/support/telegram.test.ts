/**
 * API-3xx — the Telegram transport end to end, against the in-memory port.
 *
 * **No real Telegram message is sent by anything in this file.** `fetch` is blocked by
 * `tests/setup.ts`, and the transport takes its HTTP call as an injected function, so the
 * tests drive a recorder. The bot at the other end of the real channel is long-polling
 * for the founder's own automation; a stray call from a test suite is not a cosmetic
 * problem.
 *
 * The point of these cases is that the owner channel inherits the sending guarantees
 * rather than reimplementing them: a duplicate `notification_key` sends once here exactly
 * as it does on email, because both go through `dispatchNotification`.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySupportData } from '@app/support/memory';
import {
  TelegramTransport,
  sendOwnerAlert,
  telegramTransportFromEnv,
  type OwnerAlert,
  type TelegramFetch,
} from '@app/notifications/telegram';

const NOW = new Date('2026-09-19T12:00:00.000Z');
/**
 * A bot-token-shaped string, assembled at runtime and never written as a literal.
 *
 * It is not a real token, but it is the right shape — and a real-shaped value in a
 * public repository is a value in git history forever, where no allowlist marker can
 * reach it afterwards. `SEC-633` makes that a build failure by design.
 */
const FAKE_TOKEN = ['1234567890', 'A'.repeat(35)].join(':');
const FAKE_CHAT = '-1001234567890';

interface Posted {
  readonly url: string;
  readonly body: string;
}

/** Records instead of sending. Never touches the network. */
function recorder(responses: { ok: boolean; status: number; body?: string }[] = []): {
  readonly posted: Posted[];
  readonly fetchImpl: TelegramFetch;
} {
  const posted: Posted[] = [];
  const fetchImpl: TelegramFetch = (url, init) => {
    posted.push({ url, body: init.body });
    const next = responses.shift() ?? { ok: true, status: 200 };
    return Promise.resolve({
      ok: next.ok,
      status: next.status,
      text: () => Promise.resolve(next.body ?? '{"ok":true}'),
    });
  };
  return { posted, fetchImpl };
}

function transportFor(responses: { ok: boolean; status: number }[] = []): {
  readonly posted: Posted[];
  readonly transport: TelegramTransport;
} {
  const { posted, fetchImpl } = recorder(responses);
  return {
    posted,
    transport: new TelegramTransport(
      { token: FAKE_TOKEN, ownerChatId: FAKE_CHAT, apiBase: 'https://api.telegram.org' },
      fetchImpl,
    ),
  };
}

const alert: OwnerAlert = {
  kind: 'approval_needed',
  notificationKey: 'approval_needed:apr_01J8ABCDEFGH23456789012345',
  headline: 'One campaign is waiting for approval',
  detail: 'Workspace ws_01J8ABCDEFGH23456789012345. Review it on the dashboard.',
  workspaceId: 'ws_01J8ABCDEFGH23456789012345',
};

describe('telegram transport', () => {
  it('API-380 a permitted alert is sent once, prefixed, to the configured chat', async () => {
    const port = new InMemorySupportData();
    const { posted, transport } = transportFor();

    const result = await sendOwnerAlert(
      { port, transport, wait: () => Promise.resolve(), now: () => NOW },
      alert,
    );

    expect(result.outcome).toBe('sent');
    expect(posted).toHaveLength(1);

    const body = JSON.parse(posted[0]?.body ?? '{}') as { chat_id: string; text: string };
    expect(body.chat_id).toBe(FAKE_CHAT);
    expect(body.text.startsWith('ITISYOU Verify: One campaign is waiting')).toBe(true);
    // The only method this codebase may call.
    expect(posted[0]?.url.endsWith('/sendMessage')).toBe(true);
  });

  it('API-381 a duplicate notification key sends once on Telegram too', async () => {
    const port = new InMemorySupportData();
    const { posted, transport } = transportFor();
    const deps = { port, transport, wait: () => Promise.resolve(), now: () => NOW };

    const first = await sendOwnerAlert(deps, alert);
    const second = await sendOwnerAlert(deps, alert);
    const third = await sendOwnerAlert(deps, alert);

    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('duplicate');
    expect(third.outcome).toBe('duplicate');
    expect(posted).toHaveLength(1);
    expect(port.notifications.size).toBe(1);
    expect(port.notifications.get(alert.notificationKey)?.channel).toBe('telegram');
  });

  it('API-382 with the channel unconfigured, the path still works and records suppressed', async () => {
    const port = new InMemorySupportData();

    // No transport at all — the shape of an unset token or chat id binding.
    const result = await sendOwnerAlert(
      { port, wait: () => Promise.resolve(), now: () => NOW },
      alert,
    );

    expect(result.outcome).toBe('suppressed');
    expect(result.providerStatus).toBe('no_telegram_transport_configured');
    expect(port.notifications.get(alert.notificationKey)?.state).toBe('suppressed');
    // And it did not throw, which is the property a suspension path depends on.
  });

  it('API-383 telegramTransportFromEnv is undefined when either binding is missing', () => {
    const { fetchImpl } = recorder();
    expect(telegramTransportFromEnv({}, fetchImpl)).toBeUndefined();
    expect(telegramTransportFromEnv({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN }, fetchImpl)).toBeUndefined();
    expect(
      telegramTransportFromEnv({ TELEGRAM_OWNER_CHAT_ID: FAKE_CHAT }, fetchImpl),
    ).toBeUndefined();
    expect(
      telegramTransportFromEnv(
        { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_OWNER_CHAT_ID: FAKE_CHAT },
        fetchImpl,
      ),
    ).toBeDefined();
  });

  it('API-384 a refused message is never posted, and the refusal is recorded', async () => {
    const port = new InMemorySupportData();
    const { posted, transport } = transportFor();

    const result = await sendOwnerAlert(
      { port, transport, wait: () => Promise.resolve(), now: () => NOW },
      {
        ...alert,
        notificationKey: 'approval_needed:leaky',
        detail: 'Approval needed from ada@example.com for card 4111 1111 1111 1111.',
      },
    );

    expect(posted).toHaveLength(0);
    expect(result.outcome).toBe('failed');
    // Not retryable: the same content would be refused again.
    expect(result.attemptCount).toBe(1);
    expect(port.notifications.get('approval_needed:leaky')?.state).toBe('failed');
  });

  it('API-385 a customer template routed here is refused before any HTTP call', async () => {
    const { posted, transport } = transportFor();
    const outcome = await transport.send({
      to: 'owner:telegram',
      subject: 'Your data export is ready',
      text: 'Download it here.',
      html: '',
      kind: 'data_export_ready',
    });

    expect(posted).toHaveLength(0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.providerStatus).toBe('refused:kind_not_permitted');
  });

  it('API-386 a message with no kind at all is refused — default deny', async () => {
    const { posted, transport } = transportFor();
    const outcome = await transport.send({
      to: 'owner:telegram',
      subject: 'Something',
      text: 'Anything.',
      html: '',
    });

    expect(posted).toHaveLength(0);
    expect(outcome.providerStatus).toBe('refused:kind_missing');
  });

  it('API-387 a long alert is posted as several messages, in order, with nothing dropped', async () => {
    const { posted, transport } = transportFor();
    const lines = Array.from({ length: 300 }, (_, i) => `checkpoint ${String(i)} reached`);

    const outcome = await transport.send({
      to: 'owner:telegram',
      subject: 'Milestone',
      text: lines.join('\n'),
      html: '',
      kind: 'milestone_reached',
    });

    expect(outcome.accepted).toBe(true);
    expect(posted.length).toBeGreaterThan(1);
    const sent = posted.map((p) => (JSON.parse(p.body) as { text: string }).text).join('\n');
    for (const line of lines) expect(sent).toContain(line);
  });

  it('API-388 a 5xx is retryable and a 4xx is not, and neither leaks the token', async () => {
    const serverError = transportFor([{ ok: false, status: 503 }]);
    const failed = await serverError.transport.send({
      to: 'owner:telegram',
      subject: 'Incident',
      text: 'Verification is degraded.',
      html: '',
      kind: 'critical_incident',
    });
    expect(failed.accepted).toBe(false);
    expect(failed.retryable).toBe(true);
    expect(failed.providerStatus).toBe('http_503');

    const badRequest = transportFor([{ ok: false, status: 400 }]);
    const rejected = await badRequest.transport.send({
      to: 'owner:telegram',
      subject: 'Incident',
      text: 'Verification is degraded.',
      html: '',
      kind: 'critical_incident',
    });
    expect(rejected.retryable).toBe(false);
    expect(rejected.providerStatus).toBe('http_400');

    expect(JSON.stringify([failed, rejected])).not.toContain(FAKE_TOKEN);
  });

  it('API-389 a transport error carrying the request URL never returns the token', async () => {
    const leakyFetch: TelegramFetch = (url) => {
      // Exactly what a real HTTP client does: the failure message contains the URL, and
      // the URL contains the token.
      return Promise.reject(new Error(`request to ${url} failed: ECONNRESET`));
    };
    const transport = new TelegramTransport(
      { token: FAKE_TOKEN, ownerChatId: FAKE_CHAT, apiBase: 'https://api.telegram.org' },
      leakyFetch,
    );

    const outcome = await transport.send({
      to: 'owner:telegram',
      subject: 'Incident',
      text: 'Verification is degraded.',
      html: '',
      kind: 'critical_incident',
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.providerStatus).not.toContain(FAKE_TOKEN);
    expect(outcome.providerStatus).toContain('[REDACTED-TOKEN]');
  });

  it('API-390 the owner chat id is never stored — only a hash of a reference', async () => {
    const port = new InMemorySupportData();
    const { transport } = transportFor();

    await sendOwnerAlert({ port, transport, wait: () => Promise.resolve(), now: () => NOW }, alert);

    const stored = JSON.stringify(port.notifications.get(alert.notificationKey));
    expect(stored).not.toContain(FAKE_CHAT);
    expect(stored).not.toContain(FAKE_TOKEN);
  });
});

describe('stale pending deliveries, for A07', () => {
  it('API-391 a delivery claimed but never settled is readable, so at-most-once stays honest', async () => {
    const port = new InMemorySupportData();

    // A transport that never returns: the shape of a worker dying mid-send. The key is
    // claimed, the settle never happens. It signals once it has been called, so this test
    // waits on an event rather than on a guessed number of microtasks.
    let reached = (): void => undefined;
    const sendWasReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const stuck: TelegramFetch = () => {
      reached();
      return new Promise(() => undefined);
    };
    const transport = new TelegramTransport(
      { token: FAKE_TOKEN, ownerChatId: FAKE_CHAT, apiBase: 'https://api.telegram.org' },
      stuck,
    );

    void sendOwnerAlert({ port, transport, wait: () => Promise.resolve(), now: () => NOW }, alert);
    // The claim happens before the send, so reaching the send proves the row exists.
    await sendWasReached;

    const stale = await port.listStalePendingNotifications({
      createdBefore: '2026-09-19T13:00:00.000Z',
      limit: 50,
    });

    expect(stale).toHaveLength(1);
    expect(stale[0]?.notificationKey).toBe(alert.notificationKey);
    expect(stale[0]?.state).toBe('pending');

    // A row created after the cut-off is not "stuck", it is merely recent.
    const notYet = await port.listStalePendingNotifications({
      createdBefore: '2026-09-19T11:00:00.000Z',
      limit: 50,
    });
    expect(notYet).toHaveLength(0);
  });
});
