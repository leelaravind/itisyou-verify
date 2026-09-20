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
import {
  CAMPAIGN_STATE,
  type AccessMode,
  type CampaignState,
  type Currency,
  type JobState,
  type SubscriptionStatus,
} from '@verify/contracts';
import { maskEmail, maskToken } from '@verify/security';
import { ANONYMOUS_PRINCIPAL, type OwnerPrincipal } from '../owner/access';
import {
  APPROVAL_LIFETIME_SECONDS,
  checkCampaignApproval,
  checkOwnerApproval,
  claimApproval,
  consumeApproval,
  explainApprovalRejection,
  grantOwnerApproval,
  isOwnerActionType,
  ownerPayloadHash,
  type OwnerApproval,
  type OwnerApprovalPayload,
} from '../owner/approvals';
import { packetHash, type CampaignApproval, type CampaignPacket } from '../growth/approval';
import { initialLifecycle, transition } from '../growth/lifecycle';
import {
  CONTROL_DESCRIPTION,
  CONTROL_KEYS,
  controlSettingKey,
  defaultControlState,
  defaultControls,
  isControlKey,
  type ControlKey,
  type ControlState,
  type Controls,
} from '../owner/controls';
import {
  executeCleanup,
  isCleanupCategory,
  OWNERSHIP_TAG,
  previewCleanup,
  type CleanupInventory,
  type CleanupReport,
  type InventoryItem,
} from '../owner/cleanup';
import type { NotificationHealth } from '../owner/notifications';
import { createNotificationDelivery, type NotificationDelivery } from '../notifications/delivery';
import { D1SupportDataPort } from './supportPort';
import {
  dispatchQualityRun,
  isTerminalState,
  type ExecutorAvailability,
  type QualityRun,
} from '../owner/quality';
import type { AssistantStatusPort, MaintenanceRunnerPort } from '../owner/runner';
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
import { D1ApprovalClaims } from './approvalClaims';
import { auditEvents, settings } from './audit';
import { orders as ordersRepo, refunds as refundsRepo, subscriptions } from './commerce';
import { connections } from './connections';
import type { Db } from './d1';
import { moneyPathReadiness } from '../money/mount';
import { sessions } from './index';
import { runs } from './runs';

/** A dependency sentence, used wherever a real source does not exist yet. */
const NO_ADS =
  'No advertising provider is connected to this deployment, so there is no campaign to act on.';

/**
 * What is true after an activation has been authorised and nothing else can happen.
 *
 * The approval **has** been spent by the time this is returned, and the sentence says so.
 * An owner who reads "nothing happened" and grants a second approval would be right to be
 * surprised when the first one is gone; the whole point of consume-before-act is that the
 * spend is visible even when the act could not complete.
 */
const ADS_AUTHORISED_BUT_UNSUBMITTED =
  'The approval has been spent and this campaign is now marked ready to submit, with the exact packet you ' +
  'approved recorded against it. Nothing has been created at an advertising platform, because no advertising ' +
  'provider is connected to this deployment — no money can be spent by this action. Submitting is a separate ' +
  'step that needs a connected platform.';

/**
 * Why the ordinary settings save refuses one key.
 *
 * `owner.budget_limits` is the only entry in `SETTINGS_KEY` that names an amount of money
 * the platform is allowed to spend — including `platform:advertising`, which is the owner's
 * reserved £15 allocation. `owner/settings.ts` already documents it as "bound to an
 * approval… it does not share the ordinary settings save path", but nothing enforced that:
 * the key sat in the same allowlist as the business address, so any caller of
 * `writeSetting` — a new route, a future form, a mistake — could raise a ceiling with no
 * approval, no consumption and no audit fact beyond "a setting was written".
 *
 * There is today **no** approval-bound path that writes this key: `budget_limit_change` is
 * a declared `OwnerActionType` with a canonical payload and a maximum check, and it has no
 * action behind it. So the honest state is that a ceiling cannot be changed from the panel
 * at all, and this refusal is what makes that true rather than merely unrouted. Failing
 * closed is the correct direction for a control that governs spending: an owner who cannot
 * raise a ceiling loses nothing that money depends on, and one who can raise it silently
 * loses the only gate on it.
 */
const BUDGET_LIMIT_NEEDS_APPROVAL =
  'A spending ceiling cannot be changed through the ordinary settings save — it is the one setting on this page ' +
  'that decides how much money the platform may spend, so it needs an approval granted for that exact change. ' +
  'Nothing has been saved and the current ceilings still stand. There is no approval-bound path for this on ' +
  'this deployment yet, so today the answer is that a ceiling cannot be raised from the panel at all.';

/** Cleanup categories are scanned here; a category with no scanner returns nothing at all. */
const CLEANUP_STALE_QUALITY_RUN_SECONDS = 90 * 24 * 60 * 60;
const CLEANUP_STALE_PREVIEW_SECONDS = 7 * 24 * 60 * 60;

/** Thrown by the quality persist step when a concurrent request won the dedupe key. */
class DedupeCollision extends Error {}

function unknownHealth(component: string, detail: string): ServiceHealthView {
  return { component, state: 'unknown', detail, observedAt: null };
}

/* -------------------------------------------------------------------------- */
/* the data port                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What `requestSignInLink` actually did, so the page can stop guessing.
 *
 * It deliberately carries no information about the ADDRESS -- not whether it has an
 * account, not whether it was rate limited -- because varying the reply on either would
 * turn this public endpoint into an account oracle. It carries information about the
 * DEPLOYMENT, which every visitor can already observe and which is the one thing the page
 * was previously getting wrong: it said a link was on its way on deployments that send
 * nothing at all.
 */
export interface SignInLinkOutcome {
  readonly delivery: 'sent' | 'no_transport' | 'send_failed';
}

export interface OwnerPortInput {
  readonly db: Db;
  readonly env: Env;
  readonly request: { readonly headers: Headers; readonly url: string };
  readonly now?: Date;
  /**
   * Injected transport for the provider paths. Absent in production.
   *
   * It exists because its absence was itself a defect: with no way to supply a transport,
   * no test could reach the branch where this port talks to Stripe, and the owner's refund
   * control sat dead behind a green suite. `customerPort` already had this; the asymmetry
   * is what let the two diverge.
   */
  readonly fetchImpl?: typeof fetch;
}

export class D1OwnerDataPort implements OwnerDataPort {
  readonly synthetic = false;

  readonly #db: Db;
  readonly #env: Env;
  readonly #request: { readonly headers: Headers; readonly url: string };
  readonly #now: Date;
  readonly #fetchImpl: typeof fetch | undefined;
  #principal: OwnerPrincipal | undefined = undefined;
  #runnerPort: MaintenanceRunnerPort | undefined = undefined;
  #assistantPort: AssistantStatusPort | undefined = undefined;

  /**
   * A10's compare-and-set store. One instance per port, and the only way an approval is
   * ever spent from here — `CLAIM_APPROVAL_SQL` has exactly one spelling and it is not in
   * this file.
   */
  readonly #claims: D1ApprovalClaims;

  constructor(input: OwnerPortInput) {
    this.#db = input.db;
    this.#env = input.env;
    this.#request = input.request;
    this.#now = input.now ?? new Date();
    this.#fetchImpl = input.fetchImpl;
    this.#claims = new D1ApprovalClaims(input.db);
  }

