# Completion checklist — the authoritative one

Opened 21 September 2026, 16:35 UTC. This file supersedes the per-screen and launch
checklists as the single place to read status. `docs/screen-checklist.md` keeps the per-screen
comparison detail; `docs/launch-checklist.md` keeps the launch-blocker history. Neither is a
competing status list any more.

Status vocabulary, used strictly:

- **pending** — not started
- **working** — in progress right now
- **blocked** — waiting on somebody or something named
- **verified** — acceptance criteria met, evidence exists and is named
- **deployed** — verified AND serving from production at a named commit

Production and staging both serve `9563df87e6fe` as of 17:48 UTC. No percentages appear in
this file, deliberately.

## A. Visual completion

| # | Item | Owner | Acceptance criteria | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | Home page composed against its reference | coordinator | Comparison device at full width; shape blocks in the steps; no excluded device | `docs/screen-checklist.md`, sheet `home.png`, CUST-701/703 | deployed |
| A2 | Pricing compared | coordinator | Each reference device judged; refusals stated | `docs/screen-checklist.md` | deployed |
| A3 | Workspace leads with results | coordinator | Test form behind a disclosure; cost and limitation outside it | VERIFY-560 | deployed |
| A4 | Owner panel rail | coordinator | Rail at desktop, header nav below it, never both | OWNER-924 | deployed |
| A5 | Owner callout tones | coordinator | Error styling only for problems | OWNER-919..923 | deployed |
| A6 | Remaining eleven screens compared | coordinator | Each read beside its reference at three widths | `docs/screen-checklist.md` second pass | deployed |
| A7 | `/security` composed | coordinator | Mono fact bar; exhaustive call table; retention and access as one section | CUST-807; live at 38614ab5622d | deployed |
| A8 | Connections: API detail behind disclosure | coordinator | Call list present but collapsed by default | CONN-526; live at 38614ab5622d | deployed |
| A9 | Owner customers layout | coordinator | Tally strip; runs against allowance; honest empty state | OWNER-925; live at 38614ab5622d | deployed |
| A10 | Stitch: missing references generated | coordinator | Generated, or a bounded attempt recorded and the screen composed from the design system | one attempt on 21 Sept timed out with no screen created; `/security` composed from the design system instead | verified |

## A2. Motion

Requested explicitly, and absent from this file until 17:10 UTC on 21 September, which is the
gap that mattered: the motion existed and was deployed, but nothing here held it to an
acceptance criterion, so nothing would have noticed it rotting.

| # | Occasion | Acceptance criteria | Evidence | Status |
| --- | --- | --- | --- | --- |
| M1 | Content arriving | A one-shot settle on a page's own boxes, finished inside 220ms, never re-triggered by scrolling | `@keyframes enter`; RESIL-911 | deployed |
| M2 | Disclosure expanding | Opens on `grid-template-rows`, not height, so it stays off the layout path; both disclosures behave the same | RESIL-920, mutation-checked, and measured in a browser: 8.30px at 60ms into a 220ms transition, settling at 52.78px (`docs/evidence/motion-measured.txt`). Reachable signed in and on the owner panel; no public page carries a disclosure | deployed |
| M3 | A press | The control moves under the finger and the move is transitioned | `.btn:active{transform:translateY(1px)}`; RESIL-921, mutation-checked | deployed |
| M4 | Hover | Colour and background only, on navigation, buttons, fields and table rows | RESIL-921; CUST-427 for the comparator | deployed |
| M5 | A form coming back with an error | The message settles in rather than appearing between frames | `.field__error{animation:enter}`, live at c1fc3c4b5c52 | deployed |
| M6 | Waiting | The spinner runs only while `aria-busy` is genuinely true | `@keyframes spin`; RESIL-911 | deployed |
| M7 | Page to page | A root crossfade through view transitions, no JavaScript | `@view-transition`; RESIL-911 | deployed |
| M8 | Tokens, not literals | Every transition names `--dur-fast` or `--dur-base` and `--ease` | RESIL-919 | deployed |
| M9 | A verdict | Never animates, anywhere. A verdict that fades in reads as an effect rather than a finding | RESIL-922, mutation-checked | deployed |
| M10 | The development story | Promises nothing there is animated, and keeps it. Stillness scoped to that page rather than taken from the shared component | DOC-111, RESIL-922 | deployed |
| M11 | Reduced motion | Removes all of it, delay as well as duration | RESIL-918, RESIL-923, and measured: the computed duration collapses to 0.01ms and the same track is already final at 60ms | deployed |
| M12 | Dismissals | Nothing in this product is dismissible, so there is nothing to animate. Recorded rather than left looking unaddressed | no dismissible element exists | not applicable |

