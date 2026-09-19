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

| Thing            | Value               | Where it comes from                                 |
| ---------------- | ------------------- | --------------------------------------------------- |
| Price            | £29.00 / month      | `LIMITS.PLAN_PRICE_PENCE = 2900`                    |
| Allowance        | 500 runs per period | `LIMITS.PLAN_RUNS_PER_PERIOD = 500`                 |
| Currency         | GBP                 | `PLAN.currency` in `apps/app/src/billing/config.ts` |
| Billing interval | Monthly, recurring  | Stripe price, `recurring[interval]=month`           |
| Workflows        | One per workspace   | `docs/product-scope.md` §6                          |

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

| Case                                                         | Reservation  | Why                                    |
| ------------------------------------------------------------ | ------------ | -------------------------------------- |
| Admitted, but the run row failed to commit                   | **released** | Nothing exists to verify               |
| Scheduler could never lease the run                          | **released** | No observation was ever attempted      |
| Our own configuration was invalid (missing workflow version) | **released** | Our fault, before any provider work    |
| Retention or cleanup deleted the run before it settled       | **released** | We destroyed the work                  |
| Workspace deleted mid-flight                                 | **released** | Nobody to serve                        |
| Provider call failed and the run settled `UNVERIFIED`        | **consumed** | We did the work; that is a real answer |
| Run settled `VERIFIED` / `FAILED` / `UNVERIFIED`             | **consumed** | Terminal state reached                 |
| A **queue retry** of an already-admitted run                 | **neither**  | Same unit — a retry is not a new run   |
| A **provider callback** for an existing run                  | **neither**  | Evidence for a unit already held       |
| **Internal error recovery** re-running an admitted run       | **neither**  | Same unit                              |

The last three are the ones that become a double charge if you get them wrong, which is
why they reserve nothing at all rather than reserving and releasing. Tests `BILL-051`,
`BILL-052` and `BILL-053` prove each of them is admitted without touching the counters,
even when the workspace is already at its allowance.

### How a period is identified — one function, one spelling

`apps/app/src/billing/period.ts` is the only place an allowance period key is computed.
Nothing else may derive one; if you find yourself slicing a date to get one, that is the
bug.

**A13-010, found by the Evidence and Completion Auditor.** Billing opened allowance rows
keyed `YYYY-MM-DD`. The scheduler settled them keyed `YYYY-MM`, and the customer usage view
read them the same way. The keys never matched, so `settleReservation` silently returned
false forever: reservations were never converted to consumption, `consumed` stayed at zero,
and **a workspace sitting at its limit reported itself unblocked**. Nothing raised and
nothing logged — a conditional `UPDATE` that matches no row is not an error.

Two entry points, which agree by construction:

| Function                                                               | For                                                       | Used by                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| `allowancePeriodKey(periodEndIso)`                                     | You hold provider evidence of the period end              | billing, opening the row              |
| `allowancePeriodKeyAt(atIso, currentPeriodEndIso)`                     | You hold an instant and need the period that contained it | the scheduler, settling and releasing |
| `resolveAllowancePeriodKey(source, {workspaceId, atIso, environment})` | You hold only a workspace and an instant                  | one call for the scheduler            |

`...At` returns exactly `allowancePeriodKey(end)` for any instant inside the current period,
and keeps working after a renewal: boundaries are computed by clamping the anchor day into
each month rather than by subtracting elapsed time, so a 31st anchor gives 31 Jan, 28 Feb,
31 Mar — never 3 March. That is how Stripe computes them too, and a drifting boundary would
silently move a customer's renewal date. A settle that happens after the subscription rolled
still finds the run's own period (`BILL-247`).

A period is half-open, `[start, end)`: `current_period_end` is the instant the _next_ period
begins, so a run at exactly that instant belongs to the next one (`BILL-251`). I asserted
the opposite when writing the test; the implementation was right and the assertion wrong.

