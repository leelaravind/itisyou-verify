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
import {
  createD1ReleaseApprovalAuthority,
  enqueueJob,
  type ReleaseApprovalAuthority,
} from '@app/maintenance/index';
import type { ApprovalClaimStore } from '@app/owner/approvals';
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
    { id: string; action_type: string; status: string; consumed_at: string | null } | undefined;
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

  it('OWNER-229 a covering approval is spent through the single compare-and-set BEFORE the job row is written, and a double-submit queues exactly one job', async () => {
    seedApproval(h, { id: 'apr_release', action_type: 'cleanup_execute' });

    // No owner action type covers a release yet (the lead has not ruled on one), so the
    // production `covers` refuses everything — OWNER-228 proves that. To test the spend
    // itself, this authority stands in for the missing type on one named approval only,
    // keeps the REAL loader and the REAL `CLAIM_APPROVAL_SQL` store, and records how many
    // job rows existed at the instant the approval was claimed.
    const real = createD1ReleaseApprovalAuthority(h.db);
    const jobsAtClaim: number[] = [];
    const observedClaims: ApprovalClaimStore = {
      claim: async (p) => {
        jobsAtClaim.push(jobRows(h).length);
        return real.claims.claim(p);
      },
    };
    const authority: ReleaseApprovalAuthority = {
      load: real.load,
      covers: async (approval, payload) =>
        approval.id === 'apr_release' ? { covers: true } : real.covers(approval, payload),
      claims: observedClaims,
    };

    const first = await enqueueJob({
      db: h.db,
      kind: 'execute_approved_release',
      payload: { environment: 'production', approval_id: 'apr_release' },
      requestedBy: 'usr_owner',
      now: NOW,
      approvalId: 'apr_release',
      approvals: authority,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`refused: ${JSON.stringify(first.refusal)}`);
    expect(first.approvalConsumedAt).toBe(NOW);
    expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    // Ordering: the claim ran while the job table was empty.
    expect(jobsAtClaim).toEqual([0]);

    // The database, read directly: one job bound to the approval; the approval consumed
    // once, at the enqueue time; one enqueue audit event naming both.
    const jobs = jobRows(h);
    const approval = approvalRow(h, 'apr_release');
    const audit = enqueueAudit(h);
    console.info('[OWNER-229 after first submit] maintenance_jobs =', JSON.stringify(jobs));
    console.info('[OWNER-229 after first submit] approvals row   =', JSON.stringify(approval));
    console.info('[OWNER-229 after first submit] audit           =', JSON.stringify(audit));
    expect(jobs).toEqual([
      {
        id: first.jobId,
        typed_kind: 'execute_approved_release',
        approval_id: 'apr_release',
        state: 'queued',
      },
    ]);
    expect(approval).toEqual({
      id: 'apr_release',
      action_type: 'cleanup_execute',
      status: 'consumed',
      consumed_at: NOW,
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.redacted_metadata)).toMatchObject({
      typed_kind: 'execute_approved_release',
      approval_id: 'apr_release',
      approval_consumed_at: NOW,
    });
    // The stored payload is the validated object, not the caller's JSON text.
    expect(
      JSON.parse(
        (
          h.raw
            .prepare('SELECT payload_json FROM maintenance_jobs WHERE id = ?')
            .get(first.jobId) as {
            payload_json: string;
          }
        ).payload_json,
      ),
    ).toEqual({
      kind: 'execute_approved_release',
      environment: 'production',
      approval_id: 'apr_release',
    });

    // The double-submit: same approval, same payload, a moment later. The gate sees the
    // row is consumed and refuses before the compare-and-set is even attempted.
    const second = await enqueueJob({
      db: h.db,
      kind: 'execute_approved_release',
      payload: { environment: 'production', approval_id: 'apr_release' },
      requestedBy: 'usr_owner',
      now: '2026-09-19T12:00:01.000Z',
      approvalId: 'apr_release',
      approvals: authority,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('a consumed approval queued a second release');
    expect(second.refusal.code).toBe('APPROVAL_INVALID');
    if (second.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(second.refusal.reason).toBe('already_consumed');
    expect(jobsAtClaim).toEqual([0]); // no second claim attempt
    expect(jobRows(h)).toHaveLength(1);
    expect(enqueueAudit(h)).toHaveLength(1);
    expect(approvalRow(h, 'apr_release')?.consumed_at).toBe(NOW); // the original timestamp stands

    // The race the compare-and-set exists for: a caller that passed the gate against a
    // still-granted row, but whose claim runs after another caller's claim has committed.
    seedApproval(h, { id: 'apr_race', action_type: 'cleanup_execute' });
    const raced: ReleaseApprovalAuthority = {
      load: real.load,
      covers: async () => ({ covers: true }),
      claims: {
        claim: async (p) => {
          // Another request wins the row between this request's check and its claim.
          await real.claims.claim(p);
          return real.claims.claim(p);
        },
      },
    };
    const loser = await enqueueJob({
      db: h.db,
      kind: 'execute_approved_release',
      payload: { environment: 'staging', approval_id: 'apr_race' },
      requestedBy: 'usr_owner',
      now: NOW,
      approvalId: 'apr_race',
      approvals: raced,
    });
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error('the loser of the compare-and-set queued a job');
    expect(loser.refusal.code).toBe('APPROVAL_INVALID');
    if (loser.refusal.code !== 'APPROVAL_INVALID') throw new Error('unreachable');
    expect(loser.refusal.reason).toBe('already_consumed');
    expect(jobRows(h)).toHaveLength(1); // still only the first job
    expect(approvalRow(h, 'apr_race')?.status).toBe('consumed');
  });
});
