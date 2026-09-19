import { describe, expect, it } from 'vitest';
import { AppError, type AssertionStatus, type ReasonCode } from '@verify/contracts';
import { decideRunStatus, summariseMandatory, type DecisionContext } from '@verify/domain';
import {
  T_AFTER_DEADLINE,
  T_AT_DEADLINE,
  T_DEADLINE,
  T_INSIDE_WINDOW,
  mandatoryResult,
  optionalResult,
} from '../../fixtures/index.js';

const BEFORE: DecisionContext = {
  deadlineAt: T_DEADLINE,
  now: T_INSIDE_WINDOW,
  hasWorkingEvidenceAccess: true,
  observationsRemaining: 2,
};

const AT: DecisionContext = { ...BEFORE, now: T_AT_DEADLINE };
const AFTER: DecisionContext = { ...BEFORE, now: T_AFTER_DEADLINE, observationsRemaining: 0 };
const BLIND_BEFORE: DecisionContext = { ...BEFORE, hasWorkingEvidenceAccess: false };
const BLIND_AFTER: DecisionContext = { ...AFTER, hasWorkingEvidenceAccess: false };

const supported = (id: string) => mandatoryResult(id, 'SUPPORTED', 'MATCHED');
const contradicted = (id: string) => mandatoryResult(id, 'CONTRADICTED', 'VALUE_MISMATCH');
const unknownWaiting = (id: string) => mandatoryResult(id, 'UNKNOWN', 'AWAITING_EVIDENCE');
const unknownBlind = (id: string) => mandatoryResult(id, 'UNKNOWN', 'CONNECTION_UNAVAILABLE');
const unknownAbsent = (id: string) => mandatoryResult(id, 'UNKNOWN', 'RECORD_NOT_FOUND');

describe('decideRunStatus — all mandatory supported', () => {
  it('VERIFY-080 returns VERIFIED before the deadline when every mandatory check is supported', () => {
    const d = decideRunStatus([supported('a'), supported('b')], BEFORE);
    expect(d.status).toBe('VERIFIED');
  });

  it('VERIFY-081 returns VERIFIED at and after the deadline when every mandatory check is supported', () => {
    expect(decideRunStatus([supported('a')], AT).status).toBe('VERIFIED');
    expect(decideRunStatus([supported('a')], AFTER).status).toBe('VERIFIED');
  });

  it('VERIFY-082 VERIFIED requires every mandatory assertion, not merely the absence of a contradiction', () => {
    const d = decideRunStatus([supported('a'), unknownWaiting('b')], BEFORE);
    expect(d.status).not.toBe('VERIFIED');
  });

  it('VERIFY-083 an unsupported mandatory check keeps VERIFIED off the table even after the deadline', () => {
    expect(decideRunStatus([supported('a'), unknownWaiting('b')], AFTER).status).toBe('UNVERIFIED');
  });
});

describe('decideRunStatus — contradiction is definitive', () => {
  it('VERIFY-084 one contradicted mandatory check fails the run however many passed', () => {
    const results = [
      supported('a'),
      supported('b'),
      supported('c'),
      supported('d'),
      contradicted('e'),
    ];
    const d = decideRunStatus(results, BEFORE);
    expect(d.status).toBe('FAILED');
  });

  it('VERIFY-085 there is no majority vote: nine passes and one contradiction is still FAILED', () => {
    const results = [...Array.from({ length: 9 }, (_, i) => supported(`a${i}`)), contradicted('z')];
    expect(decideRunStatus(results, BEFORE).status).toBe('FAILED');
    expect(decideRunStatus(results, AFTER).status).toBe('FAILED');
  });

  it('VERIFY-086 a contradiction fails the run before the deadline, not only at it', () => {
    expect(decideRunStatus([contradicted('a')], BEFORE).status).toBe('FAILED');
  });

  it('VERIFY-087 a definitive mandatory failure beats any number of unknowns before the deadline', () => {
    const results = [contradicted('a'), unknownWaiting('b'), unknownBlind('c')];
    expect(decideRunStatus(results, BEFORE).status).toBe('FAILED');
  });

  it('VERIFY-088 a definitive mandatory failure beats any number of unknowns after the deadline', () => {
    const results = [contradicted('a'), unknownWaiting('b'), unknownBlind('c')];
    expect(decideRunStatus(results, AFTER).status).toBe('FAILED');
  });

  it('VERIFY-089 a contradiction fails the run even while evidence access is broken', () => {
    expect(decideRunStatus([contradicted('a'), unknownBlind('b')], BLIND_AFTER).status).toBe(
      'FAILED',
    );
  });

  it('VERIFY-090 a wrong CRM field fails the run even though the email assertion passed', () => {
    const results = [
      mandatoryResult('crm_correlation_matches', 'CONTRADICTED', 'VALUE_MISMATCH'),
      mandatoryResult('email_delivered', 'SUPPORTED', 'MATCHED'),
    ];
    const d = decideRunStatus(results, BEFORE);
    expect(d.status).toBe('FAILED');
    expect(d.reason).toContain('contradicted');
  });
});

