# Campaign readiness packet — Google Ads Search, September 2026

**Prepared by:** Growth lane, 20 September 2026, 06:57 UTC.
**Campaign state at 09:20 UTC, 20 September: SUBMITTED by the owner (07:55 UTC), found EMPTY, being completed.**
The published campaign carried no keywords and no ads. Since then the lead has saved the five
exact-match keywords (§3.2) and the eight negatives; the responsive search ad (§3.3) is being
entered. Google's status: **"Not eligible — low search volume, under review."** Not approved.
Not delivering. **Spent to date: GBP 0.00.**

**Budget corrected 08:40 UTC: GBP 12.46 → GBP 12.25.** See the fee note below the billing
table: Google adds a 2% UK Digital Services Tax fee on top of media spend and VAT applies
to it, which the 12.46 figure had not allowed for.

This is the one page the owner reads and approves in a sitting. Everything below is either
read from the live Google Ads wizard, the live databases, or the build record in
`docs/advertising.md` sections 11–12, and each fact says which. Where a value could not be
read today it says **unknown** or **read back on screen**, never a guess.

It supersedes the 19 September Reddit packet that previously lived in this file. That
packet was never approved; the platform decision moved to Google Ads on 20 September once
the live wizard showed a campaign total budget exists for Search
(`docs/advertising.md` §12).

---

## Read from the billing account on 20 September 2026, not assumed

Opened `Billing > Settings` and `Billing > Summary` on account 227-475-1523 in the owner's
authenticated session. What the account itself says:

| Setting                               | Value on screen                              | What it means for the cap                                                                       |
| ------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Payer account type                    | **Individual**                               | Not a VAT-registered business                                                                   |
| Country/region                        | United Kingdom (GB)                          | UK VAT applies                                                                                  |
| United Kingdom tax info               | **blank** (no VAT number entered)            | Google adds UK VAT at the standard rate to the net spend                                        |
| How you pay                           | **Postpay**, billed on the 1st of each month | Charges follow activity; nothing is prepaid                                                     |
| Payment threshold                     | **GBP 7.50**                                 | A billing _trigger_, not a spending limit: when the balance reaches it, a charge is taken early |
| Primary payment method                | Mastercard, last four 9563                   | The card that will be charged                                                                   |
| Backup payment method                 | none                                         | Irrelevant to the cap                                                                           |
| Balance / net cost / payments to date | GBP 0.00 / GBP 0.00 / none                   | Nothing has ever been spent                                                                     |
| Account-level spending limit          | **none exists** on any billing page          | The only ceilings are the campaign's total budget and end date                                  |

**So the arithmetic is now anchored to the account, not to a guess:** the campaign total
budget is a _net_ figure; Google adds UK VAT for a UK individual payer with no VAT
registration. GBP 12.46 net at the 20% standard rate is GBP 14.95 gross (14.952), inside the
GBP 15.00 all-in authorisation with 5p to spare. A campaign total budget is a hard ceiling
on net spend for the campaign's lifetime (unlike a daily budget, which Google may exceed
on a given day), and the end date of 30 September stops delivery regardless.

