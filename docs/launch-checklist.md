# Launch checklist — the only one

Supersedes `docs/launch-plan.md`. One owner, one status, one next action, one closing
evidence per item. Updated in place; no second copy anywhere.

**Now:** 08:25 UTC · **Allowance resets:** 13:45 UTC · **Remaining:** ~5h20m

Status: `done` · `active` · `blocked` · `queued`

---

## D1 — Payments: production-origin checkout to customer access

| #   | Item                                                                       | Owner | Status     | Next action                          | Evidence to close                                     |
| --- | -------------------------------------------------------------------------- | ----- | ---------- | ------------------------------------ | ----------------------------------------------------- |
| 1.1 | Production runs the commit with the unknown-workspace guard                | lead  | **active** | Deploy HEAD; CI green already        | `/health` returns `commit` = deployed SHA             |
| 1.2 | Fresh sandbox checkout **originating from production**, isolated workspace | lead  | queued     | After 1.1                            | Checkout Session id created by production             |
| 1.3 | Webhook → subscription active                                              | lead  | queued     | Resend events to production endpoint | one `subscriptions` row, `active`                     |
| 1.4 | Allowance granted exactly once                                             | lead  | queued     | Same pass as 1.3                     | one `entitlements` row, 500, consumed 0               |
| 1.5 | Replay changes nothing                                                     | lead  | queued     | Re-send one event                    | `already_processed`; entitlement `updated_at` unmoved |
| 1.6 | Authenticated customer sees the subscription                               | lead  | queued     | Sign in as that workspace            | `/app/billing` renders active state                   |

## D2 — Core product: real HubSpot + Resend workflow

| #   | Item                                                                    | Owner      | Status         | Next action                                         | Evidence to close                                     |
| --- | ----------------------------------------------------------------------- | ---------- | -------------- | --------------------------------------------------- | ----------------------------------------------------- |
| 2.1 | Resend: correct evidence → VERIFIED                                     | A-WORKFLOW | **done**       | —                                                   | `run_01M2YRDJFB…`, provider_readback                  |
| 2.2 | Wrong recipient → FAILED                                                | A-WORKFLOW | **done**       | —                                                   | `run_01M2YRJG8F…`, CONTRADICTED/VALUE_MISMATCH        |
| 2.3 | Unavailable evidence → UNVERIFIED                                       | A-WORKFLOW | **done**       | —                                                   | `run_01M2YRBQ9E…`, EVIDENCE_NOT_RETURNED              |
| 2.4 | HubSpot property `itisyou_verify_ref` exists                            | lead       | **done**       | —                                                   | portal 149371406, 211→212 properties                  |
| 2.5 | Synthetic contacts carrying known refs                                  | lead       | **active**     | Finish the create form (a required field blocks it) | two contacts visible in the portal                    |
| 2.6 | HubSpot match → SUPPORTED/MATCHED                                       | A-WORKFLOW | blocked on 2.5 | Agent has the task, waiting on values               | a `provider_hubspot` read-back evidence row           |
| 2.7 | HubSpot correlation **contradiction** (retrieved record, wrong enquiry) | A-WORKFLOW | blocked on 2.5 | Same                                                | CONTRADICTED/VALUE_MISMATCH, **not** RECORD_NOT_FOUND |
| 2.8 | Usage increments and shows in dashboard                                 | A-WORKFLOW | queued         | After 2.6                                           | `consumed` before/after, same number on `/app/usage`  |

## D3 — Customer and owner screens

| #   | Item                                                                             | Owner   | Status   | Next action | Evidence to close                                                                 |
| --- | -------------------------------------------------------------------------------- | ------- | -------- | ----------- | --------------------------------------------------------------------------------- |
| 3.1 | Essential Stitch screens (`/app`, onboarding, runs, usage, billing, connections) | A-UI    | **done** | —           | 36 screenshots at 390/820/1440, viewport read back                                |
| 3.2 | Public screens                                                                   | A-UI    | **done** | —           | 5 routes composed                                                                 |
| 3.3 | Owner journey stays authenticated, MFA on consequential actions                  | auditor | **done** | —           | `/owner` 404, `/admin` 303, `/admin/login` 200; `authorise()` demands MFA ≤15 min |
| 3.4 | Owner dashboard shows launch figures                                             | lead    | queued   | After D1    | figures render from live ports                                                    |

## D4 — Launch

| #   | Item                                               | Owner | Status                   | Next action                            | Evidence to close                               |
| --- | -------------------------------------------------- | ----- | ------------------------ | -------------------------------------- | ----------------------------------------------- |
| 4.1 | Release gate sees Playwright failures              | lead  | **blocked — critical**   | Fix `release.mjs`; find the 3 failures | a browser failure blocks a release              |
| 4.2 | Deploy the verified version                        | lead  | queued                   | After 4.1                              | gate green at one SHA, `/health` commit matches |
| 4.3 | Campaign budget within GBP 15 all-in               | lead  | **done**                 | —                                      | GBP 12.46 total, survived reload                |
| 4.4 | Account tax/fee treatment confirms GBP 14.95 gross | lead  | queued                   | Read the account's billing page        | a figure read from the account, not computed    |
| 4.5 | Submit campaign                                    | lead  | blocked on 2.6/2.7 + 4.4 | —                                      | Google shows submitted; spend GBP 0.00          |
| 4.6 | Live-payment approval pack for the owner           | lead  | queued                   | After D1                               | one page, decision-ready                        |

## D5 — Handover

| #   | Item                                      | Owner | Status     | Next action                 | Evidence to close                    |
| --- | ----------------------------------------- | ----- | ---------- | --------------------------- | ------------------------------------ |
| 5.1 | One evidence report                       | lead  | queued     | Replaces scattered docs     | single file, every claim sourced     |
| 5.2 | Both development stories current          | lead  | queued     | End                         | events carry commit SHAs             |
| 5.3 | Correct public claims re webhook evidence | lead  | **active** | 3 false statements live now | the strings are gone from production |
| 5.4 | Cleanup: worktree, temp files             | lead  | queued     | End                         | `git worktree list` clean            |

---

## Launch blockers (only these stop a launch)

1. **4.1 — the release gate does not see Playwright failures.** CI artefact carried
   `playwright.stats.unexpected: 3` alongside `accounting.failing: 0`, and production was
   deployed from it. Until fixed, no release can be called gated.
2. **5.3 — three false public statements, live now**, all understating.
3. **2.6 / 2.7** — the advertised workflow, which gates ad submission.
4. **1.1–1.6** — production-origin payment path.

## Improvements that can wait

Webhook evidence reaching the evaluator (fails safe today); `transport` column; gap
`detail` persistence; 13 ledger rows on borrowed ids; stale gap-register rows; the Stitch
logo; owner-screen composition.

## Owner-only actions — all of them, together

| #   | Action                                                                      | Why only you                        | Needed by        |
| --- | --------------------------------------------------------------------------- | ----------------------------------- | ---------------- |
| O1  | ~~Google identity challenge~~                                               | —                                   | **done**         |
| O2  | ~~EU political ads declaration~~                                            | —                                   | **done**         |
| O3  | Approve live customer payments                                              | Your commercial decision            | pack at D1 close |
| O4  | Approve the organic posts                                                   | They publish under a human identity | ready now        |
| O5  | Confirm the account's tax/fee treatment shows GBP 14.95 gross for GBP 12.46 | Billing page is yours               | before 4.5       |

Nothing else needs you. Live charges stay disabled until O3.
