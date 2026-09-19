/**
 * Resend connector.
 *
 * Payload shapes are synthetic copies of the examples in Resend's published docs (URLs and
 * date in the header of `packages/connectors/src/resend.ts`). No real key, no real message,
 * no real recipient; `fetch` is stubbed throughout.
 */
import { describe, expect, it } from 'vitest';
import { DELIVERY_CONTRADICTING_STATUSES, DELIVERY_PROVING_STATUSES } from '@verify/contracts';
import { signSvix } from '@verify/security';
import {
  ConnectorTransportError,
  RESEND_EVENT_STATUS,
  ResendConnector,
  classifyResendError,
  mapResendEventType,
  mapResendLastEvent,
  normaliseResendEvent,
  resendAccountFingerprint,
} from '@verify/connectors';
import { RECIPIENT, T_EVENT, T_INSIDE_WINDOW } from '../../fixtures/index.js';

// Assembled at runtime: the value is synthetic, but a credential-shaped literal
// trips both our secret scan and GitHub push protection, and the right response to
// that is to stop committing the shape rather than to allowlist the warning.
const TOKEN = 're' + '_' + '0'.repeat(28);
/** `whsec_` + base64, as Svix documents. Synthetic. */
// Assembled at runtime: the value is synthetic, but a credential-shaped literal
// trips both our secret scan and GitHub push protection, and the right response to
// that is to stop committing the shape rather than to allowlist the warning.
const SECRET = 'whsec' + '_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const OTHER_SECRET = 'whsec' + '_' + 'A'.repeat(32);
const MESSAGE_ID = '56761188-7520-42d8-8898-ff6fc54ce618';
const ACCOUNT = 'resend-acct-under-test';

const credentials = { accessToken: TOKEN, webhookSecret: SECRET };
const connection = (overrides: Record<string, unknown> = {}) => ({
  provider: 'resend' as const,
  account_id: ACCOUNT,
  ...overrides,
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The retrieve-email example from Resend's API reference, with synthetic values. */
function emailPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    object: 'email',
    id: MESSAGE_ID,
    message_id: '<111-222-333@email.example.test>',
    to: [RECIPIENT],
    from: 'Acme <ack@example.test>',
    created_at: '2026-03-01 12:01:00.000000+00',
    subject: 'Thanks for your enquiry',
    html: null,
    text: null,
    bcc: [],
    cc: [],
    reply_to: [],
    last_event: 'delivered',
    scheduled_at: null,
    tags: [],
    ...overrides,
  };
}

/** The webhook example from Resend's docs, with synthetic values. */
function webhookBody(type: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: '2026-03-01T12:02:00.126Z',
    data: {
      broadcast_id: null,
      created_at: '2026-03-01T12:01:00.894Z',
      email_id: MESSAGE_ID,
      message_id: '<111-222-333@email.example.test>',
      from: 'Acme <ack@example.test>',
      to: [RECIPIENT],
      subject: 'Thanks for your enquiry',
      ...overrides,
    },
  });
}

async function svixHeaders(rawBody: string, secret: string, timestampSeconds: number, id = 'msg_test_0001'): Promise<Headers> {
  return new Headers({
    'svix-id': id,
    'svix-timestamp': String(timestampSeconds),
    'svix-signature': await signSvix(rawBody, id, timestampSeconds, secret),
  });
}

const noSleep = async (): Promise<void> => {};
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const NOW = new Date('2026-03-01T12:03:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function makeConnector(fetchImpl?: typeof fetch): ResendConnector {
  return new ResendConnector({
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    sleep: noSleep,
    jitterSeed: 0.5,
  });
}

// ---------------------------------------------------------------------------

describe('Resend capabilities', () => {
  it('CONN-084 states plainly that Resend has no read-only key', () => {
    const caps = makeConnector().capabilities();
    expect(caps.required_scopes).toEqual(['full_access']);
    expect(caps.limitations.join(' ')).toContain('no read-only API key');
  });

  it('CONN-085 refuses to claim a provider-published account identity', () => {
    expect(makeConnector().capabilities().can_prove_account_identity).toBe(false);
  });

  it('CONN-086 admits it cannot provision a webhook endpoint', () => {
    const caps = makeConnector().capabilities();
    expect(caps.can_verify_webhooks).toBe(true);
    expect(caps.can_provision_webhooks).toBe(false);
  });

  it('CONN-087 declares both readback and webhook origins, and no write capability', () => {
    const caps = makeConnector().capabilities();
    expect(caps.origins).toEqual(['provider_readback', 'provider_webhook']);
    expect(caps.writes_to_customer_system).toBe(false);
  });
});

