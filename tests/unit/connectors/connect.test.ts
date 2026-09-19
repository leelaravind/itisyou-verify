/**
 * The connection lifecycle.
 *
 * The property under test throughout: **nothing is sealed, stored or marked ready without
 * evidence it works.** Several of these tests assert on an absence — no credential in the
 * result, no `ready` status, no external call — because that absence is the guarantee.
 *
 * `fetch` is stubbed in every test. No provider has ever been contacted from this file.
 */
import { describe, expect, it } from 'vitest';
import { openCredentialFor } from '@verify/security';
import {
  CREDENTIAL_PURPOSE,
  accountLabel,
  checkTokenShape,
  checkWebhookSecretShape,
  credentialAadParts,
  establishConnection,
  markWebhookVerified,
  openConnectionCredentials,
  revalidateConnection,
} from '@verify/connectors';
import { T_INSIDE_WINDOW } from '../../fixtures/index.js';

const WORKSPACE = 'ws_00000000000000000001';
const HUBSPOT_TOKEN = ['pat', 'na1', '11111111-2222-3333-4444-555555555555'].join('-');
const RESEND_TOKEN = 're' + '_' + '0'.repeat(28);
const WEBHOOK_SECRET = 'whsec' + '_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const PORTAL = '1020304';
const FOREIGN_PORTAL = '9999999';
const READ_SCOPE = 'crm.objects.contacts.read';

