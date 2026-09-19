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
