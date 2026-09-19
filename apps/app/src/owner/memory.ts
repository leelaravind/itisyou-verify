/**
 * An in-memory `OwnerDataPort`.
 *
 * It exists so the owner screens render, the forms post, and the tests run before A02's
 * repositories are wired to this interface. Every page that uses it shows a visible
 * synthetic banner, because placeholder figures that look like real ones are the single
 * most dangerous thing an operations dashboard can do.
 *
 * Two behaviours here are not placeholders and must survive the swap to real data:
 *
 *  1. **Every mutation re-checks the capability.** The router already authorised the
 *     request; this checks again, from the principal on the `ActionContext`, and refuses if
 *     the principal does not hold it. A single missing guard in a route is then not enough
 *     to move money — and the four automation denials hold even if the route forgets.
 *  2. **Nothing reports a success it did not perform.** Where the action needs a dependency
 *     this deployment does not have — an ad platform, a paired runner, a payment provider —
 *     the result is `dependency`, not `ok`.
 */
import { explainAssertion, explainRunStatus } from '@verify/domain';
import type { AssertionResult } from '@verify/domain';
import type { JobState } from '@verify/contracts';
import { capabilitiesFor, type OwnerPrincipal } from './access.js';
import {
  approvalStanding,
  grantOwnerApproval,
  type OwnerApproval,
  type OwnerApprovalPayload,
} from './approvals.js';
import {
  applyControlChange,
  defaultControls,
  isControlKey,
  type ControlKey,
  type Controls,
} from './controls.js';
import {
  executeCleanup,
  previewCleanup,
  type CleanupInventory,
  type CleanupReport,
  type InventoryItem,
  OWNERSHIP_TAG,
} from './cleanup.js';
import { dispatchQualityRun, type ExecutorAvailability, type QualityRun } from './quality.js';
import { AssistantOff, OfflineRunner, type AssistantStatusPort, type MaintenanceRunnerPort } from './runner.js';
import {
  DEFAULT_ACCESS_MODE,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_BUSINESS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_PRICING,
  DEFAULT_RETENTION,
  SETTINGS_KEY,
} from './settings.js';
import {
  writeBlocked,
  writeFailed,
  writeOk,
  type ActionContext,
  type AlertView,
  type AuditRow,
  type CampaignView,
  type CustomerRow,
  type DeploymentView,
  type ExceptionRow,
  type OperationsView,
  type OrderRow,
  type OverviewView,
  type OwnerConnectionView,
  type OwnerDataPort,
  type OwnerRunView,
  type OwnerSettingsView,
  type OwnerWriteResult,
  type RefundRequestInput,
  type ServiceHealthView,
} from './port.js';

/** A synthetic owner principal with recent strong auth. Only ever used by this module. */
export function syntheticOwnerPrincipal(now: Date = new Date()): OwnerPrincipal {
  return {
    kind: 'owner',
    userId: 'usr_synthetic_owner',
    email: 'owner@example.invalid',
    isPlatformOwner: true,
    isAutomation: false,
    mfaVerifiedAt: new Date(now.getTime() - 60_000).toISOString(),
    sessionCreatedAt: new Date(now.getTime() - 600_000).toISOString(),
    sessionExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    csrfToken: 'synthetic-csrf-token-for-rendering-only',
  };
}

/** A scoped automation identity: short-lived, and holding three read-ish capabilities. */
export function syntheticAutomationPrincipal(now: Date = new Date()): OwnerPrincipal {
  return {
    kind: 'automation',
    userId: 'usr_synthetic_automation',
    email: 'automation@example.invalid',
    isPlatformOwner: false,
    isAutomation: true,
    mfaVerifiedAt: now.toISOString(),
    sessionCreatedAt: now.toISOString(),
    sessionExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    csrfToken: 'synthetic-automation-csrf-token',
  };
}

const AD_PLATFORM_DEPENDENCY =
  'No advertising account is connected to this deployment, so nothing can be submitted, activated or paused on a platform. ' +
  'The approval is still recorded and the campaign stays where it is.';

