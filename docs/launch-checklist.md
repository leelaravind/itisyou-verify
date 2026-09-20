# Launch checklist — the only one

Supersedes `docs/launch-plan.md`. One owner, one status, one next action, one closing
evidence per item. Updated in place; no second copy anywhere.

**Now:** 10:15 UTC · **Allowance resets:** 13:45 UTC · **Remaining:** ~3h30m

Status: `done` · `active` · `blocked` · `queued`

---

## D1 — Payments: production-origin checkout to customer access

| #   | Item                                                                       | Owner        | Status                                                | Next action                                                                                                                                                                                                                                            | Evidence to close                                                                                          |
| --- | -------------------------------------------------------------------------- | ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1.1 | Production runs the commit with the unknown-workspace guard                | lead         | **done, production verified**                         | —                                                                                                                                                                                                                                                      | `/health` returns `commit: cff4749…`; Cloudflare version `5fedf330` carries message `release-cff4749ccc11` |
| 1.2 | Fresh sandbox checkout **originating from production**, isolated workspace | lead + owner | **blocked on O8→O13→O14→O6**, after `569e8e3` deploys | Production has 0 users / 0 owners / 0 workspaces. Owner: set `OWNER_BOOTSTRAP_EMAIL` + token (O10/O11), claim owner (O8), enrol authenticator (O13), create test workspace (O14), sign in as it (O6). Then lead drives checkout in the owner's browser | Checkout Session id created by production                                                                  |
| 1.3 | Webhook → subscription active                                              | lead         | queued                                                | Resend events to production endpoint                                                                                                                                                                                                                   | one `subscriptions` row, `active`                                                                          |
| 1.4 | Allowance granted exactly once                                             | lead         | queued                                                | Same pass as 1.3                                                                                                                                                                                                                                       | one `entitlements` row, 500, consumed 0                                                                    |
| 1.5 | Replay changes nothing                                                     | lead         | queued                                                | Re-send one event                                                                                                                                                                                                                                      | `already_processed`; entitlement `updated_at` unmoved                                                      |
| 1.6 | Authenticated customer sees the subscription                               | lead         | queued                                                | Sign in as that workspace                                                                                                                                                                                                                              | `/app/billing` renders active state                                                                        |

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

| #   | Item                                                                             | Owner          | Status                                                                             | Next action | Evidence to close                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Essential Stitch screens (`/app`, onboarding, runs, usage, billing, connections) | A-UI           | **done, deployed `5da4766`**                                                       | —           | 36 screenshots at 390/820/1440, viewport read back; each opened beside its reference                                                                                                                                                                                                                |
| 3.2 | Public screens                                                                   | A-UI           | **done, production verified**                                                      | —           | `/`, `/pricing`, `/how-it-works`, `/demo` composed and re-captured; `/security` has **no approved reference** and is honestly marked not composed                                                                                                                                                   |
| 3.3 | Owner journey stays authenticated, MFA on consequential actions                  | auditor + lead | **done, production verified 08:06Z; two defects found 09:00Z, fixed in `569e8e3`** | deploy      | anonymous: `/owner` 404, `/admin` 303, `/admin/login` 200, `/app` 401. Found tracing the owner's sign-in: no authenticator-enrolment page existed, and `/admin/verify` never stamped the session, so no consequential owner action could ever pass on any deployment. AUTH-451..453, OWNER-912..916 |
| 3.4 | Owner dashboard shows launch figures                                             | A-UI           | **done, deployed `5da4766`**                                                       | —           | eight tiles from live ports, `unknown` (no numeral) on a failed read, OWNER-901..907; cannot label sandbox vs live orders because no mode column exists, and the tile says so                                                                                                                       |

## D4 — Launch

