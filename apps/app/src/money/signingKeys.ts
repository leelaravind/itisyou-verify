/**
 * The workflow event-signing key: issuing one, and resolving one on an arriving request.
 *
 * ## Why this file had to be written
 *
 * `POST /api/v1/events` is the door the whole product is named for, and it was never
 * mounted. Tracing why, the reason turned out to be one layer further down: the schema has
 * held `workflows.signing_key_hash` and `workflows.signing_key_ref` since the first
 * migration, `workflows.setSigningKey` has existed to write them, and **nothing has ever
 * called it**. No customer could hold a key, so no signed request could be verified, so
 * there was no route to mount. Same defect class, one floor lower.
 *
 * ## What a signing key proves, and what it does not
 *
 * It proves *who submitted the expectation*. It does not make the expectation true — that
 * is the entire premise of the product, and it is written into the frozen contract. A
 * verified signature gets you as far as "this workspace asked us to check this", and not
 * one step further.
 *
 * ## Shape
 *
 * Two headers, because the key id has to be readable without the secret:
 *
 *     X-Verify-Key-Id:    cred_...          the credential row, an opaque public id
 *     X-Verify-Signature: t=<unix>,v1=<hex> HMAC-SHA-256 over `${t}.${rawBody}`
 *
 * The secret itself is 32 random bytes, base64url, shown to the customer **once** at
 * issue and never again. What we keep is:
 *
 *  - `workflows.signing_key_hash` — `hashToken(secret, 'workflow_signing')`, so a support
 *    conversation can confirm *which* key a customer is holding without us holding it in
 *    the clear, and so a mask can be rendered on the activation page.
 *  - `workflows.signing_key_ref` — the `credential_versions` row id, which is also the
 *    public key id. The secret lives there inside an AES-GCM envelope whose AAD binds the
 *    workspace, the "provider" (`workflow`) and the purpose, exactly like every other
 *    stored credential in this system.
 *
 * Verification needs the secret back, so the envelope is opened per request with
 * `CREDENTIAL_KEY_V1`. A deployment with no wrapping key cannot open it and therefore
 * cannot verify anything — which is the correct degraded behaviour, and the route says so
 * as a 503 rather than pretending the signature was wrong.
 *
 * ## Rotation
 *
 * `credentials.store` retires the previous active version for the scope and inserts the
 * new one in one batch, so there is never a moment with two live keys. Issuing again is
 * therefore a rotation: the old key id stops resolving immediately. That is deliberate and
 * it is the honest behaviour — a dual-key window is a feature we have not built, and
 * pretending a retired key still works would be worse than a clean break the customer was
 * told about.
 */
import { AppError } from '@verify/contracts';
import {
  hashToken,
  openCredentialFor,
  sealCredentialFor,
  toBase64Url,
} from '@verify/security';
import { credentials } from '../db/connections';
import type { Db } from '../db/d1';
import { workflows } from '../db/workflows';
import { ID_PREFIX, newId } from '../lib/ids';

/**
 * The AAD parts. `provider` is a required field of the shared credential context and there
 * is no external provider here, so it names the thing the key belongs to instead. It is
 * authenticated by GCM either way, which is the only property that matters.
 */
export const WORKFLOW_SIGNING_PROVIDER = 'workflow';
export const WORKFLOW_SIGNING_PURPOSE = 'event_signing';

/** The domain separator for the stored hash. Never reused for any other token. */
export const WORKFLOW_SIGNING_HASH_DOMAIN = 'workflow_signing';

/** `credential_versions.owner_scope` for a workflow's signing key. */
export function workflowScope(workflowId: string): string {
  return `workflow:${workflowId}`;
}

export interface IssuedSigningKey {
  /** The public id the customer sends in `X-Verify-Key-Id`. */
  readonly keyId: string;
  /**
   * The secret. **Returned once and never recoverable.** The caller shows it to the
   * customer and must not log it, store it, or put it in an audit row.
   */
  readonly secret: string;
  /** What we keep, so the activation page can render a mask. */
  readonly secretHash: string;
  readonly issuedAt: string;
}

