# ITISYOU Verify — product scope v1

This document is the factual base for every public claim the product makes. Anything not
mapped to a code path, a rule, or an explicit limit constant here should not be said in
marketing, onboarding or the app itself. Owned by A01 (Product and Market). If you need a
claim added, it needs an implementation first — raise it with the owning agent, don't add
the sentence and hope.

Grounded against `docs/agent-brief.md`, `README.md`, `packages/contracts/src/rules.ts` and
`packages/contracts/src/money.ts`. No `plan/` document exists in this repository at the
time of writing — where the brief cites a plan section (e.g. "plan §37") this document
notes that the section text itself was not available to check against, and states the
assumption made instead.

## 1. The buyer

Small automation agencies that build and manage workflows for their own clients — the
kind of shop running a handful of n8n/Make/Zapier automations that quietly get a lead
into HubSpot and fire an acknowledgement email. They are usually the ones who find out an
automation broke when the client calls to ask why nobody replied to their enquiry, not
before.

**What they do today when an automation silently fails:**

- They rely on the automation platform's own execution log or error notification (see
  `docs/competitors.md`), which tells them the _workflow_ threw an error — not whether the
  CRM record or email actually exists downstream. A workflow that runs top to bottom
  without throwing can still write to the wrong record, skip a step because of a stale
  condition, or fire the email to the wrong address. None of that raises an error.
- They get told by the client, after the fact, that a lead was missed. This is the
  expensive failure mode: reputational, and it surfaces days or weeks after the run.
- Some build their own checking automation (a second workflow that queries the CRM) —
  which duplicates engineering effort per client and still trusts the same platform's own
  read of its own actions unless it goes elsewhere for evidence.

**What it costs them:** engineering time spent building bespoke checks per client, lost
trust with the end client when a lead silently disappears, and no artefact to show the
client ("here is the record, here is the email event") when a dispute happens.

## 2. The single supported v1 workflow

> An enquiry should create the correct CRM record and trigger an acknowledgement email.

This is the only workflow shape v1 verifies. It is evidenced independently from two
sources:

- **HubSpot** (CRM) — read back via `record.*` fields (`CRM_FIELD` in
  `packages/contracts/src/rules.ts`): `record.id`, `record.email`,
  `record.correlation_id`, `record.created_at`, `record.property` (an allow-listed named
  property).
- **Resend** (email) — read back via `message.*` fields (`EMAIL_FIELD`):
  `message.id`, `message.recipient`, `message.status`, `message.occurred_at`.

The customer's automation sends us a **signed source event**
(`packages/contracts/src/events.ts`, `sourceEventSchema`) naming the correlation id it
expects to find in HubSpot and the recipient it expects Resend to have handled. We do not
trust that event as proof — it is a trigger that tells us what to go and check
(`EvidenceOrigin: 'customer_claim'` in `packages/contracts/src/evidence.ts` is explicitly
the weakest evidence origin; `provider_readback` and `provider_webhook` are what a
`VERIFIED` result is built from).

## 3. Claims-to-implementation map

Every claim we intend to make, or explicitly refuse to make, with the code path or rule
constant that makes it true. A claim with no entry in the third column does not ship.

| Claim (customer-facing)                                                                                           | Implementation it maps to                                                                                                                                                                                                | Status                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| "We read your CRM record back from HubSpot ourselves"                                                             | `EvidenceOrigin: 'provider_readback'`, `CrmRecordEvidence` (`evidence.ts`); HubSpot connector reads `record.*` fields (A04, not yet built)                                                                               | Cut until A04 ships the connector — claim only after `provider_readback` path exists                          |
| "We check the record matches what your automation expected"                                                       | `assertionSpecSchema` operators `exists`, `equals`, `not_equals`, `normalised_email_equals`, `one_of` against `CRM_FIELD` (`rules.ts`)                                                                                   | Implemented at contract level; evaluator is A03's `packages/domain` (not yet built)                           |
| "We check the email was accepted by the sending service"                                                          | `EMAIL_STATUS` includes `'accepted'`; assertions against `message.status` with `provider_status_in` (`evidence.ts`, `rules.ts`)                                                                                          | Contract-level yes; do not conflate with delivery (see below)                                                 |
| "We check the email was delivered to the receiving mail server"                                                   | `DELIVERY_PROVING_STATUSES = {'delivered'}` (`evidence.ts`) — a distinct, stronger claim than "accepted"                                                                                                                 | Contract-level yes. **Never merge this wording with "accepted"**                                              |
| "We never treat an email open as proof someone read it"                                                           | `EMAIL_STATUS` lists `'opened'`/`'clicked'` separately from `DELIVERY_PROVING_STATUSES`; no rule in `rules.ts` allows `opened` to satisfy a delivery assertion by itself unless the customer explicitly writes that rule | Negative claim — true by omission, keep it that way                                                           |
| "You get a VERIFIED, FAILED, UNVERIFIED or PENDING result — never a fifth state"                                  | `RUN_STATUS` (`status.ts`) is a closed tuple of exactly those four                                                                                                                                                       | Implemented at contract level                                                                                 |
| "No evidence yet is never treated as success"                                                                     | `RUN_STATUS`/`ASSERTION_STATUS` design: absence maps to `UNVERIFIED`/`PENDING`, never `VERIFIED` (brief, "Absence of evidence is `UNVERIFIED`")                                                                          | Contract-level rule; evaluator (A03) must honour it — flag as a test case, not just a doc claim               |
| "A missed deadline only counts as FAILED if evidence access was actually working"                                 | Brief: "a deadline failure is supported by _working_ evidence access"; `ConnectorErrorCode`/`isRetryableConnectorError` (`errors.ts`) distinguish access problems from a genuine miss                                    | Contract-level; evaluator logic pending (A03)                                                                 |
| "Your workflow's own success webhook is a trigger, not proof"                                                     | `EvidenceOrigin: 'customer_claim'` is explicitly the weakest tier; `sourceEventSchema` only carries _expected_ values, never asserted outcomes                                                                           | Implemented at contract level                                                                                 |
| "We tell you when a run never started"                                                                            | Only true in `coverage_mode: 'independently_sourced'` (`COVERAGE_MODE`, `rules.ts`); default is `'customer_triggered'`, which by definition cannot see a run that never fired                                            | Conditional claim — must always be shown next to the workflow's actual coverage mode, never asserted globally |
| "We show our reasoning as a plain-language reason, not a black box"                                               | `REASON_CODE` enum (`errors.ts`) — `MATCHED`, `VALUE_MISMATCH`, `RECORD_NOT_FOUND`, etc., each mapped to plain language by the UI                                                                                        | Contract-level; UI translation owned by A05                                                                   |
| "Evidence is kept for 30 days"                                                                                    | `LIMITS.EVIDENCE_RETENTION_DAYS = 30` (`rules.ts`)                                                                                                                                                                       | Implemented as a constant; enforcement job is A02/A09                                                         |
| "One workflow, 500 runs a month, £29"                                                                             | `LIMITS.PLAN_RUNS_PER_PERIOD = 500`, `LIMITS.PLAN_PRICE_PENCE = 2900` (`rules.ts`)                                                                                                                                       | Implemented as a constant                                                                                     |
| "We never modify your CRM or resend your emails"                                                                  | No write scope requested anywhere in the frozen contract; `EvidenceSource` and `Evidence` types are read-only shapes; brief states this as a hard boundary                                                               | True by absence of any write path — keep it true by never adding one                                          |
| "No customer-supplied URL is ever fetched by us"                                                                  | Brief rule 8: "No customer-controlled URL is ever fetched. Provider hosts are a fixed allowlist."                                                                                                                        | Engineering rule, not yet independently testable from this repo snapshot — A02/A04 must enforce               |
| "Your data is scoped to your workspace; nobody else can see it"                                                   | Brief rule 1: tenant scope is application-enforced, every query includes `workspace_id`                                                                                                                                  | Engineering rule pending `apps/app/src/db/` (A02) — do not claim until enforced and tested                    |
| "We never let a model decide pass/fail or your bill"                                                              | Brief rule 9; `ASSISTANT_MODE` default is `'off'` (`status.ts`)                                                                                                                                                          | Contract-level; enforcement is A08's assistant boundary                                                       |
| "Card details never touch us"                                                                                     | Brief: Stripe hosted Checkout + Billing Portal                                                                                                                                                                           | Architectural decision, not yet built (A07/billing)                                                           |
| **Negative claim:** "We do not detect a run that never started, unless coverage mode is independently_sourced"    | See coverage-mode row above                                                                                                                                                                                              | Must ship as a standing caveat, not a footnote                                                                |
| **Negative claim:** "We do not verify any workflow shape other than enquiry → CRM record → acknowledgement email" | `workflowRulesSchema` has one `crm_correlation_property` and a bounded assertion set against exactly `CRM_FIELD`/`EMAIL_FIELD` — no other object type exists                                                             | True by absence                                                                                               |
| **Negative claim:** "We make no accuracy, uptime or security certification"                                       | No such infrastructure exists in this repo; brief forbids the wording outright                                                                                                                                           | Tone rule, keep enforcing it in copy review                                                                   |
| **Cut:** "Real-time verification" / "instant results"                                                             | `DEFAULT_DEADLINE_SECONDS = 600`, up to `MAX_DEADLINE_SECONDS = 3600`; results depend on a one-minute cron poll of a due-job table, not a live push                                                                      | No implementation — a result can legitimately take up to an hour to resolve                                   |
| **Cut:** "Unlimited workflows"                                                                                    | v1 pricing model is one workflow per workspace (see §6)                                                                                                                                                                  | Contradicts the frozen plan                                                                                   |
| **Cut:** "Works with any CRM / any email provider"                                                                | Only HubSpot and Resend connectors are planned for v1 (brief: "First connectors: HubSpot (CRM) and Resend (email)")                                                                                                      | No other connector exists                                                                                     |
| **Cut:** "Guaranteed accuracy" / "certified secure" / "100% uptime" / income guarantees                           | Explicitly forbidden wording (tone rules) and nothing in the stack proves any of them                                                                                                                                    | Never write these                                                                                             |
| **Cut:** "We tell you the automation is broken"                                                                   | We report evidence status against your rules, not a diagnosis of _why_ an automation failed — we have no visibility into the automation platform itself                                                                  | Out of scope; the customer still has to go and fix their own workflow                                         |

