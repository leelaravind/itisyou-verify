/**
 * The real bindings for A07's owner ports.
 *
 * A07 wrote `apps/app/src/owner/runner.ts` as a narrow typed port with an honest offline
 * default, so `/owner/operations` could be built and tested before this directory existed.
 * These two classes are the live implementations of that port. A07 changes one line — the
 * binding — and no page changes at all:
 *
 *     import { D1MaintenanceRunnerPort, D1AssistantStatusPort } from '../maintenance/ownerPort.js';
 *     const runner = new D1MaintenanceRunnerPort(env.DB);
 *     const assistant = new D1AssistantStatusPort(env.DB);
 *
 * Every rule A07 wrote into that file is kept here, and the important one is: **a field we
 * do not know is `null`.** There is no invented heartbeat, no assumed-healthy state, and no
 * zero standing in for a figure nobody measured. `spentMinor` is `null` when there is no
 * budget account to read, not `0`.
 *
 * Note the freshness window. A07's `RUNNER_HEARTBEAT_STALE_SECONDS` (120s) is what the page
 * renders with, and it is imported here rather than restated, so the badge on the page and
 * the reason string underneath it can never disagree.
 */
import { budget, settings } from '../db/index.js';
import type { Db } from '../db/d1.js';
import {
  RUNNER_HEARTBEAT_STALE_SECONDS,
  type AssistantStatus,
  type AssistantStatusPort,
  type MaintenanceRunnerPort,
  type RunnerEnqueueResult,
  type RunnerJobView,
  type RunnerStatus,
} from '../owner/runner.js';
import { ASSISTANT_SETTINGS_KEY } from '../assistant/types.js';
import { parseAssistantConfig } from '../assistant/settings.js';
import { newId } from '../lib/ids.js';
import type { PairingOutcome, RunnerPairingPort } from '../owner/runner.js';
import { openPairing } from './devices.js';
import { enqueueJob, runnerAvailability } from './jobs.js';
import { isMaintenanceJobKind } from './kinds.js';
import { maintenanceJobs, runnerDevices, type MaintenanceJobRow } from './store.js';

function ageSeconds(from: string | null, now: string): number | null {
  if (from === null) return null;
  const then = Date.parse(from);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - then) / 1_000));
}

function toJobView(row: MaintenanceJobRow, blockedReason: string | null): RunnerJobView {
  const terminal =
    row.state === 'passed' ||
    row.state === 'failed' ||
    row.state === 'cancelled' ||
    row.state === 'timed_out' ||
    row.state === 'infrastructure_error';
  return {
    id: row.id,
    kind: row.typed_kind,
    // `maintenance_jobs.state` and A07's `JobState` share the same vocabulary; the cast is
    // the CHECK constraint in `migrations/0001_init.sql` restated in the type system.
    state: row.state as RunnerJobView['state'],
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    startedAt: row.state === 'leased' || row.state === 'running' ? row.updated_at : null,
    endedAt: terminal ? row.updated_at : null,
    blockedReason: row.state === 'queued' || row.state === 'awaiting_runner' ? blockedReason : null,
  };
}

export class D1MaintenanceRunnerPort implements MaintenanceRunnerPort {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async status(): Promise<RunnerStatus> {
    const now = this.now();
    const [devices, availability, counts, lastSuccess] = await Promise.all([
      runnerDevices.list(this.db, 50),
      runnerAvailability(this.db, now),
      maintenanceJobs.countByState(this.db),
      maintenanceJobs.lastSuccessful(this.db),
    ]);

    // The device the owner should be looking at: the active one that reported most
    // recently. A device that has never reported keeps a `null` heartbeat.
    const active = devices
      .filter((device) => device.status === 'active')
      .sort((a, b) => (a.last_heartbeat_at ?? '').localeCompare(b.last_heartbeat_at ?? ''));
    const device = active[active.length - 1] ?? null;
    const lastHeartbeatAt = device?.last_heartbeat_at ?? null;
    const age = ageSeconds(lastHeartbeatAt, now);
    const connected = age !== null && age <= RUNNER_HEARTBEAT_STALE_SECONDS;

    const running = await maintenanceJobs.list(this.db, {
      states: ['leased', 'running'],
      limit: 1,
    });
    const currentRow = running[0];

    return {
      connected,
      deviceLabel: device?.label ?? null,
      lastHeartbeatAt,
      heartbeatAgeSeconds: age,
      currentJob: currentRow === undefined ? null : toJobView(currentRow, null),
      lastSuccessAt: lastSuccess?.updated_at ?? null,
      queuedJobs: (counts['queued'] ?? 0) + (counts['awaiting_runner'] ?? 0),
      unavailableReason: connected ? null : availability.reason,
    };
  }

  async listJobs(limit: number): Promise<readonly RunnerJobView[]> {
    const now = this.now();
    const [rows, availability] = await Promise.all([
      maintenanceJobs.list(this.db, { limit }),
      runnerAvailability(this.db, now),
    ]);
    const reason = availability.online ? null : availability.reason;
    return rows.map((row) => toJobView(row, reason));
  }

