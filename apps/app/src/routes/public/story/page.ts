/**
 * The visual development story.
 *
 * Five required views — a milestone timeline, a customer journey, a system-and-roles
 * diagram, decision cards and evidence panels — plus the failures, which are the part worth
 * reading. Everything is server-rendered HTML with inline SVG drawn from data; there is no
 * client script, nothing moves, and every section says where its facts came from.
 *
 * Two sources feed the page:
 *   - `docs/development-story-events.json`, imported at build time (see `events.ts`). The
 *     timeline, the decision cards and the recorded figures come from here, verbatim.
 *   - `narrative.ts`, hand-encoded from the prose story, commit messages and source comments,
 *     each item carrying its source.
 *
 * The journey's four verdicts are not drawn: they are produced by the real verification
 * engine over the shared synthetic fixtures, via the demo page's `DEMO_RUNS`, so this page
 * cannot show a verdict the engine would not reach.
 */
import { Callout, StatusBadge, Table, html, type Html, type StatusKey } from '@verify/ui';
import {
  DecisionCard,
  Disclosure,
  SourceLine,
  StatTile,
  StoryStatusPill,
  STORY_STATUSES,
  TimelineList,
  TimelineSvg,
  storyStatusLabel,
  type DecisionCardEvent,
  type StoryStatus,
  type TimelineEntry,
} from '../../../../../../packages/ui/src/story/index.js';
import { maskDisplayValue } from '../demo.js';
import { DEMO_RUNS } from '../demoData.js';
import { formatInstant } from '../shared.js';
import { JourneyDiagram, SystemDiagram } from './diagrams.js';
import {
  STORY_RECORD,
  countByStatus,
  sortByTime,
  type StoryEvent,
  type StoryRecord,
} from './events.js';
import {
  ABSENCE_RULES,
  FAILURES,
  FOUR_STATUSES,
  JOURNEY_STEPS,
  LEAD,
  METRIC_GROUPS,
  PROBLEM,
  ROLES,
  STANDING,
  SYSTEM_PIECES,
  type Role,
} from './narrative.js';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One real verdict from the engine, reduced to what the journey table shows. */
export interface JourneyRun {
  readonly id: string;
  readonly status: StatusKey;
  /** What we retrieved, masked; `null` when nothing was retrieved. */
  readonly observed: string | null;
  /** The decision engine's own sentence. */
  readonly reason: string;
  readonly supported: number;
  readonly total: number;
}

/** Adapt the demo's engine-produced runs. Addresses are masked even though synthetic. */
export function journeyRunsFromDemo(): readonly JourneyRun[] {
  return DEMO_RUNS.map((run) => ({
    id: run.id,
    status: run.status as StatusKey,
    observed: maskDisplayValue(run.observed),
    reason: run.decisionReason,
    supported: run.mandatory.supported,
    total: run.mandatory.total,
  }));
}

export interface StoryVisualPageOptions {
  readonly record?: StoryRecord;
  readonly runs?: readonly JourneyRun[];
}

/* ------------------------------------------------------------------ *
 * Formatting helpers — UTC only, never a guessed local time
 * ------------------------------------------------------------------ */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function timeOfDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'time not recorded';
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

function dayOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'an unrecorded date';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/** "19 September 2026" when every event is on one day, else "first – last". */
function spanLabel(events: readonly StoryEvent[]): string {
  const stamps = events.map((e) => e.timestamp).filter((t) => !Number.isNaN(Date.parse(t)));
  if (stamps.length === 0) return 'no recorded dates';
  const first = stamps[0] ?? '';
  const last = stamps[stamps.length - 1] ?? '';
  const firstDay = dayOf(first);
  const lastDay = dayOf(last);
  return firstDay === lastDay ? firstDay : `${firstDay} to ${lastDay}`;
}

function toTimelineEntry(event: StoryEvent): TimelineEntry {
  return {
    event_id: event.event_id,
    whenLabel: timeOfDay(event.timestamp),
    timestamp: event.timestamp,
    milestone_id: event.milestone_id,
    task_id: event.task_id,
    agent_role: event.agent_role,
    status: event.status,
    href: `#${event.event_id}`,
  };
}

