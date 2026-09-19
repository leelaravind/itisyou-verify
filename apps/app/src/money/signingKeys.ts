/**
 * The workflow event-signing key: issuing one, and resolving one on an arriving request.
 *
 * ## Why this file had to be written
 *
 * `POST /api/v1/events` is the door the product is named for, and it was never mounted.
 * Tracing why, the reason turned out to be one floor further down: the schema has held
 * `workflows.signing_key_hash` and `workflows.signing_key_ref` since the first migration,
 * `workflows.setSigningKey` has existed to write them, and **nothing has ever called it**.
 * No customer could hold a key, so no signed request could be verified, so there was no
 * route to mount. The same defect class, one layer under the one it was reported at.
 *
 * ## What a signing key proves, and what it does not
 *
 * It proves *who submitted the expectation*. It does not make the expectation true — that
 * is the whole premise of the product and it is written into the frozen contract. A
 * verified signature gets you to "this workspace asked us to check this" and no further.
 *
 * ## Shape
 *
 * Two headers, because the key id has to be readable without the secret:
 *
 *     X-Verify-Key-Id:    evk_...           the key reference, an opaque public id
 *     X-Verify-Signature: t=<unix>,v1=<hex> HMAC-SHA-256 over `${t}.${rawBody}`
 *
 * ## The secret is derived, not stored
 *
 * `secret = HMAC-SHA-256(EVENT_SIGNING_ROOT_KEY, "verify.event_signing.v1:ws:wf:ref")`.
 *
 * Nothing about the key is written to the database except the reference and a hash. This
 * is the same reasoning A06 recorded for the Stripe webhook secret in `billing/mount.ts`,
 * and it lands the same way here:
 *
 *  - **There is nowhere correct to put it.** Stored credentials in this system live in
 *    AES-GCM envelopes in `credential_versions`, and migration `0002` constrains
 *    `owner_scope` to `connection:*` or `user:*` — deliberately, so a third shape cannot
 *    appear without somebody deciding it should. A workflow is neither, and widening that
 *    CHECK to store a secret that never leaves the Worker would be ceremony around a
 *    weaker outcome.
 *  - **A derived secret has no rest state to leak.** There is no ciphertext, no nonce and
 *    no row to steal. Reading the whole `workflows` table buys an attacker the key
 *    *reference* and a hash, neither of which signs anything.
 *  - **Rotation is a new reference.** `setSigningKey` overwrites `signing_key_ref`, the old
 *    reference stops resolving on the next request, and the old secret becomes
 *    unreachable — nothing to retire, nothing to clean up, and no dual-key window
 *    pretending to exist.
 *
 * What we do keep is `signing_key_hash = hashToken(secret, 'workflow_signing')`, so support
 * can confirm *which* key a customer is holding, and the activation page can render a mask,
 * without us holding the key in a usable form.
 *
 * A deployment with no `EVENT_SIGNING_ROOT_KEY` cannot derive anything and therefore cannot
 * verify anything. That is a **503**, not a rejection: the caller did nothing wrong, and
 * answering "your signature is invalid" would send a customer hunting for a bug they do not
 * have.
 */
import { AppError } from '@verify/contracts';
import { hashToken, hmacSha256Hex } from '@verify/security';
import type { Db } from '../db/d1';
import { workflows } from '../db/workflows';
import { newId } from '../lib/ids';
import type { SigningKeyStore } from './ports';

/** The id prefix for a signing-key reference. Not in `ID_PREFIX`: it is not an entity. */
export const SIGNING_KEY_REF_PREFIX = 'evk';

/** The domain separator for the stored hash. Never reused for any other token. */
export const WORKFLOW_SIGNING_HASH_DOMAIN = 'workflow_signing';

/**
 * The derivation input. Versioned, and it names every fact the key is bound to.
 *
 * The workspace is in here on purpose: a workflow that somehow changed hands would derive
 * a different secret, so an old key cannot follow it.
 */
export function signingKeyMaterial(params: {
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly keyRef: string;
}): string {
  return `verify.event_signing.v1:${params.workspaceId}:${params.workflowId}:${params.keyRef}`;
}

/** Derive the secret for one key reference. Deterministic; nothing is stored. */
export async function deriveSigningSecret(
  rootKey: string,
  params: { readonly workspaceId: string; readonly workflowId: string; readonly keyRef: string },
): Promise<string> {
  return hmacSha256Hex(rootKey, signingKeyMaterial(params));
}

