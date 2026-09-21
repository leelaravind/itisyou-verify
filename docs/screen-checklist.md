# Screen checklist — reference, implementation, verification, audit

One row per screen. Started 21 September 2026, after the owner ruled that "15 of 19 composed"
was not evidence that a screen matches its reference or meets the requested quality, and asked
for an actual comparison.

**How a row is filled in.** The reference is rendered from its own `code.html` in a real
browser at 1440, 834 and 390 (`reports/compare/ref/`), because the exported `screen.png` is a
351-pixel thumbnail and nothing can be judged from it. Ours is rendered through the real
router and captured at the same three widths (`reports/compare/after/`). The two are then put
beside each other and the differences are written down as differences, not as impressions.

**What is deliberately NOT taken from a reference.** The owner's exclusions override a
conflicting reference style, and every reference conflicts with several: Inter and Plus Jakarta
Sans, Material Symbols icons, rounded cards, drop shadows, gradients, glass, three-tier
pricing, and in several cases copy that names prices, trials, certifications and integrations
that are not ours. What is taken is composition: layout, hierarchy, spacing rhythm, what
information sits beside what, and which devices earn their space.

## Status vocabulary

- **compared** — reference and render read side by side at all three widths, differences written down
- **implemented** — the differences worth acting on are in the code
- **verified** — re-rendered at 1440, 834 and 390 with no horizontal overflow, and its tests pass
- **audited** — an independent agent inspected the comparison and exercised the screen

## Public screens

| Screen | Reference | Compared | Implemented | Verified 1440/834/390 | Auditor |
| --- | --- | --- | --- | --- | --- |
| `/` home | `itisyou_verify_post_execution_readback_checks_for_automation_agencies` | yes | yes — see below | yes | PASS |
| `/pricing` | `pricing_policy_itisyou_verify` | yes | nothing to change | yes | not inspected |
| `/how-it-works` | `how_it_works_demonstration_itisyou_verify` | yes | answers measured | yes | not inspected |
| `/demo` | `run_details_evidence_itisyou_verify` | yes | nothing to change | yes | not inspected |
| `/security` | none published | n/a | nothing to change | yes | not inspected |
| `/support` | `billing_cancellation_support_itisyou_verify` (part) | yes | yes, see below | yes | not inspected |
| `/terms`, `/privacy`, `/refunds` | none | n/a | nothing to change | yes | not inspected |
| `/development-story` | `visual_development_story_itisyou_verify` | yes | nothing to change | yes | not inspected |

### `/` home — differences found, and what was done about each

| Difference in the reference | Judgement | Done |
| --- | --- | --- |
| A large product artefact carries the hero: reported state beside destination state, with a status taxonomy under it. Ours was a three-line compressed claim rule in a narrow column | Take it. The comparison IS the product, and it was the smallest thing on the page | `EvidenceDiff`: two ruled columns, the verdict, and the three checks that produced it, at full width under the hero copy |
| Mono request and response snippets inside the steps | Take it, with our own real field names. A reader deciding whether this fits their automation can see the exact shape they would send | `.snip` blocks on all three steps: the read scopes, the signed-event fields, the four statuses |
| Centred hero, centred lede, centred buttons | Refuse. It put the argument below the fold on a 1440x900 laptop, and it is the shape every template ships with | left-aligned, copy at a headline measure |
| Three-tier pricing table | Refuse: named exclusion, and we sell one plan | unchanged |
| Integration matrix of fourteen destinations | Refuse: we read HubSpot and Resend. Drawing fourteen would be a false claim | unchanged |
| Material Symbols icons, Inter, Plus Jakarta Sans | Refuse: named exclusions | our own SVG glyphs, our own stack |
| Rounded cards, drop shadows, emerald gradient CTA | Refuse: named exclusions | square, ruled, no shadow |

Defect found while comparing, unrelated to the reference: with `prefers-reduced-motion`
the fourth status card rendered at **opacity 0**. The reset zeroed animation duration but not
delay, and the cards are staggered up to 120ms, so a reader who asked for less motion got an
invisible card. Fixed and held by `RESIL-918`.

## Customer screens

