# Independent completion audit — pass 6

**Audit pass 6 · 20 September 2026.** Earlier passes: `docs/audit-summary.md` (1–3),
`docs/audit-pass-2.md` … `-5.md`.

## The tree

I was told to treat it as suspect and check rather than believe. I did, at the start and
after every run:

```
HEAD                    de608aa1a2c9cfaf5ce7f853f59c966939a8cca6
git status --porcelain  (empty)
origin/main             de608aa1a2c9cfaf5ce7f853f59c966939a8cca6   0   0
```

**It held this time.** `de608aa` touches one file (`docs/test-cases.json`), setting
`snapshot_commit` from the literal `"PENDING"` to `d477586` — its parent, whose test tree is
identical to this one, so the value is defensible. That commit also re-encoded the whole
ledger to ASCII escapes (`—` for `—`), which is why 619 lines moved for a one-line
change. Cosmetic, not content, but it makes every future ledger diff noisier.

---

## Verdicts

| Item | Verdict |
| --- | --- |
| Advertising blocker 1 — `/demo` carries the provider notice | **CLOSED**, and better than I asked for |
| Advertising blocker 2 — the ad no longer claims HubSpot | **CLOSED**; every other line checks out |
| Period guard (BILL-404) | **CLOSED** — I could not break it |
| Orphan rows (BILL-405) | **CLOSED** — I could not break it |
| Fourth builder / is there a fifth? | **CLOSED**, no fifth |
| Fabricated ids | **CLOSED** — every cited id exists |
| H1 — sign-in completion, single-use, rotation, identical refusals | **CLOSED**, verified to the byte on production |
| The two rewritten notices | **Both TRUE**, neither over-claims |
| **NEW — S1** | **`/pricing` contradicts itself about the same fact, on one page, and the losing half is false** |
| **NEW — S2** | **The checkout control is still inert. My own pass-4 summary overstated this and I am correcting it.** |

---

## H1 — the sign-in surface. Tested, not taken.

You were right that the earlier "fix" was worse than the bug: a real email carrying a URL
that answered 404. Both routes now exist. I wrote six adversarial tests against the real
`redeemSignInToken` and ran them; all six pass.

| Case | Result |
| --- | --- |
| A1 single-use | first `ok=true`, second `ok=false` / `unknown_or_used` |
| A2 two concurrent redemptions | **exactly one winner, exactly one session row** |
| A3 expired token (16 min) | refused |
| A4 expired vs unknown | `{"ok":false,"refusal":"unknown_or_used"}` — **byte-identical objects** |
| A5 rotation | new id ≠ old id, and the presented session's `revoked_at` is set |
| A6 stale cookie belonging to **another user** | sign-in still succeeds, and that session is revoked, not carried |

The mechanism is right where it has to be: `consumeOnce` is a single conditional
`UPDATE … WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING`
(`db/sessions.ts:235-249`) — single-use and expiry in one atomic statement, so the race has
one winner by construction rather than by ordering. `sessions.rotate` guards both halves of
its batch on the identical liveness predicate (`sessions.ts`), with the insert first.

**And on production, to the byte, as asked.** Four token classes — empty, unknown,
hex-shaped, expired-shaped — against `/app/sign-in/complete`:

```
8258e874e90260deab7d009c4009b120  <- token=''
8258e874e90260deab7d009c4009b120  <- token='no-such-token'
8258e874e90260deab7d009c4009b120  <- token='0123456789abcdef0123456789abcdef'   # secret-scan:allow synthetic probe string, never issued
8258e874e90260deab7d009c4009b120  <- token='expired-looking-abcdefabcdefabcdef'   # secret-scan:allow synthetic probe string, never issued
```

All 401, all `len=33189`, all identical once the per-request CSRF nonce is normalised. I
checked that the nonce is the *only* thing that varies by fetching the same token twice and
diffing: one line, the `csrf_token` value. **No oracle.** The owner route behaves the same
way (`426259882a5b…` for both classes, 401 not 404).

---

## The refund findings — I tried to break both and could not

**Period guard.** Migration `0008` says plainly that `0007`'s comment was false, which is the
right way to correct a false statement. The link is now exact rather than heuristic:
`invoice.paid` records the payment against the order it paid for, and
`orderPayments.record` carries `WHERE … AND payment_intent_id IS NULL`
(`db/commerce.ts`), so **a renewal cannot repoint an earlier order** — and `events.ts`
additionally guards on `order.paymentIntentId === null` before calling. Belt and braces.

My July-vs-October case, the one that broke pass 5:

