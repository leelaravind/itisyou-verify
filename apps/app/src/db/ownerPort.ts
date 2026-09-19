/**
 * `OwnerDataPort` and `OwnerAuthPort` against D1.
 *
 * Two rules shape every method below, and they pull in opposite directions on purpose:
 *
 *  1. **Where there is real data, use it.** Customers, orders, runs, connections,
 *     approvals, controls, settings, exceptions and the audit trail are all real rows and
 *     are read as such.
 *  2. **Where there is not, say so.** Adverts, the quality runner, cleanup, deployments
 *     and alerts have no data source on this deployment. Those methods return `null`
 *     (which A07's pages render as "unknown", never as zero) and `writeBlocked(...)` with
 *     a sentence naming the missing dependency. An owner dashboard that invents a figure
 *     is worse than one that admits a gap, because the owner will make a decision on it.
 *
 * `synthetic` is false, so A07's pages drop the placeholder banner — which is only
 * truthful because of rule 2.
 */
import type { AccessMode, Currency, JobState, SubscriptionStatus } from '@verify/contracts';
import { maskEmail, maskToken } from '@verify/security';
import { ANONYMOUS_PRINCIPAL, type OwnerPrincipal } from '../owner/access';
import {
  APPROVAL_LIFETIME_SECONDS,
  isOwnerActionType,
  type OwnerApproval,
} from '../owner/approvals';
import {
  CONTROL_KEYS,
  controlSettingKey,
  defaultControlState,
  defaultControls,
  isControlKey,
  type ControlKey,
  type Controls,
} from '../owner/controls';
import type { CleanupInventory, CleanupReport } from '../owner/cleanup';
import type { NotificationHealth } from '../owner/notifications';
import type { QualityRun } from '../owner/quality';
import { AssistantOff, OfflineRunner } from '../owner/runner';
import {
  DEFAULT_ACCESS_MODE,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_BUSINESS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_PRICING,
  DEFAULT_RETENTION,
  SETTINGS_KEY,
} from '../owner/settings';
import {
  writeBlocked,
  writeFailed,
  writeOk,
  type ActionContext,
  type AuditRow,
  type CampaignView,
  type CustomerRow,
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
} from '../owner/port';
import type { BootstrapResult } from '../owner/bootstrap';
import type { OwnerAuthPort, TotpResult } from '../routes/owner/index';
import { bootstrapHandler } from '../routes/owner/index';
import type { Env } from '../lib/context';
import { ID_PREFIX, newId } from '../lib/ids';
import {
  issueSignInToken,
  platformOwnerExists,
  promoteToPlatformOwner,
  verifyTotpForUser,
} from '../lib/auth';
import { consume } from '../lib/ratelimit';
import { resolveIdentity } from '../lib/session';
import { addSecondsIso, nowIso } from '../lib/time';
import { generateCsrfToken, hashToken } from '@verify/security';
import { AppError } from '@verify/contracts';
import { auditEvents, settings } from './audit';
import { orders as ordersRepo, refunds as refundsRepo, subscriptions } from './commerce';
import { connections } from './connections';
import type { Db } from './d1';
import { sessions } from './index';
import { runs } from './runs';

/** A dependency sentence, used wherever a real source does not exist yet. */
const NO_ADS =
  'No advertising provider is connected to this deployment, so there is no campaign to act on.';
const NO_RUNNER =
  'No maintenance runner is paired with this deployment, so nothing can be dispatched.';
const NO_CLEANUP =
  'Cloud resource inventory is not wired to this deployment, so there is nothing to preview.';
const NO_REFUND_PATH =
  'Refunds are issued through Stripe, which is not configured on this deployment.';

function unknownHealth(component: string, detail: string): ServiceHealthView {
  return { component, state: 'unknown', detail, observedAt: null };
}

/* -------------------------------------------------------------------------- */
/* the data port                                                               */
/* -------------------------------------------------------------------------- */

export interface OwnerPortInput {
  readonly db: Db;
  readonly env: Env;
  readonly request: { readonly headers: Headers; readonly url: string };
  readonly now?: Date;
}

export class D1OwnerDataPort implements OwnerDataPort {
  readonly synthetic = false;

  readonly #db: Db;
  readonly #env: Env;
  readonly #request: { readonly headers: Headers; readonly url: string };
  readonly #now: Date;
  readonly #runner = new OfflineRunner();
  #principal: OwnerPrincipal | undefined = undefined;

  constructor(input: OwnerPortInput) {
    this.#db = input.db;
    this.#env = input.env;
    this.#request = input.request;
    this.#now = input.now ?? new Date();
  }

  /**
   * Who is asking.
   *
   * The default is anonymous, and every refusal path in `owner/access.ts` turns that into
   * an ordinary 404. Nothing here can promote a caller: `isPlatformOwner` comes from the
   * user row and `isAutomation` from the session row, both read, never inferred.
   */
  async principal(): Promise<OwnerPrincipal> {
    if (this.#principal !== undefined) return this.#principal;

    // `resolveIdentity`, not `resolveSession`: the platform owner is a member of no
    // workspace, so a membership-requiring resolver would lock them out of their own panel.
    const resolved = await resolveIdentity(
      this.#db,
      this.#request,
      this.#env.PUBLIC_BASE_URL,
      this.#now,
    ).catch(() => null);
    if (resolved === null) {
      this.#principal = ANONYMOUS_PRINCIPAL;
      return this.#principal;
    }

    this.#principal = {
      // An automation session is an automation principal even when the user row says
      // owner. The session decides, because the session is the thing that expires.
      kind: resolved.isAutomation ? 'automation' : resolved.isPlatformOwner ? 'owner' : 'customer',
      userId: resolved.userId,
      email: resolved.email,
      isPlatformOwner: resolved.isPlatformOwner,
      isAutomation: resolved.isAutomation,
      mfaVerifiedAt: resolved.mfaVerifiedAt,
      sessionCreatedAt: resolved.sessionCreatedAt,
      sessionExpiresAt: resolved.sessionExpiresAt,
      csrfToken: generateCsrfToken(),
    };
    return this.#principal;
  }

