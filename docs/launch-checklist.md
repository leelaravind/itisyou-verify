# Launch checklist — the only one

Supersedes `docs/launch-plan.md`. One owner, one status, one next action, one closing
evidence per item. Updated in place; no second copy anywhere.

**Now:** 08:10 UTC · **Allowance resets:** 13:45 UTC · **Remaining:** ~3h35m

Status: `done` · `active` · `blocked` · `queued`

---

## D1 — Payments: production-origin checkout to customer access

| #   | Item                                                                       | Owner        | Status                        | Next action                                                                                                 | Evidence to close                                                                                          |
| --- | -------------------------------------------------------------------------- | ------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1.1 | Production runs the commit with the unknown-workspace guard                | lead         | **done, production verified** | —                                                                                                           | `/health` returns `commit: cff4749…`; Cloudflare version `5fedf330` carries message `release-cff4749ccc11` |
| 1.2 | Fresh sandbox checkout **originating from production**, isolated workspace | lead + owner | **blocked on O6**             | Owner signs in on production with a `+verify-test` address they own; lead drives checkout from that session | Checkout Session id created by production                                                                  |
| 1.3 | Webhook → subscription active                                              | lead         | queued                        | Resend events to production endpoint                                                                        | one `subscriptions` row, `active`                                                                          |
| 1.4 | Allowance granted exactly once                                             | lead         | queued                        | Same pass as 1.3                                                                                            | one `entitlements` row, 500, consumed 0                                                                    |
| 1.5 | Replay changes nothing                                                     | lead         | queued                        | Re-send one event                                                                                           | `already_processed`; entitlement `updated_at` unmoved                                                      |
| 1.6 | Authenticated customer sees the subscription                               | lead         | queued                        | Sign in as that workspace                                                                                   | `/app/billing` renders active state                                                                        |

## D2 — Core product: real HubSpot + Resend workflow

| #   | Item                                                                    | Owner      | Status   | Next action | Evidence to close                                                                                                                       |
| --- | ----------------------------------------------------------------------- | ---------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Resend: correct evidence → VERIFIED                                     | A-WORKFLOW | **done** | —           | `run_01M2YRDJFB…`, provider_readback                                                                                                    |
| 2.2 | Wrong recipient → FAILED                                                | A-WORKFLOW | **done** | —           | `run_01M2YRJG8F…`, CONTRADICTED/VALUE_MISMATCH                                                                                          |
| 2.3 | Unavailable evidence → UNVERIFIED                                       | A-WORKFLOW | **done** | —           | `run_01M2YRBQ9E…`, EVIDENCE_NOT_RETURNED                                                                                                |
| 2.4 | HubSpot property `itisyou_verify_ref` exists                            | lead       | **done** | —           | portal 149371406, 211→212 properties                                                                                                    |
| 2.5 | Synthetic contact carrying a known ref                                  | lead       | **done** | —           | contact `871054966976`, `itisyou_verify_ref = ENQ-MATCH-0001`, verified across a reload                                                 |
| 2.6 | HubSpot match → SUPPORTED/MATCHED                                       | A-WORKFLOW | **done** | —           | `run_01M2YTSKKM…` VERIFIED; `evd_01M2YV0J4V…` hubspot/provider_readback; independently confirmed by the verifier                        |
| 2.7 | HubSpot correlation **contradiction** (retrieved record, wrong enquiry) | A-WORKFLOW | **done** | —           | `run_01M2YTSKRX…` FAILED, CONTRADICTED/VALUE_MISMATCH on `evd_01M2YV0MN4…` hubspot/provider_readback; verifier confirmed the row values |
| 2.8 | Usage increments and shows in dashboard                                 | A-WORKFLOW | queued   | After 2.6   | `consumed` before/after, same number on `/app/usage`                                                                                    |

## D3 — Customer and owner screens

