/**
 * The proof run — "show me this actually works, on my data, before I pay".
 *
 * A02 refused to implement this and gave the right reason: a green tick from an empty
 * rule set is the most dangerous output this product could produce. This module is the
 * connector side of a proof that cannot produce one.
 *
 * What a proof run is: we take the customer's *configured rules*, point them at a record
 * they tell us already exists, fetch the evidence for it from the connected accounts, and
 * report — assertion by assertion — what we could prove and what we could not.
 *
 * What a proof run is not: a rehearsal with invented evidence. The evidence is real, read
 * back from the customer's own provider account with their own credential. That is the
 * only thing that makes the answer worth anything.
 *
 * Three refusals are built in, and each returns `ran: false` with a reason rather than a
 * result anyone could mistake for a pass:
 *
 *   1. No required checks. A pass against nothing means nothing.
 *   2. A rule reads from a source that is not connected. We name the source rather than
 *      quietly scoring that rule as unknown and letting the total look nearly fine.
 *   3. Nothing to look up. Without a record id or a correlation value there is no
 *      observation to make, only a guess to avoid.
 *
 * And one deliberate conservatism: **a proof run never reports FAILED because something
 * was absent.** Absence becomes a failure only at a real deadline, in a real run. At proof
 * time the honest words are "we could not prove this", and `notProved` carries them as a
 * first-class result rather than an empty space where a pass should have been.
 */
import {
  assertEvaluableRules,
  decideRunStatus,
  evaluateAssertions,
  explainAssertion,
  explainRunStatus,
  type AssertionResult,
} from '@verify/domain';
import type {
  EvidenceGap,
  EvidenceOrigin,
  ReasonCode,
  RunStatus,
  WorkflowRules,
} from '@verify/contracts';
import { getConnector, type ConnectorRuntimeOptions } from './registry.js';
import {
  toEvidenceBundle,
  type ConnectionConfig,
  type ConnectorCredentials,
  type ConnectorFetchResult,
  type EvidenceLocator,
  type ProviderId,
} from './types.js';

/** One connected account the proof may read from. */
export interface ProofSource {
  readonly provider: ProviderId;
  readonly credentials: ConnectorCredentials;
  readonly connection: ConnectionConfig;
}

export interface ProofRunInput {
  readonly rules: WorkflowRules;
  /** What the customer says identifies the record and the message. A locator, never a fact. */
  readonly locator: EvidenceLocator;
  /** The connected CRM, or null when the customer has not connected one. */
  readonly crm: ProofSource | null;
  /** The connected email provider, or null. */
  readonly email: ProofSource | null;
  /** The business event's own timestamp — the instant the rules measure from. */
  readonly occurredAt: Date;
  readonly now: Date;
  readonly runtime?: ConnectorRuntimeOptions | undefined;
}

/** One thing the proof could not establish, said out loud. */
export interface ProofShortfall {
  readonly rule_id: string;
  readonly label: string;
  /** True when this shortfall would block a real run from being VERIFIED. */
  readonly blocking: boolean;
  readonly reason_code: ReasonCode;
  /** A05 renders these verbatim; they come from A03's explanation table. */
  readonly sentence: string;
  readonly next_step: string | null;
  readonly detail: string;
}

/** What one connected account contributed, and what it could not. */
export interface ProofSourceReport {
  readonly provider: ProviderId;
  readonly connected: boolean;
  /** The account the evidence was actually attributed to. */
  readonly accountId: string | null;
  /** Whether the stored account and the live one agreed, when we could tell. */
  readonly accountMatchedConnection: boolean | null;
  readonly evidenceCount: number;
  /** Distinct origins observed. `customer_claim` appearing here would be a defect. */
  readonly origins: readonly EvidenceOrigin[];
  readonly gaps: readonly EvidenceGap[];
  readonly callsMade: number;
}

export interface ProofRunResult {
  readonly ran: boolean;
  readonly status: RunStatus | null;
  readonly statusReason: string | null;
  readonly results: readonly AssertionResult[];
  /** Rules we genuinely proved, with independent evidence. */
  readonly proved: readonly { readonly rule_id: string; readonly label: string }[];
  /** Rules we could not prove. Never empty when `status` is anything but VERIFIED. */
  readonly notProved: readonly ProofShortfall[];
  readonly sources: readonly ProofSourceReport[];
  /** Why nothing ran. Non-null exactly when `ran` is false. */
  readonly blockedReason: string | null;
  /** One sentence a customer can read, true in every branch. */
  readonly summary: string;
  readonly callsMade: number;
}

