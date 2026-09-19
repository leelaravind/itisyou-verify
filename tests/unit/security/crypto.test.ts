/**
 * Credential envelope tests.
 *
 * The property that matters: a ciphertext is worthless outside the exact context it was
 * sealed for. Every case below moves one thing — the workspace, the provider, the
 * purpose, the key, a single byte — and requires the open to fail.
 */
import { describe, expect, it } from 'vitest';
import {
  bindKeyVersion,
  buildAad,
  fromBase64,
  openCredential,
  openCredentialFor,
  randomBytes,
  sealCredential,
  sealCredentialFor,
  toBase64,
} from '@verify/security';
import { AppError } from '@verify/contracts';

// Generated per run and never written anywhere. Nothing in the repository is wrapped
// with these; they exist only for the duration of the process.
// secret-scan:allow
const KEY_A = toBase64(randomBytes(32));
// secret-scan:allow
const KEY_B = toBase64(randomBytes(32));

const CONTEXT = { workspaceId: 'ws_alpha', provider: 'hubspot', purpose: 'api_token' };
const AAD = buildAad(CONTEXT);

const seal = (plaintext: string, aad = AAD, keyBase64 = KEY_A) =>
  sealCredential(plaintext, { keyBase64, keyVersion: 1, aad });

describe('credential envelopes', () => {
  it('API-001 seals and opens a credential round trip', async () => {
    const envelope = await seal('hubspot-pat-secret-value');
    expect(envelope.key_version).toBe(1);
    expect(envelope.aad).toBe(bindKeyVersion(AAD, 1));
    expect(await openCredential(envelope, { keyBase64: KEY_A, expectedAad: AAD })).toBe(
      'hubspot-pat-secret-value',
    );
  });

  it('API-002 never stores the plaintext in the envelope', async () => {
    const envelope = await seal('a-very-distinctive-secret');
    expect(JSON.stringify(envelope)).not.toContain('a-very-distinctive-secret');
  });

  it('API-003 uses a fresh 12-byte nonce for every seal', async () => {
    const first = await seal('same-plaintext');
    const second = await seal('same-plaintext');
    expect(fromBase64(first.nonce)).toHaveLength(12);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('API-004 fails to open under a different workspace AAD', async () => {
    const envelope = await seal('secret');
    const other = buildAad({ ...CONTEXT, workspaceId: 'ws_beta' });
    await expect(
      openCredential(envelope, { keyBase64: KEY_A, expectedAad: other }),
    ).rejects.toBeInstanceOf(AppError);
    // and with the stored AAD column relabelled to match, GCM still refuses
    await expect(
      openCredential(
        { ...envelope, aad: bindKeyVersion(other, 1) },
        { keyBase64: KEY_A, expectedAad: other },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-005 fails to open under a different provider AAD', async () => {
    const envelope = await seal('secret');
    const other = buildAad({ ...CONTEXT, provider: 'resend' });
    await expect(
      openCredential(envelope, { keyBase64: KEY_A, expectedAad: other }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-006 fails to open under a different purpose AAD', async () => {
    const envelope = await seal('secret');
    const other = buildAad({ ...CONTEXT, purpose: 'refresh_token' });
    await expect(
      openCredential(envelope, { keyBase64: KEY_A, expectedAad: other }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-007 rejects a row whose stored AAD does not match the caller context', async () => {
    // The row and its AAD were copied together into another tenant, so GCM alone would
    // still decrypt. The expectedAad check is what stops it.
    const envelope = await sealCredentialFor('secret', CONTEXT, {
      keyBase64: KEY_A,
      keyVersion: 1,
    });
    await expect(
      openCredential(envelope, {
        keyBase64: KEY_A,
        expectedAad: buildAad({ ...CONTEXT, workspaceId: 'ws_beta' }),
      }),
    ).rejects.toBeInstanceOf(AppError);
    // and succeeds for the right tenant
    await expect(openCredential(envelope, { keyBase64: KEY_A, expectedAad: AAD })).resolves.toBe(
      'secret',
    );
  });

  it('API-008 fails to open with a different key', async () => {
    const envelope = await seal('secret');
    await expect(
      openCredential(envelope, { keyBase64: KEY_B, expectedAad: AAD }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-009 fails to open when one ciphertext byte is flipped', async () => {
    const envelope = await seal('secret-value-long-enough-to-flip');
    const bytes = fromBase64(envelope.ciphertext);
    const target = bytes[3];
    expect(target).toBeDefined();
    bytes[3] = (target as number) ^ 0x01;
    await expect(
      openCredential(
        { ...envelope, ciphertext: toBase64(bytes) },
        { keyBase64: KEY_A, expectedAad: AAD },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-010 fails to open when the nonce is altered', async () => {
    const envelope = await seal('secret');
    const nonce = fromBase64(envelope.nonce);
    nonce[0] = (nonce[0] as number) ^ 0xff;
    await expect(
      openCredential(
        { ...envelope, nonce: toBase64(nonce) },
        { keyBase64: KEY_A, expectedAad: AAD },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-011 rejects a nonce of the wrong length', async () => {
    const envelope = await seal('secret');
    await expect(
      openCredential(
        { ...envelope, nonce: toBase64(randomBytes(8)) },
        { keyBase64: KEY_A, expectedAad: AAD },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-012 rejects a key that is not 32 bytes', async () => {
    await expect(seal('secret', AAD, toBase64(randomBytes(16)))).rejects.toThrow(/32 bytes/);
  });

  it('API-013 refuses to seal without an AAD', async () => {
    await expect(
      sealCredential('secret', { keyBase64: KEY_A, keyVersion: 1, aad: '' }),
    ).rejects.toThrow(/aad/i);
  });

  it('API-014 builds a canonical, order-stable AAD and rejects separator injection', () => {
    expect(buildAad(CONTEXT)).toBe('v1|ws=ws_alpha|provider=hubspot|purpose=api_token');
    expect(buildAad(CONTEXT)).toBe(
      buildAad({ purpose: 'api_token', provider: 'hubspot', workspaceId: 'ws_alpha' }),
    );
    expect(() => buildAad({ ...CONTEXT, workspaceId: 'ws_alpha|provider=resend' })).toThrow();
    expect(() => buildAad({ ...CONTEXT, provider: '' })).toThrow();
  });

  it('API-016 refuses to open without an expected AAD (A10 AUTH-114)', async () => {
    // The stored AAD travels with the row, so decrypting against it alone proves only
    // that the row is self-consistent — which an attacker who can write the row controls.
    const envelope = await seal('secret');
    const unbound = openCredential(envelope, { keyBase64: KEY_A });
    // Compile-time half of the guard: the no-AAD overload yields `never`, so no caller
    // can obtain a plaintext through it. If `expectedAad` ever becomes optional again,
    // this assignment stops compiling.
    const proofItCannotProduceAValue: Promise<never> = unbound;
    void proofItCannotProduceAValue;
    // Runtime half: it rejects rather than decrypting against the row's own AAD.
    await expect(unbound).rejects.toBeInstanceOf(AppError);
    for (const bad of ['', undefined]) {
      await expect(
        openCredential(envelope, { keyBase64: KEY_A, expectedAad: bad as unknown as string }),
      ).rejects.toBeInstanceOf(AppError);
    }
  });

  it('API-017 openCredentialFor rebuilds the AAD from context, so there is nothing to forget', async () => {
    const envelope = await sealCredentialFor('secret', CONTEXT, {
      keyBase64: KEY_A,
      keyVersion: 1,
    });
    expect(await openCredentialFor(envelope, CONTEXT, { keyBase64: KEY_A })).toBe('secret');
    await expect(
      openCredentialFor(envelope, { ...CONTEXT, workspaceId: 'ws_beta' }, { keyBase64: KEY_A }),
    ).rejects.toBeInstanceOf(AppError);
    // A context that cannot even form an AAD is a refusal, not a crash the caller sees.
    await expect(
      openCredentialFor(envelope, { ...CONTEXT, workspaceId: '' }, { keyBase64: KEY_A }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-018 binds key_version into the AAD (A10 AUTH-115)', async () => {
    const one = await sealCredential('secret', { keyBase64: KEY_A, keyVersion: 1, aad: AAD });
    const two = await sealCredential('secret', { keyBase64: KEY_A, keyVersion: 2, aad: AAD });
    expect(one.aad).not.toBe(two.aad);
    expect(one.aad).toBe('v1|kv=1|ws=ws_alpha|provider=hubspot|purpose=api_token');
    expect(two.aad).toContain('kv=2');
  });

  it('API-019 a downgraded key_version column no longer decrypts', async () => {
    const envelope = await sealCredential('secret', { keyBase64: KEY_A, keyVersion: 2, aad: AAD });
    // An attacker with write access flips the column to steer at an older wrapping key.
    const downgraded = { ...envelope, key_version: 1 };
    await expect(
      openCredential(downgraded, { keyBase64: KEY_A, expectedAad: AAD }),
    ).rejects.toBeInstanceOf(AppError);
    // Editing the AAD column to agree does not help: the tag was computed over kv=2.
    await expect(
      openCredential(
        { ...downgraded, aad: bindKeyVersion(AAD, 1) },
        { keyBase64: KEY_A, expectedAad: AAD },
      ),
    ).rejects.toBeInstanceOf(AppError);
    // The untouched row still opens.
    expect(await openCredential(envelope, { keyBase64: KEY_A, expectedAad: AAD })).toBe('secret');
  });

  it('API-210 rejects a nonsensical key_version rather than coercing it', async () => {
    const envelope = await seal('secret');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        openCredential({ ...envelope, key_version: bad }, { keyBase64: KEY_A, expectedAad: AAD }),
      ).rejects.toBeInstanceOf(AppError);
    }
    expect(() => bindKeyVersion('not-an-aad', 1)).toThrow(TypeError);
  });

  it('API-015 does not leak the cause in the thrown error', async () => {
    const envelope = await seal('secret');
    const error = await openCredential(envelope, { keyBase64: KEY_B, expectedAad: AAD }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    const message = (error as AppError).publicMessage;
    expect(message).not.toContain(envelope.ciphertext);
    expect(message).not.toContain(KEY_B);
    expect(message).toBe('A stored credential could not be read.');
  });
});
