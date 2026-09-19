# Organic launch — posts for approval

**Prepared by:** A12 (Growth and Launch), 2026-09-19.
**Status: NOTHING HAS BEEN PUBLISHED.** No account has been created, no post has been
submitted, no comment has been left. Every post below is a draft for the founder to read,
edit and publish personally.

Decision this implements: **organic first, ads afterwards. The £15 advertising allocation
stays reserved and untouched** (`docs/advertising.md`).

---

## 1. What is being promised, and what is not

**Organic reach is not promised.** Ten external visits is a **target, not a forecast**. A
post can be removed by a moderator in four minutes, sink without a single upvote, or draw
three hundred visitors — and nothing written here changes which of those happens. Anyone
reading this document should treat every "expected outcome" below as a guess with a wide
error bar.

What *is* under our control: the posts are honest, they are in the right places, and they
do not claim anything the product cannot do.

### How the result will be reported

Three numbers, **always separate, never rolled into one** — the same separation
`apps/app/src/growth/analytics.ts` already enforces:

| Figure | What it is | What it is **not** |
| --- | --- | --- |
| **Observed landing sessions** | Sessions that reached the Worker, classified `external`, deduplicated by a daily-rotating salted hash | Not "unique people". Not interest. One person on a phone and a laptop is two. Somebody who bounces in two seconds counts. |
| **Qualified signups** | A workspace created and a HubSpot connection reaching `ready` | Not customers. Not revenue. |
| **Paying customers** | An active Stripe subscription | The only one of the three that is money |

A visit is not interest, and interest is not a customer. The launch report must never
imply otherwise, and must never present a single blended "results" number.

Sessions classified `internal_test`, `bot_suspected` or `unknown` are excluded from all
three and **never count toward the ten**. Our own testing does not count.

---

## 2. Rules research: what I could read, and what I could not

The lead asked for each community's promotion rules read **from the source**. Here is
exactly how far that got.

| Destination | Rules readable from source? | Evidence quality |
| --- | --- | --- |
| **Hacker News / Show HN** | **Yes** — both guideline pages fetched and quoted below | **Primary** |
| **r/n8n** | **No** | None — see below |
| **r/automate** | **No** | None |
| **r/msp** | **No** | Secondary only |
| **Indie Hackers** | **No** — `indiehackers.com/guidelines` returns HTTP 404 | Secondary, and contradictory |

**Why Reddit rules could not be read.** Every Reddit host is unreachable from this
environment: `www.reddit.com`, `old.reddit.com`, `business.reddit.com` and
`ads-api.reddit.com` all fail to fetch, and the rules JSON endpoints go through the same
hosts. This is the same wall that stopped the ad-minimums research
(`docs/advertising.md` §6.3). I have not guessed at the rules and I have not paraphrased
a rule I did not read.

**So every Reddit destination below carries a mandatory pre-flight step: the founder opens
the subreddit, reads the sidebar rules and the wiki, and confirms the post is permitted
before posting.** That is a thirty-second job on screen and it is the only reliable way to
get this right. Treat my "expected outcome" notes as context, not as a rules check.

**Indie Hackers is worse than unread — it is ambiguous.** The secondary sources conflate
two different destinations: `indiehackers.com` (the website and its groups) and
`r/indiehackers` (a subreddit with its own moderation). They are not the same place and do
not share rules. I have not resolved which set applies to which, so Indie Hackers is listed
below as **conditional**, not recommended.

---

## 3. Destinations: three recommended, one conditional, one dropped

Fewer than five survived, as the lead anticipated. A post that gets removed is worth less
than no post.

| Destination | Verdict |
| --- | --- |
| Show HN | **Recommended** — rules read from source, and the demo page fits what Show HN asks for |
| r/n8n | **Recommended, pre-flight required** — closest audience match in existence |
| r/automate | **Recommended, pre-flight required** — same post, adjusted, posted later |
| Indie Hackers | **Conditional** — only after the founder establishes which guidelines apply |
| r/msp | **Dropped** — see §8 |

---

## 4. Destination 1 — Show HN

