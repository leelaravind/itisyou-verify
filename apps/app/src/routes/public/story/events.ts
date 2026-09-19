/**
 * The structured record, imported at build time.
 *
 * `docs/development-story-events.json` is bundled into the Worker by Wrangler's esbuild, so
 * the page can never drift from the record: if the JSON changes, the page changes with it on
 * the next deploy, and there is no second copy in `public/` to fall out of date (the
 * Markdown twin already has — see `docs/development-story-visual.md`).
 *
 * Narrowing is defensive rather than trusting. `scripts/verify-story.mjs` validates the file
 * in CI, but this module still checks every field it renders, because a page about honesty
 * that crashed — or, worse, rendered a stronger status than the record carries — on a
 * malformed field would be the wrong kind of failure. A status outside the vocabulary
 * becomes `null` and renders as "not in the status vocabulary", never as a neighbour.
 */
import storyRecord from '../../../../../../docs/development-story-events.json';
import { isStoryStatus, type StoryStatus } from '../../../../../../packages/ui/src/story/index.js';

export interface StoryEvent {
  readonly event_id: string;
  readonly timestamp: string;
  readonly milestone_id: string;
  readonly task_id: string;
  readonly agent_role: string;
  readonly model_id: string | null;
  /** The recorded status if it is in the vocabulary, else `null`. */
  readonly status: StoryStatus | null;
  /** What the record literally said, kept so a bad value can be shown rather than hidden. */
  readonly raw_status: string;
  readonly goal: string;
  readonly inputs: readonly string[];
  readonly changed_artifacts: readonly string[];
  readonly commit_sha: string | null;
  readonly decision_summary: string;
  readonly alternatives_considered: readonly string[];
  readonly decision_reason: string;
  readonly limitations: string | null;
  readonly test_evidence_refs: readonly string[];
  readonly next_step: string | null;
}

export interface StoryRecord {
  readonly generated_at: string | null;
  readonly events: readonly StoryEvent[];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function textList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Narrow one raw event. Never throws; every field has an honest fallback. */
export function narrowStoryEvent(raw: unknown): StoryEvent {
  const e = record(raw);
  const rawStatus = text(e['status'], '');
  return {
    event_id: text(e['event_id'], 'EVT-????'),
    timestamp: text(e['timestamp'], ''),
    milestone_id: text(e['milestone_id'], 'no milestone'),
    task_id: text(e['task_id'], 'untitled task'),
    agent_role: text(e['agent_role'], 'role not recorded'),
    model_id: textOrNull(e['model_id']),
    status: isStoryStatus(rawStatus) ? rawStatus : null,
    raw_status: rawStatus,
    goal: text(e['goal'], 'goal not recorded'),
    inputs: textList(e['inputs']),
    changed_artifacts: textList(e['changed_artifacts']),
    commit_sha: textOrNull(e['commit_sha']),
    decision_summary: text(e['decision_summary'], 'decision not recorded'),
    alternatives_considered: textList(e['alternatives_considered']),
    decision_reason: text(e['decision_reason'], 'reason not recorded'),
    limitations: textOrNull(e['limitations']),
    test_evidence_refs: textList(e['test_evidence_refs']),
    next_step: textOrNull(e['next_step']),
  };
}

/** Narrow the whole document. */
export function narrowStoryRecord(raw: unknown): StoryRecord {
  const doc = record(raw);
  const events = Array.isArray(doc['events']) ? doc['events'].map(narrowStoryEvent) : [];
  return { generated_at: textOrNull(doc['generated_at']), events };
}

/** Sort by recorded time, then by id so ties are stable. Never mutates the input. */
export function sortByTime(events: readonly StoryEvent[]): readonly StoryEvent[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    const safeA = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
    const safeB = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    if (safeA !== safeB) return safeA - safeB;
    return a.event_id.localeCompare(b.event_id);
  });
}

/** How many events carry each in-vocabulary status. Zero-count statuses are omitted. */
export function countByStatus(events: readonly StoryEvent[]): ReadonlyMap<StoryStatus, number> {
  const counts = new Map<StoryStatus, number>();
  for (const event of events) {
    if (event.status === null) continue;
    counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
  }
  return counts;
}

/** The record as shipped. */
export const STORY_RECORD: StoryRecord = narrowStoryRecord(storyRecord);
