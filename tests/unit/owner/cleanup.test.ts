/**
 * Safe cleanup.
 *
 * The properties, in order of how much damage their absence would do:
 *  - real customer data, retained evidence and another project's resources are never in an
 *    inventory, whatever category they were filed under;
 *  - a changed inventory hash rejects the run before anything is deleted;
 *  - identity is re-proved immediately before each delete;
 *  - an interrupted run reports partial and never claims success.
 */
import { describe, expect, it } from 'vitest';
import {
  CLEANUP_CATEGORIES,
  OUT_OF_SCOPE,
  OWNERSHIP_TAG,
  cleanupCategory,
  executeCleanup,
  inventoryHash,
  isCleanupCategory,
  isInScope,
  previewCleanup,
  type CleanupInventory,
  type ExecuteDeps,
  type InventoryItem,
} from '@app/owner/cleanup';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ENV = 'staging';

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    resourceId: 'sess_expired_1',
    kind: 'session',
    category: 'expired_sessions',
    environment: ENV,
    ownershipTag: OWNERSHIP_TAG,
    estimatedBytes: 320,
    retentionConstraint: null,
    quarantineAvailable: false,
    isCustomerData: false,
    ...overrides,
  };
}

const OWNED = [
  item({ resourceId: 'sess_expired_1' }),
  item({ resourceId: 'sess_expired_2' }),
  item({ resourceId: 'ws_synth_1', kind: 'workspace', category: 'synthetic_workspaces', estimatedBytes: 4096, quarantineAvailable: true }),
];

const FORBIDDEN = [
  item({ resourceId: 'ws_real_customer', category: 'synthetic_workspaces', isCustomerData: true }),
  item({ resourceId: 'evd_retained', category: 'synthetic_workspaces', retentionConstraint: 'evidence is kept for 30 days' }),
  item({ resourceId: 'other-project-bucket', category: 'synthetic_workspaces', ownershipTag: 'unrelated-project' }),
];

function scanner(items: readonly InventoryItem[]) {
  return async (category: string) => items.filter((i) => i.category === category);
}

async function preview(items: readonly InventoryItem[], categories: readonly string[]) {
  const result = await previewCleanup({ categories, environment: ENV }, { scan: scanner(items), now: NOW });
  if (!result.ok) throw new Error(`preview failed: ${result.detail}`);
  return result.inventory;
}

