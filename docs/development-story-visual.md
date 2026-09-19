# The visual development story — what was built, and why it is shaped this way

Owner: A14. Route: `GET /development-story/visual`. Written 19 September 2026.

This is the human-readable development story as a page, for a visitor who is not an
engineer. It is drawn from the same structured record as the machine-readable story
(`docs/development-story-events.json`) and from the prose story
(`docs/development-story.md`), and it adds nothing that either does not say — except
where it cites a commit message or a source comment, and then it says so on the page.

## Where the code is

| Path                                            | What it is                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/app/src/routes/public/story/index.ts`     | The router. Exports `storyRoutes` and `STORY_VISUAL_PATH`.                                                          |
| `apps/app/src/routes/public/story/page.ts`      | The page composition: nine sections, five of them the required views.                                               |
| `apps/app/src/routes/public/story/events.ts`    | Imports the JSON at build time and narrows every field defensively.                                                 |
| `apps/app/src/routes/public/story/narrative.ts` | Hand-encoded content from the prose, the brief, commit messages and source comments. Every item carries a `source`. |
| `apps/app/src/routes/public/story/diagrams.ts`  | The journey and system SVGs, laid out in 360 viewBox units.                                                         |
| `packages/ui/src/story/styles.ts`               | `STORY_CSS` — the classes the page needs. **Not yet in the served stylesheet; see "What the lead must do".**        |
| `packages/ui/src/story/svg.ts`                  | SVG primitives that escape every data-derived string.                                                               |
| `packages/ui/src/story/components.ts`           | Disclosure, story-status pill, unknown value, stat tile, decision card.                                             |
| `packages/ui/src/story/timeline.ts`             | The timeline SVG and its list twin.                                                                                 |
| `tests/unit/story/visual.test.ts`               | 30 cases, `DOC-100`..`DOC-129`.                                                                                     |

## What the lead must do to ship it

Two lines in files that are not mine.

1. **Mount the router** — `apps/app/src/index.ts`, next to `app.route('/', publicRoutes);`
   and _before_ it, so `/development-story/visual` is not shadowed:

   ```ts
   import { storyRoutes } from './routes/public/story/index.js';
   app.route('/', storyRoutes);
   ```

2. **Append the story stylesheet** — `packages/ui/src/styles.ts` (A05's). Import
   `STORY_BASE` from `./story/styles.js` and interpolate it at the end of the `BASE`
   template literal, before `collapse()` runs. The CSP hash is computed from the resulting
   `CSS`, so nothing else changes. Until this is done the page renders correctly but
   unstyled in its story-specific parts: disclosures show the browser's default marker,
   stat tiles lose their grid, and the SVGs have no fill or stroke colour (they draw in the
   browser's defaults, which are black strokes on transparent — legible, not pretty).
   Measured cost: `STORY_CSS` is 5,391 bytes raw, 1,382 gzipped, 1,194 brotli. A05's sheet
   was 16,881 / 3,928 / 3,416, so the combined sheet stays well under the ~10KB-compressed
   line CUST-004 asserts.

Optional: add `{ href: '/development-story/visual', label: 'How this was built, in pictures' }`
to `PRODUCT_LINKS` in `packages/ui/src/layout/layouts.ts` so the footer links to it.

## The five required views, and how each is fed

| View                          | Source of truth                                                                                                                                                                  | How honesty is enforced                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Milestone timeline            | JSON events, sorted by `timestamp` then `event_id`                                                                                                                               | Each row wears exactly the JSON `status`; a value outside the six-word vocabulary renders as "not in the status vocabulary". The page computes which statuses are absent and says so ("nothing here is externally confirmed"). Rows are evenly spaced and labelled not to scale, because two events share 09:20 and two share 09:45. |
| Customer journey              | Prose story §§ The problem, The idea, The line between wrong and unknown; `EvidenceOrigin` and `AUTHORITATIVE_ABSENCE_REASONS` for vocabulary                                    | The Unverified box is drawn the same size as the Verified box. The absence rules are printed inside the SVG, not only beside it. The four verdicts in the table are produced by the real engine over the demo's synthetic fixtures (`DEMO_RUNS`), so the page cannot show a verdict the engine would not reach.                      |
| System and agent-role diagram | Prose story § Architecture; `docs/agent-brief.md` ownership table; `docs/model-routing.md`                                                                                       | A model is shown only where a record ties it to the role number. A06, A07, A08, A09 and A12 say "not recorded against this role" rather than inheriting "Opus" from a prose sentence about functions. External providers are dashed and labelled "never run against a live account".                                                 |
| Decision cards                | JSON `decision_summary`, `alternatives_considered`, `decision_reason`, `limitations`, `test_evidence_refs`, `changed_artifacts`, `inputs`, `commit_sha`, `model_id`, `next_step` | Rendered verbatim; the test asserts byte equality after escaping. Limitations sit in a visible `callout--limit` above the disclosure. An empty `alternatives_considered` says "None recorded." A null `commit_sha` says "not recorded". An empty `test_evidence_refs` says the record therefore claims nothing tested.               |
| Evidence panels               | JSON `test_evidence_refs` figures; prose § Where it stands; `docs/model-routing.md`; `docs/audit-summary.md`                                                                     | Every tile carries its source. A figure with no source renders the word `unknown` in amber, with `data-known="no"`, and the test asserts no numeral appears in such a tile. Model cost, token count, Cloudflare plan tier and uptime are unknown.                                                                                    |

Plus **What broke**, eleven failures each told in three parts — what went wrong, why the
tests did not catch it, what changed — with a source line. The six the brief named are all
there: the allowance reservation (EVT-0007), the credential binding (EVT-0008), the owner
dashboard (commit `d0e9453`), the 33%-as-100% meter (EVT-0010 and commits `ab4b345`,
`7a3c0e1`), the three falsified emails (commit `3673ea8`), the coverage mode with no
implementation (commit `3c94f8d`). The other five are push protection, the pinned SHA, the
SQL detector, the hallucinated URL, and the story underselling its own fix.

## Design decisions

- **Build-time JSON import, not the assets binding.** `resolveJsonModule` is already on.
  The existing Markdown page reads a copy from `apps/app/public/`, and `diff` shows that
  copy is already stale (it lacks the paragraphs about the exception being removed). A
  copy can drift; an import cannot.
- **No colour on story statuses.** The design system reserves hue for evidence verdicts.
  `deployed` is a development fact, not a verdict about a customer's evidence, so the six
  story statuses are neutral pills. The only exception is `unknown`, which wears the
  UNVERIFIED amber because "we do not have this number" is the same class of statement as
  "we could not confirm this check".
- **No motion at all.** Nothing animates or transitions. The reduced-motion guard is
  present so a future addition cannot slip past the test that asserts its presence.
- **Diagrams are 360 viewBox units wide, scaled by CSS.** That fits a 390px viewport with
  the page's own padding and needs no horizontal scroll; the figure container still has
  `overflow-x:auto` as a backstop. No `width`/`height` attribute on the root, because a
  dropped geometry attribute is exactly how the meter bug happened. Every figure has an
  HTML twin (`data-diagram-alt`) beside it, and every SVG has `role="img"`, a `<title>` and
  a `<desc>`.
- **Relative import of `packages/ui/src/story/`.** The vitest alias for `@verify/ui` is a
  plain string, so `@verify/ui/story/index.js` would be rewritten to a path that does not
  exist. `demoData.ts` set the precedent for a relative cross-package import with a stated
  reason. If A05 re-exports `./story/index.js` from `packages/ui/src/index.ts`, the imports
  can move to `@verify/ui`.
- **Every SVG text run is escaped** by the primitives in `svg.ts`; `SvgFigure` is the only
  `raw()` exit. DOC-108 and DOC-109 feed script and attribute-breaking payloads through
  every record field and assert they render inert in HTML and inside the SVG.

## Verified while building — things the lead should know

These are findings, not opinions. Each was checked by running a command.

1. **`apps/app/public/development-story.md` is stale.** `diff docs/development-story.md
apps/app/public/development-story.md` shows the public copy lacks lines 189–206 of the
   source (the paragraphs recording that the CSP exception was removed and the meter rounds
   down). The deployed `/development-story` therefore still undersells the fix that commit
   `7a3c0e1` corrected in `docs/`. The lead owns `public/`.
2. **The JSON and the prose disagree on the CSP fix.** EVT-0010 records the exception stage
   (`style-src-attr` allows inline attributes; limitation "the concession stays until…").
   The prose, the deployed policy and `apps/app/src/index.ts` (`"style-src-attr 'none'"`)
   record the exception removed. There is no event for the removal. The page shows EVT-0010
   as recorded and states the disagreement in the meter failure and in the Provenance
   section. The prose story's own footer says a disagreement is a defect in the story; this
   one is a missing event in the JSON.
3. **Recorded test counts have drifted from the tree.** EVT-0006 records 195 VERIFY cases;
   `grep` finds 205 distinct `VERIFY-` ids under `tests/unit/domain` today. EVT-0008's 156
   security cases still matches (156 distinct `SEC-` ids under `tests/security`). The page
   shows the recorded figures with their event ids and says figures are not re-counted at
   render time.
4. **`node scripts/verify-story.mjs`** reports 12 events: 3 implemented, 5 tested, 4
   deployed. No event is `planned`, `attempted` or `externally_confirmed`; the page computes
   and states that.
5. **The secret scanner** (`node scripts/scan-secrets.mjs`) reports clean over 432 tracked
   files. My files are not yet tracked, so it did not scan them; DOC-126 applies the same
   token-shaped, JWT and private-key patterns to the rendered page instead. One English
   word ("re-verification") tripped the token pattern and was reworded rather than
   allowlisted.

## What is verified, and what is relayed

**Verified — read from the record or produced by code at build time:**
the timeline, every decision card, every figure labelled with an event id, the status
counts, the absent-status statement, and the four journey verdicts (computed by
`@verify/domain` over `tests/fixtures/` when the page is built).

**Relayed — this page's presentation of someone else's claim, each with its source:**
the problem statement and the four-status table (prose story); the journey step text
(prose story); the roles table (agent brief, JSON, model-routing document); the system
pieces (prose story, agent brief); all eleven failures (prose story, commit messages
`d0e9453`, `3673ea8`, `3c94f8d`, `7a3c0e1`, the coverage module header, the owner router
comment); the £0.00 / £100 / £30 figures (prose story); the audit figures (the
independent auditor's public summary, not re-verified); "never run against a live
account" (prose story and audit summary).

**Not on the page because no source was found:** nothing the brief asked for was omitted.
Model attributions for A06, A07, A08, A09 and A12 are shown as not recorded rather than
inferred.

## Test results, as run

- `npx tsc -p tsconfig.json --noEmit` — exit 0.
- `npx vitest run tests/unit/story` — 1 file, 30 cases, 30 passed.
- `npx eslint` over my paths with `--max-warnings=0` — exit 0.
- `npx prettier --check` over my paths — clean after `--write`.

## Known limits of this page

- Rendered markup for the full page is about 144KB before compression, most of it the
  twelve decision cards and eleven failures. It is a documentation page served with
  `public, max-age=0, must-revalidate`; if that matters, the decision cards could move to a
  second route.
- The SVG text widths were checked by a character-count estimate, not by rendering in a
  browser. The estimate found no overruns; a screenshot on staging is still the right next
  step, for exactly the reason the meter story gives.
- The page cannot be styled in its story-specific parts until A05 appends `STORY_BASE`.
  It is readable without it.
