/**
 * SSRF guard — TEST-ONLY REFERENCE IMPLEMENTATION, owned by A10 (security review).
 *
 * This file lives under `tests/security/` deliberately: A10 does not own
 * `packages/connectors/`. A04 must adopt this logic verbatim (or something provably
 * equivalent) as the single choke point through which every outbound fetch passes,
 * and must re-export it so `tests/security/unit/url-guard.test.ts` can be re-pointed
 * at the production implementation with a one-line import change.
 *
 * Threat: brief rule 8 says "No customer-controlled URL is ever fetched." Today that is
 * a sentence in a document, not a function. Customer-influenced URLs reach us through
 * at least: OAuth `redirect_uri` / `state` round-trips, HubSpot portal-supplied API
 * hosts, Resend webhook `Location` redirects, report/export links, campaign destination
 * URLs, and any assistant-proposed URL. From a Cloudflare Worker, `fetch()` to
 * `http://169.254.169.254/` or to an internal hostname is a real request; there is no
 * network boundary doing this job for us.
 *
 * Design rules encoded here:
 *  1. HTTPS only. No http, no file:, no gopher:, no data:, no blob:.
 *  2. No userinfo. `https://api.hubapi.com@evil.example/` has host `evil.example`.
 *  3. No bare IP literals at all — the allowlist is a list of hostnames, so an IP
 *     literal can never be a legitimate provider host. Private/loopback/link-local
 *     literals get their own reason code so tests can be precise.
 *  4. Host must equal an allowlisted host, or be a subdomain of one on a dot boundary.
 *     `api.hubapi.com.evil.example` and `evil-api.hubapi.com` both fail.
 *  5. Redirects are re-checked from scratch, with a hop budget. A 302 to
 *     `http://169.254.169.254/` must not be followed.
 *  6. `checkResolvedAddress()` exists for the post-DNS check that defeats DNS rebinding.
 *     The Workers runtime does not expose resolved addresses, so on Workers this is a
 *     DOCUMENTED RESIDUAL RISK, not an implemented control. Do not claim otherwise.
 */

export type UrlGuardReason =
  | 'invalid_url'
  | 'userinfo_present'
  | 'scheme_not_allowed'
  | 'port_not_allowed'
  | 'ip_literal_not_allowed'
  | 'private_address'
  | 'host_not_allowed'
  | 'too_many_redirects';

export type UrlGuardResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: UrlGuardReason; readonly detail: string };

export interface UrlGuardOptions {
  /** Exact provider hostnames. Never build this from customer input. */
  readonly allowedHosts: readonly string[];
  /** Allow `x.allowed.example` when `allowed.example` is listed. Default true. */
  readonly allowSubdomains?: boolean;
  /** Default `[443]`. There is no legitimate reason for a provider to use another port. */
  readonly allowedPorts?: readonly number[];
  /** Default 3. */
  readonly maxRedirects?: number;
}

/** The v1 provider allowlist. Fixed at build time; never read from the database. */
export const PROVIDER_ALLOWLIST: readonly string[] = [
  'api.hubapi.com',
  'api.resend.com',
  'api.stripe.com',
  'checkout.stripe.com',
  'billing.stripe.com',
  'openrouter.ai',
];

type ParsedIp =
  | { readonly version: 4; readonly bytes: readonly [number, number, number, number] }
  | { readonly version: 6; readonly words: readonly number[] };

function fail(reason: UrlGuardReason, detail: string): UrlGuardResult {
  return { ok: false, reason, detail };
}

/** Lowercase, strip one trailing root dot, strip IPv6 brackets. */
export function normaliseHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * inet_aton-style IPv4 parsing: decimal, octal (leading 0), hex (0x), and 1-, 2-, 3- or
 * 4-part forms. The WHATWG URL parser already normalises most of these, but connectors
 * may be handed a host string that never went through `new URL`, and a future runtime
 * may differ. Belt and braces.
 */
export function parseIpv4Loose(host: string): ParsedIp | null {
  if (host === '') return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const raw of parts) {
    if (raw === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) value = Number.parseInt(raw.slice(2), 16);
    else if (/^0[0-7]+$/.test(raw)) value = Number.parseInt(raw.slice(1), 8);
    else if (/^[0-9]+$/.test(raw)) value = Number.parseInt(raw, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    nums.push(value);
  }
  // Last part absorbs the remaining bytes (inet_aton semantics).
  const last = nums[nums.length - 1];
  if (last === undefined) return null;
  const leadingCount = nums.length - 1;
  const maxLast = 2 ** (8 * (4 - leadingCount));
  if (last >= maxLast) return null;
  for (let i = 0; i < leadingCount; i++) {
    const n = nums[i];
    if (n === undefined || n > 255) return null;
  }
  const bytes: number[] = [];
  for (let i = 0; i < leadingCount; i++) bytes.push(nums[i] as number);
  for (let i = 3 - leadingCount; i >= 0; i--) bytes.push((last >>> (8 * i)) & 0xff);
  return {
    version: 4,
    bytes: [bytes[0] as number, bytes[1] as number, bytes[2] as number, bytes[3] as number],
  };
}

