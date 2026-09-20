# Independent completion audit — pass 7

**Audit pass 7 · 20 September 2026.** Earlier passes: `docs/audit-summary.md` (1–3),
`docs/audit-pass-2.md` … `-6.md`.

## The tree, which would not hold still

It moved three times while I was auditing it. That is worth recording precisely, because
what I was asked to verify was described to me as finished, and it was not finished when
it was described that way.

```
at the start        de608aa  == origin/main, clean
+2 min              44f410c  "One fact had three copies, and two of them were false"   (S1)
+9 min              7fff1ee  "The button a customer presses to buy the thing"          (S2)
+20 min             0fa4a4b  "Pressing the button found a 500 the tests could not"
origin/main         de608aa  — unchanged throughout
```

So at the moment I was told both blockers were closed, S2 existed only as uncommitted
working-tree edits, and the fourth commit exists because the implementer pressed the new
button on a deployment and it answered **500**. I take the last one as a good sign about
process and a bad one about the claim: "closed" was said before the button had been pressed.

**Everything below is measured against `0fa4a4b`, the tree as it stands now**, except where
I name an earlier commit deliberately.

---

## Verdicts

| Item | Verdict |
| --- | --- |
| S1 — the false sentence, in the source | **CLOSED.** Three copies, all three now true. I found no fourth in shipped code. |
| S1 — the false sentence, **for a live visitor** | **OPEN. Production still serves it.** Verified by fetch, not by diff. |
| S1 — two further stale copies, in spec and ledger | **NEW — S3.** `product-scope.md` still specifies the false notice; `CUST-124`'s ledger record still asserts it. |
| S2 — a reachable, submittable control | **CLOSED, and I proved it by pressing it.** |
| S2 — the control's condition vs. `createCheckout`'s | Agree on `ready`, which is necessary and **not sufficient** — that is what produced the 500. |
| S2 — what happens when Stripe refuses | **NEW — S4. A bare 500, with no statement that no card was charged.** The careful refusal wording is unreachable for the likeliest failures. |
| S2 — the sandbox disclosure | Renders, before the form, and is true. Minor wart: it also renders when there is nothing to continue to. |
| The five new tests | Three genuinely falsify. Two pass with the button gone. Not the OWNER-370 pattern. |
| **Typecheck** | **NEW — S5. `pnpm typecheck` has failed for the whole of the S2 work and still fails.** |
| The secret-scanner allowlist | **Right call.** I turned the pin off and checked what it was hiding. |
| Money path, correlation, sign-in | **Not broken.** Suite green; production re-probed. |

---

## S1 — true in the source, still false on the website

The three-copy claim checks out, with one correction: `site.ts` was already correct before
this pass (it was fixed in `d477586`). `44f410c` touched `activation.ts` and `faq.ts` only.
Three copies existed; two of them were false at once; both are now true. The wording is
fine — I checked it as a claim, not as a diff:

- *"no purchase has been completed end to end on a live deployment"* — **true**, and more
  pointedly true than the implementer knew when writing it: the one attempt on staging
  returned 500.
- *"a HubSpot record has never been read back from a real portal"* — **true**, unchanged
  from pass 6.

I swept the whole repository for every remaining copy of the stale claim. In shipped code
there are **none**. The string survives only in my own earlier reports, in
`docs/product-scope.md`, and in one ledger record — the last two are S3 below.

**But the fix is not deployed.** `origin/main` is still `de608aa`. Fetched just now:

```
https://verify.itisyou.app/pricing
  <p class="unavailable__reason">We are not taking payment or activating new workspaces
  while the endpoint that receives your automation's signed events is not live. …

https://verify-itisyou-staging.kpleelaaravind.workers.dev/pricing
  <p class="unavailable__reason">We are not taking payment or activating new workspaces
  yet: no purchase has been completed end to end on a live deployment, and a HubSpot
  record has never been read back from a real portal. …
```

