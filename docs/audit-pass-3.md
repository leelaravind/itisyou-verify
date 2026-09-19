# Independent completion audit — pass 3

**Audit pass 3 · 19 September 2026.** Written by the Evidence and Completion Auditor, who
does not write product code and has authority to block a release. Pass 1 and its two
follow-on passes are in `docs/audit-summary.md`; pass 2 is in `docs/audit-pass-2.md`.

## The commit, and whether it stayed still

This is the first pass in this project's history that was run end to end against one commit
that did not move.

```
HEAD                      33a6ea3d926f0b907c3970ff319777715905cb0c
git status --porcelain    (empty)
origin/main               33a6ea3d926f0b907c3970ff319777715905cb0c
git rev-list --left-right --count origin/main...HEAD    0   0
```

Checked at the start, after every test run, and at the end. **The tree did not move.** That
was the condition I set at the end of pass 2 and it was met.

Everything below was measured against `33a6ea3`, against the two remote D1 databases, and
against the production and staging Workers as they actually stand.

---

## Verdicts at a glance

| # | Item | Verdict |
| --- | --- | --- |
| 1 | The F1 fix in `claimInboxForRun` | **PARTIALLY CLOSED** — the defect I reported is closed; a residual of the same class survives, and I reproduced it |
| 2 | Pass 1's payment blockers | **4 CLOSED, 1 closed in part, 1 partly closed, 3 STILL OPEN** (table below) |
| 3 | `createCheckout` is a hardcoded refusal that lies about why | **CONFIRMED, and worse than reported** |
| 4 | The four corrections from pass 2 | **2 CORRECT, 1 INCORRECT, 1 CORRECT-with-residual, plus 1 NEW inaccuracy** |
| 5 | Production runs `af23e906` and later `33a6ea3` | **FALSE as to `33a6ea3`** — production cannot be running it |
| F3 | *(not claimed by anyone)* `POST /admin/login` tells a live visitor "a link is on its way" and returns **200**, while nothing in the codebase ever sends one | **NEW — confirmed against production** |

---

## 1. The F1 fix — I tried to break it, and I did

### What I did

I did not read `CONN-345`/`CONN-346` and take them. I wrote **fourteen adversarial cases of
my own**, against the real `D1ResendWebhookDataPort` and the repository's real SQLite
harness, driving the actual port methods. They live outside the repository (`H:/itisyou-audit-scratch/`,
removed afterwards) and were run with their own Vitest config so that **not one byte of the
audited tree was touched** — `git status --porcelain` was empty before and after every run.

### Result: 13 of 14 pass. The fourteenth broke it.

Taking the four questions in order:

**Can a non-PENDING run still claim? No.** Three ways tried, all refused:

| Case | Setup | Result |
| --- | --- | --- |
| A1 | A `VERIFIED` run is the **only** run naming the message | claimed **0**, `evidence` empty |
| A2 | An `UNVERIFIED` run asks | claimed **0** |
| A3 | A `VERIFIED` run asks while a `PENDING` sibling also names it | decided run claimed **0**; the pending one then correctly claimed 1 |

**Can two runs both get evidence under any ordering I can construct? Yes — one.**

| Case | Setup | Result |
| --- | --- | --- |
| B3 | Both runs `PENDING` at once, asked in either order | both **0** — correct |
| B1 | Run one claims, completes; run two created naming the same id | run two **0** — correct |
| **B2** | **25 parked callbacks for one message id**, run one claims, completes, run two created naming the same id | **run one claimed 20, run two claimed 5 — one message id bound to TWO runs** |

Verbatim from the run:

```
B2 parked=25 first_claimed=20 second_claimed=5 distinct_bound_runs=["first","second"]
AssertionError: one message id must not end up bound to two different runs: expected 2 to be 1
```

`INBOX_CLAIM_BATCH = 20` (`apps/app/src/db/resendWebhookPort.ts:53`). The guard is checked
once per call; the claim then takes at most twenty rows. Everything past the twentieth stays
parked and unclaimed, and the guard is re-evaluated from scratch the next time anyone asks —
by which time the first run may be decided and a second run may be the sole pending
claimant.

