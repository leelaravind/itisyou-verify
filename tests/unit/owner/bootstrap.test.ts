/**
 * Owner bootstrap.
 *
 * The property: it works once and then it is closed, and the closing is a property of the
 * data rather than of a secret somebody remembered to delete.
 *
 * Fixture note: the bootstrap token is assembled at runtime rather than written as a
 * literal, per the credential-shaped-fixture rule in `docs/agent-brief.md`. The value is
 * identical; it simply does not look like a credential to a scanner or to push protection.
 */
import { describe, expect, it } from 'vitest';
import {
  bootstrapOwner,
  normaliseAuthSubject,
  OWNER_BOOTSTRAP_AUDIT_ACTION,
  type BootstrapDeps,
} from '@app/owner/bootstrap';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const TOKEN = ['owner', 'bootstrap', '00000000-0000-4000-8000-000000000001'].join('-');
const EMAIL = 'founder@example.invalid';

interface Recorded {
  readonly action: string;
  readonly actor: string;
  readonly outcome: string;
  readonly occurredAt: string;
}

function deps(overrides: Partial<BootstrapDeps> = {}): {
  deps: BootstrapDeps;
  audit: Recorded[];
  promoted: string[];
} {
  const audit: Recorded[] = [];
  const promoted: string[] = [];
  let ownerExists = false;
  return {
    audit,
    promoted,
    deps: {
      configuredToken: TOKEN,
      configuredEmail: EMAIL,
      platformOwnerExists: async () => ownerExists,
      promote: async (subject) => {
        promoted.push(subject);
        ownerExists = true;
        return 'usr_owner_1';
      },
      recordAudit: async (entry) => {
        audit.push(entry);
      },
      now: NOW,
      ...overrides,
    },
  };
}

describe('owner bootstrap', () => {
  it('OWNER-130 bootstrap succeeds once with the right token and the proved address', async () => {
    const { deps: d, promoted } = deps();
    const result = await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: EMAIL }, d);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.userId).toBe('usr_owner_1');
    expect(promoted).toEqual([EMAIL]);
  });

  it('OWNER-131 a second bootstrap is refused because an owner now exists', async () => {
    const { deps: d, promoted } = deps();
    await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: EMAIL }, d);
    const second = await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: EMAIL }, d);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.refusal).toBe('already_bootstrapped');
    expect(promoted).toHaveLength(1);
  });

  it('OWNER-132 bootstrap stays closed even with the secret still present', async () => {
    const { deps: d } = deps({ platformOwnerExists: async () => true });
    const result = await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: EMAIL }, d);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('already_bootstrapped');
    expect(result.message).toMatch(/closed permanently/i);
  });

  it('OWNER-133 a wrong token is refused without ever reaching the database', async () => {
    let asked = false;
    const { deps: d } = deps({
      platformOwnerExists: async () => {
        asked = true;
        return false;
      },
    });
    const result = await bootstrapOwner(
      { presentedToken: 'not-the-token', verifiedAuthSubject: EMAIL },
      d,
    );
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('token_mismatch');
    // A guessing loop must not be usable to discover whether an owner exists.
    expect(asked).toBe(false);
  });

  it('OWNER-134 a deployment with no bootstrap secret has no bootstrap path', async () => {
    const { deps: d } = deps({ configuredToken: null });
    const result = await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: EMAIL }, d);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('not_configured');
  });

  it('OWNER-135 a bootstrap token alone is not an identity', async () => {
    const { deps: d, promoted } = deps();
    const result = await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: null }, d);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('unverified_subject');
    expect(promoted).toHaveLength(0);
  });

  it('OWNER-136 the proved address must be the one the deployment authorises', async () => {
    const { deps: d, promoted } = deps();
    const result = await bootstrapOwner(
      { presentedToken: TOKEN, verifiedAuthSubject: 'someone@example.invalid' },
      d,
    );
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('subject_mismatch');
    expect(promoted).toHaveLength(0);
  });

  it('OWNER-137 the address is matched after normalisation', async () => {
    const { deps: d } = deps();
    const result = await bootstrapOwner(
      { presentedToken: TOKEN, verifiedAuthSubject: '  FOUNDER@Example.Invalid ' },
      d,
    );
    expect(result.ok).toBe(true);
    expect(normaliseAuthSubject('  FOUNDER@Example.Invalid ')).toBe(EMAIL);
  });

  it('OWNER-138 every outcome writes an audit row, including every refusal', async () => {
    const { deps: d, audit } = deps();
    await bootstrapOwner({ presentedToken: 'wrong', verifiedAuthSubject: EMAIL }, d);
    await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: null }, d);
    await bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: EMAIL }, d);
    expect(audit.map((a) => a.outcome)).toEqual([
      'token_mismatch',
      'unverified_subject',
      'granted',
    ]);
    for (const entry of audit) {
      expect(entry.action).toBe(OWNER_BOOTSTRAP_AUDIT_ACTION);
      expect(entry.occurredAt).toBe(NOW.toISOString());
    }
  });

  it('OWNER-139 no refusal message ever echoes the token back', async () => {
    const { deps: d } = deps();
    const refusals = await Promise.all([
      bootstrapOwner({ presentedToken: TOKEN, verifiedAuthSubject: null }, d),
      bootstrapOwner({ presentedToken: 'wrong', verifiedAuthSubject: EMAIL }, d),
    ]);
    for (const result of refusals) {
      if (result.ok) throw new Error('unreachable');
      expect(result.message).not.toContain(TOKEN);
    }
  });
});
