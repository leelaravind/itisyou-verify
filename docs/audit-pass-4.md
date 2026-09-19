# Independent completion audit — pass 4

**Audit pass 4 · 20 September 2026.** Written by the Evidence and Completion Auditor, who
does not write product code and has authority to block a release. Earlier passes:
`docs/audit-summary.md` (1–3), `docs/audit-pass-2.md`, `docs/audit-pass-3.md`.

## The commit, and whether it stayed still

```
HEAD                    ca9d0626c2ab26946e0f78b2a549dfe2b883fd9a
git status --porcelain  (empty)
origin/main             ca9d0626c2ab26946e0f78b2a549dfe2b883fd9a
left/right vs origin    0   0
```

Checked at the start, after every test run, and at the end. **The tree did not move.**

Three commits since `33a6ea3`: `002b8ac` (admin login), `10dd5aa` (checkout), `ca9d062`
(portal, cancel, refund).

---

## Verdicts at a glance

| # | Claim | Verdict |
| --- | --- | --- |
| 1 | `createCheckout` now calls `startCheckout` and returns Stripe's hosted URL | **CONFIRMED** |
| 2 | `billingPortalLink` now calls `openBillingPortal` | **CONFIRMED** — and it is the only one of the four that gets the configuration check right |
| 3 | `ownerPort.cancelSubscription` now calls the billing `cancelSubscription` | **CONFIRMED** |
| 4 | `ownerPort.issueRefund` now calls `requestRefund` then `decideRefund` | **TRUE AS WORDED, BUT THE CONTROL IS STILL DEAD** — it can never succeed on any deployment. Proven below. |
| — | `grep "Stripe is not configured" apps/app/src` returns only comments | **CONFIRMED** — one hit, a comment at `scheduler/tick.ts:97` |
| A | With a provider, the approval is consumed inside `decideRefund` strictly before the Stripe call, exactly once | **UNREACHABLE** — on the owner path it is consumed **zero** times, because the call always throws first |
| B | OWNER-368's property now lives in BILL-141 | **FALSE** — BILL-141 does not assert it. It survives in **BILL-259**. And OWNER-370 lost real coverage. |
| C | No remaining path where an unpublished rule reaches a hashed approval payload | **FALSE** — the grant path hashes whatever JSON the owner pastes |
| D | Both ports cannot acquire two different clocks or id factories | **FALSE** — the owner port's billing runtime uses the wall clock while the port has an injected one |
| E | Production matches `ca9d062` | **CONSISTENT, NOT PROVEN** — still no version marker |
| F | Nothing previously closed was reopened | **ONE NEW DEFECT OF THE SAME CLASS** (G2) |

**Two findings of my own:**

| # | Finding | Severity |
| --- | --- | --- |
| **G1** | The owner refund control cannot submit a refund on **any** deployment. It throws `REFUND_TARGET_REQUIRED` before reaching Stripe, and leaves an un-actionable refund row behind. | **High — blocking** |
| **G2** | `/admin/login` no longer claims a link was sent — but now asserts "this deployment has no email delivery configured" on production, **which has Resend configured**. One false configuration statement replaced by another. | **Medium** |

---

## A / G1. The owner refund path — proven dead, by running it

### What the code does

`apps/app/src/db/ownerPort.ts:798-808` calls `decideRefund` with exactly these arguments:
`workspaceId`, `refundId`, `decision`, `approval`, `policyRule`, `consumeApproval`.

`decideRefund` (`apps/app/src/billing/refunds.ts:450-456`) refuses unless exactly one of
`paymentIntentId` / `chargeId` is supplied:

```ts
if ((params.paymentIntentId === undefined) === (params.chargeId === undefined)) {
  throw new AppError(422, 'REFUND_TARGET_REQUIRED',
    'A refund needs exactly one of a payment intent or a charge to refund against.');
}
```

`grep -n "paymentIntentId\|chargeId" apps/app/src/db/ownerPort.ts` returns **nothing**.
That check sits **before** the approval-consume block (`refunds.ts:468-489`), so the throw
happens first, every time.

