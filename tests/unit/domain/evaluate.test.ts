import { describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { evaluateAssertions, normaliseEmailAddress, type AssertionResult } from '@verify/domain';
import {
  CONNECTED_CRM_ACCOUNT,
  CONNECTED_EMAIL_ACCOUNT,
  CORRELATION_VALUE,
  FOREIGN_ACCOUNT,
  RECIPIENT,
  T_AFTER_DEADLINE,
  T_EVENT,
  T_INSIDE_WINDOW,
  isoAfter,
  makeAssertion,
  makeClaimedBundle,
  makeCrmEvidence,
  makeEmailEvent,
  makeEmailEventWithStatus,
  makeEmptyBundle,
  makeEvidenceBundle,
  makeGap,
  makeRawAssertion,
  makeRawWorkflowRules,
  makeStandardWorkflow,
  makeWorkflowRules,
  rulesFor,
} from '../../fixtures/index.js';
import type { AssertionSpec, EvidenceBundle } from '@verify/contracts';

const CTX = {
  occurredAt: T_EVENT,
  now: T_INSIDE_WINDOW,
  connectedCrmAccountId: CONNECTED_CRM_ACCOUNT,
  connectedEmailAccountId: CONNECTED_EMAIL_ACCOUNT,
} as const;

/** Evaluate exactly one assertion and return its result. */
function one(spec: AssertionSpec, bundle: EvidenceBundle, ctx = CTX): AssertionResult {
  const results = evaluateAssertions(rulesFor(spec), bundle, ctx);
  const first = results[0];
  if (first === undefined) throw new Error('expected exactly one result');
  return first;
}

describe('evaluateAssertions — exists', () => {
  it('VERIFY-001 supports exists when the addressed field is present', () => {
    const r = one(
      makeAssertion({ field: 'record.id', operator: 'exists', expected: '' }),
      makeEvidenceBundle(),
    );
    expect(r.status).toBe('SUPPORTED');
    expect(r.reason_code).toBe('MATCHED');
    expect(r.evidence_ref).toBe('crm_record:hubspot:crm-rec-1');
  });

  it('VERIFY-002 contradicts exists when the retrieved record returns the field empty', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ email: null }) });
    const r = one(
      makeAssertion({
        rule_id: 'email_present',
        field: 'record.email',
        operator: 'exists',
        expected: '',
      }),
      bundle,
    );
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('VALUE_MISMATCH');
  });

  it('VERIFY-003 treats a whitespace-only value as absent at the exists boundary', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ email: '   ' }) });
    const r = one(
      makeAssertion({
        rule_id: 'email_present',
        field: 'record.email',
        operator: 'exists',
        expected: '',
      }),
      bundle,
    );
    expect(r.status).toBe('CONTRADICTED');
  });

  it('VERIFY-004 returns UNKNOWN for exists when the evidence source was unavailable', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'PROVIDER_UNAVAILABLE' })],
    });
    const r = one(makeAssertion({ field: 'record.id', operator: 'exists', expected: '' }), bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_UNAVAILABLE');
  });

  it('VERIFY-005 reports CORRELATION_MISSING when the correlation property itself is absent', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ correlation_value: null }) });
    const r = one(
      makeAssertion({
        rule_id: 'correlation_present',
        field: 'record.correlation_id',
        operator: 'exists',
        expected: '',
      }),
      bundle,
    );
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('CORRELATION_MISSING');
  });
});