describe('decideRunStatus — unknown evidence', () => {
  it('VERIFY-091 mandatory unknown with a healthy source is PENDING before the deadline', () => {
    const d = decideRunStatus([unknownWaiting('a')], BEFORE);
    expect(d.status).toBe('PENDING');
  });

  it('VERIFY-092 mandatory unknown with a healthy source is UNVERIFIED at the deadline when absence was not established', () => {
    expect(decideRunStatus([unknownWaiting('a')], { ...AT, observationsRemaining: 0 }).status).toBe(
      'UNVERIFIED',
    );
  });

  it('VERIFY-093 mandatory unknown becomes FAILED at the deadline only when the connector established absence', () => {
    const d = decideRunStatus([unknownAbsent('a')], AFTER);
    expect(d.status).toBe('FAILED');
    expect(d.reason).toContain('does not exist');
  });

  it('VERIFY-094 an established absence does NOT fail the run before the deadline', () => {
    expect(decideRunStatus([unknownAbsent('a')], BEFORE).status).toBe('PENDING');
  });

  it('VERIFY-095 an established absence does not fail the run when evidence access is broken', () => {
    expect(decideRunStatus([unknownAbsent('a')], BLIND_AFTER).status).toBe('UNVERIFIED');
  });

  it('VERIFY-096 an established absence mixed with an ordinary unknown resolves as UNVERIFIED, not FAILED', () => {
    expect(decideRunStatus([unknownAbsent('a'), unknownWaiting('b')], AFTER).status).toBe(
      'UNVERIFIED',
    );
  });

  it('VERIFY-097 an ambiguous correlation is UNVERIFIED at the deadline, never FAILED', () => {
    const results = [mandatoryResult('a', 'UNKNOWN', 'RECORD_AMBIGUOUS')];
    expect(decideRunStatus(results, AFTER).status).toBe('UNVERIFIED');
  });

  it('VERIFY-098 an assertion still marked PENDING counts as unresolved, never as a pass', () => {
    const results = [supported('a'), mandatoryResult('b', 'PENDING', 'AWAITING_EVIDENCE')];
    expect(decideRunStatus(results, BEFORE).status).toBe('PENDING');
    expect(decideRunStatus(results, AFTER).status).toBe('UNVERIFIED');
  });
});

describe('decideRunStatus — provider inaccessible', () => {
  it('VERIFY-099 an inaccessible provider is PENDING before the deadline, with a bounded retry left', () => {
    const d = decideRunStatus([unknownBlind('a')], BLIND_BEFORE);
    expect(d.status).toBe('PENDING');
    expect(d.reason).toContain('could not reach');
  });

  it('VERIFY-100 an inaccessible provider is UNVERIFIED at the deadline, not FAILED', () => {
    const d = decideRunStatus([unknownBlind('a')], BLIND_AFTER);
    expect(d.status).toBe('UNVERIFIED');
    expect(d.reason).toContain('unverified rather than failed');
  });

  it('VERIFY-101 missing permission produces the same UNVERIFIED outcome as an outage', () => {
    const results = [mandatoryResult('a', 'UNKNOWN', 'CONNECTION_UNAVAILABLE')];
    expect(decideRunStatus(results, { ...AFTER, hasWorkingEvidenceAccess: false }).status).toBe(
      'UNVERIFIED',
    );
  });
});

describe('decideRunStatus — mixed results', () => {
  it('VERIFY-102 some pass and others unknown is PENDING before the deadline', () => {
    expect(decideRunStatus([supported('a'), unknownWaiting('b')], BEFORE).status).toBe('PENDING');
  });

  it('VERIFY-103 some pass and others unknown is UNVERIFIED after the deadline', () => {
    expect(decideRunStatus([supported('a'), unknownWaiting('b')], AFTER).status).toBe('UNVERIFIED');
  });

  it('VERIFY-104 some pass and others unknown is still FAILED when a mandatory failure exists', () => {
    expect(
      decideRunStatus([supported('a'), unknownWaiting('b'), contradicted('c')], AFTER).status,
    ).toBe('FAILED');
  });

  it('VERIFY-105 the moment of the deadline itself counts as at-deadline, not before it', () => {
    const results = [unknownWaiting('a')];
    expect(decideRunStatus(results, { ...AT, observationsRemaining: 3 }).status).toBe('UNVERIFIED');
  });
});

describe('decideRunStatus — optional assertions never change the outcome', () => {
  it('VERIFY-106 a contradicted optional assertion cannot fail a run', () => {
    const results = [supported('a'), optionalResult('opt', 'CONTRADICTED', 'VALUE_MISMATCH')];
    expect(decideRunStatus(results, BEFORE).status).toBe('VERIFIED');
    expect(decideRunStatus(results, AFTER).status).toBe('VERIFIED');
  });

  it('VERIFY-107 an unknown optional assertion cannot hold a run back from VERIFIED', () => {
    const results = [supported('a'), optionalResult('opt', 'UNKNOWN', 'EVIDENCE_UNAVAILABLE')];
    expect(decideRunStatus(results, BEFORE).status).toBe('VERIFIED');
  });

  it('VERIFY-108 a supported optional assertion cannot rescue an unresolved mandatory one', () => {
    const results = [unknownWaiting('a'), optionalResult('opt', 'SUPPORTED', 'MATCHED')];
    expect(decideRunStatus(results, AFTER).status).toBe('UNVERIFIED');
  });

  it('VERIFY-109 optional assertions are excluded from the mandatory summary counts', () => {
    const results = [
      supported('a'),
      contradicted('b'),
      optionalResult('opt', 'SUPPORTED', 'MATCHED'),
    ];
    const summary = summariseMandatory(results);
    expect(summary).toEqual({
      total: 2,
      supported: 1,
      contradicted: 1,
      unresolved: 0,
      optional_total: 1,
    });
  });
});

