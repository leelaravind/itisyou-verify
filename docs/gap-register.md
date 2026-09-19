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

| Role | State now | Evidence |
| --- | --- | --- |
| A01 product and market | **complete, not re-engaged** | `docs/product-scope.md`, `docs/competitors.md` |
| A02 architecture and data | **interrupted mid-edit** | killed at 429; was cleaning another agent's partial edit in `ownerPort.ts` |
| A03 verification engine | **idle — no owner active** | complete earlier; its `scheduler/tick.ts` now needs the money-maintenance call and nobody holds it |
| A04 provider integrations | **idle** | complete earlier against mocks; never re-engaged this session |
| A05 customer experience | complete; successor **interrupted** | A05 delivered; A05b killed at 429 mid-screenshot pass |
| A06 commerce | successor **complete** | notifications wired for 2 of 12 templates with real DB state |
| A07 owner operations | complete; successor **interrupted** | A07 browser suite green 24/17; A07b killed at 429 |
| A08 AI and maintenance | **complete, not re-engaged** | assistant and maintenance runner |
| A09 customer care and privacy | **idle — and it owns a release blocker** | owns `SEC-632` and 5 of the 10 unreached notification templates |
| A10 security reviewer | **idle** | complete earlier; not re-engaged this session |
| A11 QA and release | complete; successor **interrupted** | A11b killed at 429, but its CI gate artefact code did land in `release.mjs` |
| A12 growth and launch | **idle** | owns the organic posts awaiting owner approval |
| Auditor (A20) | **interrupted** | killed at 429 while testing the review page's four controls |

**Genuine concurrency constraint, stated plainly:** running eleven agents concurrently,
most of them on the strongest model, exhausted the session allowance and destroyed all of
their in-flight work at once. That is a real limit, not a tuning preference. The roster is
therefore being restarted smaller, with routine accounting work routed to cheaper models.

**Unknown:** whether any interrupted agent left a file in a partially-edited state that
typechecks but is semantically half-done. `tsc` is clean at `5b7c450`, which rules out
syntactic damage and rules out nothing else.

---

## Gap register

Legend — **Closure evidence** means what would have to be true to close the row, and is
deliberately phrased as a measurement, not an assertion.

### The two closed states, kept apart on purpose

A row is never just "closed". It is closed at one of two levels, and collapsing them is
how a status report starts lying without anyone deciding to.

| State | What it means | What it does **not** mean |
| --- | --- | --- |
| **LOCAL-TESTED** | Proven by a real request against a locally running Worker, with the resulting database state read back | That it works on staging or production. Local `wrangler dev` has different bindings, different secrets, no cron, and a different D1 |
| **DEPLOYMENT-VERIFIED** | The auditor re-issued the requests itself against a candidate deployment and read the state itself, and recorded the commit it reproduced against | That the feature is correct in every case — only that this evidence is real |

Nothing may be reported to the owner as done on the strength of LOCAL-TESTED alone.
Today, `POST /api/v1/events` is LOCAL-TESTED and nothing on this project is
DEPLOYMENT-VERIFIED, because the auditor's reproduction pass has not completed.

A third level exists implicitly and is worth naming: **UNIT-TESTED ONLY**, which this
project has repeatedly found to mean nothing at all. Four separate workstreams shipped
correct, thoroughly tested code that no request could reach — the events route, the
refund consumption, the notification templates, and the allowance reconciliation. A
passing unit test is evidence about a function, not about a product.