`isAllowancePeriodKey` refuses a `YYYY-MM`, and the in-memory port throws on one rather than
returning a silent miss — a mismatch should be a crash in a test, not a `false` in
production.

### Why the key is the period end, and not the start

The allowance row is keyed by the UTC date the paid period **ends**, not the date it
starts. This is load-bearing. Two different events describe the same period —
`customer.subscription.*` carries `items.data[].current_period_end` and `invoice.paid`
carries its line item's `period.end` — and both give the end _exactly_. Neither carries a
start we can trust to agree: deriving one by stepping a month backwards lands on a 30- or
31-day boundary depending on the month, so the two sources would produce two different
keys for one period, `UNIQUE (workspace_id, billing_period)` would happily allow both rows,
and the workspace would hold 1,000 runs for one £29 payment. Keying on the end makes the
two sources agree by construction (`BILL-183`, `BILL-192`).

### The wider shape, audited

Anywhere two subsystems derive a shared key independently, this bug is possible. I checked
the three other shared keys in the system:

| Key                                        | Verdict                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refunds.idempotency_key`                  | **Safe.** Built once by `refundIdempotencyKey()`. `decideRefund` reads `refund.idempotencyKey` off the stored row rather than rebuilding it, so the value sent to Stripe is by construction the value stored. |
| `outbox.unique_event_key`                  | **Safe.** Built once per event type at enqueue; `dispatch.ts` reads `row.unique_event_key` rather than re-deriving it.                                                                                        |
| `notification_deliveries.notification_key` | **Safe.** Built once by A09's `notificationKey()`; `supportData.ts` stores and looks up by the stored value.                                                                                                  |

The generalisation worth keeping: all three are safe for the same reason — **the consumer
reads the stored key rather than re-deriving it from its own inputs.** The allowance period
key was the one case where the consumer re-derived it, from a different input, in a
different module. That is the shape to look for, not the string format.

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
_not_ stopped. It goes out on A09's `payment_problem` template, keyed so that Stripe's
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
end in the same place. Our stored state is _not_ written at the moment of cancellation —
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

| State              | What it means                                                            |
| ------------------ | ------------------------------------------------------------------------ |
| `requested`        | We have written the request down. Nothing has been decided.              |
| `queued_for_owner` | Waiting for the owner. Every request lands here.                         |
| `submitted`        | Sent to Stripe. No usable answer yet.                                    |
| `pending`          | Stripe accepted it and is still moving the money.                        |
| `succeeded`        | Stripe says the money went back. **Only this may be called "refunded".** |
| `failed`           | Stripe could not do it. The customer still has a claim.                  |
| `rejected`         | The owner declined.                                                      |

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

### How the owner queue is wired

A refund request lands in `queued_for_owner`. `listRefundQueue()` gives A07's panel each
waiting refund with the amount an approval must cover and a plain-language summary. The
owner grants an approval bound to `refundApprovalPayload(refund, rule)` — A07's real
`grantOwnerApproval`, hashing the canonical payload — and passes the granted approval back
to `decideRefund`.

**The payload is rebuilt from our stored row, never from the caller.** That is the whole
mechanism. `decideRefund` takes the approval _record_, not an approval id: an id alone
would only prove that some approval exists, whereas the record carries the hash of what the
owner actually read. We re-derive the payload from the refund on file, hash it, and compare.
A refund whose amount, order, workspace, reason or cited rule differs from the approved one
— by a penny or by a character — hashes differently and authorises nothing (`BILL-213`).
There is no argument a caller could pass to paper over the difference, because the amount is
not an argument.

Also refused: an approval granted for another workspace's refund (`BILL-215`), an expired
one (`BILL-216`), one whose status is no longer `granted` (`BILL-217`), and an approve
call that names no published policy rule (`BILL-218`). The rules themselves are a closed
set (`REFUND_POLICY_RULES`), not free text, so "which rule was applied" is answerable later
from the approval alone.

Declining needs no approval and sends nothing to Stripe (`BILL-219`).

**The approval is spent, and spent before the money moves (A-20).** An approval is a
single-use authorisation, so `decideRefund` requires a `consumeApproval` callback and calls
it **strictly before** the Stripe request. Consuming afterwards would leave a window in
which a crash between the two lets one approval authorise a second submission; consuming
first means the worst case is a spent approval and no refund, which is the direction to fail
in when the alternative is money out twice. `BILL-258` records the interleaving so a future
reordering fails there.

There is no default consumer: an absent one is a 422, not a silent skip (`BILL-257`). An
approval already spent on a different refund authorises nothing and no call is made
(`BILL-259`); a consume that returns false leaves the refund queued rather than
half-submitted (`BILL-260`). Re-consuming for the _same_ refund must succeed, otherwise the
documented retry after a transport failure could never complete — A07 owns that contract and
it is stated on the parameter.

**What still depends on a live key.** Everything up to and including the authorisation
decision is real and tested. The submission itself calls
`BillingGatewayPort.createRefund`, which is stubbed in every test — so A07's "issue refund"
button is real as far as the approval, the hash binding, the state machine and the
idempotency key, and stops at the provider call. It cannot be proven against Stripe until
the founder supplies a test key. That is a stated dependency, not a silent one.

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

| Fee                                                    | Rate                       | Source                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------- |
| UK standard domestic cards                             | **1.5% + 20p**             | https://stripe.com/gb/pricing         |
| UK premium cards (commercial/corporate)                | **2.8% + 20p**             | https://stripe.com/gb/pricing         |
| EEA cards                                              | **2.5% + 20p**             | https://stripe.com/gb/pricing         |
| International cards                                    | **3.15% + 20p**            | https://stripe.com/gb/pricing         |
| Currency conversion (EEA/international, when required) | **+2%**                    | https://stripe.com/gb/pricing         |
| Stripe Billing, pay-as-you-go                          | **0.7% of billing volume** | https://stripe.com/gb/billing/pricing |

Stripe Billing's paid tiers start at £450/month, which is nonsense at our volume — the
pay-as-you-go 0.7% is the correct line. There is **no free allowance** on Stripe Billing
volume (checked 2026-09-19 on the page above).

### Contribution margin on one £29 subscription

Arithmetic in pence, per successful monthly charge:

| Card type                       | Card fee                | Billing fee (0.7%) | Total fees | Net to us  | Margin    |
| ------------------------------- | ----------------------- | ------------------ | ---------- | ---------- | --------- |
| **UK standard (expected case)** | 43.5p + 20p = **63.5p** | 20.3p              | **83.8p**  | **£28.16** | **97.1%** |
| EEA                             | 72.5p + 20p = 92.5p     | 20.3p              | 112.8p     | £27.87     | 96.1%     |
| UK premium/commercial           | 81.2p + 20p = 101.2p    | 20.3p              | 121.5p     | £27.79     | 95.8%     |
| International                   | 91.35p + 20p = 111.35p  | 20.3p              | 131.65p    | £27.68     | 95.5%     |
| International + conversion      | 111.35p + 58p = 169.35p | 20.3p              | 189.65p    | £27.10     | 93.5%     |

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

| Operation                       | Endpoint                                                                                                       | Source                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Create a customer               | `POST /v1/customers`                                                                                           | https://docs.stripe.com/api/customers/create                |
| Create a Checkout Session       | `POST /v1/checkout/sessions`                                                                                   | https://docs.stripe.com/api/checkout/sessions/create        |
| Create a Billing Portal session | `POST /v1/billing_portal/sessions`                                                                             | https://docs.stripe.com/api/customer_portal/sessions/create |
| Retrieve a subscription         | `GET /v1/subscriptions/:id`                                                                                    | https://docs.stripe.com/api/subscriptions/object            |
| Cancel now                      | `DELETE /v1/subscriptions/:id`                                                                                 | https://docs.stripe.com/api/subscriptions/cancel            |
| Cancel at period end            | `POST /v1/subscriptions/:id` with `cancel_at_period_end=true`                                                  | https://docs.stripe.com/api/subscriptions/cancel            |
| Create a refund                 | `POST /v1/refunds`                                                                                             | https://docs.stripe.com/api/refunds/create                  |
| List events for reconciliation  | `GET /v1/events` (30 days, limit 1–100)                                                                        | https://docs.stripe.com/api/events/list                     |
| Create product / price          | `POST /v1/products`, `POST /v1/prices`                                                                         | https://docs.stripe.com/api/prices/create                   |
| Idempotency                     | `Idempotency-Key` header, ≤255 chars, 24h retention                                                            | https://docs.stripe.com/api/idempotent_requests             |
| Webhook signatures              | `Stripe-Signature: t=…,v1=…`, HMAC-SHA-256 over `${t}.${rawBody}`, ignore non-`v1` schemes, 5-minute tolerance | https://docs.stripe.com/webhooks                            |

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

Status codes: **400** for a bad signature, an unparseable body or a mode mismatch — never 200. **413** for an oversized body. **200** for duplicates and for ignored types. **500**
when our own handler throws, after **releasing the receipt** so Stripe's retry is a fresh
attempt rather than a deduplicated no-op (`BILL-132`). Without that release, one internal
error would permanently swallow a paid invoice behind the dedupe constraint.

### The opaque endpoint id is a gate, not decoration

The path carries an opaque id — `/api/v1/webhooks/stripe/:opaqueId` — so that a leaked or
guessed endpoint URL is not by itself a way in. Two independent conditions must hold, and
an id we did not issue is rejected **before any work is done on the event**:

- the opaque id resolves to an endpoint we issued, **and**
- the signature verifies under _that endpoint's_ secret.

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

### The receipt and the effect are not in one transaction — decided, not open

**Decision: keep claim-then-compensate. No port change.** Recorded here so it is not an
open question at the release gate.

The route claims the event id (`beginWebhookProcessing`), dispatches, then completes the
receipt; on a thrown handler it releases the claim (`abandonWebhookProcessing`) and returns
500 so Stripe's retry is a fresh attempt. That is not a transaction. D1's `batch()` is a
list of statements, not an interactive transaction, and every handler reads between writes
— deciding whether an event is stale requires reading the stored row first — so the work
cannot be wrapped in one. Restructuring into "read, decide, then one `batch()` carrying the
receipt insert and every write" is possible but would change the port's shape and push a
significant rewrite into A02's repositories for a gain the table below shows we do not
need.

**What makes it sufficient is that every handler is idempotent by construction.** Not
"probably safe to retry" — idempotent, for a stated reason, per handler:

| Handler                                         | Why a second execution changes nothing                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`                    | `rememberBillingCustomer` is insert-once and never rebinds; the order transition `active → active` is legal and terminal; the subscription write goes through `reconcileSubscription`, which returns `ignore_duplicate` for an identical snapshot |
| `customer.subscription.created/updated/deleted` | `reconcileSubscription` returns `ignore_duplicate` for an identical snapshot, `ignore_stale` for an older one, and `ignore_terminal` once cancelled                                                                                               |
| `invoice.paid`                                  | `openAllowancePeriod` is keyed by period end and refreshes terms, never counters — so a re-run cannot grant a second allowance or reset a used one (`BILL-191`)                                                                                   |
| `invoice.payment_failed`                        | the `past_due` write goes through the same guards; the order transition to `failed` is idempotent; the notification key is derived from the window, not the clock (`BILL-188`)                                                                    |
| `charge.refunded`                               | `applyProviderRefund` returns `no_change` when the transition would not move the state                                                                                                                                                            |