/** A synthetic 32-byte AES key. Not a real key, not derived from one, never reused. */
const WRAPPING_KEY = {
  keyBase64: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 256))),
  keyVersion: 1,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function hubspotFetch(
  tokenInfo: () => Response = () =>
    json({ userId: 1, hubId: Number(PORTAL), appId: 2, scopes: [READ_SCOPE] }),
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return tokenInfo();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function resendFetch(
  domains: () => Response = () => json({ object: 'list', has_more: false, data: [] }),
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return domains();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------

describe('pasted credential shape', () => {
  it('CONN-157 rejects an empty token and names where to find the real one', () => {
    const problem = checkTokenShape('hubspot', '   ');
    expect(problem?.field).toBe('access_token');
    expect(problem?.message).toContain('Private Apps');
  });

  it('CONN-158 rejects a token with the wrong prefix for the provider', () => {
    expect(checkTokenShape('hubspot', 'sk_live_whatever')?.message).toContain('pat-');
    expect(checkTokenShape('resend', 'pat-na1-abc')?.message).toContain('re_');
  });

  it('CONN-159 recognises a token pasted into the wrong provider’s box and says so', () => {
    const problem = checkTokenShape('hubspot', RESEND_TOKEN);
    expect(problem?.message).toContain('Resend token');
  });

  it('CONN-160 recognises a signing secret pasted into the token box', () => {
    const problem = checkTokenShape('resend', WEBHOOK_SECRET);
    expect(problem?.message).toContain('webhook signing secret');
  });

  it('CONN-161 rejects a value containing whitespace, which no token does', () => {
    expect(checkTokenShape('hubspot', 'pat-na1 1111')?.message).toContain('space');
  });

  it('CONN-162 rejects an absurdly long paste rather than sending it to a provider', () => {
    expect(checkTokenShape('hubspot', `pat-${'x'.repeat(600)}`)?.message).toContain('longer');
  });

  it('CONN-163 accepts a well-shaped token without claiming it works', () => {
    expect(checkTokenShape('hubspot', HUBSPOT_TOKEN)).toBeNull();
    expect(checkTokenShape('resend', RESEND_TOKEN)).toBeNull();
  });

  it('CONN-164 treats an absent webhook secret as acceptable but a malformed one as not', () => {
    expect(checkWebhookSecretShape('')).toBeNull();
    expect(checkWebhookSecretShape(undefined)).toBeNull();
    expect(checkWebhookSecretShape('nope')?.message).toContain('whsec_');
  });
});

describe('establishConnection — HubSpot', () => {
  const base = {
    provider: 'hubspot' as const,
    workspaceId: WORKSPACE,
    accessToken: HUBSPOT_TOKEN,
    wrappingKey: WRAPPING_KEY,
    now: T_INSIDE_WINDOW,
  };

  it('CONN-165 rejects a malformed token without spending a single external call', async () => {
    const { fetchImpl, calls } = hubspotFetch();
    const result = await establishConnection({ ...base, accessToken: 'nonsense', fetchImpl });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.callsMade).toBe(0);
    expect(result.credentials).toHaveLength(0);
  });

  it('CONN-166 validates against HubSpot and records the portal the token belongs to', async () => {
    const { fetchImpl, calls } = hubspotFetch();
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe('ready');
    expect(result.connection.externalAccountId).toBe(PORTAL);
    expect(result.connection.scopes).toContain(READ_SCOPE);
    expect(calls[0]).toContain('access-token-info');
  });

  it('CONN-167 seals the token so it can only be opened with the matching workspace and purpose', async () => {
    const { fetchImpl } = hubspotFetch();
    const result = await establishConnection({ ...base, fetchImpl });
    const sealed = result.credentials[0];
    expect(sealed?.purpose).toBe(CREDENTIAL_PURPOSE.API_TOKEN);
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;

    const opened = await openCredentialFor(
      sealed.envelope,
      credentialAadParts(WORKSPACE, 'hubspot', CREDENTIAL_PURPOSE.API_TOKEN),
      WRAPPING_KEY,
    );
    expect(opened).toBe(HUBSPOT_TOKEN);
  });

  it('CONN-168 refuses to open a sealed token under another workspace', async () => {
    const { fetchImpl } = hubspotFetch();
    const result = await establishConnection({ ...base, fetchImpl });
    const sealed = result.credentials[0];
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;
    await expect(
      openCredentialFor(
        sealed.envelope,
        credentialAadParts('ws_someone_else', 'hubspot', CREDENTIAL_PURPOSE.API_TOKEN),
        WRAPPING_KEY,
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_UNREADABLE' });
  });

  it('CONN-169 refuses to open a token sealed for one purpose using another purpose', async () => {
    const { fetchImpl } = hubspotFetch();
    const result = await establishConnection({ ...base, fetchImpl });
    const sealed = result.credentials[0];
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;
    await expect(
      openCredentialFor(
        sealed.envelope,
        credentialAadParts(WORKSPACE, 'hubspot', CREDENTIAL_PURPOSE.WEBHOOK_SECRET),
        WRAPPING_KEY,
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_UNREADABLE' });
  });

  it('CONN-170 stores nothing when HubSpot rejects the token', async () => {
    const { fetchImpl } = hubspotFetch(() => json({ status: 'error', message: 'expired' }, 401));
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.credentials).toHaveLength(0);
    expect(result.connection.status).toBe('expired');
    expect(result.connection.lastErrorCode).toBe('AUTH_EXPIRED');
    expect(result.fieldErrors['access_token']).toContain('Nothing has been saved');
  });

  it('CONN-171 stores nothing and names the missing scope when the private app lacks it', async () => {
    const { fetchImpl } = hubspotFetch(() =>
      json({ hubId: Number(PORTAL), scopes: ['crm.objects.companies.read'] }),
    );
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.credentials).toHaveLength(0);
    expect(result.connection.status).toBe('degraded');
    expect(result.connection.lastErrorCode).toBe('PERMISSION_MISSING');
    expect(result.message).toContain(READ_SCOPE);
  });

  it('CONN-172 stores nothing when HubSpot is unreachable, and does not blame the token', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.credentials).toHaveLength(0);
    expect(result.connection.lastErrorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(result.message).toContain('not with your token');
  });

  it('CONN-173 refuses a token whose account cannot be identified, even though it authenticated', async () => {
    // HubSpot answered 200, but without `hubId` there is no account to attribute evidence
    // to. `resolveHubSpotAccount` classifies that as PROVIDER_UNAVAILABLE, so the refusal
    // arrives through the error branch rather than the null-account guard — either way
    // nothing is sealed and nothing is stored, which is the property that matters.
    const { fetchImpl } = hubspotFetch(() => json({ userId: 1, appId: 2, scopes: [READ_SCOPE] }));
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.credentials).toHaveLength(0);
    expect(result.connection.externalAccountId).toBeNull();
    expect(result.connection.status).not.toBe('ready');
    expect(result.message).toContain('nothing has been saved');
  });

  it('CONN-174 never puts the pasted token into any message it returns', async () => {
    const { fetchImpl } = hubspotFetch(() => json({ status: 'error' }, 401));
    const result = await establishConnection({ ...base, fetchImpl });
    expect(JSON.stringify(result)).not.toContain(HUBSPOT_TOKEN);
  });

  it('CONN-175 never returns the token in the success path either', async () => {
    const { fetchImpl } = hubspotFetch();
    const result = await establishConnection({ ...base, fetchImpl });
    // The envelope is ciphertext; the plaintext must appear nowhere in the result.
    expect(JSON.stringify(result)).not.toContain(HUBSPOT_TOKEN);
  });
});

describe('establishConnection — Resend', () => {
  const base = {
    provider: 'resend' as const,
    workspaceId: WORKSPACE,
    accessToken: RESEND_TOKEN,
    wrappingKey: WRAPPING_KEY,
    now: T_INSIDE_WINDOW,
  };

  it('CONN-176 saves the key but refuses to call the connection ready without a signing secret', async () => {
    const { fetchImpl } = resendFetch();
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe('testing');
    expect(result.connection.status).not.toBe('ready');
    expect(result.setupSteps[0]?.id).toBe('resend_create_webhook_endpoint');
    expect(result.message).toContain('not finished yet');
  });

  it('CONN-177 still refuses to call it ready when a signing secret is supplied but unproven', async () => {
    const { fetchImpl } = resendFetch();
    const result = await establishConnection({ ...base, webhookSecret: WEBHOOK_SECRET, fetchImpl });
    expect(result.ok).toBe(true);
    // Both secrets are stored — but a secret we have never seen used is a promise, not a
    // working webhook, so the connection stays in testing until one actually arrives.
    expect(result.credentials.map((c) => c.purpose)).toEqual([
      CREDENTIAL_PURPOSE.API_TOKEN,
      CREDENTIAL_PURPOSE.WEBHOOK_SECRET,
    ]);
    expect(result.connection.status).toBe('testing');
    expect(result.setupSteps[0]?.id).toBe('resend_await_signed_callback');
  });

  it('CONN-178 seals the webhook secret under its own purpose', async () => {
    const { fetchImpl } = resendFetch();
    const result = await establishConnection({ ...base, webhookSecret: WEBHOOK_SECRET, fetchImpl });
    const secret = result.credentials.find((c) => c.purpose === CREDENTIAL_PURPOSE.WEBHOOK_SECRET);
    expect(secret).toBeDefined();
    if (secret === undefined) return;
    const opened = await openCredentialFor(
      secret.envelope,
      credentialAadParts(WORKSPACE, 'resend', CREDENTIAL_PURPOSE.WEBHOOK_SECRET),
      WRAPPING_KEY,
    );
    expect(opened).toBe(WEBHOOK_SECRET);
  });

  it('CONN-179 rejects a malformed signing secret before any external call', async () => {
    const { fetchImpl, calls } = resendFetch();
    const result = await establishConnection({ ...base, webhookSecret: 'not-a-secret', fetchImpl });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.fieldErrors['webhook_secret']).toContain('whsec_');
  });

  it('CONN-180 tells a customer with a send-only key exactly what is wrong, and stores nothing', async () => {
    const { fetchImpl } = resendFetch(() =>
      json(
        {
          statusCode: 401,
          name: 'restricted_api_key',
          message: 'This API key is restricted to only send emails.',
        },
        401,
      ),
    );
    const result = await establishConnection({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.credentials).toHaveLength(0);
    expect(result.message).toContain('only send email');
    expect(result.message).toContain('no read-only key');
  });

  it('CONN-181 never returns either secret in any message', async () => {
    const { fetchImpl } = resendFetch();
    const result = await establishConnection({ ...base, webhookSecret: WEBHOOK_SECRET, fetchImpl });
    const text = JSON.stringify(result);
    expect(text).not.toContain(RESEND_TOKEN);
    expect(text).not.toContain(WEBHOOK_SECRET);
  });
});

describe('markWebhookVerified — the only route to ready', () => {
  it('CONN-182 promotes a connection only on a verification that actually succeeded', () => {
    const result = markWebhookVerified('resend', {
      valid: true,
      evidence: [
        {
          kind: 'email_event',
          origin: 'provider_webhook',
          provider: 'resend',
          provider_account_id: 'resend-key-abc',
          message_id: 'm1',
          recipient: 'ada@example.test',
          status: 'delivered',
          occurred_at: '2026-03-01T12:02:00.000Z',
          observed_at: '2026-03-01T12:02:01.000Z',
        },
      ],
      gaps: [],
      event_id: 'msg_1',
      event_type: 'email.delivered',
    });
    expect(result.ready).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.provenBy).toBe('msg_1');
    expect(result.summary).toContain('not assumed');
  });

  it('CONN-183 refuses to promote on a failed signature check', () => {
    const result = markWebhookVerified('resend', { valid: false, reason: 'signature_mismatch' });
    expect(result.ready).toBe(false);
    expect(result.status).toBe('testing');
    expect(result.provenBy).toBeNull();
  });

  it('CONN-184 refuses to promote on a signed message that produced no usable evidence', () => {
    const result = markWebhookVerified('resend', {
      valid: true,
      evidence: [],
      gaps: [
        {
          source: 'email_event',
          code: 'UNSUPPORTED_CAPABILITY',
          retryable: false,
          detail: 'unknown event',
        },
      ],
      event_id: 'msg_2',
      event_type: 'email.teleported',
    });
    expect(result.ready).toBe(false);
    expect(result.status).toBe('testing');
    expect(result.summary).toContain('not finished');
  });
});

