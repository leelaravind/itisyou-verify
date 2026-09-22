/**
 * The connection lifecycle — validate, seal, and only then hand something to be stored.
 *
 * This module closes the gap A02 named honestly in `customerPort.beginConnection`: there
 * was no connection flow, so there was nothing to begin. It exists because of one rule:
 *
 *   **A connection is never recorded as working on our own say-so.**
 *
 * So the order is fixed and not negotiable:
 *
 *   1. Check the shape of what was pasted. A token that cannot possibly be a HubSpot
 *      private-app token costs zero external calls to reject.
 *   2. Ask the provider. `validateConnection` proves the credential works *and* resolves
 *      the account it belongs to. A typo fails here, at paste time, in front of the
 *      customer — not at 3am inside their first verification run.
 *   3. Only if that succeeded, seal the credential with `sealCredentialFor` and hand the
 *      envelope back for A02 to store. **A credential that did not validate is never
 *      sealed and never returned**, so there is no path by which an unusable token
 *      reaches the database.
 *   4. Report the status the evidence supports — `ready` only when nothing is outstanding.
 *
 * This module writes nothing. It returns a `ConnectionEstablishment` describing exactly
 * what should be persisted, and A02's data layer performs the write. That seam is
 * deliberate: connectors know what a working connection *is*, the data layer knows how to
 * store one, and neither has to know the other's job.
 *
 * Nothing here ever returns a credential in plaintext, logs one, or puts one in a message.
 */
import type { CredentialEnvelope } from '@verify/security';
import { openCredentialFor, sealCredentialFor } from '@verify/security';
import type { ConnectionStatus, ConnectorErrorCode } from '@verify/contracts';
import { HUBSPOT_READ_SCOPE } from './hubspot.js';
import { RESEND_PROVIDER } from './resend.js';
import { getConnector } from './registry.js';
import type {
  ClassifiedError,
  ConnectionConfig,
  ConnectionSetupStep,
  ConnectionValidation,
  ConnectorCredentials,
  ProviderId,
  WebhookVerification,
} from './types.js';

// ---------------------------------------------------------------------------
// Credential purposes — the AAD contract between this package and A02
// ---------------------------------------------------------------------------

/**
 * The `purpose` component of the credential AAD.
 *
 * These strings are load-bearing. `sealCredentialFor` binds them into the AES-GCM
 * additional data, so sealing with `api_token` and opening with `token` does not produce
 * a wrong answer — it produces a hard decryption failure. They live here, exported, so
 * that A02's writer and this package's reader cannot drift apart silently.
 */
export const CREDENTIAL_PURPOSE = Object.freeze({
  /** The provider API token: HubSpot `pat-…`, Resend `re_…`. */
  API_TOKEN: 'api_token',
  /** The webhook signing secret: Resend `whsec_…`. */
  WEBHOOK_SECRET: 'webhook_secret',
} as const);

export type CredentialPurpose = (typeof CREDENTIAL_PURPOSE)[keyof typeof CREDENTIAL_PURPOSE];

/** The AAD context for one stored credential. Built in one place so it is built one way. */
export function credentialAadParts(
  workspaceId: string,
  provider: ProviderId,
  purpose: CredentialPurpose,
): { readonly workspaceId: string; readonly provider: string; readonly purpose: string } {
  return { workspaceId, provider, purpose };
}

export interface WrappingKey {
  readonly keyBase64: string;
  readonly keyVersion: number;
}

export interface SealedCredential {
  readonly purpose: CredentialPurpose;
  readonly envelope: CredentialEnvelope;
}

// ---------------------------------------------------------------------------
// Token shape checks — free, and they catch the common mistake
// ---------------------------------------------------------------------------

/**
 * What each provider's credential looks like.
 *
 * These are *shape* checks, not validity checks. They exist so that pasting a Resend key
 * into the HubSpot box, or pasting a webhook secret into the token box, is caught for
 * nothing instead of spending an external call and coming back with a confusing 401. A
 * token that passes this check has proven nothing at all yet.
 */
const TOKEN_SHAPE: Readonly<
  Record<
    ProviderId,
    { readonly prefixes: readonly string[]; readonly example: string; readonly where: string }
  >
> = Object.freeze({
  hubspot: Object.freeze({
    prefixes: Object.freeze(['pat-']),
    example: 'pat-na1-…',
    where: 'HubSpot → Settings → Integrations → Private Apps → your app → Auth',
  }),
  resend: Object.freeze({
    prefixes: Object.freeze(['re_']),
    example: 're_…',
    where: 'Resend → API Keys',
  }),
});

