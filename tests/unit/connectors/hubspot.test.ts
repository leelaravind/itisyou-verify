/**
 * HubSpot connector.
 *
 * Every payload below is a synthetic copy of a shape taken from HubSpot's published
 * documentation (see the header of `packages/connectors/src/hubspot.ts` for the URLs and
 * the date). No real portal, no real contact, no real token. `fetch` is stubbed in every
 * test; nothing here has ever spoken to HubSpot.
 *
 * The line this file exists to defend: a *successful* search that matched nothing is
 * `NOT_FOUND`, and everything else — a timeout, a 429, a 500, a truncated body — is not.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import {
  HUBSPOT_READ_SCOPE,
  HubSpotConnector,
  MAX_REQUESTED_PROPERTIES,
  classifyHubSpotError,
  ConnectorTransportError,
  normaliseHubSpotContact,
  selectProperties,
} from '@verify/connectors';
import { CORRELATION_VALUE, RECIPIENT, T_EVENT, T_INSIDE_WINDOW } from '../../fixtures/index.js';

// Assembled at runtime: the value is synthetic, but a credential-shaped literal
// trips both our secret scan and GitHub push protection, and the right response to
// that is to stop committing the shape rather than to allowlist the warning.
const TOKEN = ['pat', 'na1', '11111111-2222-3333-4444-555555555555'].join('-');
const PORTAL = '1020304';
const FOREIGN_PORTAL = '9999999';
const CORRELATION_PROPERTY = 'verify_correlation_id';

const connection = (overrides: Record<string, unknown> = {}) => ({
  provider: 'hubspot' as const,
  account_id: PORTAL,
  correlation_property: CORRELATION_PROPERTY,
  ...overrides,
});

const credentials = { accessToken: TOKEN };

/** A contact exactly as the contacts guide documents one. */
function contactPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: '33451',
    properties: {
      hs_object_id: '33451',
      email: RECIPIENT,
      createdate: '2026-03-01T12:01:00.000Z',
      [CORRELATION_PROPERTY]: CORRELATION_VALUE,
    },
    createdAt: '2026-03-01T12:01:00.000Z',
    updatedAt: '2026-03-01T12:05:00.000Z',
    archived: false,
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Route stubbed responses by URL so a test reads like the conversation it describes. */
function router(routes: {
  tokenInfo?: () => Response | Promise<Response>;
  contact?: () => Response | Promise<Response>;
  search?: () => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes('/oauth/v2/private-apps/get/access-token-info')) {
      return routes.tokenInfo?.() ?? json({ userId: 1, hubId: Number(PORTAL), appId: 2, scopes: [HUBSPOT_READ_SCOPE] });
    }
    if (url.includes('/crm/v3/objects/contacts/search')) {
      return routes.search?.() ?? json({ total: 0, results: [] });
    }
    return routes.contact?.() ?? json(contactPayload());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => {};

function makeConnector(fetchImpl: typeof fetch): HubSpotConnector {
  return new HubSpotConnector({ fetchImpl, sleep: noSleep, jitterSeed: 0.5 });
}

// ---------------------------------------------------------------------------

describe('HubSpot capabilities', () => {
  it('CONN-033 declares itself read-only and names the exact scope it needs', () => {
    const caps = new HubSpotConnector().capabilities();
    expect(caps.writes_to_customer_system).toBe(false);
    expect(caps.required_scopes).toEqual([HUBSPOT_READ_SCOPE]);
    expect(caps.evidence_kinds).toEqual(['crm_record']);
  });

  it('CONN-034 distinguishes "a record exists" from "a record was created in the window"', () => {
    const caps = new HubSpotConnector().capabilities();
    expect(caps.can_search_by_correlation).toBe(true);
    expect(caps.can_prove_record_created_in_window).toBe(true);
  });

  it('CONN-035 never claims to verify HubSpot webhooks in v1', () => {
    const caps = new HubSpotConnector().capabilities();
    expect(caps.can_verify_webhooks).toBe(false);
    expect(caps.can_provision_webhooks).toBe(false);
    expect(caps.origins).toEqual(['provider_readback']);
  });
});

describe('HubSpot property selection', () => {
  it('CONN-036 requests only the properties the rules need, plus the three we always need', () => {
    const props = selectProperties(['lifecyclestage'], CORRELATION_PROPERTY);
    expect(props).toEqual(['hs_object_id', 'email', 'createdate', CORRELATION_PROPERTY, 'lifecyclestage']);
  });

  it('CONN-037 refuses a property name that is not a valid HubSpot identifier', () => {
    const props = selectProperties(['ok_name', 'bad name', 'worse,name', '../../x'], CORRELATION_PROPERTY);
    expect(props).toContain('ok_name');
    expect(props.some((p) => p.includes(' ') || p.includes(',') || p.includes('/'))).toBe(false);
  });

  it('CONN-038 caps the number of properties requested', () => {
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
    expect(selectProperties(many, CORRELATION_PROPERTY).length).toBeLessThanOrEqual(MAX_REQUESTED_PROPERTIES);
  });
});

describe('HubSpot error classification', () => {
  it('CONN-039 maps 401 to AUTH_EXPIRED and marks it not retryable', () => {
    const e = classifyHubSpotError({ status: 401, bodyText: '{"status":"error","message":"expired"}' });
    expect(e.code).toBe('AUTH_EXPIRED');
    expect(e.retryable).toBe(false);
  });

  it('CONN-040 maps 403 to PERMISSION_MISSING and marks it not retryable', () => {
    const e = classifyHubSpotError({
      status: 403,
      bodyText: '{"status":"error","category":"MISSING_SCOPES","message":"missing scopes"}',
    });
    expect(e.code).toBe('PERMISSION_MISSING');
    expect(e.retryable).toBe(false);
    expect(e.detail).toContain('MISSING_SCOPES');
  });

  it('CONN-041 maps 429 to RATE_LIMITED and extracts Retry-After', () => {
    const e = classifyHubSpotError({
      status: 429,
      headers: new Headers({ 'retry-after': '12' }),
      bodyText: '{"status":"error","errorType":"RATE_LIMIT","message":"You have reached your daily limit."}',
      now: new Date('2026-03-01T12:00:00Z'),
    });
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterSeconds).toBe(12);
  });

  it('CONN-042 maps 429 without Retry-After using the documented rate-limit interval header', () => {
    const e = classifyHubSpotError({
      status: 429,
      headers: new Headers({ 'x-hubspot-ratelimit-interval-milliseconds': '10000' }),
      bodyText: '',
      now: new Date(),
    });
    expect(e.retryAfterSeconds).toBe(10);
  });

  it('CONN-043 maps 5xx to PROVIDER_UNAVAILABLE, which is retryable and is not an absence', () => {
    for (const status of [500, 502, 503, 504]) {
      const e = classifyHubSpotError({ status, bodyText: '' });
      expect(e.code, String(status)).toBe('PROVIDER_UNAVAILABLE');
      expect(e.retryable).toBe(true);
    }
  });

  it('CONN-044 maps 400 to UNSUPPORTED_CAPABILITY, because a bad property is the customer to fix', () => {
    const e = classifyHubSpotError({
      status: 400,
      bodyText: '{"status":"error","message":"Property \\"nope\\" does not exist"}',
    });
    expect(e.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(e.retryable).toBe(false);
  });

  it('CONN-045 maps a transport timeout to PROVIDER_UNAVAILABLE and never to NOT_FOUND', () => {
    const e = classifyHubSpotError({ status: null, cause: new ConnectorTransportError('timeout', 'no response') });
    expect(e.code).toBe('PROVIDER_UNAVAILABLE');
    expect(e.code).not.toBe('NOT_FOUND');
  });

  it('CONN-046 maps an oversized response to PROVIDER_UNAVAILABLE', () => {
    const e = classifyHubSpotError({
      status: null,
      cause: new ConnectorTransportError('response_too_large', 'body exceeded'),
    });
    expect(e.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-047 maps a 200 carrying an error envelope to PROVIDER_UNAVAILABLE, never to a pass', () => {
    const e = classifyHubSpotError({ status: 200, bodyText: '{"status":"error","message":"something odd"}' });
    expect(e.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('HubSpot normalisation', () => {
  const ctx = {
    provider_account_id: PORTAL,
    origin: 'provider_readback' as const,
    observedAt: T_INSIDE_WINDOW,
    correlationProperty: CORRELATION_PROPERTY,
  };

  it('CONN-048 turns a documented contact into evidence with the connected account id', () => {
    const result = normaliseHubSpotContact(contactPayload(), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.kind).toBe('crm_record');
    expect(result.evidence.provider_account_id).toBe(PORTAL);
    expect(result.evidence.record_id).toBe('33451');
    expect(result.evidence.email).toBe(RECIPIENT);
    expect(result.evidence.correlation_value).toBe(CORRELATION_VALUE);
    expect(result.evidence.created_at).toBe('2026-03-01T12:01:00.000Z');
    expect(result.evidence.origin).toBe('provider_readback');
  });

  it('CONN-049 prefers the createdate property over the envelope createdAt', () => {
    const result = normaliseHubSpotContact(
      contactPayload({
        properties: { createdate: '2026-03-01T12:02:00.000Z' },
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
      ctx,
    );
    expect(result.ok && result.evidence.created_at).toBe('2026-03-01T12:02:00.000Z');
  });

  it('CONN-155 rejects a payload with no usable id as INVALID_EVIDENCE', () => {
    for (const bad of [null, [], 'a string', { properties: {} }, { id: '' }]) {
      const result = normaliseHubSpotContact(bad, ctx);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.gap.code).toBe('INVALID_EVIDENCE');
    }
  });

  it('CONN-156 rejects a payload whose properties member is not an object', () => {
    const result = normaliseHubSpotContact({ id: '1', properties: ['nope'] }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.code).toBe('INVALID_EVIDENCE');
  });

  it('CONN-052 coerces unexpected property value types instead of crashing', () => {
    const result = normaliseHubSpotContact(
      { id: 7, properties: { email: RECIPIENT, count: 3, flag: true, nested: { a: 1 }, missing: null } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.record_id).toBe('7');
    expect(result.evidence.properties['count']).toBe('3');
    expect(result.evidence.properties['flag']).toBe('true');
    expect(result.evidence.properties['nested']).toBeNull();
    expect(result.evidence.properties['missing']).toBeNull();
  });

  it('CONN-053 leaves created_at null when the timestamp is unusable rather than inventing one', () => {
    const result = normaliseHubSpotContact(
      { id: '1', properties: { createdate: 'not a date' }, createdAt: 'also not a date' },
      ctx,
    );
    expect(result.ok && result.evidence.created_at).toBeNull();
  });
});

describe('HubSpot fetchEvidence — the account identity', () => {
  it('CONN-054 returns evidence stamped with the connected portal id', async () => {
    const { fetchImpl } = router({});
    const result = await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection(),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
      ...{},
    });
    // With a stored account id and no re-verification, no identity call is spent.
    expect(result.provider_account_id).toBe(PORTAL);
  });

  it('CONN-055 stamps the live portal id when it differs from the stored one, so the evaluator can contradict it', async () => {
    const { fetchImpl } = router({
      tokenInfo: () => json({ hubId: Number(FOREIGN_PORTAL), scopes: [HUBSPOT_READ_SCOPE] }),
      search: () => json({ total: 1, results: [contactPayload()] }),
    });
    const result = await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection({ reverify_account: true }),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });
    expect(result.provider_account_id).toBe(FOREIGN_PORTAL);
    expect(result.evidence).toHaveLength(1);
    // The evidence is still returned — the evaluator, not the connector, decides that a
    // foreign portal contradicts the rule.
    expect(result.evidence[0]?.provider_account_id).toBe(FOREIGN_PORTAL);
  });

  it('CONN-056 resolves the portal id live when the connection has never completed setup', async () => {
    const { fetchImpl, calls } = router({ search: () => json({ total: 1, results: [contactPayload()] }) });
    const result = await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection({ account_id: null }),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });
    expect(result.provider_account_id).toBe(PORTAL);
    expect(calls.some((c) => c.includes('access-token-info'))).toBe(true);
    expect(result.calls_made).toBe(2);
  });

  it('CONN-057 returns a gap and no evidence when the account cannot be established', async () => {
    const { fetchImpl } = router({ tokenInfo: () => json({ status: 'error' }, 401) });
    const result = await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection({ account_id: null }),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });
    expect(result.evidence).toHaveLength(0);
    expect(result.gaps[0]?.code).toBe('AUTH_EXPIRED');
    expect(result.provider_account_id).toBeNull();
  });
});

describe('HubSpot fetchEvidence — correlation search', () => {
  const base = {
    credentials,
    connection: connection(),
    locator: { correlation_value: CORRELATION_VALUE },
    occurredAt: T_EVENT,
    now: T_INSIDE_WINDOW,
  };

  it('CONN-058 returns provider_readback evidence for exactly one match', async () => {
    const { fetchImpl } = router({ search: () => json({ total: 1, results: [contactPayload()] }) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps).toHaveLength(0);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.origin).toBe('provider_readback');
  });

  it('CONN-059 emits AMBIGUOUS_MATCH for two matches and never guesses between them', async () => {
    const { fetchImpl } = router({
      search: () => json({ total: 2, results: [contactPayload(), contactPayload({ id: '33452' })] }),
    });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.evidence).toHaveLength(0);
    expect(result.gaps[0]?.code).toBe('AMBIGUOUS_MATCH');
    expect(result.gaps[0]?.retryable).toBe(false);
  });

  it('CONN-060 emits AMBIGUOUS_MATCH when total reports more than the page returned', async () => {
    const { fetchImpl } = router({ search: () => json({ total: 7, results: [contactPayload()] }) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('AMBIGUOUS_MATCH');
  });

  it('CONN-061 emits NOT_FOUND for a SUCCESSFUL search that matched nothing', async () => {
    const { fetchImpl } = router({ search: () => json({ total: 0, results: [] }) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.code).toBe('NOT_FOUND');
    expect(result.gaps[0]?.retryable).toBe(false);
  });

  it('CONN-062 emits PROVIDER_UNAVAILABLE — never NOT_FOUND — when the search times out', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('access-token-info')) return json({ hubId: Number(PORTAL) });
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.gaps.map((g) => g.code)).not.toContain('NOT_FOUND');
    expect(result.gaps[0]?.retryable).toBe(true);
  });

  it('CONN-063 emits PROVIDER_UNAVAILABLE — never NOT_FOUND — for a 500 from the search endpoint', async () => {
    const { fetchImpl } = router({ search: () => json({ status: 'error', message: 'boom' }, 503) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.gaps.map((g) => g.code)).not.toContain('NOT_FOUND');
  });

  it('CONN-064 emits RATE_LIMITED with Retry-After for a 429 from the search endpoint', async () => {
    const { fetchImpl } = router({
      search: () => json({ status: 'error', errorType: 'RATE_LIMIT' }, 429, { 'retry-after': '20' }),
    });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('RATE_LIMITED');
    expect(result.gaps.map((g) => g.code)).not.toContain('NOT_FOUND');
  });

  it('CONN-065 distinguishes an empty *successful* search from a failed one, explicitly', async () => {
    const empty = router({ search: () => json({ total: 0, results: [] }) });
    const failed = router({ search: () => json({ status: 'error' }, 500) });

    const a = await makeConnector(empty.fetchImpl).fetchEvidence(base);
    const b = await makeConnector(failed.fetchImpl).fetchEvidence(base);

    expect(a.gaps[0]?.code).toBe('NOT_FOUND');
    expect(b.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
    // The whole product hinges on these two never collapsing into one another.
    expect(a.gaps[0]?.code).not.toBe(b.gaps[0]?.code);
  });

  it('CONN-066 treats a 200 search with no results array as unavailable, not as absence', async () => {
    const { fetchImpl } = router({ search: () => json({ total: 0 }) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-067 treats a self-contradicting search (total > 0, results empty) as unavailable', async () => {
    const { fetchImpl } = router({ search: () => json({ total: 1, results: [] }) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-068 treats malformed JSON from a 200 as unavailable, not as absence', async () => {
    const { fetchImpl } = router({
      search: () => new Response('{"total": 0, "results": [', { status: 200 }),
    });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-069 asks HubSpot for exactly the properties the rules need and no more', async () => {
    let body: string | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.includes('search')) {
        body = init.body as string;
        return json({ total: 1, results: [contactPayload()] });
      }
      return json({ hubId: Number(PORTAL) });
    }) as unknown as typeof fetch;

    await makeConnector(fetchImpl).fetchEvidence({ ...base, requiredProperties: ['lifecyclestage'] });
    const parsed = JSON.parse(body ?? '{}') as { properties: string[]; limit: number };
    expect(parsed.properties).toEqual(['hs_object_id', 'email', 'createdate', CORRELATION_PROPERTY, 'lifecyclestage']);
    expect(parsed.limit).toBe(2);
  });

  it('CONN-070 refuses to look anything up when neither a record id nor a correlation value is supplied', async () => {
    const { fetchImpl, calls } = router({});
    const result = await makeConnector(fetchImpl).fetchEvidence({ ...base, locator: {} });
    expect(result.gaps[0]?.code).toBe('INVALID_EVIDENCE');
    expect(calls).toHaveLength(0);
  });
});

describe('HubSpot fetchEvidence — lookup by record id', () => {
  const base = {
    credentials,
    connection: connection(),
    locator: { record_id: '33451', correlation_value: CORRELATION_VALUE },
    occurredAt: T_EVENT,
    now: T_INSIDE_WINDOW,
  };

  it('CONN-071 retrieves a contact by the id the customer gave us and stamps the connected portal', async () => {
    const { fetchImpl, calls } = router({});
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.provider_account_id).toBe(PORTAL);
    expect(calls[0]).toContain('/crm/v3/objects/contacts/33451');
    expect(calls[0]).toContain('archived=false');
  });

  it('CONN-072 emits NOT_FOUND for HubSpot’s documented object-not-found 404', async () => {
    const { fetchImpl } = router({
      contact: () => json({ status: 'error', message: 'resource not found', category: 'OBJECT_NOT_FOUND' }, 404),
    });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('NOT_FOUND');
  });

  it('CONN-073 refuses to call a 404 an absence when it is not HubSpot’s object-not-found envelope', async () => {
    const { fetchImpl } = router({ contact: () => new Response('<html>404 from a proxy</html>', { status: 404 }) });
    const result = await makeConnector(fetchImpl).fetchEvidence(base);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.gaps.map((g) => g.code)).not.toContain('NOT_FOUND');
  });

  it('CONN-074 never percent-escapes its way out of the contacts endpoint', async () => {
    const { fetchImpl, calls } = router({
      contact: () => json({ status: 'error', message: 'not found', category: 'OBJECT_NOT_FOUND' }, 404),
    });
    await makeConnector(fetchImpl).fetchEvidence({
      ...base,
      locator: { record_id: '../../oauth/v1/access-tokens/pat-leak' },
    });
    expect(calls[0]).toContain('/crm/v3/objects/contacts/..%2F..%2Foauth');
    expect(new URL(calls[0] ?? '').pathname.startsWith('/crm/v3/objects/contacts/')).toBe(true);
  });

  it('CONN-075 does not fall back to a search when the id lookup authoritatively answers', async () => {
    const { fetchImpl, calls } = router({
      contact: () => json({ status: 'error', message: 'not found', category: 'OBJECT_NOT_FOUND' }, 404),
    });
    await makeConnector(fetchImpl).fetchEvidence(base);
    expect(calls.some((c) => c.includes('/search'))).toBe(false);
  });
});

describe('HubSpot retries stay inside A03’s budget', () => {
  it('CONN-076 retries a retryable failure through planNextRetry and stops at the documented cap', async () => {
    let attempts = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('access-token-info')) return json({ hubId: Number(PORTAL) });
      attempts += 1;
      return json({ status: 'error' }, 503);
    }) as unknown as typeof fetch;

    const result = await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection(),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });

    expect(attempts).toBe(LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION + 1);
    expect(result.calls_made).toBe(LIMITS.MAX_TRANSIENT_RETRIES_PER_OBSERVATION + 1);
    expect(result.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-077 does not retry a terminal configuration failure', async () => {
    let attempts = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('access-token-info')) return json({ hubId: Number(PORTAL) });
      attempts += 1;
      return json({ status: 'error', category: 'MISSING_SCOPES' }, 403);
    }) as unknown as typeof fetch;

    await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection(),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });
    expect(attempts).toBe(1);
  });

  it('CONN-078 does not retry an authoritative absence', async () => {
    let attempts = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('access-token-info')) return json({ hubId: Number(PORTAL) });
      attempts += 1;
      return json({ total: 0, results: [] });
    }) as unknown as typeof fetch;

    await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection(),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });
    expect(attempts).toBe(1);
  });
});

