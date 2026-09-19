# Running ITISYOU Verify

This is the manual for the person who owns the business. It assumes you are not a
programmer and it does not expect you to open a terminal, a database or a deployment tool
to run the company day to day. Everything described here is a page you can reach from your
phone.

If something in this guide does not match what you see on screen, believe the screen and
tell whoever is maintaining the software. A guide that has drifted is worse than no guide.

---

## 1. Getting in

### The two doors

| Address | Who it is for |
| --- | --- |
| `/app` | Your customers. Their workspaces, their runs, their bills. |
| `/admin/login` | You. |

`/admin/login` is a public web page. Anyone can open it. That is deliberate — you need to
be able to reach it from a borrowed laptop at a bad moment, and a hidden address is not a
lock. The page shows nothing at all: no customer names, no numbers, no indication of
whether an email address has an account. Typing any address into it produces the same
answer, every time.

### Signing in

1. Go to `/admin/login`.
2. Type your email address and press **Email me a link**.
3. Open the link in the email. It works once and expires after fifteen minutes.
4. You are now signed in and can read everything.

### The six-digit code

Reading is one thing. **Changing** something — a refund, a price, a pause, a cleanup — asks
for a six-digit code from your authenticator app. You will be asked again if more than
fifteen minutes have passed since the last time.

This is not the software being awkward. If someone gets hold of your unlocked laptop while
you are away from your desk, being signed in is exactly what they will have. The code is the
thing they will not have.

**If you see "Confirm it is you":** that is normal. Enter the code and the action continues.

### The very first sign-in ever

The owner account is not created by signing up. It is claimed once, using a secret set on
the deployment, from the page at `/admin/bootstrap`:

1. Sign in with a magic link first. The bootstrap secret proves *which installation this
   is*; it does not prove who you are, and you need both.
2. Paste the bootstrap token.
3. You become the platform owner.

After that, **the page stops working permanently** — not because anyone remembered to
delete the secret, but because the code refuses to run once an owner exists. You do not have
to tidy anything up.

### The automation identity

Browser tests sign in as a separate, short-lived identity. It can look around, ask for a
test suite to run, and preview a cleanup. It **cannot** activate an advert, issue a refund,
move budget, or make itself the owner. Those abilities are not switched off for it; they
simply do not exist for that identity, which is a stronger guarantee than a setting.

### "Restricted entry"

On the settings page you can switch the administrative entry point between **public login**
and **restricted entry**. Restricted entry hides the sign-in link and stops the address
being advertised.

**It is not a security control.** It reduces the number of automated scanners that stumble
over the page. Every owner page checks your session, your owner flag and your recent code
whichever setting is chosen. Do not treat restricted entry as a lock, and do not relax
anything else because it is on.

---

## 2. What the words on the screen mean

These are the words you will meet most often and the ones most easily misread.

### About verification

| Word | What it means | What to do |
| --- | --- | --- |
| **Verified** | We looked in the customer's connected systems and found evidence for everything their rules required. | Nothing. |
| **Failed** | We looked, we found evidence, and the evidence contradicts one of their rules. | The customer's automation probably did something wrong. The run page names which check and what it expected. |
| **Unverified** | We could not get enough evidence to say either way. | **This is not a failure.** Usually a connection is broken or a provider is down. Check the connections page for that customer. |
| **Pending** | The agreed window for the job to finish has not closed yet. | Nothing. Wait. |

The distinction between **failed** and **unverified** is the product. Never describe an
unverified run to a customer as a failure — we did not prove anything went wrong, we proved
we could not look.

### About things that are waiting

| Word | What it means | What to do |
| --- | --- | --- |
| **Pending** (an approval) | You approved something and it has not been used yet. | Nothing, or withdraw it if you have changed your mind. |
| **Expired** (an approval) | More than a day has passed. It no longer authorises anything. | If you still want the thing to happen, approve it again. |
| **Pause requested** (an advert) | We asked the ad platform to stop. **It has not confirmed.** | Assume the advert may still be showing and may still be spending. Check again in a few minutes. If it stays like this for an hour, open the ad platform yourself. |
| **Paused** (an advert) | The ad platform told us it is paused, or you told us you saw it paused there. | Nothing. |
| **Waiting for a runner** | Something needs a machine that can actually do work — run tests, deploy — and nothing is connected. | The job is saved, not lost. It will run when a runner is connected. Nothing has been tested or deployed yet. |
| **Runner offline** | The machine that does that work has not checked in for over two minutes. | Anything queued stays queued. If you need it now, someone has to start the runner. |
| **Unknown** | We have not measured this. | **It is not zero.** Treat it as a hole in what you know, not as good news. |
| **Out of date** | We measured this, but a while ago. | Do not make a spending decision on it. Refresh it or go and look at the source. |

### About tests

