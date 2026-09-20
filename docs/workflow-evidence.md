# Workflow evidence — the three outcomes, produced against a deployment

`docs/deployed-evidence.md` recorded one VERIFIED run and two that were correctly not
verified. It could not record a FAILED one, because none had ever happened outside a test,
and it recorded HubSpot as "credential stored and validated — **no live readback
demonstrated**". This document closes both gaps and opens a smaller one in their place.

Every line below came from a request to a running deployment or from a query against the
staging database afterwards. Nothing here is inferred from a test, and where something is
an inference rather than an observation it says so in the sentence that makes the claim.

**Environment:** staging (`verify-itisyou-staging.kpleelaaravind.workers.dev`) ·
**Worker version:** `432f4500-4f98-413c-9f5e-7f11e2af8a1e`, uploaded 2026-09-20T06:05:37Z ·
**Recorded:** 20 September 2026, 06:32–06:51Z

Recipient addresses and provider record identifiers are withheld throughout, or shown in
the masked form the product itself stores.

---

## Which commit this is evidence about

The deployment does not report a commit. `wrangler versions view` returns a version id, a
timestamp, an author and a handler list, and no build metadata of any kind, so the mapping
from version to commit has to be made from timestamps and is an inference rather than an
observation:

|                                            |                                        |
| ------------------------------------------ | -------------------------------------- |
| Worker version serving every request below | `432f4500-4f98-413c-9f5e-7f11e2af8a1e` |
| Uploaded                                   | 2026-09-20T06:05:37.404Z               |
| Last commit before that upload             | `9649ecb`, 2026-09-20T06:00:44Z        |
| First commit after it                      | `e0aa820`, 2026-09-20T06:16:20Z        |

So the evidence belongs to `9649ecb` if the deploy was made from a clean tree at HEAD, and
to nothing nameable if it was not. The version id is the only identifier that is certainly
correct, and it is the one to quote. It was confirmed rather than assumed: `wrangler tail`
stamps `scriptVersion.id` on every request it reports, and it reported
`432f4500-4f98-413c-9f5e-7f11e2af8a1e` for the requests below.

`git rev-parse HEAD` is recorded here for completeness and is close to useless for this
purpose: the working tree is shared, and HEAD moved four times while this was being
written — `08786a7` at 05:55Z, `47873e9` at 06:30Z, `d4fc79f` at 06:50Z, `121214d` at
06:53Z. A document that names a commit it read from a moving HEAD is naming the moment it
looked, not the code that answered.

---

## How a run is admitted and driven, established from the code rather than assumed

1. **Admission is `POST /api/v1/events` and nothing else.** The route is
   `apps/app/src/money/eventsRoute.ts`. It checks, in order: size, signature, the frozen
   envelope schema, that the payload's workflow matches the credential's, `occurred_at`
   freshness, **then** entitlement, and only then writes the run. Every one of those steps
   was exercised below.
2. **There is no other door.** `sourceEvents.admitOnce` is the only writer of `runs`, and
   the only caller outside tests is this route. The onboarding "proof run" step is not
   wired to anything (`customerPort.ts` returns `ran: false` with a written reason), and
   the owner's `verification.retry` is denied to the automation identity by construction —
   `AUTOMATION_CAPABILITIES` in `owner/access.ts` holds three capabilities and that is not
   one of them.
3. **The scheduler is cron only.** `handleScheduled` has exactly one caller, the Worker's
   `scheduled()` handler. Staging runs it every five minutes. There is no HTTP endpoint
   that forces a tick — `/api/v1/runner/*` is the owner's maintenance runner, authenticated
   by a device signature, and it cannot drive verification. Every wait below is therefore a
   real wait for a real cron tick.
4. **The workspace was already set up.** `scripts/seed-automation-identity.mjs --env staging`
   exists and was used, with `SEED_WORKFLOW_ADMIN=1`, to mint the scoped `workspace_admin`
   session these forms were driven with. It is the repository's own script and it writes a
   real `sessions` row; nothing was relaxed to let it in.

### What was driven through the product, and what was not

Everything below went through the product's own paths. No `runs`, `assertions`, `evidence`
or `workflow_versions` row was hand-written.

