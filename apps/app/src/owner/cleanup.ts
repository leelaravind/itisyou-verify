/**
 * Safe cleanup — `/owner/cleanup`.
 *
 * Deleting things is the one owner action with no undo, so this module is written to make
 * the dangerous version impossible rather than discouraged.
 *
 * Five rules, each implemented rather than documented:
 *
 *  1. **Categories come from a closed list.** There is no pattern, no wildcard and no
 *     user-supplied filter anywhere in this file. A category the owner cannot name is a
 *     category that cannot be deleted.
 *  2. **Nothing is deleted that was not inventoried first.** `previewCleanup` produces the
 *     exact resource ids, and `executeCleanup` iterates that list — not a fresh query. A
 *     resource that appeared in the meantime is not in the run.
 *  3. **The inventory is hashed, and a changed hash rejects the run.** Between preview and
 *     execution the world may have moved. If it has, the owner reads the new inventory.
 *  4. **Identity is verified immediately before each delete.** The id matched ten minutes
 *     ago is not proof it matches now; `verify` is called per resource, and a mismatch
 *     skips that resource and records why.
 *  5. **An interrupted run reports `partial` and a resumable checkpoint.** It never
 *     reports success for work it did not finish. `claimsComplete` is false on every path
 *     except the one where every resource was actually handled.
 *
 * Out of scope, permanently, and refused by {@link isInScope} rather than by convention:
 * real customer data, evidence still inside its retention window, backups, active
 * credentials, and anything belonging to another project in the same Cloudflare account.
 * Those need the existing approval gates and a human decision, not a cleanup button.
 */
import { sha256Hex, stableStringify } from '@verify/security';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CleanupCategory {
  readonly id: string;
  readonly label: string;
  /** What this removes, in the owner's words. */
  readonly removes: string;
  /** Why it is safe to remove. If this sentence is hard to write, the category is wrong. */
  readonly safeBecause: string;
}

export const CLEANUP_CATEGORIES: readonly CleanupCategory[] = [
  {
    id: 'synthetic_workspaces',
    label: 'Synthetic demo workspaces',
    removes: 'Workspaces we created ourselves for demos and tests, and everything inside them.',
    safeBecause: 'Nobody signed up for these. They are marked synthetic at the moment they are created.',
  },
  {
    id: 'expired_sessions',
    label: 'Expired sign-in sessions',
    removes: 'Session rows whose expiry has already passed.',
    safeBecause: 'They cannot be used to sign in. Removing them frees space and shortens the list of things to review.',
  },
  {
    id: 'consumed_login_tokens',
    label: 'Used and expired magic links',
    removes: 'Magic-link rows that have already been used, or that expired without being used.',
    safeBecause: 'A used link cannot be used again, and an expired one never could be.',
  },
  {
    id: 'expired_visit_sessions',
    label: 'Expired visit records',
    removes: 'Aggregate visit rows past their retention date.',
    safeBecause: 'These hold no address and no identity, and we said we would delete them on this schedule.',
  },
  {
    id: 'dead_outbox_entries',
    label: 'Dead background jobs',
    removes: 'Outbox rows that exhausted their retries and were marked dead.',
    safeBecause: 'They will never be dispatched. Their failure is already recorded in the audit trail.',
  },
  {
    id: 'stale_quality_runs',
    label: 'Old test-centre runs',
    removes: 'Finished test runs older than the retention window, and their stored results.',
    safeBecause: 'The release evidence packs are kept separately. This removes the working rows, not the reports.',
  },
  {
    id: 'orphaned_preview_cleanups',
    label: 'Abandoned cleanup previews',
    removes: 'Cleanup previews that were never approved and are now out of date.',
    safeBecause: 'A preview deletes nothing. These are notes to ourselves that have gone stale.',
  },
];

const CATEGORY_BY_ID = new Map(CLEANUP_CATEGORIES.map((c) => [c.id, c]));

export function isCleanupCategory(value: string): boolean {
  return CATEGORY_BY_ID.has(value);
}

export function cleanupCategory(id: string): CleanupCategory | null {
  return CATEGORY_BY_ID.get(id) ?? null;
}

/** What safe cleanup will never touch, stated for the page and enforced by `isInScope`. */
export const OUT_OF_SCOPE: readonly { readonly what: string; readonly instead: string }[] = [
  {
    what: 'Real customer workspaces, runs and evidence',
    instead: 'Use the customer record and the deletion request flow, which records who asked and when.',
  },
  {
    what: 'Evidence still inside its retention window',
    instead: 'Wait for retention to expire, or change the retention setting deliberately and record why.',
  },
  {
    what: 'Backups and exports',
    instead: 'These are the thing you fall back on. Removing one needs a decision, not a cleanup run.',
  },
  {
    what: 'Active credentials and connections',
    instead: 'Rotate or revoke the connection on the Connections page, which tells the customer what happened.',
  },
  {
    what: 'Anything belonging to another project in the same account',
    instead:
      'This account holds unrelated Workers and databases. Nothing here touches a resource whose owner tag is not ours.',
  },
];

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** The ownership tag every resource this tool may touch must carry. */
export const OWNERSHIP_TAG = 'verify-itisyou';

