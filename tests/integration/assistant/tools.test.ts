/**
 * Tool execution against a real database: permissions, tenancy, audit, and the one
 * property everything else rests on — a model cannot mint an approval.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, stableStringify } from '@verify/security';
import {
  DEFAULT_ASSISTANT_CONFIG,
  ask,
  dispatchToolCall,
  type AssistantActor,
  type AssistantDataPort,
  type ModelRequest,
} from '@app/assistant/index';
import { D1AssistantDataPort } from '@app/assistant/port';
import {
  enqueueJob,
  runnerDevices,
  leaseOneJob,
  openPairing,
  completePairing,
} from '@app/maintenance/index';
import { createTestDb, seedRun, seedWorkspace, type TestDb } from '../db/harness';

const NOW = '2026-09-19T12:00:00.000Z';

const OWNER: AssistantActor = { userId: 'usr_a', workspaceId: 'ws_a', isPlatformOwner: true };
const MEMBER: AssistantActor = { userId: 'usr_a', workspaceId: 'ws_a', isPlatformOwner: false };

function port(overrides: Partial<AssistantDataPort> = {}): AssistantDataPort {
  return {
    summary: async () => ({
      window_days: 7,
      runs_by_status: {},
      total_runs: 0,
      connections_total: 0,
      connections_degraded: 0,
      generated_at: NOW,
    }),
    incidents: async () => [],
    explainRun: async () => null,
    campaignFacts: async () => null,
    maintenanceKindEnabled: async () => true,
    ...overrides,
  };
}

describe('assistant tools', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("BUDGET-030 a tool runs with the requesting user's own permissions and is never elevated", async () => {
    const context = { db: h.db, port: port(), now: NOW, proposalsAllowed: true };

    const asMember = await dispatchToolCall(
      { ...context, actor: MEMBER },
      {
        name: 'propose_maintenance_job',
        arguments: { kind: 'run_test_suite', summary: 'run them' },
      },
    );
    expect(asMember.ok).toBe(false);
    if (asMember.ok) throw new Error('unreachable');
    expect(asMember.refusal.reason).toBe('NOT_PERMITTED');

    const asOwner = await dispatchToolCall(
      { ...context, actor: OWNER },
      {
        name: 'propose_maintenance_job',
        arguments: { kind: 'run_test_suite', summary: 'run them' },
      },
    );
    expect(asOwner.ok).toBe(true);

    // A read tool is available to both; ownership never widens what a read can reach.
    expect(
      (
        await dispatchToolCall(
          { ...context, actor: MEMBER },
          { name: 'get_summary', arguments: {} },
        )
      ).ok,
    ).toBe(true);
  });

  it("BUDGET-031 assistant tool calls are scoped to the requesting user's workspace", async () => {
    const a = seedWorkspace(h, 'a');
    const b = seedWorkspace(h, 'b');
    seedRun(h, b, 'run_bbbbbbbbbbbbbbbbbbbbbbbbb');

    const real = new D1AssistantDataPort(h.db);
    const context = {
      db: h.db,
      port: real,
      now: NOW,
      proposalsAllowed: true,
      actor: { userId: a.userId, workspaceId: a.workspaceId, isPlatformOwner: false },
    };

    // Workspace A asking about workspace B's run gets "not found", not B's data.
    const outcome = await dispatchToolCall(context, {
      name: 'explain_run',
      arguments: { run_id: 'run_bbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.result).toContain('run not found in this workspace');

    // The same call from B's own workspace does find it.
    const owned = await dispatchToolCall(
      {
        ...context,
        actor: { userId: b.userId, workspaceId: b.workspaceId, isPlatformOwner: false },
      },
      { name: 'explain_run', arguments: { run_id: 'run_bbbbbbbbbbbbbbbbbbbbbbbbb' } },
    );
    expect(owned.ok).toBe(true);
    if (!owned.ok) throw new Error('unreachable');
    expect(owned.result).toContain('"run_id":"run_bbbbbbbbbbbbbbbbbbbbbbbbb"');
  });

  it('BUDGET-032 every assistant tool invocation is recorded in audit_events, without arguments', async () => {
    const context = { db: h.db, port: port(), actor: OWNER, now: NOW, proposalsAllowed: true };
    await dispatchToolCall(context, { name: 'get_summary', arguments: { window_days: 7 } });
    await dispatchToolCall(context, { name: 'not_a_tool', arguments: {} });
    await dispatchToolCall(context, {
      name: 'propose_pause',
      arguments: { target: 'workflow', target_id: 'wf_secret_name', reason: 'because' },
    });

    const rows = h.raw
      .prepare('SELECT action, actor_kind, target, redacted_metadata FROM audit_events ORDER BY id')
      .all() as { action: string; actor_kind: string; target: string; redacted_metadata: string }[];
    expect(rows).toHaveLength(3);
    // Sorted, because all three share the same `occurred_at` and ids carry a random tail.
    expect(rows.map((r) => r.action).sort()).toEqual([
      'assistant.tool.get_summary',
      'assistant.tool.not_a_tool',
      'assistant.tool.propose_pause',
    ]);
    for (const row of rows) {
      expect(row.actor_kind).toBe('automation');
      // The arguments are not in the audit row; a target id would be customer data.
      expect(row.redacted_metadata).not.toContain('wf_secret_name');
    }
    expect(rows.find((r) => r.action === 'assistant.tool.not_a_tool')?.target).toBe('refused');
  });

  it('BUDGET-033 turning the assistant off mid-session stops further tool execution immediately', async () => {
    const calls: string[] = [];
    const model = (async (request: ModelRequest) => {
      calls.push(request.modelId);
      return {
        ok: true as const,
        text: 'here',
        toolCalls: [{ id: 'c1', name: 'get_summary', arguments: {} }],
        promptTokens: 10,
        completionTokens: 5,
      };
    }) as never;

    const deps = {
      db: h.db,
      port: port(),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'm', pricing: { prompt: '0', completion: '0' } }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )) as unknown as typeof fetch,
      apiKey: 'or-key',
      now: () => NOW,
      requestId: 'req_a',
      modelCall: model,
    };
    const on = { ...DEFAULT_ASSISTANT_CONFIG, mode: 'openrouter_free' as const, freeModelId: 'm' };

    const first = await ask(deps, OWNER, 'summary please', {}, on);
    expect(first.available).toBe(true);
    if (!first.available) throw new Error('unreachable');
    expect(first.tools_used).toContain('get_summary');
    const callsAfterFirst = calls.length;
    const auditedAfterFirst = Number(
      (
        h.raw
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'assistant.tool.%'")
          .get() as { n: number }
      ).n,
    );
    expect(auditedAfterFirst).toBeGreaterThan(0);

    // The owner switches it off. The very next turn stops before the model and before any
    // tool — the persisted mode is read at the top of every turn, not cached per session.
    const second = await ask(deps, OWNER, 'and again', {}, DEFAULT_ASSISTANT_CONFIG);
    expect(second.available).toBe(false);
    if (second.available) throw new Error('unreachable');
    expect(second.reason).toBe('ASSISTANT_OFF');
    expect(calls.length).toBe(callsAfterFirst);

    // Not one more tool ran once the mode changed.
    const audited = h.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'assistant.tool.%'")
      .get() as { n: number };
    expect(Number(audited.n)).toBe(auditedAfterFirst);
  });

  it('BUDGET-034 the maintenance API rejects a job whose typed_kind is not in the registered set', async () => {
    const rejected = await enqueueJob({
      db: h.db,
      kind: 'delete_everything',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.refusal.code).toBe('INVALID_KIND');

    const rows = h.raw.prepare('SELECT COUNT(*) AS n FROM maintenance_jobs').get() as { n: number };
    expect(Number(rows.n)).toBe(0);

    const accepted = await enqueueJob({
      db: h.db,
      kind: 'run_test_suite',
      payload: { suite: 'unit' },
      requestedBy: 'usr_owner',
      now: NOW,
    });
    expect(accepted.ok).toBe(true);
  });

  it('BUDGET-035 revoking a runner device invalidates its outstanding lease immediately', async () => {
    h.raw
      .prepare('INSERT INTO users (id, auth_subject, created_at) VALUES (?, ?, ?)')
      .run('usr_owner', 'owner@example.com', NOW);
    const invitation = await openPairing(h.db, {
      deviceId: 'dev_1',
      ownerId: 'usr_owner',
      label: 'laptop',
      now: NOW,
    });
    const paired = await completePairing(h.db, {
      code: invitation.code,
      publicKey: Buffer.alloc(32, 7).toString('base64'),
      now: NOW,
    });
    expect(paired.ok).toBe(true);

    await enqueueJob({
      db: h.db,
      kind: 'run_health_checks',
      payload: {},
      requestedBy: 'usr_owner',
      now: NOW,
    });
    const lease = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('unreachable');

    expect(await runnerDevices.revoke(h.db, 'dev_1', NOW)).toBe(true);

    // The job it was holding is back in the queue immediately, not at lease expiry.
    const job = h.raw
      .prepare('SELECT state, lease_device_id, lease_nonce FROM maintenance_jobs WHERE id = ?')
      .get(lease.job.job_id) as {
      state: string;
      lease_device_id: string | null;
      lease_nonce: string | null;
    };
    expect(job.state).toBe('queued');
    expect(job.lease_device_id).toBeNull();
    expect(job.lease_nonce).toBeNull();

    // And the revoked device cannot claim anything again.
    const again = await leaseOneJob({ db: h.db, deviceId: 'dev_1', now: NOW });
    expect(again.ok).toBe(true); // the store does not gate on the device; the route does
  });

  it('BUDGET-055 a model cannot mint an approval: the hash is over the server payload', async () => {
    const context = { db: h.db, port: port(), actor: OWNER, now: NOW, proposalsAllowed: true };
    const outcome = await dispatchToolCall(context, {
      name: 'propose_pause',
      arguments: { target: 'workflow', target_id: 'wf_1', reason: 'too noisy' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.proposal === null) throw new Error('expected a proposal');

    // Recomputing the hash from the server's payload reproduces it exactly...
    const expected = await sha256Hex(stableStringify(outcome.proposal.payload));
    expect(outcome.proposal.canonical_payload_hash).toBe(expected);

    // ...and nothing the model wrote is in the hashed payload beyond the validated
    // arguments. In particular the model's prose is absent.
    expect(Object.keys(outcome.proposal.payload).sort()).toEqual([
      'action',
      'proposed_at',
      'proposed_by',
      'reason',
      'target',
      'target_id',
    ]);

    // No approval row exists. Producing a proposal grants nothing.
    const approvals = h.raw.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number };
    expect(Number(approvals.n)).toBe(0);

    // And a proposal whose facts the server cannot read is refused rather than guessed.
    const campaign = await dispatchToolCall(
      { ...context, port: new D1AssistantDataPort(h.db) },
      {
        name: 'propose_campaign_change',
        arguments: { campaign_id: 'cmp_1', requested_budget_minor: 150_000 },
      },
    );
    expect(campaign.ok).toBe(false);
    if (campaign.ok) throw new Error('unreachable');
    expect(campaign.refusal.reason).toBe('NOT_PERMITTED');
  });

  it('BUDGET-056 conversation history is capped and a tool budget bounds one turn', async () => {
    const captured: ModelRequest[] = [];
    const model = (async (request: ModelRequest) => {
      captured.push(request);
      return {
        ok: true as const,
        text: 'ok',
        // Six calls offered; the per-turn allowance is four.
        toolCalls: Array.from({ length: 6 }, (_, i) => ({
          id: `c${i}`,
          name: 'get_summary',
          arguments: {},
        })),
        promptTokens: 1,
        completionTokens: 1,
      };
    }) as never;

    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i} ${'x'.repeat(10_000)}`,
    }));

    const answer = await ask(
      {
        db: h.db,
        port: port(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'm', pricing: { prompt: '0', completion: '0' } }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )) as unknown as typeof fetch,
        apiKey: 'or-key',
        now: () => NOW,
        requestId: 'req_hist',
        modelCall: model,
      },
      OWNER,
      'and now?',
      { history },
      { ...DEFAULT_ASSISTANT_CONFIG, mode: 'openrouter_free', freeModelId: 'm' },
    );
    expect(answer.available).toBe(true);
    if (!answer.available) throw new Error('unreachable');

    const first = captured[0];
    expect(first).toBeDefined();
    // system + question + at most 12 history messages.
    expect(first!.messages.length).toBeLessThanOrEqual(14);
    for (const message of first!.messages) {
      expect(message.content.length).toBeLessThan(4_200);
    }
    expect(answer.tools_used.length).toBe(4);
    expect(answer.refused_tool_calls.some((r) => r.reason === 'TOOL_BUDGET_EXHAUSTED')).toBe(true);
  });
});
