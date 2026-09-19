# State coverage and status-signal audit — customer surface

**A05b, 19 September 2026.** Measured against the working tree after commit `1bae04d`,
through the Worker entry point (`apps/app/src/index.ts`) and a real browser. Nothing here
is inferred from a template; every "present" was read off a served response or a
screenshot in `docs/screenshots/`, and every measurement names the case that pins it.

Companion to `design/MAPPING.md` (the design) and `docs/gap-register.md` (the register).
This document does not edit the register; the rows it closes or reopens are listed at the
end for the lead.

---

## 1. Status rendering — every site, and what carries the meaning besides colour

The four status colours measure 1.03–1.24:1 against each other in light mode and
1.01–1.11:1 in dark (`design/MAPPING.md` §2). Colour therefore carries no information on
its own, and the question for every render site is: **what else does?**

Shipped in this pass: the fourth signal from the design — a **dashed border** on the
UNVERIFIED badge (`.badge--unverified{border-style:dashed}`), at the same size, weight,
type and tint strength as the other three (CUST-410, CUST-411 assert both on the served
stylesheet) — and the **required follow-up line** under an UNVERIFIED headline verdict
naming what could not be checked and why (CUST-413..416).

Evidence: `docs/screenshots/app-runs--greyscale-1440.png` and
`app-run-unverified--dark-greyscale-1440.png`. In both, VERIFIED (closed ring, tick, solid
border), FAILED (closed ring, cross, solid), UNVERIFIED (dashed ring, bar, **dashed
border**) and PENDING (closed ring, clock hands, solid) are four different marks with the
colour removed.

### 1.1 Customer-facing sites

| Site | Component | Non-colour signals | Verdict |
| --- | --- | --- | --- |
| `/app` recent runs, `/app/runs` list, run detail headline, demo run list and headlines, home "four statuses", how-it-works statuses, story page run tables | `StatusBadge` | glyph silhouette, text label, `Status:` prefix for AT, border, border style | **not colour-alone** |
| Run detail and demo "Expected against observed" rows, proof result rows | `AssertionBadge` in the evidence margin | glyph, label ("Confirmed" / "Not as expected" / "Could not confirm" / "Still checking"), border, border style | **not colour-alone** |
| Run detail and demo comparator (new) | `Comparator` | row badge as above; right cell **content** differs per state (`no reading` in a dashed box / `not checked yet` / the value); FAILED emphasises **both** values; reason line under UNKNOWN rows | **not colour-alone** |
| Connection rows (`/app`, `/app/connections`, connect step) | `StatusBadge` with a connection label | glyph, label ("Not connected", "Ready", "Expired"…), border | **not colour-alone** |
| Compatibility cards | `StatusBadge` "Supported" / "Not supported" | glyph, label, border | **not colour-alone** |
| Verification-rate meter | `.meter__fill` (single hue) | the exact figure in text directly above and in the bar's accessible name; the bar carries no status meaning by hue | **not a status signal** |
| Callouts `warn` / `limit` / `todo` / `note` | `Callout` | default title per tone + alert or limit glyph (fixed by predecessor, CUST-360..362); `todo` also dashed | **not colour-alone** |
| Form-level errors, field errors | `formMessage`, `.field__error` | title + glyph; `aria-invalid` with a 2px border and an error sentence | **not colour-alone** |
| Failure page (new) | `ErrorState` | `role="alert"`, alert glyph, title, solid border | **not colour-alone** |
| Story page development statuses | `StoryStatusPill` | one neutral colour, text label only | **not colour-alone** (deliberately neutral) |
| Story SVG diagrams | `.diag-box--*` / `.diag-text--*` | every coloured box carries its status word as text (`tests/unit/story/visual.test.ts`) | **not colour-alone** |
| Notification emails | `notifications/templates.ts` | plain text, no colour at all | n/a |

**Customer-facing sites relying on colour alone: none found.**

### 1.2 Owner-only sites that borrow the status palette (A07's, listed, not changed)

