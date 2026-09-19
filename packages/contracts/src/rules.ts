/**
 * Frozen contract v1 — the typed rule language.
 *
 * Deliberately NOT a general expression language: no arbitrary JavaScript, no SQL,
 * no unbounded regular expressions and no customer-supplied network requests.
 * See plan §16.2.
 */
import { z } from 'zod';

/** Where an assertion looks for its evidence. */
export const EVIDENCE_SOURCE = ['crm_record', 'email_event'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCE)[number];

export const OPERATOR = [
  'exists',
  'equals',
  'not_equals',
  'normalised_email_equals',
  'occurred_within',
  'provider_status_in',
  'one_of',
] as const;
export type Operator = (typeof OPERATOR)[number];

/** Field paths a rule may address. An allowlist, not free-form traversal. */
export const CRM_FIELD = [
  'record.id',
  'record.email',
  'record.correlation_id',
  'record.created_at',
  'record.property',
] as const;

export const EMAIL_FIELD = [
  'message.id',
  'message.recipient',
  'message.status',
  'message.occurred_at',
] as const;

const fieldEnum = z.enum([...CRM_FIELD, ...EMAIL_FIELD] as [string, ...string[]]);

/** A single mandatory-or-optional check with one operator and one expected value. */
export const assertionSpecSchema = z
  .object({
    /** Stable within a workflow version; referenced by every assertion result. */
    rule_id: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
    source: z.enum(EVIDENCE_SOURCE),
    field: fieldEnum,
    /** Only meaningful when field === 'record.property'. The CRM property name. */
    property_name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/).optional(),
    operator: z.enum(OPERATOR),
    /** Expected literal. `occurred_within` uses seconds as a number. */
    expected: z.union([z.string().max(512), z.number().int(), z.array(z.string().max(128)).max(20)]),
    /** Optional checks are reported but never change the mandatory outcome. See plan §16.4. */
    mandatory: z.boolean().default(true),
    /** Human label shown beside the result. */
    label: z.string().min(1).max(160),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.field === 'record.property' && !spec.property_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'property_name is required when field is record.property',
        path: ['property_name'],
      });
    }
    if (spec.field !== 'record.property' && spec.property_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'property_name is only valid when field is record.property',
        path: ['property_name'],
      });
    }
    const crm = (CRM_FIELD as readonly string[]).includes(spec.field);
    if (crm && spec.source !== 'crm_record') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'field belongs to crm_record', path: ['field'] });
    }
    if (!crm && spec.source !== 'email_event') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'field belongs to email_event', path: ['field'] });
    }
    if (spec.operator === 'occurred_within' && typeof spec.expected !== 'number') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'occurred_within expects seconds as an integer', path: ['expected'] });
    }
    if ((spec.operator === 'provider_status_in' || spec.operator === 'one_of') && !Array.isArray(spec.expected)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'this operator expects an array of allowed values', path: ['expected'] });
    }
    if (spec.operator === 'exists' && spec.expected !== '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exists takes no expected value; use an empty string', path: ['expected'] });
    }
  });

export type AssertionSpec = z.infer<typeof assertionSpecSchema>;

/** Hard bounds from plan §22. Enforced at validation time, not merely documented. */
export const LIMITS = {
  MAX_ASSERTIONS_PER_WORKFLOW: 10,
  MAX_SOURCE_EVENT_BYTES: 32 * 1024,
  DEFAULT_DEADLINE_SECONDS: 600,
  MIN_DEADLINE_SECONDS: 60,
  MAX_DEADLINE_SECONDS: 3600,
  MAX_OBSERVATIONS_PER_RUN: 4,
  MAX_TRANSIENT_RETRIES_PER_OBSERVATION: 3,
  MAX_CONCURRENT_CONNECTOR_REQUESTS_PER_WORKSPACE: 2,
  MAX_CONCURRENT_CONNECTOR_REQUESTS_GLOBAL: 5,
  EVIDENCE_RETENTION_DAYS: 30,
  PLAN_RUNS_PER_PERIOD: 500,
  PLAN_PRICE_PENCE: 2900,
} as const;

export const workflowRulesSchema = z
  .object({
    schema_version: z.literal(1),
    deadline_seconds: z
      .number()
      .int()
      .min(LIMITS.MIN_DEADLINE_SECONDS)
      .max(LIMITS.MAX_DEADLINE_SECONDS)
      .default(LIMITS.DEFAULT_DEADLINE_SECONDS),
    coverage_mode: z.enum(['customer_triggered', 'independently_sourced']).default('customer_triggered'),
    /** CRM property that carries our correlation id on the customer's records. */
    crm_correlation_property: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/),
    assertions: z.array(assertionSpecSchema).min(1).max(LIMITS.MAX_ASSERTIONS_PER_WORKFLOW),
  })
  .strict()
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const a of rules.assertions) {
      if (seen.has(a.rule_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate rule_id: ${a.rule_id}`, path: ['assertions'] });
      }
      seen.add(a.rule_id);
    }
    if (!rules.assertions.some((a) => a.mandatory)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one assertion must be mandatory, otherwise VERIFIED would be meaningless',
        path: ['assertions'],
      });
    }
  });

export type WorkflowRules = z.infer<typeof workflowRulesSchema>;
