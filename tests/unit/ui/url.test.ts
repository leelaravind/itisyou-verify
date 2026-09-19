/**
 * CUST-098..CUST-108 — the link-target guard (SEC-1214).
 *
 * The headline case is CUST-098: a differential against A10's reviewed reference over one
 * adversarial corpus. Escaping is the one place the two deliberately differ, so the
 * comparison is on the *decision* and on the *target before escaping*, with the two
 * documented divergences enumerated rather than waved away.
 */
import { describe, expect, it } from 'vitest';
import {
  Breadcrumb,
  Button,
  Pagination,
  PublicLayout,
  attrs,
  html,
  isExternalHref,
  isSafeHref,
  render,
  safeHref,
} from '@verify/ui';
import { escapeHtml, safeHref as referenceSafeHref } from '../../security/helpers/html.js';
import { HomePage } from '../../../apps/app/src/routes/public/home.js';
import { renderMarkdownSubset } from '../../../apps/app/src/routes/public/developmentStory.js';

/** Everything the lead and A10 named, plus the shapes that usually slip past a naive check. */
/** NUL and DEL, built rather than typed, so this file stays plain ASCII. */
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

const HOSTILE_HREFS: readonly string[] = [
  // Control characters spliced into the scheme. Browsers strip these before resolving, so a
  // guard that does not strip first sees "jav<NUL>ascript:" and waves it through.
  `jav${NUL}ascript:alert(1)`,
  `javascript${DEL}:alert(1)`,
  NUL,
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'JAVASCRIPT:alert(1)',
  '\njavascript:alert(1)',
  '  \t javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'java\rscript:alert(1)',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'about:blank',
  'blob:https://example.test/abc',
  'javascript:void(0)',
  '',
  '   ',
  '',
];

/** Targets that must keep working. */
const SAFE_HREFS: readonly string[] = [
  '/',
  '/app/runs',
  '/app/runs/run_syn_0001',
  '/app/support?run=run_1',
  '/app/runs?cursor=25',
  'https://example.test/a',
  'https://example.test/a?x=1&y=2',
  'http://example.test/a',
  'mailto:someone@example.test',
  '#main',
  '#run_demo_verified',
  '//evil.example/x',
];

