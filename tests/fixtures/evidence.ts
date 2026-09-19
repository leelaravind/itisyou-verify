/**
 * Typed builders for normalised evidence. Shared across the domain, connector and ledger
 * suites so nobody hand-rolls an object that drifts from the frozen contract.
 *
 * Everything here is synthetic: `example.test` addresses, invented record ids, invented
 * account ids. No real record, no real token, no real recipient.
 */
import type {
  CrmRecordEvidence,
  EmailEventEvidence,
  EmailStatus,
  EvidenceBundle,
  EvidenceGap,
  EvidenceOrigin,
} from '@verify/contracts';
import { T_EVENT, isoAfter } from './time.js';

/** The provider account id the workspace has actually connected. */
export const CONNECTED_CRM_ACCOUNT = 'hub-acct-1000';
/** The provider account id the workspace has actually connected for email. */
export const CONNECTED_EMAIL_ACCOUNT = 'resend-acct-2000';
/** A different tenant's account. Evidence carrying this is never our customer's evidence. */
export const FOREIGN_ACCOUNT = 'hub-acct-9999';

export const CORRELATION_VALUE = 'enq_0000000000000001';
export const RECIPIENT = 'ada@example.test';

export function makeCrmEvidence(overrides: Partial<CrmRecordEvidence> = {}): CrmRecordEvidence {
  return {
    kind: 'crm_record',
    origin: 'provider_readback',
    provider: 'hubspot',
    provider_account_id: CONNECTED_CRM_ACCOUNT,
    record_id: 'crm-rec-1',
    email: RECIPIENT,
    correlation_value: CORRELATION_VALUE,
    created_at: isoAfter(T_EVENT, 30),
    properties: { lifecyclestage: 'lead', source_channel: 'website' },
    observed_at: isoAfter(T_EVENT, 60),
    ...overrides,
  };
}

export function makeEmailEvent(overrides: Partial<EmailEventEvidence> = {}): EmailEventEvidence {
  return {
    kind: 'email_event',
    origin: 'provider_readback',
    provider: 'resend',
    provider_account_id: CONNECTED_EMAIL_ACCOUNT,
    message_id: 'msg-1',
    recipient: RECIPIENT,
    status: 'delivered',
    occurred_at: isoAfter(T_EVENT, 45),
    observed_at: isoAfter(T_EVENT, 60),
    ...overrides,
  };
}

/** An email event at a chosen rung of the delivery ladder. */
export function makeEmailEventWithStatus(
  status: EmailStatus,
  overrides: Partial<EmailEventEvidence> = {},
): EmailEventEvidence {
  return makeEmailEvent({ status, message_id: `msg-${status}`, ...overrides });
}

export function makeGap(overrides: Partial<EvidenceGap> = {}): EvidenceGap {
  return {
    source: 'crm_record',
    code: 'PROVIDER_UNAVAILABLE',
    retryable: true,
    detail: 'The provider did not respond in time.',
    ...overrides,
  };
}

/** A bundle where everything the happy path needs is present and independently retrieved. */
export function makeEvidenceBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    crm: makeCrmEvidence(),
    email_events: [makeEmailEvent()],
    gaps: [],
    ...overrides,
  };
}

/** A bundle with nothing in it and no explanation — we cannot claim the connector looked. */
export function makeEmptyBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return { crm: null, email_events: [], gaps: [], ...overrides };
}

/** A bundle where both sources were unreachable. */
export function makeUnreachableBundle(code = 'PROVIDER_UNAVAILABLE'): EvidenceBundle {
  return {
    crm: null,
    email_events: [],
    gaps: [
      makeGap({ source: 'crm_record', code, retryable: code !== 'PERMISSION_MISSING' }),
      makeGap({ source: 'email_event', code, retryable: code !== 'PERMISSION_MISSING' }),
    ],
  };
}

/** Evidence the customer told us about themselves. A trigger, never proof. */
export function makeClaimedBundle(origin: EvidenceOrigin = 'customer_claim'): EvidenceBundle {
  return {
    crm: makeCrmEvidence({ origin }),
    email_events: [makeEmailEvent({ origin })],
    gaps: [],
  };
}
