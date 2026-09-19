/**
 * `execute_approved_release` and the approval that must authorise it — against a real
 * database.
 *
 * The hole these cases close: `enqueueJob` used to gate approval-required kinds with
 * `(params.approvalId ?? null) === null`, which checks that *a string was supplied* and
 * nothing else. A fabricated id, an expired id and an already-consumed id all passed, and
 * the approval was never spent. It was unreachable only because the kind is not in the
 * owner panel's dispatchable set — one enum entry away from a route that lets a made-up
 * string authorise replacing the code every customer is served.
 *
 * Every refusal below is asserted two ways: the returned refusal, and the database — no
 * `maintenance_jobs` row, no `maintenance.job.enqueued` audit event, and the approval row
 * left exactly as it was. A refusal that spends the approval would be a second defect.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueJob } from '@app/maintenance/index';
import { createTestDb, type TestDb } from '../db/harness';

const NOW = '2026-09-19T12:00:00.000Z';
const TOMORROW = '2026-09-20T12:00:00.000Z';
const YESTERDAY = '2026-09-18T12:00:00.000Z';

function seedOwner(h: TestDb): void {
  h.raw
    .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
    .run('usr_owner', 'owner@example.com', NOW);
}

/**
 * An approval row written the way `D1OwnerDataPort.grantApproval` writes one. The action
 * type defaults to `cleanup_execute` because that is the exact shape of the live restore
 * defect: a real, granted, unexpired approval for something else entirely.
 */
function seedApproval(
  h: TestDb,
  row: {
    readonly id: string;
    readonly action_type?: string;
    readonly status?: 'granted' | 'consumed' | 'expired' | 'revoked';
    readonly expires_at?: string;
    readonly consumed_at?: string | null;
  },
): void {
  h.raw
    .prepare(
      `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency,
                              status, note, created_at, expires_at, consumed_at)
       VALUES (?, 'usr_owner', ?, ?, NULL, NULL, ?, 'test approval', ?, ?, ?)`,
    )
    .run(
      row.id,
      row.action_type ?? 'cleanup_execute',
      'a'.repeat(64),
      row.status ?? 'granted',
      YESTERDAY,
      row.expires_at ?? TOMORROW,
      row.consumed_at ?? null,
    );
}

function approvalRow(h: TestDb, id: string) {
  return h.raw
    .prepare('SELECT id, action_type, status, consumed_at FROM approvals WHERE id = ?')
    .get(id) as
    | { id: string; action_type: string; status: string; consumed_at: string | null }
    | undefined;
}

function jobRows(h: TestDb) {
  return h.raw
    .prepare('SELECT id, typed_kind, approval_id, state FROM maintenance_jobs ORDER BY created_at')
    .all() as { id: string; typed_kind: string; approval_id: string | null; state: string }[];
}

function enqueueAudit(h: TestDb) {
  return h.raw
    .prepare(
      "SELECT target, redacted_metadata FROM audit_events WHERE action = 'maintenance.job.enqueued'",
    )
    .all() as { target: string; redacted_metadata: string }[];
}

async function attemptRelease(h: TestDb, approvalId: string, supplied: string | null = approvalId) {
  return enqueueJob({
    db: h.db,
    kind: 'execute_approved_release',
    payload: { environment: 'production', approval_id: approvalId },
    requestedBy: 'usr_owner',
    now: NOW,
    approvalId: supplied,
  });
}

/** The refusal shape every case asserts: refused, and the database untouched. */
function expectNothingQueued(h: TestDb): void {
  expect(jobRows(h)).toEqual([]);
  expect(enqueueAudit(h)).toEqual([]);
}

