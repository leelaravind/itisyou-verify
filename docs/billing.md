# Money — what we charge, when, and what happens when something goes wrong

Owned by A06 (Commerce). This is the plain-language money model for ITISYOU Verify, and
the reference for anyone writing customer-facing copy about billing. If a sentence about
money appears anywhere in the product, it should be traceable to this page.

Everything below that involves a number is either a constant in
`packages/contracts/src/rules.ts`, a figure verified against a provider's own published
pricing on the date stated, or explicitly labelled an estimate.

---

## 1. The offer

**£29 per month. One workflow. 500 verification runs per billing period.**

| Thing | Value | Where it comes from |
| --- | --- | --- |
| Price | £29.00 / month | `LIMITS.PLAN_PRICE_PENCE = 2900` |
| Allowance | 500 runs per period | `LIMITS.PLAN_RUNS_PER_PERIOD = 500` |
| Currency | GBP | `PLAN.currency` in `apps/app/src/billing/config.ts` |
| Billing interval | Monthly, recurring | Stripe price, `recurring[interval]=month` |
| Workflows | One per workspace | `docs/product-scope.md` §6 |

The price is held in integer pence everywhere. There is no floating-point arithmetic
anywhere near a charge or a cap (`packages/contracts/src/money.ts`).

**The price is chosen by the server, every time.** `startCheckout()` takes a workspace id
resolved from the session and nothing else — no amount, no price id, no currency, no
customer id, no status. A request body carrying any of those has nothing to attach itself
to. Test `BILL-088` sends exactly such a payload and asserts that the resulting order and
the Stripe session are unchanged.

### VAT

Not modelled in v1. The £29 is the amount Stripe collects. Whether the founder must
register for and charge VAT, and whether £29 is treated as VAT-inclusive, is a decision
for the founder and their accountant — **flagged as an open item, not an assumption made
here.** If VAT applies at 20% and £29 is treated as inclusive, the net revenue per
subscription drops to £24.17 before fees, which changes the margin in §7 materially.

---

## 2. When the customer is charged

1. The customer clicks "Subscribe". We check, **before showing a card**, whether their
   setup is something we can actually verify — HubSpot connected with read access, a
   correlation property named, Resend readable. If not, the order is **rejected with a
   reason they can act on** and no payment page is ever shown (`BILL-089`). Payment must
   never mask a setup we cannot serve.
2. If eligible, we create a Stripe **hosted Checkout Session** and redirect. Card details
   never touch our servers — we never see a card number, and we store no payment
   instrument.
3. Stripe charges £29 immediately on successful checkout, and then every month on the
   same day of the month (the subscription's billing anchor).
4. Each renewal produces an invoice. A paid invoice opens the next period's allowance.

### The success page proves nothing

Being redirected back to our success URL does **not** activate a subscription. That page
performs a read and reports what our stored state currently says, which for a customer who
has just been redirected is normally "waiting for Stripe to confirm".

Only two things can change entitlement:

- a **signature-verified webhook** from Stripe, or
- a **read against Stripe's own records** (the scheduled reconciliation, or the
  subscription lookup the checkout webhook performs).

Tests `BILL-095`, `BILL-096` and `BILL-097` cover this: hitting and replaying the success
URL leaves the workspace inactive and writes nothing at all.

---

## 3. The allowance, and what happens at the limit

The period allowance is 500 runs, held as three integers: `run_limit`, `consumed` and
`reserved`. Remaining is `run_limit - consumed - reserved`.

- A unit is **reserved** the moment a run is admitted, atomically, in one conditional
  statement. Two source events arriving at the same instant cannot be sold the same unit.
- The reservation becomes **consumed** when the run reaches a terminal state
  (`VERIFIED`, `FAILED` or `UNVERIFIED`).
- `UNVERIFIED` still consumes a unit. We did the work and produced a real answer;
  "we couldn't tell" is a result, not a failure to deliver.

