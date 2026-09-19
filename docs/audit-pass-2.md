# Independent completion audit — pass 2

**Audit pass 2 · 19 September 2026.** Written by the Evidence and Completion Auditor, who
does not write product code and has authority to block a release.

Pass 1 (`docs/audit-summary.md`) ended: *"Taking payment: not ready. Release is blocked."*
This pass checks eight specific claims the lead made today. Every claim was treated as
unproven until the evidence was found here, by running the command or reading the file.

**The repository moved twice during this audit.** It began at `0852238` with fourteen
modified files in the working tree; the lead committed them as `af23e906` mid-audit, and
production was redeployed at `22:28:31Z` while item 5 was being checked. Every finding
below names the state it was taken against. Pass 1 had the same problem and said so; it is
worth repeating that an audit chasing a moving tree is worth less than one against a pinned
commit.

- **Pinned for this pass:** `af23e9069187265016cc47ba3124dfe095297d3c`, working tree clean.
- **Environments touched:** `verify.itisyou.app` (production), `verify-itisyou-db-staging`
  and `verify-itisyou-db-production` (remote D1), GitHub Actions run `35473297078`.

---

## Verdicts at a glance

| # | Claim | Verdict |
| --- | --- | --- |
| 1 | Email evidence binds only on the provider message id; zero-match and ambiguous are distinct | **CONFIRMED** |
| 2 | `docs/correlation-reproduction.py` is the owner's file, unmodified, and still fails 4 of 8 | **CONFIRMED** |
| 3 | CONN-330..337 port R01..R08 faithfully | **CONFIRMED** (one scope gap, below) |
| 4 | `run_01M2XTQ7H8FFAAC8673E6D43A9` reached VERIFIED on `provider_readback` evidence | **CONFIRMED** |
| 5 | Production serves an old build; `POST /api/v1/events` returns 500; public pages 200 | **CONFIRMED at the time of the claim, FALSE as of 22:32Z** |
| 6 | Today's ~338 ledger entries are legitimate reconciliation, not number inflation | **CONFIRMED — not inflation** (three bookkeeping defects, all under-stating) |
| 7 | CONN-317/318/319 retired honestly because their tests were deleted | **CONFIRMED** |
| 8 | £0 spent, no campaign, nothing in the repo contradicts it | **CONFIRMED** |

**And one finding that was not claimed and was not caught:**

| # | Finding | Severity |
| --- | --- | --- |
| F1 | The R04 rule ("an ambiguous message id must not bind") is **not enforced on the evidence-inbox recovery path** added later the same day. No test covers it. | **High — blocking** |

---

## 1. Correlation — CONFIRMED

Commit `76b8a7a`, file `apps/app/src/db/resendWebhookPort.ts`.

**The recipient does not appear in the binding path at all.** Not as a fallback, not as a
tiebreak, not as a filter.

| Check | Evidence |
| --- | --- |
| The binding query keys on the message id alone | `resendWebhookPort.ts:397-406` — the only predicate besides tenancy is `json_extract(se.payload_json, '$.expected.email_message_id') = ?`. No `email_recipient`, no `lower(trim(...))` address clause of the kind the reproduction models at its `BY_RECIPIENT` (`correlation-reproduction.py:28-37`). |
| `LIMIT 2` is used, so ambiguity is observable | `resendWebhookPort.ts:405`, with the reason stated at `411-412`: *"A `LIMIT 1` would return the first of several and look exactly like a clean single match."* |
| Zero-match and ambiguous are distinct outcomes | Union type at `resendWebhookPort.ts:44-47`: `matched` / `unmatched` / `ambiguous`. Returned separately at `413` (`no_run_expects_this_message`) and `414` (`several_runs_expect_this_message`), plus `382` (`event_carries_no_message_id`) and `393` (`connection_not_owned_by_workspace`). |
| Only `PENDING` runs are candidates | `resendWebhookPort.ts:403` — so a decided run cannot be reopened by a late callback. |
| The *other* binding surface also binds on the id alone | `claimInboxForRun`, `resendWebhookPort.ts:507-560`. Its SELECT (`517-531`) filters on `workspace_id`, `message_id`, `reason`, `claimed_at`, `expires_at`. No address. |
| The scheduler never reaches the recipient to bind | `apps/app/src/scheduler/observe.ts:282-298` — the claim is gated on `locator.message_id !== undefined`. |
| The provider readback is keyed by id | `packages/connectors/src/resend.ts:655` — `this.readEmail(token, messageId, …)`, i.e. `GET /emails/{id}`. The recipient arrives *in the response* and is used as an assertion input, never as a lookup. |
| Recipient survives only as a post-binding assertion | `apps/app/src/db/ruleCompiler.ts:112, 159-166` (`email_recipient_matches`, `expected_from: source_event.email_recipient`); `observe.ts:321` feeds it to the evaluator. `customerPort.ts:585` and `1078-1112` are display only. |

