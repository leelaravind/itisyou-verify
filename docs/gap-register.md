# Gap register — ITISYOU Verify

One row per requirement. Current state is what was **verified**, not what was reported.
Where history is undocumented it says **unknown**; nothing here is inferred to fill a blank.

Compiled 19 September 2026 at commit `5b7c450`. Superseded by any later audit that
reproduces a claim against a candidate deployment.

---

## Roster reconciliation — read this first

I previously told the owner there were eleven active specialists. **That number is no
longer true and was true only at the moment I said it.** At 15:30 Europe/London this
session hit its usage limit and every running agent was terminated mid-task by HTTP 429.
None finished cleanly; several were part-way through edits.

Planned roles are twelve specialists plus one independent Evidence and Completion
Auditor. Against that, measured by what actually ran:

| Role                          | State now                                | Evidence                                                                                           |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A01 product and market        | **complete, not re-engaged**             | `docs/product-scope.md`, `docs/competitors.md`                                                     |
| A02 architecture and data     | **interrupted mid-edit**                 | killed at 429; was cleaning another agent's partial edit in `ownerPort.ts`                         |
| A03 verification engine       | **idle — no owner active**               | complete earlier; its `scheduler/tick.ts` now needs the money-maintenance call and nobody holds it |
| A04 provider integrations     | **idle**                                 | complete earlier against mocks; never re-engaged this session                                      |
| A05 customer experience       | complete; successor **interrupted**      | A05 delivered; A05b killed at 429 mid-screenshot pass                                              |
| A06 commerce                  | successor **complete**                   | notifications wired for 2 of 12 templates with real DB state                                       |
| A07 owner operations          | complete; successor **interrupted**      | A07 browser suite green 24/17; A07b killed at 429                                                  |
| A08 AI and maintenance        | **complete, not re-engaged**             | assistant and maintenance runner                                                                   |
| A09 customer care and privacy | **idle — and it owns a release blocker** | owns `SEC-632` and 5 of the 10 unreached notification templates                                    |
| A10 security reviewer         | **idle**                                 | complete earlier; not re-engaged this session                                                      |
| A11 QA and release            | complete; successor **interrupted**      | A11b killed at 429, but its CI gate artefact code did land in `release.mjs`                        |
| A12 growth and launch         | **idle**                                 | owns the organic posts awaiting owner approval                                                     |
| Auditor (A20)                 | **interrupted**                          | killed at 429 while testing the review page's four controls                                        |

**Genuine concurrency constraint, stated plainly:** running eleven agents concurrently,
most of them on the strongest model, exhausted the session allowance and destroyed all of
their in-flight work at once. That is a real limit, not a tuning preference. The roster is
therefore being restarted smaller, with routine accounting work routed to cheaper models.

**Unknown:** whether any interrupted agent left a file in a partially-edited state that
typechecks but is semantically half-done. `tsc` is clean at `5b7c450`, which rules out
syntactic damage and rules out nothing else.

---

## A correction to this register, found by the auditor

The **Owner** column named agents that were not on the roster — A16, A19 and A21 own rows and
appear nowhere in the roster table above, while A05b and A11b own eleven rows and are
recorded there as interrupted. Not one of the twelve roster agents was recorded as running.

That is worse than a clerical slip. An owner column is the thing that makes a gap register
different from a list of complaints: it is the claim that someone is accountable. Names that
do not resolve to a live assignment are unassigned work wearing owner labels, which reads as
covered and is not. The owner instructed that there be no unresolved "not mine" findings, and
a name nobody holds is the same failure in a politer form.

Owners are now written as **workstreams**, not agent numbers, because an agent is terminated
by a usage limit and a workstream is not. The roster table says who holds each workstream
today and is the only place an agent identity appears.

## Gap register

Legend — **Closure evidence** means what would have to be true to close the row, and is
deliberately phrased as a measurement, not an assertion.

### The two closed states, kept apart on purpose

A row is never just "closed". It is closed at one of two levels, and collapsing them is
how a status report starts lying without anyone deciding to.

| State                   | What it means                                                                                                                                     | What it does **not** mean                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **LOCAL-TESTED**        | Proven by a real request against a locally running Worker, with the resulting database state read back                                            | That it works on staging or production. Local `wrangler dev` has different bindings, different secrets, no cron, and a different D1 |
| **DEPLOYMENT-VERIFIED** | The auditor re-issued the requests itself against a candidate deployment and read the state itself, and recorded the commit it reproduced against | That the feature is correct in every case — only that this evidence is real                                                         |

Nothing may be reported to the owner as done on the strength of LOCAL-TESTED alone.
Today, `POST /api/v1/events` is LOCAL-TESTED and nothing on this project is
DEPLOYMENT-VERIFIED, because the auditor's reproduction pass has not completed.

