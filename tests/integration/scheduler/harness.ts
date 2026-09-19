/**
 * Scheduler integration harness.
 *
 * Builds on A02's SQLite-backed `Db` harness, so every statement the scheduler causes is
 * the real SQL against the real schema — the leases, the compare-and-set claims and the
 * allowance arithmetic are all genuinely exercised.
 *
 * What is faked is deliberately only the outside world: connectors, the credential
 * resolver, the clock and id minting. Nothing here reaches the network — `tests/setup.ts`
 * would fail the test loudly if it tried — and nothing needs a secret.
 */
import { workflowRulesSchema, type EvidenceBundle, type WorkflowRules } from '@verify/contracts';
import type {
  ClassifiedError,
  ConnectionValidation,
  Connector,
  ConnectorCapabilities,
  ConnectorFetchResult,
  FetchEvidenceInput,
  NormaliseResult,
  ProviderId,
  RevokeResult,
} from '@verify/connectors';
import { sourceEvents } from '@app/db/sourceEvents';
import type { ConnectionResolution, ConnectorRegistry, CredentialResolver } from '@app/scheduler';
import { runSchedulerTick, TickBudget, type TickReport } from '@app/scheduler';
import { createTestDb, seedWorkspace, T0, type SeededWorkspace, type TestDb } from '../db/harness';

export { T0 };
export const DEADLINE_SECONDS = 600;

export function at(seconds: number): Date {
  return new Date(new Date(T0).getTime() + seconds * 1_000);
}

export function iso(seconds: number): string {
  return at(seconds).toISOString();
}

// ---------------------------------------------------------------------------
// A connector double that records what it was asked and answers from a script
// ---------------------------------------------------------------------------

export type FetchScript = (input: FetchEvidenceInput) => ConnectorFetchResult | Promise<ConnectorFetchResult>;

export interface FakeConnector extends Connector {
  readonly calls: FetchEvidenceInput[];
}

const NO_CAPABILITIES = (provider: ProviderId): ConnectorCapabilities => ({
  provider,
  evidence_kinds: provider === 'hubspot' ? ['crm_record'] : ['email_event'],
  origins: ['provider_readback'],
  can_read_by_id: true,
  can_search_by_correlation: true,
  can_prove_record_created_in_window: true,
  can_prove_account_identity: true,
  can_verify_webhooks: false,
  can_provision_webhooks: false,
  writes_to_customer_system: false,
  required_scopes: [],
  limitations: [],
});

export function makeFakeConnector(provider: ProviderId, script: FetchScript): FakeConnector {
  const calls: FetchEvidenceInput[] = [];
  return {
    provider,
    calls,
    capabilities: () => NO_CAPABILITIES(provider),
    async validateConnection(): Promise<ConnectionValidation> {
      return {
        ok: true,
        account_id: null,
        granted_scopes: [],
        missing_capabilities: [],
        setup_steps: [],
        error: null,
        checked_at: T0,
        calls_made: 0,
      };
    },
    async fetchEvidence(input: FetchEvidenceInput): Promise<ConnectorFetchResult> {
      calls.push(input);
      return script(input);
    },
    normaliseEvidence(): NormaliseResult {
      throw new Error('not used by the scheduler');
    },
    classifyError(): ClassifiedError {
      return {
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        detail: 'the provider could not be reached',
        retryAfterSeconds: null,
      };
    },
    async revokeOrDisconnect(): Promise<RevokeResult> {
      return { local_credential_cleared: true, provider_revoked: false, manual_steps: [], calls_made: 0 };
    },
  };
}

/** A connector that always throws, to prove an adapter's exception cannot decide a status. */
export function makeThrowingConnector(provider: ProviderId): FakeConnector {
  return makeFakeConnector(provider, () => {
    throw new Error('provider exploded');
  });
}

/** Answer with a fixed bundle, as the two connectors would have split it between them. */
export function bundleScript(bundle: EvidenceBundle, callsMade = 1): {
  hubspot: FetchScript;
  resend: FetchScript;
} {
  return {
    hubspot: () => ({
      provider: 'hubspot',
      provider_account_id: bundle.crm?.provider_account_id ?? null,
      evidence: bundle.crm === null ? [] : [bundle.crm],
      gaps: bundle.gaps.filter((g) => g.source === 'crm_record'),
      calls_made: callsMade,
    }),
    resend: () => ({
      provider: 'resend',
      provider_account_id: bundle.email_events[0]?.provider_account_id ?? null,
      evidence: bundle.email_events,
      gaps: bundle.gaps.filter((g) => g.source === 'email_event'),
      calls_made: callsMade,
    }),
  };
}

export interface FakeRegistry extends ConnectorRegistry {
  readonly hubspot: FakeConnector;
  readonly resend: FakeConnector;
  /** Every provider call this registry served, across both connectors. */
  totalCalls(): number;
}

