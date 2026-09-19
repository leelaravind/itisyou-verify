import { describe, expect, it } from 'vitest';
import { REASON_CODE, RUN_STATUS, type ReasonCode } from '@verify/contracts';
import { explainAssertion, explainReasonCode, explainRun, explainRunStatus } from '@verify/domain';
import { makeResult, mandatoryResult } from '../../fixtures/index.js';

/** Words that mean nothing to the person reading a verification report. */
const JARGON = [
  'assertion',
  'evaluator',
  'idempotenc',
  'webhook',
  'payload',
  'connector',
  'null',
  'undefined',
  'HTTP',
  'endpoint',
  'schema',
  'boolean',
];

/** Words that would make us sound certain when we are not, or blame the customer. */
const FALSE_REASSURANCE = [
  'probably',
  'should be fine',
  'everything is working',
  'your fault',
  'you failed',
];

describe('explainReasonCode', () => {
  it('VERIFY-160 every reason code in the contract has an honest sentence', () => {
    for (const code of REASON_CODE) {
      const explanation = explainReasonCode(code);
      expect(explanation.code).toBe(code);
      expect(explanation.sentence.length).toBeGreaterThan(20);
      expect(explanation.sentence.endsWith('.')).toBe(true);
    }
  });

  it('VERIFY-161 no reason sentence uses internal jargon', () => {
    for (const code of REASON_CODE) {
      const text =
        `${explainReasonCode(code).sentence} ${explainReasonCode(code).next_step ?? ''}`.toLowerCase();
      for (const word of JARGON) {
        expect(text).not.toContain(word.toLowerCase());
      }
    }
  });

  it('VERIFY-162 no reason sentence offers false reassurance or blame', () => {
    for (const code of REASON_CODE) {
      const text =
        `${explainReasonCode(code).sentence} ${explainReasonCode(code).next_step ?? ''}`.toLowerCase();
      for (const phrase of FALSE_REASSURANCE) {
        expect(text).not.toContain(phrase);
      }
    }
  });

  it('VERIFY-163 an unreachable provider is explained as unverified, not as a failure', () => {
    const explanation = explainReasonCode('CONNECTION_UNAVAILABLE');
    expect(explanation.sentence).toContain('unverified rather than failed');
    expect(explanation.sentence).toContain('we could not look');
  });

  it('VERIFY-164 the delivery-status explanation states plainly that accepted is not delivered', () => {
    const explanation = explainReasonCode('STATUS_NOT_REACHED');
    expect(explanation.sentence).toContain('not the same as being delivered');
  });

  it('VERIFY-165 a next step is offered only where an action genuinely exists', () => {
    expect(explainReasonCode('MATCHED').next_step).toBeNull();
    expect(explainReasonCode('RECORD_AMBIGUOUS').next_step).not.toBeNull();
    expect(explainReasonCode('CORRELATION_MISSING').next_step).not.toBeNull();
  });
});

describe('explainAssertion', () => {
  it('VERIFY-166 a supported assertion reads as confirmed and offers no busywork', () => {
    const explanation = explainAssertion(mandatoryResult('rule_1', 'SUPPORTED', 'MATCHED'));
    expect(explanation.headline.startsWith('Confirmed')).toBe(true);
    expect(explanation.next_step).toBeNull();
  });

  it('VERIFY-167 a contradicted assertion shows what was expected against what was observed', () => {
    const result = makeResult({
      status: 'CONTRADICTED',
      reason_code: 'VALUE_MISMATCH',
      expected_display: 'enq_0000000000000001',
      observed_display: 'enq_other',
    });
    const explanation = explainAssertion(result);
    expect(explanation.detail).toBe('We expected enq_0000000000000001. We observed enq_other.');
    expect(explanation.next_step).not.toBeNull();
  });

  it('VERIFY-168 an assertion with no retrieved value says so rather than inventing one', () => {
    const result = makeResult({
      status: 'UNKNOWN',
      reason_code: 'AWAITING_EVIDENCE',
      observed_display: null,
    });
    expect(explainAssertion(result).detail).toContain('We did not retrieve a value.');
  });

  it('VERIFY-169 an unknown assertion is headlined as "could not confirm", never as a failure', () => {
    const explanation = explainAssertion(
      mandatoryResult('rule_1', 'UNKNOWN', 'CONNECTION_UNAVAILABLE'),
    );
    expect(explanation.headline.startsWith('Could not confirm')).toBe(true);
    expect(explanation.headline.toLowerCase()).not.toContain('failed');
  });
});

describe('explainRunStatus', () => {
  it('VERIFY-170 every run status has a headline, a sentence and a defined next step', () => {
    for (const status of RUN_STATUS) {
      const explanation = explainRunStatus(status);
      expect(explanation.headline.length).toBeGreaterThan(0);
      expect(explanation.sentence.length).toBeGreaterThan(20);
      expect(explanation.next_step === null || explanation.next_step.length > 0).toBe(true);
    }
  });

  it('VERIFY-171 UNVERIFIED is explained as "not a failure" in so many words', () => {
    expect(explainRunStatus('UNVERIFIED').sentence).toContain('not a failure');
  });

  it('VERIFY-172 VERIFIED claims independent evidence, not merely the absence of a problem', () => {
    expect(explainRunStatus('VERIFIED').sentence).toContain('independently retrieved');
  });

  it('VERIFY-173 explainRun returns a run explanation alongside one per assertion', () => {
    const results: ReadonlyArray<ReturnType<typeof mandatoryResult>> = [
      mandatoryResult('a', 'SUPPORTED', 'MATCHED'),
      mandatoryResult('b', 'UNKNOWN', 'EVIDENCE_UNAVAILABLE'),
    ];
    const explanation = explainRun('PENDING', results);
    expect(explanation.run.status).toBe('PENDING');
    expect(explanation.assertions).toHaveLength(2);
    expect(explanation.assertions.map((a) => a.rule_id)).toEqual(['a', 'b']);
  });

  it('VERIFY-174 a reason code missing from the map would be caught at compile time, and none is missing at runtime', () => {
    const codes: ReasonCode[] = [...REASON_CODE];
    expect(codes.every((code) => explainReasonCode(code).sentence.length > 0)).toBe(true);
    expect(codes).toHaveLength(17);
  });

  it('VERIFY-194 an omitted field reads differently from an unreachable provider', () => {
    const omitted = explainReasonCode('EVIDENCE_NOT_RETURNED');
    const outage = explainReasonCode('EVIDENCE_UNAVAILABLE');
    expect(omitted.sentence).toContain('answered us');
    expect(omitted.sentence).toContain('did not include this field');
    expect(outage.sentence).toContain('could not retrieve');
    expect(omitted.sentence).not.toBe(outage.sentence);
  });

  it('VERIFY-195 a customer claim is explained without calling the customer dishonest', () => {
    const claim = explainReasonCode('CLAIM_NOT_INDEPENDENT');
    // Unambiguous about what it is.
    expect(claim.sentence).toContain('your own automation');
    expect(claim.sentence).toContain('not something we can count as proof');
    // Gentle about what it is not.
    expect(claim.sentence).toContain('We are not doubting it');
    for (const accusation of ['lie', 'lying', 'false claim', 'dishonest', 'untrue', 'fabricat']) {
      expect(claim.sentence.toLowerCase()).not.toContain(accusation);
    }
    expect(claim.next_step).not.toBeNull();
  });
});
