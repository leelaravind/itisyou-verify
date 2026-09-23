/**
 * The usage warning through the REAL delivery layer, and the retry a stub cannot see.
 *
 * The route-level cases inject a fake sender into the events route. That proves the route
 * asks at the right moments and proves nothing about what `dispatchNotification` does with
 * the key. An independent audit found the gap hiding behind that: the dispatcher CLAIMS a
 * notification key before sending and settles the outcome onto the same row, so one
 * transient failure takes the key forever — the next attempt finds it claimed and returns
 * `duplicate`, which is not `failed`, so the caller records the threshold as announced and
 * the warning is lost silently.
 *
 * This project had already paid for that once: `scheduler/tick.ts` releases the key for
 * owner alerts, and its comment names the two stuck `failed` rows, one on production and one
 * on staging, that could never fire again. These cases drive the real port so it cannot
 * return here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1SupportDataPort } from '@app/db/supportPort';
import { createNotificationDelivery } from '@app/notifications/delivery';
import { createTestDb, seedWorkspace, type SeededWorkspace, type TestDb } from '../db/harness';

let h: TestDb;
let ws: SeededWorkspace;

beforeEach(() => {
  h = createTestDb();
  ws = seedWorkspace(h, 'alerts');
});
afterEach(() => {
  h.close();
});

const KEY = 'usage:ws:2026-10-05:75';

function transport(status: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ id: 'msg_1' }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function deliver(status: number): Promise<string> {
  const report = await createNotificationDelivery(
    { RESEND_API_KEY: 're_test_key', RESEND_FROM_ADDRESS: 'no-reply@itisyou.test' } as never,
    new D1SupportDataPort(h.db),
    { fetchImpl: transport(status) },
  ).deliver([
    {
      notificationKey: KEY,
      workspaceId: ws.workspaceId,
      recipientEmail: 'ada@example.test',
      template: 'allowance_approaching',
      vars: { workspaceName: 'Alerts', runsUsed: 15, periodEndsAt: '2026-10-05' },
    },
  ]);
  return report.results[0]?.outcome ?? 'none';
}

function rows(): { state: string; template: string }[] {
  return h.raw
    .prepare('SELECT state, template FROM notification_deliveries WHERE notification_key = ?')
    .all(KEY) as { state: string; template: string }[];
}

describe('the usage warning, through the real transport', () => {
  it('BUDGET-907 a successful send records delivery evidence rather than a mailbox claim', async () => {
    expect(await deliver(200)).toBe('sent');

    const recorded = rows();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.template).toBe('allowance_approaching');
    expect(recorded[0]?.state).toBe('sent');
  });

  it('BUDGET-908 the same key twice sends once, and the second is a duplicate', async () => {
    expect(await deliver(200)).toBe('sent');
    expect(await deliver(200)).toBe('duplicate');
    expect(rows()).toHaveLength(1);
  });

  it('BUDGET-909 a failed key is releasable, so the warning can still be delivered later', async () => {
    expect(await deliver(500)).toBe('failed');
    expect(rows()[0]?.state).toBe('failed');

    // Without releasing, the retry is a no-op that LOOKS handled. This is the defect.
    expect(await deliver(200)).toBe('duplicate');
    expect(rows()[0]?.state).toBe('failed');

    // Releasing an undelivered key is what makes the next attempt real.
    expect(await new D1SupportDataPort(h.db).releaseUndeliveredNotification(KEY)).toBe(true);
    expect(await deliver(200)).toBe('sent');
    expect(rows().some((r) => r.state === 'sent')).toBe(true);
  });

  it('BUDGET-910 releasing refuses to touch a delivered key, so nobody is emailed twice', async () => {
    expect(await deliver(200)).toBe('sent');
    expect(
      await new D1SupportDataPort(h.db).releaseUndeliveredNotification(KEY),
      'a sent key was released',
    ).toBe(false);
    expect(await deliver(200)).toBe('duplicate');
  });
});
