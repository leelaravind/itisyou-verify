# batch-03 — retrieval index

Retrieved 2026-09-21 by the session running task R10 ("Stitch batch-03 retrieval").

## Source

- `mcp__stitch__get_project` on `projects/12603262649263949929` ("ITISYOU Verify Landing
  Page"). Project `updateTime`: `2026-09-21T08:21:31.281272Z`. `screenInstances`: **23**
  (20 screens + 3 `DESIGN_SYSTEM_INSTANCE` design-system assets).
- `mcp__stitch__list_screens` on `projectId` `12603262649263949929`, which returned the
  20 non-design-system screens with their `htmlCode`/`screenshot` download URLs, titles
  and device types. Neither call exposes a per-screen `updateTime` — only the
  project-level one above is available, so that is what is recorded below; no
  per-screen timestamp was invented.

## Result: nothing new to export

All 20 screens currently in the Stitch project match, one-to-one by title, a folder
already present in `design/stitch/screens/batch-02/stitch_itisyou_verify_landing_page/`
(recorded in `design/stitch/INVENTORY.md`). The 3 design-system assets in the project
likewise correspond to the 3 `DESIGN.md` folders already exported in batch-02
(`synthetic_ground_truth`, `empirical_verification_system`, `forensic_verification_engine`).

**Screens listed in Stitch: 20. Already on disk: 20. Newly exported to batch-03: 0.**

No `mcp__stitch__get_screen` calls were made, because there was no screen to fetch that
batch-02 does not already hold — calling it for already-exported screens would only
duplicate what is on disk and risk overwriting the curated batch-02 copy, which this
task is not authorized to touch.

## Screen-by-screen diff

| # | Stitch screen id | Title | Device | Already exported as (batch-02) | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `3ddd56e1db044eaa8f7bb64c7f74c18c` | ITISYOU Verify - Post-Execution Readback Checks for Automation Agencies | DESKTOP | `itisyou_verify_post_execution_readback_checks_for_automation_agencies/code.html` | already exported, skipped |
| 2 | `13d2a919964b4fe6a19fb48ffb815ac8` | How It Works & Demonstration - ITISYOU Verify | DESKTOP | `how_it_works_demonstration_itisyou_verify/code.html` | already exported, skipped |
| 3 | `037621964d1e4fc79ec445fb08d8a980` | Pricing & Policy - ITISYOU Verify | DESKTOP | `pricing_policy_itisyou_verify/code.html` | already exported, skipped |
| 4 | `e4f2627e003a45c58a8074ae2aa3d396` | Sign In & Welcome - ITISYOU Verify | DESKTOP | `sign_in_welcome_itisyou_verify/code.html` | already exported, skipped |
| 5 | `23fa06129512448eae431f24be988a0f` | Sign In & Welcome (Mobile) - ITISYOU Verify | MOBILE | `sign_in_welcome_mobile_itisyou_verify/code.html` | already exported, skipped |
| 6 | `fa962721b8d14c549931b15ea203dd59` | Connections & Evidence Sources - ITISYOU Verify | DESKTOP | `connections_evidence_sources_itisyou_verify/code.html` | already exported, skipped |
| 7 | `8730de445859494f8139a7f2b90eb916` | Workflow Configuration - ITISYOU Verify | DESKTOP | `workflow_configuration_itisyou_verify/code.html` | already exported, skipped |
| 8 | `3c508285294f4b73ac78e66fc86d3744` | Compatibility Proof & Checkout Review - ITISYOU Verify | DESKTOP | `compatibility_proof_checkout_review_itisyou_verify/code.html` | already exported, skipped |
| 9 | `d497484045bc4a7d8e9307dd19ef5317` | Customer Dashboard - ITISYOU Verify | DESKTOP | `customer_dashboard_itisyou_verify/code.html` | already exported, skipped |
| 10 | `00840f75656d4ceabb27d14105310fd1` | Customer Dashboard (Mobile) - ITISYOU Verify | MOBILE | `customer_dashboard_mobile_itisyou_verify/code.html` | already exported, skipped |
| 11 | `4be2b76958424e5b9d947942f96f138e` | Run Details & Evidence - ITISYOU Verify | DESKTOP | `run_details_evidence_itisyou_verify/code.html` | already exported, skipped |
| 12 | `25f2062bab6d4465adce2d90519abe7c` | Reports & Exports - ITISYOU Verify | DESKTOP | `reports_exports_itisyou_verify/code.html` | already exported, skipped |
| 13 | `18bc1eb95765485185301b3485d7e2a3` | Billing, Cancellation & Support - ITISYOU Verify | DESKTOP | `billing_cancellation_support_itisyou_verify/code.html` | already exported, skipped |
| 14 | `a013701e6a7f4a6ab0756ec291431841` | Owner Overview - ITISYOU Verify | DESKTOP | `owner_overview_itisyou_verify/code.html` | already exported, skipped |
| 15 | `b0ca1c6d465c402087ad0cd3e85a4254` | Owner Customer & Incident Management - ITISYOU Verify | DESKTOP | `owner_customer_incident_management_itisyou_verify/code.html` | already exported, skipped |
| 16 | `ab75aa26904d4d04a96110c4ebf2a483` | Owner Approvals, Campaigns and Budget - ITISYOU Verify Administrative Operator | DESKTOP | `owner_approvals_campaigns_and_budget_itisyou_verify_administrative_operator/code.html` | already exported, skipped |
| 17 | `86cb4048fede4cb9bf36c2cea773a517` | Automated Testing and Cleanup Centre - ITISYOU Verify | DESKTOP | `automated_testing_and_cleanup_centre_itisyou_verify/code.html` | already exported, skipped |
| 18 | `b251effa741847f39b8848d50a6f2fc6` | Visual Development Story - ITISYOU Verify | DESKTOP | `visual_development_story_itisyou_verify/code.html` | already exported, skipped |
| 19 | `71d2a2af2a2743aea65aabc7879dc279` | ITISYOU Verify - Ground Truth Automation Verification for Agencies | DESKTOP | `itisyou_verify_ground_truth_automation_verification_for_agencies/code.html` | already exported, skipped |
| 20 | `8dee142d554f497da5d9f79732b069d4` | ITISYOU Verify Logo | (SVG, no deviceType reported) | `itisyou_verify_logo/code.html` | already exported, skipped |

## Design-system assets (not screens)

| Stitch asset id | Matched batch-02 folder | Status |
| --- | --- | --- |
| `assets_05af2644fde04804842a60f2d03bf75c` | one of `synthetic_ground_truth` / `empirical_verification_system` / `forensic_verification_engine` | already exported, skipped |
| `assets_9b22a442549347ceac26eed917014d66` | one of `synthetic_ground_truth` / `empirical_verification_system` / `forensic_verification_engine` | already exported, skipped |
| `assets_9dae3d6b3a684f559bbf1c787bde5428` | one of `synthetic_ground_truth` / `empirical_verification_system` / `forensic_verification_engine` | already exported, skipped |

Which project asset id corresponds to which named batch-02 design-system folder was not
resolved (would need a design-system-specific MCP call out of scope for this retrieval);
all three are accounted for by count (3 project assets = 3 batch-02 `DESIGN.md` folders),
which is the fact this table records.

## Files written by this retrieval

None under `screens/`. This `INDEX.md` and the `README.md` update in the same directory
are the only files this task produced.