```
R1 ok=false  msg=We have not recorded which payment paid for that order…
R1 stripe=0  refund rows=0
R2 ok=true   body=amount=4900&payment_intent=pi_july&…   (not pi_october)
```

The old order refuses and creates nothing; the right order aims at **its own** payment.

**Can any path still reach the subscription's latest payment?** No. Exhaustive grep of
`latestPaymentIntentId` / `latest_payment_intent_id` across `apps/app/src`: every remaining
reference is a type declaration, a column list, the write itself, the snapshot carry-forward,
or a comment. **Nothing reads it for a decision.**

**Orphan rows.** `checkOwnerApproval` now runs before `requestRefund`. I tried two ways to
get a row created and then fail:

```
R3 hash mismatch        -> ok=false, rows left = []
R4 amount above order   -> ok=false, rows left = []
```

Both refuse before anything is created. I could not construct a path that creates a refund
row and then fails.

**Fourth builder.** `scheduler/tick.ts:540` now seeds `newId(prefix, now.getTime())` from the
tick instant alongside `now: () => toIso(now)`. **There is no fifth**: five
`createBillingRuntime(` call sites exist, and the extra one (`billing/mount.ts:198`,
`createStripeWebhookDeps`) is a pass-through wrapper, not an independent builder — its only
caller supplies wall-clock parts for a webhook arriving in real time, which is consistent
rather than divergent.

**Fabricated ids.** I scanned every id cited in the header of every test file these commits
touched against the set of ids that actually lead a test title. **Zero dangling.**
`ownerRefund.test.ts:18` now lists `BILL-400, BILL-401, BILL-402, BILL-404, BILL-405,
AUTH-480` and all six exist; `sign-in-complete.test.ts` cites `AUTH-490..494` and all five
exist, in the tree and in the ledger. The only remaining occurrence of `BILL-403` is the
sentence at `:21` admitting it was fabricated — which my scanner flagged and I checked rather
than reported. Clean this time.

---

## The two rewritten notices — neither over-claims

I judged these as hard as the understated versions.

**"a Resend connection reaches 'ready' only once a correctly signed callback has actually
arrived."** The word carrying the weight is *only*, so I looked for a second writer. There is
exactly **one** production write of `connections.status = 'ready'`:
`db/resendWebhookPort.ts:617`, inside `markConnectionWebhookVerified`, reached from the
webhook route after signature verification and itself guarded `AND status != 'revoked'`.
(`owner/memory.ts:492` is the in-memory port, which production never constructs.) **True.**

**"the plan allowance is enforced on the live request path."** `checkAdmission` is called at
`money/eventsRoute.ts:299`, before any write, on the route mounted at `index.ts:530` —
`POST /api/v1/events` — and `docs/deployed-evidence.md` records `429 ALLOWANCE_EXHAUSTED`
observed against a deployment. **True, and deployment-verified.**

The rest of that notice: the endpoint being live and refusing an unsigned request — I
re-probed, 401 `SIGNATURE_INVALID`, **true**. HubSpot never read back from a real portal —
**true**. No purchase completed end to end — **true** (see S2). Nothing in the new wording
claims more than is true.

---

## S1 — NEW. `/pricing` contradicts itself, and the losing half is false.

The notice was corrected in `packages/ui/src/content/site.ts`. The *other* copy of the same
claim was not. `packages/ui/src/components/activation.ts:96`:

> `We are not taking payment or activating new workspaces while the endpoint that receives
> your automation’s signed events is not live.`

The endpoint **is** live. The same page says so. Fetched from production just now,
`/pricing` serves both:

- *"…the endpoint that receives your automation's signed events **is live** and refuses an
  unsigned request…"*
- *"…while the endpoint that receives your automation's signed events **is not live**."*

One page, one fact, two opposite statements, and the second is false. This is the same class
this project keeps producing — a sentence corrected in one place and left stale in another —
and it is now visitor-facing. It renders on `/pricing` and on four other surfaces
(`marketing.ts:227`, `workspacePage.ts:86`, `onboardingPages.ts:124` and `:751`).

**`/demo` carries neither string**, so the advert's landing page is not affected. But
`/pricing` is one click away and is where a visitor goes to find out what it costs.

---

## S2 — NEW, and it is a correction to my own pass-4 report

The checkout **control** is still inert. `onboardingPages.ts:745-753` renders
`UnavailableAction`, with the comment *"No form and no submit control while the activation
path is closed."* There is no `<form>` posting to `/app/onboarding/checkout` anywhere.

