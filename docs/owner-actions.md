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

| #   | Defect                                                                                                                                                                                                        | State                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| M3  | No supported way to create a customer workspace on production: signup closed, seed script refuses production by design, your sign-in produced a user with no membership.                                      | **code done, 7 new tests passing, not deployed** |
| M4a | No page to enrol an authenticator. `enrolTotp` exists and is called only by tests. Without it no owner action can pass the two-factor gate.                                                                   | building now                                     |
| M4b | `/admin/verify` checks the code but never stamps the session (`verifyTotpForUser` is called without `sessionId`), so a correct code still leaves every consequential action refused with "Confirm it is you". | building now                                     |

Until M3 + M4 are deployed, steps O8 to O6 below cannot succeed. I will message
"deployed &lt;sha&gt;, production verified" when they can.

## Do now — nothing of mine blocks these

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why only you                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| O10 | **Set the platform-owner address on production.** It is not configured today, so `/admin/bootstrap` refuses everyone. In a terminal: `cd apps/app` then `pnpm exec wrangler secret put OWNER_BOOTSTRAP_EMAIL --env production` and type `kpleelaaravind@gmail.com` at the prompt. Recommended because it is your Google account and the address the test suite treats as owner; keep `leelaaravindkarlapudi2002@outlook.com` as the _customer_ test identity so the two never share a user row. If you prefer, say "set it" and I run exactly that command with that address. | Choosing who may become platform owner is your decision.    |
| O11 | **Set a bootstrap token you hold.** One exists on production, but I cannot read it and have no record that you were ever given it. Generate a long random string in your password manager, then `pnpm exec wrangler secret put OWNER_BOOTSTRAP_TOKEN --env production` and paste it at the prompt. Never paste it in chat. It is used once, and the path closes itself after first use.                                                                                                                                                                                       | Only you should hold the credential that creates the owner. |
| O12 | **Install an authenticator app** on your phone (Google Authenticator, Aegis, 1Password, Authy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner actions need a fresh 6-digit code within 15 minutes.  |
| O4  | **Approve the two organic posts.** Shortened, no client stories, read-back-only wording; shown in full in chat and in `docs/organic-launch.md` §4.3 and §5.3.                                                                                                                                                                                                                                                                                                                                                                                                                 | They publish under your name.                               |

## After I message "deployed" — in this order, about 10 minutes

| #   | Action                                                                                                                                                                                                                                                                                                                                                                             | What it unblocks                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| O8  | **Become platform owner.** Open `https://verify.itisyou.app/admin/login`, enter the O10 address, open the emailed link within 15 minutes (it lands on `/admin/login/complete`), then open `https://verify.itisyou.app/admin/bootstrap` and paste the O11 token. You are redirected to `/owner`.                                                                                    | Every owner-panel page.                                        |
| O13 | **Enrol the authenticator.** Open `https://verify.itisyou.app/admin/authenticator`, press Enrol, add the secret to your app, store the recovery codes offline (they are shown once and never again), then enter a code when the panel asks "Confirm it is you". That stamps your session for 15 minutes.                                                                           | Every consequential action, including O14.                     |
| O14 | **Create your isolated test workspace.** `https://verify.itisyou.app/owner/customers` → "Create a customer workspace": address `leelaaravindkarlapudi2002@outlook.com`, name "Owner test workspace", tick **Test workspace** (kept out of every launch figure; removable by cleanup).                                                                                              | D1.2 production-origin checkout.                               |
| O6  | **Sign in as that customer.** `https://verify.itisyou.app/app/sign-in` → the outlook address → open the link within 15 minutes. `/app` shows the workspace. Tell me. I then drive the sandbox checkout in your browser (Stripe's hosted page, Stripe test card, nothing real) and prove activation, exactly-once allowance, replay refusal and authenticated access on production. | D1.2 to D1.6, then the live-payment approval pack is complete. |

## Later, and only after O6 is proven

| #   | Action                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O3  | Approve live customer payments. The pack is `docs/live-payment-approval.md`: L1 activate the Stripe account, L2 create the live £29.00 price, L3 enter live secrets with `wrangler secret put`, L6 decide the VAT position. Live charges stay off until you say so, and then the first live charge is your own card, refunded through `/owner`. |

## Already done, or nothing needed from you

| #   | State                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Google identity challenge — done.                                                                                                                                                                                                                                                                                                               |
| O2  | EU political-ads declaration — done.                                                                                                                                                                                                                                                                                                            |
| O5  | Tax and fee treatment — read from the account. Google adds a 2% UK DST fee on top of media spend and VAT applies to the fee, so the campaign total was lowered to **£12.25** (saved, verified across a reload): £12.25 + 2% = £12.50, + 20% VAT = **£14.99**. Nothing else caps anything in a UK postpay account.                               |
| O7  | Campaign published by you. The published campaign had **no keywords and no ads**; I have added the five exact-match keywords from the packet and am adding the negatives and the responsive search ad. Google shows "Not eligible — low search volume, under review": that is Google's status, and zero impressions remains a possible outcome. |
| O9  | Nothing: the budget is not to be increased, and it is not.                                                                                                                                                                                                                                                                                      |

## Mine, in order, so you can see what you are waiting on

1. M3 — done in code; OWNER-908..911 and AUTH-437..439 passing.
2. M4a authenticator enrolment page, M4b session stamp on a correct code — with tests.
3. Typecheck, lint, full suite, CI on `origin/main`, release gate, deploy, `/health` commit check, then the message to you.
4. Google Ads: negatives and the ad; record the DST fee and the £12.25 in `docs/campaign-packet.md`.
5. Both organic posts shortened for O4.
6. Production unknown-workspace guard exercised with one real resent Stripe event.
7. Development stories and the handover after O6 is proven.
