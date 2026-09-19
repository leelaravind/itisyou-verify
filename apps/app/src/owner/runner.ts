/**
 * What the owner panel needs from A08's maintenance runner and assistant — expressed as a
 * narrow typed port, so the pages can be built, rendered and tested before A08's modules
 * exist, and can be wired to them without a page changing.
 *
 * A08 owns `apps/app/src/maintenance/` and `apps/app/src/assistant/`. This file implements
 * neither. It states exactly what `/owner/operations` renders, and ships an honest
 * in-memory implementation ({@link OfflineRunner}) that reports "nothing is connected"
 * rather than inventing a heartbeat.
 *
 * The rule that shapes every type below: **a field we do not know is `null`, and the view
 * says "unknown"**. There is no default heartbeat, no assumed-healthy, and no zero standing
 * in for a number nobody measured. A dashboard that shows a confident zero for a figure it
 * never received is worse than one that admits it.
 */
import type { JobState } from '@verify/contracts';

// ---------------------------------------------------------------------------
// Maintenance runner
// ---------------------------------------------------------------------------

export interface RunnerJobView {
  readonly id: string;
  /** A typed kind from A08's closed set — never a command. */
  readonly kind: string;
  readonly state: JobState;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Non-null when the job is not progressing, and says why. */
  readonly blockedReason: string | null;
}

export interface RunnerStatus {
  /** True only on a heartbeat inside the freshness window. Never optimistic. */
  readonly connected: boolean;
  readonly deviceLabel: string | null;
  readonly lastHeartbeatAt: string | null;
  /** Seconds since the last heartbeat, or null when there has never been one. */
  readonly heartbeatAgeSeconds: number | null;
  readonly currentJob: RunnerJobView | null;
  readonly lastSuccessAt: string | null;
  readonly queuedJobs: number;
  /** Why the runner is not usable, when it is not. Null when it is. */
  readonly unavailableReason: string | null;
}

export type RunnerEnqueueResult =
  | { readonly ok: true; readonly job: RunnerJobView; readonly deduplicated: boolean }
  | { readonly ok: false; readonly reason: 'kind_not_allowed' | 'no_runner'; readonly detail: string };

/**
 * The port. Three reads and one write — everything `/owner/operations` does and nothing
 * more, so A08 can implement it without inheriting a page's opinions.
 */
export interface MaintenanceRunnerPort {
  status(): Promise<RunnerStatus>;
  listJobs(limit: number): Promise<readonly RunnerJobView[]>;
  /** `kind` is one of A08's typed kinds. This port never carries a command or a path. */
  enqueue(input: {
    readonly kind: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly idempotencyKey: string;
  }): Promise<RunnerEnqueueResult>;
}

/** A heartbeat older than this is not a heartbeat. */
export const RUNNER_HEARTBEAT_STALE_SECONDS = 120;

export function heartbeatIsFresh(lastHeartbeatAt: string | null, now: Date): boolean {
  if (lastHeartbeatAt === null) return false;
  const ms = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(ms)) return false;
  const age = now.getTime() - ms;
  if (age < 0) return false;
  return age <= RUNNER_HEARTBEAT_STALE_SECONDS * 1000;
}

/**
 * The default binding until A08's runner lands: nothing is paired, so nothing is claimed.
 *
 * It still accepts an enqueue — the job is real and will run when a runner appears — and it
 * returns it in `awaiting_runner` with the reason attached. That is the behaviour the
 * quality centre depends on and the reason there is no decorative success anywhere.
 */
export class OfflineRunner implements MaintenanceRunnerPort {
  readonly #jobs: RunnerJobView[] = [];
  readonly #seen = new Map<string, RunnerJobView>();
  readonly #reason: string;

  constructor(
    reason = 'No maintenance runner is paired with this deployment. Jobs are saved and will run when one is.',
  ) {
    this.#reason = reason;
  }

  async status(): Promise<RunnerStatus> {
    return {
      connected: false,
      deviceLabel: null,
      lastHeartbeatAt: null,
      heartbeatAgeSeconds: null,
      currentJob: null,
      lastSuccessAt: null,
      queuedJobs: this.#jobs.filter((j) => j.state === 'awaiting_runner' || j.state === 'queued').length,
      unavailableReason: this.#reason,
    };
  }

  async listJobs(limit: number): Promise<readonly RunnerJobView[]> {
    return this.#jobs.slice(0, Math.max(0, limit));
  }

  async enqueue(input: {
    readonly kind: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly idempotencyKey: string;
  }): Promise<RunnerEnqueueResult> {
    const existing = this.#seen.get(input.idempotencyKey);
    if (existing !== undefined) return { ok: true, job: existing, deduplicated: true };

    const job: RunnerJobView = {
      id: `mjb_${input.idempotencyKey.slice(0, 16)}`,
      kind: input.kind,
      state: 'awaiting_runner',
      requestedBy: input.requestedBy,
      createdAt: input.at,
      startedAt: null,
      endedAt: null,
      blockedReason: this.#reason,
    };
    this.#jobs.unshift(job);
    this.#seen.set(input.idempotencyKey, job);
    return { ok: true, job, deduplicated: false };
  }
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

export interface AssistantStatus {
  /** `off` is the default and the core service works fully in it. */
  readonly mode: 'off' | 'openrouter_free' | 'paid_api';
  readonly enabled: boolean;
  /** Spend against the model budget this period, or null when unmeasured. */
  readonly spentMinor: number | null;
  readonly budgetMinor: number | null;
  readonly lastCallAt: string | null;
  /** Proposals waiting for the owner. The assistant proposes; it never decides. */
  readonly pendingProposals: number;
  readonly unavailableReason: string | null;
}

export interface AssistantStatusPort {
  status(): Promise<AssistantStatus>;
}

/** The default: off, and honest about it. */
export class AssistantOff implements AssistantStatusPort {
  async status(): Promise<AssistantStatus> {
    return {
      mode: 'off',
      enabled: false,
      spentMinor: 0,
      budgetMinor: null,
      lastCallAt: null,
      pendingProposals: 0,
      unavailableReason:
        'The assistant is switched off. Nothing in verification, billing or support depends on it, so nothing is degraded.',
    };
  }
}
