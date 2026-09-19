# Privacy and data retention

**Owner:** A09 (customer care and privacy).
**Last reviewed:** 2026-09-19.

This document describes what ITISYOU Verify actually does with data, as built. It is not
legal advice, and it is not finished legal text. Where a fact belongs to the business
owner rather than to the software, it is marked `TODO_OWNER_INPUT` and left blank — a
company registration, trading address, VAT status or regulator approval is never invented
here.

The retention table below is generated from `apps/app/src/privacy/retention.ts`, which is
the code that actually deletes things. A test (`API-330`) compares the two, so this page
cannot quietly drift from the behaviour it describes.

---

## 0. What is running today, and what is not

**This section must be read before the rest, and deleted only when it is no longer true.**

A privacy notice is a promise about behaviour. The usual way one becomes a lie is not a
false sentence — it is a true sentence about a function nobody calls. So this document was
re-audited on 2026-09-19 with a harder question than "is this implemented": **does a real
request or a real scheduled tick reach it?** The service is not accepting live traffic and
is not taking payment, and this is the honest account of what that means for the promises
below.

**Enforced by running code today.** Only one thing on this page is:

| Promise                                                                    | What actually runs it                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The retention periods in §2, and the batched deletion described under them | The production cron (`* * * * *` in `wrangler.jsonc`) → `scheduled()` in `apps/app/src/index.ts` → `handleScheduled` → `runRetentionPass` → `runRetentionSweep`, against real D1. Staging deliberately has no cron. |

**Implemented, tested, and reached by nothing yet.** Each of these is written, has passing
tests, and has no route or tick that invokes it. None of it is a false description of the
code; all of it is a promise a customer cannot currently exercise:

| Promise                                                                                                               | What is missing                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The data export in §5                                                                                                 | No route calls it. There is no `/app/export` page and no API endpoint.                                                                                                                                                                               |
| Workspace deletion in §5 and §6                                                                                       | No route calls it. There is no `/app/delete` page. Deletion cannot be requested, scheduled or carried out today.                                                                                                                                     |
| "Support and cancellation remain reachable even when the service is paused" (§5)                                      | The list of always-reachable paths exists in code and nothing consults it. There is no pause middleware.                                                                                                                                             |
| A signed-out visitor being able to reach support (§5)                                                                 | The only support form is behind sign-in, at `/app/support`. The public support page publishes no address, because the owner has not supplied one — see `TODO_OWNER_INPUT` in §1. A signed-out person currently has no route to us at all.            |
| Support bodies being stripped of credentials, tokens, card-shaped numbers and other addresses **before** storage (§2) | The redaction is written and tested, and the mounted support route does not call it. The `body_redacted` column currently receives what the customer typed. **This is the most serious item on this list and is being treated as release-blocking.** |
| Support messages about deletion, billing disputes or security going straight to a person (§5)                         | The deterministic triage is written and tested; the mounted route hard-codes every case to category `other`, priority `normal`, state `open`. Nothing escalates.                                                                                     |

Nothing in the table above is a reason to soften the promises themselves. They are the
right promises; they are simply not yet ones this service can keep, which is precisely why
it is not open. **This section comes out when each row has an entry point named in it, not
when the code exists.**

---

## 1. Who we are

| Field                                 | Value                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Service name                          | ITISYOU Verify                                                            |
| Legal structure                       | UK sole trader                                                            |
| Trading name                          | `TODO_OWNER_INPUT`                                                        |
| Contact address for privacy enquiries | `TODO_OWNER_INPUT`                                                        |
| Contact email for privacy enquiries   | `TODO_OWNER_INPUT`                                                        |
| VAT registration status and number    | `TODO_OWNER_INPUT`                                                        |
| Data protection registration (ICO)    | `TODO_OWNER_INPUT` — not claimed unless the owner holds and evidences one |
| Certifications                        | None. We hold no security certification and claim none.                   |

We are a one-person business. We do not have a dedicated data protection officer, and we
do not pretend to. Requests reach a person, and that person is the owner.

---

## 2. What we hold, and for how long

