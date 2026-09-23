/**
 * `POST /api/v1/events` — the entry point that did not exist.
 *
 * ## What these cases are for
 *
 * The auditor's finding, stated once: *correct code, thoroughly tested, reached by
 * nothing.* Eight of nine payment-recovery requirements had correct logic and no request
 * path. The reason, found later, was blunter than anybody expected — the product's own
 * intake endpoint was advertised to customers in `db/customerPort.ts` and **never
 * mounted**, so `admitOnce`, the allowance reservation and the entire verification engine
 * were unreachable from outside.
 *
 * So every case here drives a real HTTP `Request` through the real route and then reads
 * the **database** rather than the handler's return value. A test that asserted on the
 * response body alone would be the same mistake in a new place.
 *
 * ## The failing-first demonstration
 *
 * These were written against a route that did not exist and could not: with no signing key
 * anywhere in the product, `BILL-300` could not be expressed at all. The recorded sequence
 * is in the report — the short version is that reverting `signingKeys.ts` to the state the
 * repository was in this morning makes every case in this file fail at `createMoneyHarness`,
 * because `issueWorkflowSigningKey` had no implementation to call.
 *
 * Area risk: this is the untrusted door to the whole product and the only place a unit of
 * allowance is taken. A defect here is either a stranger's event billed to a customer, or
 * a customer's work silently refused.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { LIMITS } from '@verify/contracts';
import { isAllowancePeriodKey } from '@app/billing/period';
import {
  ALLOWANCE_KEY,
  NOW,
  allowanceRow,
  createMoneyHarness,
  eventBody,
  postEvent,
  runRows,
  type MoneyHarness,
} from './harness';

let harness: MoneyHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

async function open(options: Parameters<typeof createMoneyHarness>[0] = {}): Promise<MoneyHarness> {
  harness = await createMoneyHarness(options);
  return harness;
}

describe('the signed-event door', () => {
  it('BILL-300 a signed event becomes a run row and one unit of reserved allowance', async () => {
    const m = await open();
    const response = await postEvent(m, eventBody(m.ws));

    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('PENDING');
    expect(body['duplicate']).toBe(false);
    expect(typeof body['run_id']).toBe('string');

    // The database, not the response. This is the assertion the whole role exists for.
    const runs = runRows(m.h, m.ws.workspaceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(body['run_id']);
    expect(runs[0]?.status).toBe('PENDING');
    // Due immediately, so the very next tick picks it up.
    expect(runs[0]?.next_check_at).toBe(NOW);

    const allowance = allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY);
    expect(allowance).toEqual({ run_limit: 500, consumed: 0, reserved: 1 });

    // The source event is stored as the validated envelope, which is what the scheduler
    // reads its locator from. A run with no readable payload verifies by correlation alone.
    const stored = m.h.raw
      .prepare('SELECT payload_json, external_event_id FROM source_events WHERE workspace_id = ?')
      .get(m.ws.workspaceId) as { payload_json: string; external_event_id: string };
    expect(stored.external_event_id).toBe('evt-000000001');
    expect(JSON.parse(stored.payload_json)).toMatchObject({
      correlation_id: 'enq_0000000000000001',
      expected: { email_recipient: 'ada@example.test' },
    });

    // And the outbox row, committed in the same batch as the run.
    const outbox = m.h.raw
      .prepare('SELECT event_type, unique_event_key FROM outbox WHERE workspace_id = ?')
      .all(m.ws.workspaceId) as { event_type: string; unique_event_key: string }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event_type).toBe('run.created');
  });

  it('BILL-301 the row is opened under the paid-period key, never a calendar month', async () => {
    const m = await open();
    await postEvent(m, eventBody(m.ws));

    const rows = m.h.raw
      .prepare('SELECT billing_period FROM entitlements WHERE workspace_id = ?')
      .all(m.ws.workspaceId) as { billing_period: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.billing_period).toBe(ALLOWANCE_KEY);
    expect(isAllowancePeriodKey(rows[0]?.billing_period ?? '')).toBe(true);
    // The harness anchor is 2026-10-05, so a route that sliced the date or the month would
    // have produced 2026-09-19 or 2026-09 and this would be red.
    expect(rows[0]?.billing_period).not.toBe('2026-09');
    expect(rows[0]?.billing_period).not.toBe('2026-09-19');
  });

  it('BILL-302 a duplicate event id returns the same run and takes no second unit', async () => {
    const m = await open();
    const first = await postEvent(m, eventBody(m.ws));
    const second = await postEvent(m, eventBody(m.ws));

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    const b = (await second.json()) as Record<string, unknown>;
    expect(b['run_id']).toBe(a['run_id']);
    expect(b['duplicate']).toBe(true);

    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)?.reserved).toBe(1);
  });

  it('BILL-303 the same event id with a different body is a conflict, not an overwrite', async () => {
    const m = await open();
    await postEvent(m, eventBody(m.ws));
    const response = await postEvent(
      m,
      eventBody(m.ws, { correlation_id: 'enq_0000000000000002' }),
    );

    expect(response.status).toBe(409);
    const stored = m.h.raw
      .prepare('SELECT payload_json FROM source_events WHERE workspace_id = ?')
      .get(m.ws.workspaceId) as { payload_json: string };
    expect(JSON.parse(stored.payload_json).correlation_id).toBe('enq_0000000000000001');
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)?.reserved).toBe(1);
  });
});

describe('authentication: one answer outward, six reasons inward', () => {
  it('BILL-304 no signature header is refused and writes nothing', async () => {
    const m = await open();
    const response = await postEvent(m, eventBody(m.ws), { signature: null });
    expect(response.status).toBe(401);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)?.reserved).toBe(0);
  });

  it('BILL-305 a signature made with the wrong secret is refused', async () => {
    const m = await open();
    const response = await postEvent(m, eventBody(m.ws), { secret: 'b'.repeat(64) });
    expect(response.status).toBe(401);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-306 a stale timestamp is refused even with a valid signature', async () => {
    const m = await open();
    // Correctly signed, an hour old. The timestamp is inside the signed payload, so a
    // captured request cannot be re-stamped without the secret.
    const response = await postEvent(m, eventBody(m.ws), {
      timestamp: Math.floor(Date.parse(NOW) / 1000) - 3_600,
    });
    expect(response.status).toBe(401);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-307 a future-dated signature is refused', async () => {
    const m = await open();
    const response = await postEvent(m, eventBody(m.ws), {
      timestamp: Math.floor(Date.parse(NOW) / 1000) + 3_600,
    });
    expect(response.status).toBe(401);
  });

  it('BILL-308 an unknown key id is indistinguishable from a bad signature', async () => {
    const m = await open();
    const unknown = await postEvent(m, eventBody(m.ws), { keyId: 'evk_nothing' });
    const wrong = await postEvent(m, eventBody(m.ws), { secret: 'c'.repeat(64) });

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
    // A prober must not be able to learn which key ids exist from the answer.
    expect(unknown.status).toBe(401);
  });

  it('BILL-309 a rotated key stops working on the next request', async () => {
    const m = await open();
    const stillWorks = await postEvent(m, eventBody(m.ws));
    expect(stillWorks.status).toBe(202);

    // Rotation is a new reference; `signing_key_ref` holds exactly one.
    m.h.raw
      .prepare('UPDATE workflows SET signing_key_ref = ? WHERE id = ?')
      .run('evk_rotated', m.ws.workflowId);

    const afterRotation = await postEvent(m, eventBody(m.ws, { event_id: 'evt-000000002' }));
    expect(afterRotation.status).toBe(401);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
  });

  it('BILL-310 no root key is a 503, not a rejection — the fault is ours and it says so', async () => {
    const m = await open({ rootKey: '' });
    const response = await postEvent(m, eventBody(m.ws));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SIGNING_KEY_UNREADABLE');
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-311 the workspace comes from the credential, never from the payload', async () => {
    const m = await open();
    // A correctly signed request naming somebody else's workflow. The credential is the
    // authority; the payload's claim is refused rather than honoured.
    const response = await postEvent(m, eventBody(m.ws, { workflow_id: 'wf_someone_else' }));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_MISMATCH');
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });
});

describe('the body: refused before it is trusted', () => {
  it('BILL-312 an oversized declared length is refused before the body is read', async () => {
    const m = await open();
    const response = await postEvent(m, eventBody(m.ws), {
      contentLength: String(LIMITS.MAX_SOURCE_EVENT_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-313 an oversized body is refused even when the declared length lies', async () => {
    const m = await open();
    const padded = eventBody(m.ws, {
      correlation_id: 'x'.repeat(120),
      expected: {
        email_recipient: 'ada@example.test',
        crm_properties: Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [`p${String(i)}`, 'y'.repeat(120)]),
        ),
      },
    });
    const response = await postEvent(m, padded);
    expect(response.status).toBe(413);
  });

  it('BILL-314 a body that is not the frozen envelope is 422 and writes nothing', async () => {
    const m = await open();
    const response = await postEvent(m, { schema_version: 1, event_id: 'evt-000000001' });
    expect(response.status).toBe(422);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-315 a body that is not JSON is 422, not a 500', async () => {
    const m = await open();
    const response = await postEvent(m, 'not json at all');
    expect(response.status).toBe(422);
  });

  it('BILL-316 an occurred_at outside the freshness window is refused', async () => {
    const m = await open();
    const stale = await postEvent(m, eventBody(m.ws, { occurred_at: '2026-09-19T08:00:00.000Z' }));
    expect(stale.status).toBe(422);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('EVENT_STALE');

    const ahead = await postEvent(
      m,
      eventBody(m.ws, { event_id: 'evt-000000002', occurred_at: '2026-09-19T12:00:00.000Z' }),
    );
    expect(ahead.status).toBe(422);
    expect(((await ahead.json()) as { error: { code: string } }).error.code).toBe(
      'EVENT_IN_FUTURE',
    );

    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });
});

describe('entitlement is enforced on the request path', () => {
  it('BILL-317 a workspace with no subscription is refused 402, and nothing is written', async () => {
    const m = await open({ subscription: null });
    const response = await postEvent(m, eventBody(m.ws));

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NO_SUBSCRIPTION');
    expect(body.error.message).toMatch(/does not have an active subscription/i);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-318 a workspace at its allowance is refused 429, about the period not the account', async () => {
    const m = await open({ runLimit: 1 });
    const first = await postEvent(m, eventBody(m.ws));
    expect(first.status).toBe(202);

    const second = await postEvent(m, eventBody(m.ws, { event_id: 'evt-000000002' }));
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ALLOWANCE_EXHAUSTED');
    expect(body.error.message).toMatch(/have not been charged anything extra/i);

    // One run, one unit. The refusal took nothing.
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 1,
      consumed: 0,
      reserved: 1,
    });
  });

  it('BILL-319 a failed payment pauses new runs at the door and says so in the customer’s words', async () => {
    // `past_due`, updated two days ago: inside the seven-day recovery window.
    const m = await open({
      subscription: { status: 'past_due', updatedAt: '2026-09-17T10:00:00.000Z' },
    });
    const response = await postEvent(m, eventBody(m.ws));

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PAYMENT_RECOVERY_PAUSED');
    // The sentence the policy promises, reaching a customer for the first time.
    expect(body.error.message).toMatch(/paused/i);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)?.reserved).toBe(0);
  });

  it('BILL-320 a workspace with no allowance row for the period is refused, not served', async () => {
    const m = await open({ billingPeriod: '2099-01-01' });
    const response = await postEvent(m, eventBody(m.ws));

    expect(response.status).toBe(409);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
  });

  it('BILL-321 admission never reaches the payment provider', async () => {
    // The harness gateway throws on any property access. Reaching Stripe to answer "may
    // this workspace run" would be a provider call on the hottest path in the system, and
    // an outage at Stripe would become an outage here.
    const m = await open();
    const response = await postEvent(m, eventBody(m.ws));
    expect(response.status).toBe(202);
  });
});

/**
 * The customer's own admission controls, through the real signed-event path.
 *
 * `billing/admission.ts` answers whether WE should serve this workspace. These answer a
 * question the customer owns: have they asked us to stop, and have they set a ceiling below
 * their plan. Both are checked before `admitOnce`, so a refusal writes nothing and moves no
 * allowance — which is what makes the same event id safe to send again afterwards.
 */
