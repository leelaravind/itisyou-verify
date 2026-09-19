/**
 * `OwnerDataPort` — exactly the reads and writes the owner screens need.
 *
 * Same contract A05 uses for the customer pages, for the same reason: the pages are written
 * against an interface, ship today on an in-memory implementation, and do not change when
 * the real repositories are wired behind them.
 *
 * Properties this shape enforces rather than documents:
 *
 *   - **Nothing consequential happens without a decision object.** Every mutating method
 *     takes an `ActionContext` carrying the principal and the instant, so an implementation
 *     cannot act without knowing who asked. It cannot be forgotten, because it cannot be
 *     omitted.
 *   - **Every write returns a typed result.** A form re-renders with the reason; it never
 *     gets a 500 for a business rule, and it never gets an `ok` it did not earn.
 *   - **Unknown is a value.** A number that has not been measured is `null` and the page
 *     renders "unknown". There is no field on which zero stands in for ignorance.
 *   - **No stored secret is ever in a return type.** Where a connection needs a label, the
 *     field is named `maskHint` and its docblock says the mask is produced at render time
 *     from a fresh read, never stored and never round-tripped.
 */
import type {
  CampaignState,
  ConnectionStatus,
  JobState,
  RunStatus,
  SubscriptionStatus,
} from '@verify/contracts';
import type { OwnerCapability, OwnerPrincipal } from './access.js';
import type { Controls } from './controls.js';
import type { FinanceInputs } from './finance.js';
import type { OwnerApproval } from './approvals.js';
import type { QualityRun } from './quality.js';
import type { CleanupInventory, CleanupReport } from './cleanup.js';
import type { AssistantStatus, RunnerStatus, RunnerJobView } from './runner.js';
import type { NotificationHealth } from './notifications.js';

/* ------------------------------------------------------------------ write results */

export interface OwnerWriteResult {
  readonly ok: boolean;
  /** Keyed by form field, so a message renders beside its own input. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** Form-level message. Present on failure; may also carry a confirmation on success. */
  readonly message: string | null;
  /** Where to send the browser on success, for POST-redirect-GET. */
  readonly redirectTo: string | null;
  /**
   * What is stopping this action, when something is — a missing runner, an unpaired device,
   * an unconfigured provider. Rendered as a dependency, not as an error.
   */
  readonly dependency: string | null;
}

export function writeOk(redirectTo: string, message: string | null = null): OwnerWriteResult {
  return { ok: true, fieldErrors: {}, message, redirectTo, dependency: null };
}

export function writeFailed(
  message: string,
  fieldErrors: Readonly<Record<string, string>> = {},
): OwnerWriteResult {
  return { ok: false, fieldErrors, message, redirectTo: null, dependency: null };
}

export function writeBlocked(dependency: string, message: string | null = null): OwnerWriteResult {
  return { ok: false, fieldErrors: {}, message, redirectTo: null, dependency };
}

/** Who is acting, and when. Required on every mutation. */
export interface ActionContext {
  readonly principal: OwnerPrincipal;
  readonly capability: OwnerCapability;
  readonly now: Date;
  readonly requestId: string;
}

/* ----------------------------------------------------------------------- overview */

export interface ServiceHealthView {
  readonly component: string;
  /** `ok`, `degraded`, `down`, or `unknown` — never an optimistic default. */
  readonly state: 'ok' | 'degraded' | 'down' | 'unknown';
  readonly detail: string;
  readonly observedAt: string | null;
}

/**
 * The launch funnel, as four separate numbers that are never added together.
 *
 * The founder was explicit about this and the interface enforces it rather than relying on
 * whoever writes the next page: **a visit is not interest, and interest is not a customer.**
 * A single "launch" figure would let the largest and least meaningful of the four stand in
 * for the business, which is exactly the flattering mistake this product exists to refuse.
 *
 * Every one of them is `number | null`, and `null` renders as "unknown" — never as zero.
 */
export interface LaunchMetric {
  readonly value: number | null;
  readonly observedAt: string | null;
}

export interface LaunchMetrics {
  /** Everyone who arrived, excluding our own traffic and suspected bots. */
  readonly totalVisits: LaunchMetric;
  /** Of those, the ones carrying a campaign attribution. A subset, not a separate total. */
  readonly adAttributedVisits: LaunchMetric;
  /** People who created a workspace and connected something. Interest, not revenue. */
  readonly qualifiedSignups: LaunchMetric;
  /** People who are actually paying. The only one of the four that is income. */
  readonly payingCustomers: LaunchMetric;
}