The claim is accurate, and the code's own comment (`346`: *"The provider's message id is the
only thing that binds. The recipient never binds."*) is a statement the implementation keeps.

---

## 2. The owner's reproduction — CONFIRMED

Byte-identical:

```
$ md5sum docs/correlation-reproduction.py /h/ITISYOU_Verify_Correlation_Reproduction.py
fdd469dffbbced57a9058ea80b253ca0 *docs/correlation-reproduction.py
fdd469dffbbced57a9058ea80b253ca0 */h/ITISYOU_Verify_Correlation_Reproduction.py
$ cmp docs/correlation-reproduction.py /h/ITISYOU_Verify_Correlation_Reproduction.py
IDENTICAL
```

And it still fails, exactly as the owner's header promises it must:

```
$ python docs/correlation-reproduction.py
...
AssertionError: 'A' is not None   test_R03_wrong_id_cannot_fall_back_to_address
AssertionError: 'A' is not None   test_R04_ambiguous_id_cannot_fall_back_to_address
AssertionError: 'B' is not None   test_R05_old_delivery_cannot_attach_to_new_pending_run
AssertionError: 'A' is not None   test_R06_address_alone_does_not_prove_an_enquiry
----------------------------------------------------------------------
Ran 8 tests in 0.003s
FAILED (failures=4)
```

The file was not edited to make it pass. The four failures are the four the lead reported,
and they are failures of the *superseded* implementation the file deliberately models
(`correlation-reproduction.py:6-9`), not of the current one.

---

## 3. The ported cases — CONFIRMED, with one scope gap

`tests/integration/db/resendWebhook.test.ts:477-532`, read line by line against
`docs/correlation-reproduction.py:76-112`. Nothing was weakened.

| Repro | Seeds | Repro asserts | Ported case | Ported asserts | Faithful? |
| --- | --- | --- | --- | --- | --- |
| R01 | A(M1, a@) | `== 'A'` | CONN-330 | `boundRun() === 'A'` | yes |
| R02 | A(M1, a@), B(M2, a@) | `== 'B'` | CONN-331 | `boundRun() === 'B'` | yes |
| R03 | A(M1, a@) | `is None` | CONN-332 | `countRows(evidence) === 0` | yes |
| R04 | A(M1, a@), B(M1, b@) | `is None` | CONN-333 | `countRows(evidence) === 0` | yes |
| R05 | A(M1, a@, **VERIFIED**), B(M2, a@) | `is None` | CONN-334 | `countRows(evidence) === 0` | yes |
| R06 | A(**no id**, a@) | `is None` | CONN-335 | `countRows(evidence) === 0` | yes |
| R07 | A(M1, a@), delivered to `wrong@` | `== 'A'` | CONN-336 | `boundRun() === 'A'` | yes |
| R08 | A(no id, a@), B(no id, a@) | `is None` | CONN-337 | `countRows(evidence) === 0` | yes |

The "no id" seeds are genuinely id-less: `tests/integration/db/harness.ts:305-312` omits
`email_message_id` from the payload entirely when `emailMessageId` is undefined, which is
what `seed(..., message_id=None)` does at `correlation-reproduction.py:55-62`. CONN-338
additionally proves the two negative outcomes are reported distinctly, which the Python
cannot express because it collapses both to `None`.

`boundRun()` (`resendWebhook.test.ts:472-475`) returns `null` unless *exactly one* evidence
row exists, so R01/R02/R07 assert both the count and the identity. That is stronger than the
reproduction, not weaker.

