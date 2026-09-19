import { describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { errorResponse, errors, jsonResponse, renderError } from '@app/lib/errors';

const REQUEST_ID = 'lse_01J8ABCDEFGHJKMNPQRSTVWXYZ';

function capture() {
  const entries: unknown[] = [];
  return { entries, log: (entry: unknown) => void entries.push(entry) };
}

describe('error handler', () => {
  it('API-160 renders an AppError into the public envelope', () => {
    const { log, entries } = capture();
    const rendered = renderError(errors.notFound('That run does not exist.'), REQUEST_ID, log);
    expect(rendered.status).toBe(404);
    expect(rendered.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'That run does not exist.',
        request_id: REQUEST_ID,
      },
    });
    expect(entries).toHaveLength(1);
  });

  it('API-161 includes retry_after_seconds and the Retry-After header when present', () => {
    const { log } = capture();
    const rendered = renderError(errors.rateLimited(42), REQUEST_ID, log);
    expect(rendered.status).toBe(429);
    expect(rendered.body.error.retry_after_seconds).toBe(42);
    expect(rendered.headers['retry-after']).toBe('42');
  });

  it('API-162 omits retry_after_seconds entirely when there is none', () => {
    const { log } = capture();
    const rendered = renderError(errors.forbidden(), REQUEST_ID, log);
    expect('retry_after_seconds' in rendered.body.error).toBe(false);
    expect(rendered.headers['retry-after']).toBeUndefined();
  });

  it('API-163 turns an unexpected throw into a generic 500 that leaks nothing', () => {
    const { log, entries } = capture();
    const cause = new Error('D1_ERROR: UNIQUE constraint failed: users.auth_subject (ada@example.com)');
    const rendered = renderError(cause, REQUEST_ID, log);
    expect(rendered.status).toBe(500);
    expect(rendered.body.error.code).toBe('INTERNAL');
    const serialised = JSON.stringify(rendered.body);
    expect(serialised).not.toContain('UNIQUE');
    expect(serialised).not.toContain('auth_subject');
    expect(serialised).not.toContain('ada@example.com');
    expect(rendered.body.error.request_id).toBe(REQUEST_ID);
    // The real cause is logged against the same request id, so it is still diagnosable.
    expect(JSON.stringify(entries)).toContain('UNIQUE');
    expect(JSON.stringify(entries)).toContain(REQUEST_ID);
  });

  it('API-164 handles a thrown non-Error without throwing itself', () => {
    const { log } = capture();
    expect(() => renderError('a bare string', REQUEST_ID, log)).not.toThrow();
    expect(renderError({ weird: true }, REQUEST_ID, log).status).toBe(500);
    expect(renderError(undefined, REQUEST_ID, log).body.error.code).toBe('INTERNAL');
  });

  it('API-165 errorResponse carries the request id in a header and a JSON content type', async () => {
    const { log } = capture();
    const response = errorResponse(new AppError(422, 'INVALID_CONFIGURATION', 'Bad rules.'), REQUEST_ID, log);
    expect(response.status).toBe(422);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_CONFIGURATION', message: 'Bad rules.', request_id: REQUEST_ID },
    });
  });

  it('API-166 jsonResponse attaches the request id to successes too', async () => {
    const response = jsonResponse({ ok: true }, REQUEST_ID, 202);
    expect(response.status).toBe(202);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('API-167 the error constructors use the statuses the brief mandates', () => {
    expect(errors.badRequest('x').httpStatus).toBe(400);
    expect(errors.unauthorised().httpStatus).toBe(401);
    expect(errors.forbidden().httpStatus).toBe(403);
    expect(errors.notFound().httpStatus).toBe(404);
    expect(errors.conflict('x').httpStatus).toBe(409);
    expect(errors.conflict('x').code).toBe('IDEMPOTENCY_CONFLICT');
    expect(errors.payloadTooLarge().httpStatus).toBe(413);
    expect(errors.unprocessable('x').httpStatus).toBe(422);
    expect(errors.rateLimited(1).httpStatus).toBe(429);
    expect(errors.paymentRequired('x').httpStatus).toBe(402);
    expect(errors.unavailable(5).httpStatus).toBe(503);
  });

  it('API-168 never returns a stack trace', () => {
    const { log } = capture();
    const cause = new Error('boom');
    const rendered = renderError(cause, REQUEST_ID, log);
    expect(JSON.stringify(rendered)).not.toContain('at ');
    expect(JSON.stringify(rendered)).not.toContain('boom');
  });
});
