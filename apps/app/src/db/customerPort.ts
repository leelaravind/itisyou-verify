/**
 * `CustomerDataPort` against D1.
 *
 * The property that makes this file safe is A05's, not mine: **no method takes a
 * workspace id.** The workspace is resolved once, from the session cookie, inside
 * `#scope()`. A page cannot ask for another tenant's data because there is no parameter
 * through which to ask. Every read below goes through a repository that takes that
 * resolved id explicitly, so the tenant predicate is in the SQL as well as in the shape.
 *
 * The second property is honesty. Three members cannot be implemented truthfully yet:
 * `beginConnection` needs A04's OAuth flow, `runProof` needs the connectors to produce
 * evidence, and `createCheckout` needs Stripe keys that do not exist in this environment.
 * Each says exactly that and exactly why, in the same register A05's synthetic port uses.
 * A plausible fake here would be worse than useless: the customer would believe a card was
 * charged, or that a connection was authorised.
 *
 * `synthetic` is false. Every page therefore drops the placeholder banner, which is only
 * correct because the reads below really are this workspace's rows.
 */
import type { AssertionResult } from '@verify/domain';
import type { CoverageMode, RunStatus, SubscriptionStatus } from '@verify/contracts';
import { LIMITS, formatMoney, money } from '@verify/contracts';
import { generateCsrfToken, maskToken, sha256Hex, stableStringify } from '@verify/security';
import { AppError } from '@verify/contracts';
import {
  CREDENTIAL_PURPOSE,
  establishConnection,
  openConnectionCredentials,
  revalidateConnection,
  type ProviderId,
} from '@verify/connectors';
import { scrubSecret, secretKeyIsUsable } from '@verify/connectors/stripe';
import type {
  ConnectionTestResult,
  TestVerificationInput,
  TestVerificationOffer,
  TestVerificationResult,
  ActivationView,
  ConnectionCredentialsInput,
  ConnectionView,
  ConnectorCompatibility,
  CustomerDataPort,
  ExpectedOutcomeInput,
  FieldMappingInput,
  OrderSummaryView,
  ProofRunView,
  ProviderKey,
  RunDetailView,
  RunListItem,
  RunPage,
  SessionView,
  SigningKeyIssuanceView,
  SigningKeyIssueResult,
  SupportRequestInput,
  SupportResult,
  UsageView,
  WorkflowDetail,
  WorkflowSummary,
  WriteResult,
} from '../routes/app/port';
import type { Env } from '../lib/context';
import { ID_PREFIX, newId } from '../lib/ids';
import { resolveSession, type ResolvedSession } from '../lib/session';
import { consume } from '../lib/ratelimit';
import { nowIso, toIso } from '../lib/time';
import { issueWorkflowSigningKey, type IssuedSigningKey } from '../money/signingKeys';
import { auditEvents } from './audit';
import { connections, credentials, type CredentialEnvelopeRow } from './connections';
import type { Db } from './d1';
import { entitlements } from './entitlements';
import { assertions, runs } from './runs';
import { sourceEvents } from './sourceEvents';
import { resolveAllowancePeriodKey, type SubscriptionPeriodSource } from '../billing/period';
import { subscriptions } from './commerce';
import { createCase } from '../support/cases';
import { hashToken } from '@verify/security';
import { D1SupportDataPort } from './supportPort';
import { workflows, workflowVersions, type WorkflowRow } from './workflows';
import {
  DEFAULT_CONFIGURED_STATE,
  composeWorkflowRules,
  parseConfiguredState,
  type ConfiguredWorkflowState,
} from './ruleCompiler';

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The wrapping key version `CREDENTIAL_KEY_V1` is. It is bound into the AAD by
 * `sealCredentialFor`, so it is authenticated rather than an editable column, and a second
 * key would arrive as `CREDENTIAL_KEY_V2` with its own number. `lib/auth.ts` says 1 for the
 * same binding; the two must not drift.
 */
const CREDENTIAL_KEY_VERSION = 1;

/**
 * The identical answer a sign-in request receives when a link went out.
 *
 * It never varies with the address -- not with whether it has an account, not with
 * whether it was rate limited -- because either would make this an account oracle.
 */
const SIGN_IN_SENT =
  'If that address has a workspace, a sign-in link is on its way. It works once and expires in fifteen minutes.';

/**
 * Said the same way on the page before the button and on the response after it.
 *
 * It names the missing secret on purpose. The person who reads this on a bare deployment is
 * the operator, and "not available" would send them reading code to find out which one.
 */
const SIGNING_KEY_UNCONFIGURED =
  'A signing key cannot be issued on this deployment: the EVENT_SIGNING_ROOT_KEY secret is not configured, so there is nothing to derive one from. Nothing was changed. This is our configuration, not something on your side.';

const ok = (redirectTo: string | null = null, message: string | null = null): WriteResult => ({
  ok: true,
  fieldErrors: {},
  message,
  redirectTo,
});

const refuse = (message: string, fieldErrors: Record<string, string> = {}): WriteResult => ({
  ok: false,
  fieldErrors,
  message,
  redirectTo: null,
});

/**
 * @deprecated **This is not an allowance period key and must never be used as one.**
 *
 * Renamed from `billingPeriodFor` so nobody reaches for it by its old, plausible name. It
 * returns a calendar month (`YYYY-MM`); allowance rows are keyed on the paid period END
 * (`YYYY-MM-DD`) by `apps/app/src/billing/period.ts`, which owns the one spelling.
 *
 * It survives for exactly one reason: `BILL-244` locks the A13-010 regression by calling it
 * and asserting it settles nothing. Nothing correct calls it. If you want a key, call
 * `resolveAllowancePeriodKey`.
 */
export function calendarMonthNotAnAllowanceKey(at: Date): string {
  return toIso(at).slice(0, 7);
}

/*
 * There is deliberately no period-key derivation in this file.
 *
 * A13-010: billing opened allowance rows keyed by the paid period END and this page read
 * them keyed by calendar month, so the two never matched and a workspace at its limit
 * reported itself unblocked. `apps/app/src/billing/period.ts` is now the one spelling;
 * anything here that wants a key asks `allowancePeriodKeyAt(at, currentPeriodEnd)` for it,
 * and when there is no subscription there is no paid period and therefore no key to guess.
 */

const PROVIDER_DETAIL: Readonly<
  Record<ProviderKey, { displayName: string; purpose: string; requirements: readonly string[] }>
> = {
  hubspot: {
    displayName: 'HubSpot',
    purpose: 'Reads the contact record your automation was supposed to create.',
    requirements: [
      'A HubSpot account you can grant read access to',
      'A contact property we can write our correlation reference into',
    ],
  },
  resend: {
    displayName: 'Resend',
    purpose: 'Reads the delivery events for the acknowledgement email.',
    requirements: ['A Resend account', 'The acknowledgement email sent through Resend'],
  },
};

/** What the customer sees when a connection is in each state. Never a raw error code. */
function connectionProblem(
  status: string,
  lastErrorCode: string | null,
): {
  problem: string | null;
  nextStep: string | null;
} {
  switch (status) {
    case 'ready':
      return { problem: null, nextStep: null };
    case 'not_connected':
      return {
        problem: 'Not connected yet.',
        nextStep: 'Connect this provider to start checking.',
      };
    case 'authorising':
    case 'testing':
      return { problem: 'Still being checked.', nextStep: 'Nothing to do, refresh in a moment.' };
    case 'expired':
      return {
        problem: 'The access we were granted has expired.',
        nextStep: 'Reconnect to grant read access again.',
      };
    case 'revoked':
      return {
        problem: 'Access was withdrawn.',
        nextStep: 'Reconnect if you still want these checks to run.',
      };
    case 'unsupported':
      return {
        problem: 'Your plan with this provider does not expose the data we need.',
        nextStep: 'Nothing you can do here: this combination is not supported.',
      };
    default:
      return {
        problem:
          lastErrorCode === null
            ? 'We could not use this connection on the last attempt.'
            : `We could not use this connection on the last attempt (${lastErrorCode}).`,
        nextStep: 'Reconnect. If it keeps happening, send us the run id.',
      };
  }
}

/**
 * The one method `resolveAllowancePeriodKey` needs, over the real subscriptions table.
 *
 * Deliberately not the whole billing port: the resolver should be able to answer "which
 * period is this instant in" without being handed everything that can move money.
 */
class BillingPortSubscriptionSource implements SubscriptionPeriodSource {
  constructor(private readonly db: Db) {}

  async findSubscriptionForWorkspace(
    workspaceId: string,
    environment: 'test' | 'live',
  ): Promise<{ readonly currentPeriodEnd: string | null } | null> {
    const row = await subscriptions.getForWorkspace(this.db, workspaceId, environment);
    return row === null ? null : { currentPeriodEnd: row.current_period_end };
  }
}

/* -------------------------------------------------------------------------- */
/* the port                                                                    */
/* -------------------------------------------------------------------------- */

/** Exactly what the port needs from the request. No Hono import, so `db/` stays framework-free. */
export interface CustomerPortInput {
  readonly db: Db;
  readonly env: Env;
  readonly request: { readonly headers: Headers; readonly url: string };
  readonly now?: Date;
  /**
   * Injected only so a test can stand in for the provider. Production leaves it undefined
   * and the connectors use the runtime's own `fetch`, which is the only path that has ever
   * been allowed to reach `api.hubapi.com` or `api.resend.com`.
   */
  readonly fetchImpl?: typeof fetch | undefined;
}


/**
 * A stored credential row as the sealed envelope the connector layer expects.
 *
 * The row carries database columns the crypto layer has no business seeing, and the AAD is
 * the field that binds a ciphertext to what it is for, so it is carried across verbatim
 * rather than rebuilt. Rebuilding it would mean a mismatch decrypts to a tag failure
 * instead of a clear refusal.
 */
function envelopeOf(row: CredentialEnvelopeRow): {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly aad: string;
  readonly key_version: number;
} {
  return {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    aad: row.aad,
    key_version: row.key_version,
  };
}

export class D1CustomerDataPort implements CustomerDataPort {
  readonly synthetic = false;

  readonly #db: Db;
  readonly #env: Env;
  readonly #request: { readonly headers: Headers; readonly url: string };
  readonly #now: Date;
  readonly #fetchImpl: typeof fetch | undefined;
  #resolved: ResolvedSession | null | undefined = undefined;

  constructor(input: CustomerPortInput) {
    this.#db = input.db;
    this.#env = input.env;
    this.#request = input.request;
    this.#now = input.now ?? new Date();
    this.#fetchImpl = input.fetchImpl;
  }

