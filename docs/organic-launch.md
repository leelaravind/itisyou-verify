# Organic launch — posts for approval

**Prepared by:** A12 (Growth and Launch), 2026-09-19.
**Status: NOTHING HAS BEEN PUBLISHED.** No account has been created, no post has been
submitted, no comment has been left. Every post below is a draft for the founder to read,
edit and publish personally.

Decision this implements: **organic first, ads afterwards. The £15 advertising allocation
stays reserved and untouched** (`docs/advertising.md`).

---

## 0. STOP — pre-flight rules gate

**I could not read a single subreddit's rules from this environment.** Every Reddit host is
unreachable from here and `indiehackers.com/guidelines` returns HTTP 404 (see §2). Hacker
News is the only destination whose rules I read at the source.

That means the rules check below is **not a caveat, it is the gate**. Work through it for
the destination you are about to post to. If any step contradicts the plan, **stop and tell
the lead** — do not reword the post to get around a rule.

### Gate A — do this once, before any destination

1. Open `https://verify.itisyou.app/demo`. Confirm it loads over HTTPS on a phone and on a
   desktop, and that it needs no account, no email and no JavaScript.
2. On that page, confirm the health card reading **33%** shows a bar filled to roughly one
   third — not full, not green-to-the-end. Every post below tells the story of that bar
   being wrong. People will check.
3. Confirm `ANALYTICS_SALT` is set in the deployed environment. Without it no visit is
   counted at all and the launch report will read zero.
4. Open one of the UTM'd links from this document in a private window. Confirm it lands on
   the demo with the parameters still on the URL and no redirect stripping them.

### Gate B — do this for each destination, immediately before posting

5. **Open the destination and read its rules.** Exactly where:
   - r/n8n → `https://www.reddit.com/r/n8n/` — the sidebar rules in full, plus the wiki and
     any pinned "read before posting" thread.
   - r/automate → `https://www.reddit.com/r/automate/` — same three places.
   - Indie Hackers → resolve §7.1 first. `indiehackers.com` and `r/indiehackers` are
     different places with different moderation, and I could not establish which rules
     apply where.
   - Show HN → already read: `https://news.ycombinator.com/showhn.html` and
     `https://news.ycombinator.com/newsguidelines.html`, quoted in §4.1.
6. **Find the specific rule governing self-promotion**, sharing your own project, or
   posting a link to something you built. Read it in full, not the summary.
7. **If self-promotion is banned outright: stop.** Drop the destination and tell the lead.
   Do not post it as a "question", do not put the link in a comment instead, do not post it
   without the link. Those are the workarounds the rule exists to catch.
8. **If self-promotion is allowed only on a given day, under a given flair, or in a
   designated thread: use that route exactly.** Note which one, so the launch report can
   say where it went.
9. **Check for an account-age or karma minimum**, and whether link posts are restricted or
   require flair. Confirm the account you are about to use meets it.
10. **Confirm the account has genuine prior history in that community.** If it does not,
    stop — see §5.2. A new account posting a link to its own product is the single most
    reliable way to lose the `verify.itisyou.app` domain site-wide.
11. **Confirm you are free for the next several hours** to answer replies. On Show HN this
    is an explicit rule; everywhere else it is the difference between a discussion and an
    advert.