describe('the customer can pause admissions and cap them', () => {
  function pause(m: Awaited<ReturnType<typeof open>>, at: string | null): void {
    m.h.raw
      .prepare('UPDATE workflows SET admissions_paused_at = ? WHERE workspace_id = ?')
      .run(at, m.ws.workspaceId);
  }
  function cap(m: Awaited<ReturnType<typeof open>>, limit: number | null): void {
    m.h.raw
      .prepare('UPDATE workflows SET admission_limit_per_period = ? WHERE workspace_id = ?')
      .run(limit, m.ws.workspaceId);
  }

  it('BILL-901 a paused workflow refuses a signed event and writes nothing at all', async () => {
    const m = await open();
    pause(m, NOW);

    const response = await postEvent(m, eventBody(m.ws));

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('ADMISSION_PAUSED');
    // The message has to say what happens to work already under way, because "paused"
    // reads to most people as "everything stops".
    expect(body.error?.message).toContain('Runs already under way are unaffected');
    expect(body.error?.message).toContain('send this same event id again');

    // Nothing written, no allowance moved: that is what makes the retry safe.
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(0);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual({
      run_limit: 500,
      consumed: 0,
      reserved: 0,
    });
  });

  it('BILL-902 the same event id is admitted once the customer resumes', async () => {
    const m = await open();
    pause(m, NOW);
    const refused = await postEvent(m, eventBody(m.ws));
    expect(refused.status).toBe(429);

    pause(m, null);
    const admitted = await postEvent(m, eventBody(m.ws));

    expect(admitted.status).toBe(202);
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toMatchObject({ reserved: 1 });
  });

  it('BILL-903 a customer ceiling refuses further admissions below the plan allowance', async () => {
    const m = await open();
    cap(m, 1);

    const first = await postEvent(m, eventBody(m.ws, { event_id: 'evt-cap-0001' }));
    expect(first.status).toBe(202);

    const second = await postEvent(m, eventBody(m.ws, { event_id: 'evt-cap-0002' }));
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('limit of 1 verifications');

    // The plan still has 499 units. This ceiling is the customer's safety catch, and a
    // faulty automation hitting it must not read as "you have used your plan".
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toMatchObject({ reserved: 1 });
  });

  it('BILL-904 no ceiling set admits normally, so the control is opt-in', async () => {
    const m = await open();
    cap(m, null);
    const response = await postEvent(m, eventBody(m.ws));
    expect(response.status).toBe(202);
  });
});

