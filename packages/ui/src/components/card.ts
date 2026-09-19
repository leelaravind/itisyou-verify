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
import { iconAlert, iconLimit } from './icons.js';

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
/**
 * The title a tone falls back to when the caller supplies none.
 *
 * ## Why a default title rather than a bare glyph
 *
 * The glyph used to be built inside the branch that renders the title, so a callout with no
 * title shipped as a coloured box and nothing else — and `.callout--warn` differs from
 * `.callout--note` only by a red-versus-grey left border and tint. `formMessage` on the
 * customer surface passes no title, so *every* form-level refusal was distinguished from a
 * confirmation by hue alone: a WCAG 1.4.1 failure on the seven places a customer is most
 * likely to meet one, and invisible in greyscale, in a forced-colours mode, and to a screen
 * reader.
 *
 * A glyph on its own would satisfy 1.4.1 and would still be weak here. These four tones
 * mean four different things and two of them share an amber; a word is the only cue that
 * cannot be lost. So every tone that carries meaning gets a heading, and `note` — which
 * means "neutral context" and claims nothing — deliberately gets none.
 */
const TONE_TITLE: Readonly<Record<CalloutTone, string | null>> = {
  note: null,
  limit: 'What this does not cover',
  warn: 'There is a problem',
  todo: 'Not filled in yet',
};

export function Callout(options: CalloutOptions): Html {
  const tone = options.tone ?? 'note';
  // `limit` gets its own silhouette rather than the warning triangle: a permanent edge of
  // the product is not a fault the reader can act on, and drawing the two the same way
  // tells them to try.
  const titleIcon =
    tone === 'warn' || tone === 'todo' ? iconAlert() : tone === 'limit' ? iconLimit() : null;
  const title = options.title ?? TONE_TITLE[tone] ?? undefined;
  return html`<aside
    ${attrs({ class: cx('callout', `callout--${tone}`), id: options.id ?? null, 'data-tone': tone })}
  >
    ${title === undefined ? null : html`<p class="callout__title">${titleIcon}${title}</p>`}
    <div class="callout__body">${options.body}</div>
  </aside>`;
}
