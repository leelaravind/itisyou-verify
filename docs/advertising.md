# Advertising feasibility — can £15 buy ten external visits?

**Owner:** A12 (Growth and Launch). **Researched and written:** 2026-09-19.
**Status:** recommendation, not an instruction. Nothing in this document has been spent,
created, submitted or activated. No advertising account exists. No ad platform API has been
called — we hold no credentials and no approved developer token.

---

## 1. The verdict, first

**No paid platform we can reach will reliably deliver ten genuine external human visits for
£15.** Not one. The arithmetic fails on every candidate, for two different reasons:

| Platform                       | Can it enforce £15 as a true maximum?                                                                                                                                                                                                                                                                | Realistic clicks for the money                                                                                           | Verdict                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Google Ads (Search)            | **No.** No total budget exists for Search; the only documented guarantee is `30.4 x average daily budget per calendar month`. Prepay — the one setting that is a real ceiling — is **not available in the United Kingdom**.                                                                          | £12.16 at a UK B2B SaaS CPC of £3–£8.72 → **1–4 clicks**                                                                 | Ruled out on both counts                                                |
| Microsoft Advertising (Search) | **Not a total ceiling, but the best cap story here.** Lifetime budgets exist only for Audience campaigns; a daily budget is multiplied by days in the month and the campaign is **paused automatically** when depleted. Minimums verified in sterling: GBP 0.05/day, GBP 5.00/month. No FX exposure. | Lower CPC than Google, but UK query volume for these terms is close to nil → **0–8 clicks, probably near 0 impressions** | **Ruled out on audience, not on the cap** — see 6.1                     |
| LinkedIn Ads                   | Yes — a lifetime budget is a hard ceiling — but the **minimum lifetime budget for a new campaign is $100** and the minimum daily is $10.                                                                                                                                                             | £15 cannot fund a compliant campaign for two days. At UK B2B CPCs → **1–2 clicks**                                       | Ruled out on the figure                                                 |
| Meta                           | Yes — an ad-set lifetime budget is a genuine ceiling, and the daily floor is $1.                                                                                                                                                                                                                     | Cheap clicks, possibly 10–25 — but Meta cannot target "builds automations for clients" with any intent signal            | Ruled out on audience: it would buy a number, not ten interested people |
| **Reddit Ads**                 | **Yes** — a total (lifetime) budget turns the ad off when reached.                                                                                                                                                                                                                                   | At the documented B2B/tech-subreddit CPC of **$1.50–$3.00**, ≈$14 of net spend buys **5–9 clicks**                       | **Best paid option, and still short of ten**                            |

**Therefore:**

1. **The honest answer to "is 10 external visits achievable on £15?" is no**, if "achievable"
   means something we can commit to. The best paid option lands at roughly five to nine
   clicks, of which perhaps four to eight reach our server as an observed session.
2. **The £15 should not be spent yet.** The cheaper alternative in §7 reaches the same
   audience, at £0, with a higher expected number of visits and far better qualification.
3. **If the owner still wants a paid experiment**, the single recommended platform is
   **Reddit Ads** — and the packet in `docs/campaign-packet.md` must be framed as _"buy
   five to nine qualified clicks and find out what the market says about the sentence we
   lead with"_, never as _"buy ten visits"_.
4. Two figures in the Reddit recommendation are **unverified** and must be read on screen
   by the owner before anything is funded. They are listed in §6. One of them — Reddit's
   minimum total budget — could make even this campaign impossible inside £15.

---

## 2. The overdelivery problem, and why it decides everything

The brief was right to put this first. A budget field that is an _average_ is not a cap,
and on the two search platforms that is the only kind of budget field there is.

### Google Ads