const PAYMENTS_DEPENDENCY =
  'Payments are not configured on this deployment, so no refund can actually be sent. The request and the approval are recorded.';

export interface MemoryOwnerPortOptions {
  readonly principal?: OwnerPrincipal;
  readonly now?: () => Date;
  readonly runner?: MaintenanceRunnerPort;
  readonly assistant?: AssistantStatusPort;
  readonly executor?: ExecutorAvailability;
  /** Extra inventory items the cleanup preview should find, on top of the built-in ones. */
  readonly extraCleanupItems?: readonly InventoryItem[];
}

export class MemoryOwnerDataPort implements OwnerDataPort {
  readonly synthetic = true;

  readonly #principal: OwnerPrincipal;
  readonly #now: () => Date;
  readonly #runner: MaintenanceRunnerPort;
  readonly #assistant: AssistantStatusPort;
  readonly #executor: ExecutorAvailability;

  #controls: Controls = defaultControls();
  #approvals: OwnerApproval[] = [];
  #qualityRuns: QualityRun[] = [];
  #cleanupReport: CleanupReport | null = null;
  #lastInventory: CleanupInventory | null = null;
  #audit: AuditRow[] = [];
  #alerts: AlertView[];
  #campaigns: CampaignView[];
  #settings: Record<string, string>;
  #idCounter = 0;
  /** Resources the synthetic cleanup scan will find. Mutated by a successful run. */
  #cleanupResources: InventoryItem[];