| Screen | Reference | Compared | Implemented | Verified | Auditor |
| --- | --- | --- | --- | --- | --- |
| `/app` workspace | `customer_dashboard_itisyou_verify` | yes | yes — see below | yes | not inspected |
| `/app` mobile | `customer_dashboard_mobile_itisyou_verify` | yes | with the desktop | yes | not inspected |
| `/app/connections` | `connections_evidence_sources_itisyou_verify` | yes | yes, see below | yes | not inspected |
| `/app/runs`, `/app/runs/:id` | `run_details_evidence_itisyou_verify` | yes | yes, see below | yes | not inspected |
| `/app/usage` | `reports_exports_itisyou_verify` | yes | yes, see below | yes | not inspected |
| `/app/billing`, `/app/cancel` | `billing_cancellation_support_itisyou_verify` | yes | nothing to change | yes | not inspected |
| `/app/sign-in` | `sign_in_welcome_itisyou_verify` (+ mobile) | yes | nothing to change | yes | not inspected |
| onboarding steps | `workflow_configuration_itisyou_verify`, `compatibility_proof_checkout_review_itisyou_verify` | yes | nothing to change | yes, four steps at three widths | not inspected |

## Owner screens

| Screen | Reference | Compared | Implemented | Verified | Auditor |
| --- | --- | --- | --- | --- | --- |
| `/owner` overview | `owner_overview_itisyou_verify` | yes | yes — see below | yes, 13 screens | PASS |
| `/owner/customers` | `owner_customer_incident_management_itisyou_verify` | yes | runs against the allowance | yes, three widths | not inspected |
| `/owner/approvals`, `/owner/ads` | `owner_approvals_campaigns_and_budget_...` | yes | nothing to change | yes, three widths | not inspected |
| `/owner/quality`, `/owner/cleanup` | `automated_testing_and_cleanup_centre_itisyou_verify` | yes | nothing to change | yes, three widths | not inspected |
| `/owner/operations`, `/owner/controls`, `/owner/settings`, `/owner/connections`, `/owner/verification` | none published | n/a | recomposed 21 Sept (tones, notices, freshness) | yes, 13 screens at three widths | PASS |
| `/admin/login` | none published | n/a | nothing to change | yes, three widths | not inspected |

### `/pricing` — compared, and deliberately unchanged

| Difference in the reference | Judgement |
| --- | --- |
| Plan detail in the wide column, order summary in the narrow one | Already ours, and asserted by CUST-705 |
| A bar of plan metrics inside the plan panel | Already ours (CUST-706) |
| Payment-recovery rules as a 2x2 grid of mono-labelled rules | Refuse. Ours is two ruled columns because one list has a single line and the other has six; as equal cards the short one reads as a panel that failed to load. The asymmetry is the point: very little stops |
| Questions two abreast | Refuse: we have five, which leaves an orphan, and one column is faster to scan for one question. A stale comment in the code claimed we did this; the comment was wrong and was corrected, not the page |
| Three tiers, a trial, a certification, named integrations we do not have | Refuse: exclusions and truthfulness |

### `/app` workspace — differences found

| Difference in the reference | Judgement | Done |
| --- | --- | --- |
| The dashboard answers "what happened" first: verdict counts, then the ledger | Take it. Ours opened with a four-field test form about 500 pixels tall, which pushed the verification rate, the activity warning and the recent runs below the fold: the page answered its own question last | the form is behind a closed disclosure, one line high. The allowance cost above it and the refusal of the inference below it stay in the flow, and VERIFY-560 now fails if either moves inside |
| Evidence gates per run, as "2 of 3 gates" | Already ours: the runs table carries a REQUIRED CHECKS column reading 0/2, 1/2, 2/2 | unchanged |
| A quota allocation row with what remains | Already ours: "This period", runs used, period end, correlation property | unchanged |
| Left border accent on the payment banner | Refuse: named exclusion | our callout, ruled along the top |

### `/owner` — differences found

| Difference in the reference | Judgement | Done |
| --- | --- | --- |
| A persistent left rail listing every section, with the current one marked | Take it. Thirteen screens in a header nav ran the full width of a desktop and wrapped onto three lines on a phone | `ShellOptions.rail`, opt-in, rendered from the same nav items. Only one navigation is ever visible: the rail from 78rem, the header links below it, each `display:none` at the other width so nobody meets thirteen links twice. OWNER-924, mutation-checked |
| The current item marked by a coloured bar down its left edge | Refuse: named exclusion. Weight, full-contrast ink and a sunken ground instead, with `aria-current` carrying the same fact | |
| Tiles with an inline verdict breakdown; cost-breakdown bars; incident queue | Refuse for now: every one of those figures is invented in the reference. We would have to measure them first, and a tile that shows a number we did not measure is the fault this whole product exists to report | |
| Rounded cards, gradients, the emerald accent | Refuse: named exclusions | |