describe('decideRunStatus — configuration errors and fault injection', () => {
  it('VERIFY-110 an empty mandatory set is a configuration error, never a VERIFIED', () => {
    const results = [optionalResult('opt', 'SUPPORTED', 'MATCHED')];
    expect(() => decideRunStatus(results, BEFORE)).toThrowError(AppError);
    try {
      decideRunStatus(results, BEFORE);
    } catch (error) {
      expect((error as AppError).httpStatus).toBe(422);
    }
  });

  it('VERIFY-111 an empty result set is a configuration error, never a VERIFIED', () => {
    expect(() => decideRunStatus([], AFTER)).toThrowError(AppError);
  });

  it('VERIFY-112 an exhausted observation budget resolves the run as UNVERIFIED, not VERIFIED', () => {
    const d = decideRunStatus([unknownWaiting('a')], { ...BEFORE, observationsRemaining: 0 });
    expect(d.status).toBe('UNVERIFIED');
    expect(d.reason).toContain('every observation');
  });

  it('VERIFY-113 a run where every check is unknown can never become VERIFIED, whatever the deadline or budget', () => {
    const reasons: ReasonCode[] = [
      'AWAITING_EVIDENCE',
      'EVIDENCE_UNAVAILABLE',
      'EVIDENCE_NOT_RETURNED',
      'CLAIM_NOT_INDEPENDENT',
      'CONNECTION_UNAVAILABLE',
      'RECORD_AMBIGUOUS',
      'RECORD_NOT_FOUND',
      'EVENT_NOT_OBSERVED',
      'STATUS_NOT_REACHED',
      'RULE_UNSUPPORTED',
    ];
    const clocks = [T_INSIDE_WINDOW, T_AT_DEADLINE, T_AFTER_DEADLINE];
    const budgets = [0, 1, 4, 99];
    const access = [true, false];
    let checked = 0;
    for (const reason of reasons) {
      for (const now of clocks) {
        for (const observationsRemaining of budgets) {
          for (const hasWorkingEvidenceAccess of access) {
            const results = [
              mandatoryResult('a', 'UNKNOWN', reason),
              mandatoryResult('b', 'UNKNOWN', reason),
            ];
            const d = decideRunStatus(results, {
              deadlineAt: T_DEADLINE,
              now,
              hasWorkingEvidenceAccess,
              observationsRemaining,
            });
            expect(d.status).not.toBe('VERIFIED');
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(reasons.length * clocks.length * budgets.length * access.length);
  });

  it('VERIFY-114 result ordering never changes the decision', () => {
    const base = [supported('a'), unknownWaiting('b'), contradicted('c')];
    const reversed = [...base].reverse();
    const shuffled = [base[1]!, base[2]!, base[0]!];
    const expected = decideRunStatus(base, AFTER);
    expect(decideRunStatus(reversed, AFTER)).toEqual(expected);
    expect(decideRunStatus(shuffled, AFTER)).toEqual(expected);
  });

  it('VERIFY-193 neither an omitted field nor a customer claim can fail a run at the deadline', () => {
    // Only an authoritatively established absence may turn UNKNOWN into FAILED. A field the
    // provider left out proves nothing, and a customer's own claim proves nothing either.
    for (const reason of ['EVIDENCE_NOT_RETURNED', 'CLAIM_NOT_INDEPENDENT'] as const) {
      const results = [mandatoryResult('a', 'UNKNOWN', reason)];
      expect(decideRunStatus(results, BEFORE).status).toBe('PENDING');
      expect(decideRunStatus(results, AFTER).status).toBe('UNVERIFIED');
    }
  });

  it('VERIFY-115 every mandatory status combination resolves to exactly one of the four statuses', () => {
    const statuses: AssertionStatus[] = ['SUPPORTED', 'CONTRADICTED', 'UNKNOWN', 'PENDING'];
    const allowed = new Set(['PENDING', 'VERIFIED', 'FAILED', 'UNVERIFIED']);
    for (const first of statuses) {
      for (const second of statuses) {
        const results = [
          mandatoryResult('a', first, 'MATCHED'),
          mandatoryResult('b', second, 'MATCHED'),
        ];
        expect(allowed.has(decideRunStatus(results, BEFORE).status)).toBe(true);
        expect(allowed.has(decideRunStatus(results, AFTER).status)).toBe(true);
      }
    }
  });
});