describe('evaluateAssertions — equals and not_equals', () => {
  const equalsSpec = makeAssertion({
    rule_id: 'correlation_equals',
    field: 'record.correlation_id',
    operator: 'equals',
    expected: CORRELATION_VALUE,
  });

  it('VERIFY-006 supports equals on an exact match', () => {
    expect(one(equalsSpec, makeEvidenceBundle()).status).toBe('SUPPORTED');
  });

  it('VERIFY-007 contradicts equals when the retrieved value is different', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ correlation_value: 'enq_other' }) });
    const r = one(equalsSpec, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('VALUE_MISMATCH');
    expect(r.observed_display).toBe('enq_other');
  });

  it('VERIFY-008 trims surrounding whitespace at the equals boundary', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ correlation_value: `  ${CORRELATION_VALUE}  ` }),
    });
    expect(one(equalsSpec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-009 keeps equals case-sensitive on a non-email field', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ correlation_value: CORRELATION_VALUE.toUpperCase() }),
    });
    expect(one(equalsSpec, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-010 relaxes equals to case-insensitive on an email address field', () => {
    const spec = makeAssertion({
      rule_id: 'email_equals',
      field: 'record.email',
      operator: 'equals',
      expected: RECIPIENT,
    });
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ email: 'ADA@Example.Test' }) });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-011 returns UNKNOWN for equals when the provider did not return the field at all', () => {
    const spec = makeAssertion({
      rule_id: 'stage_equals',
      field: 'record.property',
      property_name: 'not_returned_by_provider',
      operator: 'equals',
      expected: 'lead',
    });
    const r = one(spec, makeEvidenceBundle());
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_NOT_RETURNED');
  });

  it('VERIFY-012 contradicts equals when the provider returned the field explicitly empty', () => {
    const spec = makeAssertion({
      rule_id: 'stage_equals',
      field: 'record.property',
      property_name: 'lifecyclestage',
      operator: 'equals',
      expected: 'lead',
    });
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ properties: { lifecyclestage: null } }),
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('VALUE_MISMATCH');
  });

  const notEqualsSpec = makeAssertion({
    rule_id: 'stage_not_duplicate',
    field: 'record.property',
    property_name: 'lifecyclestage',
    operator: 'not_equals',
    expected: 'duplicate',
  });

  it('VERIFY-013 supports not_equals when a present value differs', () => {
    expect(one(notEqualsSpec, makeEvidenceBundle()).status).toBe('SUPPORTED');
  });

  it('VERIFY-014 contradicts not_equals when the value is the forbidden one', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ properties: { lifecyclestage: 'duplicate' } }),
    });
    expect(one(notEqualsSpec, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-015 never infers not_equals success from an absent value', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ properties: { lifecyclestage: null } }),
    });
    const r = one(notEqualsSpec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_NOT_RETURNED');
  });

  it('VERIFY-016 returns UNKNOWN for not_equals when the source was unavailable', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'RATE_LIMITED' })],
    });
    expect(one(notEqualsSpec, bundle).status).toBe('UNKNOWN');
  });
});

describe('evaluateAssertions — normalised_email_equals', () => {
  const spec = makeAssertion({
    rule_id: 'recipient_matches',
    source: 'email_event',
    field: 'message.recipient',
    operator: 'normalised_email_equals',
    expected: RECIPIENT,
  });

  it('VERIFY-017 supports a match that differs only by case and whitespace', () => {
    const bundle = makeEvidenceBundle({
      email_events: [makeEmailEvent({ recipient: '  ADA@EXAMPLE.TEST ' })],
    });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-018 strips a display name and angle brackets before comparing', () => {
    const bundle = makeEvidenceBundle({
      email_events: [makeEmailEvent({ recipient: 'Ada Lovelace <ada@example.test>' })],
    });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-019 does NOT strip a plus tag: a tagged address is a different mailbox', () => {
    const bundle = makeEvidenceBundle({
      email_events: [makeEmailEvent({ recipient: 'ada+anything@example.test' })],
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('VALUE_MISMATCH');
  });

  it('VERIFY-020 does NOT strip dots from the local part: that equivalence is Gmail-specific', () => {
    const bundle = makeEvidenceBundle({
      email_events: [makeEmailEvent({ recipient: 'a.d.a@example.test' })],
    });
    expect(one(spec, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-021 contradicts normalised_email_equals when the provider returned no recipient', () => {
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEvent({ recipient: null })] });
    expect(one(spec, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-022 returns UNKNOWN for normalised_email_equals when the email source was unavailable', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'email_event', code: 'PROVIDER_UNAVAILABLE' })],
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_UNAVAILABLE');
  });

  it('VERIFY-023 normalises addresses without widening the equivalence class', () => {
    expect(normaliseEmailAddress('  Ada@Example.Test  ')).toBe('ada@example.test');
    expect(normaliseEmailAddress('"Ada" <Ada@Example.Test>')).toBe('ada@example.test');
    expect(normaliseEmailAddress('ada@example.test.')).toBe('ada@example.test');
    expect(normaliseEmailAddress('ada+tag@example.test')).toBe('ada+tag@example.test');
    expect(normaliseEmailAddress('a.d.a@example.test')).toBe('a.d.a@example.test');
    expect(normaliseEmailAddress('not-an-address')).toBe('not-an-address');
  });
});

describe('evaluateAssertions — occurred_within', () => {
  const spec = makeAssertion({
    rule_id: 'created_in_window',
    field: 'record.created_at',
    operator: 'occurred_within',
    expected: 300,
  });

  it('VERIFY-024 supports a timestamp one second inside the window', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, 299) }),
    });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-025 supports a timestamp exactly on the boundary second', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, 300) }),
    });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-026 contradicts a timestamp one second outside the window', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, 301) }),
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('OUTSIDE_TIME_WINDOW');
  });

  it('VERIFY-027 contradicts evidence that predates the business event', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, -1) }),
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('OUTSIDE_TIME_WINDOW');
  });

  it('VERIFY-028 contradicts a record created long before the enquiry rather than calling it evidence', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, -86_400) }),
    });
    expect(one(spec, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-029 supports a timestamp equal to the business event itself', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, 0) }),
    });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-030 returns UNKNOWN when the timestamp is unparseable rather than calling it late', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ created_at: 'not-a-timestamp' }) });
    const r = one(spec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_NOT_RETURNED');
  });

  it('VERIFY-031 returns UNKNOWN for occurred_within when the source was unavailable', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'PROVIDER_UNAVAILABLE' })],
    });
    expect(one(spec, bundle).status).toBe('UNKNOWN');
  });

  it('VERIFY-032 measures the window from the business event, not from now', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ created_at: isoAfter(T_EVENT, 120) }),
    });
    const early = one(spec, bundle, { ...CTX, now: T_INSIDE_WINDOW });
    const late = one(spec, bundle, { ...CTX, now: T_AFTER_DEADLINE });
    expect(early.status).toBe('SUPPORTED');
    expect(late.status).toBe('SUPPORTED');
    expect(early).toEqual(late);
  });
});

