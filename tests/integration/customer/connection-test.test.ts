/**
 * "Test connection": does the button do what its label promises?
 *
 * ## Why this exists
 *
 * `revalidateConnection` has been in `@verify/connectors` since the connector work, fully
 * tested, and was called from **nowhere**. Exported, correct, unreachable. That is this
 * codebase's own named defect pattern, and its customer-visible cost was that a connection
 * could rot, through a revoked token or a portal swapped underneath it, with no way for
 * anybody to find out until a run failed for a reason nobody could explain.
 *
 * So these cases drive `POST /app/connections/test` through the real Worker with a real
 * session and a real CSRF pair, stub the PROVIDER rather than our own code, and then look
 * at three things: what the page says, what the database now holds, and whether the stored
 * credential survived.
 *
 * ## The three findings are asserted separately, deliberately
 *
 * A provider answering our read proves the credential is live. It does not prove a webhook
 * ever arrived, and neither proves the customer's automation reports enquiries to us. The
 * page draws all three, and CONN-520 asserts it never collapses them into one verdict,
 * because "connected" meaning three different things is how somebody comes to believe a
 * workflow is monitored while nothing is reaching us.
 *
 * Case ids `CONN-518..CONN-523`, `AUTH-518`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@verify/security';
import { getSignedIn, postSignedIn, signedInWorkspace, visibleText, type SignedIn } from './harness.js';

/** Assembled at runtime: a credential-shaped literal is rejected by the secret scanner. */
const HUBSPOT_TOKEN = ['pat', 'eu1', '00000000-0000-4000-8000-000000000009'].join('-');
const WRAPPING_KEY = toBase64(new Uint8Array(32).fill(7));
const SEALED_ENV = { CREDENTIAL_KEY_V1: WRAPPING_KEY } as const;
const PORTAL_ID = 13579;

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
  vi.unstubAllGlobals();
});

