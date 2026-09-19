# ITISYOU Verify — release test plan and launch gate

Owned by **A11 (QA and Release)**. The machine-readable ledger is
[`docs/test-cases.json`](test-cases.json); the checker that proves the ledger is honest is
[`scripts/verify-test-cases.mjs`](../scripts/verify-test-cases.mjs).

This document says what must pass before the product is sold to anyone, what a failure
means, and — the part that matters more — what a fully passing suite still does **not**
prove.

---

## 1. The gate

Commercial launch is blocked until **all** of the following are true on one release
candidate commit:

| # | Condition | How it is proved |
| --- | --- | --- |
| G1 | The ledger holds at least **500 distinct, meaningful cases** and every category meets its minimum | `pnpm verify:cases` exits 0 |
| G2 | Every case id in a test title exists in the ledger, and every ledger case marked implemented has a test | `node scripts/verify-test-cases.mjs --strict` exits 0 |
| G3 | Every **blocking** case (§7) passes on the release candidate | `pnpm test` and `pnpm test:e2e` reports, read case by case |
| G4 | No blocking case is skipped, quarantined, `.skip`ped or `todo` | the quality-run record separates skipped from passed |
| G5 | `pnpm typecheck` and `pnpm lint` pass with zero warnings | CI job output |
| G6 | `pnpm scan:secrets` finds nothing in the tree, the full git history and build output | CI job output |
| G7 | Migrations apply forward onto the previous release's schema, and the previous release's code still runs against the new schema | RESIL-013, RESIL-014 |
| G8 | Every case recorded as passing was actually executed — no self-reported counts | quality-run counts come from the JUnit report, never the request |

**What a failure means.** A failure at G1 or G2 means the count is not honest yet and
nothing downstream can be trusted; fix the ledger or the test titles, never the minimums.
A failure at G3 means the product has a defect in a path a paying customer will reach —
the release stops. A failure at G4 means somebody made the gate green by hiding something,
which is the only failure mode on this list that is a conduct problem rather than a bug.

**The gate is not a percentage.** There is no "95% of cases pass" state. A blocking case
either passes or the release does not go.

---

## 2. Scope of the ledger

Every case is grounded in something that exists: an operator or limit in
`packages/contracts/src/`, a table or constraint in `migrations/0001_init.sql`, or a
settled commitment in `docs/product-scope.md` / `README.md` / `SECURITY.md`. Cases for
features not yet built (owner panel, assistant, ad adapter) carry `status: "planned"`, but
each requirement is one this system will actually have.

Current ledger totals, printed by the checker:

| Category | Planned | Minimum | unit | integration | e2e |
| --- | ---: | ---: | ---: | ---: | ---: |
| `verification_logic` | 103 | 65 | 97 | 4 | 2 |
| `connector_contracts` | 51 | 45 | 28 | 21 | 2 |
| `persistence_concurrency` | 49 | 45 | 3 | 44 | 2 |
| `auth_tenancy` | 60 | 55 | 9 | 45 | 6 |
| `commerce` | 53 | 50 | 12 | 36 | 5 |
| `customer_lifecycle` | 47 | 45 | 6 | 19 | 22 |
| `owner_panel` | 47 | 45 | 9 | 32 | 6 |
| `api_security_privacy` | 55 | 45 | 36 | 17 | 2 |
| `budgets_models_maintenance` | 38 | 35 | 16 | 19 | 3 |
| `advertising_analytics` | 27 | 25 | 12 | 13 | 2 |
| `accessibility_resilience` | 30 | 30 | 8 | 8 | 14 |
| `stories_release_hygiene` | 18 | 15 | 12 | 4 | 2 |
| **Total** | **578** | **500** | **248** | **262** | **68** |

Two cases are `provider_backed` (CONN-050, CONN-051). The checker caps that number at six.

### On the level split

The brief's guidance was roughly 250 / 150 / 100. The ledger lands at 248 / 262 / 68.
That is a deliberate departure, stated rather than hidden:

- **Integration is over-weight (262 vs ~150)** because the highest-consequence behaviour in
  this product — tenant scoping, idempotency under concurrency, lease reclamation, webhook
  ordering, quota races — is only provable where a real D1 database and real transactions
  are involved. A unit test with a mocked repository proves the mock, not the constraint.
- **e2e is under-weight (68 vs ~100)** because the alternative was inventing browser tests
  for logic that has no browser in it. A Playwright test that drives a login in order to
  assert a status-code decision is a slow, flaky restatement of a unit test. The e2e cases
  that exist are there because the browser is genuinely the subject: rendering, keyboard
  operation, focus, layout under zoom and at 320px, print output, and the four customer
  journeys end to end.

If the lead wants the split moved towards the guidance, the honest way is to add e2e cases
for journeys not yet covered, not to reclassify existing integration cases.

---

## 3. Test-design techniques actually used

Not a list of techniques we admire — a list of where each one produced cases in the ledger.

**Equivalence classes.** Each operator in `rules.ts` is partitioned into the classes that
behave differently, not into arbitrary examples. For a single-value operator those classes
are: present-and-matching, present-and-differing, authoritative empty (`null` / `''`),
provider-omitted (`undefined`), and spec-unusable. That partition is why `equals` has five
cases rather than one, and why `not_equals` has a separate UNKNOWN case — "the value is
not X" cannot be established from a value that is not there.

**Boundary values.** Every bound in `LIMITS` and every comparison in `packages/domain` is
tested at the boundary and one step either side, and the ledger says so in the requirement
text: `occurred_within` at exactly N seconds and at N+1ms; a delta of exactly zero;
`MAX_ASSERTIONS_PER_WORKFLOW` at 10 and 11; `MIN_/MAX_DEADLINE_SECONDS` at 59/60 and
3600/3601; `MAX_OBSERVATIONS_PER_RUN` at 4; `MAX_TRANSIENT_RETRIES_PER_OBSERVATION` at 3;
`PLAN_RUNS_PER_PERIOD` at 500 and 501; `canReserve` at exactly-available and one penny
more; the deadline comparison at exactly `deadlineAt`. A parameterised example counts as a
separate case only when its input is one of these documented business boundaries or a
distinct failure condition.

**Role matrices.** `auth_tenancy` is built from the cross product of {anonymous,
workspace_viewer, workspace_admin, platform_owner, automation session} against
{read own, read foreign, mutate own, mutate foreign, billing, owner panel}. Only the cells
whose expected outcome differs became cases; cells that collapse to the same denial through
the same code path did not.

**State-transition coverage.** `nextRunState` is covered for every legal edge and for the
illegal ones that must throw 409 — including the two that matter most: late evidence
against a still-PENDING run, and any non-late event against a decided run. The same
approach covers `ORDER_STATUS`, `SUBSCRIPTION_STATUS`, `CAMPAIGN_STATE`, `JOB_STATE`,
`CONNECTION_STATUS` and the cleanup-run lifecycle.

**Concurrency interleavings.** Explicit two-writer races at the points where a lost update
costs money or correctness: quota at the 500-run boundary, budget reservation at the
available boundary, lease acquisition, approval consumption, order and refund idempotency
keys, and outbox dispatch.

**Delayed and duplicate events.** Provider webhooks are retried and arrive out of order, so
cases exist for: the same Stripe event four times; an older `provider_event_created`
arriving after a newer one; the same HubSpot webhook replayed outside tolerance; late email
evidence creating a revision rather than mutating a decided run; a provider cost reported
after its reservation was already released.

**Controlled fault injection.** Every connector failure mode in `CONNECTOR_ERROR_CODE` is
injected through a stub, plus: a D1 binding that fails, a fetch that never settles, a
dispatcher that throws before and after its commit point, a runner that stops
heartbeating, and a cleanup interrupted mid-execution.

**Outcome coverage — the four answers.** Every category carries cases for expected
**success**, expected **denial**, expected **failure** and expected **unknown**. The fourth
is the one teams forget and the one this product lives on: `UNVERIFIED` is not a failure,
and the ledger has cases proving that an expired credential, a rate limit, an ambiguous
CRM match, an unparseable timestamp, a customer-claim-only evidence set and a deadline
missed during an outage all resolve to unknown rather than to a false accusation.