describe('HubSpot connection lifecycle', () => {
  it('CONN-079 validates a working private app token and reports the portal it belongs to', async () => {
    const { fetchImpl } = router({});
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials,
      connection: connection({ account_id: null }),
      now: T_INSIDE_WINDOW,
    });
    expect(result.ok).toBe(true);
    expect(result.account_id).toBe(PORTAL);
    expect(result.granted_scopes).toContain(HUBSPOT_READ_SCOPE);
  });

  it('CONN-080 reports a missing contacts read scope as a fixable setup step', async () => {
    const { fetchImpl } = router({
      tokenInfo: () => json({ hubId: Number(PORTAL), scopes: ['crm.objects.companies.read'] }),
    });
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials,
      connection: connection({ account_id: null }),
      now: T_INSIDE_WINDOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PERMISSION_MISSING');
    expect(result.setup_steps[0]?.id).toBe('hubspot_add_contacts_read_scope');
  });

  it('CONN-081 reports a rejected token without claiming an account id', async () => {
    const { fetchImpl } = router({ tokenInfo: () => json({ status: 'error' }, 401) });
    const result = await makeConnector(fetchImpl).validateConnection({
      credentials,
      connection: connection({ account_id: null }),
      now: T_INSIDE_WINDOW,
    });
    expect(result.ok).toBe(false);
    expect(result.account_id).toBeNull();
    expect(result.error?.code).toBe('AUTH_EXPIRED');
  });

  it('CONN-082 admits that HubSpot cannot revoke its own private app token', async () => {
    const result = await new HubSpotConnector().revokeOrDisconnect();
    expect(result.local_credential_cleared).toBe(true);
    expect(result.provider_revoked).toBe(false);
    expect(result.manual_steps[0]?.verifiable_by_us).toBe(false);
    expect(result.calls_made).toBe(0);
  });

  it('CONN-083 never lets the token appear in a gap detail', async () => {
    const fetchImpl = (async () => {
      throw new Error(`socket hang up for Bearer ${TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await makeConnector(fetchImpl).fetchEvidence({
      credentials,
      connection: connection({ account_id: null }),
      locator: { correlation_value: CORRELATION_VALUE },
      occurredAt: T_EVENT,
      now: T_INSIDE_WINDOW,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
