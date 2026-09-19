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
    event_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    workflow_id: z.string().min(1).max(64),
    /** ISO-8601 UTC. Bounded freshness is enforced by the handler, not here. */
    occurred_at: z.string().datetime({ offset: true }),
    /** The value we expect to find in the CRM correlation property. */
    correlation_id: z.string().min(1).max(128),
    expected: z
      .object({
        /** Recipient the acknowledgement email should have gone to. */
        email_recipient: z.string().email().max(254),
        /** Optional locators. Treated as hints to verify, never as truth. */
        crm_record_id: z.string().min(1).max(128).optional(),
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
