# ITISYOU Verify — release test plan and launch gate

Owned by **A11 (QA and Release)**.

- Ledger: [`docs/test-cases.json`](test-cases.json) — one entry per case that exists.
- Checker: [`scripts/verify-test-cases.mjs`](../scripts/verify-test-cases.mjs) — proves the ledger is honest.
- Report: `scripts/build-test-report.mjs` — runs the suite and writes `reports/`.

The ledger **describes the suite that exists**. It is harvested from the test tree and the
recorded run, not written ahead of the code. A design document that disagrees with the
code is not a gate; it is a second opinion.

---

## 1. Measurement snapshot

| | |
| --- | --- |
| Commit | `866c359` |
| Working tree | dirty during measurement — other agents were committing throughout |
| Runners | Vitest 3.0.9 (`tests/unit`, `tests/integration`, `tests/security`); Playwright (Chromium, `tests/e2e`) against a real `wrangler dev` |

**The tree moved while I measured it.** Between my first and last pass the suite grew from
31 files to 122 and from ~550 cases to ~2,000. Every number below is a point-in-time
reading at `866c359`, reproducible by the method in §3. It is not a claim about any later
commit.

### The four numbers

| Measure | Count |
| --- | ---: |
| **Distinct cases** | **2,079** |
| **Passing** | **2,024** |
| **Failing** | **22** |
| **Skipped or quarantined** | **4** |

The remainder of the 2,079: **15 unmeasured** (the test exists but was added after the
recorded run) and **14 planned** (designed, no test written yet). Nothing is double
counted: 2,024 + 22 + 4 + 15 + 14 = 2,079.

**Counting towards the launch floor: 1,883.** That is lower than 2,024 because a case only
counts when it is *both* passing *and* countable — see §3.

---

## 2. The gate

| # | Condition | Status at `866c359` |
| --- | --- | --- |
| G1 | ≥ 500 distinct passing countable cases | **met** — 1,883 |
| G2 | Every category meets its floor | **NOT met** — `accessibility_resilience` is at 5 of 30 |
| G3 | Zero failing cases | **NOT met** — 22 failing |
| G4 | No blocking case skipped or quarantined | **met** — the 4 skips are non-blocking and declared (§5) |
| G5 | Ledger agrees with the tree (`--strict`) | **NOT met** — 31 defects, almost all the `SEC` prefix (§6) |
| G6 | `pnpm scan:secrets` clean, tree and history | **tree clean; `--history` red** (§7) |
| G7 | `pnpm typecheck` and `pnpm lint` clean | owned by the lead's CI job |
| G8 | Migrations apply forward and the previous release runs against the new schema | **no test exists** — RESIL-903/904, planned |

**A failure means the release stops.** Not "is investigated in parallel with shipping".
There is no percentage state: a blocking case either passes or the release waits.

---

## 3. How the numbers are counted — reproduce without reading the script

An independent auditor should be able to get the same figures. This is the whole method.

### Step 1 — what counts as a case

A case is **one id**, of the form `PREFIX-NNN`, appearing in a test title. The twelve
allowed prefixes are in `docs/agent-brief.md`.

- A case counts **once**, whatever the parameterisation. Three viewports driven from one
  test body are one case. Two browsers are one case. A rerun is an execution, not a case.
- An id used by **two different test files is a defect, not two cases**. The ledger keeps
  the first and reports the collision; today 32 executions reuse an existing id.
- A token like `SHA-256` is not a case id. The checker holds a short denylist of such
  prefixes (`SHA`, `AES`, `RFC`, `WCAG`, …).

### Step 2 — what makes a case *countable*

`countable = true` requires **both**:

1. the prefix is on the allowlist, and
2. the number is exactly three digits and is not `000`.

Everything else is `countable = false` and is worth **zero** towards every floor, however
well it passes. Today that is 156 `SEC-*` cases and 2 `A-*` cases.

### Step 3 — what makes a case *passing*

Status comes from the recorded run, never from the ledger's own assertion:

| Status | Meaning | Counts? |
| --- | --- | --- |
| `passing` | the runner reported it passed | **yes** |
| `failing` | the runner reported it failed | no |
| `skipped` | present, not executed (`it.runIf`, `test.skip`) | no |
| `quarantined` | deliberately excluded | no |
| `implemented` | exists in the tree, not in the recorded run | no |
| `planned` | designed, no test written | no |

### Step 4 — the arithmetic

```
counted = number of cases where countable === true AND status === 'passing'
```

Per category, compare `counted` against its floor. A category is short if
`counted < floor` — the shortfall is stated, never rebalanced away.

### Step 5 — reproduce it

```bash
CI=1 npx vitest run --reporter=json --outputFile=reports/vitest-a11.json
E2E_PORT=8798 CI=1 npx playwright test --reporter=json > reports/pw.json
node scripts/verify-test-cases.mjs --json
```

The third command prints `counted_passing`, the per-category table and the reconciliation.

### Why `build-test-report.mjs` reports a different number

It reports **1,972 distinct / 1,969 passed** where the ledger reports **2,079 / 2,024**.
Both are correct; they measure different sets:

| | `build-test-report.mjs` | the ledger |
| --- | --- | --- |
| Vitest cases | yes | yes |
| Playwright cases | **no** | yes (31 ids) |
| Cases with no test yet (`planned`) | no | yes (14) |
| Cases present but not in the run | no | yes, as `implemented` (15) |
| Off-allowlist `SEC-*` | counted | present but **not countable** |

If the two are ever expected to agree, the report script must learn to read the Playwright
JSON. Until then, quote the ledger for the gate and the report for the vitest run.

---

## 4. Category table at `866c359`

| Category | Total | Pass | Fail | Skip | Planned | Unmeas. | Floor | **Counted** | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `verification_logic` | 226 | 226 | 0 | 0 | 0 | 0 | 65 | **226** | ok |
| `connector_contracts` | 217 | 215 | 0 | 2 | 0 | 0 | 45 | **215** | ok |
| `persistence_concurrency` | 121 | 121 | 0 | 0 | 0 | 0 | 45 | **121** | ok |
| `auth_tenancy` | 158 | 158 | 0 | 0 | 0 | 0 | 55 | **158** | ok |
| `commerce` | 261 | 261 | 0 | 0 | 0 | 0 | 50 | **261** | ok |
| `customer_lifecycle` | 217 | 202 | 15 | 0 | 0 | 0 | 45 | **202** | ok |
| `owner_panel` | 282 | 282 | 0 | 0 | 0 | 0 | 45 | **282** | ok |
| `api_security_privacy` | 216 | 216 | 0 | 0 | 0 | 0 | 45 | **216** | ok |
| `budgets_models_maintenance` | 38 | 38 | 0 | 0 | 0 | 0 | 35 | **38** | ok |
| `advertising_analytics` | 138 | 136 | 0 | 2 | 0 | 0 | 25 | **136** | ok |
| `accessibility_resilience` | 16 | 5 | 0 | 0 | 11 | 0 | 30 | **5** | **SHORT by 25** |
| `stories_release_hygiene` | 33 | 23 | 7 | 0 | 3 | 0 | 15 | **23** | ok |
| `unassigned` (off-allowlist) | 156 | 141 | 0 | 0 | 0 | 15 | — | **0** | not countable |
| **Total** | **2,079** | **2,024** | **22** | **4** | **14** | **15** | **500** | **1,883** | floor met |

Levels: **unit 1,178 · integration 869 · e2e 32.**

### The one genuinely thin category

`accessibility_resilience` has **5 counted against a floor of 30**. This is real, not a
filing artefact. Contrast, focus, keyboard operation and colour-independence *are* tested —
but under `CUST-*` and `OWNER-*` prefixes, so they count towards those categories instead.
What has **no test anywhere** is the resilience half: migration forward-compatibility,
rollback, backup restore, health-endpoint honesty, configuration isolation and behaviour
under a D1 outage. Eleven of those are in the ledger as `planned` (`RESIL-900`–`RESIL-912`).

