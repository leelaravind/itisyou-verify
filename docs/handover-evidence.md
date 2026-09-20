# Handover — one evidence report

Written 20 September 2026, 09:55 UTC. One page, every claim with its source. Where a claim
rests on a database read, the table and the time are named; where it rests on a test, the
case id; where it rests on a third party, what that party showed. Anything not listed here
as proven is not proven.

Deployed commits at 11:50 UTC: production and staging `f2b7d18` (Cloudflare version
`2a0ae6f4`, `/health` commit matches). Owner path on production: platform owner claimed 10:59:25Z,
authenticator enrolled 11:09:28Z, code confirmation pending after a CSRF defect in the enrolment
response (fixed `b553e71`).

## 1. Payments (sandbox only; live payments are off)

| Claim                                                                          | Evidence                                                                                                                                                                                             | Where         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Signed Stripe webhooks are accepted                                            | three real events resent by Stripe and accepted after the trim fix (`c9267bc`); `STRIPE_WEBHOOK_SECRET` had been present in both environments the whole time (`wrangler secret list`)                | staging       |
| A subscription activates exactly once                                          | one `subscriptions` row `active`; one Stripe-created `entitlements` row of 500 runs; a replayed event answered `already_processed` and moved nothing                                                 | staging DB    |
| A checkout completes and returns to a working page                             | £29.00 paid with a Stripe test card on 20 Sept; `/app/billing/return` describes provider acceptance and does not claim activation                                                                    | staging       |
| An event for a workspace this deployment does not hold is refused by name      | BILL-640..653 (a foreign-environment event and a legitimate early event are separate cases); production: two foreign events resent 09:22Z and 09:34Z answered 200, `webhook_receipts` rows `ignored` | production DB |
| Production-origin checkout → activation → allowance → replay → customer access | **not done.** Production has 0 workspaces; the owner's steps in `docs/owner-actions.md` come first                                                                                                   | —             |
| Live-mode payment                                                              | **never taken, by design.** `STRIPE_MODE: "test"` everywhere. Approval pack: `docs/live-payment-approval.md` (L1–L8)                                                                                 | —             |

## 2. Verification engine, against real providers

