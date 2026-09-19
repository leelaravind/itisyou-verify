/**
 * AUTH-1xx — adversarial review of `packages/security/` (A02), plus interoperability
 * proofs against A10's independent reference implementations.
 *
 * A02 landed this module during the review. These cases are written against the REAL
 * exported interface as of 2026-09-19. Two of them fail deliberately and describe
 * findings A02 must fix (AUTH-114, AUTH-115) — do not delete or weaken them.
 *
 * The interoperability cases matter more than they look: A10 wrote the Stripe and Svix
 * verifiers from the vendor documentation without reading A02's code, and A02 wrote
 * theirs the same way. If two independent readings of the spec agree byte-for-byte, the
 * reading is probably right. If they disagreed, one of us misread a spec that stands
 * between this business and a forged payment event.
 */
import { describe, it, expect } from 'vitest';
import { SIGNATURE_TOLERANCE_SECONDS, EVENT_FRESHNESS_WINDOW_SECONDS } from '@verify/contracts';
import {
  buildAad,
  sealCredential,
  openCredential,
  sealCredentialFor,
  signRequest,
  verifyRequest,
  verifyStripeSignature,
  verifySvixSignature,
  signStripe as a02SignStripe,
  signSvix as a02SignSvix,
  hashToken,
  timingSafeEqual,
  stableStringify,
  redactObject,
  maskEmail,
  maskToken,
  neutraliseCsvField,
  generateCsrfToken,
  validateCsrfToken,
  csrfCookie,
  isSameOriginRequest,
  isStateChangingMethod,
  CSRF_COOKIE_NAME,
  NONCE_BYTES,
  type CredentialEnvelope,
} from '@verify/security';
import {
  signStripe as refSignStripe,
  signSvix as refSignSvix,
  verifyStripeSignature as refVerifyStripe,
  verifySvixSignature as refVerifySvix,
} from '../helpers/webhooks.js';
import { canonicalJson } from '../helpers/canonical.js';
import { csvCell } from '../helpers/csv.js';

const enc = new TextEncoder();
// 32 zero-ish bytes, base64. Synthetic and deterministic; not a key that guards anything.
const KEY_B64 = btoa('0123456789abcdef0123456789abcdef');
const SVIX_SECRET = `whsec_${btoa('svix-synthetic-32-byte-test-key!!')}`; // secret-scan:allow
const STRIPE_SECRET = 'whsec_stripe_synthetic_test_secret'; // secret-scan:allow
const NOW = 1_770_000_000;
const TOKEN = ['pat', 'na1', '00000000-0000-4000-8000-000000000001'].join('-');

const WS_A = { workspaceId: 'ws_aaaa', provider: 'hubspot', purpose: 'connection_token' } as const;
const WS_B = { workspaceId: 'ws_bbbb', provider: 'hubspot', purpose: 'connection_token' } as const;

