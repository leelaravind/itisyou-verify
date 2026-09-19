/**
 * `@verify/ui` — story-specific additions.
 *
 * Not yet re-exported from `packages/ui/src/index.ts` (A05's file). Until it is, the route
 * imports this module by relative path — the same arrangement `demoData.ts` uses for the
 * shared fixtures, and for the same reason: the alternative is editing a file that is not
 * mine. Note that the vitest alias for `@verify/ui` is a plain string, so a subpath import
 * such as `@verify/ui/story/index.js` would be rewritten to a path that does not exist;
 * the relative import is the one that works everywhere.
 */
export { STORY_BASE, STORY_CSS } from './styles.js';
export {
  DecisionCard,
  Disclosure,
  SourceLine,
  StatTile,
  StoryStatusPill,
  STORY_STATUSES,
  UnknownValue,
  isStoryStatus,
  storyStatusLabel,
  type DecisionCardEvent,
  type DisclosureOptions,
  type StatTileOptions,
  type StoryStatus,
} from './components.js';
export {
  SvgFigure,
  esc,
  svgArrow,
  svgBox,
  svgLine,
  svgText,
  truncate,
  type BoxTone,
  type SvgBoxOptions,
  type SvgFigureOptions,
} from './svg.js';
export { TimelineList, TimelineSvg, type TimelineEntry } from './timeline.js';