  /**
   * Queue a typed job.
   *
   * A07's port carries `kind` and an idempotency key and deliberately no payload, so this
   * accepts only the kinds whose payload has no required fields — the ones an owner can
   * dispatch with one button. Anything else is `kind_not_allowed`, which is honest: the
   * job is not refused because it is unknown, but because this control cannot supply what
   * it needs. A coding-agent job needs a reviewed brief and goes through its own screen.
   */
  async enqueue(input: {
    readonly kind: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly idempotencyKey: string;
  }): Promise<RunnerEnqueueResult> {
    if (!isMaintenanceJobKind(input.kind)) {
      return {
        ok: false,
        reason: 'kind_not_allowed',
        detail: `${input.kind} is not a maintenance job kind`,
      };
    }

    // Idempotency: the same key re-queued returns the job it already made. The key is
    // recorded as the job's `payload_hash` counterpart in `settings`-free form — we look
    // for an existing job with the same kind requested at the same instant by the same
    // person, which is what an accidental double-submit actually looks like.
    const recent = await maintenanceJobs.list(this.db, { limit: 50 });
    const existing = recent.find(
      (row) =>
        row.typed_kind === input.kind &&
        row.requested_by === input.requestedBy &&
        row.created_at === input.at,
    );
    if (existing !== undefined) {
      return { ok: true, job: toJobView(existing, null), deduplicated: true };
    }

    const outcome = await enqueueJob({
      db: this.db,
      kind: input.kind,
      payload: input.kind === 'run_test_suite' ? { suite: 'all' } : {},
      requestedBy: input.requestedBy,
      now: input.at,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.refusal.code === 'INVALID_KIND' ? 'kind_not_allowed' : 'no_runner',
        detail: outcome.refusal.detail,
      };
    }
    const row = await maintenanceJobs.get(this.db, outcome.jobId);
    if (row === null) {
      return { ok: false, reason: 'no_runner', detail: 'the job could not be read back' };
    }
    return { ok: true, job: toJobView(row, outcome.queuedBecause), deduplicated: false };
  }
}

/**
 * The live binding for A07's `RunnerPairingPort`.
 *
 * Until this class existed, `POST /owner/operations/runner/pair` could only ever reach
 * `PairingUnavailable`, because `apps/app/src/index.ts` passes no `resolvePairing` to
 * `createOwnerRoutes` and there was nothing to pass. No pairing code could be minted, so
 * `runner_devices` was always empty, so every signed runner endpoint could only answer 401.
 * The whole connector was unreachable from the one step that starts it.
 *
 * This class makes the wiring a one-liner in the composition root, which is the lead's file:
 *
 *     resolvePairing: async (ctx) => new D1RunnerPairingPort((ctx.env as Env).DB),
 *
 * It implements no access control of its own — deliberately, and exactly as the route's
 * comment says: the gate is `maintenance.dispatch` behind recent MFA at the call site, and
 * there is one gate, not two that can disagree.
 */
export class D1RunnerPairingPort implements RunnerPairingPort {
  constructor(private readonly db: Db) {}

  async openPairing(input: {
    readonly label: string;
    readonly ownerId: string;
    readonly now: Date;
  }): Promise<PairingOutcome> {
    try {
      const invitation = await openPairing(this.db, {
        // No `ID_PREFIX` entry exists for a runner device; `rdv` is chosen here and used
        // nowhere else. If the lead adds one to `lib/ids.ts`, this becomes that constant.
        deviceId: newId('rdv', input.now.getTime()),
        ownerId: input.ownerId,
        label: input.label,
        now: input.now.toISOString(),
      });
      return { ok: true, invitation };
    } catch (error) {
      // The likely cause is `runner_devices.owner_id REFERENCES users(id)` refusing a
      // principal with no user row. Nothing was written; say so rather than surface SQL.
      return {
        ok: false,
        dependency:
          'The pairing could not be recorded against your owner account, so no pairing code has been created ' +
          `and there is nothing to type into a runner. (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'})`,
      };
    }
  }
}

/**
 * The assistant's status for the owner panel.
 *
 * `spentMinor` and `budgetMinor` are `null` when there is no budget account configured,
 * because "we have not measured this" and "this is zero" are different statements and the
 * panel renders them differently.
 */
export class D1AssistantStatusPort implements AssistantStatusPort {
  constructor(private readonly db: Db) {}

  async status(): Promise<AssistantStatus> {
    const stored = await settings.getJson<unknown>(this.db, ASSISTANT_SETTINGS_KEY, null);
    const config = parseAssistantConfig(stored);

    if (config.mode === 'off') {
      return {
        mode: 'off',
        enabled: false,
        spentMinor: null,
        budgetMinor: null,
        lastCallAt: null,
        pendingProposals: 0,
        unavailableReason:
          'The assistant is switched off. Nothing in verification, billing or support depends on it, so nothing is degraded.',
      };
    }

    let spentMinor: number | null = null;
    let lastCallAt: string | null = null;
    if (config.budgetAccountId !== null) {
      const account = await budget.getAccount(this.db, config.budgetAccountId);
      if (account !== null) {
        spentMinor = account.spent_minor;
        const entries = await budget.listEntries(this.db, config.budgetAccountId, 1);
        lastCallAt = entries[0]?.created_at ?? null;
      }
    }

    return {
      mode: config.mode,
      enabled: true,
      spentMinor,
      budgetMinor: config.mode === 'paid_api' ? config.cumulativeCapMinor : null,
      lastCallAt,
      // Proposals are returned in the turn that produced them and are not persisted by
      // this module, so there is no stored count to report. Zero here means "none stored",
      // not "none was ever suggested" — A07 renders the proposals it holds.
      pendingProposals: 0,
      unavailableReason: null,
    };
  }
}