### I did not leave that as a reading. I ran it.

Fourteen lines of setup against the **real `D1OwnerDataPort`**, the real D1 harness, and a
Stripe key present in the environment — written outside the repository and run with its own
Vitest config, so the audited tree was never touched (`git status --porcelain` empty before
and after).

```
A2 result.ok=false
A2 message: No refund was submitted. REFUND_TARGET_REQUIRED:
            A refund needs exactly one of a payment intent or a charge to refund against.
A2 approval after: status=granted consumed_at=null
A2 refund rows: [{"id":"ref_01M2Y04AMN2BB78732C7424219","state":"queued_for_owner"}]
```

And directly against the library function, with the same arguments the port passes:

```
A1 threw: REFUND_TARGET_REQUIRED: A refund needs exactly one of a payment intent or a charge…
A1 consumeApproval called 0 time(s)
A1 createRefund calls: 0
```

### What this means, precisely

- **Claim 4 is true as worded and misleading in substance.** `issueRefund` does now call
  `requestRefund` and then `decideRefund`. It can never get past the second one. The control
  moved from *"refuses with a false configuration message"* to *"refuses with a true internal
  error message."* It still cannot issue a refund, on any deployment, configured or not.
- **Claim A is unreachable, not wrong.** The ordering you describe — consume strictly before
  the provider call, exactly once — is correct **in `decideRefund`**, and `BILL-257..261`
  prove it there. On the owner path `consumeApproval` is invoked **zero** times. So the
  safety property you asked me to attack holds, but vacuously: there is no path through this
  port on which an approval is consumed at all.
- **I could not construct the failure modes you asked about** — consumed twice, consumed
  after the provider call, or spent-with-a-refund-submitted — because none of them is
  reachable. The approval is correctly left `granted`. That is the good news and it is small.
- **A side effect:** `requestRefund` runs first, so every attempt leaves a `refunds` row in
  `queued_for_owner`. It is idempotent on `refundIdempotencyKey` (`refunds.ts:301`), so
  identical retries reuse one row rather than piling up — but the owner's refund queue now
  accumulates refunds that the owner's own control cannot action.

### Why no test caught it

`ownerPort.#billingRuntime` (`ownerPort.ts:646-658`) constructs `createStripeClient({ secretKey })`
with **no injectable transport** — unlike `customerPort.#billingRuntime`, which threads
`this.#fetchImpl` (`customerPort.ts:883-886`). So the provider-configured owner paths cannot
be exercised by any test in the suite without real network, and none is. The full suite is
green — I ran it: **2,603 tests, 2,600 passed, 0 failed, 3 skipped** — and it is green over a
control that cannot work.

---

## B. Did the rewritten tests preserve their intent? Partly. Two lost real coverage.

You asked me to judge this as the move an agent makes to get green. On two of the three, that
is what it is.

**OWNER-367 — intent preserved.** The behaviour genuinely changed (no provider → nothing
consumed), the assertion changed to match, and the change is an improvement. Fine.

**OWNER-368 — coverage moved, but not to where you say.** The old property was *one approval
authorises at most one submission*. You cite BILL-141. **BILL-141 does not assert that.** It
replays with a **different** approval (`apr_0002`, `refunds.test.ts:265`) and the refusal comes
from the refund state machine (`/cannot be approved/`), not from approval single-use. What it
proves is refund-level idempotency — `createRefund` called once.

The property does survive, in **BILL-259** — *"an approval already spent on another refund
authorises nothing and no money moves"* — which presents the **same** approval against a
second refund and asserts `/already been used/` with no new `createRefund` call. So the
coverage exists; your citation is wrong, and that wrong citation is now committed as a comment
in `live-engines.test.ts:646-648` where the next reader will trust it.

**OWNER-370 — coverage genuinely weakened. This is the one.** The old case asserted that an
approval granted through the panel is one the refund action recognises — that the grant path
and the consumption path hash the payload identically. That property is load-bearing: when it
broke before, every approval the owner granted was unusable.