export interface OverviewView {
  readonly finance: FinanceInputs;
  readonly health: readonly ServiceHealthView[];
  /** Paying, active workspaces. Null when the figure has not been computed. */
  readonly customersActive: number | null;
  readonly customersTotal: number | null;
  /** The four launch numbers, kept apart on purpose. See {@link LaunchMetrics}. */
  readonly launch: LaunchMetrics;
  readonly pendingApprovals: number;
  readonly openSupportCases: number | null;
  readonly runsLast24h: number | null;
  /** When the whole screen was assembled. Always shown. */
  readonly assembledAt: string;
}

/* ------------------------------------------------------------ customers and orders */

export interface CustomerRow {
  readonly workspaceId: string;
  readonly name: string;
  /** Masked at the call site. This field never carries a full address. */
  readonly contactMask: string;
  readonly eligible: boolean;
  readonly ineligibleReason: string | null;
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly connectionsReady: number;
  readonly connectionsTotal: number;
  readonly runsThisPeriod: number | null;
  readonly createdAt: string;
  readonly isSynthetic: boolean;
}

export interface OrderRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
}

export interface ExceptionRow {
  readonly id: string;
  readonly kind: 'payment_failed' | 'refund_pending' | 'connection_broken' | 'allowance_exhausted' | 'support_escalated';
  readonly workspaceId: string | null;
  readonly summary: string;
  readonly raisedAt: string;
  /** What the owner can do. Null where there is genuinely nothing useful to offer. */
  readonly suggestedAction: string | null;
}

export interface RefundRequestInput {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly policyRule: string;
  readonly reason: string;
  /** The approval that authorises this exact refund. */
  readonly approvalId: string;
}

/* ------------------------------------------------------------------- verification */

export interface ComponentEvidenceView {
  readonly component: string;
  readonly provider: string;
  readonly origin: string;
  readonly observedAt: string | null;
  readonly contentDigest: string;
  /** Already redacted by A02 before storage. Rendered through the escaping template. */
  readonly redactedSummary: string;
}

export interface OwnerRunView {
  readonly runId: string;
  readonly workspaceId: string;
  readonly workflowName: string;
  readonly status: RunStatus;
  /** From `@verify/domain`'s `explainRunStatus`. Never a raw reason code. */
  readonly statusSentence: string;
  readonly rulesRef: string;
  readonly rulesSchemaVersion: number;
  readonly occurredAt: string;
  readonly deadlineAt: string;
  readonly decidedAt: string | null;
  readonly evidence: readonly ComponentEvidenceView[];
  /** One explained line per assertion. Reason codes are explained, never printed. */
  readonly assertions: readonly {
    readonly ruleId: string;
    readonly headline: string;
    readonly sentence: string;
    readonly nextStep: string | null;
    readonly detail: string | null;
  }[];
  /** Provider outages that overlapped this run. Empty when none did. */
  readonly outages: readonly { readonly provider: string; readonly from: string; readonly to: string | null; readonly detail: string }[];
  readonly retryAvailable: boolean;
  readonly retryBlockedReason: string | null;
}

/* -------------------------------------------------------------------- connections */

export interface OwnerConnectionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly status: ConnectionStatus;
  readonly lastCheckAt: string | null;
  readonly lastErrorCode: string | null;
  /**
   * A mask **generated at render time** from a fresh read of the account identifier —
   * never a mask of stored ciphertext, and never anything derived from the secret itself.
   * Null when there is nothing connected to describe.
   */
  readonly maskHint: string | null;
  readonly scopes: readonly string[];
  readonly rotationDueAt: string | null;
}

/* --------------------------------------------------------------------------- ads */

export interface CampaignView {
  readonly id: string;
  readonly provider: string;
  readonly externalId: string | null;
  readonly state: CampaignState;
  readonly headline: string;
  readonly destinationUrl: string;
  readonly audienceSummary: string;
  readonly budgetMinor: number;
  readonly currency: string;
  readonly approvalId: string | null;
  readonly approvedPayloadHash: string | null;
  /** Null means unknown, not zero. */
  readonly spendMinor: number | null;
  readonly visits: number | null;
  readonly signups: number | null;
  readonly lastSyncAt: string | null;
  readonly lastSyncError: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

/* ------------------------------------------------------------------- operations */

export interface DeploymentView {
  readonly id: string;
  readonly environment: string;
  readonly commitSha: string | null;
  readonly deployedAt: string;
  readonly deployedBy: string;
  readonly result: 'succeeded' | 'failed' | 'rolled_back';
}

export interface AlertView {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly summary: string;
  readonly raisedAt: string;
  readonly acknowledgedAt: string | null;
}

export interface OperationsView {
  readonly health: readonly ServiceHealthView[];
  readonly deployments: readonly DeploymentView[];
  readonly alerts: readonly AlertView[];
  readonly runner: RunnerStatus;
  readonly maintenanceJobs: readonly RunnerJobView[];
  readonly assistant: AssistantStatus;
  /** Messages that claimed a row and never reported an outcome. The owner is the retry. */
  readonly notifications: NotificationHealth;
}

/* ----------------------------------------------------------------------- audit */

export interface AuditRow {
  readonly id: string;
  readonly actor: string;
  readonly actorKind: string;
  readonly action: string;
  readonly target: string | null;
  readonly occurredAt: string;
  /** Already redacted at the call site that wrote it. Rendered as text. */
  readonly redactedMetadata: string | null;
}

/* ------------------------------------------------------------------- the port */

export interface OwnerDataPort {
  /** True when this is the in-memory implementation. Pages render a visible banner. */
  readonly synthetic: boolean;