/** A HubSpot that answers `access-token-info`, and records every call made to it. */
function stubProvider(
  reply: { body: unknown; status?: number } | 'unreachable',
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (reply === 'unreachable') throw new TypeError('network unreachable');
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

const HEALTHY = { body: { hubId: PORTAL_ID, scopes: ['crm.objects.contacts.read'] } };

/** Connect HubSpot for real, through the product, so the stored credential is a real one. */
async function connectHubSpot(session: SignedIn): Promise<void> {
  stubProvider(HEALTHY);
  const served = await postSignedIn(
    session,
    '/app/onboarding/connect',
    { provider: 'hubspot', intent: 'credentials', access_token: HUBSPOT_TOKEN },
    { env: SEALED_ENV },
  );
  expect(served.status, 'the fixture must start from a real, connected credential').toBe(200);
  vi.unstubAllGlobals();
}

async function pressTest(
  session: SignedIn,
  env: Readonly<Record<string, unknown>> = SEALED_ENV,
): Promise<{ status: number; html: string }> {
  return postSignedIn(
    session,
    '/app/connections/test',
    { provider: 'hubspot' },
    { csrfSourcePath: '/app/connections', env },
  );
}

function credentialCount(session: SignedIn): number {
  const row = session.h.raw
    .prepare('SELECT COUNT(*) AS n FROM credential_versions WHERE retired_at IS NULL')
    .get() as { n: number };
  return row.n;
}

function connectionRow(session: SignedIn): Record<string, unknown> {
  return session.h.raw
    .prepare("SELECT status, last_check_at, last_error_code FROM connections WHERE provider = 'hubspot'")
    .get() as Record<string, unknown>;
}

describe('testing a stored connection against the provider', () => {
  it('CONN-518 the connections page offers a Test connection control for each provider', async () => {
    open = await signedInWorkspace();
    const served = await getSignedIn(open, '/app/connections');
    expect(served.status).toBe(200);
    expect(served.html).toContain('action="/app/connections/test"');
    expect(visibleText(served.html)).toContain('Test HubSpot connection');
    // A form, not a link: each press is an outbound call on the customer's own provider
    // account, so a prefetch or a crawler must not be able to spend it.
    expect(served.html).toMatch(/<form[^>]*action="\/app\/connections\/test"[\s\S]*?type="submit"/);
  });

  it('CONN-519 pressing it really calls the provider and records what came back', async () => {
    open = await signedInWorkspace();
    await connectHubSpot(open);

    const provider = stubProvider(HEALTHY);
    const served = await pressTest(open);

    expect(served.status).toBe(200);
    expect(provider.calls.length, 'no call was made to the provider').toBeGreaterThan(0);
    expect(provider.calls.some((u) => u.includes('hubapi.com')), 'the call did not go to HubSpot').toBe(true);

    const row = connectionRow(open);
    expect(row['last_check_at'], 'the check time was not recorded').not.toBeNull();
    expect(row['status']).toBe('ready');
  });

  it('CONN-520 the result distinguishes API access, webhook readiness and workflow verification', async () => {
    open = await signedInWorkspace();
    await connectHubSpot(open);
    stubProvider(HEALTHY);

    const served = await pressTest(open);
    const text = visibleText(served.html);

    expect(served.html).toContain('data-connection-test-result="hubspot"');
    expect(served.html).toContain('data-test-findings="hubspot"');
    // Three findings, named, not one verdict.
    expect(text).toContain('API access');
    expect(text).toContain('Webhook readiness');
    expect(text).toContain('Workflow verification');
    // And the third is explicitly NOT claimed by this check, whatever the API said.
    expect(text).toContain('this button cannot check it');
    // The check time is shown, so "connected" is never undated.
    expect(text).toMatch(/Checked /);
  });

  it('CONN-521 a provider that cannot be reached leaves the stored credential alone and says so', async () => {
    open = await signedInWorkspace();
    await connectHubSpot(open);
    const before = credentialCount(open);
    expect(before, 'the fixture stored no credential').toBeGreaterThan(0);

    stubProvider('unreachable');
    const served = await pressTest(open);
    const text = visibleText(served.html);

    expect(served.status).toBe(200);
    // The customer is told their key was not touched. An outage is our problem or the
    // provider's; making them re-paste a working key would charge them for it.
    expect(text).toContain('stored credential was not changed');
    expect(credentialCount(open), 'a credential was retired by an outage').toBe(before);
    expect(connectionRow(open)['last_error_code']).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-522 a provider that refuses the credential reports it without inventing a cause', async () => {
    open = await signedInWorkspace();
    await connectHubSpot(open);

    stubProvider({ body: { status: 'error', message: 'expired authentication' }, status: 401 });
    const served = await pressTest(open);

    expect(served.status).toBe(200);
    const row = connectionRow(open);
    expect(row['status'], 'a refused credential still reads ready').not.toBe('ready');
    expect(row['last_error_code']).not.toBeNull();
    // The API finding must be FAILED, not merely absent.
    expect(served.html).toContain('data-test-findings="hubspot"');
    expect(visibleText(served.html)).toContain('The provider refused or could not answer our read.');
  });

  it('CONN-523 the button is rate limited, so it cannot be used to hammer a provider through us', async () => {
    open = await signedInWorkspace();
    await connectHubSpot(open);

    let last = { status: 0, html: '' };
    for (let i = 0; i < 8; i += 1) {
      stubProvider(HEALTHY);
      last = await pressTest(open);
      vi.unstubAllGlobals();
    }
    // The limit is six in five minutes; the seventh and eighth must be refused, and the
    // refusal is a 503 because nothing of the customer's is wrong.
    expect(last.status).toBe(503);
    expect(visibleText(last.html)).toContain('That is a lot of checks in a short time');
  });

  it('AUTH-518 a workspace viewer cannot test a connection, and the route refuses them too', async () => {
    open = await signedInWorkspace();
    await connectHubSpot(open);
    open.h.raw.prepare("UPDATE memberships SET role = 'workspace_viewer'").run();

    const page = await getSignedIn(open, '/app/connections');
    expect(page.html, 'a viewer is offered the test form').not.toContain(
      'action="/app/connections/test"',
    );

    // The page hiding a control is not an authorisation, so the route is asked directly.
    const provider = stubProvider(HEALTHY);
    const served = await pressTest(open);

    expect(served.status).toBe(503);
    expect(visibleText(served.html)).toContain('Only a workspace admin can test a connection');
    expect(provider.calls.length, 'the provider was called for a viewer').toBe(0);
  });
});
