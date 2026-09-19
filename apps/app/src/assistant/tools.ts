/**
 * The assistant's tools: three reads and three proposals. Nothing else, ever.
 *
 * THE BOUNDARY, STATED PRECISELY
 * ------------------------------
 * A10's instruction, which this file implements: *no assistant tool may write a status, an
 * entitlement, a refund, a role or a budget movement. The approval hash is computed from
 * the server's payload, never from model text.*
 *
 * Concretely:
 *
 *  - Every read tool goes through `AssistantDataPort`, whose interface cannot express a
 *    write and cannot return a raw payload.
 *  - Every `propose_*` tool returns a `Proposal`. It writes nothing — not even a proposal
 *    row. Persisting a proposal, and executing it, is the owner-confirmation path in
 *    `apps/app/src/routes/owner/` and it re-derives the payload again there.
 *  - `canonical_payload_hash` is `sha256Hex(stableStringify(payload))` where `payload` is
 *    built by `buildPayload` from **validated arguments and server-read facts**. The
 *    model's prose is never an input to the hash. `propose_campaign_change` re-reads the
 *    campaign's current budget from the database and refuses outright if it cannot — a
 *    number the model supplied is never the number that gets hashed.
 *  - Every invocation writes an `audit_events` row through A02's repository, with redacted
 *    metadata and `actor_kind = 'automation'`.
 *  - A tool result is JSON, size-capped, and marked when it was truncated.
 *
 * And the structural anti-injection control: `dispatchToolCall` refuses every `propose_*`
 * call when the turn's context contained untrusted text (see `prompt.ts`). A successful
 * injection therefore produces a refusal, not a proposal.
 */
import { sha256Hex, stableStringify } from '@verify/security';
import { auditEvents } from '../db/index.js';
import type { Db } from '../db/d1.js';
import { newId } from '../lib/ids.js';
import {
  isMaintenanceJobKind,
  validateRepoPath,
  MAINTENANCE_JOB_KINDS,
  type MaintenanceJobKind,
} from '../maintenance/kinds.js';
import type { AssistantDataPort } from './port.js';
import { truncate } from './prompt.js';
import {
  ASSISTANT_LIMITS,
  type AssistantActor,
  type Proposal,
  type RefusedToolCall,
  type ToolSchema,
} from './types.js';

export const TOOL_NAMES = [
  'get_summary',
  'list_incidents',
  'explain_run',
  'propose_pause',
  'propose_campaign_change',
  'propose_maintenance_job',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const PROPOSAL_TOOLS: ReadonlySet<string> = new Set([
  'propose_pause',
  'propose_campaign_change',
  'propose_maintenance_job',
]);

/** Tools only a platform owner may call. A workspace member gets the reads and nothing more. */
const OWNER_ONLY: ReadonlySet<string> = new Set([
  'propose_campaign_change',
  'propose_maintenance_job',
]);

export const PAUSE_TARGETS = ['workflow', 'campaign', 'assistant'] as const;
export type PauseTarget = (typeof PAUSE_TARGETS)[number];

// ---------------------------------------------------------------------------
// Schemas advertised to the model
// ---------------------------------------------------------------------------

/**
 * The exact parameter schema of every tool. This is what a provider receives, and it is
 * also the contract the hand-written validators below enforce — the two are kept adjacent
 * on purpose so they cannot drift apart unnoticed.
 */
export const TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: 'get_summary',
    description:
      'Aggregate counts of verification runs by status and connection health for a workspace. Counts only; no customer records.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window_days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
      },
      required: [],
    },
  },
  {
    name: 'list_incidents',
    description:
      'Open operational incidents: degraded connections and failed maintenance jobs, as machine reason codes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      required: [],
    },
  },
  {
    name: 'explain_run',
    description:
      'The status, timings and per-assertion reason codes of one verification run. Never returns evidence bodies or provider payloads.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', minLength: 3, maxLength: 64 },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'propose_pause',
    description:
      'Propose pausing a workflow, a campaign or the assistant itself. Returns a proposal for a human to confirm; it changes nothing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: [...PAUSE_TARGETS] },
        target_id: { type: 'string', minLength: 1, maxLength: 64 },
        reason: { type: 'string', minLength: 1, maxLength: 280 },
      },
      required: ['target', 'target_id', 'reason'],
    },
  },
  {
    name: 'propose_campaign_change',
    description:
      'Propose a change to an advertising campaign. The server re-reads the current budget and re-prices the change; any amount in the arguments is treated as a request, never as the value.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        campaign_id: { type: 'string', minLength: 1, maxLength: 64 },
        requested_budget_minor: { type: 'integer', minimum: 0, maximum: 100_000_000 },
        note: { type: 'string', maxLength: 280 },
      },
      required: ['campaign_id'],
    },
  },
  {
    name: 'propose_maintenance_job',
    description:
      'Propose queueing a typed maintenance job for the owner’s local runner. The kind must come from the fixed allowlist; free text becomes a brief that a human reviews.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...MAINTENANCE_JOB_KINDS] },
        summary: { type: 'string', minLength: 1, maxLength: 200 },
        paths: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', maxLength: 200 },
        },
      },
      required: ['kind', 'summary'],
    },
  },
];

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

