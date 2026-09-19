/**
 * Credential envelope tests.
 *
 * The property that matters: a ciphertext is worthless outside the exact context it was
 * sealed for. Every case below moves one thing — the workspace, the provider, the
 * purpose, the key, a single byte — and requires the open to fail.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAad,
  fromBase64,
  openCredential,
  randomBytes,
  sealCredential,
  sealCredentialFor,
  toBase64,
} from '@verify/security';
import { AppError } from '@verify/contracts';

const KEY_A = toBase64(randomBytes(32));
const KEY_B = toBase64(randomBytes(32));

const CONTEXT = { workspaceId: 'ws_alpha', provider: 'hubspot', purpose: 'api_token' };
const AAD = buildAad(CONTEXT);

const seal = (plaintext: string, aad = AAD, keyBase64 = KEY_A) =>
  sealCredential(plaintext, { keyBase64, keyVersion: 1, aad });

describe('credential envelopes', () => {
  it('API-001 seals and opens a credential round trip', async () => {
    const envelope = await seal('hubspot-pat-secret-value');
    expect(envelope.key_version).toBe(1);
    expect(envelope.aad).toBe(AAD);
    expect(await openCredential(envelope, { keyBase64: KEY_A })).toBe('hubspot-pat-secret-value');
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
    const moved = { ...envelope, aad: buildAad({ ...CONTEXT, workspaceId: 'ws_beta' }) };
    await expect(openCredential(moved, { keyBase64: KEY_A })).rejects.toBeInstanceOf(AppError);
  });

  it('API-005 fails to open under a different provider AAD', async () => {
    const envelope = await seal('secret');
    const moved = { ...envelope, aad: buildAad({ ...CONTEXT, provider: 'resend' }) };
    await expect(openCredential(moved, { keyBase64: KEY_A })).rejects.toBeInstanceOf(AppError);
  });

  it('API-006 fails to open under a different purpose AAD', async () => {
    const envelope = await seal('secret');
    const moved = { ...envelope, aad: buildAad({ ...CONTEXT, purpose: 'refresh_token' }) };
    await expect(openCredential(moved, { keyBase64: KEY_A })).rejects.toBeInstanceOf(AppError);
  });

  it('API-007 rejects a row whose stored AAD does not match the caller context', async () => {
    // The row and its AAD were copied together into another tenant, so GCM alone would
    // still decrypt. The expectedAad check is what stops it.
    const envelope = await sealCredentialFor('secret', CONTEXT, { keyBase64: KEY_A, keyVersion: 1 });
    await expect(
      openCredential(envelope, {
        keyBase64: KEY_A,
        expectedAad: buildAad({ ...CONTEXT, workspaceId: 'ws_beta' }),
      }),
    ).rejects.toBeInstanceOf(AppError);
    // and succeeds for the right tenant
    await expect(
      openCredential(envelope, { keyBase64: KEY_A, expectedAad: AAD }),
    ).resolves.toBe('secret');
  });

  it('API-008 fails to open with a different key', async () => {
    const envelope = await seal('secret');
    await expect(openCredential(envelope, { keyBase64: KEY_B })).rejects.toBeInstanceOf(AppError);
  });

  it('API-009 fails to open when one ciphertext byte is flipped', async () => {
    const envelope = await seal('secret-value-long-enough-to-flip');
    const bytes = fromBase64(envelope.ciphertext);
    const target = bytes[3];
    expect(target).toBeDefined();
    bytes[3] = (target as number) ^ 0x01;
    await expect(
      openCredential({ ...envelope, ciphertext: toBase64(bytes) }, { keyBase64: KEY_A }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-010 fails to open when the nonce is altered', async () => {
    const envelope = await seal('secret');
    const nonce = fromBase64(envelope.nonce);
    nonce[0] = (nonce[0] as number) ^ 0xff;
    await expect(
      openCredential({ ...envelope, nonce: toBase64(nonce) }, { keyBase64: KEY_A }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-011 rejects a nonce of the wrong length', async () => {
    const envelope = await seal('secret');
    await expect(
      openCredential({ ...envelope, nonce: toBase64(randomBytes(8)) }, { keyBase64: KEY_A }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('API-012 rejects a key that is not 32 bytes', async () => {
    await expect(seal('secret', AAD, toBase64(randomBytes(16)))).rejects.toThrow(/32 bytes/);
  });

  it('API-013 refuses to seal without an AAD', async () => {
    await expect(sealCredential('secret', { keyBase64: KEY_A, keyVersion: 1, aad: '' })).rejects.toThrow(
      /aad/i,
    );
  });

  it('API-014 builds a canonical, order-stable AAD and rejects separator injection', () => {
    expect(buildAad(CONTEXT)).toBe('v1|ws=ws_alpha|provider=hubspot|purpose=api_token');
    expect(buildAad(CONTEXT)).toBe(
      buildAad({ purpose: 'api_token', provider: 'hubspot', workspaceId: 'ws_alpha' }),
    );
    expect(() => buildAad({ ...CONTEXT, workspaceId: 'ws_alpha|provider=resend' })).toThrow();
    expect(() => buildAad({ ...CONTEXT, provider: '' })).toThrow();
  });

  it('API-015 does not leak the cause in the thrown error', async () => {
    const envelope = await seal('secret');
    const error = await openCredential(envelope, { keyBase64: KEY_B }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    const message = (error as AppError).publicMessage;
    expect(message).not.toContain(envelope.ciphertext);
    expect(message).not.toContain(KEY_B);
    expect(message).toBe('A stored credential could not be read.');
  });
});