/** Resend's webhook signing secret. Svix's documented prefix. */
const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Trim and reject the things a paste box produces that a token never is. */
function cleanPastedSecret(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // A paste from a dashboard commonly arrives with a trailing newline or a stray space.
  // Trimming is a kindness; anything with internal whitespace is not a token.
  return raw.trim();
}

export interface TokenShapeProblem {
  readonly field: string;
  readonly message: string;
}

export function checkTokenShape(provider: ProviderId, raw: unknown): TokenShapeProblem | null {
  const token = cleanPastedSecret(raw);
  const shape = TOKEN_SHAPE[provider];
  if (token === '') {
    return {
      field: 'access_token',
      message: `Paste your ${provider === 'hubspot' ? 'HubSpot private app' : 'Resend API'} token. You will find it under ${shape.where}.`,
    };
  }
  if (/\s/.test(token)) {
    return {
      field: 'access_token',
      message:
        'That value contains a space or a line break, so it is not a token. Copy it again from the provider.',
    };
  }
  if (token.length > 512) {
    return {
      field: 'access_token',
      message:
        'That value is far longer than any provider token. Check you pasted the token and not a whole page.',
    };
  }
  if (!shape.prefixes.some((prefix) => token.startsWith(prefix))) {
    if (token.startsWith(WEBHOOK_SECRET_PREFIX)) {
      return {
        field: 'access_token',
        message: `That is a webhook signing secret, not an API token. The token goes in this box and starts ${shape.example}.`,
      };
    }
    for (const [other, otherShape] of Object.entries(TOKEN_SHAPE) as [
      ProviderId,
      (typeof TOKEN_SHAPE)[ProviderId],
    ][]) {
      if (other !== provider && otherShape.prefixes.some((prefix) => token.startsWith(prefix))) {
        return {
          field: 'access_token',
          message: `That looks like a ${other === 'hubspot' ? 'HubSpot' : 'Resend'} token. This box wants your ${provider === 'hubspot' ? 'HubSpot' : 'Resend'} token, which starts ${shape.example}.`,
        };
      }
    }
    return {
      field: 'access_token',
      message: `A ${provider === 'hubspot' ? 'HubSpot private app' : 'Resend API'} token starts ${shape.example}. Copy it from ${shape.where}.`,
    };
  }
  return null;
}