  constructor(options: MemoryOwnerPortOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#principal = options.principal ?? syntheticOwnerPrincipal(this.#now());
    this.#runner = options.runner ?? new OfflineRunner();
    this.#assistant = options.assistant ?? new AssistantOff();
    this.#executor = options.executor ?? {
      executor: 'local_runner',
      available: false,
      reason:
        'No test executor is paired with this deployment. A Cloudflare Worker cannot run a test suite itself, so the job waits for a runner.',
    };
    this.#alerts = [
      {
        id: 'alr_1',
        severity: 'warning',
        summary: 'HubSpot read latency above 2 seconds for 11 minutes',
        raisedAt: new Date(this.#now().getTime() - 40 * 60_000).toISOString(),
        acknowledgedAt: null,
      },
    ];
    this.#campaigns = [
      {
        id: 'cmp_first_test',
        provider: 'reddit',
        externalId: null,
        state: 'awaiting_owner',
        headline: 'Did your automation finish the job?',
        destinationUrl: 'https://verify.itisyou.app/?utm_source=reddit&utm_medium=cpc&utm_campaign=first_test',
        audienceSummary: 'People who build and maintain automations, GB, English',
        budgetMinor: 1500,
        currency: 'GBP',
        approvalId: null,
        approvedPayloadHash: null,
        spendMinor: null,
        visits: null,
        signups: null,
        lastSyncAt: null,
        lastSyncError: null,
        startsAt: null,
        endsAt: null,
      },
    ];
    this.#settings = {
      [SETTINGS_KEY.business]: JSON.stringify(DEFAULT_BUSINESS),
      [SETTINGS_KEY.pricing]: JSON.stringify(DEFAULT_PRICING),
      [SETTINGS_KEY.notifications]: JSON.stringify(DEFAULT_NOTIFICATIONS),
      [SETTINGS_KEY.retention]: JSON.stringify(DEFAULT_RETENTION),
      [SETTINGS_KEY.budgetLimits]: JSON.stringify(DEFAULT_BUDGET_LIMITS),
      [SETTINGS_KEY.accessMode]: JSON.stringify(DEFAULT_ACCESS_MODE),
    };
    this.#cleanupResources = [
      ...SYNTHETIC_CLEANUP_ITEMS,
      ...(options.extraCleanupItems ?? []),
    ];
  }

  #id(prefix: string): string {
    this.#idCounter += 1;
    return `${prefix}_mem${String(this.#idCounter).padStart(4, '0')}`;
  }

  /**
   * Defence in depth. The router authorised this already; if it did not, nothing here
   * happens. Returns null when the principal genuinely holds the capability.
   */
  #denied(ctx: ActionContext): OwnerWriteResult | null {
    if (capabilitiesFor(ctx.principal).has(ctx.capability)) return null;
    return writeFailed(
      `This identity cannot ${ctx.capability}. Nothing was changed.`,
    );
  }

  #record(ctx: ActionContext, action: string, target: string | null, metadata: Record<string, unknown>): void {
    this.#audit.unshift({
      id: this.#id('aud'),
      actor: ctx.principal.userId ?? 'unknown',
      actorKind: ctx.principal.isAutomation ? 'automation' : 'user',
      action,
      target,
      occurredAt: ctx.now.toISOString(),
      // Already an allowlisted, value-free object at every call site in this file.
      redactedMetadata: JSON.stringify(metadata),
    });
  }

  async principal(): Promise<OwnerPrincipal> {
    return this.#principal;
  }

  /* --------------------------------------------------------------- overview */

  async overview(now: Date): Promise<OverviewView> {
    return {
      finance: {
        currency: 'GBP',
        cashRevenueMinor: 0,
        refundsMinor: 0,
        // Not yet measured on this deployment. Unknown, not zero.
        variableCostsMinor: null,
        outstandingCommitmentsMinor: 0,
        startupCashRemainingMinor: 10_000,
        lastRefreshAt: new Date(now.getTime() - 15 * 60_000).toISOString(),
        estimatedFields: ['variable_costs', 'startup_cash'],
      },
      health: this.#health(now),
      customersActive: 0,
      customersTotal: 0,
      launchVisits: null,
      launchVisitsObservedAt: null,
      pendingApprovals: this.#approvals.filter((a) => approvalStanding(a, now) === 'usable').length,
      openSupportCases: 0,
      runsLast24h: 0,
      assembledAt: now.toISOString(),
    };
  }

  #health(now: Date): readonly ServiceHealthView[] {
    const observedAt = now.toISOString();
    return [
      { component: 'Web', state: 'ok', detail: 'Serving requests.', observedAt },
      { component: 'Database', state: 'ok', detail: 'Reachable.', observedAt },
      {
        component: 'Scheduler',
        state: 'unknown',
        detail: 'No scheduler tick has been observed by this panel yet.',
        observedAt: null,
      },
      {
        component: 'Payments',
        state: 'unknown',
        detail: 'Not configured on this deployment.',
        observedAt: null,
      },
      {
        component: 'Email',
        state: 'unknown',
        detail: 'Not configured on this deployment.',
        observedAt: null,
      },
    ];
  }

  /* ------------------------------------------------------ customers and orders */

  async customers(): Promise<readonly CustomerRow[]> {
    return [
      {
        workspaceId: 'ws_synthetic_demo',
        name: 'Worked example (synthetic)',
        contactMask: 'd**@example.invalid',
        eligible: true,
        ineligibleReason: null,
        subscriptionStatus: null,
        connectionsReady: 2,
        connectionsTotal: 2,
        runsThisPeriod: 4,
        createdAt: new Date(this.#now().getTime() - 3 * 86_400_000).toISOString(),
        isSynthetic: true,
      },
    ];
  }

  async orders(): Promise<readonly OrderRow[]> {
    return [];
  }

  async exceptions(): Promise<readonly ExceptionRow[]> {
    return [];
  }

  async cancelSubscription(ctx: ActionContext, workspaceId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    this.#record(ctx, 'owner.subscription.cancel', workspaceId, { workspace_id: workspaceId });
    return writeBlocked(
      PAYMENTS_DEPENDENCY,
      'The cancellation is recorded here but the payment provider is not connected, so nothing has been cancelled with them yet.',
    );
  }

  async rejectBeforeCheckout(ctx: ActionContext, orderId: string, reason: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      return writeFailed('Say why, in a sentence the customer can act on.', {
        reason: 'Give a reason of at least ten characters. "No" is not a reason a customer can do anything with.',
      });
    }
    this.#record(ctx, 'owner.order.reject', orderId, { order_id: orderId });
    return writeOk('/owner/customers', 'Recorded. The order is rejected and the reason is on the record.');
  }

  async issueRefund(ctx: ActionContext, input: RefundRequestInput): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const approval = this.#approvals.find((a) => a.id === input.approvalId) ?? null;
    if (approval === null) {
      return writeFailed('That approval does not exist, so there is nothing authorising this refund.');
    }
    if (approvalStanding(approval, ctx.now) !== 'usable') {
      return writeFailed(
        `That approval is ${approvalStanding(approval, ctx.now)}. Approve the refund again if you still want it to happen.`,
      );
    }
    this.#record(ctx, 'owner.refund.issue', input.orderId, {
      order_id: input.orderId,
      amount_minor: input.amountMinor,
      approval_id: input.approvalId,
    });
    return writeBlocked(PAYMENTS_DEPENDENCY);
  }

  /* ------------------------------------------------------------ verification */

  async recentRuns(limit: number): Promise<readonly OwnerRunView[]> {
    return SYNTHETIC_RUNS.slice(0, Math.max(0, limit));
  }

  async run(runId: string): Promise<OwnerRunView | null> {
    return SYNTHETIC_RUNS.find((r) => r.runId === runId) ?? null;
  }

  async retryRun(ctx: ActionContext, runId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    if (this.#controls.expensive_verification.paused) {
      return writeBlocked(
        'Expensive verification is paused, so a retry would not reach the provider. Unpause it first if you want this run looked at again.',
      );
    }
    this.#record(ctx, 'owner.run.retry', runId, { run_id: runId });
    return writeOk(`/owner/verification/${runId}`, 'Queued for another look on the next scheduler tick.');
  }

  /* ------------------------------------------------------------- connections */

  async connections(): Promise<readonly OwnerConnectionView[]> {
    const now = this.#now().toISOString();
    return [
      {
        id: 'conn_hubspot_demo',
        workspaceId: 'ws_synthetic_demo',
        provider: 'hubspot',
        status: 'ready',
        lastCheckAt: now,
        lastErrorCode: null,
        // Generated here, at render time, from the account identifier — never from stored
        // ciphertext and never from the secret.
        maskHint: 'account ••••4821',
        scopes: ['crm.objects.contacts.read'],
        rotationDueAt: null,
      },
      {
        id: 'conn_resend_demo',
        workspaceId: 'ws_synthetic_demo',
        provider: 'resend',
        status: 'degraded',
        lastCheckAt: now,
        lastErrorCode: 'RATE_LIMITED',
        maskHint: 'domain ••••.invalid',
        scopes: ['emails.read'],
        rotationDueAt: null,
      },
    ];
  }

  async rotateConnection(ctx: ActionContext, connectionId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    this.#record(ctx, 'owner.connection.rotate', connectionId, { connection_id: connectionId });
    return writeBlocked(
      'Rotation needs the provider to issue a new credential, and no provider is connected to this deployment. Nothing was changed.',
    );
  }

  async revokeConnection(ctx: ActionContext, connectionId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    this.#record(ctx, 'owner.connection.revoke', connectionId, { connection_id: connectionId });
    return writeOk(
      '/owner/connections',
      'Marked revoked here. Runs that needed it will report unverified rather than failed, because we can no longer look.',
    );
  }

  /* ---------------------------------------------------------------------- ads */

  async campaigns(): Promise<readonly CampaignView[]> {
    return this.#campaigns;
  }

  async campaign(campaignId: string): Promise<CampaignView | null> {
    return this.#campaigns.find((c) => c.id === campaignId) ?? null;
  }

  async activateCampaign(ctx: ActionContext, campaignId: string, approvalId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const approval = this.#approvals.find((a) => a.id === approvalId) ?? null;
    if (approval === null || approvalStanding(approval, ctx.now) !== 'usable') {
      return writeFailed('There is no usable approval for this campaign, so it cannot be activated.');
    }
    this.#record(ctx, 'owner.campaign.activate', campaignId, { campaign_id: campaignId, approval_id: approvalId });
    return writeBlocked(AD_PLATFORM_DEPENDENCY);
  }

  async pauseCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const index = this.#campaigns.findIndex((c) => c.id === campaignId);
    if (index === -1) return writeFailed('There is no campaign with that id.');
    const existing = this.#campaigns[index];
    if (existing === undefined) return writeFailed('There is no campaign with that id.');
    // A pause we asked for is `pause_pending` until the platform confirms it. Never `paused`.
    this.#campaigns[index] = { ...existing, state: 'pause_pending' };
    this.#record(ctx, 'owner.campaign.pause', campaignId, { campaign_id: campaignId });
    return writeOk(
      '/owner/ads',
      'Pause requested. This shows as "pause requested" until the ad platform confirms it — assume it may still be spending until then.',
    );
  }

  async resumeCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    this.#record(ctx, 'owner.campaign.resume', campaignId, { campaign_id: campaignId });
    return writeBlocked(AD_PLATFORM_DEPENDENCY);
  }

  /* --------------------------------------------------------------- operations */

  async operations(now: Date): Promise<OperationsView> {
    return {
      health: this.#health(now),
      deployments: SYNTHETIC_DEPLOYMENTS,
      alerts: this.#alerts,
      runner: await this.#runner.status(),
      maintenanceJobs: await this.#runner.listJobs(10),
      assistant: await this.#assistant.status(),
    };
  }

  async acknowledgeAlert(ctx: ActionContext, alertId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const index = this.#alerts.findIndex((a) => a.id === alertId);
    if (index === -1) return writeFailed('There is no alert with that id.');
    const existing = this.#alerts[index];
    if (existing === undefined) return writeFailed('There is no alert with that id.');
    this.#alerts[index] = { ...existing, acknowledgedAt: ctx.now.toISOString() };
    this.#record(ctx, 'owner.alert.acknowledge', alertId, { alert_id: alertId });
    return writeOk('/owner/operations', 'Acknowledged. It stays on the list until it stops happening.');
  }

  /* ----------------------------------------------------------------- controls */

  async controls(): Promise<Controls> {
    return this.#controls;
  }

  async setControl(
    ctx: ActionContext,
    key: string,
    paused: boolean,
    note: string | null,
  ): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    if (!isControlKey(key)) return writeFailed('That is not one of the controls on this page.');
    const result = applyControlChange(this.#controls, {
      key: key as ControlKey,
      paused,
      by: ctx.principal.userId ?? 'unknown',
      at: ctx.now.toISOString(),
      note,
    });
    if (!result.ok) return writeFailed(result.detail);
    this.#controls = { ...this.#controls, [key]: result.state };
    this.#record(ctx, paused ? 'owner.control.pause' : 'owner.control.resume', key, { control: key });
    return writeOk(
      '/owner/controls',
      paused
        ? 'Paused. Cancelling and getting help keep working — they always do, whatever is paused.'
        : 'Resumed.',
    );
  }

  /* ---------------------------------------------------------------- approvals */

  async approvals(): Promise<readonly OwnerApproval[]> {
    return this.#approvals;
  }

  async approval(approvalId: string): Promise<OwnerApproval | null> {
    return this.#approvals.find((a) => a.id === approvalId) ?? null;
  }

  async grantApproval(
    ctx: ActionContext,
    input: {
      readonly actionType: string;
      readonly payloadJson: string;
      readonly maximumAmountMinor: number | null;
      readonly summary: string;
    },
  ): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;

    let payload: OwnerApprovalPayload;
    try {
      const parsed: unknown = JSON.parse(input.payloadJson);
      payload = { action_type: input.actionType, payload: parsed } as OwnerApprovalPayload;
    } catch {
      return writeFailed('That approval payload is not readable, so there is nothing to bind an approval to.');
    }

    const createdAt = ctx.now.toISOString();
    const expiresAt = new Date(ctx.now.getTime() + 24 * 3_600_000).toISOString();
    try {
      const approval = await grantOwnerApproval(payload, {
        id: this.#id('apr'),
        owner_id: ctx.principal.userId ?? 'unknown',
        maximum_amount_minor: input.maximumAmountMinor,
        currency: input.maximumAmountMinor === null ? null : 'GBP',
        summary: input.summary,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      this.#approvals.unshift(approval);
      this.#record(ctx, 'owner.approval.grant', approval.id, {
        action_type: approval.action_type,
        maximum_amount_minor: approval.maximum_amount_minor,
      });
      return writeOk('/owner/approvals', `Approved. This lapses at ${expiresAt}.`);
    } catch (error) {
      return writeFailed(error instanceof Error ? error.message : 'That approval could not be granted.');
    }
  }

  async revokeApproval(ctx: ActionContext, approvalId: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const index = this.#approvals.findIndex((a) => a.id === approvalId);
    if (index === -1) return writeFailed('There is no approval with that id.');
    const existing = this.#approvals[index];
    if (existing === undefined) return writeFailed('There is no approval with that id.');
    this.#approvals[index] = { ...existing, status: 'revoked' };
    this.#record(ctx, 'owner.approval.revoke', approvalId, { approval_id: approvalId });
    return writeOk('/owner/approvals', 'Withdrawn. It no longer authorises anything.');
  }

  /* ----------------------------------------------------------------- settings */

  async readSettings(): Promise<OwnerSettingsView> {
    return {
      businessJson: this.#settings[SETTINGS_KEY.business] ?? JSON.stringify(DEFAULT_BUSINESS),
      pricingJson: this.#settings[SETTINGS_KEY.pricing] ?? JSON.stringify(DEFAULT_PRICING),
      notificationsJson: this.#settings[SETTINGS_KEY.notifications] ?? JSON.stringify(DEFAULT_NOTIFICATIONS),
      retentionJson: this.#settings[SETTINGS_KEY.retention] ?? JSON.stringify(DEFAULT_RETENTION),
      budgetLimitsJson: this.#settings[SETTINGS_KEY.budgetLimits] ?? JSON.stringify(DEFAULT_BUDGET_LIMITS),
      accessModeJson: this.#settings[SETTINGS_KEY.accessMode] ?? JSON.stringify(DEFAULT_ACCESS_MODE),
    };
  }

  async writeSetting(ctx: ActionContext, key: string, valueJson: string): Promise<OwnerWriteResult> {
    const denied = this.#denied(ctx);
    if (denied !== null) return denied;
    const allowed = Object.values(SETTINGS_KEY) as readonly string[];
    if (!allowed.includes(key)) return writeFailed('That is not a setting this page can change.');
    this.#settings[key] = valueJson;
    this.#record(ctx, 'owner.setting.write', key, { setting: key });
    return writeOk('/owner/settings', 'Saved.');
  }

  /* ------------------------------------------------------------------ quality */

  async qualityRuns(limit: number): Promise<readonly QualityRun[]> {
    return this.#qualityRuns.slice(0, Math.max(0, limit));
  }

  async dispatchQuality(
    ctx: ActionContext,
    suiteId: string,
  ): Promise<OwnerWriteResult & { readonly runState: JobState | null }> {
    const denied = this.#denied(ctx);
    if (denied !== null) return { ...denied, runState: null };

    const result = await dispatchQualityRun(
      {
        suiteId,
        environment: 'development',
        commitSha: null,
        requestedBy: ctx.principal.userId ?? 'unknown',
        at: ctx.now.toISOString(),
      },
      {
        findLive: async (key) => this.#qualityRuns.find((r) => r.dedupeKey === key) ?? null,
        availability: async () => this.#executor,
        persist: async (run) => {
          this.#qualityRuns.unshift(run);
        },
        newId: () => this.#id('qrn'),
      },
    );

    if (!result.ok) return { ...writeFailed(result.detail), runState: null };

    this.#record(ctx, 'owner.quality.dispatch', result.run.id, {
      suite_id: result.run.suiteId,
      deduplicated: result.deduplicated,
    });

    if (result.deduplicated) {
      return {
        ...writeOk('/owner/quality', 'That suite is already queued for this commit, so this is the same request, not a second one.'),
        runState: result.run.state,
      };
    }
    if (result.run.state === 'awaiting_runner') {
      return {
        ...writeBlocked(
          result.run.blockedReason ?? 'No executor is available.',
          'The job is saved and will run when an executor is connected. Nothing has been tested yet.',
        ),
        runState: result.run.state,
      };
    }
    return { ...writeOk('/owner/quality', 'Queued.'), runState: result.run.state };
  }

  /* ------------------------------------------------------------------ cleanup */

  async cleanupPreview(
    ctx: ActionContext,
    categories: readonly string[],
  ): Promise<{ readonly ok: true; readonly inventory: CleanupInventory } | { readonly ok: false; readonly detail: string }> {
    const denied = this.#denied(ctx);
    if (denied !== null) return { ok: false, detail: denied.message ?? 'Not permitted.' };

    const result = await previewCleanup(
      { categories, environment: 'development' },
      {
        scan: async (category) => this.#cleanupResources.filter((i) => i.category === category),
        now: ctx.now,
      },
    );
    if (!result.ok) return { ok: false, detail: result.detail };
    this.#lastInventory = result.inventory;
    this.#record(ctx, 'owner.cleanup.preview', result.inventory.hash, {
      categories: [...categories],
      resource_count: result.inventory.items.length,
    });
    return { ok: true, inventory: result.inventory };
  }

  async cleanupExecute(
    ctx: ActionContext,
    input: { readonly inventoryHash: string; readonly quarantine: boolean },
  ): Promise<{ readonly ok: true; readonly report: CleanupReport } | { readonly ok: false; readonly detail: string }> {
    const denied = this.#denied(ctx);
    if (denied !== null) return { ok: false, detail: denied.message ?? 'Not permitted.' };

    const previous = this.#lastInventory;
    if (previous === null) {
      return { ok: false, detail: 'Take a preview first. Nothing is deleted that has not been listed and read.' };
    }

    const removed = new Set<string>();
    const result = await executeCleanup(
      {
        runId: this.#id('clr'),
        approvedInventoryHash: input.inventoryHash,
        quarantineInsteadOfDelete: input.quarantine,
      },
      {
        rescan: async () => {
          const fresh = await previewCleanup(
            { categories: previous.categories, environment: previous.environment },
            {
              scan: async (category) => this.#cleanupResources.filter((i) => i.category === category),
              now: ctx.now,
            },
          );
          if (!fresh.ok) throw new Error(fresh.detail);
          return fresh.inventory;
        },
        verify: async () => true,
        remove: async (item) => {
          removed.add(item.resourceId);
          return { status: 'done', reclaimedBytes: item.estimatedBytes };
        },
        now: () => ctx.now,
      },
    );

    if (!result.ok) return { ok: false, detail: result.detail };
    this.#cleanupResources = this.#cleanupResources.filter((i) => !removed.has(i.resourceId));
    this.#cleanupReport = result.report;
    this.#lastInventory = null;
    this.#record(ctx, 'owner.cleanup.execute', result.report.runId, {
      deleted: result.report.deleted,
      skipped: result.report.skipped,
      state: result.report.state,
    });
    return { ok: true, report: result.report };
  }

  async lastCleanupReport(): Promise<CleanupReport | null> {
    return this.#cleanupReport;
  }

  /* -------------------------------------------------------------------- audit */

  async auditTrail(limit: number): Promise<readonly AuditRow[]> {
    return this.#audit.slice(0, Math.max(0, limit));
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const SYNTHETIC_DEPLOYMENTS: readonly DeploymentView[] = [
  {
    id: 'dep_0001',
    environment: 'development',
    commitSha: null,
    deployedAt: '2026-09-19T09:00:00.000Z',
    deployedBy: 'local',
    result: 'succeeded',
  },
];

function syntheticAssertions(): readonly AssertionResult[] {
  return [
    {
      rule_id: 'crm_record_exists',
      label: 'A CRM record was created',
      mandatory: true,
      status: 'SUPPORTED',
      reason_code: 'MATCHED',
      expected_display: 'a contact carrying this enquiry reference',
      observed_display: 'contact 4821',
      observed_at: '2026-09-19T08:59:00.000Z',
      evidence_ref: 'evd_1',
    },
    {
      rule_id: 'ack_email_delivered',
      label: 'The acknowledgement email was delivered',
      mandatory: true,
      status: 'UNKNOWN',
      reason_code: 'CONNECTION_UNAVAILABLE',
      expected_display: 'delivered',
      observed_display: null,
      observed_at: null,
      evidence_ref: null,
    },
  ];
}

function buildSyntheticRun(): OwnerRunView {
  const results = syntheticAssertions();
  const run = explainRunStatus('UNVERIFIED');
  return {
    runId: 'run_synthetic_1',
    workspaceId: 'ws_synthetic_demo',
    workflowName: 'Enquiry acknowledgement (synthetic)',
    status: 'UNVERIFIED',
    statusSentence: run.sentence,
    rulesRef: 'wf_synthetic@v2',
    rulesSchemaVersion: 1,
    occurredAt: '2026-09-19T08:55:00.000Z',
    deadlineAt: '2026-09-19T09:25:00.000Z',
    decidedAt: '2026-09-19T09:05:00.000Z',
    evidence: [
      {
        component: 'CRM record',
        provider: 'hubspot',
        origin: 'provider_readback',
        observedAt: '2026-09-19T08:59:00.000Z',
        contentDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
        redactedSummary: 'contact 4821, correlation property set, created 08:58',
      },
    ],
    assertions: results.map((result) => {
      const explained = explainAssertion(result);
      return {
        ruleId: explained.rule_id,
        headline: explained.headline,
        sentence: explained.sentence,
        nextStep: explained.next_step,
        detail: explained.detail,
      };
    }),
    outages: [
      {
        provider: 'resend',
        from: '2026-09-19T08:50:00.000Z',
        to: null,
        detail: 'Rate limited on the events endpoint; retries are backing off.',
      },
    ],
    retryAvailable: true,
    retryBlockedReason: null,
  };
}

const SYNTHETIC_RUNS: readonly OwnerRunView[] = [buildSyntheticRun()];

/**
 * The resources a cleanup preview will find in the synthetic port. Every one carries our
 * ownership tag and no retention constraint — plus three that deliberately do not, so a
 * test can prove the preview refuses them rather than trusting a comment.
 */
export const SYNTHETIC_CLEANUP_ITEMS: readonly InventoryItem[] = [
  {
    resourceId: 'ws_synthetic_old_demo',
    kind: 'workspace',
    category: 'synthetic_workspaces',
    environment: 'development',
    ownershipTag: OWNERSHIP_TAG,
    estimatedBytes: 48_000,
    retentionConstraint: null,
    quarantineAvailable: true,
    isCustomerData: false,
  },
  {
    resourceId: 'sess_expired_0001',
    kind: 'session',
    category: 'expired_sessions',
    environment: 'development',
    ownershipTag: OWNERSHIP_TAG,
    estimatedBytes: 320,
    retentionConstraint: null,
    quarantineAvailable: false,
    isCustomerData: false,
  },
  {
    resourceId: 'sess_expired_0002',
    kind: 'session',
    category: 'expired_sessions',
    environment: 'development',
    ownershipTag: OWNERSHIP_TAG,
    estimatedBytes: 320,
    retentionConstraint: null,
    quarantineAvailable: false,
    isCustomerData: false,
  },
  // --- the three that must never be removed -------------------------------
  {
    resourceId: 'ws_real_customer',
    kind: 'workspace',
    category: 'synthetic_workspaces',
    environment: 'development',
    ownershipTag: OWNERSHIP_TAG,
    estimatedBytes: 120_000,
    retentionConstraint: null,
    quarantineAvailable: false,
    isCustomerData: true,
  },
  {
    resourceId: 'evd_under_retention',
    kind: 'evidence',
    category: 'synthetic_workspaces',
    environment: 'development',
    ownershipTag: OWNERSHIP_TAG,
    estimatedBytes: 4_000,
    retentionConstraint: 'evidence is kept for 30 days and this is 4 days old',
    quarantineAvailable: false,
    isCustomerData: false,
  },
  {
    resourceId: 'unrelated-project-bucket',
    kind: 'r2_bucket',
    category: 'synthetic_workspaces',
    environment: 'development',
    ownershipTag: 'some-other-project',
    estimatedBytes: 900_000,
    retentionConstraint: null,
    quarantineAvailable: false,
    isCustomerData: false,
  },
];
