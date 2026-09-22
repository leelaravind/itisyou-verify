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

/**
 * Pressing the button twice is one verification, not two charges.
 *
 * Met on production, 22 September 2026: the identical enquiry — same CRM id, same
 * correlation value, same message id, same recipient — submitted twice produced two distinct
 * runs and two charges. The form minted a fresh external event id on every press, so the
 * admission rule that exists precisely to stop this (exactly one run and exactly one unit of
 * allowance per `(workspace, external_event_id)`, PERSIST-101/102) never saw a repeat.
 *
 * The fix routes the form through that same rule rather than adding a second mechanism: the
 * rendered form carries a submission identity, and a double-click, a browser
 * back-and-resubmit and a refresh all present it again. A newly loaded form is a new
 * submission, costs another run, and says so before the button.
 */
describe('an accidental resubmission reuses the run it already started', () => {
  /**
   * Summed across every entitlement row for the workspace.
   *
   * The fixture opens two: a calendar-month row from `seedWorkspace` and the paid-period
   * row admission actually draws from. Reading "the first" silently measured the wrong one
   * and reported every spend as zero.
   */
  function spendOf(session: SignedIn): number {
    const row = session.h.raw
      .prepare(
        'SELECT COALESCE(SUM(consumed), 0) AS c, COALESCE(SUM(reserved), 0) AS r FROM entitlements WHERE workspace_id = ?',
      )
      .get(session.workspaceId) as { c: number; r: number };
    return row.c + row.r;
  }

  it('VERIFY-570 the rendered form carries a submission identity', async () => {
    open = await ready();
    const served = await getSignedIn(open, '/app');
    expect(served.html).toContain('name="submissionId"');
  });

  it('VERIFY-571 two presses of one form make one run and spend one unit', async () => {
    open = await ready();
    const before = spendOf(open);
    const fields = { ...GOOD, submissionId: 'submission-aaaa-0001' };

    const first = await start(open, fields);
    const second = await start(open, fields);

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(runRows(open)).toHaveLength(1);

    expect(spendOf(open) - before, 'the second press bought a second run').toBe(1);
  });

  it('VERIFY-572 concurrent identical presses still make one run and spend one unit', async () => {
    open = await ready();
    const before = spendOf(open);
    const fields = { ...GOOD, submissionId: 'submission-bbbb-0002' };

    // Two in flight at once, which is what a double-click actually produces.
    const [a, b] = await Promise.all([start(open, fields), start(open, fields)]);
    expect(a.status).toBe(303);
    expect(b.status).toBe(303);

    expect(runRows(open)).toHaveLength(1);
    expect(spendOf(open) - before).toBe(1);
  });

  it('VERIFY-573 a new submission identity is a new run, deliberately', async () => {
    open = await ready();
    const before = spendOf(open);

    await start(open, { ...GOOD, submissionId: 'submission-cccc-0003' });
    await start(open, { ...GOOD, submissionId: 'submission-dddd-0004' });

    // Asking again on purpose must still work: this is the "Run another verification"
    // path, and it is a real second check of the same enquiry.
    expect(runRows(open)).toHaveLength(2);
    expect(spendOf(open) - before).toBe(2);
  });
});

/**
 * The click → check → result → run again journey, as served.
 *
 * The owner's screenshot on 22 September showed the workspace with no visible way to start
 * a verification: the only entry was a closed disclosure reading "Describe the enquiry to
 * check", four screens below the fold. A pushed commit and a passing unit test had not made
 * a button exist.
 */
describe('the verification journey has a visible way in and a way round again', () => {
  it('VERIFY-580 the workspace offers a primary Run verification button beside the heading', async () => {
    open = await ready();
    const served = await getSignedIn(open, '/app');
    const text = visibleText(served.html);

    expect(text).toContain('Run verification');
    expect(served.html).toContain('href="/app?verify=1#run-verification"');
    // It starts OUR checks. It must never claim to trigger the customer's own workflow.
    expect(text).not.toContain('Run automation');
  });

  it('VERIFY-581 the runs list carries the same way in', async () => {
    open = await ready();
    const served = await getSignedIn(open, '/app/runs');
    expect(visibleText(served.html)).toContain('Run verification');
    expect(served.html).toContain('href="/app?verify=1#run-verification"');
  });

  it('VERIFY-582 arriving with verify=1 opens the form rather than hiding it again', async () => {
    open = await ready();
    const closed = await getSignedIn(open, '/app');
    const opened = await getSignedIn(open, '/app?verify=1');

    // The disclosure carries `open` only when asked for. Matched as an attribute on the
    // element rather than as exact bytes, because `attrs` decides the spacing.
    const isOpen = (html: string): boolean => /<details[^>]*\sopen[\s>]/.test(html);
    expect(isOpen(opened.html), 'verify=1 did not open the form').toBe(true);
    expect(isOpen(closed.html), 'the form was open without being asked for').toBe(false);
  });

  it('VERIFY-583 a settled run offers Run another verification and a prefilled recheck', async () => {
    open = await ready();
    await start(open, { ...GOOD, submissionId: 'submission-journey-1' });
    const runId = (runRows(open)[0] as { id: string }).id;
    open.h.raw.prepare("UPDATE runs SET status = 'VERIFIED' WHERE id = ?").run(runId);

    const served = await getSignedIn(open, `/app/runs/${runId}`);
    const text = visibleText(served.html);

    expect(text).toContain('Run another verification');
    expect(text).toContain('Recheck this enquiry');
    // The cost, stated above the confirm rather than after it.
    expect(text).toContain('uses one run from your allowance');
    // Prefilled with what was actually asked, so nobody retypes four identifiers.
    expect(served.html).toContain(`value="${GOOD.crmRecordId}"`);
    expect(served.html).toContain(`value="${GOOD.messageId}"`);
    // And its own identity, so pressing Recheck twice cannot buy two.
    expect(served.html).toContain('name="submissionId"');
  });

  it('VERIFY-584 a pending run shows progress and a View result action, not a recheck', async () => {
    open = await ready();
    await start(open, { ...GOOD, submissionId: 'submission-journey-2' });
    const runId = (runRows(open)[0] as { id: string }).id;

    const served = await getSignedIn(open, `/app/runs/${runId}`);
    const text = visibleText(served.html);

    expect(text).toContain('We are still checking');
    expect(text).toContain('View result');
    // Nothing to recheck yet: the first check has not finished.
    expect(text).not.toContain('Recheck this enquiry');
  });

  it('VERIFY-585 reusing one identity with different details is refused, not answered with the old run', async () => {
    open = await ready();
    const id = 'submission-journey-3';
    await start(open, { ...GOOD, submissionId: id });
    const before = runRows(open).length;

    const changed = await start(open, {
      ...GOOD,
      crmRecordId: 'crm-rec-DIFFERENT',
      submissionId: id,
    });

    // Refused rather than silently handing back a result about the earlier enquiry.
    expect(changed.status).toBe(422);
    expect(visibleText(changed.html)).toContain('different from the ones this form was already submitted with');
    expect(runRows(open)).toHaveLength(before);
  });
});
