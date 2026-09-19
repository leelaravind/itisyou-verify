# Connectors: what we read, what we never touch, and what we cannot prove

ITISYOU Verify connects to your systems to fetch evidence **independently** of the
automation being checked. This page is the honest version: the exact permission we ask
for, where to find it, every field we read, everything we refuse to do, and the things we
genuinely cannot tell you.

Owner: A04. Last verified against vendor documentation on **2026-09-19**. Every API fact
below carries the URL it came from, and every one of them was read on that date rather
than recalled.

---

## The rules every connector obeys

1. **We never write to your systems.** No create, no update, no delete, no merge, no
   archive. This is not a policy we promise to remember — there is no code path that could.
   Each connector can only issue requests from a frozen table of read operations
   (`HUBSPOT_OPERATIONS`, `RESEND_OPERATIONS`), and the request builder refuses anything
   not in it. HubSpot's table has three entries; Resend's has two.
2. **We never fetch a URL you gave us.** Provider hosts are a compile-time allowlist of
   exactly three: `api.hubapi.com`, `api.resend.com`, `api.stripe.com`. Private, loopback,
   link-local and cloud-metadata addresses are refused, as are IP literals, non-HTTPS
   schemes, non-443 ports and credentials embedded in a URL. Redirects are never followed
   automatically; each hop is re-checked against the same allowlist with a limit of three.
3. **"We could not reach the provider" is never reported as "it did not happen."** This is
   the single most important line in the codebase. See *Absence versus silence* below.
4. **Your token never appears in a log line, an error message or an exported report.**
   Every credential is registered with a redactor before any request is made, and anything
   that escapes the fetch layer is scrubbed.
5. **A record id your automation gave us is a locator, not a fact.** We always confirm
   which provider account the retrieved record actually belongs to, and we attach that
   account to the evidence. If it is not your connected account, the report says so.

---

## Absence versus silence

The evaluator may turn an unproven required check into **FAILED** at the deadline only
when a connector reported `NOT_FOUND` — meaning the provider answered, successfully, that
the thing does not exist. Everything else resolves to **UNVERIFIED**, which is "we could
not tell", not "your automation failed".

| What happened | Code we emit | What your report says |
| --- | --- | --- |
| A successful search matched zero records | `NOT_FOUND` | Can become FAILED at the deadline |
| HubSpot's documented object-not-found 404 for a known id | `NOT_FOUND` | Can become FAILED at the deadline |
| Request timed out | `PROVIDER_UNAVAILABLE` | UNVERIFIED |
| 429 rate limited | `RATE_LIMITED` | UNVERIFIED |
| 500/502/503/504 | `PROVIDER_UNAVAILABLE` | UNVERIFIED |
| 200 with an unparseable or error body | `PROVIDER_UNAVAILABLE` | UNVERIFIED |
| A 404 that is *not* the provider's documented not-found envelope | `PROVIDER_UNAVAILABLE` | UNVERIFIED |
| Search reported matches but returned none | `PROVIDER_UNAVAILABLE` | UNVERIFIED |
| Two or more records carry the same reference | `AMBIGUOUS_MATCH` | UNVERIFIED |
| Token rejected | `AUTH_EXPIRED` | UNVERIFIED, connection needs attention |
| Scope or permission missing | `PERMISSION_MISSING` | UNVERIFIED, connection needs attention |

`tests/integration/connectors/observation.test.ts` CONN-141 and CONN-142 hold this line:
the same workflow, the same deadline, the same missing record — an answering provider gives
FAILED, a silent one gives UNVERIFIED.

---

## HubSpot (CRM evidence)

### What you give us

One **private app access token**. It starts `pat-` (`pat-eu-` in the EU region).

- In HubSpot go to **Settings → Integrations → Private Apps**, create an app (or edit an
  existing one), tick the scope below, save, and copy the token.
- Documentation: <https://developers.hubspot.com/docs/guides/apps/private-apps/overview>

### The exact scope

**`crm.objects.contacts.read`** — and nothing else.

Source: <https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide>
(checked 2026-09-19).

We read the scopes your token actually carries at setup time and tell you immediately if
that one is missing, rather than failing silently during a run.

### Why a private app and not a "Connect with HubSpot" button

We deliberately did **not** build a public OAuth install flow for v1. A public app needs
HubSpot app-marketplace eligibility and review, and neither is verified for this product.
A private app token is the customer's own credential, scoped by them, revocable by them,
and it requires no approval from anyone. When a public app becomes worth building, this is
the decision to revisit.

### What we read

Only these properties, by name, never the whole contact record:

| Property | Why |
| --- | --- |
| `hs_object_id` | The record id, to reference the evidence |
| `email` | To check the record is about the right person |
| `createdate` | To tell "a record exists" from "a record was created for this enquiry" |
| your correlation property | To match the record to this specific enquiry |
| any property your rules name | Because you asked us to check it |

Capped at 25 properties. A contact record can hold a phone number, an address, a decade of
notes and a deal history; none of that is needed to answer "does this record exist and does
this field match", so we do not ask for it. That is a privacy control before it is a cost
control.

### Endpoints we call

| Purpose | Method and path |
| --- | --- |
| Confirm which portal the token belongs to | `POST /oauth/v2/private-apps/get/access-token-info`, body `{"tokenKey": "<token>"}`, returns `{userId, hubId, appId, scopes}` |
| Retrieve a contact by id | `GET /crm/v3/objects/contacts/{recordId}?properties=…&archived=false` |
| Find a contact by your correlation property | `POST /crm/v3/objects/contacts/search` |

Sources: the contacts guide above; the search API at
<https://developers.hubspot.com/docs/api-reference/legacy/crm/search-the-crm>; and, for the
EU-token detail that `pat-eu` tokens must also send the `Authorization` header,
<https://community.hubspot.com/t5/APIs-Integrations/Private-App-access-token-info-endpoint-error-for-EU-tokens/m-p/719418>.
All checked 2026-09-19.

The search request asks for a page of **two** results. Two is the whole answer: zero, one,
or "more than one". Asking for more would read records we have no business reading.

### API version and limits we confirmed