describe('execute_approved_release — the approval is loaded, checked and spent, not merely named', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
    seedOwner(h);
  });

  afterEach(() => {
    h.close();
  });

  it('OWNER-225 a fabricated approval id is refused and writes no job row', async () => {
    const outcome = await attemptRelease(h, 'apr_does_not_exist');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('a made-up approval id queued a release');
    expect(outcome.refusal.code).toBe('APPROVAL_INVALID');
    if (outcome.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(outcome.refusal.reason).toBe('not_found');
    expectNothingQueued(h);
  });

  it('OWNER-226 an expired approval is refused, writes no job row, and is not spent', async () => {
    seedApproval(h, { id: 'apr_expired', expires_at: YESTERDAY });

    const outcome = await attemptRelease(h, 'apr_expired');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('an expired approval queued a release');
    expect(outcome.refusal.code).toBe('APPROVAL_INVALID');
    if (outcome.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(outcome.refusal.reason).toBe('expired');
    expectNothingQueued(h);
    // The row is exactly as seeded: a refusal must not stamp `consumed_at` on it.
    expect(approvalRow(h, 'apr_expired')).toEqual({
      id: 'apr_expired',
      action_type: 'cleanup_execute',
      status: 'granted',
      consumed_at: null,
    });
  });

  it('OWNER-227 an already-consumed approval — and a revoked one — is refused with no job row', async () => {
    seedApproval(h, { id: 'apr_spent', status: 'consumed', consumed_at: YESTERDAY });
    seedApproval(h, { id: 'apr_withdrawn', status: 'revoked' });

    const spent = await attemptRelease(h, 'apr_spent');
    expect(spent.ok).toBe(false);
    if (spent.ok) throw new Error('a consumed approval queued a release');
    expect(spent.refusal.code).toBe('APPROVAL_INVALID');
    if (spent.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(spent.refusal.reason).toBe('already_consumed');

    const withdrawn = await attemptRelease(h, 'apr_withdrawn');
    expect(withdrawn.ok).toBe(false);
    if (withdrawn.ok) throw new Error('a revoked approval queued a release');
    expect(withdrawn.refusal.code).toBe('APPROVAL_INVALID');
    if (withdrawn.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(withdrawn.refusal.reason).toBe('withdrawn');

    expectNothingQueued(h);
    // Neither row moved: the consumed one keeps its original timestamp.
    expect(approvalRow(h, 'apr_spent')?.consumed_at).toBe(YESTERDAY);
    expect(approvalRow(h, 'apr_withdrawn')?.status).toBe('revoked');
  });

  it('OWNER-228 a granted, unexpired approval for a different action does not authorise a release, and is not spent by the refusal', async () => {
    // This is the exact shape of the restore defect found live today: a real cleanup
    // approval offered as authorisation to change what customers are served.
    seedApproval(h, { id: 'apr_cleanup', action_type: 'cleanup_execute' });

    const outcome = await attemptRelease(h, 'apr_cleanup');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('a cleanup approval queued a release');
    expect(outcome.refusal.code).toBe('APPROVAL_INVALID');
    if (outcome.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(outcome.refusal.reason).toBe('action_type_mismatch');
    // The detail must tell the owner the truth: no approval type covers a release yet.
    expect(outcome.refusal.detail).toMatch(/cleanup_execute/);
    expect(outcome.refusal.detail).toMatch(/action type/i);
    expectNothingQueued(h);
    // Refused before consumption: the owner's approval is still there for what it was for.
    expect(approvalRow(h, 'apr_cleanup')).toEqual({
      id: 'apr_cleanup',
      action_type: 'cleanup_execute',
      status: 'granted',
      consumed_at: null,
    });

    // The id supplied by the caller must be the id the payload names. A payload that says
    // one approval while the caller binds another is two authorisations for one job.
    seedApproval(h, { id: 'apr_other' });
    const mismatch = await attemptRelease(h, 'apr_cleanup', 'apr_other');
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('unreachable');
    expect(mismatch.refusal.code).toBe('APPROVAL_MISMATCH');
    expectNothingQueued(h);
    expect(approvalRow(h, 'apr_other')?.status).toBe('granted');
  });
});