Staging tells the truth. **Production tells the visitor the same false sentence it told
them in pass 6.** That page is one click from `/demo`, which is the advert's landing page.
S1 was a blocker on *advertising*, and advertising is judged on what a visitor reads, not
on what is in a branch. A fix that exists only locally has closed nothing for anyone.

---

## S2 — I reached checkout. It works, and then it does not.

I did not read the diff for this. I wrote probes.

**Is the form actually reachable by a person clicking?** Pass 6's finding was "correct code
reached by nothing", so existence is not the question; reachability is. I walked the app
breadth-first from `/app` as a signed-in customer with a ready order, following only anchors
and form actions a browser could activate:

```
200 /app          200 /app/onboarding/activation      200 /app/onboarding/proof
200 /app/cancel   200 /app/onboarding/compatibility   200 /app/onboarding/review   <-
200 /app/connections  /app/onboarding/connect         200 /app/runs
200 /app/usage        /app/onboarding/mapping         200 /app/support
                      /app/onboarding/outcome

form actions reachable: /app/onboarding/checkout  <-  and six others
```

**Reachable.** And with the order not ready, the same walk still reaches the review page and
finds **no** checkout action. The condition works in both directions.

**Does submitting it work?** Their tests assert a form exists and that it contains a field
*named* `csrf_token`. Neither asserts that posting exactly what the page rendered is
accepted — a form carrying a wrong token would pass both. So I harvested the real rendered
form, its real token value and the cookies the GET set, posted precisely that, and stubbed
the network at the boundary so nothing left the machine:

```
P1 review status 200, jar verify_session=<v>; __Host-verify_csrf=<v>
P1 harvested form {"action":"/app/onboarding/checkout","fields":[["csrf_token","Cunv…"]]}
P1 POST status 303  location https://checkout.stripe.com/c/pay/cs_test_auditor
P1 outbound calls ["https://api.stripe.com/v1/customers",
                   "https://api.stripe.com/v1/checkout/sessions"]
```

**A customer can buy.** Two real Stripe calls, a 303 to a hosted checkout page. That is the
first time in seven passes I have been able to write that sentence, and I am not going to
undercut it. My own pass-4 overstatement is now retired: it is no longer an overstatement.

**Can the two conditions disagree?** The page renders on `order.ready`; `createCheckout`
refuses on `!summary.ready`; both read the same `orderSummary()`. On that value they cannot
disagree. But `ready` is **necessary, not sufficient** — `startCheckout` has its own refusal
paths and its own throws, and the page knows nothing about them. That is not theory: it is
exactly how the staging 500 happened. `orderSummary` checked that `STRIPE_SECRET_KEY` was
non-empty, staging held a malformed value, and the page offered a purchase in front of a
call that could never succeed.

### S4 — NEW. The fix is one cause deep, and the general case still 500s.

`0fa4a4b` adds `secretKeyIsUsable()` and blocks on a malformed key. That is a correct fix
for that cause, and the predicate is the exact negation of the one
`environmentForSecretKey` throws on, so those two agree by construction. Good.

It covers one cause. I asked what a customer meets for the others, with a well-formed key
and a Stripe that refuses:

| Probe | What Stripe did | What the customer got |
| --- | --- | --- |
| P7 | 401 — revoked or wrong key | **500** "We could not load this page" |
| P8 | 400 — no such price (`STRIPE_PRICE_ID` typo) | **500** "We could not load this page" |
| P9 | network failure | **500** "We could not load this page" |

All three after the customer has pressed **Continue to secure checkout**. `createCheckout`
awaits `startCheckout` with no `catch`, so a `StripeError` or `AppError` goes straight past
the route into the generic error page.

This matters more here than it would elsewhere. The sentence
*"No checkout session was created and no card was charged"* exists, is well-judged, and was
written for precisely this moment — and it is **unreachable** for the three likeliest ways
checkout fails in production. A person who has just pressed a buy button and been shown a
blank 500 does not know whether they have been charged. That is the product's own defect
class, at its own worst moment: a false impression created at a success-shaped boundary.

