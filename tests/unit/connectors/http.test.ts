/**
 * The guarded fetch and the URL guard.
 *
 * Every test here stubs `fetch`. Nothing in this file has ever reached a provider, and the
 * global guard in `tests/setup.ts` fails the suite loudly if anything tries.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_ALLOWED_HOSTS,
  ConnectorTransportError,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_REDIRECT_HOPS,
  PROVIDER_BASE_URL,
  USER_AGENT,
  checkUrl,
  guardedFetch,
  isPrivateAddress,
  parseIpLiteral,
  parseJsonBody,
  pathSegment,
  providerUrl,
  readRetryAfterSeconds,
  redactSecrets,
  CONNECTOR_URL_GUARD_OPTIONS,
} from '@verify/connectors';

// Assembled at runtime: the value is synthetic, but a credential-shaped literal
// trips both our secret scan and GitHub push protection, and the right response to
// that is to stop committing the shape rather than to allowlist the warning.
const TOKEN = ['pat', 'na1', '00000000-1111-2222-3333-444444444444'].join('-');

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function stubOnce(response: Response | (() => Promise<Response>)): typeof fetch {
  return (async () =>
    typeof response === 'function' ? response() : response) as unknown as typeof fetch;
}

describe('connector URL guard', () => {
  it('CONN-001 accepts each allowlisted provider host over https', () => {
    for (const host of CONNECTOR_ALLOWED_HOSTS) {
      const result = checkUrl(`https://${host}/v1/thing`, CONNECTOR_URL_GUARD_OPTIONS);
      expect(result.ok, host).toBe(true);
    }
  });

  it('CONN-002 refuses a host that is not on the allowlist', () => {
    const result = checkUrl(
      'https://evil.example/crm/v3/objects/contacts',
      CONNECTOR_URL_GUARD_OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_not_allowed');
  });

  it('CONN-003 refuses a lookalike host that merely ends with an allowlisted name', () => {
    const result = checkUrl('https://api.hubapi.com.evil.example/x', CONNECTOR_URL_GUARD_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_not_allowed');
  });

  it('CONN-004 refuses a subdomain of an allowlisted host, because the connector list is exact', () => {
    const result = checkUrl('https://anything.api.hubapi.com/x', CONNECTOR_URL_GUARD_OPTIONS);
    expect(result.ok).toBe(false);
  });

  it('CONN-005 refuses http://127.0.0.1 as a private address', () => {
    const result = checkUrl('http://127.0.0.1/', CONNECTOR_URL_GUARD_OPTIONS);
    expect(result.ok).toBe(false);
    // Scheme is checked before the host, so the reason is the scheme; the https form
    // proves the address check itself.
    const https = checkUrl('https://127.0.0.1/', CONNECTOR_URL_GUARD_OPTIONS);
    expect(https.ok).toBe(false);
    if (!https.ok) expect(https.reason).toBe('private_address');
  });

  it('CONN-006 refuses the cloud metadata address 169.254.169.254', () => {
    const result = checkUrl(
      'https://169.254.169.254/latest/meta-data/',
      CONNECTOR_URL_GUARD_OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('private_address');
  });

  it('CONN-007 refuses credentials embedded in a URL even when the host is allowlisted', () => {
    // secret-scan:allow — the credentials-in-URL shape IS the thing under test here
    const result = checkUrl('https://user:secret@api.hubapi.com/x', CONNECTOR_URL_GUARD_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('userinfo_present');
      // The reason must not carry the password itself.
      expect(result.detail).not.toContain('secret');
    }
  });

  it('CONN-008 refuses a non-https scheme', () => {
    for (const url of [
      'http://api.hubapi.com/x',
      'file:///etc/passwd',
      'gopher://api.hubapi.com/',
    ]) {
      const result = checkUrl(url, CONNECTOR_URL_GUARD_OPTIONS);
      expect(result.ok, url).toBe(false);
    }
  });

  it('CONN-009 refuses a non-443 port on an allowlisted host', () => {
    const result = checkUrl('https://api.hubapi.com:8443/x', CONNECTOR_URL_GUARD_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('port_not_allowed');
  });

  it('CONN-010 treats obfuscated loopback forms as private', () => {
    for (const host of [
      '2130706433',
      '0x7f.0.0.1',
      '017700000001',
      '[::1]',
      '[::ffff:127.0.0.1]',
    ]) {
      const parsed = parseIpLiteral(host.replace(/^\[|\]$/g, ''));
      expect(parsed, host).not.toBeNull();
      if (parsed !== null) expect(isPrivateAddress(parsed), host).toBe(true);
    }
  });
});

describe('guardedFetch', () => {
  it('CONN-011 sends a User-Agent identifying the service and never follows redirects automatically', async () => {
    let seen: RequestInit | undefined;
    const stub = (async (_url: string, init: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await guardedFetch({ url: 'https://api.resend.com/domains', method: 'GET', fetchImpl: stub });

    const headers = seen?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe(USER_AGENT);
    expect(seen?.redirect).toBe('manual');
  });

  it('CONN-012 refuses to start a request to a non-allowlisted host', async () => {
    await expect(
      guardedFetch({
        url: 'https://evil.example/x',
        method: 'GET',
        fetchImpl: stubOnce(jsonResponse({})),
      }),
    ).rejects.toMatchObject({ reason: 'blocked_url' });
  });

  it('CONN-013 follows a redirect whose target is also allowlisted', async () => {
    const calls: string[] = [];
    const stub = (async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://api.hubapi.com/moved' },
        });
      }
      return jsonResponse({ id: '1' });
    }) as unknown as typeof fetch;

    const result = await guardedFetch({
      url: 'https://api.hubapi.com/start',
      method: 'GET',
      fetchImpl: stub,
    });
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toBe('https://api.hubapi.com/moved');
    expect(calls).toHaveLength(2);
  });

  it('CONN-014 refuses a redirect to a private address', async () => {
    const stub = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })) as unknown as typeof fetch;

    await expect(
      guardedFetch({ url: 'https://api.hubapi.com/start', method: 'GET', fetchImpl: stub }),
    ).rejects.toMatchObject({ reason: 'blocked_redirect' });
  });

  it('CONN-015 refuses a redirect to a host outside the allowlist', async () => {
    const stub = (async () =>
      new Response(null, {
        status: 301,
        headers: { location: 'https://evil.example/' },
      })) as unknown as typeof fetch;

    await expect(
      guardedFetch({ url: 'https://api.resend.com/domains', method: 'GET', fetchImpl: stub }),
    ).rejects.toMatchObject({ reason: 'blocked_redirect' });
  });

  it('CONN-016 stops after the bounded redirect hop limit', async () => {
    const stub = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://api.hubapi.com/loop' },
      })) as unknown as typeof fetch;

    const error = await guardedFetch({
      url: 'https://api.hubapi.com/loop',
      method: 'GET',
      fetchImpl: stub,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectorTransportError);
    expect((error as ConnectorTransportError).reason).toBe('too_many_redirects');
    expect((error as ConnectorTransportError).message).toContain(String(MAX_REDIRECT_HOPS));
  });

  it('CONN-017 refuses a redirect with no Location header', async () => {
    const stub = (async () => new Response(null, { status: 307 })) as unknown as typeof fetch;
    await expect(
      guardedFetch({ url: 'https://api.hubapi.com/x', method: 'GET', fetchImpl: stub }),
    ).rejects.toMatchObject({ reason: 'missing_location' });
  });

  it('CONN-018 refuses an oversized response body declared by content-length', async () => {
    const stub = stubOnce(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
      }),
    );
    await expect(
      guardedFetch({ url: 'https://api.resend.com/domains', method: 'GET', fetchImpl: stub }),
    ).rejects.toMatchObject({ reason: 'response_too_large' });
  });

  it('CONN-019 refuses an oversized response body while streaming, without buffering it', async () => {
    const stub = stubOnce(new Response('x'.repeat(5_000), { status: 200 }));
    await expect(
      guardedFetch({
        url: 'https://api.resend.com/domains',
        method: 'GET',
        maxBytes: 1_000,
        fetchImpl: stub,
      }),
    ).rejects.toMatchObject({ reason: 'response_too_large' });
  });

  it('CONN-020 reports a timeout as a timeout, never as an answer', async () => {
    const stub = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    }) as unknown as typeof fetch;

    const error = await guardedFetch({
      url: 'https://api.hubapi.com/x',
      method: 'GET',
      fetchImpl: stub,
    }).catch((e: unknown) => e);
    expect((error as ConnectorTransportError).reason).toBe('timeout');
  });

  it('CONN-021 never lets a secret reach a thrown error message', async () => {
    const stub = (async () => {
      // A runtime or library that helpfully includes the request in its error text.
      throw new Error(`connect ECONNREFUSED while sending Authorization: Bearer ${TOKEN}`);
    }) as unknown as typeof fetch;

    const error = await guardedFetch({
      url: 'https://api.hubapi.com/x',
      method: 'GET',
      secrets: [TOKEN],
      fetchImpl: stub,
    }).catch((e: unknown) => e);

    const text = `${(error as Error).message} ${JSON.stringify(error)} ${(error as ConnectorTransportError).detail}`;
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[redacted]');
  });

  it('CONN-022 returns 4xx and 5xx as responses, because only the connector knows what they mean', async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const stub = stubOnce(new Response('{"status":"error"}', { status }));
      const result = await guardedFetch({
        url: 'https://api.hubapi.com/x',
        method: 'GET',
        fetchImpl: stub,
      });
      expect(result.status).toBe(status);
    }
  });

  it('CONN-023 strips a leading slash requirement and percent-encodes a customer-supplied segment', () => {
    expect(pathSegment('../../oauth/v1/tokens')).toBe('..%2F..%2Foauth%2Fv1%2Ftokens');
    const url = providerUrl('hubspot', `/crm/v3/objects/contacts/${pathSegment('../../oauth')}`);
    expect(new URL(url).host).toBe('api.hubapi.com');
    expect(url.startsWith(`${PROVIDER_BASE_URL.hubspot}/crm/v3/objects/contacts/`)).toBe(true);
  });

  it('CONN-024 refuses to build a URL from a path that is not rooted', () => {
    expect(() => providerUrl('resend', 'emails/1')).toThrow(ConnectorTransportError);
  });

  it('CONN-025 fails the whole suite if a connector ever reaches the real network', async () => {
    // Proves the global guard in tests/setup.ts is doing its job: no `fetchImpl`, no stub.
    await expect(
      guardedFetch({ url: 'https://api.hubapi.com/x', method: 'GET' }),
    ).rejects.toBeInstanceOf(ConnectorTransportError);
  });

  it('CONN-026 honours a stubbed global fetch when no implementation is injected', async () => {
    vi.stubGlobal('fetch', stubOnce(jsonResponse({ hubId: 42 })));
    try {
      const result = await guardedFetch({ url: 'https://api.hubapi.com/x', method: 'GET' });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.bodyText)).toEqual({ hubId: 42 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('response helpers', () => {
  it('CONN-027 reports malformed JSON as malformed rather than throwing', () => {
    expect(parseJsonBody('{"a":')).toEqual({ ok: false, detail: 'body is not valid JSON' });
    expect(parseJsonBody('   ')).toEqual({ ok: false, detail: 'empty body' });
    expect(parseJsonBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('CONN-028 extracts Retry-After in seconds', () => {
    const headers = new Headers({ 'retry-after': '37' });
    expect(readRetryAfterSeconds(headers, new Date('2026-03-01T12:00:00Z'))).toBe(37);
  });

  it('CONN-029 extracts Retry-After given as an HTTP date', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const headers = new Headers({ 'retry-after': new Date('2026-03-01T12:00:45Z').toUTCString() });
    expect(readRetryAfterSeconds(headers, now)).toBe(45);
  });

  it('CONN-030 falls back to HubSpot rate-limit interval when Retry-After is absent', () => {
    const headers = new Headers({ 'x-hubspot-ratelimit-interval-milliseconds': '10000' });
    expect(readRetryAfterSeconds(headers, new Date())).toBe(10);
  });

  it('CONN-031 returns null when no retry hint is present', () => {
    expect(readRetryAfterSeconds(new Headers(), new Date())).toBeNull();
    expect(readRetryAfterSeconds(null, new Date())).toBeNull();
  });

  it('CONN-032 redacts every occurrence of a registered secret and ignores trivially short ones', () => {
    expect(redactSecrets(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe('a [redacted] b [redacted]');
    expect(redactSecrets('a short secret', ['a'])).toBe('a short secret');
  });
});