**Added 08:40 UTC — the fee the table above could not show.** Google's own help page
(support.google.com/google-ads/answer/9750227, read in the owner's session) states that for
ads served in the United Kingdom a **2% Digital Services Tax fee is added on top of** the
campaign's spend, appears as a separate line on the invoice, and that **VAT applies to the
fee as well**. So GBP 12.46 net would have billed 12.46 × 1.02 × 1.20 = **GBP 15.25**, over
the cap. The campaign total was therefore lowered to **GBP 12.25**: 12.25 × 1.02 = 12.495,
× 1.20 = **GBP 14.99**. Saved and verified across a reload; the Overview header reads
"Budget: £12.25/campaign". The campaign _name_ still says "capped GBP 12.46 net"; the
budget control, not the name, is what caps spend.

What this does NOT establish: whether the VAT rate the invoice actually applies is exactly
20% and not a different figure. That can only be read from the first invoice, and there is
no invoice yet because nothing has been spent. If the first document shows a different
rate, the campaign is paused before the second.

## 1. The spending authorisation, restated

**GBP 15.00 all-in, including the UK DST fee and UK VAT at 20%.** Not GBP 15 of media
plus tax. The campaign is built to **GBP 12.25 net**, which is **GBP 14.99 gross**. Nothing
in this packet proposes more, and nothing in this packet may be read as a request for more.

```
media (campaign total budget)      12.25
UK DST fee 2%   12.25 x 0.02   =    0.245  ->  0.25 to the penny
subtotal                           12.50
VAT at 20%      12.50 x 0.20   =    2.499  ->  2.50 to the penny
gross                              14.99   (14.994 exactly)
headroom under GBP 15.00            0.01
```

(Superseded 08:40 UTC: the packet previously carried 12.46 net / 14.95 gross, which omitted
the DST fee. A daily budget was never used and is never to be used in place of the
campaign total.)

The earlier daily-budget derivation (GBP 0.41 x 30.4 = 12.46 net, 14.96 gross) is
recorded in `docs/advertising.md` §11 and is superseded: with a campaign **total** budget
there is no monthly multiplier and no reliance on Google's overdelivery guarantee.

VAT is assumed to apply because the payments profile is an **Individual** UK profile
(`docs/advertising.md`, "Decision two"). If the owner is VAT-registered and enters the VAT
number, the reverse charge removes the 20% and the campaign simply spends GBP 12.46 — the
safe direction to be wrong in. The media budget is **not** raised to fill that gap.

---

## 2. The four states, and which one this is

| State          | Meaning — exactly                                                                                  | Today |
| -------------- | -------------------------------------------------------------------------------------------------- | ----- |
| **drafted**    | Exists only as a Google Ads draft. Cannot serve. Cannot spend. Google has not reviewed it.         | **X** |
| **submitted**  | The owner has pressed Publish; Google's policy review is running. Still cannot serve.              |       |
| **approved**   | Google's review returned "Eligible". Can serve as soon as it is enabled and the start date passes. |       |
| **delivering** | Has served at least one impression. Money can now be accruing.                                     |       |

These four words are used in these four senses only, here and in every report. A draft is
not "live". A submitted campaign is not "approved". An approved campaign that has served
nothing is not "delivering". The line between **approved** and **delivering** is the line
between GBP 0.00 and a bill.

Today the campaign is **drafted**, and the draft is not even complete: the budget step has
not been saved (section 5).

---

## 3. The campaign as built

Read today from the URL of the open Google Ads wizard tab, unless marked otherwise.

| Field              | Value                                                | How known                                                                               |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Google Ads account | **227-475-1523 "ITISYOU Verify"**                    | Account chooser, read on screen today (the older account 129-611-7160 is also listed)   |
| Campaign name      | **Verify search - Sept 2026 - capped GBP 12.46 net** | Wizard URL, today                                                                       |
| Campaign id        | **281499240699016**                                  | Wizard URL, today                                                                       |
| Draft id           | **10214818128**                                      | Wizard URL, today                                                                       |
| Objective          | Website traffic                                      | Build record §11                                                                        |
| Campaign type      | Search                                               | Build record §11–12                                                                     |
| Bidding            | Maximise clicks, **max CPC GBP 1.20**                | Build record §11; **read back on screen** — the §12 rebuild did not restate the figure  |
| Dates              | **20 Sept 2026 – 30 Sept 2026**                      | Build record §11; **read back on screen** — same reason                                 |
| Locations          | United Kingdom                                       | Build record §11                                                                        |
| Languages          | English                                              | Build record §11                                                                        |
| Landing page       | `https://verify.itisyou.app/demo`                    | Build record §11 — see section 3.3 on the missing UTM                                   |
| Budget             | **Campaign total budget GBP 12.46 — NOT YET SAVED**  | §12: saving it raised Google's identity challenge; footer read "Changes failed to save" |

The ids recorded in `docs/advertising.md` §11 (campaign `281499240660433`, draft
`10214870512`) belong to the first attempt, which did not persist ("Drafts in progress: 0",
§12). The ids above are the rebuild's. **Whether this draft has persisted is unknown until
the owner sees it in the Drafts list** — the first thing to check in section 6.

### 3.1 Networks and settings — on / off

| Setting                         | State          | Why                                                                                        |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| Google Search                   | **ON**         | The only network with search intent                                                        |
| Google search partners          | **OFF**        | On by default. Parked domains dilute a GBP 12.46 budget                                    |
| Google Display Network          | **OFF**        | On by default. Cheap, low-intent clicks would consume the whole allowance                  |
| Enhanced conversions            | **OFF**        | On by default. Sends customer-provided data to Google — incompatible with the privacy page |
| Conversion tracking             | **NOT SET UP** | Needs a Google tag on the site — a third-party script and an undeclared subprocessor       |
| AI Max                          | **OFF**        | Google may not rewrite the copy                                                            |
| Text customisation              | **OFF**        | Confirmed on screen today: "Text customisation and Final URL expansion turned off"         |
| Final URL expansion             | **OFF**        | Same line                                                                                  |
| Audience segments / remarketing | **NONE**       | Nothing that could profile a visitor                                                       |

Visits are measured by the deployment's own first-party counter (`visit_sessions` table),
not by Google.

### 3.2 Keywords — exact match only, and negatives

```
[did my zapier automation actually run]
[check if automation created crm record]
[verify n8n workflow completed]
[automation silently failed no error]
[how to know if workflow actually worked]
```

Negatives: `free`, `tutorial`, `course`, `jobs`, `salary`, `what is automation`,
`zapier login`, `make.com login`.

Exact match only. Broad match on GBP 12.46 is how the money leaves in an hour.

### 3.3 The ad — verbatim, as entered in the rebuild (§12)

| Slot          | Text                                                                                 | Chars |
| ------------- | ------------------------------------------------------------------------------------ | ----- |
| Headline 1    | Did the automation do it?                                                            | 25    |
| Headline 2    | Check the outcome, not logs                                                          | 27    |
| Headline 3    | We read Resend back ourselves                                                        | 29    |
| Headline 4    | Four answers, never a fifth                                                          | 27    |
| Headline 5    | Evidence, not a green tick                                                           | 26    |
| Description 1 | Your workflow says success. We read the outcome back from Resend ourselves.          | 75    |
| Description 2 | Verified, failed, unverified, pending. Missing evidence is never reported as a pass. | 84    |
| Description 3 | One workflow. HubSpot and Resend only. We say plainly what we could not check.       | 78    |

Every line was checked today against the live staging database: Resend read-back
evidence exists (three `provider_readback` rows), the four statuses are the only ones the
schema admits (`CHECK (status IN ('PENDING','VERIFIED','FAILED','UNVERIFIED'))`), and
"HubSpot and Resend only" names the two providers the `connections` table permits. No
headline claims HubSpot read-back, because no HubSpot evidence row exists anywhere.

Google's own pre-filled copy — including the headline "Verification Of Fake Facts" — was
discarded in full (§12). The three "off" settings above are what stop it coming back.

**Final URL — one correction needed on screen.** The landing page as built carries no UTM
parameters. The first-party counter attributes a session to a campaign only when
`utm_campaign` is present (`apps/app/src/growth/analytics.ts`, `attributeSignup` refuses
with `no_campaign_utm`), and the packet validator in `approval.ts` rejects a destination
without one. Before enabling, set the final URL to:

```
https://verify.itisyou.app/demo?utm_source=google&utm_medium=cpc&utm_campaign=verify_search_2026_09
```

This changes attribution only. It changes nothing about spend.

---

## 4. Every spending control, what it caps, and how it was verified

Read this table knowing one thing first: **a UK Google Ads account is postpay and has no
account-level ceiling.** Prepay is not offered in the United Kingdom
(`docs/advertising.md` §3, Google's payment-settings page read 19 Sept). Google extends
credit and charges the card at a payment threshold or monthly. There is no balance to run
out. An "account spending limit" exists only for monthly-invoiced accounts, which this is
not.

**The real ceiling is therefore: the campaign total budget (GBP 12.46) plus VAT, and it
holds only while (a) that budget is saved with that figure, (b) the campaign has a fixed end
date, and (c) exactly one campaign exists in the account.** Nothing else in the account
caps anything.

| Control                                                      | What it actually caps                                                                     | What it does NOT cap                                                                                          | Verified how                                                                                                                                                                        | Status                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Campaign total budget GBP 12.46**                          | Media spend for this campaign over its whole run                                          | VAT; any second campaign; a later edit of the figure                                                          | The control was seen in the live budget step (§12); both removed legacy campaigns in the old account used it (baseline entry); Google's help states billed spend will not exceed it | **NOT SAVED** — identity challenge       |
| **Fixed end date 30 Sept 2026**                              | Duration; the total budget cannot be stretched by an open-ended run                       | Spend within the window (the total budget does that)                                                          | Build record §11; Google requires at least three days for a total budget                                                                                                            | Configured; read back on screen          |
| **Max CPC GBP 1.20**                                         | The price of any single click                                                             | Total spend — it is a rate, not a sum                                                                         | Build record §11                                                                                                                                                                    | Configured; read back on screen          |
| **Search partners OFF, Display OFF**                         | Dilution into cheap, wrong-audience inventory                                             | Nothing monetary — a quality control, not a cap                                                               | Build record §11                                                                                                                                                                    | Configured                               |
| **One campaign in the account**                              | Keeps the total budget the only exposure                                                  | It is a discipline, not a setting. Google will not stop a second campaign                                     | Old account: three legacy campaigns removed (baseline). New account: **campaign count not read today** — read the Campaigns list                                                    | **Read on screen**                       |
| **Account-level ceiling**                                    | **None exists.** Postpay, UK                                                              | —                                                                                                             | `docs/advertising.md` §3 and "Decision one"                                                                                                                                         | **Not available — do not assume one**    |
| **Payment method on file**                                   | Whether the campaign can serve at all                                                     | Spend, once one is present                                                                                    | **Unknown** — not visible to this lane; owner reads Billing > Settings                                                                                                              | **Unknown**                              |
| **Code-side gate** (`campaigns` table, approval consumption) | What _our_ software will record and act on                                                | **Anything the owner clicks inside Google Ads.** Our gate is not between the owner and Google's Enable button | Production `campaigns` table read today: **0 rows**. Activation-consumes-approval is LOCAL-TESTED only (`docs/gap-register.md`)                                                     | Not a spending control for this campaign |
| **Owner "pause ads" switch**                                 | Nothing yet — the gap register records the switch writes a row that no middleware reads   | Everything                                                                                                    | `docs/gap-register.md`, "Owner pause switches actually suspend — OPEN"                                                                                                              | **Do not rely on it**                    |
| **The GBP 30 contingency**                                   | Out of scope. Separately gated, untouched, and not referenced by this packet as available | —                                                                                                             | `docs/spend.md`                                                                                                                                                                     | Not part of this campaign                |

Residual risk, stated plainly: the campaign total budget bounds this campaign. It does not
stop a second campaign being created, and it is only as good as the figure saved in it. The
owner is the control for both.

---

## 5. What blocks the draft from being complete

One thing. Saving the budget raised Google's **"Confirm it's you"** identity challenge
(§12). That is an authentication step on the owner's Google account, and no agent may pass
it. Until it is passed:

- the budget figure is not stored, and the wizard footer showed **"Changes failed to save"**;
- the campaign cannot be published, so it cannot move past **drafted**;
- **it cannot spend.**

A second lane was driving the wizard tab at the moment this packet was read (the step
changed between two reads), so the current footer state was not re-read. That does not
change the state: nothing can be saved without the challenge.

---

## 6. What the owner must personally do, in order, and what the screen will show

Nothing here has been done. Each step is the owner's.

1. **Open `ads.google.com`.** You will see the account chooser listing two accounts:
   `129-611-7160` and **`ITISYOU Verify 227-475-1523`**. Choose the second. (The first is
   the old INR prepay account; it has zero campaigns and must stay that way.)
2. **Campaigns > Drafts.** You should see **"Verify search - Sept 2026 - capped GBP 12.46
   net"**. If the list says **"Drafts in progress: 0"**, the rebuild did not persist either
   — stop, and tell the lead; the campaign must be rebuilt from section 3 of this page
   before anything else.
3. **Open the draft.** Walk every step and compare against section 3 and 3.1. Fix anything
   that differs. Set the final URL from section 3.3. Do not change the budget figure.
4. **Budget step.** Choose **"Campaign total budget"** (not "Average daily budget") and
   enter **12.46**. Google will recommend a much larger figure — on 20 Sept it recommended
   GBP 23.02 for a _day_, nearly twice the entire authorisation. Ignore it.
5. **The "Confirm it's you" dialog** will appear on saving. Complete it on your own device.
   Then confirm the footer reads **"All changes saved"** and the budget still reads 12.46.
6. **Billing > Settings.** Read and record: payment setting (expect "Automatic payments",
   i.e. postpay), payments profile type (Individual), VAT number field (enter it if you
   are VAT-registered), and whether a payment method is on file. Without a card the
   campaign cannot serve; with one, the ceiling in section 4 is the only ceiling.
7. **Stop here for the day.** Leave the campaign as a **draft**. Do not press Publish in
   the same sitting as the budget change. Paste the read-back (steps 3–6) into
   `docs/advertising.md` §13 so the record matches the account.
8. **Later, if you still want to run it:** Publish moves the state to **submitted**. Google
   reviews; "Eligible" in the Status column means **approved**. The first non-zero
   impression in the Campaigns table means **delivering**, and the section 1 arithmetic is
   now the bill to expect.
9. **After the end date** (30 Sept): read Cost in the Campaigns table and the invoice under
   Billing. Report billed, accrued and committed separately. Anything not visible is
   reported as **unknown**, never as zero.

---

## 7. The honest expected outcome

**This budget buys a handful of visits, not ten.**

- At the max CPC of GBP 1.20, GBP 12.46 is **at most 10 clicks** — that is a ceiling, not
  a forecast.
- Published UK B2B SaaS search CPCs run GBP 3–8.72 (`docs/advertising.md` §5, secondary
  sources). At those rates GBP 12.46 is **one to four clicks**.
- Landing sessions run at roughly 80–90% of clicks (server-side counting), so **one to
  three observed sessions** is the realistic range.
- A campaign of this size on competitive keywords will frequently be "limited by budget"
  and enter a fraction of the auctions it is eligible for. Zero impressions is a possible
  outcome.

Visits, signups and customers will be reported as three separate numbers and never summed.
A visit is not interest, and interest is not a customer. The organic route in
`docs/organic-launch.md` reaches the same people for GBP 0.00 and remains the recommended
first move.

---

## 8. Visit attribution — the external sessions on production, read today

Read-only query of the production `visit_sessions` table, 20 Sept 2026 06:50 UTC. The
counter wrote nothing at all before 03:33 UTC today (the database port did not exist —
`docs/organic-launch.md` §0.6), so this is the entire history.

**13 rows: 5 `external`, 7 `bot_suspected`, 1 `internal_test`, 0 `unknown`.** No row
carries any UTM parameter. The row stores no user agent, no referrer and no address (by
design), so attribution can only come from the path, the timing, and evidence outside the
table.

| First seen (UTC) | Landing path         | Class         | Views | Verdict                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------- | ------------- | ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 03:33:37         | `/`                  | bot_suspected | 29    | project tooling                    | First row ever written, 4 min after the counter's deploy commit `b1956b5` (03:29:18 UTC). Ran until 06:20 UTC over the project's own pages. Not a visitor.                                                                                                                                                                                                                                                                                                                                                         |
| **03:33:40**     | **`/demo`**          | **external**  | 1     | **unattributed**                   | Landed **3 seconds** after the tooling row above, 4 min after the counter went live, with no UTM. The gap register (commit `08786a7`, 04:07 UTC) records this row as landing "inside this project's own working window on a page it was checking". That is the author's account, not proof. Consistent with the operator opening `/demo` in a browser before the `verify_internal` cookie existed (cookie correction landed `a77290d`, 04:01 UTC). **Not a genuine external visitor on the evidence held.**        |
| 03:42:28         | `/`                  | internal_test | 2     | operator, cookie-marked            | The only cookie-marked session; matches the correction test the gap register describes as confirmed on production.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 04:17:00         | `/privacy`           | bot_suspected | 1     | crawler or tooling                 | UA carried a crawler marker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **04:55:46**     | **`/demo`**          | **external**  | 1     | **unattributed**                   | No UTM. Inside the project's working window (commits at 04:07 and 05:56 UTC either side; a deploy of the Stripe-webhook fix was in progress). A scripted `bot_suspected` fetch of the same `/demo` path followed at 04:59:04. Agent sessions on this machine drive the owner's own Chrome, whose page views are classified `external` unless the internal cookie is present in that profile — **whether it is present is unknown**. **Not a genuine external visitor on the evidence held; not ruled out either.** |
| 04:59:04         | `/demo`              | bot_suspected | 1     | tooling                            | Crawler-marked UA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 05:04:08         | `/how-it-works`      | bot_suspected | 1     | tooling                            | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 05:36:12         | `/development-story` | bot_suspected | 1     | tooling                            | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 05:37:42 (x2)    | `/how-it-works`      | bot_suspected | 1+1   | tooling                            | Two hashes 0.3 s apart — two UA or language variants of the same check.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 05:53:39         | `/wp-json/batch/v1`  | external      | 2     | **automated probe, not a visitor** | A WordPress REST endpoint this site has never had. Browser-shaped UA, so classified `external`, but nobody types this path. Counted as external by the classifier; not counted as a visitor by anyone reading this.                                                                                                                                                                                                                                                                                                |
| 05:55:42         | `/`                  | external      | 1     | unattributed                       | No UTM. 63 s before commit `c9267bc`. Two different hashes 11 s apart (below) — two devices, two browsers, or a UA change. Nothing more can be said from the row.                                                                                                                                                                                                                                                                                                                                                  |
| 05:55:53         | `/`                  | external      | 1     | unattributed                       | As above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Verdict on the two `/demo` sessions the lead asked about: both unattributed.** Neither is
reported as a genuine external visitor. Neither is proven to be internal. **Genuine,
attributable external visits today: 0.** Sessions classified external: 5, of which one is a
vulnerability probe by its path and four cannot be attributed from what the table holds.

**What would settle each one**, in order of strength:

1. **Cloudflare Workers Logs** for `verify-itisyou-production` (observability is enabled in
   `wrangler.jsonc`). The invocation log for `GET /demo` at 03:33:40.752Z and at
   04:55:46.214Z carries the user agent, referer, country and colo. A UK Chrome UA with no
   referer during the working window points inward; a non-UK country or a referer from a
   third-party site points outward. Owner: Workers & Pages > verify-itisyou-production >
   Logs, filter by time.
2. **The operator's own Chrome history** for `verify.itisyou.app/demo` at 04:33:40 and
   05:55:46 **local (BST)**. An attempt to read it from this lane was refused by the
   permission classifier and was not retried; it is the owner's to look at.
3. **Whether the `verify_internal=1` cookie is present in the Chrome profile agents use.**
   If it is, agent page views are already excluded and the two rows are less likely to be
   ours. If it is not, every agent page view since 03:33 UTC has been counted as external.

Until one of those is read, the number reported anywhere is **0 genuine external visits**,
with five external-classified sessions listed and qualified as above.

---

## 9. Approval

Approving this packet means: the owner has read sections 1–7, accepts the state as
**drafted**, will perform section 6 personally, and understands the expected outcome in
section 7. It does not enable anything. It does not spend anything. Any change to budget,
dates, destination, audience or creative after approval invalidates it.

- [ ] I have read the arithmetic in section 1 and accept GBP 12.46 net / GBP 14.95 gross as the ceiling, with no request to raise it.
- [ ] I understand the account is postpay with no account-level ceiling, and that the campaign total budget plus VAT is the only cap.
- [ ] I understand the campaign is **drafted**, its budget is unsaved, and only I can pass the identity challenge.
- [ ] I will complete section 6 in order, and will not publish in the same sitting as saving the budget.
- [ ] I accept that this budget buys a handful of visits, not ten, and possibly none.
- [ ] I understand genuine external visits today are 0, and that five external-classified sessions exist unattributed.

**Signed:** ______________________ **Date:** ______________