I did not move a11y cases into this category to make the table green. Rebalancing a floor
by reclassification is how a gate becomes decoration.

---

## 5. Failing, skipped and unmeasured — stated plainly

### 22 failing

| Group | Count | What it is |
| --- | ---: | --- |
| `CUST-080`–`CUST-091` | 12 | The signed-in customer journey. `/app` correctly returns 401 without a session; these specs were written against a synthetic port that no longer backs `/app`. |
| `CUST-092`–`CUST-094` | 3 | Responsive layout at 390/834/1440px. Same cause. |
| `DOC-107`, `DOC-114`, `DOC-115`, `DOC-116`, `DOC-125`, `DOC-126`, `DOC-129` | 7 | A05's development-story page, mid-implementation at this commit. |

**The browser gap, recorded rather than papered over:** authenticated customer and owner
layouts are **currently unmeasured at every breakpoint**. A05 established that
`CUST-092`–`CUST-094` were previously passing *vacuously* — they were measuring a 500 error
page, which has almost no content and therefore never overflows. A test that passes against
an error page is worse than one that fails, because it reports coverage that does not
exist. A02 is building the scoped test identity that will let these run against a real
session. Until then this is a **known gap, not a pass**.

### 4 skipped — none blocking, each declared

| Case | Why |
| --- | --- |
| `CONN-900`, `CONN-901` | The only provider-backed cases. No HubSpot or Resend credential exists, so both skip. `tests/setup.ts` blocks outbound fetch and its host allowlist is empty, so running them for real is a separate, visible act owned by the lead. |
| `ADS-026`, `ADS-027` | Need the scoped automation test identity. `/owner` requires a session and the suite will not open one by a route a person could not use — the right call. |

A skip is never counted as a pass anywhere in this document or in the checker.

### 15 unmeasured

Cases whose test exists but was added after the recorded run. They count as zero. They are
`implemented`, not `passing`, and the distinction is the point.

---

## 6. Reconciliation defects (31 open)

The checker cross-reads the tree and reports what disagrees. `--strict` makes these fatal.

1. **`SEC-*` — 156 cases, 14 files, off-allowlist.** The single largest item. These are
   real, mostly passing security cases that **cannot count towards any floor** because
   `SEC` is not in the brief's prefix list. Either A02 renames them (`API` for
   validation/privacy, `AUTH` for tenancy) or the lead adds `SEC` to the brief. Both are
   legitimate; the two documents must agree. Until then the gate is being met *without*
   156 of the best cases in the suite.
2. **`A-20`, `A-21` — off-allowlist**, in `gate-a.test.ts` and `refunds.test.ts`.
3. **`CUST-09`** — a truncated token from a template-literal title. Not a real case; the
   genuine `CUST-092`–`094` are harvested from the run instead.
4. **28 duplicated ids** — one id used by two different test files (`AUTH-301`–`304`,
   `AUTH-320`–`321`, `API-300`–`311`, `SEC-201`–`207`). Two different cases wearing one
   name: only one can be counted, and the ledger can only describe one of them.

`PERSIST-000` is **fixed** — renamed to `PERSIST-001` in
`tests/integration/db/harness.test.ts`, the one change I made outside my owned paths, at
the lead's instruction.

---

## 7. Secret hygiene — including a problem I caused

The ledger quotes test source verbatim, and several fixtures are credential-shaped **on
purpose**. In their own files a `secret-scan:allow` marker exempts them. **That marker does
not survive harvesting**, so a naive ledger trips the secret scanner and GitHub push
protection.

Two defences now exist:

1. **The harvester redacts on the way in.** `api_key: '<REDACTED-FIXTURE>'` and
   `https://<credentials-in-url>@api.hubapi.com/x`. The placeholder names what the fixture
   *is*, which reads better than the original.
2. **The checker refuses a ledger that skipped step 1.** Any ledger text matching a secret
   shape is a fatal integrity failure.

Both read the rule list from **`scripts/scan-secrets.mjs`** — the repository's single list
of secret shapes — rather than copying it. Two lists drift, and the one that drifts is
always the one nobody is watching.