## 4. Explicit v1 exclusions (customer-facing wording)

- We only check one kind of workflow: an enquiry that should create a CRM record and send
  an acknowledgement email. We don't yet check quotes, invoices, support tickets, or any
  other shape of automation.
- We only read from HubSpot and Resend. If your automation uses a different CRM or a
  different email provider, we can't verify it yet.
- We don't look inside your automation platform (n8n, Make, Zapier or anything else). We
  never see why a step failed — only whether the expected outcome exists in HubSpot and
  Resend.
- We don't fix anything. We don't create or edit CRM records, and we don't send
  replacement emails on your behalf.
- We can't tell you a run never started unless you've set your workflow up with an
  independently sourced trigger. By default, if your automation never calls us, we have
  nothing to check and show nothing — we do not treat silence as success or failure.
- A result can take up to an hour to settle, because we check evidence on a schedule, not
  instantly. Nothing here is claimed to be real-time.
- One workspace on the plan supports one workflow, one owner and one invited viewer. It is
  not a multi-team or multi-workflow tool in v1.

## 5. Onboarding requirements

Before we can verify anything, a customer needs, in order:

1. **A connected HubSpot account with read access on contacts** (or the relevant object
   type). We need permission to look the record up ourselves — we cannot verify against a
   CRM we can't query.
2. **A correlation property on their HubSpot contact records** — a property that carries a
   value we can match back to a specific enquiry (`crm_correlation_property` in
   `workflowRulesSchema`). This is not automatic: the customer (or their automation) has to
   be writing a stable, unique value into a named HubSpot property for every enquiry, and
   tell us which property that is. If their automation doesn't already do this, it's real
   setup work before day one.
3. **A Resend account whose events we can read.** We need enough access to read message
   status for the account sending the acknowledgement email — not to send on their behalf.
4. **A signed event from their automation for every enquiry** — a call to our API,
   authenticated with a signing key we issue, carrying the expected correlation id and
   recipient (`sourceEventSchema`). This means editing their existing automation to add one
   more step. It is not a passive integration; the customer's workflow must be changed to
   call us.

**Be honest about the size of this**: this is not a "connect and go" product. A customer
needs an existing enquiry-to-CRM-to-email automation already built, has to add a property
to their HubSpot object schema if one doesn't already carry a correlation value, has to
generate and store a signing key, and has to add an outbound call to their existing
automation. Agencies comfortable editing their own n8n/Make/Zapier flows can do this in an
afternoon; anyone who did not build the original automation will need the original
builder's help.

## 6. Pricing assumptions and unit economics

Plan: **£29/month, one workflow, 500 runs per period, one workspace, one owner plus one
invited viewer.**

- Price: `LIMITS.PLAN_PRICE_PENCE = 2900` → £29.00 (`formatMoney` in `money.ts` renders
  this; content modules read the constant, see §pricing.ts below).
- Allowance: `LIMITS.PLAN_RUNS_PER_PERIOD = 500` runs.

### Worst-case external call volume

Per the brief's own framing: **500 runs × up to `LIMITS.MAX_OBSERVATIONS_PER_RUN` (4)
observations × up to 2 provider calls per observation.**

500 × 4 × 2 = **4,000 external provider calls per billing period, worst case**, if every
single run needed the maximum number of re-observations before settling (e.g. every
result was initially ambiguous and had to be re-checked up to the observation cap). This
is a ceiling, not a typical case — most runs should settle on the first or second
observation.

