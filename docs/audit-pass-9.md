# Independent release audit — pass 9

**Audit pass 9 · 20 September 2026, 06:45–07:15 UTC.** Earlier passes: `docs/audit-summary.md`
(1–3), `docs/audit-pass-2.md` … `-8.md`. This file is the auditor's only write; nothing else
in the tree was edited, committed, pushed or deployed by this pass.

Measured against `d4fc79f` at the start and `121214d` (HEAD, = `origin/main`) by the end. The
tree moved under the audit: `121214d` landed while pass 1 was running and eleven files under
`apps/app/src/routes/app/` and `packages/ui/src/styles.ts` plus a new untracked
`docs/workflow-evidence.md` were dirty by the time pass 4 ran. Gate numbers reported here from
a dirty tree are readings, not gate results, and are labelled as such.

All live probes were read-only: HTTP GETs against production and staging, `wrangler
deployments list`, `wrangler secret list` (names only), `gh run view`. A read-only `SELECT`
against the remote D1 databases was **refused by the permission layer** and was not attempted
by any other route — everything that depended on it is listed as unverified at the end.

Mutation testing was done in a copy of `HEAD` under the auditor's scratch directory with the
real `node_modules` junctioned in. The real working tree was never broken.

---

## Verdicts at a glance

| # | Finding | Severity |
| --- | --- | --- |
| P1-1 | The release gate does not read Playwright failures. The artefact production was deployed from (`e0aa820`, 06:18Z) records `playwright.stats.unexpected: 3` and `accounting.failing: 0` in the same file; `scripts/release.mjs` checks neither the former nor anything derived from it. Production went out from that artefact at 06:20Z. | **S1 — gate defect** |
| P1-2 | The ledger counts thirteen rows whose description belongs to a different test than the id resolves to. `OWNER-300..307` duplicate `OWNER-600..607` word for word and cite line numbers that carry the `OWNER-600` ids; `OWNER-320..324` cite lines in `automationSeed.test.ts` that carry `AUTH-44x` ids. All thirteen are "passing" on the strength of unrelated tests that happen to hold those ids. `verify-test-cases.mjs --strict` says PASS. | **S1 — ledger integrity** |
| P2-1 | The live visual story (`/development-story/visual`, production) states under "Not yet true" that provider credentials "do not exist yet" and "the connector path is proven against mocks", and under evidence that live HubSpot/Resend calls are "none … a known fact" — on the same page that says Resend produced one read-back and two signed webhooks. Source: `narrative.ts:689-691` and `:646-651`, unchanged by `a220707`. DOC-122 passes because it pins different words. | **S1 — false public statement (understating)** |
| P2-2 | `PROVIDER_PROOF_NOTICE.headline` says "Our HubSpot and Resend connectors have not yet been run against a real account"; its own body's first sentence says "Resend has been run against a real account". Served on production `/demo` and `/security`. | **S1 — self-contradicting public statement** |
| P2-3 | `docs/development-story.md` § Where it stands (identical copy served at `/development-story`) says under **Not yet true** that both deployments rejected all six Stripe events and no subscription was activated. `docs/development-story-events.json` EVT-0044 (06:15Z) records the opposite: one active subscription and one entitlement read from staging. The page's own footer says a disagreement between the two is a defect in the page. Gap-register row 345 says the same stale thing. | **S1 — story contradicts its own record** |
| P2-4 | `SERVICE_ACTIVATION_NOTICE` and `FOOTER_SERVICE_DESCRIPTION` (every public page, production) say "no purchase has been completed end to end on a deployment". EVT-0044 and commit `e0aa820` claim checkout → paid → webhook → active subscription → entitlement on staging. Either the notice is stale (understating) or "end to end" means something the notice does not say. Needs the lead's ruling, then the six copies and CUST-124 move together. **The auditor could not independently confirm the staging rows** (see unverified list). | **S2 — probable stale claim** |
| P2-5 | `docs/advertising.md` line 5 and `docs/campaign-packet.md` line 5: "No advertising account exists. No campaign has been created." The same `advertising.md` at lines 596/701/705 and commit `decd8aa`: account `227-475-1523`, campaign `281499240660433`, draft `10214870512` in Google Ads — a platform §1 of the same document rules out "on both counts". The packet still specifies Reddit. | **S2 — claims documents self-contradict** |
| P3-1 | Production runs `e0aa820`. `/health` carries no `commit` key at all (the current code emits at least `null`), and the last production deployment (06:20:22Z) matches the `e0aa820` artefact (06:18:12Z). Production therefore lacks the `47873e9` unknown-workspace guard: a `checkout.session.completed` or `customer.subscription.created` for a staging-held workspace still 500s on production and Stripe retries. Launch-plan item 1 (due T+1h = 07:45Z) is not yet done as of 06:59Z; not overdue at time of writing. | **S2 — known live defect, correctly disclosed in the commit, not yet closed** |
| P1-3 | Gap-register table rows that have become false (line numbers as of `d44cdf5`, re-read after that commit changed the file): 99 (`EVENT_SIGNING_ROOT_KEY` "Absent" — present in both environments per `wrangler secret list`), 137 (`RESEND_FROM_ADDRESS` "Absent" — present in both), 143 (customer CSRF "OPEN — and it looks defended" — both halves now applied at `routes/app/index.ts:204-207`, CUST-460..462), 144 (runner status "STILL EXPOSED ON PRODUCTION" — production answers 401), 146 (pause switches "OPEN — the control lies" — `isPathSuspended` enforced, OWNER-380..382). All understate. Row 345 ("The payment activated nothing … both deployments answered every one 400") survived `d44cdf5` unchanged and contradicts EVT-0044. The row "The deployed commit cannot be proven from outside" is still true. | **S3 — register drift, understating** |
| P1-4 | Ledger header `snapshot_commit: d477586`, `generated_at 00:23Z` — 33 commits stale, after two commits today whose whole purpose was to set it correctly. 95 rows are `implemented` (no run recorded) though the suite passes them; 3 `retired` rows are counted as "discovered (a test carrying the id exists)"; `CONN-900/901` exist in the tree but the verifier cannot see `it.runIf(cond)(` titles, so "in the ledger, not the tree 19" is really 17 and "in the test tree 2734" is really 2736. 70 ledger `requirement` strings no longer match their test title; the `expected` for CUST-005 lists assertions that were deleted from the test; OWNER-367/368's `requirement` describes the behaviour the test now asserts the opposite of. | **S3 — ledger drift, both directions** |
| P1-5 | Weakened or flipped assertions in existing tests, each argued in its commit: OWNER-498 (`calls.length === 0` → `not.toContain('cannot take payment')`), CUST-005 (OS-preference assertions deleted), OWNER-367/368 (`consumed` → `granted`). None is green-seeking on the evidence, but OWNER-498 is now only as strong as the failure alert keeping the phrase "cannot take payment" (`tick.ts:727` — it does today). | **S4 — accepted, watch** |
| P1-6 | Assertions that cannot usefully fail: OWNER-503 `toContain('test')` (scene sets `ENVIRONMENT: 'test'`; any body containing the four letters passes); CUST-720 recomputes `Math.floor(composed/total*100)` from the same list it tests, so it proves arithmetic against itself and nothing about whether the five `composed: true` flags are true — and `docs/development-story.md:387` says "the individual compositions are still ours", which contradicts five screens being composed; `OWNER-048` is the title of two different tests (`controls.test.ts:97` and `:120`), so one of them is invisible to the ledger. | **S4** |
| P2-6 | Claim scanner: the split-element repair works — 8 of 9 constructed split claims were caught. The one missed, `<span>GBP 149</span><span>/ month</span>`, is the exact example quoted in the commit message and the code comment; the `wrong-plan-price` rule requires `£`. No design file uses `GBP` in text, so no practical miss today. The published 109 (screen files) and 168 (whole `design/`) were reproduced exactly. | **S4 — comment overstates the rule** |
| P1-7 | Five newest cases proven against their defects by mutation (see § Mutation proofs). BILL-650 is a true discriminator; BILL-641 fails without its guard as claimed; BILL-630/631/633 fail without `.trim()`; BILL-634 fails without the log default; BUDGET-548 fails when either the TypeScript or the SQL half of rule 7 is broken. | **Clean** |
| P3-2 | Safety posture, verified: `STRIPE_MODE: "test"` in all three environments; livemode mismatch refused in checkout, webhook and portal; provisioning refuses a live key. `/owner` → 404 anonymous, `/admin` → 303 `/admin/login`, `/admin/login` → 200, all on production. Every one of the 24 `/owner` POST handlers goes through `withAction` with a consequential capability, and `authorise()` requires `mfa_verified_at` within 15 minutes for anything but `owner.view`. Advertising: **drafted**, per `decd8aa` and the launch plan; not verifiable from here. | **Clean, with the unverified items listed** |
| P2-7 | `d44cdf5` (07:59, lead) records that `gatherEvidence` never reads the `evidence` table, so a stored `provider_webhook` row "cannot support any assertion", and says "the public wording gets qualified instead". The commit touched only `docs/`. `narrative.ts:86` still says "or Resend calls us and we verify its signature" on the live `/development-story/visual`, and `EvidenceOrigin` still offers `provider_webhook`. The failure is safe (UNVERIFIED, never a pass) — the description of a path that cannot decide anything is not yet qualified anywhere public. | **S2 — described capability not held; disclosure pending** |
| P2-8 | The advertising ids have moved under the documents that cite them. A-GROWTH's in-flight edit to `docs/advertising.md` §13 (06:57Z) says the draft now open is campaign `281499240699016` / draft `10214818128`, that the ids in `decd8aa` and `docs/launch-plan.md` (`281499240660433` / `10214870512`) "belong to the first attempt, which … records as not persisted", and that whether the current draft has persisted is **unknown** until the owner sees it in the Drafts list. Two accounts appear in the chooser. "Drafted" is therefore the lead's belief about a wizard state, not an observed persisted object. | **S2 — state of the one thing that could spend is unconfirmed** |
| P4 | Suite, typecheck, eslint, secret scan, claim scan: green in both of the auditor's runs. Ledger `--strict`: green at `d4fc79f`; **red on the dirty tree at `d44cdf5`** because an untracked WIP test file carries eight ids the ledger lacked at that instant (tails below). | **Green at a SHA; red mid-edit** |

