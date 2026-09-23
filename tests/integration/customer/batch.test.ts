/**
 * Running a saved list of test enquiries with one press.
 *
 * The rule this is built around is the finders' rule: every expected value comes from the
 * customer's own list, never from the record or message being checked. So these cases check
 * that the admitted payloads carry the list's values exactly, that nothing is charged until
 * the one button that states the cost, that the bounds hold before the first row is
 * admitted, and that a second press of the same page buys nothing.
 *
 * Case ids `VERIFY-929..VERIFY-935`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@verify/security';
import {
  getSignedIn,
  postSignedIn,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness.js';
import { standardRules } from '../scheduler/harness.js';

const ENV = { CREDENTIAL_KEY_V1: toBase64(new Uint8Array(32).fill(51)) } as const;

const LIST = [
  '# record id, expected reference, expected recipient, message id',
  '873152382167, ENQ-TEST-AMSRR8A1, verify-test-1tbbrc@example.com',
  '873158904028, ENQ-TEST-NYCYTMIH, verify-test-nk7crm@example.com',
  '870686986478\tENQ-TEST-OOWL8D0E\tverify-test-6t68gc@example.com\t5a0c1f7e-5a41-4c0e-9d3a-2f6b7c8d9e51',
].join('\n');

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
  vi.unstubAllGlobals();
});

async function ready(consumed = 0, runLimit = 500): Promise<SignedIn> {
  open = await signedInWorkspace({ consumed, runLimit });
  open.h.raw
    .prepare('UPDATE workflow_versions SET rules_json = ? WHERE workspace_id = ?')
    .run(JSON.stringify(standardRules()), open.workspaceId);
  // Nothing may reach a provider from these cases except the background first checks,
  // which are answered "unavailable" so they settle nothing.
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  return open;
}

/**
 * What has been charged, and how many runs exist. Charged is reserved plus consumed: the
 * background first check can settle a run (moving reserved to consumed) between two
 * readings, and that is not a charge.
 */
function ledger(session: SignedIn): { charged: number; runs: number } {
  const ent = session.h.raw
    .prepare('SELECT SUM(consumed) AS consumed, SUM(reserved) AS reserved FROM entitlements')
    .get() as { consumed: number; reserved: number };
  const runs = session.h.raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
  return { charged: ent.consumed + ent.reserved, runs: runs.n };
}

async function save(session: SignedIn, text: string): Promise<{ status: number; html: string }> {
  return postSignedIn(
    session,
    '/app/test-batch/save',
    { enquiries: text },
    { csrfSourcePath: '/app', env: ENV },
  );
}

async function run(session: SignedIn, batchId: string): Promise<{ status: number; html: string }> {
  return postSignedIn(
    session,
    '/app/test-batch/run',
    { batchId },
    { csrfSourcePath: '/app', env: ENV },
  );
}