These each carry a distinct **text label**, so they pass WCAG 1.4.1. They are listed
because they use `badge--verified/failed/unverified` **without a glyph** and for meanings
that are not verdicts about evidence, which the token doctrine ("a status colour always
means a verdict about evidence") forbids. Recommendation for A07: either route them through
`StatusBadge` with a label override, or give them a neutral pill class like the story page's.

| File:line | Text carried | Palette borrowed for |
| --- | --- | --- |
| `routes/owner/opsPages.ts:72` | connected / not connected | runner liveness |
| `routes/owner/opsPages.ts:147` | notifications state | queue health |
| `routes/owner/opsPages.ts:411` | paused / running | control state |
| `routes/owner/qualityPages.ts:106` | passed / failed / other | job state |
| `routes/owner/qualityPages.ts:377` | cleanup report state | job state |
| `routes/owner/adsPages.ts:82`, `:115` | campaign state, "out of date" | sync freshness |
| `routes/owner/dashboardPages.ts:117`, `:260` | "estimate", "synthetic" | provenance tags |

The owner run detail (`dashboardPages.ts:363`) renders its own verdict block rather than
`RunVerdict`, so it does **not** carry the UNVERIFIED follow-up line. Listed for A07.

### 1.3 Residual risk carried forward

Amber may still read as a soft failure. Recorded in `packages/ui/src/styles.ts` beside the
badge rules rather than declared solved: the separation from FAILED is carried by form
(dashed vs solid, bar vs cross) and by wording; if readers are observed treating
UNVERIFIED as a failure, the fix is the wording and the follow-up line, not the hue.

---

## 2. State-coverage matrix

Legend: **present** = served and read; **new** = written in this pass; **n/a** = the
state has no meaning on that screen (a static page has no empty collection); **gap** =
missing, with the owner named. "Failure" means *the service failed to build the page*.
Field-validation refusals are listed under "notes" because they were already complete.

### 2.1 Signed-in screens

| Screen | Empty | Loading / not yet settled | Failure (ours) | Permission denied | Notes |
| --- | --- | --- | --- | --- | --- |
| `/app` workspace | present — no workflow: "No workflow set up yet… not a passing workspace" + inert Start; no runs: `EmptyState` "No runs received yet — that is not a pass" (CUST-370/371) | present — `LoadingState` "Still checking" while every run is inside its window (CUST-372/373) | **new** — HTML 500 page, `role="alert"`, what failed / what did not happen / try again / support / reference (CUST-430..433) | present — 401 sign-in page, one body for every path (CUST-376) | activity signal reads "No enquiries received yet" from `workflows.last_event_at`; the seeded fixture never sets it |
| `/app/runs` | present (CUST-370 wording) | present — "still checking" in the Decided column | **new** (CUST-431) | present (CUST-376) | pager states "this is all of them" |
| `/app/runs/:id` | present — 404 "No run with that reference"; a foreign run answers **byte-identically** to a nonexistent one (CUST-375) | present — PENDING verdict "Still checking", "not decided yet" | **new** (CUST-433) | present — the 404 is the denial; existence is never confirmed | UNVERIFIED now carries the follow-up line (CUST-413/414); comparator when >1 check (CUST-420..427) |
| `/app/connections` | present — "We cannot show your connections right now… not a statement that your connections are healthy" (CUST-374) | present — `testing`/`authorising` wear PENDING "Not finished yet", never a tick | **new** | present | |
| `/app/usage` | present in miniature — `subscriptionStatus` "none", 0 of 500 | n/a | **new** | present | 499/500 floors to 99% and `meter__fill--95` (CUST-350..353) |
| `/app/support` | n/a (form) | n/a | **new** for page build; 422 with field errors for a refused post | present | success state names the reference |
| `/app/cancel` | present — "There is no subscription to cancel" with the port's reason | n/a | **new** | present | |
| `/app/sign-in` | n/a | n/a | **new** (public router) | n/a — it is the denial page | 422 on a refused email; the same body whether or not the address exists |
| Onboarding 1 compatibility | **gap (minor, A02/A05)** — an empty provider list renders an empty grid; the port always returns two today | n/a | **new** | present | unsupported providers → warn callout |
| Onboarding 2 connect | present — "No providers to connect… a fault on our side" | present — `testing` callout "Not finished yet" | **new**; also "We cannot check a credential yet" when the port cannot validate | present | 422 re-render on a rejected credential; the secret is never echoed |
| Onboarding 3 mapping | present — no workflow → 303 to compatibility | n/a | **new** | present; **viewer role** → the port refuses "Only a workspace admin can change the field mapping", rendered as a form-level message at **422** | recommend a `code` on `WriteResult` so the router can answer 403 (A02 + A05) |
| Onboarding 4 outcome | as mapping | n/a | **new** | as mapping (admin-only refusal at 422) | "nothing required" refusal present |
| Onboarding 5 proof | present — "No proof run yet" | n/a (synchronous) | present — "We could not run the proof" with the blocked reason; **new** for page build | present | UNVERIFIED proof now carries the follow-up line |
| Onboarding 6 review | n/a | n/a | present — blockers callout; checkout failure re-renders at 503 | present | activation path inert while unverified (A05 earlier) |
| Onboarding 7 activation | present — "No runs received yet… an empty list is not a passing score" | n/a | **new** | present | "No active subscription" warn |

### 2.2 Public screens

| Screen | Empty | Loading | Failure (ours) | Permission denied |
| --- | --- | --- | --- | --- |
| `/`, `/how-it-works`, `/pricing`, `/security`, `/support`, `/terms`, `/privacy`, `/refunds` | n/a (static) | n/a | **new** — public router `onError` renders the same failure body in `PublicLayout` | n/a |
| `/demo` | n/a (fixed synthetic data) | present — the PENDING run and its "not checked yet" rows | **new** | n/a |
| `/status` | present — no uptime figure, no green tick (CUST-073) | n/a | **new** | n/a |
| `/development-story` | present — "not published" state when the asset is missing (CUST-074) | n/a | the loader swallows its own errors and renders the not-published state; **new** for anything else | n/a |
| `/development-story/visual` | present — `EmptyState` for a missing record | n/a | **new** | n/a |
| unknown path | present — rendered 404 (CUST-075) | n/a | n/a | n/a |

### 2.3 One failure the new state does not cover

The HTML failure page is installed on the two routers I own. An exception thrown by a
**Worker-level middleware** in `apps/app/src/index.ts` — the suspension guard, the visit
counter — still falls through to the global `app.onError`, which answers the JSON
envelope. This was observed live during the browser pass: a wrangler hot-reload while
another agent was mid-edit produced `ReferenceError: SUSPENDABLE_PATHS is not defined`,
six `GET /app 500`s, and a JSON body on a customer page. Transient, not mine, and the
tree typechecks now — but it is exactly the case the router handler cannot reach. For the
lead: content-negotiate in the global handler (HTML for `Accept: text/html` off `/api/`),
or move the suspension middleware inside the routers.

---

## 3. Proportional indicators — every one, and whether it rounds down

| Indicator | Where | Arithmetic | Fill class | Verified by |
| --- | --- | --- | --- | --- |
| Allowance used | `/app/usage` | `percentFloor` | `meterFillClass` | CUST-350..353 (predecessor) |
| Allowance used, as text | `/app` "This period" | `percentFloor` | — | CUST-352 |
| Verification rate | `/app`, `/demo` (`HealthReadout`) | **was `Math.round` in `packages/domain/src/coverage.ts` — 199 verified of 200 decided printed 100% and drew `meter__fill--100`.** Now `Math.floor`. | `meterFillClass` | **CUST-400..403 (new; red before the fix)** |

No other proportional indicator exists in the customer, owner or story surfaces (searched
for `meter`, `width:`, `progress`; the story's "meter" is the narrative of the incident).
No `style=` attribute exists in any template.

---

## 4. Measurements at 390 / 834 / 1440

Method: 23 served documents (every seeded state, dumped by
`tests/integration/customer/screens-dump.test.ts`) rendered in Chromium at each width;
plus the live Worker on `127.0.0.1:8811` with the seeded identity for the Playwright suites.

| Measure | Result |
| --- | --- |
| Horizontal overflow of the document | **0px on all 69 renders** (23 states × 3 widths); live `CUST-092/093/094` green on `/`, `/demo`, `/pricing`, `/how-it-works`, `/terms`, `/app`, `/app/runs`, `/app/onboarding/outcome` |
| Skip link first in tab order, lands on `#main` | first focusable on all 69 renders; live `CUST-076` green |
| Visible focus ring (2px solid, `--c-focus`) on every focusable | 0 missing across 69 renders (the only misses were `input type="hidden"`, which are not focusable); live `CUST-079` green |
| Comparator below 40rem | stacks as **triplets** (field + verdict + reason, then reported, then retrieved) — `app-run-unverified--mobile-390.png` |
| Dark mode | `app-runs--dark-1440.png`, `app-run-unverified--dark-1440.png` |
| Greyscale, light and dark | `app-runs--greyscale-1440.png`, `app-run-unverified--dark-greyscale-1440.png`, `app-run-failed--greyscale-1440.png`, `app-mixed--greyscale-1440.png` |

### 4.1 The sixteen `CUSTOMER_WORKSPACE_MISSING` cases — now measurable

A02's seed now creates the synthetic workspace and the `workspace_viewer` membership;
`GET /app` answers **200** with the seeded cookie, and the Windows seed script works
(`--file`, not `--command`). Measuring the sixteen for the first time:

| Outcome | Cases |
| --- | --- |
| **pass** | CUST-091, CUST-092, CUST-093, CUST-094 (+ CUST-095 and the screenshot capture) |
| **fail — real gap** | **CUST-080**: `D1CustomerDataPort.synthetic` is hard-coded `false`, so a workspace with `is_synthetic = 1` is served with no "Synthetic data" stripe. That is the exact confusion the banner exists to prevent. Left red on purpose. **A02**: derive `synthetic` from `workspaces.is_synthetic`. |
| **fail — assertion written for the synthetic port** | **CUST-090**: expects the synthetic port's "Nothing was sent to anybody" and `reference syn-…`. On D1, a `curl` POST with the seeded session and CSRF cookies answers 200 with "Message recorded — reference sup_…" and A09's acknowledgement ("We have your message and a person will read it. We do not send an automated answer pretending to be one."), so the page reports what happened; the assertion needs to target that property, not one port's phrasing. In the browser run the post landed on `/app` instead — measured while another session was live-editing the router's CSRF handling, so not diagnosed further here. |
| **skip — thin fixture** | CUST-081..089: the seeded workspace has **no workflow, connections or runs**, so `/app` is the "No workflow set up yet" state, onboarding steps past compatibility redirect, and no run detail can be opened. The specs now discover their fixtures (`firstRunPath`, `customerWorkflowReady`) and skip with `CUSTOMER_WORKFLOW_MISSING` instead of failing on a 404. **A02**: the seed needs a workflow with a current version, two connection rows and a few decided runs with assertion rows, one per status. |

---

## 5. Pre-existing failures found on the way, not mine

| Case | Cause | Owner |
| --- | --- | --- |
| `DOC-114` | `docs/development-story-events.json` `EVT-0015.alternatives_considered` is a string, not an array; the test iterates its characters | lead |
| `CUST-342` | `/development-story/visual` publishes the events record, and two events describe the audit finding in words containing "SOC 2" — a denial, but the served-page scan cannot tell | lead (the claim gate has an allow-marker mechanism; the record is the lead's) |
| `CUST-067` | the home `h1` no longer reads "Know whether your automation actually did the job." | A05 / lead (`HOME_HEADLINE`) |

---

## 6. Register rows this pass bears on (for the lead to update)

| Row | Evidence now |
| --- | --- |
| Four statuses readable without colour | greyscale screenshots above; CUST-410..417 through the entry point |
| Empty, loading, failure, permission-denied states | this matrix; CUST-430..433 for the new failure state |
| Proportional meters round down | CUST-400..403; the domain floor |
| Seed script works on Windows | **now true** — ran cleanly with `--file` |
| Authenticated customer UI measured at 390/834/1440 | measured; see §4.1 for what the measurement found |
| `UNVERIFIED_ACCESS` wording | `DECISION_REASON.UNVERIFIED_*` and `EVIDENCE_UNAVAILABLE` now say whose gap it is; CUST-417 on `/demo` |
