/**
 * Global test setup.
 *
 * Rule: a unit or integration test must never reach a real provider. Anything that
 * escapes a stub hits this guard and fails the test loudly rather than quietly
 * spending money or leaking data. Tests that legitimately need fetch install their
 * own stub with `vi.stubGlobal('fetch', ...)`, which takes precedence.
 */
import { beforeAll } from 'vitest';

const ALLOWED_HOSTS = new Set<string>([
  // Nothing. Provider-backed proofs run as separate, explicitly budgeted scripts.
]);

beforeAll(() => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = url;
    }
    if (ALLOWED_HOSTS.has(host)) return realFetch(input as RequestInfo, init);
    throw new Error(
      `Blocked outbound fetch to ${host} during tests. Stub it with vi.stubGlobal('fetch', ...). ` +
        `Real provider calls are not permitted in the unit or integration suites.`,
    );
  }) as typeof fetch;
});