---

## 4. Honesty — what a passing suite does not prove

Read this before quoting the number to anyone.

**Mocked providers are not a working integration.** All but two connector cases drive a
stubbed `fetch`. They prove our adapter behaves correctly *given the payload shape we
assumed*. They cannot detect that HubSpot renamed a field, that Resend introduced an event
type we map to nothing, that a scope we request no longer grants what it used to, or that
an endpoint we call was deprecated. The two `provider_backed` cases exist precisely because
mocks cannot see any of that — and two authorised reads are a smoke test, not coverage.

**Emulated mobile is not a physical device.** The 320px and 375px cases run in a desktop
browser with a resized viewport. They prove layout and keyboard operation. They do not
prove touch target ergonomics, on-screen keyboard behaviour, iOS Safari quirks, real
network latency, or how the page behaves on a three-year-old Android phone on a train.

**A green accessibility scan is a floor, not a pass.** Automated checks catch contrast,
labels and landmarks. They do not prove the product is usable with a screen reader by
someone who actually depends on one. Nobody has tested this product with a real assistive
technology user.

**Passing tests say nothing about whether anyone wants this.** 578 cases green is a
statement about correctness, not about demand, pricing, positioning or whether an agency
will change their n8n workflow to call us. The product may be entirely correct and
commercially worthless. No test in this ledger can tell the difference.

**Other things the suite does not prove:** that the Worker stays inside Cloudflare's CPU and
subrequest limits under real traffic; that D1 performs acceptably at a scale we have never
run; that Stripe's live mode behaves like its test mode; that our backup can be restored by
a person under pressure at 3am rather than by a test harness; that the founder's budget
holds once real advertising runs; that the redaction rules cover a payload shape a real
customer's CRM will contain.

**And one about the count itself.** 578 planned cases is a plan. As of this writing
**415 of them have no test at all**, and 286 case ids appear in test titles that
correspond to no designed case (§6). The gate is only real once G1 and G2 both pass.

---

## 5. Flake policy

1. **The first failure is kept.** It is recorded against the release candidate with its
   full output. It is not deleted, amended or re-run away.
2. **A passing rerun does not erase the original failure.** It adds information — the
   failure is intermittent — and nothing else. The record shows both runs.
3. **Root cause before requeue.** An intermittent failure is investigated for its cause
   (time dependence, ordering dependence, a real race, shared state between tests) before
   anyone re-runs it. "It passed the second time" is not a diagnosis.
4. **A flaky test is a defect in the test or in the code, never in the weather.** Most
   flakes in this product will be genuine concurrency or time bugs, because the product is
   built on leases, deadlines and a one-minute cron. Treat a flake there as a production
   incident found early.
5. **A blocking case may never be quarantined to make the gate green.** Not marked
   `.skip`, not moved to a nightly suite, not wrapped in a retry. If a blocking case is
   unreliable, the release waits.
6. **Retries are not permitted in the deterministic suites.** Vitest runs with no automatic
   retry. Playwright may retry only in CI and only for non-blocking cases, and any retried
   pass is reported as a retried pass, never as a clean one.
7. **Quarantine, when used at all, is time-boxed and visible.** A non-blocking case may be
   quarantined for at most one release with a named owner and a dated reason recorded in
   the ledger's `status` field. A quarantined case is not counted towards the 500.

---

## 6. Known reconciliation defects (open, as of this plan)

The checker cross-reads `tests/**/*.{test,spec}.ts` and reports what it finds. Today it
reports two defects and a large divergence. All three are real and none is fixed by
editing the ledger:

1. **`SEC-xxx` prefix is outside the allowlist.** 102 case ids across seven files under
   `tests/security/` use a `SEC` prefix that does not appear in `docs/agent-brief.md`.
   Those cases cannot be counted towards the 500 until they are renamed to an allowlisted
   prefix (`API` for validation/security/privacy, `AUTH` for auth/tenancy). This is A02's
   to fix, or the lead's to fix by adding `SEC` to the brief's allowlist — either is
   legitimate, but the two documents must agree.