export interface InventoryItem {
  /** The exact id that will be deleted. Never a pattern. */
  readonly resourceId: string;
  /** What kind of thing it is — `workspace`, `session`, `outbox_entry`. */
  readonly kind: string;
  readonly category: string;
  readonly environment: string;
  readonly ownershipTag: string;
  /** Best estimate of reclaimed bytes, or null when we genuinely do not know. Never zero as a guess. */
  readonly estimatedBytes: number | null;
  /**
   * A retention rule that still applies to this resource, or null when none does. A
   * non-null value means the resource is NOT deletable, however it was categorised.
   */
  readonly retentionConstraint: string | null;
  /** True when this resource can be quarantined instead of deleted. */
  readonly quarantineAvailable: boolean;
  /** True when this row represents genuine customer data. Always out of scope. */
  readonly isCustomerData: boolean;
}

export interface CleanupInventory {
  readonly items: readonly InventoryItem[];
  readonly hash: string;
  readonly categories: readonly string[];
  readonly environment: string;
  readonly takenAt: string;
  /** Items found but refused, with the reason. Shown, never silently dropped. */
  readonly excluded: readonly { readonly resourceId: string; readonly why: string }[];
  readonly totalEstimatedBytes: number | null;
}

export type ScopeRefusal =
  | 'not_our_resource'
  | 'customer_data'
  | 'under_retention'
  | 'category_not_allowed';

/**
 * The single scope gate. Every item passes through it in the preview and again in the
 * execution — deliberately twice, because the two calls are separated by a human reading a
 * page and by anything else that may have happened in between.
 */
export function isInScope(item: InventoryItem): { readonly ok: true } | { readonly ok: false; readonly refusal: ScopeRefusal; readonly why: string } {
  if (!isCleanupCategory(item.category)) {
    return {
      ok: false,
      refusal: 'category_not_allowed',
      why: `"${item.category}" is not one of the categories safe cleanup handles.`,
    };
  }
  if (item.ownershipTag !== OWNERSHIP_TAG) {
    return {
      ok: false,
      refusal: 'not_our_resource',
      why: `This resource is tagged "${item.ownershipTag}" and does not belong to this project. It will not be touched.`,
    };
  }
  if (item.isCustomerData) {
    return {
      ok: false,
      refusal: 'customer_data',
      why: 'This is real customer data. Deleting it goes through the customer record and the deletion request flow, not through cleanup.',
    };
  }
  if (item.retentionConstraint !== null) {
    return {
      ok: false,
      refusal: 'under_retention',
      why: `Still inside a retention rule: ${item.retentionConstraint}.`,
    };
  }
  return { ok: true };
}

/**
 * The hash the owner's approval is bound to.
 *
 * Every field that could change what gets deleted is in it. Ids are sorted so two scans
 * that found the same resources in a different order produce the same hash — an ordering
 * difference is not a change, and treating it as one would train the owner to click through
 * "the inventory changed" without reading it.
 */
export async function inventoryHash(
  items: readonly InventoryItem[],
  context: { readonly categories: readonly string[]; readonly environment: string },
): Promise<string> {
  const canonical = {
    environment: context.environment,
    categories: [...context.categories].sort(),
    items: [...items]
      .map((i) => ({
        resource_id: i.resourceId,
        kind: i.kind,
        category: i.category,
        ownership_tag: i.ownershipTag,
      }))
      .sort((a, b) => (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0)),
  };
  return sha256Hex(`verify.cleanup.inventory.v1:${stableStringify(canonical)}`);
}

export interface PreviewDeps {
  /** Scan one category. Returns everything it found, in scope or not — filtering is ours. */
  readonly scan: (category: string, environment: string) => Promise<readonly InventoryItem[]>;
  readonly now: Date;
}

export type PreviewResult =
  | { readonly ok: true; readonly inventory: CleanupInventory }
  | { readonly ok: false; readonly reason: 'no_categories' | 'unknown_category'; readonly detail: string };

