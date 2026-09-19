/**
 * The maintenance job lifecycle: enqueue, lease, result, status.
 *
 * The property the whole feature rests on: **queueing is the normal state, not the error
 * state.** When no device is paired, or the paired device is offline, a job sits in the
 * queue with a reason the owner can read, and hosted verification, billing, notifications
 * and support carry on exactly as before. Nothing in `apps/app/src/routes/`,
 * `apps/app/src/billing/`, `apps/app/src/scheduler/` or `apps/app/src/support/` imports
 * anything from this directory, which is what makes that structural rather than a promise.
 */
import { sha256Hex, stableStringify } from '@verify/security';
import { auditEvents } from '../db/index.js';
import type { Db } from '../db/d1.js';
import { newId } from '../lib/ids.js';
import {
  APPROVAL_REQUIRED_KINDS,
  CODING_AGENT_KINDS,
  MAINTENANCE_LIMITS,
  validateMaintenancePayload,
  type MaintenanceJobKind,
  type MaintenancePayload,
} from './kinds.js';
import { presenceOf } from './devices.js';
import {
  maintenanceJobs,
  runnerDevices,
  TERMINAL_STATES,
  type MaintenanceJobRow,
  type MaintenanceJobState,
} from './store.js';

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export type EnqueueRefusal =
  | { readonly code: 'INVALID_KIND'; readonly detail: string }
  | { readonly code: 'INVALID_PAYLOAD'; readonly detail: string }
  | { readonly code: 'APPROVAL_REQUIRED'; readonly detail: string }
  | { readonly code: 'BRIEF_NOT_REVIEWED'; readonly detail: string };

export type EnqueueResult =
  | {
      readonly ok: true;
      readonly jobId: string;
      readonly state: MaintenanceJobState;
      readonly payloadHash: string;
      /** Plain language for the UI when the job is queued rather than dispatched. */
      readonly queuedBecause: string | null;
    }
  | { readonly ok: false; readonly refusal: EnqueueRefusal };

export interface EnqueueParams {
  readonly db: Db;
  readonly kind: unknown;
  readonly payload: unknown;
  readonly requestedBy: string;
  readonly now: string;
  readonly priority?: number;
  /** A granted approval whose canonical hash the caller has already bound. */
  readonly approvalId?: string | null;
  readonly requestId?: string;
}

/**
 * Validate, decide the initial state, write the row.
 *
 * `payload_hash` is a SHA-256 over `stableStringify` of the **validated** payload — the
 * server's own object, never the caller's JSON text. That is the same binding
 * `approvals.canonical_payload_hash` uses, so a job and its approval can be compared
 * without either side re-serialising.
 */
export async function enqueueJob(params: EnqueueParams): Promise<EnqueueResult> {
  const validation = validateMaintenancePayload(params.kind, params.payload);
  if (!validation.ok) {
    const first = validation.problems[0];
    const code =
      first !== undefined && first.field === 'typed_kind' ? 'INVALID_KIND' : 'INVALID_PAYLOAD';
    return {
      ok: false,
      refusal: {
        code,
        detail: validation.problems.map((p) => `${p.field}: ${p.reason}`).join('; '),
      },
    };
  }
  const payload = validation.payload;
  const kind = payload.kind;

  if (APPROVAL_REQUIRED_KINDS.has(kind) && (params.approvalId ?? null) === null) {
    return {
      ok: false,
      refusal: {
        code: 'APPROVAL_REQUIRED',
        detail: `${kind} cannot be queued without a bound approval`,
      },
    };
  }

  // A coding-agent job carries a brief. A brief nobody has read is not a job; it is a
  // request. This is the gate that stops an assistant proposal becoming a running agent.
  if (CODING_AGENT_KINDS.has(kind)) {
    const brief = (payload as { readonly brief?: { readonly review_state: string } }).brief;
    if (brief === undefined || brief.review_state !== 'reviewed') {
      return {
        ok: false,
        refusal: {
          code: 'BRIEF_NOT_REVIEWED',
          detail: 'the maintenance brief must be reviewed by a person before this job is queued',
        },
      };
    }
  }

  const availability = await runnerAvailability(params.db, params.now);
  const state: MaintenanceJobState = availability.online ? 'awaiting_runner' : 'queued';

  const jobId = newId('mjb');
  const payloadHash = await sha256Hex(stableStringify(payload));
  await maintenanceJobs.insert(params.db, {
    id: jobId,
    typedKind: kind,
    payloadJson: JSON.stringify(payload),
    payloadHash,
    priority: clampPriority(params.priority),
    approvalId: params.approvalId ?? null,
    state,
    requestedBy: params.requestedBy,
    at: params.now,
  });

  await record(params.db, {
    actor: params.requestedBy,
    action: 'maintenance.job.enqueued',
    target: jobId,
    at: params.now,
    metadata: { typed_kind: kind, state, payload_hash: payloadHash.slice(0, 16) },
    ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
  });

  return {
    ok: true,
    jobId,
    state,
    payloadHash,
    queuedBecause: availability.online ? null : availability.reason,
  };
}