describe('evaluateAssertions — provider_status_in and the email status ladder', () => {
  const deliveredRequired = makeAssertion({
    rule_id: 'email_delivered',
    source: 'email_event',
    field: 'message.status',
    operator: 'provider_status_in',
    expected: ['delivered'],
  });

  it('VERIFY-033 supports a delivered-required rule when the provider reported delivered', () => {
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('delivered')] });
    expect(one(deliveredRequired, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-034 accepted does NOT satisfy a rule that requires delivered', () => {
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('accepted')] });
    const r = one(deliveredRequired, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('STATUS_NOT_REACHED');
  });

  it('VERIFY-035 bounced contradicts a rule that requires delivered', () => {
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('bounced')] });
    const r = one(deliveredRequired, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('STATUS_NOT_REACHED');
  });

  it('VERIFY-036 failed and complained also contradict a delivered-required rule', () => {
    for (const status of ['failed', 'complained'] as const) {
      const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus(status)] });
      expect(one(deliveredRequired, bundle).status).toBe('CONTRADICTED');
    }
  });

  it('VERIFY-037 opened neither supports nor contradicts delivery', () => {
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('opened')] });
    const r = one(deliveredRequired, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('STATUS_NOT_REACHED');
  });

  it('VERIFY-038 clicked is engagement, not proof that anything was delivered or read', () => {
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('clicked')] });
    expect(one(deliveredRequired, bundle).status).toBe('UNKNOWN');
  });

  it('VERIFY-039 queued and deferred are still in flight, so they are UNKNOWN not CONTRADICTED', () => {
    for (const status of ['queued', 'deferred'] as const) {
      const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus(status)] });
      expect(one(deliveredRequired, bundle).status).toBe('UNKNOWN');
    }
  });

  it('VERIFY-040 supports when the required status appears anywhere in the observed ladder', () => {
    const bundle = makeEvidenceBundle({
      email_events: [
        makeEmailEventWithStatus('accepted'),
        makeEmailEventWithStatus('delivered'),
        makeEmailEventWithStatus('opened'),
      ],
    });
    const r = one(deliveredRequired, bundle);
    expect(r.status).toBe('SUPPORTED');
    expect(r.evidence_ref).toBe('email_event:resend:msg-delivered:delivered');
    expect(r.observed_display).toBe('accepted, delivered, opened');
  });

  it('VERIFY-041 a bounce still contradicts even when an accepted event came first', () => {
    const bundle = makeEvidenceBundle({
      email_events: [makeEmailEventWithStatus('accepted'), makeEmailEventWithStatus('bounced')],
    });
    expect(one(deliveredRequired, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-042 reports EVENT_NOT_OBSERVED when the provider authoritatively reported no events', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'email_event', code: 'NOT_FOUND', retryable: false })],
    });
    const r = one(deliveredRequired, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVENT_NOT_OBSERVED');
  });

  it('VERIFY-043 reports AWAITING_EVIDENCE when nothing was returned and nothing explained why', () => {
    const r = one(deliveredRequired, makeEmptyBundle());
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('AWAITING_EVIDENCE');
  });

  it('VERIFY-044 a hard failure contradicts a rule that allows a non-delivery status', () => {
    const spec = makeAssertion({
      rule_id: 'email_accepted',
      source: 'email_event',
      field: 'message.status',
      operator: 'provider_status_in',
      expected: ['accepted', 'queued'],
    });
    const bundle = makeEvidenceBundle({ email_events: [makeEmailEventWithStatus('failed')] });
    expect(one(spec, bundle).status).toBe('CONTRADICTED');
  });
});