### At 500 runs

- We **stop admitting new runs** for the rest of the period.
- There is **no automatic overage charge**. We will never bill more than £29 in a month
  without the customer choosing to.
- Everything else keeps working: sign-in, the dashboard, past results, evidence within its
  30-day retention, export, updating the card, and cancelling.
- Runs already admitted and in flight complete normally.

### Which internal failures give a unit back

A release is correct exactly when the customer got nothing for the unit. This is the
complete list, and it is enforced in `apps/app/src/billing/entitlements.ts`:

| Case | Reservation | Why |
| --- | --- | --- |
| Admitted, but the run row failed to commit | **released** | Nothing exists to verify |
| Scheduler could never lease the run | **released** | No observation was ever attempted |
| Our own configuration was invalid (missing workflow version) | **released** | Our fault, before any provider work |
| Retention or cleanup deleted the run before it settled | **released** | We destroyed the work |
| Workspace deleted mid-flight | **released** | Nobody to serve |
| Provider call failed and the run settled `UNVERIFIED` | **consumed** | We did the work; that is a real answer |
| Run settled `VERIFIED` / `FAILED` / `UNVERIFIED` | **consumed** | Terminal state reached |
| A **queue retry** of an already-admitted run | **neither** | Same unit — a retry is not a new run |
| A **provider callback** for an existing run | **neither** | Evidence for a unit already held |
| **Internal error recovery** re-running an admitted run | **neither** | Same unit |

The last three are the ones that become a double charge if you get them wrong, which is
why they reserve nothing at all rather than reserving and releasing. Tests `BILL-051`,
`BILL-052` and `BILL-053` prove each of them is admitted without touching the counters,
even when the workspace is already at its allowance.

### How a period is identified

The allowance row is keyed by the UTC date the paid period **ends**, not the date it
starts. This is load-bearing. Two different events describe the same period —
`customer.subscription.*` carries `items.data[].current_period_end` and `invoice.paid`
carries its line item's `period.end` — and both give the end *exactly*. Neither carries a
start we can trust to agree: deriving one by stepping a month backwards lands on a 30- or
31-day boundary depending on the month, so the two sources would produce two different
keys for one period, `UNIQUE (workspace_id, billing_period)` would happily allow both rows,
and the workspace would hold 1,000 runs for one £29 payment. Keying on the end makes the
two sources agree by construction (`BILL-183`, `BILL-192`).

### Rollover

Unused runs **do not carry over**. A new period is a new row with fresh counters; the
previous period's row is left exactly as it was, because it is the record of what the
customer actually used and is what a dispute would be settled from (`BILL-125`).

---

## 4. Failed payment — the payment-recovery window

**Seven days. Approved by the founder on 2026-09-19.** The policy lives as a typed
constant in `apps/app/src/billing/policy.ts` (`PAYMENT_RECOVERY_POLICY`), so this section
and the product cannot drift apart.

When a renewal payment fails, Stripe moves the subscription to `past_due` and retries the
card on its own schedule. From that moment:

**What pauses — exactly one thing.** New verification runs are not accepted, so new
enquiries are not being checked. That is the whole of it.

**What stays available — no exceptions.**

- Signing in to the workspace
- The full run history and every past result
- Evidence still inside its retention period
- Exporting the data
- Updating the payment method
- **Cancelling.** Cancellation is never harder during a payment problem than outside one.
  Tested on day 1 (`BILL-186`) and on day 8 (`BILL-200`).

**What the customer is told.** Not "there is a billing issue". The message names the
consequence they care about — that we have paused checking new runs — alongside what has
*not* stopped. It goes out on A09's `payment_problem` template, keyed so that Stripe's
card retries cannot become a stream of identical emails (`BILL-187`, `BILL-188`).

**How verification resumes.** Only on a payment confirmed by Stripe: a signature-verified
webhook, or the scheduled reconciliation reading it back from Stripe's own records. A
checkout redirect, a retry attempt and an optimistic UI state all resume nothing
(`BILL-195`).