### Money path, billing and entitlements

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| `POST /api/v1/events` intake exists and is reachable | **LOCAL-TESTED 19 Sep.** Answered 404 in every deployment until today. Now mounted; an unsigned POST returns `401 SIGNATURE_INVALID` through the real entry point | — | lead | — | Live request against local worker, recorded in commit `5b7c450` |
| Intake works on a deployment with no Stripe key | **LOCAL-TESTED 19 Sep.** Returned 500 on every request; `createStripeClient` throws on an empty key and the module had documented that as safe | — | lead | — | Same live probe: 500 before, 401 after |
| Allowance granted exactly once across retries and duplicate webhooks | Proven in integration against real SQLite: one grant, one notification, replay adds nothing | Same proof against a **candidate deployment**, not a local harness | A16 | deploy | Duplicate Stripe delivery to staging; read `entitlements` back |
| Allowance-period identity standardised, historical rows reconciled | **Now reachable.** The tick calls `runMoneyMaintenance`, which had no caller at all despite its own doc comment naming the tick as its caller. Wired so billing maintenance runs ONCE per tick and two consumers share the report — running it twice is the precise shape of the exactly-once allowance defect | Deployed proof; no tick has run with this wiring anywhere | lead → integration | deploy | Cron tick on staging, then read the allowance row back |
| Day-8 suspension marks `unpaid`, deletes nothing | Proven in integration: subscription `unpaid`, `consumed 37` survives, workspace not deleted | Deployed proof | A16 | deploy | Staging tick at day 8 boundary |
| Signing keys can be issued to a customer | **Nothing calls `issueWorkflowSigningKey`.** No customer can obtain a key, so no customer can send a signed event | Wire issuance into the activation page | A05b | A16's spec | A real key issued, then a signed event admitted |
| `EVENT_SIGNING_ROOT_KEY` provisioned | Absent. Route mounts and, by design, answers 503 on a signed event | `wrangler secret put` per environment | lead + owner | — | Signed event to staging returns 202 |
| 503-not-401 when the root key is missing but the key id is real | **Unverified.** Today's probe used an unknown key id, which correctly short-circuits to 401 before the root key is read | Seed a workflow, then probe | A20 | seeded workflow | Probe returns 503 `SIGNING_KEY_UNREADABLE` |

### Approvals and owner controls

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| Approval validated **and consumed** on every approval-required action | **LOCAL-TESTED.** `issueRefund` — the owner panel's actual button — now consumes via compare-and-set. Double-submit proved: first press 422, second 422, `approvals.status=consumed` once, audit shows blocked then refused | Deployed proof | integration | deploy | Re-issue the double-submit against a candidate |
| `decideRefund` still has no production caller | Correct code, unreachable. Deliberately left: it is not the wired path, and wiring a second refund route would be worse than leaving one unused | Decide: delete it or make it the path | integration | — | One refund path, not two |
| Quality dispatch reachable | **LOCAL-TESTED.** Produces a real `quality_runs` row, `awaiting_runner`, with a real dedupe key | Deployed proof | integration | deploy | Owner action on staging produces the row |
| Cleanup preview and run reachable | **LOCAL-TESTED.** Produces a `cleanup_runs` row in `preview` with a real `inventory_hash`; approval spent before the first delete | Deployed proof | integration | deploy | Preview on staging returns a hash from real data |
| Campaign activation consumes an approval | **LOCAL-TESTED.** Compare-and-set; double-submit consumes once. This is what now protects the reserved £15 in code rather than by nobody having pressed the button | Deployed proof | integration | deploy | Activation without approval refused on a candidate |
| **Spending ceilings were changeable without approval** | **LOCAL-TESTED, was a live hole.** `owner.budget_limits` sat in the same `writeSetting` allowlist as the business address. `owner/settings.ts` documented it as approval-bound; nothing enforced it. `platform:advertising` is `1500` — the reserved £15 | Deployed proof | integration | deploy | Ceiling change without approval refused on a candidate |
| **Deployment restore accepted any granted approval** | **LOCAL-TESTED, was a live hole.** `POST /owner/operations/restore` checked only that *an* approval was granted and unexpired, so a `cleanup_execute` approval read as authorisation to replace the running code every customer is served. It also ignored the `deployment_id` on its own form while telling the operator it was recorded. Two existing tests had codified the hole and were rewritten to assert refusal | A `deployment_restore` action type — a new type, not a fix, so not added unilaterally | lead decision | — | Restore refused without a matching approval type |
| `execute_approved_release` job approval | **Open, latent.** `enqueueJob` requires only a non-null `approvalId` string — any fabricated, expired or consumed id passes. Currently unreachable because the kind is not dispatchable | Load, validate and consume before the job row is written | A08 | — | Fabricated id refused |
| Evidence records distinguish a real provider read-back from a mock | **Contract added, no producer yet.** A test double and a genuine read-back produced byte-identical records: `origin` records the channel, not whether the channel was real, and `fetchImpl` is injectable. `EvidenceTransport` now exists on the contract | Connector must set it, and `live` must be unforgeable from test wiring | verification/connectors | — | A test that fails if a stubbed fetch can produce `transport: live` |

