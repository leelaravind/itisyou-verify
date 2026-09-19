/**
 * Turning a stored connection into something a connector can be called with.
 *
 * This file is where the product's current reality lives: **no customer has connected
 * HubSpot or Resend, so today every resolution returns `{ ok: false }`.** That is not an
 * error path bolted on afterwards — it is the path the whole scheduler is built to handle
 * correctly, because it is the only path that currently executes.
 *
 * The rule it enforces: if we cannot open a credential, we do not call the provider. Not
 * "call it and see", not "try once in case". A call we know will fail costs money, costs
 * latency, and produces a gap we could have produced for free.
 */
import { openCredentialFor } from '@verify/security';
import type { ProviderId } from '@verify/connectors';
import { connections, credentials as credentialRows } from '../db/connections';
import type { Db } from '../db/d1';
import type { ConnectionResolution, CredentialResolver } from './ports';

/**
 * The AAD purpose for a connector's API token.
 *
 * Whoever builds the connect flow must seal with exactly this purpose, or the envelope
 * will not open here — which is the point: the AAD is what stops a ciphertext being moved
 * between tenants or between uses.
 */
export const CONNECTOR_CREDENTIAL_PURPOSE = 'connector_access_token';

/** Connection statuses we are willing to spend a provider call on. */
const USABLE_STATUSES: ReadonlySet<string> = new Set(['ready', 'degraded']);

export interface D1CredentialResolverOptions {
  readonly db: Db;
  /** The wrapping key, from the Worker binding. Absent means nothing can be opened. */
  readonly credentialKeyBase64?: string | undefined;
}

/**
 * Resolve connections out of D1.
 *
 * Every failure is returned, never thrown: a workspace with a broken connection must
 * produce an `UNVERIFIED` run, not a tick that dies and takes nine other workspaces' runs
 * down with it.
 */
export function createD1CredentialResolver(
  options: D1CredentialResolverOptions,
): CredentialResolver {
  const { db, credentialKeyBase64 } = options;

  return {
    async resolve(workspaceId: string, provider: ProviderId): Promise<ConnectionResolution> {
      const connection = await connections.getByProvider(db, workspaceId, provider);
      if (connection === null) {
        return {
          ok: false,
          reason: 'not_connected',
          detail: `no ${provider} connection exists for this workspace`,
        };
      }
      if (connection.revoked_at !== null || !USABLE_STATUSES.has(connection.status)) {
        return {
          ok: false,
          reason: 'connection_not_ready',
          detail: `${provider} connection is ${connection.status}`,
        };
      }

      const envelope = await credentialRows.activeForConnection(db, workspaceId, connection.id);
      if (envelope === null) {
        return { ok: false, reason: 'no_credential', detail: `no active ${provider} credential` };
      }
      if (credentialKeyBase64 === undefined || credentialKeyBase64.length === 0) {
        // The binding is missing. Saying so plainly beats a decrypt failure that reads
        // like a corrupted credential and sends someone hunting the wrong bug.
        return {
          ok: false,
          reason: 'credential_unreadable',
          detail: 'the credential wrapping key is not configured on this deployment',
        };
      }

      let accessToken: string;
      try {
        accessToken = await openCredentialFor(
          {
            ciphertext: envelope.ciphertext,
            nonce: envelope.nonce,
            aad: envelope.aad,
            key_version: envelope.key_version,
          },
          { workspaceId, provider, purpose: CONNECTOR_CREDENTIAL_PURPOSE },
          { keyBase64: credentialKeyBase64 },
        );
      } catch {
        // Deliberately no detail from the thrown error: it is the one place a credential
        // could leak into a log line, and there is nothing in it we could act on anyway.
        return {
          ok: false,
          reason: 'credential_unreadable',
          detail: `the stored ${provider} credential could not be opened`,
        };
      }

      return {
        ok: true,
        connection: {
          provider,
          credentials: { accessToken },
          connection: {
            provider,
            account_id: connection.external_account_id,
          },
        },
      };
    },
  };
}

/**
 * A resolver that connects to nothing, on purpose.
 *
 * Used by the demo and synthetic paths, and by any deployment with no credential key. It
 * exists so "we are not connected" is a configured, visible state rather than an accident
 * of a missing binding.
 */
export const NOT_CONNECTED_RESOLVER: CredentialResolver = {
  async resolve(_workspaceId: string, provider: ProviderId): Promise<ConnectionResolution> {
    return {
      ok: false,
      reason: 'not_connected',
      detail: `no ${provider} connection is configured on this deployment`,
    };
  },
};