| Step                                                  | Path used                                     |
| ----------------------------------------------------- | --------------------------------------------- |
| Configure the correlation property                    | `POST /app/onboarding/mapping`                |
| Configure which checks are required, and the deadline | `POST /app/onboarding/outcome`                |
| Issue/rotate the event-signing key                    | `POST /app/onboarding/activation/signing-key` |
| Submit an enquiry                                     | `POST /api/v1/events`, signed                 |
| Reach a verdict                                       | the staging cron, unassisted                  |
| Read the result back                                  | `/app/runs/{id}`, and the database            |

One thing was **not** available as a product path and was not faked: there is no way to
send an acknowledgement email from here. `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` are
present but empty in `.dev.vars`; the real values exist only as Worker secrets and as
AES-GCM envelopes in `credential_versions`. So the acknowledgement these runs assert about
is the one the earlier proof run genuinely sent on 19 September, named again by id. The
message is real, the delivery is real and the read-back below is fresh — but the send is
yesterday's, and saying otherwise would be inventing the one part of the chain that could
not be re-run.

---

## (a) Correctly matched evidence → VERIFIED

**`run_01M2YRDJFB4442E1A140C14608`** · admitted 06:35:22Z · decided 06:35:39Z · one
observation · rules version 6 — `email_delivered` and `email_recipient_matches`, both
mandatory, deadline 60 s.

| Rule                      | Mandatory | Status        | Reason  | Expected                      | Observed         |
| ------------------------- | --------- | ------------- | ------- | ----------------------------- | ---------------- |
| `email_delivered`         | yes       | **SUPPORTED** | MATCHED | one of: delivered             | delivered        |
| `email_recipient_matches` | yes       | **SUPPORTED** | MATCHED | the address the enquiry named | the same address |

Evidence, three rows, all `provider: resend`:

| Evidence          | Origin                  | Observed at          | What it is                                                                                       |
| ----------------- | ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `evd_01M2YREK4M…` | **`provider_readback`** | 2026-09-20T06:35:39Z | `GET /emails/{id}` made by the scheduler during this observation. Both assertions cite this row. |
| `evd_d1ef0595…`   | `provider_webhook`      | 2026-09-19T21:56:15Z | A callback parked in `evidence_inbox` on 19 September, claimed by this run.                      |
| `evd_c8b301cb…`   | `provider_webhook`      | 2026-09-19T21:56:15Z | The second of the pair.                                                                          |

The stored summary masks the recipient (`d**@…`), as it did before.

**The inbox claim worked, and this is the first time it has been observed working.** Two
callbacks arrived on 19 September 1.4 seconds _before_ the run that was waiting for them
existed, were parked `unmatched`, and sat unclaimed for nine hours because no run had ever
named their message id. This run did, and `claimInboxForRun` claimed both at 06:35:39Z and
stamped `claimed_run_id` on each.

**But the claim did not contribute to the verdict, and that is worth stating plainly.**
`gatherEvidence` builds the `EvidenceBundle` the evaluator sees entirely from connector
fetches. Rows already in the `evidence` table — including ones this run just claimed — are
never read back into it. The comment above the claim says a failed read-back "still has
whatever the provider already told us rather than nothing at all", and that is true of the
record and false of the verdict. Here it cost nothing because the read-back succeeded. See
the finding at the end, where it cost a verdict.

---

## (b) Wrong evidence → FAILED

Two distinct routes to a failure were driven, because they fail for different reasons and
only one of them had ever been possible.

### (b1) The right message, delivered to the wrong address

**`run_01M2YRJG8F570B2FDEE98D44F2`** · admitted 06:38:04Z · decided 06:40:39Z · rules
version 6.

The event named the same real acknowledgement message as (a), and named a different
recipient — a `.test` address that belongs to nobody.

| Rule                      | Status           | Reason             | Expected                    | Observed                                 |
| ------------------------- | ---------------- | ------------------ | --------------------------- | ---------------------------------------- |
| `email_delivered`         | SUPPORTED        | MATCHED            | one of: delivered           | delivered                                |
| `email_recipient_matches` | **CONTRADICTED** | **VALUE_MISMATCH** | the address the event named | the address the message actually went to |

Verdict **FAILED**, from one `provider_readback` row. Note the shape: the delivery check
passed. An acknowledgement that was definitely delivered, to definitely the wrong person,
is a failure and not a pass, and no majority of passing checks changes it — `decide.ts`
answers FAILED on the first contradicted mandatory assertion before it counts anything.