---

## Pass 1 — Test integrity

### 1.1 Every change to an existing test in the last eight hours

30 commits touched `tests/` or `docs/test-cases.json`. Hunks that removed or changed an existing
line in a test file were isolated and read in full. Findings, most material first.

**OWNER-498 (`be5ba79`, `tests/integration/support/owner-alert-wiring.test.ts:133`).**

```diff
-  it('OWNER-498 a healthy deployment sends nothing at all', async () => {
+  it('OWNER-498 a healthy deployment never sends the cannot-take-payment alert', async () => {
...
-    expect(s.calls.length).toBe(0);
-    expect(report.ownerAlert?.attempted).toBe(false);
+    const bodies = s.calls.map((call) => call.body).join(' ');
+    expect(bodies).not.toContain('cannot take payment');
+    expect(bodies).not.toContain('STRIPE_SECRET_KEY');
```

Loosened. The commit argues the premise changed (a healthy sandbox now sends one milestone
line), and OWNER-503 was added beside it to pin that milestone. Accepted. But the new
assertion is only meaningful while the failure alert keeps the phrase — checked:
`apps/app/src/scheduler/tick.ts:727` still renders "cannot take payment". If that wording is
ever edited, OWNER-498 becomes a test that cannot fail without anyone touching it.

**CUST-005 (`48c5287` then `51f39f7`, `tests/unit/ui/tokens.test.ts`).** Two rewrites in
three minutes. The second deleted
`expect(CSS, 'a light preference must be honoured').toContain('@media (prefers-color-scheme:light)')`
and `expect(CSS).toContain(':root:not([data-theme="dark"])')`. The commit says the OS
preference must no longer override the approved dark palette. That is a product decision
stated in the commit, so not green-seeking; but the ledger's `expected` for CUST-005 still
lists the *original* four assertions (`@media (prefers-color-scheme:dark)`,
`:root:not([data-theme="light"])`), two of which no longer exist in any test. The citable
record describes a test that is not there.