  /**
   * A08's real runner, bound lazily.
   *
   * Lazily and by dynamic import for one reason: `maintenance/ownerPort.ts` imports
   * `db/index.ts`, which imports this file. A top-level import would make that cycle load
   * order-dependent; resolving it on first use resolves it after every module has
   * evaluated. The previous binding was `OfflineRunner` — an in-memory stand-in that
   * reported "no runner" whatever the database said, and whose queued jobs vanished with
   * the request that made them.
   */
  async #runner(): Promise<MaintenanceRunnerPort> {
    if (this.#runnerPort === undefined) {
      const { D1MaintenanceRunnerPort } = await import('../maintenance/ownerPort.js');
      this.#runnerPort = new D1MaintenanceRunnerPort(this.#db, () => nowIso(this.#now));
    }
    return this.#runnerPort;
  }

  async #assistant(): Promise<AssistantStatusPort> {
    if (this.#assistantPort === undefined) {
      const { D1AssistantStatusPort } = await import('../maintenance/ownerPort.js');
      this.#assistantPort = new D1AssistantStatusPort(this.#db);
    }
    return this.#assistantPort;
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
        // The one row here that is a measurement rather than an absence. It is on the
        // overview because this is the health list the owner's pages actually render —
        // `OperationsView.health` is rendered by nothing today, which is worth knowing.
        this.#moneyPathHealth(now),
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

  /** tenant-scope:exempt platform-wide owner metric across every workspace. */
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

    // tenant-scope:exempt owner exception queue; rows carry their own workspace_id.
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

  /**
   * The billing runtime for this port, assembled in one place.
   *
   * `null` when no `STRIPE_SECRET_KEY` is set, so a caller must decide what to say rather
   * than being handed a client that will throw on first use.
   */
  async #billingRuntime(): Promise<import('../billing/runtime').BillingRuntime | null> {
    const secretKey = this.#env.STRIPE_SECRET_KEY ?? '';
    if (secretKey.length === 0) return null;
    const { createBillingRuntime } = await import('../billing/index');
    const { D1BillingDataPort } = await import('./billingPort');
    const { createStripeClient } = await import('@verify/connectors/stripe');
    return createBillingRuntime(this.#env as never, {
      data: new D1BillingDataPort(this.#db),
      gateway: createStripeClient({
        secretKey,
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
      }),
      // The PORT's clock and id factory, not this builder's own. Two clocks in one
      // operation is how a money path ends up with two notions of "now" -- the auditor
      // found this builder reaching for `new Date()` while the port held an injected
      // `#now`, which also made the behaviour untestable at a fixed instant.
      now: () => this.#now.toISOString(),
      newId: (prefix: string) => newId(prefix, this.#now.getTime()),
    });
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
    // charged. So the provider call is the operation, and a failure is reported as one.
    const runtime = await this.#billingRuntime();
    if (runtime === null) {
      await this.#audit(ctx, 'owner.subscription.cancel_blocked', workspaceId);
      return writeBlocked(
        'This deployment has no STRIPE_SECRET_KEY, so the subscription cannot be cancelled at the provider. Nothing has been changed.',
      );
    }

    try {
      const { cancelSubscription } = await import('../billing/index');
      const result = await cancelSubscription(runtime, { workspaceId });
      await this.#audit(ctx, 'owner.subscription.cancelled', workspaceId);
      return writeOk(
        result.requested === 'immediately'
          ? 'The subscription is cancelled at the provider. Nothing further will be charged.'
          : 'The subscription will end at the close of the paid period. Nothing further will be charged after that.',
      );
    } catch (error) {
      await this.#audit(ctx, 'owner.subscription.cancel_failed', workspaceId);
      return writeFailed(
        `The subscription was not cancelled at the provider, so nothing has been changed. ${
          error instanceof AppError ? error.message : 'The provider did not complete the request.'
        }`,
      );
    }
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

  /**
   * The owner panel's own refund button.
   *
   * It used to read the approval, compare `status !== 'granted'`, and stop — a check with
   * no act behind it and, worse, a check-then-act shape waiting for the act to be wired in.
   * `decideRefund` (A06/A16's path) was already correct; this one was the unwired twin.
   *
   * Now the approval is **validated and spent in the same call**, through `claimApproval`,
   * which is the only way to get an `ok` out of it. The ordering is the control: consume
   * before anything could reach a provider, so a crash leaves an approval that is visibly
   * spent rather than one that still looks spendable beside money that has moved.
   *
   * The approval is now spent inside `decideRefund`, through `consumeApproval`, which calls
   * it strictly before the Stripe request. That keeps the A-20 ordering exactly where it
   * matters and consumes once rather than twice.
   *
   * And it is not spent at all when there is no provider to submit to. The previous version
   * claimed the approval first and then reported that Stripe was unconfigured, which burned
   * the owner's single-use authorisation for a refund that could never have been made.
   */
  async issueRefund(ctx: ActionContext, input: RefundRequestInput): Promise<OwnerWriteResult> {
    const approval = await this.approval(input.approvalId);
    if (approval === null) {
      return writeFailed('That approval is not usable. Grant one for this exact refund first.');
    }

    const payload: OwnerApprovalPayload = {
      action_type: 'refund_issue',
      payload: {
        workspace_id: input.workspaceId,
        order_id: input.orderId,
        amount_minor: input.amountMinor,
        currency: 'GBP',
        policy_rule: input.policyRule,
        reason: input.reason,
      },
    };

    // `policyRule` arrives as a plain string. It is checked against the published list
    // rather than cast: the rule is part of the hashed approval payload, so accepting an
    // unrecognised one would let an approval be bound to a rule nobody published.
    const { isRefundPolicyRule } = await import('../billing/index');
    if (!isRefundPolicyRule(input.policyRule)) {
      return writeFailed('That is not a published refund policy rule.', {
        policyRule: 'Choose one of the published rules.',
      });
    }
    const policyRule = input.policyRule;

    const runtime = await this.#billingRuntime();
    if (runtime === null) {
      // Nothing is claimed. Spending a single-use approval against a provider we cannot
      // reach would burn the owner's authorisation for no refund -- the previous version
      // did exactly that, then told them so.
      await this.#audit(ctx, 'owner.refund.blocked', input.orderId);
      return writeBlocked(
        'This deployment has no STRIPE_SECRET_KEY, so no refund can be submitted to the provider. The approval has NOT been spent and can still be used once this is configured.',
      );
    }

    // Stripe refunds a specific payment, never "a subscription". Until 20 September 2026
    // this method called `requestRefund` and then `decideRefund` and could never get past
    // the second: it passed no payment target, so every attempt returned
    // REFUND_TARGET_REQUIRED and left an orphan `queued_for_owner` row the owner's own
    // control could not then action. The control was dead and the suite was green over it.
    //
    // So the target is resolved FIRST, and a refusal here creates nothing.
    // THIS order's payment, not the workspace's most recent one.
    //
    // The first version of this read `subscription.latestPaymentIntentId`, and migration
    // 0007 claimed a period guard stopped it aiming at the wrong period. There was no
    // guard: the auditor refunded a July order against October's payment and Stripe was
    // called. Comparing dates would have been a heuristic, so the link is exact instead --
    // `invoice.paid` records the payment against the order it paid for.
    const order = await runtime.data.findOrder(input.workspaceId, input.orderId);
    const paymentIntentId = order?.paymentIntentId ?? null;
    if (paymentIntentId === null) {
      await this.#audit(ctx, 'owner.refund.no_target', input.orderId);
      return writeFailed(
        'No refund was submitted and no approval was spent. We have not recorded which payment paid for that order, so there is nothing to aim a refund at. The payment reference is learned when an invoice is paid.',
      );
    }

    // The approval is checked against this exact payload BEFORE anything is created.
    // Previously only the no-target refusal happened first, so a hash mismatch still left
    // a `queued_for_owner` row behind that the owner could not then action -- which is the
    // orphan-row half of the finding, and it was still true after the first fix.
    const preflight = await checkOwnerApproval(approval, payload, ctx.now);
    if (!preflight.valid) {
      await this.#audit(ctx, 'owner.refund.refused', input.orderId);
      return writeFailed(explainApprovalRejection(preflight.reason));
    }

    try {
      const { requestRefund, decideRefund } = await import('../billing/index');
      const requested = await requestRefund(runtime, {
        workspaceId: input.workspaceId,
        orderId: input.orderId,
        amountMinor: input.amountMinor,
        currency: 'GBP',
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });

      // The approval is spent INSIDE `decideRefund`, which calls this strictly before it
      // reaches Stripe -- A10's A-20 sequencing. Claiming here as well would consume one
      // approval twice. Consuming before means the worst case is a spent approval and no
      // refund, which is the direction to fail when the alternative is money out twice.
      const decided = await decideRefund(runtime, {
        workspaceId: input.workspaceId,
        refundId: requested.refund.id,
        decision: 'approve',
        approval,
        policyRule,
        paymentIntentId,
        consumeApproval: async ({ approval: granted }) => {
          const claim = await claimApproval(granted, payload, {
            store: this.#claims,
            now: ctx.now,
          });
          if (claim.ok) await this.#audit(ctx, 'owner.approval.consumed', granted.id);
          return claim.ok;
        },
      });

      await this.#audit(ctx, 'owner.refund.issued', input.orderId);
      return writeOk(
        `The refund was submitted to the payment provider and is ${decided.state}. The approval has been spent and cannot be used again.`,
      );
    } catch (error) {
      await this.#audit(ctx, 'owner.refund.failed', input.orderId);
      return writeFailed(
        `No refund was submitted. ${
          error instanceof AppError ? error.message : 'The provider did not complete the request.'
        }`,
      );
    }
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

  /** tenant-scope:exempt campaigns belong to the platform, not to a customer workspace. */
  async campaigns(): Promise<readonly CampaignView[]> {
    const result = await this.#db
      .prepare(`${CAMPAIGN_COLUMNS} ORDER BY created_at DESC LIMIT 50`)
      .all<CampaignRow>();
    const out: CampaignView[] = [];
    for (const row of result.results) out.push(await this.#campaignView(row));
    return out;
  }

  /** tenant-scope:exempt as above; a campaign has no workspace to scope it by. */
  async campaign(campaignId: string): Promise<CampaignView | null> {
    const row = await this.#db
      .prepare(`${CAMPAIGN_COLUMNS} WHERE id = ?`)
      .bind(campaignId)
      .first<CampaignRow>();
    return row === null ? null : this.#campaignView(row);
  }

  async #campaignView(row: CampaignRow): Promise<CampaignView> {
    const packet = parsePacket(row.packet_json);
    // Spend is whatever the provider last reported, summed. No rows means nobody has told
    // us anything — which is unknown, and must never render as £0.00 beside a live budget.
    const spend = await this.#db
      .prepare(
        `SELECT SUM(spend_minor) AS total, COUNT(spend_minor) AS n
           FROM campaign_metrics WHERE campaign_id = ?`,
      )
      .bind(row.id)
      .first<{ total: number | null; n: number }>();

    return {
      id: row.id,
      provider: row.provider,
      externalId: row.external_id,
      state: toCampaignState(row.state),
      headline: packet?.creative.headline ?? 'This campaign has no readable packet.',
      destinationUrl: packet?.destination.url ?? '',
      audienceSummary:
        packet?.audience.description ??
        'The approved packet for this campaign cannot be read, so there is nothing to describe.',
      budgetMinor: Number(row.budget_minor),
      currency: row.currency,
      approvalId: row.approval_id,
      approvedPayloadHash: row.approved_payload_hash,
      spendMinor: Number(spend?.n ?? 0) === 0 ? null : Number(spend?.total ?? 0),
      // Per-campaign attribution is A12's analytics and is not computed here. Null renders
      // as "unknown"; a zero here would read as "nobody came", which we do not know.
      visits: null,
      signups: null,
      lastSyncAt: row.last_sync_at,
      lastSyncError: row.last_sync_error,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }

  /**
   * Activate a campaign — the one owner action that can commit the £15 advertising
   * allocation, and therefore the one that must not be possible without a separate,
   * explicit, single-use approval.
   *
   * The order below is the control, and it is deliberate:
   *
   *  1. **Everything that can refuse without spending, refuses first.** An unknown
   *     campaign, an unreadable packet, a campaign in a state that cannot be activated, a
   *     missing or wrong-typed approval, a packet that no longer hashes to what the owner
   *     read — all of these leave the approval untouched, so it can still be used on the
   *     thing it was actually granted for.
   *  2. **Then the compare-and-set spends it.** `meta.changes === 1` is the permission. A
   *     retry, a double-tapped button or two tabs produce exactly one activation; the loser
   *     is told the approval is already used and stops.
   *  3. **Only then is the campaign stamped**, with the approval id and the hash of the
   *     packet that authorised it, guarded by its previous state so a concurrent edit
   *     cannot be overwritten silently.
   *
   * The campaign's own hash binding is A12's `packetHash`, not this module's, which is why
   * this uses the raw `consumeApproval` primitive rather than `claimApproval`: the
   * guarantee needed here is single-use, and that is exactly what the statement provides.
   */
  async activateCampaign(
    ctx: ActionContext,
    campaignId: string,
    approvalId: string,
  ): Promise<OwnerWriteResult> {
    // The stop switch, checked before anything else — including before the campaign is
    // read. Advertising is the one control with money directly behind it, and its pause was
    // enforced by nothing: an owner could press it, be told "Paused.", and still activate a
    // campaign from the next page. The approval gate above and this pause are two halves of
    // the same control over the reserved £15, and a half that does not work is not a half.
    const adsPause = await this.#pausedControl('ads');
    if (adsPause !== null) {
      await this.#audit(ctx, 'owner.campaign.activate_paused', campaignId);
      return writeFailed(adsPause);
    }

    const row = await this.#db
      .prepare(`${CAMPAIGN_COLUMNS} WHERE id = ?`)
      .bind(campaignId)
      .first<CampaignRow>();
    if (row === null) return writeFailed('There is no campaign with that id.');

    const packet = parsePacket(row.packet_json);
    if (packet === null) {
      return writeFailed(
        'This campaign’s approved packet cannot be read, so there is nothing to check an approval against. ' +
          'Nothing has been activated.',
      );
    }

    const wanted = approvalId.trim();
    if (wanted.length === 0) {
      return writeFailed(
        'An activation needs the id of the approval that authorises this exact campaign. Grant one on the ' +
          'approvals page and paste its id here. Nothing has been activated.',
        { approval_id: 'Paste the approval id.' },
      );
    }

    // The state machine is A12's, and it refuses activation from anywhere but a packet the
    // owner has been asked about. Checked BEFORE the approval is spent: an approval must
    // never be burned on a campaign that could not have been activated anyway.
    const moved = transition(
      { ...initialLifecycle(), state: toCampaignState(row.state), external_id: row.external_id },
      { type: 'owner_approved' },
    );
    if (!moved.ok) {
      return writeFailed(
        `This campaign cannot be activated from ${row.state}: ${moved.reason}. Nothing has been activated and ` +
          'the approval is untouched.',
      );
    }

    const approval = await this.approval(wanted);
    if (approval === null) {
      return writeFailed(
        'There is no approval with that id, so nothing authorises this activation.',
      );
    }
    if (approval.action_type !== 'campaign_launch') {
      return writeFailed(
        `That approval was granted for ${approval.action_type}, not for launching a campaign, so it does not ` +
          'authorise this. Nothing has been activated.',
      );
    }
    if (approval.maximum_amount_minor === null || approval.currency === null) {
      return writeFailed(
        'That approval names no spending ceiling, so it cannot authorise a campaign that can spend money.',
      );
    }

    const bound: CampaignApproval = {
      id: approval.id,
      action_type: 'campaign_launch',
      owner_id: approval.owner_id,
      canonical_payload_hash: approval.canonical_payload_hash,
      maximum_amount_minor: approval.maximum_amount_minor,
      currency: approval.currency,
      // The provider we would actually submit to. A packet naming a different platform is
      // a platform mismatch, which is A12's rejection and not a technicality.
      platform: row.provider,
      status: approval.status,
      created_at: approval.created_at,
      expires_at: approval.expires_at,
    };
    const check = await checkCampaignApproval(bound, packet, ctx.now);
    if (!check.valid) {
      await this.#audit(ctx, 'owner.campaign.activate_refused', campaignId);
      return writeFailed(
        `That approval does not authorise this campaign: ${check.detail}. Nothing has been activated and the ` +
          'approval has not been used.',
      );
    }

    const spent = await consumeApproval(this.#claims, {
      approvalId: approval.id,
      at: nowIso(ctx.now),
    });
    if (!spent) {
      await this.#audit(ctx, 'owner.campaign.activate_refused', campaignId);
      return writeFailed(
        'That approval has already been used, or it has lapsed or been withdrawn. Each approval authorises one ' +
          'activation once, so a second attempt stops here rather than happening twice. Approve the campaign ' +
          'again if you genuinely want it to run.',
      );
    }
    await this.#audit(ctx, 'owner.approval.consumed', approval.id);

    const stamped = await this.#db
      .prepare(
        `UPDATE campaigns SET state = ?, approval_id = ?, approved_payload_hash = ?, updated_at = ?
          WHERE id = ? AND state = ?`,
      )
      .bind(moved.next.state, approval.id, check.hash, nowIso(ctx.now), campaignId, row.state)
      .run();
    if (stamped.meta.changes !== 1) {
      await this.#audit(ctx, 'owner.campaign.activate_raced', campaignId);
      return writeFailed(
        'This campaign changed while the activation was being authorised, so it has not been activated. The ' +
          'approval has been spent and cannot be reused — read the campaign again and approve it again if you ' +
          'still want it to run.',
      );
    }

    await this.#audit(ctx, 'owner.campaign.activated', campaignId);
    return writeBlocked(ADS_AUTHORISED_BUT_UNSUBMITTED);
  }

  async pauseCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    await this.#audit(ctx, 'owner.campaign.pause_blocked', campaignId);
    return writeBlocked(NO_ADS);
  }

  async resumeCampaign(ctx: ActionContext, campaignId: string): Promise<OwnerWriteResult> {
    // Resuming is the other way a paused advertising switch could be walked around, so it
    // is checked here too. The refusal comes before the dependency sentence deliberately:
    // "advertising is paused" is a truer answer than "no provider is connected", and if the
    // provider were connected tomorrow this line would still be the right one.
    const adsPause = await this.#pausedControl('ads');
    if (adsPause !== null) {
      await this.#audit(ctx, 'owner.campaign.resume_paused', campaignId);
      return writeFailed(adsPause);
    }
    await this.#audit(ctx, 'owner.campaign.resume_blocked', campaignId);
    return writeBlocked(NO_ADS);
  }

  /**
   * Is this control paused right now, and what should the owner be told if so?
   *
   * Read at the moment of the action, never cached: a stop switch that acts on a value
   * read at start-up is a stop switch with a delay nobody documented. Returns `null` when
   * the control is off, so a call site reads as "if paused, refuse".
   */
  async #pausedControl(key: ControlKey): Promise<string | null> {
    const stored = await settings.getJson<ControlState | null>(
      this.#db,
      controlSettingKey(key),
      null,
    );
    if (stored === null || typeof stored !== 'object' || stored.paused !== true) return null;
    const description = CONTROL_DESCRIPTION[key];
    const since = stored.since === null ? '' : ` It has been paused since ${stored.since}.`;
    const note =
      stored.note === null || stored.note.length === 0 ? '' : ` Your note: ${stored.note}`;
    return (
      `${description.label} is paused, so this was refused and nothing has changed.${since}${note} ` +
      `Turn the switch back on in Controls if you want this to be possible again.`
    );
  }

  /* ---------------------------------------------------------------- operations */

  async operations(now: Date): Promise<OperationsView> {
    return {
      health: [
        unknownHealth('worker', 'No health probe is wired to this deployment.'),
        unknownHealth('database', 'No health probe is wired to this deployment.'),
        this.#moneyPathHealth(now),
      ],
      deployments: [],
      alerts: [],
      // A08's real runner over `runner_devices` and `maintenance_jobs`, not an in-memory
      // stand-in whose queue emptied itself at the end of every request.
      runner: await (await this.#runner()).status(),
      maintenanceJobs: await (await this.#runner()).listJobs(20),
      assistant: await (await this.#assistant()).status(),
      // Real, not a stand-in: `notification_deliveries` exists, so "is anything stuck?"
      // is a question this deployment can actually answer.
      notifications: await this.#notificationHealth(now),
    };
  }

  /**
   * Can this deployment actually take money and admit an event?
   *
   * `moneyPathReadiness` documented itself as "used by `/health` and by the owner's
   * operations view". It was used by neither — the third instance this week of correct,
   * tested code that nothing calls, and the second where the code's own comment named a
   * caller that did not exist. This is the half of that claim I own.
   *
   * It is a **configuration read, not a probe**: it says what the running Worker is able to
   * do, which is a different and more reliable fact than whether a request succeeded a
   * moment ago. So `observedAt` is stamped — this was read now — while the state is never
   * `ok` with a secret missing. An owner looking at this page after `wrangler secret put`
   * should see the change; an owner looking at it before should not see "fine".
   */
  #moneyPathHealth(now: Date): ServiceHealthView {
    const readiness = moneyPathReadiness(this.#env as never);
    if (readiness.missingSecrets.length === 0) {
      return {
        component: 'money_path',
        state: 'ok',
        detail:
          'The signed-event intake is mounted, signatures can be verified and payment is configured.',
        observedAt: nowIso(now),
      };
    }
    // Which capability is lost is the part an owner can act on; the list of names is not.
    const lost: string[] = [];
    if (!readiness.canVerifySignatures) {
      lost.push(
        'no signed event can be verified, so the intake answers 503 to every customer request',
      );
    }
    if (!readiness.canTakePayment) {
      lost.push('nobody can hold a subscription, so no workspace can be admitted');
    }
    return {
      component: 'money_path',
      // `degraded`, not `down`: the route is mounted and answers correctly — it refuses.
      state: 'degraded',
      detail:
        `The intake is mounted and answering, but ${lost.join(', and ')}. ` +
        `Missing: ${readiness.missingSecrets.join(', ')}. These are provisioned with ` +
        '`wrangler secret put` per environment and cannot be set from this panel.',
      observedAt: nowIso(now),
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
    // tenant-scope:exempt owner health metric across every workspace; each stuck row
    // carries its own workspace_id.
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
    // tenant-scope:exempt platform-wide owner metric across every workspace.
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
    const outcome = await (
      await this.#runner()
    ).enqueue({
      kind,
      requestedBy: ctx.principal.userId ?? 'owner',
      at: nowIso(ctx.now),
      idempotencyKey: `maint:${kind}:${nowIso(ctx.now).slice(0, 16)}`,
    });
    await this.#audit(ctx, 'owner.maintenance.enqueued', kind);
    if (!outcome.ok) return writeBlocked(outcome.detail);
    return writeOk(
      '/owner/operations',
      `The job is recorded as ${outcome.job.id} and will run when a runner is paired.`,
    );
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

    let payload: unknown;
    try {
      payload = JSON.parse(input.payloadJson);
    } catch {
      return writeFailed(
        'That approval payload is not readable, so there is nothing to bind an approval to.',
        { payload_json: 'This has to be valid JSON.' },
      );
    }

    // A refund approval binds a policy rule into the hash. The rule was accepted as
    // whatever string the owner pasted, so an approval could be granted for a rule nobody
    // published. It failed closed at use -- `issueRefund` now rejects an unpublished rule
    // -- but an approval that can never authorise anything is a trap, not a safeguard, and
    // the auditor was right that "no remaining path" was too strong a claim.
    if (input.actionType === 'refund_issue') {
      const rule = (payload as { policy_rule?: unknown } | null)?.policy_rule;
      const { isRefundPolicyRule } = await import('../billing/index');
      if (typeof rule !== 'string' || !isRefundPolicyRule(rule)) {
        return writeFailed('That is not a published refund policy rule.', {
          payload_json: 'policy_rule has to be one of the published rules.',
        });
      }
    }

    const id = newId(ID_PREFIX.approval, ctx.now.getTime());
    const createdAt = nowIso(ctx.now);
    const expiresAt = addSecondsIso(ctx.now, APPROVAL_LIFETIME_SECONDS);

    /*
     * The hash has to be the one the *consuming* side computes, or an approval granted here
     * can never authorise anything — which is exactly what was happening: this method
     * stored `hashToken(payloadJson)` while `claimApproval` and `checkCampaignApproval`
     * both compare against a canonical, domain-prefixed hash of the parsed payload. Two
     * hash functions for one binding is a control that always refuses, which reads to the
     * owner as a broken button and trains them to stop using it.
     *
     * So the hash is computed here by the same function the consumer uses: A12's
     * `packetHash` for a campaign, and `grantOwnerApproval` (which also enforces "an
     * approval can never authorise less than the thing it approves") for the other three.
     */
    let hash: string;
    try {
      if (input.actionType === 'campaign_launch') {
        const packet = parsePacket(input.payloadJson);
        if (packet === null) {
          return writeFailed(
            'That is not a campaign packet. A campaign approval is bound to the exact packet you read — its ' +
              'platform, budget, audience, creative, destination and dates.',
            { payload_json: 'Paste the campaign packet.' },
          );
        }
        if (input.maximumAmountMinor === null || input.maximumAmountMinor < packet.budget_minor) {
          return writeFailed(
            `The ceiling you are approving is below this campaign's budget of ${packet.budget_minor} minor units. ` +
              'An approval cannot authorise less than the thing it approves.',
            { maximum_amount: 'Approve at least the budget.' },
          );
        }
        hash = await packetHash(packet);
      } else {
        const granted = await grantOwnerApproval(
          { action_type: input.actionType, payload } as OwnerApprovalPayload,
          {
            id,
            owner_id: ctx.principal.userId,
            maximum_amount_minor: input.maximumAmountMinor,
            currency: input.maximumAmountMinor === null ? null : 'GBP',
            summary: input.summary.trim(),
            created_at: createdAt,
            expires_at: expiresAt,
          },
        );
        hash = granted.canonical_payload_hash;
      }
    } catch (error) {
      return writeFailed(
        error instanceof Error ? error.message : 'That approval could not be granted.',
      );
    }

    await this.#db
      .prepare(
        `INSERT INTO approvals (id, owner_id, action_type, canonical_payload_hash, maximum_amount_minor, currency, status, note, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?)`,
      )
      .bind(
        id,
        ctx.principal.userId,
        input.actionType,
        hash,
        input.maximumAmountMinor,
        input.maximumAmountMinor === null ? null : 'GBP',
        input.summary.trim(),
        createdAt,
        expiresAt,
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
    if (key === SETTINGS_KEY.budgetLimits) return writeFailed(BUDGET_LIMIT_NEEDS_APPROVAL);
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
      .prepare(`${QUALITY_RUN_COLUMNS} ORDER BY created_at DESC LIMIT ?`)
      .bind(Math.min(Math.max(1, limit), 50))
      .all<Record<string, unknown>>();
    return result.results.map(toQualityRun);
  }

  /**
   * Ask for a test suite to run.
   *
   * This used to return `NO_RUNNER` without asking anything — so A07's dispatch engine, its
   * allowlist, its executable-shape guard and its dedupe key were all unreachable, and the
   * panel reported "no runner" even on a deployment with a runner paired and heartbeating.
   *
   * What happens now, in order:
   *
   *  - `dispatchQualityRun` validates the suite id against the closed list (and against the
   *    second wall that rejects anything shaped like a command or a path);
   *  - it deduplicates against a **live** row for the same suite, environment and commit,
   *    so a double-tapped button is one request;
   *  - it asks the real runner whether an executor exists, and records `queued` or
   *    `awaiting_runner` accordingly, with the limitation text that says what has and has
   *    not been proved;
   *  - and only if an executor genuinely exists does a maintenance job get created, with
   *    **the suite the owner asked for**.
   *
   * Nothing here ever reports a pass. A dispatch is a request to run, and until something
   * runs it the honest answer is a dependency.
   */
  async dispatchQuality(
    ctx: ActionContext,
    suiteId: string,
  ): Promise<OwnerWriteResult & { runState: JobState | null }> {
    const environment = String(this.#env.ENVIRONMENT);
    const runner = await this.#runner();

    const availability = async (): Promise<ExecutorAvailability> => {
      const status = await runner.status();
      return {
        executor: 'local_runner',
        available: status.connected,
        reason: status.connected
          ? null
          : (status.unavailableReason ??
            'No test executor is connected to this deployment. A Cloudflare Worker cannot run a test suite itself, ' +
              'so the job waits for a runner.'),
      };
    };

    let result: Awaited<ReturnType<typeof dispatchQualityRun>>;
    try {
      result = await dispatchQualityRun(
        {
          suiteId,
          environment,
          // No commit is recorded in this deployment, and inventing one would put a
          // verdict against code nobody can identify.
          commitSha: null,
          requestedBy: ctx.principal.userId ?? 'owner',
          at: nowIso(ctx.now),
        },
        {
          findLive: (dedupeKey) => this.#liveQualityRun(dedupeKey),
          availability,
          persist: (run) => this.#persistQualityRun(run),
          newId: () => newId(ID_PREFIX.qualityRun, ctx.now.getTime()),
        },
      );
    } catch (error) {
      if (error instanceof DedupeCollision) {
        // Somebody else won the same dedupe key between our read and our write. That is one
        // request, not two, and saying so is the truth rather than a second row.
        await this.#audit(ctx, 'owner.quality.dispatch', suiteId);
        return {
          ...writeOk(
            '/owner/quality',
            'That suite is already queued for this commit, so this is the same request, not a second one.',
          ),
          runState: null,
        };
      }
      // The store is broken. The owner is told, because a dispatch that could not be
      // recorded has not happened, and a queued-looking page would be a lie.
      await this.#audit(ctx, 'owner.quality.dispatch_failed', suiteId);
      return {
        ...writeFailed(
          'The test run could not be recorded, so nothing has been dispatched and nothing has been tested. ' +
            `The database refused the write: ${errorSentence(error)}`,
        ),
        runState: null,
      };
    }

    if (!result.ok) return { ...writeFailed(result.detail), runState: null };

    await this.#audit(ctx, 'owner.quality.dispatch', result.run.id);

    if (result.deduplicated) {
      return {
        ...writeOk(
          '/owner/quality',
          'That suite is already queued for this commit, so this is the same request, not a second one.',
        ),
        runState: result.run.state,
      };
    }

    if (result.run.state === 'queued') {
      // A queued run is only queued if something was actually asked to run it. The
      // maintenance job is the real artefact; the `quality_runs` row is our record of
      // having asked.
      const queued = await this.#queueTestSuiteJob(ctx, result.run.suiteId);
      if (!queued.ok) {
        await this.#markQualityRunAwaitingRunner(result.run.id, queued.detail);
        return {
          ...writeBlocked(
            queued.detail,
            'The request is recorded, but nothing has picked it up. Nothing has been tested.',
          ),
          runState: 'awaiting_runner',
        };
      }
      return {
        ...writeOk('/owner/quality', `Queued as maintenance job ${queued.jobId}.`),
        runState: result.run.state,
      };
    }

    return {
      ...writeBlocked(
        result.run.blockedReason ?? 'No test executor is connected to this deployment.',
        'The request is saved and will run when an executor is connected. Nothing has been tested yet.',
      ),
      runState: result.run.state,
    };
  }

  /** The live run for a dedupe key, or null. Only live states deduplicate. */
  async #liveQualityRun(dedupeKey: string): Promise<QualityRun | null> {
    const row = await this.#db
      .prepare(`${QUALITY_RUN_COLUMNS} WHERE dedupe_key = ?`)
      .bind(dedupeKey)
      .first<Record<string, unknown>>();
    return row === null ? null : toQualityRun(row);
  }

  /**
   * Write the run.
   *
   * `dedupe_key` is `UNIQUE`, so two simultaneous presses race here rather than in
   * application code. The loser gets zero rows and raises {@link DedupeCollision}, which
   * the caller turns into "that is the same request" — never into a second run, and never
   * into a silent success for a row that does not exist.
   */
  async #persistQualityRun(run: QualityRun): Promise<void> {
    if (await this.#insertQualityRun(run)) return;

    /*
     * The key is taken. There are two ways that happens and they mean opposite things.
     *
     * `quality_runs.dedupe_key` is `UNIQUE` for all time, but a dedupe key is only meant to
     * collapse requests that are genuinely the same request — a double-tapped button, two
     * tabs. A run that finished last week is not the same request as one asked for now, and
     * leaving its key in place would mean each suite could be run exactly once, ever, on
     * this deployment. So a **terminal** row hands its key back (keeping its id, its
     * results and its place in the history) and the insert is retried once.
     *
     * A **live** row keeps its key, and the caller is told this is the same request.
     */
    const existing = await this.#db
      .prepare('SELECT id, state FROM quality_runs WHERE dedupe_key = ?')
      .bind(run.dedupeKey)
      .first<{ id: string; state: string }>();
    if (existing === null) throw new DedupeCollision('dedupe key already taken');
    if (!isTerminalState(existing.state as JobState)) {
      throw new DedupeCollision('a live run already holds this dedupe key');
    }

    // The retired key can never be produced by the hash function, which emits 64 hex
    // characters and nothing else, so it can never collide with a future dispatch.
    await this.#db
      .prepare('UPDATE quality_runs SET dedupe_key = ? WHERE id = ? AND dedupe_key = ?')
      .bind(`${run.dedupeKey}:${existing.id}`, existing.id, run.dedupeKey)
      .run();
    if (!(await this.#insertQualityRun(run))) {
      throw new DedupeCollision('another request took the dedupe key first');
    }
  }

  /** The insert itself. False means the unique dedupe key was already taken. */
  async #insertQualityRun(run: QualityRun): Promise<boolean> {
    const inserted = await this.#db
      .prepare(
        `INSERT INTO quality_runs (id, suite_id, environment, executor, state, commit_sha, dedupe_key,
                                   total_cases, passed, failed, skipped, started_at, ended_at,
                                   report_ref, limitations, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .bind(
        run.id,
        run.suiteId,
        run.environment,
        run.executor,
        run.state,
        run.commitSha,
        run.dedupeKey,
        run.limitations,
        run.createdAt,
      )
      .run();
    return inserted.meta.changes === 1;
  }

  /** A run nobody could pick up is `awaiting_runner`, with the reason kept beside it. */
  async #markQualityRunAwaitingRunner(runId: string, reason: string): Promise<void> {
    await this.#db
      .prepare("UPDATE quality_runs SET state = 'awaiting_runner', limitations = ? WHERE id = ?")
      .bind(`This run has not executed and nothing has been proved either way: ${reason}`, runId)
      .run();
  }

  /**
   * Create the maintenance job that actually runs the suite.
   *
   * `enqueueJob` is called directly rather than through the narrow runner port because that
   * port carries a kind and no payload, and its implementation hard-codes `suite: 'all'` —
   * so an owner who asked for the unit suite would have been queued the whole suite without
   * being told. The suite id crosses into the payload only after `dispatchQualityRun` has
   * matched it against the closed allowlist, and the runner maps a kind to its own recipe;
   * nothing here becomes part of a command.
   */
  async #queueTestSuiteJob(
    ctx: ActionContext,
    suiteId: string,
  ): Promise<{ ok: true; jobId: string } | { ok: false; detail: string }> {
    const { enqueueJob } = await import('../maintenance/jobs.js');
    const { TEST_SUITES } = await import('../maintenance/kinds.js');
    const suite = (TEST_SUITES as readonly string[]).includes(suiteId)
      ? suiteId
      : suiteId === 'full' || suiteId === 'release_report'
        ? 'all'
        : null;
    if (suite === null) {
      return {
        ok: false,
        detail:
          `A runner is connected, but its job vocabulary has no recipe for the "${suiteId}" suite, so nothing has ` +
          'been dispatched and nothing has been tested. The request is recorded.',
      };
    }
    const outcome = await enqueueJob({
      db: this.#db,
      kind: 'run_test_suite',
      payload: { suite },
      requestedBy: ctx.principal.userId ?? 'owner',
      now: nowIso(ctx.now),
      requestId: ctx.requestId,
    });
    return outcome.ok
      ? { ok: true, jobId: outcome.jobId }
      : { ok: false, detail: outcome.refusal.detail };
  }

  /* ------------------------------------------------------------------- cleanup */

  /**
   * Build the inventory, and record it.
   *
   * The engine in `owner/cleanup.ts` does the deciding — the closed category list, the
   * scope gate, the exclusions and the hash. This method supplies exactly one thing: a
   * scanner that returns what is really in this database. It returns everything it finds,
   * in scope or not, because the gate is the engine's job and an item filtered out here
   * would never appear in the "found and deliberately left out" list the owner reads.
   *
   * The preview is written to `cleanup_runs` so the run can be bound to it later. A preview
   * deletes nothing; that is what makes it a preview.
   */
  async cleanupPreview(
    ctx: ActionContext,
    categories: readonly string[],
  ): Promise<{ ok: true; inventory: CleanupInventory } | { ok: false; detail: string }> {
    const environment = String(this.#env.ENVIRONMENT);
    let result: Awaited<ReturnType<typeof previewCleanup>>;
    try {
      result = await previewCleanup(
        { categories, environment },
        { scan: (category) => this.#scanCleanup(category, environment), now: ctx.now },
      );
    } catch (error) {
      return {
        ok: false,
        detail:
          'The inventory could not be taken, so there is nothing to show and nothing has been deleted: ' +
          errorSentence(error),
      };
    }
    if (!result.ok) return { ok: false, detail: result.detail };

    const inventory = result.inventory;
    await this.#db
      .prepare(
        `INSERT INTO cleanup_runs (id, state, categories, inventory_json, inventory_hash,
                                   report_json, requested_by, created_at, completed_at)
         VALUES (?, 'preview', ?, ?, ?, NULL, ?, ?, NULL)`,
      )
      .bind(
        newId(ID_PREFIX.cleanupRun, ctx.now.getTime()),
        JSON.stringify(inventory.categories),
        JSON.stringify(inventory),
        inventory.hash,
        ctx.principal.userId ?? 'owner',
        nowIso(ctx.now),
      )
      .run();
    await this.#audit(ctx, 'owner.cleanup.preview', inventory.hash);
    return { ok: true, inventory };
  }

  /**
   * Delete what was previewed — the only owner action with no undo.
   *
   * The order is the control, and every step before the consumption leaves the world and
   * the approval untouched:
   *
   *  1. the run must name a preview this deployment actually took;
   *  2. the world must still look the way the owner read it (the hash, rebuilt now);
   *  3. an approval bound to **this exact inventory** must exist and must be spendable;
   *  4. the approval is spent — once, by compare-and-set;
   *  5. and only then does anything get deleted, one resource at a time, each one
   *     re-checked against the scope gate and re-verified immediately before removal.
   *
   * An interrupted or failing run reports `partial` or `failed` and never claims
   * completion. `claimsComplete` is the engine's field and this method does not touch it.
   */
  async cleanupExecute(
    ctx: ActionContext,
    input: { readonly inventoryHash: string; readonly quarantine: boolean },
  ): Promise<{ ok: true; report: CleanupReport } | { ok: false; detail: string }> {
    const environment = String(this.#env.ENVIRONMENT);
    const previewRow = await this.#db
      .prepare(
        `SELECT id, categories, inventory_json FROM cleanup_runs
          WHERE inventory_hash = ? AND state = 'preview' ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(input.inventoryHash)
      .first<{ id: string; categories: string; inventory_json: string }>();
    if (previewRow === null) {
      return {
        ok: false,
        detail:
          'There is no preview on record with that inventory. Nothing is deleted that has not been listed and ' +
          'read first — take a preview and read it.',
      };
    }

    const categories = parseStringArray(previewRow.categories);

    // Nothing on this deployment can quarantine a row: a quarantine that is really a
    // deletion is the worst possible outcome of a safety option, so the run refuses
    // instead, before the approval is touched.
    if (input.quarantine) {
      return {
        ok: false,
        detail:
          'Quarantine is not available on this deployment — there is nowhere to move these rows to, and moving ' +
          'nothing while reporting "quarantined" would be a lie. Nothing has been deleted. Untick quarantine to ' +
          'delete them, or leave them where they are.',
      };
    }

    const rescan = async (): Promise<CleanupInventory> => {
      const fresh = await previewCleanup(
        { categories, environment },
        { scan: (category) => this.#scanCleanup(category, environment), now: ctx.now },
      );
      if (!fresh.ok) throw new Error(fresh.detail);
      return fresh.inventory;
    };

    // Rebuilt now, and compared before anything is spent. The engine compares it again
    // inside `executeCleanup`; this first pass exists so that a world that has already
    // moved costs the owner nothing.
    let current: CleanupInventory;
    try {
      current = await rescan();
    } catch (error) {
      return {
        ok: false,
        detail:
          'The inventory could not be rebuilt, so nothing has been deleted: ' +
          errorSentence(error),
      };
    }
    if (current.hash !== input.inventoryHash) {
      return {
        ok: false,
        detail:
          'The list of things to remove is not the list you approved — something has been added or has gone away ' +
          'since you looked. Nothing has been deleted, and no approval has been used. Take a fresh preview.',
      };
    }
    if (current.items.length === 0) {
      return {
        ok: false,
        detail: 'There is nothing to remove in these categories. Nothing was deleted.',
      };
    }

    /*
     * The approval. It is found by the hash of the canonical payload rather than by an id
     * pasted into a form, which is why `idx_approvals_lookup(action_type,
     * canonical_payload_hash, status)` exists: an approval authorises this run only if it
     * was granted over exactly these categories, this inventory hash, this count and this
     * environment. A cleanup that grew by one resource hashes differently and finds nothing.
     */
    const payload: OwnerApprovalPayload = {
      action_type: 'cleanup_execute',
      payload: {
        categories: current.categories,
        inventory_hash: current.hash,
        resource_count: current.items.length,
        environment,
      },
    };
    const wantedHash = await ownerPayloadHash(payload);
    const approvalRow = await this.#db
      .prepare(
        `SELECT id FROM approvals
          WHERE action_type = 'cleanup_execute' AND canonical_payload_hash = ? AND status = 'granted'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(wantedHash)
      .first<{ id: string }>();
    if (approvalRow === null) {
      return {
        ok: false,
        detail:
          'Nothing has been deleted: no standing approval covers this exact cleanup. Deleting is the one action ' +
          'with no undo, so it needs its own approval. Grant one on the approvals page for "cleanup_execute" with ' +
          `this payload, and run it again: ${JSON.stringify(payload.payload)}`,
      };
    }
    const approval = await this.approval(approvalRow.id);
    if (approval === null) {
      return { ok: false, detail: 'That approval could not be read. Nothing has been deleted.' };
    }

    // Spend it. Before the first delete, never after — an approval consumed afterwards is
    // not single-use across a crash, and this is the action that cannot be undone.
    const claim = await claimApproval(approval, payload, { store: this.#claims, now: ctx.now });
    if (!claim.ok) {
      await this.#audit(ctx, 'owner.cleanup.refused', current.hash);
      return {
        ok: false,
        detail: `${explainApprovalRejection(claim.reason)} Nothing has been deleted.`,
      };
    }
    await this.#audit(ctx, 'owner.approval.consumed', approval.id);

    const runId = newId(ID_PREFIX.cleanupRun, ctx.now.getTime());
    let outcome: Awaited<ReturnType<typeof executeCleanup>>;
    try {
      outcome = await executeCleanup(
        {
          runId,
          approvedInventoryHash: input.inventoryHash,
          quarantineInsteadOfDelete: false,
        },
        {
          rescan,
          verify: (item) => this.#verifyCleanupItem(item),
          remove: (item) => this.#removeCleanupItem(item),
          now: () => ctx.now,
        },
      );
    } catch (error) {
      await this.#recordCleanupFailure(previewRow.id, errorSentence(error), ctx);
      return {
        ok: false,
        detail:
          'The cleanup stopped on an error and is NOT complete. The approval has been spent. What was removed ' +
          `before it stopped is on the record; what was not is still there: ${errorSentence(error)}`,
      };
    }

    if (!outcome.ok) {
      await this.#recordCleanupFailure(previewRow.id, outcome.detail, ctx);
      return { ok: false, detail: `${outcome.detail} The approval has been spent.` };
    }

    const report = outcome.report;
    await this.#db
      .prepare(`UPDATE cleanup_runs SET state = ?, report_json = ?, completed_at = ? WHERE id = ?`)
      .bind(report.state, JSON.stringify(report), nowIso(ctx.now), previewRow.id)
      .run();
    await this.#audit(ctx, 'owner.cleanup.execute', report.runId);
    return { ok: true, report };
  }

  /** A run that could not finish is recorded as failed. It is never left looking like a preview. */
  async #recordCleanupFailure(rowId: string, detail: string, ctx: ActionContext): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE cleanup_runs SET state = 'failed', report_json = ?, completed_at = ? WHERE id = ?",
      )
      .bind(JSON.stringify({ failure: detail }), nowIso(ctx.now), rowId)
      .run();
    await this.#audit(ctx, 'owner.cleanup.failed', rowId);
  }

  async lastCleanupReport(): Promise<CleanupReport | null> {
    const row = await this.#db
      .prepare(
        `SELECT report_json FROM cleanup_runs
          WHERE report_json IS NOT NULL ORDER BY completed_at DESC, id DESC LIMIT 1`,
      )
      .first<{ report_json: string }>();
    if (row === null) return null;
    try {
      const parsed: unknown = JSON.parse(row.report_json);
      if (parsed === null || typeof parsed !== 'object') return null;
      // A failure record is not a report. Rendering it as one would put a half-built
      // object through a page that expects counts.
      if (!('claimsComplete' in parsed)) return null;
      return parsed as CleanupReport;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------- cleanup scanners */

  /**
   * What is really in this database, for one category.
   *
   * Every row is returned with the facts the scope gate needs and no filtering of our own:
   * `isCustomerData` is read from the row rather than assumed, so a real customer workspace
   * found by the synthetic-workspace scan is *refused and shown as refused* rather than
   * silently dropped — which is the difference between a gate you can see working and a
   * gate you are told about.
   */
  async #scanCleanup(category: string, environment: string): Promise<readonly InventoryItem[]> {
    if (!isCleanupCategory(category)) return [];
    const now = nowIso(this.#now);
    const base = {
      category,
      environment,
      ownershipTag: OWNERSHIP_TAG,
      // Nothing here measures bytes. Null renders as "unknown"; a zero would be a guess
      // presented as a measurement.
      estimatedBytes: null,
      quarantineAvailable: false,
    } as const;

    switch (category) {
      case 'synthetic_workspaces': {
        const rows = await this.#db
          .prepare(
            "SELECT id, is_synthetic FROM workspaces WHERE status != 'deleted' ORDER BY created_at LIMIT 500",
          )
          .all<{ id: string; is_synthetic: number }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: row.id,
          kind: 'workspace',
          retentionConstraint: null,
          isCustomerData: Number(row.is_synthetic) !== 1,
        }));
      }
      case 'expired_sessions': {
        const rows = await this.#db
          .prepare('SELECT id FROM sessions WHERE expires_at <= ? ORDER BY id LIMIT 500')
          .bind(now)
          .all<{ id: string }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: row.id,
          kind: 'session',
          retentionConstraint: null,
          isCustomerData: false,
        }));
      }
      case 'consumed_login_tokens': {
        // Addressed by rowid, never by the token hash: the hash is the lookup key for a
        // sign-in link and has no business being rendered on a page or written to a report.
        const rows = await this.#db
          .prepare(
            'SELECT rowid AS rid FROM login_tokens WHERE consumed_at IS NOT NULL OR expires_at <= ? ORDER BY rowid LIMIT 500',
          )
          .bind(now)
          .all<{ rid: number }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: `login_token:${row.rid}`,
          kind: 'login_token',
          retentionConstraint: null,
          isCustomerData: false,
        }));
      }
      case 'expired_visit_sessions': {
        const rows = await this.#db
          .prepare('SELECT id FROM visit_sessions WHERE expires_at <= ? ORDER BY id LIMIT 500')
          .bind(now)
          .all<{ id: string }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: row.id,
          kind: 'visit_session',
          retentionConstraint: null,
          isCustomerData: false,
        }));
      }
      case 'dead_outbox_entries': {
        const rows = await this.#db
          .prepare(
            "SELECT id FROM outbox WHERE dispatch_state = 'dead' ORDER BY created_at LIMIT 500",
          )
          .all<{ id: string }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: row.id,
          kind: 'outbox_entry',
          retentionConstraint: null,
          isCustomerData: false,
        }));
      }
      case 'stale_quality_runs': {
        const cutoff = addSecondsIso(this.#now, -CLEANUP_STALE_QUALITY_RUN_SECONDS);
        const rows = await this.#db
          .prepare(
            `SELECT id FROM quality_runs
              WHERE state NOT IN ('queued','awaiting_runner','running') AND created_at < ?
              ORDER BY created_at LIMIT 500`,
          )
          .bind(cutoff)
          .all<{ id: string }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: row.id,
          kind: 'quality_run',
          retentionConstraint: null,
          isCustomerData: false,
        }));
      }
      case 'orphaned_preview_cleanups': {
        const cutoff = addSecondsIso(this.#now, -CLEANUP_STALE_PREVIEW_SECONDS);
        const rows = await this.#db
          .prepare(
            "SELECT id FROM cleanup_runs WHERE state = 'preview' AND created_at < ? ORDER BY created_at LIMIT 500",
          )
          .bind(cutoff)
          .all<{ id: string }>();
        return rows.results.map((row) => ({
          ...base,
          resourceId: row.id,
          kind: 'cleanup_preview',
          retentionConstraint: null,
          isCustomerData: false,
        }));
      }
      default:
        return [];
    }
  }

  /**
   * Is this still the row we inventoried, right now?
   *
   * Asked immediately before each delete, per the engine's rule 4: an id that matched ten
   * minutes ago is not proof it matches now. A row that has gone, or that no longer meets
   * the predicate that put it in the inventory, is skipped and the skip is reported.
   */
  async #verifyCleanupItem(item: InventoryItem): Promise<boolean> {
    const target = cleanupTarget(item);
    if (target === null) return false;
    const now = nowIso(this.#now);
    try {
      const row = await this.#db
        .prepare(target.existsSql)
        .bind(...target.bind(now))
        .first<{ present: number }>();
      return row !== null;
    } catch {
      return false;
    }
  }

  /** Remove exactly one inventoried row. A delete that changes no rows is a failure, not a success. */
  async #removeCleanupItem(
    item: InventoryItem,
  ): Promise<
    | { status: 'done'; reclaimedBytes: number | null }
    | { status: 'failed'; detail: string }
    | { status: 'interrupted'; detail: string }
  > {
    const target = cleanupTarget(item);
    if (target === null) {
      return { status: 'failed', detail: `No deletion is defined for a ${item.kind}.` };
    }
    const now = nowIso(this.#now);
    try {
      const result = await this.#db
        .prepare(target.deleteSql)
        .bind(...target.bind(now))
        .run();
      if (result.meta.changes !== 1) {
        return {
          status: 'failed',
          detail:
            'The row was there a moment ago and the delete removed nothing. It is still there.',
        };
      }
      return { status: 'done', reclaimedBytes: null };
    } catch (error) {
      return { status: 'failed', detail: errorSentence(error) };
    }
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

/* -------------------------------------------------------------- shared helpers */

/**
 * A thrown value turned into one sentence an owner can read.
 *
 * Never the stack, never the SQL. What the owner needs to know is that it failed and
 * roughly what failed, and what they must not be told is anything that came out of a
 * credential or a customer row.
 */
function errorSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function parseStringArray(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- quality runs */

const QUALITY_RUN_COLUMNS = `SELECT id, suite_id, environment, executor, state, commit_sha, dedupe_key,
        total_cases, passed, failed, skipped, started_at, ended_at, report_ref, limitations, created_at
   FROM quality_runs`;

function toQualityRun(row: Record<string, unknown>): QualityRun {
  return {
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
  };
}

/* -------------------------------------------------------------------- cleanup */

/**
 * Complete statements, not fragments.
 *
 * This used to return a table name and a predicate, which the caller interpolated into a
 * template literal. A security scan flagged it and was right to. The values were in fact
 * safe — every branch below returns compile-time literals and every runtime value binds
 * through a placeholder — but a bare string type promised nothing, the safety lived in reading the
 * switch and trusting it, and SQL cannot bind an identifier, so a table name can never
 * become a parameter.
 *
 * Typing the fragments as literal unions was the first attempt and it did not answer the
 * scan: the source still contained an interpolation, and a source scan reads source. This
 * does answer it. Each branch returns two finished statements, so there is no interpolation
 * anywhere and nothing to reason about at the call site.
 */
function cleanupTarget(item: InventoryItem): {
  existsSql: string;
  deleteSql: string;
  bind: (now: string) => readonly unknown[];
} | null {
  switch (item.kind) {
    case 'workspace':
      return {
        existsSql: 'SELECT 1 AS present FROM workspaces WHERE id = ? AND is_synthetic = 1',
        deleteSql: 'DELETE FROM workspaces WHERE id = ? AND is_synthetic = 1',
        bind: () => [item.resourceId],
      };
    case 'session':
      return {
        existsSql: 'SELECT 1 AS present FROM sessions WHERE id = ? AND expires_at <= ?',
        deleteSql: 'DELETE FROM sessions WHERE id = ? AND expires_at <= ?',
        bind: (now) => [item.resourceId, now],
      };
    case 'login_token': {
      const rowid = Number(item.resourceId.slice('login_token:'.length));
      if (!Number.isSafeInteger(rowid)) return null;
      return {
        existsSql:
          'SELECT 1 AS present FROM login_tokens WHERE rowid = ? AND (consumed_at IS NOT NULL OR expires_at <= ?)',
        deleteSql:
          'DELETE FROM login_tokens WHERE rowid = ? AND (consumed_at IS NOT NULL OR expires_at <= ?)',
        bind: (now) => [rowid, now],
      };
    }
    case 'visit_session':
      return {
        existsSql: 'SELECT 1 AS present FROM visit_sessions WHERE id = ? AND expires_at <= ?',
        deleteSql: 'DELETE FROM visit_sessions WHERE id = ? AND expires_at <= ?',
        bind: (now) => [item.resourceId, now],
      };
    case 'outbox_entry':
      return {
        existsSql: "SELECT 1 AS present FROM outbox WHERE id = ? AND dispatch_state = 'dead'",
        deleteSql: "DELETE FROM outbox WHERE id = ? AND dispatch_state = 'dead'",
        bind: () => [item.resourceId],
      };
    case 'quality_run':
      return {
        existsSql:
          "SELECT 1 AS present FROM quality_runs WHERE id = ? AND state NOT IN ('queued','awaiting_runner','running')",
        deleteSql:
          "DELETE FROM quality_runs WHERE id = ? AND state NOT IN ('queued','awaiting_runner','running')",
        bind: () => [item.resourceId],
      };
    case 'cleanup_preview':
      return {
        existsSql: "SELECT 1 AS present FROM cleanup_runs WHERE id = ? AND state = 'preview'",
        deleteSql: "DELETE FROM cleanup_runs WHERE id = ? AND state = 'preview'",
        bind: () => [item.resourceId],
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ campaigns */

const CAMPAIGN_COLUMNS = `SELECT id, provider, external_id, state, approved_payload_hash, approval_id,
        packet_json, budget_minor, currency, starts_at, ends_at, last_sync_at, last_sync_error,
        created_at, updated_at
   FROM campaigns`;

interface CampaignRow {
  readonly id: string;
  readonly provider: string;
  readonly external_id: string | null;
  readonly state: string;
  readonly approved_payload_hash: string | null;
  readonly approval_id: string | null;
  readonly packet_json: string;
  readonly budget_minor: number;
  readonly currency: string;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly last_sync_at: string | null;
  readonly last_sync_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * A stored packet, or null when it cannot be read.
 *
 * Null rather than a partially-built object on purpose: a packet we cannot parse is a
 * packet we cannot hash, and a campaign whose packet cannot be hashed can never be
 * activated. Guessing the missing fields would produce a hash for something nobody
 * approved.
 */
function parsePacket(json: string): CampaignPacket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Partial<CampaignPacket>;
  if (
    typeof p.platform !== 'string' ||
    !Number.isSafeInteger(p.budget_minor) ||
    typeof p.currency !== 'string' ||
    p.audience === undefined ||
    p.creative === undefined ||
    p.destination === undefined ||
    p.duration === undefined ||
    p.bidding === undefined
  ) {
    return null;
  }
  return p as CampaignPacket;
}

/** The CHECK constraint restated in the type system. An unknown state is `unknown`. */
function toCampaignState(value: string): CampaignState {
  return (CAMPAIGN_STATE as readonly string[]).includes(value)
    ? (value as CampaignState)
    : 'unknown';
}

/* -------------------------------------------------------------------------- */
/* the auth port                                                               */
/* -------------------------------------------------------------------------- */

export class D1OwnerAuth implements OwnerAuthPort {
  readonly #db: Db;
  readonly #env: Env;

  /**
   * Built lazily: most requests here never send anything.
   * `createNotificationDelivery` records an unsent notification rather than throwing when
   * `RESEND_API_KEY` or `RESEND_FROM_ADDRESS` is missing, so a deployment without a
   * transport is a supported state -- and, now, a reportable one.
   */
  #delivery: NotificationDelivery | undefined = undefined;

  readonly #fetchImpl: typeof fetch | undefined;

  constructor(input: { db: Db; env: Env; fetchImpl?: typeof fetch }) {
    this.#db = input.db;
    this.#env = input.env;
    this.#fetchImpl = input.fetchImpl;
  }

  get #notifications(): NotificationDelivery {
    this.#delivery ??= createNotificationDelivery(
      this.#env as never,
      new D1SupportDataPort(this.#db),
      this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl },
    );
    return this.#delivery;
  }

  /**
   * Accept a sign-in request and issue a token.
   *
   * The answer never varies with the ADDRESS -- not with whether it has an account, not
   * with whether it was rate limited -- because either would turn this public endpoint into
   * an account oracle. It does now report whether this DEPLOYMENT sent anything.
   *
   * This docblock used to say "when Resend is configured the mail path picks it up". No
   * mail path ever picked it up. The token was minted, stored hashed, and never emailed,
   * while `/admin/login` answered 200 and told the visitor a link was on its way -- on a
   * public, unauthenticated endpoint, on live production. The independent auditor found it
   * on 19 September 2026. It is the same failure this product exists to detect in other
   * people's systems: a success reported by the system that was supposed to do the work,
   * with no evidence behind it.
   */
  async requestSignInLink(email: string): Promise<SignInLinkOutcome> {
    const now = new Date();
    const address = email.trim().toLowerCase();
    if (address.length === 0 || !address.includes('@')) return { delivery: 'no_transport' };

    // Rate limited on a hash of the address, never the address itself.
    const decision = await consume(
      this.#db,
      `signin:${await hashToken(address, 'ratelimit')}`,
      5,
      15 * 60,
      now,
    );
    // Rate limiting is invisible to the caller on purpose: a different answer here would
    // tell an attacker their probing is working. It reports as `sent` for the same reason
    // the answer does not vary with whether the address has an account.
    if (!decision.allowed) return { delivery: 'sent' };

    const issued = await issueSignInToken(this.#db, { email: address, now });

    const base = this.#env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    // Same defect and same fix as the customer port: the request is now the shape
    // `deliver()` reads, with an event-derived key and a logger, instead of
    // `{ template, to, variables }` behind `as never`.
    const notificationKey = `sign_in_link:${await hashToken(issued.token, 'notification-key')}`;
    const expiresInMinutes = Math.max(
      1,
      Math.round((Date.parse(issued.expiresAt) - now.getTime()) / 60_000),
    );
    const report = await this.#notifications.deliver(
      [
        {
          notificationKey,
          workspaceId: null,
          recipientEmail: address,
          template: 'sign_in_link',
          vars: {
            signInUrl: `${base}/admin/login/complete?token=${encodeURIComponent(issued.token)}`,
            expiresInMinutes,
          },
        },
      ],
      (entry) => console.warn('owner_sign_in_delivery', entry),
    );

    // What actually happened, and the three outcomes are kept apart deliberately.
    //
    // The first version of this returned only `sent | no_transport`, so ANY failed send
    // rendered "this deployment has no email delivery configured" -- on production, which
    // has both RESEND_API_KEY and RESEND_FROM_ADDRESS. The auditor caught it: in removing
    // five false configuration statements I had added a sixth. A transport that exists and
    // failed is a different fact from one that was never configured, and the visitor is
    // owed the difference: one is worth retrying, the other is not.
    if (report.sent > 0) return { delivery: 'sent' };
    return { delivery: this.#hasEmailTransport() ? 'send_failed' : 'no_transport' };
  }

  /** Whether this deployment could send at all, as opposed to tried and failed. */
  #hasEmailTransport(): boolean {
    return (
      (this.#env.RESEND_API_KEY ?? '').length > 0 &&
      (this.#env.RESEND_FROM_ADDRESS ?? '').length > 0
    );
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
