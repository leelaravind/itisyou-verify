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

Production and staging both serve `38614ab5622d` as of 16:48 UTC. No percentages appear in
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

## B. Functional verification

| # | Item | Owner | Acceptance criteria | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | Connection test, three findings | coordinator | API access, webhook readiness and workflow verification reported separately; credential untouched | `docs/evidence/staging-verification-0d2f06c17fdb.txt` | deployed |
| B2 | Guided test verification to a settled verdict | coordinator | Real admission path; settles; UNVERIFIED is a valid outcome | same file, section 3 | deployed |
| B3 | Allowance accounting | coordinator | Exactly one run consumed per test | same file, section 4 (15 to 16, then 16 to 17) | deployed |
| B4 | Synthetic separation | coordinator | Test runs excluded from the workspace rate and the owner total | VERIFY-563; `/app/usage` states it | deployed |
| B5 | Billing portal, fresh session per opening | coordinator | Two openings produce two different Stripe sessions | BILL-675/676; staging evidence section 5 | deployed |
| B6 | Viewer permissions | coordinator | All three actions refused at the route, naming the role | staging evidence section 6 | deployed |
| B7 | Payment alert delivery | Agent C | Test mode alerts nobody; a live checkout alerts once however many times Stripe redelivers it; a failed charge alerts once per INVOICE, so Smart Retries of the same invoice collapse into that one alert and a new failed invoice raises its own | `docs/evidence/functional-closure.txt`: both raise paths sit inside `if (event.livemode)` (`billing/events.ts:238,562`); idempotency is a UNIQUE `notification_key` claimed in `notifications/send.ts`, keyed on the checkout session id for the payment alert and on the invoice id for the failure alert; BILL-657..662 separate live from test. 9 of 9 passing | verified |
| B8 | Support receipt and reply | Agent C + coordinator | Either a path exists and is evidenced, or its absence is stated plainly | same file: nothing pushes a support case anywhere, and the queue listed escalated cases only. Open cases now reach it, OWNER-926, mutation-checked, live at 38614ab5622d. Replying as support@ still needs an outbound identity (B10) | deployed, with a stated limit |
| B9 | Owner panel through real login | owner + coordinator | Owner signs in at `/admin/login` with a TOTP code; panel read against production data | none yet | blocked on the owner |
| B10 | `support@itisyou.app` routing rule | owner | Rule exists in Cloudflare Email Routing; one test message received | none yet | blocked on the owner |

## C. Deployment

| # | Item | Owner | Acceptance criteria | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C1 | Release gate on the exact commit | coordinator | CI artefact matches HEAD; browser suite green | release output per commit | deployed |
| C2 | Staging first, then production | coordinator | Same artefact, staging verified before promotion | `docs/evidence/production-954a5a71750f.txt` | deployed |
| C3 | Served commit confirmed | coordinator | `/health` read independently of the release script | same file | deployed |
| C4 | Screenshots preserved durably | coordinator | Tracked copies under `docs/evidence/screenshots/` for the commit that is live | `production-38614ab5622d/`, 39 files. Earlier commits' sets are replaced rather than accumulated, so this row always names one directory and it is the current one | deployed |
| C5 | Test sessions revoked | coordinator | `revoked_at` set; cookies answer 401 | same file, section 5 and 7 | deployed |
| C6 | This candidate (A7, A8, A9, B8) released | coordinator | Full suite, staging, production, served commit | `docs/evidence/production-38614ab5622d.txt` | deployed |
| C7 | Ads paused, live payments disabled | owner | Unchanged | `docs/launch-checklist.md` 4.5; `/pricing` copy | verified |

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

1. **Sign in at `https://verify.itisyou.app/admin/login`** and confirm a TOTP code. That
   unblocks B9. Nobody may seed a production session to stand in for it.
2. **Cloudflare, Email, Email Routing, Routes**: confirm a rule for `support@itisyou.app`.
   That unblocks B10.

Nothing else is waiting on the owner. Ads stay paused and live payments stay disabled.