**The allowance is applied exactly once per paid period.** Recovery inside the window
resumes on the allowance the customer already has, with the runs they already used still
counted (`BILL-190`). A duplicate `invoice.paid` grants nothing extra (`BILL-191`), and
nor does one delivered out of order (`BILL-193`). A genuinely new paid period does open
its own allowance (`BILL-194`).

**On day 8.** Verification stays suspended and the subscription is marked `unpaid`. It is
**not cancelled** — the customer decides whether to leave — and it does not quietly resume
(`BILL-197`). The scheduled sweep that does this is idempotent (`BILL-199`), never
resurrects a cancelled subscription (`BILL-203`), and keeps the row's original provider
timestamp so a genuine later payment still outranks it (`BILL-202`) while a stale event
still loses (`BILL-201`).

**Nothing is deleted.** There is no non-payment deletion path anywhere in the billing
subsystem. Retention follows A09's published policy in `docs/privacy-retention.md` and
nothing else. Day 8 leaves the allowance, the orders, the customer binding and the
subscription row all intact (`BILL-198`).

**The policy is shown before checkout, not discovered afterwards.**
`PRE_CHECKOUT_DISCLOSURE` in `apps/app/src/billing/policy.ts` carries the price, the
allowance behaviour, the cancellation behaviour, the refund position and the full recovery
policy as one typed object for A05 to render on the review-and-price step (`BILL-166`,
`BILL-205`).

### How the window is anchored, and why it cannot drift

`migrations/0001_init.sql` is frozen and has no grace column, so the window is derived
from what we already store — and the derivation is better than a stored failure timestamp
would have been.

When a renewal invoice is not paid, Stripe does **not** advance the subscription's period,
so `current_period_end` stays at the end of the period the customer actually paid for. The
window runs seven days from that instant. It is therefore stable under redelivery (a
duplicate `invoice.payment_failed` computes the same deadline), stable under reordering
(it does not depend on which event arrived first), and unmoved by however many times
Stripe retries the card inside the window (`BILL-170`).

If a subscription has no period end recorded, the window is measured from when we recorded
the failed state instead. The window reports which anchor it used (`anchoredOn`), so this
is visible rather than hidden (`BILL-174`).

Why 7 days: long enough to cover an expired card over a weekend, short enough that we are
not indefinitely doing work for free.

## 5. Cancellation

Two timings, and the default matters.

**At period end (the default, and what the portal offers).** The customer has paid for the
current period, so they keep it. No further payment is taken. Service continues normally
until the period end, then stops. `BILL-100`.

**Immediately.** Available for support-led cancellations. Service stops now.
**Cancelling immediately does not itself refund anything** — a refund is a separate,
owner-decided act (`BILL-101`).

Cancellation can be done from the Stripe hosted Billing Portal or from our own UI; both
end in the same place. Our stored state is *not* written at the moment of cancellation —
the `customer.subscription.updated` or `.deleted` event that follows is what changes it,
so cancellation goes through exactly the same out-of-order guards as every other provider
change.

**A cancelled subscription never comes back.** Once we have stored `canceled`, no webhook
moves it to another status — not a stale one, not a same-second one, and not a
later-stamped one. Stripe itself documents a cancelled subscription as "largely
immutable". Tests `BILL-018`, `BILL-019`, `BILL-020`, `BILL-118`, `BILL-119` and
`BILL-120`.

---

## 6. Refunds — the current policy

**Every refund is queued for the owner. The system recommends; the owner decides.**

There is no deterministic automatic-refund policy yet, and until the founder approves one
there is no code path that submits a refund without a recorded owner approval
(`BILL-139`).

A refund moves through seven distinct states, because collapsing any two of them is how a
customer gets told they were refunded when they were not:

| State | What it means |
| --- | --- |
| `requested` | We have written the request down. Nothing has been decided. |
| `queued_for_owner` | Waiting for the owner. Every request lands here. |
| `submitted` | Sent to Stripe. No usable answer yet. |
| `pending` | Stripe accepted it and is still moving the money. |
| `succeeded` | Stripe says the money went back. **Only this may be called "refunded".** |
| `failed` | Stripe could not do it. The customer still has a claim. |
| `rejected` | The owner declined. |

What the customer sees is derived from that state and never from a button press: a
submitted request reads "Refund in progress with our payment provider", a queued one reads
"Refund requested — under review", and only `succeeded` reads "Refunded" (`BILL-146`,
`BILL-147`).

Each refund carries one idempotency key, which is both our unique row key and the
`Idempotency-Key` we send to Stripe. The same request twice returns the original refund
(`BILL-134`); a retry after a transport failure re-sends the same key and cannot move
money twice (`BILL-142`).

A refund issued directly from the Stripe dashboard, which we have no local record of, is
**reported, never fabricated** (`BILL-130`).

### What the founder needs to decide

1. Is there an automatic-refund rule at all (for example: full refund inside 14 days with
   zero runs consumed)? Until that is approved, everything is manual.
2. Does a refund also cancel the subscription, or are they separate acts? Currently
   separate.
3. What is stated publicly as the refund window?

---

## 7. Stripe's fees, verified, and the contribution margin

### The fees

All checked against Stripe's own published UK pricing on **2026-09-19**.

| Fee | Rate | Source |
| --- | --- | --- |
| UK standard domestic cards | **1.5% + 20p** | https://stripe.com/gb/pricing |
| UK premium cards (commercial/corporate) | **2.8% + 20p** | https://stripe.com/gb/pricing |
| EEA cards | **2.5% + 20p** | https://stripe.com/gb/pricing |
| International cards | **3.15% + 20p** | https://stripe.com/gb/pricing |
| Currency conversion (EEA/international, when required) | **+2%** | https://stripe.com/gb/pricing |
| Stripe Billing, pay-as-you-go | **0.7% of billing volume** | https://stripe.com/gb/billing/pricing |

Stripe Billing's paid tiers start at £450/month, which is nonsense at our volume — the
pay-as-you-go 0.7% is the correct line. There is **no free allowance** on Stripe Billing
volume (checked 2026-09-19 on the page above).

### Contribution margin on one £29 subscription

Arithmetic in pence, per successful monthly charge:

| Card type | Card fee | Billing fee (0.7%) | Total fees | Net to us | Margin |
| --- | --- | --- | --- | --- | --- |
| **UK standard (expected case)** | 43.5p + 20p = **63.5p** | 20.3p | **83.8p** | **£28.16** | **97.1%** |
| EEA | 72.5p + 20p = 92.5p | 20.3p | 112.8p | £27.87 | 96.1% |
| UK premium/commercial | 81.2p + 20p = 101.2p | 20.3p | 121.5p | £27.79 | 95.8% |
| International | 91.35p + 20p = 111.35p | 20.3p | 131.65p | £27.68 | 95.5% |
| International + conversion | 111.35p + 58p = 169.35p | 20.3p | 189.65p | £27.10 | 93.5% |

**The expected case is £28.16 net on a £29 subscription — a contribution margin of about
97% before any of our own costs.**

### Assumptions, and what is an estimate

- **Verified**: every percentage and fixed fee above, on 2026-09-19, from the two Stripe
  URLs given. The arithmetic is this document's own.
- **Estimated**: the per-transaction rounding. Stripe rounds each fee to the penny; I have
  carried the exact fraction (43.5p) rather than guessing the direction, so the real figure
  may differ by a penny either way.
- **Not modelled**: VAT (see §1), payout/bank fees, and **disputes**. A chargeback carries
  a separate dispute fee which I did not verify against a current UK source, so no number
  is stated here. One disputed £29 subscription wipes out the margin on a meaningful
  number of others; it should be quantified before any volume forecast is built on this
  table.
