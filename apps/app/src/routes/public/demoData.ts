/**
 * The demo workspace's four runs.
 *
 * Nothing here is a mock of a result. The four statuses are produced by running A03's real
 * `evaluateAssertions()` and `decideRunStatus()` over the shared synthetic fixtures in
 * `tests/fixtures/` — the same builders the domain suite uses — and then explained by the
 * real `explainRun()`. If A03 changes a verdict rule, this page changes with it, and the
 * unit tests that assert the four statuses here fail loudly if it ever stops being true.
 *
 * Everything is synthetic: `example.test` addresses, invented record ids, invented account
 * ids. There is no database access on this path and no input is accepted.
 */
import {
  decideRunStatus,
  describeCoverage,
  evaluateAssertions,
  explainRun,
  summariseMandatory,
  summariseWorkflowHealth,
  type AssertionResult,
  type CoverageDescription,
  type MandatorySummary,
  type RunExplanation,
  type AssertionExplanation,
  type WorkflowHealth,
} from '@verify/domain';
import { LIMITS, type EvidenceBundle, type RunStatus, type WorkflowRules } from '@verify/contracts';
/*
 * Deliberate: the demo's rules come from the real rule compiler — the pure function that
 * turns a customer's two onboarding forms into a `WorkflowRules` document. It touches no
 * database. Importing it here is what makes the demo unable to show a check that a real
 * workflow does not perform (see `demoRules()` below).
 */
import { composeWorkflowRules } from '../../db/ruleCompiler.js';
/*
 * Deliberate: this imports the shared synthetic fixture *builders* from `tests/fixtures/`.
 *
 * They are pure typed functions over the frozen contract with no vitest import, so nothing
 * from the test framework reaches the bundle — only the same builders the domain suite uses,
 * which is precisely the point: the demo cannot drift away from what the tests prove. The
 * brief asked for the demo to run on these fixtures.
 *
 * It is NOT an accident to be tidied away. Moving them would mean a new workspace package
 * (`pnpm-workspace.yaml` and `tsconfig.json` paths are the lead's), which is why they are
 * still here; say the word and I will do it properly rather than by relocating a file.
 */
import {
  CONNECTED_CRM_ACCOUNT,
  CONNECTED_EMAIL_ACCOUNT,
  CORRELATION_VALUE,
  RECIPIENT,
  T_AFTER_DEADLINE,
  T_DEADLINE,
  T_EVENT,
  T_INSIDE_WINDOW,
  makeEmailEventWithStatus,
  makeEmptyBundle,
  makeEvidenceBundle,
  makeUnreachableBundle,
} from '../../../../../tests/fixtures/index.js';

export interface DemoRun {
  /** Synthetic run id. Shaped like a real one so the page looks like the product. */
  readonly id: string;
  /** What the enquiry was, in one line, for the run list. */
  readonly summary: string;
  readonly correlationId: string;
  readonly recipient: string;
  readonly occurredAt: string;
  readonly deadlineAt: string;
  readonly decidedAt: string;
  readonly status: RunStatus;
  /** The decision engine's own sentence. */
  readonly decisionReason: string;
  readonly results: readonly AssertionResult[];
  readonly explanation: RunExplanation;
  readonly assertionExplanations: readonly AssertionExplanation[];
  readonly mandatory: MandatorySummary;
  /** What the automation claimed, for the claim rule. */
  readonly claim: string;
  /** What we retrieved, for the claim rule. Null when we retrieved nothing. */
  readonly observed: string | null;
  readonly rulesRef: string;
  readonly sourceType: string;
}

/**
 * The rules this demo judges against are exactly the rules a real workspace gets.
 *
 * Until 2026-09-19 the demo ran the shared `makeStandardWorkflow()` fixture, which asserts
 * `normalised_email_equals` on the recipient — a check the evaluator implements but that no
 * customer workflow emits: the onboarding composer asserts only that the recipient field
 * `exists`. The demo was therefore showing a visitor a comparison the product never performs
 * on a real run. So the demo now composes its rules through the same function the onboarding
 * forms use, with every check switched on, and `tests/unit/public/demo-rules.test.ts` pins
 * the two together. The composer now binds the recipient and correlation checks to the run's
 * own event (`expected_from`), so the demo shows that comparison for the same reason it did
 * not before: because real runs perform it.
 */
function demoRules(): WorkflowRules {
  const composed = composeWorkflowRules({
    correlationProperty: 'verify_correlation_id',
    deadlineSeconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
    coverageMode: 'customer_triggered',
    requireRecordExists: true,
    requireCorrelationMatch: true,
    requireEmailDelivered: true,
    requireRecipientMatch: true,
  });
  if (!composed.ok) {
    // A demo that cannot compose the product's own rules must fail loudly, not render a
    // hand-written substitute that looks like them.
    throw new Error(`demo rules did not compose: ${composed.failure.message}`);
  }
  return composed.rules;
}

const RULES: WorkflowRules = demoRules();

const EVAL_CONTEXT = {
  occurredAt: T_EVENT,
  now: T_INSIDE_WINDOW,
  connectedCrmAccountId: CONNECTED_CRM_ACCOUNT,
  connectedEmailAccountId: CONNECTED_EMAIL_ACCOUNT,
  // The synthetic enquiry's own values, exactly as the scheduler hands a real run's. The
  // composer binds two checks to them, so without this the demo's runs could never verify.
  sourceEvent: { correlation_id: CORRELATION_VALUE, email_recipient: RECIPIENT },
} as const;