The new assertion is:

```ts
expect(body).not.toMatch(/not usable|does not match|already been used/i);
expect(body).toMatch(/STRIPE_SECRET_KEY/);
```

`issueRefund` returns at the `runtime === null` branch (`ownerPort.ts:773-783`) **before any
hash is compared** — `checkOwnerApproval` lives inside `decideRefund`, which is never reached.
So the test asserts the absence of an error that could not have occurred. **It would pass if
the two hash functions were completely incompatible.** The stated property is no longer tested
anywhere on this path. That is coverage lost to make a change pass, and the test's own comment
("the assertion is that it is NOT rejected on those grounds") reads as a justification for it.

**OWNER-369 — now vacuous, and not declared.** You did not rewrite it, but *"a refund a penny
different from the approved one consumes nothing"* is now trivially true for the same reason:
the code returns before comparing anything. It passes without measuring its property.

**And the wider hole.** Approval single-use through the **production** owner refund route is
now tested nowhere. `OWNER-300..303` in `tests/integration/owner/live-path.test.ts` do assert
it through a mounted app — but that file constructs `MemoryOwnerDataPort`
(`live-path.test.ts:65-72`), which the composition root never builds (`index.ts:589` supplies
`createOwnerDataPort`). A file whose header says it exists because *"correct code, thoroughly
tested, reached by nothing"* is itself testing a port production never reaches.

---

## C. `policyRule` validation — the fix is real, the claim is not

The validation is there and correctly placed: `ownerPort.ts:765-771` checks
`isRefundPolicyRule` before the rule is used, and `decideRefund` checks again at
`refunds.ts:427`. On the **refund** path an unpublished rule authorises nothing.

But the claim is *"no remaining path where an unpublished rule reaches a hashed approval
payload"*, and the **grant** path is one. `POST /owner/approvals`
(`routes/owner/index.ts:1168-1197`) passes `form.single['payload_json']` straight to
`grantApproval` (`ownerPort.ts:1459`), which `JSON.parse`s it and hashes it through
`grantOwnerApproval` with **no rule validation** — the payload type declares
`policy_rule: string` (`owner/approvals.ts:71`), not the union.

So an owner can grant a `refund_issue` approval whose `policy_rule` is any string, and that
string is hashed into the approval. It fails closed at use, so the security consequence is
contained — but the claim as written is false, and "contained" is a different statement from
"no remaining path."

---

## D. One builder per port — but the two builders do not agree

This is the claim I was asked to check, and the answer is that they *can* differ, and they do.

| | clock | id factory |
| --- | --- | --- |
| `customerPort.#billingRuntime` (`customerPort.ts:877-890`) | `() => toIso(this.#now)` — the port's injected clock | `newId(prefix, this.#now.getTime())` |
| `ownerPort.#billingRuntime` (`ownerPort.ts:646-658`) | **`() => new Date().toISOString()`** — the wall clock | **`newId(prefix, Date.now())`** |

`D1OwnerDataPort` *has* an injected clock — `readonly #now: Date` at `ownerPort.ts:211`, set
at `:227`, and used for `ctx.now` in audits and `claimApproval`. Its billing runtime ignores
it. So within one owner action the audit rows and the approval consumption carry the injected
instant while the refund rows would carry wall-clock instants. The customer port gets this
right; the owner port does not. **Two clocks and two id factories in one operation.**

**`#billingRuntime` returning null is handled by every caller.** There are exactly two
(`ownerPort.ts:672` cancel, `:773` refund) and both check for null and return `writeBlocked`.
That half of the claim is correct.

---

## E. Production — consistent with `ca9d062`, still not provable

| Event | Time (UTC) |
| --- | --- |
| `002b8ac` committed | 23:06:18Z |
| `10dd5aa` committed | 23:13:42Z |
| `ca9d062` committed | 23:21:28Z |
| CI for `ca9d062` succeeded, artefact `release-gate-ca9d0626…` | ~23:23Z |
| **production deployed**, version `d9b88649-d38b-4ec8-af32-32e8606f3540` | **23:24:27.042Z** |

