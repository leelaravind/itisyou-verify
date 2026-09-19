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
  `docs/competitors.md`), which tells them the *workflow* threw an error — not whether the
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

| Claim (customer-facing) | Implementation it maps to | Status |
| --- | --- | --- |
| "We read your CRM record back from HubSpot ourselves" | `EvidenceOrigin: 'provider_readback'`, `CrmRecordEvidence` (`evidence.ts`); HubSpot connector reads `record.*` fields (A04, not yet built) | Cut until A04 ships the connector — claim only after `provider_readback` path exists |
| "We check the record matches what your automation expected" | `assertionSpecSchema` operators `exists`, `equals`, `not_equals`, `normalised_email_equals`, `one_of` against `CRM_FIELD` (`rules.ts`) | Implemented at contract level; evaluator is A03's `packages/domain` (not yet built) |
| "We check the email was accepted by the sending service" | `EMAIL_STATUS` includes `'accepted'`; assertions against `message.status` with `provider_status_in` (`evidence.ts`, `rules.ts`) | Contract-level yes; do not conflate with delivery (see below) |
| "We check the email was delivered to the receiving mail server" | `DELIVERY_PROVING_STATUSES = {'delivered'}` (`evidence.ts`) — a distinct, stronger claim than "accepted" | Contract-level yes. **Never merge this wording with "accepted"** |
| "We never treat an email open as proof someone read it" | `EMAIL_STATUS` lists `'opened'`/`'clicked'` separately from `DELIVERY_PROVING_STATUSES`; no rule in `rules.ts` allows `opened` to satisfy a delivery assertion by itself unless the customer explicitly writes that rule | Negative claim — true by omission, keep it that way |
| "You get a VERIFIED, FAILED, UNVERIFIED or PENDING result — never a fifth state" | `RUN_STATUS` (`status.ts`) is a closed tuple of exactly those four | Implemented at contract level |
| "No evidence yet is never treated as success" | `RUN_STATUS`/`ASSERTION_STATUS` design: absence maps to `UNVERIFIED`/`PENDING`, never `VERIFIED` (brief, "Absence of evidence is `UNVERIFIED`") | Contract-level rule; evaluator (A03) must honour it — flag as a test case, not just a doc claim |
| "A missed deadline only counts as FAILED if evidence access was actually working" | Brief: "a deadline failure is supported by *working* evidence access"; `ConnectorErrorCode`/`isRetryableConnectorError` (`errors.ts`) distinguish access problems from a genuine miss | Contract-level; evaluator logic pending (A03) |
| "Your workflow's own success webhook is a trigger, not proof" | `EvidenceOrigin: 'customer_claim'` is explicitly the weakest tier; `sourceEventSchema` only carries *expected* values, never asserted outcomes | Implemented at contract level |
| "We tell you when a run never started" | Only true in `coverage_mode: 'independently_sourced'` (`COVERAGE_MODE`, `rules.ts`); default is `'customer_triggered'`, which by definition cannot see a run that never fired | Conditional claim — must always be shown next to the workflow's actual coverage mode, never asserted globally |
| "We show our reasoning as a plain-language reason, not a black box" | `REASON_CODE` enum (`errors.ts`) — `MATCHED`, `VALUE_MISMATCH`, `RECORD_NOT_FOUND`, etc., each mapped to plain language by the UI | Contract-level; UI translation owned by A05 |
| "Evidence is kept for 30 days" | `LIMITS.EVIDENCE_RETENTION_DAYS = 30` (`rules.ts`) | Implemented as a constant; enforcement job is A02/A09 |
| "One workflow, 500 runs a month, £29" | `LIMITS.PLAN_RUNS_PER_PERIOD = 500`, `LIMITS.PLAN_PRICE_PENCE = 2900` (`rules.ts`) | Implemented as a constant |
| "We never modify your CRM or resend your emails" | No write scope requested anywhere in the frozen contract; `EvidenceSource` and `Evidence` types are read-only shapes; brief states this as a hard boundary | True by absence of any write path — keep it true by never adding one |
| "No customer-supplied URL is ever fetched by us" | Brief rule 8: "No customer-controlled URL is ever fetched. Provider hosts are a fixed allowlist." | Engineering rule, not yet independently testable from this repo snapshot — A02/A04 must enforce |
| "Your data is scoped to your workspace; nobody else can see it" | Brief rule 1: tenant scope is application-enforced, every query includes `workspace_id` | Engineering rule pending `apps/app/src/db/` (A02) — do not claim until enforced and tested |
| "We never let a model decide pass/fail or your bill" | Brief rule 9; `ASSISTANT_MODE` default is `'off'` (`status.ts`) | Contract-level; enforcement is A08's assistant boundary |
| "Card details never touch us" | Brief: Stripe hosted Checkout + Billing Portal | Architectural decision, not yet built (A07/billing) |
| **Negative claim:** "We do not detect a run that never started, unless coverage mode is independently_sourced" | See coverage-mode row above | Must ship as a standing caveat, not a footnote |
| **Negative claim:** "We do not verify any workflow shape other than enquiry → CRM record → acknowledgement email" | `workflowRulesSchema` has one `crm_correlation_property` and a bounded assertion set against exactly `CRM_FIELD`/`EMAIL_FIELD` — no other object type exists | True by absence |
| **Negative claim:** "We make no accuracy, uptime or security certification" | No such infrastructure exists in this repo; brief forbids the wording outright | Tone rule, keep enforcing it in copy review |
| **Cut:** "Real-time verification" / "instant results" | `DEFAULT_DEADLINE_SECONDS = 600`, up to `MAX_DEADLINE_SECONDS = 3600`; results depend on a one-minute cron poll of a due-job table, not a live push | No implementation — a result can legitimately take up to an hour to resolve |
| **Cut:** "Unlimited workflows" | v1 pricing model is one workflow per workspace (see §6) | Contradicts the frozen plan |
| **Cut:** "Works with any CRM / any email provider" | Only HubSpot and Resend connectors are planned for v1 (brief: "First connectors: HubSpot (CRM) and Resend (email)") | No other connector exists |
| **Cut:** "Guaranteed accuracy" / "certified secure" / "100% uptime" / income guarantees | Explicitly forbidden wording (tone rules) and nothing in the stack proves any of them | Never write these |
| **Cut:** "We tell you the automation is broken" | We report evidence status against your rules, not a diagnosis of *why* an automation failed — we have no visibility into the automation platform itself | Out of scope; the customer still has to go and fix their own workflow |

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
  (`RATE_LIMITED`, `PROVIDER_UNAVAILABLE`) can cause up to 3 extra calls *for that one
  observation*. In the true pathological case (every observation needs every retry) the
  ceiling is higher than 4,000; I'm treating the brief's 4,000 figure as the number to
  publish and design against, and flagging that retries are a further safety margin the
  system consumes, not creates.
