# How ITISYOU Verify was built

A factual record of what was decided, what was built, what broke, and what is still
unfinished. Written as it happened. Where something has not been proven, this page says
so rather than rounding it up.

Last updated: **19 September 2026**.

---

## The problem

An automation platform tells you a run succeeded. That claim comes from the automation
itself. If the step that was supposed to create a CRM record silently did nothing, or the
acknowledgement email was accepted by the sending service and then bounced, the run still
reports success — because from the automation's point of view, it finished.

Agencies running workflows for clients find out days later, from the client.

The gap is not monitoring. Error alerts fire when something throws. This is about the
cases where nothing throws and the outcome still is not there.

## The idea

Go and look.

Read the CRM record back from the CRM. Read the email outcome back from the email
provider. Check both against rules the customer set. Report what the evidence supports —
and, crucially, report honestly when the evidence is missing rather than guessing.

That last part is the whole design constraint. A verification service that quietly turns
"we could not check" into "passed" is worse than no service, because it manufactures
false confidence.

## The four statuses

| Status | What it means |
| --- | --- |
| **Verified** | Every mandatory check has supporting evidence. |
| **Failed** | Evidence contradicts a rule, or the deadline passed while evidence access was working. |
| **Unverified** | Access, correlation or evidence is missing or ambiguous. Not a pass. Not a failure. |
| **Pending** | Still inside the agreed completion window. |

`Unverified` exists because the honest answer is often "we do not know", and collapsing
that into either of the other two would be a lie in one direction or the other.

---

## Decisions, and why

### Why only one workflow shape

Version one checks exactly one thing: *an enquiry should create the correct CRM record and
trigger an acknowledgement email*, using HubSpot and Resend.

A connector marketplace would have been more impressive and less useful. Each provider
brings its own auth model, its own event semantics, its own idea of what "delivered"
means, and its own rate limits. Getting one pair genuinely right — proving the evidence is
independent and correlated — is a harder and more valuable thing than wiring ten providers
we cannot prove anything about.

### Why the rule language is deliberately small

Customers define expectations using a closed set of typed operators — `exists`, `equals`,
`normalised_email_equals`, `occurred_within`, `provider_status_in`, `one_of` — over an
allowlisted set of fields.

The alternative was a general expression language. It was rejected: a general language
lets a customer rule become an unbounded computation or a network request, and it makes
the distinction between "failed" and "could not be checked" impossible to prove. A small
language is a feature here, not a limitation we plan to remove.

### Why email addresses are not "normalised" the way you might expect

The email comparison lowercases, trims, and strips display-name brackets. It deliberately
does **not** strip `+tags`, and it does not strip dots.

Stripping `+tag` would mean `boss+anything@corp.com` — an address the customer controls —
could satisfy a rule about having emailed `boss@corp.com`. Verification must never widen
an equivalence class. Dot-stripping is a Gmail-specific convention and is simply wrong for
other providers.

### The line between "wrong" and "unknown"

This took the most care to get right.

- The provider answered, and the value is wrong → **contradicted**.
- The provider answered, and the field was not in the answer → **unknown**. We cannot call
  a value wrong when we do not have it.
- The provider answered and the field is genuinely empty → **contradicted**. That is an
  authoritative empty.
- We could not reach the provider → **unknown**, always. Our outage is not the customer's
  failure.

Only two situations can turn a missing outcome into a **failure** at the deadline: the CRM
authoritatively reporting that no such record exists, and the email provider
authoritatively reporting that no such event occurred. A timeout never qualifies.

### Why your own automation's word is not evidence

Evidence carries an origin: we asked the provider ourselves, the provider called us and we
verified its signature, or the customer's own system told us.

The third can never support a mandatory check. The result says so in plain language — and
deliberately does not imply the customer is lying. It says what *we* do: we check
everything against the connected systems ourselves, and a system reporting on its own work
is not something we can count as proof either way.

### What this cannot detect

If a workflow is supposed to run and never starts, and the workflow is the thing that tells
us a run was expected, we will not know a run was missing. Every result shows its coverage
mode, and "no runs received yet" is displayed as exactly that — never as a perfect score.

Being straightforward about this costs us a better-sounding pitch. It is the correct trade.

---

## Architecture

One Cloudflare Worker serves the site, the customer application, the owner dashboard and
the API. Cloudflare D1 holds the data, in EU-West because the business is in the UK.
Background work runs from a one-minute cron trigger over a single indexed query.

Cloudflare Queues were considered and not used. A due-job table with a partial index is
deterministic, testable without a network, and adds no delivery semantics we would then
have to design around. The service runs whether or not any developer machine is switched
on — that was a requirement, not an aspiration.

---

## What broke, and what it taught us

### The allowance reservation that silently did nothing

Admitting a source event has to do three things atomically: record the event, reserve one
run from the customer's allowance, and queue the follow-up work.

The obvious implementation guards the reservation with a conditional `UPDATE`. On D1 that
is wrong in a way that does not announce itself: a conditional update inside a batch
**cannot abort the batch**. It reports zero rows changed — after the inserts have already
committed. The event would have been admitted without consuming an allowance.

