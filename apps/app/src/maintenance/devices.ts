/**
 * Pairing and device authentication for the local maintenance runner.
 *
 * WHAT THIS IS, PRECISELY
 * -----------------------
 * There is no inbound API by which this hosted Worker can command a copy of Claude Code,
 * or any other process, on the owner's laptop. What exists is the reverse: a process the
 * owner runs, under their own account, which **polls outbound**. Everything here
 * authenticates that outbound caller. Nothing here opens a port, creates a tunnel or
 * initiates a connection towards the owner's machine.
 *
 * PAIRING
 * -------
 * The owner generates a one-time code in the dashboard. Only its hash is stored, it
 * expires, and redeeming it is a single conditional UPDATE that clears the hash — so it is
 * single-use even against two devices racing. At redemption the device supplies the raw
 * Ed25519 public key it generated locally; the private key never leaves the machine and is
 * stored outside the repository, under the user profile.
 *
 * REQUEST AUTHENTICATION
 * ----------------------
 * Every runner request carries `x-runner-device`, `x-runner-timestamp` and
 * `x-runner-signature`. The signature is Ed25519 over a canonical string that binds the
 * device id, the timestamp, the method, the path **and a hash of the body** — so a
 * signature cannot be lifted onto a different request, a different job or a different
 * result. A stale timestamp is refused. A revoked device is refused before the signature
 * is even considered relevant.
 *
 * Ed25519 via `crypto.subtle` is available in both Cloudflare Workers and Node 22, and was
 * verified working on Node v22.23.2 on this machine on 2026-09-19 (32-byte raw public key,
 * 64-byte signature, round-trip verify true).
 */
import { fromBase64, sha256Hex, timingSafeEqual, utf8Bytes } from '@verify/security';
import type { Db } from '../db/d1.js';
import { MAINTENANCE_LIMITS } from './kinds.js';
import { runnerDevices, type RunnerDeviceRow } from './store.js';

export const RUNNER_SIGNATURE_VERSION = 'v1';
/** Clock skew tolerance on a runner request, in seconds. */
export const RUNNER_TIMESTAMP_TOLERANCE_SECONDS = 300;

export const RUNNER_HEADERS = {
  device: 'x-runner-device',
  timestamp: 'x-runner-timestamp',
  signature: 'x-runner-signature',
} as const;

/** Domain separation so a pairing code hash can never be replayed as a session token. */
export async function hashPairingCode(code: string): Promise<string> {
  return sha256Hex(utf8Bytes(`verify.runner.pairing.v1:${code}`));
}

/**
 * A pairing code the owner reads aloud or copies once.
 *
 * Crockford-style alphabet with the ambiguous characters removed, grouped for legibility.
 * 10 characters over a 32-symbol alphabet is 50 bits, which is far beyond what a
 * ten-minute window and a single-use constraint require.
 */
export function generatePairingCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (i === 5) out += '-';
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

export interface PairingInvitation {
  readonly deviceId: string;
  /** Shown to the owner exactly once. Never stored, never logged, never re-displayable. */
  readonly code: string;
  readonly expiresAt: string;
}

export async function openPairing(
  db: Db,
  params: {
    readonly deviceId: string;
    readonly ownerId: string;
    readonly label: string;
    readonly now: string;
    readonly code?: string;
  },
): Promise<PairingInvitation> {
  const code = params.code ?? generatePairingCode();
  const expiresAt = new Date(
    Date.parse(params.now) + MAINTENANCE_LIMITS.PAIRING_CODE_TTL_SECONDS * 1_000,
  ).toISOString();
  await runnerDevices.createPairing(db, {
    id: params.deviceId,
    ownerId: params.ownerId,
    label: params.label.slice(0, 80),
    pairingCodeHash: await hashPairingCode(code),
    pairingExpiresAt: expiresAt,
    createdAt: params.now,
  });
  return { deviceId: params.deviceId, code, expiresAt };
}

export type PairingResult =
  | { readonly ok: true; readonly device: RunnerDeviceRow }
  | {
      readonly ok: false;
      readonly reason: 'INVALID_CODE' | 'INVALID_PUBLIC_KEY';
      readonly detail: string;
    };

