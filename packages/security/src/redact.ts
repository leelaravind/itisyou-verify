/**
 * Redaction helpers.
 *
 * Rule 7 of the engineering brief: nothing secret reaches a log, an error, an API
 * response or an export. These functions are the only sanctioned way to put a
 * customer-derived value into any of those places.
 */

/**
 * `ada@example.com` -> `a**@example.com`.
 *
 * The mask is a fixed two asterisks so the length of the local part is not leaked. A
 * single-character local part is masked entirely, because revealing its first character
 * would reveal all of it. Anything that is not shaped like an address is masked whole.
 */
export function maskEmail(value: string): string {
  if (typeof value !== 'string') return '***';
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length <= 1) return `***@${domain}`;
  return `${local[0] ?? ''}**@${domain}`;
}

/**
 * Mask a bearer-ish string. Short values are masked entirely; longer values keep a short
 * suffix so a human can tell two tokens apart in a support conversation without the
 * value being usable.
 */
export function maskToken(value: string, visibleSuffix = 4): string {
  if (typeof value !== 'string' || value.length === 0) return '********';
  if (value.length <= visibleSuffix * 2) return '********';
  return `********${value.slice(-visibleSuffix)}`;
}

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mask one value according to its type. Exported so callers can mask a single field. */
export function maskValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      return EMAIL_SHAPED.test(value) ? maskEmail(value) : maskToken(value);
    case 'number':
      // Numbers are counts, amounts in minor units and timestamps. They are not secrets,
      // and an audit entry is useless without them.
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    default:
      break;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`;
    return value.slice(0, 10).map((item) => maskValue(item, depth + 1));
  }
  return '[object]';
}

/**
 * Return a copy of `obj` containing only the allowlisted keys, with every value masked
 * by type. An allowlist, never a denylist: a field nobody thought about is dropped
 * rather than leaked.
 */
export function redactObject(
  obj: unknown,
  allowlist: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const source = obj as Record<string, unknown>;
  for (const key of allowlist) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    out[key] = maskValue(source[key]);
  }
  return out;
}

/** Characters a spreadsheet treats as the start of a formula. */
const CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralise a CSV field so an exported report cannot execute in a spreadsheet.
 *
 * A value beginning with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with
 * a single quote, which spreadsheets treat as "this is text". This does not quote or
 * escape the field for CSV framing — the writer still has to do that.
 */
export function neutraliseCsvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : String(value);
  if (text.length === 0) return text;
  const first = text[0];
  if (first !== undefined && CSV_FORMULA_PREFIXES.has(first)) return `'${text}`;
  return text;
}