| Word | What it means |
| --- | --- |
| **Queued** | Accepted, not started. |
| **Waiting for a runner** | Nothing can run it. No result exists. |
| **Running** | In progress. |
| **Passed** | Every case ran and passed, on the commit named beside it. |
| **Failed** | At least one case failed. The report says which. |
| **Cancelled** | Someone stopped it. Nothing is proved. |
| **Timed out** | It ran too long and was stopped. **Not a pass and not a failure.** |
| **Could not run** | The machinery broke, not the code. Nothing is proved. Run it again. |

---

## 3. The screens

### Overview — `/owner`

The money, the health of the service, how many customers there are, how many people have
visited since launch, and what is waiting for you.

Three things to keep in mind:

- **"Estimated net receipts" is not profit.** It is money in, minus money refunded, minus
  the costs providers have actually billed. It does not include tax, your own time, or
  anything invoiced later.
- **Every figure has a last-refresh time.** If it says "out of date", it is.
- **"Unknown" means we have not measured it.** A figure showing unknown is not a figure
  showing zero, and the page will never show you a confident zero for something nobody
  counted.

### Customers and orders — `/owner/customers`

Who has signed up, whether they are actually able to use the product, what state their
subscription is in, and how many of their connections are working.

The **exception queue** at the top is the list of things that need a decision from you —
a failed payment, a refund waiting, a broken connection, someone escalated in support.
An empty queue is a real state, not a page that has not loaded.

**Rejecting an order before checkout.** If someone cannot use the product — they do not have
the systems it needs — say so before they pay, and say why in a sentence they can act on.
The software will not accept "no" as a reason; ten characters minimum, on the record.

**Refunds.** A refund needs an approval first (see below) bound to the exact amount. An
approval for £12.00 will not authorise £12.01. That is not pedantry: it is what stops a
number being changed between the moment you read it and the moment it is paid.

### Verification — `/owner/verification`

Every recent run across all customers, and for each one: what was decided, what evidence we
retrieved, when each piece was observed, which version of the rules decided it, and whether
any provider was having problems at the time.

**Check this run again** queues another observation. It costs a call to the provider. It
cannot turn an unverified run into a verified one unless the evidence is genuinely there now.

If "Expensive verification" is paused on the controls page, this button will tell you so
rather than pretending to work.

### Connections — `/owner/connections`

Every provider connection, its health, and what to do about it.

**No stored secret ever appears here.** The hints like `account ••••4821` are generated when
the page loads, from the account identifier the provider hands back — not from anything we
hold. We do not show a masked version of a stored credential either, because a mask of a
stored secret is still a read of a stored secret.

- **Rotate** asks the provider for a new credential. It needs a working connection.
- **Revoke** stops us reading that provider at all. Runs that needed it will report
  **unverified**, never failed — we will not claim a failure we cannot see. You have to type
  "revoke" to confirm.

### Ads — `/owner/ads`

Draft, approve, activate, pause. Budget, spend, visits, signups, and the campaign id at the
platform.

Two rules this screen keeps:

1. **A pause you requested is not a pause that happened.** It reads *pause requested* until
   the ad platform confirms it, and says so in words.
2. **Stale numbers are marked stale.** A spend figure we last read an hour ago carries an
   "out of date" tag. Do not decide anything on an out-of-date spend figure.

Activating a campaign spends real money and needs an approval id.

### Operations — `/owner/operations`

Whether the service is up, what was deployed and when, what is alerting, and whether the
maintenance runner is connected.

**If the runner shows "not connected"**, anything you queue is saved and will run when a
runner is paired. Nothing on this page will tell you a job succeeded when nothing ran it.

**Restoring a previous version** replaces the running code. Read this before you do it:
a rollback undoes *code*, not *data*. Anything written to the database since that version
stays written, and a change to the database's own shape is not reversed. You have to type
"restore" to confirm.

### Controls — `/owner/controls`

Four stop switches, each of which states what it stops **and what it does not stop**:

| Switch | Stops | Does not stop |
| --- | --- | --- |
| Advertising | New campaigns; we ask the platform to pause running ones. | An ad already showing, until the platform confirms. |
| New orders | Anyone new reaching checkout. | Existing customers' service or billing. |
| Expensive verification | The retries and extra provider reads that cost money. | Verification being correct. Runs become *unverified* where we could not look — nothing is marked failed because of this. |
| Assistant | The optional assistant, everywhere. | Anything at all about verification, billing or support. It never decided those. |

**Whatever you pause, a customer can still cancel their plan and still reach support.** That
is not a promise we are being careful about; the code refuses to suspend those pages, and a
test turns every switch on at once and checks it.

Revoking a single connection is on the connections page, next to the connection it affects,
so you can see which customer it belongs to before you do it.

### Approvals — `/owner/approvals`

Every approval records what action, what amount, by whom, and when — and is tied to a
fingerprint of the exact thing you read.