/** Expands `::`, accepts a trailing dotted-quad (`::ffff:127.0.0.1`). */
export function parseIpv6Loose(host: string): ParsedIp | null {
  if (!host.includes(':')) return null;
  let text = host;
  const lastColon = text.lastIndexOf(':');
  const afterColon = text.slice(lastColon + 1);
  if (afterColon.includes('.')) {
    // Rewrite a trailing dotted quad (`::ffff:127.0.0.1`) as two hex groups so the
    // rest of the parser only ever sees hex groups and `::`.
    const v4 = parseIpv4Loose(afterColon);
    if (!v4 || v4.version !== 4) return null;
    const hi = (((v4.bytes[0] << 8) | v4.bytes[1]) & 0xffff).toString(16);
    const lo = (((v4.bytes[2] << 8) | v4.bytes[3]) & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const tail: number[] = [];
  const doubleColon = text.indexOf('::');
  let headText: string;
  let tailText: string;
  if (doubleColon === -1) {
    headText = text;
    tailText = '';
  } else {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    headText = text.slice(0, doubleColon);
    tailText = text.slice(doubleColon + 2);
  }
  const toWords = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const group of s.split(':')) {
      if (group === '' || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = toWords(headText);
  const midTail = toWords(tailText);
  if (head === null || midTail === null) return null;
  const explicit = [...head, ...midTail, ...tail];
  if (doubleColon === -1) {
    if (explicit.length !== 8) return null;
    return { version: 6, words: explicit };
  }
  if (explicit.length > 7) return null;
  const zeros = new Array<number>(8 - explicit.length).fill(0);
  const words = [...head, ...zeros, ...midTail, ...tail];
  if (words.length !== 8) return null;
  return { version: 6, words };
}

export function parseIpLiteral(host: string): ParsedIp | null {
  return parseIpv6Loose(host) ?? parseIpv4Loose(host);
}

/**
 * True for anything an attacker could point at to reach us, our host, our cloud
 * metadata service, or a neighbour: loopback, RFC1918, CGNAT, link-local (including
 * 169.254.169.254), IETF protocol assignments, documentation ranges, benchmarking,
 * multicast, reserved and broadcast. Conservative by design: a false rejection costs a
 * support ticket, a false acceptance costs the company.
 */
export function isPrivateAddress(ip: ParsedIp): boolean {
  if (ip.version === 4) {
    const [a, b, c] = ip.bytes;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast, reserved, 255.255.255.255
    return false;
  }
  const w = ip.words;
  const w0 = w[0] as number;
  const w1 = w[1] as number;
  const embedded = (): ParsedIp => ({
    version: 4,
    bytes: [
      ((w[6] as number) >> 8) & 0xff,
      (w[6] as number) & 0xff,
      ((w[7] as number) >> 8) & 0xff,
      (w[7] as number) & 0xff,
    ],
  });
  const firstSixZero = w.slice(0, 6).every((x) => x === 0);
  if (w.every((x) => x === 0)) return true; // ::
  if (firstSixZero && w[6] === 0 && w[7] === 1) return true; // ::1
  if (firstSixZero && w[7] !== undefined) return isPrivateAddress(embedded()); // ::a.b.c.d
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isPrivateAddress(embedded()); // ::ffff:a.b.c.d
  if (w0 === 0x0064 && w1 === 0xff9b) return isPrivateAddress(embedded()); // NAT64 64:ff9b::/96
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (w0 === 0x2001 && w1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (w0 === 0x2002) return true; // 6to4 — embeds an arbitrary v4, treat as unsafe
  return false;
}

function hostAllowed(host: string, opts: UrlGuardOptions): boolean {
  const allowSubdomains = opts.allowSubdomains ?? true;
  for (const entry of opts.allowedHosts) {
    const allowed = normaliseHost(entry);
    if (allowed === '') continue;
    if (host === allowed) return true;
    if (allowSubdomains && host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * The single entry point. Every outbound request must pass through this before the URL
 * reaches `fetch`. Order of checks is deliberate and asserted by the tests.
 */
export function checkUrl(raw: string, opts: UrlGuardOptions): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('invalid_url', raw);
  }
  if (url.username !== '' || url.password !== '') {
    return fail(
      'userinfo_present',
      `${url.username ? 'user' : ''}${url.password ? ':pass' : ''}@${url.hostname}`,
    );
  }
  if (url.protocol !== 'https:') return fail('scheme_not_allowed', url.protocol);
  const allowedPorts = opts.allowedPorts ?? [443];
  const port = url.port === '' ? 443 : Number(url.port);
  if (!Number.isInteger(port) || !allowedPorts.includes(port))
    return fail('port_not_allowed', String(port));
  const host = normaliseHost(url.hostname);
  const ip = parseIpLiteral(host);
  if (ip !== null) {
    return isPrivateAddress(ip)
      ? fail('private_address', host)
      : fail('ip_literal_not_allowed', host);
  }
  if (!hostAllowed(host, opts)) return fail('host_not_allowed', host);
  return { ok: true, url };
}

/**
 * Re-check a redirect target from scratch. `location` may be relative, so it is resolved
 * against the URL that produced it — and then subjected to the full guard again.
 * NEVER pass `redirect: 'follow'` to `fetch` for a connector call; the runtime will not
 * apply this guard to intermediate hops.
 */
export function checkRedirect(
  from: URL,
  location: string,
  opts: UrlGuardOptions,
  hop: number,
): UrlGuardResult {
  const maxRedirects = opts.maxRedirects ?? 3;
  if (hop > maxRedirects) return fail('too_many_redirects', String(hop));
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return fail('invalid_url', location);
  }
  return checkUrl(next.href, opts);
}

/**
 * Post-DNS check. Call this with each address the hostname resolved to, immediately
 * before connecting, to close the DNS-rebinding window. Cloudflare Workers does not
 * expose resolved addresses to `fetch`, so on Workers this remains an accepted,
 * documented residual risk (threat SSRF-04). Do not mark it implemented.
 */
export function checkResolvedAddress(address: string): UrlGuardResult {
  const ip = parseIpLiteral(normaliseHost(address));
  if (ip === null) return fail('invalid_url', address);
  if (isPrivateAddress(ip)) return fail('private_address', address);
  return { ok: true, url: new URL(`https://${ip.version === 6 ? `[${address}]` : address}/`) };
}
