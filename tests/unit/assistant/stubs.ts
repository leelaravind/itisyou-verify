/**
 * Stubs for the assistant unit tests.
 *
 * Two of them, both deliberately hostile:
 *
 *  - `recordingDb` answers the handful of statements the assistant touches and records
 *    every statement it was asked to prepare, so a test can assert what did *not* happen —
 *    which is the interesting assertion for most of these cases.
 *  - `scriptedModel` is a model client that does whatever the test tells it to, including
 *    obeying an injected instruction. The point of the injection tests is to prove the
 *    server refuses, not to prove a model behaved.
 */
import type { Db, DbResult, DbStatement } from '@app/db/d1';
import type { ModelOutcome, ModelRequest, ModelToolCall } from '@app/assistant/types';

export interface RecordingDb {
  readonly db: Db;
  readonly statements: string[];
  /** Rows the stub will return for the next `first()`, keyed by a substring of the SQL. */
  readonly canned: Map<string, unknown>;
}

const emptyResult: DbResult = { success: true, results: [], meta: { changes: 0, last_row_id: 0 } };

export function recordingDb(canned: Record<string, unknown> = {}): RecordingDb {
  const statements: string[] = [];
  const cannedMap = new Map<string, unknown>(Object.entries(canned));

  const make = (sql: string): DbStatement => ({
    bind: () => make(sql),
    first: async <T>() => {
      for (const [needle, row] of cannedMap) {
        if (sql.includes(needle)) return row as T;
      }
      return null;
    },
    all: async <T>() => emptyResult as DbResult<T>,
    run: async <T>() => emptyResult as DbResult<T>,
  });

  const db: Db = {
    prepare: (sql: string) => {
      statements.push(sql);
      return make(sql);
    },
    batch: async <T>() => [emptyResult as DbResult<T>],
  };

  return { db, statements, canned: cannedMap };
}

/** A `fetch` that fails the test if anything reaches it. */
export function forbiddenFetch(): typeof fetch {
  return (async () => {
    throw new Error('the assistant made a network call it should not have made');
  }) as unknown as typeof fetch;
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ScriptedModel {
  readonly call: (request: ModelRequest) => Promise<ModelOutcome>;
  readonly requests: ModelRequest[];
}

/** A model that returns the given turns in order, then answers with plain text. */
export function scriptedModel(turns: readonly ScriptedTurn[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    call: async (request: ModelRequest) => {
      requests.push(request);
      const turn = turns[index];
      index += 1;
      return {
        ok: true as const,
        text: turn?.text ?? 'done',
        toolCalls: turn?.toolCalls ?? [],
        promptTokens: 100,
        completionTokens: 20,
      };
    },
  };
}
