/**
 * CUST-2xx — sending, end to end, against the in-memory port.
 *
 * The three properties under test are the ones a queue will attack: a redelivered message
 * must not send twice, a missing `RESEND_API_KEY` must not break a request path, and the
 * recorded status must never claim delivery — not even when the provider's own word is
 * "delivered".
 *
 * `fetch` is blocked by `tests/setup.ts`; the transport here is a recorder, and no test in
 * this repository may send a real email.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySupportData, RecordingTransport } from '@app/support/memory';
import {
  MAX_SEND_ATTEMPTS,
  STATUS_STATEMENT,
  notificationKey,
  recordedStatusFor,
  sendNotification,
  transportFromEnv,
  type SendDependencies,
} from '@app/notifications/send';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function deps(port: InMemorySupportData, transport?: RecordingTransport): SendDependencies {
  return {
    port,
    ...(transport === undefined ? {} : { transport }),
    // Injected so bounded backoff does not make the suite sleep.
    wait: () => Promise.resolve(),
    now: () => NOW,
  };
}

const request = {
  notificationKey: notificationKey('deletion_completed', 'ws_1'),
  workspaceId: 'ws_1' as string | null,
  recipientEmail: 'owner@example.com',
  template: 'deletion_completed' as const,
  vars: {
    workspaceName: 'Acme',
    retainedStatement: 'We still hold 2 billing records.',
  },
};

describe('sending notifications', () => {
  it('CUST-250 a duplicate notification key sends exactly once', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();

    const first = await sendNotification(deps(port, transport), request);
    const second = await sendNotification(deps(port, transport), request);

    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('duplicate');
    expect(transport.sent).toHaveLength(1);
    expect(port.notifications.size).toBe(1);
  });

  it('CUST-251 a repeated queue message consumes no second attempt and leaves the original record', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();

    await sendNotification(deps(port, transport), request);
    const before = port.notifications.get(request.notificationKey);

    for (let i = 0; i < 5; i += 1) {
      await sendNotification(deps(port, transport), request);
    }

    const after = port.notifications.get(request.notificationKey);
    expect(transport.sent).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after?.attemptCount).toBe(1);
  });

  it('CUST-252 with no email transport configured, the path still works and records suppressed', async () => {
    const port = new InMemorySupportData();

    // No `transport` at all — the shape of `RESEND_API_KEY` being unset.
    const result = await sendNotification(deps(port), request);

    expect(result.outcome).toBe('suppressed');
    expect(result.state).toBe('suppressed');
    expect(result.providerStatus).toBe('no_email_transport_configured');
    expect(result.statement).toBe(STATUS_STATEMENT.no_email_transport_configured);

    const stored = port.notifications.get(request.notificationKey);
    expect(stored?.state).toBe('suppressed');
    expect(stored?.providerStatus).toBe('no_email_transport_configured');
  });

  it('CUST-253 transportFromEnv returns undefined for an absent or blank key, and never throws', () => {
    const build = () => new RecordingTransport();
    expect(transportFromEnv({}, build)).toBeUndefined();
    expect(transportFromEnv({ RESEND_API_KEY: '' }, build)).toBeUndefined();
    expect(transportFromEnv({ RESEND_API_KEY: '   ' }, build)).toBeUndefined();
    expect(transportFromEnv({ RESEND_API_KEY: 're_test_key' }, build)).toBeDefined();
  });

  it('CUST-254 a retryable failure is retried up to the bound, then recorded as failed', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      transport.outcomes.push({
        accepted: false,
        providerStatus: '503',
        retryable: true,
      });
    }

    const result = await sendNotification(deps(port, transport), request);

    expect(transport.sent).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(result.outcome).toBe('failed');
    expect(result.attemptCount).toBe(MAX_SEND_ATTEMPTS);
    expect(result.providerStatus).toBe('sending_service_unavailable');
  });

  it('CUST-255 a non-retryable rejection is not retried', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();
    transport.outcomes.push({
      accepted: false,
      providerStatus: 'blocked',
      retryable: false,
    });

    const result = await sendNotification(deps(port, transport), request);

    expect(transport.sent).toHaveLength(1);
    expect(result.providerStatus).toBe('rejected_by_sending_service');
  });

  it('CUST-256 the recorded status never claims delivery, even when the provider says "delivered"', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();
    transport.outcomes.push({
      accepted: true,
      providerStatus: 'delivered',
      retryable: false,
    });

    const result = await sendNotification(deps(port, transport), request);

    expect(result.providerStatus).toBe('accepted_by_sending_service');
    expect(port.notifications.get(request.notificationKey)?.providerStatus).toBe(
      'accepted_by_sending_service',
    );
    for (const statement of Object.values(STATUS_STATEMENT)) {
      expect(statement.toLowerCase()).not.toMatch(/\bwas delivered\b/);
    }
    expect(
      recordedStatusFor({
        accepted: true,
        providerStatus: 'delivered',
        retryable: false,
      }),
    ).toBe('accepted_by_sending_service');
  });

  it('CUST-257 a transport that throws does not throw out of sendNotification', async () => {
    const port = new InMemorySupportData();
    const throwing = {
      send: () => Promise.reject(new Error('socket hung up')),
    };

    const result = await sendNotification(
      {
        port,
        transport: throwing,
        wait: () => Promise.resolve(),
        now: () => NOW,
      },
      request,
    );

    expect(result.outcome).toBe('failed');
    expect(result.providerStatus).toBe('transport_error');
    expect(port.notifications.get(request.notificationKey)?.state).toBe('failed');
  });

  it('CUST-258 an unusable recipient address is recorded rather than retried', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();

    const result = await sendNotification(deps(port, transport), {
      ...request,
      recipientEmail: 'not-an-address',
    });

    expect(transport.sent).toHaveLength(0);
    expect(result.providerStatus).toBe('recipient_address_unusable');
    expect(result.state).toBe('failed');
  });

  it('CUST-259 the recipient address is never stored — only a hash of it', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();

    await sendNotification(deps(port, transport), request);

    const stored = port.notifications.get(request.notificationKey);
    expect(stored?.recipientHash).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('owner@example.com');
  });

  it('CUST-260 a grouping suppression is recorded without a send', async () => {
    const port = new InMemorySupportData();
    const transport = new RecordingTransport();

    const result = await sendNotification(deps(port, transport), {
      ...request,
      suppress: 'suppressed_by_grouping',
    });

    expect(transport.sent).toHaveLength(0);
    expect(result.outcome).toBe('suppressed');
    expect(result.providerStatus).toBe('suppressed_by_grouping');
  });

  it('CUST-261 a notification key must be built from stable parts, never a clock reading', () => {
    expect(notificationKey('welcome', 'ws_1')).toBe('welcome:ws_1');
    expect(() => notificationKey('welcome')).toThrow(TypeError);
    expect(() => notificationKey('welcome', '  ')).toThrow(TypeError);
  });
});