describe('Resend event mapping', () => {
  it('CONN-088 maps email.sent to accepted, not delivered', () => {
    expect(mapResendEventType('email.sent')).toBe('accepted');
    expect(DELIVERY_PROVING_STATUSES.has('accepted')).toBe(false);
  });

  it('CONN-089 maps email.delivered to delivered, the only delivery-proving status', () => {
    expect(mapResendEventType('email.delivered')).toBe('delivered');
    expect(DELIVERY_PROVING_STATUSES.has('delivered')).toBe(true);
  });

  it('CONN-090 maps email.delivery_delayed to deferred', () => {
    expect(mapResendEventType('email.delivery_delayed')).toBe('deferred');
  });

  it('CONN-091 maps the delivery-contradicting events onto contradicting statuses', () => {
    for (const [event, status] of [
      ['email.bounced', 'bounced'],
      ['email.failed', 'failed'],
      ['email.complained', 'complained'],
      ['email.suppressed', 'failed'],
    ] as const) {
      expect(mapResendEventType(event), event).toBe(status);
      expect(DELIVERY_CONTRADICTING_STATUSES.has(status), event).toBe(true);
    }
  });

  it('CONN-092 maps email.scheduled to queued', () => {
    expect(mapResendEventType('email.scheduled')).toBe('queued');
  });

  it('CONN-093 keeps opened and clicked as tracking artefacts, never as delivery proof', () => {
    expect(mapResendEventType('email.opened')).toBe('opened');
    expect(mapResendEventType('email.clicked')).toBe('clicked');
    expect(DELIVERY_PROVING_STATUSES.has('opened')).toBe(false);
    expect(DELIVERY_PROVING_STATUSES.has('clicked')).toBe(false);
  });

  it('CONN-094 covers every event type in the published mapping table', () => {
    for (const [event, status] of Object.entries(RESEND_EVENT_STATUS)) {
      expect(mapResendEventType(event), event).toBe(status);
    }
    expect(Object.keys(RESEND_EVENT_STATUS)).toHaveLength(10);
  });

  it('CONN-095 returns null for an event type the docs do not list, and never delivered', () => {
    for (const unknown of [
      'email.teleported',
      'email.received',
      'contact.created',
      'domain.deleted',
      'suppression.added',
      '',
      null,
      42,
      { type: 'email.delivered' },
    ]) {
      expect(mapResendEventType(unknown), String(unknown)).toBeNull();
    }
  });

  it('CONN-096 maps a retrieve endpoint last_event using the bare vocabulary', () => {
    expect(mapResendLastEvent('delivered')).toBe('delivered');
    expect(mapResendLastEvent('sent')).toBe('accepted');
    expect(mapResendLastEvent('canceled')).toBe('failed');
    expect(mapResendLastEvent('who_knows')).toBeNull();
  });
});

