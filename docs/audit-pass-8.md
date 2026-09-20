# Independent completion audit — pass 8

**Audit pass 8 · 20 September 2026.** Earlier passes: `docs/audit-summary.md` (1–3),
`docs/audit-pass-2.md` … `-7.md`.

Measured against `162ff1d` (HEAD), `7e689d5` (`origin/main`, and what production actually
runs), and the two running Workers. The tree moved again during the audit:
`apps/app/src/scheduler/tick.ts` acquired 38 uncommitted lines while I was reading it. I
have noted where that matters and have not reverted anything.

---

## Verdicts at a glance

| Item | Verdict |
| --- | --- |
| S1 — the false sentence, for a live visitor | **CLOSED.** Production serves true copy on every public page. Fetched, not inferred. |
| S5 — `pnpm typecheck` | **CLOSED.** Green. |
| S3 — the spec and the ledger | **CLOSED.** Both corrected; `CUST-124`'s `expected` now matches the test verbatim. |
| S3 — is there a fifth copy? | **YES. `FOOTER_SERVICE_DESCRIPTION`.** Missed by me twice and by two implementer sweeps. True today, by luck of phrasing. |
| S4 — a 500 for a buy button | **CLOSED.** Re-probed through the real Worker: 503 and an honest refusal. |
| S4 — "no card was charged" on every path | **True. The sentence around it is not.** → **S6.** |
| Owner alert — leakage, key, method allowlist, throwing | **Clean on all four.** Probed. |
| Owner alert — does the owner ever get the message? | **NO. → S7.** It has fired twice in the world, failed twice, and cannot fire again. |
| Production's Stripe key state | **ESTABLISHED, without seeing a value. → S8. It is unusable, and a second secret is unset.** |
| `paymentGatewayReadyAlert`, `milestoneAlert` | **Still no caller. → S9.** |
| OWNER-374 fixture change | **Not green-seeking.** Minimal, honest, assertion unchanged. |
| CUST-369 / the `PUBLIC_BASE_URL` gate | **Not green-seeking** — and not a test change at all. Under-tested. |
| Suite, lint, ledger, secret scan | All green in my own run. |

---

## S1 — deployed, and I checked every door an advert opens

Production last deployed `2026-09-20T01:08:29Z`. `reports/release-gate.json` carries
`commit_sha 7e689d5397bd996ad7897723817f14e9e4d66387`, `produced_by github-actions`,
`tree_clean true` — the artefact is for exactly the released commit, so the claim that
`release.mjs` refused until it had the right one is consistent with the evidence.

I fetched every public route the router defines, and grepped each body for every stale
clause:

```
              http  banner  footer  STALE
/               200    1       1      0
/how-it-works   200    0       1      0
/pricing        200    1       1      0
/demo           200    0       1      0
/security       200    0       1      0
/support        200    0       1      0
/terms          200    0       1      0
/privacy        200    0       1      0
/refunds        200    0       1      0
/status         200    0       1      0
/development-story 200  0      1      0
/app            401  (carries the full notice)
```

The `/pricing` line that was false in passes 6 and 7 now reads, on production:

> *"We are not taking payment or activating new workspaces yet: no purchase has been
> completed end to end on a live deployment, and a HubSpot record has never been read back
> from a real portal. Nothing here is broken on your side."*

True. The FAQ answer (`/support`) and the sign-in page carry their corrected versions too.
**Zero occurrences of any stale clause on any production page.** S1 is closed for a visitor,
which is the only sense in which it was ever open.

## S3 — closed, and yes, there is a fifth copy

`docs/product-scope.md` now specifies the *true* notice, kept byte-identical to
`SERVICE_ACTIVATION_NOTICE` with a line saying that if the two differ the code is right.
Good. `CUST-124`'s ledger `expected` now lists the same four assertions the test makes, in
the same order. I diffed them by hand. Closed.

**The fifth copy exists.** `packages/ui/src/content/site.ts`:

```ts
export const FOOTER_SERVICE_DESCRIPTION =
  'ITISYOU Verify is built to read HubSpot and Resend back itself and report what the
   evidence shows. Not yet accepting live verification traffic: we are not taking payment
   or activating workspaces until a purchase has been completed end to end and a HubSpot
   record has been read back from a real portal.';
```

It renders in the footer of **every one of the eleven public pages** — I confirmed it on
production, `footer=1` above, on all eleven. It is the only copy of this fact that appears
on `/terms`, `/privacy`, `/status` and `/refunds`.