/** A base64 raw Ed25519 public key is exactly 32 bytes. Anything else is refused. */
export function parsePublicKey(candidate: unknown): Uint8Array | null {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 128)
    return null;
  try {
    const bytes = fromBase64(candidate);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export async function completePairing(
  db: Db,
  params: { readonly code: string; readonly publicKey: string; readonly now: string },
): Promise<PairingResult> {
  if (parsePublicKey(params.publicKey) === null) {
    return {
      ok: false,
      reason: 'INVALID_PUBLIC_KEY',
      detail: 'expected a base64 raw 32-byte Ed25519 public key',
    };
  }
  const device = await runnerDevices.completePairing(db, {
    pairingCodeHash: await hashPairingCode(params.code),
    publicKey: params.publicKey,
    now: params.now,
  });
  if (device === null) {
    // One message for "wrong", "expired" and "already used". A device that got the code
    // wrong learns nothing about which of the three it was.
    return { ok: false, reason: 'INVALID_CODE', detail: 'pairing code is not valid' };
  }
  return { ok: true, device };
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

export type RunnerAuthFailure =
  | 'MISSING_HEADERS'
  | 'UNKNOWN_DEVICE'
  | 'DEVICE_REVOKED'
  | 'DEVICE_NOT_ACTIVE'
  | 'TIMESTAMP_STALE'
  | 'BAD_SIGNATURE';

export type RunnerAuthResult =
  | { readonly ok: true; readonly device: RunnerDeviceRow }
  | { readonly ok: false; readonly reason: RunnerAuthFailure };

/**
 * The canonical string a device signs.
 *
 * Every field that could be swapped is in it: the version tag prevents a future scheme
 * being downgraded onto this one, the device id stops a signature being replayed by
 * another device, the timestamp bounds replay, the method and path bind it to one
 * endpoint, and the body hash binds it to one payload — so a valid signature for a
 * "health check passed" result cannot be reused for a "release executed" result.
 */
export function canonicalRunnerString(params: {
  readonly deviceId: string;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHashHex: string;
}): string {
  return [
    RUNNER_SIGNATURE_VERSION,
    params.deviceId,
    params.timestamp,
    params.method.toUpperCase(),
    params.path,
    params.bodyHashHex,
  ].join('.');
}

async function verifyEd25519(
  publicKeyBase64: string,
  signatureBase64: string,
  message: string,
): Promise<boolean> {
  try {
    const rawKey = parsePublicKey(publicKeyBase64);
    if (rawKey === null) return false;
    const signature = fromBase64(signatureBase64);
    if (signature.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      rawKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      utf8Bytes(message) as BufferSource,
    );
  } catch {
    return false;
  }
}

export interface RunnerRequestParts {
  readonly deviceId: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly method: string;
  readonly path: string;
  /** The raw request body, exactly as received. Hashed, never reparsed before verifying. */
  readonly rawBody: string;
}

export function readRunnerHeaders(
  headers: Headers,
  method: string,
  path: string,
  rawBody: string,
): RunnerRequestParts {
  return {
    deviceId: headers.get(RUNNER_HEADERS.device),
    timestamp: headers.get(RUNNER_HEADERS.timestamp),
    signature: headers.get(RUNNER_HEADERS.signature),
    method,
    path,
    rawBody,
  };
}

/**
 * Authenticate one runner request.
 *
 * Order: headers present, device known, device not revoked, device active, timestamp
 * fresh, signature valid. The revocation check sits before the signature check on purpose
 * — a revoked device holding a perfectly valid key must be refused, and the refusal must
 * not depend on the cryptography succeeding first.
 */
export async function authenticateRunner(
  db: Db,
  parts: RunnerRequestParts,
  nowMs: number,
): Promise<RunnerAuthResult> {
  if (parts.deviceId === null || parts.timestamp === null || parts.signature === null) {
    return { ok: false, reason: 'MISSING_HEADERS' };
  }

  const device = await runnerDevices.get(db, parts.deviceId);
  if (device === null) return { ok: false, reason: 'UNKNOWN_DEVICE' };
  if (device.status === 'revoked') return { ok: false, reason: 'DEVICE_REVOKED' };
  if (device.status !== 'active') return { ok: false, reason: 'DEVICE_NOT_ACTIVE' };

  const unix = Number(parts.timestamp);
  if (!Number.isFinite(unix)) return { ok: false, reason: 'TIMESTAMP_STALE' };
  const skewSeconds = Math.abs(Math.floor(nowMs / 1_000) - unix);
  if (skewSeconds > RUNNER_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'TIMESTAMP_STALE' };
  }

  const bodyHashHex = await sha256Hex(utf8Bytes(parts.rawBody));
  const message = canonicalRunnerString({
    deviceId: parts.deviceId,
    timestamp: parts.timestamp,
    method: parts.method,
    path: parts.path,
    bodyHashHex,
  });

  // The device id in the header must be the one the signature was made for; the canonical
  // string already binds it, and this comparison makes the binding explicit and constant
  // time rather than implicit in the key lookup.
  if (!timingSafeEqual(device.id, parts.deviceId)) return { ok: false, reason: 'BAD_SIGNATURE' };

  const valid = await verifyEd25519(device.public_key, parts.signature, message);
  return valid ? { ok: true, device } : { ok: false, reason: 'BAD_SIGNATURE' };
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export type DevicePresence = 'online' | 'offline' | 'never_seen' | 'revoked';

export function presenceOf(device: RunnerDeviceRow, now: string): DevicePresence {
  if (device.status === 'revoked') return 'revoked';
  if (device.last_heartbeat_at === null) return 'never_seen';
  const seen = Date.parse(device.last_heartbeat_at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(seen) || !Number.isFinite(nowMs)) return 'offline';
  return nowMs - seen <= MAINTENANCE_LIMITS.OFFLINE_AFTER_SECONDS * 1_000 ? 'online' : 'offline';
}