**The three windows, named.**

1. **Crash between the claim and the effect, release succeeds.** The claim is released, the
   retry is a fresh attempt, the effect happens once. Covered by `BILL-132`.
2. **Crash after the effect, while completing the receipt.** The route cannot distinguish
   this from case 1, so it releases the claim and the retry **re-executes the handler**.
   This is the case that surprised me when I tested it, and it is the reason the table
   above is load-bearing rather than decorative: nothing about the receipt protects us
   here, only the idempotency does. Proven by `BILL-241`, which asserts the counters rather
   than the `duplicate` flag.
3. **Crash between the claim and the effect, release also fails.** The genuinely bad one:
   the claim stands over an effect that never happened, and Stripe's retry is deduplicated
   away. Two things are true about it. The operator is told — the route logs
   `stripe_webhook_claim_stranded` with the event id, and swallows the release failure
   deliberately rather than re-throwing, because re-throwing would lose that line. And
   reconciliation finds the gap: a lost `invoice.paid` shows up as
   `allowance_period_missing`, a lost subscription event as `status_mismatch`. Proven end
   to end by `BILL-242`, which strands an event and then watches `reconcile.ts` report it.

**The one gap reconciliation does not cover** is a lost `charge.refunded`: the refund stays
at `submitted` and nothing sweeps for it. It is visible — a refund stuck in `submitted` sits
in the owner's view — but it is not automatically flagged. Closing it properly needs a
`listRefundsInState` method on `BillingDataPort` and a Stripe refund-list read in
`reconcile.ts`. Flagged for the lead rather than added unilaterally, since it is another
port change.

