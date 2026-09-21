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
| `/` home | `itisyou_verify_post_execution_readback_checks_for_automation_agencies` | yes | yes — see below | yes | pending |
| `/pricing` | `pricing_policy_itisyou_verify` | pending | — | — | pending |
| `/how-it-works` | `how_it_works_demonstration_itisyou_verify` | pending | — | — | pending |
| `/demo` | `run_details_evidence_itisyou_verify` | pending | — | — | pending |
| `/security` | none published | n/a | — | — | pending |
| `/support` | `billing_cancellation_support_itisyou_verify` (part) | pending | — | — | pending |
| `/terms`, `/privacy`, `/refunds` | none | n/a | — | — | pending |
| `/development-story` | `visual_development_story_itisyou_verify` | pending | — | — | pending |

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
| `/app` workspace | `customer_dashboard_itisyou_verify` | pending | — | — | pending |
| `/app` mobile | `customer_dashboard_mobile_itisyou_verify` | pending | — | — | pending |
| `/app/connections` | `connections_evidence_sources_itisyou_verify` | pending | — | — | pending |
| `/app/runs`, `/app/runs/:id` | `run_details_evidence_itisyou_verify` | pending | — | — | pending |
| `/app/usage` | `reports_exports_itisyou_verify` | pending | — | — | pending |
| `/app/billing`, `/app/cancel` | `billing_cancellation_support_itisyou_verify` | pending | — | — | pending |
| `/app/sign-in` | `sign_in_welcome_itisyou_verify` (+ mobile) | pending | — | — | pending |
| onboarding steps | `workflow_configuration_itisyou_verify`, `compatibility_proof_checkout_review_itisyou_verify` | pending | — | — | pending |

## Owner screens

| Screen | Reference | Compared | Implemented | Verified | Auditor |
| --- | --- | --- | --- | --- | --- |
| `/owner` overview | `owner_overview_itisyou_verify` | pending | — | — | pending |
| `/owner/customers` | `owner_customer_incident_management_itisyou_verify` | pending | — | — | pending |
| `/owner/approvals`, `/owner/ads` | `owner_approvals_campaigns_and_budget_...` | pending | — | — | pending |
| `/owner/quality`, `/owner/cleanup` | `automated_testing_and_cleanup_centre_itisyou_verify` | pending | — | — | pending |
| `/owner/operations`, `/owner/controls`, `/owner/settings`, `/owner/connections`, `/owner/verification` | none published | n/a | recomposed 21 Sept (tones, notices, freshness) | yes, 13 screens at three widths | pending |
| `/admin/login` | none published | n/a | — | — | pending |

## What this checklist is not

It is not a claim that any screen is finished. A row says what was compared, what was changed
and what was verified, and nothing else. Rows marked pending are pending.
