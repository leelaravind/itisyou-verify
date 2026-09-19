/**
 * Resilience harness: a real database that can be made to fail on command.
 *
 * `FailingDb` wraps the SQLite-backed `Db` the repositories already run against and fails
 * exactly where you tell it to — on the Nth statement, on every batch, on statements
 * matching a pattern, or from a given point onward. Everything else executes for real, so a
 * test can prove what the database actually contains after a failure rather than what a
 * mock was told to say.
 *
 * Why not a mock of the whole `Db`: the interesting question is never "was the call made",
 * it is "what state did the failure leave behind". A mock cannot answer that. This can,
 * because every statement that is not being failed really runs.
 */
import type { Db, DbResult, DbStatement } from '@app/db/d1';

export class DatabaseUnreachableError extends Error {
  constructor(operation: string) {
    super(`D1_ERROR: the database could not be reached (${operation})`);
    this.name = 'DatabaseUnreachableError';
  }
}

export interface FailurePlan {
  /** Fail every statement and batch from the start. A total outage. */
  readonly failEverything?: boolean;
  /**
   * Fail once the Nth *executed* operation is reached, and everything after it. Models a
   * database that goes away mid-tick and stays away.
   */
  readonly failFromOperation?: number;
  /** Fail only operations whose SQL matches. Models one table or statement failing. */
  readonly failMatching?: RegExp;
  /** Fail every `batch()` while leaving single statements working. */
  readonly failBatches?: boolean;
  /** Fail only the first N matching operations, then recover. Models a blip. */
  readonly recoverAfter?: number;
}

interface Executed {
  readonly sql: string;
  readonly kind: 'first' | 'all' | 'run' | 'batch';
  readonly failed: boolean;
}

/**
 * A `Db` that fails on demand.
 *
 * `operations` counts every `first`/`all`/`run`/`batch` that reaches the wrapper, so a test
 * can first run the happy path, read the count, and then fail precisely at the boundary it
 * cares about.
 */
export class FailingDb implements Db {
  readonly executed: Executed[] = [];
  #operations = 0;
  #failures = 0;

  constructor(
    private readonly inner: Db,
    private plan: FailurePlan = {},
  ) {}

  get operationCount(): number {
    return this.#operations;
  }

  get failureCount(): number {
    return this.#failures;
  }

  /** Change the plan mid-test: healthy, then not, then healthy again. */
  setPlan(plan: FailurePlan): void {
    this.plan = plan;
  }

  /** Statements actually executed against the real database, for state assertions. */
  sqlExecuted(): readonly string[] {
    return this.executed.filter((e) => !e.failed).map((e) => e.sql);
  }

  #shouldFail(sql: string): boolean {
    if (this.plan.failEverything === true) return this.#withinRecovery();
    if (this.plan.failBatches === true && sql === '<batch>') return this.#withinRecovery();
    if (this.plan.failMatching !== undefined && this.plan.failMatching.test(sql)) {
      return this.#withinRecovery();
    }
    if (
      this.plan.failFromOperation !== undefined &&
      this.#operations >= this.plan.failFromOperation
    ) {
      return this.#withinRecovery();
    }
    return false;
  }

  #withinRecovery(): boolean {
    if (this.plan.recoverAfter === undefined) return true;
    return this.#failures < this.plan.recoverAfter;
  }

  prepare(query: string): DbStatement {
    const inner = this.inner.prepare(query);
    const self = this;

    const wrap = (statement: DbStatement): DbStatement => ({
      bind(...values: unknown[]): DbStatement {
        return wrap(statement.bind(...values));
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        return self.#guard(query, 'first', () => statement.first<T>());
      },
      async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
        return self.#guard(query, 'all', () => statement.all<T>());
      },
      async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
        return self.#guard(query, 'run', () => statement.run<T>());
      },
    });

    return wrap(inner);
  }

  async batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]> {
    return this.#guard('<batch>', 'batch', () => this.inner.batch<T>(statements));
  }

  async #guard<T>(sql: string, kind: Executed['kind'], run: () => Promise<T>): Promise<T> {
    this.#operations += 1;
    if (this.#shouldFail(sql)) {
      this.#failures += 1;
      this.executed.push({ sql, kind, failed: true });
      throw new DatabaseUnreachableError(kind);
    }
    this.executed.push({ sql, kind, failed: false });
    return run();
  }
}

/**
 * The `/health` probe, extracted exactly as `apps/app/src/index.ts` performs it.
 *
 * The route itself is owned by the lead and cannot be imported without booting the whole
 * Hono app and its bindings, so this mirrors the probe it runs — one `SELECT 1`, a caught
 * exception, and a status derived from the result rather than assumed. The mirror is
 * asserted against the real route source in the outage suite, so it cannot drift silently.
 */
export async function probeHealth(
  db: Db,
): Promise<{ database: 'reachable' | 'unreachable'; status: number }> {
  let database: 'reachable' | 'unreachable' = 'unreachable';
  try {
    await db.prepare('SELECT 1').first();
    database = 'reachable';
  } catch {
    database = 'unreachable';
  }
  return { database, status: database === 'reachable' ? 200 : 503 };
}
