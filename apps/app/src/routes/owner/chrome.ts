/**
 * Shared chrome for every administrative page.
 *
 * Everything here is assembled from `@verify/ui` — A05's `Shell`, `Card`, `Callout`,
 * `Button`, `Table`, `Field`. This file adds no CSS, no components and no layout of its
 * own; it composes what already exists and supplies the owner-specific navigation, the
 * `noindex` default, and the two responses this panel has that no other surface does: a
 * 404 that reveals nothing, and a re-prompt for strong authentication.
 */
import {
  Button,
  Callout,
  CsrfField,
  Shell,
  attrs,
  html,
  type Html,
  type NavItem,
} from '@verify/ui';
import type { Context } from 'hono';
import type { RouteBindings } from '../public/shared.js';
import { page } from '../public/shared.js';

/** The administrative navigation. Nothing here appears on a public page. */
export const OWNER_NAV: readonly NavItem[] = [
  { href: '/owner', label: 'Overview' },
  { href: '/owner/customers', label: 'Customers' },
  { href: '/owner/verification', label: 'Verification' },
  { href: '/owner/connections', label: 'Connections' },
  { href: '/owner/ads', label: 'Ads' },
  { href: '/owner/operations', label: 'Operations' },
  { href: '/owner/controls', label: 'Controls' },
  { href: '/owner/approvals', label: 'Approvals' },
  { href: '/owner/quality', label: 'Tests' },
  { href: '/owner/cleanup', label: 'Cleanup' },
  { href: '/owner/settings', label: 'Settings' },
];

export interface OwnerPageOptions {
  readonly title: string;
  readonly path: string;
  readonly body: Html;
  /** The signed-in owner's address, so they can see which identity they are using. */
  readonly accountLabel?: string;
  readonly csrfToken?: string;
  /** True when the page is rendering the in-memory port. Always shown, never hidden. */
  readonly synthetic?: boolean;
  /** Shown when the automation identity is driving the panel. */
  readonly automation?: boolean;
}

/**
 * `noindex` on every administrative page.
 *
 * Said plainly in the footer: this is tidiness, not security. A robots directive is a
 * request to well-behaved crawlers and has no effect at all on anybody who means harm. The
 * thing that actually protects this page is the session check, and the footer says so
 * rather than letting a reader infer that "noindex" means "private".
 */
export function OwnerLayout(options: OwnerPageOptions): Html {
  const banners: Html[] = [];
  if (options.synthetic === true) {
    banners.push(
      Callout({
        tone: 'limit',
        title: 'These figures are placeholders',
        body: html`<p>Every number, customer and campaign below is invented.</p>`,
        detail: {
          summary: 'What that means for anything you press',
          body: html`<p>
            This deployment is showing an in-memory stand-in, not your business. Nothing you press here
            reaches a provider, a card or an ad platform.
          </p>`,
        },
      }),
    );
  }
  if (options.automation === true) {
    banners.push(
      Callout({
        tone: 'note',
        title: 'Signed in as the automation test identity',
        body: html`<p>
          This identity exists to drive browser tests. It expires shortly and cannot activate an advert, issue a
          refund, move budget or become the platform owner.
        </p>`,
      }),
    );
  }

  const accountLabel = options.accountLabel;

  return Shell({
    title: options.title,
    path: options.path,
    nav: OWNER_NAV,
    // Thirteen screens: a rail at desktop width, the header nav below it. See ShellOptions.
    rail: true,
    noindex: true,
    ...(accountLabel === undefined
      ? {}
      : {
          headerAside: html`<span class="micro mono">${accountLabel}</span>
            <form method="post" action="/admin/sign-out" class="inline-form">
              ${CsrfField(options.csrfToken ?? null)}
              <button class="btn btn--quiet" type="submit">Sign out</button>
            </form>`,
        }),
    footer: html`<div class="stack-sm">
      <p class="small">
        Administrative pages are marked <span class="mono">noindex</span>. That asks search engines not to list
        them; it is tidiness, not protection. What actually keeps this page private is your session, your
        platform-owner flag and your recent two-factor check: every page checks all three on every request.
      </p>
      <p class="small">
        <a href="/owner">Overview</a> · <a href="/owner/controls">Controls</a> ·
        <a href="/owner/quality">Tests</a> · <a href="/support">Customer support page</a>
      </p>
    </div>`,
    body:
      banners.length === 0
        ? options.body
        : html`<div class="wrap section-tight stack">${banners}</div>
            ${options.body}`,
  });
}

/**
 * The 404 an unauthorised request gets.
 *
 * Byte-for-byte the page any unknown address gets, with no hint that `/owner/approvals`
 * differs from `/owner/aprovals`, and with no session, count or existence signal in it.
 * A10 asked for this specifically, and it is the reason this function takes no parameters
 * describing what was actually refused.
 */
export function ownerNotFoundPage(path: string): Html {
  return Shell({
    title: 'Page not found',
    path,
    nav: [],
    noindex: true,
    footer: html`<p class="small"><a href="/">Home</a> · <a href="/support">Support</a></p>`,
    body: html`<div class="wrap section stack">
      <div class="stack-sm">
        <p class="eyebrow">404</p>
        <h1>That page does not exist</h1>
        <p class="lede measure">
          The address you asked for is not one we serve. Nothing has gone wrong with your account.
        </p>
      </div>
      <p><a href="/">Back to the home page</a> · <a href="/support">Support</a></p>
    </div>`,
  });
}

