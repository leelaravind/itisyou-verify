# Live customer payments — approval pack for the owner

Decision-ready page. Nothing here is switched on; live charges stay disabled until you say
otherwise, and then only after the items marked **owner** are done.

Written 20 September 2026 at 08:00 UTC from the state of the deployed service, the Stripe
sandbox, and the repository at `cff4749`.

## What is proven today, in sandbox

| Claim                                                                                      | Evidence                                                                                                                                                                            | Where                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A customer can reach checkout from the review page                                         | the control renders only when the server would accept the purchase; BILL-625, CUST-907                                                                                              | production, `/app/onboarding/review`                   |
| A real Stripe Checkout Session completes and returns the customer to a working page        | £29.00 paid with a test card on 20 Sept; `/app/billing/return` says the provider accepted the payment and does not claim activation                                                 | staging                                                |
| Signed webhooks are accepted and activate a subscription exactly once                      | three real events resent and accepted; one `subscriptions` row `active`; one Stripe-created `entitlements` row of 500 runs; replay answered `already_processed` and changed nothing | staging database, confirmed by an independent verifier |
| An event for a workspace this deployment does not hold is refused by name, not by crashing | BILL-640 to BILL-653; production refused the staging workspace's events with a 200 and a recorded reason                                                                            | production log                                         |
| Live-mode events cannot act on a test-mode deployment and vice versa                       | mode mismatch refused on checkout, webhook, portal and provision paths                                                                                                              | `providerModeMatches`, tested                          |
| Refunds are single-use, owner-approved, and bound to the payment target                    | BILL-400/401/402, OWNER-370                                                                                                                                                         | tested                                                 |

## What is NOT yet proven

| Gap                                                                   | Why it matters                                                                                        | Closes when                                                                                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A checkout **originating from production**                            | Everything above ran on staging; production has 0 workspaces and has never created a Checkout Session | O6: you sign in on production once with a `+verify-test` address you own; I drive the purchase from that session and prove activation, allowance, replay and access there   |
| A **live-mode** payment                                               | None has ever been taken, by design                                                                   | after your approval, one live £29.00 charge on your own card, then an immediate refund through the owner path, so the live pipe is proven with your money and nobody else's |
| Renewal, failed-payment recovery and cancellation against Stripe live | tested against fixtures and sandbox only                                                              | the first real billing cycle                                                                                                                                                |

## What must exist before live mode can be switched on

| #   | Requirement                                                                                                                                                                          | Who                                                      | State                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| L1  | Stripe account **activated** for live payments (business details, identity, bank account, statement descriptor)                                                                      | **owner**                                                | not readable by me — the account pages are outside what I can open; confirm in Stripe > Settings > Account status |
| L2  | A **live** price for the plan, £29.00 a month, in the live catalogue                                                                                                                 | **owner** creates; I verify the id                       | not created                                                                                                       |
| L3  | Live secret key, live price id, and a **live webhook destination per environment** with its own signing secret, each set with `wrangler secret put` (prompted, never pasted in chat) | **owner** enters; I verify shape and a signed test event | not set                                                                                                           |
| L4  | `STRIPE_MODE` flipped to `live` on production only                                                                                                                                   | me, after L1 to L3                                       | `test` everywhere today                                                                                           |
| L5  | Terms, privacy, refund and cancellation pages say what live billing does                                                                                                             | me                                                       | present and served; refund and cancellation text exists on `/terms` and `/app/billing`                            |
| L6  | VAT position on the £29.00 price: inclusive or exclusive, and whether to collect a VAT number                                                                                        | **owner** decision                                       | undecided; the price page says "£29.00 a month" with no tax statement                                             |
| L7  | Owner alert on first live payment and on every failed live charge                                                                                                                    | exists, fires via Telegram                               | wired, tested, delivered on staging                                                                               |
| L8  | Reconciliation job comparing Stripe's subscriptions to ours on a schedule                                                                                                            | exists                                                   | `reconcile.ts`, tested                                                                                            |

## The decision you are being asked to make

Approve live payments **only** once L1 to L3 and L6 are done and the production-origin
sandbox checkout (O6) has been demonstrated. When you do, the sequence is: L4 on production;
one live £29.00 charge on your own card; refund it through `/owner`; confirm the refund on
Stripe; then and only then let a stranger pay.

Until then the answer to "can a customer pay you" is: **not yet, and that is deliberate**.
