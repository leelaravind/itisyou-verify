# Campaign packet — first advertising experiment

**Prepared by:** A12 (Growth and Launch), 2026-09-19.
**Status: NOT APPROVED. NOT SUBMITTED. NOTHING HAS BEEN SPENT.**
No advertising account exists. No campaign has been created. No ad platform API has been
called.

This is the document the owner reads and approves. Approving it binds a hash over
`{ budget_minor, audience, creative, destination, duration }`
(`apps/app/src/growth/approval.ts`). After that, changing any of those five invalidates the
approval automatically — including changing the budget by one penny.

---

## 0. Read this before approving

`docs/advertising.md` is the feasibility answer and it says, plainly:

> No paid platform we can reach will reliably deliver ten genuine external human visits for
> £15. The best paid option (Reddit) buys about **four to eight clicks**, and about **three
> to seven observed landing sessions**.

**The recommendation is to not spend this money yet**, and to get the first ten visits from
one honest post in r/n8n / r/msp / Indie Hackers instead, at £0. This packet exists so that
*if* the owner decides to run the paid experiment anyway, it runs under a real ceiling with
honest copy and an automatic stop — not so that it gets run.

**Two blocking checks. Both must pass before this packet can be approved:**

| # | Check | Why it blocks |
| --- | --- | --- |
| **B1** | Open Reddit's campaign creation flow and **read the minimum total (lifetime) budget on screen**. | Our figure is **$25** and is *secondary and unverified*. $25 is more than the whole £15 allocation. If $25 is correct, this campaign cannot be created and the packet is void. |
| **B2** | Confirm **which currency** Reddit will bill this account in, and the card's non-sterling transaction fee if it is USD. | The cap in this repository is integer pence. If billing is USD, the gross GBP exposure moves with the exchange rate and §5's arithmetic has to be redone at the rate on the day. |

---

## 1. Platform and account

| Field | Value |
| --- | --- |
| Platform | **Reddit Ads** (self-serve, `ads.reddit.com`) |
| Account | **Does not exist.** The owner creates it. No agent creates accounts. |
| Account owner | The founder, personally |
| MFA | **Must be enrolled before a payment method is added.** Non-negotiable. |
| Business verification | Unknown — Reddit's requirement and timeline were not established. Budget time for it. |
| API access | **None.** Campaign is operated by hand through the Reddit UI; we record what the owner did and what the platform said. See `packages/connectors/src/ads/manual.ts`. |
| Why one platform | The £15 is not split. Splitting it across two platforms halves an already-insufficient budget and doubles the number of things that can silently overspend. |

---

## 2. Objective and conversion definition

| Field | Value |
| --- | --- |
| Platform objective | **Traffic** (clicks to the site). Not Conversions — we have nothing like the volume an optimiser needs, and a conversion objective on four clicks is noise. |
| Optimisation goal | Clicks |
| **What we count as success** | See below. Three separate numbers. None is derived from another. |

**The conversion definition, precisely:**

> A **workspace is created** and its **HubSpot connection reaches `ready`**
> (`ConnectionStatus`, `packages/contracts/src/status.ts`).

That is the only thing we call a conversion, because it is the first point at which someone
has done real work rather than looked at a page.

Three figures are reported separately and are **never reconciled with each other**
(`apps/app/src/growth/analytics.ts`):

1. **Platform clicks** — what Reddit says it charged us for.
2. **Observed landing sessions** — what actually reached our Worker, classified `external`,
   deduplicated by a daily-rotating salted hash. An estimate of visits, **never** described
   as unique people.
3. **Qualified signups** and **paid customers** — from our own records.

They will not agree. That gap is information (mis-taps, immediate back-outs, clicks that
were not clicks) and it is reported, not averaged away.

**The ten-visit target is measured on figure 2 only**, and excludes anything classified
`internal_test`, `bot_suspected` or `unknown`. Our own testing never counts toward the ten.

---

## 3. Creative — the exact text that will run

Adapted from the approved copy. No new claim has been introduced. Reddit's headline field
accepts up to 300 characters, so nothing needed cutting; the call-to-action is a fixed
platform button, so the CTA sentence moves into the body.

### Ad A — primary

**Headline (35 characters):**

> Did your automation finish the job?

**Body (186 characters):**

> Check CRM records and email outcomes against your rules. See evidence when a run passes,
> fails or cannot be verified. HubSpot and Resend only, one workflow shape. Explore ITISYOU
> Verify.

**Call-to-action button:** `Learn More` (Reddit's fixed list; "Explore ITISYOU Verify"
cannot be a button, so it is the last line of the body).

**Display/brand name:** ITISYOU Verify

### Ad B — variant, same claim, narrower hook

**Headline (45 characters):**

