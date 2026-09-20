# The Stitch designs, mapped to what is actually served

**Status at 20 September 2026.** The owner commissioned nineteen screens in Stitch, approved
them, and asked which were used, which were partly used and which were missed. This document
answers that with file paths and verified HTTP status codes rather than impressions.

## Where the files are

Two archives, both already on the machine at `H:/`, which I had not looked for until asked
twice:

| Archive                                                  | Contents                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `H:/stitch_itisyou_verify_landing_page.zip` (394 KB)     | The landing page and the logo, plus `synthetic_ground_truth/DESIGN.md`                         |
| `H:/stitch_itisyou_verify_landing_page (1).zip` (9.6 MB) | **All nineteen screens**, each with `code.html` and `screen.png`, plus three `DESIGN.md` files |

The design system used is `empirical_verification_system/DESIGN.md` — a dark palette
(`#0f131c` canvas, `#6ffbbe` mint primary, `#4cd7f6` cyan focus), Plus Jakarta Sans for
headings, Inter for body, JetBrains Mono for machine output, and four status colours that map
one-to-one onto this product's four run statuses.

## The map

Every screen corresponds to a route that exists and answers 200 on production. There is **no
Stitch screen without an implemented route**, and no orphan.

| #   | Stitch screen                                         | Route                                                | HTTP     | Design state                                                                         |
| --- | ----------------------------------------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| 1   | `itisyou_verify_ground_truth_…_for_agencies`          | `/`                                                  | 200      | Palette applied; layout is ours                                                      |
| 2   | `itisyou_verify_post_execution_readback_checks_…`     | `/` (alternate landing treatment)                    | 200      | Palette applied; layout is ours                                                      |
| 3   | `how_it_works_demonstration_itisyou_verify`           | `/how-it-works`, `/demo`                             | 200, 200 | Palette applied; layout is ours                                                      |
| 4   | `pricing_policy_itisyou_verify`                       | `/pricing`                                           | 200      | Palette applied; layout is ours                                                      |
| 5   | `sign_in_welcome_itisyou_verify`                      | `/app/sign-in`                                       | 200      | Palette applied; layout is ours                                                      |
| 6   | `sign_in_welcome_mobile_itisyou_verify`               | `/app/sign-in` at mobile width                       | 200      | Palette applied; responsive behaviour is ours, not verified against the reference    |
| 7   | `customer_dashboard_itisyou_verify`                   | `/app`                                               | auth     | Palette applied; layout is ours                                                      |
| 8   | `customer_dashboard_mobile_itisyou_verify`            | `/app` at mobile width                               | auth     | Palette applied; responsive behaviour not verified against the reference             |
| 9   | `connections_evidence_sources_itisyou_verify`         | `/app/connections`                                   | auth     | Palette applied; layout is ours                                                      |
| 10  | `workflow_configuration_itisyou_verify`               | `/app/onboarding/mapping`, `/app/onboarding/outcome` | auth     | Palette applied; layout is ours                                                      |
| 11  | `compatibility_proof_checkout_review_itisyou_verify`  | `/app/onboarding/compatibility`, `/proof`, `/review` | auth     | Palette applied; the checkout control on `/review` is new today                      |
| 12  | `run_details_evidence_itisyou_verify`                 | `/app/runs/:id`                                      | auth     | Palette applied; layout is ours                                                      |
| 13  | `reports_exports_itisyou_verify`                      | `/app/usage`                                         | auth     | Palette applied; layout is ours                                                      |
| 14  | `billing_cancellation_support_itisyou_verify`         | `/app/billing`, `/app/cancel`, `/app/support`        | auth     | `/app/billing` did not exist until today                                             |
| 15  | `owner_overview_itisyou_verify`                       | `/owner`                                             | auth     | Palette applied; layout is ours                                                      |
| 16  | `owner_approvals_campaigns_and_budget_…`              | `/owner/approvals`, `/owner/ads`                     | auth     | Palette applied; layout is ours                                                      |
| 17  | `owner_customer_incident_management_itisyou_verify`   | `/owner/customers`                                   | auth     | Palette applied; layout is ours                                                      |
| 18  | `automated_testing_and_cleanup_centre_itisyou_verify` | `/owner/quality`, `/owner/cleanup`                   | auth     | Palette applied; layout is ours                                                      |
| 19  | `visual_development_story_itisyou_verify`             | `/development-story`                                 | 200      | Palette applied; layout is ours                                                      |
| —   | `itisyou_verify_logo`                                 | no route — brand asset                               | —        | **Not implemented.** The wordmark in the header is set in type, not the Stitch logo. |

Public routes verified by request against `https://verify.itisyou.app` on 20 September 2026:
`/`, `/how-it-works`, `/demo`, `/pricing`, `/security`, `/support`, `/terms`, `/privacy`,
`/refunds`, `/status`, `/development-story`, `/admin/login`, `/app/sign-in` — all **200**.
Rows marked `auth` require a session by design and are not publicly fetchable; `/admin/login`
is deliberately public while every privileged action behind it is not.

