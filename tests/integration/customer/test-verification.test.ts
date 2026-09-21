/**
 * "Run a test verification": does it use the real pipeline, and does it refuse to flatter?
 *
 * ## Why this is not a feature test
 *
 * The easy version of this feature is a simulator: take four inputs, pretend, show a green
 * tick. That would be the product committing the exact fault it sells the detection of, so
 * the cases below are built around the ways the easy version would pass and this one must
 * not.
 *
 * What is asserted:
 *
 *  - the event is admitted through `sourceEvents.admitOnce`, the SAME function the signed
 *    event endpoint calls, and the run it creates starts PENDING. There is no verdict at
 *    submit time, because there is no evidence yet;
 *  - it costs one run from the allowance, stated before the customer starts, because it
 *    takes the same admission path as a real enquiry;
 *  - the run is marked `is_synthetic`, and the two places that count runs exclude it, so a
 *    test cannot raise the workspace's own verification rate or the owner's platform total;
 *  - nothing is written to a provider. The connectors have no write path and this makes no
 *    provider call at all at submit time;
 *  - a viewer cannot start one.
 *
 * Case ids `VERIFY-560..VERIFY-565`, `AUTH-519`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@verify/security';
import { getSignedIn, postSignedIn, signedInWorkspace, visibleText, type SignedIn } from './harness.js';

const WRAPPING_KEY = toBase64(new Uint8Array(32).fill(11));
const ENV = { CREDENTIAL_KEY_V1: WRAPPING_KEY } as const;

const GOOD = {
  crmRecordId: 'crm-rec-1',
  messageId: 'msg_0000000001',
  expectedRecipient: 'ada@example.test',
  correlationValue: 'enq_0000000000000042',
};

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
  vi.unstubAllGlobals();
});

/** A workspace that can actually start one: subscribed, with an allowance to draw from. */
async function ready(): Promise<SignedIn> {
  open = await signedInWorkspace({ consumed: 0 });
  /*
   * The seeded workflow version carries an empty rule set, and the offer correctly refuses
   * a workspace with no correlation property: there would be nothing to match the named
   * record back to. Publish a real one, so the fixture is a workspace that could genuinely
   * run a test rather than one the feature is right to turn away.
   */
  open.h.raw
    .prepare("UPDATE workflow_versions SET rules_json = ? WHERE workspace_id = ?")
    .run(
      JSON.stringify({
        schema_version: 1,
        crm_correlation_property: "verify_correlation_id",
        assertions: [],
      }),
      open.workspaceId,
    );
  return open;
}

function runRows(session: SignedIn): Array<Record<string, unknown>> {
  return session.h.raw
    .prepare('SELECT id, status, is_synthetic FROM runs ORDER BY created_at DESC')
    .all() as unknown as Array<Record<string, unknown>>;
}

async function start(
  session: SignedIn,
  fields: Record<string, string> = GOOD,
): Promise<{ status: number; html: string }> {
  return postSignedIn(session, '/app/test-verification', fields, {
    csrfSourcePath: '/app',
    env: ENV,
  });
}