describe('credential envelope (A02 packages/security/src/crypto.ts)', () => {
  it('AUTH-101 seals to base64 ciphertext with a 12-byte nonce, AAD and key version', async () => {
    const envelope = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
    expect(envelope.ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(atob(envelope.nonce).length).toBe(NONCE_BYTES);
    expect(envelope.aad).toContain('ws_aaaa');
    expect(envelope.key_version).toBe(1);
  });

  it('AUTH-102 round-trips only when the expected AAD matches', async () => {
    const envelope = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
    expect(
      await openCredential(envelope, { keyBase64: KEY_B64, expectedAad: buildAad(WS_A) }),
    ).toBe(TOKEN);
  });

  it('AUTH-103 tenant A ciphertext will not open in tenant B context even with the key', async () => {
    const envelope = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
    await expect(
      openCredential(envelope, { keyBase64: KEY_B64, expectedAad: buildAad(WS_B) }),
    ).rejects.toThrow();
    // And with the AAD column itself relabelled — the GCM tag, not the string compare,
    // is what refuses. This is the case that survives a database write by an attacker.
    const relabelled: CredentialEnvelope = { ...envelope, aad: buildAad(WS_B) };
    await expect(
      openCredential(relabelled, { keyBase64: KEY_B64, expectedAad: buildAad(WS_B) }),
    ).rejects.toThrow();
  });

  it('AUTH-104 will not open under a different provider or purpose', async () => {
    const envelope = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
    for (const wrong of [
      { ...WS_A, provider: 'resend' },
      { ...WS_A, purpose: 'totp_seed' },
    ]) {
      await expect(
        openCredential(envelope, { keyBase64: KEY_B64, expectedAad: buildAad(wrong) }),
      ).rejects.toThrow();
    }
  });

  it('AUTH-105 the error thrown on failure is not an oracle and carries no ciphertext', async () => {
    const envelope = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
    let message = '';
    try {
      await openCredential(envelope, { keyBase64: KEY_B64, expectedAad: buildAad(WS_B) });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(envelope.ciphertext);
    expect(message).not.toContain(KEY_B64);
    expect(message).not.toContain(TOKEN);
  });

  it('AUTH-106 a fresh nonce is used for every seal and ciphertext is non-deterministic', async () => {
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const e = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
      nonces.add(e.nonce);
      ciphertexts.add(e.ciphertext);
    }
    expect(nonces.size).toBe(32);
    expect(ciphertexts.size).toBe(32);
  });

  it('AUTH-107 buildAad refuses separator characters that would let two contexts collide', () => {
    expect(() => buildAad({ workspaceId: 'ws|x', provider: 'hubspot', purpose: 'p' })).toThrow();
    expect(() => buildAad({ workspaceId: 'ws=x', provider: 'hubspot', purpose: 'p' })).toThrow();
    expect(() => buildAad({ workspaceId: '', provider: 'hubspot', purpose: 'p' })).toThrow();
  });

  it('AUTH-108 a wrong-length or non-base64 wrapping key is rejected, not truncated', async () => {
    await expect(
      sealCredential(TOKEN, { keyBase64: btoa('short'), keyVersion: 1, aad: buildAad(WS_A) }),
    ).rejects.toThrow();
    await expect(
      sealCredential(TOKEN, {
        keyBase64: 'not base64 at all!!',
        keyVersion: 1,
        aad: buildAad(WS_A),
      }),
    ).rejects.toThrow();
  });

  it('AUTH-114 FINDING: openCredential must REQUIRE an expected AAD, not accept undefined', async () => {
    // As written, `expectedAad` is optional. A data-access helper that looks a credential
    // up by `connection_id` and calls `openCredential(row, { keyBase64 })` will happily
    // decrypt a row belonging to another workspace, because the stored AAD travels with
    // the row and satisfies the GCM tag. The AAD then binds the ciphertext to a context
    // nobody checked, which is the same as not binding it at all.
    //
    // Required fix (A02): make `expectedAad` a required property of `OpenOptions`, or
    // expose only `openCredentialFor(envelope, parts, key)` and delete the raw-AAD path.
    // Until then this fails, and CRED-01 in docs/threat-model.md stays ABSENT.
    const envelope = await sealCredentialFor(TOKEN, WS_A, { keyBase64: KEY_B64, keyVersion: 1 });
    await expect(openCredential(envelope, { keyBase64: KEY_B64 })).rejects.toThrow();
  });

  it('AUTH-115 FINDING: key_version must be inside the AAD, not an unauthenticated column', async () => {
    // `buildAad` emits a fixed `v1|` AAD-format prefix; the WRAPPING key version is
    // stored beside the ciphertext and is not authenticated. During a key rotation with
    // two live keys, anyone who can write the `credential_versions` row can flip
    // key_version and steer decryption at the other key. Today that only causes a
    // failure, but it becomes a downgrade the moment a weaker or retired key is kept
    // readable. Bind it: `v1|kv=<n>|ws=...`.
    const one = await sealCredential(TOKEN, {
      keyBase64: KEY_B64,
      keyVersion: 1,
      aad: buildAad(WS_A),
    });
    const two = await sealCredential(TOKEN, {
      keyBase64: KEY_B64,
      keyVersion: 2,
      aad: buildAad(WS_A),
    });
    expect(one.aad, 'AAD must differ when key_version differs').not.toBe(two.aad);
  });
});

describe('source-event signatures (our own scheme)', () => {
  const BODY = '{"schema_version":1,"event_id":"evt_abcdefgh"}';

  it('AUTH-109 a valid signature over the raw body verifies', async () => {
    const header = await signRequest({ secret: 'wf_key_a', rawBody: BODY, timestamp: NOW });
    const r = await verifyRequest({ secret: 'wf_key_a', header, rawBody: BODY, now: NOW * 1000 });
    expect(r.valid).toBe(true);
  });

  it('AUTH-110 a replay outside SIGNATURE_TOLERANCE_SECONDS is rejected as stale', async () => {
    const header = await signRequest({ secret: 'wf_key_a', rawBody: BODY, timestamp: NOW });
    const r = await verifyRequest({
      secret: 'wf_key_a',
      header,
      rawBody: BODY,
      now: (NOW + SIGNATURE_TOLERANCE_SECONDS + 1) * 1000,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('timestamp_stale');
  });

  it('AUTH-111 a future-dated timestamp is rejected too', async () => {
    const header = await signRequest({
      secret: 'wf_key_a',
      rawBody: BODY,
      timestamp: NOW + 10_000,
    });
    const r = await verifyRequest({ secret: 'wf_key_a', header, rawBody: BODY, now: NOW * 1000 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('timestamp_in_future');
  });

  it('AUTH-112 one leaked workflow key forges events for that workflow only', async () => {
    // `workflows.signing_key_ref` is per workflow. The verifier must be handed the key
    // for the workflow named in the request and must never try a set of candidate keys.
    const header = await signRequest({ secret: 'wf_key_LEAKED', rawBody: BODY, timestamp: NOW });
    const r = await verifyRequest({
      secret: 'wf_key_other',
      header,
      rawBody: BODY,
      now: NOW * 1000,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('signature_mismatch');
  });

  it('AUTH-113 a single changed body byte invalidates the signature', async () => {
    const header = await signRequest({ secret: 'wf_key_a', rawBody: BODY, timestamp: NOW });
    const r = await verifyRequest({
      secret: 'wf_key_a',
      header,
      rawBody: BODY.replace('evt_abcdefgh', 'evt_abcdefgi'),
      now: NOW * 1000,
    });
    expect(r.valid).toBe(false);
  });

  it('AUTH-116 signature freshness and event freshness are separate windows', () => {
    // A signature minted seconds ago can still assert a business event from hours ago.
    // Both bounds must be enforced by the route; the contracts package defines both.
    expect(SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThan(0);
    expect(EVENT_FRESHNESS_WINDOW_SECONDS).toBeGreaterThan(SIGNATURE_TOLERANCE_SECONDS);
  });

  it('AUTH-117 a missing header is rejected rather than treated as unsigned-but-fine', async () => {
    for (const header of [null, undefined, '', '   ', 'v1=abc', 't=abc,v1=def']) {
      const r = await verifyRequest({ secret: 'wf_key_a', header, rawBody: BODY, now: NOW * 1000 });
      expect(r.valid, String(header)).toBe(false);
    }
  });
});

describe('interoperability: two independent readings of the vendor specs agree', () => {
  const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
  const BODY_BYTES = enc.encode(BODY);

  it('AUTH-120 A02 verifies a Stripe header produced by the A10 reference signer', async () => {
    const header = await refSignStripe(BODY_BYTES, STRIPE_SECRET, NOW);
    const r = await verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW * 1000);
    expect(r.valid).toBe(true);
  });

  it('AUTH-121 the A10 reference verifies a Stripe header produced by A02', async () => {
    const header = await a02SignStripe(BODY, NOW, STRIPE_SECRET);
    const r = await refVerifyStripe({
      rawBody: BODY_BYTES,
      header,
      secret: STRIPE_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('AUTH-122 A02 verifies a Svix signature produced by the A10 reference signer', async () => {
    const sig = await refSignSvix(BODY_BYTES, SVIX_SECRET, 'msg_1', NOW);
    const r = await verifySvixSignature(
      BODY,
      { id: 'msg_1', timestamp: String(NOW), signature: sig },
      SVIX_SECRET,
      NOW * 1000,
    );
    expect(r.valid).toBe(true);
  });

  it('AUTH-123 the A10 reference verifies a Svix signature produced by A02', async () => {
    const sig = await a02SignSvix(BODY, 'msg_1', NOW, SVIX_SECRET);
    const r = await refVerifySvix({
      rawBody: BODY_BYTES,
      id: 'msg_1',
      timestamp: String(NOW),
      signatureHeader: sig,
      secret: SVIX_SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('AUTH-124 A02 ignores the Stripe v0 scheme (downgrade)', async () => {
    const r = await verifyStripeSignature(
      BODY,
      `t=${NOW},v0=${'a'.repeat(64)}`,
      STRIPE_SECRET,
      NOW * 1000,
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('missing_signature');
  });

  it('AUTH-125 A02 rejects a re-serialised Stripe body', async () => {
    const header = await a02SignStripe(BODY, NOW, STRIPE_SECRET);
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    const r = await verifyStripeSignature(reserialised, header, STRIPE_SECRET, NOW * 1000);
    expect(r.valid).toBe(false);
  });

  it('AUTH-126 A02 and A10 agree on canonical JSON for an approval payload', () => {
    const payload = { b: 2, a: 1, nested: { z: [1, 2], y: 'x' } };
    expect(stableStringify(payload)).toBe(canonicalJson(payload));
  });

  it('AUTH-127 A02 and A10 agree on CSV formula neutralisation', () => {
    for (const value of ["=cmd|'/c calc'!A0", '+1', '-1', '@SUM(1)', 'plain']) {
      const a02 = neutraliseCsvField(value);
      const a10 = csvCell(value);
      const a10Unquoted = a10.startsWith('"') ? a10.slice(1, -1).replace(/""/g, '"') : a10;
      expect(a02, value).toBe(a10Unquoted);
    }
  });
});

describe('token hashing, redaction and CSRF', () => {
  it('AUTH-130 hashToken is deterministic hex and domain-separated by purpose', async () => {
    const a = await hashToken('tok_abcdefghijklmnop', 'session');
    const b = await hashToken('tok_abcdefghijklmnop', 'session');
    const c = await hashToken('tok_abcdefghijklmnop', 'login');
    expect(a).toBe(b);
    expect(a).not.toBe(c); // a session hash must not be replayable as a login-token hash
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('tok_');
  });

  it('AUTH-131 timingSafeEqual rejects near misses and length differences', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abcde')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('AUTH-132 redactObject is an allowlist — an unlisted field is dropped entirely', () => {
    const out = redactObject(
      { id: 'run_1', access_token: 'pat-na1-secret', note: 'x', email: 'a@b.test' },
      ['id', 'email'],
    );
    expect(Object.keys(out).sort()).toEqual(['email', 'id']);
    expect(JSON.stringify(out)).not.toContain('pat-na1-secret');
  });

  it('AUTH-133 masks never return the original value', () => {
    expect(maskEmail('ada@example.com')).not.toContain('ada@');
    expect(maskEmail('a@example.com')).toBe('***@example.com');
    expect(
      maskToken(['pat', 'na1', '00000000-0000-4000-8000-000000000001'].join('-')),
    ).not.toContain('pat-na1'); // secret-scan:allow
    expect(maskToken('short')).toBe('********');
  });

  it('AUTH-134 CSRF tokens are unguessable and only validate against themselves', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(validateCsrfToken(a, a)).toBe(true);
    expect(validateCsrfToken(a, b)).toBe(false);
  });

  it('AUTH-135 an absent, empty or short CSRF token never validates', () => {
    const good = generateCsrfToken();
    for (const submitted of [null, undefined, '', '   ', 'short', 'undefined']) {
      expect(validateCsrfToken(good, submitted), String(submitted)).toBe(false);
    }
    for (const cookie of [null, undefined, '', 'short']) {
      expect(validateCsrfToken(cookie, good), String(cookie)).toBe(false);
    }
  });

  it('AUTH-136 the CSRF cookie uses the __Host- prefix, Path=/, SameSite and Secure', () => {
    const cookie = csrfCookie('tok');
    expect(CSRF_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain=');
  });

  it('AUTH-137 FINDING: a __Host- cookie without Secure is silently rejected by browsers', () => {
    // `csrfCookie(token, { secure: false })` emits `__Host-verify_csrf=...` with no
    // Secure attribute. Every browser rejects that cookie outright, so local development
    // over http://localhost:8787 gets NO csrf cookie and every form post fails — and the
    // obvious "fix" a hurried developer reaches for is to disable the CSRF check.
    // Required fix (A02): when secure is false, fall back to an unprefixed cookie name.
    const insecure = csrfCookie('tok', { secure: false });
    const hasHostPrefix = insecure.startsWith('__Host-');
    const hasSecure = insecure.includes('Secure');
    expect(hasHostPrefix && !hasSecure, insecure).toBe(false);
  });

  it('AUTH-138 a state-changing request with no Origin and no Referer is rejected', () => {
    const origin = 'https://verify.itisyou.app';
    const make = (headers: Record<string, string>) =>
      ({ headers: new Headers(headers), method: 'POST' }) as const;
    expect(isSameOriginRequest(make({}), origin)).toBe(false);
    expect(isSameOriginRequest(make({ origin: 'https://evil.example' }), origin)).toBe(false);
    expect(isSameOriginRequest(make({ origin }), origin)).toBe(true);
    expect(isSameOriginRequest(make({ referer: `${origin}/app/runs` }), origin)).toBe(true);
    // A forged Origin of literal "null" (sandboxed iframe / data: document) is not trusted.
    expect(isSameOriginRequest(make({ origin: 'null' }), origin)).toBe(false);
  });

  it('AUTH-139 the safe-method list is exactly GET, HEAD and OPTIONS', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(isStateChangingMethod(method), method).toBe(false);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isStateChangingMethod(method), method).toBe(true);
    }
  });
});