describe('safe cleanup', () => {
  it('OWNER-080 the preview lists exact resource ids, never a pattern', async () => {
    const inventory = await preview(OWNED, ['expired_sessions', 'synthetic_workspaces']);
    expect(inventory.items.map((i) => i.resourceId).sort()).toEqual(['sess_expired_1', 'sess_expired_2', 'ws_synth_1']);
    for (const entry of inventory.items) {
      expect(entry.resourceId).not.toContain('*');
      expect(entry.resourceId).not.toContain('%');
    }
  });

  it('OWNER-081 every inventory row carries environment, owner tag, category, size and retention', async () => {
    const inventory = await preview(OWNED, ['expired_sessions']);
    for (const entry of inventory.items) {
      expect(entry.environment).toBe(ENV);
      expect(entry.ownershipTag).toBe(OWNERSHIP_TAG);
      expect(isCleanupCategory(entry.category)).toBe(true);
      expect(entry.estimatedBytes).not.toBeUndefined();
      expect(entry.retentionConstraint).toBeNull();
      expect(typeof entry.quarantineAvailable).toBe('boolean');
    }
  });

  it('OWNER-082 real customer data is excluded from the inventory and the exclusion is shown', async () => {
    const inventory = await preview([...OWNED, ...FORBIDDEN], ['expired_sessions', 'synthetic_workspaces']);
    expect(inventory.items.map((i) => i.resourceId)).not.toContain('ws_real_customer');
    expect(inventory.excluded.map((e) => e.resourceId)).toContain('ws_real_customer');
  });

  it('OWNER-083 evidence still under retention is excluded', async () => {
    const inventory = await preview([...OWNED, ...FORBIDDEN], ['synthetic_workspaces']);
    expect(inventory.items.map((i) => i.resourceId)).not.toContain('evd_retained');
    const reason = inventory.excluded.find((e) => e.resourceId === 'evd_retained')?.why ?? '';
    expect(reason).toMatch(/retention/i);
  });

  it('OWNER-084 another project’s resource is excluded and named as not ours', async () => {
    const inventory = await preview([...OWNED, ...FORBIDDEN], ['synthetic_workspaces']);
    expect(inventory.items.map((i) => i.resourceId)).not.toContain('other-project-bucket');
    const reason = inventory.excluded.find((e) => e.resourceId === 'other-project-bucket')?.why ?? '';
    expect(reason).toMatch(/does not belong to this project/i);
  });

  it('OWNER-085 a resource from another environment is excluded', async () => {
    const inventory = await preview([item({ resourceId: 'prod_session', environment: 'production' })], ['expired_sessions']);
    expect(inventory.items).toHaveLength(0);
    expect(inventory.excluded[0]?.why).toMatch(/production/);
  });

  it('OWNER-086 a category outside the allowlist is refused, and there is no wildcard', async () => {
    const result = await previewCleanup({ categories: ['*'], environment: ENV }, { scan: scanner(OWNED), now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unknown_category');
    expect(isCleanupCategory('*')).toBe(false);
    expect(cleanupCategory('anything_at_all')).toBeNull();
  });

  it('OWNER-087 a preview with no categories does nothing', async () => {
    const result = await previewCleanup({ categories: [], environment: ENV }, { scan: scanner(OWNED), now: NOW });
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('no_categories');
  });

  it('OWNER-088 the inventory hash ignores ordering but not membership', async () => {
    const a = await inventoryHash(OWNED, { categories: ['expired_sessions'], environment: ENV });
    const b = await inventoryHash([...OWNED].reverse(), { categories: ['expired_sessions'], environment: ENV });
    expect(a).toBe(b);
    const c = await inventoryHash(OWNED.slice(0, 2), { categories: ['expired_sessions'], environment: ENV });
    expect(a).not.toBe(c);
  });

  it('OWNER-089 executing with a stale inventory hash deletes nothing', async () => {
    const inventory = await preview(OWNED, ['expired_sessions']);
    const removed: string[] = [];
    const result = await executeCleanup(
      { runId: 'clr_1', approvedInventoryHash: 'a-hash-from-before', quarantineInsteadOfDelete: false },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (entry) => {
          removed.push(entry.resourceId);
          return { status: 'done', reclaimedBytes: 1 };
        },
        now: () => NOW,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('inventory_changed');
    expect(removed).toHaveLength(0);
  });

  it('OWNER-090 an inventory that grew between preview and execution rejects the run', async () => {
    const approved = await preview(OWNED, ['expired_sessions']);
    const grown = await preview([...OWNED, item({ resourceId: 'sess_expired_3' })], ['expired_sessions']);
    const result = await executeCleanup(
      { runId: 'clr_2', approvedInventoryHash: approved.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => grown,
        verify: async () => true,
        remove: async () => ({ status: 'done', reclaimedBytes: 0 }),
        now: () => NOW,
      },
    );
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('inventory_changed');
  });

  it('OWNER-091 a matching hash removes exactly the inventoried resources and nothing else', async () => {
    const inventory = await preview(OWNED, ['expired_sessions', 'synthetic_workspaces']);
    const removed: string[] = [];
    const result = await executeCleanup(
      { runId: 'clr_3', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (entry) => {
          removed.push(entry.resourceId);
          return { status: 'done', reclaimedBytes: entry.estimatedBytes };
        },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(removed.sort()).toEqual(['sess_expired_1', 'sess_expired_2', 'ws_synth_1']);
    expect(result.report.state).toBe('completed');
    expect(result.report.claimsComplete).toBe(true);
    expect(result.report.deleted).toBe(3);
  });

  it('OWNER-092 identity is proved immediately before each delete, and a mismatch skips it', async () => {
    const inventory = await preview(OWNED, ['expired_sessions']);
    const order: string[] = [];
    const result = await executeCleanup(
      { runId: 'clr_4', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => inventory,
        verify: async (entry) => {
          order.push(`verify:${entry.resourceId}`);
          return entry.resourceId !== 'sess_expired_2';
        },
        remove: async (entry) => {
          order.push(`remove:${entry.resourceId}`);
          return { status: 'done', reclaimedBytes: 1 };
        },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(order).toEqual(['verify:sess_expired_1', 'remove:sess_expired_1', 'verify:sess_expired_2']);
    expect(result.report.deleted).toBe(1);
    expect(result.report.skipped).toBe(1);
    const skipped = result.report.resources.find((r) => r.resourceId === 'sess_expired_2');
    expect(skipped?.outcome).toBe('skipped_identity_mismatch');
  });

  it('OWNER-093 scope is re-checked at execution, not trusted from the preview', async () => {
    const inventory = await preview(OWNED, ['expired_sessions']);
    // Something turned this row into customer data after the preview was taken.
    const poisoned: CleanupInventory = {
      ...inventory,
      items: inventory.items.map((i) => (i.resourceId === 'sess_expired_1' ? { ...i, isCustomerData: true } : i)),
    };
    const removed: string[] = [];
    const result = await executeCleanup(
      { runId: 'clr_5', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => poisoned,
        verify: async () => true,
        remove: async (entry) => {
          removed.push(entry.resourceId);
          return { status: 'done', reclaimedBytes: 1 };
        },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(removed).not.toContain('sess_expired_1');
    expect(result.report.resources.find((r) => r.resourceId === 'sess_expired_1')?.outcome).toBe('skipped_out_of_scope');
  });

  it('OWNER-094 an interrupted run reports partial and never claims completion', async () => {
    const inventory = await preview(OWNED, ['expired_sessions', 'synthetic_workspaces']);
    const result = await executeCleanup(
      { runId: 'clr_6', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (entry) =>
          entry.resourceId === 'sess_expired_2'
            ? { status: 'interrupted', detail: 'the runner was shut down mid-sweep' }
            : { status: 'done', reclaimedBytes: 1 },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.report.state).toBe('partial');
    expect(result.report.claimsComplete).toBe(false);
    expect(result.report.summary).toMatch(/NOT complete/);
    expect(result.report.summary).toMatch(/shut down mid-sweep/);
  });

  it('OWNER-095 an interrupted run leaves a resumable checkpoint naming what is left', async () => {
    const inventory = await preview(OWNED, ['expired_sessions', 'synthetic_workspaces']);
    const result = await executeCleanup(
      { runId: 'clr_7', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (entry) =>
          entry.resourceId === 'sess_expired_2'
            ? { status: 'interrupted', detail: 'power cut' }
            : { status: 'done', reclaimedBytes: 1 },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    const checkpoint = result.report.checkpoint;
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.handled).toEqual(['sess_expired_1']);
    expect(checkpoint?.remaining).toEqual(['sess_expired_2', 'ws_synth_1']);
  });

  it('OWNER-096 resuming from a checkpoint does not repeat work already done', async () => {
    const inventory = await preview(OWNED, ['expired_sessions', 'synthetic_workspaces']);
    const removed: string[] = [];
    const result = await executeCleanup(
      {
        runId: 'clr_8',
        approvedInventoryHash: inventory.hash,
        quarantineInsteadOfDelete: false,
        resumeFrom: { handled: ['sess_expired_1'], remaining: ['sess_expired_2', 'ws_synth_1'], inventoryHash: inventory.hash },
      },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (entry) => {
          removed.push(entry.resourceId);
          return { status: 'done', reclaimedBytes: 1 };
        },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(removed).not.toContain('sess_expired_1');
    expect(removed.sort()).toEqual(['sess_expired_2', 'ws_synth_1']);
    expect(result.report.claimsComplete).toBe(true);
  });

  it('OWNER-097 a run where something could not be removed is not reported as complete success', async () => {
    const inventory = await preview(OWNED, ['expired_sessions']);
    const result = await executeCleanup(
      { runId: 'clr_9', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (entry) =>
          entry.resourceId === 'sess_expired_1'
            ? { status: 'failed', detail: 'the delete was rejected' }
            : { status: 'done', reclaimedBytes: 1 },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.report.state).toBe('failed');
    expect(result.report.claimsComplete).toBe(false);
    expect(result.report.failedCount).toBe(1);
  });

  it('OWNER-098 quarantine is an outcome distinct from deletion', async () => {
    const inventory = await preview(OWNED, ['synthetic_workspaces']);
    const result = await executeCleanup(
      { runId: 'clr_10', approvedInventoryHash: inventory.hash, quarantineInsteadOfDelete: true },
      {
        rescan: async () => inventory,
        verify: async () => true,
        remove: async (_entry, mode) => {
          expect(mode).toBe('quarantine');
          return { status: 'done', reclaimedBytes: null };
        },
        now: () => NOW,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.report.quarantined).toBe(1);
    expect(result.report.deleted).toBe(0);
    // Nothing reported a size, so the total is unknown rather than zero.
    expect(result.report.reclaimedBytes).toBeNull();
  });

  it('OWNER-099 executing an empty inventory refuses rather than reporting a successful no-op', async () => {
    const empty = await preview([], ['expired_sessions']);
    const result = await executeCleanup(
      { runId: 'clr_11', approvedInventoryHash: empty.hash, quarantineInsteadOfDelete: false },
      {
        rescan: async () => empty,
        verify: async () => true,
        remove: async () => ({ status: 'done', reclaimedBytes: 0 }),
        now: () => NOW,
      } satisfies ExecuteDeps,
    );
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('empty_inventory');
  });

  it('OWNER-100 the scope gate names every refusal kind, and the page copy matches it', () => {
    expect(isInScope(item({ ownershipTag: 'someone-else' })).ok).toBe(false);
    expect(isInScope(item({ isCustomerData: true })).ok).toBe(false);
    expect(isInScope(item({ retentionConstraint: 'kept for 30 days' })).ok).toBe(false);
    expect(isInScope(item({ category: 'not_a_category' })).ok).toBe(false);
    expect(isInScope(item()).ok).toBe(true);
    // Five things are named as out of scope on the page, and each says what to do instead.
    expect(OUT_OF_SCOPE.length).toBeGreaterThanOrEqual(5);
    for (const entry of OUT_OF_SCOPE) expect(entry.instead.length).toBeGreaterThan(20);
  });

  it('OWNER-101 every category explains what it removes and why that is safe', () => {
    expect(CLEANUP_CATEGORIES.length).toBeGreaterThanOrEqual(5);
    for (const category of CLEANUP_CATEGORIES) {
      expect(category.removes.length).toBeGreaterThan(20);
      expect(category.safeBecause.length).toBeGreaterThan(20);
    }
  });

  it('OWNER-102 a total size is unknown when no row reported one, and never zero', async () => {
    const unsized = await preview([item({ estimatedBytes: null })], ['expired_sessions']);
    expect(unsized.totalEstimatedBytes).toBeNull();
    const sized = await preview(OWNED, ['expired_sessions']);
    expect(sized.totalEstimatedBytes).toBe(640);
  });
});
