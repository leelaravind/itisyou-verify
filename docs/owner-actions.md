# What only you can do — in order, with what each unblocks

Written 20 September 2026, 09:00 UTC. Every figure here was read from the deployed service
or its database at that time; nothing is assumed.

## Where production actually is

Read from the production database at 08:58 UTC (aggregates only):

| Table                           | Count      |
| ------------------------------- | ---------- |
| users                           | **0**      |
| users with `is_platform_owner`  | **0**      |
| users with an authenticator     | **0**      |
| workspaces / memberships        | **0 / 0**  |
| live sessions                   | **0**      |
| sign-in links issued / redeemed | **11 / 0** |

Nobody has ever completed a sign-in on production, including you. Your link from 08:33 UTC
was delivered (Resend "Delivered") and expired unclicked at 08:48 UTC. That is not a fault;
it just means step O8 below starts from a fresh link.

## Three application defects found while tracing your sign-in — mine, not yours

| #   | Defect                                                                                                                                                                                                        | State                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| M3  | No supported way to create a customer workspace on production: signup closed, seed script refuses production by design, your sign-in produced a user with no membership.                                      | **deployed `569e8e3` 09:31Z, production verified**                                                                                   |
| M4a | No page to enrol an authenticator. `enrolTotp` exists and is called only by tests. Without it no owner action can pass the two-factor gate.                                                                   | **deployed `569e8e3`, production verified** (`/admin/authenticator` answers 404 to anonymous)                                        |
| M4b | `/admin/verify` checks the code but never stamps the session (`verifyTotpForUser` is called without `sessionId`), so a correct code still leaves every consequential action refused with "Confirm it is you". | **deployed `569e8e3`**; AUTH-451 proves enrol → code → stamp → gate opens; not yet exercised on production (no authenticator exists) |

M3 + M4 are deployed and production verified (09:31Z, and the Telegram release message reached you at 09:44Z). Steps O8 to O6 can succeed as soon as O10 and O11 are done. As of 10:20Z production still has 0 platform owners, 0 authenticators, 0 workspaces and no bootstrap attempt; your 09:23Z session is live.

## Do now — nothing of mine blocks these

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why only you                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| O10 | **Set the platform-owner address on production.** It is not configured today, so `/admin/bootstrap` refuses everyone. In a terminal: `cd apps/app` then `pnpm exec wrangler secret put OWNER_BOOTSTRAP_EMAIL --env production` and type `kpleelaaravind@gmail.com` at the prompt. Recommended because it is your Google account and the address the test suite treats as owner; keep `leelaaravindkarlapudi2002@outlook.com` as the _customer_ test identity so the two never share a user row. If you prefer, say "set it" and I run exactly that command with that address. | Choosing who may become platform owner is your decision.    |
| O11 | **Set a bootstrap token you hold.** One exists on production, but I cannot read it and have no record that you were ever given it. Generate a long random string in your password manager, then `pnpm exec wrangler secret put OWNER_BOOTSTRAP_TOKEN --env production` and paste it at the prompt. Never paste it in chat. It is used once, and the path closes itself after first use.                                                                                                                                                                                       | Only you should hold the credential that creates the owner. |
| O12 | **Install an authenticator app** on your phone (Google Authenticator, Aegis, 1Password, Authy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner actions need a fresh 6-digit code within 15 minutes.  |
| O4  | **Approve the two organic posts.** Shortened, no client stories, read-back-only wording; shown in full in chat and in `docs/organic-launch.md` §4.3 and §5.3.                                                                                                                                                                                                                                                                                                                                                                                                                 | They publish under your name.                               |

## After I message "deployed" — in this order, about 10 minutes

| #   | Action                                                                                                                                                                                                                                                                                                                                                           | What it unblocks                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| O8  | ~~Become platform owner~~ — **done 10:59:25Z** (`owner.bootstrap: granted`). `OWNER_BOOTSTRAP_EMAIL` was set by the lead at your instruction (10:43Z) and verified equal to your session's identity.                                                                                                                                                             | Every owner-panel page.          |
| O13 | ~~Enrol the authenticator~~ — **done**: enrolled 11:09:28Z, code accepted 11:37:55Z (`auth.totp.accepted`), session stamped.                                                                                                                                                                                                                                     | Every consequential action.      |
| O14 | ~~Create your isolated test workspace~~ — **done 11:39:29Z** through `/owner/customers` inside your MFA window: `ws_01M2Z9TE8795829F6132BD4B5F`, active, synthetic, one `workspace_admin` membership for the outlook identity, one `owner.workspace.created` audit row. Bootstrap proven closed: your second paste was refused `already_bootstrapped` 11:59:01Z. | D1.2 production-origin checkout. |
| O6  | ~~Sign in as that customer~~ — **done 12:0xZ (20 Sept)**; production sandbox checkout completed 21 Sept 07:54Z: order `ord_01M31E6KYED181BAC8307E46E9` active, subscription active, one 500-run allowance, replay proven a duplicate, `/app/billing` and `/app/usage` showing it.                                                                                | D1 closed.                       |

## Next decisions — O6 is proven, so these are now live

| #   | Action                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L5  | Supply the seven legal-identity values for `/terms` and `/privacy` (registered business name, address, company registration number, VAT number or "not registered", legal structure, legal-notice contact, certifications or "none"), or state which do not apply. |
| L6  | Decide the VAT position: "£29.00 includes any VAT that applies; we are not VAT-registered" (wording change only) **or** Stripe Tax (registration in the parent account + `automatic_tax` at checkout).                                                             |

## Later

| #   | Action                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O3  | Approve live customer payments. The pack is `docs/live-payment-approval.md`: L1 activate the Stripe account, L2 create the live £29.00 price, L3 enter live secrets with `wrangler secret put`, L6 decide the VAT position. Live charges stay off until you say so, and then the first live charge is your own card, refunded through `/owner`. |

## Already done, or nothing needed from you

| #   | State                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Google identity challenge — done.                                                                                                                                                                                                                                                                                                                                                                               |
| O2  | EU political-ads declaration — done.                                                                                                                                                                                                                                                                                                                                                                            |
| O5  | Tax and fee treatment — read from the account. Google adds a 2% UK DST fee on top of media spend and VAT applies to the fee, so the campaign total was lowered to **£12.25** (saved, verified across a reload): £12.25 + 2% = £12.50, + 20% VAT = **£14.99**. Nothing else caps anything in a UK postpay account.                                                                                               |
| O7  | Campaign published by you (07:55Z); it was empty. Lead added the five exact-match keywords and eight negatives; you cleared Google's identity check (10:12Z) and the packet's responsive search ad was saved 10:15Z: **Pending — Under review**, 0 impressions, spend GBP 0.00. Campaign status "Not eligible" until the review and the low-volume keywords clear; zero impressions remains a possible outcome. |
| O9  | Nothing: the budget is not to be increased, and it is not.                                                                                                                                                                                                                                                                                                                                                      |

## Mine, in order, so you can see what you are waiting on

1. M3 — done in code; OWNER-908..911 and AUTH-437..439 passing.
2. M4a authenticator enrolment page, M4b session stamp on a correct code — with tests.
3. Typecheck, lint, full suite, CI on `origin/main`, release gate, deploy, `/health` commit check, then the message to you.
4. Google Ads: negatives and the ad; record the DST fee and the £12.25 in `docs/campaign-packet.md`.
5. Both organic posts shortened for O4.
6. Production unknown-workspace guard exercised with one real resent Stripe event.
7. Development stories and the handover after O6 is proven.