### Out-of-order events

Stripe states plainly that it "doesn't guarantee the delivery of events in the order that
they're generated" and that "distinct events can share a timestamp". Two independent
guards, both in `apps/app/src/billing/state.ts`:

1. **Monotonic** — `subscriptions.provider_event_created` holds the `created` of the event
   that last wrote the row. A smaller value is ignored (`BILL-016`, `BILL-121`).
2. **Terminal** — once stored `canceled`, no event moves it to another status. Guard 1
   alone would let a _same-second_ `customer.subscription.updated` re-enable a deleted
   subscription, because Stripe warns those timestamps can collide. Guard 2 closes it
   (`BILL-018`, `BILL-019`, `BILL-020`).

### Reconciliation

`reconcile.ts` compares each stored subscription against Stripe's own record and produces a
**typed list of discrepancies for the owner**. It reports, and repairs exactly one thing.

Reporting is the rule: a reconciliation that silently fixes state hides the webhook bug
that caused the drift, and for a cancelled subscription would be the resurrection the whole
design exists to prevent (`BILL-151`, `BILL-152`, `BILL-274`).

**The one exception is payment recovery**, because the founder's requirement 4 names two
ways verification may resume — a signature-verified webhook, _or_ a scheduled read against
Stripe's own records — and `PAYMENT_RECOVERY_POLICY.resumeRequires` promises the customer
exactly that. A reconciliation that could only detect would make that a published promise
with nothing behind it. So when we hold a payment-paused status and Stripe says the
subscription is served, we apply it (`BILL-271`). The repair is deliberately narrow:

- **One direction only.** `past_due`/`unpaid`/`paused` → `active`/`trialing`. Drift the
  other way is reported and never applied (`BILL-273`), because "Stripe says cancelled" is
  exactly where our own bug should stay visible.
- **Through the same guards.** It goes through `reconcileSubscription()`, so a cancelled
  subscription is never resurrected however Stripe answers (`BILL-274`).
- **Reported, not silent.** Every recovery appears in the report's `recovered` list; a state
  change made by a background job must be accountable to a person afterwards.
- **Dry-runnable.** `applyPaymentRecovery: false` reports without applying (`BILL-275`).

One subtlety worth knowing about: the recovery stamps `provider_event_created` with
`max(readTime, storedValue)`. The monotonic guard exists to stop out-of-order _events_
overwriting newer state; a direct read is not an event but a point-in-time query of current
truth, so letting a stale-event rule veto it is a category error. Without the `max`, clock
skew between Stripe's `created` and our own clock would make a workspace permanently
unrecoverable by reconciliation, silently. My own test caught this — and a neighbouring case
had been passing vacuously because it asserted counters without first asserting that the
recovery happened at all.

Discrepancy kinds: `status_mismatch`, `price_mismatch`, `period_end_mismatch`,
`cancel_at_period_end_mismatch`, `missing_at_provider`, `environment_mismatch`,
`allowance_period_missing`, `provider_unreadable`. Each carries plain language a person can
act on.