type Validated =
  { readonly ok: true; readonly args: Args } | { readonly ok: false; readonly detail: string };

function asObject(raw: unknown): Args {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Args;
}

function integerIn(
  value: unknown,
  min: number,
  max: number,
  fallback: number | null,
): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Validate a tool's arguments. Rejects unknown keys as well as bad values — a model that
 * invents a parameter is a model whose call we do not run.
 */
export function validateToolArguments(name: string, raw: unknown): Validated {
  const args = asObject(raw);
  const schema = TOOL_SCHEMAS.find((tool) => tool.name === name);
  if (schema === undefined) return { ok: false, detail: 'unknown tool' };

  const properties =
    (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      return { ok: false, detail: `unexpected argument ${key}` };
    }
  }

  switch (name) {
    case 'get_summary': {
      const windowDays = integerIn(args['window_days'], 1, 90, 7);
      if (windowDays === null) return { ok: false, detail: 'window_days must be 1..90' };
      return { ok: true, args: { window_days: windowDays } };
    }
    case 'list_incidents': {
      const limit = integerIn(args['limit'], 1, 20, 5);
      if (limit === null) return { ok: false, detail: 'limit must be 1..20' };
      return { ok: true, args: { limit } };
    }
    case 'explain_run': {
      const runId = shortString(args['run_id'], 64);
      if (runId === null) return { ok: false, detail: 'run_id is required' };
      return { ok: true, args: { run_id: runId } };
    }
    case 'propose_pause': {
      const target = shortString(args['target'], 32);
      if (target === null || !(PAUSE_TARGETS as readonly string[]).includes(target)) {
        return { ok: false, detail: 'target must be workflow, campaign or assistant' };
      }
      const targetId = shortString(args['target_id'], 64);
      if (targetId === null) return { ok: false, detail: 'target_id is required' };
      const reason = shortString(args['reason'], 280);
      if (reason === null) return { ok: false, detail: 'reason is required' };
      return { ok: true, args: { target, target_id: targetId, reason } };
    }
    case 'propose_campaign_change': {
      const campaignId = shortString(args['campaign_id'], 64);
      if (campaignId === null) return { ok: false, detail: 'campaign_id is required' };
      const requested = integerIn(args['requested_budget_minor'], 0, 100_000_000, null);
      if (args['requested_budget_minor'] !== undefined && requested === null) {
        return { ok: false, detail: 'requested_budget_minor must be a non-negative integer' };
      }
      const note = args['note'] === undefined ? '' : shortString(args['note'], 280);
      if (note === null) return { ok: false, detail: 'note must be 1..280 characters' };
      return {
        ok: true,
        args: {
          campaign_id: campaignId,
          ...(requested === null ? {} : { requested_budget_minor: requested }),
          note,
        },
      };
    }
    case 'propose_maintenance_job': {
      const kind = args['kind'];
      if (!isMaintenanceJobKind(kind))
        return { ok: false, detail: 'kind is not an allowed job kind' };
      const summary = shortString(args['summary'], 200);
      if (summary === null) return { ok: false, detail: 'summary is required' };
      const rawPaths = args['paths'];
      const paths: string[] = [];
      if (rawPaths !== undefined) {
        if (!Array.isArray(rawPaths) || rawPaths.length > 20) {
          return { ok: false, detail: 'paths must be an array of at most 20 repository paths' };
        }
        for (const candidate of rawPaths) {
          const check = validateRepoPath(candidate);
          // A traversal attempt refuses the whole call. It is never silently dropped.
          if (!check.ok) return { ok: false, detail: `rejected path (${check.reason})` };
          paths.push(check.path);
        }
      }
      return { ok: true, args: { kind, summary, paths } };
    }
    default:
      return { ok: false, detail: 'unknown tool' };
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly db: Db;
  readonly port: AssistantDataPort;
  readonly actor: AssistantActor;
  readonly now: string;
  /** False when the turn ingested untrusted text. Proposals are then refused outright. */
  readonly proposalsAllowed: boolean;
}