One defect found while building the rail, worth recording because it nearly shipped: the
wrapper was first called `.panel`, which is already the class on every framed section in the
panel. Declaring a two-column grid on it turned the launch-figures section into a two-column
layout with its own heading as the first column. Caught by looking at the render rather than
by a test.

### A correction the auditor asked for, and the half of it that was refused

An independent auditor read this file against the artefacts and reported the five owner rows
above as stale: renders exist for all thirteen owner screens at three widths, so "pending"
looked wrong. Half of that is right and the file was wrong.

**Taken:** the Verified column. Those screens ARE rendered through the real router and
captured at 1440, 834 and 390 with no horizontal overflow, and the Implemented column now
names what they actually received, which is the rail and the callout retoning rather than a
composition pass.

**Refused:** the auditor's conclusion that they should be marked compared. Rendering a screen
and capturing it is not comparing it with its reference. Only `/owner` has been read beside
`owner_overview_itisyou_verify`; nobody has yet put `/owner/customers` beside
`owner_customer_incident_management_itisyou_verify` and written down the differences. Marking
those rows compared would be the exact substitution this file exists to stop: evidence that a
screen exists, presented as evidence that it matches.

### The second pass: the remaining screens

Every reference below was rendered at 1440, 834 and 390 and read beside ours. Four screens
changed; the rest were compared and left alone, which is a result and is recorded as one.

| Screen | Difference | Judgement | Done |
| --- | --- | --- | --- |
| `/app/connections` | The reference lists, per provider, the exact endpoint it reads and the scopes it needs. Ours said "we only ever read" and stopped | Take it, and go further: the list is derived from the connector's own frozen operation table, so it cannot drift from what the code can do | Every call we can make, with what each is for, on the card for that provider. CONN-524 fails if an operation is added without a purpose; CONN-525 fails if anything that reads as a mutation appears |
| `/app/runs/:id` | The reference states each check once. Ours printed the same forty-word blocked-reason paragraph twice, back to back, when one outage blocked two checks | Take the principle, keep our rule: nothing moves into a disclosure, because a reader who does not open one is the reader who treats amber as a soft failure | Gaps that share a reason are named together in one line. CUST-418 and CUST-419, mutation-checked |
| `/app/usage` | Nothing structural | The page was already a meter, a result breakdown and a definition | One sentence added: a test verification costs a run and is left out of the result counts, so testing cannot move your figures. The two numbers on that page can legitimately differ and a reader should know why before they wonder |
| `/support` | The reference groups its questions and measures them. Ours ran twenty answers at the full 1140px column, about 160 characters a line | Take the measure, refuse the grouping: these twenty are already in the author's order and a reader scanning for one question does better with one column | Answers take a reading measure; questions keep the full width so the list stays scannable |
| `/how-it-works`, `/demo`, `/security`, `/development-story`, `/app/billing`, `/app/cancel`, `/app/sign-in`, `/app` mobile | Read beside their references | Nothing worth taking that the exclusions permit. The reference devices are mostly invented figures, rounded cards, gradients or integrations we do not have | unchanged |

The onboarding steps were compared last. The reference is one dense configuration screen; ours
asks one question per step behind a rail that marks where you are, which is the better shape for
a seven-step setup somebody does once, and it was left alone.

What remains uncompared: nothing. What remains unseen is the owner panel against production
data, which needs the owner to sign in.


### The owner screens, compared

| Screen | Difference in the reference | Judgement | Done |
| --- | --- | --- | --- |
| `/owner/customers` | Each tenant row carries its run allowance as a figure and a bar, so the column answers "near the limit or not" rather than "how many" | Take the figure. The denominator is the plan constant because there is one plan | The column reads 4/500, and OWNER-925 asserts that denominator against the constant, so the day a per-workspace allowance exists this column has to come from the port instead |
| `/owner/customers` | Tabs filtering by state, and a right-hand inspection panel for the selected tenant | Refuse for now. One workspace exists on this deployment: tabs over one row and an inspection panel for a selection of one are furniture rather than information | |
| `/owner/approvals`, `/owner/ads` | A budget-consumption bar and a spend breakdown | Refuse. Every figure in that part of the reference is invented; ours are real and small, and £0.00 spent does not need a bar to be understood | |
| `/owner/quality`, `/owner/cleanup` | An incident queue, a cluster topology and a worker pool | Refuse. We have no cluster, no worker pool and no incidents to queue. Drawing them would be the exact fault this product exists to report | |
| `/admin/login` | No reference published | n/a | unchanged |

## What this checklist is not

It is not a claim that any screen is finished. A row says what was compared, what was changed
and what was verified, and nothing else. Rows marked pending are pending.
