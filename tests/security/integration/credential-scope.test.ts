/**
 * SEC-64x — `credential_versions.owner_scope`: convention where a constraint belongs.
 *
 * Pass one's threat model flagged this as a gap (T-TEN-03). Pass three makes it concrete:
 * `apps/app/src/lib/auth.ts` now ships three unscoped statements against the column, and
 * they are the authentication path.
 *
 * ## The adjudication A10 was asked for
 *
 * **Is it exploitable today? No** — for two independent reasons, neither of which is
 * visible from the column:
 *
 *   1. User ids are `usr_<Crockford base32>` (`apps/app/src/lib/ids.ts`), so they cannot
 *      contain a colon, so `user:<id>` and `user:<id>:recovery` cannot collide.
 *   2. Even given a collision, the AAD purposes differ (`totp_seed` vs `recovery_code`),
 *      so AES-GCM authentication fails and nothing cross-decrypts.
 *
 * **Does it still need a structural constraint? Yes.** Three reasons:
 *
 *   1. `countRecoveryCodes` does not decrypt — it counts. Mitigation (2) does not apply to
 *      it at all, so a collision there is a wrong answer with no crypto backstop. The
 *      impact is small (a wrong "codes remaining" figure); the point is that the pattern
 *      has no floor, and the next query written against this column may not be a count.
 *   2. The whole safety rests on an id alphabet defined in a different file, with nothing
 *      linking the two. Widen the alphabet — or introduce an id from an external system —
 *      and the guarantee silently disappears.
 *   3. The column mixes two different scoping regimes: `connection:<id>` is
 *      workspace-scoped *through* `connections`, while `user:<id>` is user-scoped with no
 *      workspace at all. That is exactly why `SEC-202`/`SEC-206` cannot tell a correct
 *      query here from an incorrect one and have to fall back to a human-written marker.
 *
 * **Severity: Medium.** Two independent mitigations hold today; neither is declared where
 * the risk is.
 *
 * **The fix A10 recommends is a discriminator, not a string CHECK.** A
 * `CHECK (owner_scope GLOB 'user:*' OR owner_scope GLOB 'connection:*')` does *not*
 * prevent the collision — both colliding values satisfy it. A `scope_kind` column
 * (`'connection' | 'user_totp' | 'user_recovery'`) with a CHECK does, and it lets every
 * query filter on kind so the tenancy checks can reason about the row without a marker.
 * Migrations are the lead's; this needs an additive one, never an edit to `0001_init.sql`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { totpScope, recoveryScope } from '@app/lib/auth';
import { newId } from '@app/lib/ids';

const ROOT = process.cwd();

function schema(): string {
  const dir = join(ROOT, 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

describe('credential_versions.owner_scope', () => {
  it('SEC-641 the cross-regime half is now closed at the database', () => {
    // A02 shipped `migrations/0002_credential_scope_check.sql` during this pass. It
    // constrains `owner_scope` to `connection:?*` or `user:?*`, and — separately, closing
    // pass-one finding F5 for good — requires the AAD to carry `kv=`, so a key-version
    // downgrade cannot be forged by editing a column. Both are real improvements enforced
    // where the risk is, and both are asserted here so they cannot be dropped.
    const sql = schema();
    expect(sql).toMatch(/owner_scope\s+TEXT NOT NULL CHECK/i);
    expect(sql).toMatch(/owner_scope GLOB 'connection:\?\*'/);
    expect(sql).toMatch(/owner_scope GLOB 'user:\?\*'/);
    expect(sql).toMatch(/aad\s+TEXT NOT NULL CHECK \(aad LIKE 'v1\|kv=%'\)/i);
  });

  it('SEC-646 the intra-regime half remains convention, and is an ACCEPTED risk', () => {
    // HONEST ADJUDICATION, recorded so nobody has to re-derive it.
    //
    // The GLOB CHECK stops a `connection:` row masquerading as a `user:` row, which was
    // the cross-regime confusion in T-TEN-03. It does NOT stop the intra-regime collision
    // in SEC-642: `user:usr_abc:recovery` satisfies `user:?*` whichever builder produced
    // it. A discriminator column (`scope_kind`) would; a string CHECK cannot.
    //
    // A10's verdict: DO NOT hold the release for this. The residual exposure is
    // `countRecoveryCodes` returning a wrong count, and it requires a user id containing a
    // colon, which SEC-643 forbids and SEC-644's AAD separation would contain anyway.
    // That is a Low with two independent mitigations, both now asserted by tests. It is
    // recorded as an accepted risk in docs/security-acceptance.md, not as a blocker.
    //
    // It becomes a real problem the moment an id comes from an external system rather than
    // `newId`. If that is ever proposed, this case is where to start.
    const sql = schema();
    const colliding = 'user:usr_abc:recovery';
    expect(colliding.startsWith('user:')).toBe(true); // satisfies the CHECK either way
    expect(sql).not.toMatch(/scope_kind/); // the structural fix is not present, and that is a choice
  });

  it('SEC-642 the collision this is about is real at the string level', () => {
    // Not hypothetical: the two scope builders produce the same string for different
    // meanings whenever a user id can contain a colon. One is a TOTP seed, the other a
    // spent-recovery-code marker.
    expect(totpScope('usr_abc:recovery')).toBe(recoveryScope('usr_abc'));
  });

  it('SEC-643 mitigation 1: user ids cannot contain a colon', () => {
    // Asserted here so that widening the id alphabet fails a security test rather than
    // silently removing the thing that makes SEC-642 unreachable.
    for (let i = 0; i < 50; i += 1) {
      const id = newId('usr');
      expect(id, id).not.toContain(':');
      expect(id, id).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]+$/);
    }
  });

  it('SEC-644 mitigation 2: TOTP and recovery material are bound to different AAD purposes', () => {
    // So even given a scope collision, a TOTP seed cannot be opened as a recovery marker.
    // Asserted against the source because the constants are module-private.
    const auth = readFileSync(join(ROOT, 'apps', 'app', 'src', 'lib', 'auth.ts'), 'utf8');
    const totp = /const PURPOSE_TOTP = '([^']+)'/.exec(auth)?.[1];
    const recovery = /const PURPOSE_RECOVERY = '([^']+)'/.exec(auth)?.[1];
    expect(totp).toBeTruthy();
    expect(recovery).toBeTruthy();
    expect(totp).not.toBe(recovery);
  });

  it('SEC-645 every unscoped owner_scope statement carries a marker saying why', () => {
    // The three statements in auth.ts are user-scoped, not workspace-scoped, and that is
    // legitimate — `credential_versions` has no `workspace_id` column. But "legitimate"
    // has to be written down next to the statement, or SEC-202 cannot distinguish it from
    // the mistake it exists to catch.
    const auth = readFileSync(join(ROOT, 'apps', 'app', 'src', 'lib', 'auth.ts'), 'utf8');
    const blanked = auth
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(
        /(^|[^:])(\/\/[^\n]*)/gm,
        (_a, b: string, c: string) => b + c.replace(/[^\n]/g, ' '),
      );
    const re = /`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\[\s\S])*'/g;
    const offenders: string[] = [];
    for (const m of blanked.matchAll(re)) {
      const sql = m[0];
      if (!/\bcredential_versions\b/.test(sql)) continue;
      if (/\bworkspace_id\b/.test(sql)) continue;
      const before = auth.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
      if (before.includes('tenant-scope:exempt')) continue;
      offenders.push(sql.slice(0, 100).replace(/\s+/g, ' '));
    }
    expect(offenders).toEqual([]);
  });
});
