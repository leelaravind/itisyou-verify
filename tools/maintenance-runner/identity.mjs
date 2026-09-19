/**
 * Device identity: generated locally, stored outside the repository, never committed.
 *
 * WHERE IT LIVES
 * --------------
 * An OS-protected path under the user profile, never inside the working tree:
 *
 *   Windows  %LOCALAPPDATA%\itisyou-verify\runner\identity.json
 *   macOS    ~/Library/Application Support/itisyou-verify/runner/identity.json
 *   Linux    $XDG_STATE_HOME (or ~/.local/state)/itisyou-verify/runner/identity.json
 *
 * `identityPath()` refuses to return a path inside the repository, so a mis-set
 * environment variable cannot cause the private key to land somewhere git might see it.
 * The file is written with mode 0600 and the directory with 0700; on Windows those bits
 * are advisory, and the location under `LOCALAPPDATA` is the protection that matters.
 *
 * WHAT IT HOLDS
 * -------------
 * A PKCS#8 Ed25519 private key (base64) that never leaves this machine, the matching raw
 * public key that was handed to the hosted service at pairing, and the device id. Node's
 * Web Crypto is used so the key material and the signing algorithm are identical to the
 * verifier running in the Worker.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { webcrypto } from 'node:crypto';

const APP_DIR = 'itisyou-verify';
const SUB_DIR = 'runner';
const FILE = 'identity.json';

/** The per-platform base directory for durable local state. */
export function stateRoot() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, APP_DIR, SUB_DIR);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR, SUB_DIR);
  }
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, APP_DIR, SUB_DIR);
}

/**
 * The identity file path, proved to be outside `repoRoot`.
 *
 * This check is the whole reason the function exists. A private key inside the working
 * tree is one `git add -A` away from being published, and `.gitignore` is not a control
 * you want to be relying on for key material.
 */
export function identityPath(repoRoot = process.cwd()) {
  const path = join(stateRoot(), FILE);
  const resolvedRepo = resolve(repoRoot) + sep;
  if (resolve(path).startsWith(resolvedRepo)) {
    throw new Error(
      `refusing to store the runner identity inside the repository (${path}). ` +
        'Set LOCALAPPDATA / XDG_STATE_HOME to a directory outside the working tree.',
    );
  }
  return path;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text) {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** Generate a fresh Ed25519 keypair. The private half never leaves this process's disk. */
export async function generateIdentityMaterial() {
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKeyBase64: toBase64(publicKey), privateKeyBase64: toBase64(privateKey) };
}

export function loadIdentity(repoRoot = process.cwd()) {
  const path = identityPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed?.deviceId !== 'string' ||
      typeof parsed?.privateKeyBase64 !== 'string' ||
      typeof parsed?.baseUrl !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveIdentity(identity, repoRoot = process.cwd()) {
  const path = identityPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes. The LOCALAPPDATA location is the real protection.
  }
  return path;
}

/** Import the stored private key for signing. */
export async function signingKey(identity) {
  return webcrypto.subtle.importKey(
    'pkcs8',
    fromBase64(identity.privateKeyBase64),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
}

async function sha256Hex(text) {
  const digest = await webcrypto.subtle.digest('SHA-256', Buffer.from(text, 'utf8'));
  return Buffer.from(digest).toString('hex');
}

/**
 * Sign one outbound request.
 *
 * The canonical string is the same one `apps/app/src/maintenance/devices.ts` rebuilds:
 * version, device id, timestamp, method, path, body hash — joined with dots. Both sides
 * are written from that one sentence so they cannot drift.
 */
export async function signRequest(identity, { method, path, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHashHex = await sha256Hex(body ?? '');
  const message = [
    'v1',
    identity.deviceId,
    timestamp,
    method.toUpperCase(),
    path,
    bodyHashHex,
  ].join('.');
  const key = await signingKey(identity);
  const signature = new Uint8Array(
    await webcrypto.subtle.sign('Ed25519', key, Buffer.from(message, 'utf8')),
  );
  return {
    'x-runner-device': identity.deviceId,
    'x-runner-timestamp': timestamp,
    'x-runner-signature': toBase64(signature),
  };
}
