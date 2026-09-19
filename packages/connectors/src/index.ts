/**
 * `@verify/connectors` — the only code in the product that talks to a provider.
 *
 * The registry is deliberately tiny and deliberately closed: `getConnector` accepts a
 * `ProviderId` and nothing else, so a provider name arriving from a database row, a URL
 * segment or a customer form cannot reach a connector without passing `isSupportedProvider`
 * first.
 */
export {
  SUPPORTED_PROVIDERS,
  isWebhookCapable,
  makeGap,
  makeAuthoritativeAbsenceGap,
  toEvidenceBundle,
  totalCalls,
  type ClassifiedError,
  type ConnectionConfig,
  type ConnectionSetupStep,
  type ConnectionValidation,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorCredentials,
  type ConnectorFetchResult,
  type EvidenceKind,
  type EvidenceLocator,
  type FetchEvidenceInput,
  type NormaliseContext,
  type NormaliseResult,
  type ProviderErrorInput,
  type ProviderId,
  type RevokeResult,
  type WebhookCapableConnector,
  type WebhookVerification,
  type WebhookVerificationInput,
} from './types.js';

export {
  ConnectorTransportError,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECT_HOPS,
  PROVIDER_BASE_URL,
  USER_AGENT,
  guardedFetch,
  parseJsonBody,
  pathSegment,
  providerUrl,
  readRetryAfterSeconds,
  redactSecrets,
  type GuardedRequest,
  type GuardedResponse,
  type SafeMethod,
  type TransportFailure,
} from './http.js';

/**
 * Re-exported so `tests/security/unit/url-guard.test.ts` can be re-pointed at the
 * production implementation with a one-line import change, as A10 asked.
 */
export {
  CONNECTOR_ALLOWED_HOSTS,
  CONNECTOR_URL_GUARD_OPTIONS,
  PROVIDER_ALLOWLIST,
  checkRedirect,
  checkResolvedAddress,
  checkUrl,
  isPrivateAddress,
  normaliseHost,
  parseIpLiteral,
  parseIpv4Loose,
  parseIpv6Loose,
  type UrlGuardOptions,
  type UrlGuardReason,
  type UrlGuardResult,
} from './url-guard.js';

export {
  RETRY_STOP,
  withTransportRetry,
  type AttemptOutcome,
  type TransportRetryOptions,
  type TransportRetryResult,
} from './retry.js';

export {
  HUBSPOT_PROVIDER,
  HUBSPOT_READ_SCOPE,
  HubSpotConnector,
  MAX_REQUESTED_PROPERTIES,
  SEARCH_PROBE_LIMIT,
  classifyHubSpotError,
  hubspotConnector,
  normaliseHubSpotContact,
  resolveHubSpotAccount,
  selectProperties,
  type HubSpotAccountIdentity,
  type HubSpotFetchOptions,
} from './hubspot.js';

export {
  RESEND_EVENT_STATUS,
  RESEND_LAST_EVENT_STATUS,
  RESEND_PROVIDER,
  RESEND_WEBHOOK_TOLERANCE_SECONDS,
  ResendConnector,
  classifyResendError,
  mapResendEventType,
  mapResendLastEvent,
  normaliseResendEvent,
  resendAccountFingerprint,
  resendConnector,
  type ResendFetchOptions,
} from './resend.js';

export { getConnector, isSupportedProvider, type ConnectorRuntimeOptions } from './registry.js';

export {
  CREDENTIAL_PURPOSE,
  accountLabel,
  checkTokenShape,
  checkWebhookSecretShape,
  credentialAadParts,
  establishConnection,
  markWebhookVerified,
  openConnectionCredentials,
  revalidateConnection,
  type ConnectionEstablishment,
  type CredentialPurpose,
  type EstablishConnectionInput,
  type RevalidateInput,
  type RevalidationResult,
  type SealedCredential,
  type StoredCredentials,
  type TokenShapeProblem,
  type WebhookReadinessResult,
  type WrappingKey,
} from './connect.js';

export {
  crmPropertiesFor,
  runProof,
  type ProofRunInput,
  type ProofRunResult,
  type ProofShortfall,
  type ProofSource,
  type ProofSourceReport,
} from './proof.js';

export {
  allSetupGuides,
  setupGuide,
  type ProviderSetupGuide,
  type SetupField,
  type SetupInstruction,
} from './setup.js';
