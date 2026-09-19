/**
 * Inline SVG glyphs. No icon package, and none needed.
 *
 * The four status glyphs are drawn so their *silhouettes* differ, not only their colours:
 * a tick, a cross, a dashed ring with a bar, and a clock. Printed in greyscale, or seen by
 * someone who cannot distinguish the hues, they remain four different marks. Each is
 * `aria-hidden` because it always sits beside its own text label — the label is the
 * accessible name, and announcing the glyph too would just repeat it.
 */
import { html, raw, type Html } from '../html.js';

const SVG_OPEN =
  '<svg class="badge__glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false">';

function glyph(body: string): Html {
  return raw(`${SVG_OPEN}${body}</svg>`);
}

/** VERIFIED / SUPPORTED — a closed ring with a tick. */
export const iconCheck = (): Html =>
  glyph('<circle cx="8" cy="8" r="6.4"/><path d="M5 8.2 7.1 10.3 11 5.9"/>');

/** FAILED / CONTRADICTED — a closed ring with a cross. */
export const iconCross = (): Html =>
  glyph('<circle cx="8" cy="8" r="6.4"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6"/>');

/** UNVERIFIED / UNKNOWN — a broken ring with a bar: we looked, and there was no reading. */
export const iconDash = (): Html =>
  glyph('<circle cx="8" cy="8" r="6.4" stroke-dasharray="2.1 2.1"/><path d="M5.2 8h5.6"/>');

/** PENDING — a clock. The window is still open. */
export const iconClock = (): Html =>
  glyph('<circle cx="8" cy="8" r="6.4"/><path d="M8 4.3V8l2.7 1.9"/>');

/** A warning triangle, for error states only. */
export const iconAlert = (): Html =>
  glyph('<path d="M8 2.6 14.4 13H1.6Z"/><path d="M8 6.4v3.1"/><path d="M8 11.4h.01"/>');

/** An outward arrow, marking a link that leaves the site. */
export const iconExternal = (): Html =>
  glyph('<path d="M6.2 3.4h6.4v6.4"/><path d="M12.6 3.4 7 9"/><path d="M11 10.6v2H3.4V5h2"/>');

/** A rightward arrow for "next". */
export const iconArrow = (): Html => glyph('<path d="M3 8h10"/><path d="m9 4 4 4-4 4"/>');

export type GlyphName = 'check' | 'cross' | 'dash' | 'arc';

/** Resolve a glyph by the name held in the token table. */
export function glyphFor(name: GlyphName): Html {
  switch (name) {
    case 'check':
      return iconCheck();
    case 'cross':
      return iconCross();
    case 'dash':
      return iconDash();
    case 'arc':
      return iconClock();
    default:
      return html``;
  }
}
