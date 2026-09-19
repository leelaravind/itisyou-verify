/**
 * AES-256-GCM credential envelopes.
 *
 * Stored provider credentials are never at rest in plaintext and are never serialised
 * back out of the API. The additional authenticated data (AAD) binds a ciphertext to the
 * workspace, provider, purpose AND wrapping key version it was sealed for, so a row
 * copied into another tenant — or re-pointed at another provider, or steered at an older
 * key — fails to open rather than leaking.
 *
 * Two review findings shaped the current interface (A10, 2026-09-19):
 *
 * AUTH-114: the stored AAD travels with the row, so decrypting with `envelope.aad` and
 *   nothing else proves only that the row is internally consistent — which an attacker
 *   who can write the row also controls. The caller must therefore supply the AAD it
 *   *expects*, rebuilt from its own context. `openCredential` cannot return a plaintext
 *   without one: the no-AAD overload is typed `Promise<never>` and throws at runtime, so
 *   the unsafe call is a compile error in any code that wants the string, and a loud
 *   failure in any code that does not typecheck.
 *
 * AUTH-115: `key_version` used to sit beside the ciphertext, unauthenticated. During a
 *   rotation with two live keys, anyone able to write `credential_versions` could flip it
 *   and steer decryption at the other key. It is now inside the AAD (`v1|kv=<n>|ws=...`),
 *   so changing the column invalidates the tag.
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
  /** The full authenticated AAD, including the bound key version. */
  readonly aad: string;
  /** Which wrapping key sealed it. Authenticated by the AAD; editing it breaks the tag. */
  readonly key_version: number;
}

export interface SealOptions {
  readonly keyBase64: string;
  readonly keyVersion: number;
  /** Context AAD from `buildAad`. The key version is bound in by `sealCredential`. */
  readonly aad: string;
}

/** The only shape that can yield a plaintext. */
export interface OpenOptions {
  readonly keyBase64: string;
  /**
   * The AAD the caller believes this credential should carry, rebuilt from its own
   * context with `buildAad`. Required: it is what stops a ciphertext row being moved
   * between tenants together with its AAD column.
   */
  readonly expectedAad: string;
}

/**
 * Kept only so that omitting the AAD is a *loud* failure rather than a silent
 * cross-tenant decrypt. Every member returns `Promise<never>`; there is no way to obtain
 * a credential through it.
 */
export interface UnboundOpenOptions {
  readonly keyBase64: string;
  readonly expectedAad?: undefined;
}

export interface AadParts {
  readonly workspaceId: string;
  readonly provider: string;
  readonly purpose: string;
}

const CREDENTIAL_UNREADABLE = () =>
  new AppError(500, 'CREDENTIAL_UNREADABLE', 'A stored credential could not be read.');

/**
 * Canonical context AAD. Order and separators are fixed and the parts are checked for the
 * separators, so two different contexts can never produce the same string.
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

/**
 * Bind a wrapping key version into a context AAD. This is what actually reaches GCM, so
 * `key_version` is authenticated rather than being an editable column beside the tag.
 */
export function bindKeyVersion(contextAad: string, keyVersion: number): string {
  if (typeof contextAad !== 'string' || !contextAad.startsWith('v1|')) {
    throw new TypeError('bindKeyVersion expects an AAD produced by buildAad()');
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError('bindKeyVersion requires a positive integer keyVersion');
  }
  return `v1|kv=${keyVersion}|${contextAad.slice('v1|'.length)}`;
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
  const boundAad = bindKeyVersion(aad, keyVersion);
  const key = await importAesKey(keyBase64, 'encrypt');
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      additionalData: utf8Bytes(boundAad) as BufferSource,
    },
    key,
    utf8Bytes(plaintext) as BufferSource,
  );
  return {
    ciphertext: toBase64(new Uint8Array(sealed)),
    nonce: toBase64(nonce),
    aad: boundAad,
    key_version: keyVersion,
  };
}

/**
 * Open a sealed credential.
 *
 * Any tamper — a different key, a different context, a flipped ciphertext or nonce byte,
 * an edited `key_version` — fails and throws. The thrown error never carries the
 * ciphertext, the key or the reason, because the reason is itself an oracle.
 */
export function openCredential(
  envelope: CredentialEnvelope,
  options: OpenOptions,
): Promise<string>;
/**
 * @deprecated There is no safe way to open a credential without the AAD you expect.
 * This overload exists only so the mistake fails loudly; it always rejects.
 */
export function openCredential(
  envelope: CredentialEnvelope,
  options: UnboundOpenOptions,
): Promise<never>;
export async function openCredential(
  envelope: CredentialEnvelope,
  options: OpenOptions | UnboundOpenOptions,
): Promise<string> {
  const { keyBase64, expectedAad } = options;

  // AUTH-114. Refuse before touching the key: an unbound open is never correct.
  if (typeof expectedAad !== 'string' || expectedAad.length === 0) {
    throw CREDENTIAL_UNREADABLE();
  }
  if (!Number.isInteger(envelope.key_version) || envelope.key_version < 1) {
    throw CREDENTIAL_UNREADABLE();
  }
  // AUTH-115. Rebuild what the AAD must be for this row's declared key version and
  // require an exact match, so neither the AAD column nor key_version can be edited.
  let required: string;
  try {
    required = expectedAad.startsWith('v1|kv=')
      ? expectedAad
      : bindKeyVersion(expectedAad, envelope.key_version);
  } catch {
    throw CREDENTIAL_UNREADABLE();
  }
  if (required !== envelope.aad) throw CREDENTIAL_UNREADABLE();

  const key = await importAesKey(keyBase64, 'decrypt');
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = fromBase64(envelope.nonce);
    ciphertext = fromBase64(envelope.ciphertext);
  } catch {
    throw CREDENTIAL_UNREADABLE();
  }
  if (nonce.length !== NONCE_BYTES) throw CREDENTIAL_UNREADABLE();

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
    throw CREDENTIAL_UNREADABLE();
  }
}

/** Seal against a context rather than a raw AAD string. The preferred entry point. */
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

/**
 * Open against a context rather than a raw AAD string. **This is the call every consumer
 * should make.** The AAD is rebuilt here from the caller's own workspace, provider and
 * purpose, so there is no parameter anybody can forget.
 */
export async function openCredentialFor(
  envelope: CredentialEnvelope,
  parts: AadParts,
  key: { readonly keyBase64: string },
): Promise<string> {
  let expectedAad: string;
  try {
    expectedAad = buildAad(parts);
  } catch {
    throw CREDENTIAL_UNREADABLE();
  }
  return openCredential(envelope, { keyBase64: key.keyBase64, expectedAad });
}

/** Digest input for audit trails that must never contain the credential. */
export function envelopeFingerprintInput(envelope: CredentialEnvelope): Uint8Array {
  return concatBytes(
    utf8Bytes(`${envelope.key_version}|${envelope.aad}|`),
    utf8Bytes(envelope.nonce),
  );
}