### 4.1 The rules, quoted from source

From **<https://news.ycombinator.com/showhn.html>**, read 2026-09-19:

> "Show HN is for something you've made that other people can play with."

> "Off topic: blog posts, sign-up pages, newsletters, lists, and other reading material."

> "Please don't ask friends to upvote or comment. That's not ok on HN."

and the rule that shapes our choice of link:

> "Make it easy for users to try your thing out, ideally without barriers such as signups
> or emails."

From **<https://news.ycombinator.com/newsguidelines.html>**, read 2026-09-19:

> "Please don't use HN primarily for promotion. It's ok to post your own stuff part of the
> time, but the primary use of the site should be for curiosity."

> "Don't solicit upvotes, comments, or submissions."

> "Throwaway accounts are ok for sensitive information, but please don't create accounts
> routinely. HN is a community — users should have an identity that others can relate to."

> "Please don't do things to make titles stand out, like using uppercase or exclamation
> points, or saying how great an article is."

### 4.2 The consequence: link the demo, not the home page

ITISYOU Verify cannot be "tried out" in the Show HN sense. Using it needs a HubSpot
connection, a Resend account, a correlation property on the CRM object, a signing key, and
an edit to the customer's own automation (`docs/product-scope.md` §5). That is a wall of
signup, and the home page is a sign-up page, which Show HN lists as off topic.

**The demo page at `/demo` is the correct link.** It is server-rendered, needs no account,
no email and no JavaScript, and shows four seeded runs reaching four different honest
outcomes. That is something people can play with.

### 4.3 The post

**Title** (78 characters, no uppercase, no exclamation, plain):

> Show HN: Checking whether an automation actually did the job, not just that it ran

**URL:**

```
https://verify.itisyou.app/demo?utm_source=hn&utm_medium=organic&utm_campaign=organic_launch_2026_09&utm_content=showhn
```

**First comment from the author, posted immediately after submitting:**

> I build small automations, and the failure mode that kept catching me out is the one that
> does not throw. The workflow runs top to bottom, the platform's execution log is green,
> and the CRM record was never created — or it went to the wrong record, or the
> acknowledgement email went to the wrong address. You find out when the client rings to
> ask why nobody replied to their enquiry.
>
> So this checks the outcome instead of the run. You tell it what a given enquiry should
> have produced, it goes to HubSpot and Resend itself and reads back what is actually
> there, and it reports one of four things: verified, failed, unverified, or still pending.
> "Unverified" is a first-class answer — it means we could not get enough evidence to say,
> and it is deliberately not a pass and not a failure.
>
> The link is a demo with four seeded runs, no signup. What I would most like feedback on
> is the fourth one, where the honest answer is "I don't know".
>
> Things it deliberately cannot do, because I would rather say this up front than have
> someone find out:
>
> - One workflow shape only: an enquiry that should create a CRM record and send an
>   acknowledgement email. Not quotes, invoices or tickets.
> - HubSpot and Resend only. Different CRM or different email provider, it cannot help.
> - It never looks inside n8n/Make/Zapier. It has no idea *why* a step failed, only whether
>   the outcome exists downstream.
> - It does not fix anything. No writes to your CRM, no resent emails.
> - By default it cannot detect a run that never started, because by default your
>   automation is the thing that tells it a run was expected. Silence is shown as silence,
>   not as a perfect score.
> - Results are not real-time. Evidence is checked on a schedule and a result can take up
>   to an hour to settle.
>
> One bug worth confessing, because it is the exact thing this is supposed to prevent. The
> demo has a health card showing "33%" with a progress bar under it. The bar was rendering
> full width and solid green. The markup was right the whole time — `style="width:33%"` —
> and what was wrong was a Content-Security-Policy I had added an hour earlier. A strict
> policy with no `unsafe-inline` blocks inline `style` attributes too, so the fill fell back
> to its default width, which is all of it. Of every bug I could have shipped, that is the
> one that most directly contradicts the product: a partial result displayed as a pass, on
> the page written to argue that a partial result must never look like a pass. No code
> review would have caught it. The template was correct, the test asserted the template was
> correct, and the CSP was correct in isolation. It took deploying it and looking at a
> screenshot.
>
> No customers yet, nothing is launched, and I am here for the rest of the day if anyone
> wants to tell me it is a bad idea.