> Your workflow said it worked. Did it, though?

**Body (179 characters):**

> We read the CRM record and the email event back ourselves and check them against your
> rules. Pass, fail, or not enough evidence to say. HubSpot and Resend. Explore ITISYOU
> Verify.

**Call-to-action button:** `Learn More`

### Why the copy says what it says

| Line | What makes it true |
| --- | --- |
| "Check CRM records and email outcomes against your rules" | `assertionSpecSchema` operators against `CRM_FIELD` / `EMAIL_FIELD` (`packages/contracts/src/rules.ts`) |
| "See evidence when a run passes, fails or cannot be verified" | `RUN_STATUS` is exactly `PENDING`/`VERIFIED`/`FAILED`/`UNVERIFIED` — the three named outcomes, no fifth state |
| "We read the CRM record and the email event back ourselves" | `EvidenceOrigin: 'provider_readback'`; the HubSpot and Resend connectors exist (`packages/connectors/src/hubspot.ts`, `resend.ts`) |
| "HubSpot and Resend only, one workflow shape" | `docs/product-scope.md` §4 — stated in the ad rather than hidden on the landing page, because it qualifies the click |

### Forbidden in this or any ad

Checked mechanically by `forbiddenClaimsIn()` in `apps/app/src/growth/approval.ts`, and
asserted in `tests/unit/growth/campaign-packet.test.ts`:

`guaranteed accuracy` · `certified secure` · `works with every AI` / `works with any AI` ·
`never lose a lead` · `never miss a lead` · `100% uptime` · `real-time verification` ·
`instant results` · any income or revenue guarantee · any invented testimonial ·
any customer count · `trusted by thousands` / `join thousands of`

Also forbidden by judgement rather than by string match: any implication that we fix the
automation, that we work with CRMs other than HubSpot, that results are instant (a run can
take up to an hour to settle), or that we can detect a run that never started (only true in
`coverage_mode: 'independently_sourced'`).

**Platform auto-enhancement must be off.** If Reddit offers to rewrite, translate, shorten
or generate creative variants, it is declined. An auto-generated headline is an unapproved
claim, and it would invalidate the approval hash the moment it changed the creative.

---

## 4. Audience, geography and language

| Field | Value |
| --- | --- |
| Audience description | People who build and maintain automations for their own clients — small agencies and freelance automation builders |
| **Targets (communities)** | `r/n8n`, `r/Zapier`, `r/automate`, `r/msp` |
| Reserve communities (NOT approved; would need re-approval) | `r/sysadmin`, `r/nocode`, `r/smallbusiness` |
| Interest targeting | **Off.** Community targeting only — it is the one signal on this platform that means what it says. |
| **Negative / exclusion keywords** | `job`, `jobs`, `hiring`, `career`, `salary`, `course`, `tutorial`, `certification`, `free`, `crack`, `download`, `student`, `homework`, `giveaway` |
| Geography | **United Kingdom (`GB`) only.** Not because the product is UK-only, but because the budget cannot survive a global auction and UK traffic is the only traffic we can follow up on in the owner's timezone. |
| Language | English (`en`) |
| Device | All. No exclusion — excluding mobile would shrink an already thin delivery. |
| Frequency cap | 1 impression per user per day, if the platform offers it. Ten impressions to one person is a waste of a four-click budget. |

**Honest note on the audience:** these communities dislike advertising. The ad will be
downvoted and may be reported. That is a cost of this channel, not a surprise, and it is
another reason §7 of `docs/advertising.md` recommends the organic route first.

---

## 5. Budget, bidding and the gross ceiling

Every figure is an integer number of minor units. Nothing here is computed as a float.

| Field | Value |
| --- | --- |
| Allocation (`BUDGET.ALLOC_ADVERTISING_PENCE`) | **1500 pence (£15.00)** — treated as a **gross** ceiling, the maximum that may leave the founder's account |
| Budget type | **Total / lifetime budget.** Not a daily budget. If Reddit will not accept a total budget at this level (check **B1**), the packet is void. |
| Proposed total budget | **$13.00 USD** (or **1150 pence** if Reddit bills in GBP) |
| VAT | **20%**, assumed charged — the founder is assumed **not** VAT-registered. If registered, the reverse charge applies, 20% disappears, and this packet must be re-costed and re-approved. |
| Card non-sterling fee | **~3%**, assumed, if billed in USD. Confirm with the issuer (check **B2**). |

**Gross maximum exposure, including VAT:**

```
net ad spend                       1150 pence   (£11.50)
+ VAT at 20%                        230 pence
= subtotal                         1380 pence
+ non-sterling card fee ~3%          42 pence
= GROSS MAXIMUM EXPOSURE           1422 pence   (£14.22)
headroom against the allocation      78 pence
```