---

## 9. What runs it — the wiring

Correct logic with no caller is not a working feature. Everything below exists because an
audit found the payment-recovery logic fully tested and completely unreachable.

### The scheduler: one call per tick

A03's tick calls one function and does nothing else. The cadence lives here because it is a
money decision, not a scheduling one:

```ts
import { runBillingMaintenance, maintenanceNotifications } from './billing/scheduled.js';

const report = await runBillingMaintenance(billingRuntime);
for (const notification of maintenanceNotifications(report)) {
  await sendNotification(notification, notificationDeps);
}
```

| Job                             | Cadence                                       | Why                                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment-recovery expiry (day 8) | hourly, at minute `RECOVERY_SWEEP_MINUTE` (7) | The window is seven _days_. Running it every minute is 60× the scans for at most an hour's less latency on a boundary measured in days. Idempotent, so cadence only affects latency.                                         |
| Subscription reconciliation     | every `RECONCILE_EVERY_MINUTES` (15)          | One provider call per subscription, so it is the expensive one — but it is also the safety net for a missed webhook and the second route by which a payment resumes, so hours of latency would be felt by a paying customer. |

`runBillingMaintenance` **never throws**: a cron tick that throws takes every other job in
the same tick with it, so each job is isolated and its failure is reported in `failures`
(`BILL-279`). It returns notifications rather than sending them, so the scheduler keeps one
place where outbound mail happens (`BILL-280`).

### The admission gate: one call per event

`checkAdmission()` in `apps/app/src/billing/admission.ts` answers the whole money question
for an arriving event and returns a verdict the route acts on without knowing any billing
rules.

```ts
const verdict = await checkAdmission(billingRuntime, { workspaceId });
if (!verdict.admit) return c.json({ error: { code: verdict.refusal, message: verdict.customerMessage } }, verdict.httpStatus);
await sourceEvents.admitOnce(db, { ...params, billingPeriod: verdict.billingPeriod });
```

**It belongs at the events route, before `admitOnce` — not inside it.** Three reasons:

1. `admitOnce` answers a different question. Its conditional `UPDATE` is the atomic gate on
   the _allowance_, which is what stops two simultaneous events sharing the last unit.
   Entitlement is the prior question of whether we should be doing work for this workspace
   at all, and answering it inside the reservation would mean taking a unit from a workspace
   we have already decided not to serve.
2. The refusals differ and the customer needs to know which. "At your allowance" is a
   429 about this period; "your payment failed" is a 402 about the account (`BILL-263`,
   `BILL-266`).
3. `admitOnce` needs the period key as an argument, and `checkAdmission` returns it from
   `period.ts`. That is the other half of the A13-010 fix: the admission side can no longer
   derive its own spelling (`BILL-262`).

The gate reserves nothing (`BILL-270`). `admitOnce` may still refuse if the last unit went
to someone else in between; that race is correct — the gate is the policy answer, the
reservation is the arbiter.

Retries, provider callbacks and internal recovery are admitted **even while new work is
paused** (`BILL-265`). They belong to a unit already paid for, and refusing them would
strand work the customer was charged for.

### The pre-checkout page

A05's review-and-price page calls `preCheckoutPanel()` and renders:

- `panel.facts` as a definition list.
- `panel.sections` in order, respecting each `style` (`list` → bullets, `prose` →
  paragraphs). The ids are `allowance`, `payment-recovery`, `payment-recovery-pauses`,
  `payment-recovery-preserved`, `payment-recovery-after`, `cancellation`, `refunds`.