**OWNER-367 / OWNER-368 (`ca9d062`, `tests/integration/owner/live-engines.test.ts`).**

```diff
-    expect(after?.status).toBe('consumed');
-    expect(after?.consumed_at).toBe(ISO);
+    expect(after?.status).toBe('granted');
+    expect(after?.consumed_at).toBeNull();
```

Expectation inverted to match new behaviour (no provider → approval left unspent). The comment
argues the old behaviour burned a single-use authorisation for a refund that could not be
submitted, which is a genuine correction. Pass 4 of the audit trail (`a374d97`) then caught
the implementer weakening OWNER-370 and it was restored to a hash-equality assertion — read
and confirmed. The ledger's `requirement` for OWNER-367 still reads "a refund through the live
port moves the approval row to consumed": the opposite of what the test now asserts.

**DOC-122 (`a220707`).** Expectation changed from "never run live" to per-provider sentences.
Justified by facts; the new assertions were checked against the live page and hold. However
the negative assertions pin two exact phrases, and the same page still carries the stale
claim in *other* words (see P2-1). A test that pins the sentence it deleted, rather than the
property, misses the second copy.

**CUST-333 (`d477586`).** Substring → `toMatch(/HubSpot has not|not[^.]*read back[^.]*HubSpot/i)`.
Loose by design ("asserted by substance"). It would pass on a page saying "HubSpot has not
been mentioned". Acceptable given the second and third assertions in the same block are exact.