describe('revalidateConnection — catching a swapped token', () => {
  const stored = { provider: 'hubspot' as const, account_id: PORTAL };

  it('CONN-185 confirms a healthy connection', async () => {
    const { fetchImpl } = hubspotFetch();
    const result = await revalidateConnection({
      provider: 'hubspot',
      credentials: { accessToken: HUBSPOT_TOKEN },
      connection: stored,
      now: T_INSIDE_WINDOW,
      fetchImpl,
    });
    expect(result.status).toBe('ready');
    expect(result.accountChanged).toBe(false);
    expect(result.externalAccountId).toBe(PORTAL);
  });

  it('CONN-186 degrades a connection whose token now points at a different portal', async () => {
    const { fetchImpl } = hubspotFetch(() =>
      json({ hubId: Number(FOREIGN_PORTAL), scopes: [READ_SCOPE] }),
    );
    const result = await revalidateConnection({
      provider: 'hubspot',
      credentials: { accessToken: HUBSPOT_TOKEN },
      connection: stored,
      now: T_INSIDE_WINDOW,
      fetchImpl,
    });
    expect(result.accountChanged).toBe(true);
    expect(result.status).toBe('degraded');
    expect(result.status).not.toBe('ready');
    expect(result.externalAccountId).toBe(FOREIGN_PORTAL);
    expect(result.summary).toContain('different account');
  });

  it('CONN-187 reports an expired token without claiming an account', async () => {
    const { fetchImpl } = hubspotFetch(() => json({ status: 'error' }, 401));
    const result = await revalidateConnection({
      provider: 'hubspot',
      credentials: { accessToken: HUBSPOT_TOKEN },
      connection: stored,
      now: T_INSIDE_WINDOW,
      fetchImpl,
    });
    expect(result.status).toBe('expired');
    expect(result.externalAccountId).toBeNull();
    expect(result.lastErrorCode).toBe('AUTH_EXPIRED');
  });

  it('CONN-188 changes nothing when the provider is merely unreachable', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const result = await revalidateConnection({
      provider: 'hubspot',
      credentials: { accessToken: HUBSPOT_TOKEN },
      connection: stored,
      now: T_INSIDE_WINDOW,
      fetchImpl,
    });
    // The check failed, so nothing about the connection is asserted: no account claimed,
    // no change alleged, and certainly not `ready`.
    expect(result.accountChanged).toBe(false);
    expect(result.externalAccountId).toBeNull();
    expect(result.status).not.toBe('ready');
    expect(result.lastErrorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(result.summary).toContain('not with your token');
  });
});