No new JavaScript was added for any of it. The one script the site ships is still the
nine-line theme toggle.

## B. Functional verification

| # | Item | Owner | Acceptance criteria | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | Connection test, three findings | coordinator | API access, webhook readiness and workflow verification reported separately; credential untouched | `docs/evidence/staging-verification-0d2f06c17fdb.txt` | deployed |
| B2 | Guided test verification to a settled verdict | coordinator + independent verifier | Real admission path; reaches a settled verdict; UNVERIFIED is a valid outcome; the run is nameable in the shared run list | Re-proved at the CURRENT commit: `docs/evidence/staging-verification-5b21ed2f70ab.txt`. An independent agent seeded its own session and exercised it end to end without my script: 303 to a PENDING run, settled UNVERIFIED at 17:25Z before its deadline, honest per-check CONNECTION_UNAVAILABLE lines, allowance 19 to 20, and a run id indistinguishable in shape from the other 22. Its verdict: PIPELINE REAL, yes | deployed |
| B3 | Allowance accounting | coordinator | Exactly one run consumed per test, and the charge attributable to a named run | Measured serially at the current commit: 20 to 21 with exactly one new run id, `run_01M32G2MWE20CEF724EB8C4640`. An earlier reading moved by two because a second agent was exercising the same shared synthetic workspace; proved by the third run carrying that agent's own correlation value | deployed |
| B4 | Synthetic separation | coordinator | Test runs excluded from the workspace rate and the owner total, AND a reader can tell a test run from customer traffic on the run itself | VERIFY-563 and VERIFY-566. A verifier could not tell them apart when the only marker was a field value four cards down; the run page now names it above the verdict, live and read back | deployed |
| B5 | Billing portal, fresh session per opening | coordinator | Two openings produce two different Stripe sessions | BILL-675/676; staging evidence section 5 | deployed |
| B6 | Viewer permissions | coordinator | All three actions refused at the route, naming the role | staging evidence section 6 | deployed |
| B7 | Payment alert delivery | Agent C | Test mode alerts nobody; a live checkout alerts once however many times Stripe redelivers it; a failed charge alerts once per INVOICE, so Smart Retries of the same invoice collapse into that one alert and a new failed invoice raises its own | `docs/evidence/functional-closure.txt`: both raise paths sit inside `if (event.livemode)` (`billing/events.ts:238,562`); idempotency is a UNIQUE `notification_key` claimed in `notifications/send.ts`, keyed on the checkout session id for the payment alert and on the invoice id for the failure alert; BILL-657..662 separate live from test. 9 of 9 passing. The channel is also delivering today: 19 milestone_reached rows on production, every one state=sent, latest 17:36Z, which is this afternoon release notification | verified |
| B8 | Support receipt and reply | Agent C + coordinator | Either a path exists and is evidenced, or its absence is stated plainly | same file: nothing pushes a support case anywhere, and the queue listed escalated cases only. Open cases now reach it, OWNER-926, mutation-checked, live at 38614ab5622d. Replying as support@ still needs an outbound identity (B10) | deployed, with a stated limit |
| B9 | Owner panel through real login | owner + coordinator | Owner signs in at `/admin/login` with a TOTP code; panel read against production data | Everything around it verified on production (`docs/evidence/owner-actions-readiness.txt`): one platform owner, TOTP enrolled and accepted before, 11 sign-in emails delivered with every one state=sent, the form serving 200, the panel rendering at three widths, anonymous refused. The sign-in itself has never happened and nobody may do it for the owner | blocked on the owner, one action |
| B10 | `support@itisyou.app` routing rule | owner | Rule exists in Cloudflare Email Routing; one test message received | DNS verified (MX to Cloudflare, SPF present). The rule itself cannot be read from here: an SMTP probe that offers the recipient without sending a message is refused at connection with `550 Sender IP reverse lookup rejected`, because this machine has no reverse DNS. A fact about the prober, not the rule | blocked on the owner, one dashboard check |

## C. Deployment