  /* identity */
  principal(): Promise<OwnerPrincipal>;

  /* overview */
  overview(now: Date): Promise<OverviewView>;

  /* customers and orders */
  customers(): Promise<readonly CustomerRow[]>;
  orders(workspaceId: string | null): Promise<readonly OrderRow[]>;
  exceptions(): Promise<readonly ExceptionRow[]>;
  cancelSubscription(ctx: ActionContext, workspaceId: string): Promise<OwnerWriteResult>;
  rejectBeforeCheckout(ctx: ActionContext, orderId: string, reason: string): Promise<OwnerWriteResult>;
  issueRefund(ctx: ActionContext, input: RefundRequestInput): Promise<OwnerWriteResult>;

  /* verification */
  recentRuns(limit: number): Promise<readonly OwnerRunView[]>;
  run(runId: string): Promise<OwnerRunView | null>;
  retryRun(ctx: ActionContext, runId: string): Promise<OwnerWriteResult>;

  /* connections */
  connections(): Promise<readonly OwnerConnectionView[]>;
  rotateConnection(ctx: ActionContext, connectionId: string): Promise<OwnerWriteResult>;
  revokeConnection(ctx: ActionContext, connectionId: string): Promise<OwnerWriteResult>;

  /* ads */
  campaigns(): Promise<readonly CampaignView[]>;
  campaign(campaignId: string): Promise<CampaignView | null>;
  activateCampaign(ctx: ActionContext, campaignId: string, approvalId: string): Promise<OwnerWriteResult>;
  pauseCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult>;
  resumeCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult>;

  /* operations */
  operations(now: Date): Promise<OperationsView>;
  acknowledgeAlert(ctx: ActionContext, alertId: string): Promise<OwnerWriteResult>;
  /**
   * Queue a typed maintenance job. `kind` is one of A08's closed vocabulary and never a
   * command — the runner maps a kind to a compiled-in recipe, and nothing in this call
   * becomes part of a shell string.
   */
  enqueueMaintenance(ctx: ActionContext, kind: string): Promise<OwnerWriteResult>;

  /* controls */
  controls(): Promise<Controls>;
  setControl(ctx: ActionContext, key: string, paused: boolean, note: string | null): Promise<OwnerWriteResult>;

  /* approvals */
  approvals(): Promise<readonly OwnerApproval[]>;
  approval(approvalId: string): Promise<OwnerApproval | null>;
  grantApproval(
    ctx: ActionContext,
    input: { readonly actionType: string; readonly payloadJson: string; readonly maximumAmountMinor: number | null; readonly summary: string },
  ): Promise<OwnerWriteResult>;
  revokeApproval(ctx: ActionContext, approvalId: string): Promise<OwnerWriteResult>;

  /* settings */
  readSettings(): Promise<OwnerSettingsView>;
  writeSetting(ctx: ActionContext, key: string, valueJson: string): Promise<OwnerWriteResult>;

  /* quality */
  qualityRuns(limit: number): Promise<readonly QualityRun[]>;
  dispatchQuality(ctx: ActionContext, suiteId: string): Promise<OwnerWriteResult & { readonly runState: JobState | null }>;

  /* cleanup */
  cleanupPreview(ctx: ActionContext, categories: readonly string[]): Promise<
    { readonly ok: true; readonly inventory: CleanupInventory } | { readonly ok: false; readonly detail: string }
  >;
  cleanupExecute(
    ctx: ActionContext,
    input: { readonly inventoryHash: string; readonly quarantine: boolean },
  ): Promise<{ readonly ok: true; readonly report: CleanupReport } | { readonly ok: false; readonly detail: string }>;
  lastCleanupReport(): Promise<CleanupReport | null>;

  /* audit */
  auditTrail(limit: number): Promise<readonly AuditRow[]>;
}

export interface OwnerSettingsView {
  readonly businessJson: string;
  readonly pricingJson: string;
  readonly notificationsJson: string;
  readonly retentionJson: string;
  readonly budgetLimitsJson: string;
  readonly accessModeJson: string;
}