/** The strong-authentication re-prompt. Only ever shown to a genuine platform owner. */
export function mfaRequiredPage(options: {
  readonly path: string;
  readonly detail: string;
  readonly csrfToken: string | null;
  readonly returnTo: string;
}): Html {
  return OwnerLayout({
    title: 'Confirm it is you',
    path: options.path,
    body: html`<div class="wrap section stack">
      <div class="stack-sm">
        <h1>Confirm it is you</h1>
        <p class="lede measure">${options.detail}</p>
      </div>
      ${Callout({
        tone: 'note',
        title: 'Why you are being asked again',
        body: html`<p>
          Anything that changes money, access or what the public sees needs a two-factor check from the last
          15 minutes. Being signed in earlier today is not the same thing: if somebody walked up to an
          unlocked laptop, being signed in is exactly what they would have.
        </p>`,
      })}
      <form method="post" action="/admin/verify" class="stack">
        ${CsrfField(options.csrfToken)}
        <input type="hidden" name="return_to" ${attrs({ value: options.returnTo })} />
        <div class="field">
          <label class="field__label" for="f-totp"
            >Six-digit code from your authenticator <span class="field__req">required</span></label
          >
          <input
            class="input input--mono"
            id="f-totp"
            name="totp"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxlength="6"
            required
          />
        </div>
        ${Button({ label: 'Confirm', variant: 'primary', type: 'submit' })}
      </form>
    </div>`,
    ...(options.csrfToken === null ? {} : { csrfToken: options.csrfToken }),
  });
}

/**
 * A dependency the owner needs to see: something is stopping this action and it is not
 * their mistake. Rendered instead of an error, and never instead of a success.
 */
export function DependencyNotice(options: {
  readonly title: string;
  readonly detail: string;
}): Html {
  // Amber, not red: the doc comment above says this is rendered instead of an error, and a
  // dependency drawn as a fault tells the owner to go and fix something that is not broken.
  return Callout({
    tone: 'limit',
    title: options.title,
    body: html`<p>${options.detail}</p>`,
  });
}

/** A page heading with an optional one-line description. Used by every owner screen. */
export function PageHead(options: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly lede?: string;
  readonly aside?: Html;
}): Html {
  return html`<div class="row-between">
    <div class="stack-sm">
      ${options.eyebrow === undefined ? null : html`<p class="eyebrow">${options.eyebrow}</p>`}
      <h1>${options.title}</h1>
      ${options.lede === undefined ? null : html`<p class="lede measure">${options.lede}</p>`}
    </div>
    ${options.aside ?? null}
  </div>`;
}

/** A value that may be unknown. Never renders a zero in place of "we do not know". */
export function UnknownAware(value: string | number | null | undefined): Html {
  if (value === null || value === undefined || value === '') {
    return html`<span class="muted" data-unknown="true">unknown</span>`;
  }
  return html`<span class="mono">${value}</span>`;
}

/** A timestamp rendered in UTC, or an honest "not recorded". */
export function Instant(iso: string | null | undefined): Html {
  if (iso === null || iso === undefined || iso === '') {
    return html`<span class="muted">not recorded</span>`;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return html`<span class="muted">not recorded</span>`;
  return html`<span class="mono micro"
    >${new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '')} UTC</span
  >`;
}

/** One form that posts one action, with the CSRF token already in it. */
export function ActionForm(options: {
  readonly action: string;
  readonly csrfToken: string | null;
  readonly body: Html;
  readonly confirm?: string;
}): Html {
  return html`<form method="post" ${attrs({ action: options.action })} class="stack-sm">
    ${CsrfField(options.csrfToken)}${
      options.confirm === undefined
        ? null
        : html`<div class="field">
          <label class="field__label" for="f-confirm-${options.action.replace(/[^a-z0-9]/gi, '-')}"
            >Type <span class="mono">${options.confirm}</span> to confirm
            <span class="field__req">required</span></label
          >
          <p class="field__hint">
            This is deliberately awkward. The words you type are the thing that is about to happen.
          </p>
          <input
            class="input input--mono"
            id="f-confirm-${options.action.replace(/[^a-z0-9]/gi, '-')}"
            name="confirm"
            required
          />
        </div>`
    }${options.body}
  </form>`;
}

/* --------------------------------------------------------------------- plumbing */

/**
 * One read of the request body, in both shapes the forms need.
 *
 * Parsed once and once only: a checkbox group (`categories`) needs every value, and
 * everything else needs the single value, and parsing twice on a consumed body stream is
 * the kind of bug that only appears on the one form with a checkbox group in it.
 */
export interface OwnerForm {
  readonly single: Readonly<Record<string, string>>;
  readonly all: Readonly<Record<string, readonly string[]>>;
}

export async function readForm(c: Context<RouteBindings>): Promise<OwnerForm> {
  const parsed = await c.req.parseBody({ all: true });
  const single: Record<string, string> = {};
  const all: Record<string, readonly string[]> = {};
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (typeof value === 'string') {
      single[key] = value;
      all[key] = [value];
    } else if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === 'string');
      all[key] = strings;
      const first = strings[0];
      if (first !== undefined) single[key] = first;
    }
  }
  return { single, all };
}

export function checked(body: Readonly<Record<string, string>>, name: string): boolean {
  const value = body[name];
  return value !== undefined && value !== '' && value !== 'off';
}

/** Answer with an owner page. Always `no-store`; these are never cached anywhere. */
export async function ownerPage(
  c: Context<RouteBindings>,
  node: Html,
  status = 200,
): Promise<Response> {
  return page(c, node, { status, cache: 'private' });
}