describe('evaluateAssertions — one_of', () => {
  const spec = makeAssertion({
    rule_id: 'stage_one_of',
    field: 'record.property',
    property_name: 'lifecyclestage',
    operator: 'one_of',
    expected: ['lead', 'subscriber'],
  });

  it('VERIFY-045 supports one_of when the observed value is in the allowed list', () => {
    expect(one(spec, makeEvidenceBundle()).status).toBe('SUPPORTED');
  });

  it('VERIFY-046 contradicts one_of when the observed value is outside the list', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ properties: { lifecyclestage: 'customer' } }),
    });
    expect(one(spec, bundle).status).toBe('CONTRADICTED');
  });

  it('VERIFY-047 trims the observed value at the one_of boundary', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ properties: { lifecyclestage: ' lead ' } }),
    });
    expect(one(spec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-048 returns UNKNOWN for one_of when the provider did not return the property', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ properties: {} }) });
    const r = one(spec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_NOT_RETURNED');
  });
});

describe('evaluateAssertions — gaps, accounts and origin', () => {
  const existsSpec = makeAssertion({ field: 'record.id', operator: 'exists', expected: '' });

  it('VERIFY-049 an unavailable source is UNKNOWN, never CONTRADICTED', () => {
    for (const code of ['PROVIDER_UNAVAILABLE', 'RATE_LIMITED']) {
      const bundle = makeEmptyBundle({ gaps: [makeGap({ source: 'crm_record', code })] });
      const r = one(existsSpec, bundle);
      expect(r.status).toBe('UNKNOWN');
      expect(r.reason_code).toBe('EVIDENCE_UNAVAILABLE');
    }
  });

  it('VERIFY-050 a missing permission is CONNECTION_UNAVAILABLE, not a failure of the automation', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'PERMISSION_MISSING', retryable: false })],
    });
    const r = one(existsSpec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('CONNECTION_UNAVAILABLE');
  });

  it('VERIFY-051 an expired authorisation is CONNECTION_UNAVAILABLE', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'AUTH_EXPIRED', retryable: false })],
    });
    expect(one(existsSpec, bundle).reason_code).toBe('CONNECTION_UNAVAILABLE');
  });

  it('VERIFY-052 an authoritative CRM absence is RECORD_NOT_FOUND', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'NOT_FOUND', retryable: false })],
    });
    const r = one(existsSpec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('RECORD_NOT_FOUND');
  });

  it('VERIFY-053 an ambiguous match is UNKNOWN with RECORD_AMBIGUOUS even when a record was returned', () => {
    const bundle = makeEvidenceBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'AMBIGUOUS_MATCH', retryable: false })],
    });
    const r = one(existsSpec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('RECORD_AMBIGUOUS');
    expect(r.evidence_ref).toBeNull();
  });

  it('VERIFY-054 a record in another provider account contradicts every CRM assertion', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ provider_account_id: FOREIGN_ACCOUNT }),
    });
    const results = evaluateAssertions(makeStandardWorkflow(), bundle, CTX);
    const crmResults = results.filter((r) => r.rule_id.startsWith('crm_'));
    expect(crmResults).toHaveLength(3);
    for (const r of crmResults) {
      expect(r.status).toBe('CONTRADICTED');
      expect(r.reason_code).toBe('RECORD_WRONG_ACCOUNT');
    }
  });

  it('VERIFY-055 a customer-supplied record id is a locator, never a fact about ownership', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ origin: 'customer_claim', provider_account_id: FOREIGN_ACCOUNT }),
    });
    expect(one(existsSpec, bundle).reason_code).toBe('RECORD_WRONG_ACCOUNT');
  });

  it('VERIFY-056 an email event from another sending account contradicts the email assertion', () => {
    const spec = makeAssertion({
      rule_id: 'email_delivered',
      source: 'email_event',
      field: 'message.status',
      operator: 'provider_status_in',
      expected: ['delivered'],
    });
    const bundle = makeEvidenceBundle({
      email_events: [makeEmailEvent({ provider_account_id: FOREIGN_ACCOUNT })],
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('CONTRADICTED');
    expect(r.reason_code).toBe('RECORD_WRONG_ACCOUNT');
  });

  it('VERIFY-057 the account check is skipped when the caller asserts no connected account', () => {
    const bundle = makeEvidenceBundle({
      crm: makeCrmEvidence({ provider_account_id: FOREIGN_ACCOUNT }),
    });
    const r = one(existsSpec, bundle, { occurredAt: T_EVENT, now: T_INSIDE_WINDOW } as typeof CTX);
    expect(r.status).toBe('SUPPORTED');
  });

  it('VERIFY-058 a customer claim may never support a mandatory assertion', () => {
    const results = evaluateAssertions(makeStandardWorkflow(), makeClaimedBundle(), CTX);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.mandatory).toBe(true);
      expect(r.status).toBe('UNKNOWN');
      expect(r.reason_code).toBe('CLAIM_NOT_INDEPENDENT');
    }
  });

  it('VERIFY-059 a customer claim is still displayed alongside the result it could not support', () => {
    const r = one(existsSpec, makeClaimedBundle());
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('CLAIM_NOT_INDEPENDENT');
    expect(r.observed_display).toBe('crm-rec-1');
    expect(r.evidence_ref).toBe('crm_record:hubspot:crm-rec-1');
  });

  it('VERIFY-060 a customer claim may be evaluated normally for an optional assertion', () => {
    const optional = makeAssertion({
      field: 'record.id',
      operator: 'exists',
      expected: '',
      mandatory: false,
    });
    const mandatory = makeAssertion({
      rule_id: 'correlation_present',
      field: 'record.correlation_id',
      operator: 'exists',
      expected: '',
    });
    const results = evaluateAssertions(rulesFor(mandatory, optional), makeClaimedBundle(), CTX);
    expect(results[0]?.status).toBe('UNKNOWN');
    expect(results[1]?.status).toBe('SUPPORTED');
  });

  it('VERIFY-061 an independent event is used in preference to a customer claim for a mandatory rule', () => {
    const spec = makeAssertion({
      rule_id: 'email_delivered',
      source: 'email_event',
      field: 'message.status',
      operator: 'provider_status_in',
      expected: ['delivered'],
    });
    const bundle = makeEvidenceBundle({
      email_events: [
        makeEmailEvent({ origin: 'customer_claim', status: 'bounced', message_id: 'claimed' }),
        makeEmailEvent({ origin: 'provider_webhook', status: 'delivered', message_id: 'webhook' }),
      ],
    });
    const r = one(spec, bundle);
    expect(r.status).toBe('SUPPORTED');
    expect(r.evidence_ref).toBe('email_event:resend:webhook:delivered');
  });

  it('VERIFY-062 a provider webhook counts as independent evidence', () => {
    const bundle = makeEvidenceBundle({ crm: makeCrmEvidence({ origin: 'provider_webhook' }) });
    expect(one(existsSpec, bundle).status).toBe('SUPPORTED');
  });

  it('VERIFY-190 an omitted field and an unreachable provider are not the same finding', () => {
    const spec = makeAssertion({
      rule_id: 'stage_equals',
      field: 'record.property',
      property_name: 'lifecyclestage',
      operator: 'equals',
      expected: 'lead',
    });
    // The provider answered and simply left the property out of its response.
    const omitted = one(spec, makeEvidenceBundle({ crm: makeCrmEvidence({ properties: {} }) }));
    // The provider never answered at all.
    const outage = one(
      spec,
      makeEmptyBundle({ gaps: [makeGap({ source: 'crm_record', code: 'PROVIDER_UNAVAILABLE' })] }),
    );
    expect(omitted.status).toBe('UNKNOWN');
    expect(outage.status).toBe('UNKNOWN');
    expect(omitted.reason_code).toBe('EVIDENCE_NOT_RETURNED');
    expect(outage.reason_code).toBe('EVIDENCE_UNAVAILABLE');
    expect(omitted.reason_code).not.toBe(outage.reason_code);
  });

  it('VERIFY-191 a customer claim is distinguishable from an unreachable provider', () => {
    const claim = one(existsSpec, makeClaimedBundle());
    const outage = one(
      existsSpec,
      makeEmptyBundle({ gaps: [makeGap({ source: 'crm_record', code: 'PROVIDER_UNAVAILABLE' })] }),
    );
    const permission = one(
      existsSpec,
      makeEmptyBundle({
        gaps: [makeGap({ source: 'crm_record', code: 'PERMISSION_MISSING', retryable: false })],
      }),
    );
    expect(claim.reason_code).toBe('CLAIM_NOT_INDEPENDENT');
    expect(outage.reason_code).toBe('EVIDENCE_UNAVAILABLE');
    expect(permission.reason_code).toBe('CONNECTION_UNAVAILABLE');
    expect(new Set([claim.reason_code, outage.reason_code, permission.reason_code]).size).toBe(3);
  });

  it('VERIFY-192 unreadable evidence is reported as answered-but-unusable, not as an outage', () => {
    const bundle = makeEmptyBundle({
      gaps: [makeGap({ source: 'crm_record', code: 'INVALID_EVIDENCE', retryable: false })],
    });
    const r = one(existsSpec, bundle);
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('EVIDENCE_NOT_RETURNED');
  });
});

