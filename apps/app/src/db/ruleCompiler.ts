/**
 * Turns the two onboarding forms — field mapping and expected outcome — into a validated
 * `WorkflowRules` document, and nothing else.
 *
 * This is the piece `saveFieldMapping`/`saveExpectedOutcome` in `customerPort.ts` refused to
 * guess at: composing a valid `WorkflowRules` from two forms is a decision about what
 * VERIFIED means, and a half-formed version written to get past a refusal would change that
 * silently. So the rule here is absolute: a document either parses against
 * `workflowRulesSchema` or nothing is written, and the caller is told exactly which input
 * was the problem.
 *
 * ## Every assertion here is explicitly mandatory
 *
 * `assertionSpecSchema.mandatory` defaults to `true` when the field is omitted — but this
 * file never omits it. Nothing here relies on that default, because a form that could one
 * day gain an "advisory" checkbox must not discover that every assertion it already wrote
 * was silently mandatory by omission. Today's two forms (`FieldMappingInput`,
 * `ExpectedOutcomeInput`) have no way to ask for an advisory-only check at all — each
 * `requireX` toggle means "mandatory, or not present" — so this compiler only ever produces
 * mandatory assertions. If a form gains a real advisory option, it must say so explicitly
 * and this file must be taught the new shape; it must not infer advisory from "unset".
 *
 * ## Why `record.correlation_id` and `message.recipient` bind to the run's own event
 *
 * The obvious-looking shape for "the CRM record carries this enquiry's reference" is
 * `operator: 'equals'` against a literal, and the same for "the acknowledgement went to the
 * enquirer". Both are wrong: `assertionSpecSchema.expected` is a literal baked into the
 * workflow VERSION, shared by every run that version ever judges, so a value that is right
 * for one enquiry is wrong for every other.
 *
 * Until 2026-09-19 this file therefore emitted `exists` for both — and `exists` on
 * `message.recipient` proves only that an email had *a* recipient. A run whose
 * acknowledgement went to entirely the wrong address came back VERIFIED. The CRM side had
 * the same hole on the record-id locator path, where the record is fetched by id rather than
 * found by its correlation value.
 *
 * Both now use `expected_from` (`packages/contracts/src/rules.ts`): a closed, two-valued
 * reference to the run's own signed source event. `evaluateAssertions()` resolves it from
 * `EvaluationContext.sourceEvent`, which `scheduler/observe.ts` fills from the same parsed
 * event the locator comes from. The comparison is therefore per run, at evaluation time —
 * and if this run's event carries nothing to compare with, the assertion is UNKNOWN
 * (`BINDING_UNAVAILABLE`), never a pass.
 *
 * `normalised_email_equals`, not `equals`, for the recipient: its normalisation lowercases,
 * trims and strips a display name, and deliberately does NOT strip `+tags` — an address the
 * customer controls must not satisfy a rule about the enquirer's address. That property is
 * documented in the development story; this is the line that makes it apply to a real run.
 */
import {
  LIMITS,
  workflowRulesSchema,
  type AssertionSpec,
  type CoverageMode,
  type WorkflowRules,
} from '@verify/contracts';

export interface ConfiguredWorkflowState {
  readonly correlationProperty: string;
  readonly deadlineSeconds: number;
  readonly coverageMode: CoverageMode;
  readonly requireRecordExists: boolean;
  readonly requireCorrelationMatch: boolean;
  readonly requireEmailDelivered: boolean;
  readonly requireRecipientMatch: boolean;
}

/**
 * The seed for a workflow's very first published version.
 *
 * `workflowRulesSchema` requires at least one assertion, so the field-mapping form — saved
 * first in the onboarding order — cannot publish a valid document from its own input alone.
 * Rather than invent a fact (a fabricated correlation value, a guessed deadline), it seeds
 * the checks a customer would want by default: all four, matching the accepted reference
 * shape in `routes/app/syntheticPort.ts`'s `initialState()`. The very next step, saving the
 * expected outcome, publishes over this with the customer's own explicit choice.
 */
export const DEFAULT_CONFIGURED_STATE: ConfiguredWorkflowState = {
  correlationProperty: '',
  deadlineSeconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
  coverageMode: 'customer_triggered',
  requireRecordExists: true,
  requireCorrelationMatch: true,
  requireEmailDelivered: true,
  requireRecipientMatch: true,
};

