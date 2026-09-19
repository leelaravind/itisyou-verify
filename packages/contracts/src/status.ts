/**
 * Frozen contract v1 — status vocabularies.
 * Changing any literal here is a breaking contract change and requires a version bump.
 */

/** Aggregate outcome of a verification run. See plan §3 and §16.4. */
export const RUN_STATUS = ['PENDING', 'VERIFIED', 'FAILED', 'UNVERIFIED'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/** Outcome of a single assertion inside a run. */
export const ASSERTION_STATUS = ['PENDING', 'SUPPORTED', 'CONTRADICTED', 'UNKNOWN'] as const;
export type AssertionStatus = (typeof ASSERTION_STATUS)[number];

/** Connector lifecycle. See plan §17.4. */
export const CONNECTION_STATUS = [
  'not_connected',
  'authorising',
  'testing',
  'ready',
  'degraded',
  'expired',
  'revoked',
  'unsupported',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUS)[number];

/** Order lifecycle, distinct from subscription lifecycle. See plan §21. */
export const ORDER_STATUS = [
  'draft',
  'compatible',
  'rejected',
  'checkout_created',
  'payment_pending',
  'active',
  'expired',
  'failed',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

/** Provider subscription state mirrored from Stripe, never written by the browser. */
export const SUBSCRIPTION_STATUS = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

/** Campaign lifecycle. API acceptance is NOT delivery. See plan §25.3. */
export const CAMPAIGN_STATE = [
  'draft',
  'awaiting_owner',
  'ready_to_submit',
  'submitted',
  'in_review',
  'rejected',
  'scheduled',
  'active',
  'paused',
  'pause_pending',
  'ended',
  'unknown',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATE)[number];

/** Quality-centre job execution states. See plan §38.4. */
export const JOB_STATE = [
  'queued',
  'awaiting_runner',
  'running',
  'passed',
  'failed',
  'cancelled',
  'timed_out',
  'infrastructure_error',
] as const;
export type JobState = (typeof JOB_STATE)[number];

/** Whether a workflow can detect a run that never started. See plan §13.3. */
export const COVERAGE_MODE = ['customer_triggered', 'independently_sourced'] as const;
export type CoverageMode = (typeof COVERAGE_MODE)[number];

/** Roles. A platform owner is never created by public signup. See plan §20. */
export const ROLE = ['platform_owner', 'workspace_admin', 'workspace_viewer'] as const;
export type Role = (typeof ROLE)[number];

/** Assistant modes. Default is `off`; core service never depends on a model. See plan §23. */
export const ASSISTANT_MODE = ['off', 'openrouter_free', 'paid_api'] as const;
export type AssistantMode = (typeof ASSISTANT_MODE)[number];

/** Owner-visible access mode for the admin entry point. See plan §38.3. */
export const ACCESS_MODE = ['PUBLIC_LOGIN', 'RESTRICTED_ENTRY'] as const;
export type AccessMode = (typeof ACCESS_MODE)[number];