  /* --------------------------------------------------------------- overview */

  async overview(now: Date): Promise<OverviewView> {
    const [cash, refunded, customers, pending, openCases, runs24h, visits] = await Promise.all([
      this.#settledRevenueMinor(),
      this.#refundedMinor(),
      this.#customerCounts(),
      this.#pendingApprovalCount(),
      this.#openSupportCases(),
      this.#runsSince(addSecondsIso(now, -24 * 60 * 60)),
      this.#launchMetrics(),
    ]);

    return {
      finance: {
        currency: 'GBP',
        cashRevenueMinor: cash,
        refundsMinor: refunded,
        // Never billed to us in a form we can read. Unknown, not zero — an owner who sees
        // £0.00 costs will believe the business is more profitable than it is.
        variableCostsMinor: null,
        outstandingCommitmentsMinor: null,
        startupCashRemainingMinor: await this.#startupCashRemainingMinor(),
        lastRefreshAt: nowIso(now),
        estimatedFields: [],
      },
      health: [
        unknownHealth('worker', 'No health probe is wired to this deployment.'),
        unknownHealth('database', 'No health probe is wired to this deployment.'),
        unknownHealth('stripe', 'Commerce is not configured on this deployment.'),
        unknownHealth('resend', 'Email is not configured on this deployment.'),
      ],
      customersActive: customers.active,
      customersTotal: customers.total,
      // Four separate numbers, never collapsed into one. A visit is not a signup and a
      // signup is not income; the only one of the four that is money is the last.
      launch: {
        totalVisits: {
          value: visits.total,
          observedAt: visits.total === null ? null : nowIso(now),
        },
        adAttributedVisits: {
          value: visits.attributed,
          observedAt: visits.attributed === null ? null : nowIso(now),
        },
        qualifiedSignups: { value: visits.qualified, observedAt: nowIso(now) },
        payingCustomers: { value: customers.active, observedAt: nowIso(now) },
      },
      pendingApprovals: pending,
      openSupportCases: openCases,
      runsLast24h: runs24h,
      assembledAt: nowIso(now),
    };
  }

