# ITISYOU Verify — release test plan and launch gate

Owned by **A11 (QA and Release)**.

- Ledger: [`docs/test-cases.json`](test-cases.json) — one entry per case that exists.
- Checker: [`scripts/verify-test-cases.mjs`](../scripts/verify-test-cases.mjs) — proves the ledger is honest.
- Report: `scripts/build-test-report.mjs` — runs the vitest suite and writes `reports/`.
- **Gate artefact: `scripts/build-gate-artefact.mjs`** — run by CI on a clean checkout; its
  `release-gate-<sha>` output is the only citable number (§2b). Everything else in this
  list is a reading of a working tree.

The ledger **describes the suite that exists**. It is harvested from the test tree and the
recorded run, not written ahead of the code.

> **Do not declare readiness from a total of passing tests.** That instruction is aimed at
> the numbers in this document. §3 exists so the buckets are legible enough that nobody can
> quote one of them as if it were another.

---

## 1. Case accounting — the seven buckets

Every case sits in **exactly one terminal bucket**. Every step between adjacent buckets is
itemised. This is the output of `node scripts/verify-test-cases.mjs`, not a transcription.

> **This is a reading of a working tree, not a gate result.** It was taken on a clean
> export of `66b8d38` (`git archive HEAD | tar -x` into a scratch directory), because the
> live working tree had 91 uncommitted changes and moved twice during the measurement.
> The number that gates a production deploy comes from CI — §2b.

```
  discovered   (a test carrying the id exists)          2263
+ planned      (designed, no test written yet)            14
= ledger entries                                        2277

  discovered                                            2263
    executed     (ran in the recorded run)              2227
    not executed (exists, absent from that run)           36

  executed                                              2227
    passing                                             2205
    failing                                                2
    skipped      (declared skip)                          20
    quarantined  (known flaky, excluded)                   0

  passing                                             2205
    countable    (counts toward the 500 floor)          2205
    excluded                                               0
```

**Nothing passing is now excluded.** The 140 `SEC-*` exclusions are gone: `SEC` is on the
prefix allowlist and every `SEC` case carries an explicit category (§6a). The checker
_fails_ if any passing case is uncountable for a reason it cannot name, so an unexplained
residue cannot recur silently.

### Why each bucket is not the next one

| Step                        | Delta | Reason                                                                                                                                                                                                                                                                 |
| --------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ledger entries → discovered |   −14 | 14 designed cases have no test yet (§7).                                                                                                                                                                                                                               |
| discovered → executed       |   −36 | 36 tests exist but landed after the recorded run. Worth zero. 21 of those are the cases renamed out of a duplicate-id collision in §6b: the test bodies ran, but no result in the recorded run is keyed to their new ids, so they are `implemented` and count nothing. |
| executed → passing          |   −22 | 2 failing, 20 declared skips (§5).                                                                                                                                                                                                                                     |
| passing → countable         |     0 | Nothing passing is uncountable.                                                                                                                                                                                                                                        |

### The two runners

```
  by runner    vitest=2196  playwright=31  not-run=50
  passing      vitest=2192  playwright=13
```

**`scripts/build-test-report.mjs` reports 2,192** — the vitest-only figure. It does not
read the Playwright JSON. That is a structural difference, not a disagreement: the ledger
is the union of both runners plus cases with no run. Quote the ledger for the gate and the
report for the vitest suite, and the two reconcile through the `by runner` line above.

---

## 2. The pinned commit, and why pinning is hard here

|                     |                                             |
| ------------------- | ------------------------------------------- |
| Pin                 | `6439ffe`                                   |
| Working tree        | 24 modified files at measurement start      |
| HEAD after the pass | `66b8d38` — it moved during the measurement |

**A full measurement pass takes longer than the interval between commits.** Vitest is about
four minutes, Playwright three, extraction and rebase one. Twelve agents are committing
continuously. Across my passes the suite went 1,793 → 2,196 distinct cases in roughly
twenty minutes, and one pass measured `persistence_concurrency` at **0 passing** purely
because thirteen files had landed after that run started.

Two consequences, stated rather than worked around:

1. **The numbers above are a reading of the working tree at `6439ffe`, not a property of
   any commit.** Anything that landed mid-pass shows as `not executed`, which is why that
   bucket exists and counts zero.
2. **The authoritative gate number must come from CI on a tagged release candidate with a
   clean tree** — which is what a release candidate is for. A developer machine on a live
   tree cannot produce a reproducible total, and this document should not pretend otherwise.

**This is no longer advice.** §2b is the mechanism.

### Observed again while writing this section

Mid-measurement, A02 renamed `API-300`–`313` to `API-600`–`613` in
`tests/unit/security/totp.test.ts` — uncommitted, in the shared tree. The checker went
from exit 0 to exit 1 in four minutes, naming `API-312` and `API-313` as ledger cases with
no test. Nothing was wrong with the checker, the ledger or A02's rename; the tree simply
moved between two readings. `git show HEAD:tests/unit/security/totp.test.ts` still carries
the old ids, so the ledger is correct **about the commit** and wrong about the desk it is
sitting on. Every number in this document is therefore taken from a clean export of
`66b8d38`, never from the live tree.

---

## 2b. The gate artefact — where the citable number comes from