A third level exists implicitly and is worth naming: **UNIT-TESTED ONLY**, which this
project has repeatedly found to mean nothing at all. Four separate workstreams shipped
correct, thoroughly tested code that no request could reach — the events route, the
refund consumption, the notification templates, and the allowance reconciliation. A
passing unit test is evidence about a function, not about a product.

### Money path, billing and entitlements

| Requirement                                                          | Current state                                                                                                                                                                                                                                                                                                  | Missing work                                                       | Owner                        | Depends on                                | Closure evidence                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `POST /api/v1/events` intake exists and is reachable                 | **LOCAL-TESTED 19 Sep.** Answered 404 in every deployment until today. Now mounted; an unsigned POST returns `401 SIGNATURE_INVALID` through the real entry point                                                                                                                                              | —                                                                  | lead                         | —                                         | Live request against local worker, recorded in commit `5b7c450` |
| Intake works on a deployment with no Stripe key                      | **LOCAL-TESTED 19 Sep.** Returned 500 on every request; `createStripeClient` throws on an empty key and the module had documented that as safe                                                                                                                                                                 | —                                                                  | lead                         | —                                         | Same live probe: 500 before, 401 after                          |
| Allowance granted exactly once across retries and duplicate webhooks | Proven in integration against real SQLite: one grant, one notification, replay adds nothing                                                                                                                                                                                                                    | Same proof against a **candidate deployment**, not a local harness | A16                          | deploy                                    | Duplicate Stripe delivery to staging; read `entitlements` back  |
| Allowance-period identity standardised, historical rows reconciled   | **Now reachable.** The tick calls `runMoneyMaintenance`, which had no caller at all despite its own doc comment naming the tick as its caller. Wired so billing maintenance runs ONCE per tick and two consumers share the report — running it twice is the precise shape of the exactly-once allowance defect | Deployed proof; no tick has run with this wiring anywhere          | lead → integration           | deploy                                    | Cron tick on staging, then read the allowance row back          |
| Day-8 suspension marks `unpaid`, deletes nothing                     | Proven in integration: subscription `unpaid`, `consumed 37` survives, workspace not deleted                                                                                                                                                                                                                    | Deployed proof                                                     | A16                          | deploy                                    | Staging tick at day 8 boundary                                  |
| Signing keys can be issued to a customer                             | **LOCAL-TESTED 19 Sep.** `POST /app/onboarding/activation/signing-key` issues through the real browser path; secret shown once, hash-only at rest, rotation invalidates the old key with 401 SIGNATURE_INVALID. Proven on a live worker with the database read back                                            | Deployment-verified, once the root key exists                      | authenticated customer flows | owner provisioning EVENT_SIGNING_ROOT_KEY | A key issued on staging, then a signed event admitted there     |
| `EVENT_SIGNING_ROOT_KEY` provisioned                                 | Absent. Route mounts and, by design, answers 503 on a signed event                                                                                                                                                                                                                                             | `wrangler secret put` per environment                              | lead + owner                 | —                                         | Signed event to staging returns 202                             |
| 503-not-401 when the root key is missing but the key id is real      | **Unverified.** Today's probe used an unknown key id, which correctly short-circuits to 401 before the root key is read                                                                                                                                                                                        | Seed a workflow, then probe                                        | A20                          | seeded workflow                           | Probe returns 503 `SIGNING_KEY_UNREADABLE`                      |

| A verified run proves the acknowledgement reached the enquirer | **LOCAL-TESTED 19 Sep.** Closure evidence met: an acknowledgement delivered to the wrong address now returns **FAILED** with `CONTRADICTED`/`VALUE_MISMATCH`, and the expectation displayed is the run's own address rather than a literal authored once. `+tag` variants fail; an enquiry naming a different address verifies against _that_ address. A correction to my own earlier note: the CRM half was sound only on the search path — on the `crm_record_id` path the record's correlation value was never compared, so `exists` passed for a record carrying another enquiry's reference. The same binding closes both | Deployment-verified | verification and connectors | deploy | The same wrong-address run against a candidate |

### Approvals and owner controls