| #   | Item                                                                             | Owner          | Status                               | Next action | Evidence to close                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------- | -------------- | ------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Essential Stitch screens (`/app`, onboarding, runs, usage, billing, connections) | A-UI           | **done, deployed `5da4766`**         | —           | 36 screenshots at 390/820/1440, viewport read back; each opened beside its reference                                                                                          |
| 3.2 | Public screens                                                                   | A-UI           | **done, production verified**        | —           | `/`, `/pricing`, `/how-it-works`, `/demo` composed and re-captured; `/security` has **no approved reference** and is honestly marked not composed                             |
| 3.3 | Owner journey stays authenticated, MFA on consequential actions                  | auditor + lead | **done, production verified 08:06Z** | —           | anonymous: `/owner` 404, `/owner/quality` 404, `/admin` 303, `/admin/login` 200, `/app` 401; `authorise()` demands MFA ≤15 min                                                |
| 3.4 | Owner dashboard shows launch figures                                             | A-UI           | **done, deployed `5da4766`**         | —           | eight tiles from live ports, `unknown` (no numeral) on a failed read, OWNER-901..907; cannot label sandbox vs live orders because no mode column exists, and the tile says so |

## D4 — Launch

| #   | Item                                     | Owner        | Status                        | Next action                                                                                                                                             | Evidence to close                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------- | ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 | Release gate sees Playwright failures    | lead         | **done, exercised**           | —                                                                                                                                                       | gate refused the `e0aa820` artefact naming the 3 failures; passed `cff4749` at 15/0/0                                                                                                                                                                              |
| 4.2 | Deploy the verified version              | lead         | **done, production verified** | —                                                                                                                                                       | `cff4749` deployed 07:42Z through the full gate; `/health` commit matches; all five pages free of the stale claims                                                                                                                                                 |
| 4.3 | Campaign budget within GBP 15 all-in     | lead         | **done**                      | —                                                                                                                                                       | GBP 12.46 total, survived reload                                                                                                                                                                                                                                   |
| 4.4 | Account tax/fee treatment                | lead         | **done, one caveat**          | —                                                                                                                                                       | Read from Billing settings: Individual, UK, no VAT number, Postpay, GBP 7.50 threshold (a trigger, not a cap), no account ceiling → 20% VAT on GBP 12.46 net = GBP 14.95. Caveat: the exact rate is only provable from the first invoice, which does not exist yet |
| 4.5 | Submit campaign                          | owner + lead | **blocked on O7**             | Every condition is met; the wizard's Review step renders no Publish button because an ad blocker in the browser profile stops its checks (page says so) | Google shows submitted; spend GBP 0.00                                                                                                                                                                                                                             |
| 4.6 | Live-payment approval pack for the owner | lead         | **done**                      | —                                                                                                                                                       | `docs/live-payment-approval.md`: proven / not proven / L1 to L8 requirements / the decision                                                                                                                                                                        |

## D5 — Handover

| #   | Item                             | Owner | Status                        | Next action             | Evidence to close                                                   |
| --- | -------------------------------- | ----- | ----------------------------- | ----------------------- | ------------------------------------------------------------------- |
| 5.1 | One evidence report              | lead  | queued                        | Replaces scattered docs | single file, every claim sourced                                    |
| 5.2 | Both development stories current | lead  | queued                        | End                     | events carry commit SHAs                                            |
| 5.3 | Correct public claims            | lead  | **done, production verified** | —                       | five live pages: 0 stale strings, corrected notice present (07:43Z) |
| 5.4 | Cleanup: worktree, temp files    | lead  | queued                        | End                     | `git worktree list` clean                                           |

---

## The four states, per fix (evidence, not assertion)

| Fix                                    | Code fixed           | CI passed | Deployed              | Production verified                                                                                                                     |
| -------------------------------------- | -------------------- | --------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook secret/path trim               | `c9267bc`            | `9649ecb` | `cff4749` 07:42Z      | staging: 3 real events accepted; production: real events now reach the handler and are refused by name for the workspace they belong to |
| Webhook rejection log                  | `c9267bc`            | yes       | yes                   | production tail showed `stripe_webhook_rejected` with reasons on 20 Sept                                                                |
| Unknown-workspace guard (200, not 500) | `47873e9`            | yes       | yes, `cff4749`        | not yet exercised on production since deploy                                                                                            |
| Version marker                         | `d4fc79f`            | yes       | yes                   | `/health` returns `commit: cff4749…`; Cloudflare version message matches                                                                |
| Browser-suite gate                     | `e9f6d0e`            | yes       | n/a (release tooling) | refused the shipped `e0aa820` artefact; passed `cff4749`                                                                                |
| False public claims corrected          | `a220707`, `3a7924c` | yes       | yes                   | 0 stale strings on 5 live pages at 07:43Z                                                                                               |
| Visit rule 7 (monotonic exclusion)     | `a77290d`            | yes       | yes                   | own 03:42 session flipped external to internal_test on production                                                                       |
| Design figure milestone                | `121214d`            | yes       | yes                   | Telegram delivery not re-verified this hour                                                                                             |