### (b2) A CRM correlation reference no record carries

**`run_01M2YS2Z45DE24EF1E8F2B41B0`** · admitted 06:47:03Z · decided 06:50:39Z · rules
version 9 — `crm_record_exists` and `crm_correlation_matches`, both mandatory, no email
checks, deadline 60 s.

| Rule                      | Status  | Reason               | Expected                 | Observed   |
| ------------------------- | ------- | -------------------- | ------------------------ | ---------- |
| `crm_record_exists`       | UNKNOWN | **RECORD_NOT_FOUND** | present                  | no reading |
| `crm_correlation_matches` | UNKNOWN | **RECORD_NOT_FOUND** | this enquiry's reference | no reading |

Verdict **FAILED**.

This is the one that needs its mechanism spelled out, because "unknown" becoming "failed"
is the single most dangerous transition in the product. It is permitted only when the
connector _asked the provider and the provider answered that there is nothing there_:
`RECORD_NOT_FOUND` and `EVENT_NOT_OBSERVED` are the entire contents of
`AUTHORITATIVE_ABSENCE_REASONS`, the deadline had passed, and `hasWorkingEvidenceAccess`
was true because the only gap held was `NOT_FOUND` — a working connection reporting an
absence. A timeout, a 500, a rate limit or a permission problem would each have produced a
different gap code, kept `hasWorkingEvidenceAccess` false, and resolved this run UNVERIFIED.

**This is a real HubSpot read.** `RECORD_NOT_FOUND` is reachable only from a 2xx search
response that returned no rows — `makeAuthoritativeAbsenceGap` refuses to build it from any
other status — so a request left the Worker, reached `api.hubapi.com`, and was answered.
That a call is made at all was also observed directly on an adjacent tick; see the next
section.

---

## (c) Missing evidence → UNVERIFIED, never a pass and never a silent failure

**`run_01M2YRBQ9EF21A5E60E4F74B39`** · admitted 06:34:21Z · decided 06:35:39Z · rules
version 6.

The event carried `expected.email_recipient` and deliberately **no**
`expected.email_message_id`, which is the documented configuration mistake: without it
nothing binds a delivery to this enquiry, because two enquiries from one customer share an
address.

| Rule                      | Status  | Reason                | Expected                      | Observed |
| ------------------------- | ------- | --------------------- | ----------------------------- | -------- |
| `email_delivered`         | UNKNOWN | EVIDENCE_NOT_RETURNED | one of: delivered             | —        |
| `email_recipient_matches` | UNKNOWN | EVIDENCE_NOT_RETURNED | the address the enquiry named | —        |

Verdict **UNVERIFIED**. `EVIDENCE_NOT_RETURNED` is not in `AUTHORITATIVE_ABSENCE_REASONS`,
so the deadline passing could not convert it to a failure. Two further runs resolved the
same way for a different reason —
`run_01M2YRJH8N286AE8080ED644D4` and `run_01M2YRVZ6WB60AB07772144B93`, both
`CONNECTION_UNAVAILABLE` on both CRM checks — and
`run_01M2YR89VX1AA290798B7C4AD9` resolved UNVERIFIED holding both reasons at once, two
email checks `EVIDENCE_NOT_RETURNED` and two CRM checks `CONNECTION_UNAVAILABLE`.

The customer-facing report for one of these was read back from `/app/runs/{id}` and says,
in its own words:

> We could not reach the connected system, so this check is unverified rather than failed.
> We are not saying your automation went wrong; we are saying we could not look.

and, on the verdict:

> We could not get enough evidence to say either way. This is not a failure — it means we
> could not look, or what we could see was not conclusive.

Neither the status nor the page rounds the gap up to a pass or down to a fault.

---

## HubSpot: read-back demonstrated, evidence still never produced

The two are different claims and the distinction is the point of this section.

**What is now demonstrated.** The scheduler made a real, authenticated,
credential-resolved call to `api.hubapi.com` from the deployed Worker, using the customer's
stored connection — portal `…1406`, scopes `oauth` and `crm.objects.contacts.read` — and
HubSpot answered. A tick carrying exactly one run reported `calls_made: 1`, which
distinguishes a call that was made from a credential that never resolved: the zero-call
paths (`not_connected`, `connection_not_ready`, `no_credential`) report `calls_made: 0`.