Twenty is not a high bar. Resend fires one event per open and per click, each with its own
`provider_event_id`, so each is a distinct parked row (the `UNIQUE (workspace_id, provider,
provider_event_id)` dedupe only collapses genuine replays). My case B6 confirms it: 21 opens
of one message produce 21 parked rows.

**Does `LIMIT 2` actually make ambiguity visible, or can a third run hide it? It cannot be
hidden.** With three pending claimants, and again with twenty, every single one was refused:

```
C1 three pending runs name it: none claims        -> all 0, evidence empty
C2 twenty pending runs name it: none claims       -> all 0, evidence empty
```

`LIMIT 2` returns two rows, the length check rejects anything that is not exactly one, and
the asker's identity is compared afterwards. A run cannot arrange to be the one returned.

**Is there any path where `claimInboxForRun` is reached with a `runId` the caller did not
verify?** The only non-test caller is `apps/app/src/scheduler/observe.ts:865`, gated on
`locator.message_id !== undefined` (`observe.ts:282-298`). But that no longer matters, which
is the right design: **the port now verifies the `runId` itself**, so a careless caller
cannot exploit it.

| Case | Setup | Result |
| --- | --- | --- |
| D1 | A run asks using **another run's** message id | **0** |
| D2 | A `runId` that does not exist at all | **0** |
| D3 | Another workspace's run asks for this workspace's row | **0** |

**And the legitimate behaviour still works** — I checked, because a fix that closes a hole by
breaking the feature is not a fix:

| Case | Result |
| --- | --- |
| E1 | The single pending run that named it still receives it (claimed 1) |
| E2 | An ambiguity that later resolves (sibling decided) lets the survivor claim |
| E3 | A row parked `ambiguous` is **still** never claimable, even after the sibling is decided |

### The residual, stated precisely — and it is not the lead's fix that caused it

I then asked whether B2 depends on the batch limit at all. **It does not.** Case B4 goes
through the **live** path and needs no batch:

```
B4 bound=[{"run_id":"one","n":1},{"run_id":"two","n":1}]
```

Run one names `M1`, receives its delivery, is decided. The customer's automation then reports
a second enquiry naming the same `M1`. A late provider callback for that message — an open, a
click, a bounce — arrives, `#correlateEmailEvidence` finds exactly one pending run naming
`M1`, and binds it to run **two**. Run two never had an acknowledgement of its own, and can
now be VERIFIED on run one's evidence.

So the honest finding is two-part:

- **F1 as I reported it in pass 2 is CLOSED.** The dangerous ordering — callback parked
  `unmatched`, two runs then appear, first observed wins — is refused. `CONN-345` and
  `CONN-346` are real tests that check real things, and my own independent cases agree with
  them.
- **F2 is a residual of the same class, not introduced by this fix, and not closed by it.**
  The guard establishes *"at this instant exactly one PENDING run names this message."* The
  property the product actually needs is *"all evidence for one message id belongs to one
  enquiry, for all time."* Those are different, and the gap between them is reachable both
  on the recovery path (B2) and on the live path (B4).

**Severity.** High in kind — it is the same failure the whole day's work has been about, one
enquiry's acknowledgement satisfying another enquiry's check, able to publish a VERIFIED
verdict against an enquiry that was never acknowledged. Reachability is narrower than F1:
it requires the customer's automation to name the same `expected.email_message_id` on two
enquiries. That is a customer-side mistake, but "the customer's automation is wrong" is the
exact condition this product exists to detect, so it cannot also be the assumption that
keeps it correct.

**What would close it:** bind the message id to one run permanently — for example, refuse to
open a run naming an `expected.email_message_id` that a decided run already used, or record
the owning run on first bind and require every later claim and live match for that id to
agree with it. I do not write product code; that is the shape, not a patch.

---

## 2. Pass 1's payment blockers, re-checked

Pass 1 and its two follow-on passes raised these on the commerce path. Each is checked
against `33a6ea3` and, where it is a deployment question, against the live services.