> **A near-miss worth recording.** The first version of that rule-loading parser recovered
> **16 of 18** rules: an unescaped `/` inside a regex character class ended the literal
> early and truncated the block mid-rule. The two rules lost were `basic-auth-url` and
> `assigned-secret-literal` — *exactly* the two that matched the fixtures in question. It
> would have redacted nothing and reported success. Both copies now assert that the number
> of rules parsed equals the number the file declares, and throw otherwise. A redaction
> pass with a shape blind spot is worse than none, because it is trusted.

**Open, and mine:** an earlier, unredacted generation of `docs/test-cases.json` was
committed. `node scripts/scan-secrets.mjs --history` is red on blob `5b7c53de` for two
lines. The working tree is clean; only history is affected. History rewriting is forbidden
here, so the documented mechanism is the scanner's pinned-SHA historical allowlist — that
file is not mine, so this is the lead's call, not something I should quietly add myself.

---

## 8. Test-design techniques, and where they show up

**Equivalence classes.** Each rule operator is partitioned by behaviour, not by example:
present-and-matching, present-and-differing, authoritative empty (`null`/`''`),
provider-omitted (`undefined`), and spec-unusable. That partition is why `equals` has five
cases rather than one, and why `not_equals` has a separate UNKNOWN case — "the value is not
X" cannot be established from a value that is not there.

**Boundary values.** Every bound in `LIMITS` is exercised at the boundary and one step
either side: `occurred_within` at exactly N seconds and N+1ms; delta exactly zero;
`MAX_ASSERTIONS_PER_WORKFLOW` at 10 and 11; deadlines at 59/60 and 3600/3601;
`MAX_OBSERVATIONS_PER_RUN` at 4; `PLAN_RUNS_PER_PERIOD` at 500 and 501; `canReserve` at
exactly-available and one penny more; the deadline comparison at exactly `deadlineAt`.

**Role matrices.** `auth_tenancy` is the cross product of {anonymous, viewer, admin, owner,
automation} against {read own, read foreign, mutate own, mutate foreign, billing, owner
panel} — keeping only the cells whose outcome genuinely differs.

**State-transition coverage.** Every legal edge of `nextRunState`, and the illegal ones
that must throw 409 — including late evidence against a still-pending run, and any
non-late event against a decided run. Same treatment for order, subscription, campaign,
job and connection lifecycles.

**Concurrency interleavings.** Two-writer races wherever a lost update costs money or
correctness: quota at 500, budget reservation at the available boundary, lease acquisition,
approval consumption, order and refund idempotency keys, outbox dispatch.

**Delayed and duplicate events.** The same Stripe event four times; an older
`provider_event_created` after a newer one; a webhook replayed outside tolerance; late
email evidence creating a revision rather than mutating a decided run; a provider cost
reported after its reservation was released.

**Controlled fault injection.** Every `CONNECTOR_ERROR_CODE`, a failing D1 binding, a fetch
that never settles, a dispatcher that throws either side of its commit point, a runner that
stops heartbeating, a cleanup interrupted mid-execution.

**The four outcomes.** Success, denial, failure and **unknown**. The fourth is the one
teams forget and the one this product lives on: an expired credential, a rate limit, an
ambiguous CRM match, an unparseable timestamp, customer-claim-only evidence and a deadline
missed during an outage all resolve to `UNVERIFIED` rather than to a false accusation.

### A note on `risk` granularity

Cases harvested from the tree carry a **per-file area risk** (`risk_source: "area"`),
hand-written after reading each of the 121 test files — what it costs the business if that
area is wrong. The 14 designed-but-unwritten cases carry **per-case** risk
(`risk_source: "case"`). The field says which it is. I am not going to claim 2,065
individually-reasoned risk statements when what exists is 121 area statements applied to
the cases beneath them.

---

## 9. Honesty — what a passing suite does not prove

**Mocked providers are not a working integration.** Every connector case except two drives
a stubbed `fetch`, and those two **have never run** — no HubSpot or Resend credential
exists. The suite proves our adapters handle the payload *we believe* the provider sends.
It cannot prove the provider sends it. Until `CONN-900`/`CONN-901` run, every claim about
reading records back is **designed, not observed**, and the launch material must say so.

