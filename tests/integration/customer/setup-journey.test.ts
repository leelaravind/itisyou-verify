/**
 * The seven steps, walked the way a person with a browser would have to walk them.
 *
 * ## Why this is separate from `setup-entry.test.ts`
 *
 * That file proves the two doors are open. This one proves the corridor behind them
 * connects: that from `/app` a customer reaches the checkout step using only controls
 * rendered on the page in front of them, never by knowing a route.
 *
 * It is the assertion the onboarding suite was missing. Every step had its own cases, each
 * constructing the request it wanted to test, and the journey was unreachable for days
 * without one of them failing, because a test that builds its own URL cannot tell you
 * whether a browser could have built it. So this walk never invents a path. At each step
 * it reads the markup it was served, finds the way onward that page offers, and takes it:
 * a link by following the href, a form by submitting it with a real CSRF pair and
 * following the redirect the server answers with. Where it stops is where a customer
 * stops.
 *
 * What it does NOT claim is that the journey completes. It does not, and saying otherwise
 * would be the kind of claim this product exists to refuse. Step 6 hands off to Stripe and
 * only offers its control when `orderSummary().ready`, which needs two connected
 * providers; the walk goes as far as the review step and then asserts what a customer
 * actually meets there, which is a stated reason rather than a dead end. That boundary
 * moves when a workspace is fully connected and live payments are on, not before.
 *
 * Case ids `CUST-148`, `CUST-149`, `CUST-150`.
 */
import { describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
import {
  BASE,
  SESSION_VALUE,
  csrfPairFor,
  getSignedIn,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(session: SignedIn): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: session.h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

/**
 * Submit a form the way the browser would, and report where the server sent us.
 *
 * The harness's own `postSignedIn` returns the body and drops the `Location`, which is
 * exactly the header this file is about: a step that accepts a submission and redirects
 * onward is a step that leads somewhere, and that fact lives in the header, not the body.
 */
async function submit(
  session: SignedIn,
  path: string,
  fields: Record<string, string>,
): Promise<{ readonly status: number; readonly location: string | null; readonly html: string }> {
  const pair = await csrfPairFor(session, path);
  const body = new URLSearchParams({ ...fields, csrf_token: pair.token });
  const response = (await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE,
        cookie: `__Host-verify_session=${SESSION_VALUE}; __Host-verify_csrf=${pair.cookie}`,
      }),
      body: body.toString(),
    }),
    envFor(session),
    ctx,
  )) as Response;
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: response.status >= 300 && response.status < 400 ? '' : await response.text(),
  };
}

/** Every onboarding path this page offers as a way onward: anchors and form actions. */
function waysOnward(markup: string): readonly string[] {
  const hrefs = [...markup.matchAll(/<a[^>]*href="(\/app\/onboarding\/[^"#?]*)"/g)].map(
    (m) => m[1] ?? '',
  );
  const actions = [...markup.matchAll(/<form[^>]*action="(\/app\/onboarding\/[^"#?]*)"/g)].map(
    (m) => m[1] ?? '',
  );
  return [...new Set([...hrefs, ...actions])];
}

describe('the setup journey is walkable using only the controls a page renders', () => {
  it('CUST-148 the workspace leads to step 1, and step 1 leads to step 2, with no path typed by the test', async () => {
    const session = await signedInWorkspace();
    // Start where a customer starts, with nothing configured in the workspace.
    session.h.raw
      .prepare('DELETE FROM workflow_versions WHERE workspace_id = ?')
      .run(session.workspaceId);
    session.h.raw.prepare('DELETE FROM workflows WHERE workspace_id = ?').run(session.workspaceId);

    const workspace = await getSignedIn(session, '/app');
    expect(workspace.status).toBe(200);
    expect(
      waysOnward(workspace.html),
      'the workspace offers no way into the setup',
    ).toContain('/app/onboarding/compatibility');

    const stepOne = await getSignedIn(session, '/app/onboarding/compatibility');
    expect(stepOne.status).toBe(200);
    expect(waysOnward(stepOne.html), 'step 1 offers no way to step 2').toContain(
      '/app/onboarding/connect',
    );
  });

  it('CUST-149 steps 2 to 5 each lead to the next, links followed and forms actually submitted', async () => {
    const session = await signedInWorkspace();

    // Step 2 -> 3. The connect step leads on by a link: connecting a provider is optional
    // at this point in the journey and the page says so, so the control is a link rather
    // than a gate.
    const connect = await getSignedIn(session, '/app/onboarding/connect');
    expect(connect.status).toBe(200);
    expect(waysOnward(connect.html), 'step 2 offers no way to step 3').toContain(
      '/app/onboarding/mapping',
    );

    // Step 3 -> 4. This one leads on by a form posting to its own path, which is why a
    // walk that only read hrefs called it a dead end. It is not: the server accepts the
    // mapping and redirects. That redirect is the assertion.
    const mapping = await getSignedIn(session, '/app/onboarding/mapping');
    expect(mapping.status).toBe(200);
    expect(waysOnward(mapping.html)).toContain('/app/onboarding/mapping');
    const savedMapping = await submit(session, '/app/onboarding/mapping', {
      correlationProperty: 'enquiry_id',
    });
    expect(savedMapping.status, 'the mapping step refused a valid correlation property').toBe(303);
    expect(savedMapping.location).toBe('/app/onboarding/outcome');

    // Step 4 -> 5. Same shape, and the values are the ones its own form offers.
    const outcome = await getSignedIn(session, '/app/onboarding/outcome');
    expect(outcome.status).toBe(200);
    const savedOutcome = await submit(session, '/app/onboarding/outcome', {
      deadlineSeconds: '3600',
      coverageMode: 'customer_triggered',
      requireRecordExists: 'on',
      requireCorrelationMatch: 'on',
    });
    expect(savedOutcome.status, 'the outcome step refused its own form values').toBe(303);
    expect(savedOutcome.location).toBe('/app/onboarding/proof');

    // Step 5 -> 6. The proof run answers in place rather than redirecting, so the way
    // onward is the link its result carries.
    const proof = await submit(session, '/app/onboarding/proof', {});
    expect(proof.status).toBe(200);
    expect(waysOnward(proof.html), 'the proof result offers no way to the review step').toContain(
      '/app/onboarding/review',
    );
  });

  it('CUST-150 step 6 is where the walk stops on this deployment, and the page states why rather than dead-ending', async () => {
    /*
     * The honest end of the journey today. `orderSummary().ready` is false for a workspace
     * with no connected providers, so the review step renders no submit control, which is
     * correct: a page may not offer a purchase the server would decline. What it must not
     * do is stop without a reason, which is the difference between a gate and a dead end,
     * and is the one a customer experiences as the product being broken.
     */
    const session = await signedInWorkspace();
    const review = await getSignedIn(session, '/app/onboarding/review');
    expect(review.status).toBe(200);
    expect(review.html, 'the review step offers no checkout and gives no reason').toContain(
      'data-unavailable',
    );
    const at = review.html.indexOf('data-unavailable');
    const control = visibleText(review.html.slice(at, at + 900));
    expect(control).toContain('Continue to secure checkout');
    expect(
      control.length,
      'the taken-down control carries its label and nothing else',
    ).toBeGreaterThan('Continue to secure checkout'.length + 20);
  });
});
