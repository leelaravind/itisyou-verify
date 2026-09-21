# Stitch reference inventory vs. product routes — 2026-09-21

Cross-references the product's routes against `design/stitch/INVENTORY.md` and the
folders actually present in
`design/stitch/screens/batch-02/stitch_itisyou_verify_landing_page/` (confirmed by
directory listing; batch-03 added zero new screens per its own `INDEX.md`).

Matching method: folder/title correspondence only. A route is marked matched only
when the Stitch screen's title names the same concept as the route (e.g. "Billing,
Cancellation & Support" for `/app/billing`). Where a folder is thematically close but
not confirmed — no exact naming overlap, or the task brief itself designates the route
as needing fresh generation — it is marked **NONE**, with the nearest candidate noted
for context only. No content-level (rendered) comparison was done beyond reading
`<title>` tags, which were empty/generic in several files; those matches rest on
folder-name correspondence to the 16-item list already recorded in
`design/stitch/INVENTORY.md`.

## Public

| Route | Matched Stitch folder | Notes |
| --- | --- | --- |
| `/` | `itisyou_verify_post_execution_readback_checks_for_automation_agencies` | Title confirms: "ITISYOU Verify \| Post-Execution Readback Checks for Automation Agencies" |
| `/pricing` | `pricing_policy_itisyou_verify` | Title: "Pricing & Policy" |
| `/how-it-works` | `how_it_works_demonstration_itisyou_verify` | Title: "How It Works & Demonstration" |
| `/demo` | **NONE** | Demonstration content appears folded into the how-it-works screen above; no screen dedicated to `/demo` alone |
| `/security` | **NONE** | No screen exists for this concept anywhere in batch-02. Generation target #1 |
| `/support` (public) | **NONE** | `billing_cancellation_support_itisyou_verify` covers in-app customer billing/support, not a public marketing support page — not counted as a match |
| `/status` | **NONE** | No service-status screen exists. Generation target #3 |
| `/terms` | **NONE** | No screen matches |
| `/privacy` | **NONE** | No screen matches |
| `/development-story` | **NONE** | Only the "Visual" variant exists (see next row); no plain-text development-story screen |
| `/development-story/visual` | `visual_development_story_itisyou_verify` | Title/folder name: "Visual Development Story" |

## Auth

| Route | Matched Stitch folder | Notes |
| --- | --- | --- |
| `/app/sign-in` | `sign_in_welcome_itisyou_verify` | Title: "Sign In & Welcome" (mobile variant also exists: `sign_in_welcome_mobile_itisyou_verify`) |
| `/admin/login` | **NONE** | No owner/admin sign-in screen exists. Generation target #4 |

## Customer

| Route | Matched Stitch folder | Notes |
| --- | --- | --- |
| `/app` | `customer_dashboard_itisyou_verify` | Title/folder: "Customer Dashboard" (mobile variant also exists) |
| `/app/connections` | `connections_evidence_sources_itisyou_verify` | Title: "Connections & Evidence Sources" |
| `/app/runs` (list) | **NONE** | Only a run-detail screen exists (next row); no run-list screen. Generation target #5 |
| `/app/runs/:id` | `run_details_evidence_itisyou_verify` | Title: "Run Details & Evidence" |
| `/app/usage` | **NONE** | `reports_exports_itisyou_verify` is the nearest candidate by theme but does not name "usage" specifically — not counted as a confirmed match |
| `/app/billing` | `billing_cancellation_support_itisyou_verify` | Title: "Billing, Cancellation & Support" — billing named explicitly |
| `/app/cancel` | `billing_cancellation_support_itisyou_verify` | Same folder; "Cancellation" named explicitly |
| `/app/support` (customer) | **NONE** | Per task brief this route has no reference despite the thematic overlap with the billing/support folder above; owner treats it as needing a dedicated screen. Generation target #2 |

## Onboarding

| Route | Matched Stitch folder | Notes |
| --- | --- | --- |
| `/app/onboarding/compatibility` | `compatibility_proof_checkout_review_itisyou_verify` | Title: "Compatibility Proof & Checkout Review" — "Compatibility" named |
| `/app/onboarding/connect` | **NONE** | `connections_evidence_sources_itisyou_verify` is the ongoing in-app connections screen; not confirmed as the onboarding step specifically |
| `/app/onboarding/mapping` | **NONE** | `workflow_configuration_itisyou_verify` is a plausible candidate but "mapping" is not named; not counted as a confirmed match |
| `/app/onboarding/outcome` | **NONE** | No screen names this step |
| `/app/onboarding/proof` | `compatibility_proof_checkout_review_itisyou_verify` | "Proof" named explicitly |
| `/app/onboarding/review` | `compatibility_proof_checkout_review_itisyou_verify` | "Review" named explicitly (same folder covers compatibility + proof + review as one flow) |
| `/app/onboarding/activation` | **NONE** | No screen names this step |

## Owner

| Route | Matched Stitch folder | Notes |
| --- | --- | --- |
| `/owner` | `owner_overview_itisyou_verify` | Title/folder: "Owner Overview" |
| `/owner/customers` | `owner_customer_incident_management_itisyou_verify` | Title: "Owner Customer & Incident Management" |
| `/owner/quality` | **NONE** | `automated_testing_and_cleanup_centre_itisyou_verify` is the nearest candidate but names "cleanup", not "quality" — see next row |
| `/owner/cleanup` | `automated_testing_and_cleanup_centre_itisyou_verify` | Title: "Automated Testing and Cleanup Centre" — "Cleanup" named explicitly |
| `/owner/approvals` | `owner_approvals_campaigns_and_budget_itisyou_verify_administrative_operator` | Title: "Owner Approvals, Campaigns and Budget" — "Approvals" named |
| `/owner/ads` | `owner_approvals_campaigns_and_budget_itisyou_verify_administrative_operator` | Same folder; "Campaigns and Budget" corresponds to ad-campaign management |

## Summary

- **34 routes** checked.
- **18 matched** to an existing batch-02 folder: `/`, `/pricing`, `/how-it-works`,
  `/development-story/visual`, `/app/sign-in`, `/app`, `/app/connections`,
  `/app/runs/:id`, `/app/billing`, `/app/cancel`, `/app/onboarding/compatibility`,
  `/app/onboarding/proof`, `/app/onboarding/review`, `/owner`, `/owner/customers`,
  `/owner/cleanup`, `/owner/approvals`, `/owner/ads`.
- **16 routes have NONE**: `/demo`, `/security`, `/support`, `/status`, `/terms`,
  `/privacy`, `/development-story`, `/admin/login`, `/app/runs`, `/app/usage`,
  `/app/support`, `/app/onboarding/connect`, `/app/onboarding/mapping`,
  `/app/onboarding/outcome`, `/app/onboarding/activation`, `/owner/quality`.
- Of those 16, the task brief prioritises exactly five for generation (see
  `design/stitch/screens/batch-04/INDEX.md` for outcome): `/security`,
  `/app/support`, `/status`, `/admin/login`, `/app/runs`. The remaining 11
  (`/demo`, `/support`, `/terms`, `/privacy`, `/development-story`, `/app/usage`,
  `/app/onboarding/connect`, `/app/onboarding/mapping`, `/app/onboarding/outcome`,
  `/app/onboarding/activation`, `/owner/quality`) remain unreferenced and out of
  scope for this task.