`STRIPE_PRICE_ID` is the near neighbour of the bug just fixed — non-empty is checked, shape
is not. The lesson of the 500 was not "validate the key"; it was "the page must not offer
what the server cannot deliver."

### The sandbox disclosure

Real, and correctly placed. `STRIPE_MODE` is `test` in all three environments in
`wrangler.jsonc`, so the notice is true everywhere it renders.

```
P2 sandboxAt 35387  formAt 36552        -> the notice precedes the control
P2 "No card is charged": true
P3 STRIPE_MODE=live -> notice absent, button present
```

One wart: it renders on `order.paymentsMode` alone, so a customer who *cannot* buy is still
told *"Continuing hands you to a Stripe test checkout"* when there is no Continue.

```
P4 form present: false
P4 sandbox notice present: true
P4 reason shown: Connect HubSpot so we can read the CRM record.
```

Harmless, but it is a sentence about an action that is not on the page.

---

## Are the new tests green-seeking? I removed the form and watched.

I restored the previous control by hand and ran the file, rather than reasoning about it:

```
× CUST-478  a ready order renders a form aimed at the checkout route
× CUST-479  that form carries a submit control and a CSRF field
× CONN-478  the control leaves when a connection does
✓ CUST-480  an unconfigured deployment offers nothing
✓ CUST-481  a sandbox deployment says so before the customer is handed to Stripe
```

**Three genuinely falsify.** `CUST-480` passes with the button gone, which the implementer
states plainly and which is the point of it. `CUST-481` also passes with the button gone —
its title says *"before the customer is handed to Stripe"* and it asserts only that two
strings appear somewhere on the page, which stays true when there is no way to be handed to
Stripe at all. The implementer's "four of five fail against the previous page" is
accurate — `CUST-481` fails there because the callout is new, not because it guards the
control. The title over-claims by a little; the case is not dishonest.

**This is not OWNER-370.** No assertion was weakened, nothing was renamed to survive, and
`checkoutForm()` deliberately matches the form element rather than the path as a substring —
which is the right call, since the path does appear in prose on that page. `BILL-616` is the
paired case that stops `BILL-615`'s guard being satisfied by blocking everything. The
testing instinct here is sound.

---

## S5 — NEW. `pnpm typecheck` has been red for the whole of this work.

```
apps/app/src/routes/app/syntheticPort.ts(554,5): error TS2741:
  Property 'paymentsMode' is missing in type '{ planName … ready: boolean; }'
  but required in type 'OrderSummaryView'.
```

Still failing at `0fa4a4b`. Present since `7fff1ee`, whose message reads *"Suite: 2,617
passed, 0 failed… Claims clean."* The suite is green and the typecheck is not, and the
commit reports the half that was green.

Read what the error is. `7fff1ee` added `paymentsMode` to `OrderSummaryView` and to
`D1CustomerDataPort`, and did not add it to `SyntheticCustomerDataPort`. **One fact, two
implementations, one of them not updated** — which is, to the word, the defect the
immediately preceding commit was written to fix, and whose own message says *"two constants
is not an implementation of it."* The type system caught it on the spot. Nobody ran it.

The runtime consequence is small: `paymentsMode` is `undefined` on the synthetic port, so
the sandbox callout renders on `/demo`, where it is harmless. The process consequence is
not small. `scripts/release.mjs` runs `pnpm typecheck` as its **first** gate and throws
`release gate failed at: typecheck`, so `release:staging` and `release:production` both
refuse this tree. Yet the button reached staging and was pressed there. It got there by
`wrangler deploy --env staging`, which runs no gate at all — and that is the same shape as
every other finding in this project: a control that exists, is correct, and was gone around.