| #   | Item                                     | Owner        | Status                                                    | Next action                                                            | Evidence to close                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------- | ------------ | --------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Release gate sees Playwright failures    | lead         | **done, exercised**                                       | —                                                                      | gate refused the `e0aa820` artefact naming the 3 failures; passed `cff4749` at 15/0/0                                                                                                                                                                                                                          |
| 4.2 | Deploy the verified version              | lead         | **done, production verified**                             | —                                                                      | `cff4749` deployed 07:42Z through the full gate; `/health` commit matches; all five pages free of the stale claims                                                                                                                                                                                             |
| 4.3 | Campaign budget within GBP 15 all-in     | lead         | **done**                                                  | —                                                                      | Campaign total lowered GBP 12.46 → **GBP 12.25** at 08:40Z, verified across a reload: 12.25 + 2% DST fee = 12.50, + 20% VAT = **14.99**                                                                                                                                                                        |
| 4.4 | Account tax/fee treatment                | lead         | **done**                                                  | —                                                                      | Billing settings: Individual, UK, no VAT number, Postpay, GBP 7.50 threshold (a trigger, not a cap), no account ceiling. Google's own help (answer 9750227): UK DST fee **2% added on top of** media spend, VAT applies to the fee. Caveat unchanged: the invoice rate is only provable from the first invoice |
| 4.5 | Submit campaign                          | owner + lead | **submitted by owner (O7); found empty; being completed** | Lead adds the ad (RSA from packet §3.3, final URL with `utm_campaign`) | Published campaign had **no keywords and no ads**. 08:45–09:05Z: 5 exact-match keywords saved, 8 negatives saved. Google status: "Not eligible — low search volume, under review" (Google's, not ours). Spend GBP 0.00                                                                                         |
| 4.6 | Live-payment approval pack for the owner | lead         | **done**                                                  | —                                                                      | `docs/live-payment-approval.md`: proven / not proven / L1 to L8 requirements / the decision                                                                                                                                                                                                                    |

## D5 — Handover

| #   | Item                             | Owner | Status                        | Next action             | Evidence to close                                                                       |
| --- | -------------------------------- | ----- | ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| 5.1 | One evidence report              | lead  | queued                        | Replaces scattered docs | single file, every claim sourced                                                        |
| 5.2 | Both development stories current | lead  | queued                        | End                     | events carry commit SHAs                                                                |
| 5.3 | Correct public claims            | lead  | **done, production verified** | —                       | five live pages: 0 stale strings, corrected notice present (07:43Z)                     |
| 5.4 | Cleanup: worktree, temp files    | lead  | **done 10:15Z**               | —                       | `git worktree list` shows only the main tree; releases now run from the clean main tree |

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
| Sign-in delivery (wrong request shape behind `as never`) | `8dd1a5f` | yes | yes | production: one `sign_in_link` row `sent` at 08:33:23Z; Resend "Delivered" to the owner's address |
| M3 `workspace.create` owner action | `569e8e3` | `35502274339` | production 09:31Z (`6478fbd1`), staging 09:38Z | `/owner/customers` 404 to anonymous; not yet exercised by the owner (needs O8→O13) |
| M4a `/admin/authenticator` enrolment page | `569e8e3` | yes | yes | `/admin/authenticator` 404 to anonymous; AUTH-451 proves enrol→code→stamp→gate opens against D1; no owner has enrolled yet |
| M4b `/admin/verify` stamps THIS session, checks CSRF | `569e8e3` | yes | yes | AUTH-452 keeps the old defect as a tripwire; not yet exercised on production (no authenticator exists) |
| Unknown-workspace guard, exercised on production | `47873e9` | yes | `cff4749` | 09:22Z and 09:34Z: two foreign events resent from Stripe answered 200; `webhook_receipts` rows `ignored`, `workspace_id` null |
| Release Telegram milestone (one per deployed commit) | `7a4e026` | `35502933948` | production 09:43Z (`/health` commit `7a4e026`), staging 09:45Z | proven: `notification_deliveries` row `milestone_reached:release_deployed:production:7a4e0267d7f2`, state `sent`, 09:44:39Z — the owner received the deploy message on Telegram |
| Public notice reworded (owner can now create a workspace; none exists) | `3154a87` | `35503195409` | production + staging 09:55Z at `601da25` (`eba071c5`) | served pages: new sentence present on `/`, `/pricing`, `/app/sign-in`; old sentence 0 occurrences; DOC-130 caught the published-story drift at the local gate and `601da25` synced it |

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

1. **1.2 to 1.6, production-origin payment path.** Production has 0 users, 0 owners, 0 workspaces, 0 redeemed sign-in links (11 issued). Two application defects (no enrolment page; verify never stamped the session) plus the missing workspace-create action are fixed in `569e8e3` — CI, gate, deploy pending. Then the owner's steps in `docs/owner-actions.md` (O10, O11, O8, O13, O14, O6).
2. **4.5, the campaign was published empty**: keywords and negatives now saved; the responsive search ad is being entered. Google's status is "Not eligible — low search volume, under review" and may stay that way.
3. Nothing else blocks a launch from the code side.

Closed since the last report: 4.3/4.4 (budget lowered to GBP 12.25 on the account's actual DST+VAT treatment), O5, O7 (owner published). Reopened: 3.3 as two defects, fixed in `569e8e3`.

## Improvements that can wait

Webhook evidence reaching the evaluator (fails safe today); `transport` column; gap
`detail` persistence; 13 ledger rows on borrowed ids; stale gap-register rows; the Stitch
logo; owner-screen composition.

## Owner-only actions — all of them, together

The full version, with the exact command or page for each, is **`docs/owner-actions.md`**.

| #   | Action                                                                                              | State                                                                           |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| O1  | ~~Google identity challenge~~                                                                       | **done**                                                                        |
| O2  | ~~EU political ads declaration~~                                                                    | **done**                                                                        |
| O5  | ~~Confirm tax treatment~~                                                                           | **done** — budget lowered to GBP 12.25 on the account's own DST + VAT treatment |
| O7  | ~~Publish the campaign~~                                                                            | **done** by owner; it was empty, lead is filling it                             |
| O10 | Set `OWNER_BOOTSTRAP_EMAIL` on production (`wrangler secret put … --env production`)                | **do now** — not configured, bootstrap refuses everyone                         |
| O11 | Set an `OWNER_BOOTSTRAP_TOKEN` you hold                                                             | **do now**                                                                      |
| O12 | Install an authenticator app                                                                        | **do now**                                                                      |
| O4  | Approve the two organic posts                                                                       | ready — shortened versions in `docs/organic-launch.md` §4.3, §5.3               |
| O8  | Claim the owner account: `/admin/login` → link → `/admin/bootstrap` + token                         | after `569e8e3` deploys                                                         |
| O13 | Enrol the authenticator at `/admin/authenticator`, confirm a code                                   | after O8                                                                        |
| O14 | Create the isolated test workspace at `/owner/customers` (outlook address, "Test workspace" ticked) | after O13                                                                       |
| O6  | Sign in as that customer at `/app/sign-in`, tell the lead                                           | after O14 — unblocks D1.2–1.6                                                   |
| O3  | Approve live customer payments (`docs/live-payment-approval.md`)                                    | only after O6 is proven                                                         |
| O9  | Nothing: the budget is not to be increased, and it is not                                           | —                                                                               |

Live charges stay disabled until O3.