### Customer flows and authenticated UI

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| Purchase and activation paths disabled while unverified | Done. Four controls rendered inert with no focusable element and no `type="submit"` | — | A05 | — | `tests/unit/ui/activation.test.ts`, 12 cases, shown red before the fix |
| Seven-day recovery policy shown **before** checkout | `preCheckoutPanel` now has a caller and renders above the CTA | Confirmed in source, **not** in a browser against the deployed page | A20 | deploy | Fetch the review page; read the policy on it |
| Authenticated customer UI measured at 390/834/1440 | **Unmeasured.** 16 cases skip with `CUSTOMER_WORKSPACE_MISSING` | Seed a synthetic workspace + read-only `workspace_viewer` membership | A02 | — | The 16 cases run and pass |
| Seed script works on Windows | Broken: `execFileSync` with `shell:true` unquoted splits the SQL | One-line change to `--file` | A02 | — | Script seeds first time |
| Four statuses readable without colour | **Release-relevant defect.** The four status colours sit at 1.01–1.11:1 against each other in dark mode — in greyscale all four are the same mark | Implement glyph + label set; audit every status render site | A05b | A19's tokens | Greyscale screenshot; all four distinguishable |
| Empty, loading, failure, permission-denied states on every screen | Partially present; no complete matrix exists | Per-screen audit and the missing states | A05b | — | State-coverage matrix per screen |
| Proportional meters round down | Enforced via fill classes after the 33%→100% incident | Re-verify after design integration | A05b | — | 33% renders as `meter__fill--30` |

### Notifications and support

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| Customer told clearly that verification is paused | **Wired and proven.** Stripe webhook → delivery → transport, with duplicate delivery producing exactly one email | Deployed proof | A06b | deploy | Staging webhook; one `notification_deliveries` row |
| Remaining 10 of 12 templates reachable | Unreached: sign-in link, welcome, export ready, deletion scheduled/completed, allowance approaching/reached, first material failure, recovery, provider disconnected | Each needs its owner's trigger | A09, A02, A16, A03 | — | One live send per template |
| "Payment recovered, runs resumed" notification | **No template exists.** Deliberately not invented | Add `payment_resumed`; needs a `resumedToServing` signal from the money path | A06b + A16 | A16 | Recovery event produces exactly one email |
| `RESEND_FROM_ADDRESS` provisioned | Absent. Nothing is actually sent; recorded as `no_email_transport_configured` | `wrangler secret put` | owner | — | A real email delivered |

### Security and resilience

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| No unearned public claim ships | **LOCAL-TESTED 19 Sep.** `scripts/scan-claims.mjs` added and wired into the release gate; proven to exit 0 on the tree and 1 on a planted claim | Keep the served-pages pass running post-deploy | lead | deploy | Gate output per release |
| `SEC-632` blocks its worker for 218s | Root-caused by two agents independently. Not a pool-pressure problem; a synchronous `execFileSync` holding the event loop past birpc's fixed 60s timer | Make it async, split it, or move it out of vitest into the release gate | A09 | — | Full suite green with no unhandled RPC error |
| `SEC-206` tenant scope in the predicate | Failing | Fix | A02 | — | Case passes |
| Migration 0002 forward-compatibility | **Known unresolved.** A previous Worker writing the older AAD shape would be rejected by the CHECK constraint | Decide: widen, or accept with a documented rollback restriction | A02 + lead | — | Stated decision with reasoning |
| Backup restoration proven | **DEPLOYMENT-VERIFIED.** Run against real remote D1, not a local harness. Proven on real D1: 2 tenants, 0 cross-tenant leaks, byte-identical digests, statuses preserved; both drill DBs deleted | — | lead | — | Recorded in the story |

