/**
 * `expected_from` — a rule may name one of two values from the run's own signed event.
 *
 * The contract side: the binding is a closed enum, only two operators may take it, the
 * literal must be empty when it is set, and each binding may address only its counterpart
 * fields. The evaluator side: a bound value is compared per run, a missing binding is
 * UNKNOWN and never a pass, and the +tag rule of `normalised_email_equals` applies to the
 * bound comparison exactly as to a literal one.
 */
import { describe, expect, it } from 'vitest';
import { assertionSpecSchema, type AssertionSpec, type EvidenceBundle } from '@verify/contracts';
import { describeExpected, evaluateAssertions, type AssertionResult } from '@verify/domain';
import {
  CONNECTED_CRM_ACCOUNT,
  CONNECTED_EMAIL_ACCOUNT,
  CORRELATION_VALUE,
  RECIPIENT,
  T_EVENT,
  T_INSIDE_WINDOW,
  makeAssertion,
  makeCrmEvidence,
  makeEmailEvent,
  makeEvidenceBundle,
  rulesFor,
} from '../../fixtures/index.js';

const CTX = {
  occurredAt: T_EVENT,
  now: T_INSIDE_WINDOW,
  connectedCrmAccountId: CONNECTED_CRM_ACCOUNT,
  connectedEmailAccountId: CONNECTED_EMAIL_ACCOUNT,
  sourceEvent: { correlation_id: CORRELATION_VALUE, email_recipient: RECIPIENT },
} as const;

const recipientBound = makeAssertion({
  rule_id: 'email_recipient_matches',
  source: 'email_event',
  field: 'message.recipient',
  operator: 'normalised_email_equals',
  expected: '',
  expected_from: 'source_event.email_recipient',
  label: 'The acknowledgement went to the address the enquiry named',
});

const correlationBound = makeAssertion({
  rule_id: 'crm_correlation_matches',
  field: 'record.correlation_id',
  operator: 'equals',
  expected: '',
  expected_from: 'source_event.correlation_id',
  label: 'The CRM record carries this enquiry reference',
});

function one(spec: AssertionSpec, bundle: EvidenceBundle, ctx = CTX as object): AssertionResult {
  const first = evaluateAssertions(rulesFor(spec), bundle, ctx as typeof CTX)[0];
  if (first === undefined) throw new Error('expected exactly one result');
  return first;
}

describe('the contract keeps the binding closed', () => {
  it('VERIFY-233 accepts a bound recipient comparison with an empty literal', () => {
    expect(recipientBound.expected_from).toBe('source_event.email_recipient');
    expect(recipientBound.expected).toBe('');
  });

  it('VERIFY-234 rejects a binding on any operator other than equals or normalised_email_equals', () => {
    for (const operator of ['exists', 'not_equals', 'one_of', 'occurred_within'] as const) {
      const result = assertionSpecSchema.safeParse({
        ...recipientBound,
        operator,
        expected: operator === 'occurred_within' ? 0 : operator === 'one_of' ? ['x'] : '',
      });
      expect(result.success, operator).toBe(false);
    }
  });

  it('VERIFY-235 rejects a literal alongside a binding — a rule says where its value comes from, once', () => {
    const result = assertionSpecSchema.safeParse({ ...recipientBound, expected: RECIPIENT });
    expect(result.success).toBe(false);
  });

  it('VERIFY-236 rejects a binding on a field it is not the counterpart of', () => {
    const wrongField = assertionSpecSchema.safeParse({
      ...recipientBound,
      source: 'crm_record',
      field: 'record.correlation_id',
    });
    expect(wrongField.success).toBe(false);
    const wrongName = assertionSpecSchema.safeParse({
      ...recipientBound,
      expected_from: 'source_event.enquirer_address',
    });
    expect(wrongName.success).toBe(false);
  });
});

describe('the evaluator compares against the run’s own value', () => {
  it('VERIFY-237 supports a recipient that matches this run’s address, and shows that address as the expectation', () => {
    const r = one(
      recipientBound,
      makeEvidenceBundle({ email_events: [makeEmailEvent({ recipient: ' ADA@Example.test ' })] }),
    );
    expect(r.status).toBe('SUPPORTED');
    expect(r.expected_display).toBe(RECIPIENT);
  });

  it('VERIFY-238 contradicts a recipient that is not this run’s address', () => {
    const r = one(
      recipientBound,
      makeEvidenceBundle({
        email_events: [makeEmailEvent({ recipient: 'someone-else@example.test' })],
      }),
    );
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('VALUE_MISMATCH');
    expect(r.observed_display).toBe('someone-else@example.test');
  });

  it('VERIFY-239 does not strip a plus tag from the bound comparison either', () => {
    const r = one(
      recipientBound,
      makeEvidenceBundle({
        email_events: [makeEmailEvent({ recipient: 'ada+anything@example.test' })],
      }),
    );
    expect(r.status).toBe('CONTRADICTED');
  });

  it('VERIFY-240 a missing or blank binding is UNKNOWN with BINDING_UNAVAILABLE, never a pass', () => {
    const bundle = makeEvidenceBundle();
    const without = { ...CTX, sourceEvent: undefined };
    const blank = {
      ...CTX,
      sourceEvent: { correlation_id: CORRELATION_VALUE, email_recipient: '  ' },
    };
    for (const ctx of [without, blank]) {
      const r = one(recipientBound, bundle, ctx);
      expect(r.status).toBe('UNKNOWN');
      expect(r.reason_code).toBe('BINDING_UNAVAILABLE');
      expect(r.expected_display).toBe(describeExpected(recipientBound));
      expect(r.expected_display).toContain('did not carry');
    }
  });

  it('VERIFY-241 binds the correlation check to this run’s reference on the CRM side too', () => {
    expect(one(correlationBound, makeEvidenceBundle()).status).toBe('SUPPORTED');
    const wrong = one(
      correlationBound,
      makeEvidenceBundle({ crm: makeCrmEvidence({ correlation_value: 'enq_0000000000000002' }) }),
    );
    expect(wrong.status).toBe('CONTRADICTED');
    expect(wrong.expected_display).toBe(CORRELATION_VALUE);
  });

  it('VERIFY-242 a literal rule is unaffected by the run’s values', () => {
    const literal = makeAssertion({
      rule_id: 'always_the_boss',
      source: 'email_event',
      field: 'message.recipient',
      operator: 'normalised_email_equals',
      expected: 'boss@example.test',
    });
    const r = one(
      literal,
      makeEvidenceBundle({ email_events: [makeEmailEvent({ recipient: RECIPIENT })] }),
    );
    expect(r.status).toBe('CONTRADICTED');
    expect(r.expected_display).toBe('boss@example.test');
  });
});
