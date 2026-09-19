/**
 * Workflow event-signing key lookup, in D1.
 *
 * Moved verbatim from `tests/integration/money/d1ports.ts` on 19 September 2026. It was
 * written there because `SEC-201` forbids SQL outside this directory and its author did
 * not own this directory. The algorithms were proved against the real migrated schema
 * there; what was missing was that nothing in production implemented the port at all, so
 * no claim that this "runs in production" could be made. Moving it here is what makes
 * that claim true, and the mount in `apps/app/src/index.ts` is what makes it reachable.
 *
 * The statements are unchanged. Every one is workspace-scoped except where a marker and a
 * reason say why it cannot be.
 */
import type { Db } from './d1.js';
import type {
  SigningKeyStore,
  StoredSigningKey,
} from '../money/ports.js';

export class D1WorkflowSigningKeys implements SigningKeyStore {
  constructor(private readonly db: Db) {}

  async findActiveWorkflowSigningKey(keyId: string): Promise<StoredSigningKey | null> {
    // tenant-scope:exempt resolves the workspace FROM the key reference the caller
    // presented; a workspace predicate would require the answer as an input, and what
    // makes it safe is the signature check the route performs immediately afterwards.
    const row = await this.db
      .prepare(
        `SELECT w.workspace_id, w.id AS workflow_id, w.signing_key_ref,
                v.id AS version_id, v.deadline_seconds
           FROM workflows w
           JOIN workflow_versions v
             ON v.id = w.current_version_id AND v.workspace_id = w.workspace_id
          WHERE w.signing_key_ref = ? AND w.status = 'active' AND w.archived_at IS NULL`,
      )
      .bind(keyId)
      .first<{
        workspace_id: string;
        workflow_id: string;
        signing_key_ref: string;
        version_id: string;
        deadline_seconds: number;
      }>();
    if (row === null) return null;
    return {
      keyId: row.signing_key_ref,
      workspaceId: row.workspace_id,
      workflowId: row.workflow_id,
      workflowVersionId: row.version_id,
      deadlineSeconds: row.deadline_seconds,
    };
  }
}

/**
 * The factory the composition root calls. Kept beside the class so a caller never has to
 * know it is a class, and so swapping the implementation is one edit here.
 */
export function createWorkflowSigningKeyStore(db: Db): SigningKeyStore {
  return new D1WorkflowSigningKeys(db);
}
