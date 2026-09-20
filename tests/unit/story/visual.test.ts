/**
 * DOC-100..DOC-129 — the visual development story.
 *
 * The cases that matter most are the honesty ones: the page can never show a status the
 * structured record does not carry, an unknown number can never look like zero, and a
 * hostile value in a record field can never become markup. Everything is asserted on the
 * rendered bytes, not on a helper having been called.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PublicLayout, render } from '@verify/ui';
import storyJson from '../../../docs/development-story-events.json';
import {
  DecisionCard,
  StatTile,
  StoryStatusPill,
  STORY_CSS,
  STORY_STATUSES,
} from '../../../packages/ui/src/story/index.js';
import {
  STORY_RECORD,
  STORY_VISUAL_PATH,
  StoryVisualPage,
  narrowStoryRecord,
  sortByTime,
  storyRoutes,
} from '../../../apps/app/src/routes/public/story/index.js';
import { DEMO_RUNS } from '../../../apps/app/src/routes/public/demoData.js';

/* ------------------------------------------------------------------ helpers */

/** The escaping `hono/html` applies to interpolated text. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The markup between the first occurrence of `start` and the next occurrence of `end`. */
function block(markup: string, start: string, end: string): string {
  const from = markup.indexOf(start);
  if (from === -1) throw new Error(`block start not found: ${start}`);
  const to = markup.indexOf(end, from);
  if (to === -1) throw new Error(`block end not found: ${end}`);
  return markup.slice(from, to + end.length);
}

function allMatches(markup: string, re: RegExp): string[] {
  return [...markup.matchAll(re)].map((m) => m[1] ?? '');
}

/**
 * One decision card. The marker is the attribute run `attrs()` emits at runtime — Prettier
 * reflows the template around it but cannot touch it — and it is anchored on the class so a
 * bare `id="EVT-0002"` cannot first hit the substring inside `data-event-id="EVT-0002"` on
 * the timeline list, higher up.
 */
function card(markup: string, eventId: string): string {
  return block(markup, `class="card stack" id="${eventId}"`, '</article>');
}

/** A phrase from a template, tolerant of the line breaks Prettier puts between its words. */
function phrase(text: string): RegExp {
  return new RegExp(
    text
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
  );
}

/** Inline style attributes and event handlers, matched only inside a tag — escaped prose cannot trip it. */
const INLINE_STYLE_ATTR = /<[a-z][^>]*\sstyle\s*=/i;
const INLINE_HANDLER_ATTR = /<[a-z][^>]*\son[a-z]+\s*=/i;

interface RawEvent {
  readonly event_id: string;
  readonly status: string;
  readonly commit_sha: string | null;
  readonly decision_summary: string;
  readonly decision_reason: string;
  readonly alternatives_considered: readonly string[];
  readonly test_evidence_refs: readonly string[];
  readonly limitations: string;
}

const RAW_EVENTS = (storyJson as { events: readonly RawEvent[] }).events;
const JSON_STATUSES = new Set(RAW_EVENTS.map((e) => e.status));

const HOSTILE_TEXT = '<script>alert("xss")</script>';
const HOSTILE_ATTR = '"><img src=x onerror=alert(1)>';

function hostileRecord() {
  return narrowStoryRecord({
    generated_at: '2026-09-19T09:32:11.970Z',
    events: [
      {
        event_id: 'EVT-9001',
        timestamp: '2026-09-19T09:00:00Z',
        milestone_id: HOSTILE_ATTR,
        task_id: HOSTILE_TEXT,
        agent_role: HOSTILE_ATTR,
        model_id: HOSTILE_TEXT,
        status: 'tested',
        goal: HOSTILE_TEXT,
        inputs: [HOSTILE_ATTR],
        changed_artifacts: [HOSTILE_TEXT],
        commit_sha: HOSTILE_ATTR,
        decision_summary: HOSTILE_TEXT,
        alternatives_considered: [HOSTILE_ATTR, HOSTILE_TEXT],
        decision_reason: HOSTILE_ATTR,
        test_evidence_refs: [HOSTILE_TEXT],
        limitations: HOSTILE_ATTR,
        next_step: HOSTILE_TEXT,
      },
    ],
  });
}