describe('evaluateAssertions — configuration the evaluator refuses to guess at', () => {
  it('VERIFY-063 a rule addressing record.property without a property name is RULE_UNSUPPORTED', () => {
    const spec = makeRawAssertion({
      field: 'record.property',
      operator: 'equals',
      expected: 'lead',
    });
    const r = one(spec, makeEvidenceBundle());
    expect(r.status).toBe('UNKNOWN');
    expect(r.reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-064 provider_status_in against a field other than message.status is RULE_UNSUPPORTED', () => {
    const spec = makeRawAssertion({
      source: 'email_event',
      field: 'message.recipient',
      operator: 'provider_status_in',
      expected: ['delivered'],
    });
    expect(one(spec, makeEvidenceBundle()).reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-065 occurred_within with a non-numeric window is RULE_UNSUPPORTED', () => {
    const spec = makeRawAssertion({
      field: 'record.created_at',
      operator: 'occurred_within',
      expected: 'soon',
    });
    expect(one(spec, makeEvidenceBundle()).reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-066 provider_status_in naming a status outside the vocabulary is RULE_UNSUPPORTED', () => {
    const spec = makeRawAssertion({
      source: 'email_event',
      field: 'message.status',
      operator: 'provider_status_in',
      expected: ['read_by_a_human'],
    });
    expect(one(spec, makeEvidenceBundle()).reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-067 a field that belongs to the other evidence source is RULE_UNSUPPORTED', () => {
    const spec = makeRawAssertion({
      source: 'email_event',
      field: 'record.id',
      operator: 'exists',
      expected: '',
    });
    expect(one(spec, makeEvidenceBundle()).reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-068 an unknown field is RULE_UNSUPPORTED rather than silently absent', () => {
    const spec = makeRawAssertion({
      field: 'record.secret_sauce',
      operator: 'exists',
      expected: '',
    });
    expect(one(spec, makeEvidenceBundle()).reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-069 one_of with an empty allowed list is RULE_UNSUPPORTED, not vacuously false', () => {
    const spec = makeRawAssertion({
      field: 'record.property',
      property_name: 'lifecyclestage',
      operator: 'one_of',
      expected: [],
    });
    expect(one(spec, makeEvidenceBundle()).reason_code).toBe('RULE_UNSUPPORTED');
  });

  it('VERIFY-070 a workflow whose assertions are all optional is rejected', () => {
    const rules = makeRawWorkflowRules({
      assertions: [
        makeRawAssertion({ mandatory: false }),
        makeRawAssertion({ rule_id: 'r2', mandatory: false }),
      ],
    });
    expect(() => evaluateAssertions(rules, makeEvidenceBundle(), CTX)).toThrowError(AppError);
    try {
      evaluateAssertions(rules, makeEvidenceBundle(), CTX);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).httpStatus).toBe(422);
      expect((error as AppError).code).toBe('WORKFLOW_RULES_INVALID');
    }
  });

  it('VERIFY-071 a workflow with no assertions at all is rejected', () => {
    const rules = makeRawWorkflowRules({ assertions: [] });
    expect(() => evaluateAssertions(rules, makeEvidenceBundle(), CTX)).toThrowError(AppError);
  });

  it('VERIFY-072 duplicate rule ids are rejected rather than silently collapsed', () => {
    const rules = makeRawWorkflowRules({ assertions: [makeRawAssertion(), makeRawAssertion()] });
    expect(() => evaluateAssertions(rules, makeEvidenceBundle(), CTX)).toThrowError(AppError);
  });

  it('VERIFY-073 more assertions than the contract allows is rejected', () => {
    const assertions = Array.from({ length: 11 }, (_, i) =>
      makeRawAssertion({ rule_id: `rule_${i}` }),
    );
    expect(() =>
      evaluateAssertions(makeRawWorkflowRules({ assertions }), makeEvidenceBundle(), CTX),
    ).toThrowError(AppError);
  });

  it('VERIFY-074 the frozen contract itself rejects an all-optional workflow', () => {
    expect(() =>
      makeWorkflowRules({ assertions: [makeAssertion({ mandatory: false })] }),
    ).toThrowError();
  });
});

describe('evaluateAssertions — determinism and shape', () => {
  it('VERIFY-075 the same rules and evidence produce identical results regardless of now', () => {
    const rules = makeStandardWorkflow();
    const bundle = makeEvidenceBundle();
    const a = evaluateAssertions(rules, bundle, { ...CTX, now: T_INSIDE_WINDOW });
    const b = evaluateAssertions(rules, bundle, { ...CTX, now: T_AFTER_DEADLINE });
    expect(a).toEqual(b);
  });

  it('VERIFY-076 every result carries the rule id, label, mandatory flag and a reason code', () => {
    const results = evaluateAssertions(makeStandardWorkflow(), makeEvidenceBundle(), CTX);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(typeof r.rule_id).toBe('string');
      expect(r.label.length).toBeGreaterThan(0);
      expect(typeof r.mandatory).toBe('boolean');
      expect(typeof r.reason_code).toBe('string');
      expect(typeof r.expected_display).toBe('string');
    }
  });

  it('VERIFY-077 the happy path supports every assertion in the shipping workflow', () => {
    const results = evaluateAssertions(makeStandardWorkflow(), makeEvidenceBundle(), CTX);
    expect(results.every((r) => r.status === 'SUPPORTED')).toBe(true);
  });

  it('VERIFY-078 observed_at carries the provider event timestamp, not our observation time', () => {
    const spec = makeAssertion({
      rule_id: 'email_delivered',
      source: 'email_event',
      field: 'message.status',
      operator: 'provider_status_in',
      expected: ['delivered'],
    });
    const bundle = makeEvidenceBundle({
      email_events: [
        makeEmailEvent({ occurred_at: isoAfter(T_EVENT, 45), observed_at: isoAfter(T_EVENT, 900) }),
      ],
    });
    expect(one(spec, bundle).observed_at).toBe(isoAfter(T_EVENT, 45));
  });

  it('VERIFY-079 expected_display describes a time window in words a customer can read', () => {
    const spec = makeAssertion({
      rule_id: 'created_in_window',
      field: 'record.created_at',
      operator: 'occurred_within',
      expected: 300,
    });
    expect(one(spec, makeEvidenceBundle()).expected_display).toBe(
      'within 300 seconds of the enquiry',
    );
  });
});