It is **true today**, and only because it is phrased as *"until"* rather than as a present
statement. But it enumerates the same two gaps as the banner, and it will be stale the day
either one closes — which is exactly the failure mode S1 was, three times over. It was
last touched in `d477586`, two corrections ago, and survived both of the implementer's
sweeps and both of mine.

So the fact has **six** copies, not four: the banner, `ACTIVATION_UNAVAILABLE_REASON`, the
FAQ answer, the spec, the ledger record, and the footer. A seventh, `PROVIDER_PROOF_NOTICE`,
carries the HubSpot half on its own terms. The instinct to write "one sentence so they
cannot drift apart" keeps producing another sentence.

## S5 — closed

`pnpm typecheck` exits clean. `syntheticPort.ts` has `paymentsMode`. Nothing further.

---

## S4 — fixed, and I proved it the way I broke it

I did not read the diff for this either. I rebuilt my pass-7 probes: harvest the real
rendered form and its real CSRF token from `GET /app/onboarding/review`, carry the cookies
the GET set, POST exactly that through `worker.fetch`, with `globalThis.fetch` stubbed so a
failing Stripe is the only thing the code can see.

| Probe | What Stripe did | Pass 7 | Pass 8 |
| --- | --- | --- | --- |
| P1 | 401 — revoked or wrong key | 500, blank | **503, "no card was charged"** |
| P2 | 400 — no such price | 500, blank | **503, "no card was charged"** |
| P3 | network failure | 500, blank | **503, "no card was charged"** |

One Stripe call each, the generic *"We could not load this page"* absent in all three, the
refusal rendered back on the review page. **S4 is closed.** `STRIPE_PRICE_ID` is shape-checked
in `orderSummary` (`/^price_[A-Za-z0-9]+$/`) as asked.

### S6 — NEW. "No card was charged" is true. "No checkout session was created" is not.

I was asked specifically whether the claim holds on a throw that happens *after* Stripe
created a session. It does — and the other half of the same sentence does not.

`startCheckout` has four throw sites downstream of a successful
`gateway.createCheckoutSession()`: `assertMode(session.livemode, …)`, the
`session.url === null` guard, the `!transition.allowed` guard, and any failure of the
`data.recordOrderStatus` write. All four land in the new catch, which renders:

> *"**No checkout session was created** and no card was charged. Our payment provider did
> not complete the request…"*

Two probes, both through the real Worker:

```
P4  Stripe returns a session with url:null   -> 503, "No checkout session was created" shown
P5  Stripe returns a livemode:true session   -> 503, "No checkout session was created" shown
```

In both, a Checkout Session object exists at Stripe with the id we were handed. The first
clause is false. The implementer's own claim — *"'No card was charged' is true on every
path through it: a Checkout Session is not a charge"* — is **correct**, and is the right
reasoning. The sentence simply asserts one more thing than that reasoning supports.

Customer harm is small: the idempotency key is `…:${order.id}`, so a retry converges on the
same session rather than minting a second. But this product's whole argument is that a
system reporting on its own work is not proof, and the defect class it sells against is a
false statement made at a success-shaped boundary. Saying "no session was created" when one
was is that defect, in the refusal written to avoid it. The fix is one clause: on the catch
path, say only what is known.

---

## The owner-alert pass — audited as a new surface

Five questions were put to me. Four have clean answers. The fifth does not.

### Can customer data, a secret value, an email address or a chat id reach the message?

**No.** The detail is built from `[...billingSecrets.missing].sort()`, and `missing` can
only ever contain the five frozen literals in `BILLING_SECRET_NAMES`. There is no path by
which a value, a workspace, or a contact reaches it. I dumped the exact bytes the transport
posted:

```json
{"chat_id":"55555555",
 "text":"ITISYOU Verify — Payments are not configured on a deployment\n\nThe test
  deployment cannot take payment. Unset or unusable: STRIPE_PRICE_ID, STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_PATH_ID, STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_UNKNOWN_KEY. Only you can
  set these, because the value must not pass through the assistant, a log or a screenshot.
  Set each one with wrangler secret put, then the checkout control appears on the review
  page by itself.",
 "disable_web_page_preview":true}
```

Names only. The chat id is an API parameter, not message text. I also checked the guard
does not accidentally refuse its own alert — `STRIPE_SECRET_KEY` does not trip the
`\bsecret\b\s*[:=]` rule (no word boundary inside an underscored identifier), and
`STRIPE_WEBHOOK_UNKNOWN_KEY` at 26 characters does not trip the unlabelled-blob rule
because that rule requires a digit. Both near misses, both safe.

### Is the key clock-free, and does a different secret send again?