**BILL-400 message regex, AUTH-420 equality, status-signals `data-demo-run` split, createCheckout
`/no card was charged/i`, ports.test blockers naming the secret** — all read; each is at least as
strong as before, several stronger. `notification-wiring.test.ts` helper now filters
`channel != 'telegram'` from the rows it counts — a scope narrowing, explained, and the other
channel is asserted in its own file.

### 1.2 Tests that cannot fail, or fail for the wrong reason

- **OWNER-503** (`owner-alert-wiring.test.ts:160`):
  `expect(s.calls[0]?.body, 'the alert does not name its deployment').toContain('test')`. The
  scene's `ENVIRONMENT` is `'test'` (line 53). Four letters that also appear in "latest",
  "attestation", `sk_test`. Assert the full `Sandbox payment secrets present on test` instead.
- **CUST-720** (`tests/unit/ui/design-progress.test.ts`, landed in `121214d`): computes
  `Math.floor((progress.composed / progress.total) * 100)` from `STITCH_SCREENS` and compares it
  to `designProgress()`, which does the same arithmetic on the same list. It cannot fail unless
  the function disagrees with itself. Nothing asserts that `/`, `/pricing`, `/how-it-works`,
  `/demo`, `/security` are actually composed against their references; those five booleans are
  hand-written. The message to the owner ("5 of 19, 26%") rests on them, and
  `docs/development-story.md:387-388` currently says the individual compositions are *not* done.
  One of the two is wrong. CUST-721..723 are sound.
- **OWNER-048** is the id of two different tests (`tests/unit/owner/controls.test.ts:97` and
  `:120`). The ledger has one row (the second). The verifier reported no duplicate.
- **`OWNER-340`** row in the ledger has the *template string*
  `${OWNER_LAYOUT_CASE_IDS[WIDTHS.indexOf(viewport)] ?? 'OWNER-340'}` as its requirement — the
  generator captured source, not a title.
- The dead-regex pattern from a previous pass (`\b` after `%`) was searched for across
  `tests/`: no instance remains. `metadata:` passed to a `workspaceId` helper: the fixture in
  BILL-641 now uses `subscriptionObject({ workspaceId })`, which does emit `metadata.workspace_id`
  (`harness.ts:239-246`). `event_id`/`processing_status`: BILL-650 reads `eventId`/`status`,
  matching the memory store. Both of today's self-reported fixture bugs are fixed as described.
- Test blocks with no assertion: one, `tests/e2e/owner.spec.ts` "OWNER-348 pausing, acknowledging
  and campaign journeys are covered elsewhere" — a placeholder, labelled as such.

### 1.3 Mutation proofs — the five newest cases

Scratch copy of `d4fc79f`; one implementation change at a time; the named test file run; file
restored from the real tree afterwards.

| Mutation | Where | Cases that failed | Verdict |
| --- | --- | --- | --- |
| A — remove `workspaceExists` guard in the checkout handler | `apps/app/src/billing/events.ts:142-144` | BILL-640, BILL-643, **BILL-650** (3 failed / 40 passed) | BILL-650 discriminates as the commit claims |
| B — remove `workspaceExists` guard in the subscription handler | `events.ts:261-263` | **BILL-641**, BILL-653 (2 / 41) | BILL-641 now fails without its guard, as `47873e9` says it was fixed to |
| C — remove both `.trim()` in `createEndpointSecretResolver` | `apps/app/src/billing/mount.ts:170-171` | BILL-630, BILL-631, **BILL-633** (3 / 25) | BILL-633 reproduces the six refused deliveries |
| D — drop the `defaultWebhookLog` fallback | `mount.ts:256` | BILL-634 (1 / 27) | Guards the silent-default regression |
| E — `excludedFirst` → last write wins | `apps/app/src/growth/memory.ts:52-53` | BUDGET-548 (1 / 62) | TypeScript half covered |
| F — SQL `CASE` → `excluded.classification` | `apps/app/src/db/growthPort.ts:95-100` | BUDGET-547, BUDGET-548 (2 / 7) | SQL half covered separately |

BILL-651/652 passed in both directions under A and B, which is what a control should do.
`121214d`'s CUST-720..723 landed after this table was built and were reviewed by reading only
(see 1.2).

### 1.4 Ledger verify — both directions of drift

`node scripts/verify-test-cases.mjs --strict` at `121214d` (dirty tree): **PASS**,
`TOTAL 2753 · passing 2621 · planned 14 · implemented 95 · counted 2621 · floor met`;
`in the ledger 2753 · in the test tree 2734 · in the ledger, not the tree 19`.

**Overstating.**