let body = '';
let full = '';

beforeAll(async () => {
  body = await render(StoryVisualPage());
  full = await render(
    PublicLayout({ title: 'Story', path: STORY_VISUAL_PATH, body: StoryVisualPage() }),
  );
});

/* ------------------------------------------------------------------ statuses */

describe('statuses never outrun the record', () => {
  it('DOC-100 every status rendered on the page exists in the JSON, and none falls back to unknown', () => {
    const rendered = allMatches(body, /data-story-status="([^"]+)"/g);
    expect(rendered.length).toBeGreaterThan(0);
    for (const status of rendered) {
      expect(JSON_STATUSES.has(status), `rendered status "${status}" is not in the record`).toBe(
        true,
      );
    }
    expect(rendered).not.toContain('unknown');
  });

  it('DOC-101 each event renders exactly the status its JSON event carries, on the card and in the list', () => {
    for (const event of RAW_EVENTS) {
      const re = new RegExp(
        `data-event-id="${event.event_id}"[^>]*data-story-status="([^"]+)"`,
        'g',
      );
      const found = allMatches(body, re);
      expect(
        found.length,
        `${event.event_id} should appear on the card and in the timeline list`,
      ).toBe(2);
      for (const status of found) expect(status).toBe(event.status);
    }
  });

  it('DOC-102 statuses the record does not contain are not drawn on any event, and the page names them as absent', () => {
    const absent = STORY_STATUSES.filter((s) => !JSON_STATUSES.has(s));
    expect(absent.length).toBeGreaterThan(0); // the record currently has no planned/attempted/externally_confirmed
    for (const status of absent) {
      expect(body).not.toContain(`data-story-status="${status}"`);
    }
    expect(body).toContain(`data-absent-statuses="${absent.join(' ')}"`);
    // the strongest status in the vocabulary is named as absent, whatever the template's line breaks
    expect(body).toMatch(/nothing here is\s+externally confirmed/);
  });

  it('DOC-103 a status outside the vocabulary renders as "not in the status vocabulary", never as one of the six', async () => {
    const record = narrowStoryRecord({
      generated_at: null,
      events: [{ ...RAW_EVENTS[0], event_id: 'EVT-9002', status: 'shipped' }],
    });
    const markup = await render(StoryVisualPage({ record, runs: [] }));
    const rendered = card(markup, 'EVT-9002');
    expect(rendered).toContain('not in the status vocabulary');
    expect(rendered).toContain('data-story-status="unknown"');
    for (const status of STORY_STATUSES)
      expect(rendered).not.toContain(`data-story-status="${status}"`);
    expect(markup).not.toContain('shipped');
  });

  it('DOC-129 a story status is drawn neutral — it is a development fact, not an evidence verdict', async () => {
    const pill = await render(StoryStatusPill('deployed'));
    expect(pill).toContain('class="story-status"');
    expect(pill).toContain('deployed');
    expect(pill).not.toMatch(/badge--|verified|failed|unverified|pending/);
    // one pill per event on the card, one in the list, and one per distinct status in the count row
    const pills = body.match(/class="story-status"/g) ?? [];
    expect(pills.length).toBe(RAW_EVENTS.length * 2 + JSON_STATUSES.size);
  });
});

/* ------------------------------------------------------------------ unknown */