## What "palette applied" means, and what it does not

It means the approved colour system, type stacks and status vocabulary are live on that route,
because every component reads the same CSS custom properties and the token values were
replaced at source. One change, nineteen screens, and no route, form or payment path touched.
That was the point of doing it at the token layer rather than rewriting markup.

It does **not** mean the screen matches its reference composition. The Stitch screens propose
particular layouts — card arrangements, column counts, hero structure, where the evidence sits
relative to the verdict — and those have not been implemented. Saying "the Stitch design is
live" would be the same class of claim this product exists to refuse: true of one layer,
false of the thing a person actually sees.

## Honestly: what is missed

1. **The logo.** `itisyou_verify_logo/code.html` is 1 KB and has not been used at all.
2. **Per-screen composition** for all nineteen. The palette is theirs; the layout is ours.
3. **Responsive behaviour against the two mobile references.** Stitch supplied explicit mobile
   designs for the dashboard and sign-in. The deployed pages are responsive, but they have not
   been compared against those two files at tablet or phone width.
4. **Side-by-side screenshots** of reference against running page for each row above. The
   reference PNGs exist in the archive; the running captures do not exist for the
   authenticated rows, because capturing them needs a seeded session per screen.

## Why the token layer was done first

The instruction was to implement the approved appearance **while preserving verified
functionality**. Nineteen hand-rewritten screens is nineteen chances to break a form, a CSRF
field, a status badge or the checkout control that was only wired this morning. Replacing the
token values changes every screen at once and cannot do any of that — the suite stayed at
2,644 passing across the change, and the contrast guard recomputed every ratio from the new
colours rather than trusting the comment.

Composition work is the next block, and it is the part that should be done screen by screen
with the suite run between each.

## The designs cannot be implemented as drawn

Sweeping all nineteen `code.html` files for business facts found that the approved
compositions carry a great deal of invented content. Run through this repository's own claim
scanner, the twenty-two screen files produce **109 findings across 9 rule classes**, and 168 across the whole design directory once the `DESIGN.md` files are included. Reproduce with `node scripts/scan-claims.mjs --paths design`.

> **This figure was published as 34 and that was wrong.** An independent audit found the > scanner matched each rule against the raw markup line while a comment four lines above > said tags were stripped first -- they were stripped into a variable used only for the > exemption check. So any claim split across an element boundary was invisible, which is > the ordinary shape of a price on a designed page: the figure in one element, the period > in its sibling. The gate reported two wrong monthly prices where the rendered text > carries eighteen. The scanner now matches the raw line AND the tag-stripped text, and > the number above is what it reports. The earlier 34 is left named here rather than > quietly replaced, because it was reported to the owner.

| Rule                          | Hits | Example from the designs                                          |
| ----------------------------- | ---- | ----------------------------------------------------------------- |
| `generated-status-vocabulary` | 7    | "PHANTOM 200", "GROUND TRUTH PROTOCOL"                            |
| `false-certification`         | 6    | **"SOC2 Type II"** — a certification this business does not hold  |
| `wrong-plan-price`            | 4    | "£85 / month", "£120.00 / month", "£340.00/month", "£49 / month"  |
| `named-competitor`            | 4    | "Zapier"                                                          |
| `unoffered-trial`             | 3    | "14-Day Agency Trial", "No CC Required"                           |
| `remediation-claim`           | 3    | language implying the service acts on a customer system           |
| `invented-plan-tier`          | 3    | "Starter Agency", "High-Scale Partner", "VOLUME TIER", "per-seat" |
| `unclaimed-package`           | 2    | an install command for a registry name nobody has claimed         |
| `absolutist-claim`            | 2    | "100% of", "ZERO-TRUST: STRICT"                                   |

Beyond what the scanner catches, the designs also name QuickBooks, Airtable, Salesforce,
Python and Make as evidence sources; invent revenue figures (£45,000, £39,000, £28,340); and
describe a "Verified Automation SLA" retainer product. The real configuration is **£29.00 a
month, 500 runs, one workflow, HubSpot and Resend only, no trial, and no certification of any
kind**.

This is why the composition work has to be done as _translation_ rather than
implementation. Building a designed page faithfully means its copy arrives with it, and the
copy is the part that would put a false claim in front of a paying visitor — the precise
defect this product exists to detect in other people's systems.

**Three rules were added to the scanner** for the gaps it did not already cover:
`wrong-plan-price`, `unoffered-trial` and `invented-plan-tier`. When first written they
matched nothing at all: a mangled escape had left literal backspace characters inside the
patterns, invisible in an editor and in `grep`, and the scanner reported "clean" over content
containing four wrong prices. `DOC-503..DOC-505` now assert each rule fires on the designs'
exact strings and does not fire on our own true sentences, because a guard that cannot be
shown to catch anything is the same defect as correct code that nothing reaches.