### 4.4 Expected outcome

A Show HN with no front-page traction typically gets tens of visits over a day; one that
catches gets hundreds to thousands. **Most Show HNs do not catch.** The realistic median
here is a few dozen visits and two to five comments. That would clear ten. It might also
get four visits.

### 4.5 Do not do this

- **Do not link the home page or the pricing page.** Show HN explicitly lists sign-up pages
  as off topic, and a submission that looks like a landing page gets flagged.
- **Do not ask anyone to upvote.** HN detects voting rings and the penalty is the domain,
  not just the post. This is the single fastest way to lose `verify.itisyou.app` on HN
  permanently.
- **Do not create a fresh account to post this.** Use the founder's real account. A
  day-old account submitting its own product is the standard shape of astroturfing.
- **Do not post and walk away.** "Must be something you've worked on personally and which
  you're around to discuss." Block out the afternoon.
- Do not put an exclamation mark or capitals in the title.

---

## 5. Destination 2 — r/n8n

### 5.1 Rules: NOT READ — pre-flight required

I could not reach Reddit (§2). **Before posting, the founder must:**

1. Open r/n8n, read the sidebar rules in full and the wiki if there is one.
2. Find the rule governing self-promotion / sharing your own project, and confirm this post
   is permitted. If there is a designated day or a designated thread, use it.
3. Check for any account-age or karma minimum, and whether link posts are restricted.
4. If self-promotion is banned outright: **do not post it another way. Drop the
   destination** and tell the lead.

### 5.2 Account

Use the founder's **existing personal Reddit account with real history**, not a new one.
A brand-new account posting a link to a product it owns is the fastest route to a
shadowban, and a domain ban applies site-wide, which would also cost us r/automate and any
future paid campaign on Reddit.

### 5.3 The post

**Title:**

> I kept finding out an automation had silently failed from the client, so I built
> something that checks the outcome. Here is what it can't do.

**Body:**

> The failure that got me was never the one that throws. The workflow runs, the execution
> log is green, and the contact was never created in the CRM — or it was created against
> the wrong record, or the acknowledgement email went to an address with a typo in it.
> Nothing errors. You find out days later when the client asks why nobody replied.
>
> The usual answer is to build a second workflow that queries the CRM and checks. I did
> that for a couple of clients and it was the same work every time, and it still trusted
> the same platform's own read of its own actions.
>
> So I built the check as a separate thing. Your automation sends it a signed event saying
> "enquiry X should now have a CRM record with correlation id Y and an acknowledgement to
> Z". It then goes to HubSpot and Resend itself, reads back what is actually there, and
> checks it against rules you wrote. You get one of four answers: verified, failed,
> unverified, or pending. Your workflow's own "success" is treated as a trigger to go and
> look, never as proof.
>
> The part I care about most is "unverified". If it cannot get the evidence — the CRM
> connection is down, the correlation value is missing, the record is ambiguous — it says
> so. It does not round that up to a pass or down to a failure. Absence of evidence is not
> evidence of either.
>
> **What it genuinely cannot do**, because this is the bit people find out later and get
> annoyed about:
>
> - One workflow shape only: enquiry → CRM record → acknowledgement email. Not quotes, not
>   invoices, not tickets.
> - HubSpot and Resend only. Another CRM or another email provider, it can't help yet.
> - It never looks inside n8n. It has no visibility into your executions and cannot tell
>   you *why* something failed — only whether the outcome exists downstream.
> - It doesn't fix anything. No writes to your CRM, no resent emails. It reads.
> - Setup is real work, not "connect and go": you need a stable correlation value written
>   into a named HubSpot property on every enquiry, a signing key, and one extra HTTP node
>   in your existing flow. If you didn't build the original automation you'll need whoever
>   did.
> - By default it can't tell you a run never started, because your own automation is what
>   tells it a run was expected. That case shows as "no runs received", never as a clean
>   sheet.
> - Not real-time. Checks run on a schedule; a result can take up to an hour to settle.
>
> Best bug so far, which is also the most embarrassing: the demo page shows a health card
> reading "33%" with a progress bar under it, and the bar was rendering full width and
> solid green. The markup was fine — `style="width:33%"`. The problem was a
> Content-Security-Policy I'd added an hour before: a strict policy with no `unsafe-inline`
> blocks inline `style` attributes as well as inline stylesheets, so the fill fell back to
> its default width, which is 100%. The entire point of the product is that a partial
> result must never display as a pass, and I shipped a bar inflating 33% to 100% on the
> page written to demonstrate exactly that. Nothing in review would have found it — the
> template was right, the test asserted the template was right, and the CSP was right in
> isolation. It took looking at a screenshot of the deployed page.
>
> There's a demo with four seeded runs if you want to see the four outcomes, no signup:
> [link]
>
> No customers yet, nothing launched. Mostly I want to know whether the "unverified"
> distinction is useful to you or just pedantry, and whether the setup cost is too high for
> what it gives you.

