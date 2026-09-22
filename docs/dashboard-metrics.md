# Dashboard metrics: what exists, and a small set worth adding

Written 22 September 2026 against production `b6df26b`, from the pages as a signed-in
customer actually sees them plus the production schema. Every proposal below names its
source, its window and how it treats test data, because a metric without those three is a
number somebody will eventually read as something it is not.

## What already exists

The honest parts are already here and should not be disturbed.

| Where | Metric | State |
| --- | --- | --- |
| `/app` | VERIFIED / FAILED / UNVERIFIED / PENDING counts | present |
| `/app` | Verification rate | present, and **correctly refuses to score an empty workflow** |
| `/app` | "Are enquiries still arriving?" activity warning | present |
| `/app` | Runs used, period end, correlation property, completion window | present |
| `/app/usage` | Runs used `n/500`, remaining, subscription state, runs by result | present |
| `/app/connections` | Per-provider status and `LAST CHECKED` timestamp | present |
| `/app/runs` | Per-run result, enquiry reference, received, decided, `0/2` required checks | present |

Three things it already gets right, listed so a later change does not quietly undo them:

- **No accuracy percentage without something to score.** An empty workflow reads "There is
  nothing to score. An empty workflow is not a passing workflow", not `0%` or `100%`.
- **Test runs are excluded from the verification rate**, and the usage page says so in words.
- **Absence is never a pass.** The empty states say "an empty workspace is not a verified one".

## What is missing

| Gap | Why it matters | Data exists? |
| --- | --- | --- |
| **Reserved is never shown** | `entitlements` carries `consumed` *and* `reserved`. The page shows only a combined "used". A customer cannot see how much of their allowance is committed to runs still in flight | yes, `entitlements.reserved` |
| **No oldest pending age** | "3 pending" is fine at three minutes and an incident at three hours. The page cannot tell them apart | yes, `runs.created_at` |
| **No processing time** | Both timestamps are on screen per run; nothing summarises received → decided | yes, `runs.created_at`, `completed_at` |
| **No real-versus-test filter, and no test badge in the list** | A test run is labelled on *its own page* ("You started this one") and excluded from the rate, but in `/app/runs` it is indistinguishable from a real one. Two test runs currently read as two customer failures | yes, `runs.is_synthetic` / `source_events` source type |
| **Connection freshness is a timestamp, not a state** | `LAST CHECKED 12:47:08 UTC` requires the reader to do date arithmetic to know whether it is stale | yes, `connections.last_check_at` |

## Proposed customer set

Six. Each one answers a question a customer actually asks.

| Metric | Source | Window | Test data |
| --- | --- | --- | --- |
| **Connection freshness** | `connections.last_check_at`, `status` | Now, as an age | n/a — connections are not runs |
| **Pending runs, and oldest pending age** | `runs` where status `PENDING` | Live, no window | Excluded by default; toggle to include |
| **Settled verdict counts** | `runs.status` | Current billing period | Excluded by default; toggle to include |
| **Processing time (median, 95th)** | `completed_at − created_at` over settled runs | Current billing period | Excluded — a test run's timing is not the customer's service level |
| **Allowance: consumed / reserved / remaining** | `entitlements` | Current billing period | **Included, and shown as such.** A test run really does cost a run; hiding it would make the allowance figure wrong |
| **Real versus test filter** | `runs.is_synthetic` | Applies to every panel above | This is the control, not a metric |

Note the deliberate asymmetry in the last two rows: test runs are **excluded from quality**
figures and **included in billing** figures, because that is the truth in both cases. The
allowance panel should say so in one line rather than leaving the reader to discover it.

## Proposed owner set

| Metric | Source | Window | Test data |
| --- | --- | --- | --- |
| **Queue backlog** | `runs` where `next_check_at <= now` and not terminal | Live | Separated, not merged |
| **Scheduler last successful tick** | `run_attempts.ended_at` where outcome is a success | Live, as an age | n/a |
| **Provider error / throttling rate** | `run_attempts.error_code`, split `PROVIDER_UNAVAILABLE` vs `RATE_LIMITED` | Rolling 24h | Included — a throttle caused by test traffic is still a throttle |
| **Webhook rejection and retry rate** | `webhook_receipts.processing_status` | Rolling 24h | Included |
| **Notification delivery failures** | `notification_deliveries.state`, `attempt_count` | Rolling 24h | Included |
| **Infrastructure usage and spend** | Cloudflare account figures, not the database | Current month | n/a |

The provider error rate earns its place twice over: a sustained `PROVIDER_UNAVAILABLE` rate
is exactly the condition that, until today, silently demoted healthy connections to
`not_connected` and took them out of service.

## Three display rules

**1. Zero, unknown and stale must look different.**

- *Zero* — we looked and there were none. `0`, plainly.
- *Unknown* — we have no reading. Never `0`. An em dash with "no reading", matching the
  wording the run comparator already uses for an unread check.
- *Stale* — we have a reading and it is old. The value, with its age and a visible marker.
  The threshold belongs to the metric: a scheduler tick is stale at minutes, a connection
  check at days.

The product already applies exactly this distinction inside a run ("no reading" against a
retrieved value). The dashboards should not invent a second vocabulary for the same idea.

**2. No accuracy percentage without independently labelled ground truth.**

The verification rate is a rate of *our verdicts*, not a measure of whether those verdicts
were right. Nothing in the system currently holds an independent label saying what a run's
answer should have been, so there is no honest denominator for an accuracy figure and none
should be displayed. The existing "verification rate" wording is correct because it says
what it counts.

**3. Every panel states its window and its test-data treatment in the panel.**

Not in a tooltip and not in a help page. One line of small text, the way the usage page
already explains why test runs are left out of the results below it.

## What this document does not claim

These are proposals, not built work. Nothing here has been implemented. The assessment of
what exists was read from the deployed pages on 22 September; the "data exists" column was
checked against the production schema, not against a query that has been written and run.
