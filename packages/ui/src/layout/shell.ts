/**
 * The page shell.
 *
 * Everything every page needs and must not get wrong: a `lang`, a viewport, the inlined
 * stylesheet, a skip link that actually lands on `#main`, one `<h1>` per page supplied by
 * the caller, and `noindex` on anything behind a session.
 */
import { attrs, html, raw, type Html } from '../html.js';
import { safeHref } from '../url.js';
import { CSS, THEME_SCRIPT } from '../styles.js';
import { PRODUCT_NAME } from '../content/site.js';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export interface ShellOptions {
  /** Page title, without the product name — the shell appends it. */
  readonly title: string;
  /** Meta description. Omitted rather than invented when a page has nothing factual to say. */
  readonly description?: string;
  /** Path of the current page, used to mark the active nav item. */
  readonly path: string;
  readonly nav: readonly NavItem[];
  /** Authenticated pages are never indexed. */
  readonly noindex?: boolean;
  /** Rendered after the header, before `<main>` — used for the synthetic-data stripe. */
  readonly beforeMain?: Html;
  readonly footer: Html;
  readonly body: Html;
  /** Extra links rendered on the right of the header — sign in, sign out. */
  readonly headerAside?: Html;
}

/**
 * Which nav item is the current page.
 *
 * Only the *most specific* match counts. Marking both "Workspace" (`/app`) and "Runs"
 * (`/app/runs`) as `aria-current="page"` on the run list, which is what a plain prefix test
 * does, tells a screen-reader user they are in two places at once.
 */
function currentHref(nav: readonly NavItem[], path: string): string | null {
  let best: string | null = null;
  for (const item of nav) {
    const matches = item.href === path || (item.href !== '/' && path.startsWith(`${item.href}/`));
    if (!matches) continue;
    if (best === null || item.href.length > best.length) best = item.href;
  }
  return best;
}

function navLink(item: NavItem, activeHref: string | null): Html {
  // SEC-1214: `attrs` drops an href that fails the scheme guard, which would leave a bare
  // anchor in the primary navigation. A nav item we cannot link to is not shown at all.
  const target = safeHref(item.href);
  if (target === null) return html``;
  const current = activeHref !== null && item.href === activeHref;
  return html`<a ${attrs({ href: target, 'aria-current': current ? 'page' : null })}>${item.label}</a>`;
}

/**
 * DO NOT REINDENT THE TWO INLINE BLOCKS BELOW.
 *
 * `<style>` and `<script>` must contain exactly the constant and nothing else — no
 * surrounding whitespace. The Worker's Content-Security-Policy carries sha256(CSS) and
 * sha256(THEME_SCRIPT), and a browser hashes the exact bytes between the tags: one stray
 * newline and it silently refuses to apply the stylesheet, on every page, with no error a
 * developer would notice. Case CUST-065 in `tests/unit/ui/pages.test.ts` fails if this is
 * ever reformatted; that test is the only thing standing between a tidy-up and a site with
 * no CSS.
 */
export function Shell(options: ShellOptions): Html {
  return html`${raw('<!doctype html>')}
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${options.title} — ${PRODUCT_NAME}</title>
    ${options.description === undefined
      ? null
      : html`<meta name="description" content="${options.description}" />`}
    ${options.noindex === true ? html`<meta name="robots" content="noindex, nofollow" />` : null}
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>${raw(CSS)}</style>
    <script>${raw(THEME_SCRIPT)}</script>
  </head>
  <body>
    <a class="skip" href="#main">Skip to main content</a>
    <header class="site">
      <div class="wrap site__inner">
        <a class="brand" href="/">
          <span class="brand__mark">ITISYOU</span><span class="brand__name">Verify</span>
        </a>
        <nav class="nav" aria-label="Primary">
          ${(() => {
            const active = currentHref(options.nav, options.path);
            return options.nav.map((item) => navLink(item, active));
          })()}${options.headerAside ?? null}
        </nav>
      </div>
    </header>
    ${options.beforeMain ?? null}
    <main id="main" tabindex="-1">${options.body}</main>
    <footer class="foot">
      <div class="wrap">${options.footer}</div>
    </footer>
  </body>
</html>`;
}
