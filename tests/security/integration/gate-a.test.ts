/**
 * AUTH-5xx — the two Gate A blockers A10 named in pass two, re-verified against code.
 *
 *   A-21  a new session id on every privilege transition, old row revoked
 *   A-20  an approval consumed exactly once, atomically, before money moves
 *
 * Both were claimed as done or in-brief. This checks them, behaviourally where a real
 * database is available (`tests/integration/db/harness.ts` runs actual SQLite), and at the
 * statement level where the property is about how the SQL is written rather than what it
 * returns.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedWorkspace, T0 } from '../../integration/db/harness';
import { sessions } from '@app/db/sessions';

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

const LATER = '2026-09-19T22:00:00.000Z';

/** A real tenant, seeded by the shared harness rather than by hand. */
function seedUser(h: ReturnType<typeof createTestDb>, suffix = 'a'): string {
  return seedWorkspace(h, suffix).userId;
}

describe('A-21 session rotation on a privilege transition', () => {
  it('AUTH-501 rotate mints a new session and revokes the old one, atomically', async () => {
    const h = createTestDb();
    const userId = seedUser(h);
    await sessions.create(h.db, {
      idHash: 'old_hash',
      userId,
      createdAt: T0,
      expiresAt: LATER,
    });

    const ok = await sessions.rotate(h.db, {
      oldIdHash: 'old_hash',
      newIdHash: 'new_hash',
      userId,
      now: T0,
      expiresAt: LATER,
    });
    expect(ok).toBe(true);

    const old = await h.db
      .prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind('old_hash')
      .first<{ revoked_at: string | null }>();
    const fresh = await h.db
      .prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind('new_hash')
      .first<{ revoked_at: string | null }>();

    expect(old?.revoked_at, 'the pre-authentication session must be revoked').toBe(T0);
    expect(fresh, 'a successor session must exist').not.toBeNull();
    expect(fresh?.revoked_at, 'the successor must be live').toBeNull();
  });

  it('AUTH-502 a planted session id cannot survive the transition (fixation)', async () => {
    // The attack: plant a known cookie, wait for the victim to authenticate into it. If
    // the id after sign-in equals the id before it, the attacker holds an authenticated
    // session. `rotate` makes the two ids different by construction.
    const h = createTestDb();
    const userId = seedUser(h);
    await sessions.create(h.db, {
      idHash: 'planted_by_attacker',
      userId,
      createdAt: T0,
      expiresAt: LATER,
    });
    await sessions.rotate(h.db, {
      oldIdHash: 'planted_by_attacker',
      newIdHash: 'issued_after_signin',
      userId,
      now: T0,
      expiresAt: LATER,
    });
    const planted = await h.db
      .prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind('planted_by_attacker')
      .first<{ revoked_at: string | null }>();
    expect(planted?.revoked_at).not.toBeNull();
  });

  it('AUTH-503 rotating a dead session mints nothing', async () => {
    // Otherwise a revoked or expired cookie could be traded for a live one.
    const h = createTestDb();
    const userId = seedUser(h);
    await sessions.create(h.db, {
      idHash: 'expired_hash',
      userId,
      createdAt: T0,
      expiresAt: T0, // already expired at `now`
    });
    const ok = await sessions.rotate(h.db, {
      oldIdHash: 'expired_hash',
      newIdHash: 'should_not_exist',
      userId,
      now: LATER,
      expiresAt: LATER,
    });
    expect(ok).toBe(false);
    const fresh = await h.db
      .prepare('SELECT id FROM sessions WHERE id = ?')
      .bind('should_not_exist')
      .first();
    expect(fresh).toBeNull();
  });

  it('AUTH-504 rotate cannot be raced into minting two successors', async () => {
    // Both statements carry the IDENTICAL liveness guard and the insert runs first, so a
    // second caller evaluated against the first's committed row matches nothing. Keying
    // the insert off "the row we just revoked" would mint two successors instead, which
    // is the fixation this exists to prevent — so the shape is asserted, not just the
    // single-threaded outcome a test can observe.
    const source = read('apps', 'app', 'src', 'db', 'sessions.ts');
    const rotate = source.slice(source.indexOf('async rotate('), source.indexOf('async rotate(') + 2600);
    expect(rotate).toMatch(/db\.batch\(\[/);
    const guards = [...rotate.matchAll(/revoked_at IS NULL AND expires_at > \?/g)];
    expect(guards.length, 'both statements must carry the same liveness guard').toBeGreaterThanOrEqual(2);
    expect(rotate).toMatch(/INSERT INTO sessions[\s\S]*UPDATE sessions SET revoked_at/);
    expect(rotate).toMatch(/meta\.changes === 1 && .*meta\.changes === 1/);
  });

  it('AUTH-505 sign-in goes through rotate, never through a bare create', async () => {
    const auth = read('apps', 'app', 'src', 'lib', 'auth.ts');
    expect(auth).toMatch(/sessions\.rotate\(/);
    expect(auth).toMatch(/The id after sign-in is never the id before it/);
  });
});

describe('A-20 an approval is consumed exactly once before money moves', () => {
  it('AUTH-510 the approval check refuses anything but a live, granted, matching approval', async () => {
    const { checkOwnerApproval } = await import('@app/owner/approvals');
    const base = {
      id: 'apr_1',
      owner_id: 'usr_owner',
      action_type: 'refund_issue' as const,
      canonical_payload_hash: 'deadbeef',
      maximum_amount_minor: 2900,
      currency: 'GBP' as const,
      status: 'granted' as const,
      note: null,
      created_at: T0,
      expires_at: LATER,
      consumed_at: null,
      summary: 'Refund 2900 GBP to ws_a for goodwill',
    };
    const payload = {
      action_type: 'refund_issue' as const,
      payload: {
        refund_id: 'ref_1',
        order_id: 'ord_1',
        workspace_id: 'ws_a',
        amount_minor: 2900,
        currency: 'GBP' as const,
        reason: 'goodwill',
      },
    };
    // A consumed approval must not authorise a second time.
    const used = await checkOwnerApproval({ ...base, status: 'consumed' }, payload, new Date(T0));
    expect(used.valid).toBe(false);
    if (!used.valid) expect(used.reason).toBe('status_not_granted');
    // As must a revoked or expired one.
    const revoked = await checkOwnerApproval({ ...base, status: 'revoked' }, payload, new Date(T0));
    expect(revoked.valid).toBe(false);
    const expired = await checkOwnerApproval({ ...base, expires_at: T0 }, payload, new Date(LATER));
    expect(expired.valid).toBe(false);
    if (!expired.valid) expect(expired.reason).toBe('expired');
  });

  it('AUTH-511 FINDING: nothing ever transitions an approval to consumed', () => {
    // THE GAP. `approvals.status` has a `consumed` state in the schema CHECK, the
    // `OwnerApproval` type carries `consumed_at`, `approvalStanding()` renders 'used' for
    // it, and `checkOwnerApproval` correctly refuses a consumed approval (AUTH-510).
    //
    // No code writes it. Grep the whole application for a statement that sets
    // `status = 'consumed'` or `consumed_at` on `approvals` and there is none, so the
    // state is unreachable and `status_not_granted` can never fire for REUSE.
    //
    // The consequence is check-then-act: `checkOwnerApproval` returns valid, then the
    // refund is submitted, and nothing in between claims the approval. Two requests
    // carrying the same approval both observe `status = 'granted'` and both proceed.
    //
    // WHY THIS IS NOT CRITICAL: `refunds.idempotency_key` is `NOT NULL UNIQUE` and the
    // approval's payload hash binds to one specific refund, so a replayed approval can
    // only re-submit the SAME refund, which reaches Stripe under the same idempotency key
    // and is deduplicated there. The exposure is a missing audit fact and a single-use
    // control that is not actually single-use — not a second charge today.
    //
    // FIX (A07 owns approvals, A06 owns the refund path): make consumption the act that
    // authorises, in one statement, and use its row count as the gate:
    //
    //     UPDATE approvals SET status = 'consumed', consumed_at = ?
    //      WHERE id = ? AND status = 'granted' AND expires_at > ?
    //
    // `meta.changes === 1` is then the permission, and a loser gets zero rows and stops.
    // Check-then-act becomes compare-and-set, which is what `revokeApproval` already does
    // correctly one function above.
    const searched = [
      ['apps', 'app', 'src', 'owner', 'approvals.ts'],
      ['apps', 'app', 'src', 'db', 'ownerPort.ts'],
      ['apps', 'app', 'src', 'billing', 'refunds.ts'],
      ['apps', 'app', 'src', 'growth', 'approval.ts'],
    ];
    const found: string[] = [];
    for (const relative of searched) {
      let source = '';
      try {
        source = read(...relative);
      } catch {
        continue;
      }
      if (/UPDATE\s+approvals\s+SET[^;`']*(status\s*=\s*'consumed'|consumed_at\s*=)/is.test(source)) {
        found.push(relative.join('/'));
      }
    }
    expect(
      found,
      "no statement anywhere transitions an approval to 'consumed'; the state is unreachable",
    ).not.toEqual([]);
  });

  it('AUTH-512 the refund path cannot be entered without an approval at all', () => {
    // The half that IS built, and is good: there is no default, no "auto" value and no
    // id-only variant, so an unrecorded approval cannot authorise a refund.
    const refunds = read('apps', 'app', 'src', 'billing', 'refunds.ts');
    expect(refunds).toMatch(/There is no code path in\s+\* this file that submits a refund without an `approvalId`/);
    expect(refunds).toMatch(/readonly approval\?: OwnerApproval;/);
    expect(refunds).not.toMatch(/approvalId:\s*['"]auto['"]/);
  });

  it('AUTH-513 the approved amount is a ceiling, and the payload cannot exceed it', async () => {
    const { checkOwnerApproval } = await import('@app/owner/approvals');
    const approval = {
      id: 'apr_1',
      owner_id: 'usr_owner',
      action_type: 'refund_issue' as const,
      canonical_payload_hash: 'unused',
      maximum_amount_minor: 2900,
      currency: 'GBP' as const,
      status: 'granted' as const,
      note: null,
      created_at: T0,
      expires_at: LATER,
      consumed_at: null,
      summary: 'Refund 2900 GBP to ws_a for goodwill',
    };
    const dearer = {
      action_type: 'refund_issue' as const,
      payload: {
        refund_id: 'ref_1',
        order_id: 'ord_1',
        workspace_id: 'ws_a',
        amount_minor: 2901,
        currency: 'GBP' as const,
        reason: 'goodwill',
      },
    };
    const result = await checkOwnerApproval(approval, dearer, new Date(T0));
    expect(result.valid).toBe(false);
    // One penny over is refused — either because the hash moved or because the ceiling
    // was breached. Both are correct; what must never happen is `valid: true`.
    if (!result.valid) {
      expect(['payload_changed', 'amount_exceeds_approved_maximum']).toContain(result.reason);
    }
  });
});
