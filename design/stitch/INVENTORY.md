# Stitch export inventory

Generated 19 September 2026 from Stitch project `12603262649263949929`.

## What was exported, and how

Two downloads, both validated before extraction (see `EXPORT-CAPABILITY.md` for the
capability check):

| Archive | Size | Entries | Extracted to |
| --- | --- | --- | --- |
| `stitch_itisyou_verify_landing_page.zip` | 394 KB | 9 | `screens/batch-01/` |
| `stitch_batch_02_all_screens.zip` | 9.66 MB | 67 | `screens/batch-02/` |

Both passed the same checks: valid end-of-central-directory record, every entry's
declared size read back, **zero** path-traversal (`..`) or absolute-path entries.
Batch 02 supersedes batch 01 and contains everything in it.

## The 16 required screens — all present

Every screen the owner specified exists in `screens/batch-02/stitch_itisyou_verify_landing_page/`.

| # | Required screen | Exported folder |
| --- | --- | --- |
| 1 | Landing page | `itisyou_verify_post_execution_readback_checks_for_automation_agencies` |
| 2 | How it works and demonstration | `how_it_works_demonstration_itisyou_verify` |
| 3 | Pricing | `pricing_policy_itisyou_verify` |
| 4 | Sign-in and welcome | `sign_in_welcome_itisyou_verify` (+ `_mobile_`) |
| 5 | Connection setup | `connections_evidence_sources_itisyou_verify` |
| 6 | Workflow configuration | `workflow_configuration_itisyou_verify` |
| 7 | Compatibility proof and checkout review | `compatibility_proof_checkout_review_itisyou_verify` |
| 8 | Customer dashboard | `customer_dashboard_itisyou_verify` (+ `_mobile_`) |
| 9 | Run details and evidence | `run_details_evidence_itisyou_verify` |
| 10 | Reports and exports | `reports_exports_itisyou_verify` |
| 11 | Billing, cancellation and support | `billing_cancellation_support_itisyou_verify` |
| 12 | Owner overview | `owner_overview_itisyou_verify` |
| 13 | Owner customer and incident management | `owner_customer_incident_management_itisyou_verify` |
| 14 | Owner approvals, campaigns and budget | `owner_approvals_campaigns_and_budget_itisyou_verify_administrative_operator` |
| 15 | Automated testing and cleanup centre | `automated_testing_and_cleanup_centre_itisyou_verify` |
| 16 | Visual development story | `visual_development_story_itisyou_verify` |

Plus two extras that are not among the sixteen and are kept only as reference:
`itisyou_verify_logo` and `itisyou_verify_ground_truth_automation_verification_for_agencies`
(the first, superseded landing page).

Three design systems were generated rather than one: `synthetic_ground_truth`,
`empirical_verification_system`, `forensic_verification_engine`. The palette decision
between them is recorded in `design/MAPPING.md`.

## The finding that matters most

**Correcting a generative design tool does not retroactively clean what it already
produced, and it does not reliably stop it reproducing the same thing.**

Halfway through generation I gave Stitch an explicit, itemised instruction to remove
every absolutist and unearned claim, and it visibly adopted the rule — its own agent
log restated the standing rules back verbatim, and later screens do carry more careful
language. A scan of the finished export shows what that was actually worth:

| Banned phrase | Files still containing it (of 20 screens) |
| --- | --- |
| `ZERO-TRUST` | 13 |
| `SOC2` | 6 |
| `VERIFIED REALITY` | 4 |
| `Zapier` (named competitor) | 4 |
| `PHANTOM 200` | 3 |
| `ISO 27001` | 2 |
| `AUTO-REMEDIAT` | 2 |
| `Make.com` (named competitor) | 2 |
| `PyPI` (unclaimed package name) | 2 |
| `self-healing` | 1 |
| `Deterministic Verification Guaranteed` | 1 |

Two of those are false statements about regulated attestations this business does not
hold. Two more name real competitors. Three describe a product that observes and reports
as one that repairs things, which the frozen contract forbids and which cannot become
true under the current design.

This is the whole justification for the owner's standing rule that generated output must
never overwrite application code. The visual system is worth having. The words are not
evidence of anything, and a design tool has no way to know which of its confident
sentences are true.

## What happens to this material

- **Taken:** the visual language, the layout structure, the state coverage, and three
  specific tokens identified in `design/MAPPING.md`.
- **Rejected:** all generated copy, every claim, every figure, every badge. Replacement
  wording is written by hand and each claim is checked against the implementation.
- **Enforced:** `scripts/scan-claims.mjs` fails the release gate if any phrase in this
  table reaches tracked application source. A rule that depends on remembering is not a
  rule.