> "On a given day, your campaign might spend up to twice your average daily budget to take
> advantage of fluctuations of traffic."
> "At the end of the month, you will have spent no more than 30.4 times your average daily
> budget."
>
> — [About overdelivery and your average daily budget](https://support.google.com/google-ads/answer/1704443?hl=en), read 2026-09-19

The 30.4 is 365 ÷ 12. The exact arithmetic that matters to us:

```
documented monthly ceiling = 30.4 x average daily budget
to keep that at or below £12.16:  average daily budget = £0.40
to keep that at or below £15.00:  average daily budget = £0.49
```

Three things follow, and all three are bad:

- **There is no shorter ceiling than the month.** A campaign scheduled to run seven days at
  £2.00/day is _not_ documented as bounded at £14. On each of those seven days it may spend
  up to 2 x £2.00, i.e. up to £28 across the week — and that is still under the £60.80
  monthly limit, so nothing in Google's stated guarantee prevents it. **Only the monthly
  figure is promised.** A short campaign is therefore _less_ protected than a long one.
- **The guarantee resets at the calendar-month boundary.** A campaign spanning 28 October
  to 3 November gets a fresh allowance in November. A £15-capped campaign that crosses a
  month boundary is a £30-capped campaign.
- **To make £15 a true maximum you must set £0.49/day and confine the run to one calendar
  month.** At £0.49/day the campaign will sit permanently "limited by budget" and enter a
  fraction of the auctions it is eligible for.

Google also confirms the second-order behaviour: a related page notes that even where
systems are designed to stop serving at a spending limit, "it's possible in rare
circumstances that our systems won't detect discrepancies right away", while stating "you'll
never actually pay more than your spending limits"
([About spending limits](https://support.google.com/google-ads/answer/10486637?hl=en), read
2026-09-19). So the money is protected; the _delivery_ is not bounded at the day level.

### Microsoft Advertising

Microsoft's wording is actually stronger, and is worth quoting because it is the only
search platform that documents an automatic pause:

> "If you create a campaign and specify a daily budget, the service calculates the monthly
> budget limit by multiplying the daily budget by the number of days in the month. ... If
> the daily budget amount or calculated monthly budget amount is depleted, the campaign is
> paused automatically."
>
> "Your budget is a target; your actual spend might be higher or lower. ... Microsoft
> Advertising anticipates and automatically compensates for the fluctuations, and usually
> keeps overspend to less than 100% above your daily limit."
>
> — [Budget and Bid Strategies](https://learn.microsoft.com/en-us/advertising/guides/budget-bid-strategies?view=bingads-13), read 2026-09-19

Note "usually". And note that the _only_ enforced number is again monthly. Microsoft also
confirms that a lifetime budget **exists only for Audience campaigns**, not for Search — so
a Search campaign cannot be given a total ceiling at all.

### The platforms that do have a real ceiling

- **LinkedIn**: "your total spend will never exceed the lifetime budget of your campaign or
  ad set" ([Campaign and ad set budgets](https://www.linkedin.com/help/lms/answer/a422101),
  read 2026-09-19). Unambiguous. Irrelevant, because of the floor — see §4.
- **Meta**: an ad-set lifetime budget is spent across the schedule and not exceeded; a
  _daily_ budget is an average that may be exceeded by up to 75% on a day.
- **Reddit**: "Your ad group will try to deliver your average daily spend each day until
  you hit your total budget. After that, your ad will turn off." This is the behaviour we
  want. **Flagged as secondary-source** — see §6.

**Conclusion of §2: a platform that cannot enforce £15 as a true maximum is not usable here,
and that eliminates both search engines.**

---

## 3. Can we prepay instead? (No, not in the UK)

A prepaid balance is the cleanest possible ceiling: you cannot spend money that is not
there. Google describes it exactly that way:

> "You make a payment before your ads run. Then, as your ads run and you accrue costs, the
> credit from your payment will decrease. When your payment is used up, your ads will stop
> running."

But the availability table on the same page lists the countries where prepay is not
offered, and the **United Kingdom is in that list** — alongside Ireland, France, Germany,
Spain, Italy, the Netherlands and most of western Europe
([About payment settings in Google Ads](https://support.google.com/google-ads/answer/2375432?hl=en-GB),
read 2026-09-19).

A UK Google Ads account is therefore **postpay**: Google charges the card when the account
reaches a payment threshold, or monthly, whichever comes first — and "each time your account
hits its threshold before the end of the month, your threshold increases". There is no
balance to run out. Monthly invoicing is the only alternative and requires a credit
application we would not pass.

**This is the single finding that kills Google Ads for this experiment.** Not the CPC — the
absence of any mechanism that can stop at £15.

---

## 4. Minimums, and what they do to £15

| Platform              | Minimum daily                                                    | Minimum lifetime/total                                                      | Currency | Source                                                                                                              |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Google Ads            | none documented                                                  | n/a (no total budget for Search)                                            | GBP      | [help](https://support.google.com/google-ads/answer/6385083?hl=en)                                                  |
| Microsoft Advertising | **GBP 0.05** (min monthly **GBP 5.00**, min bid GBP 0.05)        | n/a for Search                                                              | GBP      | [Microsoft Advertising Currencies](https://learn.microsoft.com/en-us/advertising/guides/currencies?view=bingads-13) |
| LinkedIn              | **$10**                                                          | **$100** for a new, inactive campaign; after launch, `$10 x days scheduled` | USD      | [LinkedIn help](https://www.linkedin.com/help/lms/answer/a422101)                                                   |
| Meta                  | **$1/day** impression-billed; **$5/day** click/conversion-billed | `daily minimum x scheduled days`                                            | USD      | secondary — see §6                                                                                                  |
| Reddit                | **$5/day**                                                       | **$25** (standard); $620 for "Max" campaigns                                | USD      | secondary — see §6                                                                                                  |

**LinkedIn is ruled out by the figure, exactly as the brief anticipated.** £15 is
approximately $19. LinkedIn will not create a new campaign below a $100 lifetime budget, and
its $10/day floor means £15 funds fewer than two days. Even setting the minimums aside, UK
B2B CPCs on LinkedIn are routinely £6–£12 — one or two clicks for the entire budget. There
is no version of this where LinkedIn is the answer.

**Reddit's $25 total-budget floor is the problem to check.** $25 is roughly £19.50 — above
the whole allocation. If that figure is correct and applies to a standard Traffic campaign,
the recommended campaign **cannot be created as a total-budget campaign inside £15**, and
the fallback would be a daily budget of $5/day over three days with a hard end date — which
is a weaker ceiling. See §6.

---

## 5. Audience reality and the click arithmetic

### Who we need

Small automation agencies — people running a handful of n8n/Make/Zapier flows for their own
clients (`docs/product-scope.md` §1). They are a narrow, technical, low-volume audience.

### Google Ads: the search-intent case, costed

UK cost-per-click benchmarks for B2B SaaS, 2026:

- Cross-industry UK average on Search: **£1.95**.
- B2B SaaS non-brand search: commonly **£3–£6**, with one 2026 dataset putting the average
  at **£8.72** and DevTools-category SaaS at **$7–$9**.

Sources: [Google Ads Benchmarks 2026 — UK](https://ppcchief.com/blog/google-ads-benchmarks-2026),
[B2B SaaS Google Ads Benchmarks 2026](https://www.kampaio.com/blog/b2b-saas-google-ads-benchmarks-2026),
[SaaS Google Ads Benchmarks 2026](https://aimers.io/blog/saas-google-ads-benchmarks), all
read 2026-09-19. These are secondary aggregators; we have no account and therefore no
Keyword Planner access to check them against real auction data.

With a documented monthly ceiling of **£12.16** (£0.40/day x 30.4, leaving room for VAT — see
§8):

| Assumed CPC                     | Clicks the whole budget buys               |
| ------------------------------- | ------------------------------------------ |
| £1.22                           | 10 — the CPC at which this would just work |
| £1.95 (UK all-industry average) | 6                                          |
| £3.00 (optimistic B2B SaaS)     | 4                                          |
| £6.00 (typical B2B SaaS)        | 2                                          |
| £8.72 (2026 B2B SaaS average)   | 1                                          |

**The CPC that makes ten clicks impossible is anything above about £1.22.** Every published
B2B SaaS benchmark for the UK is above it, most by a factor of three or more. And that
figure is the _ceiling_, assuming the budget is fully delivered — at £0.40/day a campaign on
competitive B2B keywords will frequently not enter the auction at all, so the realistic
outcome is nearer one or two clicks over the month, or none.

**Google Ads search intent cannot deliver ten clicks at this budget. It is not close.**

### Reddit: the best paid option, honestly costed

Reddit is the only platform where the audience exists as a _place_: r/n8n, r/Zapier,
r/automate, r/msp, r/sysadmin. We would not be guessing at an interest graph; we would be
buying placement in the room where these people already complain about the exact problem.

Published 2026 Reddit CPC benchmarks: **$0.50–$3.50 overall, most campaigns $0.75–$2.00**,
and specifically **"B2B and tech subreddits (r/startups, r/sysadmin) cost more, $1.50–$3.00
CPC, due to advertiser competition"**
([Reddit Ads Cost Benchmarks](https://benly.ai/learn/reddit-ads/reddit-ads-cost-benchmarks),
[Reddit B2B Advertising Benchmarks 2026](https://www.abetheagency.com/guide/reddit-b2b-advertising-benchmarks-2026),
read 2026-09-19 — both secondary).

With ≈**$14** of net ad spend (see §8 for how £15 gross becomes $14 net):

| Assumed CPC                     | Clicks | Observed landing sessions at 80–90% |
| ------------------------------- | ------ | ----------------------------------- |
| $0.75 (broad, cheap placements) | 18     | 14–16                               |
| $1.50 (low end of B2B/tech)     | 9      | 7–8                                 |
| $2.00 (mid B2B/tech)            | 7      | 5–6                                 |
| $3.00 (high end of B2B/tech)    | 4      | 3–4                                 |

The tension is the whole finding: **the cheap clicks are the wrong audience, and the right
audience costs $1.50–$3.00.** Targeting r/n8n and r/msp — which is the only reason to be on
Reddit at all — puts us squarely in the expensive band. Five to nine clicks is the honest
expectation, and four to eight observed sessions.

Our counting is server-side (`apps/app/src/growth/analytics.ts` hashes at the Worker, not in
the browser), so we lose only clicks that never reach us — mis-taps, immediate back-outs,
and anything the platform reports as a click that was not one. That is why the landing-session
figure is 80–90% of clicks and not 50%.

### Meta

Meta would probably produce ten or more clicks: $14 at UK CPMs of £5–£12 is roughly
1,000–2,500 impressions, and 0.5–1% CTR gets you there. But there is no targeting input on
Meta that means "builds automations for clients". The nearest available signals are broad
interest buckets, and a £1/day budget on Meta delivers disproportionately into the cheapest
placements. It would buy ten clicks and approximately zero interested people. **Recommending
Meta would be optimising the metric rather than the outcome**, so it is rejected.

---

## 6. Verification status of every figure

Re-checked 2026-09-19 after the founder asked for account-level minimums to be confirmed
properly. Each figure now carries where it came from. Three states matter:

- **primary** - read from the platform's own documentation.
- **secondary** - from a third-party write-up; treat as an order of magnitude, not a quote.
- **requires account** - the figure exists but is only visible from inside a signed-in
  advertising account. This is a _finding_, not a gap: no further public research will
  produce it, and the owner reading it on screen is the answer.

### Confirmed on this pass

| Figure                                                  | Value                                                                                                                                    | Provenance | Source                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Advertising, **GBP minimum bid**              | **GBP 0.05**                                                                                                                             | primary    | [Microsoft Advertising Currencies](https://learn.microsoft.com/en-us/advertising/guides/currencies?view=bingads-13), UKPound row |
| Microsoft Advertising, **GBP minimum daily budget**     | **GBP 0.05**                                                                                                                             | primary    | same                                                                                                                             |
| Microsoft Advertising, **GBP minimum monthly budget**   | **GBP 5.00**                                                                                                                             | primary    | same                                                                                                                             |
| Microsoft Advertising, GBP maximum monthly budget       | GBP 3,938,700.00                                                                                                                         | primary    | same                                                                                                                             |
| Meta, account-level `spend_cap` minimum                 | **$100 USD** - "defined as integer value of subunit in your currency with a minimum value of $100 USD (or approximate local equivalent)" | primary    | [Marketing API reference](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/)                       |
| Meta, budget placement                                  | Budget is set at campaign level **or** ad-set level, never both                                                                          | primary    | same                                                                                                                             |
| LinkedIn minimums ($10/day, $100 lifetime)              | unchanged                                                                                                                                | primary    | [LinkedIn help](https://www.linkedin.com/help/lms/answer/a422101)                                                                |
| Google Ads 30.4x monthly rule; UK prepay unavailability | unchanged                                                                                                                                | primary    | sections 2 and 3                                                                                                                 |

**Two of these change a conclusion. Both are recorded in 6.1 and 6.2 below.**

### Still unconfirmed, and why

| #   | Figure                                                                    | Status               | What it would take                                                                                                          |
| --- | ------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Reddit minimum total (lifetime) budget** - our stored figure is **$25** | **requires account** | The owner reads it on screen in the campaign creation flow. See 6.3 for what was tried.                                     |
| 2   | **Reddit minimum daily budget** - stored as **$5**                        | **requires account** | Same screen.                                                                                                                |
| 3   | **Reddit billing currency for a UK account** (GBP or USD)                 | **requires account** | Visible in ad-account billing settings at creation.                                                                         |
| 4   | **Reddit account verification requirement and timeline**                  | **requires account** | Only observable by creating the account.                                                                                    |
| 5   | **Meta minimum daily budget** ($1 impression-billed / $5 click-billed)    | **secondary**        | Meta publishes `spend_cap` but not these; they appear only in the ad-set creation UI.                                       |
| 6   | **Google Ads minimum average daily budget**                               | **not published**    | Google documents no minimum for Search anywhere public. Absence of a published minimum is not the same as there being none. |
| 7   | **Every CPC figure in section 5**                                         | **secondary**        | We hold no advertising account, so there is no Keyword Planner and no Reddit forecast tool to check them against.           |

All seven are recorded in code at `packages/connectors/src/ads/facts.ts` as
`minimums_provenance`, and asserted by `ADS-112`, so an unverified number cannot quietly
become a fact.

### 6.1 Correction: Microsoft Advertising is ruled out on **audience**, not on the cap

My first pass ruled Microsoft out alongside Google. With the GBP currency table now read,
that was too blunt, and the distinction matters:

- Microsoft's minimum monthly budget in sterling is **GBP 5.00** - comfortably inside the
  GBP 15 allocation, unlike LinkedIn's $100 floor.
- Microsoft **documents an automatic pause**: "If the daily budget amount or calculated
  monthly budget amount is depleted, the campaign is paused automatically." Google
  documents only that you will not be _charged_ above the limit.
- The account is **billed in GBP**, so there is no exchange-rate exposure and no
  non-sterling card fee - unlike Reddit, where both are live risks (section 8).
- Setting GBP 0.37/day gives a documented monthly ceiling of GBP 11.47 across a 31-day
  month, inside the allocation, with an automatic pause when it is reached.

So Microsoft has the **strongest cap story of any candidate**, better than Reddit's. It is
still not recommended, and the reason is now the honest one: **UK search volume on Bing for
terms like "n8n monitoring" or "zapier error alerting" is close to nil.** A campaign with a
perfect ceiling and no impressions delivers zero visits. It is ruled out on audience.

The underlying limitation stands: Microsoft offers a lifetime budget **only for Audience
campaigns, not Search**, so there is still no _total_ ceiling - the guarantee is per
calendar month, and the campaign must not cross a month boundary.

### 6.2 New: Meta's account-level spend cap cannot be used as a GBP 15 ceiling

Meta's `spend_cap` looked like it might be the clean account-wide ceiling. It is not: the
API reference states a **minimum value of $100 USD**. That is roughly five times the whole
allocation.

So on Meta the _only_ usable ceiling is the ad-set lifetime budget. That is still a real
ceiling, and Meta remains rejected on audience (section 5), but it is worth recording that
the belt-and-braces control people assume exists is out of reach at this budget.

### 6.3 What was tried for Reddit, so nobody repeats it

Reddit's help centre is a fully client-rendered Salesforce Experience Cloud site. It serves
no article content to an unauthenticated fetch. On 2026-09-19 the following were attempted:

| Route                                              | Result                                  |
| -------------------------------------------------- | --------------------------------------- |
| `business.reddithelp.com/helpcenter/s/article/...` | HTTP 401                                |
| `business.reddithelp.com/s/article/max-campaigns`  | Renders a "CSS Error" shell, no content |
| `business.reddithelp.com/s/article/Simple-Create`  | Same shell, no content                  |
| `business.reddit.com`                              | Not reachable                           |
| `www.reddit.com` / `old.reddit.com`                | Not reachable                           |
| `ads-api.reddit.com/docs/v3/`                      | Not reachable                           |
| Search-index extraction of the help articles       | Returns fragments, not the figures      |

One useful fragment did surface from Reddit's own Max Campaigns help article via search
indexing: Max Campaigns "allow you to optionally set a **campaign spend cap** if your budget
type is daily, which is the maximum amount your campaign can spend over its lifetime." That
names a real total-ceiling control distinct from the ad-group budget. It does not help us -
Max Campaigns are reported (secondary) to require $20/day or $620 lifetime - but if the
owner sees a "campaign spend cap" field on a standard campaign, that is the control to use.

**Conclusion: items 1-4 cannot be resolved without signing in. They become owner steps
(section 9), performed before any money is committed.**

## 7. The cheaper alternative, which is also the better one

> **Decision taken 2026-09-19: organic first, ads afterwards. The GBP 15 stays reserved
> and untouched.** The posts themselves are in `docs/organic-launch.md`, written and
> awaiting approval. Nothing has been published.

The brief asked for an honest answer rather than a packet we cannot run. Here it is.

**Ten external visits from exactly this audience is a £0 problem, not a £15 problem.**

The buyer described in `docs/product-scope.md` §1 is already gathered in public places and
already complaining about this exact failure — "the client rang to ask why nobody replied to
their enquiry". Reaching ten of them costs time, not money:

- **One honest post in r/n8n, r/msp or r/automate**, written as "I built a thing that checks
  whether your automation actually did what it said; here is precisely what it does not do
  yet". The exclusions in `docs/product-scope.md` §4 are the post. A build-log post with a
  candid limitations list routinely gets hundreds of views in these subreddits.
- **Replies in existing threads** about silent automation failures — no link unless asked.
- **Show HN / Indie Hackers**, same framing.
- **The development story** the repository already keeps (`docs/` and the public development
  story route) is publishable content that costs nothing to distribute.

Expected outcome: comfortably more than ten visits, from people who chose to click on a
technical description rather than an ad, with actual comments attached — which is worth more
than the visit count. Expected cost: £0. Expected downside: a Reddit community reacts badly
to anything that reads as an advertisement, so the post must be genuinely non-promotional or
it will be removed and the account burned — which would also cost us the paid option.

**Recommendation: run this first. Keep the £15 and the gated £30 untouched.** Spend on ads
only once we know, from real comments, which sentence makes someone lean in — at which point
£15 buys a test of a _known_ message rather than a guess.

---

## 8. If the owner spends anyway: the one platform, and the money

**Platform: Reddit Ads. One platform. The £15 is not split.**

Why Reddit and nothing else:

1. It is the only candidate that documents a **total budget** ceiling _and_ has a floor
   plausibly at or below our allocation _and_ can place us in front of the actual buyer.
2. Google and Microsoft cannot enforce a total ceiling at all (§2, §3).
3. LinkedIn's floor is $100 (§4).
4. Meta can enforce the cap but cannot find the audience (§5).

### The money, in integer pence

The £15 allocation (`BUDGET.ALLOC_ADVERTISING_PENCE = 1500`) must be treated as a **gross**
ceiling — the total that can leave the founder's account — not as the ad spend. Two things
sit on top of the ad spend:

- **VAT at 20%.** UK advertisers contract with the platform's Irish entity. A
  VAT-_registered_ UK business accounts for it under the reverse charge and is charged 0%;
  a business without a VAT number is treated as a consumer and **charged 20%**
  ([VAT on Google Ads, UK](https://lanop.co.uk/vat-on-google-ads-uk-guide/), read
  2026-09-19; the same treatment applies to Meta and, on the same principle, to Reddit).
  Assume the founder is **not** VAT-registered: assume 20% is added.
- **A non-sterling transaction fee** if Reddit bills in USD — typically 2.75–2.99% on a UK
  card, plus the card issuer's exchange rate rather than the interbank one.

Working backwards from £15.00 gross:

```
gross ceiling                       1500 pence
less VAT at 20%                     net x 1.20
less card non-sterling fee ~3%      x 1.03
=> maximum net ad spend             1500 / (1.20 x 1.03) = 1213 pence
proposed net ad spend                1150 pence  (£11.50) — leaves headroom
  + VAT 20%                           230 pence
  = subtotal                         1380 pence
  + 3% non-sterling fee                42 pence
  = gross maximum exposure           1422 pence  (£14.22)
headroom against the allocation        78 pence
```

At an assumed 1.28 USD/GBP that £11.50 is about **$14.70**; at a 5% adverse move it is about
$14.00. *_The packet therefore sets a USD total budget of $13.00**, which stays inside the
gross ceiling across any plausible rate — and which is *below the unverified $25 minimum_,
which is why check (1) in §6 must happen first.

If the owner is VAT-registered, the reverse charge applies, the 20% disappears, and the net
ad spend can rise to about £14.50. That is a real difference and worth ten minutes of
checking.

### Expected return, stated honestly

**$13 of Reddit spend in B2B/tech subreddits buys about four to eight clicks, and about
three to seven observed landing sessions.** Not ten. The experiment's value is the message
test and the first real external traffic, not the visit count.

---

## 9. What the owner must clear before anything can be submitted

In order. None of these can be done by an agent.

1. **Read Reddit's minimum total budget on screen** in the campaign creation flow. If it is
   above the net budget in §8, stop — this campaign cannot run inside £15, and §7 is the
   answer.
2. **Decide the VAT position.** VAT-registered or not, and if registered, enter the VAT
   number in the ad account's billing settings so the reverse charge applies.
3. **Create the Reddit account** (a Reddit user account, then an ad account). Not created;
   creating accounts is outside what any agent here may do.
4. **Enrol MFA on that account before adding a payment method.** An ad account with a card
   on it and no second factor is an unbounded liability.
5. **Add the payment method**, and confirm with the card issuer what the non-sterling
   transaction fee is if billing is in USD.
6. **Complete whatever business/identity verification Reddit asks for**, and note how long
   it took — we do not know, and the schedule in the packet may need moving.
7. **Confirm the billing currency** and record it against the packet.
8. **Approve the packet** in `docs/campaign-packet.md`, which binds the approval hash. Any
   later change to budget, audience, creative, destination or duration invalidates it
   (`apps/app/src/growth/approval.ts`).
9. **Create the campaign as a draft, paused**, following the ordered steps the manual
   adapter emits. Do not submit in the same sitting.
10. **Paste the external campaign id back** so we can reconcile, pause and account for spend.
    Without it, `getStatus` will correctly refuse to report anything but `unknown`.

### On API access, for the record

Neither search platform could be automated on a fresh account even if we wanted to:

- **Google Ads API**: a developer token is needed, and for new Basic-access applications
  "you must complete brand verification for your Google Cloud project" before the
  (now-automated) review runs; a free-trial or suspended billing account is rejected outright
  ([Developer token](https://developers.google.com/google-ads/api/docs/get-started/dev-token),
  read 2026-09-19). Not instant, and not possible without an account and a billed Cloud
  project.
- **Microsoft Advertising API**: a universal sandbox token is public and immediate; a
  production token is issued quickly for first-party use. Better, but irrelevant, since
  Microsoft is ruled out on the cap.
- **Reddit Ads API**: requires an ad account and an OAuth client we do not have.

So the adapter that ships is `manual` — a human operates the platform UI and we record what
they did and what the platform said (`packages/connectors/src/ads/manual.ts`). The Reddit
API adapter in `reddit-planner.ts` is a _planner_: it describes the calls a future
integration would make and refuses every operation with `NO_CREDENTIALS`. It contains no
`fetch` and must not acquire one without a separate, explicitly approved change.

---

## 10. Sources

All read 2026-09-19.

- [About overdelivery and your average daily budget — Google Ads Help](https://support.google.com/google-ads/answer/1704443?hl=en)
- [About spending limits — Google Ads Help](https://support.google.com/google-ads/answer/10486637?hl=en)
- [About average daily budgets — Google Ads Help](https://support.google.com/google-ads/answer/6385083?hl=en)
- [About payment settings in Google Ads (en-GB) — prepay availability table](https://support.google.com/google-ads/answer/2375432?hl=en-GB)
- [Prepay payments — Google Ads Help](https://support.google.com/google-ads/answer/2393016?hl=en)
- [Budget and Bid Strategies — Microsoft Advertising, Microsoft Learn](https://learn.microsoft.com/en-us/advertising/guides/budget-bid-strategies?view=bingads-13)
- [Campaign and ad set budgets — LinkedIn Marketing Solutions Help](https://www.linkedin.com/help/lms/answer/a422101)
- [Get started with the Google Ads API: developer token](https://developers.google.com/google-ads/api/docs/get-started/dev-token)
- [Get Started With the Bing Ads API — Microsoft Learn](https://learn.microsoft.com/en-us/advertising/guides/get-started?view=bingads-13)
- [Microsoft Advertising Currencies — GBP minimum bid and budget table](https://learn.microsoft.com/en-us/advertising/guides/currencies?view=bingads-13)
- [Meta Marketing API — campaign reference, `spend_cap` minimum](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/)
- [Reddit Ads Cost: CPC, CPM & CPA by Industry (2026)](https://benly.ai/learn/reddit-ads/reddit-ads-cost-benchmarks) — secondary
- [Reddit B2B Advertising Benchmarks 2026](https://www.abetheagency.com/guide/reddit-b2b-advertising-benchmarks-2026) — secondary
- [Reddit Ads Minimum Budget Requirements in 2026](https://www.stackmatix.com/blog/reddit-ads-minimum-budget-requirements-2026) — secondary
- [Meta Ads Minimum Daily Budget in 2026](https://www.stackmatix.com/blog/meta-ads-minimum-daily-budget-2026) — secondary
- [What Changed in Google Ads Benchmarks for 2026: UK CPC & CTR](https://ppcchief.com/blog/google-ads-benchmarks-2026) — secondary
- [B2B SaaS Google Ads Benchmarks 2026](https://www.kampaio.com/blog/b2b-saas-google-ads-benchmarks-2026) — secondary
- [SaaS Google Ads Benchmarks 2026: CPC, CPL and cost drivers](https://aimers.io/blog/saas-google-ads-benchmarks) — secondary
- [Is There VAT on Google Ads? VAT guide for UK businesses](https://lanop.co.uk/vat-on-google-ads-uk-guide/) — secondary
