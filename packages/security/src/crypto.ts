/**
 * AES-256-GCM credential envelopes.
 *
 * Stored provider credentials are never at rest in plaintext and are never serialised
 * back out of the API. The additional authenticated data (AAD) binds a ciphertext to the
 * workspace, provider and purpose it was sealed for, so a row copied into another tenant
 * — or re-pointed at another provider — fails to open rather than leaking.
 *
 * `crypto.subtle` is available in Cloudflare Workers and in Node 22, so this is the only
 * implementation.
 */
import { AppError } from '@verify/contracts';
import { concatBytes, fromBase64, randomBytes, toBase64, utf8Bytes, utf8Text } from './bytes';

/** AES-GCM nonce length in bytes. 96 bits is the NIST-recommended size for GCM. */
export const NONCE_BYTES = 12;
/** AES-256 key length in bytes. */
export const KEY_BYTES = 32;

export interface CredentialEnvelope {
  /** base64 AES-GCM ciphertext with the 16-byte tag appended (Web Crypto's layout). */
  readonly ciphertext: string;
  /** base64 12-byte random IV. Never reused across seals. */
  readonly nonce: string;
  /** Canonical AAD string this ciphertext is bound to. */
  readonly aad: string;
  /** Which wrapping key sealed it, so keys can be rotated without a flag day. */
  readonly key_version: number;
}

export interface SealOptions {
  readonly keyBase64: string;
  readonly keyVersion: number;
  readonly aad: string;
}

export interface OpenOptions {
  readonly keyBase64: string;
  /**
   * The AAD the caller believes this credential should carry, rebuilt from its own
   * context. When supplied it must equal the stored AAD; that is what stops a ciphertext
   * row being moved between tenants together with its AAD column.
   */
  readonly expectedAad?: string;
}

export interface AadParts {
  readonly workspaceId: string;
  readonly provider: string;
  readonly purpose: string;
}

/**
 * Canonical AAD string. Order and separators are fixed and the parts are checked for the
 * separator so two different contexts can never produce the same string.
 */
export function buildAad({ workspaceId, provider, purpose }: AadParts): string {
  for (const [name, part] of Object.entries({ workspaceId, provider, purpose })) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new TypeError(`buildAad requires a non-empty ${name}`);
    }
    if (part.includes('|') || part.includes('=')) {
      throw new TypeError(`buildAad ${name} must not contain '|' or '='`);
    }
  }
  return `v1|ws=${workspaceId}|provider=${provider}|purpose=${purpose}`;
}

function importAesKey(keyBase64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64(keyBase64);
  } catch {
    throw new TypeError('credential key must be base64');
  }
  if (raw.length !== KEY_BYTES) {
    throw new TypeError(`credential key must be ${KEY_BYTES} bytes, received ${raw.length}`);
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [usage]);
}

export async function sealCredential(
  plaintext: string,
  { keyBase64, keyVersion, aad }: SealOptions,
): Promise<CredentialEnvelope> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('sealCredential requires a non-empty plaintext');
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError('sealCredential requires a positive integer keyVersion');
  }
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new TypeError('sealCredential requires a non-empty aad; use buildAad()');
  }
  const key = await importAesKey(keyBase64, 'encrypt');
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: utf8Bytes(aad) as BufferSource },
    key,
    utf8Bytes(plaintext) as BufferSource,
  );
  return {
    ciphertext: toBase64(new Uint8Array(sealed)),
    nonce: toBase64(nonce),
    aad,
    key_version: keyVersion,
  };
}

/**
 * Open a sealed credential. Any tamper — a different key, a different AAD, a flipped
 * ciphertext or nonce byte — fails GCM authentication and throws. The thrown error never
 * carries the ciphertext, the key or the reason, because the reason is itself an oracle.
 */
export async function openCredential(
  envelope: CredentialEnvelope,
  { keyBase64, expectedAad }: OpenOptions,
): Promise<string> {
  if (expectedAad !== undefined && expectedAad !== envelope.aad) {
    throw new AppError(500, 'CREDENTIAL_UNREADABLE', 'A stored credential could not be read.');
  }
  const key = await importAesKey(keyBase64, 'decrypt');
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = fromBase64(envelope.nonce);
    ciphertext = fromBase64(envelope.ciphertext);
  } catch {
    throw new AppError(500, 'CREDENTIAL_UNREADABLE', 'A stored credential could not be read.');
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new AppError(500, 'CREDENTIAL_UNREADABLE', 'A stored credential could not be read.');
  }
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: utf8Bytes(envelope.aad) as BufferSource,
      },
      key,
      ciphertext as BufferSource,
    );
    return utf8Text(new Uint8Array(opened));
  } catch {
    throw new AppError(500, 'CREDENTIAL_UNREADABLE', 'A stored credential could not be read.');
  }
}

/**
 * Convenience for the common shape: seal against a context rather than a raw AAD string.
 */
export async function sealCredentialFor(
  plaintext: string,
  parts: AadParts,
  key: { readonly keyBase64: string; readonly keyVersion: number },
): Promise<CredentialEnvelope> {
  return sealCredential(plaintext, {
    keyBase64: key.keyBase64,
    keyVersion: key.keyVersion,
    aad: buildAad(parts),
  });
}

/** Digest of the envelope, for audit trails that must never contain the credential. */
export function envelopeFingerprintInput(envelope: CredentialEnvelope): Uint8Array {
  return concatBytes(
    utf8Bytes(`${envelope.key_version}|${envelope.aad}|`),
    utf8Bytes(envelope.nonce),
  );
}
