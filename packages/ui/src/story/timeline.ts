/**
 * The milestone timeline: one SVG drawn from the events, and the list that is its twin.
 *
 * Rows are spaced evenly and sorted by recorded time. Spacing is *not* to scale, and the
 * figure's own description says so — two events share 09:20 and two share 09:45, and a
 * proportional axis would stack their labels on top of each other. The honest picture is
 * the ordered one, with every real timestamp printed beside it.
 */
import { attrs, html, type Html } from '../html.js';
import { StoryStatusPill, storyStatusLabel, type StoryStatus } from './components.js';
import { SvgFigure, svgLine, svgText, truncate } from './svg.js';

export interface TimelineEntry {
  readonly event_id: string;
  /** Formatted time, e.g. "09:03 UTC". */
  readonly whenLabel: string;
  /** The raw ISO timestamp, rendered as a `<time>` value. */
  readonly timestamp: string;
  readonly milestone_id: string;
  readonly task_id: string;
  readonly agent_role: string;
  readonly status: StoryStatus | null;
  /** Anchor to the event's decision card. */
  readonly href: string;
}

const ROW = 52;
const TOP = 24;
const AXIS_X = 22;
const TEXT_X = 36;
const WIDTH = 360;

function statusWord(status: StoryStatus | null): string {
  return status === null ? 'status not in vocabulary' : storyStatusLabel(status);
}

/** The SVG. */
export function TimelineSvg(entries: readonly TimelineEntry[], id: string, dayLabel: string): Html {
  const height = TOP + entries.length * ROW + 8;
  let body = svgLine(AXIS_X, TOP - 8, AXIS_X, height - 8, 'diag-axis');
  entries.forEach((entry, index) => {
    const y = TOP + index * ROW + 10;
    body += `<circle cx="${AXIS_X}" cy="${y}" r="4" class="diag-dot"/>`;
    body += svgText(
      TEXT_X,
      y + 4,
      `${entry.whenLabel} · ${entry.event_id}`,
      'diag-text diag-text--micro',
    );
    body += svgText(TEXT_X, y + 18, truncate(entry.task_id, 38), 'diag-text diag-text--strong');
    body += svgText(
      TEXT_X,
      y + 32,
      truncate(`${statusWord(entry.status)} · ${entry.milestone_id} · ${entry.agent_role}`, 44),
      'diag-text diag-text--mono',
    );
  });
  return SvgFigure({
    id,
    width: WIDTH,
    height,
    body,
    title: `Timeline of ${entries.length} recorded events on ${dayLabel}`,
    desc:
      'Events in the order they were recorded, each with its time, id, task and the status the record gives it. ' +
      'Rows are evenly spaced and not to scale. The list beside this figure carries the same information.',
    caption: html`Historical record, drawn from
      <span class="mono">docs/development-story-events.json</span>. Evenly spaced by order, not by
      elapsed time.`,
  });
}

/** The list twin: every field the figure shows, plus a link to each decision card. */
export function TimelineList(entries: readonly TimelineEntry[]): Html {
  return html`<ol class="tl" data-diagram-alt="timeline">
    ${entries.map(
      (entry) =>
        html`<li
          ${attrs({ 'data-event-id': entry.event_id, 'data-story-status': entry.status ?? 'unknown' })}
        >
          <time class="tl__when" datetime="${entry.timestamp}">${entry.whenLabel}</time>
          <div class="tl__body">
            <p class="small">
              <a ${attrs({ href: entry.href, class: 'mono' })}>${entry.event_id}</a>
              ${entry.task_id}
            </p>
            <p class="tl__meta">
              ${StoryStatusPill(entry.status)}<span>${entry.milestone_id}</span
              ><span>${entry.agent_role}</span>
            </p>
          </div>
        </li>`,
    )}
  </ol>`;
}