describe('unknown is unknown, never zero', () => {
  it('DOC-104 a stat tile with no recorded value says unknown and contains no numeral', async () => {
    const tile = await render(
      StatTile({ label: 'Tokens consumed', value: null, source: 'docs/model-routing.md' }),
    );
    expect(tile).toContain('data-unknown="true"');
    expect(tile).toContain('>unknown<');
    expect(tile).not.toMatch(/>\s*0\s*</);
    expect(tile).toContain('data-known="no"');

    const unknownTiles = [
      ...body.matchAll(/<div\s+class="stat"[^>]*data-known="no"\s*>([\s\S]*?)<\/div>/g),
    ];
    expect(unknownTiles.length).toBeGreaterThanOrEqual(4);
    for (const [, inner] of unknownTiles) {
      expect(inner).toContain('data-unknown="true"');
      expect(inner).not.toMatch(/class="stat__value">/);
    }
  });

  it('DOC-105 a null commit_sha renders as "not recorded", not as a fabricated hash', () => {
    const withoutSha = RAW_EVENTS.filter((e) => e.commit_sha === null);
    expect(withoutSha.length).toBeGreaterThan(0);
    for (const event of withoutSha) {
      const rendered = card(body, event.event_id);
      expect(rendered).toContain('<dd>not recorded</dd>');
    }
  });

  it('DOC-106 model cost and token figures are shown as unknown because the tooling exposes neither', () => {
    expect(body).toMatch(/data-stat="Model usage cost" data-known="no"/);
    expect(body).toMatch(/data-stat="Tokens consumed" data-known="no"/);
    expect(body).toMatch(/data-stat="Cloudflare plan tier" data-known="no"/);
  });
});

/* ------------------------------------------------------------------ policy */

describe('the deployed policy would not have to make an exception for this page', () => {
  it('DOC-107 no inline style attribute is emitted anywhere on the full page', () => {
    expect(full).not.toMatch(INLINE_STYLE_ATTR);
    // the meter failure quotes the offending markup as prose; that must survive, escaped, and not count
    expect(body).toContain('style=&quot;width:33%&quot;');
    expect(STORY_CSS).not.toContain('style=');
  });

  it('DOC-110 the page is complete with JavaScript disabled: one theme script, no handlers, native details', () => {
    expect((full.match(/<script/g) ?? []).length).toBe(1); // the shell's theme script, and nothing of ours
    expect(body).not.toContain('<script');
    expect(full).not.toMatch(INLINE_HANDLER_ATTR);
    expect(full).not.toMatch(/javascript:/i);
    expect(body).toContain('<details');
    expect(body).toContain('<summary class="disc__summary">');
  });

  it('DOC-127 the disclosure summary has a visible focus ring in the story stylesheet', () => {
    expect(STORY_CSS).toContain('.disc__summary:focus-visible{outline:2px solid var(--c-focus)');
  });
});

/* ------------------------------------------------------------------ hostile */

describe('hostile record fields render inert', () => {
  it('DOC-108 script and attribute-breaking payloads in every text field are escaped on the card', async () => {
    const markup = await render(StoryVisualPage({ record: hostileRecord(), runs: [] }));
    expect(markup).not.toContain('<script>');
    expect(markup).not.toMatch(/<img/);
    expect(markup).not.toMatch(/<[a-z]+[^>]*onerror/i);
    expect(markup).toContain(esc(HOSTILE_TEXT));
    expect(markup).toContain(esc(HOSTILE_ATTR));
    // the payload used as a milestone id must not close the attribute it is written into
    expect(markup).not.toContain('data-story-status=""><img');
  });

  it('DOC-109 the same payloads are escaped inside the SVG timeline, where text is raw markup', async () => {
    const markup = await render(StoryVisualPage({ record: hostileRecord(), runs: [] }));
    const svg = block(markup, 'data-diagram="timeline"', '</svg>');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toMatch(/<text[^>]*>[^<]*&quot;&gt;&lt;img/);
  });
});

/* ------------------------------------------------------------------ motion */