| Requirement                                                           | Current state                                                                                                                                                                                                                                                                                                                                                                                                            | Missing work                                                                          | Owner                   | Depends on | Closure evidence                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------- | ---------- | ------------------------------------------------------------------ |
| Approval validated **and consumed** on every approval-required action | **LOCAL-TESTED.** `issueRefund` — the owner panel's actual button — now consumes via compare-and-set. Double-submit proved: first press 422, second 422, `approvals.status=consumed` once, audit shows blocked then refused                                                                                                                                                                                              | Deployed proof                                                                        | integration             | deploy     | Re-issue the double-submit against a candidate                     |
| `decideRefund` still has no production caller                         | Correct code, unreachable. Deliberately left: it is not the wired path, and wiring a second refund route would be worse than leaving one unused                                                                                                                                                                                                                                                                          | Decide: delete it or make it the path                                                 | integration             | —          | One refund path, not two                                           |
| Quality dispatch reachable                                            | **LOCAL-TESTED.** Produces a real `quality_runs` row, `awaiting_runner`, with a real dedupe key                                                                                                                                                                                                                                                                                                                          | Deployed proof                                                                        | integration             | deploy     | Owner action on staging produces the row                           |
| Cleanup preview and run reachable                                     | **LOCAL-TESTED.** Produces a `cleanup_runs` row in `preview` with a real `inventory_hash`; approval spent before the first delete                                                                                                                                                                                                                                                                                        | Deployed proof                                                                        | integration             | deploy     | Preview on staging returns a hash from real data                   |
| Campaign activation consumes an approval                              | **LOCAL-TESTED.** Compare-and-set; double-submit consumes once. This is what now protects the reserved £15 in code rather than by nobody having pressed the button                                                                                                                                                                                                                                                       | Deployed proof                                                                        | integration             | deploy     | Activation without approval refused on a candidate                 |
| **Spending ceilings were changeable without approval**                | **LOCAL-TESTED, was a live hole.** `owner.budget_limits` sat in the same `writeSetting` allowlist as the business address. `owner/settings.ts` documented it as approval-bound; nothing enforced it. `platform:advertising` is `1500` — the reserved £15                                                                                                                                                                 | Deployed proof                                                                        | integration             | deploy     | Ceiling change without approval refused on a candidate             |
| **Deployment restore accepted any granted approval**                  | **LOCAL-TESTED, was a live hole.** `POST /owner/operations/restore` checked only that _an_ approval was granted and unexpired, so a `cleanup_execute` approval read as authorisation to replace the running code every customer is served. It also ignored the `deployment_id` on its own form while telling the operator it was recorded. Two existing tests had codified the hole and were rewritten to assert refusal | A `deployment_restore` action type — a new type, not a fix, so not added unilaterally | lead decision           | —          | Restore refused without a matching approval type                   |
| `execute_approved_release` job approval                               | **Open, latent.** `enqueueJob` requires only a non-null `approvalId` string — any fabricated, expired or consumed id passes. Currently unreachable because the kind is not dispatchable                                                                                                                                                                                                                                  | Load, validate and consume before the job row is written                              | A08                     | —          | Fabricated id refused                                              |
| Evidence records distinguish a real provider read-back from a mock    | **Contract added, no producer yet.** A test double and a genuine read-back produced byte-identical records: `origin` records the channel, not whether the channel was real, and `fetchImpl` is injectable. `EvidenceTransport` now exists on the contract                                                                                                                                                                | Connector must set it, and `live` must be unforgeable from test wiring                | verification/connectors | —          | A test that fails if a stubbed fetch can produce `transport: live` |

### Customer flows and authenticated UI

| Requirement                                                       | Current state                                                                                                                                     | Missing work                                                         | Owner | Depends on   | Closure evidence                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- | ------------ | ---------------------------------------------------------------------- |
| Purchase and activation paths disabled while unverified           | Done. Four controls rendered inert with no focusable element and no `type="submit"`                                                               | —                                                                    | A05   | —            | `tests/unit/ui/activation.test.ts`, 12 cases, shown red before the fix |
| Seven-day recovery policy shown **before** checkout               | `preCheckoutPanel` now has a caller and renders above the CTA                                                                                     | Confirmed in source, **not** in a browser against the deployed page  | A20   | deploy       | Fetch the review page; read the policy on it                           |
| Authenticated customer UI measured at 390/834/1440                | **Unmeasured.** 16 cases skip with `CUSTOMER_WORKSPACE_MISSING`                                                                                   | Seed a synthetic workspace + read-only `workspace_viewer` membership | A02   | —            | The 16 cases run and pass                                              |
| Seed script works on Windows                                      | Broken: `execFileSync` with `shell:true` unquoted splits the SQL                                                                                  | One-line change to `--file`                                          | A02   | —            | Script seeds first time                                                |
| Four statuses readable without colour                             | **Release-relevant defect.** The four status colours sit at 1.01–1.11:1 against each other in dark mode — in greyscale all four are the same mark | Implement glyph + label set; audit every status render site          | A05b  | A19's tokens | Greyscale screenshot; all four distinguishable                         |
| Empty, loading, failure, permission-denied states on every screen | Partially present; no complete matrix exists                                                                                                      | Per-screen audit and the missing states                              | A05b  | —            | State-coverage matrix per screen                                       |
| Proportional meters round down                                    | Enforced via fill classes after the 33%→100% incident                                                                                             | Re-verify after design integration                                   | A05b  | —            | 33% renders as `meter__fill--30`                                       |

