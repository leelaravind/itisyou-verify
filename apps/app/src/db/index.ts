/**
 * The data access layer. This directory is the only place raw SQL exists.
 *
 * Contract every repository in here keeps:
 *
 *  - Any function that touches a customer-scoped table takes `workspaceId` as an explicit
 *    first-class parameter and puts it in the `WHERE` clause. There is deliberately no
 *    "get by id" without a workspace.
 *  - A lookup that walks from parent to child (a run's assertions, a connection's
 *    credential) proves the child belongs to the parent *inside the same workspace*, with
 *    a join or a `WHERE EXISTS`, not with a second query.
 *  - Lists use explicit columns, a capped limit and an opaque cursor over
 *    `(created_at, id)`. No `SELECT *` on any list path.
 *  - Multi-statement writes go through `db.batch()`, which D1 documents as one
 *    transaction that rolls the whole sequence back if any statement fails.
 *  - Conditional writes report success through `meta.changes`, never through a re-read.
 *
 * The three cross-tenant functions are the scheduler's (`runs.listDue`, `runs.claimDue`,
 * `outbox.listDue`), the retention sweeps and the platform-owner views. Each is marked in
 * its own docblock and each returns `workspace_id` so the caller can scope what follows.
 */
export type { Db, DbResult, DbStatement, DbMeta } from './d1';
export { applied, changesAt, fromSqlBool, orNull, resultAt, toSqlBool } from './d1';

export {
  buildPage,
  clampLimit,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type Page,
  type PageCursor,
  type PageRequest,
} from './cursor';

export { users, workspaces, memberships } from './identity';
export type { UserRow, WorkspaceRow, WorkspaceStatus, MembershipRow } from './identity';

export { sessions, loginTokens } from './sessions';
export type { SessionRow, LoginTokenRow, LoginTokenPurpose } from './sessions';

export { connections, credentials, connectionScope, userScope } from './connections';
export type { ConnectionRow, CredentialEnvelopeRow, Provider } from './connections';

export { workflows, workflowVersions } from './workflows';
export type { WorkflowRow, WorkflowStatus, WorkflowVersionRow, CoverageMode } from './workflows';

export { sourceEvents } from './sourceEvents';
export type { SourceEventRow, SourceEventSource, AdmitParams, AdmitResult } from './sourceEvents';

export { runs, runAttempts, assertions, evidence } from './runs';
export type {
  RunRow,
  DueRun,
  RunAttemptRow,
  AssertionRow,
  AssertionInput,
  EvidenceRow,
  EvidenceInput,
} from './runs';

export { webhookReceipts, outbox } from './webhooks';
export type {
  WebhookReceiptRow,
  WebhookProcessingStatus,
  OutboxRow,
  DispatchState,
} from './webhooks';

export { entitlements } from './entitlements';
export type { EntitlementRow } from './entitlements';

export { budget } from './budget';
export type {
  BudgetAccountRow,
  BudgetEntryRow,
  BudgetEntryKind,
  BudgetMovement,
  BudgetOutcome,
  MovementParams as BudgetMovementParams,
} from './budget';

export { auditEvents, settings } from './audit';
export type { AuditEventRow, ActorKind, SettingRow } from './audit';

// ---------------------------------------------------------------------------
// Commerce, support and the three port implementations
// ---------------------------------------------------------------------------

export { billingCustomers, orders, subscriptions, refunds } from './commerce';
export type {
  BillingCustomerRow,
  OrderRow,
  SubscriptionRow,
  RefundRow,
  Environment,
  RefundState,
} from './commerce';

export {
  supportCases,
  notifications,
  retention,
  exportPages,
  EXPORT_PAGE_COLUMNS,
} from './supportData';
export type {
  SupportCaseRow,
  NotificationRow,
  RetentionTarget,
  ExportSection,
  ExpiredRowRef,
} from './supportData';

export { D1BillingDataPort, createBillingContactLookup } from './billingPort';
export { D1SupportDataPort, D1RateLimiter } from './supportPort';
export {
  D1CustomerDataPort,
  createCustomerDataPort,
  recordSupportCase,
  recordAnonymousSupportCase,
} from './customerPort';
export type { CustomerPortInput } from './customerPort';

export { D1OwnerDataPort, D1OwnerAuth, createOwnerDataPort, createOwnerAuth } from './ownerPort';
export type { OwnerPortInput } from './ownerPort';

export {
  D1ApprovalClaims,
  createApprovalClaims,
  createRefundApprovalConsumer,
} from './approvalClaims';
export {
  AUTOMATION_AUTH_SUBJECT,
  automationSeedExports,
  buildAutomationSeed,
  seedAutomationIdentity,
} from './automationSeed';
export type { AutomationSeed, AutomationSeedRequest } from './automationSeed';

export {
  D1ResendWebhookDataPort,
  assignWebhookPathId,
  createResendEndpointResolver,
  createResendWebhookData,
  newWebhookPathId,
} from './resendWebhookPort';

// The money path's two D1 ports. They arrived late because they were written in the test
// tree — SEC-201 forbids SQL outside this directory and their author did not own it — and
// until they moved here nothing in production implemented the port at all.
export { D1AllowanceRepair } from './allowanceRepair';
export { D1WorkflowSigningKeys, createWorkflowSigningKeyStore } from './workflowSigningKeys';