export function checkWebhookSecretShape(raw: unknown): TokenShapeProblem | null {
  const secret = cleanPastedSecret(raw);
  if (secret === '') return null; // optional at this step; the setup step covers it
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    return {
      field: 'webhook_secret',
      message:
        'A Resend signing secret starts whsec_. You will find it beside the webhook endpoint in the Resend dashboard.',
    };
  }
  if (/\s/.test(secret) || secret.length > 512) {
    return {
      field: 'webhook_secret',
      message: 'That value is not a signing secret. Copy it again from Resend.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Establishing a connection
// ---------------------------------------------------------------------------

export interface EstablishConnectionInput {
  readonly provider: ProviderId;
  readonly workspaceId: string;
  /** Raw, as pasted. Trimmed here; never logged, never echoed, never returned. */
  readonly accessToken: string;
  /** Raw, as pasted. Resend only. */
  readonly webhookSecret?: string | undefined;
  /** The CRM property carrying our correlation id, when the customer has chosen one. */
  readonly correlationProperty?: string | undefined;
  /**
   * When a correctly signed callback has already been verified for this connection, the
   * instant it was. Carried in so that re-submitting credentials on a proven connection
   * does not silently demote it to `testing`: the webhook was proven once and re-pasting a
   * key is no reason to disbelieve it. NULL or absent means no callback has been verified.
   */
  readonly webhookVerifiedAt?: string | null | undefined;
  readonly wrappingKey: WrappingKey;
  readonly now: Date;
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Exactly what A02 should write. Nothing more, nothing implied. */
export interface ConnectionEstablishment {
  readonly ok: boolean;
  readonly provider: ProviderId;
  readonly connection: {
    readonly status: ConnectionStatus;
    /** The account the credential really belongs to. Null when we could not establish one. */
    readonly externalAccountId: string | null;
    readonly scopes: readonly string[];
    readonly lastCheckAt: string;
    readonly lastErrorCode: ConnectorErrorCode | null;
  };
  /**
   * Sealed credentials to store. **Empty whenever validation failed** — we do not keep a
   * token we could not use, and there is no branch here that seals one.
   */
  readonly credentials: readonly SealedCredential[];
  /** Field-keyed messages, shaped for A05's `WriteResult.fieldErrors`. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** A form-level sentence. Truthful about both success and failure. */
  readonly message: string;
  /** What the customer still has to do. Non-empty means the connection is not ready. */
  readonly setupSteps: readonly ConnectionSetupStep[];
  readonly callsMade: number;
}

const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = Object.freeze({
  hubspot: 'HubSpot',
  resend: 'Resend',
});

/**
 * Map a connector error onto the connection status vocabulary.
 *
 * Deliberately conservative: anything we do not specifically understand leaves the
 * connection `not_connected` rather than implying a half-working state.
 */
function statusForError(code: ConnectorErrorCode): ConnectionStatus {
  switch (code) {
    case 'AUTH_EXPIRED':
      return 'expired';
    case 'PERMISSION_MISSING':
    case 'UNSUPPORTED_CAPABILITY':
      return 'degraded';
    case 'RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
    case 'NOT_FOUND':
    case 'AMBIGUOUS_MATCH':
    case 'INVALID_EVIDENCE':
    default:
      return 'not_connected';
  }
}

/**
 * Turn a classified error into something a customer can act on.
 *
 * `error.detail` may contain a provider's own wording, which is fine to store but is not
 * always a sentence anyone should be shown. The customer-facing text is ours.
 */
function customerMessageForError(provider: ProviderId, error: ClassifiedError): string {
  const name = PROVIDER_NAME[provider];
  switch (error.code) {
    case 'AUTH_EXPIRED':
      return `${name} rejected that token. Nothing has been saved. Check you copied the whole value, and that the private app or key has not been deleted.`;
    case 'PERMISSION_MISSING':
      return provider === 'hubspot'
        ? `That token works, but the private app is missing the ${HUBSPOT_READ_SCOPE} scope, so we could not read anything. Nothing has been saved. Add the scope in HubSpot and paste the token again.`
        : `That key works, but it can only send email; it cannot read anything back. Nothing has been saved. Resend offers no read-only key, so reading delivery evidence needs a full-access key.`;
    case 'RATE_LIMITED':
      return `${name} asked us to slow down, so we could not check that token yet. Nothing has been saved. Try again in a minute.`;
    case 'PROVIDER_UNAVAILABLE':
      return `We could not reach ${name} to check that token, so nothing has been saved. This is a problem at our end or theirs, not with your token. Try again shortly.`;
    case 'UNSUPPORTED_CAPABILITY':
      return `${name} refused the request we use to check a connection. Nothing has been saved. Tell us about this: it usually means the provider changed something.`;
    case 'NOT_FOUND':
    case 'AMBIGUOUS_MATCH':
    case 'INVALID_EVIDENCE':
    default:
      return `We could not confirm that ${name} token, so nothing has been saved.`;
  }
}

function refusal(
  provider: ProviderId,
  now: Date,
  fieldErrors: Record<string, string>,
  message: string,
  callsMade: number,
  lastErrorCode: ConnectorErrorCode | null = null,
  status: ConnectionStatus = 'not_connected',
): ConnectionEstablishment {
  return {
    ok: false,
    provider,
    connection: {
      status,
      externalAccountId: null,
      scopes: [],
      lastCheckAt: now.toISOString(),
      lastErrorCode,
    },
    credentials: [],
    fieldErrors,
    message,
    setupSteps: [],
    callsMade,
  };
}

/**
 * Validate a pasted credential against the provider and, only on success, seal it.
 *
 * Returns everything A02 needs to persist and everything A05 needs to render. Returns no
 * credential at all on any failure path.
 */
export async function establishConnection(
  input: EstablishConnectionInput,
): Promise<ConnectionEstablishment> {
  const provider = input.provider;
  const name = PROVIDER_NAME[provider];
  const token = cleanPastedSecret(input.accessToken);
  const webhookSecret = cleanPastedSecret(input.webhookSecret);

  // --- step 1: shape. Free, and it catches the common mistakes. ------------
  const shapeProblem = checkTokenShape(provider, input.accessToken);
  if (shapeProblem !== null) {
    return refusal(
      provider,
      input.now,
      { [shapeProblem.field]: shapeProblem.message },
      `Nothing has been saved.`,
      0,
    );
  }
  const secretProblem =
    provider === RESEND_PROVIDER ? checkWebhookSecretShape(input.webhookSecret) : null;
  if (secretProblem !== null) {
    return refusal(
      provider,
      input.now,
      { [secretProblem.field]: secretProblem.message },
      `Nothing has been saved.`,
      0,
    );
  }

  // --- step 2: ask the provider. ------------------------------------------
  const connector = getConnector(provider, {
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const credentials: ConnectorCredentials = {
    accessToken: token,
    ...(webhookSecret === '' ? {} : { webhookSecret }),
  };
  const connection: ConnectionConfig = {
    provider,
    account_id: null,
    ...(input.correlationProperty === undefined
      ? {}
      : { correlation_property: input.correlationProperty }),
    ...(input.webhookVerifiedAt === undefined || input.webhookVerifiedAt === null
      ? {}
      : { webhook_verified_at: input.webhookVerifiedAt }),
  };

  let validation: ConnectionValidation;
  try {
    validation = await connector.validateConnection({ credentials, connection, now: input.now });
  } catch {
    // A throw from here is a bug on our side, not the customer's. Do not store anything,
    // and do not blame their token for it.
    return refusal(
      provider,
      input.now,
      {},
      `We could not check that ${name} token because something went wrong at our end. Nothing has been saved.`,
      1,
      'PROVIDER_UNAVAILABLE',
    );
  }

  if (validation.error !== null) {
    return refusal(
      provider,
      input.now,
      { access_token: customerMessageForError(provider, validation.error) },
      customerMessageForError(provider, validation.error),
      validation.calls_made,
      validation.error.code,
      statusForError(validation.error.code),
    );
  }

  if (validation.account_id === null) {
    // The credential worked but we could not say whose account it is. Attributing evidence
    // to an account we cannot name is exactly the thing this product exists not to do.
    return refusal(
      provider,
      input.now,
      {},
      `That ${name} token works, but we could not confirm which account it belongs to, so we have not saved it. Evidence we cannot attribute to your account is not evidence.`,
      validation.calls_made,
      'PROVIDER_UNAVAILABLE',
    );
  }

  // --- step 3: seal. Only reached when the provider answered successfully. --
  const sealed: SealedCredential[] = [
    {
      purpose: CREDENTIAL_PURPOSE.API_TOKEN,
      envelope: await sealCredentialFor(
        token,
        credentialAadParts(input.workspaceId, provider, CREDENTIAL_PURPOSE.API_TOKEN),
        input.wrappingKey,
      ),
    },
  ];
  if (webhookSecret !== '') {
    sealed.push({
      purpose: CREDENTIAL_PURPOSE.WEBHOOK_SECRET,
      envelope: await sealCredentialFor(
        webhookSecret,
        credentialAadParts(input.workspaceId, provider, CREDENTIAL_PURPOSE.WEBHOOK_SECRET),
        input.wrappingKey,
      ),
    });
  }

  // --- step 4: the status the evidence actually supports. -------------------
  //
  // `testing`, not `ready`, whenever anything is outstanding. For Resend that is the
  // normal case on first connect: a signing secret we have never seen used is a promise,
  // not a working webhook, and only a genuinely verified callback moves it on.
  const outstanding = validation.setup_steps;
  const status: ConnectionStatus = validation.ok && outstanding.length === 0 ? 'ready' : 'testing';

  return {
    ok: true,
    provider,
    connection: {
      status,
      externalAccountId: validation.account_id,
      scopes: validation.granted_scopes,
      lastCheckAt: validation.checked_at,
      lastErrorCode: null,
    },
    credentials: sealed,
    fieldErrors: {},
    message:
      status === 'ready'
        ? `Connected. We checked that token against ${name} and read back the account it belongs to.`
        : `That ${name} token works and we have saved it. The connection is not finished yet: see the step below. We will mark it ready when we have actually received a signed message, not before.`,
    setupSteps: outstanding,
    callsMade: validation.calls_made,
  };
}

// ---------------------------------------------------------------------------
// Re-validation — how a swapped token gets caught
// ---------------------------------------------------------------------------

/**
 * The failures that tell us nothing about the connection.
 *
 * A provider that is down, or that is refusing us for going too fast, is a fact about the
 * provider and about us. It is not evidence that the customer's credential is bad, that
 * their account changed, or that they never connected in the first place. A re-check that
 * learns nothing must therefore change nothing: `revalidateConnection` returns the status
 * the connection already had, and the caller reports the failed *check* separately.
 *
 * Getting this wrong is not cosmetic. `not_connected` is outside the scheduler's
 * `USABLE_STATUSES`, so demoting a healthy connection on a bad minute takes it out of
 * service for real runs until somebody presses a button at a luckier moment.
 */
const UNINFORMATIVE_ERRORS: ReadonlySet<ConnectorErrorCode> = new Set([
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
]);

export interface RevalidateInput {
  readonly provider: ProviderId;
  readonly credentials: ConnectorCredentials;
  readonly connection: ConnectionConfig;
  /**
   * The status this connection already has. Returned unchanged when the check cannot reach
   * the provider, so an outage never rewrites health we did not actually measure.
   */
  readonly currentStatus: ConnectionStatus;
  readonly now: Date;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface RevalidationResult {
  readonly provider: ProviderId;
  readonly status: ConnectionStatus;
  /** The account the credential belongs to *now*. */
  readonly externalAccountId: string | null;
  /**
   * True when the live account differs from the one this connection was set up with.
   * This is the condition that makes every piece of evidence we have attributed to this
   * connection suspect, so it is reported loudly rather than folded into a generic error.
   */
  readonly accountChanged: boolean;
  readonly scopes: readonly string[];
  readonly lastErrorCode: ConnectorErrorCode | null;
  /** Plain language for the owner panel and the customer. */
  readonly summary: string;
  readonly setupSteps: readonly ConnectionSetupStep[];
  readonly checkedAt: string;
  readonly callsMade: number;
}

/**
 * Re-check a stored connection against the provider.
 *
 * A04's own rule is that evidence is attributed to the account the *token* belongs to. A
 * token quietly swapped for one pointing at a different HubSpot portal would therefore
 * silently re-attribute every future run. Nothing in the evidence path can notice that on
 * its own — only this check can. A07 runs it on a cadence; the owner panel can run it on
 * demand.
 */
export async function revalidateConnection(input: RevalidateInput): Promise<RevalidationResult> {
  const name = PROVIDER_NAME[input.provider];
  const connector = getConnector(input.provider, {
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });

  let validation: ConnectionValidation;
  try {
    validation = await connector.validateConnection({
      credentials: input.credentials,
      connection: input.connection,
      now: input.now,
    });
  } catch {
    return {
      provider: input.provider,
      // "We have not changed anything about it" is the summary, so it had better be true
      // of the status as well as of the credential.
      status: input.currentStatus,
      externalAccountId: null,
      accountChanged: false,
      scopes: [],
      lastErrorCode: 'PROVIDER_UNAVAILABLE',
      summary: `We could not check the ${name} connection. We have not changed anything about it.`,
      setupSteps: [],
      checkedAt: input.now.toISOString(),
      callsMade: 1,
    };
  }

  if (validation.error !== null) {
    return {
      provider: input.provider,
      status: UNINFORMATIVE_ERRORS.has(validation.error.code)
        ? input.currentStatus
        : statusForError(validation.error.code),
      externalAccountId: null,
      accountChanged: false,
      scopes: [],
      lastErrorCode: validation.error.code,
      summary: customerMessageForError(input.provider, validation.error),
      setupSteps: validation.setup_steps,
      checkedAt: validation.checked_at,
      callsMade: validation.calls_made,
    };
  }

  const expected = input.connection.account_id;
  const actual = validation.account_id;
  const accountChanged = expected !== null && actual !== null && expected !== actual;

  if (accountChanged) {
    return {
      provider: input.provider,
      // Not `ready`. The credential works, but it is no longer the credential this
      // connection's history was built on.
      status: 'degraded',
      externalAccountId: actual,
      accountChanged: true,
      scopes: validation.granted_scopes,
      lastErrorCode: 'PERMISSION_MISSING',
      summary: `The ${name} credential now belongs to a different account than the one this connection was set up with. We have paused it rather than quietly attributing your results to the new account. Reconnect to confirm which account you want checked.`,
      setupSteps: validation.setup_steps,
      checkedAt: validation.checked_at,
      callsMade: validation.calls_made,
    };
  }

  const outstanding = validation.setup_steps;
  const ready = validation.ok && outstanding.length === 0;
  return {
    provider: input.provider,
    status: ready ? 'ready' : 'testing',
    externalAccountId: actual,
    accountChanged: false,
    scopes: validation.granted_scopes,
    lastErrorCode: null,
    summary: ready
      ? `The ${name} connection is working. We checked it against ${name} just now.`
      : `The ${name} credential works, but the connection is not finished. See the outstanding step.`,
    setupSteps: outstanding,
    checkedAt: validation.checked_at,
    callsMade: validation.calls_made,
  };
}

// ---------------------------------------------------------------------------
// The one way a Resend connection becomes ready
// ---------------------------------------------------------------------------

export interface WebhookReadinessResult {
  readonly ready: boolean;
  readonly status: ConnectionStatus;
  readonly summary: string;
  /** The provider event id that proved it, for the audit trail. */
  readonly provenBy: string | null;
}

/**
 * Promote a connection to `ready` on the strength of a webhook we actually verified.
 *
 * This function is the only route from `testing` to `ready` for a webhook-dependent
 * connection, and it takes the *verification result* rather than a boolean, so a caller
 * cannot assert readiness — it can only present evidence of it. An invalid verification,
 * or a valid one that produced no usable evidence, does not promote anything.
 */
export function markWebhookVerified(
  provider: ProviderId,
  verification: WebhookVerification,
): WebhookReadinessResult {
  const name = PROVIDER_NAME[provider];
  if (!verification.valid) {
    return {
      ready: false,
      status: 'testing',
      summary: `We received a message on the ${name} webhook but could not verify its signature, so the connection is still unproven.`,
      provenBy: null,
    };
  }
  if (verification.evidence.length === 0) {
    // A signed callback we could not turn into evidence proves the endpoint and the secret
    // are right, but not that we can use what arrives. Honest middle ground: still testing.
    return {
      ready: false,
      status: 'testing',
      summary: `A correctly signed ${name} message arrived, but it was not an event we can use as delivery evidence. The connection is not finished.`,
      provenBy: verification.event_id,
    };
  }
  return {
    ready: true,
    status: 'ready',
    summary: `A correctly signed ${name} message arrived and we could read it. This connection is now proven end to end, not assumed.`,
    provenBy: verification.event_id,
  };
}

// ---------------------------------------------------------------------------
// Opening what was stored
// ---------------------------------------------------------------------------

export interface StoredCredentials {
  readonly apiToken: CredentialEnvelope;
  readonly webhookSecret?: CredentialEnvelope | undefined;
}

/**
 * Open sealed envelopes into the `ConnectorCredentials` a fetch needs.
 *
 * Always `openCredentialFor`, never `openCredential`: the AAD is rebuilt here from the
 * workspace, provider and purpose this caller believes it is acting for, so a ciphertext
 * row copied from another tenant fails to open instead of decrypting into this one.
 */
export async function openConnectionCredentials(
  stored: StoredCredentials,
  context: { readonly workspaceId: string; readonly provider: ProviderId },
  key: { readonly keyBase64: string },
): Promise<ConnectorCredentials> {
  const accessToken = await openCredentialFor(
    stored.apiToken,
    credentialAadParts(context.workspaceId, context.provider, CREDENTIAL_PURPOSE.API_TOKEN),
    key,
  );
  if (stored.webhookSecret === undefined) return { accessToken };
  const webhookSecret = await openCredentialFor(
    stored.webhookSecret,
    credentialAadParts(context.workspaceId, context.provider, CREDENTIAL_PURPOSE.WEBHOOK_SECRET),
    key,
  );
  return { accessToken, webhookSecret };
}

/**
 * A label for a connected account that is safe to render.
 *
 * Built fresh from the *account id* — which is not a secret; HubSpot's portal id is on
 * every page of their UI — and never from the credential. Rule 7 forbids serialising a
 * stored credential back out even masked, so this never touches one.
 */
export function accountLabel(
  provider: ProviderId,
  externalAccountId: string | null,
): string | null {
  if (externalAccountId === null || externalAccountId === '') return null;
  if (provider === 'hubspot') return `HubSpot account ${externalAccountId}`;
  // The Resend identifier is a fingerprint of the key, not a name Resend publishes, so it
  // is described as what it is rather than dressed up as an account name.
  return `Resend key ${externalAccountId.replace(/^resend-key-/, '').slice(0, 8)}`;
}
