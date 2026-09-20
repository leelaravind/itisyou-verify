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
| 7   | `customer_dashboard_itisyou_verify`                   | `/app`                                               | auth     | Composition translated (see below); copy is ours                                     |
| 8   | `customer_dashboard_mobile_itisyou_verify`            | `/app` at mobile width                               | auth     | Composition translated: count cards two abreast, run table stacks into records       |
| 9   | `connections_evidence_sources_itisyou_verify`         | `/app/connections`, `/app/onboarding/connect`        | auth     | Composition translated on both; two provider cards, not the reference's four         |
| 10  | `workflow_configuration_itisyou_verify`               | `/app/onboarding/mapping`, `/app/onboarding/outcome` | auth     | Composition translated: status tiles, rules beside timing                            |
| 11  | `compatibility_proof_checkout_review_itisyou_verify`  | `/app/onboarding/compatibility`, `/proof`, `/review` | auth     | Composition translated; the checkout control keeps its `order.ready` gate            |
| 12  | `run_details_evidence_itisyou_verify`                 | `/app/runs/:id`                                      | auth     | Composition translated: verdict band, check tally, checks beside provenance          |
| 13  | `reports_exports_itisyou_verify`                      | `/app/usage`                                         | auth     | Composition translated; no export or retention block, because we offer none          |
| 14  | `billing_cancellation_support_itisyou_verify`         | `/app/billing`, `/app/cancel`, `/app/support`        | auth     | `/app/billing` composed 7/5 with cancel and support as panes; the other two are ours |
| 15  | `owner_overview_itisyou_verify`                       | `/owner`                                             | auth     | Composition translated (see below); every figure is the port's or the word unknown   |
| 16  | `owner_approvals_campaigns_and_budget_…`              | `/owner/approvals`, `/owner/ads`                     | auth     | Palette applied; layout is ours                                                      |
| 17  | `owner_customer_incident_management_itisyou_verify`   | `/owner/customers`                                   | auth     | Palette applied; layout is ours                                                      |
| 18  | `automated_testing_and_cleanup_centre_itisyou_verify` | `/owner/quality`, `/owner/cleanup`                   | auth     | `/owner/quality` composed (see below); `/owner/cleanup` is ours                      |
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

## The authenticated screens, composed (20 September 2026, later the same day)

Rows 7–14 were recomposed as _translation_: the reference's arrangement, none of its words.
Every figure on those screens is read from the customer port and every sentence comes from an
existing route or `packages/ui/src/content/`. Pinned by `CUST-901..CUST-908` in
`tests/unit/ui/customer-composition.test.ts`, which also asserts that no reference phrase, no
second price, no trial and no seat term reached any of the ten pages.

