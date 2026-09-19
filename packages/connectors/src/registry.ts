/**
 * The connector registry.
 *
 * Deliberately tiny and deliberately closed: `getConnector` accepts a `ProviderId` and
 * nothing else, so a provider name arriving from a database row, a URL segment or a
 * customer form cannot reach a connector without passing `isSupportedProvider` first.
 *
 * It lives in its own module rather than in `index.ts` so that `connect.ts` and `proof.ts`
 * can reach it without importing the package barrel and creating a cycle.
 */
import { HubSpotConnector, hubspotConnector } from './hubspot.js';
import { ResendConnector, resendConnector } from './resend.js';
import { SUPPORTED_PROVIDERS, type Connector, type ProviderId } from './types.js';

/** Runtime knobs every connector understands. Injected by callers; defaulted in tests. */
export interface ConnectorRuntimeOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly jitterSeed?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  /** Resend only; ignored elsewhere. */
  readonly toleranceSeconds?: number | undefined;
}

const DEFAULTS: Readonly<Record<ProviderId, Connector>> = Object.freeze({
  hubspot: hubspotConnector,
  resend: resendConnector,
});

/** Narrow an untrusted string to a supported provider. */
export function isSupportedProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The typed connector for a provider.
 *
 * Total over `ProviderId`, so it cannot return undefined. With no options it returns the
 * shared, stateless instance; with options it builds one, which is how tests inject a
 * stubbed `fetch` without a global.
 */
export function getConnector(provider: ProviderId, options?: ConnectorRuntimeOptions): Connector {
  if (options === undefined) return DEFAULTS[provider];
  if (provider === 'hubspot') {
    return new HubSpotConnector({
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.jitterSeed === undefined ? {} : { jitterSeed: options.jitterSeed }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
  }
  return new ResendConnector({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.jitterSeed === undefined ? {} : { jitterSeed: options.jitterSeed }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.toleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: options.toleranceSeconds }),
  });
}