export function makeRegistry(hubspot: FakeConnector, resend: FakeConnector): FakeRegistry {
  return {
    hubspot,
    resend,
    get: (provider: ProviderId) => (provider === 'hubspot' ? hubspot : resend),
    totalCalls: () => hubspot.calls.length + resend.calls.length,
  };
}

// ---------------------------------------------------------------------------
// Credential resolvers
// ---------------------------------------------------------------------------

/** Every provider resolves. Used by the tests that are about evidence, not connections. */
export function connectedResolver(accountIds: { hubspot?: string; resend?: string } = {}): CredentialResolver {
  return {
    async resolve(_workspaceId: string, provider: ProviderId): Promise<ConnectionResolution> {
      return {
        ok: true,
        connection: {
          provider,
          credentials: { accessToken: 'test-token-not-a-real-secret' },
          connection: {
            provider,
            account_id:
              provider === 'hubspot' ? (accountIds.hubspot ?? 'hub-acct-1000') : (accountIds.resend ?? 'resend-acct-2000'),
          },
        },
      };
    },
  };
}

/** Nothing resolves, which is today's production reality. */
export function notConnectedResolver(
  reason: ConnectionResolution extends { ok: false } ? never : 'not_connected' | 'credential_unreadable' = 'not_connected',
): CredentialResolver {
  return {
    async resolve(_workspaceId: string, provider: ProviderId): Promise<ConnectionResolution> {
      return { ok: false, reason, detail: `no ${provider} connection in this test` };
    },
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface TickOptions {
  readonly now?: Date;
  readonly resolver?: CredentialResolver;
  readonly connectors?: ConnectorRegistry;
  readonly budget?: TickBudget;
  readonly maxRuns?: number;
  readonly maxExternalCalls?: number;
  readonly wallClockMs?: number;
  readonly elapsed?: () => number;
  readonly handlers?: Parameters<typeof runSchedulerTick>[0]['handlers'];
  readonly sweeper?: Parameters<typeof runSchedulerTick>[0]['sweeper'];
}

export interface SchedulerHarness {
  readonly h: TestDb;
  readonly ws: SeededWorkspace;
  readonly registry: FakeRegistry;
  /** Deterministic ids, so assertions can name the row they mean. */
  newId(prefix: string): string;
  setRules(rules: WorkflowRules): void;
  admit(externalId: string, options?: AdmitOptions): Promise<string>;
  tick(options?: TickOptions): Promise<TickReport>;
  runRow(runId: string): RunSnapshot;
  entitlement(): { run_limit: number; consumed: number; reserved: number };
  close(): void;
}

export interface AdmitOptions {
  readonly occurredAtSeconds?: number;
  readonly nextCheckAtSeconds?: number;
  readonly deadlineSeconds?: number;
  readonly correlationId?: string;
  readonly recipient?: string;
}

export interface RunSnapshot {
  readonly id: string;
  readonly status: string;
  readonly revision: number;
  readonly observation_count: number;
  readonly next_check_at: string | null;
  readonly completed_at: string | null;
}

/** The v1 shipping workflow, expressed through the frozen schema. */
export function standardRules(overrides: Partial<WorkflowRules> = {}): WorkflowRules {
  return workflowRulesSchema.parse({
    schema_version: 1,
    deadline_seconds: DEADLINE_SECONDS,
    coverage_mode: 'customer_triggered',
    crm_correlation_property: 'verify_correlation_id',
    assertions: [
      {
        rule_id: 'crm_record_exists',
        source: 'crm_record',
        field: 'record.id',
        operator: 'exists',
        expected: '',
        mandatory: true,
        label: 'A CRM record was created',
      },
      {
        rule_id: 'email_delivered',
        source: 'email_event',
        field: 'message.status',
        operator: 'provider_status_in',
        expected: ['delivered'],
        mandatory: true,
        label: 'The acknowledgement email reached the recipient',
      },
    ],
    ...overrides,
  });
}

/** CRM-only rules, for tests that must call exactly one provider. */
export function crmOnlyRules(): WorkflowRules {
  return workflowRulesSchema.parse({
    schema_version: 1,
    deadline_seconds: DEADLINE_SECONDS,
    coverage_mode: 'customer_triggered',
    crm_correlation_property: 'verify_correlation_id',
    assertions: [
      {
        rule_id: 'crm_record_exists',
        source: 'crm_record',
        field: 'record.id',
        operator: 'exists',
        expected: '',
        mandatory: true,
        label: 'A CRM record was created',
      },
    ],
  });
}

export function createSchedulerHarness(
  options: { rules?: WorkflowRules; runLimit?: number } = {},
): SchedulerHarness {
  const h = createTestDb();
  const ws = seedWorkspace(h, 'sched', { runLimit: options.runLimit ?? 500, createdAt: T0 });

  let counter = 0;
  const newId = (prefix: string): string => {
    counter += 1;
    return `${prefix}_${String(counter).padStart(4, '0')}`;
  };

  const setRules = (rules: WorkflowRules): void => {
    h.raw
      .prepare('UPDATE workflow_versions SET rules_json = ? WHERE id = ?')
      .run(JSON.stringify(rules), ws.workflowVersionId);
  };
  setRules(options.rules ?? standardRules());

  const registry = makeRegistry(
    makeFakeConnector('hubspot', () => ({
      provider: 'hubspot',
      provider_account_id: 'hub-acct-1000',
      evidence: [],
      gaps: [],
      calls_made: 1,
    })),
    makeFakeConnector('resend', () => ({
      provider: 'resend',
      provider_account_id: 'resend-acct-2000',
      evidence: [],
      gaps: [],
      calls_made: 1,
    })),
  );

  return {
    h,
    ws,
    registry,
    newId,
    setRules,

    async admit(externalId: string, admitOptions: AdmitOptions = {}): Promise<string> {
      const occurredAt = iso(admitOptions.occurredAtSeconds ?? 0);
      const deadlineAt = iso(admitOptions.deadlineSeconds ?? DEADLINE_SECONDS);
      const nextCheckAt = iso(admitOptions.nextCheckAtSeconds ?? 0);
      const runId = `run_${externalId}`;
      const payload = {
        schema_version: 1,
        event_id: externalId.padEnd(8, '0'),
        workflow_id: ws.workflowId,
        occurred_at: occurredAt,
        correlation_id: admitOptions.correlationId ?? 'enq_0000000000000001',
        expected: { email_recipient: admitOptions.recipient ?? 'ada@example.test' },
      };
      const result = await sourceEvents.admitOnce(h.db, {
        workspaceId: ws.workspaceId,
        billingPeriod: ws.billingPeriod,
        workflowId: ws.workflowId,
        workflowVersionId: ws.workflowVersionId,
        externalEventId: externalId,
        source: 'signed_customer_event',
        sourceEventId: `sev_${externalId}`,
        runId,
        outboxId: `obx_${externalId}`,
        receivedAt: T0,
        occurredAt,
        correlationKeyHash: 'corr-hash',
        payloadHash: `hash-${externalId}`,
        payloadJson: JSON.stringify(payload),
        deadlineAt,
        nextCheckAt,
      });
      return result.runId;
    },

    async tick(tickOptions: TickOptions = {}): Promise<TickReport> {
      const budget =
        tickOptions.budget ??
        new TickBudget({
          ...(tickOptions.maxRuns === undefined ? {} : { maxRuns: tickOptions.maxRuns }),
          ...(tickOptions.maxExternalCalls === undefined
            ? {}
            : { maxExternalCalls: tickOptions.maxExternalCalls }),
          ...(tickOptions.wallClockMs === undefined ? {} : { wallClockMs: tickOptions.wallClockMs }),
          ...(tickOptions.elapsed === undefined ? {} : { elapsed: tickOptions.elapsed }),
        });
      return runSchedulerTick({
        db: h.db,
        now: tickOptions.now ?? at(1),
        resolver: tickOptions.resolver ?? notConnectedResolver(),
        connectors: tickOptions.connectors ?? registry,
        budget,
        newId,
        digest: async (input: string) => `digest:${input.length}`,
        ...(tickOptions.handlers === undefined ? {} : { handlers: tickOptions.handlers }),
        ...(tickOptions.sweeper === undefined ? {} : { sweeper: tickOptions.sweeper }),
      });
    },

    runRow(runId: string): RunSnapshot {
      const row = h.raw
        .prepare(
          'SELECT id, status, revision, observation_count, next_check_at, completed_at FROM runs WHERE id = ?',
        )
        .get(runId) as RunSnapshot | undefined;
      if (row === undefined) throw new Error(`no run ${runId}`);
      return row;
    },

    entitlement() {
      const row = h.raw
        .prepare('SELECT run_limit, consumed, reserved FROM entitlements WHERE workspace_id = ? AND billing_period = ?')
        .get(ws.workspaceId, ws.billingPeriod) as
        | { run_limit: number; consumed: number; reserved: number }
        | undefined;
      if (row === undefined) throw new Error('no entitlement row');
      return { run_limit: Number(row.run_limit), consumed: Number(row.consumed), reserved: Number(row.reserved) };
    },

    close: () => h.close(),
  };
}

/** Remaining allowance, computed the one way the whole system agrees on. */
export function remainingAllowance(e: { run_limit: number; consumed: number; reserved: number }): number {
  return e.run_limit - e.consumed - e.reserved;
}
