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

/**
 * Whether the call that produced this evidence actually left the process.
 *
 * ## Why this had to be added to a frozen contract
 *
 * `origin` records the *channel* an observation arrived through. It does not record
 * whether that channel was real. A connector stamps `provider_readback` whenever its HTTP
 * layer returns a normal 200 — and that HTTP layer takes an injectable `fetchImpl`, which
 * tests replace with a stub. The consequence, found by an independent review rather than
 * by anyone who wrote the code: **a test double and a genuine provider read-back produce
 * byte-identical evidence records.**
 *
 * That matters more here than it would almost anywhere else. The entire argument for a
 * VERIFIED result is that `provider_readback` and `provider_webhook` are independent of
 * `customer_claim` — we went and looked ourselves rather than believing the automation's
 * own report. If a fixture can wear the `provider_readback` label and nothing downstream
 * can tell, then that independence is an intention rather than a property, and the
 * strongest claim this product makes rests on something unverifiable.
 *
 * So provenance is recorded separately from channel, and the two answer different
 * questions: `origin` asks *how did this reach us*, `transport` asks *did it come from
 * outside this process*.
 *
 * ## The rule that makes it worth recording
 *
 * `live` may only be set by the code path that used the runtime's own `fetch`. It must
 * never be settable from test wiring, a fixture, a builder, or a default. Anything else —
 * an injected implementation, a replayed cassette, a synthetic demo record — is
 * `simulated`, including when the simulation is faithful. A field that a test can set to
 * `live` is worth less than no field at all, because it would launder exactly the doubt
 * it exists to record.
 *
 * `unknown` exists for evidence written before this field did. It is not a synonym for
 * `live`, and nothing may treat it as one.
 */
export type EvidenceTransport =
  /** The call left this process and reached the provider over the network. */
  | 'live'
  /** A stub, fixture, cassette or synthetic record. Faithful or not, it is not proof. */
  | 'simulated'
  /** Recorded before provenance was tracked. Never to be read as `live`. */
  | 'unknown';

export interface CrmRecordEvidence {
  readonly kind: 'crm_record';
  readonly origin: EvidenceOrigin;
  /**
   * Did the call that produced this leave the process? Optional for now so existing
   * records remain valid; absent is read as `unknown`, never as `live`.
   */
  readonly transport?: EvidenceTransport;
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
  /**
   * Did the call that produced this leave the process? Optional for now so existing
   * records remain valid; absent is read as `unknown`, never as `live`.
   */
  readonly transport?: EvidenceTransport;
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
