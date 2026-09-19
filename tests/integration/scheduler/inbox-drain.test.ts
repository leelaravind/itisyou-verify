/**
 * The scheduler drains the evidence inbox for the run that was waiting.
 *
 * ## Why this file exists
 *
 * The inbox closes a real ordering problem: a provider fires `email.sent` within
 * milliseconds of the send, and the signed source event describing the enquiry arrives
 * afterwards. That callback matches no run at the time, so it is parked.
 *
 * Parking it is only half a fix. Something has to claim it, and on 19 September 2026 the
 * claim existed and nothing called it -- the port had `claimInboxForRun`, it was tested,
 * and no code path reached it. That is this project's dominant defect class, found for the
 * thirteenth time, and it is why the assertion here is made through `harness.tick()`
 * rather than by calling the claim directly. Calling the claim directly is what the port
 * tests already do, and it is exactly the test that cannot catch this.
 *
 * Case ids `CONN-350..352`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type WorkflowRules } from '@verify/contracts';
import { composeWorkflowRules } from '@app/db/ruleCompiler';
import { makeCrmEvidence, makeEmailEvent } from '../../fixtures/index.js';
import {
  at,
  bundleScript,
  iso,
  connectedResolver,
  createSchedulerHarness,
  makeFakeConnector,
  makeRegistry,
  type SchedulerHarness,
} from './harness';

const ENQUIRER = 'ada@example.test';
const MESSAGE_ID = 'msg_parked_0001';

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

/** The connection the callback came in on. `evidence_inbox` references it. */
const CONNECTION_ID = 'conn_inbox_drain';

function seedConnection(harness: SchedulerHarness): void {
  harness.h.raw
    .prepare(
      `INSERT INTO connections (id, workspace_id, provider, status, scopes, created_at)
       VALUES (?, ?, 'resend', 'ready', '[]', ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(CONNECTION_ID, harness.ws.workspaceId, iso(0));
}

/** A callback that arrived before any run existed, parked exactly as the webhook parks it. */
function park(harness: SchedulerHarness, messageId: string, id = 'ebx_1'): void {
  seedConnection(harness);
  harness.h.raw
    .prepare(
      `INSERT INTO evidence_inbox
         (id, workspace_id, connection_id, provider, provider_event_id, message_id,
          reason, content_digest, redacted_summary, observed_at, received_at, expires_at)
       VALUES (?, ?, ?, 'resend', ?, ?, 'unmatched', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      harness.ws.workspaceId,
      CONNECTION_ID,
      `evt_${id}`,
      messageId,
      `digest_${id}`,
      JSON.stringify({ kind: 'email_event', status: 'delivered', message_id: messageId }),
      iso(0),
      iso(0),
      iso(60 * 60 * 24 * 30),
    );
}

function inboxRow(harness: SchedulerHarness, id = 'ebx_1') {
  return harness.h.raw
    .prepare('SELECT claimed_at, claimed_run_id FROM evidence_inbox WHERE id = ?')
    .get(id) as { claimed_at: string | null; claimed_run_id: string | null } | undefined;
}

let harness: SchedulerHarness;

beforeEach(() => {
  harness = createSchedulerHarness({ rules: customerRules() });
});

afterEach(() => {
  harness.close();
});

describe('the scheduler claims callbacks that arrived before their run', () => {
  const observe = () =>
    harness.tick({
      now: at(1),
      resolver: connectedResolver(),
      connectors: (() => {
        const script = bundleScript({
          crm: makeCrmEvidence(),
          email_events: [makeEmailEvent({ recipient: ENQUIRER })],
          gaps: [],
        });
        return makeRegistry(
          makeFakeConnector('hubspot', script.hubspot),
          makeFakeConnector('resend', script.resend),
        );
      })(),
    });

  it('CONN-350 a parked callback is claimed by the run that names its message id', async () => {
    park(harness, MESSAGE_ID);
    const runId = await harness.admit('evt-350', {
      recipient: ENQUIRER,
      emailMessageId: MESSAGE_ID,
    });

    await observe();

    const row = inboxRow(harness);
    expect(row?.claimed_at, 'the tick did not drain the inbox').not.toBeNull();
    expect(row?.claimed_run_id).toBe(runId);
  });

  it('CONN-351 a parked callback for a different message is left alone', async () => {
    park(harness, 'msg_someone_elses');
    await harness.admit('evt-351', { recipient: ENQUIRER, emailMessageId: MESSAGE_ID });

    await observe();

    // The address matches this run perfectly and the message id does not. It stays parked.
    expect(inboxRow(harness)?.claimed_at).toBeNull();
  });

  it('CONN-352 a run that names no message id claims nothing', async () => {
    park(harness, MESSAGE_ID);
    await harness.admit('evt-352', { recipient: ENQUIRER });

    await observe();

    expect(inboxRow(harness)?.claimed_at).toBeNull();
  });
});