- **Not included**: our own delivery costs. Cloudflare Workers and D1 sit inside the
  existing account plan, and Resend's free tier covers early volume, but no consumption
  data exists yet (`docs/product-scope.md` §6 says the same). **Contribution margin is not
  net profit**, and revenue is not authorisation to increase ad spend — founder money and
  customer subscription revenue are separate ledger categories and stay that way.

---

## 8. How the technical design keeps the above true

### The Stripe API version we target

**`2026-08-26.dahlia`**, pinned in `packages/connectors/src/stripe.ts` and sent as
`Stripe-Version` on every request. Verified 2026-09-19 against
https://docs.stripe.com/api/versioning.

Endpoints and parameters, all verified the same day:

| Operation | Endpoint | Source |
| --- | --- | --- |
| Create a customer | `POST /v1/customers` | https://docs.stripe.com/api/customers/create |
| Create a Checkout Session | `POST /v1/checkout/sessions` | https://docs.stripe.com/api/checkout/sessions/create |
| Create a Billing Portal session | `POST /v1/billing_portal/sessions` | https://docs.stripe.com/api/customer_portal/sessions/create |
| Retrieve a subscription | `GET /v1/subscriptions/:id` | https://docs.stripe.com/api/subscriptions/object |
| Cancel now | `DELETE /v1/subscriptions/:id` | https://docs.stripe.com/api/subscriptions/cancel |
| Cancel at period end | `POST /v1/subscriptions/:id` with `cancel_at_period_end=true` | https://docs.stripe.com/api/subscriptions/cancel |
| Create a refund | `POST /v1/refunds` | https://docs.stripe.com/api/refunds/create |
| List events for reconciliation | `GET /v1/events` (30 days, limit 1–100) | https://docs.stripe.com/api/events/list |
| Create product / price | `POST /v1/products`, `POST /v1/prices` | https://docs.stripe.com/api/prices/create |
| Idempotency | `Idempotency-Key` header, ≤255 chars, 24h retention | https://docs.stripe.com/api/idempotent_requests |
| Webhook signatures | `Stripe-Signature: t=…,v1=…`, HMAC-SHA-256 over `${t}.${rawBody}`, ignore non-`v1` schemes, 5-minute tolerance | https://docs.stripe.com/webhooks |

**Two shape changes in the current API that the code deliberately handles:**

- A Subscription no longer carries a top-level `current_period_end`. It lives on each
  subscription item at `items.data[].current_period_end`. We read the item and fall back to
  the legacy field so an event generated under an older account API version still parses
  (`BILL-084`, `BILL-085`).
- An Invoice no longer carries a top-level `subscription`. It lives at
  `parent.subscription_details.subscription`. Both are read (`BILL-086`).

### Webhooks

`POST /api/v1/webhooks/stripe/:opaqueId`, in that order:

1. Read the body **as bytes**. Stripe's documentation is explicit that any manipulation of
   the raw body breaks verification. Re-serialising the parsed JSON fails the check, and
   that is tested deliberately (`BILL-111`).
2. Enforce a **256 KiB cap**, first on the declared `Content-Length` and again on what
   actually arrived (`BILL-107`, `BILL-108`).
3. **Verify the signature**, then parse. Never the other way round.
4. Reject an event from the **wrong Stripe mode** — a test event delivered to live config
   is a 400 and changes nothing (`BILL-112`).
5. **Deduplicate on Stripe's event id**, backed by `UNIQUE (provider, event_id)` on
   `webhook_receipts`. A redelivery is a 200 with no second effect (`BILL-114`,
   `BILL-126`).
6. Dispatch. An unrecognised event type is recorded and ignored with a 200 (`BILL-131`) —
   returning non-2xx would make Stripe retry it for three days.