  async #settledRevenueMinor(): Promise<number | null> {
    // tenant-scope:exempt the platform owner's view is cross-tenant by definition;
    // this is the whole business, not one customer's slice of it.
    const row = await this.#db
      .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM orders WHERE status = 'active'")
      .first<{ n: number }>();
    return row === null ? null : Number(row.n);
  }

  async #refundedMinor(): Promise<number | null> {
    // tenant-scope:exempt the platform owner's view is cross-tenant by definition;
    // this is the whole business, not one customer's slice of it.
    const row = await this.#db
      .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM refunds WHERE state = 'succeeded'")
      .first<{ n: number }>();
    return row === null ? null : Number(row.n);
  }

  async #startupCashRemainingMinor(): Promise<number | null> {
    const row = await this.#db
      .prepare(
        `SELECT (authorised_limit_minor - spent_minor - committed_minor) AS n
           FROM budget_accounts WHERE scope = 'founder:startup'`,
      )
      .first<{ n: number }>();
    return row === null ? null : Number(row.n);
  }

  async #customerCounts(): Promise<{ active: number | null; total: number | null }> {
    const row = await this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' AND is_synthetic = 0 THEN 1 ELSE 0 END) AS active
           FROM workspaces WHERE deleted_at IS NULL`,
      )
      .first<{ total: number; active: number | null }>();
    if (row === null) return { active: null, total: null };
    return { active: Number(row.active ?? 0), total: Number(row.total) };
  }

  async #pendingApprovalCount(): Promise<number> {
    const row = await this.#db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'granted'")
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async #openSupportCases(): Promise<number | null> {
    const row = await this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM support_cases WHERE state IN ('open','awaiting_owner','escalated')",
      )
      .first<{ n: number }>();
    return row === null ? null : Number(row.n);
  }

  /** tenant-scope:exempt platform-wide owner metric across every workspace. */
  async #runsSince(since: string): Promise<number | null> {
    const row = await this.#db
      .prepare('SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?')
      .bind(since)
      .first<{ n: number }>();
    return row === null ? null : Number(row.n);
  }

  /**
   * The launch numbers, read separately because they mean different things.
   *
   * `qualified` is "created a workspace and connected something" — interest, not revenue.
   * It is deliberately not the same query as `payingCustomers`.
   */
  async #launchMetrics(): Promise<{
    total: number | null;
    attributed: number | null;
    qualified: number | null;
  }> {
    const visits = await this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN utm_campaign IS NOT NULL THEN 1 ELSE 0 END) AS attributed
           FROM visit_sessions WHERE classification = 'external'`,
      )
      .first<{ total: number; attributed: number | null }>();
    const qualified = await this.#db
      .prepare(
        `SELECT COUNT(DISTINCT w.id) AS n FROM workspaces w
           JOIN connections c ON c.workspace_id = w.id AND c.status = 'ready'
          WHERE w.deleted_at IS NULL AND w.is_synthetic = 0`,
      )
      .first<{ n: number }>();
    return {
      total: visits === null ? null : Number(visits.total),
      attributed: visits === null ? null : Number(visits.attributed ?? 0),
      qualified: qualified === null ? null : Number(qualified.n),
    };
  }

  /* ------------------------------------------------------ customers and orders */

  /**
   * The owner's customer list.
   *
   * tenant-scope:exempt the platform owner's whole job is the cross-tenant view; every row
   * carries its workspace_id and the contact is masked before it leaves this method.
   */
  async customers(): Promise<readonly CustomerRow[]> {
    // tenant-scope:exempt the owner's customer list is the cross-tenant view; the contact
    // is masked before it leaves this method and every row names its workspace.
    const result = await this.#db
      .prepare(
        `SELECT w.id, w.name, w.status, w.is_synthetic, w.created_at,
                (SELECT u.auth_subject FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.workspace_id = w.id ORDER BY m.created_at ASC LIMIT 1) AS contact,
                (SELECT COUNT(*) FROM connections c WHERE c.workspace_id = w.id) AS conn_total,
                (SELECT COUNT(*) FROM connections c WHERE c.workspace_id = w.id AND c.status = 'ready') AS conn_ready,
                (SELECT s.status FROM subscriptions s WHERE s.workspace_id = w.id
                  ORDER BY s.updated_at DESC LIMIT 1) AS sub_status,
                (SELECT (e.consumed + e.reserved) FROM entitlements e WHERE e.workspace_id = w.id
                  ORDER BY e.billing_period DESC LIMIT 1) AS runs_period
           FROM workspaces w
          WHERE w.deleted_at IS NULL
          ORDER BY w.created_at DESC
          LIMIT 200`,
      )
      .all<{
        id: string;
        name: string;
        status: string;
        is_synthetic: number;
        created_at: string;
        contact: string | null;
        conn_total: number;
        conn_ready: number;
        sub_status: string | null;
        runs_period: number | null;
      }>();

    return result.results.map((row) => {
      const ready = Number(row.conn_ready);
      const total = Number(row.conn_total);
      const eligible = ready >= 2 && row.status === 'active';
      return {
        workspaceId: row.id,
        name: row.name,
        // Masked here, freshly, from a live read. A stored mask is still a stored address.
        contactMask: row.contact === null ? 'unknown' : maskEmail(row.contact),
        eligible,
        ineligibleReason: eligible
          ? null
          : row.status !== 'active'
            ? `The workspace is ${row.status}.`
            : `${ready} of ${total || 2} provider connections are ready.`,
        subscriptionStatus: (row.sub_status as SubscriptionStatus | null) ?? null,
        connectionsReady: ready,
        connectionsTotal: total,
        runsThisPeriod: row.runs_period === null ? null : Number(row.runs_period),
        createdAt: row.created_at,
        isSynthetic: row.is_synthetic === 1,
      };
    });
  }

  /** tenant-scope:exempt owner order list; narrowed by workspace when one is supplied. */
  async orders(workspaceId: string | null): Promise<readonly OrderRow[]> {
    const rows =
      workspaceId === null
        ? // tenant-scope:exempt owner order list across every workspace; the
          // workspace variant below is scoped through ordersRepo.listForWorkspace.
          (
            await this.#db
              .prepare(
                `SELECT id, workspace_id, status, amount_minor, currency, rejection_reason, created_at
                   FROM orders ORDER BY created_at DESC, id DESC LIMIT 100`,
              )
              .all<{
                id: string;
                workspace_id: string;
                status: string;
                amount_minor: number | null;
                currency: string | null;
                rejection_reason: string | null;
                created_at: string;
              }>()
          ).results
        : (await ordersRepo.listForWorkspace(this.#db, workspaceId, 100)).map((o) => ({
            id: o.id,
            workspace_id: o.workspace_id,
            status: o.status as string,
            amount_minor: o.amount_minor,
            currency: o.currency,
            rejection_reason: o.rejection_reason,
            created_at: o.created_at,
          }));

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      status: row.status,
      amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
      currency: row.currency,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
    }));
  }

  /**
   * What needs the owner's attention, assembled from real rows only.
   *
   * tenant-scope:exempt the exception queue is the cross-tenant view by definition.
   */
  async exceptions(): Promise<readonly ExceptionRow[]> {
    const out: ExceptionRow[] = [];

    const refunds = await refundsRepo.listAwaitingOwner(this.#db, 25);
    for (const refund of refunds) {
      out.push({
        id: refund.id,
        kind: 'refund_pending',
        workspaceId: refund.workspace_id,
        summary: `A refund of ${refund.amount_minor} ${refund.currency} is waiting for your approval.`,
        raisedAt: refund.created_at,
        suggestedAction: 'Review the refund and grant or refuse an approval for it.',
      });
    }

    // tenant-scope:exempt owner exception queue; every row carries its workspace_id and
    // the owner's job is precisely to see across tenants.
    const broken = await this.#db
      .prepare(
        `SELECT id, workspace_id, provider, status FROM connections
          WHERE status IN ('expired','revoked','degraded','unsupported')
          ORDER BY created_at DESC LIMIT 25`,
      )
      .all<{ id: string; workspace_id: string; provider: string; status: string }>();
    for (const row of broken.results) {
      out.push({
        id: row.id,
        kind: 'connection_broken',
        workspaceId: row.workspace_id,
        summary: `The ${row.provider} connection is ${row.status}, so evidence cannot be retrieved.`,
        raisedAt: nowIso(this.#now),
        suggestedAction: 'Ask the customer to reconnect. Nothing here can reconnect it for them.',
      });
    }

    // tenant-scope:exempt owner exception queue; rows carry their own workspace_id.
    const exhausted = await this.#db
      .prepare(
        `SELECT id, workspace_id, billing_period FROM entitlements
          WHERE (run_limit - consumed - reserved) <= 0 ORDER BY billing_period DESC LIMIT 25`,
      )
      .all<{ id: string; workspace_id: string; billing_period: string }>();
    for (const row of exhausted.results) {
      out.push({
        id: row.id,
        kind: 'allowance_exhausted',
        workspaceId: row.workspace_id,
        summary: `The ${row.billing_period} allowance is spent, so new events are being refused.`,
        raisedAt: nowIso(this.#now),
        suggestedAction: 'Nothing is broken. The customer can upgrade or wait for the next period.',
      });
    }

    const escalated = await this.#db
      .prepare(
        `SELECT id, workspace_id, subject, updated_at FROM support_cases
          WHERE state = 'escalated' ORDER BY updated_at DESC LIMIT 25`,
      )
      .all<{ id: string; workspace_id: string | null; subject: string; updated_at: string }>();
    for (const row of escalated.results) {
      out.push({
        id: row.id,
        kind: 'support_escalated',
        workspaceId: row.workspace_id,
        summary: row.subject,
        raisedAt: row.updated_at,
        suggestedAction: 'Answer it, or close it with a reason.',
      });
    }

    return out;
  }

  async cancelSubscription(ctx: ActionContext, workspaceId: string): Promise<OwnerWriteResult> {
    const existing = await subscriptions.getForWorkspace(
      this.#db,
      workspaceId,
      this.#env.STRIPE_MODE === 'live' ? 'live' : 'test',
    );
    if (existing === null) {
      return writeFailed('That workspace has no subscription to cancel.');
    }
    // Cancelling at Stripe is the act that matters; writing `canceled` here without it
    // would tell the owner the customer had stopped paying while the card kept being
    // charged. Refused rather than faked.
    await this.#audit(ctx, 'owner.subscription.cancel_blocked', workspaceId);
    return writeBlocked(
      'Stripe is not configured on this deployment, so the subscription cannot be cancelled at the provider. Nothing has been changed.',
    );
  }

  async rejectBeforeCheckout(
    ctx: ActionContext,
    orderId: string,
    reason: string,
  ): Promise<OwnerWriteResult> {
    if (reason.trim().length < 3) {
      return writeFailed('Give a reason the customer can read.', { reason: 'Say why.' });
    }
    // tenant-scope:exempt the owner rejects an order by its id from their own queue; the
    // status predicate is what makes it safe, and the row returns its workspace_id.
    const row = await this.#db
      .prepare(
        `UPDATE orders SET status = 'rejected', rejection_reason = ?, updated_at = ?
          WHERE id = ? AND status IN ('draft','compatible')
          RETURNING workspace_id`,
      )
      .bind(reason.trim(), nowIso(ctx.now), orderId)
      .first<{ workspace_id: string }>();
    if (row === null) {
      return writeFailed('That order is no longer waiting to be rejected.');
    }
    await this.#audit(ctx, 'owner.order.rejected', orderId);
    return writeOk('/owner/customers', 'The order is rejected and the customer can see why.');
  }

  async issueRefund(ctx: ActionContext, input: RefundRequestInput): Promise<OwnerWriteResult> {
    const approval = await this.approval(input.approvalId);
    if (approval === null || approval.status !== 'granted') {
      return writeFailed('That approval is not usable. Grant one for this exact refund first.');
    }
    await this.#audit(ctx, 'owner.refund.blocked', input.orderId);
    return writeBlocked(NO_REFUND_PATH);
  }

  /* --------------------------------------------------------------- verification */

  /** tenant-scope:exempt owner verification queue across every workspace. */
  async recentRuns(limit: number): Promise<readonly OwnerRunView[]> {
    // tenant-scope:exempt owner verification queue; each id is re-read scoped by the
    // workspace_id this query returns, so nothing downstream is unscoped.
    const result = await this.#db
      .prepare(`SELECT id, workspace_id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(Math.min(Math.max(1, limit), 100))
      .all<{ id: string; workspace_id: string }>();
    const out: OwnerRunView[] = [];
    for (const row of result.results) {
      const view = await this.#runView(row.workspace_id, row.id);
      if (view !== null) out.push(view);
    }
    return out;
  }

  /** tenant-scope:exempt owner run lookup; the workspace is resolved from the row itself. */
  async run(runId: string): Promise<OwnerRunView | null> {
    // tenant-scope:exempt resolves the workspace FROM the run id, then #runView re-reads
    // every row scoped by it.
    const row = await this.#db
      .prepare('SELECT workspace_id FROM runs WHERE id = ?')
      .bind(runId)
      .first<{ workspace_id: string }>();
    if (row === null) return null;
    return this.#runView(row.workspace_id, runId);
  }

  async #runView(workspaceId: string, runId: string): Promise<OwnerRunView | null> {
    const { assertions, evidence } = await import('./runs');
    const { sourceEvents } = await import('./sourceEvents');
    const { workflows, workflowVersions } = await import('./workflows');

    const run = await runs.get(this.#db, workspaceId, runId);
    if (run === null) return null;
    const [event, version, workflow, results, evidenceRows] = await Promise.all([
      sourceEvents.getForRun(this.#db, workspaceId, runId),
      workflowVersions.get(this.#db, workspaceId, run.workflow_version_id),
      workflows.get(this.#db, workspaceId, run.workflow_id),
      assertions.listForRun(this.#db, workspaceId, runId),
      evidence.listForRun(this.#db, workspaceId, runId),
    ]);

    return {
      runId: run.id,
      workspaceId,
      workflowName: workflow?.name ?? 'Workflow',
      status: run.status,
      statusSentence: STATUS_SENTENCE[run.status] ?? 'No decision has been recorded.',
      rulesRef: `${run.workflow_id}@v${version?.version_number ?? 1}`,
      rulesSchemaVersion: version?.schema_version ?? 1,
      occurredAt: event?.occurred_at ?? run.created_at,
      deadlineAt: run.deadline_at,
      decidedAt: run.completed_at,
      evidence: evidenceRows.map((e) => ({
        component: e.provider,
        provider: e.provider,
        origin: e.origin,
        observedAt: e.observed_at,
        contentDigest: e.content_digest,
        redactedSummary: e.redacted_summary,
      })),
      assertions: results.map((a) => ({
        ruleId: a.rule_id,
        headline: a.label,
        sentence: a.observed_display ?? 'Nothing was observed for this check.',
        nextStep: null,
        detail: a.expected_display,
      })),
      outages: [],
      retryAvailable: false,
      retryBlockedReason:
        'Re-running a verification needs the connectors, which are not configured on this deployment.',
    };
  }

  async retryRun(ctx: ActionContext, runId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.run.retry_blocked', runId);
    return writeBlocked(
      'Re-running a verification needs the provider connectors, which are not configured on this deployment.',
    );
  }

  /* ---------------------------------------------------------------- connections */

  /** tenant-scope:exempt owner connection health across every workspace. */
  async connections(): Promise<readonly OwnerConnectionView[]> {
    // tenant-scope:exempt owner connection health across every workspace; the mask is
    // generated here from a fresh read and no credential is in the projection.
    const result = await this.#db
      .prepare(
        `SELECT id, workspace_id, provider, status, last_check_at, last_error_code,
                external_account_id, scopes
           FROM connections ORDER BY workspace_id ASC, provider ASC LIMIT 200`,
      )
      .all<{
        id: string;
        workspace_id: string;
        provider: string;
        status: string;
        last_check_at: string | null;
        last_error_code: string | null;
        external_account_id: string | null;
        scopes: string;
      }>();

    return result.results.map((row) => {
      let scopes: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.scopes);
        if (Array.isArray(parsed))
          scopes = parsed.filter((s): s is string => typeof s === 'string');
      } catch {
        scopes = [];
      }
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        provider: row.provider,
        status: row.status as OwnerConnectionView['status'],
        lastCheckAt: row.last_check_at,
        lastErrorCode: row.last_error_code,
        // Generated here from a fresh read of the account identifier. Never a mask of
        // ciphertext, never stored, never round-tripped.
        maskHint: row.external_account_id === null ? null : maskToken(row.external_account_id),
        scopes,
        rotationDueAt: null,
      };
    });
  }

  async rotateConnection(ctx: ActionContext, connectionId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.connection.rotate_blocked', connectionId);
    return writeBlocked(
      'Rotating a credential means re-authorising with the provider, which is not configured on this deployment.',
    );
  }

  async revokeConnection(ctx: ActionContext, connectionId: string): Promise<OwnerWriteResult> {
    // tenant-scope:exempt resolves the workspace FROM the connection id the owner clicked,
    // which is the only unscoped read; `connections.revoke` below then carries the
    // resolved workspace_id in its own predicate.
    const row = await this.#db
      .prepare('SELECT workspace_id FROM connections WHERE id = ?')
      .bind(connectionId)
      .first<{ workspace_id: string }>();
    if (row === null) return writeFailed('That connection does not exist.');
    // Revoking is genuinely local: it stops us using the credential and retires every
    // stored envelope, which we can do without the provider.
    const revoked = await connections.revoke(
      this.#db,
      row.workspace_id,
      connectionId,
      nowIso(ctx.now),
    );
    if (!revoked) return writeFailed('That connection was already revoked.');
    await this.#audit(ctx, 'owner.connection.revoked', connectionId);
    return writeOk(
      '/owner/connections',
      'The connection is revoked and its stored credentials are retired.',
    );
  }

  /* ----------------------------------------------------------------------- ads */

  async campaigns(): Promise<readonly CampaignView[]> {
    return [];
  }

  async campaign(): Promise<CampaignView | null> {
    return null;
  }

  async activateCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.campaign.activate_blocked', campaignId);
    return writeBlocked(NO_ADS);
  }

  async pauseCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.campaign.pause_blocked', campaignId);
    return writeBlocked(NO_ADS);
  }

  async resumeCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.campaign.resume_blocked', campaignId);
    return writeBlocked(NO_ADS);
  }

  /* ---------------------------------------------------------------- operations */

  async operations(now: Date): Promise<OperationsView> {
    return {
      health: [
        unknownHealth('worker', 'No health probe is wired to this deployment.'),
        unknownHealth('database', 'No health probe is wired to this deployment.'),
      ],
      deployments: [],
      alerts: [],
      runner: await this.#runner.status(),
      maintenanceJobs: await this.#runner.listJobs(20),
      assistant: await new AssistantOff().status(),
      // Real, not a stand-in: `notification_deliveries` exists, so "is anything stuck?"
      // is a question this deployment can actually answer.
      notifications: await this.#notificationHealth(now),
    };
  }

  /**
   * Deliveries that claimed a row and never reported an outcome.
   *
   * Messages are sent at most once by design, so a send interrupted halfway is never
   * retried automatically — the owner is the retry. That is why these are surfaced rather
   * than swept, and why an empty list here is a real answer and not a default.
   */
  async #notificationHealth(now: Date): Promise<NotificationHealth> {
    const stuckAfterSeconds = 15 * 60;
    const cutoff = addSecondsIso(now, -stuckAfterSeconds);
    const stuck = await this.#db
      .prepare(
        `SELECT id, workspace_id, template, channel, attempt_count, provider_status, created_at
           FROM notification_deliveries
          WHERE state = 'pending' AND created_at <= ?
          ORDER BY id LIMIT 50`,
      )
      .bind(cutoff)
      .all<{
        id: string;
        workspace_id: string | null;
        template: string;
        channel: string;
        attempt_count: number;
        provider_status: string | null;
        created_at: string;
      }>();
    const inFlight = await this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM notification_deliveries WHERE state = 'pending' AND created_at > ?",
      )
      .bind(cutoff)
      .first<{ n: number }>();

    return {
      stuck: stuck.results.map((row) => ({
        id: row.id,
        template: row.template,
        channel: row.channel,
        workspaceId: row.workspace_id,
        createdAt: row.created_at,
        ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(row.created_at)) / 1000)),
        attemptCount: Number(row.attempt_count),
        providerStatus: row.provider_status,
      })),
      inFlight: Number(inFlight?.n ?? 0),
      unavailableReason: null,
    };
  }

  /**
   * Queue a typed maintenance job.
   *
   * `kind` is one of A08's closed vocabulary and never becomes part of a command. With no
   * runner paired the job is still recorded and comes back `awaiting_runner` with the
   * reason attached — accepted honestly rather than refused or faked.
   */
  async enqueueMaintenance(ctx: ActionContext, kind: string): Promise<OwnerWriteResult> {
    const outcome = await this.#runner.enqueue({
      kind,
      requestedBy: ctx.principal.userId ?? 'owner',
      at: nowIso(ctx.now),
      idempotencyKey: `maint:${kind}:${nowIso(ctx.now).slice(0, 16)}`,
    });
    await this.#audit(ctx, 'owner.maintenance.enqueued', kind);
    if (!outcome.ok) return writeBlocked(outcome.detail);
    return writeOk('/owner/operations', 'The job is queued and will run when a runner is paired.');
  }

  async acknowledgeAlert(ctx: ActionContext, alertId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.alert.ack_blocked', alertId);
    return writeBlocked(
      'No alerting source is wired to this deployment, so there is nothing to acknowledge.',
    );
  }

  /* ------------------------------------------------------------------ controls */

  async controls(): Promise<Controls> {
    const out: Record<string, unknown> = { ...defaultControls() };
    for (const key of CONTROL_KEYS) {
      const stored = await settings.getJson<unknown>(this.#db, controlSettingKey(key), null);
      if (stored !== null && typeof stored === 'object') out[key] = stored;
    }
    return out as Controls;
  }

  async setControl(
    ctx: ActionContext,
    key: string,
    paused: boolean,
    note: string | null,
  ): Promise<OwnerWriteResult> {
    if (!isControlKey(key)) return writeFailed('That is not a control this panel owns.');
    const next = {
      ...defaultControlState(key as ControlKey),
      paused,
      changedAt: nowIso(ctx.now),
      changedBy: ctx.principal.userId ?? 'owner',
      note,
    };
    await settings.set(this.#db, {
      key: controlSettingKey(key as ControlKey),
      valueJson: JSON.stringify(next),
      updatedAt: nowIso(ctx.now),
      updatedBy: ctx.principal.userId,
    });
    await this.#audit(ctx, paused ? 'owner.control.paused' : 'owner.control.resumed', key);
    return writeOk('/owner/controls', paused ? 'Paused.' : 'Resumed.');
  }

  /* ----------------------------------------------------------------- approvals */

  async approvals(): Promise<readonly OwnerApproval[]> {
    const result = await this.#db
      .prepare(
        `SELECT id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency,
                status, note, created_at, expires_at, consumed_at
           FROM approvals ORDER BY created_at DESC LIMIT 100`,
      )
      .all<ApprovalRow>();
    return result.results.map(toApproval).filter((a): a is OwnerApproval => a !== null);
  }

  async approval(approvalId: string): Promise<OwnerApproval | null> {
    const row = await this.#db
      .prepare(
        `SELECT id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency,
                status, note, created_at, expires_at, consumed_at
           FROM approvals WHERE id = ?`,
      )
      .bind(approvalId)
      .first<ApprovalRow>();
    return row === null ? null : toApproval(row);
  }

  async grantApproval(
    ctx: ActionContext,
    input: {
      actionType: string;
      payloadJson: string;
      maximumAmountMinor: number | null;
      summary: string;
    },
  ): Promise<OwnerWriteResult> {
    if (!isOwnerActionType(input.actionType)) {
      return writeFailed('That is not an action this panel can approve.');
    }
    if (input.summary.trim().length < 3) {
      return writeFailed('Write what you are approving, in a sentence.', {
        summary: 'A hash is not an audit trail.',
      });
    }
    if (ctx.principal.userId === null) return writeFailed('Only a signed-in owner can approve.');

    const id = newId(ID_PREFIX.approval, ctx.now.getTime());
    await this.#db
      .prepare(
        `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency, status, note, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?)`,
      )
      .bind(
        id,
        ctx.principal.userId,
        input.actionType,
        await hashToken(input.payloadJson, 'approval'),
        input.maximumAmountMinor,
        input.maximumAmountMinor === null ? null : 'GBP',
        input.summary.trim(),
        nowIso(ctx.now),
        addSecondsIso(ctx.now, APPROVAL_LIFETIME_SECONDS),
      )
      .run();
    await this.#audit(ctx, 'owner.approval.granted', id);
    return writeOk('/owner/approvals', 'Approval granted. It expires in 24 hours.');
  }

  async revokeApproval(ctx: ActionContext, approvalId: string): Promise<OwnerWriteResult> {
    const result = await this.#db
      .prepare("UPDATE approvals SET status = 'revoked' WHERE id = ? AND status = 'granted'")
      .bind(approvalId)
      .run();
    if (result.meta.changes !== 1) return writeFailed('That approval is no longer revocable.');
    await this.#audit(ctx, 'owner.approval.revoked', approvalId);
    return writeOk('/owner/approvals', 'Revoked.');
  }

  /* ------------------------------------------------------------------ settings */

  async readSettings(): Promise<OwnerSettingsView> {
    const read = async (key: string, fallback: unknown): Promise<string> =>
      JSON.stringify(await settings.getJson(this.#db, key, fallback));
    return {
      businessJson: await read(SETTINGS_KEY.business, DEFAULT_BUSINESS),
      pricingJson: await read(SETTINGS_KEY.pricing, DEFAULT_PRICING),
      notificationsJson: await read(SETTINGS_KEY.notifications, DEFAULT_NOTIFICATIONS),
      retentionJson: await read(SETTINGS_KEY.retention, DEFAULT_RETENTION),
      budgetLimitsJson: await read(SETTINGS_KEY.budgetLimits, DEFAULT_BUDGET_LIMITS),
      accessModeJson: await read(SETTINGS_KEY.accessMode, DEFAULT_ACCESS_MODE),
    };
  }

  async writeSetting(
    ctx: ActionContext,
    key: string,
    valueJson: string,
  ): Promise<OwnerWriteResult> {
    const allowed = new Set<string>(Object.values(SETTINGS_KEY));
    if (!allowed.has(key)) return writeFailed('That is not a setting this panel owns.');
    try {
      JSON.parse(valueJson);
    } catch {
      return writeFailed('That value is not valid JSON.', { value: 'Check the syntax.' });
    }
    await settings.set(this.#db, {
      key,
      valueJson,
      updatedAt: nowIso(ctx.now),
      updatedBy: ctx.principal.userId,
    });
    await this.#audit(ctx, 'owner.setting.written', key);
    return writeOk('/owner/settings', 'Saved.');
  }

  /* ------------------------------------------------------------------- quality */

  async qualityRuns(limit: number): Promise<readonly QualityRun[]> {
    const result = await this.#db
      .prepare(
        `SELECT id, suite_id, environment, executor, state, commit_sha, dedupe_key, total_cases,
                passed, failed, skipped, started_at, ended_at, report_ref, limitations, created_at
           FROM quality_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(Math.min(Math.max(1, limit), 50))
      .all<Record<string, unknown>>();
    return result.results.map((row) => ({
      id: String(row['id']),
      suiteId: String(row['suite_id']),
      environment: String(row['environment']),
      executor: row['executor'] as QualityRun['executor'],
      state: row['state'] as JobState,
      commitSha: (row['commit_sha'] as string | null) ?? null,
      dedupeKey: String(row['dedupe_key'] ?? ''),
      requestedBy: 'owner',
      totalCases: row['total_cases'] === null ? null : Number(row['total_cases']),
      passed: row['passed'] === null ? null : Number(row['passed']),
      failed: row['failed'] === null ? null : Number(row['failed']),
      skipped: row['skipped'] === null ? null : Number(row['skipped']),
      startedAt: (row['started_at'] as string | null) ?? null,
      endedAt: (row['ended_at'] as string | null) ?? null,
      reportRef: (row['report_ref'] as string | null) ?? null,
      limitations:
        (row['limitations'] as string | null) ??
        'This run recorded no statement about what it could not prove.',
      blockedReason: null,
      createdAt: String(row['created_at']),
    }));
  }

  async dispatchQuality(
    ctx: ActionContext,
    suiteId: string,
  ): Promise<OwnerWriteResult & { runState: JobState | null }> {
    await this.#audit(ctx, 'owner.quality.dispatch_blocked', suiteId);
    return { ...writeBlocked(NO_RUNNER), runState: null };
  }

  /* ------------------------------------------------------------------- cleanup */

  async cleanupPreview(): Promise<
    { ok: true; inventory: CleanupInventory } | { ok: false; detail: string }
  > {
    return { ok: false, detail: NO_CLEANUP };
  }

  async cleanupExecute(): Promise<
    { ok: true; report: CleanupReport } | { ok: false; detail: string }
  > {
    return { ok: false, detail: NO_CLEANUP };
  }

  async lastCleanupReport(): Promise<CleanupReport | null> {
    return null;
  }

  /* --------------------------------------------------------------------- audit */

  async auditTrail(limit: number): Promise<readonly AuditRow[]> {
    const rows = await auditEvents.listPlatform(this.#db, limit);
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      actorKind: row.actor_kind,
      action: row.action,
      target: row.target,
      occurredAt: row.occurred_at,
      redactedMetadata: row.redacted_metadata,
    }));
  }

  async #audit(ctx: ActionContext, action: string, target: string | null): Promise<void> {
    await auditEvents.record(this.#db, {
      id: newId(ID_PREFIX.auditEvent, ctx.now.getTime()),
      actor: ctx.principal.userId ?? 'anonymous',
      actorKind: ctx.principal.isAutomation ? 'automation' : 'user',
      action,
      target,
      requestId: ctx.requestId,
      occurredAt: nowIso(ctx.now),
    });
  }
}