export interface IssueSigningKeyDeps {
  readonly db: Db;
  /** Base64 AES-GCM wrapping key. Absent on a deployment with no `CREDENTIAL_KEY_V1`. */
  readonly credentialKeyBase64: string;
  readonly keyVersion?: number;
  readonly now: string;
  readonly newId?: (prefix: string) => string;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/**
 * Issue (or rotate) the signing key for one workflow.
 *
 * Order matters and it is the safe one: seal and store the credential first, then stamp
 * the workflow. A crash between the two leaves an orphan credential version that nothing
 * points at — harmless, and the next issue retires it. The reverse order would leave a
 * workflow pointing at a credential that does not exist, which is a 500 on the hottest
 * untrusted path in the system.
 */
export async function issueWorkflowSigningKey(
  deps: IssueSigningKeyDeps,
  params: { readonly workspaceId: string; readonly workflowId: string },
): Promise<IssuedSigningKey> {
  if (deps.credentialKeyBase64.length === 0) {
    throw new AppError(
      503,
      'CREDENTIAL_KEY_MISSING',
      'This deployment has no credential wrapping key, so a signing key cannot be issued.',
    );
  }
  const mint = deps.newId ?? ((prefix: string) => newId(prefix));
  const random = deps.randomBytes ?? defaultRandomBytes;

  const secret = toBase64Url(random(32));
  const secretHash = await hashToken(secret, WORKFLOW_SIGNING_HASH_DOMAIN);
  const keyVersion = deps.keyVersion ?? 1;

  const envelope = await sealCredentialFor(
    secret,
    {
      workspaceId: params.workspaceId,
      provider: WORKFLOW_SIGNING_PROVIDER,
      purpose: WORKFLOW_SIGNING_PURPOSE,
    },
    { keyBase64: deps.credentialKeyBase64, keyVersion },
  );

  const keyId = mint(ID_PREFIX.credential);
  await credentials.store(deps.db, {
    id: keyId,
    ownerScope: workflowScope(params.workflowId),
    connectionId: null,
    keyVersion,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    aad: envelope.aad,
    createdAt: deps.now,
  });

  const stamped = await workflows.setSigningKey(deps.db, params.workspaceId, params.workflowId, {
    signingKeyHash: secretHash,
    signingKeyRef: keyId,
  });
  if (!stamped) {
    throw new AppError(
      404,
      'WORKFLOW_NOT_FOUND',
      'That workflow does not belong to this workspace, so no key was issued.',
    );
  }

  return { keyId, secret, secretHash, issuedAt: deps.now };
}

/**
 * Everything the events route needs about the caller, resolved from the key id alone.
 *
 * The workspace comes from here and **never from the request body**. That is the whole
 * point of the credential: a payload can claim any workspace it likes, and claiming is not
 * proving.
 */
export interface ResolvedSigningKey {
  readonly keyId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly deadlineSeconds: number;
  /** The secret, opened for this request. Never logged, never returned to a caller. */
  readonly secret: string;
}

export type SigningKeyResolution =
  | { readonly outcome: 'resolved'; readonly key: ResolvedSigningKey }
  /** No such key id, or it has been retired, or the workflow is not active. */
  | { readonly outcome: 'unknown' }
  /** The envelope exists but this deployment cannot open it. A 503, not a rejection. */
  | { readonly outcome: 'unreadable' };

/**
 * The port the route depends on, so a test can drive the route without a wrapping key and
 * the composition root can supply the real D1-backed resolver.
 */
export type SigningKeyResolver = (keyId: string) => Promise<SigningKeyResolution>;

interface SigningKeyRow {
  readonly credential_id: string;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly aad: string;
  readonly key_version: number;
  readonly workspace_id: string;
  readonly workflow_id: string;
  readonly version_id: string;
  readonly deadline_seconds: number;
}

/**
 * The real resolver, over D1.
 *
 * One query. The join is what makes the lookup tenant-safe without a workspace predicate:
 * the key id is the only thing the caller supplied, and the workspace is *derived* from
 * the workflow that owns the scope rather than accepted from anywhere. `retired_at IS
 * NULL` is what makes a rotation take effect immediately, and `signing_key_ref = cv.id` is
 * what stops a retired-but-not-yet-deleted row from still authenticating.
 */
export function createSigningKeyResolver(deps: {
  readonly db: Db;
  readonly credentialKeyBase64: string;
}): SigningKeyResolver {
  return async (keyId: string): Promise<SigningKeyResolution> => {
    if (keyId.length === 0 || keyId.length > 64) return { outcome: 'unknown' };
    // tenant-scope:exempt resolves the workspace FROM the credential the caller proved it
    // holds; a workspace predicate here would require the answer as an input.
    const row = await deps.db
      .prepare(
        `SELECT cv.id AS credential_id, cv.ciphertext, cv.nonce, cv.aad, cv.key_version,
                w.workspace_id, w.id AS workflow_id,
                v.id AS version_id, v.deadline_seconds
           FROM credential_versions cv
           JOIN workflows w
             ON w.signing_key_ref = cv.id
            AND cv.owner_scope = 'workflow:' || w.id
           JOIN workflow_versions v
             ON v.id = w.current_version_id AND v.workspace_id = w.workspace_id
          WHERE cv.id = ? AND cv.retired_at IS NULL
            AND w.status = 'active' AND w.archived_at IS NULL`,
      )
      .bind(keyId)
      .first<SigningKeyRow>();
    if (row === null) return { outcome: 'unknown' };

    if (deps.credentialKeyBase64.length === 0) return { outcome: 'unreadable' };
    let secret: string;
    try {
      secret = await openCredentialFor(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          aad: row.aad,
          key_version: row.key_version,
        },
        {
          workspaceId: row.workspace_id,
          provider: WORKFLOW_SIGNING_PROVIDER,
          purpose: WORKFLOW_SIGNING_PURPOSE,
        },
        { keyBase64: deps.credentialKeyBase64 },
      );
    } catch {
      // A wrong wrapping key, a rotated key we no longer hold, or a tampered row. All of
      // them are our problem, not the caller's, and all of them must read the same from
      // outside.
      return { outcome: 'unreadable' };
    }

    return {
      outcome: 'resolved',
      key: {
        keyId: row.credential_id,
        workspaceId: row.workspace_id,
        workflowId: row.workflow_id,
        workflowVersionId: row.version_id,
        deadlineSeconds: row.deadline_seconds,
        secret,
      },
    };
  };
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
