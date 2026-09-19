/**
 * Card and Callout.
 *
 * A Card groups related content. A Callout says something *about* the content beside it —
 * most often a limitation. `callout--limit` exists because A03's `describeCoverage()`
 * returns a `limitation` string that must be visible on the page, never folded into a
 * tooltip or an accordion, and a component that can only be rendered visibly is a cheaper
 * guarantee than a code-review rule.
 */
import { attrs, cx, html, type Html } from '../html.js';
import { iconAlert } from './icons.js';

export interface CardOptions {
  readonly title?: string;
  /** Rendered opposite the title — a status badge, a timestamp, a link. */
  readonly aside?: Html;
  readonly body: Html;
  /** Heading level for the card title. Pick the one the document outline needs. */
  readonly headingLevel?: 2 | 3 | 4;
  readonly id?: string;
  readonly className?: string;
}

export function Card(options: CardOptions): Html {
  const level = options.headingLevel ?? 3;
  const head =
    options.title === undefined && options.aside === undefined
      ? null
      : html`<div class="card__head">
          ${
            options.title === undefined
              ? html`<span></span>`
              : level === 2
                ? html`<h2 class="card__title">${options.title}</h2>`
                : level === 4
                  ? html`<h4 class="card__title">${options.title}</h4>`
                  : html`<h3 class="card__title">${options.title}</h3>`
          }
          ${options.aside ?? null}
        </div>`;

  return html`<section ${attrs({ class: cx('card', options.className ?? ''), id: options.id ?? null })}>
    ${head}${options.body}
  </section>`;
}

export type CalloutTone = 'note' | 'limit' | 'warn' | 'todo';

export interface CalloutOptions {
  readonly tone?: CalloutTone;
  readonly title?: string;
  readonly body: Html;
  readonly id?: string;
}

/**
 * Tones, and what each one means — they are not interchangeable:
 *   `note`  neutral context.
 *   `limit` something this product cannot do. Always visible, never collapsible.
 *   `warn`  something is wrong right now and the customer may need to act.
 *   `todo`  a placeholder the business owner has not filled in yet. Shown, not hidden:
 *           a legal page that silently omits a trading address is worse than one that
 *           admits it is incomplete.
 */
export function Callout(options: CalloutOptions): Html {
  const tone = options.tone ?? 'note';
  const titleIcon = tone === 'warn' || tone === 'todo' ? iconAlert() : null;
  return html`<aside
    ${attrs({ class: cx('callout', `callout--${tone}`), id: options.id ?? null, 'data-tone': tone })}
  >
    ${
      options.title === undefined
        ? null
        : html`<p class="callout__title">${titleIcon}${options.title}</p>`
    }
    <div class="callout__body">${options.body}</div>
  </aside>`;
}