const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = Object.freeze({
  hubspot: 'HubSpot',
  resend: 'Resend',
});

function blocked(reason: string, sources: readonly ProofSourceReport[] = []): ProofRunResult {
  return {
    ran: false,
    status: null,
    statusReason: null,
    results: [],
    proved: [],
    notProved: [],
    sources,
    blockedReason: reason,
    summary: reason,
    callsMade: 0,
  };
}

function disconnectedReport(provider: ProviderId): ProofSourceReport {
  return {
    provider,
    connected: false,
    accountId: null,
    accountMatchedConnection: null,
    evidenceCount: 0,
    origins: [],
    gaps: [],
    callsMade: 0,
  };
}

function reportFor(source: ProofSource, result: ConnectorFetchResult): ProofSourceReport {
  const origins = [...new Set(result.evidence.map((e) => e.origin))];
  const stored = source.connection.account_id;
  return {
    provider: source.provider,
    connected: true,
    accountId: result.provider_account_id,
    accountMatchedConnection:
      stored === null || result.provider_account_id === null
        ? null
        : stored === result.provider_account_id,
    evidenceCount: result.evidence.length,
    origins,
    gaps: result.gaps,
    callsMade: result.calls_made,
  };
}

/**
 * Run a proof against real connected accounts.
 *
 * Every external call goes through the connectors, which means through the guarded fetch,
 * the fixed host allowlist and A03's retry planner. A proof run is bounded by exactly the
 * same budget as any other observation; it is not a privileged path.
 */
export async function runProof(input: ProofRunInput): Promise<ProofRunResult> {
  const { rules, locator } = input;

  // --- refusal 1: nothing is actually required ----------------------------
  const mandatory = rules.assertions.filter((a) => a.mandatory);
  if (mandatory.length === 0) {
    return blocked(
      'Nothing was checked. This workflow has no required checks, so a pass would not mean anything. Mark at least one check as required first.',
    );
  }

  try {
    assertEvaluableRules(rules);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the rules could not be read';
    return blocked(`Nothing was checked. These rules cannot be evaluated: ${message}`);
  }

  // --- refusal 2: a rule reads from a source that is not connected ---------
  const needsCrm = rules.assertions.some((a) => a.source === 'crm_record');
  const needsEmail = rules.assertions.some((a) => a.source === 'email_event');
  const missing: string[] = [];
  if (needsCrm && input.crm === null) missing.push('your CRM');
  if (needsEmail && input.email === null) missing.push('your email provider');
  if (missing.length > 0) {
    const sources: ProofSourceReport[] = [];
    if (needsCrm && input.crm === null) sources.push(disconnectedReport('hubspot'));
    if (needsEmail && input.email === null) sources.push(disconnectedReport('resend'));
    return blocked(
      `Nothing was checked. Your checks read from ${missing.join(' and ')}, which ${missing.length === 1 ? 'is' : 'are'} not connected yet. We will not score a check we had no way of looking at.`,
      sources,
    );
  }

  // --- refusal 3: nothing to look up --------------------------------------
  if (needsCrm) {
    const hasCrmLocator =
      (typeof locator.record_id === 'string' && locator.record_id !== '') ||
      (typeof locator.correlation_value === 'string' && locator.correlation_value !== '');
    if (!hasCrmLocator) {
      return blocked(
        'Nothing was checked. We need either a CRM record id or the reference your automation writes into the correlation property, so that we know which record to look at. Guessing is not an option we offer.',
      );
    }
  }
  if (needsEmail) {
    const hasEmailLocator = typeof locator.message_id === 'string' && locator.message_id !== '';
    if (!hasEmailLocator) {
      return blocked(
        `Nothing was checked. ${PROVIDER_NAME.resend} cannot be searched, so we need the message id your automation recorded when it sent the acknowledgement. Without it there is nothing to read back.`,
      );
    }
  }

  // --- the observation ----------------------------------------------------
  const fetched: ConnectorFetchResult[] = [];
  const sources: ProofSourceReport[] = [];

  const crmSource = needsCrm ? input.crm : null;
  if (crmSource !== null) {
    const connector = getConnector(crmSource.provider, input.runtime ?? {});
    const result = await connector.fetchEvidence({
      credentials: crmSource.credentials,
      connection: crmSource.connection,
      locator,
      occurredAt: input.occurredAt,
      now: input.now,
      requiredProperties: crmPropertiesFor(rules),
    });
    fetched.push(result);
    sources.push(reportFor(crmSource, result));
  }

  const emailSource = needsEmail ? input.email : null;
  if (emailSource !== null) {
    const connector = getConnector(emailSource.provider, input.runtime ?? {});
    const result = await connector.fetchEvidence({
      credentials: emailSource.credentials,
      connection: emailSource.connection,
      locator,
      occurredAt: input.occurredAt,
      now: input.now,
    });
    fetched.push(result);
    sources.push(reportFor(emailSource, result));
  }

  const bundle = toEvidenceBundle(fetched);
  const results = evaluateAssertions(rules, bundle, {
    occurredAt: input.occurredAt,
    now: input.now,
    connectedCrmAccountId: crmSource?.connection.account_id ?? null,
    connectedEmailAccountId: emailSource?.connection.account_id ?? null,
  });

  // A proof is one look, never a deadline. The deadline is placed deliberately in the
  // future and the observation budget deliberately at zero, which makes
  // `decideRunStatus` resolve an unproven check as UNVERIFIED rather than FAILED. A
  // contradiction still fails, because a contradiction is a fact and does not need a
  // deadline to become one.
  const deadlineAt = new Date(
    Math.max(
      input.occurredAt.getTime() + rules.deadline_seconds * 1000,
      input.now.getTime() + 1000,
    ),
  );
  const hasWorkingEvidenceAccess = bundle.gaps.every((gap) => gap.code === 'NOT_FOUND');
  const decision = decideRunStatus(results, {
    deadlineAt,
    now: input.now,
    hasWorkingEvidenceAccess,
    observationsRemaining: 0,
  });

  const proved = results
    .filter((r) => r.status === 'SUPPORTED')
    .map((r) => ({ rule_id: r.rule_id, label: r.label }));

  const notProved: ProofShortfall[] = results
    .filter((r) => r.status !== 'SUPPORTED')
    .map((r) => {
      const explanation = explainAssertion(r);
      return {
        rule_id: r.rule_id,
        label: r.label,
        blocking: r.mandatory,
        reason_code: r.reason_code,
        sentence: explanation.sentence,
        next_step: explanation.next_step,
        detail: explanation.detail ?? '',
      };
    });

  return {
    ran: true,
    status: decision.status,
    statusReason: decision.reason,
    results,
    proved,
    notProved,
    sources,
    blockedReason: null,
    summary: summarise(decision.status, proved.length, notProved, sources),
    callsMade: fetched.reduce((sum, r) => sum + r.calls_made, 0),
  };
}

