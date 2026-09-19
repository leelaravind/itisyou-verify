/**
 * The email transport.
 *
 * `send.ts` has always been written against a `NotificationTransport`, and nothing in the
 * repository implemented one for email. So every wiring of the notification path would
 * have had `transport: undefined`, every message would have settled as
 * `no_email_transport_configured`, and the whole thing would have been green and silent.
 *
 * Three properties matter here and none of them are about happy-path sending:
 *  - an accepted submission is reported as acceptance and never as delivery;
 *  - the API key cannot reach `provider_status`, which the owner dashboard renders;
 *  - only a fault a retry could plausibly fix is marked retryable.
 */
import { describe, expect, it } from 'vitest';
import {
  RESEND_SEND_ENDPOINT,
  ResendEmailTransport,
  createEmailTransport,
} from '@app/notifications/email';
import { recordedStatusFor } from '@app/notifications/send';

/** Assembled at runtime — see `docs/agent-brief.md` on credential-shaped literals. */
const API_KEY = ['re', 'test', 'Z'.repeat(24)].join('_');
const FROM = 'verify@example.test';

const MESSAGE = {
  to: 'someone@example.com',
  subject: 'Subject',
  text: 'Body',
  html: '<p>Body</p>',
};

function transportWith(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): ResendEmailTransport {
  return new ResendEmailTransport({
    apiKey: API_KEY,
    fromAddress: FROM,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init ?? {})) as typeof fetch,
  });
}

describe('CUST-370 the email transport', () => {
  it('CUST-370 posts to the one fixed host and reports acceptance, never delivery', async () => {
    const seen: { url: string; body: unknown; auth: string }[] = [];
    const transport = transportWith((url, init) => {
      seen.push({
        url,
        body: JSON.parse(String(init.body)) as unknown,
        auth: String((init.headers as Record<string, string>)['authorization']),
      });
      // Resend answering with its most confident-sounding word.
      return new Response(JSON.stringify({ id: 'msg_1', status: 'delivered' }), { status: 200 });
    });

    const result = await transport.send(MESSAGE);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(RESEND_SEND_ENDPOINT);
    expect(seen[0]?.auth).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]?.body).toEqual({
      from: FROM,
      to: ['someone@example.com'],
      subject: 'Subject',
      text: 'Body',
      html: '<p>Body</p>',
    });

    expect(result.accepted).toBe(true);
    // And the recorded status is acceptance even though the provider said "delivered".
    expect(recordedStatusFor(result)).toBe('accepted_by_sending_service');
  });

  it('CUST-371 never lets the API key reach the recorded provider status', async () => {
    // An upstream error body that echoes the credential back — the exact shape that puts a
    // live key into a database column the owner dashboard renders.
    const transport = transportWith(
      () =>
        new Response(JSON.stringify({ name: `bad_key ${API_KEY}` }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await transport.send(MESSAGE);

    expect(result.accepted).toBe(false);
    expect(result.providerStatus).not.toContain(API_KEY);
    expect(result.providerStatus).toContain('http_401');
    // A 401 is our configuration, not a transient fault. Retrying is just three 401s.
    expect(result.retryable).toBe(false);
  });

  it('CUST-372 marks 429 and 5xx retryable and a network fault retryable', async () => {
    for (const status of [429, 500, 503]) {
      const transport = transportWith(() => new Response('', { status }));
      const result = await transport.send(MESSAGE);
      expect(result.retryable).toBe(true);
      expect(recordedStatusFor(result)).toBe('sending_service_unavailable');
    }

    const thrower = transportWith(() => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
    });
    const failure = await thrower.send(MESSAGE);
    expect(failure.accepted).toBe(false);
    expect(failure.retryable).toBe(true);
    expect(failure.providerStatus).toBe('network_TypeError');
  });

  it('CUST-373 a 4xx recipient rejection is recorded as an unusable address, not a retry', async () => {
    const transport = transportWith(
      () =>
        new Response(JSON.stringify({ name: 'invalid_recipient' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await transport.send(MESSAGE);
    expect(recordedStatusFor(result)).toBe('recipient_address_unusable');
  });

  it('CUST-374 no transport is built without both a key and a verified sender', () => {
    expect(createEmailTransport({})).toBeUndefined();
    expect(createEmailTransport({ RESEND_API_KEY: API_KEY })).toBeUndefined();
    expect(createEmailTransport({ RESEND_FROM_ADDRESS: FROM })).toBeUndefined();
    expect(
      createEmailTransport({ RESEND_API_KEY: '  ', RESEND_FROM_ADDRESS: FROM }),
    ).toBeUndefined();
    expect(
      createEmailTransport({ RESEND_API_KEY: API_KEY, RESEND_FROM_ADDRESS: FROM }),
    ).toBeInstanceOf(ResendEmailTransport);
  });
});