**Link, placed where the rules allow** (in the body if link posts are fine, otherwise in
the founder's own first comment):

```
https://verify.itisyou.app/demo?utm_source=reddit&utm_medium=organic&utm_campaign=organic_launch_2026_09&utm_content=r_n8n
```

### 5.4 Expected outcome

r/n8n is the single closest audience match available — these are literally the people in
`docs/product-scope.md` §1. A technical post with a visible limitations list and a real bug
story tends to do well in tool subreddits. **Realistic: 20–150 visits if it stays up, near
zero if a moderator removes it as promotion.** The removal risk is the dominant variable and
I cannot size it, because I could not read the rules.

### 5.5 Do not do this

- **Do not post it as a link post with a bare URL and no text.** That reads as an
  advertisement and is the most commonly removed shape.
- **Do not lead with the product name.** Lead with the problem. The title above does.
- **Do not post the same text to r/n8n and r/automate on the same day.** Cross-posting
  identical promotional text across subreddits is the classic spam signal and can trigger a
  site-wide action.
- Do not argue with a moderator if it is removed. Ask once, politely, what would have been
  acceptable, and accept the answer.
- Do not edit the post to add a link after it gains traction. That is a known bait pattern
  and moderators watch for it.

---

## 6. Destination 3 — r/automate

### 6.1 Rules: NOT READ — pre-flight required

Same as §5.1. Read the sidebar and the wiki first. r/automate covers a broader range of
automation than n8n specifically, so confirm the post is on topic as well as permitted.

### 6.2 Timing

**Post this at least five to seven days after r/n8n**, and only if r/n8n was not removed.
Two reasons: near-simultaneous posts of similar text across subreddits is the spam pattern
described in §5.5, and if r/n8n gets removed for a rule I could not read, we learn that
before spending the second destination.

### 6.3 The post

**Title:**

> Built a checker for the automation failure that doesn't throw an error — outcome
> verification rather than run monitoring

**Body:** the r/n8n body from §5.3, with these changes:

- Replace "It never looks inside n8n" with "It never looks inside your automation platform
  — n8n, Make, Zapier or anything else."
- Replace "one extra HTTP node in your existing flow" with "one extra outbound call from
  your existing flow".
- Cut the paragraph beginning "The usual answer is to build a second workflow" down to one
  sentence, since this audience is broader and the post should be shorter.
- Keep the limitations list and the CSP bug in full. They are the parts that make it a
  build log rather than an advert.

**Link:**

```
https://verify.itisyou.app/demo?utm_source=reddit&utm_medium=organic&utm_campaign=organic_launch_2026_09&utm_content=r_automate
```

### 6.4 Expected outcome

Broader and less targeted than r/n8n. **Realistic: 10–60 visits**, of which a smaller
proportion are the actual buyer.

### 6.5 Do not do this

- Do not post before r/n8n has been up for a week (§6.2).
- Do not reuse the r/n8n title verbatim. Identical titles across subreddits is the pattern.
- Do not post a third and fourth subreddit "while we're at it". Two is a launch; five is a
  campaign, and it will be treated as one.

---

## 7. Destination 4 (conditional) — Indie Hackers

### 7.1 Rules: NOT READ, and the destination is ambiguous

`https://www.indiehackers.com/guidelines` returns **HTTP 404**, so there is no guidelines
page at the obvious URL. The secondary sources I found describe rules for **r/indiehackers**
(a subreddit) — one-self-promotion-post-per-product under a "SHOW IH" flair, framed as a
request for feedback rather than an announcement, with MRR claims requiring proof — and it
is not clear those apply to the `indiehackers.com` site at all.

**This destination is not recommended until the founder resolves which place they mean and
reads that place's actual rules.** It is included because the *framing* below is right for
either, once that is settled.

### 7.2 The post, if it goes ahead

**Title:**

> Feedback wanted: I built outcome verification for automations, and I think the setup cost
> might be too high

**Body:** the structure these communities reward is background → problem → what I tried →
what happened → what I learned, with the ask at the end:

> **Background.** Small automations that get an enquiry into a CRM and fire an
> acknowledgement email. I maintain a few for clients.
>
> **Problem.** The failure that costs you the client is the one that doesn't throw. Green
> execution log, no CRM record. You find out when they ring.
>
> **What I built.** A separate service that checks the outcome rather than the run: it reads
> the record back from HubSpot and the message event from Resend itself, checks both against
> rules you wrote, and returns verified / failed / unverified / pending. "Unverified" is a
> real answer — missing or ambiguous evidence is never rounded to a pass.
>
> **What I learned, and where I want a second opinion.** Onboarding is heavy. You need a
> correlation value written into a named HubSpot property on every enquiry, a signing key,
> and an extra call added to your existing automation. Anyone who didn't build the original
> flow needs the person who did. I've been honest about that on the site rather than hiding
> it behind "connect and go", and I'm now unsure whether that honesty is costing me more
> sign-ups than the friction itself.
>
> **The bug I'd rather tell you about than have you find.** The demo's health card showed
> "33%" above a progress bar that rendered full width and solid green. The markup was
> correct; a Content-Security-Policy added an hour earlier blocked inline `style`
> attributes, so the fill fell back to 100%. On the page whose entire argument is that a
> partial result must never look like a pass. Template right, test right, policy right in
> isolation — only a screenshot of the deployed page found it.
>
> No customers, nothing launched, no revenue to report. Demo with four seeded runs, no
> signup: [link]
>
> **The ask:** is the setup cost disqualifying, or is it the normal price of this kind of
> tool? I'd rather hear "too heavy" now than after I've built more of it.

**Link:**

```
https://verify.itisyou.app/demo?utm_source=indiehackers&utm_medium=organic&utm_campaign=organic_launch_2026_09&utm_content=ih_feedback
```

### 7.3 Expected outcome

**Low — realistically 5–30 visits.** Indie Hackers traffic is mostly other founders, not
automation agencies, so the value here is critique rather than visits. Judge it on the
quality of the replies, not the number.

### 7.4 Do not do this

- **Do not post it until §7.1 is resolved.** Posting to the wrong place under the wrong
  rules is how a product gets a permanent removal.
- **Do not state or imply any revenue figure.** The secondary guidance is consistent that
  MRR claims without proof get removed, and we have no revenue anyway.
- Do not frame it as an announcement. The permitted frame is a feedback request, and the
  title above is one.
- Do not post it a second time when there is news. One post per product.

---

## 8. Dropped — r/msp

**Dropped from the first wave.**

r/msp is the community of managed service providers, which overlaps our buyer. But the
consistent finding across every secondary source is that it is **strongly vendor-hostile**
and operates strict anti-self-promotion rules: product mentions are expected to be rare and
only where genuinely helpful, and the community is described as having been repeatedly
burned by oversold tooling.

I could not read the actual rules (§2). Posting a product link, from an account with no
history in that community, into the subreddit most likely to treat it as vendor spam, is the
highest-risk option on the list — and a removal there can attract a site-wide domain flag
that would also cost us r/n8n, r/automate and any future paid Reddit campaign.

**It can come back** if the founder reads the sidebar and finds a designated vendor thread
or self-promotion day, and uses it. It should not be entered any other way, and it should
not be first.

---

## 9. Pre-flight checklist

Performed by the founder, in order. Nothing is posted until every box on that destination's
row is ticked.

**Before anything:**

- [ ] `https://verify.itisyou.app/demo` loads correctly over HTTPS, on mobile and desktop.
- [ ] The 33% progress bar renders at 33%. The bug in every post above is fixed, and the
      post will be read by people who check.
- [ ] The demo requires no signup, no email and no JavaScript.
- [ ] `ANALYTICS_SALT` is set in the deployed environment, or no visit is counted at all.
- [ ] A UTM'd link has been opened once and confirmed to land correctly with parameters
      intact and no redirect stripping them.

**Per destination:**

- [ ] Rules read on screen, and the specific self-promotion rule identified.
- [ ] Account-age / karma requirement checked, and the account being used meets it.
- [ ] The account has genuine prior history in that community, or the post is not made.
- [ ] Posting at a sensible hour for a UK/US technical audience, with the founder free to
      answer replies for the next several hours.

---

## 10. Claims check

Every post above has been checked against `docs/product-scope.md` and the forbidden-phrase
list enforced by `forbiddenClaimsIn()` in `apps/app/src/growth/approval.ts`.

**Not present in any post:** guaranteed accuracy · certified secure · works with every AI ·
never lose a lead · 100% uptime · real-time verification · instant results · any income or
revenue claim · any testimonial · any customer count · any "trusted by".

**Present in every post, deliberately:** the one supported workflow shape; HubSpot and
Resend only; no visibility into the automation platform; no writes and no fixes; the real
onboarding cost; the coverage-mode limitation on undetected runs; results not being
real-time; and that there are **no customers yet**.

That last one is not modesty. "No customers yet, nothing launched" is true, it is the
correct register for all four destinations, and it removes any temptation to imply traction
we do not have.

**One judgement call recorded for the lead:** the posts say the service "reads the record
back from HubSpot and the message event from Resend itself". That is what the code does
(`EvidenceOrigin: 'provider_readback'`; `packages/connectors/src/hubspot.ts` and
`resend.ts`). It has not been exercised against a live HubSpot or Resend account from this
repository. The posts do not claim it has, and pairing it with "no customers yet, nothing
launched" keeps the reader's expectation correct — but if the lead wants the claim softened
to describe the design rather than the behaviour, say so and I will reword all four.

---

## 11. Measurement

All four destinations share `utm_campaign=organic_launch_2026_09` and differ by
`utm_content`, so each post's contribution is separable without any cross-site tracking.

Reported as three separate figures (§1). Additional honesty required in the launch report:

- Visitors who strip UTMs, arrive from a copied link, or come via an aggregator will be
  counted as **external but unattributed**. They are real visits and must be reported as
  such, not dropped for being untidy and not assigned to a post that may not have produced
  them.
- HN and Reddit report their own view counts. **Those are not our visits and must not be
  added to ours**, any more than ad-platform clicks may be added to landing sessions.
- The session id rotates every UTC day, so somebody returning the next day counts twice.
  The figure is an estimate of visits and is never presented as unique people.
- Attribution to a post is only possible for **14 days**, because the visit row is deleted
  at that point under A09's retention policy. A signup three weeks after a post is reported
  as a signup with no attributable source — which is the truth, not a gap to fill in.

---

### Approval

- [ ] I have read all four posts and the claims check in §10.
- [ ] I accept that organic reach is not promised and ten visits is a target, not a forecast.
- [ ] I will perform the §9 pre-flight, including reading each community's rules on screen.
- [ ] I understand r/msp is dropped and why.
- [ ] I will publish these myself. Nothing here is posted on my behalf.

**Signed:** ______________________  **Date:** ______________