**The scope gap.** The reproduction asserts *"nothing is returned"*. The four negative cases
assert *"nothing is written to `evidence`"* — true, and correct for binding — but the port
now **also parks the unbound callback** in `evidence_inbox` (`resendWebhookPort.ts:425-492`),
and none of CONN-332/334/335/337 asserts anything about that row. That parked row is
claimable later. See F1.

---

## 4. The verified run — CONFIRMED

`cd apps/app && npx wrangler d1 execute verify-itisyou-db-staging --remote --json --command …`

```
runs
  id          run_01M2XTQ7H8FFAAC8673E6D43A9
  status      VERIFIED
  workflow_id wf_slice_proof_0001
  created_at  2026-09-19T21:56:21.628Z
  completed_at 2026-09-19T22:00:55.000Z   (deadline 22:11:21.628Z — inside it)

assertions (2 rows, both mandatory = 1)
  email_delivered          SUPPORTED  MATCHED  observed "delivered"
  email_recipient_matches  SUPPORTED  MATCHED  observed "delivered@resend.dev"
  both -> evidence_id evd_01M2XV0QKBFE1506FF5A1041E5

evidence (1 row)
  origin              provider_readback        <-- NOT customer_claim
  provider            resend
  provider_record_id  01a0bbab-7989-776c-8cd6-58278e013380
  redacted_summary    "email 01a0bbab-…; recipient d**@resend.dev; status delivered; …"
```

Every element of the claim holds. The origin is `provider_readback`, which per
`packages/contracts/src/evidence.ts:21` means the connector's own HTTP call — not a webhook
assertion and not a fixture. The recipient is masked in storage. Both mandatory assertions
are SUPPORTED/MATCHED, and the verdict is VERIFIED. This is corroborated by
`docs/deployed-evidence.md`, which records the same run.

---

## 5. Production — CONFIRMED at the time of the claim, FALSE as of 22:32Z

At roughly **22:1x UTC**, before the lead's redeployment:

```
POST https://verify.itisyou.app/api/v1/events   ->  500
{"error":{"code":"INTERNAL_ERROR","message":"Something went wrong on our side. …",
          "request_id":"a3dbfe728ca02736"}}
```

At **22:28:31.907Z** a new production deployment landed (`wrangler deployments list
--name verify-itisyou-production`, version `9f8c213d-84ee-4f1a-b630-991ef7d31cbc`, source
"Unknown (deployment)").

At **22:32:06Z**, after that deployment:

```
POST https://verify.itisyou.app/api/v1/events   ->  401
{"error":{"code":"SIGNATURE_INVALID","message":"The request signature could not be verified."}}
```

The public pages were 200 at both times:

```
/              200       /privacy      200       /security     200
/pricing       200       /terms        200       /admin/login  200
```