|          |                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer | `scripts/build-gate-artefact.mjs`, run by the `gate` job in `.github/workflows/ci.yml`                                                               |
| Output   | `reports/release-gate.json`, uploaded as `release-gate-<sha>`                                                                                        |
| Consumer | `scripts/release.mjs`, which refuses a **production** deploy unless the artefact was produced by CI, from a clean tree, at the commit being deployed |

The artefact carries the seven-bucket ladder, the per-runner split, the twelve floor
results, the ledger checker's exit code, and two provenance fields that decide everything:

```json
"produced_by": "github-actions",   // or "local"
"tree_clean": true,
"commit_sha": "…",
"citation_rule": "Citable. Produced by CI on a clean checkout at …"
```

**That artefact is the only number anyone may cite for the ≥500-distinct-test
requirement.** A local run of `build-gate-artefact.mjs` refuses to write anything at all
unless the tree is clean; with `--allow-dirty` it writes a file stamped
`produced_by: "local"` and `NOT CITABLE`, and the release gate rejects it by name.

Check the artefact you hold without starting a release:

```bash
node scripts/release.mjs --env production --check-gate-artefact
node scripts/release.mjs --env production --check-gate-artefact --gate-artefact path/to/release-gate.json
```

Staging is advisory — it prints the same findings as notes and proceeds, because staging
is where a release candidate is supposed to fail. Production is fatal on every one of:
artefact absent, not a v1 release-gate artefact, `commit_sha` ≠ HEAD, `produced_by` ≠
`github-actions`, `tree_clean` ≠ true, checker exit code ≠ 0, floor not met, any category
below floor.

**Everywhere a local run prints a total it now says what it is.**
`verify-test-cases.mjs` prints `reading of a working tree at <sha>, N uncommitted
change(s)` above the table and repeats it under the verdict.
`build-test-report.mjs` labels its own threshold check `NOT a gate result` in the console,
the Markdown, the readiness note and the HTML. The word "gate" is reserved for the
artefact.

---

## 3. How the numbers are counted — reproduce without reading the script

### Step 1 — what is a case

One **id**, `PREFIX-NNN`, appearing in a test title. Twelve prefixes, in
`docs/agent-brief.md`.

- A case counts **once**, whatever the parameterisation. Three viewports from one body are
  one case. Two browsers are one case. A rerun is an execution, not a case.
- **A title declares one id, and it is the leading token.** `it('VERIFY-012 …')` declares
  `VERIFY-012`. An id appearing later in a title —
  `it('API-016 refuses to open without an expected AAD (A10 AUTH-114)')` — is a
  cross-reference to somebody else's case, not a second implementation of it. Reading
  every id-shaped token in a title invented four duplicate-id defects out of nothing
  (§6b). Measured across the whole tree: 2,311 ids lead a title, 2,311 ids appear in one,
  so nothing real is lost by reading only the leading token.
- An id in **two different files is a defect, not two cases** (§6).
- `SHA-256` is not a case id; the checker holds a denylist of such prefixes.
- A title built at runtime (`` `CUST-09${i}` ``) cannot be found by a static scan. Those
  cases carry `title_generated: true` and their evidence is the run record.

### Step 2 — `countable`

`countable = true` requires **both**: the prefix is on the allowlist, **and** the number is
exactly three digits and not `000`. Everything else is worth **zero** towards every floor,
however well it passes.

### Step 2b — which category a case lands in

`category` is an **optional** field on a ledger entry.

- **Present → it wins.** The value must be one of the twelve, or the checker exits 1.
- **Absent → the prefix default applies**, exactly as before, so no pre-existing entry
  changed behaviour when this was introduced.
- **A prefix may have no default.** `SEC` is mapped to `null`: its cases genuinely span
  four categories, so every `SEC-*` entry must name its own, and the checker exits 1
  naming any that does not.

The rule is "explicit wins", not "explicit permitted where convenient". A prefix that
carries a default and an entry that overrides it are both legal; the checker counts such
overrides and prints them, so a quiet reclassification is visible rather than silent.
There are none today.

### Step 3 — `status`, from the run and never from the ledger's own assertion

| Status        | Meaning                                          | Counts? |
| ------------- | ------------------------------------------------ | ------- |
| `passing`     | the runner reported a pass                       | **yes** |
| `failing`     | the runner reported a failure                    | no      |
| `skipped`     | present, not executed                            | no      |
| `quarantined` | deliberately excluded as flaky                   | no      |
| `implemented` | exists in the tree, absent from the recorded run | no      |
| `planned`     | designed, no test written                        | no      |

### Step 4 — the arithmetic

```
counted = cases where countable === true AND status === 'passing'
```

Per category, compare `counted` with its floor. A shortfall is stated, never rebalanced
away by reclassifying cases into the short category.

### Step 5 — reproduce it

```bash
CI=1 npx vitest run --reporter=json --outputFile=reports/vitest-a11.json
# the browser suite needs a seeded identity for anything behind a session:
node scripts/seed-automation-identity.mjs   # then export what it prints
E2E_PORT=8788 CI=1 npx playwright test --reporter=json > reports/pw.json
node scripts/verify-test-cases.mjs --json
```

The last command prints the bucket ladder, the per-category table and the reconciliation.
Take its **exit code**, not its output: `0` sound, `1` broken. `--strict` also fails on
tree defects; `--gate` also fails on any category below floor.