export interface IssuedSigningKey {
  /** The public reference the customer sends in `X-Verify-Key-Id`. */
  readonly keyId: string;
  /**
   * The secret. Returned so the caller can show it to the customer **once**. It must not be
   * logged, stored, or put in an audit row — it is re-derivable from the root key and the
   * reference, and that is the only copy that should exist.
   */
  readonly secret: string;
  /** What we keep, so the activation page can render a mask. */
  readonly secretHash: string;
  readonly issuedAt: string;
}

export interface IssueSigningKeyDeps {
  readonly db: Db;
  /** The Worker secret every signing key is derived from. Absent on a bare deployment. */
  readonly rootKey: string;
  readonly now: string;
  readonly newId?: (prefix: string) => string;
}

/**
 * Issue (or rotate) the signing key for one workflow.
 *
 * Calling it twice produces two independent keys and only the second one works, because
 * `signing_key_ref` holds exactly one reference. There is no window in which both are live.
 */
export async function issueWorkflowSigningKey(
  deps: IssueSigningKeyDeps,
  params: { readonly workspaceId: string; readonly workflowId: string },
): Promise<IssuedSigningKey> {
  if (deps.rootKey.length === 0) {
    throw new AppError(
      503,
      'EVENT_SIGNING_UNCONFIGURED',
      'This deployment has no event-signing root key, so a signing key cannot be issued.',
    );
  }
  const mint = deps.newId ?? ((prefix: string) => newId(prefix));
  const keyId = mint(SIGNING_KEY_REF_PREFIX);
  const secret = await deriveSigningSecret(deps.rootKey, {
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    keyRef: keyId,
  });
  const secretHash = await hashToken(secret, WORKFLOW_SIGNING_HASH_DOMAIN);

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
 * The workspace comes from here and **never from the request body**. That is the entire
 * point of the credential: a payload can claim any workspace it likes, and claiming is not
 * proving.
 */
export interface ResolvedSigningKey {
  readonly keyId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly deadlineSeconds: number;
  /** The secret, derived for this request. Never logged, never returned to a caller. */
  readonly secret: string;
}

export type SigningKeyResolution =
  | { readonly outcome: 'resolved'; readonly key: ResolvedSigningKey }
  /** No such reference, or the workflow is archived or inactive. */
  | { readonly outcome: 'unknown' }
  /** The reference is ours but this deployment cannot derive a secret. A 503, not a 401. */
  | { readonly outcome: 'unreadable' };

/** The route depends on this, so a test can drive it and the root can supply the real one. */
export type SigningKeyResolver = (keyId: string) => Promise<SigningKeyResolution>;

/**
 * The real resolver.
 *
 * There is no SQL in this file and there must not be: `apps/app/src/db/` is the only place
 * a statement naming a customer-scoped table may live, and `workflows` and
 * `workflow_versions` are both customer-scoped. `SEC-201` enforces it, and the rule is the
 * reason tenant scoping can be checked in one place instead of remembered in twelve.
 *
 * The store's contract carries the tenancy property: the workspace is **derived** from the
 * workflow that holds the reference, never accepted from the caller. A workspace predicate
 * is impossible here because discovering the workspace is the purpose of the call — and
 * what makes that safe is not a predicate but the signature check the caller has to pass
 * immediately afterwards.
 */
export function createSigningKeyResolver(deps: {
  readonly store: SigningKeyStore;
  readonly rootKey: string;
}): SigningKeyResolver {
  return async (keyId: string): Promise<SigningKeyResolution> => {
    if (keyId.length === 0 || keyId.length > 64) return { outcome: 'unknown' };

    const stored = await deps.store.findActiveWorkflowSigningKey(keyId);
    if (stored === null) return { outcome: 'unknown' };
    if (deps.rootKey.length === 0) return { outcome: 'unreadable' };

    const secret = await deriveSigningSecret(deps.rootKey, {
      workspaceId: stored.workspaceId,
      workflowId: stored.workflowId,
      keyRef: stored.keyId,
    });

    return {
      outcome: 'resolved',
      key: {
        keyId: stored.keyId,
        workspaceId: stored.workspaceId,
        workflowId: stored.workflowId,
        workflowVersionId: stored.workflowVersionId,
        deadlineSeconds: stored.deadlineSeconds,
        secret,
      },
    };
  };
}