| Owner dashboard from live ports + owner screens composed | `5da4766` | yes | yes, `dbece4ef` 08:05Z | `/owner` 404 anonymous at 08:06Z; tiles not yet viewed with an owner session on production |
| Design-figure Telegram gate (`outcome !== 'sent'`) | `5da4766` | yes | yes | awaiting the first post-deploy cron tick; the 13-of-19 row was absent at 08:07Z |

## Live figures (read from the databases at 07:47 UTC)

|                                    | Production                                                                                                                             | Staging                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Workspaces / users / subscriptions | 0 / 0 / 0                                                                                                                              | 1 active subscription                                                                                                     |
| Stripe allowance                   | —                                                                                                                                      | one Stripe-created entitlement, 500 runs, 11 consumed (plus a hand-seeded 10-run slice from 19 Sept that is not Stripe's) |
| Runs                               | 0                                                                                                                                      | 3 VERIFIED, 3 FAILED, 8 UNVERIFIED                                                                                        |
| Evidence                           | 0                                                                                                                                      | HubSpot read-back 2, Resend read-back 3, Resend webhook 4                                                                 |
| Visit sessions                     | external **8 recorded** (none attributable to a stranger with evidence; 3 arrived while agents ran browser tooling), bot 9, internal 2 | —                                                                                                                         |
| Real revenue                       | GBP 0.00                                                                                                                               | GBP 0.00                                                                                                                  |

---

## Launch blockers (only these stop a launch)

1. **1.2 to 1.6, production-origin payment path**, waiting on **O6** (a sign-in only you can receive).
2. **4.5, campaign submission**: conditions met; blocked by an ad blocker in the browser profile (O7).
3. Nothing else blocks a launch from the code side. Not composed and honestly listed: `/security` (no reference), `/app/onboarding/connect`, `/admin/login`, `/support`, `/development-story/visual`.

Closed since the last report: 4.1 (gate), 5.3 (false claims, production verified), 2.5 to 2.7 (HubSpot both paths), 1.1 and 4.2 (deploy with version marker).

## Improvements that can wait

Webhook evidence reaching the evaluator (fails safe today); `transport` column; gap
`detail` persistence; 13 ledger rows on borrowed ids; stale gap-register rows; the Stitch
logo; owner-screen composition.

## Owner-only actions — all of them, together

| #   | Action                                                                                                                                                                                                          | Why only you                                                                                                                                                       | Needed by               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| O1  | ~~Google identity challenge~~                                                                                                                                                                                   | —                                                                                                                                                                  | **done**                |
| O2  | ~~EU political ads declaration~~                                                                                                                                                                                | —                                                                                                                                                                  | **done**                |
| O3  | Approve live customer payments                                                                                                                                                                                  | Your commercial decision                                                                                                                                           | pack at D1 close        |
| O4  | Approve the organic posts                                                                                                                                                                                       | They publish under a human identity                                                                                                                                | ready now               |
| O5  | ~~Confirm tax treatment~~                                                                                                                                                                                       | read from the account myself                                                                                                                                       | **done**                |
| O6  | Sign in on **production** once with an address you own carrying a `+verify-test` tag (the product keeps `+tags` distinct, so it is a separate isolated workspace), then paste me the sign-in link or click it   | The seed script refuses production by design and I will not bypass it; the magic link lands in a mailbox only you can read                                         | needed for D1.2 to D1.6 |
| O7  | Turn off the ad blocker for ads.google.com in your Chrome profile (or open the draft in a profile without one), reload the Review step and press **Publish campaign**; or tell me it is off and I will press it | Browser extensions on your machine are yours; the page itself says Google Ads cannot run with one active, and no Publish button exists in the page until it is off | needed for 4.5          |

Nothing else needs you. Live charges stay disabled until O3.
