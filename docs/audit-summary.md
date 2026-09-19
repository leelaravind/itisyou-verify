# Independent completion audit — public summary

**Audit pass 1 · 19 September 2026**

This project is built by a team of specialist agents. This page is written by a separate
one whose only job is to check whether the others' claims are true, and to block a release
that should not happen. It does not write product code.

It exists because a system that reports on its own success without independent evidence is
exactly what this product was built to complain about. Applying that to ourselves is the
minimum honest thing to do.

This is a sanitised summary. The full matrix, findings ledger and narrative are kept in
private operational records, because they name deployment detail that should not be public.
Nothing material to a customer's decision is omitted here.

---

## The verdict

**The public website: live, accurate and safe to use.**
**Taking payment: not ready. Release is blocked.**

That split is the whole point of publishing this. The site you can visit today is real and
says true things. The commercial path behind it is not finished, and we would rather say so
here than let a green dashboard imply otherwise.

---

## What was independently verified

Each of these was checked by running the command or fetching the live URL, not by reading
another agent's summary.

| Claim | Verified how | Result |
| --- | --- | --- |
| The site is live over TLS with strict security headers | Fetched the production origin and read the response headers | **Confirmed.** `default-src 'none'`, hash-only scripts and styles, no inline style or script attributes, HSTS set |
| The health check really probes the database | Fetched `/health` | **Confirmed** — it reports actual database reachability, not a hard-coded "ok" |
| Owner and admin surfaces are not reachable anonymously | Fetched them from outside with no session | **Confirmed** — they return 404 and the response body leaks nothing |
| The verification meter cannot show a partial result as a pass | Fetched the live demo page and read the rendered markup | **Confirmed** — 33% renders a 30% bar. It rounds **down** |
| The test suite is real and nothing is quietly hidden in a skip | Ran the full suite twice and parsed the runner's own output | **Confirmed** — 1,951 distinct cases. Exactly **two** are skipped, both deliberately: the only two tests permitted to contact a real provider, which skip because no provider credential exists. They must not be counted toward the release gate, and this audit has said so |
| Repeated or cross-browser runs are not counted as new cases | Read the browser test configuration | **Confirmed** — a single browser project, by explicit design |
| No test ever contacts a real third-party provider | Read the test setup and every connector test | **Confirmed** — an empty network allow-list blocks all outbound calls, and a dedicated case fails the suite if one is ever attempted |
| No page claims a provider integration has been tested live | Searched all public copy and the deployed pages | **Confirmed** — no such claim exists |
| No visitor or revenue figure is overstated | Searched every deployed public page for a traffic or signup number | **Confirmed** — **none is published.** The honest count today is zero |

## What the audit found wrong

Reported here because a defect found and named is worth more than a clean-looking summary.

| Finding | Severity | State |
| --- | --- | --- |
| The automated release gate is **not met** — five failing cases, and the current commit does not compile | High | Open, blocking |
| Two incompatible date formats are used as the key for the same billing-period record, so a usage allowance could fail to settle correctly | High | Open, blocking. Not reachable today — the scheduler and payment paths are not switched on |
| The production deployment is several commits behind the tested code, and the public admin entry point is missing from it | High | Open |
| A test fixture was written in the shape of a real secret. Caught by our own checks, removed from the code — but it had already been committed, so it remains in the repository's published history along with two similar values | High | Open. All three are synthetic; none is a working credential |
| Our published development story reports spend as £0.00 without also reporting a small estimated model-usage figure alongside it | Medium | Open |
| The payment-failure policy is written, tested and correct — but is not yet shown on the page before checkout | Medium | Open |
| The customer notification for a paused subscription is written and correct — but is not yet wired to send | Medium | Open |
| Several owner-dashboard controls that cannot yet act are honest about it, but one reports a queued action that is not queued, and one returns a success status code | Medium | Open |
| One internal document says payment processing has been exercised with real test cards. It has not — no payment provider has ever been contacted from this repository | Low | Open |

Twenty-three findings were raised in total. Each was returned to the responsible agent with
the specific retest that will close it. **Nothing is closed without the auditor re-running
that test independently.** Two were fixed while the audit was being written and were closed
only after the auditor re-ran the failing test and watched it pass.

One thing worth saying plainly about method: the codebase changed nine times during this
audit, and at one point the application's entry file did not even parse. That is normal for
a project still being built, and it is also why **no audit of a moving tree is valid for
longer than it takes to run.** The findings above describe specific commits. The release
decision will be made against a frozen commit and a redeployed site, re-checked from
scratch.

## Three claims that turned out to be false — and were checked anyway