function clampPriority(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return 5;
  return Math.min(Math.max(value, 1), 9);
}

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

export interface LeasedJob {
  readonly job_id: string;
  readonly typed_kind: MaintenanceJobKind;
  readonly payload: MaintenancePayload;
  readonly lease_nonce: string;
  readonly lease_expires_at: string;
}

export type LeaseResult =
  | { readonly ok: true; readonly job: LeasedJob }
  | { readonly ok: false; readonly reason: 'NO_WORK' };

/**
 * Claim exactly one job.
 *
 * The loop exists because the candidate read and the claim are two statements: if another
 * device wins the race, the claim reports zero rows changed and we look for the next
 * candidate rather than returning empty-handed. A bounded number of attempts means a busy
 * queue cannot turn this into an unbounded scan.
 *
 * Two runners calling this concurrently produce exactly one claim per job, because the
 * `UPDATE` re-states the claimable predicate and the loser matches nothing.
 */
export async function leaseOneJob(params: {
  readonly db: Db;
  readonly deviceId: string;
  readonly now: string;
  readonly leaseSeconds?: number;
  readonly attempts?: number;
}): Promise<LeaseResult> {
  const leaseSeconds = params.leaseSeconds ?? MAINTENANCE_LIMITS.LEASE_SECONDS;
  const attempts = Math.min(Math.max(1, params.attempts ?? 5), 20);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = await maintenanceJobs.nextCandidate(params.db, params.now);
    if (candidate === null) return { ok: false, reason: 'NO_WORK' };

    const nonce = newId('lse');
    const leaseExpiresAt = new Date(Date.parse(params.now) + leaseSeconds * 1_000).toISOString();
    const claimed = await maintenanceJobs.claim(params.db, {
      jobId: candidate.id,
      deviceId: params.deviceId,
      nonce,
      leaseExpiresAt,
      now: params.now,
    });
    if (claimed === null) continue; // Another device won this one. Try the next candidate.

    const payload = parsePayload(claimed);
    if (payload === null) {
      // A row whose payload no longer validates cannot be run. Fail it rather than hand a
      // runner something it would have to interpret.
      await maintenanceJobs.recordResult(params.db, {
        jobId: claimed.id,
        deviceId: params.deviceId,
        nonce,
        state: 'infrastructure_error',
        resultJson: JSON.stringify({
          lease_nonce: nonce,
          outcome: 'infrastructure_error',
          reason: 'stored payload no longer validates against its typed schema',
        }),
        at: params.now,
      });
      continue;
    }

    return {
      ok: true,
      job: {
        job_id: claimed.id,
        typed_kind: payload.kind,
        payload,
        lease_nonce: nonce,
        lease_expires_at: leaseExpiresAt,
      },
    };
  }
  return { ok: false, reason: 'NO_WORK' };
}

function parsePayload(row: MaintenanceJobRow): MaintenancePayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  const check = validateMaintenancePayload(row.typed_kind, raw);
  return check.ok ? check.payload : null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const RESULT_OUTCOMES = ['passed', 'failed', 'timed_out', 'infrastructure_error'] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

export interface RunnerResultInput {
  readonly outcome: unknown;
  readonly summary: unknown;
  readonly details: unknown;
  readonly started_at: unknown;
  readonly finished_at: unknown;
}