Status codes: **400** for a bad signature, an unparseable body or a mode mismatch — never
200. **413** for an oversized body. **200** for duplicates and for ignored types. **500**
when our own handler throws, after **releasing the receipt** so Stripe's retry is a fresh
attempt rather than a deduplicated no-op (`BILL-132`). Without that release, one internal
error would permanently swallow a paid invoice behind the dedupe constraint.

### The opaque endpoint id is a gate, not decoration

The path carries an opaque id — `/api/v1/webhooks/stripe/:opaqueId` — so that a leaked or
guessed endpoint URL is not by itself a way in. Two independent conditions must hold, and
an id we did not issue is rejected **before any work is done on the event**:

- the opaque id resolves to an endpoint we issued, **and**
- the signature verifies under *that endpoint's* secret.

Verification is still executed when the id is unknown, against a stand-in key, so the work
done and the time taken are the same either way and the response is byte-identical to a
wrong signature (`BILL-106`, `BILL-208`). But the rejection is on the **lookup result**,
never on the signature comparison.

**This was wrong in the first version, and A10 found it (SEC-431).** The route fell back to
a hardcoded stand-in secret and then accepted whatever verified against it. This repository
is permanently public, so that constant was readable by anyone: sign a fabricated
`invoice.paid` with it, POST to an endpoint id you invent, and it would have been
dispatched to the real handler. That is a free subscription, and money out on the refund
path. The opaque id was decoration and the shared secret was the only gate — exactly the
thing the opaque id exists to prevent. It was never exploitable in production because the
route is not yet mounted in `apps/app/src/index.ts`; it would have become exploitable the
moment it was.

The stand-in key is now also assembled at runtime rather than written as a literal
(`docs/agent-brief.md`, "Never commit a credential-shaped literal"), and
`unknownEndpointKey` can be overridden per deployment from a Worker secret. Since the route
fails closed on the lookup, that value carries no security weight either way — but a
credential-shaped string in a public repository is rejected by our scanner and by GitHub
push protection regardless, and it invites precisely the mistake above. Covered by
`BILL-207`, `BILL-208`, `BILL-209` and `BILL-210`.

### The receipt and the effect are not in one transaction

Stated plainly because it is a real limitation, not a solved problem.

The route claims the event id (`beginWebhookProcessing`), dispatches, then completes the
receipt — and on a thrown handler it releases the claim (`abandonWebhookProcessing`) and
returns 500 so Stripe's retry is a fresh attempt. That is claim-then-compensate, not a
transaction. D1's `batch()` is a list of statements, not an interactive transaction, so
application logic that reads between writes — which every one of these handlers does, since
deciding whether an event is stale requires reading the stored row first — cannot be
wrapped in one.

What makes the gap safe rather than merely acknowledged is that **every handler is
idempotent by construction**:

| Handler | Why re-running it is harmless |
| --- | --- |
| `checkout.session.completed` | `rememberBillingCustomer` is insert-once; the order transition `active → active` is legal and terminal; the subscription write goes through the guards |
| `customer.subscription.*` | `reconcileSubscription` returns `ignore_duplicate` for an identical snapshot |
| `invoice.paid` | `openAllowancePeriod` is keyed by period end and refreshes terms, never counters |
| `invoice.payment_failed` | the `past_due` write is guarded; the order transition is idempotent |
| `charge.refunded` | `applyProviderRefund` returns `no_change` when the state would not move |

So the failure modes resolve as follows. A crash **after** the effect and before the
receipt completes leaves the receipt at `received`; the retry reads `in_flight`, returns
200, and does nothing — the effect stands, applied once. A crash **between** the claim and
the effect, where the compensating release also fails, is the one genuinely bad case: the
retry is deduplicated and that event's effect is lost. The scheduled reconciliation in
`reconcile.ts` is the net that catches it, which is one of the two reasons it exists.

