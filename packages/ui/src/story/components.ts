/**
 * Components specific to the visual development story.
 *
 * They exist because nothing in `components/` covered them: a native disclosure, a neutral
 * pill for the six *development* statuses, an explicit "unknown" value, a stat tile whose
 * unknown state can never be mistaken for zero, and a decision card that renders the
 * structured record's fields verbatim rather than paraphrased.
 *
 * Structural shapes only — this package stays a leaf. The route adapts the JSON to these
 * interfaces; the components never read the file.
 */
import { attrs, html, type Html } from '../html.js';
import { Callout } from '../components/card.js';

/* ------------------------------------------------------------------ *
 * The six story statuses
 * ------------------------------------------------------------------ */

/**
 * The status vocabulary `scripts/verify-story.mjs` enforces, in ascending strength. The
 * page renders a status only if it is one of these; anything else renders as "not in the
 * status vocabulary" and never as a neighbouring word.
 */
export const STORY_STATUSES = [
  'planned',
  'attempted',
  'implemented',
  'tested',
  'deployed',
  'externally_confirmed',
] as const;

export type StoryStatus = (typeof STORY_STATUSES)[number];

export function isStoryStatus(value: unknown): value is StoryStatus {
  return typeof value === 'string' && (STORY_STATUSES as readonly string[]).includes(value);
}

/** Human label for a status: the word itself, underscores as spaces, no rewording. */
export function storyStatusLabel(status: StoryStatus): string {
  return status.replace(/_/g, ' ');
}

/**
 * A development status, drawn neutral. In this design system a colour is a verdict about a
 * customer's evidence, and "deployed" is not one — so no green here, on purpose.
 */
export function StoryStatusPill(status: StoryStatus | null): Html {
  if (status === null) {
    return html`<span class="story-status story-status--unknown" data-story-status="unknown"
      >not in the status vocabulary</span
    >`;
  }
  return html`<span ${attrs({ class: 'story-status', 'data-story-status': status })}>${storyStatusLabel(status)}</span>`;
}

/* ------------------------------------------------------------------ *
 * Disclosure
 * ------------------------------------------------------------------ */

export interface DisclosureOptions {
  /** The summary line. Plain text; it is the button's accessible name. */
  readonly summary: string;
  readonly body: Html;
  readonly open?: boolean;
  readonly id?: string;
}

/**
 * A native `<details>`. Works with JavaScript disabled, is keyboard operable by default,
 * and takes the design system's focus ring. Nothing that must be seen goes inside one —
 * limitations, failures and verdicts stay in the flow.
 */
export function Disclosure(options: DisclosureOptions): Html {
  return html`<details ${attrs({ class: 'disc', id: options.id ?? null, open: options.open === true })}>
    <summary class="disc__summary">${options.summary}</summary>
    <div class="disc__body">${options.body}</div>
  </details>`;
}

/* ------------------------------------------------------------------ *
 * Unknown, source, stat tile
 * ------------------------------------------------------------------ */

/**
 * The word "unknown", as a value. Rendered wherever a number was not recorded. It is never
 * `0`, never blank and never a dash, because each of those reads as a measurement.
 */
export function UnknownValue(): Html {
  return html`<span class="stat__value stat__value--unknown" data-unknown="true">unknown</span>`;
}

/** Where a fact came from, in mono, so a reader can go and check it. */
export function SourceLine(source: string): Html {
  return html`<p class="story-source">Source: ${source}</p>`;
}

export interface StatTileOptions {
  readonly label: string;
  /** The recorded figure as text, or `null` when it was not recorded. */
  readonly value: string | null;
  readonly unit?: string;
  /** The event id, document or commit the figure is taken from. Required — no unsourced numbers. */
  readonly source: string;
  readonly note?: string;
}