**What is still not demonstrated.** HubSpot has produced **zero rows in the `evidence`
table**, on 19 September and today alike. A read-back only becomes evidence when a record
comes back, and no record has. Connected is not proven, a call is not evidence, and the
count that matters is still nought.

### The configured correlation property does not exist in the portal

Two runs, four minutes apart, same connection, same credential, same rules, differing in
one field:

| Run                              | `crm_correlation_property` | Reason on both CRM checks | Verdict    |
| -------------------------------- | -------------------------- | ------------------------- | ---------- |
| `run_01M2YRVZ6WB60AB07772144B93` | `itisyou_verify_ref`       | `CONNECTION_UNAVAILABLE`  | UNVERIFIED |
| `run_01M2YS2Z45DE24EF1E8F2B41B0` | `firstname`                | `RECORD_NOT_FOUND`        | **FAILED** |

The credential works, the scope is sufficient and contact search is permitted — the
`firstname` run proves all three, because a successful search that returns no rows is the
only thing that produces `RECORD_NOT_FOUND`. Therefore the `itisyou_verify_ref` refusal is
the property, not the connection: HubSpot answered with a client error, the connector
classified it `UNSUPPORTED_CAPABILITY`, and `mapGapToReason` folds that into
`CONNECTION_UNAVAILABLE`.

**Precisely what cannot be said:** which status code it was. The connector distinguishes
400/422 (`UNSUPPORTED_CAPABILITY`) from 403 (`PERMISSION_MISSING`) from 401
(`AUTH_EXPIRED`) and all three arrive at the same stored `reason_code`. The gap's `detail`
string is built, used to pick a schedule, and then discarded; nothing writes it to
`run_attempts`, to `assertions` or to a log line. So the classification above is read off a
controlled comparison rather than off the response, and "the portal has no
`itisyou_verify_ref` property" is the explanation that fits — not a fact anybody here
observed.

**What would be needed** to finish this: the property `itisyou_verify_ref` created on the
contact object in portal `…1406`, and one contact carrying a known value in it. Neither can
be done from this side — the connector's frozen operation table has three entries, all
reads, and there is no code path in this product that can create either. Then a run whose
`correlation_id` is that value would produce the first HubSpot `provider_readback` evidence
row this product has ever held.

### Was any of this a fixture?

No, and the reasoning is not "we did not mock anything":

- `PRODUCTION_CONNECTORS` constructs each connector with no options, so `fetchImpl` is
  undefined and `guardedFetch` uses the runtime's own `fetch`. The only mechanism in the
  codebase for substituting a connector's HTTP layer is that parameter, and nothing outside
  tests passes it.
- `transport` would say so directly — it is `'live'` exactly when `fetchImpl` is undefined —
  except that **`transport` is not persisted**. The `evidence` table has no such column and
  `recordEvidence` drops the field before the insert. It survives only inside
  `content_digest`, which cannot be queried for it. So the provenance argument above is made
  from the wiring, not from the row, and that is weaker than it should be. See the findings.
- The synthetic paths cannot reach a connector: `/demo` touches no database,
  `SyntheticCustomerDataPort` is overridden at mount, and `NOT_CONNECTED_RESOLVER` — which
  is what a deployment without `CREDENTIAL_KEY_V1` gets — guarantees _no_ call rather than a
  fake one.

Every outcome in the repository's test suite is the opposite: `VERIFY-227`/`231` (wrong
recipient, wrong correlation → FAILED), `CONN-061`/`CONN-141` (zero-result search →
`NOT_FOUND` → FAILED at the deadline) and the whole UNVERIFIED family run against stubbed
`fetchImpl` routers or fake connector objects. `CONN-900` and `CONN-901` are the only
provider-backed cases in `docs/test-cases.json`, both `skipped`, and `docs/test-plan.md`
says so: "Until `CONN-900`/`901` run, every claim about reading records back is designed,
not observed." That sentence is now half wrong — the Resend half is observed, and so is the
HubSpot _call_ — and the tests that would prove it in CI still have not run.

---

## Refusals, all against the same deployment