/** Build the inventory. Deletes nothing; a preview that could delete would not be a preview. */
export async function previewCleanup(
  input: { readonly categories: readonly string[]; readonly environment: string },
  deps: PreviewDeps,
): Promise<PreviewResult> {
  if (input.categories.length === 0) {
    return { ok: false, reason: 'no_categories', detail: 'Choose at least one category to look at.' };
  }
  for (const category of input.categories) {
    if (!isCleanupCategory(category)) {
      return {
        ok: false,
        reason: 'unknown_category',
        detail: `"${category}" is not a cleanup category. Only the categories listed on this page can be run.`,
      };
    }
  }

  const items: InventoryItem[] = [];
  const excluded: { resourceId: string; why: string }[] = [];

  for (const category of input.categories) {
    for (const found of await deps.scan(category, input.environment)) {
      if (found.environment !== input.environment) {
        excluded.push({
          resourceId: found.resourceId,
          why: `Belongs to the ${found.environment} environment, not ${input.environment}.`,
        });
        continue;
      }
      const scope = isInScope(found);
      if (!scope.ok) {
        excluded.push({ resourceId: found.resourceId, why: scope.why });
        continue;
      }
      items.push(found);
    }
  }

  const known = items.filter((i) => i.estimatedBytes !== null);
  const totalEstimatedBytes =
    known.length === 0 && items.length > 0
      ? null
      : known.reduce((sum, i) => sum + (i.estimatedBytes ?? 0), 0);

  return {
    ok: true,
    inventory: {
      items,
      hash: await inventoryHash(items, input),
      categories: [...input.categories],
      environment: input.environment,
      takenAt: deps.now.toISOString(),
      excluded,
      totalEstimatedBytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ResourceOutcome = 'deleted' | 'quarantined' | 'skipped_identity_mismatch' | 'skipped_out_of_scope' | 'failed';

export interface ResourceReport {
  readonly resourceId: string;
  readonly kind: string;
  readonly category: string;
  readonly outcome: ResourceOutcome;
  readonly reclaimedBytes: number | null;
  /** Why, for everything that is not a plain `deleted`. */
  readonly detail: string | null;
}

export interface CleanupCheckpoint {
  /** Ids already handled, in order. Re-running with this checkpoint skips them. */
  readonly handled: readonly string[];
  /** Ids still to do. Empty only on a complete run. */
  readonly remaining: readonly string[];
  readonly inventoryHash: string;
}

export interface CleanupReport {
  readonly runId: string;
  readonly state: 'completed' | 'partial' | 'failed';
  /**
   * The one field a caller is allowed to read as "it is all done". False on every path
   * except a run where every inventoried resource was handled.
   */
  readonly claimsComplete: boolean;
  readonly inventoryHash: string;
  readonly categories: readonly string[];
  readonly environment: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly resources: readonly ResourceReport[];
  readonly deleted: number;
  readonly quarantined: number;
  readonly skipped: number;
  readonly failedCount: number;
  readonly reclaimedBytes: number | null;
  /** Non-null when the run stopped early. Feeds straight back into a resumed run. */
  readonly checkpoint: CleanupCheckpoint | null;
  /** One sentence for the owner. Never says "complete" on a partial run. */
  readonly summary: string;
}

export type ExecuteRefusal = 'inventory_changed' | 'no_approval' | 'empty_inventory';

export type ExecuteResult =
  | { readonly ok: true; readonly report: CleanupReport }
  | { readonly ok: false; readonly refusal: ExecuteRefusal; readonly detail: string };

export interface ExecuteDeps {
  /**
   * Re-scan and rebuild the inventory at execution time. The hash of this result is
   * compared with the approved one; a difference rejects the run.
   */
  readonly rescan: () => Promise<CleanupInventory>;
  /**
   * Prove this exact resource is still the thing we inventoried, immediately before it is
   * removed. `false` skips it and records why.
   */
  readonly verify: (item: InventoryItem) => Promise<boolean>;
  /**
   * Remove or quarantine one resource. Returning `interrupted` stops the run and produces a
   * partial report — a runner shutting down mid-sweep is a normal event, not an error.
   */
  readonly remove: (
    item: InventoryItem,
    mode: 'delete' | 'quarantine',
  ) => Promise<
    | { readonly status: 'done'; readonly reclaimedBytes: number | null }
    | { readonly status: 'failed'; readonly detail: string }
    | { readonly status: 'interrupted'; readonly detail: string }
  >;
  readonly now: () => Date;
}

export interface ExecuteInput {
  readonly runId: string;
  /** The hash the owner approved. Must still match the world. */
  readonly approvedInventoryHash: string;
  readonly quarantineInsteadOfDelete: boolean;
  /** Resume a previous partial run. Ids already handled are not repeated. */
  readonly resumeFrom?: CleanupCheckpoint;
}

/**
 * Run the cleanup.
 *
 * Never throws for an expected condition — a rejected run, a mismatched identity and an
 * interruption are all outcomes with reports, because an exception here would leave the
 * owner with no record of what had already been removed.
 */
export async function executeCleanup(input: ExecuteInput, deps: ExecuteDeps): Promise<ExecuteResult> {
  const startedAt = deps.now().toISOString();
  const current = await deps.rescan();

  if (current.hash !== input.approvedInventoryHash) {
    return {
      ok: false,
      refusal: 'inventory_changed',
      detail:
        'The list of things to remove is not the list you approved — something has been added or has gone away since ' +
        'you looked. Nothing has been deleted. Take a fresh preview and read it.',
    };
  }
  if (current.items.length === 0) {
    return {
      ok: false,
      refusal: 'empty_inventory',
      detail: 'There is nothing to remove in these categories. Nothing was deleted.',
    };
  }

  const alreadyHandled = new Set(input.resumeFrom?.handled ?? []);
  const mode = input.quarantineInsteadOfDelete ? 'quarantine' : 'delete';

  const resources: ResourceReport[] = [];
  const handled: string[] = [...alreadyHandled];
  let interrupted: string | null = null;
  let reclaimed = 0;
  let reclaimedKnown = false;

  for (const item of current.items) {
    if (alreadyHandled.has(item.resourceId)) continue;
    if (interrupted !== null) break;

    // Rule 4: scope is re-checked here, not trusted from the preview.
    const scope = isInScope(item);
    if (!scope.ok) {
      resources.push({
        resourceId: item.resourceId,
        kind: item.kind,
        category: item.category,
        outcome: 'skipped_out_of_scope',
        reclaimedBytes: null,
        detail: scope.why,
      });
      handled.push(item.resourceId);
      continue;
    }

    const stillTheSame = await deps.verify(item);
    if (!stillTheSame) {
      resources.push({
        resourceId: item.resourceId,
        kind: item.kind,
        category: item.category,
        outcome: 'skipped_identity_mismatch',
        reclaimedBytes: null,
        detail:
          'This resource is no longer the one we inventoried, so it was left alone. That is the safe outcome, not an error.',
      });
      handled.push(item.resourceId);
      continue;
    }

    const outcome = await deps.remove(item, mode);
    if (outcome.status === 'interrupted') {
      interrupted = outcome.detail;
      break;
    }
    if (outcome.status === 'failed') {
      resources.push({
        resourceId: item.resourceId,
        kind: item.kind,
        category: item.category,
        outcome: 'failed',
        reclaimedBytes: null,
        detail: outcome.detail,
      });
      handled.push(item.resourceId);
      continue;
    }

    if (outcome.reclaimedBytes !== null) {
      reclaimed += outcome.reclaimedBytes;
      reclaimedKnown = true;
    }
    resources.push({
      resourceId: item.resourceId,
      kind: item.kind,
      category: item.category,
      outcome: mode === 'quarantine' ? 'quarantined' : 'deleted',
      reclaimedBytes: outcome.reclaimedBytes,
      detail: null,
    });
    handled.push(item.resourceId);
  }

  const handledSet = new Set(handled);
  const remaining = current.items.filter((i) => !handledSet.has(i.resourceId)).map((i) => i.resourceId);
  const complete = remaining.length === 0 && interrupted === null;

  const deleted = resources.filter((r) => r.outcome === 'deleted').length;
  const quarantined = resources.filter((r) => r.outcome === 'quarantined').length;
  const skipped = resources.filter(
    (r) => r.outcome === 'skipped_identity_mismatch' || r.outcome === 'skipped_out_of_scope',
  ).length;
  const failedCount = resources.filter((r) => r.outcome === 'failed').length;

  const state: CleanupReport['state'] = complete ? (failedCount > 0 ? 'failed' : 'completed') : 'partial';

  const summary = complete
    ? failedCount > 0
      ? `Finished the list. ${deleted + quarantined} handled, ${failedCount} could not be removed and are still there.`
      : `Finished. ${deleted + quarantined} removed, ${skipped} left alone on purpose.`
    : `Stopped before the end. ${deleted + quarantined} removed so far, ${remaining.length} not yet looked at. ` +
      `This run is NOT complete${interrupted === null ? '' : `: ${interrupted}`}. Resume it to finish.`;

  return {
    ok: true,
    report: {
      runId: input.runId,
      state,
      claimsComplete: complete && failedCount === 0,
      inventoryHash: current.hash,
      categories: current.categories,
      environment: current.environment,
      startedAt,
      endedAt: deps.now().toISOString(),
      resources,
      deleted,
      quarantined,
      skipped,
      failedCount,
      reclaimedBytes: reclaimedKnown ? reclaimed : null,
      checkpoint: complete
        ? null
        : { handled, remaining, inventoryHash: current.hash },
      summary,
    },
  };
}
