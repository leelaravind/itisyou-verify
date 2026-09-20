# Spend — what is confirmed, what is estimated, what is unknown

Three categories, deliberately kept apart. They have been reported together before and
that was a mistake: one of them is a bank transaction, one is a resource I can see but
whose invoice I cannot, and one is a cost I genuinely cannot measure from here.

Compiled 19 September 2026 at commit `25a41fc`.

---

## 1. Advertising — **£0.00 confirmed**

This is the only figure here I can state without qualification.

| Item | Amount | Evidence |
| --- | --- | --- |
| Campaign spend | **£0.00** | No campaign has ever been activated |
| £15 allocation | **reserved, untouched** | Activation requires a granted, unexpired approval; none has been granted |
| £30 contingency | **untouched, separately gated** | Its own approval gate, never invoked |

The evidence is structural rather than a statement of intent: campaign activation is
gated on consuming an approval, and no approval has been created, granted or consumed.
A specialist is currently wiring that consumption so the gate is enforced by code rather
than by the fact that nobody has pressed the button yet — until that lands, the £0.00 is
true because of what has not happened, not because of what would stop it.

No card details have been requested. No payment method is on file for advertising.

---

## 2. Infrastructure — **no new paid resource created; the invoice is not visible to me**

What I can verify is which resources this project created. What I cannot verify is what
they cost, because I can read the Cloudflare API but not the account's billing.

| Resource | Created by this project | Note |
| --- | --- | --- |
| `verify-itisyou-db-production` (D1) | yes | Tiny; far inside D1's free allowance |
| `verify-itisyou-db-staging` (D1) | yes | Tiny |
| `verify-itisyou-production` (Worker) | yes | |
| `verify-itisyou-staging` (Worker) | yes | |
| `verify.itisyou.app` | subdomain only | The apex domain was already owned; **no registration was purchased** |

Two backup-drill databases were created during a restore test and **both were deleted**;
`wrangler d1 list` confirms only the two above remain for this project.

The account also holds databases for unrelated projects — `itisyou-studio`,
`itisyou-news`, `devyou`, `atsyou`. All are untouched, as instructed.

**What I am not claiming.** I am not claiming this cost £0. Cloudflare's free allowances
for Workers and D1 are generous and this project's usage is small, so the marginal cost is
plausibly zero — but "plausibly zero" is an inference from resource size, not a reading of
an invoice. If an exact figure matters, the owner can read it from the Cloudflare
dashboard's billing page in a way I cannot.

---

## 3. Claude usage — **real, unquantified, and not measurable from inside this session**

This is the category that has been reported loosely before, and the correction is owed.

Earlier in this project I gave estimated token budgets. The owner told me to verify actual
usage limits rather than rely on estimates, and I had to concede that **I cannot see the
account's limits or its usage**. That is still true. Today the session hit its usage limit
and terminated eleven running agents at once — which is direct evidence that the limit is
real and was reached, and still tells me nothing about the monetary figure.

So, plainly:

- Claude usage on this project is **substantial** — a large number of specialist agents, several running concurrently for hours.
- I **cannot** convert that into pounds. Not approximately, not as a range.
- Any number I produced would be invented, and inventing a cost figure for the owner's own budget is exactly the failure this product exists to argue against.

**An open question the owner should decide rather than me.** The £100 budget was framed
around launching the business. It is not clear whether Claude usage is meant to count
against it, or whether the £100 is for advertising and infrastructure with model usage
treated as a separate development cost. I have been treating it as the latter — which is
why every previous report said "£0.00 of £100 spent" — but that was my assumption and it
was never confirmed. If it should count, the £0.00 figure is wrong and the budget position
needs restating.

---

## Update — 20 September 2026, 06:57 UTC

The 19 September position above is left as written. What changed:

### Advertising — still **£0.00 confirmed**, and the shape of the guarantee has changed

| Item | 19 Sept | 20 Sept |
| --- | --- | --- |
| Advertising account | none | **Google Ads `227-475-1523 "ITISYOU Verify"`**, postpay, GBP, Individual UK payments profile |
| Campaign | none | **One draft**, state **drafted** (campaign `281499240699016`, draft `10214818128`, read from the live wizard URL today). Budget step **not saved** — Google's identity challenge blocks it |
| Impressions served | 0 | **0** — a draft cannot serve |
| Spend | £0.00 | **£0.00** |
| Payment method on advertising account | none requested | **Unknown** to this lane. Not visible without the owner's billing screen |
| Ceiling mechanism | structural: nothing existed | **Campaign total budget GBP 12.46 + VAT 20% = GBP 14.95**, once saved. There is **no account-level ceiling** on a UK postpay account |
| £30 contingency | untouched, separately gated | **untouched, separately gated, not referenced as available** |

The full control table, arithmetic and owner steps are in `docs/campaign-packet.md`. The
one sentence that matters for this file: the £0.00 is confirmed because the draft has never
been published, not because any account setting would stop it spending.

### Infrastructure — unchanged, one addition

No new paid resource. One Stripe **sandbox** subscription now exists on staging at
£29.00/month in test mode; no money moved. `STRIPE_MODE` is `test` in every environment.

### Claude usage — unchanged

Still real, still unquantifiable from inside a session, still the owner's decision whether
it counts against the £100.

---

## Summary

| Category | Figure | Confidence |
| --- | --- | --- |
| Advertising | £0.00 | **Confirmed** — nothing activated, gate never invoked |
| Infrastructure | No new paid resource; marginal cost plausibly £0 | **Partial** — resources verified, invoice not visible |
| Claude usage | Unquantified | **Unknown** — not measurable from here |
| **Against the £100 budget** | **£0.00**, on the assumption that model usage is a separate development cost | **Assumption, unconfirmed by the owner** |
