/**
 * Inline-SVG primitives for diagrams drawn from data.
 *
 * Everything here returns a *string* of SVG markup in which every piece of data-derived text
 * has already been escaped. The one exit into the page is `SvgFigure`, which wraps the body
 * in `raw()` — so the only way for a value to reach an SVG unescaped is to bypass these
 * helpers, and nothing in the story does.
 *
 * Geometry is expressed in viewBox units and scaled by CSS (`.story-figure svg`). No `width`
 * or `height` attribute is emitted on the root, and no `style` attribute anywhere: the
 * Worker's policy is `style-src-attr 'none'`, and a dropped geometry attribute is exactly
 * how a 33% meter once drew as 100%. Fill and stroke are classes, so the theme drives them.
 */
import { escapeAttribute, html, raw, type Html } from '../html.js';

/** Escape for text content and attribute values alike. Re-exported so callers use one name. */
export const esc = escapeAttribute;

/** Visual tone of a box. The four status tones are for verdicts only, never decoration. */
export type BoxTone = 'plain' | 'sunken' | 'external' | 'verified' | 'failed' | 'unverified' | 'pending';

const VERDICT_TONES: ReadonlySet<BoxTone> = new Set(['verified', 'failed', 'unverified', 'pending']);

export interface SvgBoxOptions {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Text lines, already broken by the caller. The first is set strong. */
  readonly lines: readonly string[];
  readonly tone?: BoxTone;
  /** Set lines after the first in mono — for machine vocabulary such as `provider_readback`. */
  readonly mono?: boolean;
}

const LINE_HEIGHT = 14;

/** A rounded box with centred text lines. */
export function svgBox(options: SvgBoxOptions): string {
  const tone = options.tone ?? 'plain';
  const boxClass = tone === 'plain' ? 'diag-box' : `diag-box diag-box--${tone}`;
  const firstClass = VERDICT_TONES.has(tone) ? `diag-text diag-text--${tone}` : 'diag-text diag-text--strong';
  const restClass = options.mono === true ? 'diag-text diag-text--mono' : 'diag-text';
  const count = options.lines.length;
  const cx = options.x + options.w / 2;
  const startY = options.y + options.h / 2 - ((count - 1) * LINE_HEIGHT) / 2 + 4;
  const text = options.lines
    .map((line, index) => {
      const y = startY + index * LINE_HEIGHT;
      const cls = index === 0 ? firstClass : restClass;
      return `<text x="${cx}" y="${y}" text-anchor="middle" class="${cls}">${esc(line)}</text>`;
    })
    .join('');
  return (
    `<rect x="${options.x}" y="${options.y}" width="${options.w}" height="${options.h}" rx="4" class="${boxClass}"/>` +
    text
  );
}

/** A straight connector ending in a small filled arrowhead at (x2, y2). */
export function svgArrow(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const headLength = 7;
  const headWidth = 4;
  const baseX = x2 - ux * headLength;
  const baseY = y2 - uy * headLength;
  const leftX = baseX - uy * headWidth;
  const leftY = baseY + ux * headWidth;
  const rightX = baseX + uy * headWidth;
  const rightY = baseY - ux * headWidth;
  const round = (n: number): string => String(Math.round(n * 10) / 10);
  return (
    `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(baseX)}" y2="${round(baseY)}" class="diag-line"/>` +
    `<polygon points="${round(x2)},${round(y2)} ${round(leftX)},${round(leftY)} ${round(rightX)},${round(rightY)}" class="diag-head"/>`
  );
}

/** A plain line with no head — for an axis or a bracket. */
export function svgLine(x1: number, y1: number, x2: number, y2: number, className = 'diag-line'): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${className}"/>`;
}

/** A single text run. `anchor` follows SVG's `text-anchor`. */
export function svgText(
  x: number,
  y: number,
  text: string,
  className = 'diag-text',
  anchor: 'start' | 'middle' | 'end' = 'start',
): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${esc(text)}</text>`;
}

/**
 * Shorten a label that would overrun its box. The full text always appears in the HTML
 * equivalent beside the figure, so nothing is lost — only the picture is kept legible.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface SvgFigureOptions {
  /** Unique on the page; used for the accessible name's element ids. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Accessible name — what the picture is. */
  readonly title: string;
  /** Accessible description — what it shows, in a sentence or two. */
  readonly desc: string;
  /** Already-escaped SVG markup from the helpers above. */
  readonly body: string;
  readonly caption?: Html;
}

/**
 * The figure wrapper. `role="img"` with `aria-labelledby` pointing at the SVG's own `<title>`
 * and `<desc>`, so assistive technology gets a name and a description rather than a tree of
 * unlabelled shapes. The HTML twin of every figure is rendered next to it by the caller.
 */
export function SvgFigure(options: SvgFigureOptions): Html {
  const titleId = `${options.id}-title`;
  const descId = `${options.id}-desc`;
  const svg =
    `<svg viewBox="0 0 ${options.width} ${options.height}" role="img" aria-labelledby="${esc(titleId)} ${esc(descId)}" class="diag" data-diagram="${esc(options.id)}">` +
    `<title id="${esc(titleId)}">${esc(options.title)}</title>` +
    `<desc id="${esc(descId)}">${esc(options.desc)}</desc>` +
    options.body +
    '</svg>';
  return html`<figure class="story-figure" data-figure="${options.id}">
    ${raw(svg)}
    ${options.caption === undefined ? null : html`<figcaption>${options.caption}</figcaption>`}
  </figure>`;
}