Closing the gap properly would mean restructuring each handler into "read, decide, then one
`batch()` containing the receipt insert and every resulting write". That is a real change
to the port's shape and is not something to guess at — flagged for the lead rather than
half-done.

### Out-of-order events

Stripe states plainly that it "doesn't guarantee the delivery of events in the order that
they're generated" and that "distinct events can share a timestamp". Two independent
guards, both in `apps/app/src/billing/state.ts`:

1. **Monotonic** — `subscriptions.provider_event_created` holds the `created` of the event
   that last wrote the row. A smaller value is ignored (`BILL-016`, `BILL-121`).
2. **Terminal** — once stored `canceled`, no event moves it to another status. Guard 1
   alone would let a *same-second* `customer.subscription.updated` re-enable a deleted
   subscription, because Stripe warns those timestamps can collide. Guard 2 closes it
   (`BILL-018`, `BILL-019`, `BILL-020`).

### Reconciliation

`reconcile.ts` runs on a schedule, compares each stored subscription against Stripe's own
record, and produces a **typed list of discrepancies for the owner**. It does not repair
anything. A reconciliation that silently fixes state hides the webhook bug that caused the
drift, and for a cancelled subscription would be exactly the resurrection the design
exists to prevent (`BILL-151`, `BILL-152`).

Discrepancy kinds: `status_mismatch`, `price_mismatch`, `period_end_mismatch`,
`cancel_at_period_end_mismatch`, `missing_at_provider`, `environment_mismatch`,
`allowance_period_missing`, `provider_unreadable`. Each carries plain language a person can
act on.

---

## 9. What is not proven

- **No call has ever been made to Stripe from this repository.** There is no key here, and
  a test-mode call would still create real objects in the owner's account. Every test
  injects a stub; `tests/setup.ts` fails loudly on any escaping `fetch`. The adapter is
  verified against the *documentation*, not against the live API.
- The bootstrap helper `ensureProductAndPrice` has never been run. It is written to be
  idempotent through the price `lookup_key` and to refuse rather than create a second price
  when the key is in use on different terms (`BILL-081`, `BILL-083`), but that is a claim
  about the code, not an observation of Stripe's behaviour.
- **Webhook signing-secret rotation is not implemented.** Recorded deliberately as a known
  limitation rather than quietly patched.

  Stripe's documentation (https://docs.stripe.com/webhooks, checked 2026-09-19) describes
  rolling an endpoint secret as follows: you may "choose to immediately expire the current
  secret or delay its expiration for up to 24 hours"; during that period "multiple secrets
  are active for the endpoint" and "Stripe generates one signature per secret until
  expiration". The `Stripe-Signature` header then carries several `v1=` values, of which
  only one matches any given secret.

  `verifyStripeSignature` in `packages/security/src/signatures.ts` already iterates every
  `v1` value in the header, so the *verifier* handles the dual-secret case correctly. The
  gap is one level up: `resolveEndpointSecret(opaqueId)` in
  `apps/app/src/routes/webhooks/stripe.ts` returns a **single** secret, so only signatures
  produced with that one secret can match.

  **What to expect when rolling the secret today.** Choose the 24-hour delayed expiry, not
  immediate. Between the moment Stripe starts signing with the new secret and the moment
  the new secret is deployed to the Worker, events signed with the new secret are rejected
  with a 400. Stripe retries a failed delivery for up to three days with exponential
  backoff, so events in that gap are not lost provided the new secret is deployed well
  inside three days; the scheduled reconciliation in `reconcile.ts` is the second net.
  Do **not** choose immediate expiry — that removes the overlap entirely and guarantees
  rejections with nothing to fall back on but the retry schedule.

  **The fix, when someone picks it up**, is to have `resolveEndpointSecret` return a *list*
  of candidate secrets and try each. That needs no change to the verifier and no schema
  change. It was left undone rather than guessed at because it needs a decision about where
  the second secret is stored and how it expires.
- Dispute/chargeback fees are unverified (§7).