### Notifications and support

| Requirement                                       | Current state                                                                                                                                                        | Missing work                                                                 | Owner              | Depends on | Closure evidence                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ | ---------- | -------------------------------------------------- |
| Customer told clearly that verification is paused | **Wired and proven.** Stripe webhook → delivery → transport, with duplicate delivery producing exactly one email                                                     | Deployed proof                                                               | A06b               | deploy     | Staging webhook; one `notification_deliveries` row |
| Remaining 10 of 12 templates reachable            | Unreached: sign-in link, welcome, export ready, deletion scheduled/completed, allowance approaching/reached, first material failure, recovery, provider disconnected | Each needs its owner's trigger                                               | A09, A02, A16, A03 | —          | One live send per template                         |
| "Payment recovered, runs resumed" notification    | **No template exists.** Deliberately not invented                                                                                                                    | Add `payment_resumed`; needs a `resumedToServing` signal from the money path | A06b + A16         | A16        | Recovery event produces exactly one email          |
| `RESEND_FROM_ADDRESS` provisioned                 | Absent. Nothing is actually sent; recorded as `no_email_transport_configured`                                                                                        | `wrangler secret put`                                                        | owner              | —          | A real email delivered                             |

### Security and resilience

| Requirement                                         | Current state                                                                                                                                                                                                                                                                                                                                                                                                                          | Missing work                                                                                                       | Owner                        | Depends on         | Closure evidence                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Customer routes defend against CSRF                 | **OPEN — and it looks defended.** Owner routes apply both halves together, explicitly never separately. `routes/app/` applies neither: `session()` mints a fresh token per request and renders it into forms, but no cookie half is ever set and `validateCsrfToken` is never called. A hidden token field compared against nothing is decoration, and a reviewer scanning the form sees it and moves on                               | Land both halves matching the owner implementation; a structural test that fails if any customer mutation lacks it | authenticated customer flows | —                  | Cross-origin POST refused; legitimate same-origin submission still works                                                 |
| `GET /api/v1/runner/status` requires authentication | **Fixed locally, STILL EXPOSED ON PRODUCTION.** Was unauthenticated behind a comment claiming a middleware that does not exist. Production answers 200 today; it discloses almost nothing because nothing is paired, and until today nothing could be                                                                                                                                                                                  | Deploy through the gate                                                                                            | lead                         | next gated release | Production returns 401 unsigned                                                                                          |
| Maintenance runner can pair a device                | **LOCAL-TESTED.** `resolvePairing` was never passed, so the default unavailable stub meant no code could be minted, `runner_devices` stayed empty, and every signed endpoint could only answer 401                                                                                                                                                                                                                                     | Deployed proof                                                                                                     | lead                         | deploy             | A device pairs on staging                                                                                                |
| Owner pause switches actually suspend               | **OPEN — the control lies.** `/owner/controls` writes a settings row and returns "Paused." `isPathSuspended` is invoked by no middleware, so pausing new_orders, chatbot or ads changes nothing the Worker serves. This is the emergency brake, and the ads half is the other half of the £15 protection                                                                                                                               | Wire it; a structural test that every named switch has a middleware consulting it                                  | owner operations             | —                  | Flip the switch, issue the request, get a refusal that says why                                                          |
| Release jobs require a real approval                | **LOCAL-TESTED.** `enqueueJob` accepted any non-empty string as an approval id — fabricated, expired and consumed ids all queued a release. Now loaded, validated, checked to cover a release, and spent before the job row is written                                                                                                                                                                                                 | A `release_execute` action type; consumption is unreachable until one exists                                       | lead decision                | —                  | Fabricated id refused with no job row                                                                                    |
| Assistant cannot be steered by untrusted text       | **LOCAL-TESTED.** The boundary was enforced only for a field no production code supplies, so proposals would have been permanently allowed in a shipped build while tool results carrying provider error codes and customer-authored labels were fed back unfenced                                                                                                                                                                     | Deployed proof                                                                                                     | maintenance and assistant    | deploy             | A poisoned tool result cannot produce a proposal                                                                         |
| No unearned public claim ships                      | **LOCAL-TESTED 19 Sep.** `scripts/scan-claims.mjs` added and wired into the release gate; proven to exit 0 on the tree and 1 on a planted claim                                                                                                                                                                                                                                                                                        | Keep the served-pages pass running post-deploy                                                                     | lead                         | deploy             | Gate output per release                                                                                                  |
| `SEC-632` blocks its worker for 218s                | Root-caused by two agents independently. Not a pool-pressure problem; a synchronous `execFileSync` holding the event loop past birpc's fixed 60s timer                                                                                                                                                                                                                                                                                 | Make it async, split it, or move it out of vitest into the release gate                                            | A09                          | —                  | Full suite green with no unhandled RPC error                                                                             |
| `SEC-206` tenant scope in the predicate             | **Closed**                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                  | A02                          | —                  | Case passes: verified 19 Sep 2026 and recorded passed by CI at `af23e906`. This row read "Failing" long after it passed. |
| Migration 0002 forward-compatibility                | **Known unresolved.** A previous Worker writing the older AAD shape would be rejected by the CHECK constraint                                                                                                                                                                                                                                                                                                                          | Decide: widen, or accept with a documented rollback restriction                                                    | A02 + lead                   | —                  | Stated decision with reasoning                                                                                           |
| Backup restoration                                  | **CLAIM WITHDRAWN 19 Sep.** I recorded this as DEPLOYMENT-VERIFIED citing "recorded in the story". The development story contains **no such event** — the citation was false. A manual drill against remote D1 was performed earlier and its results reported at the time, but both drill databases were deleted, so it is not reproducible now and no test covers it. The in-repo backup test is in-memory SQLite with and one tenant | A restore drill that is repeatable, and a test that covers it                                                      | lead                         | —                  | A drill re-run against real D1 with its commands and output recorded, or a test that does it                             |