Assumption made here (not yet verifiable — `packages/connectors` has no source files yet):
that "2 provider calls per observation" means one HubSpot read and one Resend read per
observation. On that assumption, the 4,000-call ceiling splits to roughly **2,000 calls to
HubSpot and 2,000 calls to Resend per workspace per month**, worst case.

Two further multipliers exist in `LIMITS` that the brief's stated formula does not
include, and this document is not asserting they are additive on top of the 4,000 figure —
flagging them so nobody is surprised later:

- `MAX_TRANSIENT_RETRIES_PER_OBSERVATION = 3` — a retryable connector error
  (`RATE_LIMITED`, `PROVIDER_UNAVAILABLE`) can cause up to 3 extra calls _for that one
  observation_. In the true pathological case (every observation needs every retry) the
  ceiling is higher than 4,000; I'm treating the brief's 4,000 figure as the number to
  publish and design against, and flagging that retries are a further safety margin the
  system consumes, not creates.
- `MAX_CONCURRENT_CONNECTOR_REQUESTS_PER_WORKSPACE = 2` /
  `..._GLOBAL = 5` — these cap _simultaneous_ requests, not the monthly total. They matter
  for the rate-limit check below because they bound how many requests a single workspace
  can throw at HubSpot or Resend in the same instant.

### Do free/entry provider tiers absorb this? (verified where stated)

- **HubSpot**: private-app API limits for Free/Starter accounts are **100 requests per 10
  seconds per app, and 250,000 requests per day per account** (HubSpot developer docs,
  "API usage guidelines and limits", fetched 2026-09-19:
  https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines). A
  worst-case 2,000 HubSpot calls in a month is roughly 65–70/day averaged, and the
  workspace-level concurrency cap of 2 simultaneous connector requests means we can never
  burst anywhere near the 100-per-10-seconds ceiling from one workspace alone. **Verified:
  yes, comfortably absorbed**, even at the stated worst case, for a single workspace on
  HubSpot's free tier.
- **Resend**: the documented default API rate limit is **10 requests per second per team**
  (Resend docs, "Usage Limits", fetched 2026-09-19:
  https://resend.com/docs/api-reference/rate-limit); this applies across account tiers
  per that page, i.e. it isn't described there as a free-tier-only restriction. Our
  workspace-level concurrency cap of 2 is far below that. **Important distinction**:
  Resend's separate monthly _sending_ allowance (a free account's own email-send quota) is
  the customer's own limit for the emails their automation sends — it is not consumed by
  our read calls to check message status, which are a different kind of API usage. I did
  not find an explicit documented cap on read/status-check API calls separate from the
  general rate limit above, so I'm not asserting one. **Verified for rate limit; not
  verified for any separate read-quota, because none was found stated.**
- Estimate vs verified, summarised: the 4,000-call ceiling and the HubSpot/Resend split
  are this document's own arithmetic from `LIMITS` (verified against the source file).
  The provider rate-limit numbers above were checked against each provider's own current
  docs on 2026-09-19 (URLs given). Whether A04's actual connector implementation makes
  exactly "2 calls per observation" is **not yet verified**, because no connector code
  exists in this repository yet — treat the split as this document's working assumption
  until A04 confirms or corrects it.

### What this means for margin

At £29/month per workspace, worst-case external API usage does not approach either
provider's stated rate limits for a single customer. The real constraint on margin is
Cloudflare Workers/D1 usage and staff time, not provider API quota — this document does
not attempt to cost those, as no consumption data exists yet.

## 7. Acceptance mapping — customer journey

The brief refers to "plan §37" for the customer journey phases; that plan document is not
present in this repository, so its exact phase list could not be checked. The mapping
below is built instead from what is actually specified elsewhere in the frozen contract
(`docs/agent-brief.md`, `status.ts`, `events.ts`) and should be treated as this agent's
best reconstruction, not a verbatim copy of plan §37. Flag to the lead if the real §37
phase list differs.

| Journey phase                  | Observable definition of "working"                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up and workspace creation | A `workspace_admin` (owner) session exists; a workspace row exists scoped by `workspace_id` (brief rule 1)                                                                                                                                  |
| Connect HubSpot                | `ConnectionStatus` for the HubSpot connection reaches `'ready'` (`status.ts`); anything short of that (`'authorising'`, `'testing'`, `'degraded'`, `'expired'`, `'revoked'`, `'unsupported'`) is shown as not yet usable, in plain language |
| Connect Resend                 | Same connection lifecycle, `ConnectionStatus` reaches `'ready'` for the Resend connection                                                                                                                                                   |
| Define the workflow rules      | A `WorkflowRules` object validates against `workflowRulesSchema` — a `crm_correlation_property` is set, at least one mandatory assertion exists, and the assertion count is within `MAX_ASSERTIONS_PER_WORKFLOW` (10)                       |
| Choose the plan and pay        | An `OrderStatus` reaches `'active'` via Stripe Checkout (`status.ts`); `SubscriptionStatus` mirrors Stripe as `'active'` or `'trialing'`, never set by the browser                                                                          |
| Send a signed event            | A POST validates against `sourceEventSchema`, returns `eventAcceptedSchema` with a `run_id` and initial `status` of `'PENDING'`                                                                                                             |
| Receive a result               | The run's `RunStatus` moves from `'PENDING'` to one of `'VERIFIED'`, `'FAILED'`, `'UNVERIFIED'` within the workflow's `deadline_seconds`, each mandatory assertion carrying a `ReasonCode` the UI can render in plain language              |
| Ongoing running                | Successive signed events (distinct `event_id`s) each produce their own run; a duplicate `event_id` returns the existing run's result rather than creating a second one (idempotency, brief rule 4)                                          |
| Cancel                         | `SubscriptionStatus` moves to `'canceled'` via the Stripe Billing Portal; no further runs are accepted once the workspace is off-plan                                                                                                       |

## 8. Open items for other agents

- A03 (domain/evaluator): confirm the "2 provider calls per observation" assumption in §6,
  and confirm that "absence is UNVERIFIED, never VERIFIED" is enforced in the state
  machine, not just documented.
- A04 (connectors): confirm the actual HubSpot/Resend call shape per observation once
  built, so §6's split can be corrected if wrong.
- A05: `packages/ui/src/content/*` is written for you to import as-is (see handoff).
- The lead: no `plan/` document was found in this repository to check plan §37 against;
  flagging in case that's a repo gap rather than an intentional omission.

## 9. Re-audit — 2026-09-19 (workstream 2, against the deployed product)

§3's table was written when almost nothing existed. Section 1 was written then too. The
product has since grown a full public site, connectors, domain evaluator, billing with a
7-day payment-recovery policy, retention/deletion, support and an owner dashboard. This
section re-checks every claim against what is now actually built, deployed at
https://verify.itisyou.app. Three lists, as asked for.

### 9.1 Claims that became true (promoted from §3's "cut" or "conditional" rows)