| Data                           | What it is                                                                                                                                                    | How long we keep it                 | How it is removed                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw webhook and event payloads | The exact bytes a provider or your automation sends us, before we check and normalise them.                                                                   | 0 days — never stored               | Discarded in the same request, after the signature is checked. We keep a hash and a minimal validated envelope.                                                                 |
| Evidence                       | The CRM record fields and email status events your workflow rules reference, as read back from HubSpot and Resend.                                            | 30 days                             | Swept on expiry, in small indexed batches                                                                                                                                       |
| Source events and run results  | The validated envelope of each signed event, and the run, assertions and status that came from it.                                                            | 90 days                             | Swept on expiry, in small indexed batches                                                                                                                                       |
| Webhook receipts               | Provider name, event id, a payload hash and the processing outcome. No payload.                                                                               | 30 days                             | Swept on expiry, in small indexed batches                                                                                                                                       |
| Notification records           | Which template went to which hashed address, when, and what the sending service said. Never the message body, never the address itself.                       | 180 days                            | Swept on expiry, in small indexed batches                                                                                                                                       |
| Support cases                  | Your message, with credentials, tokens, card-shaped numbers and other addresses removed **before** storage.                                                   | 365 days                            | Swept on expiry, in small indexed batches                                                                                                                                       |
| Audit records                  | Who did what and when, with metadata redacted.                                                                                                                | 365 days                            | Swept on expiry, in small indexed batches                                                                                                                                       |
| Website analytics sessions     | A salted daily hash, the landing path and campaign parameters. No IP address is ever stored.                                                                  | 14 days                             | Swept on expiry, in small indexed batches                                                                                                                                       |
| Sign-in sessions               | A hashed session token and its expiry.                                                                                                                        | 1 day after expiry                  | Swept on expiry                                                                                                                                                                 |
| Sign-in links                  | A hashed one-time token and its expiry.                                                                                                                       | 1 day after expiry                  | Swept on expiry                                                                                                                                                                 |
| Rate limit counters            | A hashed bucket name and a count.                                                                                                                             | 1 day after expiry                  | Swept on expiry                                                                                                                                                                 |
| Account records                | Your workspace, memberships, provider connections and workflow configuration. Your sign-in identity (the email address you log in with) is a separate record. | For as long as the account exists   | The workspace, its memberships, its connections and its workflow configuration are removed when you delete the workspace. Your sign-in identity is removed on request — see §6. |
| Billing and tax records        | Orders, subscriptions, refunds and the payment provider's customer reference. Never a card number — we never receive one.                                     | Kept after account deletion; see §6 | Not swept                                                                                                                                                                       |

### Why these periods

- **Evidence — 30 days.** This is a fixed system limit, not a per-customer setting, and it
  is the figure published on the pricing and FAQ pages. Long enough to investigate a
  disputed result, short enough that we are not holding a shadow copy of your CRM.
- **Source events and run results — 90 days.** A quarter of result history to look back
  over. Runs are attached to their source event by a cascading foreign key, so the two
  cannot be given different periods. Evidence inside those runs has already gone at
  thirty days, so a run older than a month shows its outcome and reasons without the
  underlying records.
- **Webhook receipts — 30 days.** This is what stops a redelivered provider event being
  processed twice. It has to outlive the longest redelivery window a provider uses.
- **Notification records — 180 days.** So that "you never told me" can be answered with a
  record rather than a shrug, across a dispute that may surface months later. The
  recipient is stored as a hash, so this set cannot be turned back into a mailing list.
- **Support cases — 365 days.** A conversation that restarts months later still has its
  history. Bodies are redacted on the way in, so what is held for the year is already
  stripped of credentials and card-shaped numbers.
- **Audit records — 365 days.** A security question is usually asked long after the
  event, and an audit trail shorter than the period people ask about is not an audit
  trail.
- **Analytics sessions — 14 days.** The shortest window that is still useful. A visit
  record exists only to connect a sign-up to the campaign that produced it, and that
  happens within days. The identifier is a salted daily hash and is not durable across
  days in any case.