| # | Pass 1 finding | Verdict | Evidence |
| --- | --- | --- | --- |
| P1 | *"Two incompatible date formats used as the key for the same billing-period record"* — later *"partially fixed and not closed; two of the three places still use the old one, and the safety check is missing from the path production uses"* | **CLOSED** | I ran both functions, which is how pass 1 proved it open. `billingPeriodKey('2026-09-19T12:34:56Z')` → `2026-09-19`; `allowancePeriodKey(...)` → `2026-09-19`; `allowancePeriodKeyAt` agrees with `allowancePeriodKey` for the same period (`2026-10-20` from both sources). The validator now runs on the production paths: `apps/app/src/db/billingPort.ts:286`, `apps/app/src/scheduler/observe.ts:632`, `apps/app/src/money/periodReconciliation.ts:203,227,234`, `apps/app/src/billing/memory.ts:81`. The surviving `YYYY-MM` producer is renamed `calendarMonthNotAnAllowanceKey` (`apps/app/src/db/customerPort.ts:119`), documented as not a key, and has **zero non-test callers** — its only two callers are regression tests that assert it settles nothing. The customer usage page now calls `resolveAllowancePeriodKey` (`customerPort.ts:1168`). |
| P2 | *"Payments are not live. The payment routes are not switched on. No card can be charged."* | **STILL OPEN** | See §3. It is not merely "not switched on" — the customer-facing entry point is a hardcoded refusal, and the real implementation has no non-test caller. |
| P3 | *"The payment-failure policy … has nine parts. One is fully met. The other eight have correct, well-tested logic that nothing currently calls."* | **STILL OPEN** | The same shape as §3 across refunds, cancellation and the billing portal — verified below. |
| P4 | *"The production deployment is several commits behind the tested code"* | **STILL OPEN** | See §5. Production's last deployment predates the audited commit by twelve minutes; staging's predates it by forty-five. |
| P5 | *"No customer can be issued a signing key at all, because nothing calls the code that issues one"* | **CLOSED** | `POST /app/onboarding/activation/signing-key` (`apps/app/src/routes/app/index.ts:694-716`) calls `port.issueSigningKey()`, implemented at `apps/app/src/db/customerPort.ts:964` and reaching the real `issueWorkflowSigningKey` — real key material, real DB write, an audit record, gated on `workspace_admin`, CSRF enforced by `withSession`. The control is rendered for the customer at `apps/app/src/routes/app/onboardingPages.ts:830`. Not a stub. |
| P6 | *"The customer notification for a paused subscription is written and correct but is not yet wired to send"* | **CLOSED** | The delivery collaborator is now passed into the mounted Stripe webhook route: `apps/app/src/index.ts:368`, `notifications: createNotificationDelivery(...)`, with the comment naming this exact finding — *"The wire that was missing. Without it `handleStripeEvent` still builds the `payment_problem` notification for a failed renewal and the route still drops it."* `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` are configured on both deployments, and an unset transport is recorded as `no_email_transport_configured` rather than silently dropped. |
| P7 | *"one [owner control] reports a queued action that is not queued, and one returns a success status code"* | **half CLOSED, half STILL OPEN — and the open half is worse than pass 1 described** | *Queued-but-not-queued:* **closed** on the live path. `apps/app/src/db/ownerPort.ts:1611-1627` now asks the runner and records `awaiting_runner` when nothing accepted the job — *"A queued run is only queued if something was actually asked to run it"*; `:1586` *"a queued-looking page would be a lie."* The offending message survives only in `apps/app/src/owner/memory.ts:477-480`, and `MemoryOwnerDataPort` has no non-test constructor (the composition root supplies the D1 port at `apps/app/src/index.ts:589`). *Success status code:* **still open, and it is F3 below.** |
| P8 | *"The four purchase and activation controls are inert"* | **PARTLY CLOSED** | The **activation** control is now live and does real work (P5). The **purchase** control is still inert — `createCheckout` refuses unconditionally (§3), so posting to the checkout endpoint still returns 503 and no card can be charged. |
| P9 | *"The automated release gate is not met — five failing cases, and the current commit does not compile"* | **CLOSED** | Run by me at this commit: `npx tsc -p tsconfig.json --noEmit --pretty false` → **exit 0, no output**. `npx eslint . --max-warnings=0` → **exit 0, no output**. Full suite → **2,594 passed, 0 failed, 3 skipped**. The commit compiles, lints and is green. (The gate *artefact* is a separate matter — see the end of §4: CI has produced none for `33a6ea3`.) |