| Claim                                                                                      | What now makes it true                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "We read your CRM record back from HubSpot ourselves"                                      | `packages/connectors/src/hubspot.ts`, `HUBSPOT_OPERATIONS` (three read-only endpoints), `docs/connectors.md`. Real code path — see the hard caveat in §9.3 about what has _not_ been exercised.                                   |
| "We check the record matches what your automation expected"                                | `packages/domain/src/evaluate.ts` and `decide.ts`, exercised by `VERIFY-*` unit tests                                                                                                                                             |
| "Accepted by the sending service" vs "delivered to the receiving server" are kept distinct | `docs/connectors.md`'s Resend event-mapping table maps `email.sent` → `accepted` and `email.delivered` → `delivered` as the only delivery-proving status; never merged                                                            |
| "An email being opened is never treated as proof anyone read it"                           | Same table: `email.opened`/`email.clicked` carry no delivery weight; confirmed in code, not just prose                                                                                                                            |
| "Absence of evidence is never VERIFIED"                                                    | `packages/domain/src/decide.ts` — no branch of the decision table returns `VERIFIED` without every mandatory assertion `SUPPORTED`                                                                                                |
| "A missed deadline only counts as FAILED if evidence access was actually working"          | `decide.ts`'s `FAILED_ABSENT` branch requires an _authoritative_ absence (a provider `NOT_FOUND`, per `docs/connectors.md`'s "Absence versus silence" table); anything else resolves `UNVERIFIED`. Held by `CONN-141`/`CONN-142`. |
| "We never modify your CRM or resend your emails"                                           | `HUBSPOT_OPERATIONS` and `RESEND_OPERATIONS` are frozen tables of read-only calls; there is no code path that could construct a write request (`docs/connectors.md` §"The rules every connector obeys")                           |
| "No customer-supplied URL is ever fetched by us"                                           | `packages/connectors/src/url-guard.ts` — compile-time allowlist of exactly three hosts, private/loopback/metadata addresses refused, redirects re-checked per hop                                                                 |
| "Your token never appears in a log line, an error message or an exported report"           | Redaction is registered before any request is issued (`docs/connectors.md`); export code confirms no stored credential is ever serialised (`docs/privacy-retention.md` §5)                                                        |
| "Card details never touch us"                                                              | Stripe hosted Checkout + Billing Portal, `docs/billing.md` §2 — no card data path exists in this codebase                                                                                                                         |
| "£29/month, one workflow, 500 runs" and the allowance/overage behaviour                    | `docs/billing.md` §3 — reservation/consumption accounting, `BILL-*` tests, no automatic overage charge                                                                                                                            |
| "Evidence kept 30 days"                                                                    | `apps/app/src/privacy/retention.ts`, generated into `docs/privacy-retention.md`, checked against the sweep by `API-330`                                                                                                           |
| "We never let a model decide pass/fail or your bill"                                       | `apps/app/src/assistant/` exists with `ASSISTANT_MODES` defaulting to `'off'`; the assistant is a separate subsystem from `packages/domain`'s decision table, which never imports it                                              |
| Tenant scoping ("your data is scoped to your workspace")                                   | 14 files under `apps/app/src/db/` reference `workspace_id`-scoped queries; no longer merely a brief rule, an actual pattern in the data-access layer                                                                              |

### 9.2 Claims that quietly became false, or need rewording (caught and already fixed)

- **`PLAN_CANCELLATION_WORDING` inside the payment-failure email.** A09 removed it from
  `payment_problem` because "you keep access for the rest of the period you already paid
  for" describes a _voluntary_ cancellation, not a _failed renewal_ — the period being
  billed for has already ended when that email goes out, so the sentence would tell a
  customer they still have something they no longer have. **I agree with this reading.**
  The constant itself is still correct where it actually applies: the pricing page and the
  cancellation-confirmed email, both genuine cancellations. No change needed to the
  constant; A09's judgement to not reuse it in that one email was right.
- **The privacy/legal content constants under-described Resend.** `SUBPROCESSORS` and
  `DATA_FLOW` in `packages/ui/src/content/legal.ts` said Resend was "read access only" —
  true for evidence, but Resend is now also the service that sends our own transactional
  emails (sign-in links, failure notices, deletion confirmations), per
  `apps/app/src/privacy/dataflow.ts` (A09) and `docs/privacy-retention.md` §3–4. **Fixed in
  this pass** — both constants now state the dual role.
- **The onboarding-guide FAQ answer pointed at a page that did not exist.** `faq.ts`'s
  `what-do-i-need-before-starting` said "see our onboarding guide for the exact steps" with
  no such guide published; A05 had to render a visible "not yet published" callout rather
  than a broken link. **Fixed in this pass** — `packages/ui/src/content/onboarding.ts` now
  has the actual four-step guide, sourced from `docs/connectors.md`'s verified connector
  facts (exact HubSpot scope, the Resend full-access-key caveat, the manual webhook setup).

### 9.3 Claims still unbacked — the list to act on

1. **The site must not imply the provider integration has been exercised against a live
   account — checked hardest, per the brief. It currently does not overstate this**, on
   the pages I could find: `/`, `/how-it-works`, `/pricing`, `/security`, `/demo`, the FAQ,
   and the onboarding flow (`apps/app/src/routes/app/onboardingPages.ts`). The demo page is
   explicit and repeated ("Synthetic data", "no customer here, no database is read") and
   never claims a live HubSpot/Resend account was used. `docs/connectors.md` and
   `docs/billing.md` state the CONN-050/CONN-051/Stripe-live gap themselves, in the
   development-facing docs. I found no customer-facing sentence claiming the connectors
   have been tested against a real provider account. **No fix needed here; flagging the
   check as done, not skipped.**

2. **`independently_sourced` coverage mode is selectable and described, but not actually
   implemented — this is the one I am flagging hardest.** A customer can choose "We find
   enquiries ourselves" in onboarding (`apps/app/src/routes/app/onboardingPages.ts` line
   ~326), and `packages/domain/src/coverage.ts`'s `describeCoverage()` then shows the
   confident headline **"We find the enquiries ourselves"** with the detail "We list
   enquiries from the connected system on our own schedule rather than waiting to be told
   about them, so an enquiry your automation missed entirely still shows up here." I looked
   for the connector operation that would do this listing and could not find one:
   `HUBSPOT_OPERATIONS` in `packages/connectors/src/hubspot.ts` has exactly three entries
   (`token_info`, `contact_by_id`, `contact_search` — a lookup by a known correlation
   value, not an enumeration of recent contacts), and no file under `apps/app/src/scheduler/`
   references `coverage_mode` at all. The field is stored
   (`apps/app/src/db/workflows.ts`) and changes the UI copy, but nothing in the codebase
   actually polls HubSpot or Resend independently of a customer-sent event. **A customer who
   selects this mode today is told a capability exists that the system cannot deliver.**
   This is precisely the class of claim this whole audit exists to catch, and it is a
   product/engineering gap, not a copy gap — my own `faq.ts` (`what-is-coverage-mode`,
   `run-never-started`) and `home.ts` correctly describe the _intended_ design and I have
   not found a sentence of mine that overstates it beyond what `coverage.ts` itself claims,
   but that intended design is not yet real. Recommend one of: (a) hide the
   `independently_sourced` option in onboarding until a real listing connector exists, or
   (b) reword `describeCoverage()`'s headline to something that does not promise detection
   that cannot happen, until it can. Either fix belongs to A03/A04, not to a content change
   in `packages/ui`.

