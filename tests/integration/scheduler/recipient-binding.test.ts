/**
 * A verified run means the acknowledgement reached the enquirer.
 *
 * This is the closure evidence for the gap-register row "A verified run does not prove the
 * acknowledgement reached the enquirer". Until 2026-09-19 the rule compiler asserted only
 * that `message.recipient` `exists`, so a run whose acknowledgement went to entirely the
 * wrong address came back VERIFIED. Every case here uses the rules a real workspace gets —
 * `composeWorkflowRules` with every check on — admits a run the way the API does, drives
 * the real tick against the real schema, and reads the row back.
 *
 * The connectors are fakes scripted with fixed evidence. No HubSpot or Resend credential
 * exists on this project, so nothing here has run against a live provider; what is proven
 * is the evaluator's per-run binding, end to end through the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type EvidenceBundle, type WorkflowRules } from '@verify/contracts';
import { composeWorkflowRules } from '@app/db/ruleCompiler';
import { makeCrmEvidence, makeEmailEvent } from '../../fixtures/index.js';
import {
  at,
  bundleScript,
  connectedResolver,
  createSchedulerHarness,
  makeFakeConnector,
  makeRegistry,
  type SchedulerHarness,
} from './harness';

const ENQUIRER = 'ada@example.test';
const SOMEONE_ELSE = 'someone-else@example.test';
const ENQUIRY = 'enq_0000000000000001';

/** Exactly what the onboarding forms publish with every check switched on. */
function customerRules(): WorkflowRules {
  const composed = composeWorkflowRules({
    correlationProperty: 'verify_correlation_id',
    deadlineSeconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
    coverageMode: 'customer_triggered',
    requireRecordExists: true,
    requireCorrelationMatch: true,
    requireEmailDelivered: true,
    requireRecipientMatch: true,
  });
  if (!composed.ok) throw new Error(composed.failure.message);
  return composed.rules;
}

function registryFor(bundle: EvidenceBundle) {
  const script = bundleScript(bundle);
  return makeRegistry(
    makeFakeConnector('hubspot', script.hubspot),
    makeFakeConnector('resend', script.resend),
  );
}

interface AssertionRow {
  rule_id: string;
  status: string;
  reason_code: string;
  expected_display: string | null;
  observed_display: string | null;
}

function assertionRows(harness: SchedulerHarness, runId: string): AssertionRow[] {
  return harness.h.raw
    .prepare(
      'SELECT rule_id, status, reason_code, expected_display, observed_display FROM assertions WHERE run_id = ? ORDER BY rule_id',
    )
    .all(runId) as unknown as AssertionRow[];
}

function row(harness: SchedulerHarness, runId: string, ruleId: string): AssertionRow {
  const found = assertionRows(harness, runId).find((r) => r.rule_id === ruleId);
  if (found === undefined) throw new Error(`no assertion row for ${ruleId}`);
  return found;
}

let harness: SchedulerHarness;

beforeEach(() => {
  harness = createSchedulerHarness({ rules: customerRules() });
});

afterEach(() => {
  harness.close();
});

describe('the acknowledgement must reach the address this enquiry named', () => {
  it('VERIFY-227 an acknowledgement delivered to the wrong address fails the run', async () => {
    const runId = await harness.admit('evt-227', { recipient: ENQUIRER });
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent({ recipient: SOMEONE_ELSE })],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).toBe('FAILED');

    const recipient = row(harness, runId, 'email_recipient_matches');
    expect(recipient.status).toBe('CONTRADICTED');
    expect(recipient.reason_code).toBe('VALUE_MISMATCH');
    // The expectation shown is this run's own address, not a literal from the version.
    expect(recipient.expected_display).toBe(ENQUIRER);
    expect(recipient.observed_display).toBe(SOMEONE_ELSE);
    // Everything else about the run was fine — this is the only thing that was wrong.
    for (const other of ['crm_record_exists', 'crm_correlation_matches', 'email_delivered']) {
      expect(row(harness, runId, other).status).toBe('SUPPORTED');
    }
  });

  it('VERIFY-228 the same run with the acknowledgement at the enquirer’s address is VERIFIED', async () => {
    const runId = await harness.admit('evt-228', { recipient: ENQUIRER });
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent({ recipient: ENQUIRER })],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).toBe('VERIFIED');
    expect(row(harness, runId, 'email_recipient_matches').status).toBe('SUPPORTED');
  });

  it('VERIFY-229 a plus-tagged variant of the enquirer’s address is the wrong address', async () => {
    const runId = await harness.admit('evt-229', { recipient: ENQUIRER });
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent({ recipient: 'ada+anything@example.test' })],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).toBe('FAILED');
    expect(row(harness, runId, 'email_recipient_matches').reason_code).toBe('VALUE_MISMATCH');
  });

  it('VERIFY-230 the binding is per run: an enquiry that named a different address verifies against that address', async () => {
    const runId = await harness.admit('evt-230', { recipient: SOMEONE_ELSE });
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent({ recipient: SOMEONE_ELSE })],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).toBe('VERIFIED');
    expect(row(harness, runId, 'email_recipient_matches').expected_display).toBe(SOMEONE_ELSE);
  });

  it('VERIFY-231 a CRM record carrying a different enquiry’s reference fails the run', async () => {
    const runId = await harness.admit('evt-231', { correlationId: ENQUIRY, recipient: ENQUIRER });
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        // What the record-id locator path can return: a real record, wrong enquiry.
        crm: makeCrmEvidence({ correlation_value: 'enq_0000000000000002' }),
        email_events: [makeEmailEvent({ recipient: ENQUIRER })],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).toBe('FAILED');
    const correlation = row(harness, runId, 'crm_correlation_matches');
    expect(correlation.status).toBe('CONTRADICTED');
    expect(correlation.expected_display).toBe(ENQUIRY);
    expect(correlation.observed_display).toBe('enq_0000000000000002');
  });

  it('VERIFY-232 an event we cannot read binds nothing: the bound checks are UNKNOWN and the run is not VERIFIED', async () => {
    const runId = await harness.admit('evt-232', { recipient: ENQUIRER });
    // The stored envelope is corrupted after admission, so `readLocator` yields nothing.
    harness.h.raw
      .prepare('UPDATE source_events SET payload_json = ? WHERE id = ?')
      .run('{"not":"an event"}', 'sev_evt-232');
    await harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: registryFor({
        crm: makeCrmEvidence(),
        email_events: [makeEmailEvent({ recipient: ENQUIRER })],
        gaps: [],
      }),
    });
    expect(harness.runRow(runId).status).not.toBe('VERIFIED');
    for (const bound of ['email_recipient_matches', 'crm_correlation_matches']) {
      const r = row(harness, runId, bound);
      expect(r.status).toBe('UNKNOWN');
      expect(r.reason_code).toBe('BINDING_UNAVAILABLE');
    }
  });
});
