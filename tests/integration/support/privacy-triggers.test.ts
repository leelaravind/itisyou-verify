/**
 * API-40x — does a real customer action, or a real scheduled tick, produce the three
 * privacy notifications?
 *
 * This file exists for exactly the reason `notification-wiring.test.ts` next door does.
 * `export.ts` and `deletion.ts` were complete, correct and **reached by nothing**:
 * `buildExport` exported only pure functions, `exportLinkExpiry()` in `send.ts` had no
 * caller at all, and `scheduleWorkspaceDeletion`, `deleteWorkspace` and `retainedStatement`
 * all existed and built nothing. Three templates — `data_export_ready`,
 * `deletion_scheduled`, `deletion_completed` — had no event that could ever produce them.
 * `docs/privacy-retention.md` §0 lists every one of those rows as "implemented, tested,
 * and reached by nothing yet".
 *
 * So nothing here calls `sendNotification` or `renderNotification` directly to make a
 * template appear. Each case starts at the request layer in `privacy/requests.ts` — the
 * entry point a route calls — runs the real `deliverNotifications` chain through the real
 * `ResendEmailTransport` against a stub `fetch`, and finishes by reading
 * `notification_deliveries` out of a real SQLite database with the real migrations applied.
 *
 * **These cases fail before the fix by construction**: `privacy/requests.ts` did not exist,
 * so the module under test could not be imported and nothing could produce these keys.
 *
 * The last case is the constraint that matters most here: what each template actually
 * interpolates. Nothing may carry a credential, a card detail, a payment-method id, or
 * another tenant's data. That is asserted against the bytes posted to the transport, not
 * against a comment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { D1SupportDataPort } from '@app/db/supportPort';
import { createNotificationDelivery } from '@app/notifications/delivery';
import {
  cancelWorkspaceDeletion,
  redeemExportLink,
  requestWorkspaceDeletion,
  requestWorkspaceExport,
  runDueWorkspaceDeletions,
  EXPORT_LINK_TTL_SECONDS,
} from '@app/privacy/requests';
import { DELETION_GRACE_DAYS } from '@app/privacy/deletion';
import { createTestDb, seedWorkspace, type TestDb } from '../db/harness';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Assembled at runtime, never written as a literal. This repository is public and a
 * credential-shaped string is rejected by `scripts/scan-secrets.mjs` and by GitHub push
 * protection — see `docs/agent-brief.md` and SEC-633.
 */
const RESEND_KEY = ['re', 'test', '0'.repeat(24)].join('_');
const FROM_ADDRESS = 'verify@example.test';
const BASE_URL = 'https://verify.example';
const CONTACT = 'owner@example.test';

let dbs: TestDb[] = [];

afterEach(() => {
  for (const h of dbs) h.close();
  dbs = [];
});

interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** A `fetch` that accepts every submission and records what was actually posted. */
function recordingFetch(sent: SentEmail[]): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({
      to: String((body['to'] as string[] | undefined)?.[0] ?? ''),
      subject: String(body['subject'] ?? ''),
      text: String(body['text'] ?? ''),
      html: String(body['html'] ?? ''),
    });
    return new Response(JSON.stringify({ id: 'msg_stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

interface Scene {
  readonly h: TestDb;
  readonly workspaceId: string;
  readonly port: D1SupportDataPort;
  readonly sent: SentEmail[];
  readonly clock: { value: string };
  readonly deps: Parameters<typeof requestWorkspaceExport>[0];
  notificationRows(): Record<string, unknown>[];
  settingsRows(): Record<string, unknown>[];
  workspaceRow(): Record<string, unknown> | undefined;
}

function scene(options: { readonly startAt?: string; readonly suffix?: string } = {}): Scene {
  const h = createTestDb();
  dbs.push(h);
  const suffix = options.suffix ?? 'priv';
  seedWorkspace(h, suffix);
  const workspaceId = `ws_${suffix}`;
  const port = new D1SupportDataPort(h.db);
  const clock = { value: options.startAt ?? '2026-09-19T09:00:00.000Z' };
  const sent: SentEmail[] = [];
  const delivery = createNotificationDelivery(
    { RESEND_API_KEY: RESEND_KEY, RESEND_FROM_ADDRESS: FROM_ADDRESS },
    port,
    { fetchImpl: recordingFetch(sent), now: () => new Date(clock.value) },
  );
  return {
    h,
    workspaceId,
    port,
    sent,
    clock,
    deps: {
      port,
      notifications: { deliver: (requests) => delivery.deliver(requests) },
      baseUrl: BASE_URL,
      now: () => new Date(clock.value),
    },
    notificationRows: () =>
      h.raw
        .prepare('SELECT * FROM notification_deliveries ORDER BY created_at, notification_key')
        .all() as Record<string, unknown>[],
    settingsRows: () =>
      h.raw.prepare('SELECT * FROM settings ORDER BY key').all() as Record<string, unknown>[],
    workspaceRow: () =>
      h.raw.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
        | Record<string, unknown>
        | undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* data_export_ready                                                           */
/* -------------------------------------------------------------------------- */

describe('API-40x the data export has an entry point', () => {
  it('API-401 requesting an export sends data_export_ready and records one delivery row', async () => {
    const s = scene();

    const outcome = await requestWorkspaceExport(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
    });

    // The link is real, points at our own origin, and carries an opaque token.
    expect(outcome.downloadUrl.startsWith(`${BASE_URL}/app/export/`)).toBe(true);
    expect(outcome.expiresAt).toBe(
      new Date(Date.parse(s.clock.value) + EXPORT_LINK_TTL_SECONDS * 1000).toISOString(),
    );

    // One email actually reached the transport.
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.subject).toContain('your data export is ready');
    expect(s.sent[0]?.text).toContain(outcome.downloadUrl);

    // And the database says so.
    const rows = s.notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['template']).toBe('data_export_ready');
    expect(rows[0]?.['workspace_id']).toBe(s.workspaceId);
    expect(rows[0]?.['state']).toBe('sent');
    expect(rows[0]?.['provider_status']).toBe('accepted_by_sending_service');
    // The recipient is stored hashed, never as an address. A previous agent closed two
    // leaks by hashing the recipient before storage; that standard holds here.
    expect(String(rows[0]?.['recipient_hash'] ?? '')).not.toContain('@');
    expect(String(rows[0]?.['recipient_hash'] ?? '')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('API-402 the raw download token is never stored — only its hash is', async () => {
    const s = scene();
    const outcome = await requestWorkspaceExport(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
    });
    const token = outcome.downloadUrl.split('/').pop() ?? '';
    expect(token.length).toBeGreaterThan(30);

    const dump = JSON.stringify(s.settingsRows());
    expect(dump, 'the raw token must never reach storage').not.toContain(token);
    // The stored key is a SHA-256 of it, under this file's own prefix.
    expect(dump).toContain('privacy:export-link:');
  });

  it('API-403 the link rebuilds the export for its own workspace and expires on time', async () => {
    const s = scene();
    const outcome = await requestWorkspaceExport(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
    });
    const token = outcome.downloadUrl.split('/').pop() ?? '';

    const built = await redeemExportLink(s.deps, token);
    expect(built.workspaceId).toBe(s.workspaceId);
    expect(built.files.length).toBeGreaterThan(0);

    // One second past the stated expiry, the link is gone. A 404, not a 403: confirming
    // that a token existed is itself a small leak.
    s.clock.value = new Date(
      Date.parse(outcome.expiresAt) + 1_000,
    ).toISOString();
    await expect(redeemExportLink(s.deps, token)).rejects.toThrow(/no longer usable/i);
  });

  it('API-404 an unknown token is refused rather than serving anything', async () => {
    const s = scene();
    await expect(redeemExportLink(s.deps, 'not-a-real-token')).rejects.toThrow(/no longer usable/i);
    expect(s.sent).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* deletion_scheduled and deletion_completed                                   */
/* -------------------------------------------------------------------------- */

describe('API-41x workspace deletion has an entry point', () => {
  it('API-411 requesting a deletion schedules it, sends deletion_scheduled, and removes nothing', async () => {
    const s = scene();

    const outcome = await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });

    const expected = new Date(
      Date.parse(s.clock.value) + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(outcome.schedule.deletionAt).toBe(expected);

    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.subject).toContain('deletion scheduled');
    expect(s.sent[0]?.text).toContain('Nothing has been removed yet');

    const rows = s.notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['template']).toBe('deletion_scheduled');
    expect(rows[0]?.['state']).toBe('sent');

    // Nothing was deleted. The grace period is the product, not a formality.
    expect(s.workspaceRow()?.['status']).toBe('active');
    expect(
      (s.h.raw.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number }).n,
    ).toBe(1);
  });

  it('API-412 asking twice inside the grace period does not move the date or send twice', async () => {
    const s = scene();
    const first = await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });

    s.clock.value = '2026-09-20T09:00:00.000Z';
    const second = await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });

    expect(second.schedule.deletionAt).toBe(first.schedule.deletionAt);
    expect(second.notification.duplicates).toBe(1);
    expect(s.sent).toHaveLength(1);
    expect(s.notificationRows()).toHaveLength(1);
  });

  it('API-413 the tick deletes nothing before the grace period ends', async () => {
    const s = scene();
    await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });

    s.clock.value = '2026-09-25T09:00:00.000Z'; // day 6 of 7
    const outcomes = await runDueWorkspaceDeletions(s.deps);

    expect(outcomes).toHaveLength(0);
    expect(s.workspaceRow()?.['status']).toBe('active');
    expect(s.sent).toHaveLength(1); // still only the schedule message
  });

  it('API-414 the tick after the grace period deletes, sends deletion_completed, and the workspace is marked deleted', async () => {
    const s = scene();
    await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });

    s.clock.value = '2026-09-27T09:00:00.000Z'; // past day 7
    const outcomes = await runDueWorkspaceDeletions(s.deps);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.report.complete).toBe(true);

    // The database, read back.
    expect(s.workspaceRow()?.['status']).toBe('deleted');
    expect(s.workspaceRow()?.['deleted_at']).not.toBeNull();
    expect(
      (s.h.raw.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number }).n,
      'every membership of the workspace is removed',
    ).toBe(0);
    expect(
      (s.h.raw.prepare('SELECT COUNT(*) AS n FROM workflows').get() as { n: number }).n,
      'workflow configuration is removed',
    ).toBe(0);

    // The confirmation carries the retained statement, and only when the deletion really
    // finished — `deleteWorkspace` returns `complete` for exactly this reason.
    const completed = s
      .notificationRows()
      .filter((r) => r['template'] === 'deletion_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.['state']).toBe('sent');
    const email = s.sent.find((m) => m.subject.includes('deletion complete'));
    expect(email?.text).toMatch(/billing and tax records|sign-in identity|nothing of yours/i);
  });

  it('API-415 a second tick after a completed deletion sends nothing more', async () => {
    const s = scene();
    await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });
    s.clock.value = '2026-09-27T09:00:00.000Z';
    await runDueWorkspaceDeletions(s.deps);
    const after = s.sent.length;

    s.clock.value = '2026-09-28T09:00:00.000Z';
    const again = await runDueWorkspaceDeletions(s.deps);

    expect(again).toHaveLength(0);
    expect(s.sent).toHaveLength(after);
  });

  it('API-416 the cancel link stops a scheduled deletion and the tick then does nothing', async () => {
    const s = scene();
    const outcome = await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });
    const token = outcome.cancelUrl.split('/').pop() ?? '';

    const cancelled = await cancelWorkspaceDeletion(s.deps, token);
    expect(cancelled.cancelled).toBe(true);

    s.clock.value = '2026-09-27T09:00:00.000Z';
    expect(await runDueWorkspaceDeletions(s.deps)).toHaveLength(0);
    expect(s.workspaceRow()?.['status']).toBe('active');
  });
});

