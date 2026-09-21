# Launch checklist — the only one

Supersedes `docs/launch-plan.md`. One owner, one status, one next action, one closing
evidence per item. Updated in place; no second copy anywhere.

**Now:** 08:30 UTC, 21 Sept · **Allowance resets:** 13:45 UTC · **Remaining:** new allowance day

Status: `done` · `active` · `blocked` · `queued`

---

## D1 — Payments: production-origin checkout to customer access

| #   | Item                                                                       | Owner        | Status                                         | Next action | Evidence to close                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------- | ------------ | ---------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Production runs the commit with the unknown-workspace guard                | lead         | **done, production verified**                  | —           | `/health` returns `commit: cff4749…`; Cloudflare version `5fedf330` carries message `release-cff4749ccc11`                                                                                                                                                                                                                                                                             |
| 1.2 | Fresh sandbox checkout **originating from production**, isolated workspace | lead + owner | **done, production verified 07:54Z (21 Sept)** | —           | order `ord_01M31E6KYED181BAC8307E46E9` created by production 07:34:32Z with Checkout Session `cs_test_a1GoKH…` in the sandbox; owner paid with Stripe's test card; order `active` 07:54:12Z. Two of our own defects stood in the way and were fixed first: the connect page's false webhook sentence (`e35c2b8`) and CSP `form-action 'self'` swallowing the 303 to Stripe (`953e9c5`) |
| 1.3 | Webhook → subscription active                                              | lead         | **done, production verified**                  | —           | three signed events at 07:54:12Z (`evt_1UI23E1v0rNNhRrqSjNFzyrZ`, `…7za5mUeS`, `…quWT1T5PZ`) all `processed`, bound to the workspace; `subscriptions` row `active`, environment `test`, period end 2026-10-21T07:54:09Z                                                                                                                                                                |
| 1.4 | Allowance granted exactly once                                             | lead         | **done, production verified**                  | —           | exactly one `entitlements` row `ent_01M31FAN27EB0A90C116D0434C`: 500 / consumed 0 / reserved 0, `updated_at` 07:54:12.706Z                                                                                                                                                                                                                                                             |
| 1.5 | Replay changes nothing                                                     | lead         | **done, production verified**                  | —           | Stripe resend of `checkout.session.completed` at 07:56:56Z answered 200 `{"received": true, "duplicate": true}`; entitlement row byte-identical (same `updated_at`), receipts still 3 processed, subscriptions still 1                                                                                                                                                                 |
| 1.6 | Authenticated customer sees the subscription                               | lead         | **done, production verified**                  | —           | in the owner's customer session: `/app/billing/return` "Your subscription is active" with the checkout reference; `/app/billing` Status: active, £29.00 per month, portal link; `/app/usage` 0/500, period end 2026-10-21 07:54:09 UTC                                                                                                                                                 |

## D2 — Core product: real HubSpot + Resend workflow

