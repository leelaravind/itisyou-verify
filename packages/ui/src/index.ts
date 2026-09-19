/**
 * `@verify/ui` — the design system and shared page chrome.
 *
 * Two halves, deliberately separate:
 *   - `./content/*` is A01's factual copy. It is plain data and is re-exported unchanged.
 *     Nothing in this package rewrites a claim or invents one.
 *   - everything else is A05's: tokens, the stylesheet, accessible components and layouts.
 *
 * No runtime dependency beyond `hono`. No CSS framework, no icon package, no client
 * framework — the whole interface is server-rendered HTML with one inlined stylesheet.
 */

/* A01's copy, re-exported verbatim. */
export * from './content/index.js';

/* Rendering primitive. */
export {
  attrs,
  cx,
  escapeAttribute,
  html,
  join,
  raw,
  render,
  renderSync,
  when,
  type Child,
  type Html,
} from './html.js';

/* Design tokens. */
export {
  ASSERTION_LABEL,
  ASSERTION_TO_STATUS,
  DARK,
  FONT,
  LAYOUT,
  LIGHT,
  RADIUS,
  SPACE,
  STATUS_PRESENTATION,
  TYPE,
  type AssertionKey,
  type Palette,
  type StatusKey,
  type StatusPresentation,
} from './tokens.js';

/* The stylesheet. */
export { CSS, CSS_BYTES, THEME_SCRIPT } from './styles.js';

/* Components and layouts. */
export * from './components/index.js';
export * from './layout/index.js';