| Fact | Value | Source, checked 2026-09-19 |
| --- | --- | --- |
| API version | CRM **v3** (`/crm/v3/objects/contacts`) | [contacts guide](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide) |
| Private app rate limit, Free & Starter | 100 requests / 10 seconds per app | [usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines) |
| Private app rate limit, Professional & Enterprise | 190 requests / 10 seconds per app | same |
| With the API Limit Increase add-on | 250 requests / 10 seconds per app | same |
| Daily limit per account | 250,000 / 625,000 / 1,000,000 by tier | same |
| Search endpoint limit | **5 requests per second per account** | [search API](https://developers.hubspot.com/docs/api-reference/legacy/crm/search-the-crm) |
| Search page maximum | 200 per page, 10,000 results total | same |
| Rate-limit headers | `X-HubSpot-RateLimit-Max`, `-Remaining`, `-Interval-Milliseconds`, `-Daily`, `-Daily-Remaining` | usage guidelines |
| 429 body | `{"status":"error","message":…,"errorType":"RATE_LIMIT","correlationId":…,"policyName":…}` | usage guidelines |

**Where the documentation is ambiguous, and what we assumed:**

- HubSpot documents `Retry-After` for webhooks it calls, but **does not document a
  `Retry-After` header on its own 429 responses**. We read `Retry-After` when it is
  present, and otherwise fall back to `X-HubSpot-RateLimit-Interval-Milliseconds`, which is
  the provider telling us the length of the window we just exhausted. If neither is present
  we use the scheduler's own backoff.
- The usage guidelines note that **search responses carry no rate-limit headers at all**,
  so after a search 429 we have nothing to read and rely on backoff.
- HubSpot does not publish the portal id on a contact object. We therefore attribute a
  contact to the portal the *token* belongs to, established from
  `access-token-info`. This is sound — a token scoped to portal A cannot read portal B's
  records — but it means the attribution is about the credential, not the record.

### What we never touch

There is no create, update, delete, merge or archive path in this connector. Companies,
deals, tickets, notes, timeline events and files are never requested. We never write a
property, never enrol a contact in a workflow, and never change a lifecycle stage.

### What HubSpot evidence cannot prove

- A contact created and then deleted before we looked is indistinguishable from one that
  never existed.
- We cannot see a contact the private app has not been granted access to.
- Two contacts carrying the same enquiry reference produce `AMBIGUOUS_MATCH`. We refuse to
  pick one, because a guess that produced a VERIFIED would be a lie.
- We do not verify HubSpot webhooks in v1, so HubSpot evidence has exactly one origin:
  `provider_readback`.

### Disconnecting

HubSpot does **not** let an application revoke its own private app token. When you
disconnect we delete our copy and stop using it, and we tell you to delete the token
yourself in HubSpot. We do not claim to have revoked something we cannot revoke.

---

## Resend (email evidence)

### What you give us

1. A **Resend API key** (starts `re_`), and
2. a **webhook signing secret** (starts `whsec_`).

Both come from the Resend dashboard: API Keys, and Webhooks.

### The uncomfortable part: Resend has no read-only key

Resend's API key permissions are **`full_access`** ("Can create, delete, get, and update
any resource") or **`sending_access`** ("Can only send emails"). There is no third option.

Source: <https://resend.com/docs/api-reference/api-keys/create-api-key>, checked 2026-09-19.

Reading a message back therefore requires a `full_access` key, which is far broader than
reading needs — the same key could send mail and delete resources. **We ask for more power
than we use, because Resend offers nothing narrower.** We say so here rather than quietly
storing a more powerful key and letting the UI imply otherwise.

If you would rather not hand over a full-access key, you can run this connector on webhook
evidence alone: a signed `email.delivered` callback is independent evidence and needs no
API key at all. You lose the ability to re-check a message on demand, which means a run
whose webhook never arrived stays UNVERIFIED instead of being resolvable by a readback.
That trade is yours to make, and it is a real one.

### Webhook setup is manual, and we do not pretend otherwise

Resend's public API has no endpoint for creating a webhook endpoint. We cannot set it up
for you. `validateConnection` returns a guided setup step (A05 renders it) and the
connection stays **incomplete** until a correctly signed callback has arrived.

Subscribe the endpoint to: `email.sent`, `email.delivered`, `email.delivery_delayed`,
`email.bounced`, `email.complained`, `email.failed`.

Documentation: <https://resend.com/docs/dashboard/webhooks/introduction>

### Endpoints we call

| Purpose | Method and path |
| --- | --- |
| Retrieve one message | `GET /emails/{id}` |
| Liveness and permission probe at setup only | `GET /domains` |

Sources: <https://resend.com/docs/api-reference/emails/retrieve-email> and
<https://resend.com/docs/api-reference/domains/list-domains>, checked 2026-09-19.

`POST /emails` — the send endpoint — is not in the operations table, is not imported, and
cannot be constructed. This service never sends mail on your behalf.

### Signature verification

Resend signs with **Svix**. Confirmed 2026-09-19 against
<https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests> and
<https://docs.svix.com/receiving/verifying-payloads/how-manual>:

- Headers `svix-id`, `svix-timestamp`, `svix-signature`.
- Secret is `whsec_` + base64; the base64 part is decoded to raw key bytes.
- Signed content is `` `${id}.${timestamp}.${body}` `` where *body is the raw request
  bytes*.
- Signature is HMAC-SHA-256, base64, compared in constant time.
- The header holds space-delimited `v1,<signature>` entries; non-`v1` versions are ignored.
- Timestamp tolerance: **300 seconds** either side. Svix recommends a tolerance but does
  not publish a number; 300s is the value `@verify/security` already uses for Stripe and
  for our own scheme, so all three agree.

We verify against the **raw bytes**. Parsing the JSON and re-serialising it produces
different bytes, and a signature check over that would be checking a document Resend never
sent. Parsing happens only after verification succeeds.

A correctly signed message replayed by someone who captured it is still correctly signed.
Only the event-id ledger can tell a Resend retry from a replay, so the webhook route passes
us the ids it has already stored and we reject a repeat.

Implementation note for the lead: `verifySvixSignature` lives in `@verify/security`
(A02) and this connector **reuses it**. There is no duplicate implementation to reconcile.

### Event mapping

Confirmed against <https://resend.com/docs/dashboard/webhooks/event-types> and the
individual payload pages, 2026-09-19.

| Resend event | Our status | Meaning |
| --- | --- | --- |
| `email.sent` | `accepted` | Resend took the message. **Not delivery.** |
| `email.scheduled` | `queued` | Accepted for later sending |
| `email.delivered` | `delivered` | The receiving mail server took it. The only delivery-proving status. |
| `email.delivery_delayed` | `deferred` | Temporary problem, not yet a contradiction |
| `email.bounced` | `bounced` | Permanently rejected — contradicts delivery |
| `email.complained` | `complained` | Marked as spam — contradicts delivery |
| `email.failed` | `failed` | Never sent — contradicts delivery |
| `email.suppressed` | `failed` | Resend refused to send it; the recipient never saw it |
| `email.opened` | `opened` | A tracking pixel loaded. Proves nothing about a person. |
| `email.clicked` | `clicked` | A tracked link was followed. Proves nothing about a person. |
| anything else | *no status* | Recorded as an unsupported-event gap. Never silently `delivered`. |

`email.received` (inbound mail) and the `domain.*`, `contact.*` and `suppression.*`
families are outside this ladder on purpose: they are not outbound-delivery evidence, and
forcing them onto it would invent a fact.

### API version and limits we confirmed

| Fact | Value | Source, checked 2026-09-19 |
| --- | --- | --- |
| Base URL | `https://api.resend.com` | [API reference](https://resend.com/docs/api-reference/introduction) |
| Auth | `Authorization: Bearer re_…` | same |
| Rate limit | **10 requests per second per team** (default) | same |
| Missing `User-Agent` | error `1010`, HTTP 403 | same |
| Error codes | `missing_api_key` 401, `restricted_api_key` 401/403, `invalid_permission` 403, `not_found` 404, `rate_limit_exceeded` 429, `application_error` 500, `service_unavailable` 503 | [errors](https://resend.com/docs/api-reference/errors) |

Resend does not version its API in the path; there is no version string to record beyond
the documentation date above.

**Where the documentation is ambiguous, and what we assumed:**

- Resend does not document rate-limit response headers, only the 429 status. We read
  `Retry-After` if it is sent and otherwise back off.
- The documented message for a 404 is "The requested endpoint does not exist", which is
  about routing rather than about a missing record. Our `GET /emails/{id}` path is
  compiled in and covered by tests, so a 404 on that call can only be about the id, and we
  treat it as an authoritative absence. **Residual risk:** if Resend ever retired or moved
  that endpoint, its 404 would read to us as "no such message". The mitigation is that a
  connector-level contract test would fail first.
- Resend does not report a key's permission level back to us; we learn it only by being
  refused. We therefore report an empty granted-scope list rather than guess.

### What Resend evidence cannot prove

- **Resend publishes no team or account identifier**, so there is no provider-sourced
  account id to attach to evidence. We attach a stable fingerprint of the API key the
  evidence was read with. That is real and checkable — swap the key and the fingerprint
  changes — but it is weaker than HubSpot's portal id, and
  `capabilities().can_prove_account_identity` is `false` to say so.
- **A retrieved message tells us its latest status but not when that status was reached.**
  `GET /emails/{id}` returns `last_event` and `created_at`, and `created_at` is when the
  message was created, not when it was delivered. Readback evidence therefore carries the
  send time as its `occurred_at`. **Only a signed webhook carries the event's own instant**,
  so a rule of the form "delivered within N seconds" is genuinely answerable only from
  webhook evidence. If your workflow has such a rule, get the webhook working.
- We can only look up a message whose Resend id your automation told us. A message we were
  never told about is invisible to us.
- Opens and clicks are never treated as proof anyone read anything.

### Disconnecting

Resend does not let a key delete itself. We delete our copy and tell you to remove the key
in the Resend dashboard.

---

## Stripe

`api.stripe.com` is on the outbound allowlist because billing uses it. There is **no
Stripe evidence connector** — Stripe is not a source of verification evidence in v1, and
`getConnector` only accepts `hubspot` and `resend`.

---

## The coverage limit you should know about

**We check the runs we are told about.** In the default `customer_triggered` coverage mode,
your automation tells us an enquiry happened and we then verify, independently, whether the
CRM record and the acknowledgement really exist. That is a real check: the evidence comes
from the provider, not from your automation's own claim of success.

What it cannot catch is a run that **never started**. If your automation silently stops
firing altogether, there is no trigger, so there is no run for us to check, so there is
nothing to report. A gap in the reports is the only symptom.

Detecting that requires `independently_sourced` coverage mode, where we look for the
expected activity ourselves rather than waiting to be told. Until your workflow is
configured that way, treat the absence of failures as evidence that the runs we saw were
fine — not as evidence that every run happened.

---

## Budget: how many provider calls one run can cause

Bounded and provable. One run gets at most `MAX_OBSERVATIONS_PER_RUN` observations, and
each observation gets at most `MAX_TRANSIENT_RETRIES_PER_OBSERVATION` transport retries.
Retries never buy an extra observation, so the ceiling is
`MAX_OBSERVATIONS_PER_RUN × (1 + MAX_TRANSIENT_RETRIES_PER_OBSERVATION)` = **16 external
calls per run**, per evidence source.

Every retry decision in the connectors goes through A03's `planNextRetry`. There is no
private retry loop anywhere in `packages/connectors` — that is what keeps the ceiling true
rather than aspirational.

One caveat worth stating: when a connection's account id has never been established (setup
never completed) or when connection health explicitly asks for re-verification, HubSpot
spends **one additional call** on `access-token-info` before the read. On the normal path,
with a completed connection, that call is not made.

---

## Tests

`tests/unit/connectors/` and `tests/integration/connectors/`, case ids `CONN-001` onwards.
Every one of them stubs `fetch`. No test in this repository has ever contacted HubSpot or
Resend, and `tests/setup.ts` fails the suite loudly if one tries.