describe('nothing moves, and it says so', () => {
  it('DOC-111 no animation or transition is declared, no SVG animates, and the page labels itself historical', () => {
    expect(STORY_CSS).not.toContain('@keyframes');
    expect(STORY_CSS.replace(/transition:none/g, '')).not.toContain('transition:');
    expect(STORY_CSS.replace(/animation:none/g, '')).not.toContain('animation:');
    expect(full).not.toMatch(/<animate|<animateTransform|<set\s/);
    expect(body).toContain('data-historical');
    expect(body).toContain('Historical record');
    expect(body).toMatch(phrase('nothing is animated'));
  });

  it('DOC-112 the reduced-motion path is static by construction: a guard exists and every figure has an HTML twin', () => {
    expect(STORY_CSS).toContain('@media (prefers-reduced-motion:reduce)');
    const figures = allMatches(body, /data-figure="([^"]+)"/g);
    expect(figures.sort()).toEqual(['journey', 'system', 'timeline']);
    for (const id of figures) {
      expect(body, `figure ${id} needs a data-diagram-alt twin`).toContain(
        `data-diagram-alt="${id}"`,
      );
    }
  });

  it('DOC-113 every diagram is an inline SVG with role="img", an accessible name and a description', () => {
    const svgs = body.match(/<svg[^>]*class="diag"[^>]*>/g) ?? [];
    expect(svgs.length).toBe(3);
    for (const open of svgs) {
      expect(open).toContain('role="img"');
      expect(open).toMatch(/aria-labelledby="[a-z]+-title [a-z]+-desc"/);
    }
    expect((body.match(/<title id="[a-z]+-title">/g) ?? []).length).toBe(3);
    expect((body.match(/<desc id="[a-z]+-desc">/g) ?? []).length).toBe(3);
  });

  it('DOC-124 every diagram fits a 390px viewport: viewBox no wider than 360 and no width attribute a policy could drop', () => {
    const roots = body.match(/<svg[^>]*class="diag"[^>]*>/g) ?? [];
    for (const open of roots) {
      const view = /viewBox="0 0 (\d+) (\d+)"/.exec(open);
      expect(view, open).not.toBeNull();
      expect(Number(view?.[1])).toBeLessThanOrEqual(360);
      expect(open).not.toMatch(/\swidth=/);
      expect(open).not.toMatch(/\sheight=/);
    }
    expect(STORY_CSS).toContain('.story-figure{');
    expect(STORY_CSS).toMatch(/\.story-figure\{[^}]*overflow-x:auto/);
  });
});

/* ------------------------------------------------------------------ decision cards */