- **Thirteen rows describe tests that do not exist under their id.** Ledger `OWNER-300..307`
  have requirements identical to `OWNER-600..607` and `implementation_ref`s into
  `tests/integration/db/ownerPort.test.ts` at lines whose titles begin `OWNER-600`…`OWNER-607`.
  The ids `OWNER-300..307` do exist in the tree — as *different* tests in
  `tests/integration/owner/live-path.test.ts` ("a POST to the refund route moves the approval row
  to consumed…"). `OWNER-320..324` cite `tests/integration/db/automationSeed.test.ts:248-295`,
  whose titles are `AUTH-440..460`; the ids resolve to `tests/integration/owner/call-sites.test.ts`.
  Every one of the thirteen is `passing`. The verifier's duplicate check (`requirement + setup`)
  did not fire because `setup` differs. So the citable 2621 contains at least 8 rows counted
  twice under two id ranges and 5 rows with no test matching their description.
- `discovered (a test carrying the id exists) 2739` includes 3 `retired` rows (`CONN-317..319`)
  for which no test exists — the accounting puts every non-`planned` status in `discovered`.
- The 19 "in the ledger, not the tree" = 14 planned + 3 retired + **2 that are in the tree**
  (`CONN-900`, `CONN-901`, `tests/integration/connectors/live-smoke.test.ts:136,212`, written
  `it.runIf(HUBSPOT_ENABLED)('CONN-900 …')`). `TITLE_CALL` at `verify-test-cases.mjs:639` does
  not match a call with a parenthesised modifier. Same blind spot in this auditor's first pass.

**Understating.**

- `passing 2621` against an actual run of 2693 vitest passed / 0 failed / 3 skipped at
  `d4fc79f` and 2697 at `121214d` (the lead's figure). 95 rows sit in `implemented` — exists,
  status not recorded — though every one of them ran and passed in both of this pass's runs.
- `snapshot_commit: "d477586"`, `generated_at: 00:23:33Z`. HEAD is 33 commits later. Commits
  `b4cf8da` and `de608aa` were each titled "snapshot_commit for the commit it describes"; the
  field has drifted again and nothing checks it.
- 70 rows have a `requirement` that matches no test title (most are harmless rewordings; the
  material ones are named above). CUST-005's `expected` lists two deleted assertions.
- The by-runner note says the vitest-only passing figure (2603 in the ledger) is what
  `build-test-report.mjs` reports; `run-tests.mjs` reported 2693. The two published numbers
  differ by 90 and both are called "passing".

**Net:** the ledger's headline of 2753 cases overstates the tree by 19 (of which 14 are honestly
labelled planned); its citable 2621 overstates distinct described-and-passing tests by at least
13 and understates the tests that actually pass by roughly 70. The number is not wrong in one
direction; it is wrong in two, and `--strict` cannot see either.

### 1.5 The release gate and the browser suite (P1-1)

`reports/release-gate.json` — produced by CI for `e0aa820` at 06:18:12Z, tree clean — contains:

```json
"accounting": { "failing": 0, ... },
"runners": { "playwright": { "executed": true, "stats": { "expected": 12, "skipped": 26, "unexpected": 3 } } }
```

`scripts/release.mjs:120-197` checks `commit_sha`, `produced_by`, `tree_clean`,
`ledger.checker_exit_code`, `gate.met`, `floors_met`. It does not read `runners.playwright`.
`scripts/verify-test-cases.mjs` never opens `pw.json` (grep: the only `playwright` references are
the runner labels on ledger rows), so a Playwright failure cannot become a `failing` case;
`accounting.failing` comes from the ledger's stored status strings. `.github/workflows/ci.yml:170-175`
says `continue-on-error` "is not a way of ignoring failures … a failing browser case becomes a
recorded failure". It becomes a number in a field nothing reads. Production was deployed from
this artefact at 06:20:22Z (`wrangler deployments list --env production`, latest entry).

Which three cases failed is **not knowable from the repository**: `pw.json` is not uploaded as an
artefact, the job log redirects the reporter to the file, and the local `reports/pw.json`
(00:25Z, `unexpected: 0`) is from a different commit and machine.

---

## Pass 2 — Claims and honesty

### 2.1 Scanner

`node scripts/scan-claims.mjs` — clean, 64 files, 5 exemptions. `--paths reports/served` — clean,
71 files, 9 exemptions. Probe file with nine claims each split across elements:

```
£149 / month              caught  (wrong-plan-price)
14-Day Agency Trial       caught  (unoffered-trial)
SOC 2 Type II             caught  (false-certification)
Trusted by 2,000          caught  (unearned-social-proof)
guaranteed accuracy       caught  (absolutist-claim)
£149 a month  (via <br>)  caught
GBP 149 / month           MISSED  — rule requires "£"
We <em>fix</em> your…     caught  (remediation-claim)
100% accurate             caught  (absolutist-claim)
```

The repair described in `e0aa820` is real. The `GBP` example in `scan-claims.mjs` (comment
above the rule loop) and in the commit message is not one the rule matches; `design/` uses `£`
throughout (no `GBP \d` in any text file), so no finding was lost, but the comment should not
cite an example the gate would pass.

Published figures reproduced: `node scripts/scan-claims.mjs --paths design` → **168** findings;
summing the 22 `code.html` screen files → **109** (15 of the 22 have findings; 7 are clean). Both
match `docs/stitch-mapping.md:96`, both stories and EVT-0043/0044.

### 2.2 Figures presented as facts, spot-checked

| Figure | Where | Checked against | Result |
| --- | --- | --- | --- |
| 109 / 168 findings | stitch-mapping, both stories, events | re-ran scanner | correct |
| "34 findings" | `development-story-events.json:1100` decision_summary; both stories; live `/development-story` | left named as the superseded figure beside 109 | acceptable, deliberate |
| "Suite: 2,689 passed" (`47873e9`), "2,697" (`121214d`) | commit messages | own runs: 2,693 at `d4fc79f` | consistent with the trajectory |
| "Ledger PASS (2,745)", "(2,753)" | commit messages | verifier | correct at those commits |
| "Distinct test cases 1,951", "Findings raised 23", "Cases skipped 2 … because no provider credential exists" | `narrative.ts:630-652`, live `/development-story/visual` | `HUBSPOT_TEST_TOKEN` and `RESEND_API_KEY` are set in both environments (`wrangler secret list`); gap row 347 says the HubSpot credential is validated against portal 149371406 | the *reason* given for the skips is false today; the block says "relayed as published" but the note is present-tense |
| "5 of 19, 26%" | `121214d` commit message, milestone to owner | `STITCH_SCREENS` booleans; story text says compositions "still ours" | unverifiable; internally contradicted |
| "GBP 0.00 spent" | launch plan, spend.md, story | structurally plausible (no activation path used); no bill visible | not independently verifiable |
| "twelve overstated claims corrected on 19 September" | `narrative.ts:599`, live | `docs/audit-summary.md` | as published; not re-derived |

### 2.3 "Not yet true" / "Where it stands" / gap register, against current reality

**False by overstating the gap (saying less than is true):**

1. `narrative.ts:689-691` (`STANDING`, rendered on live `/development-story/visual`): "Provider-backed
   evidence against real HubSpot and Resend accounts, because those credentials do not exist yet —
   until they do, the connector path is proven against mocks, and this page will not pretend
   otherwise." Credentials exist (secret names present in both environments; gap row 347;
   `docs/deployed-evidence.md` records a real Resend read-back and a VERIFIED verdict on staging).
   The same page, two sections up, says so. `narrative.ts:646-651`: "Live HubSpot or Resend calls
   from this repository: none … This is a known fact, not an unknown" — same defect. `a220707`
   fixed the callout, the diagram and the connectors row and left these two. DOC-122's negatives
   pin "never run against a live account" and pass.
