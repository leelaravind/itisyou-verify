# Customer acceptance report — ITISYOU Verify

22 September 2026. Run entirely through the normal browser interface as the existing
authorised test user in its existing workspace, on production. No database edits, no seeded
sessions, no developer endpoints, no injected evidence, no direct backend submissions, no
allowance resets. Database reads quoted here are read-only and were taken to explain
customer-visible failures, never to substitute for them.

Full working record: `docs/evidence/acceptance-test-phase-1.txt`.

## Verdict

**The product does not yet pass a customer acceptance test.** Four customer-visible defects
were found and fixed, three of them in the first two actions a customer would take. The
success path — a run that reaches VERIFIED — remains unproven on every deployment this
product has ever had.

What was exercised works, and several things work unusually well. What could not be exercised
is named as untested rather than inferred.

## Baselines

| Phase | Commit | Time (UTC) | Consumed | Reserved | Limit |
| --- | --- | --- | --- | --- | --- |
| 1 | `b954bbcb101c` | 12:46:01 | 0 | — | 500 |
| 2 | `92ed30dee962` | 13:04:35 | 0 | — | 500 |
| 3 | `e6861bd3a2c5` | 13:22:24 | 0 | — | 500 |
| final | `b6df26b2376a` | 13:40 | **2** | **0** | 500 |

The allowance is 500, not 300, and was 0 when the test began. Each phase ended at a defect,
as instructed, and resumed from a freshly recorded baseline after a gated deploy.

## Attempted, admitted, settled

| | |
| --- | --- |
| Verifications attempted | 3 (one refused before submission) |
| Admitted | 2 |
| Settled | 2 |
| Unresolved at report time | 0 |
| Expected-result matches | 2 of 2 |
| Mismatches | 0 |
| Allowance consumed | 2 |

Both admitted runs settled FAILED, which was the expected result: their CRM record and
message id did not exist, and an authoritative absence after the deadline is a real failure
by design. Both settled inside a minute of their ten-minute deadline. Nothing timed out.

## Accounting reconciliation

Read from `entitlements` after both runs settled:

```
run_limit 500 · consumed 2 · reserved 0 · updated_at 2026-09-22T13:36:26Z
```

Two admitted, two consumed, nothing stranded in reserve. The counters reconcile exactly. No
retry or duplicate double-charged. The `reserved` counter moved and returned to zero as the
runs settled, so reserve-then-settle works — it is simply never shown to the customer.

The `got 2, wanted 1` double-charge recorded against staging `5b21ed2f70ab` on 21 September
**does not reproduce** from a quiet baseline, and is consistent with two testers running
concurrently rather than a billing fault.

Test runs are labelled `owner_test`, counted against the allowance, and excluded from the
verification rate — which is correct on all three counts, and the usage page says so.

## Defects found

All four were met through the customer interface, on production, and all are fixed, gated and
deployed. Each carries a mutation-checked regression case.

**1. Testing a connection moved it backwards.** `high`
Pressing "Test Resend connection" on a healthy connection flipped it READY → NOT FINISHED YET
and contradicted itself: "a correctly signed callback has been received and understood"
directly above "we have never actually received a message signed with it". `testConnection`
called the connector without `webhook_verified_at`, the one field Resend decides readiness on.
A dead end, too — the webhook route re-promotes only while that field is null, so no later
delivery could recover it. The identical omission had already been found and fixed in the
credential-save path. `CONN-902..904`.

**2. An unreachable provider un-connected a working connection.** `high`
A transient Resend error classified as `PROVIDER_UNAVAILABLE`, which `statusForError` mapped
to `not_connected` — the state meaning "you have never connected this". The card offered
"Connect this provider" directly beneath its own promise never to make the customer paste a
working key again. Not cosmetic: `not_connected` is outside the scheduler's `USABLE_STATUSES`,
so a bad minute at a provider takes the connection **out of service for real runs**.
`CONN-905..907`, and `CONN-521` strengthened.

**3. Every absence-failure was reported as a contradiction.** `high`
A run that retrieved nothing was announced as "We retrieved the evidence and it contradicts at
least one of your required checks", above a table reading "no reading" twice and a counter
reading "0 of 2 items did not match". `decideRunStatus` computes `FAILED_ABSENT` correctly and
it is never persisted — `runs` has no `reason` column — so every surface re-derived a sentence
from the status alone. Systematic, not an edge case. `VERIFY-901..904`, `CUST-961..962`.

**4. The run page kept serving the old sentence after (3) was fixed.** `medium`
My own incomplete fix, caught by re-reading the deployed page rather than trusting the unit
test: `RunDetailPage` called `explainRunStatus(run.status)` without the results it already
had. Two surfaces were fixed and the one a customer reads was not. `CUST-963..964` assert the
**rendered page** through the Worker entry point.

