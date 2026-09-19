/**
 * Frozen contract v1 — structured error codes.
 * Connector errors distinguish terminal configuration problems from retryable transport problems.
 * See plan §17.1.
 */

export const CONNECTOR_ERROR_CODE = [
  'AUTH_EXPIRED',
  'PERMISSION_MISSING',
  'NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'AMBIGUOUS_MATCH',
  'UNSUPPORTED_CAPABILITY',
  'INVALID_EVIDENCE',
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODE)[number];

/** Codes for which a bounded retry can plausibly succeed without customer action. */
export const RETRYABLE_CONNECTOR_ERRORS: ReadonlySet<ConnectorErrorCode> = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
]);

/** Codes that require the customer or owner to change configuration or re-authorise. */
export const TERMINAL_CONNECTOR_ERRORS: ReadonlySet<ConnectorErrorCode> = new Set([
  'AUTH_EXPIRED',
  'PERMISSION_MISSING',
  'UNSUPPORTED_CAPABILITY',
]);

export function isRetryableConnectorError(code: ConnectorErrorCode): boolean {
  return RETRYABLE_CONNECTOR_ERRORS.has(code);
}

/** Machine-readable reason codes attached to assertions, translated to plain language in the UI. */
export const REASON_CODE = [
  'MATCHED',
  'VALUE_MISMATCH',
  'RECORD_NOT_FOUND',
  'RECORD_AMBIGUOUS',
  'RECORD_WRONG_ACCOUNT',
  'EVENT_NOT_OBSERVED',
  'STATUS_NOT_REACHED',
  'OUTSIDE_TIME_WINDOW',
  'EVIDENCE_UNAVAILABLE',
  /** The provider answered but omitted this field. Distinct from an outage. */
  'EVIDENCE_NOT_RETURNED',
  /** Rejected because its only source was the customer's own claim, which is not independent. */
  'CLAIM_NOT_INDEPENDENT',
  'CONNECTION_UNAVAILABLE',
  'DEADLINE_PASSED',
  'AWAITING_EVIDENCE',
  'CORRELATION_MISSING',
  'RULE_UNSUPPORTED',
] as const;
export type ReasonCode = (typeof REASON_CODE)[number];

/** Public API error envelope. Never carries stack traces or internal identifiers. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly retry_after_seconds?: number;
  };
}

export class AppError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`${code}: ${publicMessage}`);
    this.name = 'AppError';
  }
}
