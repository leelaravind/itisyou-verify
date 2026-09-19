/**
 * The two page layouts.
 *
 * `PublicLayout` is indexable marketing and legal. `AppLayout` is everything behind a
 * session and is `noindex` without the caller having to remember.
 */
import { html, type Html } from '../html.js';
import { CsrfField } from '../components/field.js';
import { PRODUCT_NAME } from '../content/site.js';
import { Shell, type NavItem } from './shell.js';

/** Primary public navigation. Labels are navigation, not product claims. */
export const PUBLIC_NAV: readonly NavItem[] = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/demo', label: 'Demo' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/support', label: 'Support' },
];

/** Navigation inside a signed-in workspace. */
export const APP_NAV: readonly NavItem[] = [
  { href: '/app', label: 'Workspace' },
  { href: '/app/runs', label: 'Runs' },
  { href: '/app/connections', label: 'Connections' },
  { href: '/app/usage', label: 'Usage' },
  { href: '/app/support', label: 'Support' },
];

const LEGAL_LINKS: readonly NavItem[] = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/refunds', label: 'Cancellation and refunds' },
  { href: '/security', label: 'Security' },
];

const PRODUCT_LINKS: readonly NavItem[] = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/demo', label: 'Worked example' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/status', label: 'Service status' },
  { href: '/development-story', label: 'How this was built' },
];

function linkList(items: readonly NavItem[]): Html {
  return html`<ul class="stack-sm">
    ${items.map((item) => html`<li><a href="${item.href}">${item.label}</a></li>`)}
  </ul>`;
}

function publicFooter(): Html {
  return html`<div class="foot__cols">
    <div class="stack-sm">
      <p class="eyebrow">Product</p>
      ${linkList(PRODUCT_LINKS)}
    </div>
    <div class="stack-sm">
      <p class="eyebrow">Legal</p>
      ${linkList(LEGAL_LINKS)}
    </div>
    <div class="stack-sm">
      <p class="eyebrow">${PRODUCT_NAME}</p>
      <p class="small">
        A service that reads HubSpot and Resend back itself and reports what the evidence shows.
        We make no accuracy, security or uptime certification.
      </p>
      <p class="small">
        Trading details are published on the <a href="/terms">terms page</a>.
      </p>
    </div>
  </div>`;
}

export interface PublicPageOptions {
  readonly title: string;
  readonly description?: string;
  readonly path: string;
  readonly body: Html;
  readonly beforeMain?: Html;
}

export function PublicLayout(options: PublicPageOptions): Html {
  return Shell({
    title: options.title,
    ...(options.description === undefined ? {} : { description: options.description }),
    path: options.path,
    nav: PUBLIC_NAV,
    ...(options.beforeMain === undefined ? {} : { beforeMain: options.beforeMain }),
    headerAside: html`<a href="/app">Sign in</a>`,
    footer: publicFooter(),
    body: options.body,
  });
}

export interface AppPageOptions {
  readonly title: string;
  readonly path: string;
  readonly body: Html;
  /** The signed-in person's email, shown so they know which workspace they are in. */
  readonly accountLabel?: string;
  /** Required for the sign-out form; A02 owns the token, this only renders it. */
  readonly csrfToken?: string;
  readonly beforeMain?: Html;
}

export function AppLayout(options: AppPageOptions): Html {
  return Shell({
    title: options.title,
    path: options.path,
    nav: APP_NAV,
    noindex: true,
    ...(options.beforeMain === undefined ? {} : { beforeMain: options.beforeMain }),
    headerAside:
      options.accountLabel === undefined
        ? html`<a href="/app/sign-in">Sign in</a>`
        : html`<span class="micro mono">${options.accountLabel}</span>
            <form method="post" action="/app/sign-out" class="inline-form">
              ${CsrfField(options.csrfToken ?? null)}
              <button class="btn btn--quiet" type="submit">Sign out</button>
            </form>`,
    footer: html`<div class="stack-sm">
      <p class="small">
        Signed-in pages are never indexed. Evidence is kept for 30 days and then removed.
      </p>
      <p class="small">
        <a href="/support">Support</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> ·
        <a href="/app/cancel">Cancel your plan</a>
      </p>
    </div>`,
    body: options.body,
  });
}
