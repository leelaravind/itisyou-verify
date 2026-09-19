/**
 * Owner approvals — what was approved, how much, by whom, and when.
 *
 * A12 already solved this for one action type: `bindApproval` in
 * `apps/app/src/growth/approval.ts` binds a campaign approval to a hash over the exact
 * packet the owner read, so a penny's difference stops the approval applying. That work is
 * not re-implemented here — `bindCampaignApproval` below delegates to it verbatim.
 *
 * What this module adds is the other three things the owner approves, which A12's packet
 * shape does not describe: a **refund**, a **budget limit change**, and a **cleanup run**.
 * They use the same mechanism — `stableStringify` + `sha256Hex` over a canonical payload,
 * domain-prefixed per action type — so an approval minted for one action can never be
 * replayed as another even if the payloads happened to serialise identically.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **The hash is computed from the server's view of the payload**, never from anything
 *     the browser posted back and never from text a model emitted. The caller passes the
 *     resolved amounts; there is no path here that accepts a number from a form.
 *  2. **An approval expires.** `expires_at` is required, not optional, and
 *     `checkApproval` refuses an expired one before it looks at anything else that could
 *     be mistaken for a pass.
 *  3. **The record says what was approved in words as well as in a hash.** A hash is not
 *     an audit trail. Every approval carries a `summary` a person can read a year later.
 */
import type { Currency } from '@verify/contracts';
import { sha256Hex, stableStringify } from '@verify/security';
import {
  bindApproval,
  isApprovalValidFor,
  type ApprovalCheck,
  type ApprovalStatus,
  type BindApprovalInput,
  type CampaignApproval,
  type CampaignPacket,
} from '../growth/approval.js';

export type { ApprovalStatus, CampaignApproval, ApprovalCheck };

/** How long an owner approval stands before it must be granted again. */
export const APPROVAL_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * The action types an owner can approve. Closed set: a new consequential action adds a
 * member here and gets its own canonical payload, rather than borrowing somebody else's.
 */
export const OWNER_ACTION_TYPES = [
  'campaign_launch',
  'refund_issue',
  'budget_limit_change',
  'cleanup_execute',
] as const;

export type OwnerActionType = (typeof OWNER_ACTION_TYPES)[number];