export interface StoredResult {
  readonly lease_nonce: string;
  readonly outcome: ResultOutcome;
  readonly summary: string;
  readonly details: readonly string[];
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly recorded_at: string;
}

export type ResultRefusal =
  'JOB_NOT_FOUND' | 'INVALID_RESULT' | 'LEASE_MISMATCH' | 'DEVICE_REVOKED';

export type ResultResponse =
  | { readonly ok: true; readonly state: MaintenanceJobState; readonly duplicate: boolean }
  | { readonly ok: false; readonly reason: ResultRefusal; readonly detail: string };

/**
 * Redact and bound a result before it is stored.
 *
 * A runner's output is a program's output from the owner's own machine: it can contain a
 * path, a stack trace, an environment variable that leaked into an error message. This
 * function keeps a short summary and a capped list of lines, strips control characters,
 * and applies the secret-shaped patterns below. Anything longer is cut with the cut stated.
 */
const SECRET_SHAPED: readonly RegExp[] = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

export function redactResultText(text: unknown, maxChars: number): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    out += printable ? ch : ' ';
  }
  for (const pattern of SECRET_SHAPED) out = out.replace(pattern, '[redacted]');
  return out.length <= maxChars ? out.trim() : `${out.slice(0, maxChars).trim()} […truncated]`;
}

export function validateRunnerResult(
  raw: unknown,
  nonce: string,
  now: string,
): StoredResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const outcome = source['outcome'];
  if (typeof outcome !== 'string' || !(RESULT_OUTCOMES as readonly string[]).includes(outcome)) {
    return null;
  }
  const rawDetails = source['details'];
  const details = Array.isArray(rawDetails)
    ? rawDetails.slice(0, 50).map((line) => redactResultText(line, 500))
    : [];
  const readIso = (value: unknown): string | null =>
    typeof value === 'string' && Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : null;

  return {
    lease_nonce: nonce,
    outcome: outcome as ResultOutcome,
    summary: redactResultText(source['summary'], 500),
    details,
    started_at: readIso(source['started_at']),
    finished_at: readIso(source['finished_at']),
    recorded_at: now,
  };
}

/**
 * Record a result, exactly once.
 *
 * Idempotency: the stored envelope carries the `lease_nonce` that produced it. A duplicate
 * POST fails the conditional UPDATE (the nonce was cleared), so we re-read the row; if it
 * is terminal and its stored result names the same nonce, this is the same result arriving
 * twice and the answer is the original one. A *different* nonce, or a non-terminal state,
 * is a genuine mismatch and is refused.
 */