**Yes to both, and the second is the part nobody tested.** `OWNER-497` covers "the same
problem sends once". Nothing covers "a different problem sends again", so I probed it:

```
A1  tick 1: malformed key  -> sent
    tick 2: price removed  -> sent          2 Telegram sends
```

Correct. The key discriminates on the sorted name list, so the alert re-fires when the
*set* of broken secrets changes and not otherwise. That is the right design.

### Does it respect the one-method allowlist?

**Yes.** The pass hands a `NotificationTransport` built by `telegramTransportFromEnv`, and
every send goes through `TelegramTransport.postOne`, which calls `assertMethodPermitted`
before building the URL. No path in the pass can reach `getUpdates` or `setWebhook`. The
founder's poller is safe.

### Can the pass throw and cause a cron retry?

**No.** The whole block is inside `try/catch`, and the only expression outside it —
`checkBillingSecrets(billingEnv)` — is pure and has no throw. I confirmed with a junk
`STRIPE_MODE`, which `billingEnvironmentOf` *does* throw on:

```
A5  STRIPE_MODE='banana' -> no throw, outcome=sent, tick resolves
```

### S7 — NEW. Is the gate right? The gate is right. The alert is unreachable anyway.

`!ready && PUBLIC_BASE_URL` is a defensible gate and mirrors the deletions pass. It is not
what silences the owner.

**What silences the owner is that the alert is at-most-once across its own failures.**
`dispatchNotification` claims the `notification_key` with `INSERT … ON CONFLICT DO NOTHING`
*before* it attempts anything, and every terminal state — `sent`, `failed`, `suppressed` —
settles that same row. The `!claim.inserted` branch is unconditional: it returns
`duplicate` and sends nothing, whatever the previous outcome was. Nothing deletes the row
(retention deletes by `workspace_id`, and owner alerts carry `workspace_id NULL`), nothing
retries it, and the key is derived from a *standing state* rather than an event — so the
state can persist for weeks while its one chance to be announced is already spent.

Two probes, both through `handleScheduled`:

```
A2  tick 1: Telegram not configured        -> suppressed   (key claimed)
    tick 2: owner sets the Telegram secrets -> duplicate
    tick 3: problem still true              -> duplicate    0 sends, ever
A3  tick 1: Telegram answers 500            -> failed, 3 attempts (key claimed)
    tick 2: Telegram healthy                -> duplicate    0 sends, ever
```

`OWNER-499` asserts `outcome: 'suppressed'` and records it as a pass. That case is looking
directly at the defect and calling it the intended behaviour.

**And it has already happened, on both deployments.** Read from the live databases, with
read-only `SELECT`s:

```
verify-itisyou-db-production   2026-09-20T01:08:55Z
  notification_key  authentication_required:billing_secrets:test:
                    STRIPE_SECRET_KEY,STRIPE_WEBHOOK_UNKNOWN_KEY
  state             failed
  attempt_count     3
  provider_status   sending_service_unavailable

verify-itisyou-db-staging      2026-09-20T01:15:55Z
  the same key, the same state, the same count.
```

One row each, nothing since, because nothing can be. **The feature has fired exactly twice
in the world, failed both times, and by design can never fire again for this condition.
Zero messages have reached the owner's phone.** A channel wired on the grounds that "a ping
five minutes later is worth more than a dashboard row they will check tomorrow" has
delivered neither: no ping, and a dashboard row saying `sending_service_unavailable` with
no cause attached.

This is the project's dominant defect class in a new costume. Pass 7's version was *correct
code reached by nothing*. This is *correct code, now reached, that produces nothing and
cannot be made to try again*.

The uncommitted change to `tick.ts` wraps the transport to `console.log` the provider status
on a failed attempt. That is a real improvement for an operator reading logs. It does not
make the owner reachable and it does not unburn the two keys that are already spent. Both
deployments need the existing rows cleared, or the design needs a retry path — a
standing-condition alert whose only send attempt has failed is not "at most once", it is
"at most never".

### S9 — minor, and familiar. Two of the three builders still have no caller.

`grep -rn "paymentGatewayReadyAlert\|milestoneAlert" apps/app/src` returns only comments.
`paymentGatewayReadyAlert` is the one the commit message calls *"written for this exact
situation by name"* and the one the founder asked for; `milestoneAlert` is the one the
routing table argues for at length as "the row easiest to drop precisely because nothing
breaks when it is missing". Both are still dropped. The file was fixed at one of three call
sites and reported as fixed.

---

## S8 — NEW. Production cannot take money, and I established it without seeing a value

This was the open question in the brief. It is answered, and the answer is worse than
"unverified".

