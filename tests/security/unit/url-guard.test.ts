/**
 * SEC-0xx — SSRF / URL-safety regression suite.
 *
 * Tests the A10 reference guard in `tests/security/helpers/url-guard.ts`.
 * When A04 adopts it into `packages/connectors/`, change the import below to the
 * production module and delete nothing else. If a case here starts failing after that
 * swap, the production guard is weaker than the reviewed one — that is the point.
 */
import { describe, it, expect } from 'vitest';
import {
  checkUrl,
  checkRedirect,
  checkResolvedAddress,
  parseIpv4Loose,
  parseIpv6Loose,
  isPrivateAddress,
  PROVIDER_ALLOWLIST,
  type UrlGuardOptions,
} from '../helpers/url-guard.js';

const OPTS: UrlGuardOptions = { allowedHosts: PROVIDER_ALLOWLIST };

describe('SSRF: outbound URL allowlist', () => {
  it('SEC-001 accepts an exact allowlisted provider host over https', () => {
    const r = checkUrl('https://api.hubapi.com/crm/v3/objects/contacts', OPTS);
    expect(r.ok).toBe(true);
  });

  it('SEC-002 rejects a host that merely contains an allowlisted host', () => {
    for (const bad of [
      'https://api.hubapi.com.evil.example/',
      'https://evil-api.hubapi.com.attacker.test/',
      'https://notapi.hubapi.com.co/',
      'https://api.hubapi.com/../../x'.replace('api.hubapi.com', 'apihubapi.com'),
    ]) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toBe('host_not_allowed');
    }
  });

  it('SEC-003 rejects userinfo used to disguise the real host', () => {
    // `new URL` gives host = evil.example here; a naive `startsWith` check would pass it.
    const r = checkUrl('https://api.hubapi.com@evil.example/steal', OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('userinfo_present');
    const parsed = new URL('https://api.hubapi.com@evil.example/steal');
    expect(parsed.hostname).toBe('evil.example');
  });

  it('SEC-004 rejects the plain-http form of the userinfo trick', () => {
    const r = checkUrl('http://evil.example@api.hubapi.com/', OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('userinfo_present');
  });

  it('SEC-005 rejects every scheme except https', () => {
    for (const bad of [
      'http://api.hubapi.com/',
      'file:///etc/passwd',
      'gopher://api.hubapi.com:70/',
      'ftp://api.hubapi.com/',
      'data:text/plain;base64,aGk=',
      'blob:https://api.hubapi.com/x',
    ]) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
    }
  });

  it('SEC-006 rejects a non-443 port even on an allowlisted host', () => {
    const r = checkUrl('https://api.hubapi.com:8080/x', OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('port_not_allowed');
    expect(checkUrl('https://api.hubapi.com:443/x', OPTS).ok).toBe(true);
  });

  it('SEC-007 rejects loopback in every notation', () => {
    for (const bad of [
      'https://127.0.0.1/',
      'https://127.1/',
      'https://0177.0.0.1/',
      'https://0x7f.0.0.1/',
      'https://0x7f000001/',
      'https://2130706433/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/',
    ]) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason, bad).toBe('private_address');
    }
  });

  it('SEC-008 rejects the cloud metadata address', () => {
    for (const bad of [
      'https://169.254.169.254/latest/meta-data/',
      'https://169.254.170.2/v2/credentials',
      'https://[fe80::1]/',
      'https://[::ffff:a9fe:a9fe]/',
      'https://2852039166/', // decimal 169.254.169.254
    ]) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason, bad).toBe('private_address');
    }
  });

  it('SEC-009 rejects 0.0.0.0 and the unspecified address', () => {
    for (const bad of ['https://0.0.0.0/', 'https://0/', 'https://[::]/']) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason, bad).toBe('private_address');
    }
  });

  it('SEC-010 rejects RFC1918, CGNAT and unique-local ranges', () => {
    for (const bad of [
      'https://10.0.0.5/',
      'https://172.16.0.1/',
      'https://172.31.255.254/',
      'https://192.168.1.1/',
      'https://100.64.0.1/',
      'https://[fc00::1]/',
      'https://[fd12:3456::1]/',
    ]) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason, bad).toBe('private_address');
    }
  });

  it('SEC-011 rejects a PUBLIC bare IP too — the allowlist is hostnames, not addresses', () => {
    const r = checkUrl('https://8.8.8.8/', OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ip_literal_not_allowed');
    const v6 = checkUrl('https://[2001:4860:4860::8888]/', OPTS);
    expect(v6.ok).toBe(false);
    if (!v6.ok) expect(v6.reason).toBe('ip_literal_not_allowed');
  });

  it('SEC-012 rejects DNS-rebinding-shaped hostnames that encode a private address', () => {
    // These resolve to 127.0.0.1 / 169.254.169.254 but are syntactically hostnames.
    // The allowlist — not the IP check — is what stops them, which is why the allowlist
    // must be a fixed literal and never assembled from customer input.
    for (const bad of [
      'https://127.0.0.1.nip.io/',
      'https://7f000001.nip.io/',
      'https://make-169-254-169-254.sslip.io/',
      'https://localtest.me/',
      'https://spoofed.burpcollaborator.net/',
    ]) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason, bad).toBe('host_not_allowed');
    }
  });

  it('SEC-013 rejects a trailing-dot host that would bypass a naive equality check', () => {
    // `api.hubapi.com.` is the same name to DNS. The guard normalises it, so it is
    // accepted; `evil.example.` is still rejected. Both behaviours are asserted.
    expect(checkUrl('https://api.hubapi.com./x', OPTS).ok).toBe(true);
    expect(checkUrl('https://evil.example./x', OPTS).ok).toBe(false);
  });

  it('SEC-014 is case-insensitive about the host and does not leak case-based bypasses', () => {
    expect(checkUrl('https://API.HubAPI.CoM/x', OPTS).ok).toBe(true);
    expect(checkUrl('https://EVIL.EXAMPLE/x', OPTS).ok).toBe(false);
  });

  it('SEC-015 re-applies the full guard to a redirect target', () => {
    const from = new URL('https://api.hubapi.com/crm/v3/objects/contacts');
    const toMetadata = checkRedirect(from, 'http://169.254.169.254/latest/meta-data/', OPTS, 1);
    expect(toMetadata.ok).toBe(false);
    const relative = checkRedirect(from, '/crm/v3/objects/companies', OPTS, 1);
    expect(relative.ok).toBe(true);
    const offHost = checkRedirect(from, 'https://evil.example/', OPTS, 1);
    expect(offHost.ok).toBe(false);
    if (!offHost.ok) expect(offHost.reason).toBe('host_not_allowed');
  });

  it('SEC-016 enforces a redirect hop budget', () => {
    const from = new URL('https://api.hubapi.com/a');
    const r = checkRedirect(from, 'https://api.hubapi.com/b', OPTS, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_many_redirects');
  });

  it('SEC-017 rejects malformed and empty inputs rather than defaulting to allowed', () => {
    for (const bad of ['', 'not a url', '//api.hubapi.com/x', 'https://', '   ']) {
      const r = checkUrl(bad, OPTS);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('SEC-018 checkResolvedAddress rejects a private answer (post-DNS rebinding guard)', () => {
    expect(checkResolvedAddress('127.0.0.1').ok).toBe(false);
    expect(checkResolvedAddress('169.254.169.254').ok).toBe(false);
    expect(checkResolvedAddress('::1').ok).toBe(false);
    expect(checkResolvedAddress('104.16.0.1').ok).toBe(true);
  });
});

describe('SSRF: numeric address parsing used by the guard', () => {
  it('SEC-019 parses inet_aton-style IPv4 encodings to the same address', () => {
    const expected = [127, 0, 0, 1];
    for (const form of ['127.0.0.1', '127.1', '127.0.1', '2130706433', '0x7f000001', '0177.0.0.01']) {
      const parsed = parseIpv4Loose(form);
      expect(parsed, form).not.toBeNull();
      if (parsed && parsed.version === 4) expect([...parsed.bytes], form).toEqual(expected);
    }
  });

  it('SEC-020 parses IPv6 including compressed and IPv4-mapped forms', () => {
    expect(parseIpv6Loose('::1')).not.toBeNull();
    expect(parseIpv6Loose('fe80::1')).not.toBeNull();
    expect(parseIpv6Loose('::ffff:169.254.169.254')).not.toBeNull();
    expect(parseIpv6Loose('2001:4860:4860::8888')).not.toBeNull();
    expect(parseIpv6Loose('gggg::1')).toBeNull();
  });

  it('SEC-021 classifies IPv4-mapped and NAT64-embedded private addresses as private', () => {
    const mapped = parseIpv6Loose('::ffff:10.0.0.1');
    expect(mapped).not.toBeNull();
    if (mapped) expect(isPrivateAddress(mapped)).toBe(true);
    const nat64 = parseIpv6Loose('64:ff9b::169.254.169.254');
    expect(nat64).not.toBeNull();
    if (nat64) expect(isPrivateAddress(nat64)).toBe(true);
    const publicV6 = parseIpv6Loose('2606:4700:4700::1111');
    expect(publicV6).not.toBeNull();
    if (publicV6) expect(isPrivateAddress(publicV6)).toBe(false);
  });

  it('SEC-022 never treats a hostname as a parseable IP address', () => {
    for (const host of ['api.hubapi.com', 'example', '1.2.3.4.5', 'a.b.c.d']) {
      expect(parseIpv4Loose(host), host).toBeNull();
    }
  });
});