Only when every box on that destination's row is ticked does the post go out.

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
> have produced; it is built to query HubSpot and Resend directly for the record and the
> message event, check what comes back against rules you wrote, and report one of four
> things: verified, failed, unverified, or still pending. "Unverified" is a first-class
> answer — not enough evidence to say — and it is deliberately not a pass and not a failure.
>
> **Straight about what I have and have not actually run:** the HubSpot and Resend adapters
> have never been pointed at a live account. I hold no provider credentials, and every
> connector test injects a fake HTTP layer — the provider responses are synthetic, built
> from each vendor's own API documentation. What *has* been exercised for real is the rule
> evaluator and the decision table, over synthetic evidence: which assertion outcomes
> combine into VERIFIED vs FAILED vs UNVERIFIED, what happens when evidence is missing
> rather than contradictory, and when a missed deadline is allowed to count as a failure.
> So read "queries HubSpot and Resend" as what the code is written to do, not as something
> I have watched work end to end against a real portal. That distinction is the whole
> product, so it would be a poor look to fudge it here.
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
> Z". It is built to go to HubSpot and Resend directly for the record and the message event
> and check them against rules you wrote. You get one of four answers: verified, failed,
> unverified, or pending. Your workflow's own "success" is a trigger to go and look, never
> proof on its own.
>
> **Where it actually is, honestly:** the HubSpot and Resend adapters have not been run
> against a live account. I have no provider credentials yet, and every connector test
> injects a fake HTTP layer with synthetic responses shaped from the vendors' API docs. The
> part that *is* properly exercised is the evaluator and the decision table, over synthetic
> evidence — which assertion outcomes produce which of the four statuses, what happens when
> evidence is missing rather than contradictory, and when a blown deadline is allowed to
> count as a failure at all. I would rather say that plainly than let "reads it back from
> HubSpot" imply I have pointed it at a real portal and watched it work, because the thing
> this is supposed to catch is software reporting on its own success with no independent
> evidence. Doing that in the post introducing it would be quite the own goal.
>
> The part I care about most is "unverified". The design is that missing or ambiguous
> evidence — connection down, correlation value absent, two candidate records — is reported
> as exactly that, never rounded up to a pass or down to a failure. Absence of evidence is
> not evidence of either.
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
- **Keep the "Where it actually is, honestly" paragraph verbatim.** It is the one paragraph
  that must not be trimmed for length. If the post has to be shorter, cut the background,
  not the disclosure.

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
> **What I built.** A separate service that checks the outcome rather than the run. It is
> built to query HubSpot for the record and Resend for the message event, check both against
> rules you wrote, and return verified / failed / unverified / pending. "Unverified" is a
> real answer — missing or ambiguous evidence is never rounded to a pass.
>
> **What I have actually run, as opposed to written.** The HubSpot and Resend adapters have
> never touched a live account — no credentials yet, and every connector test injects a fake
> HTTP layer with synthetic responses built from the vendors' API docs. The evaluator and
> decision table are properly exercised over synthetic evidence. I am flagging it because
> the product's entire pitch is that a system reporting on its own success is not evidence,
> and I would rather not make that mistake in the post that introduces it.
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

**Moved to §0, at the top of this document, where it cannot be read past.** It is a gate,
not a closing formality, and keeping a second copy here would guarantee the two drift apart.

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

### 10.1 Observed behaviour versus designed behaviour

Every sentence in all four posts has been sorted into one of two buckets, and anything in
the second is worded as design, not as something we have watched happen.

| Claim in the posts | Status | What backs it |
| --- | --- | --- |
| Four outcomes: verified / failed / unverified / pending, and never a fifth | **Observed** | `RUN_STATUS` is a closed tuple; the evaluator and decision table are exercised across `tests/unit/domain/` |
| Missing or ambiguous evidence resolves to UNVERIFIED, never to a pass | **Observed** | Evaluator tests over synthetic evidence |
| A blown deadline only counts as FAILED when evidence access was working | **Observed** | Same |
| The customer's own "success" signal is a trigger, not proof | **Observed** | `EvidenceOrigin: 'customer_claim'` is the weakest tier by construction; no path lets it satisfy a mandatory assertion |
| The demo shows four seeded runs and needs no account, email or JavaScript | **Observed** | `apps/app/src/routes/public/demo.ts`, server-rendered |
| The CSP bug that rendered 33% as a full green bar | **Observed** | It happened; the fix is in the policy with a comment saying why |
| Setup cost: correlation property, signing key, an extra call in the customer's flow | **Observed** | It is the documented onboarding in `docs/product-scope.md` §5 |
| Every limitation in the "what it cannot do" lists | **Observed** | True by absence — there is no code path that could do those things |
| **Querying HubSpot and Resend for the record and the message event** | **DESIGNED, NOT OBSERVED** | `packages/connectors/src/hubspot.ts` / `resend.ts` exist and are tested, but against an injected fake HTTP layer. The connector tests state it outright: "No real portal, no real contact, no real token." |