| Case                                            | Result                         |
| ----------------------------------------------- | ------------------------------ |
| Unsigned event                                  | 401 `SIGNATURE_INVALID`        |
| Valid key id, wrong secret                      | 401 `SIGNATURE_INVALID`        |
| Correctly signed, naming another workflow       | 403 `WORKFLOW_MISMATCH`        |
| Correctly signed, `occurred_at` an hour old     | 422 `EVENT_STALE`              |
| Correctly signed, everything in order           | 202, a run id, `PENDING`       |
| Form post without the double-submit token       | 403, "That did not go through" |
| Form post with the token and no `Origin` header | 403 — both halves are required |

At 06:06:38Z the same correctly-signed event was refused **402 `NO_SUBSCRIPTION`**, because
the staging `subscriptions` table was empty at that moment. That refusal is worth keeping
rather than deleting, for two reasons. It proves the entitlement gate sits where the file
says it does — after the signature, the schema, the workflow match and the freshness window,
all four of which that request had already passed. And it dates the evidence: a subscription
appeared between 06:06Z and 06:31Z, from work happening elsewhere on the same deployment,
and every run above is on the far side of it.

No billing row was written to produce any of this. An attempt to seed one was made and
refused, and the refusal was accepted rather than worked around.

---

## Findings

1. **Evidence already attached to a run does not reach the evaluator.**
   `gatherEvidence` builds the bundle from connector fetches only. `run_01M2XR5GQ9…` is the
   live demonstration: it holds two `provider_webhook` rows, one of them `delivered`, bound
   to it by message id on 19 September — and both of its mandatory assertions are UNKNOWN
   with `EVIDENCE_NOT_RETURNED`, and its verdict is UNVERIFIED. The delivery proof was in
   the same database, on the same run, and the verdict did not see it. It fails in the safe
   direction, which is why it has gone unnoticed.
2. **`docs/deployed-evidence.md` is wrong about why those two runs were unverified.** It
   says "Neither named `expected.email_message_id`, so no delivery evidence could be bound
   to either." Evidence _is_ bound to `run_01M2XR5GQ9…`, and the only writer of those rows
   requires an exact `expected.email_message_id` match, so that run must have named one.
   The 33% figure stands; the explanation under it does not.
3. **`transport` is computed and thrown away.** The contract in
   `packages/contracts/src/evidence.ts` argues at length that recording live-versus-simulated
   separately from `origin` is what keeps the independence claim from being an intention.
   `http.ts` computes it correctly. The `evidence` table has no column for it and
   `recordEvidence` drops it, so no stored row can be audited for provenance after the fact.
   Webhook evidence is never stamped at all.
4. **A gap's `detail` never survives.** The difference between "your token lacks a scope",
   "that property does not exist" and "your token has expired" is present in the connector,
   used to choose a schedule, and then discarded — all three land as `CONNECTION_UNAVAILABLE`
   with nothing written anywhere. Working out which one had happened took a controlled
   experiment against a live portal. A support conversation would need the same experiment.
5. **The deployment cannot say which commit it is.** Every claim tying evidence to a commit
   is currently an inference from two timestamps.
6. **The onboarding deadline choices are 60, 300, 600, 1800 and 3600 seconds.** The workflow
   these runs belong to was seeded at 900, which the form cannot express, so restoring the
   original configuration through the product was not possible. It was restored to 1800 with
   its original correlation property, and that is a deliberate, disclosed difference from the
   state found at the start.

## What this document does not claim

- **Production has not been touched.** Nothing here was run against
  `4c95be5b-e37d-450f-84f8-fd6c9d9406f5`, and no deploy was made.
- **No acknowledgement email was sent by this work.** The message these runs read back was
  sent on 19 September. The read-backs are fresh; the send is not.
- **HubSpot has produced no evidence row.** A call was made and answered. That is a weaker
  claim than evidence and is deliberately not dressed up as one.
- **The failure class in (b2) is one of four HTTP statuses, not a known one.** See finding 4.
- **Eight runs is not a sample.** It is one of each outcome, plus the controls needed to
  attribute them.

---

# Second pass — the CRM ledger

The owner corrected two claims in the section above and both corrections are accepted.
**HubSpot has never supported a verdict**: the VERIFIED run was carried entirely by a Resend
read-back. And **`RECORD_NOT_FOUND` is not correlation-mismatch detection**: it proves we
notice a record is _absent_, which is a different capability from noticing a record that
_exists_ and belongs to a different enquiry. Only the second is a mismatch. This ledger
keeps them apart.