`createCheckout` genuinely calls `startCheckout` and genuinely returns a Stripe URL — I
verified that in pass 4 and it is still true. But I wrote in pass 4's verdict that *"checkout
is wired"* without saying that nothing a customer can click reaches it. That was my
overstatement, not yours, and it stood for two passes. **A customer still cannot buy
anything**, and the only thing standing between them and a charge is the absence of a button
rather than a gate — which is also what `ACTIVATION_UNAVAILABLE_REASON` is for, except that
its stated reason (S1) is false.

There is no global "not accepting customers" switch: payment is gated by
`orderSummary().blockers` — HubSpot ready, Resend ready, a published workflow, Stripe env —
plus the missing button. Production has both Stripe secrets.

---

## Housekeeping

Full suite, run by me: **2,615 tests, 2,612 passed, 0 failed, 3 skipped.** `tsc --noEmit`
exit 0, no output. `eslint --max-warnings=0` exit 0, no output.
`verify-test-cases.mjs --strict --gate` exit 0, **Ledger integrity: PASS**, 2,536 countable
and passing, and the number **not** backed by a recorded pass is **zero**.

---

## RELEASE VERDICT

**Taking payment: still BLOCKED, and for the first time the list is not about correctness.**

Everything I raised in pass 5 is genuinely closed, and closed in a way that survived my
attempts to break it rather than my reading of the diff. The money path now refuses what it
should refuse, aims at what it should aim at, and creates nothing when it refuses. The
sign-in surface is sound to the byte. That is real progress and I am not going to dress it
down.

What blocks a paid release:

1. **S2 — no customer can buy anything.** The control is absent by design. Until the button
   exists and one purchase has been completed end to end on a deployment, "ready to take
   payment" is not a claim anyone can make.
2. **S1 — fix the false sentence before the button appears**, because the moment the
   activation path opens, a visitor reading `/pricing` is being given a false reason for a
   state that no longer exists.

Nothing else. The list is two items and neither is a defect in the engine.

---

## ADVERTISING VERDICT

**Yes — with one fix first, and it is a five-minute one.**

Both blockers I raised are closed, and one is closed better than I asked. `/demo` now carries
a provider notice that does what the old one did not: it separates what has been observed
from what has not — *"HubSpot has not. A real credential is stored and validated against a
live portal, but no record has yet been read back from one"* and *"designed and tested rather
than observed. A stub proves we handle the response we believe a provider sends; it cannot
prove the provider sends it."* That also repairs the understatement I flagged in pass 5,
where the old notice disclaimed Resend too.

**I read every line of the ad copy, not only the one you changed.**

| Line | Verdict |
| --- | --- |
| `Did the automation actually do it?` | A question. No claim. |
| `Check the outcome, not the run log` | True of the design and of the deployed behaviour. |
| `Reads the email outcome back from Resend` | **True and proven** — a real `provider_readback` decided a run on 19 September. HubSpot correctly dropped. |
| Description 1 — *"…whether the acknowledgement actually reached the recipient, by reading the outcome back from Resend ourselves"* | True, with one nuance: Resend's `delivered` means the recipient's mail **server** accepted it, not that a person read it. The product uses the same phrasing internally (`ruleCompiler.ts:153`), so it is consistent rather than inflated — but it is the one line I would tighten. |
| Description 2 — *"Four answers: verified, failed, unverified, pending. Missing evidence is never reported as a pass. One workflow shape, HubSpot and Resend only."* | **Exact.** `RUN_STATUS = ['PENDING','VERIFIED','FAILED','UNVERIFIED']` — four, named correctly. The limitation is in the ad, which is the right place for it. |

**What a cold visitor on `/demo` would meet:** a 200 page, no account or email required, a
worked example, and a notice that separates observed from designed. Nothing on it is false.
They could not sign up and pay if they wanted to — but the page tells them so, and being
unable to buy is not a misrepresentation when the site says you cannot buy.

**The one fix before it runs: S1.** A visitor who clicks from `/demo` to `/pricing` — the
single most likely next click for someone evaluating a product — reads a false statement
about the service, on the same page that contradicts it. Correct
`ACTIVATION_UNAVAILABLE_REASON` and the answer is an unqualified yes.

I am deliberately not adding conditions beyond that. You asked the question that matters —
whether anything would make the product misrepresent itself to someone arriving from an
advert — and after S1 the answer is no.

---

*Pass 6 was measured against `de608aa1a2c9cfaf5ce7f853f59c966939a8cca6`, clean and equal to
`origin/main` throughout; the production Worker and its public pages; and ten adversarial
tests written by the auditor and run against the real ports and the real auth functions from
outside the repository.*