### F3 — the live admin sign-in page tells visitors a link was sent. Nothing sends one.

This is the open half of P7. Pass 1 recorded it as *"one returns a success status code."*
That undersells it, in the same way pass 1 undersold the checkout message.

I probed the **live production service**:

```
$ curl -X POST https://verify.itisyou.app/admin/login -d "email=…@example.invalid"
status=200
… a link is on its way. It expires in fifteen minutes and can be used once.
  We do not say whether an account exists, to anyone, ever.
```

No sign-in link is ever sent, by any code path. `requestSignInLink`
(`apps/app/src/db/ownerPort.ts:2504-2520`) rate-limits and calls `issueSignInToken` — and
nothing else. There is no transport call, no notification, no delivery. `issueSignInToken`
has exactly two non-test callers: this one (`ownerPort.ts:2519`) and a staging-only helper
(`:2534`). A `sign_in_link` template exists (`apps/app/src/notifications/templates.ts:293`)
and is never rendered for this path.

**The repository already knows.** `apps/app/src/notifications/templates.ts:60-61`:

> **The other seven still have no triggering event.** `sign_in_link` is the one that costs
> the most: `issueSignInToken` mints a token the owner path never emails…

And the method's own docblock (`ownerPort.ts:2499-2502`) says it plainly: *"when Resend is
configured the mail path picks it up. Until then it is issued and simply never delivered."*
`RESEND_API_KEY` and `RESEND_FROM_ADDRESS` **are** configured on production — I read the
secret list — and it still is not picked up, because no code picks it up.

**The same product, on the customer side, refuses to do this** —
`apps/app/src/db/customerPort.ts:292-302` returns **422** and says:

> *"No sign-in link was sent. Email delivery is not connected in this environment yet, so
> nothing would arrive and we will not pretend otherwise."*

with a docblock at `:287-288` stating that pretending is *"what the brief forbids — the
customer would sit waiting for a mail nobody sent."* The owner path does the forbidden thing
at a 200, on a page that is public on the internet.

The anti-enumeration goal is legitimate and should be kept: the same answer for every
address is correct. But *"a link is on its way"* is not ambiguous — it is false for **every**
address, including the owner's. Anti-enumeration can be preserved with wording that is not a
lie.

**Severity: blocking, and trivially reachable** — it is one unauthenticated POST to a public
production URL.

### 2a. What that table adds up to

**Four of pass 1's blockers are genuinely closed** — the billing-period key (P1), the release
gate and compilation (P9), signing-key issuance (P5), and the paused-subscription notification
wiring (P6). Each was closed by running the thing, not by reading the fix.

**What remains open is one defect wearing five faces**, and naming it once is more useful
than listing it five times:

> **The product tells users things about itself that are not true, at success or
> success-adjacent status codes, in front of code that would work.**

- checkout says "Stripe is not configured" on a deployment where it is (§3, 503);
- the billing portal says the same (§3);
- owner cancel says the same (§3);
- owner refund says the same *after* spending the approval (§3);
- `/admin/login` says "a link is on its way" when nothing sends one (F3, **200**).

P2, P3, P7's open half and P8's purchase half are all that one finding. P4 — the deployment
being behind — is §5.

---

## 3. The checkout stub — CONFIRMED, and worse than reported

I verified this myself rather than taking it.

**`createCheckout` never calls Stripe.** `apps/app/src/db/customerPort.ts:861-873`, complete:

```ts
async createCheckout(): Promise<WriteResult> {
  const scope = await this.#scope();
  if (scope === null) return refuse('Sign in before subscribing.');
  const summary = await this.orderSummary();
  if (!summary.ready) {
    return refuse(
      `No checkout session was created and no card was charged. ${summary.blockers.join(' ')}`,
    );
  }
  return refuse(
    'No checkout session was created and no card was charged. Stripe is not configured in this environment, so there is no hosted Checkout to hand you to.',
  );
}
```

