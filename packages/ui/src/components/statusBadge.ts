/**
 * The status badge.
 *
 * Three independent signals, always, because one of them will fail someone:
 *   1. a glyph with a distinct silhouette (survives greyscale and colour blindness),
 *   2. a text label (survives both, and is what a screen reader announces),
 *   3. a border in the status colour (survives a high-contrast forced-colours mode,
 *      where backgrounds are overridden but borders are kept).
 *
 * Colour alone is never used, here or anywhere else in the package.
 */
import { attrs, cx, html, type Html } from '../html.js';
import {
  ASSERTION_LABEL,
  ASSERTION_TO_STATUS,
  STATUS_PRESENTATION,
  type AssertionKey,
  type StatusKey,
} from '../tokens.js';
import { glyphFor } from './icons.js';

const MODIFIER: Readonly<Record<StatusKey, string>> = {
  VERIFIED: 'badge--verified',
  FAILED: 'badge--failed',
  UNVERIFIED: 'badge--unverified',
  PENDING: 'badge--pending',
};

export interface StatusBadgeOptions {
  readonly status: StatusKey;
  /** Larger variant for a run's headline verdict. */
  readonly large?: boolean;
  /** Overrides the visible label. The status word is still announced via the prefix. */
  readonly label?: string;
}

/**
 * A run status badge. The accessible name reads "Status: Verified" rather than bare
 * "Verified", so a screen-reader user meeting it out of context knows what is being
 * claimed.
 */
export function StatusBadge(options: StatusBadgeOptions): Html {
  const presentation = STATUS_PRESENTATION[options.status];
  const label = options.label ?? presentation.label;
  return html`<span
    ${attrs({
      class: cx('badge', MODIFIER[options.status], options.large === true ? 'badge--lg' : ''),
      'data-status': options.status,
    })}
    >${glyphFor(presentation.glyph)}<span class="sr-only">Status: </span>${label}</span
  >`;
}

export interface AssertionBadgeOptions {
  readonly status: AssertionKey;
  readonly large?: boolean;
}

/**
 * An assertion-level badge. It borrows the run palette deliberately — the customer-facing
 * meaning of "confirmed" and "verified" is the same — but keeps its own wording, because a
 * single check being confirmed is not the same claim as a whole run being verified.
 */
export function AssertionBadge(options: AssertionBadgeOptions): Html {
  const mapped = ASSERTION_TO_STATUS[options.status];
  const presentation = STATUS_PRESENTATION[mapped];
  return html`<span
    ${attrs({
      class: cx('badge', MODIFIER[mapped], options.large === true ? 'badge--lg' : ''),
      'data-assertion-status': options.status,
    })}
    >${glyphFor(presentation.glyph)}<span class="sr-only">Check: </span>${ASSERTION_LABEL[options.status]}</span
  >`;
}