The ordering is right this time, and the version id matches what you stated. What I can
**observe**: production serves the `002b8ac` change — I probed `/admin/login` and got the new
wording. What I **cannot** observe: any discriminator between `10dd5aa` and `ca9d062`, because
every control they changed is behind a session. `/health` still carries no commit identifier.

So: **production is provably at or after `002b8ac`, and the timing is consistent with
`ca9d062`. The exact deployed commit remains unverifiable.** The owner action I named in pass 3
— stamp a commit id into the Worker — has not been done, and it is now the third pass in a row
where "which commit is live" could not be answered.

What I could observe of the four controls, without spending money:

- `POST /app/onboarding/checkout` unauthenticated → **401**, sign-in page. Correct; the
  control is behind auth and no longer behind a lie.
- I did **not** complete a purchase, create a refund, or cancel a subscription.

---

## F. Re-checks of what earlier passes closed

| Previously | Now |
| --- | --- |
| Correlation F1/F2 (`resendWebhookPort.ts`) | **Untouched** by these three commits. Not reopened. |
| Billing-period key (pass 1's P1) | `customerPort` changed, but nothing on the key path. Not reopened. |
| Suite green / compiles / lints | Re-run by me at `ca9d062`: **2,600 passed, 0 failed, 3 skipped**; `tsc --noEmit` **exit 0, no output**; `eslint --max-warnings=0` **exit 0, no output**. |
| Ledger honesty | **2,536** countable-and-passing, and the number **not** backed by a recorded pass is **zero**. The six new rows (`AUTH-433`, `OWNER-200`, `API-621`, `BILL-297/298/299`) are all `implemented`, `countable: false`. No inflation. `verify-test-cases.mjs --strict --gate` exits **0**, `Ledger integrity: PASS`. |
| "No CI gate artefact for the audited commit" (pass 3) | **CLOSED.** CI run `35475902431` produced `release-gate-ca9d0626c2ab…`. |
| `snapshot_commit` (pass 3, still wrong) | **STILL WRONG, AND FURTHER OUT.** It now reads `"002b8ac"` — two commits behind the tree it describes, which contains `API-621` and `BILL-297..299` from `10dd5aa`. Pass 2 found it off by one; pass 3 found the fix off by one again; this is the third occurrence and the gap has widened. |
| F3 `/admin/login` | **The lie is gone** — see G2 for what replaced it. |

### G2. The admin-login fix is real, and introduces the same class of defect

The substance is fixed: `requestSignInLink` (`ownerPort.ts:2641-2676`) now actually delivers
through `#notifications`, and reports what happened. On production:

```
$ curl -X POST https://verify.itisyou.app/admin/login -d "email=…@example.invalid"
status=200
No sign-in link was sent. This deployment has no email delivery configured, so nothing
would arrive and we will not pretend otherwise. We do not say whether an account exists…
```

No claimed success. That is the important half and it is genuinely done.

But `SignInLinkOutcome` has exactly two states (`ownerPort.ts:194-196`):

```ts
export interface SignInLinkOutcome { readonly delivery: 'sent' | 'no_transport'; }
```

and the outcome is `report.sent > 0 ? 'sent' : 'no_transport'`. **There is no failure state.**
Any send that is attempted and fails — a rejected address, an API error, an unverified sending
domain — renders the sentence *"This deployment has no email delivery configured."*

**Production has `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` configured.** I read the secret
list. The transport is built. So the sentence production served me is false: the deployment
*does* have email delivery configured; my probe address was simply rejected.

This is the same class as the five "Stripe is not configured" statements this very set of
commits removed: **a user-facing sentence asserting a configuration fact the code did not
check.** And the correct pattern is in the same changeset — `billingPortalLink`
(`customerPort.ts:1217-1223`) reads `STRIPE_SECRET_KEY` explicitly before saying it is
missing, and falls back to a neutral message otherwise. That makes G2 an inconsistency rather
than a policy, which is why I rate it Medium rather than High.

**Minor, same file:** `customerPort.ts:868-871` leaves `const secretKey = …; void secretKey;`
— a read-and-discard that lint cannot flag because `void` counts as a use.

---

## What this pass could not check

- **The deployed commit's identity.** Unverifiable without a build marker; owner action.
- **Any provider-configured owner path, end to end.** `ownerPort.#billingRuntime` has no
  injectable transport, so neither I nor the suite can reach Stripe through it without real
  network. G1 was found by reading and proven by the throw that precedes the network call.
- **Checkout, refund, cancel and portal against a live session.** I did not complete a
  purchase, create a refund, or cancel a subscription, as instructed.
- **Whether `report.sent === 0` on production was a rejected address or a broken transport.**
  My probe used an `.invalid` domain deliberately. Either way the rendered sentence is false
  on a configured deployment; which of the two it was does not change that.

---

## RELEASE VERDICT

**The public website: unchanged — live, accurate, safe to use.**

**Taking payment: closer than it has ever been, and still BLOCKED.**

What genuinely changed today is real and should be said plainly: **checkout is wired.**
`createCheckout` calls `startCheckout` and returns Stripe's hosted URL; the billing portal is
wired and is the one control that gets its configuration check right; owner cancel is wired;
`/admin/login` no longer reports a success it did not perform. Four of the five false
configuration sentences I found in pass 3 are gone, the suite is green over 2,600 tests, the
ledger is honest, and CI produced a gate artefact for the audited commit for the first time.

It stays blocked because **one of the four controls you reported as wired cannot work**, and
because the pattern that produced it is still present.

### The shortest list that would unblock a paid release

1. **Pass a refund target.** `ownerPort.issueRefund` must supply `chargeId` or
   `paymentIntentId` to `decideRefund`. Today it supplies neither and the control throws
   `REFUND_TARGET_REQUIRED` 100% of the time. Nothing else on this list matters more.
2. **Make the provider-configured owner paths testable**, then test them. Thread an injectable
   gateway into `ownerPort.#billingRuntime` the way `customerPort` already threads
   `#fetchImpl`. G1 survived a green 2,600-test suite because no test can reach that branch.
3. **Restore OWNER-370's property.** Assert that an approval granted through the panel hashes
   identically to what the refund path recomputes — on a path that actually reaches the
   comparison. And correct the BILL-141 citation to BILL-259.
4. **Give `SignInLinkOutcome` a third state.** `'sent' | 'no_transport' | 'send_failed'`, and
   say "we could not send it" when the transport exists and the send failed.
5. **Give `ownerPort.#billingRuntime` the port's own clock and id factory**, as
   `customerPort` does.
6. **Fix `snapshot_commit`** — third pass running. Generate it from `git rev-parse HEAD` at
   write time rather than by hand.
7. **Validate `policy_rule` on the grant path**, or stop claiming no path hashes an
   unpublished rule.

### Owner actions nobody else can take

- **Stamp a commit identifier into the deployed Worker.** Three passes have now been unable to
  say which commit is live. One line in `/health` ends it permanently.
- **Decide whether Claude model usage counts against the £100** — still open from pass 2.

### What I would say if asked whether the team is being straight

Yes, with one qualification. Every claim in this brief was checkable, three of four were true,
and the one that was not was stated in a form precise enough that I could disprove it in an
hour. The two claims I marked FALSE (C and D) are both cases of a true fix described more
broadly than it was made. That is a reporting habit worth tightening, not a pattern of
concealment — and the coverage loss in OWNER-370 is the one thing in this pass I would call a
green-seeking move rather than an error.

---

*Pass 4 was measured against `ca9d0626c2ab26946e0f78b2a549dfe2b883fd9a`, clean and equal to
`origin/main` throughout; the production Worker and its configured secrets; GitHub Actions run
`35475902431`; and adversarial tests written by the auditor and run against the real ports from
outside the repository.*