- `panel.mustBeVisible` **not** behind a disclosure control — the founder's requirement is
  that the policy is displayed, not discovered afterwards.

Nothing is retyped: the lines are the policy arrays by identity (`BILL-240`).

## 10. Turning it on

### Mounting the webhook route

Everything the composition root needs is in `apps/app/src/billing/mount.ts`, so `index.ts`
assembles nothing by hand:

```ts
import { createStripeWebhookDeps, assertBillingSecrets } from './billing/mount.js';
import { createStripeWebhookRoute } from './routes/webhooks/stripe.js';
import { D1BillingDataPort, createBillingContactLookup } from './db/index.js';
import { createStripeClient } from '@verify/connectors/stripe';   // see note below

// Mount BEFORE the public router, and before any body-parsing middleware: the route must
// read the raw bytes itself.
app.route(
  '/',
  createStripeWebhookRoute(
    createStripeWebhookDeps(env, {
      data: new D1BillingDataPort(env.DB),
      gateway: createStripeClient({ secretKey: env.STRIPE_SECRET_KEY ?? '' }),
      billingContact: createBillingContactLookup(env.DB),
      newId: (prefix) => newId(prefix),
    }),
  ),
);
```

`createStripeWebhookDeps` calls `assertBillingSecrets` itself, so a production or staging
deployment missing any billing secret **fails at construction** rather than serving a
money path that silently rejects everything. In development it builds and every delivery is
a 400, which is the right degraded behaviour for an unconfigured money path (`BILL-222`,
`BILL-223`).

Note on the import: A04's `packages/connectors/src/index.ts` does not re-export
`stripe.ts`, so the client comes from the subpath or from a one-line addition to that
barrel — A04's call. Nothing in `apps/app/src/billing/` imports it directly; the
orchestration codes against `BillingGatewayPort`, which `createStripeClient` satisfies
structurally.

### The five secrets

| Name                         | What it is                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`          | The API key. Test mode until the founder authorises live.          |
| `STRIPE_PRICE_ID`            | The £29/month GBP price, from the provisioning step below.         |
| `STRIPE_WEBHOOK_SECRET`      | The endpoint signing secret, `whsec_…`.                            |
| `STRIPE_WEBHOOK_PATH_ID`     | The opaque path segment we issue. Not public.                      |
| `STRIPE_WEBHOOK_UNKNOWN_KEY` | The stand-in key verification runs against for an unknown path id. |

The last one is not a credential — nothing is ever accepted under it — but it must be
per-deployment and unguessable, and it must be **present**. A stand-in key that silently
defaults to a compiled-in constant is exactly how SEC-431 reopens, so its absence is a hard
failure in production (`BILL-222`).

### Why `resolveEndpointSecret` does not read D1

Asked and answered in `mount.ts`, and worth stating here too. There is one endpoint per
deployment, so a lookup table with one row would add a database round trip to the hottest
untrusted path in the system — on every delivery, including every forged one, which is a
free amplification factor for anyone who wants to spend our D1 reads. There is no table for
it in the frozen schema, and adding one would put a signing key in a database row when the
Worker secret store is the right home for a value that never leaves the Worker. And the
opaque id is compared with `timingSafeEqual`; a SQLite lookup is not constant time and
leaks through timing what the id is not (`BILL-224`).

If a second endpoint ever exists — the real case is the dual-secret window during a roll —
the fix is to let the resolver return several candidate secrets, not to move it into the
database.

### Provisioning the product and price

`POST /api/v1/billing/provision-price`, owner-only, one command:

```sh
curl -X POST https://<host>/api/v1/billing/provision-price \
  -H "x-owner-bootstrap-token: $OWNER_BOOTSTRAP_TOKEN"