---

## 4. Category table — before and after the `SEC` ruling

Both columns are readings of **the same clean export of `66b8d38`**, differing only by the
change described in §6a and the renames in §6b. Anything else would not be a comparison.

| Category                     |   Floor | Counted **before** | Counted **after** | Verdict before | Verdict after |
| ---------------------------- | ------: | -----------------: | ----------------: | -------------- | ------------- |
| `verification_logic`         |      65 |                226 |           **226** | ok             | ok            |
| `connector_contracts`        |      45 |                256 |           **256** | ok             | ok            |
| `persistence_concurrency`    |      45 |                128 |           **128** | ok             | ok            |
| `auth_tenancy`               |      55 |                169 |           **191** | ok             | ok            |
| `commerce`                   |      50 |                281 |           **281** | ok             | ok            |
| `customer_lifecycle`         |      45 |                214 |           **217** | ok             | ok            |
| `owner_panel`                |      45 |                292 |           **310** | ok             | ok            |
| `api_security_privacy`       |      45 |                216 |           **301** | ok             | ok            |
| `budgets_models_maintenance` |      35 |                 38 |            **50** | ok             | ok            |
| `advertising_analytics`      |      25 |                136 |           **136** | ok             | ok            |
| `accessibility_resilience`   |      30 |                 79 |            **79** | ok             | ok            |
| `stories_release_hygiene`    |      15 |                 30 |            **30** | ok             | ok            |
| `unassigned` (off-allowlist) |       — |           0 of 156 |     **— (empty)** | not countable  | —             |
| **Total**                    | **500** |          **2,065** |         **2,205** | floor met      | floor met     |

**No verdict moves.** All twelve floors were met before and are met after; the change is a
reporting-honesty change and was never capable of rescuing a shortfall. The +140 is the
`SEC` passing cases entering the categories they belong to: `auth_tenancy` +22,
`owner_panel` +18, `budgets_models_maintenance` +12, `customer_lifecycle` +3,
`api_security_privacy` +85.

Ledger entries went 2,256 → 2,277 (§6b adds 21 renamed cases, all `implemented`, all worth
zero). Reconciliation defects went 56 → 53. "In the ledger, not the tree" went 175 → 34:
156 of that 175 were `SEC` cases the old scan could not see at all.

Levels: unit 1,198 · integration 1,047 · e2e 32.

**All twelve floors are met.** `accessibility_resilience` was at 5 of 30 when A11 first
reported it; `tests/integration/resilience/*` has since landed (database outage,
interrupted jobs, migration compatibility, restore) and it is now 79.

---

## 5. Failing and skipped, named

### 2 failing

| Case       | What it is                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-206`  | Every SELECT/UPDATE/DELETE on a customer table must be scoped in its _predicate_, not merely mention the column. A live tenant-scope finding. |
| `CUST-079` | Every interactive element shows a visible focus ring. Browser suite.                                                                          |

### 20 skipped — every one declared, with a reason in the annotation

| Group                                                                    | Count | Declared reason                                                                                                                                         |
| ------------------------------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUST-080`–`091`, `CUST-092`–`094`, `ADS-026`–`027`, 4 owner-phone specs |    18 | No automation identity seeded. `scripts/seed-automation-identity.mjs` now exists; export what it prints before running the authenticated browser suite. |
| `CONN-900`, `CONN-901`                                                   |     2 | The only provider-backed cases. No HubSpot or Resend credential exists.                                                                                 |
| `OWNER-321`                                                              |     1 | Live owner port approval consumption.                                                                                                                   |

**These were failures an hour ago and are now honest skips.** A02 shipped the scoped
identity and A05 converted the authenticated specs from _failing against a 401_ to
_declaring they cannot run_. That is the right direction: A05 had earlier established the
same cases were passing **vacuously** against a 500 error page — a page with almost no
content never overflows, so a layout assertion against it passes while measuring nothing.
A test that passes against an error page is worse than one that fails.

**A skip is never counted as a pass**, here or in the checker. The signed-in customer and
owner interface remains **unmeasured at every breakpoint** until the identity is seeded in
the run.

### 0 quarantined

Nothing is quarantined. If anything ever is, it is time-boxed to one release with a named
owner and a dated reason in the ledger's `status`, and it counts zero.

---

## 6. Open defects in the test tree

`--strict` exits 1 while any of these stand. 56 before this pass, 53 after.

**A11b, reading at `25a41fc` (§f, §g below):** `--strict` reconciliation defects now 49 (down
from the 53 above, but a different pass, on a tree that gained ~150 files in between — not a
like-for-like improvement, just the current count). Plain-mode ledger integrity failures are
0, down from 2 (`API-312`, `API-313`), fixed in §g. Both figures are readings of the working
tree at that commit, not gate numbers; see §2b.

### a. The `SEC-` prefix — ruled, and applied

**Ruling: `SEC` joins the allowlist, but not as a blanket prefix mapping.**

A11 recommended mapping the whole prefix to `api_security_privacy` and recorded that doing
so misfiles roughly 52 of 156 cases. That caveat is the problem: a number known to be wrong
for a third of its inputs is a false number with a footnote, and footnotes get dropped when
a total is quoted. Renaming 156 ids to encode the category was the other option and is
worse — an id is identity, not metadata, and `reports/` and commit messages already
reference them.

