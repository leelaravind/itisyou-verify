/**
 * The data the money path needs, as ports — and the reason there is no SQL in this module.
 *
 * `apps/app/src/db/` is the only place in the application that writes SQL, and `SEC-201`
 * enforces it by scanning every other file for a statement naming a customer-scoped table.
 * That rule is not a style preference: tenant scoping is a property you can only keep if
 * there is exactly one place to check for it. A reconciliation pass that moves customer
 * money rows is the last thing that should have its own private query.
 *
 * So the orchestration in this module states what it needs and A02's layer decides how to
 * fetch it. Each method below is written as a contract rather than a query, and the ones
 * that write are **compare-and-set**: they take the values the caller read and return
 * `false` if the row has moved since. A repair that overwrote a live reservation would
 * sell the same unit of allowance twice, which is the defect this module exists to end.
 *
 * ## Status
 *
 * These are implemented in `apps/app/src/db/`. Nothing here may be satisfied by a stand-in
 * in production code; a test may implement them, but a test that does so is testing this
 * module's arithmetic and **not** the SQL, and must say so.
 */

/** One allowance row, exactly the fields a repair decision is made from. */
export interface AllowanceRowSnapshot {
  readonly workspaceId: string;
  readonly billingPeriod: string;
  readonly runLimit: number;
  readonly consumed: number;
  readonly reserved: number;
  /** The optimistic-concurrency token. Every write below is conditional on it. */
  readonly updatedAt: string;
}

/** One run, reduced to the two facts that decide which period paid for it. */
export interface RunPeriodFact {
  /** `PENDING` is the only non-terminal status the schema allows. */
  readonly status: string;
  readonly createdAt: string;
}

/**
 * Everything the allowance reconciliation reads and writes.
 *
 * Implemented by `apps/app/src/db/allowanceRepair.ts` (owner: A02).
 */
export interface AllowanceRepairPort {
  /**
   * Workspaces that hold at least one allowance row, in a stable order, bounded.
   *
   * A deliberate platform-wide sweep: it is how a repair pass finds work at all. Every
   * read after it is scoped by the workspace id this returns.
   */
  listWorkspacesWithAllowanceRows(limit: number): Promise<readonly string[]>;

  /** The subscription's `current_period_end`, which is the anchor every key derives from. */
  currentPeriodEnd(workspaceId: string, environment: 'test' | 'live'): Promise<string | null>;

  /** Every allowance row for one workspace. Ordered by key, so a report is reproducible. */
  listAllowanceRows(workspaceId: string): Promise<readonly AllowanceRowSnapshot[]>;

  /**
   * Every run for one workspace, bounded, oldest first.
   *
   * The arbiter. `entitlements` is a derived counter; `runs` is the record of what we
   * actually did, and it is the only thing that can settle a disagreement between them.
   */
  listRunPeriodFacts(workspaceId: string, limit: number): Promise<readonly RunPeriodFact[]>;

  /**
   * Move a row to a different `billing_period`, when nothing occupies the target.
   *
   * Must be a single statement guarded on both `expectUpdatedAt` and the absence of the
   * target row, so it can never collide with `UNIQUE (workspace_id, billing_period)` and
   * can never clobber a concurrent write. Returns whether this call moved it.
   */
  renameAllowancePeriod(params: {
    readonly workspaceId: string;
    readonly fromPeriod: string;
    readonly toPeriod: string;
    readonly expectUpdatedAt: string;
    readonly at: string;
  }): Promise<boolean>;

  /**
   * Fold one row's counters into another and delete the source, atomically.
   *
   * Must be one transaction. `run_limit` is **never** summed: merging two rows produces
   * one row with one allowance, or the customer is handed their 500 runs twice.
   */
  mergeAllowancePeriod(params: {
    readonly workspaceId: string;
    readonly fromPeriod: string;
    readonly intoPeriod: string;
    readonly at: string;
  }): Promise<boolean>;

  /** Delete a row, conditional on the exact counters the caller read. */
  dropAllowanceRow(params: {
    readonly workspaceId: string;
    readonly billingPeriod: string;
    readonly expectConsumed: number;
    readonly expectReserved: number;
    readonly expectUpdatedAt: string;
  }): Promise<boolean>;

  /**
   * Set both counters, conditional on the exact values the caller read.
   *
   * `run_limit` is not a parameter and must not appear in the statement.
   */
  setAllowanceCounters(params: {
    readonly workspaceId: string;
    readonly billingPeriod: string;
    readonly consumed: number;
    readonly reserved: number;
    readonly expectConsumed: number;
    readonly expectReserved: number;
    readonly expectUpdatedAt: string;
    readonly at: string;
  }): Promise<boolean>;
}

/**
 * One workflow signing key reference, as stored.
 *
 * No secret and no ciphertext: the secret is derived from a Worker root key and these
 * three facts (see `money/signingKeys.ts`), so the data layer never holds key material at
 * all. Implemented by `apps/app/src/db/workflowSigningKeys.ts` (owner: A02).
 */
export interface StoredSigningKey {
  /** `workflows.signing_key_ref` — the value the caller sent in `X-Verify-Key-Id`. */
  readonly keyId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  /** The workflow's **current** version. A run is always admitted against the live rules. */
  readonly workflowVersionId: string;
  readonly deadlineSeconds: number;
}

/**
 * Resolve a workflow's active signing key from its public key id.
 *
 * The workspace is **derived** here and never accepted from a request. That is the one
 * property this lookup exists for, and it is why a workspace predicate is impossible:
 * discovering the workspace is the purpose of the call.
 *
 * Must return `null` for a retired version, an archived or inactive workflow, or a key id
 * the workflow no longer points at — so a rotation takes effect on the next request.
 */
export interface SigningKeyStore {
  findActiveWorkflowSigningKey(keyId: string): Promise<StoredSigningKey | null>;
}