/**
 * The two properties a read-before-write check cannot establish on its own.
 *
 * `checkCustomerAdmissionControls` reads, then `admitOnce` writes. Between those two the
 * world can move, so the ceiling has to be proved under real concurrency through the actual
 * route rather than argued for from the shape of the code. And an event already admitted
 * must keep answering with its own result after a pause or a ceiling — the refusal is about
 * NEW work, and a customer's retry of something already paid for must not be turned away.
 */
describe('the ceiling and the pause under concurrency and replay', () => {
  function cap(m: Awaited<ReturnType<typeof open>>, limit: number | null): void {
    m.h.raw
      .prepare('UPDATE workflows SET admission_limit_per_period = ? WHERE workspace_id = ?')
      .run(limit, m.ws.workspaceId);
  }
  function pause(m: Awaited<ReturnType<typeof open>>, at: string | null): void {
    m.h.raw
      .prepare('UPDATE workflows SET admissions_paused_at = ? WHERE workspace_id = ?')
      .run(at, m.ws.workspaceId);
  }

  it('BILL-905 concurrent events against a ceiling of one admit exactly one', async () => {
    const m = await open();
    cap(m, 1);

    // Four distinct events in flight together. Every one of them reads the ceiling before
    // any of them has written, which is precisely the window a read-before-write check
    // cannot close by itself.
    const responses = await Promise.all([
      postEvent(m, eventBody(m.ws, { event_id: 'evt-race-1' })),
      postEvent(m, eventBody(m.ws, { event_id: 'evt-race-2' })),
      postEvent(m, eventBody(m.ws, { event_id: 'evt-race-3' })),
      postEvent(m, eventBody(m.ws, { event_id: 'evt-race-4' })),
    ]);

    const admitted = responses.filter((r) => r.status === 202);
    // The allowance reservation is the arbiter, not the ceiling read: whatever the ceiling
    // let through, the database must still show exactly what was charged.
    const runs = runRows(m.h, m.ws.workspaceId);
    const allowance = allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY);

    expect(runs.length).toBe(admitted.length);
    expect(allowance?.reserved).toBe(runs.length);
    // Exactly one, not "at most one": the ceiling rides on the same conditional UPDATE that
    // arbitrates the allowance, so concurrency is decided by the database rather than by
    // whichever request happened to read first.
    expect(runs.length).toBe(1);
    expect(admitted).toHaveLength(1);
  });

  it('BILL-906 an already admitted event replays its own result after a pause, unpaid twice', async () => {
    const m = await open();
    const body = eventBody(m.ws, { event_id: 'evt-replay-1' });

    const first = await postEvent(m, body);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { run_id: string };
    const spentAfterFirst = allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY);

    pause(m, NOW);
    const replay = await postEvent(m, body);

    // 200 with the existing run, not 429: this is not new work, and the customer has
    // already paid for it. Refusing it would make a retry of settled work look like a
    // failure to an automation that is behaving correctly.
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { run_id: string; duplicate: boolean };
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.run_id).toBe(firstBody.run_id);

    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(allowanceRow(m.h, m.ws.workspaceId, ALLOWANCE_KEY)).toEqual(spentAfterFirst);
  });

  it('BILL-907 an already admitted event replays its own result at the ceiling too', async () => {
    const m = await open();
    const body = eventBody(m.ws, { event_id: 'evt-replay-2' });
    const first = await postEvent(m, body);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { run_id: string };

    cap(m, 1);
    const replay = await postEvent(m, body);

    expect(replay.status).toBe(200);
    expect((await replay.json()) as { run_id: string }).toMatchObject({ run_id: firstBody.run_id });
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
  });
});

