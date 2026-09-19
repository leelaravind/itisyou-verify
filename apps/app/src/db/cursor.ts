/**
 * Bounded cursor pagination.
 *
 * Offset pagination over a tenant table is both slow and wrong: rows inserted during
 * paging shift the window and the caller silently skips records. Every list in this layer
 * therefore pages on the composite key `(created_at, id)`, which is unique because ids
 * carry a time prefix, and is exactly the shape of the `idx_*_ws_created` indexes.
 *
 * The cursor is opaque base64url. It is not a security boundary — the workspace scope on
 * every query is — but keeping it opaque stops callers building one by hand and relying
 * on its internals.
 */
import { AppError } from '@verify/contracts';
import { fromBase64Url, toBase64Url } from '@verify/security';

/** Hard ceiling on any page, regardless of what a caller asks for. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, or null when this was the last one. */
  readonly nextCursor: string | null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

export function encodeCursor(cursor: PageCursor): string {
  return toBase64Url(new TextEncoder().encode(`c1|${cursor.createdAt}|${cursor.id}`));
}

/** Decode a caller-supplied cursor. A malformed cursor is a 400, never a silent reset. */
export function decodeCursor(value: string | null | undefined): PageCursor | null {
  if (value === undefined || value === null || value === '') return null;
  let text: string;
  try {
    text = new TextDecoder().decode(fromBase64Url(value));
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'That page cursor is not valid.');
  }
  const parts = text.split('|');
  if (parts.length !== 3 || parts[0] !== 'c1' || !parts[1] || !parts[2]) {
    throw new AppError(400, 'INVALID_CURSOR', 'That page cursor is not valid.');
  }
  return { createdAt: parts[1], id: parts[2] };
}

/**
 * Build the page from `limit + 1` fetched rows: the extra row only ever tells us whether
 * another page exists, and is never returned.
 */
export function buildPage<T extends { readonly id: string; readonly created_at: string }>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last === undefined ? null : encodeCursor({ createdAt: last.created_at, id: last.id }),
  };
}