`wrangler secret list` returns **names only**. Both Workers hold the identical fifteen:

```
ANALYTICS_SALT  CREDENTIAL_KEY_V1  EVENT_SIGNING_ROOT_KEY  HUBSPOT_TEST_TOKEN
OWNER_BOOTSTRAP_TOKEN  RESEND_API_KEY  RESEND_FROM_ADDRESS  RESEND_WEBHOOK_UNKNOWN_KEY
SESSION_SIGNING_KEY  STRIPE_PRICE_ID  STRIPE_SECRET_KEY  STRIPE_WEBHOOK_PATH_ID
STRIPE_WEBHOOK_SECRET  TELEGRAM_BOT_TOKEN  TELEGRAM_OWNER_CHAT_ID
```

**`STRIPE_WEBHOOK_UNKNOWN_KEY` is absent from both.** It is one of the five
`checkBillingSecrets` requires.

And the production alert key names `STRIPE_SECRET_KEY` *alongside* it. The name is in the
secret list, so the value is present — which means it reached `checkBillingSecrets` and was
counted missing by the second test, `!secretKeyIsUsable(secretKey)`. **Production's
`STRIPE_SECRET_KEY` is malformed, exactly as staging's is.** No value was seen by me or by
anything I ran; the deployment's own alert key is the evidence.

Two consequences, one of them not about checkout at all:

1. **Production cannot complete a purchase.** The known staging defect is a production
   defect too. Only the owner can fix it, with `wrangler secret put`, and the value must not
   pass through the assistant.
2. **The tick's money pass has never run on production.** `runMoneyMaintenance` is gated on
   `checkBillingSecrets(billingEnv).ready`, which is false and has been false since the pass
   was wired. Allowance-period reconciliation — the repair written because "a workspace
   showing 2 of 10 used could sell eight runs nobody paid for" — is unreachable on the only
   deployment where it would matter. A pass wired to fix an unreachable function is itself
   unreachable, for a reason nobody was told, because the alert that would have told them is
   S7.

---

## The two fixture changes: is either of them fitting a test to the code?

**OWNER-374 — no.** The property under test is stated in its own title: *"the same row
reads ok, so it is a measurement not a constant"*. The assertion (`row?.state === 'ok'`) is
unchanged. `checkBillingSecrets` deliberately tightened from present to present-and-usable,
which made the old placeholder `'present-not-a-credential'` a correct failure. Only the two
secrets that gained a shape check were changed; the other three placeholders were left
exactly as they were. That is the minimal repair, and leaving the other three alone is the
tell that it was done honestly rather than by making everything well-formed until the test
went green. Assembling the synthetics at runtime to keep the secret scanner quiet is the
same pattern used elsewhere in the tree. **Not green-seeking.** One note: the title still
says "with both secrets present", when what it now requires is present *and* well-formed.

**CUST-369 — no, and it is not a test change at all.** `tests/integration/support/notification-wiring.test.ts`
was not touched in `7e689d5`. The `PUBLIC_BASE_URL` gate is a change to production code that
happened to restore a test asserting `s.rows()` is empty on an unconfigured deployment. The
behaviour is right — the deletions pass is gated identically, and both deployed environments
set `PUBLIC_BASE_URL` in `wrangler.jsonc` `vars`, so nothing real is silenced by it.
**Not green-seeking.**

The note here is coverage, not honesty: the gate's behaviour is asserted only incidentally,
by a case about billing notifications, and `OWNER-495..499` do not cover it at all. A
production Worker that lost its `PUBLIC_BASE_URL` would silently stop alerting its owner and
no case would notice.

### The new cases, judged as tests

`OWNER-495` is the one that matters and it is well made: it asserts an HTTP call was made to
`/sendMessage` **by a tick**, not by a test calling the sender. That is precisely the
assertion whose absence let the channel stay unreachable, and it would have caught the
original defect. `OWNER-496` and `OWNER-498` are sound. `OWNER-497` tests the half of
at-most-once that is good news and not the half that is bad news. `OWNER-499` asserts the
state that burns the key and calls it a pass. Nothing covers "a different secret sends
again" — which works, but I had to find that out myself.

`BILL-617..620` are honest cases and `BILL-620` (the provider's wording never reaching the
customer) is a good instinct. They test the port, not the route, so they would not have
caught a route-level 500; my probes cover that gap and it holds.

---

## Nothing else broke

- **Full suite, my own run, probes removed: 2,628 passed, 0 failed, 3 skipped**, 173 files.
  Matches the implementer's number.