/* -------------------------------------------------------------------------- */
/* the interpolation constraint                                                */
/* -------------------------------------------------------------------------- */

describe('API-42x what these templates interpolate', () => {
  /**
   * The explicit check. Nothing sent by this path may carry a credential, a card detail, a
   * payment-method id, or another tenant's data. Asserted against the bytes that reached
   * the transport — subject, text and HTML — rather than against the variables we intended
   * to pass, because the defect class this project keeps hitting is a true comment about
   * code nobody calls, and its sibling is a true comment about a value nobody checked.
   */
  const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
    ['a Stripe secret or restricted key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/],
    ['a Stripe webhook signing secret', /\bwhsec_[A-Za-z0-9_-]{8,}/],
    ['a Resend key', /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{8,}/],
    ['a HubSpot token', /\bpat-(?:na|eu)[0-9]?-[0-9a-f]{8}-/],
    ['a bearer token', /\bBearer\s+[A-Za-z0-9._-]{16,}/i],
    ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
    ['a payment-method or card id', /\b(?:pm|card|src|cus|pi|seti)_[A-Za-z0-9]{14,}/],
    ['a card-shaped number', /\b(?:\d[ -]?){13,19}\b/],
    ['an assigned secret literal', /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{12,}/i],
  ];

  it('API-421 no privacy notification body carries a credential, a card detail or a payment-method id', async () => {
    const s = scene();
    await requestWorkspaceExport(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
    });
    await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_priv',
    });
    s.clock.value = '2026-09-27T09:00:00.000Z';
    await runDueWorkspaceDeletions(s.deps);

    expect(
      s.sent.map((m) => m.subject),
      'all three templates must actually have been sent, or this case proves nothing',
    ).toHaveLength(3);

    for (const message of s.sent) {
      const surface = `${message.subject}\n${message.text}\n${message.html}`;
      for (const [what, pattern] of FORBIDDEN) {
        expect(pattern.test(surface), `a message body contains ${what}:\n${surface}`).toBe(false);
      }
    }
  });

  it('API-422 no privacy notification mentions another tenant, and each names only its own workspace', async () => {
    const s = scene({ suffix: 'mine' });
    // A second workspace in the same database, with a name that would be unmistakable if
    // it leaked. Nothing addressed to the first may mention it.
    seedWorkspace(s.h, 'theirs');

    await requestWorkspaceExport(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
    });
    await requestWorkspaceDeletion(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
      requestedBy: 'usr_mine',
    });
    s.clock.value = '2026-09-27T09:00:00.000Z';
    await runDueWorkspaceDeletions(s.deps);

    expect(s.sent.length).toBeGreaterThanOrEqual(3);
    for (const message of s.sent) {
      const surface = `${message.subject}\n${message.text}\n${message.html}`;
      expect(surface, 'another tenant is named').not.toContain('theirs');
      expect(surface, 'another tenant is named').not.toContain('ws_theirs');
      expect(surface).toContain('Workspace mine');
    }
  });

  it('API-423 the export file itself carries no credential, for the workspace the link names', async () => {
    const s = scene();
    const outcome = await requestWorkspaceExport(s.deps, {
      workspaceId: s.workspaceId,
      recipientEmail: CONTACT,
    });
    const built = await redeemExportLink(s.deps, outcome.downloadUrl.split('/').pop() ?? '');
    const body = built.files.map((f) => f.body).join('\n');
    for (const [what, pattern] of FORBIDDEN) {
      // A card-shaped run of digits is a false positive against an ISO instant's digits,
      // so that one rule is checked on the messages only; every credential rule applies here.
      if (what === 'a card-shaped number') continue;
      expect(pattern.test(body), `the export contains ${what}`).toBe(false);
    }
    expect(built.statement).toMatch(/never exported in any form/i);
  });
});