### Test reporting and cleanup

| Requirement                            | Current state                                                                                                               | Missing work                                                                                                                 | Owner          | Depends on | Closure evidence                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- | ------------------------------------------------------------ |
| ≥500 distinct meaningful passing tests | 2,065 countable passing at a pinned read; 2,205 with `SEC-*` included                                                       | The number must come from CI on a clean checkout. `release.mjs` now refuses production unless the gate artefact matches HEAD | A11b           | CI run     | `release-gate-<sha>.json` produced by GitHub Actions at HEAD |
| Test inventory reconciled              | Seven buckets reconcile with nothing left over; the "29 unexplained" had no irreducible core                                | Apply explicit per-case `category` to 156 `SEC-*` entries; no renames                                                        | A11b           | —          | Twelve floors recomputed exactly                             |
| 61 duplicate test ids                  | 8 are one agent colliding with itself; 5 need coordination                                                                  | Fix                                                                                                                          | A11b + A07/A09 | —          | Zero duplicates                                              |
| Test runner trustworthy                | Wrapper now names `GREEN-SUMMARY-BUT-EXIT-1` and flags any file ≥45s as a latent blocker, proven against real captured data | Depends on the `SEC-632` fix                                                                                                 | A21            | A09        | Two consecutive clean full runs                              |
| Downloadable test and release reports  | Present                                                                                                                     | Re-verify after the ledger change                                                                                            | A11b           | —          | Reports download with commit id beside each                  |

### Model routing, Telegram, designs, stories, promotion

| Requirement                                       | Current state                                                                                                                        | Missing work                                                                                               | Owner       | Depends on     | Closure evidence                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------- | -------------- | ---------------------------------------------- |
| Route work across models by complexity            | Done and recorded in `docs/model-routing.md`; Fable used on owner instruction                                                        | Rebalance toward cheaper models for routine accounting after the 429                                       | lead        | —              | Roster shows mixed models                      |
| Telegram owner notifications                      | **Working.** Verified recipient, messages delivered, no receiver started, no webhook touched, YouTube automation undisturbed         | Continue milestone updates                                                                                 | lead        | —              | `message_id` per send                          |
| Stitch designs: 16 screens generated and exported | **Complete.** All 16 present plus 3 design systems; two ZIPs validated (no path traversal) and extracted                             | —                                                                                                          | lead        | —              | `design/stitch/INVENTORY.md`                   |
| Batch ZIP export capability                       | **Verified, not assumed.** Supported, capped at 16 screens per selection; the export nonetheless contained all 20 screens            | —                                                                                                          | lead        | —              | `design/stitch/EXPORT-CAPABILITY.md`           |
| Generated designs must not overwrite app code     | Enforced by rule and now by gate. 13 of 20 screens still carried `ZERO-TRUST` after an explicit correction the tool visibly accepted | Hand-write all copy; take only the visual system                                                           | A05b        | A19            | `scan-claims` green on served pages            |
| Design tokens and contrast                        | `design/tokens.css` produced: 0 contrast failures of 45 pairs light and dark, against 12 failures in the generated palette           | Integrate without breaking CSP                                                                             | A05b        | —              | Re-run a11y tests                              |
| A false AA claim in shipped code                  | `packages/ui/src/tokens.ts` claims 4.49:1 is "still AA". AA is 4.50                                                                  | Fix to `#5D6B77` (4.55:1) and add a test computing ratios from token values                                | A19         | —              | Test fails if a comment drifts from its colour |
| Development story — agent-readable                | Present and schema-validated                                                                                                         | Add today's events                                                                                         | lead        | —              | `verify-story.mjs` exit 0                      |
| Development story — visual                        | Present and served                                                                                                                   | **It publishes the events record, so story text is a public claim surface.** Now covered by the claim gate | lead        | —              | Served-page scan green                         |
| Organic posts                                     | Drafted, **awaiting owner approval**. Nothing published                                                                              | Owner approval                                                                                             | A12 + owner | owner          | Owner says publish                             |
| £15 ad allocation                                 | **Reserved and untouched.** No campaign activated, £0.00 spent of £100                                                               | —                                                                                                          | A12         | owner approval | Budget panel                                   |
| 10 genuine external visits                        | 0. Nothing promoted yet                                                                                                              | Follows approval                                                                                           | A12         | owner          | Visit analytics                                |