function toDecisionCardEvent(event: StoryEvent): DecisionCardEvent {
  return {
    event_id: event.event_id,
    when: formatInstant(event.timestamp),
    milestone_id: event.milestone_id,
    task_id: event.task_id,
    agent_role: event.agent_role,
    model_id: event.model_id,
    status: event.status,
    goal: event.goal,
    decision_summary: event.decision_summary,
    alternatives_considered: event.alternatives_considered,
    decision_reason: event.decision_reason,
    limitations: event.limitations,
    test_evidence_refs: event.test_evidence_refs,
    changed_artifacts: event.changed_artifacts,
    inputs: event.inputs,
    commit_sha: event.commit_sha,
    next_step: event.next_step,
  };
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

const SECTIONS = [
  { id: 'problem', label: 'The problem' },
  { id: 'journey', label: 'Customer journey' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'system', label: 'System and roles' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'broke', label: 'What broke' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'standing', label: 'Where it stands' },
  { id: 'provenance', label: 'What is verified here' },
] as const;

function sectionHead(id: string, eyebrow: string, title: string, lede?: string): Html {
  return html`<div class="stack-sm">
    <p class="eyebrow">${eyebrow}</p>
    <h2 id="${`${id}-heading`}">${title}</h2>
    ${lede === undefined ? null : html`<p class="lede measure">${lede}</p>`}
  </div>`;
}

function toc(): Html {
  return html`<nav class="story-toc" aria-label="On this page">
    <ul>
      ${SECTIONS.map((s) => html`<li><a href="${`#${s.id}`}">${s.label}</a></li>`)}
    </ul>
  </nav>`;
}

function problemSection(): Html {
  return html`<section class="story-section stack" id="problem" aria-labelledby="problem-heading">
    ${sectionHead('problem', 'The problem', 'Success reported by the thing being checked is not evidence')}
    <div class="measure stack">${PROBLEM.paragraphs.map((p) => html`<p>${p}</p>`)}</div>
    ${SourceLine(PROBLEM.source)}
    ${Table({
      caption: 'The four results a run can have',
      columns: [
        { key: 'status', header: 'Result', cell: (row) => StatusBadge({ status: row.status }) },
        { key: 'meaning', header: 'What it means', cell: (row) => row.meaning },
      ],
      rows: FOUR_STATUSES,
    })}
    ${SourceLine(FOUR_STATUSES[0]?.source ?? 'docs/development-story.md')}
  </section>`;
}

function journeySection(runs: readonly JourneyRun[]): Html {
  return html`<section class="story-section stack" id="journey" aria-labelledby="journey-heading">
    ${sectionHead(
      'journey',
      'Customer journey',
      'Enquiry → automation → we read both outcomes back → rules → one of four verdicts',
      'The picture and the list say the same thing. Read whichever suits you.',
    )}
    <div class="grid grid-2">
      ${JourneyDiagram()}
      <div class="story-alt stack" data-diagram-alt="journey">
        <ol class="steps">
          ${JOURNEY_STEPS.map(
            (step) =>
              html`<li>
                <h3>${step.title}</h3>
                <p>${step.body}</p>
                ${step.vocabulary === undefined ? null : html`<p class="micro mono">${step.vocabulary}</p>`}
                ${SourceLine(step.source)}
              </li>`,
          )}
        </ol>
      </div>
    </div>

    ${Callout({
      tone: 'limit',
      title: 'What absence means: the line between "wrong" and "unknown"',
      body: html`<ul class="dcard__list" data-absence-rules>
          ${ABSENCE_RULES.rules.map((rule) => html`<li>${rule}</li>`)}
        </ul>
        ${SourceLine(ABSENCE_RULES.source)}`,
    })}

    <div class="stack-sm">
      <h3>Four real verdicts about invented evidence</h3>
      <p class="small muted measure">
        These rows are produced by running the live verification engine over fixed synthetic
        fixtures, the same runs the <a href="/demo">worked example</a> shows. No customer, no
        database, no provider call. They are here because a diagram can only claim what the engine
        would actually decide.
      </p>
    </div>
    ${Table({
      caption: 'Synthetic runs decided by the real engine',
      columns: [
        {
          key: 'verdict',
          header: 'Verdict',
          cell: (run: JourneyRun) => StatusBadge({ status: run.status }),
        },
        {
          key: 'retrieved',
          header: 'What we retrieved',
          cell: (run: JourneyRun) =>
            run.observed === null
              ? html`<span class="mono muted" data-nothing-retrieved>nothing retrieved</span>`
              : html`<span class="mono">${run.observed}</span>`,
        },
        {
          key: 'checks',
          header: 'Required checks confirmed',
          numeric: true,
          cell: (run: JourneyRun) => `${String(run.supported)}/${String(run.total)}`,
        },
        { key: 'reason', header: 'The engine’s own reason', cell: (run: JourneyRun) => run.reason },
      ],
      rows: runs,
    })}
    ${SourceLine('apps/app/src/routes/public/demoData.ts → @verify/domain evaluateAssertions, decideRunStatus; tests/fixtures/')}
  </section>`;
}

function timelineSection(record: StoryRecord): Html {
  const events = sortByTime(record.events);
  const entries = events.map(toTimelineEntry);
  const counts = countByStatus(events);
  const present = STORY_STATUSES.filter((s) => counts.has(s));
  const absent = STORY_STATUSES.filter((s) => !counts.has(s));
  const outOfVocabulary = events.filter((e) => e.status === null);
  const span = spanLabel(events);

  return html`<section class="story-section stack" id="timeline" aria-labelledby="timeline-heading">
    ${sectionHead(
      'timeline',
      'Milestone timeline',
      `${String(events.length)} recorded events, ${span}`,
      'Each event carries exactly the status the structured record gives it, no stronger.',
    )}
    <div class="row" data-status-counts>
      ${present.map(
        (status) =>
          html`<span class="row"
            >${StoryStatusPill(status)}<span class="micro mono"
              >${String(counts.get(status) ?? 0)}</span
            ></span
          >`,
      )}
      ${
        outOfVocabulary.length === 0
          ? null
          : html`<span class="row"
              >${StoryStatusPill(null)}<span class="micro mono"
                >${String(outOfVocabulary.length)}</span
              ></span
            >`
      }
    </div>
    ${
      absent.length === 0
        ? null
        : html`<p class="small muted measure" data-absent-statuses="${absent.join(' ')}">
            The vocabulary also allows ${absent.map((s) => storyStatusLabel(s)).join(', ')}. No
            event carries ${absent.length === 1 ? 'that status' : 'those statuses'}, so none is
            drawn. In particular, nothing here is externally confirmed.
          </p>`
    }
    <div class="grid grid-2">
      ${TimelineSvg(entries, 'timeline', span)}
      <div class="story-alt">${TimelineList(entries)}</div>
    </div>
    ${SourceLine(
      `docs/development-story-events.json${record.generated_at === null ? '' : `, generated ${formatInstant(record.generated_at)}`}`,
    )}
  </section>`;
}

function systemSection(): Html {
  const allRoles: readonly Role[] = [LEAD, ...ROLES];
  return html`<section class="story-section stack" id="system" aria-labelledby="system-heading">
    ${sectionHead(
      'system',
      'System and roles',
      'One Worker, five packages, twelve specialist roles',
      'Each role was given a bounded task, a set of files it alone owned, and the facts it needed rather than the whole repository.',
    )}
    <div class="grid grid-2">
      ${SystemDiagram()}
      <div class="story-alt" data-diagram-alt="system">
        <dl class="kv">
          ${SYSTEM_PIECES.map(
            (piece) =>
              html`<dt>${piece.name}</dt>
                <dd class="stack-sm">
                  <span>${piece.body}</span>
                  <span class="micro">owned by ${piece.ownedBy}</span>
                  ${SourceLine(piece.source)}
                </dd>`,
          )}
        </dl>
      </div>
    </div>
    ${Table({
      caption: 'The twelve specialist roles, the lead, and what each owned',
      columns: [
        {
          key: 'id',
          header: 'Role',
          rowHeader: true,
          cell: (role: Role) => html`<span class="mono">${role.id}</span>`,
        },
        { key: 'name', header: 'Name', cell: (role: Role) => role.name },
        {
          key: 'owns',
          header: 'Owned',
          cell: (role: Role) => html`<span class="mono small">${role.owns}</span>`,
        },
        {
          key: 'model',
          header: 'Model recorded',
          cell: (role: Role) =>
            role.model === null
              ? html`<span class="muted" data-model-unrecorded="${role.id}"
                  >not recorded against this role</span
                >`
              : html`<span class="mono">${role.model}</span>
                  <span class="micro">(${role.modelSource ?? ''})</span>`,
        },
      ],
      rows: allRoles,
    })}
    <p class="small muted measure">
      A model is listed only where a record ties it to the role number. The routing document also
      attributes commerce, customer experience, support and growth to the strongest model by
      function, without a role number; that mapping is not inferred here. This page itself was
      produced by a later role, A14, which is not among the twelve.
    </p>
    ${SourceLine('docs/agent-brief.md § Repository layout and ownership; docs/model-routing.md § Catalogue; EVT-0001, 0005, 0006, 0007, 0008, 0009')}
  </section>`;
}

function decisionsSection(record: StoryRecord): Html {
  const events = sortByTime(record.events);
  return html`<section
    class="story-section stack"
    id="decisions"
    aria-labelledby="decisions-heading"
  >
    ${sectionHead(
      'decisions',
      'Decision cards',
      'What was decided, what else was considered, and why',
      'These fields are rendered from the structured record word for word. Where the record says "none", the card says none.',
    )}
    <div class="grid grid-2">
      ${events.map((event) => DecisionCard(toDecisionCardEvent(event)))}
    </div>
  </section>`;
}

function failuresSection(): Html {
  return html`<section class="story-section stack" id="broke" aria-labelledby="broke-heading">
    ${sectionHead(
      'broke',
      'What broke',
      'The most valuable content on this page',
      'A product whose pitch is that it does not overstate what it knows cannot have a development story that does. Here is what went wrong, why the tests did not catch it, and what changed.',
    )}
    <div class="stack-lg">
      ${FAILURES.map(
        (failure) =>
          html`<article
            class="fail stack"
            id="${`broke-${failure.id}`}"
            data-failure="${failure.id}"
          >
            <h3>${failure.title}</h3>
            <div class="fail__grid">
              <div class="stack-sm">
                <p class="eyebrow">What went wrong</p>
                <p>${failure.wentWrong}</p>
              </div>
              <div class="stack-sm">
                <p class="eyebrow">Why the tests did not catch it</p>
                <p>${failure.whyMissed}</p>
              </div>
              <div class="stack-sm">
                <p class="eyebrow">What changed</p>
                <p>${failure.whatChanged}</p>
              </div>
            </div>
            ${SourceLine(failure.source)}
          </article>`,
      )}
    </div>
  </section>`;
}

function evidenceSection(): Html {
  return html`<section class="story-section stack" id="evidence" aria-labelledby="evidence-heading">
    ${sectionHead(
      'evidence',
      'Evidence panels',
      'Real numbers, each with the record it came from',
      'Where a number was not recorded, it says unknown. It never says zero.',
    )}
    ${METRIC_GROUPS.map(
      (group) =>
        html`<div class="stack" id="${`evidence-${group.id}`}">
          <div class="stack-sm">
            <h3>${group.title}</h3>
            <p class="small muted measure">${group.intro}</p>
          </div>
          <div class="stats">
            ${group.metrics.map((metric) =>
              StatTile({
                label: metric.label,
                value: metric.value,
                ...(metric.unit === undefined ? {} : { unit: metric.unit }),
                ...(metric.note === undefined ? {} : { note: metric.note }),
                source: metric.source,
              }),
            )}
          </div>
        </div>`,
    )}
  </section>`;
}

function standingSection(): Html {
  return html`<section class="story-section stack" id="standing" aria-labelledby="standing-heading">
    ${sectionHead('standing', 'Where it stands', 'Built, live, and not yet true: kept separate')}
    <div class="grid grid-2">
      ${STANDING.map(
        (item) =>
          html`<section class="card stack-sm" data-standing="${item.heading}">
            <h3 class="card__title">${item.heading}</h3>
            <p class="small">${item.body}</p>
            ${SourceLine(item.source)}
          </section>`,
      )}
    </div>
    ${Callout({
      tone: 'limit',
      title: 'What has, and has not, run against a live provider account',
      body: html`<p data-never-live>
        Until 20 September 2026 this panel said the connectors had never been run against a live
        account and that no credentials existed. Both halves have since stopped being true, and
        the honest version is per provider rather than one sentence covering three. Resend has
        run live: a deployment holds one provider read-back and two signed provider webhooks
        from a real Resend account, and they produced one VERIFIED run and two UNVERIFIED ones.
        HubSpot is connected and has produced no evidence at all; connected is not proven, and
        this page will not let the first stand in for the second. Stripe has taken one sandbox
        payment through the deployed service; live charges are disabled.
      </p>`,
    })}
  </section>`;
}

function provenanceSection(): Html {
  return html`<section
    class="story-section stack"
    id="provenance"
    aria-labelledby="provenance-heading"
  >
    ${sectionHead('provenance', 'Provenance', 'Which parts of this page are verified, and which are relayed')}
    <div class="measure stack">
      <p class="small">
        <strong>Read from the record at build time.</strong> The timeline, every decision card and
        every figure labelled with an event id come from
        <span class="mono">docs/development-story-events.json</span>, the same file
        <span class="mono">scripts/verify-story.mjs</span> validates. If the record changes, this
        page changes with it.
      </p>
      <p class="small">
        <strong>Produced by the real engine.</strong> The four verdicts in the journey table are
        computed by the verification engine over synthetic fixtures when this page is built: real
        decisions about invented facts.
      </p>
      <p class="small">
        <strong>Relayed from other documents.</strong> The narrative, the roles table and the
        failures are this page's presentation of the prose story, the brief, the routing document,
        commit messages and source comments. Each carries its source. The audit figures are an
        independent auditor's published numbers and were not re-verified here.
      </p>
      <p class="small">
        <strong>Not re-counted.</strong> Test totals are as the responsible agent recorded them at
        that moment. The tree has moved since, so a count taken today may differ. That is a property
        of a historical record, and the record is what this page shows.
      </p>
    </div>
    ${Disclosure({
      summary: 'Known disagreements between the sources',
      body: html`<ul class="dcard__list">
        <li>
          EVT-0010 records the CSP fix at the stage where inline style attributes were permitted as
          a named exception; the prose story and the deployed policy record that the exception was
          later removed. The structured record has no event for the removal yet.
        </li>
        <li>
          The Markdown copy served at <a href="/development-story">/development-story</a> is read
          from a static asset that can lag the source document. This page does not use a copy.
        </li>
      </ul>`,
    })}
  </section>`;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export function StoryVisualPage(options: StoryVisualPageOptions = {}): Html {
  const record = options.record ?? STORY_RECORD;
  const runs = options.runs ?? journeyRunsFromDemo();
  const generated =
    record.generated_at === null ? 'an unrecorded time' : formatInstant(record.generated_at);

  return html`<div class="wrap section stack-lg" data-story-visual>
    <div class="stack">
      <div class="stack-sm">
        <p class="eyebrow">Development story · visual</p>
        <h1>How ITISYOU Verify works, and how it was built</h1>
        <p class="lede measure">
          For a reader who is not an engineer: what the product does, in pictures drawn from the
          project's own record, and what went wrong on the way. Nothing here is rounded up.
        </p>
      </div>
      ${Callout({
        tone: 'note',
        title: 'Historical record',
        body: html`<p data-historical>
          Everything on this page describes work already done, as recorded at ${generated}. Nothing
          is live, nothing is animated, and no figure is re-counted when the page renders. The prose
          version is at
          <a href="/development-story">/development-story</a>.
        </p>`,
      })}
      ${toc()}
    </div>

    ${problemSection()} ${journeySection(runs)} ${timelineSection(record)} ${systemSection()}
    ${decisionsSection(record)} ${failuresSection()} ${evidenceSection()} ${standingSection()}
    ${provenanceSection()}
  </div>`;
}

/** Exported for tests: which statuses the page would render for a record. */
export function renderedStatuses(record: StoryRecord): readonly (StoryStatus | null)[] {
  return sortByTime(record.events).map((e) => e.status);
}