If anything about it changes afterwards — an amount, a date, a destination, a word of ad
text, the list of things a cleanup would remove — the approval stops applying and you are
asked again. **Approvals expire after 24 hours**, so something agreed yesterday cannot be
carried out today without you looking at it again.

You can withdraw an approval at any time before it is used.

### Settings — `/owner/settings`

- **Business details.** Your trading name and address. These are legally required on the
  public terms and privacy pages, nobody on the build team knows them, and the software will
  not invent them — the pages show `TODO_OWNER_INPUT` until you fill these in. **Do this
  before you take a single payment.** You are recorded as a **UK sole trader**; that is fixed
  rather than offered as a choice, because picking the wrong one would publish something
  untrue about who is liable.
- **Pricing.** Applies to **future purchases only**. Changing the price here never re-prices
  anyone who has already bought — their price is held against their subscription at the
  payment provider.
- **Notifications.** Where your alerts go and which events produce one. "Any verification
  fails" is off by default because it is noisy.
- **How long things are kept.** Shortening a retention period takes effect immediately.
  Lengthening one applies only to things collected afterwards — we already told customers
  the shorter figure.
- **Approved spending limits.** The one setting here that can cost money. Raising a limit
  needs an approval bound to the exact figure, so it does not share the ordinary save button.
- **Access mode.** Public login or restricted entry. See section 1.

### Test centre — `/owner/quality`

Press a button, a test suite runs, and you get a report with the commit it ran against, the
counts, and what it does not prove.

You choose a suite from a list. You never type what to run — there is no box on this page
that reaches a machine, which is why nobody can turn this screen into a way to run arbitrary
commands on our systems.

**If nothing is connected that can run tests**, the job is saved and shows *waiting for a
runner*, with the reason. It is never reported as passing. A green tick you did not earn is
the single most dangerous thing a page like this could show you.

Four files are downloadable once a run has produced them: the test report, the raw results,
the JUnit file other tools read, and the release-readiness decision. They need your session;
they are not public.

### Cleanup — `/owner/cleanup`

Remove things that are safe to remove, having read exactly what they are first.

1. **Preview.** Pick from a fixed list of categories — there is no pattern to type and no
   wildcard to get wrong. You get back the exact resource ids, what each one is, which
   environment it lives in, roughly how much space it frees, and whether it can be
   quarantined instead of deleted.
2. **Read the "left out" list.** Anything found but refused is shown with the reason.
3. **Run it.** You type "delete" to confirm.

Four safety rules, each enforced rather than intended:

- Nothing is deleted that was not in the list you read.
- If that list has changed since you read it — anything added or gone — **the run stops
  before deleting anything** and asks you to look at the new list.
- Each resource's identity is proved again immediately before it is removed. If it is no
  longer the thing we listed, it is left alone and the report says so.
- If a run is interrupted, it reports **partial** with a resumable checkpoint. It never
  claims to have finished.

**Never in scope, and refused by the software rather than by convention:** real customer
data, evidence still inside its retention window, backups, active credentials, and anything
belonging to another project in the same hosting account. Those need a deliberate decision,
not a cleanup button.

---

## 4. When something is wrong

### A customer says verification is broken

1. Open their run on `/owner/verification`.
2. Read the result. If it is **unverified**, we could not look — check their connections.
3. If a provider was having problems, the run page lists the outage beside the evidence.
4. If it is **failed**, the page names which check, what was expected and what we observed.
   That is the customer's automation, not ours.

### Money looks wrong on the overview

Check the last-refresh time first. Then check whether any figure says **unknown** — a total
built on an unknown input is itself unknown, and the page will show it as unknown rather
than quietly leaving it out.

### An advert is spending more than expected

1. Go to `/owner/ads` and press **Request pause** on the campaign.
2. It will read *pause requested*. **Assume it is still spending** until the platform
   confirms.
3. If you need it stopped now, open the ad platform's own console and pause it there. Then
   come back — we will pick that up on the next read.
4. If it is urgent and you are not sure which campaign, pause **Advertising** on
   `/owner/controls`.

### Something needs to run and the runner is offline

The job is saved. It will run when a runner is connected. Nothing has been done yet and
nothing is lost. If it is urgent, somebody with access to the runner machine has to start it.

### You are locked out

`/admin/login` is public and works from any device. If you have lost your authenticator, you
can still sign in and read everything — you just cannot change anything until you can produce
a code. That is the design working, not a fault.

### Something on a page looks like a lie

Tell whoever maintains the software, and say which page and what it claimed. A button that
pretends to work is treated as a serious defect here, not as a cosmetic one.

---

## 5. The things this software will not do for you

Said plainly, so you are not waiting for them:

- It will not decide a refund, a price or an approval. It records your decision and enforces
  it exactly.
- It will not tell you an advert is paused on the strength of our own request.
- It will not show you a figure it has not measured.
- It will not report a test as passing without running it.
- It will not delete anything you have not read a list of first.
- It will not invent your trading name or address.