| Route                                     | Reference folder                                     | What was taken from the reference                                                                                                                      | What was not, and why                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/app`                                    | `customer_dashboard_…` and `…_mobile_…`              | Head beside a mono fact bar; four run-count cards in one row (2×2 on a phone); period figures as a metrics bar; framed run ledger with a tally under it | The payment-paused banner, the £89 renewal, the 1,904/5,000 quota, the "proof chain" and "forensic diff" blocks — none of those facts exist here         |
| `/app/connections`                        | `connections_evidence_sources_…`                     | Notice above the cards; one card per provider in a row, facts in a sunken pane, state tally beside the head                                            | Four providers (we have two), the encryption architecture panel, the "isolation protocol" copy                                                            |
| `/app/onboarding/mapping`, `/outcome`     | `workflow_configuration_…`                           | Four status tiles above the rules; the rule in the wider column with its facts beside it; checks beside timing                                         | The operator grammar, the settling-window slider, the per-rule weight column, the £0.14 cost tile                                                         |
| `/app/onboarding/proof`, `/review`        | `compatibility_proof_checkout_review_…`              | Proof verdict beside its checks; disclosure in the wider column, order summary and control in the narrower one                                          | The £120 + VAT total, the 10,000-run allowance, the "unconditional refund" copy, the card-on-file block                                                   |
| `/app/runs/:id`                           | `run_details_evidence_…`                             | Head beside a mono bar; verdict band ruled in the verdict's colour with the check tally beside it and identifiers under it; checks 7 / provenance 5   | The four status tiles (a FAILED tile on an UNVERIFIED run's page would dress it as a failure — CUST-063), the raw-body inspector, the "audit guarantee" |
| `/app/usage`                              | `reports_exports_…`                                  | Period facts as a mono bar; the meter in the wider column; four count cards under it                                                                    | Export formats, the export ledger, the 365-day retention tiles — we offer none of those                                                                   |
| `/app/billing`                            | `billing_cancellation_support_…`                     | Subscription and plan 7 / portal control 5; cancellation and support as two panes leading to their own pages                                            | The invoice table, the VAT registration, the card on file, the support form inline (it stays on `/app/support`)                                           |

Screenshots of the served pages at 390, 820 and 1440px are under `docs/screenshots/stitch/`.
They were made by rendering each screen to static HTML through the real Worker
(`tests/integration/customer/screens-dump.test.ts`) and loading that file in Playwright's
bundled Chromium with the viewport set to exactly each width; the script reads
`window.innerWidth` back and refuses to write a file whose width is not the one asked for.

### The two onboarding steps, composed (20 September 2026, later still)

The first two setup steps were recomposed the same way — the reference's arrangement, none
of its words — and pinned by `CUST-951..CUST-953` in
`tests/unit/ui/onboarding-composition.test.ts`, which also assert that every paste form
still posts to the same action with the same token and hidden provider, that the
permission notice still precedes the paste box, that the compatibility control is still
the inert element and not a button, and that no reference phrase and no pound figure at
all reached either page (neither states a price; the one real price is on `/review`).

The mapping had no row of its own for `/app/onboarding/connect`. It was composed against
row 9, `connections_evidence_sources_…`, because that is the one approved screen that
draws a credential paste flow — a key box under each provider's readback facts, a primary
control under the box, a count of connections by state along the bottom — and it is the
same reference `/app/connections` is composed against, so the two pages now draw the same
card the same way.

| Route                           | Reference folder                        | What was taken from the reference                                                                                                                                                                                                        | What was not, and why                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/app/onboarding/connect`       | `connections_evidence_sources_…`        | The notice above the cards; one card per provider side by side from desktop width (stacked on a tablet, because each card carries a form); in each card the readback facts in a sunken pane under the head, then the permission statement, then the paste box and its control; a closing band with the count of connections by state on the left and the way onward on the right | Four providers (we have two); the head's "sandbox environment" and "refresh all probes" tiles (no such fact, no such action); the "isolation protocol architecture" panel and its four-stage envelope row; the audit-ledger link. Our cards run far taller than the reference's, because they carry the full permission notice, the numbered setup steps and the two boundary lists — none of those words were cut for the layout |
| `/app/onboarding/compatibility` | `compatibility_proof_checkout_review_…` | Head beside a count of providers by the label each card wears; the provider cards stacked in the wider column, each with its facts in a sunken pane; the commitment and the (inert) control in the narrower one, seven parts to five, read after every card in document order | The four-status legend strip (this step's badges are two of the four; the four tiles live on `/outcome`); the second pane per card and the payload blocks (probe results, which do not exist before anything is connected); the "overall assessment" card; the commercial column's £120, VAT line, £144 total and card on file (not our price; the one real price is on `/review`); the seven-day policy card and its three metric tiles (the disclosure is on `/review`) |

Screenshots: `app-onboarding-connect-{390,820,1440}.png` and
`app-onboarding-compatibility-{390,820,1440}.png` (re-captured), by the same method.

## The owner screens, composed (20 September 2026, later still)

Rows 15 and 18 were recomposed the same way — the reference's arrangement, none of its
words. The owner references are an operator console: a fixed side navigation, a strip of
status tiles, a row of KPI cards, a wide cost breakdown beside a narrow "contingency
reserve", and an incident table; the test centre has a row of six counts by state, a wide
matrix beside a narrow integrity card, a reports table and a cleanup section. Pinned by
`OWNER-901..OWNER-907` in `tests/unit/ui/owner-composition.test.ts` and
`tests/integration/owner/launch-figures.test.ts`, which also assert that no reference phrase
and no pound figure other than the finance summary's own reached either page, and that both
pages are still a byte-identical 404 for an anonymous request.

| Route            | Reference folder                                 | What was taken from the reference                                                                                                                                                                   | What was not, and why                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/owner`         | `owner_overview_itisyou_verify`                  | Head beside a mono bar of the page's own facts; the launch figures as one strip of tiles (eight, four across); the money table 7 / customers and approvals 5; service health as a framed table with a four-state tally under it | The side navigation (shared chrome, not this screen's), the "operating cost breakdown" and "contingency reserve", the incident queue, every invented figure (42 accounts, £3,738, £6,500, 14,892 runs) and the "enclave" vocabulary |
| `/owner/quality` | `automated_testing_and_cleanup_centre_…`         | Head beside a mono bar; a strip of counts by state above the form, one entry per state that occurred; the suite form 7 / evidence pack 5; the runs as a framed table with a tally under it          | The cleanup half (served at `/owner/cleanup`, not recomposed), the pinned-commit "record" bar, the 1,482-case estate, the SHA-256 manifests and the signed exports — none of those facts exist here                             |

Two things on `/owner` are new rather than rearranged, and both are read from the port.
A **paid orders** tile counts the orders the port's ledger records as `active` or
`refunded`; the ledger does not record whether a payment was live or sandbox, and the tile
says so rather than calling itself either. A **cash received** tile renders
`finance.cashRevenueMinor` through `displayMinor`, so a ledger holding zero pence reads
`£0.00` and a ledger the port could not read reads `unknown` — the same rule as every other
figure on the page. The external-visit figure is the D1 port's own query, which counts
`visit_sessions` rows whose `classification = 'external'` and nothing else. When the
overview read itself throws, the page renders every figure as `unknown` instead of a 500.

Screenshots: `owner-{390,820,1440}.png` (in-memory port, every launch figure honestly
unknown), `owner-known-{390,820,1440}.png` (a port answering every read, so the tiles can
be seen carrying figures) and `owner-quality-{390,820,1440}.png`, made by
`tests/integration/owner/screens-dump.test.ts` and the same Playwright method as above.

## The design figure, reconciled (20 September 2026)

`packages/ui/src/designProgress.ts` was reconciled by opening each served screenshot at
1440px beside its reference `screen.png`. The public screens were re-captured for this
(`home`, `pricing`, `how-it-works`, `demo` under `docs/screenshots/stitch/`), because the
captures under `docs/screenshots/` predate the public composition pass. At that
reconciliation the list read **13 of 19 composed**. Two labels were corrected to routes the
Worker serves (`/app/onboarding` → `/app/onboarding/compatibility`,
`/app/onboarding/workflow` → `/app/onboarding/outcome`), and `/security` — previously
counted — is no longer, because no approved screen exists for that route and a layout cannot
be composed against a reference that does not exist. The six not composed at that point:
`/security`, `/app/onboarding/compatibility` (its cards took the reference's panes and
nothing else), `/app/onboarding/connect`, `/admin/login`, `/support` (no reference for
either) and `/development-story/visual`. The earlier figure of 5 of 19 was reported to the
owner and is left named here.

Later the same day `/app/onboarding/compatibility` and `/app/onboarding/connect` were
composed (the section above) and flipped after the same comparison, so the list now reads
**15 of 19 composed**, which `designProgress()` reports as 78% — rounded down from 78.9.
The four not composed: `/security`, `/admin/login` and `/support`, for which no approved
screen exists, and `/development-story/visual`, which has a reference and is not built.
Nothing was composed for `/support`: the instruction was to stop rather than invent a
reference for it, and this document is where that is recorded.

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
