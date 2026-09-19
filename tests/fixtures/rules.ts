/**
 * Typed builders for workflow rules. Built through the frozen Zod schema wherever the rules
 * are meant to be valid, so a fixture can never drift away from the contract; raw builders
 * are provided for the deliberately-invalid cases the evaluator must refuse.
 */
import {
  LIMITS,
  assertionSpecSchema,
  workflowRulesSchema,
  type AssertionSpec,
  type WorkflowRules,
} from '@verify/contracts';
import { CORRELATION_VALUE, RECIPIENT } from './evidence.js';

/** Raw assertion input, before the schema applies its defaults. */
export type AssertionInput = Omit<Partial<AssertionSpec>, 'mandatory'> & { mandatory?: boolean };

/** Build a valid assertion through the frozen schema. Throws if the fixture is invalid. */
export function makeAssertion(overrides: AssertionInput = {}): AssertionSpec {
  return assertionSpecSchema.parse({
    rule_id: 'crm_record_exists',
    source: 'crm_record',
    field: 'record.id',
    operator: 'exists',
    expected: '',
    mandatory: true,
    label: 'A CRM record was created',
    ...overrides,
  });
}

/**
 * Build an assertion *without* the schema, for the cases where the whole point is that the
 * spec is malformed and the evaluator must refuse to guess.
 */
export function makeRawAssertion(overrides: Partial<AssertionSpec> = {}): AssertionSpec {
  return {
    rule_id: 'raw_rule',
    source: 'crm_record',
    field: 'record.id',
    operator: 'exists',
    expected: '',
    mandatory: true,
    label: 'A raw, unvalidated rule',
    ...overrides,
  } as AssertionSpec;
}

export function makeWorkflowRules(overrides: Partial<WorkflowRules> = {}): WorkflowRules {
  return workflowRulesSchema.parse({
    schema_version: 1,
    deadline_seconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
    coverage_mode: 'customer_triggered',
    crm_correlation_property: 'verify_correlation_id',
    assertions: [makeAssertion()],
    ...overrides,
  });
}

/** Rules assembled without schema validation, for the deliberately-invalid cases. */
export function makeRawWorkflowRules(overrides: Partial<WorkflowRules> = {}): WorkflowRules {
  return {
    schema_version: 1,
    deadline_seconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
    coverage_mode: 'customer_triggered',
    crm_correlation_property: 'verify_correlation_id',
    assertions: [makeRawAssertion()],
    ...overrides,
  } as WorkflowRules;
}

/** Convenience: a one-assertion workflow around a single spec. */
export function rulesFor(...assertions: AssertionSpec[]): WorkflowRules {
  return makeRawWorkflowRules({ assertions });
}

/** The v1 shipping workflow: an enquiry creates a CRM record and an acknowledgement is sent. */
export function makeStandardWorkflow(): WorkflowRules {
  return makeWorkflowRules({
    assertions: [
      makeAssertion({
        rule_id: 'crm_record_exists',
        field: 'record.id',
        operator: 'exists',
        expected: '',
      }),
      makeAssertion({
        rule_id: 'crm_correlation_matches',
        field: 'record.correlation_id',
        operator: 'equals',
        expected: CORRELATION_VALUE,
        label: 'The CRM record carries this enquiry reference',
      }),
      makeAssertion({
        rule_id: 'crm_created_in_window',
        field: 'record.created_at',
        operator: 'occurred_within',
        expected: 300,
        label: 'The CRM record was created promptly after the enquiry',
      }),
      makeAssertion({
        rule_id: 'email_delivered',
        source: 'email_event',
        field: 'message.status',
        operator: 'provider_status_in',
        expected: ['delivered'],
        label: 'The acknowledgement email reached the recipient',
      }),
      makeAssertion({
        rule_id: 'email_recipient_matches',
        source: 'email_event',
        field: 'message.recipient',
        operator: 'normalised_email_equals',
        expected: RECIPIENT,
        label: 'The acknowledgement went to the enquirer',
      }),
    ],
  });
}
