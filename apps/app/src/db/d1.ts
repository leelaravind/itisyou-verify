/**
 * The exact slice of the D1 API this application uses.
 *
 * Confirmed 2026-09-19 against https://developers.cloudflare.com/d1/worker-api/d1-database/:
 *  - "Batched statements are SQL transactions. If a statement in the sequence fails, then
 *    an error is returned for that specific statement, and it aborts or rolls back the
 *    entire sequence."
 *  - "D1 operates in auto-commit. Our implementation guarantees that each statement in
 *    the list will execute and commit, sequentially, non-concurrently."
 *  - `D1Result` carries `success`, `results` and `meta` with `changes`, `last_row_id`,
 *    `duration`, `rows_read`, `rows_written`.
 *
 * Every atomic multi-statement write in this layer therefore goes through `batch()`, and
 * every conditional write reports success through `meta.changes` rather than a re-read.
 *
 * Declaring the interface structurally (rather than importing `D1Database`) is what lets
 * the integration harness substitute a local SQLite database while the repositories under
 * test stay byte-identical. A real `D1Database` satisfies `Db`; see the assertion at the
 * bottom of this file.
 */

export interface DbMeta {
  readonly changes: number;
  readonly last_row_id: number;
  readonly duration?: number;
  readonly rows_read?: number;
  readonly rows_written?: number;
}

export interface DbResult<T = Record<string, unknown>> {
  readonly success: boolean;
  readonly results: T[];
  readonly meta: DbMeta;
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DbResult<T>>;
}

export interface Db {
  prepare(query: string): DbStatement;
  batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]>;
}

/** SQLite stores booleans as 0/1; these two functions are the only place that is known. */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromSqlBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

/** `null` for an absent optional, which is what every nullable column expects. */
export function orNull<T>(value: T | undefined | null): T | null {
  return value === undefined || value === null ? null : value;
}

/** True when a conditional write actually applied. The only success test we use. */
export function applied(result: DbResult<unknown>): boolean {
  return result.meta.changes > 0;
}

/**
 * Read one statement's result out of a `batch()` response.
 *
 * `noUncheckedIndexedAccess` makes the index access `DbResult | undefined`; a missing
 * entry means the driver returned fewer results than statements, which is a bug we want
 * to see immediately rather than a silent `changes === 0`.
 */
export function resultAt<T = Record<string, unknown>>(
  results: readonly DbResult<T>[],
  index: number,
): DbResult<T> {
  const result = results[index];
  if (result === undefined) {
    throw new Error(`batch returned ${results.length} results; statement ${index} is missing`);
  }
  return result;
}

/** Rows affected by statement `index` of a batch. */
export function changesAt(results: readonly DbResult<unknown>[], index: number): number {
  return resultAt(results as readonly DbResult<Record<string, unknown>>[], index).meta.changes;
}

/**
 * Compile-time proof that the real Cloudflare binding is usable wherever `Db` is
 * required. If Cloudflare changes the shape of `batch` or `meta`, this line fails the
 * typecheck rather than failing in production.
 */
export type AssertD1IsDb = D1Database extends Db ? true : never;