export type ToolOutcome =
  | { readonly ok: true; readonly result: string; readonly proposal: Proposal | null }
  | { readonly ok: false; readonly refusal: RefusedToolCall };

/** Serialise a tool result, capped, with truncation stated rather than hidden. */
export function encodeToolResult(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null';
  if (text.length <= ASSISTANT_LIMITS.MAX_TOOL_RESULT_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    original_length: text.length,
    body: truncate(text, ASSISTANT_LIMITS.MAX_TOOL_RESULT_CHARS),
  });
}

/**
 * Build a proposal. `payload` is the server's, and the hash is over the server's.
 *
 * `summary` is composed here from the payload by a template. It exists so a human sees the
 * same words the server will act on — not the model's description of what it meant.
 */
async function buildProposal(
  actionType: string,
  payload: Record<string, unknown>,
  summary: string,
  now: string,
): Promise<Proposal> {
  const canonical = stableStringify(payload);
  return {
    proposal_id: newId('prp'),
    action_type: actionType,
    summary,
    payload,
    canonical_payload_hash: await sha256Hex(canonical),
    requires_approval: true,
    status: 'proposed',
    created_at: now,
  };
}

async function recordInvocation(
  context: ToolContext,
  name: string,
  outcome: 'executed' | 'refused',
  detail: string,
): Promise<void> {
  try {
    await auditEvents.record(context.db, {
      id: newId('aud'),
      actor: context.actor.userId,
      actorKind: 'automation',
      action: `assistant.tool.${name}`,
      occurredAt: context.now,
      workspaceId: context.actor.workspaceId,
      target: outcome,
      // Reason codes and tool names only. Never arguments, never customer text.
      redactedMetadata: JSON.stringify({ outcome, detail: detail.slice(0, 120) }),
    });
  } catch {
    // An audit write that fails must not make the tool appear to have succeeded silently,
    // but it also must not crash the turn. The caller sees the tool result; the operator
    // sees the missing row. Deliberately not swallowed any further than this.
  }
}

/**
 * Run one tool call, with every gate in order.
 *
 * Order matters and is the security property: unknown tool, then untrusted-context refusal
 * for proposals, then permission, then argument validation, and only then any read.
 */