2. **`PERSIST-000`** appears in `tests/integration/db/harness.test.ts`. Numbering starts at
   001.
3. **The ledger's numbering and the implemented tests' numbering were assigned
   independently and collide.** 286 implemented ids have no ledger case and 415 ledger
   cases have no test. The same id — `VERIFY-012`, say — means one thing in this ledger and
   something else in `tests/unit/domain/evaluate.test.ts`. **The ledger is the design of
   record**; the implementation pass reconciles test titles to it. The alternative — rebasing
   the ledger onto ids that were assigned before any ledger existed — would make the plan a
   description of what happened rather than a specification of what must hold.

`node scripts/verify-test-cases.mjs --strict` fails while any of these stand. The plain
run reports them and exits 0, so the ledger's own integrity can be checked independently of
other agents' in-flight work.

---

## 7. Blocking cases and accepted risks

### Blocking — the release does not go without these

| Area | Blocking scope | Why |
| --- | --- | --- |
| `verification_logic` | **All 103.** | A false `VERIFIED` or a false `FAILED` destroys the only thing the product sells. There is no case here we would ship broken. |
| `commerce` | **All 53.** | Every one is either money moving wrongly, money moving twice, or service given away. |
| `auth_tenancy` | **All 60.** | Cross-tenant access in a product whose asset is other people's CRM evidence is unrecoverable. |
| `api_security_privacy` | **All 55.** | Public repository, public endpoint, customer-controlled data rendered back to a browser. |
| `persistence_concurrency` | **All 49.** | Idempotency and tenant scope are enforced here or nowhere. |
| `connector_contracts` | 49 of 51 — all except the two `provider_backed` cases | The stubbed cases are blocking. The two real-provider cases are blocking only when credentials are authorised (see below). |
| `budgets_models_maintenance` | Budget ledger arithmetic and the assistant boundary (BUDGET-001…BUDGET-016), plus the reservation races (BUDGET-017…BUDGET-023) | Rule 9 — a model must never decide verification, access or money — is a launch condition, not a nice-to-have, and a budget that can be overspent is not a budget. |
| `owner_panel` | Approval binding (OWNER-001…OWNER-013), runner authorisation (OWNER-021…OWNER-030) and cleanup safety (OWNER-031…OWNER-037) | These are the controls that stop the operations panel spending money, executing untyped work, or deleting a customer. |
| `customer_lifecycle` | Signup, connection, rules, first run, report, cancellation, export, deletion | The paths a paying customer cannot route around. |
| `accessibility_resilience` | Contrast, keyboard operation, labels, focus, and the outage/rollback/backup cases | Accessibility failures exclude users; the resilience four are what make a bad release undoable. |
| `stories_release_hygiene` | The secret scan, the public-artifact check and the claims map | A committed credential in a public repository, or a claim we cannot support, is worse than a bug. |

### Documented accepted risks — known gaps we are launching with

Each of these is a deliberate decision, not an oversight. Each names what could go wrong.

| Accepted risk | What we are accepting | Mitigation |
| --- | --- | --- |
| **Real provider payload drift** | Only 2 of 51 connector cases touch a real provider. HubSpot or Resend can change a field or an event type and every mock will stay green. | The two provider-backed smoke cases run before each release when credentials are authorised; connector errors surface as `UNVERIFIED`, never as a false `VERIFIED`. |
| **No physical device testing** | Mobile is emulated only. | The layout cases run at 320px and 375px; the founder checks the four main pages on a real phone before launch as a manual step, recorded as such. |
| **No real assistive-technology user testing** | Automated checks and keyboard traversal only. | Documented publicly rather than claimed as accessible; SECURITY.md's tone rules already forbid a compliance claim. |
| **`advertising_analytics` is non-blocking** | 27 cases, none blocking launch of the core product. A campaign defect costs advertising budget, not customer correctness. | Campaign spend is capped by `BUDGET.ALLOC_ADVERTISING_PENCE` and gated on an owner approval bound to the exact packet hash. No campaign runs before the core gate passes. |
| **Assistant features are non-blocking** | `ASSISTANT_MODE` defaults to `off` and the core service has no model dependency. | The boundary cases (a model can never decide status, access or money) are blocking; the assistant's own usefulness is not. |
| **No load testing at scale** | The 500-run page case is the largest thing measured. | `PLAN_RUNS_PER_PERIOD` bounds a single workspace; the dispatcher's batch bound and the partial index bound the scheduler. Re-open this before the second paying customer, not the first. |
| **No penetration test** | An automated security suite is not an adversarial review. | SECURITY.md already states this plainly and offers a private reporting route rather than claiming certification. |

