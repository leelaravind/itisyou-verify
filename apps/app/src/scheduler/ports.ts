/**
 * The narrow seams the scheduler depends on.
 *
 * Everything the tick cannot do by itself — read a clock, open a credential, talk to a
 * provider, send an email, delete an expired row — arrives through one of these. That is
 * not ceremony: it is what lets the whole scheduler be driven end to end in a test with no
 * network, no secrets and no wall clock, which is the only way the crash paths can be
 * exercised at all.
 *
 * Nothing in `apps/app/src/scheduler/**` calls `fetch`, reads an environment variable or
 * constructs a provider URL. If you find yourself wanting to, add a port instead.
 */
import type {
  Connector,
  ConnectorCredentials,
  ConnectionConfig,
  ProviderId,
} from '@verify/connectors';

/**
 * A connection the scheduler may actually use, with its secret already opened.
 *
 * `null` from the resolver is a first-class, expected answer — today it is the *only*
 * answer, because no customer has connected HubSpot or Resend yet. It means "do not call
 * this provider", never "call it and see what happens".
 */
export interface ResolvedConnection {
  readonly provider: ProviderId;
  readonly credentials: ConnectorCredentials;
  readonly connection: ConnectionConfig;
}

/** Why a connection could not be resolved. Shown to nobody; used to pick an honest gap. */
export type ConnectionUnavailableReason =
  /** No connection row at all: the customer has never connected this provider. */
  | 'not_connected'
  /** A connection row exists but is revoked, expired or otherwise not ready. */
  | 'connection_not_ready'
  /** A connection row exists but holds no credential we can open. */
  | 'no_credential'
  /** A credential exists but could not be decrypted. Never retried inside a run. */
  | 'credential_unreadable';

export type ConnectionResolution =
  | { readonly ok: true; readonly connection: ResolvedConnection }
  | { readonly ok: false; readonly reason: ConnectionUnavailableReason; readonly detail: string };

/**
 * Turns (workspace, provider) into something a connector can be called with.
 *
 * Implementations must never throw for a missing or unreadable credential — a run whose
 * credential cannot be opened is an `UNVERIFIED` run, not a crashed tick.
 */
export interface CredentialResolver {
  resolve(workspaceId: string, provider: ProviderId): Promise<ConnectionResolution>;
}

/** The connector lookup, injected so a test can supply a recording double. */
export interface ConnectorRegistry {
  get(provider: ProviderId): Connector;
}

/**
 * What the dispatcher does with one outbox row once it has won the claim.
 *
 * Handlers must be **idempotent**: the dispatcher guarantees at-least-once delivery and
 * the commit/dispatch boundary guarantees nothing better than that. A handler that cannot
 * tolerate being called twice with the same row is a bug waiting for a retry.
 */
export interface OutboxHandler {
  /** Returns true when the row is finished with; false to leave it for another attempt. */
  handle(event: OutboxEvent): Promise<boolean>;
}

export interface OutboxEvent {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly eventType: string;
  readonly entityId: string;
  readonly uniqueEventKey: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly now: Date;
}

/** Bounded retention work for one tick. Implemented over A09's resumable sweep. */
export interface RetentionSweeper {
  sweep(input: {
    readonly now: Date;
    readonly batchSize: number;
    readonly maxBatches: number;
  }): Promise<{
    readonly removed: number;
    readonly complete: boolean;
  }>;
}

/**
 * Structured, secret-free scheduler logging.
 *
 * Deliberately not `console` directly: a tick that logs a provider response, a credential
 * or a customer's email address into Workers logs has leaked it, and a port makes that
 * reviewable in one place.
 */
export interface SchedulerLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

export const SILENT_LOGGER: SchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/** Content digest for an evidence row. Injected so tests stay synchronous and offline. */
export type DigestFn = (input: string) => Promise<string>;

/** Id minting, injected so a test can make ids deterministic and assertions readable. */
export type IdFactory = (prefix: string) => string;

/**
 * Elapsed wall-clock milliseconds since the tick started.
 *
 * This is the one genuine clock read in the scheduler, and it is a port because the whole
 * point of the wall-clock budget is that a test can drive it to exhaustion without waiting.
 */
export type ElapsedFn = () => number;