**£14.22 is the number the owner is approving.** The `maximum_amount_minor` on the approval
record is set to **1422**, and `publishApproved` refuses outright if the packet budget
exceeds it (`packages/connectors/src/ads/manual.ts`, asserted by `ADS-016`).

The gated £30 contingency (`BUDGET.CONTINGENCY_GATED_PENCE = 3000`) is **not** available to
this campaign and is not assumed anywhere in this packet.

### Bidding constraints

| Field | Value |
| --- | --- |
| Bid strategy | **Manual CPC** — an automatic strategy on a four-click budget optimises nothing and removes our only control |
| Maximum CPC | **$2.00**. Above this the budget buys fewer than seven clicks and the experiment stops being informative. |
| Bid changes permitted without re-approval | **Reducing** the max CPC, and pausing. Both shrink exposure. |
| Bid changes requiring fresh approval | **Raising** the max CPC, raising the budget, adding a community, widening geography, extending the end date, or changing a word of the creative. Enforced by `classifyChange()` in `apps/app/src/growth/approval.ts` (`ADS-037`, `ADS-038`, `ADS-039`). |

---

## 6. Destination URL

```
https://verify.itisyou.app/?utm_source=reddit&utm_medium=cpc&utm_campaign=verify_first_test&utm_content=ad_a
```

(Ad B uses `utm_content=ad_b`. This is the **real production host**, confirmed live by the
lead on 2026-09-19 — it is not a placeholder, so the URL above is the URL that will be
pasted into the platform. Changing it later changes `destination` and therefore requires a
fresh approval; it cannot be slipped in after signing.)

| Field | Value |
| --- | --- |
| `utm_source` | `reddit` |
| `utm_medium` | `cpc` |
| `utm_campaign` | `verify_first_test` |
| `utm_content` | `ad_a` / `ad_b` |
| Landing page | The public marketing page. It must state the exclusions from `docs/product-scope.md` §4 above the fold. Paying to send someone to a page that oversells is worse than not advertising. |
| Redirects | **None.** The URL pasted into the platform is the URL that serves. A redirect chain loses UTMs and breaks attribution. |
| Scheme | HTTPS only |

UTM values arriving back at the Worker are attacker-controlled and are validated against
`/^[A-Za-z0-9_.\-]{1,64}$/`; anything else is dropped rather than stored (`ADS-012`). A
session arriving with no UTM at all still counts as a visit, but is reported as
*unattributed*, never as ad-attributed (`ADS-104`).

---

## 7. Schedule

| Field | Value |
| --- | --- |
| Start | **2026-10-05, 09:00** |
| End | **2026-10-11, 23:59** |
| Timezone | **Europe/London**, set explicitly in the platform's schedule field |
| Duration | 7 days |
| Calendar month | Entirely within October. **Deliberate.** A campaign that crosses a month boundary gets a fresh monthly allowance on platforms whose only ceiling is monthly; keeping inside one month is a standing discipline even here, where a total budget makes it moot. |
| Dayparting | None. The budget is too small for dayparting to mean anything. |

The dates move if Reddit's account verification takes longer than expected. **Moving them
changes `duration` and invalidates the approval** — that is intended, and re-approving a
date change costs the owner thirty seconds.

---

## 8. The platform's cap behaviour, in its own terms

Recorded verbatim so that if the platform behaves differently, we can show what we were
told. Stored in code at `packages/connectors/src/ads/facts.ts`.

> "Your ad group will try to deliver your average daily spend each day until you hit your
> total budget. After that, your ad will turn off."

Source: Reddit Ads Help Centre, *How much do Reddit Ads cost?*, as indexed on 2026-09-19.
**`primary_source: false`** — the page is JavaScript-rendered and returned HTTP 401 to an
unauthenticated fetch, so this wording was not read at the source. **The owner must confirm
the equivalent sentence on screen** when creating the campaign.

For contrast, the two platforms this packet rejects:

- **Google Ads:** "On a given day, your campaign might spend up to twice your average daily
  budget... At the end of the month, you will have spent no more than 30.4 times your
  average daily budget." No total ceiling; prepay unavailable in the UK.
- **Microsoft Advertising:** "the service calculates the monthly budget limit by multiplying
  the daily budget by the number of days in the month... the campaign is paused
  automatically", and overspend is "usually... less than 100% above your daily limit".

---

## 9. Automatic stop rules

Implemented in `apps/app/src/growth/stops.ts`. Each returns a typed reason code. Severity
`halt` means stop now; `warn` means tell the owner.

