/**
 * Frozen contract v1 — the signed source-event envelope customers send us.
 * See plan §16.1. A signing key proves who submitted the expectation, not that it is true.
 */
import { z } from 'zod';
import { LIMITS } from './rules.js';

export const sourceEventSchema = z
  .object({
    schema_version: z.literal(1),
    /** Customer-chosen, stable per business event. Duplicates return the existing run. */
    event_id: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    workflow_id: z.string().min(1).max(64),
    /** ISO-8601 UTC. Bounded freshness is enforced by the handler, not here. */
    occurred_at: z.string().datetime({ offset: true }),
    /** The value we expect to find in the CRM correlation property. */
    correlation_id: z.string().min(1).max(128),
    expected: z
      .object({
        /**
         * Recipient the acknowledgement email should have gone to.
         *
         * This is a thing we CHECK, not a thing we correlate on. Two enquiries from the
         * same customer share a recipient and are still two enquiries, so an address can
         * never establish which enquiry a delivery event belongs to. It is asserted after
         * binding, and the right message delivered to the wrong address is a contradiction
         * rather than a non-match.
         */
        email_recipient: z.string().email().max(254),
        crm_record_id: z.string().min(1).max(128).optional(),
        /**
         * The provider's own id for the acknowledgement message.
         *
         * Optional in the schema and **required in practice for an email verdict**: it is
         * the only thing that binds a delivery event to this enquiry. Omit it and no email
         * evidence will ever attach to this run, so its email assertions stay unknown and
         * the run ends UNVERIFIED. That is the correct answer rather than a bug -- we
         * genuinely cannot tell which enquiry an address received mail for -- but it is a
         * configuration decision with a visible consequence, so it is stated here.
         *
         * Send it back from whatever your automation got when it sent the message.
         */
        email_message_id: z.string().min(1).max(200).optional(),
        /** Expected values for `record.property` assertions, keyed by property name. */
        crm_properties: z.record(z.string().max(128), z.string().max(512)).optional(),
      })
      .strict(),
  })
  .strict();

export type SourceEvent = z.infer<typeof sourceEventSchema>;

export const MAX_SOURCE_EVENT_BYTES = LIMITS.MAX_SOURCE_EVENT_BYTES;

/** Maximum clock skew accepted on `occurred_at`, in seconds. */
export const EVENT_FRESHNESS_WINDOW_SECONDS = 15 * 60;

/** Replay window for HMAC request signatures on POST /api/v1/events. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const eventAcceptedSchema = z
  .object({
    run_id: z.string(),
    status: z.enum(['PENDING', 'VERIFIED', 'FAILED', 'UNVERIFIED']),
    duplicate: z.boolean(),
    deadline_at: z.string(),
  })
  .strict();

export type EventAccepted = z.infer<typeof eventAcceptedSchema>;