/**
 * Read a previously published version back into the shape the two forms edit.
 *
 * Goes through `workflowRulesSchema` rather than a bespoke parse, so a row that could not
 * possibly have been written by this file (hand-edited, restored from an old backup, from a
 * schema version this file predates) is never silently trusted as a merge base — it falls
 * back to the same seed a brand new workflow starts from.
 */
export function parseConfiguredState(rulesJson: string | null): ConfiguredWorkflowState {
  if (rulesJson === null) return DEFAULT_CONFIGURED_STATE;
  let parsed: WorkflowRules;
  try {
    parsed = workflowRulesSchema.parse(JSON.parse(rulesJson));
  } catch {
    return DEFAULT_CONFIGURED_STATE;
  }
  return {
    correlationProperty: parsed.crm_correlation_property,
    deadlineSeconds: parsed.deadline_seconds,
    coverageMode: parsed.coverage_mode,
    requireRecordExists: parsed.assertions.some(
      (a) => a.field === 'record.id' && a.operator === 'exists',
    ),
    requireCorrelationMatch: parsed.assertions.some((a) => a.field === 'record.correlation_id'),
    requireEmailDelivered: parsed.assertions.some((a) => a.field === 'message.status'),
    requireRecipientMatch: parsed.assertions.some((a) => a.field === 'message.recipient'),
  };
}

function buildAssertions(state: ConfiguredWorkflowState): AssertionSpec[] {
  const assertions: AssertionSpec[] = [];

  if (state.requireRecordExists) {
    assertions.push({
      rule_id: 'crm_record_exists',
      source: 'crm_record',
      field: 'record.id',
      operator: 'exists',
      expected: '',
      mandatory: true,
      label: 'A CRM record was created',
    });
  }

  if (state.requireCorrelationMatch) {
    assertions.push({
      rule_id: 'crm_correlation_matches',
      source: 'crm_record',
      field: 'record.correlation_id',
      // Bound to the run's own correlation id — see the file header. A literal cannot work.
      operator: 'equals',
      expected: '',
      expected_from: 'source_event.correlation_id',
      mandatory: true,
      label: 'The CRM record carries this enquiry reference',
    });
  }

  if (state.requireEmailDelivered) {
    assertions.push({
      rule_id: 'email_delivered',
      source: 'email_event',
      field: 'message.status',
      operator: 'provider_status_in',
      expected: ['delivered'],
      mandatory: true,
      label: 'The acknowledgement email reached the recipient',
    });
  }

  if (state.requireRecipientMatch) {
    assertions.push({
      rule_id: 'email_recipient_matches',
      source: 'email_event',
      field: 'message.recipient',
      // Bound to the address this run's event named — see the file header. `+tags` are not
      // stripped, so a customer-controlled variant of the address does not satisfy it.
      operator: 'normalised_email_equals',
      expected: '',
      expected_from: 'source_event.email_recipient',
      mandatory: true,
      label: 'The acknowledgement went to the address the enquiry named',
    });
  }

  return assertions;
}

export interface ComposeFailure {
  /** The `workflowRulesSchema` issue path, e.g. `['crm_correlation_property']`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ComposeResult =
  | { readonly ok: true; readonly rules: WorkflowRules }
  | { readonly ok: false; readonly failure: ComposeFailure };

/**
 * The only path from a `ConfiguredWorkflowState` to a `WorkflowRules` document. Every field
 * is validated by the schema before this returns `ok: true` — there is no direct-construct
 * path elsewhere in the customer port, so a document that reaches `workflowVersions.publish`
 * has necessarily passed here first.
 */
export function composeWorkflowRules(state: ConfiguredWorkflowState): ComposeResult {
  const candidate = {
    schema_version: 1 as const,
    deadline_seconds: state.deadlineSeconds,
    coverage_mode: state.coverageMode,
    crm_correlation_property: state.correlationProperty,
    assertions: buildAssertions(state),
  };

  const parsed = workflowRulesSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      failure: {
        path: issue?.path ?? [],
        message: issue?.message ?? 'The configured rules are not valid.',
      },
    };
  }
  return { ok: true, rules: parsed.data };
}