---

## 8. Execution strategy inside the budget

The founder's authorised total is £100 (`BUDGET.TOTAL_INITIAL_PENCE = 10_000` pence). The
test suite must cost approximately nothing to run, and must be runnable by anyone who
clones a public repository.

**Deterministic suites — run locally and in public CI, on every push.**

```bash
pnpm typecheck
pnpm test          # vitest: tests/unit/**, tests/integration/** — outbound fetch is blocked
pnpm test:e2e      # playwright, against a local worker with a local D1
pnpm verify:cases  # ledger integrity + reconciliation
pnpm scan:secrets
```

Everything in those suites uses synthetic fixtures. `tests/setup.ts` fails loudly on any
outbound `fetch`, which is the mechanism that makes "we never contacted a real provider" a
fact rather than an intention. No paid model call is made from any test: `ASSISTANT_MODE`
is `off` in the test environment and the model router refuses a paid tier without a budget
reservation, which the test harness never grants.

**Real-provider checks — few, authorised, capped.**

- Exactly two (`CONN-050`, `CONN-051`). Each is a **single read** against a provider test
  or developer account seeded by us.
- They **skip, not fail**, when their credential is absent. That is deliberate: a public CI
  run on a fork must not go red because it has no secret.
- They never write, never send, and never touch a real customer's account.
- Stripe is exercised in **test mode only**, through Stripe's own test cards. No live-mode
  call is made from any test, and `RESIL-008` fails the build if `STRIPE_MODE` and the
  secret disagree.

**What is explicitly not done, and will not be:**

- No 500 real emails. Resend is stubbed everywhere except the one authorised read; the
  magic-link e2e cases capture the message from a stubbed transport.
- No 500 live charges. Checkout and webhook cases drive stubbed Stripe payloads with real
  signature verification — the signature is real, the money is not.
- No purchased clicks. Every advertising case runs against a stubbed ad adapter. A campaign
  is only ever created by a person, behind an owner approval bound to the packet hash.
- No Cloudflare resource outside `verify-itisyou-*` is touched by any test. Staging has no
  cron triggers by design, so a test environment cannot generate recurring cost.

**Cost ceiling for the whole gate:** the deterministic suites are £0. The two
provider-backed reads are on free provider tiers. The only real spend the gate can cause is
Cloudflare usage on the staging deployment, which is inside the existing account plan.

---

## 9. Running the checker

```bash
pnpm verify:cases                          # ledger integrity + reconciliation report
node scripts/verify-test-cases.mjs --strict  # release gate: test-tree defects also fail
node scripts/verify-test-cases.mjs --json    # machine-readable summary for CI
```

The checker uses Node built-ins only and has no dependencies. It fails with exit code 1,
and a specific message, when any id is duplicated, malformed or off-allowlist; when a
category is below its minimum or the total is below 500; when a required field is missing
or a `requirement`, `risk`, `setup` or `expected` is empty; when two cases share an
identical `requirement` + `setup` pair; when a `level` or `status` is outside its allowed
set; when numbering within a prefix is not sequential from 001; or when a case claims a
status beyond `planned` with no matching test title.

A passing checker proves the plan is honest. It does not prove a single test passes. That
is what G3 is for.