One more thing I checked while I was in there: CI's `gate` job, which produces the
`release-gate-<sha>` artefact that `release.mjs` demands for production, carries no
`needs: verify`. An artefact can therefore be minted at a SHA whose typecheck, lint and
secret scan failed. Production is still protected, because `release.mjs` re-runs typecheck
locally — but the artefact is not the evidence its name implies.

---

## S3 — NEW. Two more copies of the same fact, in the two documents that define it.

S1 was "one fact, three copies, two stale". Having found three, I looked for the rest.

**`docs/product-scope.md:409`** still carries the notice as a **specification**, in the old
words, with `A05: render this on /, /pricing, and the entry point of the onboarding flow`
underneath it:

> *"…the endpoint that receives your automation's signed events is **not live yet**, a
> completed Resend connection **cannot yet reach "ready"**, and the checks that pause
> verification at your plan allowance … **do not yet run automatically**."*

All three of those clauses are now false, and this is the document that tells the next
implementer what the page must say. It is not visitor-facing (`/product-scope.md` is 404),
so it is not an advertising defect. It is the copy that regenerates the other three.

**`docs/test-cases.json`, `CUST-124`**, marked `"status": "passing"`, records:

```
"expected": "expect(body).toContain('signed events is not live yet');
             expect(body).toContain('cannot yet reach \"ready\"');
             expect(body).toContain('do not yet run automatically'); …"
```

The test in the tree asserts the opposite, and says why it changed, in a good comment. The
**ledger record of it does not**. So the artefact this project offers as proof of what is
proven describes a test asserting a sentence the product no longer makes and that is no
longer true. `verify-test-cases.mjs` reconciles **case ids**, not `expected` text, which is
why "Ledger integrity: PASS" sits happily on top of it. (Its `implementation_ref` is also
stale — it points at line 89, the test is at line 98. That is endemic rather than
particular: 1,694 of 2,656 refs point at a line not containing their own id. Cosmetic, but
it means the field cannot be relied on to find anything.)

I did not catch either of these in pass 6, when I had the same evidence in front of me.
That is my miss, and I am recording it as mine.

---

## Nothing else broke

- **Full suite, run by me at `7fff1ee` with my four probes added: 2,621 passed, 0 failed,
  3 skipped.** The implementer's 2,617 is the same number without mine.
- **Ledger gate** at `0fa4a4b`: `Ledger integrity: PASS`, 0 reconciliation defects. (It was
  red mid-flight on `BILL-615`/`BILL-616`; that closed when the commit landed.)
- **`eslint --max-warnings=0`**: clean. The only warnings in my run were from my own probe
  files, which I have deleted.
- **Sign-in, on production, re-probed**: empty, unknown and hex-shaped tokens all `401`. No
  regression from pass 6's byte-identical result.
- **`POST /api/v1/events` unsigned, on production**: `401`. Still live, still refusing.
- **The money path**: untouched by these four commits. `customerPort.ts` gained a blocker
  and a field; nothing in refunds, the period guard or the orphan-row guard moved.

---

## The secret scanner: right call, and I checked rather than accepted it

My pass-6 report was swept into a commit with `git add -A` and its four synthetic sign-in
probe strings tripped `assigned-secret-literal`. The response was to mark the two lines in
the tree copy and pin the committed blob `f8445a7d…` in `ALLOWED_HISTORY_BLOBS`.

I turned the pin off to see what it was covering:

```
scan:secrets — 2 potential secret(s) found. DO NOT PUSH.
  history:docs/audit-pass-6.md@f8445a7d:69  [assigned-secret-literal]  token=***f' (40 chars)
  history:docs/audit-pass-6.md@f8445a7d:70  [assigned-secret-literal]  token=***f' (42 chars)
```