interface Scenario {
  readonly id: string;
  readonly summary: string;
  readonly bundle: EvidenceBundle;
  readonly now: Date;
  readonly hasWorkingEvidenceAccess: boolean;
  readonly observationsRemaining: number;
  readonly claim: string;
  readonly observed: string | null;
}

/**
 * Four scenarios, chosen because each is a situation a real customer will actually meet —
 * not because each produces a different colour.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    // Everything worked. The record exists, carries the reference, was created in time, and
    // the acknowledgement reached the recipient's mail server.
    id: 'run_demo_verified',
    summary: 'Enquiry from ada@example.test',
    bundle: makeEvidenceBundle(),
    now: T_INSIDE_WINDOW,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 3,
    claim: `contact carrying ${CORRELATION_VALUE}, acknowledgement delivered to ${RECIPIENT}`,
    observed: `contact crm-rec-1 carrying ${CORRELATION_VALUE}; acknowledgement to ${RECIPIENT} status "delivered"`,
  },
  {
    // The CRM half is perfect and the email bounced. This is the failure agencies actually
    // have, and the one their automation platform's error log will never show them.
    id: 'run_demo_failed',
    summary: 'Enquiry from ada@example.test',
    bundle: makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('bounced')] }),
    now: T_AFTER_DEADLINE,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 0,
    claim: `contact carrying ${CORRELATION_VALUE}, acknowledgement delivered to ${RECIPIENT}`,
    observed: `contact crm-rec-1 carrying ${CORRELATION_VALUE}; acknowledgement to ${RECIPIENT} status "bounced"`,
  },
  {
    // The completion window is still open and nothing has arrived yet. Not a failure.
    id: 'run_demo_pending',
    summary: 'Enquiry from ada@example.test',
    bundle: makeEmptyBundle(),
    now: T_INSIDE_WINDOW,
    hasWorkingEvidenceAccess: true,
    observationsRemaining: 3,
    claim: `contact carrying ${CORRELATION_VALUE}, acknowledgement delivered to ${RECIPIENT}`,
    observed: null,
  },
  {
    // The HubSpot authorisation expired, so we could not look. This must never render as a
    // failure: we are not saying the automation went wrong, we are saying we could not see.
    id: 'run_demo_unverified',
    summary: 'Enquiry from ada@example.test',
    bundle: makeUnreachableBundle('AUTH_EXPIRED'),
    now: T_AFTER_DEADLINE,
    hasWorkingEvidenceAccess: false,
    observationsRemaining: 0,
    claim: `contact carrying ${CORRELATION_VALUE}, acknowledgement delivered to ${RECIPIENT}`,
    observed: null,
  },
];

function buildRun(scenario: Scenario): DemoRun {
  const results = evaluateAssertions(RULES, scenario.bundle, EVAL_CONTEXT);
  const decision = decideRunStatus(results, {
    deadlineAt: T_DEADLINE,
    now: scenario.now,
    hasWorkingEvidenceAccess: scenario.hasWorkingEvidenceAccess,
    observationsRemaining: scenario.observationsRemaining,
  });
  const explained = explainRun(decision.status, results);
  return {
    id: scenario.id,
    summary: scenario.summary,
    correlationId: CORRELATION_VALUE,
    recipient: RECIPIENT,
    occurredAt: T_EVENT.toISOString(),
    deadlineAt: T_DEADLINE.toISOString(),
    decidedAt: scenario.now.toISOString(),
    status: decision.status,
    decisionReason: decision.reason,
    results,
    explanation: explained.run,
    assertionExplanations: explained.assertions,
    mandatory: summariseMandatory(results),
    claim: scenario.claim,
    observed: scenario.observed,
    rulesRef: 'wf_demo@v1',
    sourceType: 'signed source event (customer_claim)',
  };
}

/** The four demo runs, in the order the demo page shows them. */
export const DEMO_RUNS: readonly DemoRun[] = SCENARIOS.map(buildRun);

/** The demo workflow's coverage description, from A03's real `describeCoverage()`. */
export const DEMO_COVERAGE: CoverageDescription = describeCoverage(RULES);

/**
 * The demo workflow's health, from A03's real `summariseWorkflowHealth()`. With one failed
 * and one unverified run out of three decided, this is deliberately not a flattering
 * number — a demo that showed 100% would be selling something the product refuses to sell.
 */
export const DEMO_HEALTH: WorkflowHealth = summariseWorkflowHealth({
  verified: DEMO_RUNS.filter((run) => run.status === 'VERIFIED').length,
  failed: DEMO_RUNS.filter((run) => run.status === 'FAILED').length,
  unverified: DEMO_RUNS.filter((run) => run.status === 'UNVERIFIED').length,
  pending: DEMO_RUNS.filter((run) => run.status === 'PENDING').length,
});

/** The demo workflow's rules, so the page can show what was actually being checked. */
export const DEMO_RULES: WorkflowRules = RULES;

/** Find one demo run by id. Returns undefined rather than guessing. */
export function findDemoRun(id: string): DemoRun | undefined {
  return DEMO_RUNS.find((run) => run.id === id);
}