```

It is a Worker route rather than a local CLI on purpose. There is no TypeScript runner in
this repository — `node_modules/.bin` has `tsc`, `vitest`, `eslint`, `prettier` and
`wrangler`, and nothing that executes a `.ts` file — and adding one would be a new
dependency. Duplicating the Stripe calls into a plain `.mjs` would put money-touching code
in two places. Running it inside the Worker is better than either anyway: **the secret key
never leaves the Worker secret store**, never reaches a laptop, a shell history or a CI log.

What it guarantees:

- **No key, no call.** 422 naming the missing secret, nothing sent (`BILL-229`).
- **Live mode refused outright**, before the key is even read (`BILL-230`) — and refused
  again if the key itself is a live key while `STRIPE_MODE` claims test, which is the
  misconfiguration that would create real objects in the owner's live account
  (`BILL-231`).
- **Idempotent** on two layers: the price `lookup_key` search, and a deterministic
  `Idempotency-Key` with no time component. A second run creates nothing and returns the
  same price id (`BILL-233`).
- **Never prints the key.** The response carries the price id, the product id and the mode.
  `StripeError` has already scrubbed any key-shaped string from a provider message before
  it can be read back (`BILL-234`).
- **Owner-only, and does not confirm it exists** to anyone else: a missing or wrong token
  is a 404 byte-identical to the anonymous one (`BILL-235`).

The response includes the next step in one line: set `STRIPE_PRICE_ID` to the price id it
printed, then redeploy.

### What A05 renders before checkout

`preCheckoutPanel()` in `apps/app/src/billing/disclosure.ts` returns the finished content —
heading, formatted price, labelled facts, and headed sections with their lines — derived
from `PLAN` and `PAYMENT_RECOVERY_POLICY`. A05 maps it to markup and retypes nothing, so a
change to the policy cannot leave the page saying something the code no longer does
(`BILL-240`).

`panel.mustBeVisible` is the one sentence that may not be hidden behind a disclosure
control: the price, the allowance, the recovery window and that cancellation is always
available (`BILL-239`).

## 11. What is not proven

- **No call has ever been made to Stripe from this repository.** There is no key here, and
  a test-mode call would still create real objects in the owner's account. Every test
  injects a stub; `tests/setup.ts` fails loudly on any escaping `fetch`. The adapter is
  verified against the _documentation_, not against the live API.
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
  `v1` value in the header, so the _verifier_ handles the dual-secret case correctly. The
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

  **The fix, when someone picks it up**, is to have `resolveEndpointSecret` return a _list_
  of candidate secrets and try each. That needs no change to the verifier and no schema
  change. It was left undone rather than guessed at because it needs a decision about where
  the second secret is stored and how it expires.

- Dispute/chargeback fees are unverified (§7).
- **The refund submission has never reached Stripe.** The approval binding, the hash check,
  the state machine and the idempotency key are all real and tested; the final
  `POST /v1/refunds` is a stub. See §6.
- **The provisioning route has never run.** Its guards are tested against a stub gateway;
  whether Stripe behaves as documented for `lookup_key` reuse is a claim about the
  documentation, not an observation.
- **Nothing is mounted yet.** `apps/app/src/index.ts` does not route the webhook or the
  provisioning endpoint. Mounting is the lead's, and the moment to confirm
  `STRIPE_WEBHOOK_UNKNOWN_KEY` is provisioned in both environments.
- **Three wirings are specified but not yet connected**, and until they are, the feature
  they enable is not working however well it is tested:
  - `runBillingMaintenance()` needs a call from A03's tick, or day 8 never arrives and
    reconciliation never resumes anyone (§9).
  - `checkAdmission()` needs a call from the events route, or a failed payment pauses
    nothing (§9).
  - `preCheckoutPanel()` needs a call from A05's review-and-price page, or the policy is
    discovered after payment rather than displayed before it (§9).
- **A13-010 is not closed.** `period.ts` is the single key function, but two call sites still
  use the old calendar-month one — `scheduler/observe.ts:502` (A03) and
  `db/customerPort.ts:641` (A02). Until both call `period.ts`, allowances still never settle
  and a workspace at its limit still reports itself clear.