There is no gateway, no client, no session. The final `return refuse(...)` is **not guarded by
any condition**. The only environment read in the vicinity is in `orderSummary`
(`customerPort.ts:836-838`), and it feeds the *other* branch: when Stripe **is** configured
that blocker is not added, `summary.ready` becomes true, and control falls through to the
unconditional sentence.

**`startCheckout` has no non-test caller.** Every reference in the repository:

```
apps/app/src/billing/checkout.ts:6    (a doc comment)
apps/app/src/billing/checkout.ts:68   (the definition)
apps/app/src/billing/index.ts:125     (a re-export — not a call)
tests/integration/billing/checkout.test.ts   15 call sites
```

Zero non-test call sites. A full implementation — idempotency key, order creation, Stripe
Checkout Session, livemode tamper check — that nothing a customer can reach ever executes.

**The message is false on both deployments, not just staging.** I read the configured
secrets rather than inferring:

```
verify-itisyou-staging      STRIPE_PRICE_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET  all present
verify-itisyou-production   STRIPE_PRICE_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET  all present
```

And the refusal predates both deployments — the sentence was introduced in `85c2c63` at
09:46Z, while staging was deployed at 21:55:58Z and production at 22:28:31Z. So the deployed
builds contain it.

**Therefore: on the live production service, a customer who has completed setup and presses
subscribe is told "Stripe is not configured in this environment" — on a deployment where
Stripe is configured — and receives HTTP 503.** That is not a stub being honest about a gap.
It is a stub asserting a false fact about the deployment, to the person trying to pay. The
doc comment above the method (`customerPort.ts:857-859`, *"There is none in this
environment"*) is false in the same way.

**The same shape, unconditional, on three more commerce operations** — each read by me
directly:

| Operation | Location | Behaviour |
| --- | --- | --- |
| Owner-issued refund | `apps/app/src/db/ownerPort.ts:684-715` | **Consumes the owner's single-use approval** (`claimApproval`, then audits `owner.approval.consumed`) and *then* returns `writeBlocked` with `NO_REFUND_PATH` (`ownerPort.ts:127-128`): *"Refunds are issued through Stripe, which is not configured on this deployment."* Unconditional. The approval is spent on an action that cannot occur. |
| Owner cancel subscription | `apps/app/src/db/ownerPort.ts:626-641` | Unconditional `writeBlocked`: *"Stripe is not configured on this deployment…"* |
| Customer billing portal | `apps/app/src/db/customerPort.ts:1201-1220` | Always returns `href: null` with *"…Stripe is not configured in this environment."* Unconditional. |

Each has a real, tested implementation behind it — `decideRefund`
(`apps/app/src/billing/refunds.ts:389`), `cancelSubscription`
(`apps/app/src/billing/portal.ts:82`), `openBillingPortal` (`apps/app/src/billing/portal.ts:28`) —
and **none of the three has a non-test caller.**

### Did pass 1 identify this as a stub, or only as "not switched on"?

The question was asked precisely and it deserves a precise answer, including where it
reflects badly on my own predecessor in this role.

**Pass 1 got closer than "not switched on", and then under-rated what it had.**

- `docs/audit-summary.md:92` and `:125` — the headline framing: *"Payments are not live. The
  payment routes are not switched on."* That framing implies wiring that exists but is
  disabled. It is wrong about the shape of the work.
- `docs/audit-summary.md:166` — pass 1 **did** identify the "code exists, nothing calls it"
  property, but only for the payment-failure policy: *"correct, well-tested logic that
  nothing currently calls."* It did not extend that to checkout, refunds, cancellation or
  the portal, and it did not name `startCheckout`.
- `docs/audit-summary.md:225-227` — pass 1's third pass **hit the exact 503**: *"Posting
  directly to the checkout endpoint with a valid session and a valid CSRF token returns
  **503** and an honest message naming what is missing."* It called the message **honest**.
  That judgement was defensible at the time and is not now: that pass was measured against
  `wrangler dev --local` with no Stripe variables at all, where the sentence was true. It
  became false the moment credentials were configured, and nothing re-checked it.
- `docs/audit-summary.md:261-262` — and then, filed under **"Smaller drift"**: *"the reason
  shown on the blocked purchase controls names a condition that is no longer the true one."*

**That last line is this finding, and it was filed as cosmetic.** It is not cosmetic. It is a
false statement of fact made by a live production service to a customer attempting to pay,
and it sits in front of a complete, tested implementation that has never once executed
outside a test process. Pass 1 found it, described it accurately in nine words, and ranked
it below a 404 size difference. I am recording that as an error of this audit role, not of
the build team.

**So: the answer is "both, and the difference is large."** The remaining work is not to
switch on a route. It is to wire four separate operations to implementations nothing has
ever called in production, and to remove four messages that lie to a paying customer the
moment credentials exist — which they now do, on both deployments.

---

## 4. The four corrections from pass 2

| Correction | Verdict |
| --- | --- |
| SEC-206 / CUST-079 ledger status | **CORRECT** |
| `docs/deployed-evidence.md` production-500 line | **CORRECT in place, but INTRODUCED A NEW INACCURACY and left three contradictions standing** |
| `snapshot_commit` | **INCORRECT — the same off-by-one, moved forward one commit** |
| the "ran in the recorded run" label | **CORRECT, with the sibling label left unfixed** |

**Nothing was marked `passing` that does not pass.** This was the check I was asked to make
hardest, and I made it myself: 2,536 rows are `countable && status == "passing"` at HEAD
(up from 2,534, exactly SEC-206 and CUST-079), and the number of them **not** recorded as
passed in `reports/test-results.json` or `reports/pw.json` is **zero**. The two new rows
`CONN-345` and `CONN-346` are registered `implemented`, `countable: false` — conservative,
since both in fact pass. The full suite at this commit, run by me:

```
numTotalTests 2597 · numPassedTests 2594 · numFailedTests 0 · numPendingTests 3 · success true
```

which matches the commit message's *"2,594 passed, 0 failed, 3 skipped"* exactly.

**`snapshot_commit` is still wrong.** It now reads `"af23e90"` — but the ledger contains
`CONN-345` and `CONN-346`, and I confirmed those ids do not exist in
`git show af23e90:tests/integration/db/resendWebhook.test.ts`. The ledger describes
`33a6ea3`'s tree and names its parent. The value was moved forward one commit and reproduced
the identical error.

**A consequence of that, which is a fresh inaccuracy in the ledger:** inserting 78 lines into
`resendWebhook.test.ts` shifted two existing rows' references, and they were not regenerated:

| Row | `implementation_ref` says | That line actually holds | True line |
| --- | --- | --- | --- |
| CONN-343 | `…resendWebhook.test.ts:653` | `/**` — a comment | 731 |
| CONN-344 | `…resendWebhook.test.ts:668` | **`it('CONN-345 …')`** — a different case | 746 |

`CONN-344`'s citation now points at `CONN-345`'s test. Separately, the two new rows carry
absolute Windows paths (`H:/itisyou-verify/tests/…`) where every other row in the file is
repo-relative.

**The new inaccuracy in `docs/deployed-evidence.md:13`.** It now asserts:

> Production was released at `af23e906` on 19 September 2026 at 22:28:31Z

`docs/audit-pass-2.md:199-201` — added in the same commit — records the opposite:

> I have not verified that the newly deployed build *is* `af23e906`; the deployment list
> carries no commit tag. … **Recorded as unverified.**

The version id and the timestamp are supported. The commit attribution is not, and line 24
compounds it (*"production now runs the same commit"*). A finding recorded as unverified was
restated as fact in the same commit that recorded it.

**Three documents still carry the corrected-away claims** — I read each myself:

- `docs/test-plan.md:360-367` — a section headed **"### 2 failing"** listing `SEC-206` and
  `CUST-079`. Only line 709 of that file was fixed. The more prominent statement, in the
  same file, still contradicts it.
- `docs/deployed-evidence.md:113-114` — *"**Production has not been exercised.** It was
  serving an older build whose intake answered 500."* Uncorrected, in the same file as the
  correction.
- `docs/release-reconciliation.md:142` — *"Production runs an older build than this commit."*
  Untouched. (As it happens this one is now true again — see §5 — but by accident, not by
  intent.)

**The label fix is good.** `scripts/verify-test-cases.mjs` now prints
`executed (status says it ran; unverified here)` and carries a comment saying plainly that
the script never opens a run artefact. I confirmed the script reads exactly three things —
`scripts/scan-secrets.mjs`, `docs/test-cases.json`, and every file under `tests/` — and no
run report. The sibling line `not executed (exists, absent from that run)` still names a run
the script never opened; that half of the finding was not fixed.

`node scripts/verify-test-cases.mjs --strict --gate` exits **0**, `Ledger integrity: PASS`.

One thing neither of us should overlook: `reports/release-gate.json` is the only CI-produced
artefact in the tree and it is from `af23e906` — it still records `passing 2534`, `failing 2`,
`ledger_entries 2648`. **There is no CI gate artefact for `33a6ea3`.** The citable number for
the commit under audit has not been produced by CI at all.

---

## 5. Which commit is actually deployed — FALSE as to `33a6ea3`

No build or commit identifier is exposed anywhere: `/health` returns service, environment,
database and timestamp only; no response header carries a version; and there is no
`BUILD_SHA`-shaped constant anywhere in `apps/` or `packages/`. So the deployed build cannot
be tied to a commit by inspection.

It can be settled by clock, and the clock is decisive:

| Event | Time (UTC) |
| --- | --- |
| `0852238` committed | 22:14:30Z |
| **staging last deployed** | **21:55:58.402Z** (version `46f57e5b-…`) |
| `af23e906` committed | 22:25:34Z |
| **production last deployed** | **22:28:31.907Z** (version `9f8c213d-…`) |
| **`33a6ea3` committed** | **22:40:49Z** |

There has been **no deployment of either Worker since `33a6ea3` was committed.** Production's
last release was twelve minutes *before* the commit existed.

- **Production is not running `33a6ea3`.** It cannot be. The claim that it is, is **FALSE**.
- Production is running something built at or before 22:28:31Z, three minutes after
  `af23e906` was committed — consistent with `af23e906`, but **not proven**, and pass 2
  already recorded that as unverified.
- **Staging is older than both**, by forty-five minutes. `docs/deployed-evidence.md` labels
  its staging evidence `e9524a6`, which is consistent.

**What this means concretely:** `33a6ea3` changes exactly one file of application source —
`apps/app/src/db/resendWebhookPort.ts`, +33 lines, the F1 guard. So **the F1 fix is not
deployed anywhere.** Both live services still contain the version of `claimInboxForRun` whose
defect blocked the release in pass 2.

---

## What this pass could not check

- **The 13 Playwright cases were not re-executed by me.** They need a live deployment and a
  seeded session; they rest on the CI `pw.json`.
- **The deployed build's identity is unverifiable from outside.** Naming which commit is live
  requires an owner action: stamp a commit sha into the Worker (a `wrangler deploy --var`, a
  version tag, or a `/health` field). Until that exists, no audit can confirm what is running.
- **I did not exercise checkout against a deployment.** Driving a real Stripe sandbox session
  needs an authenticated customer session on staging; the conclusion in §3 rests on the code
  being an unconditional refusal plus the configured secrets, both of which I read directly.
- **No audit shows defects are absent.** F2 was found by attacking a path that had just been
  declared safe.

---

## RELEASE VERDICT

**The public website: unchanged — live, accurate, safe to use.**

**Taking payment: still not ready. Release remains BLOCKED.**

The reason has sharpened, and it is no longer "payments are not switched on."

**The product makes false statements about itself to live users, at success status codes, in
front of implementations that would work.** Stripe is configured on production today; a
customer who completes setup and presses subscribe is told it is not, at 503. And anyone on
the internet can POST to `/admin/login` right now and be told at **200** that a sign-in link
is on its way, when no code in the repository sends one — a thing this project's own source
says the brief forbids, and which its customer-side equivalent correctly refuses to do.

That is the same class of defect the product exists to detect in other people's systems.
Shipping it while charging for it is the one outcome this audit role exists to prevent.

### The shortest list that would unblock a paid release

1. **Wire checkout.** Make `POST /app/onboarding/checkout` reach `startCheckout`
   (`apps/app/src/billing/checkout.ts:68`) instead of `customerPort.createCheckout`
   (`customerPort.ts:861`). This is the only item without which no money can move.
2. **Delete the five false messages, or make them conditional.** `customerPort.ts:871`,
   `customerPort.ts:1219`, `ownerPort.ts:640`, `ownerPort.ts:127-128`, and
   `adminPages.ts:24-26`. A refusal may say "not available yet"; it may not say "Stripe is
   not configured" on a deployment where it is, and it may not say "a link is on its way"
   when nothing sends one. **`/admin/login` is the most urgent of the five** — it is live,
   public, unauthenticated, and returns 200. Either wire `sign_in_link` to the transport
   that already exists (`apps/app/src/notifications/templates.ts:293`,
   `notifications/email.ts:67`), or change the sentence. Keep the anti-enumeration
   property; it is correct and worth keeping.
3. **Stop spending the owner's approval on a refund that cannot happen**
   (`ownerPort.ts:704-714`). Refuse before `claimApproval`, not after.
4. **Close F2.** Bind a message id to one enquiry permanently, and cover both the live path
   (B4) and the batch boundary (B2) with tests. Until then a VERIFIED verdict can attach to
   an enquiry that was never acknowledged.
5. **Deploy the audited commit and produce a CI gate artefact for it.** Neither live service
   contains the F1 fix, and there is no `release-gate-33a6ea3…` artefact at all.
6. **Fix `snapshot_commit` and regenerate the stale `implementation_ref`s** (CONN-343,
   CONN-344), and reconcile `docs/test-plan.md:360-367`,
   `docs/deployed-evidence.md:113-114`, `docs/release-reconciliation.md:142` and the
   unverified commit attribution at `docs/deployed-evidence.md:13`.

Items 1–3 are the paid release. Item 4 is the product's core claim. Items 5–6 are the
record, and this project has been explicit that the record is part of the product.

### Owner actions nobody else can take

- **Stamp a commit identifier into the deployed Worker.** Without it, "which commit is live"
  is permanently unverifiable, and three of today's findings existed only because nobody
  could answer it.
- **Decide whether Claude model usage counts against the £100.** `docs/spend.md` §3 raises
  this and it is still undecided; the £0.00 figure is precise only for advertising and
  infrastructure.
- **Confirm that the Stripe keys now on production are intended to be there.** Live
  credentials are configured on a deployment whose commerce path refuses every operation.
  That is a safe combination today only because nothing calls the gateway.

### What is genuinely better, and should be said

The F1 fix is real. I attacked it fourteen ways and thirteen held, including every shape of
the defect I actually reported — a decided run cannot claim, two pending runs cannot both
claim, twenty pending runs cannot hide behind `LIMIT 2`, and a caller cannot pass a `runId`
the port has not verified for itself. The ledger correction was honest and minimal: two rows
moved, both toward the truth, and nothing was marked passing that does not pass. **Four of
pass 1's commerce blockers are genuinely closed**, each proved by running the thing: the
billing-period key — pass 1's headline money bug, still open at the end of pass 2 — is closed
and I closed it the way pass 1 opened it, by running both functions; the commit compiles,
lints and is green; a customer can now actually be issued a signing key; and the notification
wire that pass 1 found missing is in place, with a comment naming the finding. And for the
first time in this project's history, a pass ran against a commit that did not move.

None of that is a reason to take money yet.

---

*Pass 3 was measured against `33a6ea3d926f0b907c3970ff319777715905cb0c`, clean and equal to
`origin/main` throughout; the production and staging Workers and their configured secrets;
both remote D1 databases; and fourteen adversarial tests written by the auditor and run
against the real port from outside the repository.*
