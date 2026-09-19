/**
 * SEC-4xx — provider webhook forgery, tampering and replay.
 *
 * Schemes verified against vendor docs on 2026-09-19 — see the header comment of
 * `tests/security/helpers/webhooks.ts` for the exact citations.
 *
 * Nothing in `apps/app/src/routes/webhooks/` exists yet, so these cases prove the
 * REFERENCE verifier. A06/A04 must re-point this file at the production verifier once
 * it lands; the assertions must not change.
 */
import { describe, it, expect } from 'vitest';
import {
  verifyStripeSignature,
  verifySvixSignature,
  signStripe,
  signSvix,
  STRIPE_TOLERANCE_SECONDS,
} from '../helpers/webhooks.js';

const enc = new TextEncoder();
const STRIPE_SECRET = 'whsec_synthetic_test_secret_not_a_real_key'; // secret-scan:allow
// base64 of 32 synthetic bytes — Svix secrets are base64 after the prefix.
const SVIX_SECRET = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`; // secret-scan:allow
const NOW = 1_770_000_000;

const BODY = enc.encode(
  JSON.stringify({ id: 'evt_test_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }),
);

describe('Stripe webhook signatures', () => {
  it('SEC-401 accepts a correctly signed body', async () => {
    const header = await signStripe(BODY, STRIPE_SECRET, NOW);
    const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(true);
  });

  it('SEC-402 rejects a forged signature', async () => {
    const header = `t=${NOW},v1=${'0'.repeat(64)}`;
    const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature_mismatch');
  });

  it('SEC-403 rejects a single tampered body byte', async () => {
    const header = await signStripe(BODY, STRIPE_SECRET, NOW);
    const tampered = new Uint8Array(BODY);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] as number) ^ 0x01;
    const r = await verifyStripeSignature({ rawBody: tampered, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(false);
  });

  it('SEC-404 rejects a re-serialised body that is semantically identical', async () => {
    // The trap: `JSON.stringify(await c.req.json())` reorders nothing but changes
    // whitespace/number formatting. Verification MUST use the raw bytes.
    const header = await signStripe(BODY, STRIPE_SECRET, NOW);
    const reserialised = enc.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(BODY)), null, 2));
    const r = await verifyStripeSignature({
      rawBody: reserialised,
      header,
      secret: STRIPE_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it('SEC-405 rejects a replayed delivery outside the 300s tolerance', async () => {
    const header = await signStripe(BODY, STRIPE_SECRET, NOW);
    const r = await verifyStripeSignature({
      rawBody: BODY,
      header,
      secret: STRIPE_SECRET,
      nowSeconds: NOW + STRIPE_TOLERANCE_SECONDS + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_out_of_tolerance');
  });

  it('SEC-406 rejects a future-dated timestamp as well as a stale one', async () => {
    const header = await signStripe(BODY, STRIPE_SECRET, NOW + 10_000);
    const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_out_of_tolerance');
  });

  it('SEC-407 ignores the v0 scheme (downgrade attack)', async () => {
    // Stripe docs: "To prevent downgrade attacks, ignore all schemes that aren't v1."
    const header = `t=${NOW},v0=${'a'.repeat(64)}`;
    const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_supported_scheme');
  });

  it('SEC-408 accepts either signature during a secret roll (two v1 values)', async () => {
    const good = await signStripe(BODY, STRIPE_SECRET, NOW);
    const goodHex = good.slice(good.indexOf('v1=') + 3);
    const header = `t=${NOW},v1=${'b'.repeat(64)},v1=${goodHex}`;
    const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(true);
  });

  it('SEC-409 rejects a missing or malformed header instead of defaulting to trust', async () => {
    for (const header of [null, '', 'garbage', 't=notanumber,v1=abc', 'v1=abc']) {
      const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
      expect(r.ok, JSON.stringify(header)).toBe(false);
    }
  });

  it('SEC-410 rejects a signature made with a different secret (test/live confusion)', async () => {
    const header = await signStripe(BODY, 'whsec_a_different_secret', NOW); // secret-scan:allow
    const r = await verifyStripeSignature({ rawBody: BODY, header, secret: STRIPE_SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature_mismatch');
  });
});

describe('Resend / Svix (Standard Webhooks) signatures', () => {
  const ID = 'msg_2abcDEF';

  it('SEC-420 accepts a correctly signed body', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const r = await verifySvixSignature({
      rawBody: BODY,
      id: ID,
      timestamp: String(NOW),
      signatureHeader: sig,
      secret: SVIX_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('SEC-421 binds the signature to the message id — swapping ids invalidates it', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const r = await verifySvixSignature({
      rawBody: BODY,
      id: 'msg_someone_elses',
      timestamp: String(NOW),
      signatureHeader: sig,
      secret: SVIX_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature_mismatch');
  });

  it('SEC-422 binds the signature to the timestamp — replaying with a fresh one fails', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const r = await verifySvixSignature({
      rawBody: BODY,
      id: ID,
      timestamp: String(NOW + 1),
      signatureHeader: sig,
      secret: SVIX_SECRET,
      nowSeconds: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature_mismatch');
  });

  it('SEC-423 rejects a stale delivery outside tolerance', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const r = await verifySvixSignature({
      rawBody: BODY,
      id: ID,
      timestamp: String(NOW),
      signatureHeader: sig,
      secret: SVIX_SECRET,
      nowSeconds: NOW + 301,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_out_of_tolerance');
  });

  it('SEC-424 rejects a tampered body', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const tampered = enc.encode(new TextDecoder().decode(BODY).replace('cs_1', 'cs_2'));
    const r = await verifySvixSignature({
      rawBody: tampered,
      id: ID,
      timestamp: String(NOW),
      signatureHeader: sig,
      secret: SVIX_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it('SEC-425 base64-DECODES the secret after the whsec_ prefix (not Stripe semantics)', async () => {
    // Treating the Svix secret as an opaque ASCII string — the Stripe convention —
    // produces a verifier that rejects every legitimate Resend call. This case pins the
    // difference so nobody "harmonises" the two implementations.
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const asOpaqueAscii = await verifySvixSignature({
      rawBody: BODY,
      id: ID,
      timestamp: String(NOW),
      signatureHeader: sig,
      // Pass the base64 text itself as if it were already key bytes.
      secret: btoa(SVIX_SECRET.slice('whsec_'.length)),
      nowSeconds: NOW,
    });
    expect(asOpaqueAscii.ok).toBe(false);
  });

  it('SEC-426 ignores unknown signature versions and requires v1', async () => {
    const r = await verifySvixSignature({
      rawBody: BODY,
      id: ID,
      timestamp: String(NOW),
      signatureHeader: 'v2,AAAA v99,BBBB',
      secret: SVIX_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_supported_scheme');
  });

  it('SEC-427 accepts one valid signature among several (secret rotation)', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    const r = await verifySvixSignature({
      rawBody: BODY,
      id: ID,
      timestamp: String(NOW),
      signatureHeader: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${sig}`,
      secret: SVIX_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('SEC-428 rejects missing headers rather than treating them as optional', async () => {
    const sig = await signSvix(BODY, SVIX_SECRET, ID, NOW);
    for (const missing of [
      { id: null, timestamp: String(NOW), signatureHeader: sig },
      { id: ID, timestamp: null, signatureHeader: sig },
      { id: ID, timestamp: String(NOW), signatureHeader: null },
    ]) {
      const r = await verifySvixSignature({
        rawBody: BODY,
        secret: SVIX_SECRET,
        nowSeconds: NOW,
        ...missing,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('missing_header');
    }
  });
});