2. `packages/ui/src/content/site.ts:126` `PROVIDER_PROOF_NOTICE.headline`: "Our HubSpot and Resend
   connectors have not yet been run against a real account". Body, first sentence: "Resend has
   been run against a real account". Live on production `/demo` and `/security`, fetched 06:51Z.
3. `docs/development-story.md:383-386` / `apps/app/public/development-story.md` (byte-identical) /
   live `/development-story`: "**Not yet true.** The subscription that payment should have
   activated: the provider delivered six events for it and both deployments rejected all six".
   `docs/development-story-events.json` EVT-0044 (06:15Z, same repository): "read from the live
   staging database: one subscription row, status active; one entitlement row, 500 runs, none
   consumed … replayed … already-processed duplicate". `docs/development-story-visual.md:405`
   same stale sentence. Gap register row 345 same.
4. `SERVICE_ACTIVATION_NOTICE` / `FOOTER_SERVICE_DESCRIPTION` "no purchase has been completed end to
   end on a deployment" — see P2-4. Pass 8 predicted exactly this ("it will be stale the day either
   one closes"). The auditor could not confirm the staging rows and so records this as *probable*.
5. Gap register rows 99, 137, 143, 144, 146 — see P1-3 for each with its evidence.

**False by understating the gap (saying more than is true):**

6. `docs/advertising.md:4-5` and `docs/campaign-packet.md:4-5` "No advertising account exists. No
   campaign has been created." — account `227-475-1523`, draft `10214870512` (same file, lines
   596-705; `decd8aa`; launch plan). The launch plan's own state for it is **drafted**. A reader of
   the header believes less exists than does — but a reader of the packet believes the plan is
   Reddit when the built draft is Google Ads, which the feasibility section rules out. Both
   directions in one pair of documents.