### Test reporting and cleanup

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| ≥500 distinct meaningful passing tests | 2,065 countable passing at a pinned read; 2,205 with `SEC-*` included | The number must come from CI on a clean checkout. `release.mjs` now refuses production unless the gate artefact matches HEAD | A11b | CI run | `release-gate-<sha>.json` produced by GitHub Actions at HEAD |
| Test inventory reconciled | Seven buckets reconcile with nothing left over; the "29 unexplained" had no irreducible core | Apply explicit per-case `category` to 156 `SEC-*` entries; no renames | A11b | — | Twelve floors recomputed exactly |
| 61 duplicate test ids | 8 are one agent colliding with itself; 5 need coordination | Fix | A11b + A07/A09 | — | Zero duplicates |
| Test runner trustworthy | Wrapper now names `GREEN-SUMMARY-BUT-EXIT-1` and flags any file ≥45s as a latent blocker, proven against real captured data | Depends on the `SEC-632` fix | A21 | A09 | Two consecutive clean full runs |
| Downloadable test and release reports | Present | Re-verify after the ledger change | A11b | — | Reports download with commit id beside each |

### Model routing, Telegram, designs, stories, promotion

| Requirement | Current state | Missing work | Owner | Depends on | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| Route work across models by complexity | Done and recorded in `docs/model-routing.md`; Fable used on owner instruction | Rebalance toward cheaper models for routine accounting after the 429 | lead | — | Roster shows mixed models |
| Telegram owner notifications | **Working.** Verified recipient, messages delivered, no receiver started, no webhook touched, YouTube automation undisturbed | Continue milestone updates | lead | — | `message_id` per send |
| Stitch designs: 16 screens generated and exported | **Complete.** All 16 present plus 3 design systems; two ZIPs validated (no path traversal) and extracted | — | lead | — | `design/stitch/INVENTORY.md` |
| Batch ZIP export capability | **Verified, not assumed.** Supported, capped at 16 screens per selection; the export nonetheless contained all 20 screens | — | lead | — | `design/stitch/EXPORT-CAPABILITY.md` |
| Generated designs must not overwrite app code | Enforced by rule and now by gate. 13 of 20 screens still carried `ZERO-TRUST` after an explicit correction the tool visibly accepted | Hand-write all copy; take only the visual system | A05b | A19 | `scan-claims` green on served pages |
| Design tokens and contrast | `design/tokens.css` produced: 0 contrast failures of 45 pairs light and dark, against 12 failures in the generated palette | Integrate without breaking CSP | A05b | — | Re-run a11y tests |
| A false AA claim in shipped code | `packages/ui/src/tokens.ts` claims 4.49:1 is "still AA". AA is 4.50 | Fix to `#5D6B77` (4.55:1) and add a test computing ratios from token values | A19 | — | Test fails if a comment drifts from its colour |
| Development story — agent-readable | Present and schema-validated | Add today's events | lead | — | `verify-story.mjs` exit 0 |
| Development story — visual | Present and served | **It publishes the events record, so story text is a public claim surface.** Now covered by the claim gate | lead | — | Served-page scan green |
| Organic posts | Drafted, **awaiting owner approval**. Nothing published | Owner approval | A12 + owner | owner | Owner says publish |
| £15 ad allocation | **Reserved and untouched.** No campaign activated, £0.00 spent of £100 | — | A12 | owner approval | Budget panel |
| 10 genuine external visits | 0. Nothing promoted yet | Follows approval | A12 | owner | Visit analytics |

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
