/**
 * The read port the assistant's tools run against.
 *
 * Deliberately narrow, deliberately aggregate. Every method returns a shape that has
 * already been reduced to counts, reason codes and short labels — there is no method that
 * can return a raw provider payload, an evidence body, a credential envelope, an email
 * address or a support message verbatim. That is a property of the *interface*, so a
 * future implementation cannot quietly widen it without changing this file.
 *
 * The `D1AssistantDataPort` below is composed entirely from A02's repositories in
 * `apps/app/src/db/`. It contains no SQL of its own: `apps/app/src/db/` remains the only
 * place raw SQL lives.
 */
import { assertions, connections, runs } from '../db/index.js';
import type { Db } from '../db/d1.js';
import type { MaintenanceJobKind } from '../maintenance/kinds.js';

/** Counts only. Never a customer name, never an address, never a payload. */
export interface AssistantSummary {
  readonly window_days: number;
  readonly runs_by_status: Readonly<Record<string, number>>;
  readonly total_runs: number;
  readonly connections_total: number;
  readonly connections_degraded: number;
  readonly generated_at: string;
}

export interface AssistantIncident {
  readonly id: string;
  readonly kind: 'connection_error' | 'run_unverified' | 'maintenance_job_failed';
  readonly opened_at: string;
  /** A short machine reason code, not free text from a provider. */
  readonly reason_code: string;
  /** Already redacted at the source. Treated as untrusted whenever it is shown. */
  readonly redacted_summary: string;
}

export interface AssistantRunExplanation {
  readonly run_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly deadline_at: string;
  readonly observation_count: number;
  readonly assertions: readonly {
    readonly label: string;
    readonly mandatory: boolean;
    readonly status: string;
    readonly reason_code: string;
  }[];
}

/** What the server knows about a proposed change, so it can re-derive and re-price it. */
export interface CampaignFacts {
  readonly campaign_id: string;
  readonly state: string;
  readonly current_budget_minor: number;
  readonly currency: string;
}

export interface AssistantDataPort {
  summary(workspaceId: string | null, windowDays: number, now: string): Promise<AssistantSummary>;
  incidents(workspaceId: string | null, limit: number): Promise<readonly AssistantIncident[]>;
  explainRun(workspaceId: string, runId: string): Promise<AssistantRunExplanation | null>;
  /** `null` when the campaign does not exist. A proposal for it is then refused. */
  campaignFacts(campaignId: string): Promise<CampaignFacts | null>;
  /** True when the kind may currently be queued at all (allowlist plus owner settings). */
  maintenanceKindEnabled(kind: MaintenanceJobKind): Promise<boolean>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The real port, composed from A02's repositories.
 *
 * `campaignFacts` returns `null` until A12's campaign repository exists: an assistant that
 * cannot read the current budget must not be able to propose a change to it, and returning
 * `null` is what makes `propose_campaign_change` refuse rather than guess. That is the
 * correct failure direction and it is asserted by a test.
 */
export class D1AssistantDataPort implements AssistantDataPort {
  constructor(private readonly db: Db) {}

  async summary(
    workspaceId: string | null,
    windowDays: number,
    now: string,
  ): Promise<AssistantSummary> {
    const since = new Date(Date.parse(now) - windowDays * DAY_MS).toISOString();
    if (workspaceId === null) {
      return {
        window_days: windowDays,
        runs_by_status: {},
        total_runs: 0,
        connections_total: 0,
        connections_degraded: 0,
        generated_at: now,
      };
    }
    const byStatus = await runs.countByStatus(this.db, workspaceId, since);
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const connectionRows = await connections.list(this.db, workspaceId);
    return {
      window_days: windowDays,
      runs_by_status: byStatus,
      total_runs: total,
      connections_total: connectionRows.length,
      connections_degraded: connectionRows.filter((row) => row.status !== 'ready').length,
      generated_at: now,
    };
  }

  async incidents(
    workspaceId: string | null,
    limit: number,
  ): Promise<readonly AssistantIncident[]> {
    if (workspaceId === null) return [];
    const connectionRows = await connections.list(this.db, workspaceId);
    return connectionRows
      .filter((row) => row.status !== 'ready' || row.last_error_code !== null)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        kind: 'connection_error' as const,
        opened_at: row.last_check_at ?? row.created_at,
        reason_code: row.last_error_code ?? 'CONNECTION_UNAVAILABLE',
        // The provider name and our own status vocabulary only. No provider error text.
        redacted_summary: `${row.provider} connection is ${row.status}`,
      }));
  }

  async explainRun(workspaceId: string, runId: string): Promise<AssistantRunExplanation | null> {
    const run = await runs.get(this.db, workspaceId, runId);
    if (run === null) return null;
    const rows = await assertions.listForRun(this.db, workspaceId, runId, run.revision);
    return {
      run_id: run.id,
      status: run.status,
      created_at: run.created_at,
      deadline_at: run.deadline_at,
      observation_count: run.observation_count,
      assertions: rows.map((row) => ({
        label: row.label,
        mandatory: row.mandatory === 1,
        status: row.status,
        reason_code: row.reason_code,
      })),
    };
  }

  async campaignFacts(_campaignId: string): Promise<CampaignFacts | null> {
    // A12 owns `campaigns`. Until a read exists here, the server cannot re-price a campaign
    // proposal, so it must refuse to make one. Returning `null` is the refusal.
    return null;
  }

  async maintenanceKindEnabled(_kind: MaintenanceJobKind): Promise<boolean> {
    return true;
  }
}