describe('opening what was stored', () => {
  it('CONN-189 round-trips both credentials through the sealed envelopes', async () => {
    const { fetchImpl } = resendFetch();
    const established = await establishConnection({
      provider: 'resend',
      workspaceId: WORKSPACE,
      accessToken: RESEND_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      wrappingKey: WRAPPING_KEY,
      now: T_INSIDE_WINDOW,
      fetchImpl,
    });
    const api = established.credentials.find((c) => c.purpose === CREDENTIAL_PURPOSE.API_TOKEN);
    const hook = established.credentials.find(
      (c) => c.purpose === CREDENTIAL_PURPOSE.WEBHOOK_SECRET,
    );
    expect(api).toBeDefined();
    expect(hook).toBeDefined();
    if (api === undefined || hook === undefined) return;

    const opened = await openConnectionCredentials(
      { apiToken: api.envelope, webhookSecret: hook.envelope },
      { workspaceId: WORKSPACE, provider: 'resend' },
      WRAPPING_KEY,
    );
    expect(opened.accessToken).toBe(RESEND_TOKEN);
    expect(opened.webhookSecret).toBe(WEBHOOK_SECRET);
  });

  it('CONN-190 fails to open a credential row moved into another workspace', async () => {
    const { fetchImpl } = hubspotFetch();
    const established = await establishConnection({
      provider: 'hubspot',
      workspaceId: WORKSPACE,
      accessToken: HUBSPOT_TOKEN,
      wrappingKey: WRAPPING_KEY,
      now: T_INSIDE_WINDOW,
      fetchImpl,
    });
    const api = established.credentials[0];
    expect(api).toBeDefined();
    if (api === undefined) return;
    await expect(
      openConnectionCredentials(
        { apiToken: api.envelope },
        { workspaceId: 'ws_attacker', provider: 'hubspot' },
        WRAPPING_KEY,
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_UNREADABLE' });
  });
});

describe('account labels', () => {
  it('CONN-191 builds a label from the account id, never from a credential', () => {
    expect(accountLabel('hubspot', PORTAL)).toBe(`HubSpot account ${PORTAL}`);
    expect(accountLabel('hubspot', null)).toBeNull();
  });

  it('CONN-192 describes the Resend identifier as the key fingerprint it actually is', () => {
    const label = accountLabel('resend', 'resend-key-0123456789abcdef');
    expect(label).toContain('Resend key');
    expect(label).not.toContain('resend-key-');
  });
});