export function isOwnerActionType(value: string): value is OwnerActionType {
  return (OWNER_ACTION_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Canonical payloads
// ---------------------------------------------------------------------------

/** A refund, as the owner reads it before approving. Integer minor units only. */
export interface RefundApprovalPayload {
  readonly workspace_id: string;
  readonly order_id: string;
  readonly amount_minor: number;
  readonly currency: Currency;
  /** The rule being applied, from the published refund policy. Not free text. */
  readonly policy_rule: string;
  readonly reason: string;
}

/** A change to an approved spending ceiling. */
export interface BudgetLimitApprovalPayload {
  readonly account_scope: string;
  readonly current_limit_minor: number;
  readonly proposed_limit_minor: number;
  readonly currency: Currency;
  readonly justification: string;
}

/** A cleanup run, bound to the inventory that was previewed. */
export interface CleanupApprovalPayload {
  readonly categories: readonly string[];
  readonly inventory_hash: string;
  readonly resource_count: number;
  readonly environment: string;
}

export type OwnerApprovalPayload =
  | { readonly action_type: 'refund_issue'; readonly payload: RefundApprovalPayload }
  | { readonly action_type: 'budget_limit_change'; readonly payload: BudgetLimitApprovalPayload }
  | { readonly action_type: 'cleanup_execute'; readonly payload: CleanupApprovalPayload };

function assertMinor(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${name} must be an integer number of minor units, received: ${String(value)}`,
    );
  }
}

/**
 * Exactly the fields the approval covers, in a shape `stableStringify` will sort. Arrays
 * are copied and, where order is not meaningful (cleanup categories), sorted — so the same
 * selection made in a different order is the same approval rather than a new one.
 */
export function canonicalOwnerPayload(input: OwnerApprovalPayload): Record<string, unknown> {
  switch (input.action_type) {
    case 'refund_issue': {
      const p = input.payload;
      assertMinor('amount_minor', p.amount_minor);
      return {
        workspace_id: p.workspace_id,
        order_id: p.order_id,
        amount_minor: p.amount_minor,
        currency: p.currency,
        policy_rule: p.policy_rule,
        reason: p.reason,
      };
    }
    case 'budget_limit_change': {
      const p = input.payload;
      assertMinor('current_limit_minor', p.current_limit_minor);
      assertMinor('proposed_limit_minor', p.proposed_limit_minor);
      return {
        account_scope: p.account_scope,
        current_limit_minor: p.current_limit_minor,
        proposed_limit_minor: p.proposed_limit_minor,
        currency: p.currency,
        justification: p.justification,
      };
    }
    case 'cleanup_execute': {
      const p = input.payload;
      return {
        categories: [...p.categories].sort(),
        inventory_hash: p.inventory_hash,
        resource_count: p.resource_count,
        environment: p.environment,
      };
    }
    default: {
      // Exhaustiveness: adding an action type without a canonical payload will not compile.
      const never: never = input;
      throw new TypeError(`no canonical payload for ${JSON.stringify(never)}`);
    }
  }
}

/** Domain-prefixed per action type, so one action's hash can never authorise another's. */
export async function ownerPayloadHash(input: OwnerApprovalPayload): Promise<string> {
  return sha256Hex(
    `verify.approval.v1.${input.action_type}:${stableStringify(canonicalOwnerPayload(input))}`,
  );
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface OwnerApproval {
  readonly id: string;
  readonly action_type: OwnerActionType;
  readonly owner_id: string;
  readonly canonical_payload_hash: string;
  /** Gross ceiling this approval authorises, or null where the action moves no money. */
  readonly maximum_amount_minor: number | null;
  readonly currency: Currency | null;
  readonly status: ApprovalStatus;
  /** What the owner actually read, in one sentence. A hash is not an audit trail. */
  readonly summary: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

export interface GrantApprovalInput {
  readonly id: string;
  readonly owner_id: string;
  /** Resolved server-side. Never a number that arrived in a form field. */
  readonly maximum_amount_minor: number | null;
  readonly currency: Currency | null;
  readonly summary: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/**
 * Grant an approval over a payload the server assembled.
 *
 * The maximum is checked against the payload where the payload carries an amount: an
 * approval can never authorise less than the thing it approves, which is the mistake that
 * quietly lets a partial approval through.
 */
export async function grantOwnerApproval(
  input: OwnerApprovalPayload,
  grant: GrantApprovalInput,
): Promise<OwnerApproval> {
  if (grant.maximum_amount_minor !== null) {
    assertMinor('maximum_amount_minor', grant.maximum_amount_minor);
    if (grant.maximum_amount_minor < 0) {
      throw new TypeError('maximum_amount_minor must not be negative');
    }
  }
  if (input.action_type === 'refund_issue') {
    if (
      grant.maximum_amount_minor === null ||
      grant.maximum_amount_minor < input.payload.amount_minor
    ) {
      throw new TypeError(
        `maximum_amount_minor ${String(grant.maximum_amount_minor)} is below the refund amount ${input.payload.amount_minor}`,
      );
    }
  }
  if (input.action_type === 'budget_limit_change') {
    if (
      grant.maximum_amount_minor === null ||
      grant.maximum_amount_minor < input.payload.proposed_limit_minor
    ) {
      throw new TypeError(
        `maximum_amount_minor ${String(grant.maximum_amount_minor)} is below the proposed limit ${input.payload.proposed_limit_minor}`,
      );
    }
  }
  if (Date.parse(grant.expires_at) <= Date.parse(grant.created_at)) {
    throw new TypeError('an approval must expire after it is created');
  }

  return {
    id: grant.id,
    action_type: input.action_type,
    owner_id: grant.owner_id,
    canonical_payload_hash: await ownerPayloadHash(input),
    maximum_amount_minor: grant.maximum_amount_minor,
    currency: grant.currency,
    status: 'granted',
    summary: grant.summary,
    created_at: grant.created_at,
    expires_at: grant.expires_at,
    consumed_at: null,
  };
}

export type OwnerApprovalRejection =
  | 'action_type_mismatch'
  | 'status_not_granted'
  | 'expired'
  | 'payload_changed'
  | 'currency_mismatch'
  | 'amount_exceeds_approved_maximum';

export type OwnerApprovalCheck =
  | { readonly valid: true; readonly hash: string }
  | { readonly valid: false; readonly reason: OwnerApprovalRejection; readonly detail: string };

/**
 * Does this approval authorise this payload, right now?
 *
 * Expiry is checked before the hash deliberately: an owner whose approval lapsed should be
 * told it lapsed, not told the payload changed when it did not.
 */
export async function checkOwnerApproval(
  approval: OwnerApproval,
  input: OwnerApprovalPayload,
  now: Date = new Date(),
): Promise<OwnerApprovalCheck> {
  if (approval.action_type !== input.action_type) {
    return {
      valid: false,
      reason: 'action_type_mismatch',
      detail: `this approval covers ${approval.action_type}, not ${input.action_type}`,
    };
  }
  if (approval.status !== 'granted') {
    return {
      valid: false,
      reason: 'status_not_granted',
      detail: `approval status is ${approval.status}`,
    };
  }
  const expiry = Date.parse(approval.expires_at);
  if (Number.isNaN(expiry) || now.getTime() > expiry) {
    return {
      valid: false,
      reason: 'expired',
      detail: `approval expired at ${approval.expires_at}`,
    };
  }

  const monetary: { readonly amount: number; readonly currency: Currency } | null =
    input.action_type === 'refund_issue'
      ? { amount: input.payload.amount_minor, currency: input.payload.currency }
      : input.action_type === 'budget_limit_change'
        ? { amount: input.payload.proposed_limit_minor, currency: input.payload.currency }
        : null;

  if (monetary !== null && approval.currency !== monetary.currency) {
    return {
      valid: false,
      reason: 'currency_mismatch',
      detail: `approved in ${String(approval.currency)}, payload says ${monetary.currency}`,
    };
  }

  const hash = await ownerPayloadHash(input);
  if (hash !== approval.canonical_payload_hash) {
    return {
      valid: false,
      reason: 'payload_changed',
      detail: 'something in the approved payload has changed since the owner read it',
    };
  }

  if (monetary !== null) {
    if (approval.maximum_amount_minor === null || monetary.amount > approval.maximum_amount_minor) {
      return {
        valid: false,
        reason: 'amount_exceeds_approved_maximum',
        detail: `payload amount ${monetary.amount} exceeds approved maximum ${String(approval.maximum_amount_minor)}`,
      };
    }
  }

  return { valid: true, hash };
}

// ---------------------------------------------------------------------------
// Campaign approvals — A12's, unchanged
// ---------------------------------------------------------------------------

/**
 * Bind a campaign approval. This is A12's `bindApproval` and nothing else: the packet
 * hash, the expansion rules and the rejection vocabulary are all theirs. Re-deriving them
 * here would be a second implementation of the one thing that must have exactly one.
 */
export async function bindCampaignApproval(
  packet: CampaignPacket,
  input: BindApprovalInput,
): Promise<CampaignApproval> {
  return bindApproval(packet, input);
}

/** A12's validity check, re-exported so owner routes have one import for approvals. */
export async function checkCampaignApproval(
  approval: CampaignApproval,
  packet: CampaignPacket,
  now: Date = new Date(),
): Promise<ApprovalCheck> {
  return isApprovalValidFor(approval, packet, now);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * A rejection turned into something an owner can act on. Never a bare reason code — the
 * same rule `@verify/domain`'s `explain.ts` follows for verification reasons.
 */
const REJECTION_TEXT: Record<ClaimRejection, string> = {
  already_consumed:
    'This approval has already been used. Each one authorises a single action once; approve it again if you genuinely want it to happen a second time.',
  action_type_mismatch:
    'This approval was granted for a different kind of action, so it does not authorise this one.',
  status_not_granted:
    'This approval has already been used, or it was withdrawn. Approve the action again if you still want it to happen.',
  expired:
    'This approval has expired. Approvals lapse so that something agreed yesterday cannot be carried out today without you looking again.',
  payload_changed:
    'Something changed after you approved it — an amount, a date, a destination or the list of things involved. Read the new version and approve that instead.',
  currency_mismatch: 'The currency is not the one you approved.',
  amount_exceeds_approved_maximum:
    'The amount is larger than the maximum you approved. Approve the larger amount explicitly if that is what you want.',
};

export function explainApprovalRejection(reason: ClaimRejection): string {
  return REJECTION_TEXT[reason];
}

// ---------------------------------------------------------------------------
// Consumption — the act that authorises
// ---------------------------------------------------------------------------

/**
 * The statement that spends an approval. **The only one.**
 *
 * A10 found the gap this closes (`AUTH-511`): `approvals.status` had a `consumed` state
 * that no code ever wrote, so `checkOwnerApproval` was a check-then-act. Two requests
 * carrying the same approval both saw `granted`, both passed, and both proceeded. The
 * exposure was bounded — `refunds.idempotency_key` is `UNIQUE` and the payload hash binds
 * an approval to one specific refund, so a replay could only re-submit the same refund —
 * but a single-use control that is not actually single-use is not a control, and the
 * missing `consumed_at` is a missing audit fact about who spent what and when.
 *
 * So consumption *is* the authorisation. The guard is the row count, not a prior read:
 *
 *     UPDATE approvals SET status = 'consumed', consumed_at = ?
 *      WHERE id = ? AND status = 'granted' AND expires_at > ?
 *
 * `meta.changes === 1` is the permission. The loser of a race gets zero rows and stops.
 * Check-then-act becomes compare-and-set — the same shape `sessions.rotate` and the budget
 * movements already use, for the same reason.
 *
 * The literal lives here, beside the rules it enforces, because an approval's single-use
 * guarantee is an approval rule and not a storage detail. A second spelling of it anywhere
 * else is a defect.
 */
export const CLAIM_APPROVAL_SQL = `UPDATE approvals SET status = 'consumed', consumed_at = ?
    WHERE id = ? AND status = 'granted' AND expires_at > ?`;

/**
 * The compare-and-set, as a one-method port so this module stays free of a database handle.
 *
 * An implementation runs {@link CLAIM_APPROVAL_SQL} and returns `meta.changes === 1`. It
 * must never re-read and compare: returning true because the row *looks* consumed after the
 * fact reintroduces exactly the race this exists to remove.
 */
export interface ApprovalClaimStore {
  claim(params: { readonly approvalId: string; readonly at: string }): Promise<boolean>;
}

/**
 * The raw compare-and-set: spend this approval, and say whether **this call** spent it.
 *
 * `true` means `meta.changes === 1` — this caller holds the permission. `false` means the
 * approval was already consumed, revoked, expired or absent, and the caller must stop. It
 * never explains which; {@link claimApproval} is the function that can, because it looked.
 *
 * Almost nobody should call this directly. It exists as a named primitive because A10's
 * finding was that the *statement* did not exist anywhere, and because the campaign path
 * binds its payload through A12's hash rather than mine and so cannot use the wrapper.
 */
export async function consumeApproval(
  store: ApprovalClaimStore,
  params: { readonly approvalId: string; readonly at: string },
): Promise<boolean> {
  return store.claim(params);
}

export type ClaimRejection = OwnerApprovalRejection | 'already_consumed';

export type ApprovalClaim =
  | { readonly ok: true; readonly hash: string; readonly consumedAt: string }
  | { readonly ok: false; readonly reason: ClaimRejection; readonly detail: string };

/**
 * Validate **and spend** an approval, in that order, with no gap a second caller can use.
 *
 * There is deliberately no way to get an `ok` from this function without the approval having
 * been consumed: the call site cannot accidentally check and then forget to claim, because
 * the check and the claim are the same call. Anything that moves money should call this and
 * nothing else — `checkOwnerApproval` remains for rendering a page, where nothing is spent.
 *
 * ## Call this BEFORE the provider, never after
 *
 * The ordering is the control, not a detail of it. Consume-after means a crash between the
 * provider call and the write leaves an approval that still looks spendable sitting next to
 * money that has already moved — the one combination that lets the same authorisation be
 * used twice. Consume-before means the worst case is an approval spent on a call that
 * failed: visible, recoverable by granting another, and wrong in the safe direction.
 *
 * A06's `decideRefund` should therefore replace its `checkOwnerApproval` with this call and
 * keep it where the check is now — above `gateway.createRefund`, below the state guard:
 *
 * ```ts
 * const claim = await claimApproval(params.approval, refundApprovalPayload(refund, params.policyRule), {
 *   store: approvalClaims,      // runs CLAIM_APPROVAL_SQL, returns meta.changes === 1
 *   now: new Date(at),
 * });
 * if (!claim.ok) {
 *   throw new AppError(403, 'REFUND_APPROVAL_INVALID',
 *     `This approval does not authorise this refund: ${explainApprovalRejection(claim.reason)}`);
 * }
 * // `claim.consumedAt` is the audit fact: when this approval was spent.
 * ```
 */
export async function claimApproval(
  approval: OwnerApproval,
  input: OwnerApprovalPayload,
  deps: { readonly store: ApprovalClaimStore; readonly now: Date },
): Promise<ApprovalClaim> {
  const check = await checkOwnerApproval(approval, input, deps.now);
  if (!check.valid) {
    return { ok: false, reason: check.reason, detail: check.detail };
  }

  const at = deps.now.toISOString();
  const won = await deps.store.claim({ approvalId: approval.id, at });
  if (!won) {
    return {
      ok: false,
      reason: 'already_consumed',
      detail:
        'This approval was already used. It authorises one action once, so a second attempt — a double-tapped ' +
        'button, a retried request, or someone else acting at the same moment — stops here rather than happening twice.',
    };
  }
  return { ok: true, hash: check.hash, consumedAt: at };
}

/** Is this approval still usable, ignoring any particular payload? For list rendering. */
export function approvalStanding(
  approval: Pick<OwnerApproval, 'status' | 'expires_at'>,
  now: Date,
): 'usable' | 'expired' | 'used' | 'withdrawn' {
  if (approval.status === 'consumed') return 'used';
  if (approval.status === 'revoked') return 'withdrawn';
  const expiry = Date.parse(approval.expires_at);
  if (Number.isNaN(expiry) || now.getTime() > expiry) return 'expired';
  return 'usable';
}