/**
 * The usage warning, on the path that actually changes usage.
 *
 * `allowance_approaching` and `allowance_reached` existed as templates, with variables and
 * rendering, and nothing had ever sent one — the same shape as the payment-recovery logic an
 * auditor found earlier: correct, tested, consulted by no request path.
 *
 * These drive the real events route and assert what the transport was asked to send.
 */
describe('usage warnings reach the transport, once', () => {
  interface Captured {
    readonly notificationKey: string;
    readonly template: string;
    readonly recipientEmail: string;
  }

  async function openWithAlerts(
    outcome: 'sent' | 'failed' = 'sent',
    runLimit = 4,
  ): Promise<{ m: Awaited<ReturnType<typeof open>>; captured: Captured[] }> {
    const captured: Captured[] = [];
    const m = await open({
      runLimit,
      sendUsageAlert: async (request: Captured) => {
        captured.push({
          notificationKey: request.notificationKey,
          template: request.template,
          recipientEmail: request.recipientEmail,
        });
        return { outcome };
      },
    });
    return { m, captured };
  }

  it('BILL-908 crossing a threshold asks the transport to send, with an event-derived key', async () => {
    // A limit of 4 means the third admission is 75%.
    const { m, captured } = await openWithAlerts('sent', 4);
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-alert-1' }));
    expect(captured).toHaveLength(0);
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-alert-2' }));
    expect(captured).toHaveLength(0);
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-alert-3' }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.template).toBe('allowance_approaching');
    // Derived from the period and the threshold, never from the clock.
    expect(captured[0]?.notificationKey).toContain(':75');
    expect(captured[0]?.notificationKey).not.toMatch(/\d{13}/);
  });

  it('BILL-909 further admissions at the same threshold send nothing more', async () => {
    const { m, captured } = await openWithAlerts('sent', 20);
    // 20-run plan: the 15th admission is 75%, the 16th..18th are still 75-89%.
    for (let i = 1; i <= 18; i += 1) {
      await postEvent(m, eventBody(m.ws, { event_id: `evt-dedupe-${String(i)}` }));
    }
    /*
     * 18 of 20 crosses 75% AND 90%, so two warnings is correct — they are different news.
     * What must never happen is the SAME threshold twice, which is what an alert keyed on
     * the state rather than the crossing would do on every admission for the rest of the
     * period.
     */
    const keys = captured.map((c) => c.notificationKey);
    expect(new Set(keys).size, 'a threshold was announced more than once').toBe(keys.length);
    expect(keys.filter((k) => k.endsWith(':75'))).toHaveLength(1);
    expect(keys.filter((k) => k.endsWith(':90'))).toHaveLength(1);
  });

  it('BILL-910 a failed send is not recorded, so the next admission tries again', async () => {
    const { m, captured } = await openWithAlerts('failed', 4);
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-retry-1' }));
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-retry-2' }));
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-retry-3' }));
    expect(captured).toHaveLength(1);

    // The threshold was never marked announced, because the send failed.
    const stored = m.h.raw
      .prepare('SELECT usage_alert_key FROM workflows WHERE workspace_id = ?')
      .get(m.ws.workspaceId) as { usage_alert_key: string | null };
    expect(stored.usage_alert_key).toBeNull();

    // So the next admission asks again rather than losing the warning.
    await postEvent(m, eventBody(m.ws, { event_id: 'evt-retry-4' }));
    expect(captured.length).toBeGreaterThan(1);
  });

  it('BILL-911 a duplicate event admits nothing and therefore warns about nothing', async () => {
    const { m, captured } = await openWithAlerts('sent', 4);
    const body = eventBody(m.ws, { event_id: 'evt-alert-dup' });
    await postEvent(m, body);
    await postEvent(m, body);
    await postEvent(m, body);

    // Three posts, one admission: usage moved once and never crossed 75%.
    expect(runRows(m.h, m.ws.workspaceId)).toHaveLength(1);
    expect(captured).toHaveLength(0);
  });
});