7. `apps/app/src/index.ts:435` and `d4fc79f`: "Until 20 September 2026 there was no way to answer
   that from outside" (which commit is serving). Still no way, on either deployment, at 06:59Z:
   `/health` on production and staging returns no `commit` key. True of the code; not yet true of
   anything deployed. The gap-register row 351 is the one that is still correct.

**Still true, checked:** launch plan item 2 ("done") — confirmed by mutation A; "Live customer
payments remain disabled" — see Pass 3; `/owner` 404, `/admin/login` 200 — live.

---

## Pass 3 — Safety posture, literally

| Item | State | How verified |
| --- | --- | --- |
| Live Stripe payments | **Disabled.** | `apps/app/wrangler.jsonc`: `STRIPE_MODE: "test"` for development, staging and production. `billing/checkout.ts:158,180` `assertMode` refuses a livemode object under test config; `routes/webhooks/stripe.ts:172` refuses a livemode event; `billing/portal.ts:45` same; `billing/provision.ts:24,151` refuses a live key or `STRIPE_MODE=live` before any call. `STRIPE_SECRET_KEY` is *present* on both environments (names only) — whether it is a test-shaped key **could not be seen**. A live key under test mode would create a live Checkout Session and then refuse it (pass-8 S6): no charge, one orphan session. |
| Can real money move | **No customer path.** Checkout: test mode only. Refunds: `refund.issue` needs owner session + MFA + granted approval + a Stripe key; under a test key it refunds test charges. Advertising: draft only (below). What the auditor could not rule out: the value of `STRIPE_SECRET_KEY` on production. |
| Advertising campaign | **Drafted**, not submitted, not approved, not delivering — *as stated by the lead* (`decd8aa`, `docs/launch-plan.md` "This is today"). Google Ads account `227-475-1523`, campaign `281499240660433`, draft `10214870512`, "keywords, ad text and the budget amount are not done, so it is not publishable". | Read from commits and docs only. No Google Ads access from this audit. Two claims documents say no account exists (P2-5). |
| Owner dashboard authenticated | **Yes.** | Live production: `GET /owner` → 404 (35,777 B page, identical shape to any refused address); `GET /admin` → 303 to `/admin/login`; `GET /app` → 401. Code: `principalOf` throws on an unconfigured production port (`routes/owner/index.ts:293-297`); `authorise()` gate 1 returns `not_found` for anonymous. |
| `/admin/login` reachable | **Yes, 200, public, by design** (`index.ts:470-473`). Live. `/admin/bootstrap` also public; it "closes itself by writing an owner". Whether it has closed on production could not be checked (DB). |
| Privileged actions require recent MFA | **Yes in code.** `owner/access.ts:271-286`: every capability except `owner.view` requires `mfa_verified_at` within `MFA_WINDOW_SECONDS = 900`, future timestamps rejected, absent = never. All 24 `routes.post('/owner/…')` handlers call `withAction(c, '<capability>')` with a consequential capability (list checked: `refund.issue`, `ads.activate`, `approval.grant`, `settings.write`, `controls.toggle`, `maintenance.dispatch`, `cleanup.execute`, …); the four `RAW` POSTs are `/admin/login`, `/admin/bootstrap`, `/admin/verify`, `/admin/sign-out` — the auth flow itself. OWNER-170/171 assert the refusal and the permission. **Not verified:** that the production owner account has TOTP enrolled and that `port.principal()` populates `mfaVerifiedAt` from a real session row (DB read refused). |
| Which commit production serves | **Cannot be proven from outside; inferred `e0aa820`.** `/health` has no `commit` key; last deployment 06:20:22Z; artefact for `e0aa820` produced 06:18:12Z; `d4fc79f`'s own message says production was on `e0aa820`. No version carries a message on either environment. |

---

## Pass 4 — Release gate reality

Run 1, at `d4fc79f`, clean tree, 06:46Z:

```
 Test Files  177 passed | 1 skipped (178)
      Tests  2693 passed | 3 skipped (2696)
run-tests: exit 0 and every cross-check agrees; files 178, tests 2693 passed / 0 failed / 3 skipped (on disk: 178 files)
EXIT=0
```
`npx tsc -p tsconfig.json --noEmit --pretty false` → no output, `EXIT=0`.
`npx eslint . --max-warnings=0` → no output, `EXIT=0`.
`node scripts/scan-secrets.mjs` → `scan:secrets — clean. 707 tracked files.` `EXIT=0`.
`node scripts/verify-test-cases.mjs --strict` → `Ledger integrity: PASS`, `EXIT=0`, with the caveats in 1.4.