3. **Test-ledger hygiene risk on the exact two IDs the brief singled out.** The ledger
   (`docs/test-cases.json`) correctly records `CONN-050` and `CONN-051` as
   `provider_backed: true, status: "planned"`, matching `docs/organic-launch.md`'s "still
   planned, never run." But `tests/unit/connectors/hubspot.test.ts` also has two unit tests
   literally titled `'CONN-050 rejects a payload with no usable id as INVALID_EVIDENCE'` and
   `'CONN-051 rejects a payload whose properties member is not an object'` — unrelated
   input-validation tests reusing the same case IDs the ledger reserves for the real
   provider-backed reads. `scripts/verify-test-cases.mjs` does not currently fail on this
   (the ledger's own `status` field is still `'planned'`, so its "status claims implemented
   but no test exists" check does not fire, and its "id used in more than one file" check
   only compares across files, and these two IDs only collide within one file against the
   ledger's separate `implementation_ref`). Nothing public currently claims these are
   passing. The risk is purely that a future edit could flip the ledger's `status` to
   `passing` on the strength of these unit tests existing, without a real provider account
   ever having been contacted — exactly the false claim the lead is watching for. Flagging
   for A04/A11 to rename the two unit test titles off `CONN-050`/`CONN-051` so the ids stay
   reserved for the genuine provider-backed cases.

4. **Dispute/chargeback fees remain unverified** (`docs/billing.md` §7) — unchanged from
   when that document was written; noted here only because it is a live "estimate, not
   verified" item that could be mistaken for settled.

5. **VAT status remains `TODO_OWNER_INPUT` everywhere** (this document §6, `legal.ts`,
   `docs/privacy-retention.md`) — the founder has confirmed UK sole trader; trading name,
   contact address and VAT registration status are still outstanding and every placeholder
   stays visibly marked, per instruction.

### 9.4 A05's "What the service does" paragraph on `/terms` — reviewed, blessed

`apps/app/src/routes/public/legal.ts`, `TermsPage()`, the paragraph beginning "`${PLAN_NAME}`
verifies one workflow shape...": accurate against §2–3 of this document and against
`docs/connectors.md`. It restates the read-only boundary and the one supported workflow
shape without overclaiming exercised provider use, and it sits directly above
`StandingLimitations()`, so the caveats are not separated from the claim. **Blessed as
written — no change requested.**

## 10. Re-audit against reachability — 2026-09-19, second pass, urgent

An independent auditor found the dominant defect on this project is **correct code,
thoroughly tested, reached by nothing**: a function exists, is unit-tested, and nothing
on a real HTTP entry point or cron tick ever calls it. §9 asked "is this implemented".
This section asks the harder question the lead posed: **does a real request reach it.**
Every entry below was checked by reading `apps/app/src/index.ts` (the only place routes
are actually mounted) and `apps/app/src/scheduler/tick.ts`
(`IMPLEMENTED_SCHEDULER_PASSES`), then grepping for callers, not by reading a doc comment
that claims wiring.

### 10.1 Claims that are true and wired (entry point given, not just the module)

| Claim                                                                                                                                      | Entry point                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe billing events (checkout completion, subscription/invoice changes, refunds) are processed                                           | `app.all('/api/v1/webhooks/stripe/*', ...)` in `apps/app/src/index.ts`, mounted and calling `createStripeWebhookRoute`                                                                  |
| Due verification runs are observed against HubSpot/Resend, retried within budget, and decided                                              | `handleScheduled` → `runSchedulerTick` → the `due_job` pass, in `IMPLEMENTED_SCHEDULER_PASSES` (`apps/app/src/scheduler/tick.ts`)                                                       |
| Outbox events (e.g. notification dispatch on a run decision) are delivered                                                                 | The `outbox` pass, same `IMPLEMENTED_SCHEDULER_PASSES` list                                                                                                                             |
| Evidence/source-events/etc. are swept on their retention schedule                                                                          | The `retention` pass, same list, backed by `apps/app/src/privacy/retention.ts` and checked against the doc by `API-330`                                                                 |
| Sign-in, onboarding pages, run/connection/usage dashboards, support form, cancellation                                                     | `app.route('/app', createAppRoutes(...))`, mounted against real D1 (`createCustomerDataPort`)                                                                                           |
| Owner dashboard, once A02's session/TOTP wiring lands (explicitly gated to 404 for everyone until then, per the comment at the mount site) | `app.route('/owner/*', ...)` etc. — correctly **not** claiming to work yet; the code comment says so and the content on `/owner` is not customer-facing, so no public claim rests on it |
| The health check                                                                                                                           | `app.get('/health', ...)`, genuinely probes D1                                                                                                                                          |

### 10.2 Claims that must be qualified now (exact replacement wording given)

All of the following are addressed by one new, prominent, honest notice — see
`SERVICE_ACTIVATION_NOTICE` in `packages/ui/src/content/site.ts` — rather than a patch to
every sentence that touches them, because the root cause is one and the same across all
of them: the parts of the system that connect a real workspace to the real, tested
checking logic are not yet live.

> **We are not yet accepting live verification traffic.**
> Everything on this site describes how ITISYOU Verify is built to work, and the
> underlying checking logic is real and tested. Three things this notice used to call
> unfinished are now done, and it is only honest to say so: the endpoint that receives
> your automation's signed events is live and refuses an unsigned request, a Resend
> connection reaches "ready" only once a correctly signed callback has actually arrived,
> and the plan allowance is enforced on the live request path. What is not finished is the
> part that matters most before anyone pays: live payments are switched off until the owner
> turns them on separately, and this deployment cannot yet create a new customer workspace. So we
> are not taking payment or activating new workspaces yet. This notice comes down when
> that last part is done, and not before.

**This specification is the fourth copy of that fact and was the last one still stale.**
The auditor found it in pass 7, after two copies in the UI had been corrected: a document
that _specifies_ a false notice will put it back the next time someone implements from the
spec, which makes a stale spec worse than a stale string. The wording above is kept
identical to `SERVICE_ACTIVATION_NOTICE` in `packages/ui/src/content/site.ts` on purpose —
if the two ever differ, the code is right and this line is the defect.

A05: render this on `/`, `/pricing`, and the entry point of the onboarding flow, above the
fold, not in a footnote.

Specific content already corrected in this pass:

- `packages/ui/src/content/onboarding.ts` — the intro now points at this notice; step 3's
  (Resend) caveat now states plainly that our side of the webhook is not yet reachable, so
  the connection cannot currently finish reaching `ready`; step 4's (signed event) caveat
  now states the intake endpoint is not yet live; `ONBOARDING_DONE_MEANS` now says "once
  live traffic is switched on" rather than describing it as available today.
- `packages/ui/src/content/faq.ts` — added `is-verification-live-today`, answering the
  question plainly rather than leaving a stranger to infer it from silence.

Not yet corrected, and not mine to correct — flagged for the owning agent, with the exact
finding so nobody has to re-derive it:

- **The resume-on-confirmed-payment promise** (`apps/app/src/billing/policy.ts`,
  `PAYMENT_RECOVERY_POLICY.resumeRequires` and the `payment_problem` email in
  `apps/app/src/notifications/templates.ts`, which says "Checking starts again when a
  payment is actually confirmed by our payment provider"). `reconcileSubscriptions()` is
  correct but has **zero callers** anywhere in `apps/app/src`
  (confirmed by grep: only `apps/app/src/billing/index.ts` re-exports it, and
  `apps/app/src/billing/scheduled.ts`'s `runBillingMaintenance` — the function whose own
  doc comment says "A03's tick calls `runBillingMaintenance(runtime, { now })`" — is
  **itself never imported or called anywhere in `apps/app/src`**, including
  `apps/app/src/scheduler/tick.ts`, whose `IMPLEMENTED_SCHEDULER_PASSES` list is exactly
  `['due_job', 'outbox', 'retention']`). Recommended replacement wording for A09's email,
  until wired: replace "Checking starts again when a payment is actually confirmed by our
  payment provider" with _"Checking starts again once a confirmed payment reaches us — we
  are still finishing the automatic check for this, so if it feels slow after you have
  paid, contact us and we will resolve it by hand."_ This is honest without frightening a
  customer who has genuinely paid.
- **The pre-checkout disclosure** (`PRE_CHECKOUT_DISCLOSURE` /
  `preCheckoutPanel()` in `apps/app/src/billing/disclosure.ts`) has zero callers in
  `apps/app/src/routes`. The founder required this to be shown before checkout, not
  discovered after. Until a route renders it, **checkout must not be reachable at all**
  (§10.3) — there is no safe qualified wording for "we will show you the policy before you
  pay" when nothing shows it.
- **No route consults an entitlement.** I found no caller of the run-admission/allowance
  logic (`apps/app/src/billing/admission.ts`, `apps/app/src/db/entitlements.ts`) from any
  route in `apps/app/src/routes`. This is subsumed by the larger finding in §10.3: there is
  currently no route at all that creates a run from a real request, so there is nothing yet
  for an entitlement check to guard.
- **Day 8 never arrives.** Same root cause as the resume promise — `runBillingMaintenance`
  has no caller, so `expirePaymentRecoveryWindows()` never runs on a schedule.
- **The Resend webhook route is not mounted.** `createResendWebhookRoute` (in
  `apps/app/src/routes/webhooks/resend.ts`) has no caller in `apps/app/src/index.ts`. Only
  the Stripe webhook is mounted (`app.all('/api/v1/webhooks/stripe/*', ...)`); there is no
  equivalent line for Resend. `packages/ui/src/content/onboarding.ts` step 3 now says this
  plainly (see above).

### 10.3 Claims that must be removed — purchase/activation paths, err toward removal

This is larger than the four items the lead named. Checking `apps/app/src/index.ts`
directly (the only place any route is mounted) against
`packages/contracts/src/events.ts` and every place my own content describes "send us a
signed event":

**There is no mounted route, anywhere, that accepts a customer's signed event.** Grepped
for `api/v1/events` (the path named in `packages/contracts/src/events.ts`'s own comments,
in `packages/security/src/signatures.ts`, and shown to customers as their event endpoint
by `apps/app/src/db/customerPort.ts`) across every route file and `apps/app/src/index.ts`:
it appears only as a _string constant displayed to the customer_ — never as a mounted
path. `apps/app/src/scheduler/observe.ts` parses a `sourceEventSchema` payload once one
already exists as a stored run, and `apps/app/src/db/runs.ts` can create one, but nothing
in the routing layer turns an inbound HTTP request into that call. The single mechanism
this entire product is named for — an automation's signed event starting a verified run —
**has no live entry point today.**

This is not a wording problem. No replacement sentence makes "send us a signed event"
true while the endpoint does not exist. Per the founder's instruction — informational
site stays, purchase and activation paths come down — the concrete actions are:

1. **Disable the checkout/"go live" step of onboarding** (the button labelled "Start
   setting this up" on the pricing page and "Finish setting up" in the welcome email, both
   of which lead into `apps/app/src/routes/app/onboardingPages.ts`'s checkout step) until
   the event-intake route exists, the Resend webhook is mounted, entitlement is consulted,
   and `runBillingMaintenance` has a caller. This is a routing change for A05/A06, not a
   content change — flagging it here because it is the direct consequence of what this
   audit found, not because it is mine to make.
2. **Leave the descriptive "how it works" content in place** (`home.ts`,
   `onboarding.ts`), now qualified by `SERVICE_ACTIVATION_NOTICE` and the corrected
   caveats above, because the design itself is real, tested, and not what is in question.
3. **Do not remove the demo page.** It runs the real `evaluate`/`decide`/`explain` code
   over synthetic fixtures, touches no database, and has never claimed to be live traffic —
   it remains an accurate demonstration of the checking logic regardless of whether the
   intake route exists yet.

### 10.4 The two items to verify rather than assume — checked directly

- **Nothing states the provider integration has run against a live HubSpot or Resend
  account.** Re-checked `/`, `/how-it-works`, `/pricing`, `/security`, `/demo`, the FAQ,
  and `docs/connectors.md`/`docs/billing.md` for exactly this after §9's first pass; found
  nothing new. `CONN-900`/`CONN-901` were not previously in this document — noting here
  that they, not `CONN-050`/`CONN-051`, are the lead's current identifiers for the
  provider-backed cases; either way, no public page claims they have run, and none should
  until they have.
- **The founder's sole-trader details remain `TODO_OWNER_INPUT`.** Unchanged in
  `packages/ui/src/content/legal.ts` (`OWNER_LEGAL_IDENTITY`) and
  `docs/privacy-retention.md`. Confirmed still visibly marked, not invented.

## 11. Public-claims audit — 2026-09-19, third pass (A18)

§9 asked "is this implemented". §10 asked "does a real request reach it". This pass asks a
third question that neither answered: **would a visitor reading the page today be told
something untrue?** — and it was answered by fetching every public page through
`apps/app/src/index.ts`, the Worker entry point, and reading the rendered HTML. Not by
rendering a page function, and not by reading this document, which had itself drifted.

The regression tests are `tests/integration/public/claims.test.ts` (`CUST-330`..`CUST-340`).
Every case builds a real `Request` and asserts against the response body. All eleven were
committed red against the site as it stood and are green against the site as it now stands.

### 11.1 Claims corrected

| #   | Claim as published                                                                                                                                 | Where                                                                                                                                                                                        | Verdict                                                               | What it now says                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Only workflows configured with an independently sourced trigger can show a run that never started at all"                                         | `packages/ui/src/content/home.ts`, `HOME_WHAT_THIS_DOES_NOT_DO[3]` — rendered on `/` and `/how-it-works`                                                                                     | **Not true today**                                                    | "We have built no way to find enquiries your automation never reported." No second mode is offered.                                                                                                                                                                                                   |
| 2   | "By default we cannot tell you a run never started at all — only workflows set up with an independently sourced trigger can show that"             | `packages/ui/src/content/site.ts`, `STANDING_LIMITATIONS_PARAGRAPH` — rendered on `/how-it-works`, `/pricing`, `/security`, `/support`, `/terms`, `/status`, `/demo` and the app's run pages | **Not true today**                                                    | The same sentence without the escape hatch.                                                                                                                                                                                                                                                           |
| 3   | "Only if your workflow is set up with an independently sourced trigger…"                                                                           | `packages/ui/src/content/faq.ts`, `run-never-started`                                                                                                                                        | **Not true today**                                                    | "No." Followed by why, and by the statement that we would rather name the blind spot than sell a setting that does not close it.                                                                                                                                                                      |
| 4   | '"Independently sourced" means the trigger comes from somewhere outside your automation, so a run that never started can itself be shown as a gap' | `packages/ui/src/content/faq.ts`, `what-is-coverage-mode`                                                                                                                                    | **Not true today**                                                    | "There is one coverage mode today." The second is named as roadmap and explicitly not offered.                                                                                                                                                                                                        |
| 5   | "We read the CRM record and the email outcome back from HubSpot and Resend ourselves", and every variant of it                                     | `/`, `/how-it-works`, `/security`                                                                                                                                                            | **True but unproven against a real provider**                         | Unchanged — the code is real — but each of those three pages now renders `PROVIDER_PROOF_NOTICE`, which states that the connectors have never been run against a real HubSpot or Resend account and that every connector test to date runs against stubs built from published provider documentation. |
| 6   | Nothing at all about what happens if a payment fails                                                                                               | `/pricing`                                                                                                                                                                                   | **Not true by omission**                                              | `/pricing` now renders the seven-day payment-recovery policy — headline, what pauses, what keeps working, what happens on day 8, and what happens to the customer's data — read from `PAYMENT_RECOVERY_POLICY` rather than retyped.                                                                   |
| 7   | "ITISYOU Verify reads your HubSpot record and Resend email status back itself and tells you what the evidence shows."                              | `/` meta description                                                                                                                                                                         | **Not true today**                                                    | "…is built to read … and not yet accepting live traffic, so nothing is on sale today."                                                                                                                                                                                                                |
| 8   | "Cancel from the billing portal at any time."                                                                                                      | `/pricing` meta description                                                                                                                                                                  | **Not true today**                                                    | An instruction to a subscriber, quoted where nobody can subscribe. Replaced with the terms and the fact that we are not taking payment.                                                                                                                                                               |
| 9   | "see our onboarding guide for the exact steps"                                                                                                     | `packages/ui/src/content/faq.ts`, `what-do-i-need-before-starting` — rendered on `/`, `/how-it-works` and `/support`                                                                         | **Not true today**                                                    | "There is no separate onboarding guide yet — the how-it-works page is the full instructions until one is written." The contradicting callout on `/how-it-works` now only says where the instructions are.                                                                                             |
| 10  | "A service that reads HubSpot and Resend back itself and reports what the evidence shows."                                                         | `packages/ui/src/layout/layouts.ts` footer — every public page, including the last line of `/terms`                                                                                          | **Not true today**                                                    | `FOOTER_SERVICE_DESCRIPTION`: what it is built to do, plus one line saying we are not accepting live traffic.                                                                                                                                                                                         |
| 11  | "Start with the worked example and the setup requirements before you sign up"                                                                      | `apps/app/src/routes/app/authPages.ts` — served at `GET /app`, which answers 401 with this page                                                                                              | **Not true today**                                                    | "There is nothing to sign up for yet." The page now carries the activation notice. The sign-in form itself is untouched.                                                                                                                                                                              |
| 12  | "The mode was made unavailable rather than reworded: … it is marked unsupported as data the onboarding UI reads"                                   | `apps/app/src/routes/public/story/narrative.ts`, rendered at `/development-story/visual`                                                                                                     | **Not true today — the claim described a fix that had not been made** | Made true rather than softened: see §11.2.                                                                                                                                                                                                                                                            |

### 11.2 Activation paths disabled or corrected

- **The onboarding coverage-mode selector still offered the unimplemented mode.**
  `apps/app/src/routes/app/onboardingPages.ts` listed two hard-coded options, the second
  labelled "We find enquiries ourselves", and `apps/app/src/routes/app/index.ts` stored
  whichever came back. `packages/domain/src/coverage.ts` has marked that mode
  `supported: false, selectable: false` since commit `3c94f8d`, and the public development
  story has claimed since then that the onboarding UI reads that data. It did not.
  The option list now comes from `SELECTABLE_COVERAGE_MODES`, so the mode cannot be offered
  by forgetting to delete a line; the unavailable mode is rendered through
  `UnavailableAction` with A03's own reason rather than disappearing unexplained; and the
  `POST` handler resolves the submitted value against `SELECTABLE_COVERAGE_MODES` instead of
  a string literal, so a hand-posted form gets the coverage we can deliver rather than a
  stored promise nothing implements.
- **The sign-in page** (`GET /app`, answering 401) now carries `SERVICE_ACTIVATION_NOTICE`
  and no longer invites a sign-up. Signing in is deliberately **not** disabled: the owner's
  instruction was to preserve every working control, and an existing account must still be
  able to reach its workspace.
- Nothing else was disabled. The purchase path was already closed by the previous pass
  (`UnavailableAction` on `/pricing`, on the onboarding entry point, and in place of the
  checkout submit control) and those controls were left exactly as they are.

### 11.3 Claims that should be removed rather than qualified

Recorded here for the owner; **not acted on**, because removing a page or a policy is a
product decision rather than a copy correction.

1. **The `independently_sourced` coverage mode should come out of the customer-facing
   vocabulary entirely**, not only out of the selector. It remains in
   `packages/contracts/src/status.ts` (frozen, not mine to touch) and is still named on
   `/development-story/visual`. Keeping it visible anywhere a buyer reads invites the
   question "can I have that one?", and the honest answer is a roadmap item with no date.
2. **"Cancel from the billing portal at any time"** — as an FAQ answer (`how-cancel`), not
   just as a meta description. No customer can reach a Stripe billing portal, because no
   customer can subscribe. It currently reads as an instruction; it should either come out
   until checkout opens or be rewritten as a future term of the plan.
3. **The `/status` page's "Environment" row.** On production it reads `production`, which
   tells a visitor nothing they can act on, and the page already says plainly that there is
   no monitoring behind it. A deployment label is internal detail dressed as a status signal.
4. **The `Stripe` row of the subprocessor table** states that Stripe processes "billing
   details and subscription status". No live key exists and no payment has ever been taken,
   so Stripe processes nothing for us at present. It belongs in the list because it will,
   but the table has no column that can say "not yet in use", and inventing one for a single
   row is worse than saying so in the surrounding prose.

### 11.4 Ruling out the claim classes found on the Stitch-generated landing page

A design audit of a _generated_ landing page — not our shipped site — found four classes of
claim we do not make, plus a pricing mismatch. The owner asked for these to be ruled out on
the real site, and for the negatives to be stated rather than left silent. Method for each:
fetch every page through `apps/app/src/index.ts`, strip tags to visible text, and pattern-match
both the text and the raw markup; then grep the source tree for the same, in case something is
written but unrendered. Regression cases `CUST-342`..`CUST-347` keep each check running.

**1. Compliance and certification claims — one finding, now corrected.**
No `SOC 2`, `SOC-2`, `ISO 27001`, `PCI DSS`, `HIPAA`, `Type II`, "certified", "accredited",
"trust seal" or "trust badge" appears on any page. Every one of the 21 occurrences of
"certification" across the site is a **denial** ("We hold no certification and do not claim
one", "We make no accuracy, security or uptime certification") or a visible
`TODO_OWNER_INPUT` gap on `/security` and `/terms`. There are **no `<img>` elements anywhere
on the site** — checked on every page, not inferred — so no badge graphic can carry a claim
the text does not; the only three `alt` attributes belong to the three inline diagrams on
`/development-story/visual` and read "journey", "system", "timeline".

The one finding: `/development-story/visual` carried a heading reading **"Independently
audited"**. It described one specialist agent on this project reviewing another's work
against the code — not a third-party attestation — but "independently audited" is the exact
register a security attestation uses, and a reader scanning headings could not tell. The
heading is now "Reviewed by a second specialist, in-house" and the body opens by saying what
it is not. Severity: lower than a badge, because the surrounding text never claimed a
standard, but corrected on the owner's rule that an attestation claim is not ordinary
overclaiming.

**2. Attributed quotes, named individuals and competitor claims — nothing found.**
No `<blockquote>`, no `<cite>`, no testimonial or review component exists in
`packages/ui/src/components/` at all, so the site has no markup capable of presenting an
attributed quote. No "trusted by", no customer count, no case study, no G2/Capterra/
Trustpilot reference, and no text matching the shape `— Firstname Lastname, Company`.
No individual is named anywhere on a public page.

Competitors are mentioned in exactly one sentence, on `/` and `/how-it-works`: _"We never see
inside n8n, Make, Zapier or whatever runs your workflow."_ That is a statement about our own
blindness, not a claim about their products, and it is the only one. `docs/competitors.md`
contains comparative analysis and is not published — it is a repository document, not a route.
`CUST-343` bars the shape that would be a problem: a competitor name within eighty characters
of "fails", "cannot", "doesn't" or "misses".

**3. Auto-remediation claims — nothing found, and the opposite is stated.**
No "auto-healed", "AUTO-REMEDIATED", "self-healing", "auto-fix", "self-repair" or "we will fix
your…" in any tense, on any page, in any source file under `packages/ui/src` or
`apps/app/src/routes`. The frozen contract is observe-only, so this is not a gap waiting to be
filled — it can never become true under the current design. What the site says instead is the
inverse, prominently: _"It does not fix anything"_ as a full card on `/` and `/how-it-works`,
_"We only ever read"_ in the FAQ and on the connections page, and _"We never modify your CRM,
send a replacement email, or fix your automation"_ in the standing limitations paragraph on
seven pages. Two greps matched on `/development-story/visual` — "forcing a rollback" (a D1
transaction) and "Dependabot auto-fixes" (our own CI) — neither of which is a product claim.

**4. Package or SDK install instructions — nothing found.**
No `pip install`, `npm install`, `pnpm add`, `yarn add`, `gem install`, `go get`, `cargo add`
or `brew install`; no reference to PyPI, npmjs.com, crates.io, Packagist or RubyGems; no SDK
or CLI is offered. **There is no `<pre>` or `<code>` block on any public page** — the site
publishes no copyable command at all. So there is no unclaimed-registry-name exposure: nothing
tells a reader to fetch anything from a namespace we do not control.

**5. Pricing accuracy — correct, and four retyped figures removed.**
Every published figure matches the implementation. The only numbers the site publishes are
£29.00 (`LIMITS.PLAN_PRICE_PENCE` through `formatMoney`), 500 runs
(`LIMITS.PLAN_RUNS_PER_PERIOD`), 30 days retention (`LIMITS.EVIDENCE_RETENTION_DAYS`) and the
7-day recovery window (`PAYMENT_FAILURE_GRACE_DAYS`). **No `$`, `€`, `USD` or `EUR` appears on
any page** — one plan, one currency, and no tier structure.

Four figures were nonetheless **retyped as literals** where a change to the constant would have
left them behind. All four now interpolate the constant:

| Literal                         | File                                                                | Now reads                                                    |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| "kept for 30 days by default"   | `packages/ui/src/content/faq.ts` (`store-customer-data`)            | `${LIMITS.EVIDENCE_RETENTION_DAYS}`                          |
| "Thirty days by default"        | `packages/ui/src/content/faq.ts` (`how-long-evidence-kept`)         | `${LIMITS.EVIDENCE_RETENTION_DAYS}`                          |
| "kept for 30 days by default"   | `packages/ui/src/content/legal.ts` (`EVIDENCE_RETENTION_NOTE`)      | `${LIMITS.EVIDENCE_RETENTION_DAYS}`                          |
| "500 runs a month … seven days" | `apps/app/src/routes/public/index.ts` (`/pricing` meta description) | `${LIMITS.PLAN_RUNS_PER_PERIOD}`, `${PAYMENT_RECOVERY_DAYS}` |

`CUST-347` reads those modules **as source** and fails on a hard-coded duplicate of a governed
number. A rendering assertion cannot catch this class: four copies of "30" all render correctly
right up to the moment somebody changes the constant, which is precisely when a claims test
should fire.

### 11.5 Checked and left alone

- `/demo` — the four verdicts really are produced by `evaluateAssertions()`,
  `decideRunStatus()` and `explainRun()` over the shared synthetic fixtures. The page says
  "real verdicts about fake facts" and that is exactly what it is. **True today.**
- `/status` — publishes no uptime figure, and `/health` genuinely probes D1. **True today.**
- `TODO_OWNER_INPUT` placeholders on `/terms`, `/privacy`, `/security` and `/support` — still
  rendered as visible gaps, never filled with anything plausible. **True today.**
- Open Graph text — there is none. `packages/ui/src/layout/shell.ts` emits `charset`,
  `viewport`, `title`, `description`, `robots`, `color-scheme` and a favicon link, and no
  `og:` or `twitter:` tags at all. Nothing to correct, and none were added: a share card is
  a claim surface and this is not the week to open one.
- No testimonial, customer count, case study or statistic appears anywhere on the site. The
  only figures published are the price, the allowance, the retention period and the demo's
  own 33%, and all four are read from constants.