export async function dispatchToolCall(
  context: ToolContext,
  call: { readonly name: string; readonly arguments: unknown },
): Promise<ToolOutcome> {
  const name = call.name;

  if (!(TOOL_NAMES as readonly string[]).includes(name)) {
    await recordInvocation(context, name.slice(0, 60), 'refused', 'unknown tool');
    return {
      ok: false,
      refusal: { name, reason: 'UNKNOWN_TOOL', detail: 'not a registered tool' },
    };
  }

  if (PROPOSAL_TOOLS.has(name) && !context.proposalsAllowed) {
    await recordInvocation(context, name, 'refused', 'untrusted context');
    return {
      ok: false,
      refusal: {
        name,
        reason: 'PROPOSALS_DISABLED_UNTRUSTED_CONTEXT',
        detail:
          'this turn read text from a customer, a provider or a ticket, so it cannot produce a proposal',
      },
    };
  }

  if (OWNER_ONLY.has(name) && !context.actor.isPlatformOwner) {
    await recordInvocation(context, name, 'refused', 'not platform owner');
    return {
      ok: false,
      refusal: { name, reason: 'NOT_PERMITTED', detail: 'this tool is owner-only' },
    };
  }

  const validated = validateToolArguments(name, call.arguments);
  if (!validated.ok) {
    await recordInvocation(context, name, 'refused', validated.detail);
    return {
      ok: false,
      refusal: { name, reason: 'INVALID_ARGUMENTS', detail: validated.detail },
    };
  }
  const args = validated.args;

  switch (name as ToolName) {
    case 'get_summary': {
      const summary = await context.port.summary(
        context.actor.workspaceId,
        args['window_days'] as number,
        context.now,
      );
      await recordInvocation(context, name, 'executed', 'summary');
      return { ok: true, result: encodeToolResult(summary), proposal: null };
    }

    case 'list_incidents': {
      const incidents = await context.port.incidents(
        context.actor.workspaceId,
        args['limit'] as number,
      );
      await recordInvocation(context, name, 'executed', `${incidents.length} incidents`);
      return { ok: true, result: encodeToolResult({ incidents }), proposal: null };
    }

    case 'explain_run': {
      if (context.actor.workspaceId === null) {
        await recordInvocation(context, name, 'refused', 'no workspace in scope');
        return {
          ok: false,
          refusal: { name, reason: 'NOT_PERMITTED', detail: 'no workspace is in scope' },
        };
      }
      // Scoped by the caller's own workspace, resolved from the session — never from an
      // argument. A run id from another tenant simply is not found.
      const explanation = await context.port.explainRun(
        context.actor.workspaceId,
        args['run_id'] as string,
      );
      await recordInvocation(
        context,
        name,
        'executed',
        explanation === null ? 'not found' : 'found',
      );
      return {
        ok: true,
        result: encodeToolResult(explanation ?? { error: 'run not found in this workspace' }),
        proposal: null,
      };
    }

    case 'propose_pause': {
      const payload = {
        action: 'pause',
        target: args['target'],
        target_id: args['target_id'],
        // The reason is carried for the human reviewer; it is part of the hashed payload
        // so a confirmation cannot be replayed against a different stated reason.
        reason: args['reason'],
        proposed_by: 'assistant',
        proposed_at: context.now,
      };
      const proposal = await buildProposal(
        'assistant.pause',
        payload,
        `Pause ${String(args['target'])} ${String(args['target_id'])}`,
        context.now,
      );
      await recordInvocation(
        context,
        name,
        'executed',
        proposal.canonical_payload_hash.slice(0, 16),
      );
      return { ok: true, result: encodeToolResult(proposal), proposal };
    }

    case 'propose_campaign_change': {
      const facts = await context.port.campaignFacts(args['campaign_id'] as string);
      if (facts === null) {
        // The server cannot re-price it, so it will not propose it. A number from the
        // model is never a substitute for the number in the database.
        await recordInvocation(context, name, 'refused', 'campaign facts unavailable');
        return {
          ok: false,
          refusal: {
            name,
            reason: 'NOT_PERMITTED',
            detail: 'the server cannot read this campaign, so it cannot re-price a change to it',
          },
        };
      }
      const requested = args['requested_budget_minor'];
      const payload = {
        action: 'campaign_change',
        campaign_id: facts.campaign_id,
        currency: facts.currency,
        // Both numbers come from the server's read; the model's request is recorded
        // separately so a reviewer can see what was asked for versus what is proposed.
        current_budget_minor: facts.current_budget_minor,
        requested_budget_minor: typeof requested === 'number' ? requested : null,
        note: args['note'],
        proposed_by: 'assistant',
        proposed_at: context.now,
      };
      const proposal = await buildProposal(
        'assistant.campaign_change',
        payload,
        `Change campaign ${facts.campaign_id} budget from ${facts.current_budget_minor} ${facts.currency} minor units`,
        context.now,
      );
      await recordInvocation(
        context,
        name,
        'executed',
        proposal.canonical_payload_hash.slice(0, 16),
      );
      return { ok: true, result: encodeToolResult(proposal), proposal };
    }

    case 'propose_maintenance_job': {
      const kind = args['kind'] as MaintenanceJobKind;
      const enabled = await context.port.maintenanceKindEnabled(kind);
      if (!enabled) {
        await recordInvocation(context, name, 'refused', 'kind disabled');
        return {
          ok: false,
          refusal: { name, reason: 'NOT_PERMITTED', detail: `${kind} is not enabled` },
        };
      }
      const payload = {
        action: 'maintenance_job',
        typed_kind: kind,
        // The free text becomes a brief that still needs a human to mark reviewed. It is
        // data on the job row; nothing turns it into a command.
        brief_summary: args['summary'],
        brief_review_state: 'needs_review',
        paths: args['paths'],
        proposed_by: 'assistant',
        proposed_at: context.now,
      };
      const proposal = await buildProposal(
        'assistant.maintenance_job',
        payload,
        `Queue maintenance job ${kind} (brief needs review)`,
        context.now,
      );
      await recordInvocation(
        context,
        name,
        'executed',
        proposal.canonical_payload_hash.slice(0, 16),
      );
      return { ok: true, result: encodeToolResult(proposal), proposal };
    }

    default:
      return {
        ok: false,
        refusal: { name, reason: 'UNKNOWN_TOOL', detail: 'not a registered tool' },
      };
  }
}
