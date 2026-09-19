/**
 * Frozen contract v1 — normalised evidence shapes returned by connectors.
 * Connectors translate provider payloads into these; the evaluator sees nothing else.
 */

/** Where an observation came from, and therefore how much it is worth. */
export type EvidenceOrigin =
  /** We asked the provider's API ourselves using the customer's connection. Strongest. */
  | 'provider_readback'
  /** The provider called us and we verified its signature against the raw bytes. Strong. */
  | 'provider_webhook'
  /** The customer's own automation told us. A trigger, never proof. */
  | 'customer_claim';

export interface CrmRecordEvidence {
  readonly kind: 'crm_record';
  readonly origin: EvidenceOrigin;
  readonly provider: string;
  readonly provider_account_id: string;
  readonly record_id: string;
  readonly email: string | null;
  readonly correlation_value: string | null;
  readonly created_at: string | null;
  readonly properties: Readonly<Record<string, string | null>>;
  readonly observed_at: string;
}

export interface EmailEventEvidence {
  readonly kind: 'email_event';
  readonly origin: EvidenceOrigin;
  readonly provider: string;
  readonly provider_account_id: string;
  readonly message_id: string;
  readonly recipient: string | null;
  /** Normalised provider semantics, not a marketing word. */
  readonly status: EmailStatus;
  readonly occurred_at: string;
  readonly observed_at: string;
}

/**
 * Deliberately ordered from weakest to strongest claim.
 * `accepted` means the sending service took the message. It is NOT inbox delivery.
 * `opened` is never treated as proof a person read anything.
 */
export const EMAIL_STATUS = [
  'queued',
  'accepted',
  'delivered',
  'deferred',
  'bounced',
  'complained',
  'failed',
  'opened',
  'clicked',
] as const;
export type EmailStatus = (typeof EMAIL_STATUS)[number];

/** Statuses that prove a receiving mail server took the message. */
export const DELIVERY_PROVING_STATUSES: ReadonlySet<EmailStatus> = new Set(['delivered']);

/** Statuses that definitively contradict successful delivery. */
export const DELIVERY_CONTRADICTING_STATUSES: ReadonlySet<EmailStatus> = new Set([
  'bounced',
  'failed',
  'complained',
]);

export type Evidence = CrmRecordEvidence | EmailEventEvidence;

/** What the evaluator is handed for one observation attempt. */
export interface EvidenceBundle {
  readonly crm: CrmRecordEvidence | null;
  /** Zero or more email events for the correlated message, newest last. */
  readonly email_events: readonly EmailEventEvidence[];
  /** Connector problems encountered while gathering, by source. */
  readonly gaps: readonly EvidenceGap[];
}

export interface EvidenceGap {
  readonly source: 'crm_record' | 'email_event';
  readonly code: string;
  readonly retryable: boolean;
  readonly detail: string;
}
