/**
 * CUST-2xx — the public support form, validated without a database.
 *
 * The property being defended is availability, not tidiness: this path has to work for a
 * signed-out visitor, and it has to keep working when the rest of the service is paused.
 */
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_REACHABLE_PATHS,
  FORM_LIMITS,
  isReachableWhilePaused,
  payloadWithinLimit,
  validateSupportForm,
} from '@app/support/form';
import { SUPPORT_LIMITS } from '@app/support/cases';

const valid = {
  email: 'Ada@Example.com',
  subject: '  Cannot reconnect HubSpot  ',
  message: 'The connection says the authorisation expired and reconnecting does nothing.',
  runId: '',
};

describe('support form validation', () => {
  it('CUST-240 a valid submission parses and normalises the address and subject', () => {
    const result = validateSupportForm(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe('ada@example.com');
    expect(result.value.subject).toBe('Cannot reconnect HubSpot');
    expect(result.value.runId).toBeNull();
  });

  it('CUST-241 a missing address is a field error, not an exception', () => {
    const result = validateSupportForm({ ...valid, email: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toContain('email');
    expect(result.errors[0]?.message).toMatch(/reply/i);
  });

  it('CUST-242 an oversized message is rejected by byte length, not character count', () => {
    // Multi-byte characters: 10,000 of them are well under the character cap but over
    // the byte cap, which is the one that decides what we actually store.
    const message = 'é'.repeat(SUPPORT_LIMITS.MAX_BODY_BYTES);
    const result = validateSupportForm({ ...valid, message });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toContain('message');
  });

  it('CUST-243 an oversized raw payload is refused before anything is parsed', () => {
    expect(payloadWithinLimit(FORM_LIMITS.MAX_PAYLOAD_BYTES)).toBe(true);
    expect(payloadWithinLimit(FORM_LIMITS.MAX_PAYLOAD_BYTES + 1)).toBe(false);
    expect(payloadWithinLimit(Number.NaN)).toBe(false);
  });

  it('CUST-244 a non-object payload is rejected without throwing', () => {
    for (const raw of [null, undefined, 'a string', 42, ['a'], true]) {
      const result = validateSupportForm(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('CUST-245 a malformed run reference is rejected, and a blank one is accepted', () => {
    const bad = validateSupportForm({ ...valid, runId: 'run_123' });
    expect(bad.ok).toBe(false);
    const blank = validateSupportForm({ ...valid, runId: '   ' });
    expect(blank.ok).toBe(true);
  });

  it('CUST-246 support, cancellation and the legal pages stay reachable while the service is paused', () => {
    expect(isReachableWhilePaused('/support')).toBe(true);
    expect(isReachableWhilePaused('/support/submit')).toBe(true);
    expect(isReachableWhilePaused('/account/cancel')).toBe(true);
    expect(isReachableWhilePaused('/account/delete')).toBe(true);
    expect(isReachableWhilePaused('/legal/privacy')).toBe(true);
    // A query string does not smuggle a route past the check either way.
    expect(isReachableWhilePaused('/support?topic=billing')).toBe(true);
  });

  it('CUST-247 an ordinary application route is not reachable while paused', () => {
    expect(isReachableWhilePaused('/app/runs')).toBe(false);
    expect(isReachableWhilePaused('/api/v1/events')).toBe(false);
    // Not a prefix match on a different route that merely starts with the same letters.
    expect(isReachableWhilePaused('/supported-workflows')).toBe(false);
  });

  it('CUST-248 the always-reachable list names both support and cancellation', () => {
    expect(ALWAYS_REACHABLE_PATHS).toContain('/support');
    expect(ALWAYS_REACHABLE_PATHS).toContain('/account/cancel');
  });
});