| # | Item | Owner | Acceptance criteria | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C1 | Release gate on the exact commit | coordinator | CI artefact matches HEAD; browser suite green | release output per commit | deployed |
| C2 | Staging first, then production | coordinator | Same artefact, staging verified before promotion | `docs/evidence/production-954a5a71750f.txt` | deployed |
| C3 | Served commit confirmed | coordinator | `/health` read independently of the release script | same file | deployed |
| C4 | Screenshots preserved durably | coordinator | Tracked copies under `docs/evidence/screenshots/` for the commit that is live | `production-9563df87e6fe/`, 39 files. Earlier commits' sets are replaced rather than accumulated, so this row always names one directory and it is the current one | deployed |
| C5 | Test sessions revoked | coordinator | `revoked_at` set; cookies answer 401 | same file, section 5 and 7 | deployed |
| C6 | This candidate (A7, A8, A9, B8) released | coordinator | Full suite, staging, production, served commit | `docs/evidence/production-38614ab5622d.txt` | deployed |
| C7 | Ads paused, live payments disabled | owner | Unchanged, and the decision document re-validated rather than assumed | `docs/live-payment-approval.md`: verdict NOT READY, 3 of 13 FAIL, structure and every drift-prone PASS row re-read against production 9563df87e6fe at 17:50Z. STRIPE_MODE is test in every environment block; production holds one subscription, none live, and zero rows of either live-payment alert | verified |

## D. Issue register

| Severity | Issue | Reproduction | Impact | Owner | Fix | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| high | Billing portal replayed a spent Stripe session | Two openings returned identical URLs on deployed staging | Customer saw "session expired" on the second click | coordinator | Unique idempotency key per opening | BILL-675 mutation-checked; two different sessions on staging |
| medium | Reduced-motion readers lost a status card | `prefers-reduced-motion`, fourth card measured opacity 0 | Content invisible to that reader | coordinator | Reset zeroes delay as well as duration | RESIL-918 mutation-checked |
| medium | Owner rail hid the header nav on every page | Desktop width, any public page | Primary navigation missing site-wide | coordinator | Rule scoped to `.has-rail` | CUST-068 in the browser suite; OWNER-924 |
| medium | An unanswered support message was invisible to the owner | Submit the support form; the case appears nowhere until somebody escalates it | A customer writes in and nobody hears | coordinator | Open cases join escalated ones in the exception queue | OWNER-926, mutation-checked |
| low | Stale capture contradicted a live feature | Auditor read a pre-deploy HTML capture | Evidence appeared to refute a true claim | coordinator | Artefact recaptured at the live commit | `docs/evidence/production-954a5a71750f.txt` section 7 |
| low | `/security` certifications line overflowed its bar | Desktop, text cut mid-word | Cosmetic, one line | coordinator | Explanation moved below the bar | A7 |

No known critical defects. Flaky or blocked checks: the production migration step has twice
failed with "Command failed" and passed unchanged on a retry; it is a no-op on both databases
and is recorded here rather than treated as green.

## D2. Independent audit of this candidate

Run on Opus, read-only, against `38614ab5622d` live. Eight areas: billing-portal freshness,
role enforcement on money, payment alerts, support visibility, synthetic separation, four
rendered screens, the live exclusions, and this file's own honesty.

Items 1 to 7 reproduced. Nothing in the security or payment paths was found wrong. Two
observations worth keeping:

- BILL-676 asserts two requests reach Stripe, which catches a LOCAL cache but not a
  Stripe-side replay. BILL-675 is the case that catches a constant key, and it is the one
  that was mutation-checked.
- The provider call table clips at 390px inside its own `.tablewrap`, which scrolls and is
  keyboard reachable (`role="region"`, `tabindex="0"`). Not a defect.

All three findings were in this file rather than in the product, and all three are fixed
above: a corrupted title line, a C4 citation pointing at a deleted directory, and B7 stating
an acceptance criterion the code deliberately does not meet. The last was the one worth
having: "failed charge alerts every time" would have been a wrong requirement to hold the
code to, and the code is right.

## E. Exactly what is needed from the owner

1. **Sign in at `https://verify.itisyou.app/admin/login`**: type the owner address, press
   "Email me a link", open it, enter the six-digit code. Then say so. Everything else about
   that path is already verified on production and recorded in
   `docs/evidence/owner-actions-readiness.txt`; the only unverified step is a person doing it,
   and nobody may seed a production session to stand in for that.
2. **Cloudflare, itisyou.app, Email, Email Routing, Routes**: confirm a rule whose custom
   address is `support@itisyou.app` and whose destination is a mailbox you read, then send one
   message to it. The rule cannot be read from here: Cloudflare refuses an SMTP probe from this
   machine at connection, before a recipient can be offered, because the connection has no
   reverse DNS.

Nothing else is waiting on the owner. Ads stay paused and live payments stay disabled.