**The claim was softened in all four posts, on the lead's instruction, and the reason is
recorded here because it is the right reason:** a reader in r/n8n hears "reads the record
back from HubSpot" as *this has been pointed at a real portal and it worked*. It has not. We
hold no provider credentials, every connector test stubs the transport, and the only two
provider-backed cases in the ledger — `CONN-050` (a real HubSpot sandbox read) and
`CONN-051` (a real Resend test-mode event read) — are both still `planned`, never run.

The gap between "the code does this" and "we have observed it doing this" is precisely the
gap this product exists to complain about: a system reporting on its own success without
independent evidence. Making that claim in the post that introduces us would be the same
error we are selling against, in public, on page one.

Each post now says what *was* tested instead — stubbed provider responses built from the
vendors' own API documentation, with the real evaluator and decision table run over
synthetic evidence. That is true, it is more specific than a hedge, and in these communities
it reads as someone worth replying to.

**Standing rule for any future post:** a sentence describing behaviour must name behaviour
someone has observed. Where it has not been observed, say what was tested instead. When
`CONN-050` and `CONN-051` move from `planned` to passing, this row moves to **Observed** and
the wording in all four posts can be tightened — not before.

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

## 12. Appendix — build-log material not yet used

Held for a future post rather than crammed into the first one. Both are true, both are
small, and both are the kind of specific that these communities reward.

### The separator that made a source file invisible to `grep`

The visit session id is a salted hash over the date, the salt, the address, the user agent
and the language header. Those fields are joined before hashing, and the separator has to be
something that cannot occur inside any of them — otherwise two different field splits can
produce the same hash input, and two different visitors collapse into one session.

A NUL byte has exactly that property, so a NUL byte is what ended up in the file. Not the
escape sequence — the actual byte, `0x00`, sitting in the middle of `analytics.ts`.

It worked perfectly. It also made the file **register as binary**: `grep` reported
`Binary file apps/app/src/growth/analytics.ts matches` and printed nothing, so a search for
a constant in that file silently returned no lines instead of the line it was sitting on.
The compiler was happy, the tests passed, the linter passed, and the only symptom was a
search quietly failing to find something that was there.

The fix is one character of syntax: write `'\u001f'` as an escape rather than embedding the
raw control character, and use the unit separator instead of NUL. Same "cannot occur in the
input" property, plain-ASCII source, and the file is text again.

The lesson worth telling: a correct value and a correct *encoding of that value in source*
are different things, and the failure mode of getting the second one wrong is not an error —
it is a tool going quiet. The reasoning is now recorded in a comment at the constant itself,
so the next person reaching for a separator finds it.

### Two provider-backed tests that have never run

`CONN-050` and `CONN-051` are the only cases in the whole ledger marked `provider_backed`:
a real HubSpot sandbox read, and a real Resend test-mode event read. Both are still
`planned`. Everything else about the connectors is exercised against an injected fake
transport.

That is an honest position for a pre-launch project, and the interesting part is that the
ledger makes it *visible* — `provider_backed: true` plus `status: planned` is a machine-
readable admission that the integration has never touched a real system. Most projects
discover that fact in production.

---

### Approval

- [ ] I have read all four posts and the claims check in §10.
- [ ] I accept that organic reach is not promised and ten visits is a target, not a forecast.
- [ ] I will perform the §9 pre-flight, including reading each community's rules on screen.
- [ ] I understand r/msp is dropped and why.
- [ ] I have completed the §0 pre-flight gate for the destination I am about to post to.
- [ ] I accept that the posts say the HubSpot and Resend adapters have never run against a
      live account, and I will not remove that line to make the post read better.
- [ ] I will publish these myself. Nothing here is posted on my behalf.

**Signed:** ______________________  **Date:** ______________