/**
 * The CRM properties this rule set actually names.
 *
 * Feeding this into `fetchEvidence` is what keeps the proof run honest about privacy: it
 * reads the same narrow slice of a contact that a real run would, not a whole record
 * "because it is only a test".
 */
export function crmPropertiesFor(rules: WorkflowRules): readonly string[] {
  const names = new Set<string>();
  for (const assertion of rules.assertions) {
    if (assertion.field === 'record.property' && typeof assertion.property_name === 'string') {
      names.add(assertion.property_name);
    }
  }
  return [...names];
}

function summarise(
  status: RunStatus,
  provedCount: number,
  notProved: readonly ProofShortfall[],
  sources: readonly ProofSourceReport[],
): string {
  const blockingCount = notProved.filter((s) => s.blocking).length;
  const accounts = sources
    .filter((s) => s.connected && s.accountId !== null)
    .map((s) => PROVIDER_NAME[s.provider])
    .join(' and ');

  if (status === 'VERIFIED') {
    return `We proved all ${provedCount} checks by reading the evidence back from ${accounts === '' ? 'your connected accounts' : accounts}. Nothing here came from your automation telling us it worked.`;
  }
  if (status === 'FAILED') {
    return `We read the evidence back from ${accounts === '' ? 'your connected accounts' : accounts} and ${blockingCount === 1 ? 'one required check is contradicted by it' : `${blockingCount} required checks are contradicted by it`}. That is a real finding, not a setup problem.`;
  }
  const headline = explainRunStatus(status).sentence;
  return `${headline} We proved ${provedCount} of the checks; ${blockingCount === 0 ? 'none of the required ones are outstanding' : blockingCount === 1 ? 'one required check is still unproven' : `${blockingCount} required checks are still unproven`}. At proof time that means "we could not show this", not "your automation failed".`;
}