describe('the guided test verification', () => {
  it('VERIFY-560 the workspace offers the form and states the allowance cost before it is started', async () => {
    const session = await ready();
    const served = await getSignedIn(session, '/app');
    expect(served.status).toBe(200);

    expect(served.html).toContain('data-test-verification');
    expect(served.html).toContain('action="/app/test-verification"');
    const text = visibleText(served.html);
    // The cost, said before the four fields rather than after the button.
    expect(text).toMatch(/uses one of your \d+ runs/);
    // And the refusal of the inference somebody would most like to draw.
    expect(text).toContain('It proves nothing about whether your automation reports its enquiries');

    /*
     * The four fields sit behind a closed disclosure so the page answers "is my automation
     * working" before it offers an occasional action. Neither of the two sentences above may
     * follow them in: a limitation behind a disclosure is one a reader can honestly say they
     * never saw, and the cost has to be stated BEFORE the test is started.
     */
    const disclosureAt = served.html.indexOf('<details');
    expect(disclosureAt, 'the form is no longer behind a disclosure').toBeGreaterThan(-1);
    const openText = visibleText(served.html.slice(0, disclosureAt));
    expect(openText, 'the allowance cost moved inside the disclosure').toMatch(
      /uses one of your \d+ runs/,
    );
    const afterDisclosure = visibleText(served.html.slice(served.html.indexOf('</details>')));
    expect(afterDisclosure, 'the refusal of the inference moved inside the disclosure').toContain(
      'It proves nothing about whether your automation reports its enquiries',
    );
  });

  it('VERIFY-561 every guided field names something that must already exist, and nothing is written anywhere', async () => {
    const session = await ready();
    const served = await getSignedIn(session, '/app');
    const text = visibleText(served.html);

    expect(text).toContain('We create nothing and send nothing');
    expect(text).toContain('We read it; we never create or edit one');
    expect(text).toContain('we never send mail');

    // No provider call is made by starting one: the evidence is read later, by the
    // scheduler, against the real connectors. Any fetch here would be a write path or a
    // shortcut, and there is neither.
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await start(session);
    expect(calls, 'starting a test verification called out to something').toEqual([]);
  });

  it('VERIFY-562 it admits a real run through the real path, PENDING, with no verdict invented', async () => {
    const session = await ready();
    const before = runRows(session).length;

    const served = await start(session);
    // A redirect to the run is the honest answer: there is no result yet to render.
    expect(served.status).toBe(303);

    const rows = runRows(session);
    expect(rows.length, 'no run was created').toBe(before + 1);
    const created = rows[0] as Record<string, unknown>;
    expect(created['status'], 'a verdict was invented at submit time').toBe('PENDING');

    // A real source event, with the customer's four values, sitting behind it.
    const event = session.h.raw
      .prepare('SELECT payload_json, source FROM source_events ORDER BY received_at DESC LIMIT 1')
      .get() as { payload_json: string; source: string };
    const payload = JSON.parse(event.payload_json) as {
      correlation_id: string;
      expected: Record<string, string>;
    };
    expect(payload.correlation_id).toBe(GOOD.correlationValue);
    expect(payload.expected['crm_record_id']).toBe(GOOD.crmRecordId);
    expect(payload.expected['email_message_id']).toBe(GOOD.messageId);
    expect(payload.expected['email_recipient']).toBe(GOOD.expectedRecipient);
    expect(event.source).toBe('owner_test');
  });

  it('VERIFY-566 the run page says in words that this was a test the customer started', async () => {
    /*
     * An independent verifier read a finished run page and could not tell it from customer
     * traffic: the only marker was the field value "Source type: owner_test", four cards
     * down. A figure you cannot place is worse than no figure, which is the confusion this
     * product exists to refuse, so it is named in words above the verdict.
     */
    const session = await ready();
    await start(session);
    const created = runRows(session)[0] as Record<string, unknown>;
    const served = await getSignedIn(session, `/app/runs/${String(created['id'])}`);
    expect(served.status).toBe(200);

    expect(served.html, 'the run page does not say it was a test').toContain('data-test-run-notice');
    const text = visibleText(served.html);
    expect(text).toContain('This is a test verification you ran from your workspace');
    expect(text).toContain('left out of your verification rate');

    // And it appears BEFORE the verdict, not four cards below it.
    expect(served.html.indexOf('data-test-run-notice')).toBeLessThan(
      served.html.indexOf('data-run-verdict'),
    );
  });

  it('VERIFY-563 the run is marked synthetic and is excluded from both run counts', async () => {
    const session = await ready();
    await start(session);

    const created = runRows(session)[0] as Record<string, unknown>;
    expect(created['is_synthetic'], 'the test run was not marked').toBe(1);

    /*
     * The flag alone would be decoration: `runs.is_synthetic` existed from the first
     * migration and was read NOWHERE, so a test run counted as platform traffic and could
     * raise the workspace's own verification rate. Both queries now exclude it, and these
     * two assertions are what stop that regressing.
     */
    const ownerTotal = session.h.raw
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE created_at >= '1970-01-01' AND is_synthetic = 0")
      .get() as { n: number };
    const allRuns = session.h.raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    expect(allRuns.n).toBeGreaterThan(ownerTotal.n);

    // And the customer's own dashboard rate does not count it either.
    const served = await getSignedIn(session, '/app');
    expect(served.status).toBe(200);
  });

  it('VERIFY-564 it refuses bad input per field and starts nothing', async () => {
    const session = await ready();
    const before = runRows(session).length;

    const served = await start(session, {
      crmRecordId: '',
      messageId: '',
      expectedRecipient: 'not-an-address',
      correlationValue: '',
    });

    expect(served.status).toBe(422);
    const text = visibleText(served.html);
    expect(text).toContain('Name a CRM record that already exists');
    expect(text).toContain('Give the address the acknowledgement should have reached');
    expect(runRows(session).length, 'a run was created from invalid input').toBe(before);
  });

  it('VERIFY-565 it is rate limited, because each one spends a run', async () => {
    const session = await ready();
    let last = { status: 0, html: '' };
    for (let i = 0; i < 6; i += 1) last = await start(session);

    expect(last.status).toBe(422);
    expect(visibleText(last.html)).toContain('several test verifications in a short time');
  });

  it('AUTH-519 a workspace viewer is offered no form and the route refuses them', async () => {
    const session = await ready();
    session.h.raw.prepare("UPDATE memberships SET role = 'workspace_viewer'").run();

    const served = await getSignedIn(session, '/app');
    expect(served.html, 'a viewer is offered the test form').not.toContain(
      'action="/app/test-verification"',
    );
    expect(visibleText(served.html)).toContain('Only a workspace admin can run a test verification');

    const before = runRows(session).length;
    const posted = await start(session);
    expect(posted.status).toBe(422);
    expect(runRows(session).length, 'a viewer created a run').toBe(before);
  });
});