**Exactly my two lines, and nothing else.** The mechanism is a full content SHA, so it
cannot silently widen: change one byte of that blob and the pin stops matching. The tree
scan is still clean with only those two lines marked, `SEC-632` still walks all history and
asserts it actually read something, and `SEC-633` still fails the build on a *new*
credential-shaped fixture — which is the thing that stops an allowlist becoming a slow way
of turning a control off. The alternative was rewriting public history or deleting the
history step from CI, both worse.

**This is not a control being quietly turned off.** It was recorded loudly, in the file and
in the commit message, with the cause stated as the implementer's own.

Two caveats, neither fatal. The list has gone from six entries to nine in a short span, and
"pin it with a good reason" is a habit that degrades gracefully right up until it doesn't;
it wants a ceiling. And the implementer **edited my report** to add the markers. I diffed
the tree copy against the committed blob: the only change is two trailing comments on lines
69 and 70, and no finding, number or sentence of mine was altered. I am satisfied — but an
auditor's record being edited by the audited party should be asked for, not done and
mentioned afterwards.

---

## RELEASE VERDICT

**Taking payment: BLOCKED — but for the first time the blockers are about shipping rather
than about whether the thing exists.**

A customer can now buy. I proved it myself, from the rendered page through a real form post
to a Stripe redirect. That is the single largest thing to happen in seven passes, and the
implementer found their own worst remaining bug the right way — by pressing the button on a
deployment instead of asking a test whether the button would work.

What blocks a paid release:

1. **S5 — the tree does not typecheck**, and has not for the whole of this work. Fix
   `syntheticPort.orderSummary`. Until then `release.mjs` refuses, correctly, and anything
   on a deployment got there around the gate.
2. **S4 — a 500 is not an acceptable answer to a buy button.** Catch what `startCheckout`
   throws and return the refusal wording that already exists and already says the one thing
   the customer needs to hear. Validate `STRIPE_PRICE_ID`'s shape while you are there; it is
   the next `STRIPE_SECRET_KEY`.
3. **The end-to-end purchase still has not happened.** One completed checkout on a
   deployment, webhook through to an activated workspace, and the sentence
   *"no purchase has been completed end to end"* can come down. Not before.
4. **S3 — correct the spec and `CUST-124`'s ledger record**, or the false sentence has a
   place to be copied back from.

Nothing else. The engine is not what is wrong.

---

## ADVERTISING VERDICT

**No — and it is the same five-minute fix I signed off last time, which was never
deployed.**

I said in pass 6 that after S1 the answer was an unqualified yes. S1 was fixed in the
source, correctly, and more thoroughly than I asked. **It was not shipped.** Production
serves the false sentence on `/pricing` today, and I fetched it to be sure rather than
trusting the commit. `/demo` remains clean and every line of ad copy I re-read still checks
out; the ad's landing page is fine. But `/pricing` is the first click of anyone evaluating
the price, and it tells them something untrue about the service.

There is no new advertising defect. There is one old one that was fixed everywhere except
where it mattered, which is a distinction this project keeps rediscovering.

**Deploy `44f410c` to production and the answer is yes.** That is genuinely all that stands
between here and an advert I would sign off. I would not wait for the release blockers to
run it: nothing in S4 or S5 is visible to a visitor who cannot sign in, and the site
correctly tells them they cannot buy yet.

One condition attaches to the moment that stops being true. **The day checkout opens to real
customers, S4 must already be closed** — an advert that brings people to a buy button which
answers 500 without saying whether they were charged is worse than an advert for a product
that admits it is not selling yet.

---

*Pass 7 was measured against a working tree that advanced from `de608aa` to `0fa4a4b`
during the audit, pinned at `0fa4a4b` for every stated result; the production Worker and
the staging Worker and their public pages; and nine adversarial probes written by the
auditor — a breadth-first reachability walk of the signed-in application, an exact-replay
form submission against the real worker and the real CSRF defence, three Stripe-failure
injections, and a by-hand mutation of the review page to test whether the new cases
actually falsify. The probe files were deleted after the run and are not part of the
suite.*
