/**
 * `POST /app/onboarding/connect` with `intent=credentials`, through the real Worker.
 *
 * The unit-level cases in `tests/integration/db/connectCredentials.test.ts` prove the port
 * does the right thing. They cannot prove the route reaches it — and reaching it was the
 * entire defect: `submitConnectionCredentials` is optional on `CustomerDataPort`, the D1
 * port did not implement it, so the handler took its fallback branch and answered "this
 * workspace has no way to validate a credential against the provider yet" to every paste.
 *
 * So this file builds real `Request`s, hands them to the default export of
 * `apps/app/src/index.ts`, carries a real CSRF pair obtained the way a browser obtains one
 * (GET the page, keep the cookie, read the hidden field), and then looks in the database.
 *
 * `fetch` is stubbed. Nothing here has contacted HubSpot: the provider-backed run is
 * `tools/live-connect/`, which is opt-in and deliberately outside this suite.
 *
 * Case ids CUST-474..CUST-477.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@verify/security';
import {
  csrfPairFor,
  getSignedIn,
  postSignedIn,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness.js';

/** Assembled at runtime: a credential-shaped literal is rejected by the secret scanner. */
const HUBSPOT_TOKEN = ['pat', 'eu1', '00000000-0000-4000-8000-000000000003'].join('-');
const WRAPPING_KEY = toBase64(new Uint8Array(32).fill(5));
const SEALED_ENV = { CREDENTIAL_KEY_V1: WRAPPING_KEY } as const;

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
  vi.unstubAllGlobals();
});

async function workspace(): Promise<SignedIn> {
  open = await signedInWorkspace();
  return open;
}

/** HubSpot's `access-token-info`, and nothing else — the one call this flow may make. */
function stubHubSpot(body: unknown, status = 200): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

function rows(session: SignedIn, sql: string): Array<Record<string, unknown>> {
  return session.h.raw.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
}

describe('pasting a provider credential through the customer router', () => {
  it('CUST-474 the connect page no longer warns that a credential cannot be checked', async () => {
    const session = await workspace();
    const served = await getSignedIn(session, '/app/onboarding/connect');
    expect(served.status).toBe(200);

    const text = visibleText(served.html);
    expect(text).not.toContain('We cannot check a credential yet');
    expect(served.html).toContain('name="intent"');
    expect(served.html).toContain('value="credentials"');
    // The submit button is live, not the disabled "Checking is not available yet".
    expect(text).toContain('Check this HubSpot credential');

    // And a real pair is rendered, which is what the POST below depends on.
    const pair = await csrfPairFor(session, '/app/onboarding/connect');
    expect(pair.cookie).toBe(pair.token);
  });

  it('CUST-475 a valid credential posted to the route ends up as ciphertext in the database', async () => {
    const session = await workspace();
    const stub = stubHubSpot({ hubId: 13579, scopes: ['crm.objects.contacts.read'] });

    const served = await postSignedIn(
      session,
      '/app/onboarding/connect',
      {
        provider: 'hubspot',
        intent: 'credentials',
        access_token: HUBSPOT_TOKEN,
      },
      { env: SEALED_ENV },
    );

    expect(served.status).toBe(200);
    // Exactly one provider call, and it is the token-info read.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain('api.hubapi.com');
    expect(stub.calls[0]).toContain('access-token-info');
    // The credential is never echoed back into the page.
    expect(served.html).not.toContain(HUBSPOT_TOKEN);

    const connection = rows(session, 'SELECT * FROM connections');
    expect(connection).toHaveLength(1);
    expect(connection[0]!['workspace_id']).toBe(session.workspaceId);
    expect(connection[0]!['status']).toBe('ready');
    expect(connection[0]!['external_account_id']).toBe('13579');
    expect(connection[0]!['last_check_at']).toBeTruthy();

    const credential = rows(session, 'SELECT * FROM credential_versions');
    expect(credential).toHaveLength(1);
    expect(String(credential[0]!['ciphertext'])).not.toContain(HUBSPOT_TOKEN);
    expect(credential[0]!['aad']).toBe(
      `v1|kv=1|ws=${session.workspaceId}|provider=hubspot|purpose=api_token`,
    );
    expect(String(credential[0]!['owner_scope']).startsWith('connection:')).toBe(true);

    // The audit row says a credential was submitted and by whom. It does not say what.
    const audit = rows(session, 'SELECT * FROM audit_events');
    expect(audit).toHaveLength(1);
    expect(audit[0]!['action']).toBe('connection.credential_submitted');
    expect(audit[0]!['actor']).toBe(session.userId);
    expect(JSON.stringify(audit)).not.toContain(HUBSPOT_TOKEN);

    // The page reports the new state from the database on the next render — a plain GET,
    // no submission in sight, and Resend beside it still says it is not connected.
    const after = await getSignedIn(session, '/app/onboarding/connect');
    const text = visibleText(after.html);
    expect(text).toContain('HubSpot Status: Ready');
    expect(text).toContain('Resend Status: Not connected');
  });

  it('CUST-476 a credential the provider rejects is refused with 422 and stores nothing', async () => {
    const session = await workspace();
    stubHubSpot({ status: 'error', message: 'expired authentication' }, 401);

    const served = await postSignedIn(
      session,
      '/app/onboarding/connect',
      { provider: 'hubspot', intent: 'credentials', access_token: HUBSPOT_TOKEN },
      { env: SEALED_ENV },
    );

    expect(served.status).toBe(422);
    expect(visibleText(served.html)).toContain('Nothing has been saved');
    expect(served.html).not.toContain(HUBSPOT_TOKEN);
    expect(rows(session, 'SELECT * FROM credential_versions')).toHaveLength(0);
    expect(rows(session, 'SELECT * FROM connections')).toHaveLength(0);
  });

  it('CUST-477 with no wrapping key the route refuses without contacting the provider', async () => {
    const session = await workspace();
    const stub = stubHubSpot({ hubId: 13579, scopes: ['crm.objects.contacts.read'] });

    const served = await postSignedIn(session, '/app/onboarding/connect', {
      provider: 'hubspot',
      intent: 'credentials',
      access_token: HUBSPOT_TOKEN,
    });

    expect(served.status).toBe(422);
    expect(stub.calls).toHaveLength(0);
    expect(visibleText(served.html)).toContain('CREDENTIAL_KEY_V1');
    expect(rows(session, 'SELECT * FROM credential_versions')).toHaveLength(0);
    expect(rows(session, 'SELECT * FROM connections')).toHaveLength(0);
  });
});