export function StatTile(options: StatTileOptions): Html {
  return html`<div ${attrs({ class: 'stat', 'data-stat': options.label, 'data-known': options.value === null ? 'no' : 'yes' })}>
    ${options.value === null
      ? html`<p class="stat__value stat__value--unknown" data-unknown="true">unknown</p>`
      : html`<p class="stat__value">${options.value}${options.unit === undefined ? null : html`<span class="stat__unit">${options.unit}</span>`}</p>`}
    <p class="stat__label">${options.label}</p>
    ${options.note === undefined ? null : html`<p class="stat__note">${options.note}</p>`}
    ${SourceLine(options.source)}
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Decision card
 * ------------------------------------------------------------------ */

/** One structured event, adapted for display. Text fields are rendered verbatim. */
export interface DecisionCardEvent {
  readonly event_id: string;
  /** Formatted timestamp, e.g. "2026-09-19 09:03 UTC". */
  readonly when: string;
  readonly milestone_id: string;
  readonly task_id: string;
  readonly agent_role: string;
  readonly model_id: string | null;
  readonly status: StoryStatus | null;
  readonly goal: string;
  readonly decision_summary: string;
  readonly alternatives_considered: readonly string[];
  readonly decision_reason: string;
  readonly limitations: string | null;
  readonly test_evidence_refs: readonly string[];
  readonly changed_artifacts: readonly string[];
  readonly inputs: readonly string[];
  readonly commit_sha: string | null;
  readonly next_step: string | null;
}

function listOr(items: readonly string[], empty: string, mono = false): Html {
  if (items.length === 0) return html`<p class="small muted">${empty}</p>`;
  return html`<ul ${attrs({ class: mono ? 'dcard__list dcard__artifacts' : 'dcard__list' })}>
    ${items.map((item) => html`<li>${item}</li>`)}
  </ul>`;
}

/**
 * The decision, the alternatives and the reason — visible, verbatim. The limitation is
 * visible too, in the same callout the product uses for its own. Evidence references,
 * changed files, inputs, commit and model sit behind a disclosure for the reader who wants
 * to go and check.
 */
export function DecisionCard(event: DecisionCardEvent): Html {
  return html`<article ${attrs({ class: 'card stack', id: event.event_id, 'data-event-id': event.event_id, 'data-story-status': event.status ?? 'unknown' })}>
    <div class="stack-sm">
      <p class="dcard__meta">
        <span>${event.event_id}</span><span>·</span><span>${event.when}</span><span>·</span><span>${event.milestone_id}</span
        ><span>·</span><span>${event.task_id}</span>
      </p>
      <h3 class="card__title">${event.goal}</h3>
      <div class="row">${StoryStatusPill(event.status)}<span class="micro mono">${event.agent_role}</span></div>
    </div>

    <div class="stack-sm">
      <p class="dcard__label">Decision</p>
      <p class="small">${event.decision_summary}</p>
    </div>

    <div class="stack-sm">
      <p class="dcard__label">Alternatives considered</p>
      ${listOr(event.alternatives_considered, 'None recorded.')}
    </div>

    <div class="stack-sm">
      <p class="dcard__label">Why</p>
      <p class="small">${event.decision_reason}</p>
    </div>

    ${event.limitations === null
      ? null
      : Callout({
          tone: 'limit',
          title: 'Limitation, as recorded',
          body: html`<p data-limitation>${event.limitations}</p>`,
        })}

    ${Disclosure({
      summary: 'Evidence, files changed, commit and model',
      body: html`<div class="stack-sm">
          <p class="dcard__label">Test evidence referenced</p>
          ${listOr(event.test_evidence_refs, 'None recorded — and the record therefore claims nothing tested.')}
        </div>
        <div class="stack-sm">
          <p class="dcard__label">Files and directories changed</p>
          ${listOr(event.changed_artifacts, 'None recorded.', true)}
        </div>
        <div class="stack-sm">
          <p class="dcard__label">Inputs</p>
          ${listOr(event.inputs, 'None recorded.', true)}
        </div>
        <dl class="kv">
          <dt>Commit</dt>
          <dd>${event.commit_sha ?? 'not recorded'}</dd>
          <dt>Model</dt>
          <dd>${event.model_id ?? 'not recorded'}</dd>
          <dt>Next step</dt>
          <dd>${event.next_step ?? 'not recorded'}</dd>
        </dl>`,
    })}
  </article>`;
}