describe('a batch of test enquiries', () => {
  it('VERIFY-929 saving the list validates every line, costs nothing, and runs nothing', async () => {
    const session = await ready();
    const before = ledger(session);
    const bad = await save(session, `${LIST}\nnot-enough-fields`);
    expect(bad.status).toBe(422);
    expect(visibleText(bad.html)).toContain('Line 5');
    expect(visibleText(bad.html)).toContain('Nothing was saved');

    const good = await save(session, LIST);
    expect(good.status).toBe(303);
    expect(ledger(session)).toEqual(before);
  });

  it('VERIFY-930 the workspace shows the saved list and states the cost above the one button that spends it', async () => {
    const session = await ready();
    await save(session, LIST);
    const served = await getSignedIn(session, '/app');
    const text = visibleText(served.html);
    expect(text).toContain('Running this list uses 3 runs');
    expect(text).toContain('Run all 3 (uses 3 runs)');
    expect(text).toContain('ENQ-TEST-AMSRR8A1');
    // Two rows have no message, and the page says what that means before it is pressed.
    expect(text).toContain('2 have no message id');
    const costAt = served.html.indexOf('Running this list uses');
    const buttonAt = served.html.indexOf('Run all 3');
    expect(costAt).toBeGreaterThan(-1);
    expect(costAt).toBeLessThan(buttonAt);
  });

  it("VERIFY-931 one press admits one run per enquiry, charged once each, carrying the list's own values", async () => {
    const session = await ready();
    await save(session, LIST);
    const before = ledger(session);
    const served = await run(session, 'batch-aaaaaaaa-0001');
    expect(served.status).toBe(303);
    const after = ledger(session);
    expect(after.runs - before.runs).toBe(3);
    expect(after.charged - before.charged).toBe(3);

    const payloads = (
      session.h.raw
        .prepare(
          "SELECT payload_json FROM source_events WHERE source = 'owner_test' ORDER BY external_event_id",
        )
        .all() as Array<{ payload_json: string }>
    ).map(
      (row) =>
        JSON.parse(row.payload_json) as {
          correlation_id: string;
          expected: Record<string, string>;
        },
    );
    expect(payloads.map((p) => p.correlation_id)).toEqual([
      'ENQ-TEST-AMSRR8A1',
      'ENQ-TEST-NYCYTMIH',
      'ENQ-TEST-OOWL8D0E',
    ]);
    expect(payloads[0]?.expected).toEqual({
      email_recipient: 'verify-test-1tbbrc@example.com',
      crm_record_id: '873152382167',
    });
    expect(payloads[2]?.expected['email_message_id']).toBe('5a0c1f7e-5a41-4c0e-9d3a-2f6b7c8d9e51');
  });

  it('VERIFY-932 pressing the same page twice buys nothing the second time', async () => {
    const session = await ready();
    await save(session, LIST);
    await run(session, 'batch-bbbbbbbb-0001');
    const once = ledger(session);
    const again = await run(session, 'batch-bbbbbbbb-0001');
    expect(again.status).toBe(303);
    expect(ledger(session)).toEqual(once);
  });

  it('VERIFY-933 a batch the allowance cannot cover is refused whole, before anything is admitted', async () => {
    const session = await ready(498, 500);
    await save(session, LIST);
    const before = ledger(session);
    const served = await run(session, 'batch-cccccccc-0001');
    expect(served.status).toBe(422);
    expect(visibleText(served.html)).toContain('needs 3 runs and 2 remain');
    expect(ledger(session)).toEqual(before);
  });

  it('VERIFY-934 more than ten enquiries cannot be saved, and a fourth batch in an hour is refused', async () => {
    const session = await ready();
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `87315238${String(1000 + i)}, ENQ-${String(i)}, a${String(i)}@example.com`,
    ).join('\n');
    const tooMany = await save(session, eleven);
    expect(tooMany.status).toBe(422);
    expect(visibleText(tooMany.html)).toContain('At most 10 enquiries per batch');

    await save(session, '873152382167, ENQ-ONE, one@example.com');
    for (const id of ['batch-dddddddd-0001', 'batch-dddddddd-0002', 'batch-dddddddd-0003']) {
      expect((await run(session, id)).status).toBe(303);
    }
    const before = ledger(session);
    const fourth = await run(session, 'batch-dddddddd-0004');
    expect(fourth.status).toBe(422);
    expect(visibleText(fourth.html)).toContain('several batches in a short time');
    expect(ledger(session)).toEqual(before);
  });

  it('VERIFY-935 a viewer can neither save a list nor run one', async () => {
    const session = await ready();
    await save(session, LIST);
    session.h.raw.prepare("UPDATE memberships SET role = 'workspace_viewer'").run();
    const before = ledger(session);
    const saved = await save(session, '873152382167, ENQ-X, x@example.com');
    expect(saved.status).toBe(422);
    expect(visibleText(saved.html)).toContain('Only a workspace admin');
    const ran = await run(session, 'batch-eeeeeeee-0001');
    expect(ran.status).toBe(422);
    expect(ledger(session)).toEqual(before);
  });
});