---

## Genuine external blockers — these need the owner, not an agent

1. **Stripe test key** and **`STRIPE_PRICE_ID`** — without them live payments cannot be enabled or tested end to end.
2. **Resend API key** and **`RESEND_FROM_ADDRESS`** — without them no notification is actually delivered.
3. **`EVENT_SIGNING_ROOT_KEY`** — 32 random bytes per environment. Without it the intake answers 503 on every signed event.
4. **A HubSpot account** — the connector is proven against mocks only, and will stay that way until a real credential exists.
5. **Sole-trader legal details** — company name, address, VAT status. `legal.ts` is `TODO_OWNER_INPUT` and the site cannot make lawful commercial claims without them.
6. **Approval to publish the organic posts.**

None of these are things I can obtain or work around, and none should be worked around.

---

## What this register does not claim

It does not claim the product is correct, secure, or ready to sell. Every row marked
closed cites a measurement; every row not marked closed is open regardless of how
confident any agent's summary was. Several rows are closed against a **local** probe and
explicitly still need reproduction against a candidate deployment — that distinction is
the difference between this register and a status report.

---

# 19 September 2026, evening — what running the deployed service actually showed

Everything below was found by sending real requests to a real deployment with real
provider credentials. None of it was visible to the local suite, which passed 2,569
cases throughout.

## Release-blocking

**GAP-501 — Email evidence is bound to a run by recency, not by correlation.**
`D1ResendWebhookDataPort.recordEmailEvidence` calls `evidence.recordProviderEvent`
without a `runId`. That method's fallback is
`SELECT r.id FROM runs r WHERE r.workspace_id = ? AND r.status = 'PENDING' ORDER BY
r.created_at DESC LIMIT 1` — the most recently created pending run in the workspace,
whatever it is for.

Observed: two pending runs existed (`…R57DX…` created 21:11:34, `…R5GQ9…` created
21:11:44). A delivery event for an email unrelated to either was attached to
`…R5GQ9…` purely because it was newer.

Two enquiries in flight in one workspace is not an edge case, it is a Tuesday. The
consequence is that one enquiry's acknowledgement can satisfy another enquiry's
check. The product's entire claim is that it tells you whether _this_ enquiry was
handled, and a correlation defect at this spot falsifies exactly that claim — while
every assertion, every status mapping and every signature check around it stays
correct. `expected.email_message_id` exists in the event envelope and is the obvious
handle; nothing currently consumes it.
Accountable: connectors/evidence owner. **This blocks release, and blocks taking the
activation notice down.**

## Closed today, with the evidence

**GAP-502 — A signed Resend callback can promote a connection to `ready`.** Was
unreachable: the resolver reported `last_check_at` as `webhookVerifiedAt`, and
`last_check_at` is never NULL on a real connection, so the route's `=== null`
promotion test could never fire. Fixed in `38f05b7` (migration 0005 adds the real
column). Evidence: staging connection promoted at 2026-09-19T20:51:16.811Z by a
genuine signed delivery. Regression test CONN-315 confirmed to fail against the old
mapping.

**GAP-503 — A malformed Stripe key no longer takes down event intake.** `POST
/api/v1/events` answered 500 on staging _and production_ because the mount built a
Stripe client it never calls and `createStripeClient` throws on a bad key. Fixed in
`cb02b02`; the stored key was also wrong and has been replaced from the sandbox.
Evidence: staging answers 401 `SIGNATURE_INVALID` to an unsigned event. MONEY-470 and
MONEY-471 confirmed to fail against the old guard.