| Claim                                                         | Evidence                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resend read-back → VERIFIED                                   | `run_01M2YRDJFB…`, evidence origin `provider_readback`                                                                                                         |
| Resend wrong recipient → FAILED                               | `run_01M2YRJG8F…`, `CONTRADICTED / VALUE_MISMATCH`                                                                                                             |
| Provider unavailable → UNVERIFIED                             | `run_01M2YRBQ9E…`, `EVIDENCE_NOT_RETURNED`; `run_01M2YT605A…`, `CONNECTION_UNAVAILABLE`                                                                        |
| HubSpot match → SUPPORTED, run VERIFIED                       | `run_01M2YTSKKM…`, `evd_01M2YV0J4V…` hubspot/provider_readback; contact `871054966976` with `itisyou_verify_ref = ENQ-MATCH-0001` in portal 149371406          |
| HubSpot record of another enquiry → CONTRADICTION, run FAILED | `run_01M2YTSKRX…`, `CONTRADICTED / VALUE_MISMATCH` on `evd_01M2YV0MN4…`; the connector is read-only (property and contact were created in the owner's browser) |
| Missing record → FAILED_ABSENT, not a contradiction           | `run_01M2YS2Z45…`, `RECORD_NOT_FOUND`; decided by `decide.ts:128` (`unresolved.every(isAuthoritativeAbsence)` after the deadline with healthy access)          |
| Stored provider webhooks feed a verdict                       | **no, deferred.** `gatherEvidence` uses connector fetches only; a stored webhook alone leaves a run UNVERIFIED. Every public page says so                      |

All runs above are in our own workspaces against our own accounts and synthetic records. They
prove the providers answer this service correctly. They prove nothing about a customer's portal.

## 3. Identity, owner panel and the owner path

| Claim                                                                            | Evidence                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anonymous requests learn nothing about the panel                                 | production 09:32Z: `/owner` 404, `/owner/customers` 404, `/admin/authenticator` 404, `/admin` 303, `/admin/login` 200, `/app` 401                |
| Consequential owner actions need a code from the last 15 minutes                 | `authorise()` gate 3; OWNER-170/171; AUTH-451 (gate opens after a stamped code), AUTH-452 (an unstamped correct code does not open it)           |
| The automation identity cannot create tenants, activate ads, refund, move budget | AUTH-310..312, OWNER-911, AUTH-439                                                                                                               |
| Sign-in email actually leaves                                                    | production `notification_deliveries`: `sign_in_link` row `sent` 08:33:23Z; Resend log "Delivered" to the owner's address; API-247..249, AUTH-436 |
| A workspace can be created on production by a supported path                     | `workspace.create` deployed at `569e8e3`; OWNER-908..911, AUTH-437..439. **Not yet exercised by the owner**                                      |
| An authenticator can be enrolled and a code stamps the session                   | `/admin/authenticator` deployed at `569e8e3`; OWNER-912..916, AUTH-451..453. **No authenticator exists on production yet**                       |
| State of production identity at 08:58Z                                           | users 0, platform owners 0, authenticators 0, workspaces 0, memberships 0, live sessions 0, sign-in links 11 issued / 0 redeemed                 |
| Owner dashboard renders from live ports                                          | staging, seeded owner session: 200, eight launch tiles, POST without CSRF 403; OWNER-901..907                                                    |

## 4. Public claims

| Claim                                                  | Evidence                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No stale claim is served                               | release claim scan over 7 served pages, clean, at each deploy (`569e8e3` 09:31Z); CUST-333 asserts the dated provider facts                                                                                                                                                       |
| The activation notice names exactly the two open gaps  | `SERVICE_ACTIVATION_NOTICE`: live payments off; no customer workspace exists yet, public signup closed, only the owner can create one. Reworded after `569e8e3` made the owner path real; the old wording ("cannot yet create") is now in the CLOSED list of the consistency test |
| Webhook receipt is never described as verdict evidence | `PROVIDER_PROOF_NOTICE`, FAQ, story page; claim-scan rules                                                                                                                                                                                                                        |

## 5. Design

15 of 19 Stitch screens composed against their reference (`designProgress()`); 36
screenshots at 390/820/1440 for the essential customer screens; `/security` has no approved
reference and is marked as such. The design figure reaches Telegram once per new count
(OWNER-504) — it did not before `dd3c8c4`, and the owner had been told it had.

## 6. Tests

2,792 ledger rows (`docs/test-cases.json`), strict reconciliation passing at `7a4e026`; the
release gate refuses a production deploy without CI's artefact for HEAD and refuses when the
browser suite has any unexpected or flaky result (it refused `e0aa820` on exactly that).

## 7. Launch figures, read from the tables

| Figure                   | Production                                                                                        | Staging                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| Sandbox transactions     | 0                                                                                                 | 1 checkout, 1 active subscription |
| Real revenue             | **£0.00**                                                                                         | £0.00                             |
| Verified external visits | **0 attributable**; 8 `external` rows, none with a UTM, 3 coincident with our own browser tooling | —                                 |
| Signups (workspaces)     | 0                                                                                                 | 1 (automation)                    |
| Customers                | 0                                                                                                 | 0                                 |
| Spend against the £100   | £0.00 confirmed; £30 contingency untouched                                                        | —                                 |

## 8. Advertising

Google Ads account 227-475-1523, campaign 24269887676. Published by the owner 07:55Z; found to
carry no keywords and no ads. Budget lowered 12.46 → **£12.25** total (Google's 2% UK DST fee
on top, VAT on the fee → £14.99), verified across a reload. Five exact-match keywords and
eight negatives saved. The packet's responsive search ad saved at 10:15Z after the owner
cleared Google's identity check: **Pending — Under review**, 0 impressions. Campaign status
"Not eligible" (low search volume, ad under review). Spend £0.00; no impression served.
States: drafted ✓, submitted ✓, approved ✗, delivering ✗.

## 9. What only the owner can do

`docs/owner-actions.md`, in order: O10 `OWNER_BOOTSTRAP_EMAIL`, O11 a bootstrap token, O12
an authenticator app, O8 claim the owner account, O13 enrol, O14 create the test workspace,
O6 sign in as it, O4 approve the two posts, O3 live payments (later). Also: the Google Ads
identity challenge on the ad editor.

## 10. Where things are

| Thing                  | Location                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| The single checklist   | `docs/launch-checklist.md`                                                                      |
| Owner steps            | `docs/owner-actions.md`                                                                         |
| Live-payment approval  | `docs/live-payment-approval.md`                                                                 |
| Campaign packet        | `docs/campaign-packet.md`                                                                       |
| Organic posts (for O4) | `docs/organic-launch.md` §4.3, §5.3                                                             |
| Workflow evidence      | `docs/workflow-evidence.md`                                                                     |
| Story record           | `docs/development-story-events.json` (EVT-0001..0046), `docs/development-story.md`, `-agent.md` |
| Release verification   | `docs/release-verification.md`; `scripts/release.mjs`                                           |
| Release worktree       | `H:/itisyou-verify-rel2` (detached, disposable; remove with `git worktree remove`)              |
