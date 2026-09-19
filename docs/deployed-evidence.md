# Deployed evidence — what was exercised, against which commit

Every line here came from a request to a running deployment. Nothing is inferred from
tests, and nothing here is a claim about code that was only read.

**Commit:** `e9524a6` · **Environment:** staging
(`verify-itisyou-staging.kpleelaaravind.workers.dev`) · **Recorded:** 19 September 2026

Staging rather than production because production was still serving an older build at the
time of writing; its intake answered 500. That is stated rather than worked around.

---

## The complete workflow, end to end

The order matters: the email was sent **before** the event, which is the realistic order
and the one that used to lose evidence.

| Step | Evidence |
| --- | --- |
| Acknowledgement sent by the "customer's automation" | Resend message `01a0bbab-…013380`, to a provider simulator address |
| Delivery callbacks arrive before any run exists | Two rows parked in `evidence_inbox`, `reason: unmatched`, unclaimed |
| Signed event accepted | `POST /api/v1/events` → **202**, `run_01M2XTQ7H8FFAAC8673E6D43A9`, PENDING |
| Scheduler observes on its own cron | `observation_count: 1`, `completed_at 2026-09-19T22:00:55Z` |
| Verdict | **VERIFIED** |

### The assertions behind that verdict

| Rule | Status | Expected | Observed |
| --- | --- | --- | --- |
| `email_delivered` | SUPPORTED / MATCHED | one of: delivered | delivered |
| `email_recipient_matches` | SUPPORTED / MATCHED | delivered@resend.dev | delivered@resend.dev |

Evidence `origin: provider_readback` — an actual `GET /emails/{id}` against Resend, not a
webhook assertion and not a fixture. The stored summary masks the recipient (`d**@…`).

**This is the first VERIFIED verdict this product has produced from real provider evidence
on a deployed environment.** Everything before it was scripted connectors.

## Refusals, all against the deployment

| Case | Result |
| --- | --- |
| Unsigned event | 401 `SIGNATURE_INVALID` |
| Rotated-out signing key | 401 `SIGNATURE_INVALID` |
| Event naming another workflow | 403 `WORKFLOW_MISMATCH` |
| `occurred_at` an hour old | 422 `EVENT_STALE` |
| `occurred_at` an hour ahead | 422 `EVENT_IN_FUTURE` |
| Malformed envelope | 422 `EVENT_INVALID` |
| Same `event_id` twice | 200, same `run_id`, `duplicate: true`, **no second allowance unit** |
| Allowance exhausted | 429 `ALLOWANCE_EXHAUSTED` |

`reserved` moved to exactly 2 for two distinct runs and did not move for the duplicate.

## Two runs that were correctly NOT verified

`run_01M2XR57DX…` and `run_01M2XR5GQ9…` both finished **UNVERIFIED**. Neither named
`expected.email_message_id`, so no delivery evidence could be bound to either, and the
honest answer to "we cannot tell whose delivery that was" is UNVERIFIED rather than a
pass. The workspace page reports the resulting **33% verification rate** without
flattering it.

## Customer-facing surfaces, authenticated

| Path | Result |
| --- | --- |
| `/app` | 200 — verification rate, honestly 33% |
| `/app/runs` | 200 |
| `/app/runs/{id}` | 200 — full report, below |
| `/app/usage` | 200 — allowance for the period |
| `/app/connections` | 200 — connection health |
| `/app/support` | 200 |
| `/app/cancel` | 200 — "Cancelling takes one action and does not go through us" |

The run report states the verdict, each check as Confirmed with its source labelled
`provider readback`, expected against observed, the coverage mode, and a "What this cannot
see" section. The recipient is masked throughout.

## Owner access

| Probe | Result |
| --- | --- |
| `/admin/login`, signed out | **200 — publicly reachable, as required** |
| `/owner`, authenticated | 200 — Overview, Customers, Verification, Connections, Ads, Operations, Controls, Approvals, Tests, Cleanup, Settings |
| `/owner`, anonymous | **404** — deliberately not confirmable by probing |
| `/admin`, authenticated | 303 → `/owner` |

## Providers

| | |
| --- | --- |
| Resend | **ready**, promoted at `2026-09-19T20:51:16.811Z` by a genuinely signed callback |
| Resend webhook | Enabled, subscribed to exactly the six events the connector maps |
| HubSpot | Credential stored and validated against portal 149371406 — **no live readback demonstrated** |
| Stripe | Sandbox only; no live payment, live mode not enabled |

## What this document does not claim

- **Production has not been exercised.** It was serving an older build whose intake
  answered 500.
- **No sandbox checkout has been driven through the browser end to end.**
- **HubSpot record readback is unproven** against a real portal.
- **Zero external visits.** No campaign has run.