**GAP-504 — The release gate had never passed since the browser suite joined CI.**
Two independent causes: a database name wrangler does not declare (`d50b632`), and
the screenshot test dirtying the tracked tree the gate artefact is computed from
(`5ac7be4`). Three commits shipped under a red gate, including a production deploy,
while it was described as pinned to a passing one. Evidence: CI green at `5ac7be4`.

**GAP-505 — The intake accepts a correctly signed event and creates a run.** Evidence:
`run_01M2XR57DX42B55B1CFCF74B24`, 202, PENDING, deadline honoured. Denials all
correct against the deployment: duplicate returns the same run with `duplicate:true`
and takes no second allowance unit; wrong workflow 403 `WORKFLOW_MISMATCH`; stale 422
`EVENT_STALE`; future 422 `EVENT_IN_FUTURE`; malformed 422 `EVENT_INVALID`; a
rotated-out key 401.

**GAP-506 — The plan allowance is enforced on the live request path.** Evidence:
`reserved` moved to exactly 2 for two distinct runs and did not move for the
duplicate; with the limit lowered to 2, a further event was refused 429
`ALLOWANCE_EXHAUSTED` with an accurate message. This disproves the third clause of
the activation notice.

**GAP-507 — Provider evidence reaches a run.** Evidence: two rows, `origin
provider_webhook`, `accepted` and `delivered` correctly distinguished. Correlation is
wrong (GAP-501) but the transport, signature, storage and status mapping are real.

## Open, not blocking release

**GAP-508 — Activation issues a signing key for a workflow with no current version.**
The key resolver inner-joins `workflow_versions` on `current_version_id`, so such a
key resolves to `unknown_key` and the customer is told their _signature_ is invalid.
The truth is their setup is incomplete. A customer could hold a key that can never
work and be sent to debug the wrong thing.

**GAP-509 — Provider evidence arriving before any run exists is silently dropped.**
`recordProviderEvent` writes only `WHERE EXISTS (SELECT 1 FROM runs …)`. A provider
can deliver `email.sent` before our run row is committed; that evidence is lost with
no record that it arrived.

**GAP-510 — The scheduler had never run on any deployed environment but production.**
Staging carried no cron by decision (plan §30, cost). The consequence was that the
due-run pass, outbox, allowance settlement and billing recovery sweep were first
exercised in front of customers. Revised: staging now takes a five-minute tick.
**Not yet deployed — the deploy was refused by the permission classifier and has not
been worked around.**

**GAP-511 — CI prints the seeded automation session cookie and CSRF token into public
build logs.** Per-run values against the local CI database with no remote validity, so
not an exposure of anything usable, but they should be masked rather than echoed.

**GAP-512 — Three ITISYOU Verify keys exist in Resend where one would do**, plus one
sending-only key for the test automation. The superseded two should be revoked.

**GAP-513 — The staging Resend webhook path id was exposed** in a page title captured
into a session transcript. The endpoint is signature-gated so the path alone grants
nothing, but it is meant to be unguessable. To be rotated; production must receive a
freshly generated one.

---

# 20 September 2026 — what the independent auditor found once it was switched back on

The auditor had been off. The owner noticed and said so. Four passes later, these are its
findings and their state. Every "closed" row cites the evidence rather than a summary.

## Closed

| Ref | Finding                                                                                                                                                                                      | Evidence                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3  | `POST /admin/login` answered 200 and said "a link is on its way" on live production; nothing emailed the token                                                                               | `002b8ac`. Link is now actually sent; the page says "Nothing was sent" with a reason otherwise. AUTH-420 rewritten to assert equality rather than `undefined`; OWNER-200 fails against the unfixed copy. |
| —   | Four purchase controls inert, all claiming Stripe was unconfigured on configured deployments                                                                                                 | `10dd5aa`, `ca9d062`. Checkout, portal, cancel and refund all reach the provider. BILL-297/298 fail against the restored stub.                                                                           |
| G1  | Owner refund could not submit on any deployment: no payment target passed, leaving orphan `queued_for_owner` rows                                                                            | `a374d97`. Migration 0007 stores the target from `invoice.paid`; refusal now creates nothing. BILL-400/401 fail against the unfixed port.                                                                |
| G2  | The `/admin/login` fix had no failure state, so a failed send reported "no email delivery configured" — false on production                                                                  | `a374d97`. `send_failed` is now distinct from `no_transport`. AUTH-434.                                                                                                                                  |
| D   | Two billing runtimes disagreed: `ownerPort` used `new Date()` while holding an injected `#now`                                                                                               | `a374d97`. Both ports use the port's own clock and id factory.                                                                                                                                           |
| C   | The grant path hashed whatever `policy_rule` string was pasted, so an approval could bind a rule nobody published                                                                            | `a374d97`. Validated at grant as well as at use. BILL-402.                                                                                                                                               |
| —   | `SEC-206` and `CUST-079` marked `failing` in the ledger while CI recorded them passed; three documents asserted a **security** test was broken while `security-acceptance.md` said it passed | `33a6ea3`. All four now agree, each saying it was wrong rather than quietly changing.                                                                                                                    |
| —   | 74 ledger reconciliation defects; the citable number measured an unidentifiable subset of the suite                                                                                          | `af23e90`. 74 → 0, ledger integrity PASS.                                                                                                                                                                |
| —   | The release gate had never passed since the browser suite joined CI                                                                                                                          | `d50b632`, `5ac7be4`. Two independent causes: an undeclared database name and the screenshot test dirtying the tree the gate is computed from.                                                           |