const STATUS_SENTENCE: Record<string, string> = {
  VERIFIED: 'Every required check is supported by evidence we retrieved.',
  FAILED: 'Evidence contradicts at least one required check.',
  UNVERIFIED: 'We could not retrieve enough evidence to decide. That is not a failure.',
  PENDING: 'Still inside the agreed completion window.',
};

interface ApprovalRow {
  readonly id: string;
  readonly owner_id: string;
  readonly action_type: string;
  readonly canonical_payload_hash: string;
  readonly maximum_amount_minor: number | null;
  readonly currency: string | null;
  readonly status: string;
  readonly note: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

function toApproval(row: ApprovalRow): OwnerApproval | null {
  if (!isOwnerActionType(row.action_type)) return null;
  return {
    id: row.id,
    action_type: row.action_type,
    owner_id: row.owner_id,
    canonical_payload_hash: row.canonical_payload_hash,
    maximum_amount_minor:
      row.maximum_amount_minor === null ? null : Number(row.maximum_amount_minor),
    currency: (row.currency as Currency | null) ?? null,
    status: row.status as OwnerApproval['status'],
    summary: row.note ?? '',
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

/* -------------------------------------------------------------------------- */
/* the auth port                                                               */
/* -------------------------------------------------------------------------- */

export class D1OwnerAuth implements OwnerAuthPort {
  readonly #db: Db;
  readonly #env: Env;

  constructor(input: { db: Db; env: Env }) {
    this.#db = input.db;
    this.#env = input.env;
  }

  /**
   * Accept a sign-in request and issue a token.
   *
   * Returns nothing, always, whether or not the address has an account — A07's page shows
   * the same sentence either way. The token is minted and stored hashed; when Resend is
   * configured the mail path picks it up. Until then it is issued and simply never
   * delivered, which is honest: the link genuinely exists and genuinely expires.
   */
  async requestSignInLink(email: string): Promise<void> {
    const now = new Date();
    const address = email.trim().toLowerCase();
    if (address.length === 0 || !address.includes('@')) return;

    // Rate limited on a hash of the address, never the address itself.
    const decision = await consume(
      this.#db,
      `signin:${await hashToken(address, 'ratelimit')}`,
      5,
      15 * 60,
      now,
    );
    if (!decision.allowed) return;

    await issueSignInToken(this.#db, { email: address, now });
  }

  /**
   * Issue a sign-in link and return its URL, for staging only.
   *
   * Documented completion path while Resend is unconfigured. It is **impossible in
   * production**: the environment check throws before a token is minted, so there is no
   * token to leak even if the route were somehow reachable. The guard is here rather than
   * in the route because a route can be mounted twice and a constructor cannot.
   */
  async issueStagingSignInLink(email: string, now: Date = new Date()): Promise<string> {
    if (this.#env.ENVIRONMENT === 'production') {
      throw new AppError(404, 'NOT_FOUND', 'Not found.');
    }
    const issued = await issueSignInToken(this.#db, { email, now });
    const base = this.#env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    return `${base}/admin/login/complete?token=${encodeURIComponent(issued.token)}`;
  }

  async verifyTotp(principal: OwnerPrincipal, code: string, now: Date): Promise<TotpResult> {
    if (principal.userId === null) {
      return { ok: false, dependency: null };
    }
    const outcome = await verifyTotpForUser(this.#db, this.#env, {
      userId: principal.userId,
      code,
      now,
      ...(principal.kind === 'anonymous' ? {} : {}),
      accountName: principal.email ?? 'owner',
    });
    if (outcome.ok) return { ok: true, dependency: null };
    return { ok: false, dependency: outcome.dependency };
  }

  /**
   * The one-time promotion, composed through A07's `bootstrapHandler` so the four
   * conditions cannot be assembled wrongly here.
   */
  bootstrap(
    input: { presentedToken: string; verifiedAuthSubject: string | null },
    now: Date,
  ): Promise<BootstrapResult> {
    const handler = bootstrapHandler({
      configuredToken: this.#env.OWNER_BOOTSTRAP_TOKEN ?? null,
      configuredEmail: this.#env.OWNER_BOOTSTRAP_EMAIL ?? null,
      platformOwnerExists: () => platformOwnerExists(this.#db),
      promote: (authSubject) => promoteToPlatformOwner(this.#db, authSubject),
      recordAudit: async (entry) => {
        await auditEvents.record(this.#db, {
          id: newId(ID_PREFIX.auditEvent, now.getTime()),
          actor: entry.actor,
          actorKind: 'system',
          action: entry.action,
          target: entry.outcome,
          occurredAt: entry.occurredAt,
        });
      },
    });
    return handler(input, now);
  }

  async signOut(principal: OwnerPrincipal): Promise<void> {
    if (principal.userId === null) return;
    await sessions.revokeAllForUser(this.#db, principal.userId, nowIso(new Date()));
  }

  async accessMode(): Promise<AccessMode> {
    const stored = await settings.getJson<{ mode?: string }>(
      this.#db,
      SETTINGS_KEY.accessMode,
      DEFAULT_ACCESS_MODE,
    );
    return stored.mode === 'RESTRICTED_ENTRY' ? 'RESTRICTED_ENTRY' : 'PUBLIC_LOGIN';
  }
}

/** Factory for the route mount, mirroring `createCustomerDataPort`. */
export function createOwnerDataPort(
  c: { readonly env: unknown; readonly req: { readonly raw: Request } },
  now?: Date,
): D1OwnerDataPort {
  const env = c.env as Env | undefined;
  if (env === undefined || env === null || typeof env !== 'object' || !('DB' in env)) {
    throw new Error('createOwnerDataPort: the DB binding is missing.');
  }
  return new D1OwnerDataPort({
    db: env.DB,
    env,
    request: c.req.raw,
    ...(now !== undefined ? { now } : {}),
  });
}

export function createOwnerAuth(c: { readonly env: unknown }): D1OwnerAuth {
  const env = c.env as Env | undefined;
  if (env === undefined || env === null || typeof env !== 'object' || !('DB' in env)) {
    throw new Error('createOwnerAuth: the DB binding is missing.');
  }
  return new D1OwnerAuth({ db: env.DB, env });
}