Same deployment as above (`432f4500-4f98-413c-9f5e-7f11e2af8a1e`), same product paths, same
redaction rules.

|       | Claim                                                                   | Run                              | Verdict                                                               |
| ----- | ----------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| **A** | A matching CRM record supports verification                             | —                                | **not yet proven** — awaiting the portal setup                        |
| **B** | A retrieved record carrying another enquiry's reference is CONTRADICTED | —                                | **not yet proven** — expressible, and needs one more input; see below |
| **C** | A CRM that does not answer stays UNKNOWN → UNVERIFIED, never a mismatch | `run_01M2YT605AA5897F63C1C44F76` | **proven**                                                            |

## C. Unavailable is not mismatched — proven

`run_01M2YT605AA5897F63C1C44F76` · admitted 2026-09-20T07:06:11Z · deadline 07:07:11Z ·
decided **07:10:39Z, three and a half minutes after the deadline** · rules: `crm_record_exists`
and `crm_correlation_matches`, both mandatory, no email checks.

The correlation property was set to a name the portal does not define, so HubSpot answered
the search with a client error rather than a record or an absence.

| Assertion id                     | Rule                      | Status  | Reason                   | Observed | Evidence |
| -------------------------------- | ------------------------- | ------- | ------------------------ | -------- | -------- |
| `asr_01M2YTE8061D54028CF1E949B0` | `crm_correlation_matches` | UNKNOWN | `CONNECTION_UNAVAILABLE` | none     | none     |
| `asr_01M2YTE8066711518F77A64D4C` | `crm_record_exists`       | UNKNOWN | `CONNECTION_UNAVAILABLE` | none     | none     |

Verdict **UNVERIFIED**. The deadline had passed and the run still did not fail, because
`CONNECTION_UNAVAILABLE` is not an authoritative absence; it is never reported as a mismatch,
and no evidence row was written. The customer-facing text says "we could not look", not "your
record was wrong".

## B. What a correlation contradiction needs — expressible, one input missing

The rule shape can express it. `crm_correlation_matches` is `field: record.correlation_id`,
`operator: equals`, `expected_from: source_event.correlation_id`
(`apps/app/src/db/ruleCompiler.ts:133-141`), and a retrieved record whose correlation value
differs yields CONTRADICTED / VALUE_MISMATCH — the same path `VERIFY-231` covers.

The missing input is **a contact record id**, not a second property. The connector's locator
priority is get-by-id first, search second, with no fallback between them
(`packages/connectors/src/hubspot.ts:883-895`). A _search_ can only ever return records whose
correlation value already equals the one searched for, so the search path can produce SUPPORTED
or `RECORD_NOT_FOUND` and **can never produce a mismatch**. Retrieving a record that belongs to
another enquiry requires the event to carry `expected.crm_record_id`
(`packages/contracts/src/events.ts:34`), which routes to `readContactById`
(`hubspot.ts:505-519`); that call requests the correlation property explicitly through
`selectProperties` (`hubspot.ts:303-321`), so the retrieved record carries a comparable value.

So to prove B: an event whose `correlation_id` is enquiry **X** and whose
`expected.crm_record_id` is the HubSpot id of the contact carrying enquiry **Y**. No connector
change, no new operator, no new scope and no write.

## Why the earlier `RECORD_NOT_FOUND` run reached FAILED

Asked specifically, answered specifically. Run `run_01M2YS2Z45DE24EF1E8F2B41B0`, decided
2026-09-20T06:50:39Z against deadline 06:48:03Z. Its two mandatory assertions:

| Assertion id                     | Rule                      | Status  | Reason             |
| -------------------------------- | ------------------------- | ------- | ------------------ |
| `asr_01M2YS9M762529816FDE4F4CFE` | `crm_correlation_matches` | UNKNOWN | `RECORD_NOT_FOUND` |
| `asr_01M2YS9M7674A851B2EE944CF9` | `crm_record_exists`       | UNKNOWN | `RECORD_NOT_FOUND` |

Both UNKNOWN, and the run FAILED. The chain, in order, with the line that does each step
(read at commit `121214d`; the deployment was built from an earlier one, and these files did
not change between them):