export async function recordJobResult(params: {
  readonly db: Db;
  readonly jobId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly body: unknown;
  readonly now: string;
  readonly requestId?: string;
}): Promise<ResultResponse> {
  const device = await runnerDevices.get(params.db, params.deviceId);
  if (device === null || device.status === 'revoked') {
    return { ok: false, reason: 'DEVICE_REVOKED', detail: 'this device may not post results' };
  }

  const job = await maintenanceJobs.get(params.db, params.jobId);
  if (job === null) return { ok: false, reason: 'JOB_NOT_FOUND', detail: 'no such job' };

  const result = validateRunnerResult(params.body, params.nonce, params.now);
  if (result === null) {
    return { ok: false, reason: 'INVALID_RESULT', detail: 'result did not match its schema' };
  }

  const state: MaintenanceJobState = result.outcome;
  const stored = await maintenanceJobs.recordResult(params.db, {
    jobId: params.jobId,
    deviceId: params.deviceId,
    nonce: params.nonce,
    state,
    resultJson: JSON.stringify(result).slice(0, MAINTENANCE_LIMITS.MAX_RESULT_CHARS),
    at: params.now,
  });

  if (stored) {
    await record(params.db, {
      actor: params.deviceId,
      actorKind: 'runner',
      action: 'maintenance.job.result',
      target: params.jobId,
      at: params.now,
      metadata: { outcome: result.outcome, typed_kind: job.typed_kind },
      ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
    });
    return { ok: true, state, duplicate: false };
  }

  const current = await maintenanceJobs.get(params.db, params.jobId);
  if (current !== null && TERMINAL_STATES.has(current.state) && current.result_json !== null) {
    try {
      const existing = JSON.parse(current.result_json) as { lease_nonce?: unknown };
      if (existing.lease_nonce === params.nonce) {
        // The same runner's same result, arriving twice. Report the original.
        return { ok: true, state: current.state, duplicate: true };
      }
    } catch {
      // Unparseable stored result: fall through to the mismatch refusal rather than guess.
    }
  }
  return {
    ok: false,
    reason: 'LEASE_MISMATCH',
    detail: 'this lease is not the one currently holding the job',
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface RunnerAvailability {
  readonly online: boolean;
  /** Plain language. This is the string the UI shows next to a queued job. */
  readonly reason: string;
  readonly pairedDevices: number;
  readonly activeDevices: number;
}

export async function runnerAvailability(db: Db, now: string): Promise<RunnerAvailability> {
  const devices = await runnerDevices.list(db, 50);
  const active = devices.filter((device) => device.status === 'active');
  const online = active.filter((device) => presenceOf(device, now) === 'online');

  if (devices.length === 0) {
    return {
      online: false,
      reason: 'No maintenance runner is paired. Jobs will queue until one is.',
      pairedDevices: 0,
      activeDevices: 0,
    };
  }
  if (active.length === 0) {
    return {
      online: false,
      reason: 'Every paired runner has been revoked or has not finished pairing.',
      pairedDevices: devices.length,
      activeDevices: 0,
    };
  }
  if (online.length === 0) {
    return {
      online: false,
      reason:
        'The paired runner is offline — the machine is switched off, asleep, or the runner is not running. Jobs will queue until it checks in.',
      pairedDevices: devices.length,
      activeDevices: active.length,
    };
  }
  return {
    online: true,
    reason: 'A paired runner is online.',
    pairedDevices: devices.length,
    activeDevices: active.length,
  };
}

export interface RunnerStatusView {
  readonly availability: RunnerAvailability;
  readonly devices: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: string;
    readonly presence: string;
    readonly last_seen: string | null;
  }[];
  readonly jobs_by_state: Readonly<Record<string, number>>;
  readonly last_successful_job: {
    readonly id: string;
    readonly typed_kind: string;
    readonly finished_at: string;
  } | null;
  /**
   * Stated on every status response, because it is the single most important honest fact
   * about this feature: nothing here is required for the service to work.
   */
  readonly hosted_service_unaffected: true;
}

export async function runnerStatus(db: Db, now: string): Promise<RunnerStatusView> {
  const [devices, availability, counts, lastSuccess] = await Promise.all([
    runnerDevices.list(db, 50),
    runnerAvailability(db, now),
    maintenanceJobs.countByState(db),
    maintenanceJobs.lastSuccessful(db),
  ]);
  return {
    availability,
    devices: devices.map((device) => ({
      id: device.id,
      label: device.label,
      status: device.status,
      presence: presenceOf(device, now),
      last_seen: device.last_heartbeat_at,
    })),
    jobs_by_state: counts,
    last_successful_job:
      lastSuccess === null
        ? null
        : {
            id: lastSuccess.id,
            typed_kind: lastSuccess.typed_kind,
            finished_at: lastSuccess.updated_at,
          },
    hosted_service_unaffected: true,
  };
}

// ---------------------------------------------------------------------------

async function record(
  db: Db,
  params: {
    readonly actor: string;
    readonly actorKind?: 'user' | 'system' | 'runner' | 'automation';
    readonly action: string;
    readonly target: string;
    readonly at: string;
    readonly metadata: Record<string, string | number>;
    readonly requestId?: string;
  },
): Promise<void> {
  try {
    await auditEvents.record(db, {
      id: newId('aud'),
      actor: params.actor,
      actorKind: params.actorKind ?? 'user',
      action: params.action,
      occurredAt: params.at,
      target: params.target,
      redactedMetadata: JSON.stringify(params.metadata),
      ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
    });
  } catch {
    // Never let an audit failure change the outcome of the operation being audited.
  }
}