  /**
   * The workspace this request acts in, resolved from the session and memoised.
   *
   * This is the only place a workspace id enters the port. Every method below takes it
   * from here; none accepts one.
   */
  async #scope(): Promise<ResolvedSession | null> {
    if (this.#resolved === undefined) {
      this.#resolved = await resolveSession(
        this.#db,
        this.#request,
        this.#env.PUBLIC_BASE_URL,
        this.#now,
      );
    }
    return this.#resolved;
  }

  /* --- session --- */

  async session(): Promise<SessionView | null> {
    const scope = await this.#scope();
    if (scope === null) return null;
    return {
      workspaceId: scope.workspaceId,
      workspaceName: scope.workspaceName,
      email: scope.email,
      role: scope.role === 'workspace_viewer' ? 'workspace_viewer' : 'workspace_admin',
      csrfToken: generateCsrfToken(),
    };
  }

  /**
   * Magic-link sign-in.
   *
   * Not implemented here yet: issuing a link means sending an email, and the send path is
   * A09's `notifications/send.ts` with A04's Resend transport behind it. Answering "check
   * your inbox" without a transport wired up would be the exact kind of fabricated success
   * the brief forbids — the customer would sit waiting for a mail nobody sent.
   *
   * The reply is deliberately identical whether or not the address has an account.
   */
  async requestSignInLink(email: string): Promise<WriteResult> {
    const trimmed = email.trim();
    if (trimmed.length === 0 || !trimmed.includes('@')) {
      return refuse('Enter the email address you signed up with.', {
        email: 'That does not look like an email address.',
      });
    }
    const address = trimmed.toLowerCase();

    // Rate limited on a hash of the address, never the address itself. A different answer
    // when limited would tell someone probing that their probing is working.
    const { consume } = await import('../lib/ratelimit');
    const decision = await consume(
      this.#db,
      `signin:customer:${await hashToken(address, 'ratelimit')}`,
      5,
      15 * 60,
      this.#now,
    );
    if (!decision.allowed) return ok(null, SIGN_IN_SENT);

    const { issueSignInToken } = await import('../lib/auth');
    const issued = await issueSignInToken(this.#db, { email: address, now: this.#now });

    const base = this.#env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const { createNotificationDelivery } = await import('../notifications/delivery');
    // The request in the shape `deliver()` actually reads. The previous version passed
    // `{ template, to, variables }` behind an `as never` cast; `sendNotification` reads
    // `recipientEmail` and `vars`, so `recipient` was undefined, `.trim()` threw inside
    // the claim, `deliver()` swallowed it as `failed`, no row was written, no log was
    // passed, and the page told the owner "we tried and the attempt failed". Every sign-in
    // on production failed this way while minting a token each time. Found by tracing the
    // owner's own attempt: token in `login_tokens`, nothing in `notification_deliveries`,
    // nothing in the tail. The key is derived from the token's hash, never the token: the
    // key is stored in the clear and the token is a credential.
    const notificationKey = `sign_in_link:${await hashToken(issued.token, 'notification-key')}`;
    const expiresInMinutes = Math.max(
      1,
      Math.round((Date.parse(issued.expiresAt) - this.#now.getTime()) / 60_000),
    );
    const report = await createNotificationDelivery(
      this.#env as never,
      new D1SupportDataPort(this.#db),
      this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl },
    ).deliver(
      [
        {
          notificationKey,
          workspaceId: null,
          recipientEmail: address,
          template: 'sign_in_link',
          vars: {
            signInUrl: `${base}/app/sign-in/complete?token=${encodeURIComponent(issued.token)}`,
            expiresInMinutes,
          },
        },
      ],
      // A refusal here must have somewhere to go. Keys and statuses only; never a body.
      (entry) => console.warn('sign_in_delivery', entry),
    );

    if (report.sent > 0) return ok(null, SIGN_IN_SENT);

    // The two failures are kept apart for the same reason the owner path keeps them
    // apart: "we are not set up to email you" and "we tried and it did not go" are
    // different facts, and only one is worth retrying. This method used to return the
    // first unconditionally -- including on production, which has both Resend secrets --
    // which made it a false statement about the deployment rather than about the address.
    const configured =
      (this.#env.RESEND_API_KEY ?? '').length > 0 &&
      (this.#env.RESEND_FROM_ADDRESS ?? '').length > 0;
    return refuse(
      configured
        ? 'No sign-in link was sent. We tried and the attempt failed, so nothing arrived. Please try again in a moment.'
        : 'No sign-in link was sent. This deployment has no email delivery configured, so nothing would arrive and we will not pretend otherwise.',
    );
  }

  async signOut(): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return ok('/app/sign-in');
    const { sessions } = await import('./sessions');
    await sessions.revoke(this.#db, scope.sessionId, nowIso(this.#now));
    this.#resolved = null;
    return ok('/app/sign-in', 'You are signed out on this device.');
  }

  /* --- onboarding --- */

  async connectorCompatibility(): Promise<readonly ConnectorCompatibility[]> {
    return (['hubspot', 'resend'] as const).map((provider) => ({
      provider,
      displayName: PROVIDER_DETAIL[provider].displayName,
      purpose: PROVIDER_DETAIL[provider].purpose,
      requirements: PROVIDER_DETAIL[provider].requirements,
      supported: true,
      unsupportedReason: null,
    }));
  }

  /**
   * Re-check one stored connection against the provider, on request.
   *
   * ## What this does and does not establish
   *
   * It makes the narrowest live read the connector offers and reports the answer. It says
   * nothing about whether a webhook has ever arrived, and nothing at all about whether the
   * customer's automation reports enquiries to us. Those are returned as separate fields
   * rather than folded into one verdict, because "connected" meaning three different things
   * is how a customer ends up believing a workflow is monitored when nothing is reaching us.
   *
   * ## Credentials survive an outage
   *
   * When the provider cannot be reached, `revalidateConnection` returns the status the
   * connection already had, and this method writes that back unchanged along with the error
   * code and the check time. A provider being down is our problem or theirs; it is never
   * evidence that the customer's key is bad, and making them re-paste a working key because
   * HubSpot had a bad minute would be the product punishing them for somebody else's outage.
   *
   * This paragraph used to claim the outage path answered `degraded`, and only the *thrown*
   * one did. A classified `PROVIDER_UNAVAILABLE` went through `statusForError` to
   * `not_connected`, which is the state meaning "you have never connected this", so the page
   * offered "Connect this provider to start checking" directly beneath its own promise that
   * a key would never have to be pasted again. Worse, `not_connected` is outside the
   * scheduler's `USABLE_STATUSES`, so a bad minute at Resend took the connection out of
   * service for real runs. Met on production on 22 September; held now by CONN-905.
   *
   * ## Rate limited, per workspace and provider
   *
   * Each press is an outbound call to somebody else's API on our account. Six per five
   * minutes is enough to work through a broken setup and not enough to be a way of hammering
   * a provider through us.
   */
  async testConnection(provider: ProviderKey): Promise<ConnectionTestResult> {
    const providerId: ProviderId = provider === 'resend' ? 'resend' : 'hubspot';
    const displayName = PROVIDER_DETAIL[providerId].displayName;
    const blocked = (reason: string): ConnectionTestResult => ({
      provider,
      displayName,
      apiAccess: 'not_checked',
      webhookReadiness: providerId === 'resend' ? 'never_received' : 'not_applicable',
      workflowVerification: 'not_checked',
      status: 'not_connected',
      checkedAt: nowIso(this.#now),
      summary: reason,
      nextStep: null,
      credentialsPreserved: true,
      blockedReason: reason,
    });

    const scope = await this.#scope();
    if (scope === null) return blocked('Sign in to test a connection.');
    if (scope.role !== 'workspace_admin') {
      return blocked(
        `Only a workspace admin can test a connection. Your role in this workspace is viewer, so nothing was sent to ${displayName}.`,
      );
    }

    const row = await connections.getByProvider(this.#db, scope.workspaceId, providerId);
    if (row === null || row.revoked_at !== null) {
      return blocked(
        `There is no ${displayName} connection to test yet. Connect one first and this becomes useful.`,
      );
    }

    const keyBase64 = this.#env.CREDENTIAL_KEY_V1;
    if (keyBase64 === undefined || keyBase64.length === 0) {
      return blocked(
        `This deployment has no CREDENTIAL_KEY_V1 secret, so the stored credential cannot be opened to test it. That is our configuration, not something on your side. Nothing was sent to ${displayName}.`,
      );
    }

    const decision = await consume(
      this.#db,
      `connection-test:${scope.workspaceId}:${providerId}`,
      6,
      300,
      this.#now,
    );
    if (!decision.allowed) {
      return blocked(
        `That is a lot of checks in a short time. Wait a moment and try again; nothing was sent to ${displayName}.`,
      );
    }

    const apiEnvelope = await credentials.activeForScope(
      this.#db,
      scope.workspaceId,
      row.id,
      CREDENTIAL_PURPOSE.API_TOKEN,
    );
    if (apiEnvelope === null) {
      return blocked(
        `This ${displayName} connection has no stored credential to test with. Paste the key again and it becomes testable.`,
      );
    }
    const secretEnvelope =
      providerId === 'resend'
        ? await credentials.activeForScope(
            this.#db,
            scope.workspaceId,
            row.id,
            CREDENTIAL_PURPOSE.WEBHOOK_SECRET,
          )
        : null;

    const opened = await openConnectionCredentials(
      {
        apiToken: envelopeOf(apiEnvelope),
        ...(secretEnvelope === null ? {} : { webhookSecret: envelopeOf(secretEnvelope) }),
      },
      { workspaceId: scope.workspaceId, provider: providerId },
      { keyBase64 },
    );

    // Webhook readiness is a stored fact about what has ARRIVED, never inferred from the
    // API answering. HubSpot is polled, so it has no webhook to be ready.
    //
    // This is read BEFORE the provider call because the connector needs it as well. A
    // webhook that has already been proven stays proven, exactly as it does when a
    // credential is re-pasted. Without carrying it in, Resend cannot see that a signed
    // callback ever arrived, reports the connection unfinished, and the status write below
    // pushes a `ready` connection back to `testing` -- moving a customer's connection
    // backwards because they pressed the button that only asks how it is doing. Worse, the
    // route that promotes on a signed callback fires only while `webhook_verified_at` is
    // null, so no later delivery would climb it back out.
    const webhook = await this.#db
      .prepare(`SELECT webhook_verified_at FROM connections WHERE workspace_id = ? AND id = ?`)
      .bind(scope.workspaceId, row.id)
      .first<{ webhook_verified_at: string | null }>();

    const result = await revalidateConnection({
      provider: providerId,
      credentials: opened,
      connection: {
        provider: providerId,
        account_id: row.external_account_id,
        // Resolve identity live rather than trusting the stored value: a token quietly
        // swapped for one pointing at a different account is exactly what this check is
        // for, and trusting the stored id would hide it.
        reverify_account: true,
        ...(webhook?.webhook_verified_at == null
          ? {}
          : { webhook_verified_at: webhook.webhook_verified_at }),
      },
      // So an unreachable provider returns the health we already had rather than inventing
      // a worse one we did not measure.
      currentStatus: row.status,
      now: this.#now,
      ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
    });

    await connections.setStatus(this.#db, scope.workspaceId, row.id, {
      status: result.status,
      lastCheckAt: result.checkedAt,
      lastErrorCode: result.lastErrorCode,
    });

    await auditEvents.record(this.#db, {
      id: newId(ID_PREFIX.auditEvent, this.#now.getTime()),
      actor: scope.userId,
      actorKind: 'user',
      workspaceId: scope.workspaceId,
      action: 'connection.tested',
      target: row.id,
      occurredAt: nowIso(this.#now),
      // The classification and the cost, never a credential and never a token value.
      redactedMetadata: JSON.stringify({
        provider: providerId,
        status: result.status,
        error_code: result.lastErrorCode,
        account_changed: result.accountChanged,
        calls_made: result.callsMade,
      }),
    });

    return {
      provider,
      displayName,
      apiAccess: result.lastErrorCode === null ? 'ok' : 'failed',
      webhookReadiness:
        providerId !== 'resend'
          ? 'not_applicable'
          : webhook?.webhook_verified_at != null
            ? 'received'
            : 'never_received',
      workflowVerification: 'not_checked',
      status: result.status,
      checkedAt: result.checkedAt,
      summary: result.summary,
      nextStep: result.setupSteps[0]?.detail ?? null,
      // Nothing in this method deletes or retires a credential, and the outage path is
      // called out so the page can say so where it matters most.
      credentialsPreserved: true,
      blockedReason: null,
    };
  }

  async connections(): Promise<readonly ConnectionView[]> {
    const scope = await this.#scope();
    if (scope === null) return [];
    const rows = await connections.list(this.#db, scope.workspaceId);
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const base = this.#env.PUBLIC_BASE_URL.replace(/\/+$/, '');

    return (['hubspot', 'resend'] as const).map((provider) => {
      const row = byProvider.get(provider);
      const status = row?.status ?? 'not_connected';
      const { problem, nextStep } = connectionProblem(status, row?.last_error_code ?? null);
      return {
        provider,
        displayName: PROVIDER_DETAIL[provider].displayName,
        status,
        // Generated fresh from the stored account id — never a stored credential, and
        // never a mask we persisted (rule 7).
        accountLabel:
          row?.external_account_id === undefined || row.external_account_id === null
            ? null
            : maskToken(row.external_account_id),
        lastCheckedAt: row?.last_check_at ?? null,
        problem,
        nextStep,
        webhookUrl:
          provider === 'resend' && typeof row?.webhook_path_id === 'string'
            ? `${base}/api/v1/webhooks/resend/${row.webhook_path_id}`
            : null,
      };
    });
  }

  /**
   * Not implementable honestly yet: starting an authorisation means redirecting to the
   * provider's consent screen with a client id and a registered callback, and neither
   * exists in this environment. Saying "connected" or recording `authorising` would
   * describe a conversation that never happened.
   */
  async beginConnection(provider: ProviderKey): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to connect a provider.');
    return refuse(
      `No authorisation was started and nothing about your ${PROVIDER_DETAIL[provider].displayName} account has changed. The ${PROVIDER_DETAIL[provider].displayName} app credentials are not configured in this environment, so there is nowhere to send you yet.`,
    );
  }

  /**
   * Validate a pasted provider credential against the provider, then store it sealed.
   *
   * This is the method whose absence made the route take its fallback branch — "this
   * workspace has no way to validate a credential against the provider yet" — which was
   * true and therefore correct, and also meant no customer could connect anything and no
   * `provider_readback` evidence could ever exist. The fallback stays exactly where it is,
   * for any port that still cannot do this. This one can.
   *
   * The order is fixed, and every step can only refuse, never soften:
   *
   *   1. **Role.** Only a workspace admin may hand us a credential. A viewer is refused
   *      before anything is sent anywhere, so a read-only member cannot spend a call
   *      against the customer's rate limit either.
   *   2. **A place to put it.** With no `CREDENTIAL_KEY_V1` there is nothing to seal with,
   *      and a credential we cannot seal is one we must not accept. Refused before the
   *      provider is contacted, because asking would be pointless and not free.
   *   3. **Ask the provider.** `establishConnection` does the narrowest read that proves
   *      the credential works and says whose account it is — HubSpot's
   *      `access-token-info`, Resend's `GET /domains` — and returns sealed envelopes *only*
   *      on success. An expired token, a missing scope and an unreachable provider come
   *      back as three different sentences, because they are three different problems.
   *   4. **Store, atomically.** Connection row and ciphertext in one batch, with
   *      `last_check_at` set from the provider's answer, so the page reads the state back
   *      out of the database rather than trusting the submission that produced it.
   *
   * Nothing here returns, logs or audits the credential. The audit row records that a
   * credential was submitted, for which provider, by whom, and how it went.
   */
  async submitConnectionCredentials(input: ConnectionCredentialsInput): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to connect a provider.');

    const provider: ProviderId = input.provider === 'resend' ? 'resend' : 'hubspot';
    const displayName = PROVIDER_DETAIL[provider].displayName;

    if (scope.role !== 'workspace_admin') {
      return refuse(
        `Only a workspace admin can connect a provider. Nothing was sent to ${displayName} and nothing was stored.`,
      );
    }

    const keyBase64 = this.#env.CREDENTIAL_KEY_V1;
    if (keyBase64 === undefined || keyBase64.length === 0) {
      return refuse(
        `Nothing was sent to ${displayName} and nothing was stored. This deployment has no CREDENTIAL_KEY_V1 secret, so there is nothing to encrypt a credential with, and we will not hold one any other way. This is our configuration, not something on your side.`,
      );
    }

    // A webhook that has already been proven stays proven. Without carrying this in, a
    // customer who re-pastes their API key -- to rotate it, or after being told the old one
    // leaked -- would silently drop a `ready` Resend connection back to `testing`, and
    // would then have to arrange a fresh signed delivery to climb back out.
    const priorWebhookVerifiedAt = await this.#db
      .prepare(
        `SELECT webhook_verified_at FROM connections WHERE workspace_id = ? AND provider = ?`,
      )
      .bind(scope.workspaceId, provider)
      .first<{ webhook_verified_at: string | null }>();

    const established = await establishConnection({
      provider,
      workspaceId: scope.workspaceId,
      accessToken: input.accessToken,
      ...(priorWebhookVerifiedAt?.webhook_verified_at == null
        ? {}
        : { webhookVerifiedAt: priorWebhookVerifiedAt.webhook_verified_at }),
      ...(input.webhookSecret === undefined ? {} : { webhookSecret: input.webhookSecret }),
      wrappingKey: { keyBase64, keyVersion: CREDENTIAL_KEY_VERSION },
      now: this.#now,
      ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
    });

    const at = nowIso(this.#now);

    // `credentials` is empty on every refusal path in `establishConnection` — there is no
    // branch there that seals an unvalidated token. Both conditions are checked anyway:
    // this is the last point at which an unusable credential could reach the database.
    if (!established.ok || established.credentials.length === 0) {
      await auditEvents.record(this.#db, {
        id: newId(ID_PREFIX.auditEvent, this.#now.getTime()),
        actor: scope.userId,
        actorKind: 'user',
        workspaceId: scope.workspaceId,
        action: 'connection.credential_rejected',
        target: provider,
        occurredAt: at,
        // The provider's classification, never the value that was rejected.
        redactedMetadata: JSON.stringify({
          provider,
          error_code: established.connection.lastErrorCode,
          calls_made: established.callsMade,
        }),
      });
      return {
        ok: false,
        fieldErrors: { ...established.fieldErrors },
        message: established.message,
        redirectTo: null,
      };
    }

    const connectionId = await connections.establish(this.#db, {
      newConnectionId: newId(ID_PREFIX.connection, this.#now.getTime()),
      workspaceId: scope.workspaceId,
      provider,
      status: established.connection.status,
      externalAccountId: established.connection.externalAccountId,
      scopes: established.connection.scopes,
      lastCheckAt: established.connection.lastCheckAt,
      credentials: established.credentials.map((sealed) => ({
        id: newId(ID_PREFIX.credential, this.#now.getTime()),
        purpose: sealed.purpose,
        keyVersion: sealed.envelope.key_version,
        ciphertext: sealed.envelope.ciphertext,
        nonce: sealed.envelope.nonce,
        aad: sealed.envelope.aad,
      })),
    });

    await auditEvents.record(this.#db, {
      id: newId(ID_PREFIX.auditEvent, this.#now.getTime()),
      actor: scope.userId,
      actorKind: 'user',
      workspaceId: scope.workspaceId,
      action: 'connection.credential_submitted',
      target: connectionId,
      occurredAt: at,
      // Which provider, which account, what we now claim — and nothing that could be used
      // as a credential. The purposes are stored as names, not as values.
      redactedMetadata: JSON.stringify({
        provider,
        status: established.connection.status,
        external_account_id: established.connection.externalAccountId,
        purposes: established.credentials.map((sealed) => sealed.purpose),
      }),
    });

    return {
      ok: true,
      fieldErrors: {},
      message: established.message,
      redirectTo: null,
    };
  }

  async workflows(): Promise<readonly WorkflowSummary[]> {
    const scope = await this.#scope();
    if (scope === null) return [];
    const page = await workflows.list(this.#db, scope.workspaceId, { limit: 20 });
    const summaries: WorkflowSummary[] = [];
    for (const row of page.items) {
      summaries.push(await this.#summarise(scope.workspaceId, row));
    }
    return summaries;
  }

  async #summarise(
    workspaceId: string,
    row: {
      id: string;
      name: string;
      coverage_mode: CoverageMode;
      status: string;
      last_event_at: string | null;
      current_version_id: string | null;
    },
  ): Promise<WorkflowSummary> {
    const counts = await runs.countByStatus(this.#db, workspaceId, '1970-01-01T00:00:00.000Z');
    const version =
      row.current_version_id === null
        ? null
        : await workflowVersions.get(this.#db, workspaceId, row.current_version_id);
    return {
      id: row.id,
      name: row.name,
      coverageMode: row.coverage_mode,
      deadlineSeconds: version?.deadline_seconds ?? LIMITS.DEFAULT_DEADLINE_SECONDS,
      active: row.status === 'active',
      lastEventAt: row.last_event_at,
      counts: {
        verified: counts['VERIFIED'] ?? 0,
        failed: counts['FAILED'] ?? 0,
        unverified: counts['UNVERIFIED'] ?? 0,
        pending: counts['PENDING'] ?? 0,
      },
    };
  }

  async workflow(): Promise<WorkflowDetail | null> {
    const scope = await this.#scope();
    if (scope === null) return null;
    const page = await workflows.list(this.#db, scope.workspaceId, { limit: 1 });
    const row = page.items[0];
    if (row === undefined) return null;

    const summary = await this.#summarise(scope.workspaceId, row);
    const version =
      row.current_version_id === null
        ? null
        : await workflowVersions.get(this.#db, scope.workspaceId, row.current_version_id);

    let correlationProperty = '';
    let requireRecordExists = false;
    let requireCorrelationMatch = false;
    let requireEmailDelivered = false;
    let requireRecipientMatch = false;
    if (version !== null) {
      try {
        const rules = JSON.parse(version.rules_json) as {
          crm_correlation_property?: string;
          assertions?: { source?: string; field?: string; operator?: string }[];
        };
        correlationProperty = rules.crm_correlation_property ?? '';
        for (const spec of rules.assertions ?? []) {
          if (spec.field === 'record.id' && spec.operator === 'exists') requireRecordExists = true;
          if (spec.field === 'record.correlation_id') requireCorrelationMatch = true;
          if (spec.field === 'message.status') requireEmailDelivered = true;
          if (spec.field === 'message.recipient') requireRecipientMatch = true;
        }
      } catch {
        // A rules blob we cannot parse is a configuration problem, not a page crash. The
        // customer sees empty toggles rather than a 500, and the values are re-derivable.
      }
    }

    return {
      ...summary,
      mapping: {
        correlationProperty,
        // Empty until a CRM connection can actually list properties. An invented list
        // would make the customer choose a property that does not exist.
        availableProperties: [],
      },
      outcome: {
        deadlineSeconds: summary.deadlineSeconds,
        requireRecordExists,
        requireCorrelationMatch,
        requireEmailDelivered,
        requireRecipientMatch,
        coverageMode: summary.coverageMode,
      },
      signingKeyHint: row.signing_key_hash === null ? null : maskToken(row.signing_key_hash),
    };
  }

  /**
   * The workflow this workspace configures.
   *
   * Exactly one per workspace today, the same assumption `workflow()` and `activation()`
   * already make ("first row is canonical"). Created here, lazily, on first configuration —
   * nothing in onboarding creates one earlier, because nothing asked for one to exist before
   * there was something to configure.
   */
  async #workflowForConfiguration(scope: ResolvedSession): Promise<WorkflowRow> {
    const existing = (await workflows.list(this.#db, scope.workspaceId, { limit: 1 })).items[0];
    if (existing !== undefined) return existing;
    const id = newId(ID_PREFIX.workflow, this.#now.getTime());
    await workflows.create(this.#db, {
      id,
      workspaceId: scope.workspaceId,
      name: 'Verification workflow',
      coverageMode: 'customer_triggered',
      createdAt: nowIso(this.#now),
    });
    const created = await workflows.get(this.#db, scope.workspaceId, id);
    if (created === null) {
      throw new Error(
        'workflowForConfiguration: created workflow vanished before it could be read',
      );
    }
    return created;
  }

  /** What this workflow is already configured to check, read back through the schema. */
  async #currentConfiguredState(
    scope: ResolvedSession,
    workflow: WorkflowRow,
  ): Promise<ConfiguredWorkflowState> {
    if (workflow.current_version_id === null) return DEFAULT_CONFIGURED_STATE;
    const version = await workflowVersions.get(
      this.#db,
      scope.workspaceId,
      workflow.current_version_id,
    );
    return parseConfiguredState(version?.rules_json ?? null);
  }

  /**
   * Both rule edits publish a new immutable workflow version rather than mutating one, so a
   * report from last week still shows the rules that actually decided it (constraint 1).
   * `composeWorkflowRules` (`ruleCompiler.ts`) is the only path to a `WorkflowRules` document
   * — a state that does not parse against `workflowRulesSchema` writes nothing at all
   * (constraint 2), and this is the one place both save methods reach that decision.
   */
  async #publishRules(
    scope: ResolvedSession,
    workflow: WorkflowRow,
    state: ConfiguredWorkflowState,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly path: readonly (string | number)[]; readonly message: string }
  > {
    const composed = composeWorkflowRules(state);
    if (!composed.ok) {
      return { ok: false, path: composed.failure.path, message: composed.failure.message };
    }

    const at = nowIso(this.#now);
    const rulesJson = JSON.stringify(composed.rules);
    const rulesHash = await sha256Hex(
      `verify.workflow_rules.v1:${stableStringify(composed.rules)}`,
    );
    await workflowVersions.publish(this.#db, {
      id: newId(ID_PREFIX.workflowVersion, this.#now.getTime()),
      workspaceId: scope.workspaceId,
      workflowId: workflow.id,
      rulesJson,
      rulesHash,
      deadlineSeconds: composed.rules.deadline_seconds,
      schemaVersion: composed.rules.schema_version,
      createdBy: scope.userId,
      createdAt: at,
    });
    // The hash and nothing else: the full rules document is already in `rules_json` on the
    // version row itself, and an audit trail is read by more people than that row is.
    await auditEvents.record(this.#db, {
      id: newId(ID_PREFIX.auditEvent, this.#now.getTime()),
      actor: scope.userId,
      actorKind: 'user',
      workspaceId: scope.workspaceId,
      action: 'workflow.rules_published',
      target: workflow.id,
      occurredAt: at,
      redactedMetadata: JSON.stringify({ rules_hash: rulesHash }),
    });
    return { ok: true };
  }

  /** `composeWorkflowRules`'s schema path, translated into this form's own field names. */
  #mappingFieldErrors(path: readonly (string | number)[]): Record<string, string> {
    return path[0] === 'crm_correlation_property'
      ? { correlationProperty: 'Use letters, numbers and underscores only.' }
      : {};
  }

  /** As above, for the expected-outcome form. */
  #outcomeFieldErrors(path: readonly (string | number)[]): Record<string, string> {
    if (path[0] === 'deadline_seconds') {
      return {
        deadlineSeconds: `Choose between ${LIMITS.MIN_DEADLINE_SECONDS} and ${LIMITS.MAX_DEADLINE_SECONDS} seconds.`,
      };
    }
    return {};
  }

  async saveFieldMapping(input: FieldMappingInput): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to change this workflow.');
    if (scope.role !== 'workspace_admin') {
      return refuse('Only a workspace admin can change the field mapping.');
    }
    if (!/^[A-Za-z0-9_]{1,128}$/.test(input.correlationProperty)) {
      return refuse('That property name is not valid.', {
        correlationProperty: 'Use letters, numbers and underscores only.',
      });
    }

    const workflow = await this.#workflowForConfiguration(scope);
    const current = await this.#currentConfiguredState(scope, workflow);
    const next: ConfiguredWorkflowState = {
      ...current,
      correlationProperty: input.correlationProperty,
    };
    const published = await this.#publishRules(scope, workflow, next);
    if (!published.ok) {
      return refuse(published.message, this.#mappingFieldErrors(published.path));
    }
    return ok('/app/onboarding/outcome', 'The field mapping was saved.');
  }

  async saveExpectedOutcome(input: ExpectedOutcomeInput): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to change this workflow.');
    if (scope.role !== 'workspace_admin') {
      return refuse('Only a workspace admin can change the expected outcome.');
    }
    if (
      !Number.isInteger(input.deadlineSeconds) ||
      input.deadlineSeconds < LIMITS.MIN_DEADLINE_SECONDS ||
      input.deadlineSeconds > LIMITS.MAX_DEADLINE_SECONDS
    ) {
      return refuse('That completion window is outside the supported range.', {
        deadlineSeconds: `Choose between ${LIMITS.MIN_DEADLINE_SECONDS} and ${LIMITS.MAX_DEADLINE_SECONDS} seconds.`,
      });
    }
    if (
      !input.requireRecordExists &&
      !input.requireCorrelationMatch &&
      !input.requireEmailDelivered &&
      !input.requireRecipientMatch
    ) {
      return refuse('At least one check has to be required, or VERIFIED would mean nothing.', {
        requireRecordExists: 'Select at least one check.',
      });
    }

    const workflow = await this.#workflowForConfiguration(scope);
    const current = await this.#currentConfiguredState(scope, workflow);
    if (current.correlationProperty === '') {
      return refuse(
        'Map your CRM reference field before setting the expected outcome: there is nothing to check against yet.',
      );
    }
    const next: ConfiguredWorkflowState = {
      ...current,
      deadlineSeconds: input.deadlineSeconds,
      coverageMode: input.coverageMode,
      requireRecordExists: input.requireRecordExists,
      requireCorrelationMatch: input.requireCorrelationMatch,
      requireEmailDelivered: input.requireEmailDelivered,
      requireRecipientMatch: input.requireRecipientMatch,
    };
    const published = await this.#publishRules(scope, workflow, next);
    if (!published.ok) {
      return refuse(published.message, this.#outcomeFieldErrors(published.path));
    }
    return ok('/app/onboarding/proof', 'The expected outcome was saved.');
  }

  /**
   * The proof run evaluates real rules against invented evidence. It needs the evaluator
   * AND a compiled rule set; without the compiler it would be evaluating nothing, and a
   * green tick from an empty rule set is the most dangerous output this product could
   * produce.
   */
  async runProof(): Promise<ProofRunView> {
    const scope = await this.#scope();
    return {
      ran: false,
      status: null,
      statusReason: null,
      results: [],
      blockedReason:
        scope === null
          ? 'Sign in to run a proof.'
          : 'No proof run was performed. The rule compiler is not wired into this environment, so there are no rules to evaluate, and a pass against no rules would mean nothing.',
    };
  }


  /* --- guided test verification --- */

  /**
   * What a test verification would cost, and whether one can be started at all.
   *
   * Asked before the customer commits, for the same reason the billing portal's
   * availability is separate from opening it: a page that has to DO the thing to find out
   * whether it can would spend a run from the allowance just to decide whether to draw a
   * form.
   */
  async testVerificationOffer(): Promise<TestVerificationOffer> {
    const usage = await this.usage();
    const remaining = Math.max(0, usage.runsIncluded - usage.runsUsed);
    const base = {
      // Always true, and a field rather than a sentence in the template so the page cannot
      // quietly stop saying it. It costs one run because it is admitted through the same
      // path a real enquiry takes; a free side-door would be a different code path, and a
      // result from a different path proves nothing about the one that matters.
      consumesAllowance: true,
      runsRemaining: remaining,
      runsIncluded: usage.runsIncluded,
    };

    const scope = await this.#scope();
    if (scope === null) {
      return { ...base, canStart: false, reason: 'Sign in to run a test verification.', correlationProperty: '' };
    }
    if (scope.role !== 'workspace_admin') {
      return {
        ...base,
        canStart: false,
        reason:
          'Only a workspace admin can run a test verification. Your role in this workspace is viewer.',
        correlationProperty: '',
      };
    }

    const workflow = await this.workflow();
    if (workflow === null) {
      return {
        ...base,
        canStart: false,
        reason:
          'There is no workflow to test yet. A test verification is checked against your rules, and there are none to check it against.',
        correlationProperty: '',
      };
    }
    const correlationProperty = workflow.mapping.correlationProperty;
    if (correlationProperty === '') {
      return {
        ...base,
        canStart: false,
        reason:
          'This workflow has no correlation property set, so nothing could be matched back to the record you name. Finish the field mapping first.',
        correlationProperty: '',
      };
    }
    if (remaining <= 0) {
      return {
        ...base,
        canStart: false,
        reason:
          'This period has no runs left, and a test verification costs one like any other. It becomes available again when the period rolls over.',
        correlationProperty,
      };
    }
    return { ...base, canStart: true, reason: null, correlationProperty };
  }

  /**
   * Start one, from four values the customer supplies.
   *
   * ## It is the real pipeline, not a rehearsal of it
   *
   * The four fields are exactly the four the real source-event schema carries, so this
   * writes a genuine source event and admits it through `sourceEvents.admitOnce` — the same
   * function the signed-event endpoint calls. The scheduler then observes it, reads the
   * providers, and the same evaluator decides it. Nothing here shortcuts to a verdict.
   *
   * ## What it must never do
   *
   * It creates no CRM record and sends no email: every field names something that must
   * ALREADY EXIST, and the connectors have no write path at all. It fabricates no result —
   * the run starts PENDING and is decided by evidence, which means a test can and should
   * come back FAILED or UNVERIFIED. And it proves nothing about whether the customer's
   * automation reports enquiries to us, because the event came from this form rather than
   * from their automation; the page says so where it is read.
   *
   * ## Marked, so it cannot inflate anything
   *
   * `isSynthetic: true`. The column existed and was read nowhere, so the flag alone would
   * have been decoration; the owner's platform run count and the workspace's own
   * verification rate both exclude it now.
   */
  async startTestVerification(input: TestVerificationInput): Promise<TestVerificationResult> {
    const refuse = (message: string, fieldErrors: Record<string, string> = {}) => ({
      ok: false,
      runId: null,
      fieldErrors,
      message,
    });

    const offer = await this.testVerificationOffer();
    if (!offer.canStart) return refuse(offer.reason ?? 'A test verification cannot be started.');

    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in to run a test verification.');

    const fieldErrors: Record<string, string> = {};
    const crmRecordId = input.crmRecordId.trim();
    const messageId = input.messageId.trim();
    const expectedRecipient = input.expectedRecipient.trim();
    const correlationValue = input.correlationValue.trim();
    if (crmRecordId === '') fieldErrors['crmRecordId'] = 'Name a CRM record that already exists.';
    if (messageId === '')
      fieldErrors['messageId'] = 'Give the provider id of a message that was already sent.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(expectedRecipient))
      fieldErrors['expectedRecipient'] = 'Give the address the acknowledgement should have reached.';
    if (correlationValue === '')
      fieldErrors['correlationValue'] =
        'Give the value that should be in the correlation property on that record.';
    if (Object.keys(fieldErrors).length > 0) {
      return refuse('Nothing was started. Check the fields below.', fieldErrors);
    }

    const decision = await consume(
      this.#db,
      `test-verification:${scope.workspaceId}`,
      4,
      3600,
      this.#now,
    );
    if (!decision.allowed) {
      return refuse(
        'That is several test verifications in a short time, and each one costs a run. Wait a while before the next.',
      );
    }

    const workflow = await this.workflow();
    if (workflow === null) return refuse('There is no workflow to test against.');
    const versionRow = await this.#db
      .prepare('SELECT current_version_id FROM workflows WHERE workspace_id = ? AND id = ?')
      .bind(scope.workspaceId, workflow.id)
      .first<{ current_version_id: string | null }>();
    const versionId = versionRow?.current_version_id ?? null;
    if (versionId === null) {
      return refuse(
        'This workflow has no published version, so there are no rules to judge a test against.',
      );
    }

    const environment = this.#env.STRIPE_MODE === 'live' ? 'live' : 'test';
    const resolved = await resolveAllowancePeriodKey(new BillingPortSubscriptionSource(this.#db), {
      workspaceId: scope.workspaceId,
      atIso: toIso(this.#now),
      environment,
    });
    if (resolved.key === null) {
      return refuse(
        'This workspace has no billing period open, so there is no allowance to draw a test run from.',
      );
    }

    const at = nowIso(this.#now);
    const eventId = `test-${newId(ID_PREFIX.sourceEvent, this.#now.getTime())}`;
    const payload = {
      schema_version: 1 as const,
      event_id: eventId,
      workflow_id: workflow.id,
      occurred_at: at,
      correlation_id: correlationValue,
      expected: {
        email_recipient: expectedRecipient,
        crm_record_id: crmRecordId,
        email_message_id: messageId,
      },
    };
    const payloadJson = JSON.stringify(payload);

    const admitted = await sourceEvents.admitOnce(this.#db, {
      workspaceId: scope.workspaceId,
      billingPeriod: resolved.key,
      workflowId: workflow.id,
      workflowVersionId: versionId,
      externalEventId: eventId,
      // The existing vocabulary, not a new value: this IS an owner-initiated test run,
      // and the column has a CHECK constraint that a new word would fail at write time.
      source: 'owner_test',
      sourceEventId: newId(ID_PREFIX.sourceEvent, this.#now.getTime()),
      runId: newId(ID_PREFIX.run, this.#now.getTime()),
      outboxId: newId(ID_PREFIX.outbox, this.#now.getTime()),
      receivedAt: at,
      occurredAt: at,
      correlationKeyHash: await sha256Hex(`${scope.workspaceId}:${correlationValue}`),
      payloadHash: await sha256Hex(payloadJson),
      payloadJson,
      deadlineAt: toIso(new Date(this.#now.getTime() + workflow.deadlineSeconds * 1000)),
      nextCheckAt: at,
      // Marked at birth. Nothing downstream has to infer it, and the exclusions in the
      // owner's run count and the workspace's verification rate read this column.
      isSynthetic: true,
    });

    await auditEvents.record(this.#db, {
      id: newId(ID_PREFIX.auditEvent, this.#now.getTime()),
      actor: scope.userId,
      actorKind: 'user',
      workspaceId: scope.workspaceId,
      action: 'run.test_verification_started',
      target: admitted.runId,
      occurredAt: at,
      // The shape of what was asked, never the customer's values: a CRM record id and a
      // recipient address are their data, not ours to copy into an audit row.
      redactedMetadata: JSON.stringify({
        workflow_id: workflow.id,
        synthetic: true,
        duplicate: admitted.duplicate,
      }),
    });

    return {
      ok: true,
      runId: admitted.runId,
      fieldErrors: {},
      message:
        'The test verification was admitted and is now waiting to be checked, exactly like a real enquiry. It is decided by reading your providers, so it can come back verified, failed or unverified.',
    };
  }

  /* --- billing --- */

  async orderSummary(): Promise<OrderSummaryView> {
    const scope = await this.#scope();
    const blockers: string[] = [];
    if (scope === null) blockers.push('You are not signed in.');

    if (scope !== null) {
      /*
       * Role, and it belongs here rather than on the page.
       *
       * Found by an independent review on 21 September 2026, immediately after two pages
       * were changed to render their setup controls on `role === 'workspace_admin'` with
       * a comment claiming that was "the same rule the server uses". It was the rule for
       * `saveFieldMapping`, `saveExpectedOutcome` and `submitConnectionCredentials`. It
       * was not the rule here, and this is the one that spends money: `createCheckout`
       * refuses only on `summary.ready`, and nothing in `orderSummary` had ever consulted
       * a role. On a workspace with both providers ready and a published workflow, a
       * `workspace_viewer` was shown a live "Continue to secure checkout" button and
       * could create a real Stripe Checkout Session for a workspace they may only read.
       *
       * Adding it as a blocker rather than as a second check inside `createCheckout`
       * closes the page and the route with one line each way: the review step renders its
       * control on `order.ready`, `createCheckout` refuses on `order.ready`, and both now
       * see the same answer. A separate guard in `createCheckout` would have been a
       * second rule to keep in step with this one, which is the shape of defect that
       * produced this finding.
       */
      if (scope.role !== 'workspace_admin') {
        blockers.push(
          'Only a workspace admin can subscribe. Your role in this workspace is viewer, so this is not yours to buy.',
        );
      }
      const live = await connections.list(this.#db, scope.workspaceId);
      const ready = new Set(
        live.filter((row) => row.status === 'ready').map((row) => row.provider),
      );
      if (!ready.has('hubspot')) blockers.push('Connect HubSpot so we can read the CRM record.');
      if (!ready.has('resend'))
        blockers.push('Connect Resend so we can read email delivery events.');
      const page = await workflows.list(this.#db, scope.workspaceId, { limit: 1 });
      if (page.items[0] === undefined) blockers.push('Create a workflow to check.');
      else if (page.items[0].current_version_id === null) {
        blockers.push('Publish your expected outcome before subscribing.');
      }
    }
    // A key that is present but malformed is the same fact as a key that is absent: this
    // deployment cannot take money. Checking only for emptiness is what let staging render
    // a working-looking checkout button in front of a call that threw
    // `Stripe secret key does not look like a test or live key` -- a 500 the customer met
    // only after deciding to buy. Found by pressing the button on a deployment; no unit
    // test could have seen it, because every one of them supplies a well-formed fixture.
    // The same question asked of the price. `price_…` is Stripe's shape; anything else is a
    // 400 from the provider AFTER the customer has pressed Continue. The auditor called
    // this "the next STRIPE_SECRET_KEY" and was right: one of the pair was validated and
    // the other was not, for no reason other than which one had already caused an outage.
    const rawPriceId = this.#env.STRIPE_PRICE_ID ?? '';
    const priceId = rawPriceId.trim();
    if (priceId !== '' && !/^price_[A-Za-z0-9]+$/.test(priceId)) {
      // Name the actual problem. "Is not a Stripe price id" sent the owner to the Stripe
      // dashboard three times looking for a value they may already have set correctly, and
      // the three likely causes want three different actions. None of these says the value:
      // a price id is not a secret, but this message is rendered to a customer.
      const because =
        rawPriceId !== priceId
          ? 'it has whitespace around it, which usually means it was piped in with a trailing newline'
          : /^prod_/.test(priceId)
            ? 'it is a product id (prod_…) rather than the price id (price_…) underneath it'
            : 'it does not begin with price_';
      blockers.push(
        `Payments are not enabled in this environment: STRIPE_PRICE_ID is set but ${because}. That is our configuration, not something on your side.`,
      );
    }
    const secretKey = (this.#env.STRIPE_SECRET_KEY ?? '').trim();
    if (secretKey !== '' && !secretKeyIsUsable(secretKey)) {
      blockers.push(
        'Payments are not enabled in this environment: STRIPE_SECRET_KEY is set but is not a usable Stripe key. That is our configuration, not something on your side.',
      );
    }
    if (priceId === '' || secretKey === '') {
      // Naming the secret is not a leak -- these are variable names, not values -- and the
      // person reading it on a bare deployment is the operator, who would otherwise go
      // looking through code to find out which of the two is missing.
      const missing = [
        secretKey === '' ? 'STRIPE_SECRET_KEY' : null,
        priceId === '' ? 'STRIPE_PRICE_ID' : null,
      ].filter((name): name is string => name !== null);
      blockers.push(
        `Payments are not enabled in this environment: ${missing.join(' and ')} is not set. That is our configuration, not something on your side.`,
      );
    }

    // Every value here is resolved from server-side constants. Nothing is read from the
    // request, so a crafted form cannot buy a plan at a price it chose (rule 5).
    return {
      planName: 'ITISYOU Verify: one workflow',
      priceDisplay: formatMoney(money(LIMITS.PLAN_PRICE_PENCE, 'GBP')),
      billingPeriod: 'month',
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      blockers,
      ready: blockers.length === 0,
      paymentsMode: this.#env.STRIPE_MODE === 'live' ? 'live' : 'test',
    };
  }

  /**
   * Refuses, and says plainly that no card was charged.
   *
   * Creating a Checkout session means calling Stripe with a secret key. There is none in
   * this environment, so there is nothing to redirect to. The wording matters more than
   * the code path: a customer who believes a payment was attempted will wait for it.
   */
  /**
   * The billing runtime, assembled in one place.
   *
   * Spelled once because a second spelling is how a money path acquires two different
   * clocks, two different id factories, or -- as happened with the period key -- two
   * different notions of the same thing.
   */
  async #billingRuntime(): Promise<import('../billing/runtime').BillingRuntime> {
    const { createBillingRuntime } = await import('../billing/index');
    const { D1BillingDataPort } = await import('./billingPort');
    const { createStripeClient } = await import('@verify/connectors/stripe');
    return createBillingRuntime(this.#env as never, {
      data: new D1BillingDataPort(this.#db),
      gateway: createStripeClient({
        secretKey: (this.#env.STRIPE_SECRET_KEY ?? '').trim(),
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
      }),
      now: () => toIso(this.#now),
      newId: (prefix: string) => newId(prefix, this.#now.getTime()),
    });
  }

  async createCheckout(): Promise<WriteResult> {
    const scope = await this.#scope();
    if (scope === null) return refuse('Sign in before subscribing.');
    const summary = await this.orderSummary();
    if (!summary.ready) {
      return refuse(
        // True as written: this refusal happens before any call to Stripe is made at all.
        `No checkout session was created and no card was charged. ${summary.blockers.join(' ')}`,
      );
    }

    // No second configuration gate here. `orderSummary` above already refuses when either
    // Stripe secret is missing, and adding a duplicate check would have been unreachable
    // code guarding a money path -- the exact shape of defect this method was just fixed
    // for. The secret is read once, below, having been proven present.
    const secretKey = this.#env.STRIPE_SECRET_KEY ?? '';

    const { startCheckout } = await import('../billing/index');
    void secretKey;

    /*
     * Everything below the button, including the provider failing.
     *
     * `startCheckout` returns an outcome for the refusals it anticipates and THROWS for a
     * gateway that answers 401, rejects the price id, or does not answer at all. Those
     * three are the likeliest real failures on this path, and every one of them escaped to
     * the page error boundary as a bare 500 -- so the careful refusal wording below, which
     * exists precisely so a customer is told no card was charged, was unreachable for
     * exactly the cases it was written for. The auditor found this by making Stripe fail
     * rather than by reading the method.
     *
     * "No card was charged" stays true on every path through this catch. A Checkout
     * Session is not a charge; a card is entered on Stripe's page, after this request has
     * already returned. So the sentence is safe to say even when we do not know how far
     * the call got, which is the only reason it may be said at all.
     *
     * The cause is logged and never rendered: a provider error can carry a key, and this
     * message is shown to whoever pressed the button.
     */
    let result: Awaited<ReturnType<typeof startCheckout>>;
    try {
      result = await startCheckout(
        {
          ...(await this.#billingRuntime()),
          // Eligibility is `orderSummary`'s question, already answered above. Asking it
          // again through this port keeps billing unable to take money on its own say-so.
          checkEligibility: async () => {
            const current = await this.orderSummary();
            return current.ready
              ? { eligible: true }
              : { eligible: false, reason: current.blockers.join(' ') };
          },
        },
        {
          workspaceId: scope.workspaceId,
          ...(scope.email === undefined ? {} : { customerEmail: scope.email }),
        },
      );
    } catch (caught) {
      // eslint-disable-next-line no-console -- the operator's only view of a money-path failure
      console.log('checkout', {
        event: 'checkout_start_failed',
        workspace_id: scope.workspaceId,
        // `scrubSecret` removes any `sk_`/`rk_`/`whsec_` shaped token, so a provider error
        // quoting the key back at us cannot put it in a log line.
        message: scrubSecret(caught instanceof Error ? caught.message : String(caught)),
      });
      return refuse(
        'No card was charged and your subscription has not started. Our payment provider did not ' +
          'complete the request. Nothing about your workspace has changed; try again in a moment, ' +
          'and if it keeps happening please contact support before trying a different card.',
      );
    }

    if (result.outcome === 'checkout_ready') {
      // Stripe's hosted page. The card is entered there and never reaches us.
      return ok(result.checkoutUrl, 'Continue on Stripe to finish subscribing.');
    }
    if (result.outcome === 'already_subscribed') {
      return ok('/app/onboarding/activation', 'This workspace is already subscribed.');
    }
    return refuse(
      /*
       * What this sentence may claim, and what it may not.
       *
       * It used to open "No checkout session was created", and on four of the paths that
       * reach here that is false: `assertMode`, the null-URL guard, a refused status
       * transition and a failing `recordOrderStatus` all run AFTER Stripe has created a
       * session. The auditor drove two of them and watched the product tell a customer
       * nothing had been created while a session existed in the account -- this product's
       * own thesis, pointed at itself, on the money path.
       *
       * "No card was charged" survives on every path, because a card is entered on
       * Stripe's page after this request has returned, and an abandoned Checkout Session
       * expires without ever becoming a charge. That is the fact the customer needs and
       * the only one we can state.
       */
      `No card was charged and your subscription has not started. ${result.detail ?? result.reason}`,
    );
  }

  async activation(): Promise<ActivationView> {
    const scope = await this.#scope();
    const endpoint = `${this.#env.PUBLIC_BASE_URL}/api/v1/events`;
    if (scope === null) {
      return {
        active: false,
        subscriptionStatus: null,
        eventEndpoint: endpoint,
        workflowId: '',
        signingKeyId: null,
        signingKeyHint: null,
        signingKeyIssuance: {
          canIssue: false,
          cannotIssueReason: 'Sign in to issue a signing key.',
        },
        firstRunId: null,
      };
    }
    const page = await workflows.list(this.#db, scope.workspaceId, { limit: 1 });
    const workflow = page.items[0];
    const subscription = await subscriptions.getForWorkspace(
      this.#db,
      scope.workspaceId,
      this.#env.STRIPE_MODE === 'live' ? 'live' : 'test',
    );
    const firstRun =
      workflow === undefined
        ? null
        : ((await runs.listByWorkflow(this.#db, scope.workspaceId, workflow.id, { limit: 1 }))
            .items[0] ?? null);

    return {
      active: subscription?.status === 'active' || subscription?.status === 'trialing',
      subscriptionStatus: (subscription?.status as SubscriptionStatus | undefined) ?? null,
      eventEndpoint: endpoint,
      workflowId: workflow?.id ?? '',
      signingKeyId: workflow?.signing_key_ref ?? null,
      signingKeyHint:
        workflow?.signing_key_hash === undefined || workflow.signing_key_hash === null
          ? null
          : maskToken(workflow.signing_key_hash),
      signingKeyIssuance: this.#signingKeyIssuance(scope, workflow),
      firstRunId: firstRun?.id ?? null,
    };
  }

  #rootKey(): string {
    return this.#env.EVENT_SIGNING_ROOT_KEY ?? '';
  }

  /** What the page says next to the control — the same conditions `issueSigningKey` enforces. */
  #signingKeyIssuance(
    scope: ResolvedSession,
    workflow: WorkflowRow | undefined,
  ): SigningKeyIssuanceView {
    if (workflow === undefined) {
      return {
        canIssue: false,
        cannotIssueReason:
          'There is no workflow to issue a key for yet. Finish the setup steps first.',
      };
    }
    if (scope.role !== 'workspace_admin') {
      return {
        canIssue: false,
        cannotIssueReason: 'Only a workspace admin can issue or rotate the signing key.',
      };
    }
    if (this.#rootKey().length === 0) {
      return { canIssue: false, cannotIssueReason: SIGNING_KEY_UNCONFIGURED };
    }
    return { canIssue: true, cannotIssueReason: null };
  }

  /**
   * Issue or rotate this workspace's workflow signing key.
   *
   * The first production caller of `issueWorkflowSigningKey`, and through it the first of
   * `workflows.setSigningKey`. Both existed, both were tested, nothing reached either, and
   * so no customer had ever held a key.
   *
   * The secret goes back to the page and nowhere else. It is not in the audit row (that
   * carries the public reference only), it is not logged, and it is not stored — the row
   * holds `hashToken(secret, 'workflow_signing')`, from which nothing can be signed.
   *
   * With no root key the derivation refuses before anything is minted or written, and that
   * refusal comes back as a typed configuration error: not rethrown into a 500, and not
   * papered over with a key derived from the empty string.
   */
  async issueSigningKey(): Promise<SigningKeyIssueResult> {
    const scope = await this.#scope();
    if (scope === null) {
      return {
        outcome: 'refused',
        reason: 'not_signed_in',
        message: 'Sign in to issue a signing key.',
      };
    }
    if (scope.role !== 'workspace_admin') {
      return {
        outcome: 'refused',
        reason: 'not_permitted',
        message: 'Only a workspace admin can issue or rotate the signing key. Nothing was changed.',
      };
    }
    const workflow = (await workflows.list(this.#db, scope.workspaceId, { limit: 1 })).items[0];
    if (workflow === undefined) {
      return {
        outcome: 'refused',
        reason: 'no_workflow',
        message: 'There is no workflow to issue a key for yet. Nothing was changed.',
      };
    }

    const rotated = workflow.signing_key_ref !== null;
    const at = nowIso(this.#now);
    let issued: IssuedSigningKey;
    try {
      issued = await issueWorkflowSigningKey(
        { db: this.#db, rootKey: this.#rootKey(), now: at },
        { workspaceId: scope.workspaceId, workflowId: workflow.id },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'EVENT_SIGNING_UNCONFIGURED') {
        return { outcome: 'unconfigured', message: SIGNING_KEY_UNCONFIGURED };
      }
      if (error instanceof AppError && error.code === 'WORKFLOW_NOT_FOUND') {
        return { outcome: 'refused', reason: 'no_workflow', message: error.publicMessage };
      }
      throw error;
    }

    // The public reference and nothing else. Not the secret; and not the hash either — it
    // already sits on the workflow row, and an audit trail is read by more people.
    await auditEvents.record(this.#db, {
      id: newId(ID_PREFIX.auditEvent, this.#now.getTime()),
      actor: scope.userId,
      actorKind: 'user',
      workspaceId: scope.workspaceId,
      action: rotated ? 'workflow.signing_key_rotated' : 'workflow.signing_key_issued',
      target: workflow.id,
      occurredAt: at,
      redactedMetadata: JSON.stringify({ key_ref: issued.keyId }),
    });

    return {
      outcome: 'issued',
      keyId: issued.keyId,
      secret: issued.secret,
      rotated,
      issuedAt: issued.issuedAt,
    };
  }

  /* --- results --- */

  async listRuns(options: {
    cursor?: string;
    limit: number;
    source?: 'real' | 'test';
  }): Promise<RunPage> {
    const scope = await this.#scope();
    if (scope === null) return { items: [], nextCursor: null, prevCursor: null };

    const page = await runs.listByWorkspace(this.#db, scope.workspaceId, {
      limit: options.limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.source === undefined ? {} : { source: options.source }),
    });

    const items: RunListItem[] = [];
    for (const row of page.items) {
      const results = await assertions.listForRun(this.#db, scope.workspaceId, row.id);
      const mandatory = results.filter((a) => a.mandatory === 1);
      const event = await sourceEvents.getForRun(this.#db, scope.workspaceId, row.id);
      items.push({
        id: row.id,
        status: row.status,
        summary: summarise(row.status, mandatory),
        // The readable reference the customer typed, not the hash we key on. The detail
        // page already parses it out of the same payload; the list showed 64 hex
        // characters where the run's own page shows "ENQ-MATCH-0001".
        correlationId: readableCorrelation(event),
        occurredAt: event?.occurred_at ?? row.created_at,
        decidedAt: row.completed_at,
        mandatorySupported: mandatory.filter((a) => a.status === 'SUPPORTED').length,
        mandatoryTotal: mandatory.length,
        // The list said nothing about this, so a test run a customer started read exactly
        // like an enquiry their automation reported.
        isTest: event?.source === 'owner_test',
      });
    }

    // The port exposes a prevCursor; keyset pagination cannot produce one without a
    // reverse query, and inventing one would send the customer to the wrong page.
    return { items, nextCursor: page.nextCursor, prevCursor: null };
  }

  async run(runId: string): Promise<RunDetailView | null> {
    const scope = await this.#scope();
    if (scope === null) return null;

    // Scoped by the resolved workspace, so another tenant's run id returns null rather
    // than a row somebody then has to remember to check.
    const row = await runs.get(this.#db, scope.workspaceId, runId);
    if (row === null) return null;

    const [event, version, workflow, rows] = await Promise.all([
      sourceEvents.getForRun(this.#db, scope.workspaceId, runId),
      workflowVersions.get(this.#db, scope.workspaceId, row.workflow_version_id),
      workflows.get(this.#db, scope.workspaceId, row.workflow_id),
      assertions.listForRun(this.#db, scope.workspaceId, runId),
    ]);

    let recipient = '';
    let correlationId = event?.correlation_key_hash ?? '';
    if (event !== null) {
      try {
        const payload = JSON.parse(event.payload_json) as {
          correlation_id?: string;
          expected?: { email_recipient?: string };
        };
        recipient = payload.expected?.email_recipient ?? '';
        correlationId = payload.correlation_id ?? correlationId;
      } catch {
        /* a payload we cannot parse still yields a readable run */
      }
    }

    const results: AssertionResult[] = rows.map((a) => ({
      rule_id: a.rule_id,
      label: a.label,
      mandatory: a.mandatory === 1,
      status: a.status,
      reason_code: a.reason_code as AssertionResult['reason_code'],
      expected_display: a.expected_display ?? '',
      observed_display: a.observed_display,
      observed_at: a.observed_at,
      evidence_ref: a.evidence_id,
    }));

    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: workflow?.name ?? 'Workflow',
      status: row.status,
      statusReason: summarise(row.status, results.filter((r) => r.mandatory)),
      correlationId,
      recipient,
      occurredAt: event?.occurred_at ?? row.created_at,
      deadlineAt: row.deadline_at,
      observedAt: results.find((r) => r.observed_at !== null)?.observed_at ?? null,
      decidedAt: row.completed_at,
      sourceType: event?.source ?? 'signed_customer_event',
      rulesRef: `${row.workflow_id}@v${version?.version_number ?? 1}`,
      rulesSchemaVersion: version?.schema_version ?? 1,
      coverageMode: workflow?.coverage_mode ?? 'customer_triggered',
      revision: row.revision,
      lateCompletion:
        row.completed_at !== null &&
        row.completed_at > row.deadline_at &&
        row.status === 'VERIFIED',
      results,
    };
  }

  /* --- usage --- */

  /**
   * Usage for the period the customer is actually paying for.
   *
   * The period key comes from `allowancePeriodKeyAt`, never from the calendar. A
   * subscription that started on the 20th is billed 20th to 20th, so a `YYYY-MM` key would
   * roll the allowance over a week early — handing out runs nobody paid for and then
   * cutting the customer off before their period ended.
   *
   * With no subscription there is no paid period, so there is no key to look up and no
   * allowance row to find. That is reported as "nothing used yet against the plan
   * allowance", not as a fabricated month.
   */
  async usage(): Promise<UsageView> {
    const scope = await this.#scope();
    const nothingYet = (start: string, end: string): UsageView => ({
      periodStart: start,
      periodEnd: end,
      runsUsed: 0,
      runsIncluded: LIMITS.PLAN_RUNS_PER_PERIOD,
      admissionBlocked: false,
      subscriptionStatus: null,
    });

    if (scope === null) return nothingYet(toIso(this.#now), toIso(this.#now));

    const environment = this.#env.STRIPE_MODE === 'live' ? 'live' : 'test';
    const subscription = await subscriptions.getForWorkspace(
      this.#db,
      scope.workspaceId,
      environment,
    );

    // The key comes from A06's resolver, which reads the subscription's own period end.
    // Deriving one here is the A13-010 defect: this page read `YYYY-MM` while billing wrote
    // `YYYY-MM-DD`, so it looked up a row that never existed and reported 0 used / 500 left
    // forever — to a customer who might be at their limit and being refused.
    const resolved = await resolveAllowancePeriodKey(new BillingPortSubscriptionSource(this.#db), {
      workspaceId: scope.workspaceId,
      atIso: toIso(this.#now),
      environment,
    });
    if (resolved.key === null) {
      return {
        ...nothingYet(toIso(this.#now), toIso(this.#now)),
        subscriptionStatus: (subscription?.status as SubscriptionStatus | undefined) ?? null,
      };
    }
    const periodEnd = subscription?.current_period_end ?? toIso(this.#now);

    const allowance = await entitlements.get(this.#db, scope.workspaceId, resolved.key);
    const used = (allowance?.consumed ?? 0) + (allowance?.reserved ?? 0);
    const included = allowance?.run_limit ?? LIMITS.PLAN_RUNS_PER_PERIOD;

    return {
      // The END is the provider's own figure and is the key the row is stored under.
      // The START is NOT derived here: computing it means walking the anchor boundaries,
      // and a second spelling of that walk is exactly the A13-010 defect. A06 has not
      // exported `allowancePeriodStartAt`; requested in the handoff. Until it exists this
      // reports when the figures were read, which is true, rather than a month we guessed.
      periodStart: toIso(this.#now),
      periodEnd: toIso(periodEnd),
      runsUsed: used,
      runsIncluded: included,
      // Resolved from the stored allowance, never from anything the browser sent.
      admissionBlocked: allowance !== null && included - used <= 0,
      subscriptionStatus: (subscription?.status as SubscriptionStatus | undefined) ?? null,
    };
  }

  /**
   * Can this reader open the portal? Asked without calling Stripe.
   *
   * ## The defect this split fixes
   *
   * There was one method, `billingPortalLink()`, and `GET /app/billing` called it while
   * rendering. It created a real Stripe billing-portal session and the page put the
   * returned URL straight into `<a href>`. A Stripe portal session is single-use and
   * short-lived, so:
   *
   *  - every page view, including a refresh or a back-button, burned a session;
   *  - the link a customer eventually clicked was minted when the page was drawn, not when
   *    they clicked, so on any page left open it had expired. That is the "expired session"
   *    the owner hit from a fresh sign-in;
   *  - a bearer-secret URL sat in the HTML of an authenticated page.
   *
   * Availability is now decided from what we already hold and the session is minted per
   * click by `openBillingPortal`, below.
   */
  async billingPortalAvailability(): Promise<{ canOpen: boolean; reason: string | null }> {
    const refusal = await this.#portalRefusal();
    return refusal === null ? { canOpen: true, reason: null } : { canOpen: false, reason: refusal };
  }

  /** The one place that decides whether a portal opening is allowed, so both paths agree. */
  async #portalRefusal(): Promise<string | null> {
    const scope = await this.#scope();
    if (scope === null) return 'Sign in to manage billing.';
    // Same rule as `orderSummary`: managing the card and cancelling the plan are changes to
    // the workspace's money, and a viewer may read this workspace, not spend from it.
    if (scope.role !== 'workspace_admin') {
      return 'Only a workspace admin can manage billing. Your role in this workspace is viewer, so the portal is not yours to open.';
    }
    const subscription = await subscriptions.getForWorkspace(
      this.#db,
      scope.workspaceId,
      this.#env.STRIPE_MODE === 'live' ? 'live' : 'test',
    );
    if (subscription === null) {
      return 'There is no subscription to manage yet, so there is nothing to open and nothing to cancel.';
    }
    if ((this.#env.STRIPE_SECRET_KEY ?? '').trim() === '') {
      return 'The billing portal could not be opened: this deployment has no STRIPE_SECRET_KEY, so there is no portal session to create. That is our configuration, not something on your side.';
    }
    return null;
  }

  /**
   * Mint one fresh portal session for one authorised opening.
   *
   * The refusal check is repeated here rather than trusted from the page, because the page
   * is not what protects this: `POST /app/billing/portal` is reachable by anyone holding a
   * session and a CSRF pair, and a control being absent from a render has never been an
   * authorisation. `openBillingPortal` in `billing/portal.ts` reads the Stripe customer id
   * from our own binding rather than from the request, so a forged `cus_…` reaches nothing,
   * and it refuses a session whose livemode disagrees with this deployment.
   *
   * The URL is returned and nothing else is done with it: not logged, not stored, not
   * counted. It is a bearer credential for this customer's billing account.
   */
  async openBillingPortal(): Promise<{ href: string | null; reason: string | null }> {
    const refusal = await this.#portalRefusal();
    if (refusal !== null) return { href: null, reason: refusal };
    const scope = await this.#scope();
    if (scope === null) return { href: null, reason: 'Sign in to manage billing.' };

    try {
      const { openBillingPortal } = await import('../billing/index');
      const opened = await openBillingPortal(await this.#billingRuntime(), {
        workspaceId: scope.workspaceId,
      });
      return { href: opened.portalUrl, reason: null };
    } catch (error) {
      // A portal we could not open is reported as not opened. An older version of this
      // returned the "no STRIPE_SECRET_KEY" sentence unconditionally -- including on
      // deployments where Stripe WAS configured -- so the customer was told a configuration
      // fact that was false and the portal was never attempted.
      return {
        href: null,
        reason: `The billing portal could not be opened. ${
          error instanceof AppError ? error.message : 'Stripe did not return a portal link.'
        } Nothing has been changed.`,
      };
    }
  }

  /* --- support --- */

  /**
   * Record a support request.
   *
   * **This delegates to A09's `createCase` and does not reimplement any of it.** The
   * previous version wrote the raw body straight into `body_redacted` and hard-coded
   * `category: 'other'`, `priority: 'normal'`, `state: 'open'` — under a comment claiming
   * redaction had happened elsewhere. Two published statements were false as a result:
   *
   *  - a customer who pasted an API key into the form had it stored verbatim, in a column
   *    whose name asserts the opposite, and in every backup since;
   *  - a billing dispute, a deletion request and a security report never escalated, so
   *    A09's acknowledgement — "it has gone straight to the owner" — was untrue.
   *
   * `createCase` redacts, triages, writes and produces the acknowledgement, in that order.
   * Calling it is the fix; the comment that used to stand here is exactly why the defect
   * survived review, because it told the next reader the work was already done.
   */
  async submitSupportRequest(input: SupportRequestInput): Promise<SupportResult> {
    const scope = await this.#scope();
    const fieldErrors: Record<string, string> = {};
    const subject = input.subject.trim();
    const body = input.body.trim();
    if (subject.length < 3) fieldErrors['subject'] = 'Tell us in a few words what this is about.';
    if (body.length < 10) fieldErrors['body'] = 'A little more detail will let us help faster.';
    if (subject.length > 200)
      fieldErrors['subject'] = 'Please keep the subject under 200 characters.';
    if (body.length > 5000) fieldErrors['body'] = 'Please keep the message under 5000 characters.';
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, fieldErrors, message: null, redirectTo: null, reference: null };
    }
    if (scope === null) {
      return {
        ok: false,
        fieldErrors: {},
        message:
          'Sign in so we can link your message to your workspace, or use the public support form if you cannot sign in.',
        redirectTo: null,
        reference: null,
      };
    }

    // If the run id is not this workspace's, it is dropped rather than stored — a support
    // case must not become a way to reference another tenant's run.
    let linkedRunId: string | null = null;
    if (input.runId !== undefined && input.runId.length > 0) {
      const run = await runs.get(this.#db, scope.workspaceId, input.runId);
      linkedRunId = run?.id ?? null;
    }

    return recordSupportCase(this.#db, {
      workspaceId: scope.workspaceId,
      contactEmail: scope.email,
      subject,
      body,
      linkedRunId,
      now: this.#now,
    });
  }
}

/**
 * The one support write path, shared by the signed-in port and the public form.
 *
 * Both callers land here so neither can drift from the other on redaction or triage. The
 * raw body reaches `createCase` and nothing else: it is redacted before it is stored, and
 * triage decides the category, priority and starting state from the redacted text.
 */
export async function recordSupportCase(
  db: Db,
  input: {
    workspaceId: string | null;
    contactEmail: string;
    subject: string;
    body: string;
    linkedRunId?: string | null;
    servicePaused?: boolean;
    now?: Date;
  },
): Promise<SupportResult> {
  try {
    const created = await createCase(
      new D1SupportDataPort(db),
      {
        workspaceId: input.workspaceId,
        contactEmail: input.contactEmail,
        subject: input.subject,
        body: input.body,
        linkedRunId: input.linkedRunId ?? null,
        ...(input.servicePaused !== undefined ? { servicePaused: input.servicePaused } : {}),
      },
      input.now ?? new Date(),
    );
    return {
      ok: true,
      fieldErrors: {},
      // A09's own wording, which now matches what actually happened: the escalated
      // sentence is only produced when triage actually escalated.
      message: created.acknowledgement,
      redirectTo: '/app/support',
      reference: created.record.id,
    };
  } catch (error) {
    // A validation refusal from `createCase` is a field problem, not a 500.
    if (error instanceof AppError && error.httpStatus === 422) {
      return {
        ok: false,
        fieldErrors: { body: error.publicMessage },
        message: error.publicMessage,
        redirectTo: null,
        reference: null,
      };
    }
    throw error;
  }
}

/**
 * The signed-out support path.
 *
 * Support and cancellation must stay reachable when the service is paused and when the
 * person cannot sign in — which is precisely when they most need to reach us. A signed-out
 * case carries `workspace_id = NULL`, which is a real scope in `supportCases.get`, not a
 * wildcard, so it is readable by the owner queue and by nobody else.
 *
 * The contact address is required here because there is no session to take it from, and a
 * message we cannot reply to is not a support channel.
 */
export async function recordAnonymousSupportCase(
  db: Db,
  input: {
    contactEmail: string;
    subject: string;
    body: string;
    servicePaused?: boolean;
    now?: Date;
  },
): Promise<SupportResult> {
  return recordSupportCase(db, { ...input, workspaceId: null });
}

/**
 * The enquiry reference as the customer would recognise it.
 *
 * `correlation_key_hash` is what we index on; it is not what anyone typed. Falling back to
 * it is right when the payload cannot be read, and wrong as a first choice.
 */
function readableCorrelation(event: { payload_json: string; correlation_key_hash: string } | null): string {
  if (event === null) return '';
  try {
    const payload = JSON.parse(event.payload_json) as { correlation_id?: string };
    return payload.correlation_id ?? event.correlation_key_hash;
  } catch {
    return event.correlation_key_hash;
  }
}

/**
 * One sentence per status. Deliberately not a decision — it only describes one.
 *
 * It describes it from the assertion rows rather than from the status alone, because FAILED
 * has two causes: a check the evidence contradicts, and a record the provider confirmed does
 * not exist. Saying "contradicted by the evidence we retrieved" about a run where nothing was
 * retrieved is false, and sends a customer looking for a data mismatch when the truth is that
 * nothing was created. See `explainRunStatus`; held by VERIFY-901.
 */
function summarise(
  status: RunStatus,
  mandatory: readonly { readonly status: string }[],
): string {
  const mandatoryTotal = mandatory.length;
  switch (status) {
    case 'VERIFIED':
      return `All ${mandatoryTotal} required checks are supported by evidence we retrieved.`;
    case 'FAILED':
      return mandatory.some((a) => a.status === 'CONTRADICTED')
        ? 'At least one required check is contradicted by the evidence we retrieved.'
        : 'The completion window closed and the connected systems confirmed the expected record or message does not exist.';
    case 'UNVERIFIED':
      return 'We could not retrieve enough evidence to decide. That is not a failure.';
    case 'PENDING':
      return 'Still inside the agreed completion window.';
    default:
      return 'No decision has been recorded.';
  }
}

/**
 * Factory for the route mount.
 *
 * Accepts a Hono context structurally so `apps/app/src/db/` never imports Hono. `c.env` is
 * typed `unknown` because A05's `RouteEnv` deliberately declares only the vars the pages
 * read; the binding really is there at runtime, and this checks it rather than asserting.
 */
export function createCustomerDataPort(
  c: { readonly env: unknown; readonly req: { readonly raw: Request } },
  now?: Date,
): D1CustomerDataPort {
  const env = c.env as Env | undefined;
  if (env === undefined || env === null || typeof env !== 'object' || !('DB' in env)) {
    throw new Error(
      'createCustomerDataPort: the DB binding is missing. Add a d1_databases entry for this environment in wrangler.jsonc.',
    );
  }
  return new D1CustomerDataPort({
    db: env.DB,
    env,
    request: c.req.raw,
    ...(now !== undefined ? { now } : {}),
  });
}