The fix writes the reservation so that exhausting the allowance violates a `NOT NULL`
constraint, which does roll the whole batch back. It reads oddly. It is correct, and there
is a test that fails if anyone "tidies" it.

### A credential binding that bound nothing

Stored provider credentials are encrypted with the workspace, provider and purpose mixed
into the authenticated data, so ciphertext moved to another tenant will not decrypt.

The independent security review found the flaw: the function that opens a credential
accepted the expected binding as an *optional* argument. Any helper that looked a
credential up by its id and forgot to pass it would decrypt any tenant's row — because the
stored binding travels with the row and satisfies the check on its own.

The binding was real. The API made forgetting it easy. That is the same thing as not
having it.

### Push protection caught us

GitHub's push protection blocked a push because test fixtures were shaped like real API
keys. They were synthetic — all zeros — but shape is what a scanner sees.

The fixtures were rewritten so they are assembled at runtime and no credential-shaped
literal is committed. The alternative — clicking "allow this secret" — would have trained
us to dismiss the one warning that will one day be real.

### 33% that displayed as 100%

The demo page shows a workflow health card: a big "33%" with a progress bar underneath.
The bar was rendering full width and solid green.

The markup was right the whole time — `style="width:33%"`. What was wrong was the
Content-Security-Policy added an hour earlier. A strict policy with no `unsafe-inline`
blocks inline `style` attributes as well as inline stylesheets, so the fill fell back to
its default width, which is all of it.

Of every bug this project could have shipped, this is the one that most directly
contradicts what it sells. The entire argument for the product is that a partial or
unknown result must never be displayed as a pass. A bar inflating 33% to 100% does
exactly that, on the page written to demonstrate the opposite.

Nothing in the code review would have found it. The template was correct, the test
asserted the template was correct, and the policy was correct in isolation. It took
deploying the page and looking at a screenshot.

The first fix was a narrow exception: permit inline style *attributes*, keep blocking
inline scripts and injected stylesheets, and write into the policy why the exception
existed and what would have to change before it could be removed.

That exception is gone. The better fix was to stop needing it — the computed width moved
out of a style attribute and into a small set of predefined CSS classes, so the policy
went back to refusing inline style attributes entirely. The classes round **down**: 33%
draws as 30, 99% draws as 95, and only a true 100% fills the bar. On a product whose
whole argument is that a partial result must never look complete, a bar that errs
generous is worse than one that errs mean.

The deployed page was checked afterwards rather than assumed: `style-src-attr 'none'` in
the response header, zero inline style attributes in the markup, and the meter rendering
as `meter__fill--30`.

*(This paragraph previously described only the exception. It was caught during a later
audit of the deployed site against the documentation — the story was underselling its own
fix, which is a smaller sin than the reverse but the same class of drift.)*

### A pinned action that did not exist

The CI workflow pins every GitHub Action to a full commit SHA, because a tag can be
repointed at new code by whoever controls the action.

One of the pinned SHAs resolved to no commit at all. It was caught by checking all three
against the GitHub API instead of trusting the list. Pinning without verifying is a
ritual, not a control.

---

## How the work was organised

Twelve specialist roles, each given a bounded task, a set of files it alone owns, and the
specific facts it needed rather than the whole repository. They reported back with the
commands they ran and the real output.

Some findings only exist because the reviewer was a different agent from the author. The
security review was told to challenge the implementation, not confirm it, and it wrote
tests that fail against real defects rather than a document full of reassurance. Six such
tests were committed **red**, on purpose, and closed one at a time.

One deliberate duplication: the security reviewer and the data specialist independently
implemented webhook signature verification for Stripe and for Resend, from the vendor
specifications, without seeing each other's code. Both implementations were then tested
against each other. Two separate readings of a specification agreeing is the strongest
evidence available without a live provider call — and it is not the same as a live
provider call, which is why the report says both things.

Models were chosen by risk rather than by default. Architecture, payments, tenant
isolation and security review went to the strongest available model. Product copy and
competitor research went to a cheaper one. Bounded scripting tasks went to cheaper ones
still. Counting tests, validating a schema and scanning for secrets are done by code, not
by a model — those are exactly the jobs where a model would be slower, dearer and less
reliable.

---

## Where it stands

**Built and tested.** The verification engine, the data layer, the security primitives,
the connectors, payments, the customer journey, support and privacy handling.

**Live.** `verify.itisyou.app`, serving over TLS, with a health check that actually probes
the database instead of returning a hard-coded "ok".

**Not yet true.** Live payments, because that needs the owner's verified business details.
Provider-backed evidence against real HubSpot and Resend accounts, because those
credentials do not exist yet — until they do, the connector path is proven against mocks,
and this page will not pretend otherwise. Advertising, because no campaign has been
approved and nothing has been spent.

**Spent so far: £0.00** of the £100 budget. The £30 contingency is untouched.

---

*This page is generated from the same record as the machine-readable story in
`docs/development-story-events.json`. If the two ever disagree, that is a defect in this
page.*