## What works

Confirmed through the interface, not inferred:

- **Connection testing separates three questions** — API access, webhook readiness, workflow
  verification — and refuses to answer the third, saying so plainly. HubSpot's card was
  correct throughout.
- **Credentials survive a check.** No test retired or rewrote a stored credential.
- **Invalid input is refused before submission and costs nothing.**
- **PENDING → settled works**, within a minute of a ten-minute deadline.
- **A test run is labelled as one on its own page**, counted against the allowance, and
  excluded from the verification rate.
- **Recipients are masked** (`a**@example.com`). No credential appeared on any screen.
- **Empty states refuse to flatter.** "An empty workflow is not a passing workflow." No
  accuracy percentage is shown where there is nothing to score.
- **The run detail page is genuinely good** — per-check expected-against-observed, a reason
  code, and a next step per check.

## Untested, and why

**The success path has never been demonstrated anywhere.** Staging settled UNVERIFIED with
`CONNECTION_UNAVAILABLE`; production has now produced FAILED. **No deployment of this product
has ever produced a VERIFIED result.** Proving it needs a real HubSpot contact carrying a known
`itisyou_verify_ref`, and a real Resend message id with a known recipient — fixtures only the
account owner can create. Requested; not supplied at time of writing.

Blocked on those same fixtures:

| Matrix row | State |
| --- | --- |
| Correct CRM correlation and recipient | **untested** — needs a real record and message |
| Wrong recipient | **untested** — needs a real message to mis-address |
| Existing CRM record, wrong correlation | **untested** — needs a real record |
| Missing or unavailable evidence | tested — verdict correct, explanation was defect 3 |
| Pending progressing to settled | tested — passes |
| Invalid input | tested — passes |
| Repeated clicks and duplicates | tested — see friction 4 |

**300 runs is unreachable through the customer flow.** Guided test verification is rate
limited to four per hour per workspace (`consume(db, 'test-verification:<ws>', 4, 3600)`).
Three hundred runs is seventy-five hours of continuous pressing. **The 300-run volume and the
500-run allowance boundary are therefore both untested**, and reaching either would require
altering production entitlement data or the limiter, which was ruled out.

**The external automation path is untested.** The website's guided form exercises the internal
pipeline and proves nothing about whether an outside automation signs and sends events
correctly — the page says so itself. No authorised automation was available to trigger.

## Customer friction, by impact

1. **A test run is indistinguishable from a real one in `/app/runs`.** Labelled on its own
   page, excluded from the rate, but the list shows no badge and offers no real-versus-test
   filter. Two test runs currently read as two customer failures at a glance.
2. **`reserved` is never shown.** The data exists; a customer cannot see how much allowance is
   committed to runs in flight.
3. **No oldest-pending age.** "3 pending" reads the same at three minutes and three hours.
4. **Duplicate submissions are silent.** No confirmation and no warning; a second identical
   enquiry costs a second run. Defensible by design — de-duplication keys on the event id —
   but the usage page tells the customer "One enquiry, counted once".
5. **Invalid input uses the browser's native bubble**, the one error in the product that does
   not look like the product.
6. **The verdict sentence now appears twice** on a settled run page. Introduced today by the
   defect-3 fix; recorded rather than patched, to fold into the next change.

Dashboard proposals addressing 1–3: `docs/dashboard-metrics.md`.

## Independent review

One reviewer, given sanitised evidence and no authentication secrets, checked the claims in
the evidence file against the code and the suite. Result: **OVERCLAIMS: none.** It confirmed
each of the seven substantive claims at file and line, ran 124 tests across the six implicated
files, and verified that both the false "not one case in the tree touched it" claim and its
later correction check out against the commits.

It raised one finding of its own, now fixed: the `CONN-188` ledger entry still recorded the
pre-fix assertion text. It also correctly noted that two statements — that the 13:04:54Z
Resend refusal was a genuine transient, and the speculation about throttling — are live
observations it cannot verify from a static read. Both are recorded in the evidence file as
observations rather than findings.

## Cost

Two runs of a 500-run allowance. Four gated deploys. No paid upgrade, no additional spending,
no change to entitlement data. Ads remain paused and live payments remain disabled.

## What to do next

1. **Supply the two fixtures** (a HubSpot contact id with its `itisyou_verify_ref` value, and
   a Resend message id with its recipient). Without them the success path stays unproven.
2. **Badge and filter test runs in the runs list** — the highest-impact friction found.
3. **Decide about the 500-run boundary.** It cannot be reached honestly through the customer
   flow. Either accept it as untested, or test it somewhere that is not production.
4. **Trigger the external automation path** through an authorised automation, or accept it as
   untested. It is the one path the guided form explicitly cannot speak to.