describe('the link-target guard', () => {
  it('CUST-098 agrees with A10’s reviewed reference on every payload, escaping aside', () => {
    const disagreements: string[] = [];
    for (const value of [...HOSTILE_HREFS, ...SAFE_HREFS]) {
      const mine = safeHref(value);
      const reference = referenceSafeHref(value);

      // 1. The accept/reject decision must be identical. This is the security property.
      if ((mine === null) !== (reference === null)) {
        disagreements.push(`decision: ${JSON.stringify(value)} mine=${mine} reference=${reference}`);
        continue;
      }
      if (mine === null || reference === null) continue;

      // 2. The one remaining divergence: escaping. This guard returns the target unescaped
      //    because `attrs()` escapes exactly once; the reference escapes inside. Apply the
      //    reference's own escaper and the two must match byte for byte.
      //
      //    There used to be a second divergence — a same-document `#fragment`, which the
      //    reference resolved against the production origin. A10 adopted this side's
      //    behaviour on 2026-09-19, so fragments now compare like everything else and no
      //    special case is needed. That is what this test is for: the divergence was loud,
      //    it got settled, and the settlement is now enforced rather than described.
      if (escapeHtml(mine) !== reference) {
        disagreements.push(`target: ${JSON.stringify(value)} mine=${JSON.stringify(escapeHtml(mine))} reference=${JSON.stringify(reference)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('CUST-099 refuses every script-bearing scheme, including mixed case and whitespace-split', () => {
    for (const value of HOSTILE_HREFS) {
      expect(safeHref(value), value).toBeNull();
      expect(isSafeHref(value), value).toBe(false);
    }
  });

  it('CUST-100 keeps every target the application actually uses', () => {
    for (const value of SAFE_HREFS) {
      expect(safeHref(value), value).not.toBeNull();
    }
    expect(safeHref('/app/runs/run_1')).toBe('/app/runs/run_1');
    expect(safeHref('#main')).toBe('#main');
    expect(safeHref('https://example.test/a?x=1&y=2')).toBe('https://example.test/a?x=1&y=2');
  });

  it('CUST-101 a protocol-relative target becomes an explicit absolute URL rather than looking same-origin', () => {
    // Not refused — the scheme is safe — but the rendered target says where it goes.
    expect(safeHref('//evil.example/x')).toBe('https://evil.example/x');
    expect(isExternalHref('//evil.example/x')).toBe(true);
    expect(isExternalHref('/app/runs')).toBe(false);
    expect(isExternalHref('#main')).toBe(false);
  });

  it('CUST-102 attrs() drops a URL-bearing attribute whose value fails the guard, and keeps the rest', async () => {
    const markup = await render(html`<a ${attrs({ class: 'x', href: 'javascript:alert(1)' })}>t</a>`);
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('href=');
    expect(markup).toContain('class="x"');

    for (const name of ['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'ping']) {
      const out = await render(html`<x ${attrs({ [name]: 'javascript:alert(1)' })}></x>`);
      expect(out, name).not.toContain('javascript:');
    }
  });

  it('CUST-103 attrs() does not mistake a data-* attribute for <object data>', async () => {
    const markup = await render(html`<div ${attrs({ 'data-note': 'javascript:alert(1)' })}></div>`);
    expect(markup).toContain('data-note="javascript:alert(1)"');
  });

  it('CUST-104 a Button given an unvouchable target renders an inert control, never a live link', async () => {
    const markup = await render(Button({ label: 'Open the billing portal', href: 'javascript:alert(1)' }));
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('<a');
    expect(markup).toContain('data-href-rejected="true"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('Open the billing portal');
  });

  it('CUST-105 a Button given a real external target links out with rel set, whether or not the caller said so', async () => {
    const markup = await render(Button({ label: 'Billing portal', href: 'https://billing.stripe.com/p/session_x' }));
    expect(markup).toContain('href="https://billing.stripe.com/p/session_x"');
    expect(markup).toContain('rel="noopener noreferrer"');

    const internal = await render(Button({ label: 'Runs', href: '/app/runs' }));
    expect(internal).toContain('href="/app/runs"');
    expect(internal).not.toContain('rel=');
  });

  it('CUST-106 a breadcrumb and a pagination control degrade to plain text rather than to a script URL', async () => {
    const crumbs = await render(
      Breadcrumb([{ label: 'Workspace', href: 'javascript:alert(1)' }, { label: 'Runs' }]),
    );
    expect(crumbs).not.toContain('javascript:');
    expect(crumbs).not.toContain('<a');
    expect(crumbs).toContain('Workspace');

    const pager = await render(
      Pagination({ newerHref: 'javascript:alert(1)', olderHref: null, shown: 3, noun: 'runs' }),
    );
    expect(pager).not.toContain('javascript:');
    expect(pager).toContain('this is all of them');
  });

  it('CUST-107 the rendered site contains no script-bearing URL in any attribute', async () => {
    const markup = await render(PublicLayout({ title: 'Home', path: '/', body: HomePage() }));
    expect(markup).not.toMatch(/(href|src|action|formaction|poster|cite|ping)\s*=\s*"\s*(javascript|data|vbscript|file|about|blob):/i);
  });

  it('CUST-108 a development-story link uses the same guard, so a javascript: target stays as text', () => {
    const rendered = renderMarkdownSubset(
      '[bad](javascript:alert(1)) [also bad](JaVaScRiPt:alert(1)) [ok](https://example.test/a) [local](/app/runs)',
    );
    expect(rendered).not.toContain('href="javascript:');
    expect(rendered).not.toContain('href="JaVaScRiPt:');
    expect(rendered).toContain('<a href="https://example.test/a" rel="nofollow noopener noreferrer">ok</a>');
    expect(rendered).toContain('href="/app/runs"');
  });
});