| #   | Item                                                                    | Owner      | Status                   | Next action | Evidence to close                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------- | ---------- | ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Resend: correct evidence → VERIFIED                                     | A-WORKFLOW | **done**                 | —           | `run_01M2YRDJFB…`, provider_readback                                                                                                                                                                                                                                                                                                                                                                                          |
| 2.2 | Wrong recipient → FAILED                                                | A-WORKFLOW | **done**                 | —           | `run_01M2YRJG8F…`, CONTRADICTED/VALUE_MISMATCH                                                                                                                                                                                                                                                                                                                                                                                |
| 2.3 | Unavailable evidence → UNVERIFIED                                       | A-WORKFLOW | **done**                 | —           | `run_01M2YRBQ9E…`, EVIDENCE_NOT_RETURNED                                                                                                                                                                                                                                                                                                                                                                                      |
| 2.4 | HubSpot property `itisyou_verify_ref` exists                            | lead       | **done**                 | —           | portal 149371406, 211→212 properties                                                                                                                                                                                                                                                                                                                                                                                          |
| 2.5 | Synthetic contact carrying a known ref                                  | lead       | **done**                 | —           | contact `871054966976`, `itisyou_verify_ref = ENQ-MATCH-0001`, verified across a reload                                                                                                                                                                                                                                                                                                                                       |
| 2.6 | HubSpot match → SUPPORTED/MATCHED                                       | A-WORKFLOW | **done**                 | —           | `run_01M2YTSKKM…` VERIFIED; `evd_01M2YV0J4V…` hubspot/provider_readback; independently confirmed by the verifier                                                                                                                                                                                                                                                                                                              |
| 2.7 | HubSpot correlation **contradiction** (retrieved record, wrong enquiry) | A-WORKFLOW | **done**                 | —           | `run_01M2YTSKRX…` FAILED, CONTRADICTED/VALUE_MISMATCH on `evd_01M2YV0MN4…` hubspot/provider_readback; verifier confirmed the row values                                                                                                                                                                                                                                                                                       |
| 2.8 | Usage increments and shows in dashboard                                 | lead       | **done 10:01Z, staging** | —           | one signed event through `POST /api/v1/events` → 202, `run_01M2Z46X56…` PENDING; `/app/usage` in the same customer session reads **12 / 500, 488 remaining, runs received 15** (was 11 / 14); `entitlements`: `consumed 11, reserved 1` at admission (the page counts both); run settled UNVERIFIED at 10:05:39Z and the row read afterwards is `consumed 12, reserved 0` — one event, one increment, same figure on the page |

## D3 — Customer and owner screens

| #   | Item                                                                             | Owner          | Status                               | Next action | Evidence to close                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------- | -------------- | ------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Essential Stitch screens (`/app`, onboarding, runs, usage, billing, connections) | A-UI           | **done, deployed `5da4766`**         | —           | 36 screenshots at 390/820/1440, viewport read back; each opened beside its reference                                                                                                                                                                                                                                                                                       |
| 3.2 | Public screens                                                                   | A-UI           | **recomposed and deployed `d11c271654bd`** | —           | `/` and `/pricing` recomposed against the owner exclusions and captured from production at 1440 and 390: `reports/screenshots/production-d11c271654bd/`. Nine excluded devices removed at the token and stylesheet layer, so the fix reaches all nineteen screens; RESIL-911..915 assert each device is absent from the whole stylesheet; RESIL-916 and RESIL-917 are different in kind, rendering five public pages and checking what a reader sees (dashes, and leaked comment syntax). Five sheet-wide, two page-wide, corrected after a meta-audit found all three summaries of this saying seven. Zero reader-visible em or en dashes on all nine public pages, measured against the served HTML. `/security` still has **no owner-approved reference** and stays marked not composed |
| 3.3 | Owner journey stays authenticated, MFA on consequential actions                  | auditor + lead | **done, production verified 12:00Z** | —           | production: `owner.bootstrap granted` 10:59:25Z; `auth.totp.enrolled` 11:09:28Z; `auth.totp.accepted` 11:37:55Z with `mfa_verified_at` stamped; first consequential action (workspace.create) succeeded 11:39:29Z inside the window; second bootstrap paste refused `already_bootstrapped` 11:59:01Z; anonymous `/owner`, `/owner/customers`, `/admin/authenticator` → 404 |
| 3.4 | Owner dashboard shows launch figures                                             | A-UI           | **done, deployed `5da4766`**         | —           | eight tiles from live ports, `unknown` (no numeral) on a failed read, OWNER-901..907; cannot label sandbox vs live orders because no mode column exists, and the tile says so                                                                                                                                                                                              |

## D4 — Launch

