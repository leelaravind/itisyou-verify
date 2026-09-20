# Independent completion audit — pass 5

**Audit pass 5 · 20 September 2026.** Earlier passes: `docs/audit-summary.md` (1–3),
`docs/audit-pass-2.md`, `-3.md`, `-4.md`.

## The commit, and the freeze

Measured against **`00575a5`**, clean and equal to `origin/main` at the start.

**The freeze was broken during this pass.** You said you would not commit again until I
reported. While I was writing up, HEAD moved to **`e79e91b`** ("The campaign, specified
exactly, and what blocks it", +107 lines to `docs/advertising.md`). Stating it because I was
asked to. It changes no code, no test, no migration, so **no measurement below is
invalidated** — every code fact was taken against a tree byte-identical to `e79e91b` outside
`docs/`. But three passes have now asked for a still tree and two have not got one.

**The documentation-only claim checks out:** `b4cf8da` touches one line of
`docs/test-cases.json`; `00575a5` touches three files under `docs/`. Neither touches `apps/`,
`packages/`, `migrations/` or `tests/`. So production at `b4cf8da` carries all of `a374d97`'s
code — and I confirmed that behaviourally (see G2).

---

## Verdicts

| Item | Verdict |
| --- | --- |
| **G1** core — the refund reaches Stripe | **CLOSED**, proven by me |
| G1 Q1 — can a refusal still leave an orphan row? | **YES, IT STILL CAN** — claim overstated |
| G1 Q2 — can a refund be aimed at another period's payment? | **YES** — the guard the migration describes does not exist |
| G1 Q3 — is `recordPaymentTarget` scoping sound? | **SOUND** |
| **G2** — `send_failed` distinct from `no_transport` | **CLOSED**, verified on production |
| **D** — both ports use their own clock and id factory | **CLOSED for the ports**; "no third spelling anywhere" is **FALSE** |
| **C** — `policy_rule` validated at grant | **CLOSED** |
| **OWNER-370** — restored | **SUBSTANTIALLY RESTORED**, one step short of the stated property |
| Citations BILL-259 / BILL-213 | **BOTH CORRECT** this time |
| `fetchImpl` absent in production, unsettable from a request | **CONFIRMED** |
| BILL-400/401 fail against the unfixed port | **CONFIRMED**; the claim about their *first* version is **unverifiable** |
| Anything reopened from passes 1–4 | **Nothing** |
| **H1** (new) | **The customer cannot sign in at all, and is told a false reason** |

---

## G1 — the refund control. Core closed; two of your three questions answer badly.

I wrote my own tests against the real `D1OwnerDataPort` with a stubbed transport, outside the
repository.

**It works now.** This is the case your own test file does not contain:

```
P5-1 ok=true
P5-1 stripe calls=1 url=https://api.stripe.com/v1/refunds
P5-1 body=amount=4900&payment_intent=pi_latest&metadata[workspace_id]=ws_alpha&…
P5-1 approval=consumed consumed_at=2026-09-19T12:00:00.000Z
P5-1 refunds=[{"state":"succeeded","provider_refund_id":"re_test_1"}]
```

One provider call, the right payment intent, the approval consumed exactly once — at the
**injected** instant, which also confirms D's clock fix. G1's core is genuinely closed.

**Q1 — a refusal can still leave an orphan row.** Only the no-target refusal moved ahead of
`requestRefund`. An approval-hash mismatch — an ordinary case, not an exotic one — still
creates the row first and fails afterwards:

```
P5-3 ok=false message=No refund was submitted. REFUND_APPROVAL_INVALID: …
P5-3 refunds left behind=[{"state":"queued_for_owner"}]
P5-3 stripe calls=0
```

The commit message says *"a refusal no longer leaves a row behind."* **Overstated** — that
refusal does not; others still do.

**Q2 — yes, a refund can be aimed at a payment for a different period.** An order created
2026-07-01, refunded against the payment for the period ending 2026-10-19:

```
P5-2 ok=true
P5-2 stripe body=amount=4900&payment_intent=pi_latest&…
```

`latest_payment_period_end` is written by the webhook, typed through `port.ts`, carried
forward on snapshot writes — and **read by nothing**. `issueRefund` reads only
`latestPaymentIntentId`. The only non-test references are pass-through.

Migration `0007` says the column exists *"so a refund cannot be aimed at a payment for a
different period by accident"* and *"it is why `issueRefund` refuses rather than guessing when
the order it was asked to refund is not the one this payment covers."* **There is no such
refusal.** The migration documents a guard that was not implemented. With one plan price, an
owner refunding July's order moves October's money, and the amounts match so Stripe accepts
it.

**Q3 — the scoping is sound.** `workspaceId` in `handleInvoicePaid` comes from our own
records — `stored?.workspaceId`, else `findWorkspaceForBillingCustomer` — never from the
webhook payload (`events.ts:320-328`). The UPDATE requires `workspace_id` **and**
`provider_subscription_id` **and** `environment` to agree (`commerce.ts:275-288`), so a
mismatch updates zero rows. Fails closed. No cross-tenant write.

**One more thing about the new test file.** Its header declares *"Case ids `BILL-400..BILL-403`"*.
`BILL-403` does not exist — not as a test, not as a ledger row. A dangling citation, in the
commit that fixed a citation problem. And there is still **no success-path case**: nothing in
the suite drives a refund through to a provider call. The capability I proved above is proved
by my test, not yours.

---

## G2 — closed, and verified on the deployed build

Three outcomes, correctly derived (`ownerPort.ts:2734-2744`): `sent` when `report.sent > 0`,
otherwise `send_failed` if `#hasEmailTransport()` — which checks **both** `RESEND_API_KEY` and
`RESEND_FROM_ADDRESS` — else `no_transport`. That is the explicit configuration check the
previous version lacked.

On production, which has both secrets:

```
$ curl -X POST https://verify.itisyou.app/admin/login -d "email=…@example.invalid"
status=200
No sign-in link was sent. We tried and the attempt failed, so nothing arrived. Please try
again in a moment. We do not say whether an account exists, to anyone, ever.
```

The right sentence. All three variants keep the no-enumeration clause, and the outcome varies
only with deployment capability — a rate-limited request still reports `sent`
(`ownerPort.ts:2707`), so probing reveals nothing. **Correct.**

*Nit:* a malformed address returns `no_transport` (`ownerPort.ts:2697`), which would render
"no email delivery configured" for what is actually a bad input. Unreachable from the route,
which regex-gates first. Worth tidying, not worth blocking.

---

## D — closed for the ports; the sweeping half of the claim is false

Both builders now agree: `ownerPort.ts:673-674` uses `this.#now.toISOString()` and
`newId(prefix, this.#now.getTime())`, matching `customerPort.ts:887-888`. P5-1's
`consumed_at=2026-09-19T12:00:00.000Z` is that fix observed rather than read.

But **"no third spelling exists anywhere" is false.** There are four `createBillingRuntime`
call sites, not two. `apps/app/src/scheduler/tick.ts:533-538` builds one with
`now: () => toIso(now)` — injected — and `newId: (prefix: string) => newId(prefix)`, which
defaults to `Date.now()` (`lib/ids.ts:79`). Injected clock, wall-clock id factory: the same
divergence, in a fourth builder. (`notifications/billingTick.ts:116` gets it right.)

Low severity — the timestamp in an id is cosmetic — but you asked for *anywhere*.

---

## C — closed

`grantApproval` now validates before hashing (`ownerPort.ts`, the `refund_issue` branch):
`typeof rule !== 'string' || !isRefundPolicyRule(rule)` → refuse. It sits ahead of the id,
timestamps and hash computation. There is exactly one writer of `approvals` rows in the
application (`ownerPort.ts:1599`), so there is no second path. **No remaining path to a hashed
approval carrying an unpublished rule.**

---

## OWNER-370 — judged as hard as the first time. Better, and still one step short.

The new case grants through the real route, reads `canonical_payload_hash` from the row, and
asserts it equals `ownerPayloadHash({action_type:'refund_issue', payload: REFUND_PAYLOAD})`.
`claimApproval` computes its comparison with that same function (`owner/approvals.ts:308`), so
this is the right function, not a lookalike. It would catch the historical regression — grant
storing `hashToken(payloadJson)` while consume computed a canonical hash — which is the defect
the case exists for. **This is a real test of a real property, and not the move I called out
last time.**

Where it stops short: it recomputes from `REFUND_PAYLOAD`, the same constant it posted. It
proves *the grant side is canonical*. It does not prove that `issueRefund`'s own payload
construction (`ownerPort.ts:750-760`) produces the same object — a dropped `reason`, a
different currency literal, a changed key set would diverge and this test would still pass.
The title claims the whole property ("an approval granted in the panel is one the action can
actually consume"); the assertion covers the half that regressed.

The full property **is** true today — my P5-1 drove grant to consumption and the approval
came back `consumed`. So: restored in substance, over-titled by a step. Not a green-seeking
rewrite.

**Citations — both right this time.** BILL-259 does assert the property OWNER-368 carried
(same approval, second refund, `/already been used/`, no new `createRefund`). BILL-213 exists
and asserts *"an approval for an amount one penny different authorises nothing"*, which is
exactly what OWNER-369 was asserting vacuously — and OWNER-369 is now explicitly labelled
vacuous (`live-engines.test.ts:653-661`). Checked, not taken.

---

## The remaining checks

**`fetchImpl` — safe.** The only production construction is `createOwnerDataPort`
(`ownerPort.ts:2829`), which builds the port from `{env, req.raw}` and an optional `now`, and
never passes `fetchImpl`. No request-controlled path reaches it.

**BILL-400/401 against the unfixed port — confirmed, from my own pass-4 measurement.** Against
`ca9d062`'s predecessor I recorded the old port returning *"No refund was submitted.
REFUND_TARGET_REQUIRED: …"* and leaving one `queued_for_owner` row. BILL-400 requires the
message to match `/payment to refund against/i` and both cases require zero refund rows, so
both fail against the old behaviour on at least two assertions each. **The claim that your
*first* version of them did not fail is unverifiable** — that version was never committed. I
record it as your account, not as a finding.

**Nothing reopened.** Correlation (`resendWebhookPort.ts`) untouched. `tsc --noEmit` exit 0,
no output; `eslint --max-warnings=0` exit 0, no output; `verify-test-cases.mjs --strict --gate`
exit 0, `Ledger integrity: PASS`. Full suite run by me: **2,608 tests, 2,605 passed, 0 failed,
3 skipped** — matching your commit message exactly. Ledger: **2,536** countable-and-passing,
**zero** not backed by a recorded pass, five new rows (`AUTH-434`, `AUTH-480`, `BILL-400/401/402`)
all `implemented` and non-countable, and **no status changed on any existing row**.
`snapshot_commit` now reads `a374d97` and the test tree has not changed since, so for the first
time in four passes **it names a commit whose tree it describes.**

---

## H1 — new, and it decides the advertising question

**A customer cannot sign in. There is no path.**

`customerPort.requestSignInLink` (`customerPort.ts:292-302`) is still an unconditional
refusal:

> *"No sign-in link was sent. Email delivery is not connected in this environment yet, so
> nothing would arrive and we will not pretend otherwise."*

Production has `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`. **That sentence is false on the
deployed service** — the sixth instance of the class you removed five of, and the one the
owner-side fix did not reach. The owner path got a real transport, three honest outcomes and a
test; the customer path, which is the one a paying customer uses, was left as it was.

And it is worse than a wrong sentence: **no token is minted, and no customer completion route
exists anywhere.** The only routes under `/app` are `GET /sign-in`, `POST /sign-in` and
`POST /sign-out`; `/admin/login/complete` is the owner's and has no customer counterpart. So
the journey is a dead end by construction, not by configuration.

Observed on production: `/` 200 → its call to action is `href="/app"` → `/app` 401 rendering
the sign-in page → submitting returns 422 with the false reason.

---

## RELEASE VERDICT

**The public website: live, accurate on the pages that matter, safe to use.**

**Taking payment: still BLOCKED**, and the list is now short and specific.

1. **H1 — wire customer sign-in, or stop offering it.** No customer can reach the product, and
   the refusal states a false reason. This outranks everything else: checkout being wired
   (pass 4) buys nothing while nobody can get to it.
2. **G1 Q2 — implement the period guard, or delete the column and the migration comment that
   promises it.** A refund aimed at the wrong period is money out against the wrong payment.
3. **G1 Q1 — move `requestRefund` after the approval check**, so no refusal leaves a row the
   owner cannot action.
4. **Add the success-path test** your own file is missing, and delete or write `BILL-403`.
5. Minor: the scheduler's fourth runtime builder (`tick.ts:537`); the malformed-address
   `no_transport`; OWNER-370's title.

---

## ADVERTISING VERDICT

**No. Not today.** Two specific things, both narrow, both fixable in under an hour.

I want to be fair about what is already right, because it is most of it. `/demo` and
`/pricing` both carry, prominently:

> *"Not yet accepting live verification traffic: we are not taking payment or activating
> workspaces while the endpoint that receives your automation's signed events is not live."*

That is the disclosure that defuses almost all of this risk. A visitor is told before they
invest anything that the service is not taking money and not activating accounts. The proposed
landing page needs no account and no email, as claimed. The campaign construction — exact
match, presence-only, manual CPC, total budget, no remarketing tag — is careful and I have no
quarrel with it.

**What blocks it:**

1. **The headline "Reads HubSpot and Resend directly" is not supported for HubSpot.** Your own
   records say so: `docs/deployed-evidence.md:108` — *"Credential stored and validated against
   portal 149371406 — no live readback demonstrated"*; `:116` — *"HubSpot record readback is
   **unproven** against a real portal"*; `docs/gap-register.md:343` likewise. Resend is proven
   (pass 2 verified a real `provider_readback`). HubSpot is not. An advert headline carries no
   notice with it, so this would be an unqualified capability claim that the project's own gap
   register marks unproven. Drop HubSpot from that headline, or prove the readback first.
2. **`/demo` — the proposed landing page — is the one public page that omits the provider
   proof notice.** `/` and `/how-it-works` both render *"never been run against a real HubSpot
   or Resend account — every connector test so far runs against stubs built from published
   provider documentation."* I fetched `/demo`: it is absent. So the campaign would buy paid
   traffic to the single page that drops the disclosure the project added to keep exactly this
   claim honest.

**Not blocking, but fix while you are there:** H1's false sign-in reason is reachable in two
clicks from `/demo` (`/app` is linked from it). The visitor has already been told you are not
activating workspaces, so they are not being misled into buying — but they are being given a
false reason, on a page a paid click can reach.

**One correction in your favour.** That honesty banner says the events endpoint *"is not
live."* It is live: `POST /api/v1/events` on production answers **401 SIGNATURE_INVALID** to an
unsigned request, correctly. And the provider proof notice says connectors have never run
against a real HubSpot **or Resend** account — Resend has, on staging, with
`origin: provider_readback`. Both statements understate the product. Harmless to a visitor and
the safe direction to be wrong in, but two public pages currently claim less than is true.

**Fix those two and the answer becomes yes** — put the provider notice on `/demo`, and make the
headline claim only what is demonstrated. Nothing else in this pass stands between a paid click
and an honest page.

---

*Pass 5 was measured against `00575a5b71cd3463ce7b56ed12ef8d9dbd888a09` (HEAD moved to
`e79e91b`, documentation only, during write-up); the production Worker, its configured secrets
and its public pages; and adversarial tests written by the auditor and run against the real
ports from outside the repository.*