## Closed, and they were mine

| Ref       | Finding                                                                                                                                                                                                                                                                                                                                     | What I did                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| OWNER-370 | **I weakened coverage to make my own change pass.** The case proved an approval granted in the panel hashes identically to what the refund path recomputes. My rewrite asserted the response did not contain a phrase that code path cannot produce, because it returns earlier. It would have passed with two incompatible hash functions. | Restored: it recomputes `ownerPayloadHash` and asserts equality.                                  |
| —         | **I cited the wrong test as evidence.** Claimed OWNER-368's property had moved to BILL-141; BILL-141 replays with a _different_ approval, so its refusal comes from the state machine.                                                                                                                                                      | Corrected to BILL-259, verified. OWNER-369 labelled vacuous on its harness, pointing at BILL-213. |
| —         | My first BILL-400/401 did not catch the defect they named — they stopped at a missing approval and never reached the target check                                                                                                                                                                                                           | Found by running them against the old code, which is the only way that gets caught.               |

## Open

Rewritten 20 September 2026. Two rows below had stopped being true and are marked as
closed rather than silently deleted, because both were reported to the owner.

| Ref | Finding                                                                                                                                                                                                     | Why it is still open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —   | ~~No money has moved through any purchase control on a deployment.~~ **Closed 20 September**: a real sandbox Checkout Session was created by the deployed service and paid with a test card, £29.00.        | Closed. What replaces it is the row below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| —   | **The payment activated nothing.** Stripe delivered six events for it and both deployments answered every one `400 INVALID_SIGNATURE`. The path id is right — a wrong one refuses differently.              | Owner-gated: needs `STRIPE_WEBHOOK_SECRET` set per environment from each destination's own signing secret.                                                                                                                                                                                                                                                                                                                                                                                                   |
| —   | Approval single-use through the **production owner route** is covered only where a provider exists, not through that route                                                                                  | Now possible — the port takes an injectable transport — and not yet written.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| —   | HubSpot record readback unproven against a real portal                                                                                                                                                      | Credential validated against portal 149371406, connection reads `ready`, and the evidence table holds **no HubSpot row at all**. Connected is not proven, and the story page now says so in those words.                                                                                                                                                                                                                                                                                                     |
| —   | ~~10 external visits: zero, owner-gated on the campaign.~~ **Restated 20 September.**                                                                                                                       | The counter wrote nothing at all until today (`port: () => null`). It now writes: production holds one bot-classified session, one internal-test session and **one external session**. That one external row landed inside this project's own working window on a page it was checking, so the honest count of genuine outside visitors is **still zero**, not one.                                                                                                                                          |
| —   | **Our own browser traffic was counted as external, and one row still is.** A browser cannot send `x-verify-internal`, so the operator is only recognisable once the `verify_internal` cookie is set.        | Partly closed: contract rule 7 (`a77290d`) lets a later page view correct a session into an excluded class, which was confirmed working on production. It cannot correct a client that never returns, so the one remaining external row stays as recorded and is qualified wherever the figure is reported.                                                                                                                                                                                                  |
| —   | **Third-party analytics cookies from the parent domain reach this service.** `_ga`, `_ga_*` and a consent cookie are present on `verify.itisyou.app` and are therefore sent to our Worker on every request. | Not ours to set or unset. This service loads no third-party script — the Content-Security-Policy forbids it and the story page asserts exactly one inline script — so these are scoped to `.itisyou.app` by the owner's main site. We neither read nor store them, and the privacy page correctly does not list Google as a subprocessor. **For the owner:** scoping those cookies to the exact host that sets them would stop an analytics identifier being transmitted to a service that does not want it. |
| —   | The deployed commit cannot be proven from outside                                                                                                                                                           | No version marker is served, so production timing is consistent with a commit but not proof of one.                                                                                                                                                                                                                                                                                                                                                                                                          |
