/**
 * Signature verification.
 *
 * Every rejection path has its own case and its own reason code, because "invalid
 * signature" in a log is useless when a customer's integration stops working at 3am.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hmacSha256Hex,
  signRequest,
  signStripe,
  signSvix,
  toBase64,
  utf8Bytes,
  verifyRequest,
  verifyStripeSignature,
  verifySvixSignature,
} from '@verify/security';
import { SIGNATURE_TOLERANCE_SECONDS } from '@verify/contracts';

const SECRET = 'wf_signing_secret_value';
const BODY = '{"schema_version":1,"event_id":"evt_00000001"}';
const NOW = Date.UTC(2026, 8, 19, 10, 0, 0);
const NOW_UNIX = Math.floor(NOW / 1000);

describe('our own request signature', () => {
  it('API-040 accepts a signature produced by signRequest', async () => {
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: NOW_UNIX });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const result = await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW });
    expect(result).toEqual({ valid: true, timestamp: NOW_UNIX });
  });

  it('API-041 rejects a missing header', async () => {
    expect(await verifyRequest({ secret: SECRET, header: null, rawBody: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'missing_header',
    });
    expect(await verifyRequest({ secret: SECRET, header: '   ', rawBody: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'missing_header',
    });
  });

  it('API-042 rejects a malformed header', async () => {
    for (const header of ['garbage', 't=abc,v1=deadbeef', 'v1=deadbeef,t=1,t=2', '=,=']) {
      const result = await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(['malformed_header', 'missing_signature']).toContain(result.reason);
    }
  });

  it('API-043 rejects a header with a timestamp but no v1 value', async () => {
    const result = await verifyRequest({
      secret: SECRET,
      header: `t=${NOW_UNIX},v0=abc`,
      rawBody: BODY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('API-044 rejects a stale timestamp just outside the tolerance', async () => {
    const stale = NOW_UNIX - SIGNATURE_TOLERANCE_SECONDS - 1;
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: stale });
    expect(await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'timestamp_stale',
    });
  });

  it('API-045 accepts a timestamp at the edge of the tolerance', async () => {
    const edge = NOW_UNIX - SIGNATURE_TOLERANCE_SECONDS;
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: edge });
    const result = await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW });
    expect(result.valid).toBe(true);
  });

  it('API-046 rejects a timestamp too far in the future', async () => {
    const future = NOW_UNIX + SIGNATURE_TOLERANCE_SECONDS + 1;
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: future });
    expect(await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'timestamp_in_future',
    });
  });

  it('API-047 rejects a signature made with the wrong secret', async () => {
    const header = await signRequest({ secret: 'other-secret', rawBody: BODY, timestamp: NOW_UNIX });
    expect(await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('API-048 rejects a modified body byte', async () => {
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: NOW_UNIX });
    const tampered = BODY.replace('evt_00000001', 'evt_00000002');
    expect(await verifyRequest({ secret: SECRET, header, rawBody: tampered, now: NOW })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('API-049 rejects a replay of an identical request once it falls outside the tolerance', async () => {
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: NOW_UNIX });
    // Same bytes, same signature, replayed later.
    const later = NOW + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000;
    expect(await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: NOW })).toMatchObject({
      valid: true,
    });
    expect(await verifyRequest({ secret: SECRET, header, rawBody: BODY, now: later })).toEqual({
      valid: false,
      reason: 'timestamp_stale',
    });
  });

  it('API-050 signs over the timestamp, so a re-stamped header does not verify', async () => {
    const header = await signRequest({ secret: SECRET, rawBody: BODY, timestamp: NOW_UNIX - 400 });
    const restamped = header.replace(/^t=\d+/, `t=${NOW_UNIX}`);
    expect(await verifyRequest({ secret: SECRET, header: restamped, rawBody: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('API-051 verifies over raw bytes, not a re-serialised object', async () => {
    const raw = utf8Bytes('{"b":1,"a":2}');
    const header = await signRequest({ secret: SECRET, rawBody: raw, timestamp: NOW_UNIX });
    expect(await verifyRequest({ secret: SECRET, header, rawBody: raw, now: NOW })).toMatchObject({
      valid: true,
    });
    const reserialised = JSON.stringify(JSON.parse('{"b":1,"a":2}'));
    expect(
      await verifyRequest({ secret: SECRET, header, rawBody: `${reserialised} `, now: NOW }),
    ).toEqual({ valid: false, reason: 'signature_mismatch' });
  });
});

describe('Stripe webhook signature', () => {
  // secret-scan:allow synthetic webhook secret; signs nothing that exists
  const STRIPE_SECRET = 'whsec_stripe_test_secret';

  it('API-060 accepts a correctly signed payload', async () => {
    const header = await signStripe(BODY, NOW_UNIX, STRIPE_SECRET);
    expect(await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW)).toMatchObject({
      valid: true,
    });
  });

  it('API-061 matches the documented construction: HMAC-SHA256 over `${t}.${body}`', async () => {
    // Independent computation, so this asserts the documented scheme rather than our own.
    const expected = createHmac('sha256', STRIPE_SECRET)
      .update(`${NOW_UNIX}.${BODY}`, 'utf8')
      .digest('hex');
    expect(expected).toBe(await hmacSha256Hex(STRIPE_SECRET, `${NOW_UNIX}.${BODY}`));
    const header = `t=${NOW_UNIX},v1=${expected}`;
    expect(await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW)).toMatchObject({
      valid: true,
    });
  });

  it('API-062 ignores the v0 test scheme rather than accepting it', async () => {
    const v0 = await hmacSha256Hex(STRIPE_SECRET, `${NOW_UNIX}.${BODY}`);
    const header = `t=${NOW_UNIX},v0=${v0}`;
    expect(await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
  });

  it('API-063 accepts when one of several v1 signatures matches (rolled secret)', async () => {
    const good = await hmacSha256Hex(STRIPE_SECRET, `${NOW_UNIX}.${BODY}`);
    const header = `t=${NOW_UNIX},v1=${'0'.repeat(64)},v1=${good}`;
    expect(await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW)).toMatchObject({
      valid: true,
    });
  });

  it('API-064 rejects a stale timestamp beyond the five-minute default', async () => {
    const header = await signStripe(BODY, NOW_UNIX - 301, STRIPE_SECRET);
    expect(await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'timestamp_stale',
    });
  });

  it('API-065 rejects a future timestamp beyond the tolerance', async () => {
    const header = await signStripe(BODY, NOW_UNIX + 301, STRIPE_SECRET);
    expect(await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'timestamp_in_future',
    });
  });

  it('API-066 rejects a wrong secret, a modified body and a missing header distinctly', async () => {
    const header = await signStripe(BODY, NOW_UNIX, STRIPE_SECRET);
    expect(await verifyStripeSignature(BODY, header, 'whsec_other', NOW)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
    expect(await verifyStripeSignature(`${BODY} `, header, STRIPE_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
    expect(await verifyStripeSignature(BODY, null, STRIPE_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'missing_header',
    });
    expect(await verifyStripeSignature(BODY, header, '', NOW)).toEqual({
      valid: false,
      reason: 'malformed_secret',
    });
  });

  it('API-067 verifies against raw bytes, so whitespace normalisation fails', async () => {
    const raw = utf8Bytes(BODY);
    const header = await signStripe(raw, NOW_UNIX, STRIPE_SECRET);
    expect(await verifyStripeSignature(raw, header, STRIPE_SECRET, NOW)).toMatchObject({
      valid: true,
    });
    expect(
      await verifyStripeSignature(JSON.stringify(JSON.parse(BODY), null, 2), header, STRIPE_SECRET, NOW),
    ).toEqual({ valid: false, reason: 'signature_mismatch' });
  });
});

describe('Svix / Resend webhook signature', () => {
  // whsec_ + base64 of 24 bytes, shaped exactly as Svix issues them.
  // secret-scan:allow synthetic webhook secret; signs nothing that exists
  const SVIX_SECRET = `whsec_${toBase64(utf8Bytes('resend-webhook-secret-24'))}`;
  const MSG_ID = 'msg_2abcDEF';

  const headers = (signature: string, timestamp = String(NOW_UNIX), id = MSG_ID) => ({
    id,
    timestamp,
    signature,
  });

  it('API-070 accepts a correctly signed Svix payload', async () => {
    const signature = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    expect(signature).toMatch(/^v1,/);
    expect(await verifySvixSignature(BODY, headers(signature), SVIX_SECRET, NOW)).toMatchObject({
      valid: true,
    });
  });

  it('API-071 signs `${id}.${timestamp}.${body}` with the base64-decoded secret', async () => {
    // Computed with Node's own HMAC, independently of the implementation under test.
    const expected = createHmac('sha256', Buffer.from('resend-webhook-secret-24', 'utf8'))
      .update(`${MSG_ID}.${NOW_UNIX}.${BODY}`, 'utf8')
      .digest('base64');
    expect(
      await verifySvixSignature(BODY, headers(`v1,${expected}`), SVIX_SECRET, NOW),
    ).toMatchObject({ valid: true });
  });

  it('API-072 accepts a space-delimited list containing one good signature', async () => {
    const good = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    const header = `v1,${toBase64(utf8Bytes('not-the-signature'))} ${good}`;
    expect(await verifySvixSignature(BODY, headers(header), SVIX_SECRET, NOW)).toMatchObject({
      valid: true,
    });
  });

  it('API-073 ignores non-v1 versions', async () => {
    const good = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    const v2Only = good.replace('v1,', 'v2,');
    expect(await verifySvixSignature(BODY, headers(v2Only), SVIX_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
  });

  it('API-074 rejects when any of the three headers is missing', async () => {
    const good = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    expect(
      await verifySvixSignature(BODY, { id: null, timestamp: String(NOW_UNIX), signature: good }, SVIX_SECRET, NOW),
    ).toEqual({ valid: false, reason: 'missing_header' });
    expect(
      await verifySvixSignature(BODY, { id: MSG_ID, timestamp: null, signature: good }, SVIX_SECRET, NOW),
    ).toEqual({ valid: false, reason: 'missing_header' });
    expect(
      await verifySvixSignature(BODY, { id: MSG_ID, timestamp: String(NOW_UNIX), signature: null }, SVIX_SECRET, NOW),
    ).toEqual({ valid: false, reason: 'missing_header' });
  });

  it('API-075 rejects a stale and a future timestamp distinctly', async () => {
    const stale = NOW_UNIX - 301;
    const future = NOW_UNIX + 301;
    expect(
      await verifySvixSignature(
        BODY,
        headers(await signSvix(BODY, MSG_ID, stale, SVIX_SECRET), String(stale)),
        SVIX_SECRET,
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'timestamp_stale' });
    expect(
      await verifySvixSignature(
        BODY,
        headers(await signSvix(BODY, MSG_ID, future, SVIX_SECRET), String(future)),
        SVIX_SECRET,
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'timestamp_in_future' });
  });

  it('API-076 rejects a different message id, a modified body and a wrong secret', async () => {
    const good = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    expect(
      await verifySvixSignature(BODY, headers(good, String(NOW_UNIX), 'msg_other'), SVIX_SECRET, NOW),
    ).toEqual({ valid: false, reason: 'signature_mismatch' });
    expect(await verifySvixSignature(`${BODY} `, headers(good), SVIX_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
    expect(
      await verifySvixSignature(
        BODY,
        headers(good),
        `whsec_${toBase64(utf8Bytes('a-completely-other-key!!'))}`,
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('API-077 rejects a malformed timestamp and a malformed secret', async () => {
    const good = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    expect(await verifySvixSignature(BODY, headers(good, 'not-a-number'), SVIX_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'malformed_header',
    });
    expect(await verifySvixSignature(BODY, headers(good), 'whsec_', NOW)).toEqual({
      valid: false,
      reason: 'malformed_secret',
    });
    expect(await verifySvixSignature(BODY, headers(good), 'whsec_not base64!', NOW)).toEqual({
      valid: false,
      reason: 'malformed_secret',
    });
  });

  it('API-078 rejects a signature entry with no version prefix', async () => {
    const good = await signSvix(BODY, MSG_ID, NOW_UNIX, SVIX_SECRET);
    const stripped = good.slice('v1,'.length);
    expect(await verifySvixSignature(BODY, headers(stripped), SVIX_SECRET, NOW)).toEqual({
      valid: false,
      reason: 'malformed_header',
    });
  });
});