**The authenticated browser journey is unmeasured.** 15 of 32 browser cases fail because
`/app` needs a session the suite cannot yet create. Nothing in the signed-in customer or
owner interface is currently verified at any breakpoint by an automated test. Worse, three
of those cases were passing *vacuously* until A05 looked — measuring an error page.

**Emulated mobile is not a physical device.** The 320/390/834px cases resize a desktop
browser. They say nothing about touch ergonomics, on-screen keyboards, iOS Safari, real
latency, or a three-year-old Android phone on a train.

**A green accessibility check is a floor.** Automated sweeps catch contrast, labels and
landmarks. Nobody has tested this product with a real assistive-technology user.

**2,024 passing cases say nothing about demand.** Not about pricing, positioning, or
whether an agency will edit their n8n workflow to call us. The product may be entirely
correct and commercially worthless. No test here can tell the difference.

**Also unproven:** behaviour inside Cloudflare's CPU and subrequest limits under real
traffic; D1 at a scale we have never run; that Stripe live mode behaves like test mode;
that a human can restore the backup under pressure; that the budget holds once real
advertising runs; that redaction covers a payload shape a real customer's CRM will contain.

---

## 10. Flake policy

1. **The first failure is kept**, with its output, against the release candidate.
2. **A passing rerun does not erase it.** It adds one fact — the failure is intermittent.
3. **Root cause before requeue.** "It passed the second time" is not a diagnosis.
4. **A flake is a defect in the test or the code, never in the weather.** In this product
   most flakes will be genuine concurrency or time bugs, because it is built on leases,
   deadlines and a one-minute cron.
5. **A blocking case may never be quarantined to make the gate green.** Not `.skip`, not
   moved to a nightly suite, not wrapped in a retry.
6. **No automatic retry in the deterministic suites.** Playwright may retry in CI only, and
   a retried pass is reported as a retried pass.
7. **Quarantine is time-boxed and visible** — one release, a named owner, a dated reason in
   the ledger's `status`. A quarantined case counts zero.

> **Observed here.** Across three browser runs, `CUST-092`–`095` flipped between pass and
> fail depending on run order, and one run produced 34 spurious failures because the dev
> server never started — an infrastructure error, recorded as such, not as 34 defects. The
> stable explanation only appeared once `/app` was inspected directly and found to be
> returning 500 for a missing D1 binding, later 401 for a missing session. Chasing the
> flake to its cause is what produced `RESIL-904`.

---

## 11. Blocking and accepted risks

### Blocking — the release does not go

| Area | Scope | Why |
| --- | --- | --- |
| `verification_logic` | all 226 | A false VERIFIED or FAILED destroys the only thing the product sells. |
| `commerce` | all 261 | Every case is money moving wrongly, twice, or service given away. |
| `auth_tenancy` | all 158 | Cross-tenant access to other people's CRM evidence is unrecoverable. |
| `api_security_privacy` | all 216 | Public repo, public endpoint, customer-controlled data rendered to a browser. |
| `persistence_concurrency` | all 121 | Idempotency and tenant scope are enforced here or nowhere. |
| `connector_contracts` | 215 stubbed | The two provider-backed cases block only once credentials are authorised. |
| `owner_panel` | approvals, cleanup safety, runner authorisation | The controls that stop the panel spending money or deleting a customer. |
| `budgets_models_maintenance` | assistant boundary + reservation races | Rule 9 is a launch condition; a budget that can be overspent is not a budget. |
| `customer_lifecycle` | signup, connect, rules, first run, report, cancellation, export, deletion | The paths a paying customer cannot route around. |
| `stories_release_hygiene` | secret scan, artifact hygiene, claims map | A credential in a public repo, or a claim we cannot support, is worse than a bug. |

### Accepted risks — launching with these, deliberately

