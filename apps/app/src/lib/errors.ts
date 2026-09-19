/**
 * The single place a thrown value becomes an HTTP response.
 *
 * Two rules, both from the engineering brief:
 *  - A thrown `AppError` becomes its declared status with the public envelope.
 *  - Anything else becomes a generic 500 that leaks nothing at all. The real cause is
 *    logged against the request id so an operator can correlate the two; it is never
 *    written into the body, a header or a status line.
 */
import { AppError, type ApiErrorBody } from '@verify/contracts';

export interface ErrorRenderResult {
  readonly status: number;
  readonly body: ApiErrorBody;
  readonly headers: Record<string, string>;
}

/** What we log. Deliberately a function so a test can capture it without a global. */
export type ErrorLogger = (entry: {
  readonly request_id: string;
  readonly level: 'error';
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly stack?: string;
}) => void;

const defaultLogger: ErrorLogger = (entry) => {
  // Structured, single line, no customer payload. Workers ships this to the tail.
  console.error(JSON.stringify(entry));
};

const GENERIC_MESSAGE = 'Something went wrong on our side. The problem has been recorded.';

/**
 * Turn any thrown value into the public envelope. Never throws itself — an error handler
 * that can fail is not an error handler.
 */
export function renderError(
  error: unknown,
  requestId: string,
  log: ErrorLogger = defaultLogger,
): ErrorRenderResult {
  if (error instanceof AppError) {
    // An AppError's message is written by us and is safe to return by construction.
    log({
      request_id: requestId,
      level: 'error',
      code: error.code,
      status: error.httpStatus,
      message: error.publicMessage,
    });
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.publicMessage,
        request_id: requestId,
        ...(error.retryAfterSeconds !== undefined
          ? { retry_after_seconds: error.retryAfterSeconds }
          : {}),
      },
    };
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (error.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(error.retryAfterSeconds);
    }
    return { status: error.httpStatus, body, headers };
  }

  // Unexpected. Log the real cause; return nothing derived from it.
  const cause = error instanceof Error ? error : new Error(String(error));
  log({
    request_id: requestId,
    level: 'error',
    code: 'INTERNAL',
    status: 500,
    message: cause.message,
    ...(cause.stack !== undefined ? { stack: cause.stack } : {}),
  });
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: GENERIC_MESSAGE, request_id: requestId } },
    headers: { 'content-type': 'application/json; charset=utf-8' },
  };
}

/** `renderError` as a `Response`, for routes that return one directly. */
export function errorResponse(
  error: unknown,
  requestId: string,
  log: ErrorLogger = defaultLogger,
): Response {
  const rendered = renderError(error, requestId, log);
  return new Response(JSON.stringify(rendered.body), {
    status: rendered.status,
    headers: { ...rendered.headers, 'x-request-id': requestId },
  });
}

/** JSON success response with the request id attached, for symmetry with errorResponse. */
export function jsonResponse(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
    },
  });
}

// ---------------------------------------------------------------------------
// Constructors for the errors this system actually raises.
// Keeping them here stops the same condition acquiring three different codes.
// ---------------------------------------------------------------------------

export const errors = {
  badRequest: (message: string, code = 'INVALID_REQUEST') => new AppError(400, code, message),
  unauthorised: (message = 'Sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have access to this workspace.') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message: string, code = 'IDEMPOTENCY_CONFLICT') => new AppError(409, code, message),
  payloadTooLarge: (message = 'The request body is too large.') =>
    new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  unprocessable: (message: string, code = 'INVALID_CONFIGURATION') =>
    new AppError(422, code, message),
  rateLimited: (retryAfterSeconds: number, message = 'Too many requests. Try again shortly.') =>
    new AppError(429, 'RATE_LIMITED', message, retryAfterSeconds),
  paymentRequired: (message: string, code = 'ALLOWANCE_EXHAUSTED') =>
    new AppError(402, code, message),
  unavailable: (retryAfterSeconds: number, message = 'A dependency is unavailable.') =>
    new AppError(503, 'DEPENDENCY_UNAVAILABLE', message, retryAfterSeconds),
} as const;