- `MAX_CONCURRENT_CONNECTOR_REQUESTS_PER_WORKSPACE = 2` /
  `..._GLOBAL = 5` — these cap *simultaneous* requests, not the monthly total. They matter
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
  Resend's separate monthly *sending* allowance (a free account's own email-send quota) is
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

| Journey phase | Observable definition of "working" |
| --- | --- |
| Sign-up and workspace creation | A `workspace_admin` (owner) session exists; a workspace row exists scoped by `workspace_id` (brief rule 1) |
| Connect HubSpot | `ConnectionStatus` for the HubSpot connection reaches `'ready'` (`status.ts`); anything short of that (`'authorising'`, `'testing'`, `'degraded'`, `'expired'`, `'revoked'`, `'unsupported'`) is shown as not yet usable, in plain language |
| Connect Resend | Same connection lifecycle, `ConnectionStatus` reaches `'ready'` for the Resend connection |
| Define the workflow rules | A `WorkflowRules` object validates against `workflowRulesSchema` — a `crm_correlation_property` is set, at least one mandatory assertion exists, and the assertion count is within `MAX_ASSERTIONS_PER_WORKFLOW` (10) |
| Choose the plan and pay | An `OrderStatus` reaches `'active'` via Stripe Checkout (`status.ts`); `SubscriptionStatus` mirrors Stripe as `'active'` or `'trialing'`, never set by the browser |
| Send a signed event | A POST validates against `sourceEventSchema`, returns `eventAcceptedSchema` with a `run_id` and initial `status` of `'PENDING'` |
| Receive a result | The run's `RunStatus` moves from `'PENDING'` to one of `'VERIFIED'`, `'FAILED'`, `'UNVERIFIED'` within the workflow's `deadline_seconds`, each mandatory assertion carrying a `ReasonCode` the UI can render in plain language |
| Ongoing running | Successive signed events (distinct `event_id`s) each produce their own run; a duplicate `event_id` returns the existing run's result rather than creating a second one (idempotency, brief rule 4) |
| Cancel | `SubscriptionStatus` moves to `'canceled'` via the Stripe Billing Portal; no further runs are accepted once the workspace is off-plan |

## 8. Open items for other agents

- A03 (domain/evaluator): confirm the "2 provider calls per observation" assumption in §6,
  and confirm that "absence is UNVERIFIED, never VERIFIED" is enforced in the state
  machine, not just documented.
- A04 (connectors): confirm the actual HubSpot/Resend call shape per observation once
  built, so §6's split can be corrected if wrong.
- A05: `packages/ui/src/content/*` is written for you to import as-is (see handoff).
- The lead: no `plan/` document was found in this repository to check plan §37 against;
  flagging in case that's a repo gap rather than an intentional omission.