Run 2, at `121214d` with 11 uncommitted files (another lane's work in progress) — appended
below when complete. These are readings of a dirty tree, not gate results.

Run 2, at `d44cdf5` with **12 uncommitted files** (A-UI and A-GROWTH lanes mid-edit, plus an
untracked `tests/unit/ui/customer-composition.test.ts`), 07:05Z:

```
run-tests: exit 0 and every cross-check agrees; files 180, tests 2705 passed / 0 failed / 3 skipped (on disk: 180 files)
EXIT=0
```
`npx tsc -p tsconfig.json --noEmit --pretty false` → no output, `EXIT=0`.
`npx eslint . --max-warnings=0` → no output, `EXIT=0`.
`node scripts/scan-secrets.mjs` → `scan:secrets — clean. 711 tracked files.` `EXIT=0`.
`node scripts/scan-claims.mjs --paths reports/served` → `scan:claims — clean. 72 public-surface file(s) scanned … 9 line(s) exempted` `EXIT=0`.
`node scripts/verify-test-cases.mjs --strict`:

```
    in the ledger                2753
    in the test tree             2742
    in both                      2734
    in the tree, not the ledger  8
    in the ledger, not the tree  19

  1 reconciliation defect(s) (fatal under --strict):
    DEFECT  [test-tree] tests/unit/ui/customer-composition.test.ts carries 8 case id(s) absent from the ledger (CUST-901, CUST-902, CUST-903, CUST-904, …) — the ledger must describe the suite that exists

  --strict: 1 reconciliation defect(s) block the release gate.
EXIT=1
```

**Reading of the red:** the file named is untracked (`git ls-files` returns nothing for it), so
the committed tree at `d44cdf5` does not contain the defect; and by the time this was written
the dirty `docs/test-cases.json` already carried `CUST-901..908`, so the lane is reconciling it.
This is work in progress caught between two saves, not a committed regression — but it is
exactly the state a hurried commit would freeze, and whoever commits that test file must commit
the ledger rows in the same change or the strict gate goes red at a SHA.

**If anything is red, what must stay disabled:** nothing in the auditor's runs is red. The
one gate that *should* have been red and was not is the Playwright half of the `e0aa820`
artefact (P1-1). Until `release.mjs` refuses on `runners.playwright.stats.unexpected > 0` — or
the three failures are identified and shown to be outside the paid path — the browser layer is
unmeasured for gating purposes and the launch plan's item 16 ("full gate green") cannot be
claimed on the strength of the artefact alone.

---

## Claims made by other agents or the lead that this pass could NOT verify

1. **Staging holds one active subscription and one entitlement (500 runs, 0 consumed), and a
   replayed event was answered `already_processed` with `updated_at` unchanged** (`e0aa820`,
   EVT-0044). A read-only `SELECT` against the remote D1 was refused by the permission layer.
   Launch-plan item 17 ("auditor reproduces activation and replay without the lead's help")
   **cannot be met by this auditor under the current permissions.** Say so to the owner rather
   than letting item 17 read as pending.
2. **The Google Ads draft exists, has persisted, has never served, has spent GBP 0.00, and is
   unpublishable** (`decd8aa`, launch plan). No Google Ads access from this audit. The ids cited
   by the commit and the launch plan are, per A-GROWTH's in-flight §13, the *first* attempt that
   did not persist; the current one's persistence is "unknown until the owner sees it in the
   Drafts list". `docs/advertising.md:5` still says no account exists.
3. **`STRIPE_SECRET_KEY` on production and staging is a test-mode key.** Only the name is
   visible. The mode guards make a live key harmless to customers but not impossible.
4. **Which three Playwright cases failed in CI run 35493802230** and whether any is on the
   paid path. Not recoverable from the repository or the job log.
5. **Production is running `e0aa820`.** Inferred from timestamps and the lead's own statement;
   no deployment carries a commit marker.
6. **The owner account on production has TOTP enrolled and `/admin/bootstrap` has closed.**
   DB read refused.
7. **Five of nineteen Stitch screens are composed against their references** (`121214d`,
   "26%"). Hand-set booleans, no test of the fact, and `docs/development-story.md:387`
   currently says the opposite.
8. **"GBP 0.00 spent" on infrastructure and advertising.** No invoice is visible to any agent;
   `docs/spend.md` says as much. The auditor cannot improve on that.
9. **Production holds one bot, one internal-test and one external visit session** (gap row 348),
   and that the external one is the project's own browser. DB read refused.
10. **`docs/workflow-evidence.md`** (new, untracked, A-WORKFLOW lane): its runs, evidence rows and
    the FAILED verdict it says it produced on staging. Not audited — it appeared during pass 4
    and depends on the same staging database reads.