| #   | Item                                     | Owner        | Status                                                                                   | Next action                                                       | Evidence to close                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Release gate sees Playwright failures    | lead         | **done, exercised**                                                                      | —                                                                 | gate refused the `e0aa820` artefact naming the 3 failures; passed `cff4749` at 15/0/0                                                                                                                                                                                                                          |
| 4.2 | Deploy the verified version              | lead         | **done, production verified `d11c271654bd`**                                             | —                                                                 | Staging first at 11:51Z, then production at 11:54Z, from the **same** gate artefact (`reports/release-gate/d11c271654bd/`), so both run one candidate. Gate: 2,692 citable passing cases, browser 15 passed / 0 failed / 0 flaky. `/health` on both environments returns `d11c271654bd`. Rendered claim scan clean over 7 served pages on each. Deploy alert delivered: `milestone_reached:release_deployed:production:d11c27`, telegram, `sent`, 11:54:25Z |
| 4.3 | Campaign budget within GBP 15 all-in     | lead         | **done**                                                                                 | —                                                                 | Campaign total lowered GBP 12.46 → **GBP 12.25** at 08:40Z, verified across a reload: 12.25 + 2% DST fee = 12.50, + 20% VAT = **14.99**                                                                                                                                                                        |
| 4.4 | Account tax/fee treatment                | lead         | **done**                                                                                 | —                                                                 | Billing settings: Individual, UK, no VAT number, Postpay, GBP 7.50 threshold (a trigger, not a cap), no account ceiling. Google's own help (answer 9750227): UK DST fee **2% added on top of** media spend, VAT applies to the fee. Caveat unchanged: the invoice rate is only provable from the first invoice |
| 4.5 | Submit campaign                          | owner + lead | **submitted 20 Sept; ad saved; campaign PAUSED 21 Sept 08:50 UK by the owner's account** | Owner decides whether to re-enable; lead touches nothing          | Change history: "21 Sept 2026 08:50:18 — kpleelaaravind@gmail.com — 1 campaign paused". Ad row: "Not eligible — Campaign is paused". Budget £12.25 total, 0 impressions, spend GBP 0.00. States: drafted ✓, submitted ✓, approved ✗ (review not completed before the pause), delivering ✗                      |
| 4.6 | Live-payment approval pack for the owner | lead         | **decision updated 12:00Z: NOT READY, 3 of 13 FAIL**                                     | Owner only, in order: L2, L3, then L4                            | `docs/live-payment-approval.md`: L5, L6 and L7 moved to PASS and are deployed and read back from production. The three that remain are the owner's to authorise: L2 a live £29.00 price in the parent account, L3 live secrets and a webhook destination, L4 the `STRIPE_MODE` flip, which is last |

## D5 — Handover

| #   | Item                             | Owner | Status                        | Next action             | Evidence to close                                                                       |
| --- | -------------------------------- | ----- | ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| 5.1 | One evidence report              | lead  | queued                        | Replaces scattered docs | single file, every claim sourced                                                        |
| 5.2 | Both development stories current | lead  | **done, deployed**            | —                       | EVT-0049..EVT-0053 appended with commit SHAs and test-evidence refs, `verify-story` well-formed; the served `/development-story` page corrected in the three places today's work made false and swept of its 40 dashes; `apps/app/public/development-story.md` byte-identical to `docs/development-story.md` (DOC-130) |
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
| CSRF cookie set on every principal-resolving response (enrol → confirm form) | `b553e71` | `35507634839` (with `f2b7d18`) | production + staging 11:45Z (`2a0ae6f4`) | found from the owner's first code on production (11:10Z) being refused as a CSRF mismatch; OWNER-917/918; owner's confirmation on the fixed build still pending |
| BILL-614 fixture expiry (time bomb at 10:00Z today) | `f2b7d18` | yes | yes | CI `35507354304` failed on it at 11:20Z on a commit that had not touched refunds; the local gate refused the same; fixture now relative to the real clock |
| Connect page: Resend webhook address rendered from `webhook_path_id` | `e35c2b8` (+ ledger `7a72c81`) | `35537183448` | staging 12:33Z; production 12:42Z (`495efcdd`) | production, the owner's customer tab: corrected callout rendered; staging, automation workspace's real Resend row: `data-webhook-url` rendered once with the deployment's prefix and a 43-character id; the sentence "does not exist in this deployment yet" absent. CUST-482 |
| CSP `form-action` allows the redirect to Stripe Checkout / billing portal | `953e9c5` | yes | production 07:5xZ (21 Sept), then owner's checkout completed 07:54Z | found 07:40Z on the first production checkout: server answered 303 to Stripe (order `checkout_created`, session `cs_test_a1GoKH…`), Chrome enforced `form-action 'self'` on the post-redirect and stayed on the review page; the code comment asserted the opposite. CUST-483 pins the served header |
| Form message heading follows the result (success no longer under "There is a problem") | `a89f60e` | yes | production 08:2xZ (`e3c1a1b8`), staging | CUST-484; found when the owner read a successful Resend save as a rejection, twice |

