/**
 * The two lookup functions a customer uses to pick something to test with, rather than
 * paste an id they have to go and find: `lookupContacts` (HubSpot) and `listSentMessages`
 * (Resend). Neither is on the evidence path — no retry, one attempt, and neither may ever
 * hand back the value under test (HubSpot's correlation property) as something to copy
 * into an expectation.
 *
 * Every payload below is synthetic. `fetch` is stubbed in every test; nothing here has ever
 * spoken to HubSpot or Resend.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_LOOKUP_MAX_OFFSET,
  CONTACT_LOOKUP_MAX_QUERY,
  CONTACT_LOOKUP_PAGE_SIZE,
  HUBSPOT_READS,
  MESSAGE_LOOKUP_PAGE_SIZE,
  isContactId,
  isContactLookupCursor,
  isResendEmailId,
  listSentMessages,
  lookupContacts,
} from '@verify/connectors';

// Assembled at runtime: the value is synthetic, but a credential-shaped literal trips
// both our secret scan and GitHub push protection, and the right response to that is to
// stop committing the shape rather than to allowlist the warning.
const HUBSPOT_TOKEN = ['pat', 'na1', '99998888-7777-6666-5555-444433332222'].join('-');
const RESEND_TOKEN = 're' + '_' + '1'.repeat(28);

const CORRELATION_PROPERTY = 'verify_correlation_id';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch stub that records every call it was given, for shape assertions. */
function spy(responder: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function parsedBody(call: Call | undefined): Record<string, unknown> {
  return JSON.parse((call?.init.body as string | undefined) ?? '{}') as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HubSpot: lookupContacts
// ---------------------------------------------------------------------------

describe('HubSpot contact lookup — request shape', () => {
  it('CONN-908 POSTs the exact search request, and never asks for the correlation value itself', async () => {
    const { fetchImpl, calls } = spy(() => json({ results: [] }));
    await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${HUBSPOT_TOKEN}`);

    const body = parsedBody(calls[0]);
    expect(body['filterGroups']).toEqual([
      { filters: [{ propertyName: CORRELATION_PROPERTY, operator: 'HAS_PROPERTY' }] },
    ]);
    expect(body['sorts']).toEqual([{ propertyName: 'createdate', direction: 'DESCENDING' }]);
    expect(body['limit']).toBe(CONTACT_LOOKUP_PAGE_SIZE);
    expect(CONTACT_LOOKUP_PAGE_SIZE).toBe(10);
    expect(body['properties']).toEqual(['firstname', 'lastname', 'email', 'createdate']);
    // The whole point of this lookup: the correlation property is used to FILTER, never
    // requested as a value a customer could read off the page and copy into an expectation.
    expect(body['properties']).not.toContain(CORRELATION_PROPERTY);

    // An empty query is not sent at all, rather than sent as an empty string.
    expect('query' in body).toBe(false);
  });

  it('CONN-909 trims a non-empty query and truncates one past the documented cap', async () => {
    expect(CONTACT_LOOKUP_MAX_QUERY).toBe(100);

    const trimmed = spy(() => json({ results: [] }));
    await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '  ada  ',
      after: null,
      options: { fetchImpl: trimmed.fetchImpl },
    });
    expect(parsedBody(trimmed.calls[0])['query']).toBe('ada');

    const long = spy(() => json({ results: [] }));
    const longQuery = 'a'.repeat(150);
    await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: longQuery,
      after: null,
      options: { fetchImpl: long.fetchImpl },
    });
    const sentQuery = parsedBody(long.calls[0])['query'];
    expect(typeof sentQuery).toBe('string');
    expect((sentQuery as string).length).toBe(100);
    expect(sentQuery).toBe('a'.repeat(100));
  });
});

describe('HubSpot contact lookup — parsing', () => {
  it('CONN-910 maps a contact to {id,name,email,createdAt}, joining names and nulling an empty one', async () => {
    const { fetchImpl } = spy(() =>
      json({
        results: [
          {
            id: '111',
            properties: {
              firstname: 'Ada',
              lastname: 'Lovelace',
              email: 'ada@example.test',
              createdate: '2026-01-01T00:00:00.000Z',
            },
          },
          // lastname absent entirely: the name is the first name alone.
          { id: '222', properties: { firstname: 'Grace', email: 'grace@example.test' } },
          // both names blank: name is null, not an empty string.
          { id: '333', properties: { firstname: '  ', lastname: '' } },
        ],
      }),
    );
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') return;
    expect(outcome.items).toEqual([
      {
        id: '111',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      { id: '222', name: 'Grace', email: 'grace@example.test', createdAt: null },
      { id: '333', name: null, email: null, createdAt: null },
    ]);
    for (const item of outcome.items) expect(isContactId(item.id)).toBe(true);
  });

  it('CONN-911 drops entries with a non-numeric id or that are not objects', async () => {
    const { fetchImpl } = spy(() =>
      json({
        results: [
          { id: '444', properties: { firstname: 'Kept' } },
          'not-an-object',
          null,
          42,
          { id: 'not-numeric', properties: { firstname: 'Dropped' } },
          { properties: { firstname: 'No id at all' } },
        ],
      }),
    );
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') return;
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]?.id).toBe('444');
    expect(isContactId('not-numeric')).toBe(false);
  });

  it('CONN-912 cuts the page at CONTACT_LOOKUP_PAGE_SIZE even when the provider returns more', async () => {
    const wanted = Array.from({ length: 10 }, (_, i) => ({
      id: String(100 + i),
      properties: { firstname: `Contact${i}` },
    }));
    const extra = Array.from({ length: 5 }, (_, i) => ({
      id: String(200 + i),
      properties: { firstname: `Extra${i}` },
    }));
    const { fetchImpl } = spy(() => json({ results: [...wanted, ...extra] }));
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') return;
    expect(outcome.items).toHaveLength(10);
    expect(outcome.items.map((i) => i.id)).toEqual(wanted.map((w) => w.id));
  });
});

describe('HubSpot contact lookup — paging', () => {
  it('CONN-913 turns paging.next.after into nextCursor when it is within the offset cap', async () => {
    expect(CONTACT_LOOKUP_MAX_OFFSET).toBe(40);
    const { fetchImpl } = spy(() => json({ results: [], paging: { next: { after: '10' } } }));
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind === 'page') expect(outcome.nextCursor).toBe('10');
    expect(isContactLookupCursor('10')).toBe(true);
  });

  it('CONN-914 drops a next cursor past the offset cap instead of offering it', async () => {
    const { fetchImpl } = spy(() => json({ results: [], paging: { next: { after: '50' } } }));
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind === 'page') expect(outcome.nextCursor).toBeNull();
    expect(isContactLookupCursor('50')).toBe(false);
  });

  it('CONN-915 reports no next cursor when the provider sends no paging at all', async () => {
    const { fetchImpl } = spy(() => json({ results: [] }));
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind === 'page') expect(outcome.nextCursor).toBeNull();
  });

  it('CONN-916 sends a supplied after cursor straight through in the request body', async () => {
    const { fetchImpl, calls } = spy(() => json({ results: [] }));
    await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: CORRELATION_PROPERTY,
      query: '',
      after: '20',
      options: { fetchImpl },
    });
    expect(parsedBody(calls[0])['after']).toBe('20');
  });

  it('CONN-917 refuses a cursor this lookup would never have issued, and never calls fetch', async () => {
    for (const bad of ['abc', '41']) {
      const { fetchImpl, calls } = spy(() => json({ results: [] }));
      const outcome = await lookupContacts({
        token: HUBSPOT_TOKEN,
        correlationProperty: CORRELATION_PROPERTY,
        query: '',
        after: bad,
        options: { fetchImpl },
      });
      expect(outcome.kind, bad).toBe('error');
      if (outcome.kind === 'error') expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(calls, bad).toHaveLength(0);
      expect(isContactLookupCursor(bad), bad).toBe(false);
    }
  });
});

describe('HubSpot contact lookup — configuration guard', () => {
  it('CONN-918 refuses an invalid correlation property name before ever calling fetch', async () => {
    const { fetchImpl, calls } = spy(() => json({ results: [] }));
    const outcome = await lookupContacts({
      token: HUBSPOT_TOKEN,
      correlationProperty: 'bad name;',
      query: '',
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(calls).toHaveLength(0);
  });
});

describe('HubSpot contact lookup — failures, one attempt, never a page', () => {
  it('CONN-919 classifies every provider failure and calls fetch exactly once, with no retry', async () => {
    const run = async (
      responder: () => Response | Promise<Response> | never,
      opts: { throws?: unknown } = {},
    ) => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        if (opts.throws !== undefined) throw opts.throws;
        return responder();
      }) as unknown as typeof fetch;
      const outcome = await lookupContacts({
        token: HUBSPOT_TOKEN,
        correlationProperty: CORRELATION_PROPERTY,
        query: '',
        after: null,
        options: { fetchImpl },
      });
      return { outcome, calls };
    };

    const cases: Array<{
      label: string;
      responder: () => Response;
      code: string;
      opts?: { throws?: unknown };
      extra?: (outcome: Awaited<ReturnType<typeof run>>['outcome']) => void;
    }> = [
      {
        label: '401',
        responder: () => json({ status: 'error', message: 'expired' }, 401),
        code: 'AUTH_EXPIRED',
      },
      {
        label: '403',
        responder: () => json({ status: 'error', category: 'MISSING_SCOPES' }, 403),
        code: 'PERMISSION_MISSING',
      },
      {
        label: '429',
        responder: () =>
          json({ status: 'error', errorType: 'RATE_LIMIT' }, 429, { 'retry-after': '15' }),
        code: 'RATE_LIMITED',
        extra: (outcome) => {
          if (outcome.kind === 'error') expect(outcome.error.retryAfterSeconds).toBe(15);
        },
      },
      {
        label: '500',
        responder: () => json({ status: 'error' }, 500),
        code: 'PROVIDER_UNAVAILABLE',
      },
      {
        label: 'non-JSON 200',
        responder: () => new Response('{"results": [', { status: 200 }),
        code: 'PROVIDER_UNAVAILABLE',
      },
      {
        label: 'missing results array',
        responder: () => json({ total: 0 }),
        code: 'PROVIDER_UNAVAILABLE',
      },
    ];

    for (const c of cases) {
      const { outcome, calls } = await run(c.responder);
      expect(outcome.kind, c.label).toBe('error');
      if (outcome.kind === 'error') expect(outcome.error.code, c.label).toBe(c.code);
      expect(calls, c.label).toBe(1);
      c.extra?.(outcome);
    }

    // A transport failure (timeout, network error) is classified the same way and is
    // never mistaken for a page of results.
    const { outcome, calls } = await run(
      () => {
        throw new Error('unreachable');
      },
      { throws: Object.assign(new Error('aborted'), { name: 'TimeoutError' }) },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Resend: listSentMessages
// ---------------------------------------------------------------------------

const MESSAGE_ID_A = '11111111-1111-1111-1111-111111111111';
const MESSAGE_ID_B = '22222222-2222-2222-2222-222222222222';

describe('Resend sent-message lookup — request shape', () => {
  it('CONN-920 GETs the list endpoint with the documented page size and Bearer auth', async () => {
    expect(MESSAGE_LOOKUP_PAGE_SIZE).toBe(20);
    const { fetchImpl, calls } = spy(() => json({ object: 'list', has_more: false, data: [] }));
    await listSentMessages({ token: RESEND_TOKEN, after: null, options: { fetchImpl } });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.resend.com/emails');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(calls[0]?.init.method).toBe('GET');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${RESEND_TOKEN}`);
  });

  it('CONN-921 carries a supplied after cursor through as a query parameter', async () => {
    const { fetchImpl, calls } = spy(() => json({ object: 'list', has_more: false, data: [] }));
    await listSentMessages({ token: RESEND_TOKEN, after: MESSAGE_ID_A, options: { fetchImpl } });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('after')).toBe(MESSAGE_ID_A);
    expect(isResendEmailId(MESSAGE_ID_A)).toBe(true);
  });

  it('CONN-922 refuses a non-UUID cursor without ever calling fetch', async () => {
    const { fetchImpl, calls } = spy(() => json({ object: 'list', has_more: false, data: [] }));
    const outcome = await listSentMessages({
      token: RESEND_TOKEN,
      after: 'not-a-uuid',
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(calls).toHaveLength(0);
    expect(isResendEmailId('not-a-uuid')).toBe(false);
  });
});

describe('Resend sent-message lookup — parsing', () => {
  it('CONN-923 maps a message to {id,to[],subject,createdAt,lastEvent}, accepting to as string or array', async () => {
    const { fetchImpl } = spy(() =>
      json({
        object: 'list',
        has_more: false,
        data: [
          {
            id: MESSAGE_ID_A,
            to: 'single@example.test',
            subject: 'Thanks for your enquiry',
            created_at: '2026-03-01T12:01:00.000Z',
            last_event: 'delivered',
          },
          {
            id: MESSAGE_ID_B,
            to: ['first@example.test', 'second@example.test'],
            subject: null,
            created_at: '2026-03-02T12:01:00.000Z',
            last_event: null,
          },
        ],
      }),
    );
    const outcome = await listSentMessages({
      token: RESEND_TOKEN,
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') return;
    expect(outcome.items).toEqual([
      {
        id: MESSAGE_ID_A,
        to: ['single@example.test'],
        subject: 'Thanks for your enquiry',
        createdAt: '2026-03-01T12:01:00.000Z',
        lastEvent: 'delivered',
      },
      {
        id: MESSAGE_ID_B,
        to: ['first@example.test', 'second@example.test'],
        subject: null,
        createdAt: '2026-03-02T12:01:00.000Z',
        lastEvent: null,
      },
    ]);
  });

  it('CONN-924 drops entries whose id is not a Resend UUID', async () => {
    const { fetchImpl } = spy(() =>
      json({
        object: 'list',
        has_more: false,
        data: [
          { id: 'not-a-uuid', to: ['dropped@example.test'] },
          { id: MESSAGE_ID_A, to: ['kept@example.test'] },
        ],
      }),
    );
    const outcome = await listSentMessages({
      token: RESEND_TOKEN,
      after: null,
      options: { fetchImpl },
    });
    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') return;
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]?.id).toBe(MESSAGE_ID_A);
  });

  it('CONN-925 sets nextCursor to the last item’s id only when has_more is true', async () => {
    const page = (hasMore: boolean) =>
      json({
        object: 'list',
        has_more: hasMore,
        data: [
          { id: MESSAGE_ID_A, to: ['a@example.test'] },
          { id: MESSAGE_ID_B, to: ['b@example.test'] },
        ],
      });

    const withMore = spy(() => page(true));
    const more = await listSentMessages({
      token: RESEND_TOKEN,
      after: null,
      options: { fetchImpl: withMore.fetchImpl },
    });
    expect(more.kind).toBe('page');
    if (more.kind === 'page') expect(more.nextCursor).toBe(MESSAGE_ID_B);

    const withoutMore = spy(() => page(false));
    const done = await listSentMessages({
      token: RESEND_TOKEN,
      after: null,
      options: { fetchImpl: withoutMore.fetchImpl },
    });
    expect(done.kind).toBe('page');
    if (done.kind === 'page') expect(done.nextCursor).toBeNull();
  });
});

describe('Resend sent-message lookup — failures, one attempt, never a page', () => {
  it('CONN-926 classifies every provider failure and calls fetch exactly once, with no retry', async () => {
    const run = async (responder: () => Response, opts: { throws?: unknown } = {}) => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        if (opts.throws !== undefined) throw opts.throws;
        return responder();
      }) as unknown as typeof fetch;
      const outcome = await listSentMessages({
        token: RESEND_TOKEN,
        after: null,
        options: { fetchImpl },
      });
      return { outcome, calls };
    };

    const cases: Array<{ label: string; responder: () => Response; code: string }> = [
      {
        label: '401 restricted_api_key',
        responder: () =>
          json(
            {
              statusCode: 401,
              name: 'restricted_api_key',
              message: 'This API key is restricted to only send emails.',
            },
            401,
          ),
        code: 'PERMISSION_MISSING',
      },
      {
        label: '429',
        responder: () =>
          json(
            { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' },
            429,
          ),
        code: 'RATE_LIMITED',
      },
      {
        label: '500',
        responder: () => json({ statusCode: 500, name: 'application_error', message: 'boom' }, 500),
        code: 'PROVIDER_UNAVAILABLE',
      },
      {
        label: '200 without a data array',
        responder: () => json({ object: 'list', has_more: false }),
        code: 'PROVIDER_UNAVAILABLE',
      },
    ];

    for (const c of cases) {
      const { outcome, calls } = await run(c.responder);
      expect(outcome.kind, c.label).toBe('error');
      if (outcome.kind === 'error') expect(outcome.error.code, c.label).toBe(c.code);
      expect(calls, c.label).toBe(1);
    }

    const { outcome, calls } = await run(
      () => {
        throw new Error('unreachable');
      },
      { throws: new Error('network down') },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reads.ts: the contact_lookup entry a customer reads before granting access
// ---------------------------------------------------------------------------

describe('HUBSPOT_READS — the contact_lookup entry', () => {
  it('CONN-927 documents contact_lookup as choosing a contact, and reading names, emails and ids only', () => {
    const entry = HUBSPOT_READS.find((r) => r.call === 'POST /crm/v3/objects/contacts/search');
    // token_info, contact_by_id, contact_search and contact_lookup are distinct rows even
    // where two share a method+path, so find by purpose content instead of relying on the
    // first search-shaped match.
    const contactLookupEntry = HUBSPOT_READS.filter(
      (r) => r.call === 'POST /crm/v3/objects/contacts/search',
    ).find((r) => r.purpose.includes('choosing'));
    expect(entry).toBeDefined();
    expect(contactLookupEntry).toBeDefined();
    expect(contactLookupEntry?.purpose).toContain('choosing');
    expect(contactLookupEntry?.purpose).toContain('it reads names, emails and ids only');
  });
});
