/**
 * Check one run now, because somebody is watching it.
 *
 * ## Why this exists
 *
 * A pending run is checked when its `next_check_at` falls due, and the minute cron is what
 * notices that. The plan backs off from 30 seconds, but a run whose check fell due at
 * 12:00:31 waited for the 12:01 tick, and a test verification with a ten-minute window got
 * only a handful of looks. A customer who has just pressed "Run a test verification" and is
 * watching the run page saw nothing move, and was told to reload.
 *
 * So a watched run is checked AT its due time rather than at the next minute boundary.
 * Nothing about WHEN a run is due changes: that is still the scheduler's plan and its
 * backoff. Only the lag between "due" and "looked at" shrinks.
 *
 * ## Why this is safe
 *
 * It is the scheduler's own path, one run wide:
 *   - the run is read scoped to the caller's workspace, never by id alone;
 *   - it is claimed with the same compare-and-set on `(id, revision)` the tick uses, so a
 *     tick and a watcher racing for the same run cannot both observe it;
 *   - it is observed by the same `observeRun`, under a one-run budget, so it can make no
 *     more provider calls than the tick would have for that run;
 *   - a run that is not due is left alone. Polling faster than the plan cannot buy extra
 *     provider calls, because only a due run can be claimed;
 *   - the owner's `expensive_verification` pause is honoured: a paused deployment makes no
 *     on-demand calls, and the tick decides as before.
 *
 * It never throws. The caller hands it to `waitUntil` after answering the request.
 */
import { runs, type DueRun } from '../db/runs';
import { D1BillingDataPort } from '../db/billingPort';
import { settings } from '../db/audit';
import type { Db } from '../db/d1';
import { newId } from '../lib/ids';
import { addSecondsIso, toIso } from '../lib/time';
import { sha256Hex } from '@verify/security';
import { getConnector, type ProviderId } from '@verify/connectors';
import { controlSettingKey } from '../owner/controls';
import { TICK_DEFAULTS, TickBudget } from './budget';
import { createD1CredentialResolver, NOT_CONNECTED_RESOLVER } from './credentials';
import { observeRun } from './observe';
import type { ConnectorRegistry, SchedulerLogger } from './ports';

export type WatchedCheckOutcome =
  'checked' | 'not_due' | 'settled' | 'claimed_elsewhere' | 'not_found' | 'suspended' | 'failed';

export interface WatchedCheckInput {
  readonly db: Db;
  readonly workspaceId: string;
  readonly runId: string;
  readonly credentialKeyBase64: string | undefined;
  readonly billingEnvironment: 'test' | 'live';
  readonly now?: Date;
  /** Injected in tests; production reaches the providers through the runtime's `fetch`. */
  readonly connectors?: ConnectorRegistry;
  readonly logger?: SchedulerLogger;
}

const PRODUCTION: ConnectorRegistry = { get: (provider: ProviderId) => getConnector(provider) };

export async function checkWatchedRun(input: WatchedCheckInput): Promise<WatchedCheckOutcome> {
  const now = input.now ?? new Date();
  const nowIso = toIso(now);
  try {
    const row = await runs.get(input.db, input.workspaceId, input.runId);
    if (row === null) return 'not_found';
    if (row.next_check_at === null) return 'settled';
    if (row.next_check_at > nowIso) return 'not_due';

    const paused = await settings.getJson<{ paused?: boolean } | null>(
      input.db,
      controlSettingKey('expensive_verification'),
      null,
    );
    if (paused !== null && paused.paused === true) return 'suspended';

    const leaseUntil = addSecondsIso(now, TICK_DEFAULTS.LEASE_SECONDS);
    const won = await runs.tryClaim(input.db, {
      runId: row.id,
      expectedRevision: row.revision,
      now: nowIso,
      leaseUntil,
    });
    if (!won) return 'claimed_elsewhere';

    const due: DueRun = {
      id: row.id,
      workspace_id: row.workspace_id,
      workflow_id: row.workflow_id,
      workflow_version_id: row.workflow_version_id,
      revision: row.revision + 1,
      observation_count: row.observation_count,
      deadline_at: row.deadline_at,
      next_check_at: leaseUntil,
    };
    const resolver =
      input.credentialKeyBase64 === undefined || input.credentialKeyBase64.length === 0
        ? NOT_CONNECTED_RESOLVER
        : createD1CredentialResolver({
            db: input.db,
            credentialKeyBase64: input.credentialKeyBase64,
          });

    await observeRun(due, {
      db: input.db,
      now,
      connectors: input.connectors ?? PRODUCTION,
      resolver,
      budget: new TickBudget({ maxRuns: 1 }),
      newId: (prefix: string) => newId(prefix),
      digest: (value: string) => sha256Hex(value),
      billing: new D1BillingDataPort(input.db),
      billingEnvironment: input.billingEnvironment,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    return 'checked';
  } catch (caught) {
    // A claimed run whose observation threw is not lost: its lease expires and the tick
    // takes it, exactly as when a tick's own worker dies.
    input.logger?.warn('scheduler.watched.failed', {
      run_id: input.runId,
      message: caught instanceof Error ? caught.name : 'unknown error',
    });
    return 'failed';
  }
}