**The consequence, stated plainly:** the claim was true when made and is now stale. If it
is repeated after 22:28Z it becomes **FALSE** — production no longer 500s; it refuses an
unsigned event correctly. `docs/deployed-evidence.md:9` ("production was still serving an
older build at the time of writing; its intake answered 500") is now a stale statement in a
published document and should be dated or corrected rather than left standing.

I have not verified that the newly deployed build *is* `af23e906`; the deployment list
carries no commit tag. That the intake now behaves correctly is evidence it is newer than
the 500-ing build, not proof of which build it is. **Recorded as unverified.**

---

## 6. The number — CONFIRMED. This is not inflation.

I scrutinised this hardest, as instructed, and I could not break it.

### What actually changed

`af23e906` moved `docs/test-cases.json` from **2,296** to **2,648** rows: **368 added, 16
removed, net +352**. (The lead said "~338"; the commit message says 338 *newly registered
from the tree*, the remaining 30 being rename targets. The net figure is +352. A small
imprecision in the framing, not in the ledger.)

Of the 368 new rows: **314 countable and passing, 54 `implemented` and explicitly not
countable.** The 16 removals are `SEC-1201..1219` and `SEC-431` — malformed four-digit ids
and one off-allowlist id, renamed in the tree.

### Every question asked, answered

| Question | Answer | How |
| --- | --- | --- |
| Does every newly registered id appear in a test title? | **Yes — all 368, no exceptions.** | Regex over all 173 files in `tests/` for `it`/`test`/`describe` titles led by a case id; 2,634 distinct ids found; set difference with the 368 new ids is empty. |
| Are there countable rows with no test at all? | **No — zero.** | Same scan: `countable && status=="passing"` rows absent from the title set = 0. The 19 ledger-only ids are 14 `planned` (countable, but *not counted* — counting requires `passing`), 3 `retired` (not countable) and 2 declared skips. |
| Is any new countable case a `it.skip` / `it.todo`? | **No — zero.** | Direct scan for `it.skip(`/`test.skip(`/`.todo(` against the 314 ids. |
| Is any new countable case assertion-free? | **No.** | Assertion-count scan over each test body: distribution 1×49, 2×70, 3×61, 4×46, 5×28, 6+×59. The single apparent zero, `BUDGET-017`, was my extractor mis-parsing a template-literal title; the test has seven `expect(` calls (`tests/integration/assistant/tool-result-taint.test.ts:130-155`). |
| Does every "passing" row correspond to a recorded pass? | **Yes — all 2,534.** | 2,521 vitest rows matched against `reports/test-results.json`; 13 playwright rows against `reports/pw.json` (`expected: 15, unexpected: 0`). Rows passing in the ledger but not passed in a run artefact: **0**. |
| Is the run artefact trustworthy? | **Yes — it is the CI artefact, byte for byte.** | See below. |
| Does an independent run agree? | **Yes.** | See below. |

### The run artefact has genuine CI provenance

`reports/` is gitignored (`.gitignore:66`) and untracked, so the local copies prove nothing
on their own — and in fact they were regenerated twice while this audit was running. So I
fetched the authoritative artefact instead:

```
$ gh run view 35473297078 --repo leelaravind/itisyou-verify
✓ main CI · 35473297078   (push, af23e906, success, 1m34s)
  ✓ typecheck, lint, tests, secret scan
  ✓ release gate number (clean checkout, one SHA)
  ARTIFACTS  release-gate-af23e9069187265016cc47ba3124dfe095297d3c

$ gh run download 35473297078 -n release-gate-af23e90… && md5sum …
97bf134f9be527aeeac22a296f3bef7a  CI release-gate.json   ==  reports/release-gate.json
dcfe7d236bfad7ca3c27d204dfa094af  CI test-results.json   ==  reports/test-results.json
65bf52f90af6800db323f0f2a263d550  CI pw.json             ==  reports/pw.json
```

All three local files are **byte-identical** to what GitHub Actions produced on a clean
checkout of `af23e906`. The citable number is not a local artefact the lead can rewrite.

### And I ran the suite myself

```
$ npx vitest run --reporter=json
{ numTotalTests: 2595, numPassedTests: 2592, numFailedTests: 0,
  numPendingTests: 3, success: true }
```

Cross-referenced against the ledger: of the **2,521** rows marked countable-and-passing with
`runner: vitest`, the number that did **not** pass in my own independent run is **zero**.
The nine ported correlation cases (CONN-330..338) all passed. The four rows created by
today's renames (`AUTH-019`, `CONN-050`, `CONN-051`, `SEC-038`) all passed.

The 13 playwright rows I did **not** re-run — they need a live deployment and a seeded
session. They are backed by the CI `pw.json` only. **Recorded as verified-by-artefact, not
independently re-executed.**

### The gate check, verbatim

```
$ node scripts/verify-test-cases.mjs --strict --gate
EXIT=0

ITISYOU Verify — release test ledger
  ledger      docs/test-cases.json (generated 2026-09-19T22:24:13.148Z, snapshot 0852238)
  test tree   tests/ — 173 file(s) scanned
  reading of  a working tree at af23e9069187, clean

  category                        total   pass  fail  plan  unmeas   min  COUNTED  verdict
  verification_logic                242    242     0     0       0    65      242  ok
  connector_contracts               299    294     0     0       0    45      294  ok
  persistence_concurrency           128    128     0     0       0    45      128  ok
  auth_tenancy                      211    196     1     0      14    55      196  ok
  commerce                          363    351     0     0      12    50      351  ok
  customer_lifecycle                353    319     1     0      18    45      319  ok
  owner_panel                       374    364     0     0       9    45      364  ok
  api_security_privacy              355    333     0     0      22    45      333  ok
  budgets_models_maintenance         52     52     0     0       0    35       52  ok
  advertising_analytics             138    136     0     0       0    25      136  ok
  accessibility_resilience           97     86     0    11       0    30       86  ok
  stories_release_hygiene            36     33     0     3       0    15       33  ok
  ----------------------------------------------------------------------------------------
  TOTAL                            2648   2534     2    14      75   500     2534  floor met

  Reconciliation (ledger vs case ids in test titles)
    in the ledger                2648
    in the test tree             2629
    in both                      2629
    in the tree, not the ledger  0
    in the ledger, not the tree  19

  Ledger integrity: PASS
```

### Three bookkeeping defects found — all of which *under*-state, none of which inflates

**(a) Two rows are marked `failing` that every recorded run says passed.** The ledger's own
stated basis is *"status = the recorded run"*. It is not, for these two:

| Row | Ledger | CI `test-results.json` | CI `pw.json` | My own run |
| --- | --- | --- | --- | --- |
| `SEC-206` | failing | **passed** | — | **passed** |
| `CUST-079` | failing | — | **passed** | — |

Worse, the repository contradicts itself about `SEC-206` in public documents:
`docs/threat-model.md:769-771` and `docs/test-plan.md:709` assert it is **currently
failing**; `docs/gap-register.md:151` says **Failing**; `docs/security-acceptance.md:67`
says **PASS**. One of these is wrong and it is the three that say failing. A stale
"a security test is red" claim is the safer direction to be wrong in, but it is still a
false statement in a published document, and the claim-scanning gate did not catch it.

**(b) The ledger mislabels which commit it is a snapshot of.** `docs/test-cases.json`
declares `"snapshot_commit": "0852238"` and is committed in `af23e906`, whose tree it
describes. Self-reported provenance that names the wrong commit is exactly the kind of thing
this project exists to object to.

**(c) The verifier's "ran in the recorded run" label overstates what the verifier checks.**
`scripts/verify-test-cases.mjs` prints `executed (ran in the recorded run) 2556` and
`not executed (exists, absent from that run) 78` — but the script never opens
`reports/test-results.json`, `pw.json` or any run artefact. Those buckets are derived
entirely from the ledger's own `status` field (`verify-test-cases.mjs:799` defines
`EXECUTED_STATUSES`; `828-829` assigns the buckets from it). The script is honest in its
closing line (*"Ledger integrity: PASS. A sound ledger proves the count is honest. It does
not make a failing suite green."*), but the bucket label says the run was consulted and it
was not. **The gate the lead ran does not, by itself, prove any case ever executed.** The
number happens to be correct — I proved that against CI and against my own run — but it was
proved by me, not by that command.

### Verdict on the number

**2,534 is a real number.** Not one row counts that should not. The direction of every error
I found is conservative. The accusation of inflation is not supported by anything I could
find, and I looked for it specifically.

---

## 7. Retired cases — CONFIRMED

`CONN-317`, `CONN-318`, `CONN-319` appear **nowhere** in `tests/`, `apps/` or `packages/`
(recursive grep, `.ts`/`.tsx`): zero hits. The tests really are gone.

The ledger rows are retained, with:

```
"status": "retired",  "countable": false,
"requirement": "… — RETIRED: Superseded by CONN-332: an address may not bind evidence
                at all, so 'goes to the run whose enquiry named that recipient' is no
                longer the rule."
```

(and likewise CONN-318 → CONN-330/331, CONN-319 → CONN-333).

This is the honest handling. Deleting the rows would erase the record that a rule once
existed and was superseded; retaining them at `countable: false` keeps the history auditable
and worth exactly zero toward the gate. Confirmed: they contribute 0 to the 2,534.

---

## 8. Spend — CONFIRMED

The documents say £0 and the databases agree.

| Source | Statement |
| --- | --- |
| `docs/advertising.md:4-6` | *"Nothing in this document has been spent, created, submitted or activated. No advertising account exists."* |
| `docs/campaign-packet.md:4` | *"NOT APPROVED. NOT SUBMITTED. NOTHING HAS BEEN SPENT."* |
| `docs/spend.md` §1 | Campaign spend **£0.00**; £15 allocation reserved and untouched; £30 contingency untouched |
| `docs/completeness-report.md:69` | Advertising **£0.00** |
| `docs/gap-register.md:179` | £0.00 spent of £100 |

Checked against both remote databases rather than taking the documents' word:

```
verify-itisyou-db-production   campaigns 0  non_draft 0  approvals 0  consumed 0  metrics 0
verify-itisyou-db-staging      campaigns 0  non_draft 0  approvals 0  consumed 0  metrics 0
```

No campaign exists in any state. No approval has ever been created, let alone granted or
consumed — and `apps/app/src/db/ownerPort.ts:964-1088` makes a consumed approval a
precondition of activation. The £0.00 is structural, not merely unexercised. Nothing in the
repository contradicts it.

**One qualification, which `docs/spend.md` §3 makes itself and I am repeating rather than
discovering:** £0.00 is precise for *advertising and infrastructure*. It is not a total
project cost — Claude model usage is real, substantial and unquantified, and whether it
counts against the £100 is an undecided question the owner must settle. The document says
so plainly and does not hide behind the £0.00. That is the right way to report it.

---

## F1 — The ambiguity rule is not enforced on the recovery path. **Blocking.**

Not one of the eight claims. Found while checking claim 1, and it is the most serious thing
in this audit.

### What the code does

Three commits landed today, in this order: `76b8a7a` (id-only binding), `9467038` (park
unbindable callbacks in an inbox), `e9524a6` (the scheduler drains that inbox). The rule the
owner's R04 establishes — *an ambiguous message id must bind nothing* — is enforced in the
first and bypassed by the third.

- **Live path.** Two `PENDING` runs name `M1`; a delivery for `M1` arrives.
  `#correlateEmailEvidence` returns `ambiguous` (`resendWebhookPort.ts:414`), the callback is
  parked with `reason = 'ambiguous'`, and `claimInboxForRun` filters `reason = 'unmatched'`
  (`resendWebhookPort.ts:521`) so it can never be claimed. `CONN-333` and `CONN-342` prove
  this. Correct.
- **Recovery path.** The same delivery arrives **before either run exists** — which is the
  precise ordering the inbox was built for (`resendWebhookPort.ts:298-302`: *"the provider
  fires `email.sent` in milliseconds and the customer's automation reports the enquiry
  afterwards"*). Zero runs match, so it parks with `reason = 'unmatched'`. The two runs are
  then created, both naming `M1`. `claimInboxForRun` (`517-531`) filters only on
  `workspace_id`, `message_id`, `reason = 'unmatched'`, `claimed_at IS NULL` and
  `expires_at`. **There is no ambiguity re-check and no `status = 'PENDING'` check on the
  claiming run.** Whichever run the scheduler observes first takes the evidence.

### Reproduced

Against the exact SQL as written in `resendWebhookPort.ts:397-419` and `517-531`, in an
isolated sqlite model (no application file was modified):

```
--- live path, two runs already naming M1 (CONN-333 / R04) ---
  correlate(M1) -> ('ambiguous', 'several_runs_expect_this_message')
                   => parked "ambiguous", never claimable (CONN-342)

--- recovery path: SAME ambiguity, delivery arrives FIRST ---
  no runs yet: correlate(M1) -> ('unmatched', 'no_run_expects_this_message')
  parked with reason = unmatched
  now two PENDING runs both name M1 - genuinely ambiguous
  run A observes first: claimInboxForRun(A,M1) -> 1 row(s) written
  run B observes next : claimInboxForRun(B,M1) -> 0 row(s) written
  evidence: [('evd_1', 'A')]
  => the ambiguity R04 forbids was resolved by observation order.
```

### Why it matters

The comment at `resendWebhookPort.ts:494-497` states: *"Rows parked as `ambiguous` are never
claimed — an ambiguity does not become resolvable later just because one of its candidates
asked."* That is true only when the ambiguity was **visible at park time**. When it is not,
the ambiguity is resolved by cron scheduling order, which says nothing whatsoever about
which enquiry the delivery belongs to.

This is the same failure class as the recipient fallback that `76b8a7a` removed: *one
enquiry's acknowledgement satisfying a different enquiry's check, while every assertion
around it stays correct*. It can produce a **VERIFIED verdict on the wrong run** — which
falsifies the only claim the product makes. The risk text the lead wrote for CONN-317/318/319
describes this exact outcome.

### Why it was not caught

`CONN-342` ("an ambiguous callback is parked but never claimed",
`resendWebhook.test.ts:627-650`) seeds **both runs before the callback arrives**, so the
ambiguity is visible at park time and the row is parked `ambiguous`. It never exercises the
ordering that produces an `unmatched` park followed by a contested claim. `CONN-332/334/335/337`
assert only `countRows(evidence) === 0` and say nothing about the parked row that survives —
the scope gap noted in item 3. Nothing in the suite covers this.

### What would close it

Re-checking, at claim time, that exactly one `PENDING` run in the workspace names that
message id — the same `LIMIT 2` test the live path already performs — and asserting it with a
test whose delivery arrives before any run and whose ambiguity appears afterwards.

*I do not write product code; this is stated as the shape of the fix, not as a patch.*

---

## What this pass does not prove

- **The tree moved twice under me.** `0852238` → `af23e906`, and a production deployment at
  `22:28:31Z`. Items 1–3 and 6–8 were re-verified against the pinned `af23e906`. Item 5 is
  reported with both timestamps because it changed mid-check.
- **The identity of the deployed production build is unverified.** It is newer than the
  500-ing build; which commit it is, I did not establish.
- **13 playwright cases were not independently re-executed.** They need a live deployment and
  a seeded session. They rest on the CI `pw.json`.
- **Payments were not re-examined in this pass.** No claim asked me to, and I have not
  re-checked anything in pass 1's payment findings.
- **No audit shows defects are absent.** F1 was found by reading a path nobody claimed was
  safe. There may be others in paths nobody claimed at all.

---

## RELEASE VERDICT

**The public website: unchanged from pass 1 — live, accurate, safe to use.**

**Taking payment: still not ready. Release remains BLOCKED.**

Three reasons, in order of weight:

1. **F1 is an open, reproduced, untested correctness defect in the evidence-binding
   mechanism** — the mechanism pass 1 already blocked on and the one the owner's
   reproduction exists to police. It can attach one enquiry's delivery evidence to a
   different enquiry and publish a VERIFIED verdict on it. It was introduced today, by the
   two commits that followed the fix, and no test covers it. A product whose entire claim is
   "we check whether the thing actually happened" cannot ship a binding path that resolves
   ambiguity by cron order.
2. **Nothing in these eight claims addresses pass 1's payment blockers.** The payment routes
   being switched on, the two incompatible billing-period key formats, and the pre-checkout
   payment-failure policy were not in scope today and have not been re-verified. They remain
   open until someone checks them.
3. **The repository changed three times during a two-hour audit, including a production
   deployment.** That is not itself a defect, but it means no single commit has been audited
   end to end today, and a release decision needs one that has been.

**What is genuinely better than it was this morning, and should be said:** the correlation
fix is real and the recipient truly does not bind. The owner's reproduction was vendored
unmodified and still fails, which is the honest thing to have done with it. Its eight cases
are ported faithfully and pass against the real database. The product produced its first
VERIFIED verdict from real provider evidence on a deployed environment, with
`origin: provider_readback` and a masked recipient. The citable test number survived the
hardest scrutiny I could apply — 2,534, backed byte-for-byte by a genuine CI artefact and
corroborated by my own independent run of the suite. **The count was not inflated. I looked
for that specifically and it is not there.**

None of that is a reason to take money yet.

---

*Pass 2 checked eight claims against `af23e9069187265016cc47ba3124dfe095297d3c`, the
production origin, two remote D1 databases and GitHub Actions run `35473297078`. Six claims
confirmed outright, one confirmed-then-superseded by a deployment made during the audit, one
confirmed with three under-stating bookkeeping defects named. One unclaimed blocking defect
found and reproduced.*
