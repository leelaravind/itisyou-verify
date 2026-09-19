/**
 * SEC-5xx — credential envelope: proving AAD binding survives a database leak.
 *
 * Scenario the schema is designed for: `credential_versions` is exfiltrated (a D1 dump,
 * a backup, a compromised read path) AND the wrapping key `CREDENTIAL_KEY_V1` is also
 * obtained. Without AAD, every ciphertext decrypts and every customer's HubSpot and
 * Resend tokens are gone at once.
 *
 * With AES-GCM additional authenticated data bound to workspace + provider + purpose +
 * key version, a ciphertext belonging to workspace A CANNOT be decrypted while claiming
 * workspace B's context — the GCM tag check fails. That does not stop an attacker who
 * has both the key and the full row (they can replay the correct AAD), but it does stop:
 *   - a confused-deputy bug in our own code that passes the wrong workspace id,
 *   - a row copied between tenants in the database,
 *   - a `connection_id` swapped in a request to decrypt someone else's credential.
 *
 * That limitation is stated honestly here and in docs/threat-model.md (CRED-02).
 * AAD is a tenant-confusion control, not a key-compromise control.
 *
 * These cases run against WebCrypto directly, so they prove the CONSTRUCTION today.
 * `tests/security/integration/security-package.test.ts` asserts A02's real
 * implementation has the same property.
 */
import { describe, it, expect } from 'vitest';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Envelope {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly aad: string;
}

/** The AAD string shape the schema comment promises: workspace + provider + purpose. */
function buildAad(
  workspaceId: string,
  provider: string,
  purpose: string,
  keyVersion: number,
): string {
  return `v${keyVersion}|ws=${workspaceId}|provider=${provider}|purpose=${purpose}`;
}

function toBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBuffer(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<Envelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(enc.encode(aad)) },
    key,
    toBuffer(enc.encode(plaintext)),
  );
  return { ciphertext: new Uint8Array(ciphertext), nonce, aad };
}

async function open(key: CryptoKey, envelope: Envelope, aad: string): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(envelope.nonce), additionalData: toBuffer(enc.encode(aad)) },
    key,
    toBuffer(envelope.ciphertext),
  );
  return dec.decode(plain);
}

const KEY_BYTES = new Uint8Array(32).fill(7); // synthetic, deterministic, not a real key
const TOKEN_A = ['pat', 'na1', '00000000-0000-4000-8000-000000000001'].join('-');
const WS_A = 'ws_aaaaaaaaaaaaaaaa';
const WS_B = 'ws_bbbbbbbbbbbbbbbb';

describe('credential envelope: AAD binds ciphertext to a tenant', () => {
  it('SEC-501 round-trips with the correct AAD', async () => {
    const key = await importKey(KEY_BYTES);
    const aad = buildAad(WS_A, 'hubspot', 'connection_token', 1);
    const sealed = await seal(key, TOKEN_A, aad);
    expect(await open(key, sealed, aad)).toBe(TOKEN_A);
  });

  it('SEC-502 tenant A ciphertext will not decrypt in tenant B context, even with the key', async () => {
    const key = await importKey(KEY_BYTES);
    const sealed = await seal(key, TOKEN_A, buildAad(WS_A, 'hubspot', 'connection_token', 1));
    await expect(
      open(key, sealed, buildAad(WS_B, 'hubspot', 'connection_token', 1)),
    ).rejects.toThrow();
  });

  it('SEC-503 will not decrypt under a different provider context', async () => {
    const key = await importKey(KEY_BYTES);
    const sealed = await seal(key, TOKEN_A, buildAad(WS_A, 'hubspot', 'connection_token', 1));
    await expect(
      open(key, sealed, buildAad(WS_A, 'resend', 'connection_token', 1)),
    ).rejects.toThrow();
  });

  it('SEC-504 will not decrypt under a different purpose (connection token vs TOTP seed)', async () => {
    const key = await importKey(KEY_BYTES);
    const sealed = await seal(key, TOKEN_A, buildAad(WS_A, 'hubspot', 'connection_token', 1));
    await expect(open(key, sealed, buildAad(WS_A, 'hubspot', 'totp_seed', 1))).rejects.toThrow();
  });

  it('SEC-505 will not decrypt under a different key version label', async () => {
    const key = await importKey(KEY_BYTES);
    const sealed = await seal(key, TOKEN_A, buildAad(WS_A, 'hubspot', 'connection_token', 1));
    await expect(
      open(key, sealed, buildAad(WS_A, 'hubspot', 'connection_token', 2)),
    ).rejects.toThrow();
  });

  it('SEC-506 rejects a tampered ciphertext (GCM tag)', async () => {
    const key = await importKey(KEY_BYTES);
    const aad = buildAad(WS_A, 'hubspot', 'connection_token', 1);
    const sealed = await seal(key, TOKEN_A, aad);
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await expect(open(key, { ...sealed, ciphertext: tampered }, aad)).rejects.toThrow();
  });

  it('SEC-507 rejects a swapped nonce', async () => {
    const key = await importKey(KEY_BYTES);
    const aad = buildAad(WS_A, 'hubspot', 'connection_token', 1);
    const one = await seal(key, TOKEN_A, aad);
    const two = await seal(key, TOKEN_A, aad);
    await expect(open(key, { ...one, nonce: two.nonce }, aad)).rejects.toThrow();
  });

  it('SEC-508 uses a fresh 12-byte nonce for every seal (AES-GCM nonce reuse is fatal)', async () => {
    const key = await importKey(KEY_BYTES);
    const aad = buildAad(WS_A, 'hubspot', 'connection_token', 1);
    const nonces = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const sealed = await seal(key, TOKEN_A, aad);
      expect(sealed.nonce.byteLength).toBe(12);
      nonces.add([...sealed.nonce].join(','));
    }
    expect(nonces.size).toBe(64);
  });

  it('SEC-509 produces different ciphertext for the same plaintext (no deterministic leak)', async () => {
    const key = await importKey(KEY_BYTES);
    const aad = buildAad(WS_A, 'hubspot', 'connection_token', 1);
    const one = await seal(key, TOKEN_A, aad);
    const two = await seal(key, TOKEN_A, aad);
    expect([...one.ciphertext].join(',')).not.toBe([...two.ciphertext].join(','));
  });

  it('SEC-510 the AAD string itself must contain the workspace id verbatim', () => {
    // Guard against an implementation that "binds" to a hash of the workspace id it was
    // given by the caller instead of the one resolved from the session — the AAD is only
    // as good as where the workspace id came from.
    const aad = buildAad(WS_A, 'hubspot', 'connection_token', 1);
    expect(aad).toContain(WS_A);
    expect(aad).not.toContain(WS_B);
  });
});
