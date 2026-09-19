/**
 * The complete CSV cell encoder. **One function that both prefixes and quotes.**
 *
 * A10's threat model (`docs/threat-model.md`, T-CSV-01) flagged the split as the risk:
 * A02's `neutraliseCsvField` in `@verify/security` deliberately only prefixes, and
 * documents that the writer still owes the RFC4180 quoting. Two half-controls owned by
 * two agents is precisely how a field containing both a formula leader *and* a quote or
 * comma ships broken — quote first and the apostrophe lands outside the quotes, where
 * Excel ignores it and evaluates the formula anyway.
 *
 * So there is exactly one entry point here. It calls A02's function for the prefix step —
 * so there is still only one definition of "what starts a formula" in the codebase — and
 * then does the quoting itself, in the right order:
 *
 *   1. coerce to text (`null`/`undefined` become an empty field, never the word "null");
 *   2. **prefix** with `'` if the first character is `= + - @` TAB or CR — A02's function;
 *   3. **quote** if the result contains a quote, comma, CR or LF, doubling inner quotes.
 *
 * Order matters: the apostrophe must be *inside* the quotes. `"'=cmd"` is inert text.
 * `'"=cmd"` is a formula in a broken row.
 *
 * Every export in this product routes every cell through `csvCell`. Nothing writes a
 * comma into an export by hand.
 */
import { neutraliseCsvField } from '@verify/security';

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Characters that force RFC4180 quoting. Identical to A10's reference implementation in
 * `tests/security/helpers/csv.ts`, deliberately — two encoders that disagree byte for
 * byte would make A10's regression tests stop meaning anything about shipped code.
 */
const NEEDS_QUOTING = /[",\r\n]/;

/** Encode one cell: formula-neutralised first, then RFC4180-quoted. */
export function csvCell(value: CsvValue): string {
  const text = neutraliseCsvField(
    value === null || value === undefined
      ? ''
      : typeof value === 'boolean'
        ? value
          ? 'true'
          : 'false'
        : value,
  );
  if (text.length === 0) return '';
  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** One record. CRLF is what RFC4180 specifies and what Excel expects. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(',');
}

/**
 * A whole document, terminated with a final CRLF so appending another chunk cannot join
 * two rows together.
 */
export function csvDocument(rows: readonly (readonly CsvValue[])[]): string {
  if (rows.length === 0) return '';
  return `${rows.map(csvRow).join('\r\n')}\r\n`;
}

/**
 * Streaming helper: encode a header row and a body separately so a large export can be
 * written in pages without holding the whole document in memory.
 */
export function csvChunk(rows: readonly (readonly CsvValue[])[]): string {
  return csvDocument(rows);
}