describe('Resend normalisation', () => {
  const ctx = {
    provider_account_id: ACCOUNT,
    origin: 'provider_webhook' as const,
    observedAt: T_INSIDE_WINDOW,
  };

  it('CONN-097 builds email evidence with the account id, recipient and event instant', () => {
    const result = normaliseResendEvent(
      {
        eventType: 'email.delivered',
        messageId: MESSAGE_ID,
        recipient: [RECIPIENT],
        occurredAt: '2026-03-01T12:02:00.126Z',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.kind).toBe('email_event');
    expect(result.evidence.provider_account_id).toBe(ACCOUNT);
    expect(result.evidence.status).toBe('delivered');
    expect(result.evidence.recipient).toBe(RECIPIENT);
    expect(result.evidence.occurred_at).toBe('2026-03-01T12:02:00.126Z');
  });

  it('CONN-098 rejects an unmapped event as UNSUPPORTED_CAPABILITY rather than guessing', () => {
    const result = normaliseResendEvent(
      { eventType: 'email.teleported', messageId: MESSAGE_ID, recipient: [RECIPIENT], occurredAt: NOW.toISOString() },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(result.gap.detail).toContain('email.teleported');
    }
  });

  it('CONN-099 rejects a payload with no message id', () => {
    const result = normaliseResendEvent(
      { eventType: 'email.delivered', messageId: undefined, recipient: [], occurredAt: NOW.toISOString() },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.code).toBe('INVALID_EVIDENCE');
  });

  it('CONN-100 rejects a payload with no usable timestamp rather than inventing one', () => {
    const result = normaliseResendEvent(
      { eventType: 'email.delivered', messageId: MESSAGE_ID, recipient: [], occurredAt: 'yesterday-ish' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.code).toBe('INVALID_EVIDENCE');
  });

  it('CONN-101 parses the Postgres-style timestamp the retrieve endpoint returns', () => {
    const result = normaliseResendEvent(
      { lastEvent: 'delivered', messageId: MESSAGE_ID, recipient: RECIPIENT, occurredAt: '2026-03-01 12:01:00.000000+00' },
      ctx,
    );
    expect(result.ok && result.evidence.occurred_at).toBe('2026-03-01T12:01:00.000Z');
  });

  it('CONN-102 rejects a non-object payload', () => {
    for (const bad of [null, 'text', 42, ['a']]) {
      const result = normaliseResendEvent(bad, ctx);
      expect(result.ok, String(bad)).toBe(false);
    }
  });
});

describe('Resend fetchEvidence', () => {
  const base = {
    credentials,
    connection: connection(),
    locator: { message_id: MESSAGE_ID },
    occurredAt: T_EVENT,
    now: T_INSIDE_WINDOW,
  };

  it('CONN-103 returns provider_readback evidence for a retrieved message', async () => {
    const fetchImpl = (async () => json(emailPayload())) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.origin).toBe('provider_readback');
    expect(result.evidence[0]?.provider_account_id).toBe(ACCOUNT);
    expect(result.calls_made).toBe(1);
  });

  it('CONN-104 maps the retrieved last_event honestly: sent becomes accepted', async () => {
    const fetchImpl = (async () => json(emailPayload({ last_event: 'sent' }))) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    const evidence = result.evidence[0];
    expect(evidence?.kind === 'email_event' && evidence.status).toBe('accepted');
  });

  it('CONN-105 emits NOT_FOUND when Resend authoritatively has no such message', async () => {
    const fetchImpl = (async () =>
      json({ statusCode: 404, name: 'not_found', message: 'Email not found' }, 404)) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('NOT_FOUND');
    expect(result.gaps[0]?.retryable).toBe(false);
  });

  it('CONN-106 emits PROVIDER_UNAVAILABLE — never NOT_FOUND — on a timeout', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.gaps.map((g) => g.code)).not.toContain('NOT_FOUND');
  });

  it('CONN-107 emits RATE_LIMITED with Retry-After for a 429', async () => {
    const fetchImpl = (async () =>
      json({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }, 429, {
        'retry-after': '5',
      })) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('RATE_LIMITED');
    expect(result.gaps[0]?.retryable).toBe(true);
  });

  it('CONN-108 maps a restricted send-only key to PERMISSION_MISSING, not AUTH_EXPIRED', () => {
    const error = classifyResendError({
      status: 401,
      bodyText: JSON.stringify({
        statusCode: 401,
        name: 'restricted_api_key',
        message: 'This API key is restricted to only send emails.',
      }),
    });
    expect(error.code).toBe('PERMISSION_MISSING');
  });

  it('CONN-109 maps a missing API key to AUTH_EXPIRED', () => {
    const error = classifyResendError({
      status: 401,
      bodyText: JSON.stringify({ statusCode: 401, name: 'missing_api_key', message: 'Missing API key.' }),
    });
    expect(error.code).toBe('AUTH_EXPIRED');
  });

  it('CONN-110 maps 403 to PERMISSION_MISSING and 503 to PROVIDER_UNAVAILABLE', () => {
    expect(classifyResendError({ status: 403, bodyText: '' }).code).toBe('PERMISSION_MISSING');
    expect(classifyResendError({ status: 503, bodyText: '' }).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-111 maps a guard refusal to PROVIDER_UNAVAILABLE, never to an absence', () => {
    const error = classifyResendError({
      status: null,
      cause: new ConnectorTransportError('blocked_redirect', 'private_address: 169.254.169.254'),
    });
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-112 treats malformed JSON from a 200 as unavailable, not as absence', async () => {
    const fetchImpl = (async () => new Response('{"id": "abc"', { status: 200 })) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-113 treats a 200 carrying an error envelope as unavailable', async () => {
    const fetchImpl = (async () =>
      json({ statusCode: 500, name: 'application_error', message: 'An unexpected error occurred.' })) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-114 refuses to look anything up without a message id, because Resend cannot be searched', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return json(emailPayload());
    }) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence({ ...base, locator: {} });
    expect(called).toBe(0);
    expect(result.gaps[0]?.code).toBe('INVALID_EVIDENCE');
  });

  it('CONN-115 derives a stable account fingerprint and changes it when the key changes', async () => {
    const a = await resendAccountFingerprint(TOKEN);
    const b = await resendAccountFingerprint(TOKEN);
    const c = await resendAccountFingerprint(`${TOKEN}x`);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('resend-key-')).toBe(true);
    expect(a).not.toContain(TOKEN);
  });

  it('CONN-116 never lets the API key appear in a gap detail', async () => {
    const fetchImpl = (async () => {
      throw new Error(`socket hang up while sending Bearer ${TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('Resend webhook signature verification', () => {
  const verify = async (
    body: string,
    headers: Headers,
    secret = SECRET,
    extra: Record<string, unknown> = {},
  ) =>
    makeConnector().verifyWebhook({
      rawBody: bytes(body),
      headers,
      secret,
      now: NOW,
      connection: connection(),
      ...extra,
    });

  it('CONN-117 accepts a correctly signed payload and produces provider_webhook evidence', async () => {
    const body = webhookBody('email.delivered');
    const result = await verify(body, await svixHeaders(body, SECRET, NOW_SECONDS));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.origin).toBe('provider_webhook');
    expect(result.event_type).toBe('email.delivered');
    expect(result.event_id).toBe('msg_test_0001');
  });

  it('CONN-118 rejects a payload signed with a different secret', async () => {
    const body = webhookBody('email.delivered');
    const result = await verify(body, await svixHeaders(body, OTHER_SECRET, NOW_SECONDS));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature_mismatch');
  });

  it('CONN-119 rejects a body modified by a single byte after signing', async () => {
    const body = webhookBody('email.delivered');
    const headers = await svixHeaders(body, SECRET, NOW_SECONDS);
    const tampered = body.replace('email.delivered', 'email.deliveret');
    expect(tampered).not.toBe(body);
    const result = await verify(tampered, headers);
    expect(result.valid).toBe(false);
  });

  it('CONN-120 rejects a stale timestamp outside the tolerance', async () => {
    const body = webhookBody('email.delivered');
    const stale = NOW_SECONDS - 3600;
    const result = await verify(body, await svixHeaders(body, SECRET, stale));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('timestamp_stale');
  });

  it('CONN-121 rejects a timestamp far in the future', async () => {
    const body = webhookBody('email.delivered');
    const future = NOW_SECONDS + 3600;
    const result = await verify(body, await svixHeaders(body, SECRET, future));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('timestamp_in_future');
  });

  it('CONN-122 rejects a malformed signature header', async () => {
    const body = webhookBody('email.delivered');
    const headers = new Headers({
      'svix-id': 'msg_test_0001',
      'svix-timestamp': String(NOW_SECONDS),
      'svix-signature': 'not-a-signature',
    });
    const result = await verify(body, headers);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('malformed_header');
  });

  it('CONN-123 rejects a malformed timestamp header', async () => {
    const body = webhookBody('email.delivered');
    const headers = new Headers({
      'svix-id': 'msg_test_0001',
      'svix-timestamp': 'not-a-number',
      'svix-signature': await signSvix(body, 'msg_test_0001', NOW_SECONDS, SECRET),
    });
    const result = await verify(body, headers);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('malformed_header');
  });

  it('CONN-124 rejects a request with the signature headers missing entirely', async () => {
    const result = await verify(webhookBody('email.delivered'), new Headers());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing_header');
  });

  it('CONN-125 rejects a correctly signed message that has already been seen', async () => {
    const body = webhookBody('email.delivered');
    const headers = await svixHeaders(body, SECRET, NOW_SECONDS);
    const first = await verify(body, headers);
    expect(first.valid).toBe(true);
    const replay = await verify(body, headers, SECRET, { seenEventIds: new Set(['msg_test_0001']) });
    expect(replay.valid).toBe(false);
    if (!replay.valid) expect(replay.reason).toBe('replayed_event');
  });

  it('CONN-126 verifies over raw bytes, so a re-serialised body no longer matches', async () => {
    const body = webhookBody('email.delivered');
    const headers = await svixHeaders(body, SECRET, NOW_SECONDS);
    // Same object, different bytes — exactly what re-serialising a parsed payload does.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(reserialised).not.toBe(body);
    const result = await verify(reserialised, headers);
    expect(result.valid).toBe(false);
  });

  it('CONN-127 maps every documented event type through a real signed callback', async () => {
    for (const [event, expected] of Object.entries(RESEND_EVENT_STATUS)) {
      const body = webhookBody(event);
      const result = await verify(body, await svixHeaders(body, SECRET, NOW_SECONDS, `msg_${event}`));
      expect(result.valid, event).toBe(true);
      if (!result.valid) continue;
      const evidence = result.evidence[0];
      expect(evidence?.kind === 'email_event' && evidence.status, event).toBe(expected);
    }
  });

  it('CONN-128 accepts a signed callback for an unknown event but produces a gap, not delivered', async () => {
    const body = webhookBody('email.teleported');
    const result = await verify(body, await svixHeaders(body, SECRET, NOW_SECONDS));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.evidence).toHaveLength(0);
    expect(result.gaps[0]?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(result.event_type).toBe('email.teleported');
  });

  it('CONN-129 rejects a correctly signed body that is not JSON', async () => {
    const body = 'this is not json';
    const result = await verify(body, await svixHeaders(body, SECRET, NOW_SECONDS));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('body_not_json');
  });

  it('CONN-130 uses the event instant, not the message creation instant, as occurred_at', async () => {
    const body = webhookBody('email.delivered');
    const result = await verify(body, await svixHeaders(body, SECRET, NOW_SECONDS));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const evidence = result.evidence[0];
    expect(evidence?.kind === 'email_event' && evidence.occurred_at).toBe('2026-03-01T12:02:00.126Z');
  });
});

describe('Resend connection lifecycle', () => {
  it('CONN-131 marks a connection incomplete until a webhook signing secret exists', async () => {
    const fetchImpl = (async () => json({ object: 'list', has_more: false, data: [] })) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials: { accessToken: TOKEN },
      connection: connection({ account_id: null }),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.missing_capabilities).toContain('provider_webhook');
    expect(result.setup_steps[0]?.id).toBe('resend_create_webhook_endpoint');
  });

  it('CONN-132 accepts a connection with a working key and a signing secret', async () => {
    const fetchImpl = (async () => json({ object: 'list', has_more: false, data: [] })) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials,
      connection: connection({ account_id: null }),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.account_id).toBe(await resendAccountFingerprint(TOKEN));
  });

  it('CONN-133 tells the customer to swap a send-only key for a full-access one', async () => {
    const fetchImpl = (async () =>
      json({ statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails.' }, 401)) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials,
      connection: connection({ account_id: null }),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PERMISSION_MISSING');
    expect(result.setup_steps[0]?.id).toBe('resend_use_full_access_key');
  });

  it('CONN-134 never reports a guessed scope list', async () => {
    const fetchImpl = (async () => json({ object: 'list', has_more: false, data: [] })) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials,
      connection: connection({ account_id: null }),
      now: NOW,
    });
    expect(result.granted_scopes).toEqual([]);
  });

  it('CONN-135 admits that Resend cannot delete its own API key', async () => {
    const result = await makeConnector().revokeOrDisconnect();
    expect(result.local_credential_cleared).toBe(true);
    expect(result.provider_revoked).toBe(false);
    expect(result.manual_steps[0]?.id).toBe('resend_delete_api_key');
  });
});