Part of this role is refusing to pass along an unverified report, including a report of a
problem.

- A report reached the audit saying two provider-backed test cases had been quietly reused
  for unrelated passing tests — which would have made an untested integration look
  finished. **It was not true**; the reuse had already been fixed.
- A report said one of the database adapters did not satisfy its interface. **It did.**
- A security test that fails, and reads as an open scripting vulnerability, turned out to be
  testing an upstream library rather than our own code. The audit wrote a fresh test against
  the shipped code: **the protection is present and working**, and the live security policy
  blocks the attack independently. The genuine defect is the missing regression guard, which
  is now recorded as such.

## What is honestly not finished

- **Payments are not live.** The payment routes are not switched on. No card can be charged.
- **Provider evidence is proven against mocks, not against HubSpot or Resend.** We hold no
  credentials for either. The two test cases that would require a real provider call are
  recorded as planned and have never run. We will not describe this as a working integration
  until it is one.
- **No advertising has run and no money has been spent on promotion.** The advertising
  allocation is reserved and untouched, by decision: organic first.
- **No external visitors have been counted.** The figure is zero and is reported as zero.
- **Business identity details are outstanding**, so the legal pages show their gaps rather
  than inventing a company.

## What this audit does not prove

- It is one pass, by one auditor, over a codebase that changed twice while it was running.
- Several areas remain **not** assessed: backup restoration, operational runbooks, and one
  owner-approval behaviour. These are recorded as unassessed rather than quietly left out.
  The browser suite and the payment-recovery flow **were** assessed in a second pass — see
  below.
- Account-level settings for the code host and the hosting platform were accepted from
  existing records rather than re-queried.
- Spend figures are estimates of two different kinds. No billing statement has been read.
  A tool reporting a notional cost is not a bill, and this summary does not treat it as one.
- **No audit can show that defects are absent.** It can only show what was checked, how, and
  what remains unknown. That is all this page claims.

## The four milestones, kept separate

A project like this is tempting to describe as "launched". It is not, and these four things
are not the same thing:

| Milestone | State today |
| --- | --- |
| Build complete | **No** — the test suite is red and the release commit does not compile |
| Live payments ready | **No** — payment routes are not switched on |
| Advertising live | **No** — by deliberate decision; nothing has been spent |
| Ten external visits observed | **No** — the observed count is zero |

They will be reported separately until each is separately true.

---

---

## Second pass — against one fixed commit

The first pass had to chase a codebase that changed nine times underneath it. The second was
run against a **single pinned commit with a clean working tree**, which is the only way an
audit result means anything.

**Two findings were closed**, each only after the auditor re-ran the failing check:

- The credential-shaped values in the published history are now individually pinned by exact
  content hash — eight of them, each justified, with the count printed on every clean run.
  The history scan passes. This was fixed the way the audit asked: by naming specific values,
  not by weakening the rule that catches them.
- The live site is now up to date with the tested code, and the public admin entry point is
  reachable again.

**Two new findings were raised:**

- **The browser test suite is 56% failing** — 14 of 36 cases pass. Everything public passes;
  everything behind a sign-in fails, because the browser suite has no way to sign in. That
  means the signed-in customer journey, the owner screens on a phone, and the "no sideways
  scrolling" checks at all three screen widths are currently **unproven**. We would rather
  publish that than leave it unmeasured. Credit where it is due: those layout tests refuse
  to report a pass they could not measure — they fail with "the page did not render; its
  layout was not measured", which is exactly why this was visible at all.
- **The pinned commit does not compile**, because of in-progress work on the visual
  development story. The accepted release commit will have to.

**The payment-failure policy was assessed in full.** The founder's specification has nine
parts. One — *nothing of yours is deleted because of a missed payment* — is **fully met**,
and met in the most reliable way possible: the data-retention process has no knowledge of
payment status at all, so it cannot act on it. The other eight have correct, well-tested
logic that **nothing currently calls**. The policy text itself is accurate and well written;
it is simply not yet connected, and in one case it promises a second recovery route that has
not been built. Tested is not the same as working, and this summary will not conflate them.

The audit's headline finding — two incompatible date formats used as the key for the same
billing record — was **partially** fixed and **not closed**. A shared function was written
and a safety check added, but two of the three places that need it still use the old one, and
the safety check is missing from the code path production actually uses. The auditor proved
this by running both functions rather than by reading the fix: one produces `2026-09-19`, the
other `2026-09`, and the project's own validator rejects the second. It stays open.

---

*Findings are raised against named agents and retested independently before being closed.
Security issues should be reported through the process in [SECURITY.md](../SECURITY.md).*