### How deletion actually runs

Deletion is a scheduled sweep, not a background promise. It reads expired rows in small
indexed batches — a keyset scan over an index that already exists — deletes exactly those
rows, and checkpoints where it stopped. It is safe to run twice: the eligibility test is
the row's own expiry, so a row that has already gone cannot be deleted again and a row
that has not expired cannot be deleted early. If a sweep is interrupted, the next one
resumes from the checkpoint. If it reaches its per-run ceiling with work left, it reports
itself as **incomplete** rather than claiming success.

---

## 3. Where data goes

| Stage                     | Who runs it             | Where                      | What it is for                                                                                                                |
| ------------------------- | ----------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Your browser              | You                     | Your device                | Signing in, configuring a workflow, reading results, sending us a support message.                                            |
| Cloudflare Workers and D1 | Cloudflare              | EU-West                    | Runs the application and stores everything we hold.                                                                           |
| HubSpot                   | HubSpot                 | Determined by the provider | The CRM evidence source. We read contact records back using the read access you grant. We never write.                        |
| Resend                    | Resend                  | Determined by the provider | The email evidence source, and the service that sends our own transactional messages.                                         |
| Stripe                    | Stripe                  | Determined by the provider | Payment processing, through hosted Checkout and the hosted Billing Portal. Card details never reach our servers.              |
| Optional model provider   | The configured provider | Determined by the provider | Powers the optional AI assistant. **Off by default.** It can never decide a verification result, an access right or a charge. |

Where a third party's processing region is that third party's to decide, this table says
so. We have not verified a contractual region for HubSpot, Resend, Stripe or any model
provider, and we do not claim one.

The structured version of this table is in `apps/app/src/privacy/dataflow.ts`, and the
privacy page renders it from there.

---

## 4. Subprocessors

| Subprocessor            | Role                                                                                            | Data involved                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cloudflare              | Application hosting, database (D1) and cron scheduling                                          | All workspace configuration, source events and retained evidence                                                 |
| HubSpot                 | Customer-connected CRM evidence source (read access only)                                       | The specific contact record fields your workflow rules reference                                                 |
| Resend                  | Customer-connected email evidence source (read access only), and our transactional email sender | Message status events for the acknowledgement email your rules reference; the transactional messages we send you |
| Stripe                  | Payment processing and billing management                                                       | Billing details and subscription status; we never see full card numbers                                          |
| Optional model provider | Powers the optional AI assistant, only when a customer enables it                               | Only the text needed to answer the specific assistant request                                                    |

This list is the whole list. If it changes, this page changes with it.

### Telegram — the owner's own channel, and why it is not on that list

The business owner receives operational alerts on Telegram, through a bot they already
run. It is **not** a subprocessor of customer data, because no customer data reaches it.

That is enforced rather than promised. The channel carries six kinds of message —
an approval needed, a sign-in or card entry that only a person can complete, a spending
decision, a critical incident, a provider outage, and a milestone. Every message is
checked before it is sent, and a message containing anything shaped like an email
address, an access token, a payment card number or a raw provider record is **refused**,
not redacted and sent. What it may carry instead is an opaque reference — `ws_…` — which
means nothing outside our own database and which the owner taps through to the dashboard,
where access is checked in the ordinary way.

If that guard is ever relaxed so that customer data could reach this channel, Telegram
becomes a subprocessor and belongs in the table above. The code is in
`apps/app/src/notifications/telegram.ts`.

---

## 5. What you can ask us for