So the category moved onto the case:

1. `category` is an optional ledger field. Present → it wins. Absent → the prefix default,
   exactly as before, so no existing entry changed behaviour.
2. `PREFIX_CATEGORY.SEC` is `null`: on the allowlist, no default. Every `SEC-*` entry must
   declare its own category, and the checker exits 1 naming any that does not.
3. **Zero renames.** `SEC-431` is still `SEC-431` in the test source.

All 156 were assigned by reading the `describe` blocks in the file each case lives in, not
by trusting a per-file count:

| Category                     | Cases | Source                                                                                                                                                                             |
| ---------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_security_privacy`       |   100 | url-guard 22, webhook-signature 19, shipped-encoders 15, webhook-route 12, output-encoding 12, source-scan (SSRF, secret hygiene, CI posture) 14, secret-hygiene 5, plus `SEC-203` |
| `auth_tenancy`               |    23 | credential-aad 10, credential-scope 6, tenant-predicate `SEC-206`/`207`, source-scan tenant-scope `SEC-201`/`202`/`204`/`205`, `SEC-213`                                           |
| `owner_panel`                |    18 | approval-hash, all of it                                                                                                                                                           |
| `budgets_models_maintenance` |    12 | assistant-injection, all of it                                                                                                                                                     |
| `customer_lifecycle`         |     3 | `SEC-210`–`212`, the synthetic-workspace describe inside tenant-predicate                                                                                                          |

Two of A11's file-level groupings did not survive reading the files:

- `source-scan.test.ts` opens with a five-case `describe('tenant scope: …')`. A11 filed all
  19 of that file under `api_security_privacy`; four of those five are tenant isolation.
- `tenant-predicate.test.ts` carries a second `describe('synthetic data can never be
mistaken for a real workspace')`. Nothing in it is about tenancy.

**Four judgement calls, stated rather than buried:**

| Case            | Assigned               | Why, and what the argument against is                                                                                                                                                                                          |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SEC-203`       | `api_security_privacy` | It sits in the `tenant scope` describe, but what it guards is parameter binding — SQL injection. The counter-argument is real: its own comment is about a workspace id being concatenated into a statement.                    |
| `SEC-205`       | `auth_tenancy`         | "No lowercase SQL verb in the data layer" is a lint rule on its face. It exists solely so `SEC-201`/`202`/`204` cannot be blinded by `select * from runs`, so it is part of the tenant-scope control.                          |
| `SEC-210`–`212` | `customer_lifecycle`   | They are about a demo workspace announcing itself to a customer. `SEC-212` ("no billing portal, nothing to buy") has a fair claim to `commerce`; it is kept with its two siblings rather than splitting a three-case describe. |
| `SEC-301`–`321` | `owner_panel`          | Approval hashing is about ad-campaign payloads, so `advertising_analytics` is arguable. It is filed under the panel that consumes the approval, matching the brief's "owner panel/approvals".                                  |

**`A-20` / `A-21` should not be added.** They are an ad-hoc Gate-A row label, not a
category prefix. Two renames, to `AUTH`/`BILL` by subject.

### b. Duplicated ids — 61 reported, 4 of them not real, 21 fixed, 36 left

**First, four were never collisions.** The scan read _every_ id-shaped token in a title, so
a cross-reference to another agent's case was counted as a second implementation of it:

| "Collision" | What it actually is                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH-114`  | `it('API-016 refuses to open without an expected AAD (A10 AUTH-114)')` in `unit/security/crypto.test.ts`                                         |
| `AUTH-115`  | `it('API-018 binds key_version into the AAD (A10 AUTH-115)')`, same file                                                                         |
| `AUTH-137`  | `it('API-110 never emits a __Host- cookie without Secure (A10 AUTH-137)')` in `unit/security/csrf.test.ts`                                       |
| `SEC-431`   | `it('BILL-222 production refuses to mount without the stand-in key — a silent default is how SEC-431 …')` in `integration/billing/mount.test.ts` |

Three agents would have renamed working tests to resolve collisions that did not exist. The
scan now reads only the **leading** id in a title (§3, step 1). 2,311 ids lead a title and
2,311 appear in one, so the rule loses nothing.

That also corrects A11's split. Its prose said "eight of the thirteen collisions are A02
with itself"; its own table says six, and with the phantoms removed it is **four
A02-with-itself groups and six cross-agent groups**.

#### Fixed here — A02 with itself, 21 ids, no cross-agent coordination needed

The id stays where the ledger's `implementation_ref` already points; the other side moves
into free numbers adjacent to that file's own block. All 30 cases in the three files pass
after the rename (`npx vitest run …`, exit 0). Each renamed case gets a ledger entry with
status `implemented` — the test body ran in the recorded run, but no result is keyed to its
new id, so it counts **zero** until a run measures it.

| Was               | Now               | File that moved                             | File that kept the id                           |
| ----------------- | ----------------- | ------------------------------------------- | ----------------------------------------------- |
| `AUTH-301`–`304`  | `AUTH-314`–`317`  | `security/integration/owner-access.test.ts` | `integration/db/auth.test.ts`                   |
| `AUTH-320`–`323`  | `AUTH-332`–`335`  | `security/integration/owner-access.test.ts` | `integration/db/auth.test.ts`                   |
| `AUTH-401`–`404`  | `AUTH-406`–`409`  | `security/integration/port-shape.test.ts`   | `integration/db/ownerPort.test.ts`              |
| `AUTH-420`, `421` | `AUTH-412`, `413` | `security/integration/port-shape.test.ts`   | `integration/db/ownerPort.test.ts`              |
| `SEC-201`–`205`   | `SEC-231`–`235`   | `security/unit/csv-injection.test.ts`       | `security/integration/source-scan.test.ts`      |
| `SEC-206`, `207`  | `SEC-236`, `237`  | `security/unit/csv-injection.test.ts`       | `security/integration/tenant-predicate.test.ts` |

#### Open — needs another agent, 36 ids in 6 groups

**These are not mine to edit.** Each row is a proposal: which file keeps the id, which
moves, and to what. The proposed numbers are free in both the tree and the ledger as of
`66b8d38`. The agent who owns the _moving_ file makes the change and tells A11 so the
ledger follows.

| Ids                                | Keeps the id                                                               | Moves                                        | Proposed new ids                                                                                          | Needs         |
| ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------- |
| `API-300`–`308`, `310`, `311` (11) | `unit/security/totp.test.ts` (A02 — the ledger describes these)            | `unit/support/csv.test.ts` (A09)             | `API-500`–`508`, `API-510`, `API-511`                                                                     | **A09**       |
| `BILL-262`–`265`, `270`–`274` (9)  | `integration/billing/wiring.test.ts` (A07 — the ledger describes these)    | `integration/db/wiring.test.ts` (A02)        | `BILL-282`–`285`, `BILL-290`–`294`                                                                        | **A02 + A07** |
| `OWNER-300`–`307` (8)              | `integration/db/ownerPort.test.ts` (A02 — the ledger describes these)      | `integration/owner/live-path.test.ts` (A07)  | `OWNER-310`–`317`                                                                                         | **A07**       |
| `OWNER-320`–`324` (5)              | `integration/db/automationSeed.test.ts` (A02 — the ledger describes these) | `integration/owner/call-sites.test.ts` (A07) | `OWNER-330`–`334`                                                                                         | **A07**       |
| `BILL-260`, `BILL-261` (2)         | `integration/billing/refunds.test.ts` (A07 — the ledger describes these)   | `integration/db/wiring.test.ts` (A02)        | `BILL-286`, `BILL-287`                                                                                    | **A02 + A07** |
| `A-20` (1)                         | neither — `A-20` is not a valid case id                                    | both `describe` blocks                       | `BILL-288` in `integration/billing/refunds.test.ts`, `OWNER-335` in `security/integration/gate-a.test.ts` | **A02 + A07** |

`A-20` is the odd one: both files use it as a **`describe`** title for the same Gate-A row,
so it is simultaneously a duplicate and a malformed id. Splitting it by subject — the
refunds side is commerce, the gate-a side is owner approval — resolves both at once.

**A02 has already fixed a seventh group unprompted.** `API-300`–`313` in
`unit/security/totp.test.ts` were renamed to `API-600`–`613` in the working tree while this
section was being written (uncommitted at `66b8d38`). If that lands, the first row above is
resolved the other way round — A09 keeps `API-300`–`311` — and the ledger needs
regenerating for those 14 entries. A11 should do that after the commit, not before.

### c. The `SEC-12xx` block — 15 malformed ids

`SEC-1201`–`1205` and `SEC-1210`–`1219` in `security/integration/shipped-encoders.test.ts`
are four digits. Ids are zero-padded to three, so these are `countable: false` and worth
zero whatever their status. They are now visible as 15 named defects rather than hidden
inside a single "prefix `SEC` is off-allowlist" line. They belong to `api_security_privacy`
and would count if renumbered into the free `SEC-8xx` range. A10's call.

### d. `CUST-09`

A truncated token from a template-literal title; not a real case. The genuine
`CUST-092`–`094` are harvested from the run record.

### e. Correction: `ADS-026` / `ADS-027` are in the ledger

A07 reported them missing. They are present, at `tests/e2e/ads.spec.ts:48` and `:79`, with
`status: "skipped"` and `countable: true`. They do not count **because they are skipped**,
not because they are absent — they will count the moment the automation identity is seeded
in the run.

### f. Nine new duplicate ids, introduced after `66b8d38` and not in §6b above

A11b (this pass), reading at `25a41fc`. §6b's "36 ids in 6 groups" table was built against
`66b8d38`. Commit `5b7c450` then added four new test files in one 310-file, 30k-line
change — `tests/integration/customer/colour-alone.test.ts`, `tests/integration/customer/
states.test.ts`, `tests/integration/support/notification-wiring.test.ts` and
`tests/unit/support/notification-transport.test.ts` did not exist at `66b8d38` (`git show
66b8d38:<path>` is `fatal: … exists on disk, but not in '66b8d38'` for each). Two of them
collide with the other two on `CUST` numbers that were free when §6b was written. **These
are not the "eight self-collisions" from the roster brief** — verified against content and
each file's own header, not assumed: they are two unrelated feature pairs, so they need
their owning agents, not a unilateral rename.

Both `colour-alone.test.ts` and `states.test.ts` open with a doc comment declaring their own
range (`CUST-360..CUST-363`, `CUST-370..CUST-376`) — a deliberate reservation. Neither
`notification-wiring.test.ts` nor `notification-transport.test.ts` declares a range
anywhere; they used the numbers ad hoc. On that basis the customer-UI files keep the ids and
the notification files move — the same rule §6b already used ("the id stays where it was
declared as a range; the other side moves").

| Ids                    | Keeps the id                                                        | Moves                                                | Proposed new ids     | Needs               |
| ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | --------------------- | ------------------- |
| `CUST-360`–`363` (4)   | `integration/customer/colour-alone.test.ts` (declares the range)     | `integration/support/notification-wiring.test.ts`      | `CUST-500`–`503`      | owner of `notification-wiring.test.ts` |
| `CUST-370`–`374` (5)   | `integration/customer/states.test.ts` (declares the range, through `CUST-376`) | `unit/support/notification-transport.test.ts` | `CUST-510`–`514`      | owner of `notification-transport.test.ts` |

`CUST-500`–`503` and `CUST-510`–`514` are free in both the tree and the ledger as of
`25a41fc` (checked against every `CUST-\d{3}` token in `tests/` and every `CUST-*` id in
`docs/test-cases.json`). Neither pair is in the ledger yet (both are "in tree, not ledger"),
so no ledger entry needs renumbering to match — only the test source, by its owner.

This makes the honest total **10 duplicate ids currently in the tree** (these 9, plus the
`A-20` group `§6b` already tracks), not the 8-self/5-other split the roster brief assumed.
The self-collision side of that brief's arithmetic is not stale in a way that leaves work
undone — §6b's own 4 self-collision groups (21 ids) are already fixed in the tree (verified:
`AUTH-314`–`317`, `AUTH-332`–`335`, `AUTH-406`–`409`, `AUTH-412`/`413`, `SEC-231`–`237` all
present, no `AUTH-3xx`/`SEC-201`–`207` duplicates remain) — it is short by these 9, which
did not exist when it was written.

### g. Ledger drift from A02's unprompted rename — fixed here

§6b flagged that A02 renamed `API-300`–`313` to `API-600`–`613` in `tests/unit/security/
totp.test.ts` "uncommitted at `66b8d38`," landing the other way round from the proposal, and
noted the ledger would need regenerating for those 14 entries once it landed. It landed in
`5b7c450`. Left unfixed, the ledger's `API-312`/`313` entries pointed at ids no longer
declared anywhere (`--strict` and even the plain run failed: `FAIL [API-312] status is
'passing' but no test title in tests/ carries this id`, same for `API-313`) — and
`API-300`–`311` looked reconciled only by coincidence, because `tests/unit/support/
csv.test.ts` independently reused that exact number range for twelve unrelated CSV-injection
cases (§6b's other resolution: "A09 keeps `API-300`–`311`"). The ledger's own `API-300`–`311`
rows would have counted as "in tree" against the wrong test.

Fixed here: all 13 ledger rows describing `tests/unit/security/totp.test.ts` (`API-300`–
`308`, `310`–`313` — there is no `API-309`) renumbered to `API-600`–`608`, `610`–`613`, with
`implementation_ref` line numbers corrected to the renamed file's current line numbers.
Requirement text was matched one-for-one against the new `it(...)` titles before renumbering
(e.g. old `API-312` "forgives case, spaces and hyphens…" = new `API-612`, same wording).
Zero requirement text changed; only `id` and `implementation_ref` did. `node
scripts/verify-test-cases.mjs` now exits 0 with no ledger integrity failures (`docs/test-
cases.json` diff: 13 ids changed, 26 lines total — `git diff --stat` confirms).

`tests/unit/support/csv.test.ts`'s own twelve cases (`API-300`–`311`, the real ones) remain
absent from the ledger — part of the pre-existing 187 "in tree, not ledger" gap, not
something this fix could close without inventing new required fields (`risk`, `setup`,
`expected`, `owner_agent`) on A09's behalf. Flagged, not silently left implied.

---

## 7. Planned — 14 designed cases with no test

Eleven `RESIL-9xx` (configuration isolation, D1 outage, scheduler backlog drain, migration
compatibility both ways, restore, health honesty, 200% zoom) and three `DOC-9xx` (story
schema, cut-claims scan, public artifact manifest). Several are now duplicated by the real
`tests/integration/resilience/*` work that landed; they will be retired from the ledger as
their subjects are genuinely covered. `CONN-900`/`901` graduated from planned to
implemented-and-skipping when A04 wrote them against these ids.

---

## 8. Secret hygiene, and two near-misses in my own tooling

The ledger quotes test source, and several fixtures are credential-shaped **on purpose**.
In their own files a `secret-scan:allow` marker exempts them; **that marker does not
survive harvesting**, so a naive ledger trips the secret scanner and GitHub push
protection.

Two defences:

1. **The harvester redacts on the way in** — `api_key: '<REDACTED-FIXTURE>'`,
   `https://<credentials-in-url>@api.hubapi.com/x`. The placeholder names what the fixture
   _is_.
2. **The checker refuses a ledger that skipped step 1.** Any ledger text matching a secret
   shape is a fatal integrity failure.

Both read the rule list from **`scripts/scan-secrets.mjs`** — the repository's single list
of secret shapes — rather than copying it.

> **Near-miss one.** The first parser recovered **16 of 18** rules: an unescaped `/` inside
> a regex character class ended the literal early and truncated the block. The two lost
> were `basic-auth-url` and `assigned-secret-literal` — _exactly_ the two matching the
> fixtures in question. It would have redacted nothing and reported success.
>
> **Near-miss two.** Having added an assertion that parsed-count equals declared-count, the
> rule list was later reformatted to multi-line entries with trailing commas. The parser
> recovered **15 of 18** and **refused to run**, naming the shortfall, instead of quietly
> redacting less. That is the assertion doing its job within an hour of being written.

**Open, and mine:** an earlier unredacted ledger generation is in git history at blob
`5b7c53de`. The working tree is clean (`scan-secrets` exit 0); only `--history` is red.
History rewriting is forbidden here, so the documented mechanism is the scanner's
pinned-SHA historical allowlist. That file is not mine — the lead's call.

---

## 9. Honesty — what a passing suite does not prove

**Mocked providers are not a working integration.** All but two connector cases drive a
stubbed `fetch`, and **those two have never run** — no HubSpot or Resend credential exists.
The suite proves our adapters handle the payload _we believe_ the provider sends. Until
`CONN-900`/`901` run, every claim about reading records back is **designed, not observed**.

**The authenticated interface is unmeasured.** 18 browser cases skip for want of a seeded
identity. Nothing behind a session is currently verified at any breakpoint by an executed
test — and three of those cases were passing _vacuously_ against an error page until A05
looked.

**Emulated mobile is not a physical device.** Resizing a desktop browser says nothing about
touch ergonomics, on-screen keyboards, iOS Safari, latency, or an old Android on a train.

**A green accessibility check is a floor.** Nobody has tested this product with a real
assistive-technology user.

**2,205 passing cases say nothing about demand** — not pricing, not positioning, not
whether an agency will edit their n8n workflow to call us. The product may be entirely
correct and commercially worthless.

**Also unproven:** behaviour inside Cloudflare's CPU and subrequest limits under real
traffic; D1 at a scale never run; that Stripe live mode behaves like test mode; that a
person can restore the backup under pressure; that redaction covers a payload shape a real
customer's CRM will contain.

---

## 10. Flake policy

1. **The first failure is kept**, with its output, against the release candidate.
2. **A passing rerun does not erase it.** It adds one fact: the failure is intermittent.
3. **Root cause before requeue.** "It passed the second time" is not a diagnosis.
4. **A flake is a defect in the test or the code, never in the weather.**
5. **A blocking case may never be quarantined to make the gate green.**
6. **No automatic retry in the deterministic suites.** Playwright retries in CI only, and a
   retried pass is reported as a retried pass.
7. **Quarantine is time-boxed and visible**, and counts zero.
8. **An infrastructure failure is recorded as an infrastructure failure, not as N defects.**

> **Observed, and worth knowing.** Three browser runs produced 34 spurious failures each
> because `wrangler dev` never became reachable: with a dozen agents editing, the dev
> server reloads continuously and the suite's `webServer` start races it. Recorded as one
> infrastructure error, not 34 defects. Running against an already-warm server produced the
> clean reading in §1. **The browser suite is not reliably measurable on a live working
> tree** — another reason the gate belongs in CI on a frozen commit.

---

## 11. Blocking and accepted risks

### Blocking

| Area                                     | Scope                                                                    | Why                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `verification_logic`                     | all 226                                                                  | A false VERIFIED or FAILED destroys the only thing the product sells.                              |
| `commerce`                               | all 281                                                                  | Money moving wrongly, twice, or service given away.                                                |
| `auth_tenancy`                           | all 169                                                                  | Cross-tenant access to other people's CRM evidence is unrecoverable.                               |
| `api_security_privacy` + the 156 `SEC-*` | all                                                                      | Public repo, public endpoint, customer data rendered to a browser. `SEC-206` is currently failing. |
| `persistence_concurrency`                | all 128                                                                  | Idempotency and tenant scope are enforced here or nowhere.                                         |
| `connector_contracts`                    | 256 stubbed                                                              | The two provider-backed cases block only once credentials are authorised.                          |
| `owner_panel`                            | approvals, cleanup safety, runner authorisation                          | The controls that stop the panel spending money or deleting a customer.                            |
| `budgets_models_maintenance`             | assistant boundary, reservation races                                    | Rule 9 is a launch condition.                                                                      |
| `customer_lifecycle`                     | signup → connect → rules → first run → report → cancel → export → delete | The paths a paying customer cannot route around.                                                   |
| `accessibility_resilience`               | outage, interrupted jobs, migration compatibility, restore               | What makes a bad release undoable.                                                                 |

### Accepted risks

| Risk                                       | Accepted                                                                                              | Why tolerable                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No provider-backed evidence**            | 2 of 258 connector cases touch a real provider; neither has run.                                      | Connector errors surface as `UNVERIFIED`, never a false `VERIFIED`. Launch material must say "designed, not observed". **Re-open the moment a credential exists.**  |
| **Authenticated interface unmeasured**     | 18 skipped browser cases.                                                                             | Unit and integration cover the logic beneath; this is an _interface_ evidence gap. Blocking for a UI release; the seeding script now exists, so it is one run away. |
| ~~**156 `SEC-*` uncountable**~~            | **Closed.** Ruled and applied — §6a. Each `SEC` case now declares its own category; no verdict moved. |                                                                                                                                                                     |
| **15 `SEC-12xx` ids are four digits**      | `shipped-encoders.test.ts` counts zero regardless of status.                                          | They pass, and `api_security_privacy` clears its floor 301/45 without them. A renumbering, not new work — §6c.                                                      |
| **36 ids still duplicated across 6 files** | Only one of each pair can be counted, and the ledger describes only one.                              | Each needs an agent other than A11 to move their side; proposals with free ids are in §6b. No floor depends on the difference.                                      |
| **No physical device testing**             | Emulated viewports only.                                                                              | Documented publicly rather than claimed; founder checks four pages on a real phone as a recorded manual step.                                                       |
| **No assistive-technology user testing**   | Automated checks only.                                                                                | Stated plainly; SECURITY.md forbids a compliance claim.                                                                                                             |
| **No load testing at scale**               | Largest measured page is 500 runs.                                                                    | `PLAN_RUNS_PER_PERIOD` bounds one workspace. Re-open before the second paying customer.                                                                             |
| **No penetration test**                    | An automated suite is not adversarial review.                                                         | SECURITY.md says so and offers a private reporting route.                                                                                                           |

---

## 12. Execution strategy inside the budget

```bash
pnpm typecheck
pnpm test            # vitest — outbound fetch blocked by tests/setup.ts
pnpm test:e2e        # playwright against wrangler dev + local D1
pnpm verify:cases    # ledger integrity, buckets, reconciliation
pnpm scan:secrets    # before every push
node scripts/build-test-report.mjs
node scripts/build-gate-artefact.mjs   # refuses a dirty tree; CI runs this one
```

Everything in that list except the last line is **a reading of a working tree**. Only the
`release-gate-<sha>` artefact produced by CI is a gate result — §2b.

Everything deterministic uses synthetic fixtures. `tests/setup.ts` fails loudly on any
outbound `fetch` — that is what makes "no real provider was contacted" a fact rather than
an intention. `ASSISTANT_MODE` is `off` in tests and the model router refuses a paid tier
without a budget reservation the harness never grants.

**Real-provider checks:** exactly two, both skipping. Each is a single read against a
provider _test_ account; they never write and never send. Running them also requires the
lead to add the provider hosts to the setup allowlist for that run — deliberately a
separate, visible act, so a provider cannot be contacted by accident.

**Never:** 500 real emails; 500 live charges (real signature verification over stubbed
payloads — the signature is real, the money is not); purchased clicks; any Cloudflare
resource not named `verify-itisyou-*`. Staging has no cron triggers, so a test environment
cannot generate recurring cost.

Migration `0003_quality_artifacts.sql` is applied to local, staging and production, so the
evidence pack from `build-test-report.mjs` has an authenticated home reachable from the
owner panel rather than the world-readable asset directory.

---

## 13. Running the checker

```bash
node scripts/verify-test-cases.mjs                   # buckets + integrity + reconciliation
node scripts/verify-test-cases.mjs --gate            # category floors are fatal
node scripts/verify-test-cases.mjs --strict          # tree defects are fatal
node scripts/verify-test-cases.mjs --strict --gate   # the release gate
node scripts/verify-test-cases.mjs --json            # machine-readable, for CI and audit
```

Take the **exit code**: `0` sound, `1` broken. On a clean export of `66b8d38`: plain `0`,
`--gate` `0`, `--strict` `1` (53 tree defects), `scan-secrets` `0`.

It exits 1 when: an id is duplicated or malformed; a prefix is off-allowlist; **a
`category` value is outside the twelve-category allowlist**; **a case whose prefix has no
default category does not declare one** (every `SEC-*` case); a required field is missing
or a text field empty; two cases share an identical `requirement` + `setup` (the padding
detector); `level`, `status` or `risk_source` is outside its set; a case claims a run
status with no matching test; a countable case carries a malformed id; **any ledger text
matches a secret shape**; or **the bucket arithmetic fails to balance** — including any
passing case that is uncountable for a reason the checker cannot name.

Both category rules were proved by breaking one entry and restoring it:

```bash
# 1. an off-allowlist category value
#    SEC-431.category := "security_regression"
node scripts/verify-test-cases.mjs --quiet    # exit 1
#    FAIL  [SEC-431] category `security_regression` is outside the twelve-category allowlist {…}

# 2. a SEC case with no explicit category
#    delete SEC-431.category
node scripts/verify-test-cases.mjs --quiet    # exit 1
#    FAIL  [SEC-431] prefix `SEC` spans several categories and has no default, so this
#                    case must declare `category` explicitly — one of {…}

# restored byte-for-byte; exit 0
```

**What it does not check, despite an earlier claim here:** numbering is _not_ verified to
be sequential from 001. `numbersByPrefix` is collected and never read. The gaps are
deliberate (ids are grouped in blocks by subject), so the right fix is this correction to
the prose rather than a new rule.

A sound ledger proves the count is honest. It does not make a failing suite green, and it
is not a readiness decision.