1. **HubSpot answered 2xx with an empty result set.**
   `packages/connectors/src/hubspot.ts:672-683` — `results.length === 0` and `total === 0`
   returns `kind: 'absent'`. A self-contradicting `total > 0` is refused as
   `PROVIDER_UNAVAILABLE` two lines above, so an absence is never inferred from a confusing
   answer.
2. **The absence is only allowed to be authoritative if the status proves it.**
   `packages/connectors/src/types.ts:394-408` — `makeAuthoritativeAbsenceGap` refuses any
   non-2xx status, downgrading it to `PROVIDER_UNAVAILABLE`, and otherwise emits gap code
   `NOT_FOUND`.
3. **`NOT_FOUND` on a CRM source becomes the reason code `RECORD_NOT_FOUND`.**
   `packages/domain/src/evaluate.ts:450-454`.
4. **The constant that permits the transition.**
   `packages/domain/src/evaluate.ts:100-103` —
   `AUTHORITATIVE_ABSENCE_REASONS = { 'RECORD_NOT_FOUND', 'EVENT_NOT_OBSERVED' }`, read
   through `isAuthoritativeAbsence` at `evaluate.ts:105-107`. Those two members are the whole
   policy; nothing else in the system can turn a mandatory unknown into a failure.
5. **Evidence access had to be healthy.**
   `apps/app/src/scheduler/observe.ts:828-830` — `hasWorkingEvidenceAccess` is true only when
   every gap held is `NOT_FOUND`. A working connection reporting an absence qualifies; a
   timeout, a 403 or a 400 does not, which is exactly why run C above did not fail.
6. **The code path that applies it.**
   `packages/domain/src/decide.ts:128-129`, reached only after the earlier branches have ruled
   out a contradiction (`:89`), a full pass (`:95`), and "still inside the window with budget
   left" (`:105`):

   ```ts
   if (unresolved.length > 0 && unresolved.every((r) => isAuthoritativeAbsence(r.reason_code))) {
     return { status: 'FAILED', reason: DECISION_REASON.FAILED_ABSENT };
   }
   ```

   `every`, not `some`: one ordinary unknown alongside the absences would have sent the run to
   `UNVERIFIED_INCOMPLETE` on the next line. It was called with `deadlineAt` and
   `hasWorkingEvidenceAccess` from `observe.ts:359-362`.

**What that verdict means, stated as narrowly as it deserves:** the connected CRM was asked
whether any contact carried this enquiry's reference, answered successfully that none did, and
the deadline for one to appear had passed. It is a proven absence. It is not a proven mismatch,
and the section above should not have been read as one.

## A and B — run against portal `…1406`, 2026-09-20T07:20:39Z

Setup done by the lead through the owner's authenticated HubSpot session: contact property
`itisyou_verify_ref` (single-line text, contact object) and one synthetic contact carrying
`ENQ-MATCH-0001`. **That contact is a fabricated record with no data subject** — the address
on it is in the IANA-reserved `example.com` domain and is undeliverable. It is not a person and
must not later be read as one. The application connector was not changed: still three frozen
read operations, no write path, no extra scope.

Both runs used rules version `crm_record_exists` + `crm_correlation_matches`, both mandatory,
deadline 60 s, correlation property `itisyou_verify_ref`. Record ids are shown masked.

### A. A matching CRM record supports verification — **proven**

`run_01M2YTSKKM2DC653F9BA114937` · admitted 07:16:54Z · decided 07:20:39Z · one observation ·
located by search on `itisyou_verify_ref EQ ENQ-MATCH-0001`, no record id supplied.

| Assertion id                     | Rule                      | Status        | Reason  | Expected         | Observed         |
| -------------------------------- | ------------------------- | ------------- | ------- | ---------------- | ---------------- |
| `asr_01M2YV0JA1F53A4070A4524C52` | `crm_record_exists`       | **SUPPORTED** | MATCHED | present          | record `…6976`   |
| `asr_01M2YV0JA1C7A7E24C46944ADA` | `crm_correlation_matches` | **SUPPORTED** | MATCHED | `ENQ-MATCH-0001` | `ENQ-MATCH-0001` |

Verdict **VERIFIED**.