| Request                                                | How to ask                                                                | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A copy of everything we hold about your workspace      | From the account page while signed in, or by sending us a support message | We build a file containing your workspace, members, workflows, runs, assertions, retained evidence, support messages, notification records, audit records and billing records, as JSON or CSV. It never contains a stored provider credential, in any form — not even masked.                                                                                                                                                                                                                                                    |
| Correct something that is wrong                        | Send us a support message saying what is wrong                            | Configuration you control, you can change yourself. Evidence we read back is a record of what HubSpot or Resend said at the time; we will not alter it, because an altered record of evidence is worthless. Correct it at the source and the next check reads the corrected value.                                                                                                                                                                                                                                               |
| Delete your workspace and its data                     | From the account page while signed in, or by sending us a support message | We schedule the deletion with a short grace period so it can be undone, then revoke sessions, stop scheduled checks, expire shareable links, and remove evidence, runs, workflow configuration and rules, provider connections and their stored credentials, support messages, notification records and every membership of the workspace. You get a statement of exactly what remains and why. Your sign-in identity is not removed automatically, because it can belong to another workspace; ask and we will remove that too. |
| Stop the optional AI assistant being used on your data | Turn it off in settings — it is off unless you turned it on               | No text is sent to any model provider. The core service does not depend on a model and behaves identically.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Complain about how your data has been handled          | Send us a support message                                                 | It is escalated to the owner and never auto-answered. A person replies. If you are not satisfied, you can take it to the data protection regulator in your country. We claim no approval or endorsement from any regulator.                                                                                                                                                                                                                                                                                                      |

**Support and cancellation remain reachable even when the service is paused.** A service
that goes down and takes its own support channel with it has removed your last option, so
the support form, the cancellation path, the deletion path and the legal pages are served
whatever else is switched off.

---

## 6. What deletion does not remove

When you delete a workspace we revoke your sessions, stop scheduled checks and expire
shareable links, then remove your evidence, runs and results, workflow configuration and
rules, provider connections and the credentials stored against them, support messages,
notification records, and every membership of that workspace.

Your **sign-in identity** — the email address you log in with — is deliberately not
removed by this. It can belong to more than one workspace, and removing it here could
lock you out of another one. Ask us and we will remove it.

We keep two things, and here is exactly why.

**Billing and tax records.** HMRC requires business records to be kept:

- For Self Assessment, _"You must keep your records for at least 5 years after the 31
  January submission deadline of the relevant tax year."_
  Source: <https://www.gov.uk/self-employed-records/how-long-to-keep-your-records>,
  verified 2026-09-19.
- For VAT, _"You must keep VAT records for at least 6 years (or 10 years if you are using
  the VAT One Stop Shop (OSS) scheme or used the VAT Mini One Stop Shop (MOSS) scheme)."_
  Source: <https://www.gov.uk/charge-reclaim-record-vat/keeping-vat-records>,
  verified 2026-09-19.

Which of these applies depends on the owner's VAT registration status, which is
`TODO_OWNER_INPUT`. Until that is filled in, this page does not state a single retention
figure for billing records, because stating one would mean guessing. What these records
contain is what was charged and when — never a card number; we never receive one.

**Audit records of actions on the account, including the deletion itself.** Redacted, and
removed automatically 365 days after they were written.

Nothing else is kept, and nothing retained above is used for any purpose other than the
one stated.

### Backups — the honest part

Our database is backed up. A backup taken before a deletion still contains the deleted
data until that backup expires on its own schedule, and we do not rewrite backups to
remove individual records — doing that reliably is not something we can honestly promise.
We would rather tell you this than claim the data is gone from everywhere the moment you
ask.

---

## 7. Things we deliberately do not do

- We do not use your data to train any model. Evidence we retrieve is used only to check
  your rules and show you results.
- We do not store a raw IP address, anywhere, for any purpose.
- We do not run a client-side analytics script, and there is no third-party tag on any
  page.
- We do not serialise a stored credential back out — not into an export, not into a log,
  not into an error message, not masked.
- We do not claim an email was delivered. We record that a sending service accepted it,
  which is the only thing we can observe.
- We hold no security certification and claim none.

---

## 8. Open items for the owner

Every `TODO_OWNER_INPUT` above must be filled in with real, verifiable information before
this page is published:

1. Trading name.
2. Contact address for privacy enquiries.
3. Contact email for privacy enquiries.
4. VAT registration status and number — this determines which HMRC retention period in §6
   applies to billing records.
5. Whether an ICO registration is held, and its number if so.

None of these may be filled in by an agent, and none may be guessed.
