/**
 * Button and link-button.
 *
 * A control that navigates renders an `<a>`; a control that acts renders a `<button>`.
 * There is no clickable `<div>` in this package and no `onclick` anywhere — every button
 * either submits a form or is a link, so the whole interface works with JavaScript off.
 */
import { attrs, cx, html, type Html } from '../html.js';
import { isExternalHref, safeHref } from '../url.js';

export type ButtonVariant = 'primary' | 'default' | 'quiet' | 'danger';

export interface ButtonOptions {
  /** Visible text. Always present: an icon-only control has no accessible name worth having. */
  readonly label: string;
  readonly variant?: ButtonVariant;
  /** When set, renders an anchor instead of a button. */
  readonly href?: string;
  readonly type?: 'submit' | 'button';
  readonly name?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  /** Overrides the accessible name when the visible label is ambiguous out of context. */
  readonly ariaLabel?: string;
  /** Trailing glyph, decorative only. */
  readonly icon?: Html;
  /** For a link that leaves the site. Adds rel and an out-arrow. */
  readonly external?: boolean;
  readonly id?: string;
}

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'btn--primary',
  default: '',
  quiet: 'btn--quiet',
  danger: 'btn--danger',
};

export function Button(options: ButtonOptions): Html {
  const className = cx('btn', VARIANT_CLASS[options.variant ?? 'default']);
  const icon = options.icon ?? null;

  if (options.href !== undefined) {
    const target = safeHref(options.href);
    if (target === null) {
      // SEC-1214. A target whose scheme we cannot vouch for is not offered as a link at
      // all. Rendering the anchor without an href would leave a control that looks
      // clickable, is not focusable, and tells nobody why — so it becomes an explicitly
      // inert element instead, marked so the defect is findable in the rendered HTML.
      return html`<span
        ${attrs({
          class: cx(className, 'btn--inert'),
          id: options.id ?? null,
          role: 'link',
          'aria-disabled': 'true',
          'data-href-rejected': 'true',
        })}
        >${options.label}</span
      >`;
    }
    // `rel` is set whenever the target actually leaves the site, not only when the caller
    // remembered to say so.
    const external = options.external === true || isExternalHref(target);
    return html`<a
      ${attrs({
        class: className,
        href: target,
        id: options.id ?? null,
        'aria-label': options.ariaLabel ?? null,
        'aria-disabled': options.disabled === true ? 'true' : null,
        rel: external ? 'noopener noreferrer' : null,
        target: options.external === true ? '_blank' : null,
      })}
      >${options.label}${icon}</a
    >`;
  }

  return html`<button
    ${attrs({
      class: className,
      type: options.type ?? 'submit',
      id: options.id ?? null,
      name: options.name ?? null,
      value: options.value ?? null,
      disabled: options.disabled === true,
      'aria-label': options.ariaLabel ?? null,
    })}
  >
    ${options.label}${icon}
  </button>`;
}

/** A row of buttons with consistent spacing and wrapping. */
export function ButtonRow(buttons: readonly Html[]): Html {
  return html`<div class="btn-row">${buttons}</div>`;
}