| Reason code | Trigger | Severity |
| --- | --- | --- |
| `allocated_exposure_reached` | observed spend ≥ 1150 pence net | halt |
| `allocated_exposure_approaching` | observed spend ≥ 850 pence (allocation minus the 300-pence buffer) | warn |
| `spend_unknown_too_long` | we have not known what was spent for more than 24 hours | halt |
| `billing_anomaly` | spend is negative, non-integer, in an unexpected currency, or a charge we did not authorise | halt |
| `landing_page_broken` | the landing page is not serving | halt |
| `checkout_broken` | checkout is not completing | halt |
| `approval_revoked` | the approval is revoked or expired | halt |
| `owner_command` | the owner said stop | halt |
| `critical_incident` | any critical incident anywhere in the product | halt |

Two properties that matter more than the list:

- **Unknown spend is not zero spend.** A campaign whose spend we cannot read is halted, not
  assumed free (`ADS-094`, `ADS-088`).
- **No floating-point arithmetic touches the cap.** Asserted at source level by `ADS-098`,
  which strips comments from `stops.ts` and fails if any decimal literal, `parseFloat`,
  `toFixed`, `Math.round`, `Math.ceil` or any division other than milliseconds-to-seconds
  appears in the file.

---

## 10. How a pause is verified

**A local pause flag is not proof delivery stopped.** Neither is an API call returning 200,
and neither is spend that happens to look flat.

`verifyPause()` (`apps/app/src/growth/stops.ts`) returns one of three answers:

| Verdict | When |
| --- | --- |
| `paused` | a **fresh reconciled provider read** shows paused or ended, **or** the owner explicitly confirms they looked and it was paused |
| `pause_pending` | we asked, and nothing has confirmed it — including the case where the last provider read still shows `active` |
| `unknown` | we have not even asked, or we have no external campaign id to ask about |

The owner's verification procedure, which the manual adapter emits as ordered steps
(`packages/connectors/src/ads/manual.ts`):

1. Set the campaign to paused in the Reddit ads manager.
2. Reload after at least one minute and confirm it still shows Paused. *One read is a
   screenshot; two are evidence.*
3. Confirm spend has not moved across the next reporting interval — **two consecutive equal
   spend readings**.
4. Record the confirmation here with the time it was actually observed. **Only that recorded
   observation moves the state from `pause_pending` to `paused`** (`ADS-018`, `ADS-099`).

A campaign with no external id recorded can never be reported as paused — there is nothing
to have paused — and an `active` observation for such a campaign is refused outright
(`ADS-075`).

---

## 11. Duplicate-campaign guard

A create that times out may have succeeded. Retrying it blind is how a £15 budget becomes a
£30 budget.

`planCreation()` in `apps/app/src/growth/lifecycle.ts` will not return `create` while a
previous attempt's outcome is unknown; it returns `reconcile_first`. The reconcile either
finds the campaign (→ `adopt_existing`), authoritatively finds nothing (→ exactly one
`create`), or cannot tell (→ `refuse`). Asserted by `ADS-055` through `ADS-058`.

Likewise, **API acceptance is never `active`**. A provider returning 2xx reaches `submitted`
and stops there; only a reconciled provider read can produce `active` (`ADS-005`,
`ADS-052`). On the manual adapter, `accepted_by_provider` is always `false`, because we
submit nothing — a person does (`ADS-071`).

---

## 12. Approval block

Approving this packet binds a SHA-256 hash over the canonical form of
`{ budget_minor, audience, creative, destination, duration }`. Reordering the JSON keys does
not change it; changing the budget by one penny does (`ADS-032`, `ADS-033`).

| Field | Value |
| --- | --- |
| `action_type` | `campaign_launch` |
| `platform` | `reddit` |
| `budget_minor` | `1150` |
| `currency` | `GBP` |
| `maximum_amount_minor` (gross, incl. VAT and card fee) | `1422` |
| `expires_at` | 14 days from approval. An approval that outlives the plan is a liability. |
| Canonical payload hash | *computed at approval time by `bindApproval()` — not pre-filled here, because a hash written into a document by hand is not a hash* |

---

### Owner sign-off

- [ ] **B1** — I have read Reddit's minimum total budget on screen and it is at or below the net budget above.
- [ ] **B2** — I have confirmed the billing currency and, if USD, the card's non-sterling fee.
- [ ] I have read `docs/advertising.md` and I understand this buys approximately **four to eight clicks**, not ten visits.
- [ ] I accept a gross maximum exposure of **£14.22**.
- [ ] I have enrolled MFA on the Reddit account before adding a payment method.
- [ ] I approve the creative in §3 verbatim, and I will not let the platform rewrite it.
- [ ] I understand that the gated £30 contingency is not available to this campaign.

**Signed:** ______________________  **Date:** ______________

*Until every box above is ticked and this is signed, no campaign is created, submitted or
funded. Nothing in this repository will do it for you.*