- **`eslint --max-warnings=0`**: clean.
- **`pnpm verify:cases`**: `Ledger integrity: PASS`, 0 reconciliation defects, 2,665 ids in
  both. (`CUST-124`'s `implementation_ref` still points at line 89 for a test at line 98 —
  endemic, cosmetic, unchanged.)
- **`pnpm scan:secrets`**: clean, 698 tracked files.
- **Production re-probed**: `/owner` 404, unsigned `POST /api/v1/events` 401, `/health`
  reachable and reporting D1 up.
- **`release.mjs`** runs typecheck, lint, the full suite, ledger, story, secret scan over
  tree *and* history *and* the built bundle, claim scan, migrations, deploy, a post-deploy
  smoke check and a claim scan against the pages as actually served. That is a real gate.
  The pass-7 finding that CI's `gate` job carries no `needs: verify` is **unchanged** — the
  artefact can still be minted at a SHA whose checks failed — but production is protected
  because `release.mjs` re-runs all of them locally. Worth fixing; not a blocker.

---

## RELEASE VERDICT

**BLOCKED — and for the first time the blockers are entirely about the deployment rather
than about the code.**

The code is in the best state it has been in eight passes. A customer can reach a buy
button, press it, and be handed to Stripe; when Stripe refuses they now get a refusal
instead of a 500; the tree typechecks; the gate ran and produced an artefact for the exact
commit that shipped. Every one of pass 7's four findings is genuinely closed.

What blocks a paid release:

1. **S8 — production cannot take money.** `STRIPE_SECRET_KEY` is present and unusable;
   `STRIPE_WEBHOOK_UNKNOWN_KEY` is unset. Owner action, `wrangler secret put`, value never
   through the assistant. Until then no purchase can complete anywhere, and the tick's money
   pass does not run on production at all.
2. **S7 — the alert that exists to report exactly that is spent.** Both deployments hold a
   `failed` row for the key, and no tick will ever try again. Clear those two rows and give
   a standing-condition alert a retry path, or the channel is decorative.
3. **The end-to-end purchase still has not happened**, and now demonstrably cannot until
   (1). The sentence *"no purchase has been completed end to end"* stays up.
4. **S6 — narrow the refusal sentence.** Drop "No checkout session was created" from the
   catch path; keep "no card was charged", which is the true and important half.
5. **S9 — wire `paymentGatewayReadyAlert`**, or delete it. It is the alert the owner asked
   for by name and it still has no caller.

---

## ADVERTISING VERDICT

**Yes.**

I said in pass 7 that deploying `44f410c` was all that stood between here and an advert I
would sign off. It was deployed, inside `7e689d5`, through the gate rather than around it,
and I have verified the result by fetching every public page rather than by reading the
diff. Every claim a visitor from an advert can reach is now true: the landing page, the
price page, the FAQ, the sign-in page and the footer of all eleven pages. No stale clause
survives anywhere on the production Worker. The ad copy in `docs/advertising.md` and
`docs/campaign-packet.md` is byte-identical to what I signed off in pass 7.

The product also still tells visitors, prominently and in the loudest tone it has, that it
is not taking payment — which, given S8, is not merely honest but accurate about today.
That alignment is the whole reason this verdict can be yes while the release verdict is no.

Two conditions attach, and both are about the day this stops being true:

- **S4 stays closed.** The advert brings people to a page that will one day carry a live buy
  button. It must never answer 500. It does not today, and I proved it today.
- **S6 first, and S8 first.** The day the notice comes down and the button goes live, the
  refusal wording must be narrowed to what it can support, and the deployment must actually
  be able to take money. An advert that brings a buyer to a button in front of a key that
  cannot work is the same defect as the false sentence, moved one click later.

`FOOTER_SERVICE_DESCRIPTION` is not an advertising defect today. It will be the first thing
to go stale on the day either gap closes, and it is on every page including the legal ones.
Correct it in the same commit as the banner, or it becomes the sixth false copy of a fact
that has now been wrong in five places across three passes.

---

*Pass 8 was measured against `162ff1d` with one uncommitted change that appeared mid-audit,
against `7e689d5` as the commit production actually serves, against the production and
staging Workers and their public pages, against the production and staging D1 databases by
read-only query, against the Cloudflare secret **name** lists for both Workers, and against
eleven adversarial probes written by the auditor: five replaying a real rendered checkout
form through the real Worker against five different Stripe failures, and six driving
`handleScheduled` through the owner-alert pass's key lifecycle. No probe sent a byte to a
real provider. The probe files were deleted after the run and are not part of the suite. No
secret value was read, requested or inferred beyond the shape conclusion the deployment's
own alert key states.*