| Risk | What is accepted | Why it is tolerable |
| --- | --- | --- |
| **No provider-backed evidence** | 2 of 217 connector cases touch a real provider and neither has run. | Connector errors surface as `UNVERIFIED`, never a false `VERIFIED`. The launch material must say "designed, not observed". **Re-open the moment a credential exists.** |
| **Authenticated browser journey unmeasured** | 15 failing e2e cases; signed-in UI unverified at every breakpoint. | Unit and integration cover the logic beneath. This is a gap in *interface* evidence. Blocking for a UI release; A02's scoped identity closes it. |
| **`accessibility_resilience` at 5 of 30** | No migration, rollback, backup or outage test. | A11y itself is covered under other prefixes. The resilience half is genuinely untested — **G8 stays failed** until `RESIL-900`–`912` exist. |
| **156 `SEC-*` uncountable** | The best security cases count zero. | They pass; they are simply misfiled. A naming fix, not new work. |
| **No physical device testing** | Emulated viewports only. | Documented publicly rather than claimed. Founder checks four pages on a real phone as a recorded manual step. |
| **No assistive-technology user testing** | Automated checks only. | Stated plainly; SECURITY.md already forbids a compliance claim. |
| **No load testing at scale** | Largest measured page is 500 runs. | `PLAN_RUNS_PER_PERIOD` bounds one workspace. Re-open before the second paying customer. |
| **No penetration test** | An automated suite is not adversarial review. | SECURITY.md says so and offers a private reporting route instead of a certification claim. |

---

## 12. Execution strategy inside the budget

The authorised total is £100 (`BUDGET.TOTAL_INITIAL_PENCE`). The suite must cost
approximately nothing and run from a public clone.

```bash
pnpm typecheck
pnpm test            # vitest — outbound fetch is blocked by tests/setup.ts
pnpm test:e2e        # playwright against a local wrangler dev + local D1
pnpm verify:cases    # ledger integrity + reconciliation
pnpm scan:secrets    # before every push
node scripts/build-test-report.mjs
```

Everything deterministic uses synthetic fixtures. `tests/setup.ts` fails loudly on any
outbound `fetch` — that mechanism is what makes "no real provider was contacted" a fact
rather than an intention. `ASSISTANT_MODE` is `off` in tests and the model router refuses a
paid tier without a budget reservation the harness never grants.

**Real-provider checks:** exactly two, both skipping today. Each is a single read against a
provider *test* account. They never write, never send. Running them also requires the lead
to add the provider hosts to the setup allowlist for that run — deliberately a separate,
visible act, so a provider cannot be contacted from the suite by accident.

**Never:** 500 real emails (Resend is stubbed; magic links come from a stubbed transport);
500 live charges (real signature verification over stubbed payloads — the signature is
real, the money is not); purchased clicks (stubbed ad adapter; a campaign is only created
by a person behind an approval bound to the packet hash); any Cloudflare resource not named
`verify-itisyou-*`. Staging has no cron triggers, so a test environment cannot generate
recurring cost.

Migration `0003_quality_artifacts.sql` is applied to local, staging and production, so the
evidence pack from `build-test-report.mjs` now has an authenticated home reachable from the
owner panel rather than the world-readable asset directory.

---

## 13. Running the checker

```bash
pnpm verify:cases                                    # integrity + reconciliation
node scripts/verify-test-cases.mjs --strict          # tree defects are fatal
node scripts/verify-test-cases.mjs --gate            # category floors are fatal
node scripts/verify-test-cases.mjs --strict --gate   # the release gate
node scripts/verify-test-cases.mjs --json            # machine-readable, for CI and audit
```

No dependencies; Node built-ins only. It exits 1 when: an id is duplicated, malformed or
off-allowlist; a required field is missing or a text field is empty; two cases share an
identical `requirement` + `setup` (the padding detector); `level`, `status` or `risk_source`
is outside its set; numbering within a prefix is not sequential from 001; a case claims a
run status with no matching test; a countable case carries a malformed id; or **any ledger
text matches a secret shape**. Under `--strict` it also fails on tree defects; under
`--gate`, on any category below its floor.

A sound ledger proves the count is honest. It does not make a failing suite green.