## Live figures (re-read from the production database at 14:05 UTC, 21 September 2026)

The row below said **0 / 0 / 0** until now, on a document that was itself updated at 12:00Z
the same day. It was a 07:47Z reading left in place across two later edits, and it
contradicted this file's own D1.2-1.6, which prove a workspace, a subscription and an
order. Found by an independent meta-audit. The figures are now read fresh and carry the
time they were read.

|                                    | Production                                                                                                                             | Staging                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Workspaces / users / subscriptions | **1 / 2 / 1** (the owner's own isolated test workspace) | 1 active subscription                                                                                                     |
| Stripe allowance                   | —                                                                                                                                      | one Stripe-created entitlement, 500 runs, 11 consumed (plus a hand-seeded 10-run slice from 19 Sept that is not Stripe's) |
| Runs                               | 0                                                                                                                                      | 3 VERIFIED, 3 FAILED, 8 UNVERIFIED                                                                                        |
| Evidence                           | 0                                                                                                                                      | HubSpot read-back 2, Resend read-back 3, Resend webhook 4                                                                 |
| Visit sessions                     | external **8 recorded** (none attributable to a stranger with evidence; 3 arrived while agents ran browser tooling), bot 9, internal 2 | —                                                                                                                         |
| Real revenue                       | GBP 0.00                                                                                                                               | GBP 0.00                                                                                                                  |

---

## D6 — The owner's 21 September requirements

Candidate `a904db086221`: **deployed to staging and verified there**; production promotion
is blocked on one permission approval (see blockers). Screens captured at 1440, 834 and 390
in `reports/screenshots/staging-a904db086221/` (42 screens, no horizontal overflow at any
viewport, no screen blocked).

| #   | Requirement                        | Status                          | Evidence                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | Test connection                    | **done, live; verified on staging** | `POST /app/connections/test`, a form not a link, CSRF, rate limited 6 per 5 min, admin only. Wires `revalidateConnection`, which existed and was called from **nowhere**. CONN-518..523, AUTH-518. Verified on the deployed service: all three findings render, the credential survives an outage                                         |
| 6.2 | API vs webhook vs workflow, split  | **done, live; verified on staging** | Three findings drawn separately; `workflowVerification` is a field on the result type, always `not_checked`, so the page cannot stop saying it. CONN-520                                                                                                                                                                                 |
| 6.3 | "We only ever read" corrected      | **done, live; verified on staging** | The old copy claimed neither credential can send mail. Resend publishes no read-only key, so that was false. Now states what our CODE does and names the Resend full-access reality. CUST-903                                                                                                                                             |
| 6.4 | Guided test verification           | **done, live; verified on staging** | Four fields mapping 1:1 onto the real source-event schema, admitted through `sourceEvents.admitOnce`, decided by the real evaluator. Starts PENDING; no verdict invented. VERIFY-560..565, AUTH-519                                                                                                                                       |
| 6.5 | Allowance explained before start   | **done, live; verified on staging** | "This uses one of your 500 runs, and N remain", above the fields. It costs one because it takes the real admission path; a free side door would be a different code path. VERIFY-560                                                                                                                                                      |
| 6.6 | Test runs labelled and excluded    | **done**                        | `is_synthetic` existed since the first migration and was read **nowhere**. Now excluded from the owner's platform total AND the workspace's own verification rate. VERIFY-563 asserts the filtered count is genuinely lower, so it cannot rot back into a flag nobody reads                                                                 |
| 6.7 | Billing portal defect              | **done, live; verified on staging** | Cause: the session was minted during the GET render and baked into an anchor, so it was spent before the click. Now one fresh session per click via POST. BILL-670..674, AUTH-517. Verified: the served page contains no `billing.stripe.com`                                                                                              |
| 6.8 | Purposeful accessible animation    | **done, live and read back on production** | One motion language: 2 duration tokens, 1 easing curve, 1 rise. Entrance settle, hover feedback, `grid-template-rows` disclosure, `@view-transition` crossfade. **No new JavaScript.** `prefers-reduced-motion` neutralises all of it, with an explicit carve-out for view-transition pseudo-elements. RESIL-911..917                    |
| 6.9 | The verdict never animates         | **done**                        | `badge--lg` removed from the entrance list, and the development-story page stays wholly static because it tells readers "nothing is animated". CUST-427, DOC-111                                                                                                                                                                          |
| 6.10| Independent auditor                | **done**                        | Ran against the pinned candidate on staging, on a cheap model, read-only. All seven checked items PASS; it found no weak assertion among the 20 new cases and judged the candidate fit to promote                                                                                                                                         |
| 6.11| Staging deploy + verification      | **done**                        | `a904db086221` at 13:37Z, then `6fae121148ff` at 13:59Z before production; `docs/evidence/staging-verification-a904db086221.txt`, every check passed including all three viewer restrictions refusing at the ROUTE, not only in the UI                                                                                                                                                     |
| 6.12| Production deploy                  | **done**                        | `6fae121148ff` deployed 14:00Z, then `4cf097ad5620` at 15:31Z carrying the visual pass, staging first from the same gate artefact. The migration step that was refused at 13:0xZ ran and passed on this attempt; nothing was skipped and no flag was added. Served commit read back at 14:01Z. `docs/evidence/production-6fae121148ff.txt` |
| 6.13| Full customer and owner UI         | **done**                        | Customer screens recomposed and captured at three viewports. The OWNER panel is now recomposed to the same rules: error styling reserved for problems (14 callouts retoned, so a state of knowledge no longer wears the colour of a failure), long notices cut to one sentence with the rest in a disclosure, and the launch strip states a shared freshness once instead of eight times. 13 owner screens captured at 1440, 834 and 390, none overflowing. OWNER-919..923, mutation-checked. Its arrangement was already composed to the approved owner screen and was not rebuilt |
| 6.14| Stitch: missing designs            | **not done, deliberately**      | The 20 approved references are all on disk and mapped. A generation run for the missing screens stalled after ~140k tokens and was stopped on the owner's cost instruction. `/security` still has no owner-approved reference                                                                                                              |

## D7. The visual pass against the Stitch references (21 September 2026, afternoon)

Added after the owner ruled that "15 of 19 composed" is not evidence that a screen matches its
reference. One row per thing claimed. `docs/screen-checklist.md` carries the per-screen detail.

| #   | Requirement | State | Evidence |
| --- | --- | --- | --- |
| 7.1 | References rendered properly, at our widths | **done** | The exported `screen.png` is a 351-pixel thumbnail; each reference `code.html` is now rendered in a real browser at 1440, 834 and 390 into `reports/compare/ref/` |
| 7.2 | Home compared and implemented | **done, live** | The comparison device (`EvidenceDiff`) and the mono shape blocks; three arrangements tried and measured. CUST-701, CUST-703 |
| 7.3 | Pricing compared | **done, nothing to change** | Four reference devices judged; each refusal has a stated reason in the screen checklist. One stale comment corrected |
| 7.4 | Workspace compared and implemented | **done, live** | The four-field form moved behind a disclosure so the page answers its own question first; the allowance cost and the limitation stay in the flow, held by VERIFY-560 |
| 7.5 | Owner dashboard compared and implemented | **done, live** | A rail at desktop width, the header nav below it, never both. OWNER-924, mutation-checked |
| 7.6 | Reduced-motion defect found and fixed | **done, live** | The fourth status card rendered at opacity 0 for a reader who asked for less motion. RESIL-918 |
| 7.7 | Billing portal defect found and fixed | **done, live** | A constant Stripe idempotency key replayed the first, spent session. BILL-675, BILL-676, and two openings on deployed staging now produce two different sessions |
| 7.8 | Independent auditor on the visual work | **done** | Cheap model, read-only, ten claims: 8 PASS, 1 PARTIAL, 1 FAIL. Its one finding was acted on in part and refused in part, in writing |
| 7.9 | Remaining screens compared | **NOT done** | Eleven screens are still marked pending in `docs/screen-checklist.md`: how-it-works, demo, support, the development story, five customer screens and five owner screens. Rendered and captured, not compared |
| 7.10 | Owner panel seen signed in | **NOT done, owner only** | Every owner render in this work came from the in-memory port. Nobody has opened the panel against production data, and nobody may seed a production session to stand in for that |

## Launch blockers (only these stop a launch)

Read at 15:31 UTC on 21 September 2026, against production at `4cf097ad5620`.

0. **CLEARED at 14:00Z, and left here rather than deleted.** For most of the afternoon this
   read "BLOCKED ON THE OWNER, and it is one command": the production release aborted because
   the permission classifier refused

   ```
   npx wrangler d1 migrations apply verify-itisyou-db-production --env production --remote
   ```

   which `scripts/release.mjs` runs unconditionally and has no flag to skip. No flag was
   added and no path around it was taken. On the attempt at 14:00Z the same command was
   accepted, the gate ran whole, and `6fae121148ff` went to staging and then to production
   from one artefact. Production served `6fae121148ff` when `/health` was read at 14:01Z, so
   the billing-portal fix, the connection test, the guided test verification and the motion
   language are live. Evidence: `docs/evidence/production-6fae121148ff.txt`.

   What is still owner-only is in the numbered blockers below and in `docs/owner-actions.md`:
   the owner panel walkthrough (nobody may seed a production session to stand in for it),
   `support@itisyou.app` routing, live payments, and the organic posts.

1. **Nothing on the sandbox payment path blocks a launch.** D1.1-1.6 are production verified
   (21 Sept 07:54-07:57Z). Live payments remain a separate, owner-gated decision.

2. **An authorisation hole on the money path was found and closed today, and it is the most
   important thing on this page.** `createCheckout` enforced no role and `orderSummary()`
   never consulted one, so on a workspace with both providers ready and a workflow published,
   a `workspace_viewer` was shown a live "Continue to secure checkout" button and pressing it
   produced a **303 to Stripe Checkout** for a workspace they may only read. Found by an
   independent review on a second model, not by the suite. Closed as a blocker inside
   `orderSummary` so the page and the route read one answer. Evidence, in the order it is
   worth trusting:
   - **deployed staging, both roles, same workspace**: an admin sees a checkout form, a viewer
     does not; a viewer's hand-built POST carrying a real session and a real double-submit CSRF
     pair answers **503 with the role refusal**, no `Location`, and creates no order
     (`reports/evidence/staging-verification-d11c271654bd.txt`).
   - **mutation check**: with the guard removed, AUTH-514 fails and AUTH-515 fails with
     *expected 303 to be 503*, which is the vulnerability reproduced; AUTH-516, the admin
     control on the identical fixture, passes throughout
     (`reports/evidence/mutation-check-auth-478-480.txt`).
   - the first regression written for this was **rejected by the owner** because it posted no
     CSRF token and so proved the CSRF guard rather than role enforcement. That is recorded
     because the lesson is the point: a refusal is not evidence of the refusal you wanted.

3. **The release gate caught a red browser suite that the vitest count could not see.** Two
   Playwright cases had gone stale against today's copy changes while `failing: 0` was
   reported, because that figure never reads the Playwright report. Production refuses on it
   and staging warns; both fixed before the deploy. Run the whole browser suite locally, not
   one spec.

4. **4.5, advertising**: PAUSED at 08:50 UK on 21 Sept by the owner's own account (change
   history), not delivering, £12.25 total budget, 0 impressions, £0.00 spent. **The lead does
   not enable ads.**

5. **Still open, and none of it is launch-blocking for a sandbox launch:**
   - L2, L3, L4 for live payments, all owner-only, in that order.
   - four of nineteen screens not composed; `/security` has no owner-approved reference to
     compose against, so it cannot simply be built.
   - `support@itisyou.app`: DNS proves Cloudflare Email Routing (MX route1/2/3, SPF, DMARC
     `p=none`). Whether a **routing rule** exists for `support@` could not be determined from
     here: the wrangler OAuth token carries `zone (read)` and not email-routing scope, and an
     SMTP `RCPT TO` probe connected to the MX but would not complete a conversation from this
     machine. Owner action, one look: Cloudflare, Email, Email Routing, Routes. Replying **as**
     `support@` needs an outbound identity and is a second, separate decision.
   - ten genuine external visits: honest count still **zero**.
   - the demonstration page's runs are still fixtures.

## A measurement caveat worth carrying

`scripts/scan-secrets.mjs` prints "clean. 791 tracked files". 791 is the number of tracked
PATHS; the script skips binary extensions before reading, so it actually reads **595** files
and skips 196 (194 `.png`, 2 `.zip`). Three commit messages repeated the 791 figure as though
it were coverage. The scan is still clean over everything it can read; the sentence was a 25%
overstatement of what was looked at. Found by an independent meta-audit.

## Improvements that can wait

Webhook evidence reaching the evaluator (fails safe today); `transport` column; gap
`detail` persistence; 13 ledger rows on borrowed ids; stale gap-register rows; the Stitch
logo; owner-screen composition.

## Owner-only actions, all of them, together

Read 21 September 2026 at 12:00 UTC. Everything the lead can do without you is done and
deployed at `d11c271654bd`. These four are yours, and nothing else is waiting on you.

| #   | Action                                                                                                                                                                                                                                     | Why only you                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| O4  | **Approve or edit the two organic posts.** Shortened, no client stories, read-back-only wording; `docs/organic-launch.md` §4.3 and §5.3. The lead posts nothing.                                                                            | They publish under your name.                                       |
| O15 | **Confirm the `support@itisyou.app` routing rule.** Cloudflare, Email, Email Routing, Routes: is there a rule for `support@`, and where does it forward? One look. Then the lead sends one test message and records receipt. Reply-as is a separate decision after that. | The Cloudflare dashboard needs your sign-in; the token here has `zone (read)` only. |
| O3  | **Live customer payments**, in order: L2 a live £29.00 monthly price in the parent account `acct_1UHU2QP8C4JrYWQF`, L3 a restricted live key, a new opaque webhook path id and a live destination with the six event types, then L4 the `STRIPE_MODE` flip. Exact steps: `docs/live-payment-approval.md` §4. L5, L6 and L7 are now PASS and deployed, so those three are all that remain. | Spending real money and taking it from strangers is your decision.  |
| O14b| **Re-check the owner dashboard in your own session.** Your session was rotated out by the customer sign-in on 20 Sept. Sign in at `/admin/login`, confirm a code, open `/owner` and use one control. The lead verified the panel renders and that anonymous access is refused, but did that on **staging** with a seeded synthetic identity: the seed script refuses production by design, so production's panel has not been opened since the rotation. | Only your identity can hold a platform-owner session on production. |

**Ads stay paused and live payments stay disabled** until you say otherwise, on both counts.