| Evidence                         | Provider      | Origin                  | Observed at          | Cited by        |
| -------------------------------- | ------------- | ----------------------- | -------------------- | --------------- |
| `evd_01M2YV0J4V8DE1619E3F41482C` | **`hubspot`** | **`provider_readback`** | 2026-09-20T07:20:39Z | both assertions |

**This is the first HubSpot evidence row this product has ever held, and the first verdict
HubSpot has ever supported.** Every earlier VERIFIED run was carried by Resend alone. The
`evidence` table went from zero HubSpot rows to two in one tick.

### B. A record belonging to another enquiry is contradicted — **proven**

`run_01M2YTSKRX1960E7D29C38477E` · admitted 07:16:54Z · decided 07:20:39Z · one observation ·
enquiry reference `ENQ-OTHER-9999`, `expected.crm_record_id` naming record `…6976`, so the
connector took the read-by-id path and retrieved the contact that belongs to
`ENQ-MATCH-0001`.

| Assertion id                     | Rule                      | Status           | Reason             | Expected         | Observed         |
| -------------------------------- | ------------------------- | ---------------- | ------------------ | ---------------- | ---------------- |
| `asr_01M2YV0MTAD13A5E40334A4714` | `crm_record_exists`       | SUPPORTED        | MATCHED            | present          | record `…6976`   |
| `asr_01M2YV0MTAF9859DD0456D48F3` | `crm_correlation_matches` | **CONTRADICTED** | **VALUE_MISMATCH** | `ENQ-OTHER-9999` | `ENQ-MATCH-0001` |

Verdict **FAILED**.

| Evidence                         | Provider      | Origin                  | Observed at          | Cited by        |
| -------------------------------- | ------------- | ----------------------- | -------------------- | --------------- |
| `evd_01M2YV0MN4FB9D3EA8136243BB` | **`hubspot`** | **`provider_readback`** | 2026-09-20T07:20:39Z | both assertions |

This is the distinction the owner asked for, and it now has two separate runs behind it:

|                             | Record retrieved? | Reason             | Verdict                | What it proves                                                  |
| --------------------------- | ----------------- | ------------------ | ---------------------- | --------------------------------------------------------------- |
| `run_01M2YS2Z45…` (earlier) | no                | `RECORD_NOT_FOUND` | FAILED at the deadline | we notice a record is **absent**                                |
| `run_01M2YTSKRX…` (B)       | **yes**           | `VALUE_MISMATCH`   | FAILED immediately     | we notice a retrieved record belongs to a **different enquiry** |

B failed on contradiction, not on absence, and not at a deadline — `decide.ts:89` answers
FAILED on the first contradicted mandatory assertion before any deadline or absence logic is
consulted. The other mandatory check passed at the same time, which is the point: a majority of
passing checks does not rescue a contradicted one.

Both evidence rows carry the same `content_digest`. That is correct and worth noting: one
record, retrieved twice by two different locator paths, normalises to the same evidence.

### The ledger, closed

|       | Claim                                                                   | Run                              | Verdict                                            |
| ----- | ----------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| **A** | A matching CRM record supports verification                             | `run_01M2YTSKKM2DC653F9BA114937` | **proven** — VERIFIED, HubSpot `provider_readback` |
| **B** | A retrieved record carrying another enquiry's reference is contradicted | `run_01M2YTSKRX1960E7D29C38477E` | **proven** — CONTRADICTED / VALUE_MISMATCH         |
| **C** | A CRM that does not answer stays UNKNOWN → UNVERIFIED, never a mismatch | `run_01M2YT605AA5897F63C1C44F76` | **proven** — UNVERIFIED past the deadline          |

Corrections to the first pass, now that A has run: "HubSpot record readback is unproven" and
"no live readback demonstrated" in `docs/deployed-evidence.md` are both out of date, and the
line in `docs/test-plan.md` saying every read-back claim is "designed, not observed" is now
false for both providers on staging. `CONN-900` still has not run in CI, so that remains true
of the test suite.

**Still not claimed.** Nothing was run against production. The connector remains read-only and
was not touched. `transport` is still computed and not persisted, so these two rows cannot be
audited for live-versus-simulated after the fact — the argument that they are live rests on
the wiring and on the fact that a fabricated portal record answered with a value nothing in
this repository knows.