describe('decision cards are verbatim', () => {
  it('DOC-114 decision, alternatives and reason appear word for word for every event', () => {
    for (const event of RAW_EVENTS) {
      const rendered = card(body, event.event_id);
      expect(rendered).toContain(esc(event.decision_summary));
      expect(rendered).toContain(esc(event.decision_reason));
      for (const alternative of event.alternatives_considered)
        expect(rendered).toContain(esc(alternative));
      if (event.alternatives_considered.length === 0) expect(rendered).toContain('None recorded.');
    }
  });

  it('DOC-115 the limitation is visible in the flow, before any disclosure, on a single card and on the page', async () => {
    const single = await render(
      DecisionCard({
        event_id: 'EVT-9003',
        when: '2026-09-19 09:00:00 UTC',
        milestone_id: 'M1',
        task_id: 'x',
        agent_role: 'lead',
        model_id: null,
        status: 'tested',
        goal: 'g',
        decision_summary: 'd',
        alternatives_considered: [],
        decision_reason: 'r',
        limitations: 'THE LIMITATION',
        test_evidence_refs: ['ref'],
        changed_artifacts: [],
        inputs: [],
        commit_sha: null,
        next_step: null,
      }),
    );
    expect(single.indexOf('THE LIMITATION')).toBeGreaterThan(-1);
    expect(single.indexOf('THE LIMITATION')).toBeLessThan(single.indexOf('<details'));

    for (const event of RAW_EVENTS) {
      const rendered = card(body, event.event_id);
      const at = rendered.indexOf(esc(event.limitations));
      expect(at, `${event.event_id} limitation missing`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(rendered.indexOf('<details'));
    }
  });

  it('DOC-116 every test evidence reference is rendered verbatim, and an event with none says so', () => {
    for (const event of RAW_EVENTS) {
      const rendered = card(body, event.event_id);
      for (const ref of event.test_evidence_refs) expect(rendered).toContain(esc(ref));
      if (event.test_evidence_refs.length === 0) {
        expect(rendered).toContain(
          'None recorded — and the record therefore claims nothing tested.',
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ timeline */

describe('timeline', () => {
  it('DOC-117 the list and the figure are ordered by recorded time and labelled as not to scale', () => {
    const list = block(body, '<ol class="tl"', '</ol>');
    const ids = allMatches(list, /data-event-id="([^"]+)"/g);
    expect(ids).toEqual(sortByTime(STORY_RECORD.events).map((e) => e.event_id));
    expect(ids.length).toBe(RAW_EVENTS.length);
    const svg = block(body, 'data-diagram="timeline"', '</svg>');
    expect(svg).toContain('not to scale');
    for (const event of RAW_EVENTS) expect(svg).toContain(event.event_id);
    expect(body).toMatch(phrase('Evenly spaced by order, not by elapsed time'));
  });
});

/* ------------------------------------------------------------------ journey */

describe('customer journey', () => {
  it('DOC-118 the journey draws all four verdicts and makes the absence case explicit', () => {
    const svg = block(body, 'data-diagram="journey"', '</svg>');
    for (const word of ['Verified', 'Failed', 'Unverified', 'Pending'])
      expect(svg).toContain(`>${word}<`);
    expect(svg).toContain('not a pass, not a failure');
    expect(svg).toContain('provider unreachable → Unverified, always');
    expect(svg).toContain('customer_claim: a trigger, not proof');
    const rules = block(body, 'data-absence-rules', '</ul>');
    expect(rules).toContain('RECORD_NOT_FOUND');
    expect(rules).toContain('EVENT_NOT_OBSERVED');
    expect(rules).toContain('A timeout never qualifies.');
  });

  it('DOC-119 the journey table’s verdicts are the engine’s own, in the demo’s order, and absence shows as nothing retrieved', () => {
    const table = block(body, 'aria-label="Synthetic runs decided by the real engine"', '</table>');
    const statuses = allMatches(table, /data-status="([A-Z]+)"/g);
    expect(statuses).toEqual(DEMO_RUNS.map((run) => run.status));
    const nothing = (table.match(/data-nothing-retrieved/g) ?? []).length;
    expect(nothing).toBe(DEMO_RUNS.filter((run) => run.observed === null).length);
    expect(nothing).toBeGreaterThan(0);
    // labelled synthetic, and not a live claim
    expect(body).toMatch(phrase('Four real verdicts about invented evidence'));
  });
});

/* ------------------------------------------------------------------ system & roles */

describe('system and roles', () => {
  it('DOC-120 the twelve roles, the lead, and the eight system pieces are all named', () => {
    const roles = block(
      body,
      'aria-label="The twelve specialist roles, the lead, and what each owned"',
      '</table>',
    );
    for (let n = 1; n <= 12; n += 1) {
      expect(roles).toContain(`<span class="mono">A${String(n).padStart(2, '0')}</span>`);
    }
    expect(roles).toContain('<span class="mono">lead</span>');
    const pieces = block(body, 'data-diagram-alt="system"', '</dl>');
    for (const name of [
      'contracts',
      'domain',
      'connectors',
      'security',
      'ui',
      'One Cloudflare Worker',
      'Cloudflare D1',
      'One-minute cron',
    ]) {
      expect(pieces).toContain(`<dt>${name}</dt>`);
    }
  });

  it('DOC-121 a role with no model recorded against its number says so and names no model', () => {
    const roles = block(
      body,
      'aria-label="The twelve specialist roles, the lead, and what each owned"',
      '</table>',
    );
    for (const id of ['A06', 'A07', 'A08', 'A09', 'A12']) {
      expect(roles).toContain(`data-model-unrecorded="${id}"`);
      const row = block(roles, `<span class="mono">${id}</span>`, '</tr>');
      expect(row).toContain('not recorded against this role');
      expect(row).not.toMatch(/claude-|Opus|Sonnet|Haiku|Fable/);
    }
    // and where a record does name one, it is cited
    const a01 = block(roles, '<span class="mono">A01</span>', '</tr>');
    expect(a01).toContain('claude-sonnet-5');
    expect(a01).toContain('EVT-0005');
  });
});

/* ------------------------------------------------------------------ honesty */

describe('honesty rules', () => {
  /**
   * This case used to assert the page said the connectors had NEVER run live. On
   * 20 September 2026 that stopped being true for one of the three providers and stayed true
   * for another, and a single sentence covering three providers is exactly the shape that goes
   * stale silently — so the assertion is now per provider, and the strongest of the three is
   * pinned in the negative: HubSpot is connected and must never be described as proven while
   * it has produced no evidence.
   */
  it('DOC-122 the page states per provider what has and has not run against a live account', () => {
    expect(body).toContain('data-never-live');
    // Resend: what it has actually produced, named as evidence rather than as a connection.
    expect(body).toMatch(phrase('one provider read-back and two signed provider webhooks'));
    // HubSpot: connected is not proven, and the page says so in those words.
    expect(body).toMatch(phrase('HubSpot is connected and has produced no evidence at all'));
    expect(body).toMatch(phrase('connected is not proven'));
    // Stripe: sandbox only, and the live position stated beside it.
    expect(body).toMatch(phrase('one sandbox payment'));
    expect(body).toMatch(phrase('live charges are disabled'));
    // The superseded blanket claim is gone from the page entirely, diagram included.
    expect(body).not.toMatch(phrase('never run against a live account'));
    expect(body).not.toMatch(phrase('never been run against a live HubSpot or Resend account'));
    const svg = block(body, 'data-diagram="system"', '</svg>');
    expect(svg).toContain('Resend: live evidence on a deployment');
    expect(svg).toContain('HubSpot: connected, no evidence yet');
  });

  it('DOC-123 every named failure is told in three parts: what went wrong, why the tests missed it, what changed', () => {
    const required = [
      'allowance',
      'binding',
      'owner',
      'meter',
      'emails',
      'coverage',
      'push',
      'sha',
      'detector',
      'haiku',
      'drift',
      // Added 20 September 2026. The page had told eleven failures and stopped, while the
      // record kept gaining them — the drift this very list exists to catch, one level up.
      'return',
      'counter',
      'invisible',
      'preference',
    ];
    for (const id of required) {
      const article = block(body, `data-failure="${id}"`, '</article>');
      expect(article).toContain('What went wrong');
      expect(article).toContain('Why the tests did not catch it');
      expect(article).toContain('What changed');
      expect(article).toContain('Source: ');
    }
    // the meter story is told to its end, and the record's lag is admitted rather than hidden
    const meter = block(body, 'data-failure="meter"', '</article>');
    expect(meter).toContain('33% draws as 30');
    expect(meter).toContain('has no later event for its removal');
  });

  it('DOC-126 no email address, credential-shaped string or private identifier reaches the page', () => {
    expect(full).not.toMatch(/\b[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    expect(full).not.toMatch(
      /\b(?:sk|rk|pat|whsec|re|xox[abprs]|ghp|gho|github_pat)[_-][A-Za-z0-9_-]{12,}/,
    );
    expect(full).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./);
    expect(full).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  it('DOC-128 the hallucinated repository URL is described, not reproduced as a link', () => {
    const haiku = block(body, 'data-failure="haiku"', '</article>');
    expect(haiku).toContain('an address that does not exist');
    expect(full).not.toContain('itisyou/verify');
    expect(haiku).not.toContain('<a ');
  });
});

/* ------------------------------------------------------------------ route */

describe('route', () => {
  it('DOC-125 the router answers 200 HTML at the story path with the public cache policy', async () => {
    const response = await storyRoutes.request(
      STORY_VISUAL_PATH,
      {},
      {
        ENVIRONMENT: 'test',
        PUBLIC_BASE_URL: 'http://localhost',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    const text = await response.text();
    expect(text).toContain('data-story-visual');
    expect(text).toContain('<html lang="en-GB">');
    expect(text).not.toMatch(INLINE_STYLE_ATTR);
  });
});
