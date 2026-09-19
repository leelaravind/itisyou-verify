import { describe, expect, it } from 'vitest';
import {
  createRecoveryCodes,
  createTotpEnrolment,
  generateTotpCode,
  hashRecoveryCode,
  normaliseRecoveryCode,
  totpCounterAt,
  TOTP_PERIOD_SECONDS,
  verifyTotpCode,
} from '@verify/security';

const NOW = Date.UTC(2026, 8, 19, 10, 0, 0);
const enrol = () =>
  createTotpEnrolment({ issuer: 'ITISYOU Verify', accountName: 'owner@example.com' });

describe('TOTP', () => {
  it('API-600 enrolment produces a base32 secret and a provisioning URI, once', () => {
    const e = enrol();
    expect(e.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.provisioningUri).toMatch(/^otpauth:\/\/totp\//);
    expect(e.provisioningUri).toContain('ITISYOU%20Verify');
    expect(e.provisioningUri).toContain(e.secretBase32);
    expect(enrol().secretBase32).not.toBe(e.secretBase32);
  });

  it('API-601 accepts the current code', () => {
    const e = enrol();
    const code = generateTotpCode(e.secretBase32, NOW);
    expect(
      verifyTotpCode({ secretBase32: e.secretBase32, code, now: NOW, lastAcceptedCounter: null }),
    ).toEqual({
      ok: true,
      counter: totpCounterAt(NOW),
    });
  });

  it('API-602 tolerates one step of drift either side, and no more', () => {
    const e = enrol();
    const step = TOTP_PERIOD_SECONDS * 1000;
    const code = generateTotpCode(e.secretBase32, NOW);
    for (const at of [NOW - step, NOW, NOW + step]) {
      expect(
        verifyTotpCode({ secretBase32: e.secretBase32, code, now: at, lastAcceptedCounter: null })
          .ok,
        String(at),
      ).toBe(true);
    }
    for (const at of [NOW - step * 2, NOW + step * 2]) {
      expect(
        verifyTotpCode({ secretBase32: e.secretBase32, code, now: at, lastAcceptedCounter: null }),
        String(at),
      ).toEqual({ ok: false, refusal: 'mismatch' });
    }
  });

  it('API-603 refuses a replay of an arithmetically perfect code', () => {
    const e = enrol();
    const code = generateTotpCode(e.secretBase32, NOW);
    const first = verifyTotpCode({
      secretBase32: e.secretBase32,
      code,
      now: NOW,
      lastAcceptedCounter: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Same code, same second, from another browser. The maths still says yes.
    expect(
      verifyTotpCode({
        secretBase32: e.secretBase32,
        code,
        now: NOW,
        lastAcceptedCounter: first.counter,
      }),
    ).toEqual({ ok: false, refusal: 'replayed' });
  });

  it('API-604 refuses an earlier counter still inside the drift window', () => {
    const e = enrol();
    const step = TOTP_PERIOD_SECONDS * 1000;
    const previous = generateTotpCode(e.secretBase32, NOW - step);
    const current = totpCounterAt(NOW);
    // The previous step's code verifies arithmetically at `now`, but it is not newer.
    expect(
      verifyTotpCode({
        secretBase32: e.secretBase32,
        code: previous,
        now: NOW,
        lastAcceptedCounter: current,
      }),
    ).toEqual({ ok: false, refusal: 'replayed' });
  });

  it('API-605 accepts the next step after one was consumed', () => {
    const e = enrol();
    const step = TOTP_PERIOD_SECONDS * 1000;
    const consumed = totpCounterAt(NOW);
    const next = generateTotpCode(e.secretBase32, NOW + step);
    const check = verifyTotpCode({
      secretBase32: e.secretBase32,
      code: next,
      now: NOW + step,
      lastAcceptedCounter: consumed,
    });
    expect(check).toEqual({ ok: true, counter: consumed + 1 });
  });

  it('API-606 refuses a malformed code before doing any arithmetic', () => {
    const e = enrol();
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ']) {
      expect(
        verifyTotpCode({ secretBase32: e.secretBase32, code, now: NOW, lastAcceptedCounter: null }),
        code,
      ).toEqual({ ok: false, refusal: 'malformed' });
    }
  });

  it('API-607 refuses a code from a different secret', () => {
    const a = enrol();
    const b = enrol();
    const code = generateTotpCode(b.secretBase32, NOW);
    expect(
      verifyTotpCode({ secretBase32: a.secretBase32, code, now: NOW, lastAcceptedCounter: null }),
    ).toEqual({ ok: false, refusal: 'mismatch' });
  });

  it('API-608 reports a mismatch rather than throwing on an unparseable stored secret', () => {
    expect(
      verifyTotpCode({
        secretBase32: 'not-base32!!',
        code: '123456',
        now: NOW,
        lastAcceptedCounter: null,
      }),
    ).toEqual({ ok: false, refusal: 'mismatch' });
  });
});

describe('recovery codes', () => {
  it('API-610 mints distinct, high-entropy, human-typeable codes with matching hashes', async () => {
    const set = await createRecoveryCodes(10);
    expect(set.codes).toHaveLength(10);
    expect(set.hashes).toHaveLength(10);
    expect(new Set(set.codes).size).toBe(10);
    expect(new Set(set.hashes).size).toBe(10);
    for (const code of set.codes) expect(code).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    for (const hash of set.hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < set.codes.length; i += 1) {
      expect(await hashRecoveryCode(set.codes[i] as string)).toBe(set.hashes[i]);
    }
  });

  it('API-611 the hash is one-way: no code appears in its own hash', async () => {
    const set = await createRecoveryCodes(3);
    for (let i = 0; i < 3; i += 1) {
      const code = set.codes[i] as string;
      expect(set.hashes[i]).not.toContain(normaliseRecoveryCode(code));
      expect(set.hashes[i]).not.toContain(code);
    }
  });

  it('API-612 forgives case, spaces and hyphens when the owner types it back', async () => {
    const set = await createRecoveryCodes(1);
    const code = set.codes[0] as string;
    const typed = code.toLowerCase().replace(/-/g, ' ');
    expect(await hashRecoveryCode(typed)).toBe(set.hashes[0]);
    expect(normaliseRecoveryCode('ab cd-EF')).toBe('ABCDEF');
  });

  it('API-613 is domain-separated from session and login token hashes', async () => {
    const { hashToken } = await import('@verify/security');
    const code = 'ABCDE-FGHIJ-KLMNO-PQRST';
    expect(await hashRecoveryCode(code)).not.toBe(await hashToken(code, 'session'));
    expect(await hashRecoveryCode(code)).not.toBe(await hashToken(code, 'login'));
  });
});
