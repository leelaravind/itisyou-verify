# Security acceptance — the launch gate

**Owner:** A10 (security), independent of the implementing agents.
**Read by:** the lead, before any deployment that can be reached by a customer or can take
money.

| Pass            | Date                     | What existed                                                                                                                  |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1               | 2026-09-19 (morning)     | Contracts, schema, A02's security primitives and data layer                                                                   |
| 2               | 2026-09-19 (afternoon)   | The assembled system, deployed at https://verify.itisyou.app                                                                  |
| **3 — current** | **2026-09-19 (evening)** | **The release candidate: real authentication, the mounted webhook path, the three D1 ports, the owner panel's real controls** |

## The two gates, and why they are different

The founder needs one question answered before taking a customer's money and a different,
much smaller question answered before leaving a marketing site on the internet. Conflating
them either blocks a harmless public site for months or ships a commerce system on the
strength of "the home page looks fine".

- **Gate A — COMMERCE.** Everything that must hold before a real card is charged, a real
  credential is stored, or a real customer's data enters the system. **One row is not
  passing: A-20.** Do not take money until it does.
- **Gate B — PUBLIC SITE.** Everything that must hold for a public site with no customer
  data and nothing for sale. **This gate is passing, and the site is already live.** I
  verified it by fetching it, not by reading the source.

A row in Gate A that is red does not mean the site should come down. A row in Gate B that
is red means it should.

## Commands, and what they actually returned

```
npx vitest run tests/security          → 245 cases: 243 pass, 2 FAIL
npx tsc -p tsconfig.json --noEmit      → 0 errors
node scripts/scan-secrets.mjs           → clean. 416 tracked files.
node scripts/scan-secrets.mjs --history → FAILS: synthetic fixtures in already-committed
                                          blobs. See F16.
```

Findings close fast in this project because agents fix them mid-review. The numbers above
are the end state; the worst states are recorded in the re-run table at the bottom so the
account stays honest. Pass two peaked at `221: 217 pass, 4 FAIL`; pass three opened at
`226: 220 pass, 6 FAIL` with three of A10's own checks red against `apps/app/src/lib/auth.ts`.

The whole suite now runs under `pnpm test` — the root `vitest.config.ts` includes
`tests/security/**/*.test.ts`. Pass one's SEC-ACC-01 is closed.

---

## Gate A — blocking before this service takes money

| #        | Check                                                                                                                                            | Test ID                         | Result (pass 2)                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-01** | An unknown webhook endpoint id cannot inject a forged provider event, **even when the fallback key is known**.                                   | `SEC-431`                       | **PASS.** Was a reproduced CRITICAL (status 200) at 10:35; A06 fixed it at 10:51. `SEC-431` is now a permanent regression test that injects the fallback key.                                                               |
| **A-02** | No cryptographic constant used in a comparison is a literal in this public repository.                                                           | `SEC-432`                       | **PASS.** The fallback key is now derived per deployment.                                                                                                                                                                   |
| **A-03** | Stripe signatures verify over raw bytes, before any parse; bad signature is 400, never 200.                                                      | `SEC-434`, `SEC-435`, `SEC-436` | **PASS.** Verified against the real Hono route.                                                                                                                                                                             |
| **A-04** | The webhook never reveals _why_ it refused, and never echoes the signing secret.                                                                 | `SEC-437`, `SEC-441`            | **PASS.**                                                                                                                                                                                                                   |
| **A-05** | An unknown endpoint and a wrong secret are indistinguishable to the caller.                                                                      | `SEC-433`                       | **PASS**, and it survived A-01's fix — which was the point of asserting it separately.                                                                                                                                      |
| **A-06** | A signature minted for one endpoint is not accepted at another.                                                                                  | `SEC-442`                       | **PASS.**                                                                                                                                                                                                                   |
| **A-07** | A test-mode event delivered to a live endpoint is refused.                                                                                       | `SEC-439`                       | **PASS.**                                                                                                                                                                                                                   |
| **A-08** | A duplicate provider event id produces no second effect.                                                                                         | `SEC-440`                       | **PASS.** Behavioural, over the real route. Closes pass one's SEC-ACC-12.                                                                                                                                                   |
| **A-09** | An oversized body is refused before it is read or parsed.                                                                                        | `SEC-438`                       | **PASS.**                                                                                                                                                                                                                   |
| **A-10** | `openCredential` cannot be called without an expected AAD.                                                                                       | `AUTH-114`                      | **PASS.** Pass-one finding F1 closed by A02.                                                                                                                                                                                |
| **A-11** | A ciphertext sealed for workspace A does not open in B's context, even holding the key.                                                          | `SEC-502`, `AUTH-103`           | **PASS.**                                                                                                                                                                                                                   |
| **A-12** | `key_version` is bound inside the AAD.                                                                                                           | `AUTH-115`                      | **PASS.** Pass-one F5 closed.                                                                                                                                                                                               |
| **A-13** | Every query on a customer-scoped table names `workspace_id` or is marked exempt.                                                                 | `SEC-202`, `SEC-204`            | **PASS.** Pass-one F2 closed — A02/A09 added the markers during this pass.                                                                                                                                                  |
| **A-14** | The same, judged on the **predicate** rather than the column list.                                                                               | `SEC-206`                       | **PASS.** Was FAIL, with 4 statements scoped only by their SELECT list; A02/A09 added per-statement markers during this pass.                                                                                               |
| **A-15** | No SQL fragment is accepted as a function parameter.                                                                                             | `SEC-203`                       | **PASS.** Pass-one F3 closed.                                                                                                                                                                                               |
| **A-16** | No customer-facing page can name a tenant: no `CustomerDataPort` method takes a workspace id.                                                    | `AUTH-402`, `AUTH-403`          | **PASS.** A05's design survived contact with the call sites.                                                                                                                                                                |
| **A-17** | `getCaseForOwner` is the only by-id-without-workspace support read, and it says so.                                                              | `AUTH-410`, `AUTH-411`          | **PASS.**                                                                                                                                                                                                                   |
| **A-18** | No Stripe identifier is accepted from a browser; the checkout-session reverse lookup is reachable only from the signature-verified webhook path. | `AUTH-420`, `AUTH-421`          | **PASS.** Closes pass one's SEC-ACC-24.                                                                                                                                                                                     |
| **A-19** | An approval binds budget + audience + creative + destination + duration + currency + action type; one penny changes the hash.                    | `SEC-301`–`SEC-318`, `SEC-722`  | **PASS.**                                                                                                                                                                                                                   |
| **A-20** | An approval is consumed exactly once, atomically, before money moves.                                                                            | `AUTH-511`                      | **FAIL — the one remaining Gate A blocker.** The `consumed` state is unreachable: nothing in the application ever writes it. Finding F17.                                                                                   |
| **A-21** | A new session id is issued and the old row revoked on every privilege transition.                                                                | `AUTH-501`–`AUTH-505`           | **PASS.** Verified behaviourally against real SQLite, not against the brief: `rotate()` is one atomic batch, both statements carry the identical liveness guard, a dead session mints nothing, and a planted id is revoked. |
| **A-22** | An approval refuses a consumed, revoked, expired or altered payload, and treats the approved amount as a ceiling.                                | `AUTH-510`, `AUTH-513`          | **PASS.**                                                                                                                                                                                                                   |
| **A-23** | The refund path cannot be entered without a recorded approval — no default, no "auto", no id-only variant.                                       | `AUTH-512`                      | **PASS.**                                                                                                                                                                                                                   |
| **A-24** | `credential_versions.owner_scope` is constrained at the database, and the AAD must carry the key version.                                        | `SEC-641`                       | **PASS.** A02 shipped `migrations/0002_credential_scope_check.sql` during this pass.                                                                                                                                        |

**Gate A verdict: DO NOT TAKE MONEY — one row, and it is narrow.** Everything else on this
gate now passes, most of it verified behaviourally rather than structurally. The single
blocker is **A-20**: an approval is checked and then acted on, with nothing in between
claiming it, so the `consumed` state the schema defines is never reached.

To be precise about the exposure, because it is smaller than "approval reuse" sounds:
`refunds.idempotency_key` is `NOT NULL UNIQUE` and the approval's payload hash binds to one
specific refund, so a replayed approval can only re-submit the **same** refund, which
reaches Stripe under the same idempotency key and is deduplicated there. What is actually
missing is a single-use control that is single-use, and an audit fact — today every
approval stays `granted` forever, so the record cannot answer "was this one used?".

It is still a blocker, because the fix is four lines and the control is the one standing
between an owner's click and money leaving. See F17.

---

## Gate B — blocking for a public site with nothing for sale

This gate was assessed against **the deployed site**, by fetching it on 2026-09-19.

| #        | Check                                                                                                             | Evidence                                                                                                                                                                                                                                                                                | Result                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-01** | No customer data is reachable.                                                                                    | `GET /app` renders a workspace built by `SyntheticCustomerDataPort`, banner "This workspace is showing synthetic data", ids `run_syn_*`, email masked `o**@example.test`.                                                                                                               | **PASS**                                                                                                                                                                                                                                                       |
| **B-02** | Nothing is purchasable.                                                                                           | `POST /app/onboarding/checkout` → **503**, no stack trace, no secret, no Stripe redirect. `billingPortalLink()` returns null with an honest reason.                                                                                                                                     | **PASS**                                                                                                                                                                                                                                                       |
| **B-03** | Synthetic data can never be mistaken for real data.                                                               | `SEC-210`, `SEC-211`, `SEC-212`                                                                                                                                                                                                                                                         | **PASS**                                                                                                                                                                                                                                                       |
| **B-04** | An unauthenticated request to an owner route is an ordinary 404.                                                  | `GET /owner`, `/owner/dashboard` → **404**, identical to `/debug` and `/.well-known/x`.                                                                                                                                                                                                 | **PASS**                                                                                                                                                                                                                                                       |
| **B-05** | The owner capability model cannot be widened by a flag.                                                           | `AUTH-301`–`AUTH-312`                                                                                                                                                                                                                                                                   | **PASS**                                                                                                                                                                                                                                                       |
| **B-06** | The scoped automation identity cannot activate ads, refund, move budget or self-promote.                          | `AUTH-310`, `AUTH-311`, `AUTH-312`                                                                                                                                                                                                                                                      | **PASS.** The denials are structural — the capability is absent from the set.                                                                                                                                                                                  |
| **B-07** | Consequential owner actions require recent strong auth; a future-dated timestamp is not freshness.                | `AUTH-320`–`AUTH-323`                                                                                                                                                                                                                                                                   | **PASS**                                                                                                                                                                                                                                                       |
| **B-08** | No source map, no debug endpoint, no source file is served.                                                       | `/index.js.map`, `/assets/app.js.map`, `/src/index.ts`, `/debug` → all **404**.                                                                                                                                                                                                         | **PASS**                                                                                                                                                                                                                                                       |
| **B-09** | A strict CSP with no `unsafe-inline`.                                                                             | Live header: `default-src 'none'`; `script-src` and `style-src` by SHA-256 hash; `script-src-attr 'none'`; `base-uri 'none'`; `frame-ancestors 'none'`.                                                                                                                                 | **PASS.** Better than pass one asked for.                                                                                                                                                                                                                      |
| **B-10** | Transport and framing headers.                                                                                    | Live: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` denying camera/mic/geo/payment. | **PASS**                                                                                                                                                                                                                                                       |
| **B-11** | No private response can enter a shared cache.                                                                     | Live: `/app`, `/app/runs`, `/owner` all `Cache-Control: no-store`; `Vary: Cookie` present site-wide.                                                                                                                                                                                    | **PASS.** Closes pass one's SEC-ACC-25.                                                                                                                                                                                                                        |
| **B-12** | Escaping on every field that round-trips to HTML.                                                                 | `SEC-1210`–`SEC-1213` against A05's shipped `packages/ui`.                                                                                                                                                                                                                              | **PASS**                                                                                                                                                                                                                                                       |
| **B-13** | A link target cannot carry a `javascript:` scheme, through the guard, through `attrs()`, or through a component.  | `SEC-1214`, `SEC-1216`–`SEC-1219`                                                                                                                                                                                                                                                       | **PASS.** F15 closed by A05. Verified independently, not accepted: `SEC-1218` runs A10's own 22-value adversarial corpus through both implementations and fails on any disagreement; `SEC-1219` proves they are byte-identical once escaping is accounted for. |
| **B-14** | CSV exports neutralise formula leaders, with the apostrophe inside the quotes.                                    | `SEC-1201`–`SEC-1205`                                                                                                                                                                                                                                                                   | **PASS.** A09's claim verified, not accepted: byte-identical to the reference across 23 corpus values. Closes pass one's SEC-ACC-18.                                                                                                                           |
| **B-15** | The assistant has no tool that can write a status, entitlement, refund, role or budget.                           | `SEC-701`, `SEC-702`, `SEC-703`                                                                                                                                                                                                                                                         | **PASS**                                                                                                                                                                                                                                                       |
| **B-16** | Injected instructions in ingested text fire no tool; proposals are refused outright on an untrusted turn.         | `SEC-710`–`SEC-714`                                                                                                                                                                                                                                                                     | **PASS.** The refusal precedes the permission check, which is the right order.                                                                                                                                                                                 |
| **B-17** | A model cannot mint an approval: the hash is over the server's payload.                                           | `SEC-720`, `SEC-721`, `SEC-722`                                                                                                                                                                                                                                                         | **PASS.** A model-written summary is not part of the binding.                                                                                                                                                                                                  |
| **B-18** | Every outbound URL passes the SSRF guard.                                                                         | `SEC-001`–`SEC-022`, `SEC-602`, `SEC-603`                                                                                                                                                                                                                                               | **PASS.** A04 adopted the reference verbatim and tightened it (`allowSubdomains: false`, three hosts).                                                                                                                                                         |
| **B-19** | CI holds no deployment secret, never uses `pull_request_target`, pins `contents: read` and every action to a SHA. | `SEC-620`–`SEC-623`                                                                                                                                                                                                                                                                     | **PASS**                                                                                                                                                                                                                                                       |
| **B-20** | The tracked working tree contains no secret.                                                                      | `SEC-631`, `SEC-633`, `SEC-634`                                                                                                                                                                                                                                                         | **PASS.** `scan:secrets — clean. 377 tracked files.` Closes pass one's SEC-ACC-27 — the lead fixed the fixture and taught the scanner to honour a marker on the preceding line.                                                                                |
| **B-22** | The **full-history** scan that CI runs on every pull request is clean.                                            | `SEC-632`, `SEC-635`                                                                                                                                                                                                                                                                    | **FAIL.** 7 hits, every one a synthetic fixture in an already-committed blob. Finding F16. Does not block Gate B — nothing real is exposed — but it makes CI permanently red, which is how the control gets deleted.                                           |
| **B-21** | `tsc --noEmit` is clean.                                                                                          | —                                                                                                                                                                                                                                                                                       | **1 error**, in A07's in-flight `routes/owner/index.ts` (`'pairing' is declared but never read`). Not a security defect and not mine.                                                                                                                          |

**Gate B verdict: PASS.** The live site is safe to leave up. B-13 is the only red row and
it is doubly mitigated; it is carried into Gate A.

---

## Findings raised in this pass

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Severity     | Owner   | Test                 | Live?                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **F13** | **Any unknown webhook endpoint id accepted a forged event.** The route fell back to a hardcoded `DECOY_SECRET` when `resolveEndpointSecret` returned null, then acted on the result if the signature verified. The repository is public, so the constant was not a secret: sign a body with it, POST to `/api/v1/webhooks/stripe/<invented-id>`, and a fabricated `checkout.session.completed` or `invoice.paid` reached the real handler. Reproduced: **expected 400, got 200.** | **CRITICAL** | A06     | `SEC-431`, `SEC-432` | **CLOSED** 10:51. Never live — the route was not mounted. The fix fails closed on the lookup and derives the fallback per deployment. |
| **F14** | 4 statements satisfied the tenant-scope check only because `workspace_id` appeared in their SELECT column list, not their predicate. All 4 were correct cross-tenant sweeps; none was declared.                                                                                                                                                                                                                                                                                   | **Medium**   | A02/A09 | `SEC-206`            | **CLOSED.** Per-statement markers added.                                                                                              |
| **F15** | `packages/ui` interpolates `href` with no scheme guard, so `javascript:` survives intact. Mitigated twice today (every href is a literal; the CSP blocks it) and live the moment a link target comes from a CRM value, a report link or a campaign destination.                                                                                                                                                                                                                   | **Medium**   | A05     | `SEC-1214`           | **OPEN**                                                                                                                              |
| **F16** | **`scan-secrets --history` is permanently red on committed synthetic fixtures** — 7 hits across 5 files and 4 agents, including 2 from A10's own earlier revision. None is a real credential. `secret-scan:allow` cannot fix it: a committed blob is immutable. CI runs this on every pull request, so every PR is red, and the obvious "fix" is to delete the step — removing the one control that catches a credential committed and then deleted.                              | **Medium**   | lead    | `SEC-632`            | **OPEN**                                                                                                                              |

### F13, and why `SEC-431` now tests something stronger

A06's fix is the right one: verification still runs for an unknown id, so `SEC-433`
(indistinguishability) keeps passing, but the rejection is made on the **lookup result**,
never on the comparison — and the fallback key is derived per deployment rather than
published.

`SEC-431` was rewritten to match. It no longer greps the source for a published constant;
it **injects** the fallback key and signs the forged body with it. The property asserted
is therefore permanent and stronger than the original finding: the opaque path id is a
gate in its own right, and an attacker who learns the fallback key by any means still
gets a 400.

---

### The fix for F17, written out

Make consumption the act that authorises, in one statement, and use its row count as the
permission:

```sql
UPDATE approvals SET status = 'consumed', consumed_at = ?
 WHERE id = ? AND status = 'granted' AND expires_at > ?
```

`meta.changes === 1` is then the authorisation; a loser gets zero rows and stops. That
turns check-then-act into compare-and-set, which is exactly what `revokeApproval` already
does correctly one function above in the same file — the pattern is in the codebase, it
just was not applied here.

Sequencing matters: consume **before** calling Stripe, not after. If the provider call
fails, the approval is spent and the owner grants a new one — which is the safe direction.
Consuming afterwards means a crash between the charge and the update leaves an approval
that can be spent again.

---

## The link-guard divergences A05 raised — adjudicated

A05 built the scheme guard against A10's reviewed semantics rather than inventing a third
variant, and enumerated three places where the two implementations differ. All three were
put to A10 to decide. Verified independently first: `SEC-1218` runs A10's own corpus — 22
values including NUL, TAB, LF and DEL smuggled into `javascript:`, `data:`, `vbscript:`,
`file:`, `blob:`, protocol-relative, fragment and empty forms — through **both**
implementations and fails on any disagreement. There is none.

**1. A05 returns the target unescaped. CONFIRMED — A05 is right.**
`attrs()` escapes exactly once at the point that writes the attribute. Escaping in the
guard as well would double-encode every query string (`?a=1&b=2` → `&amp;amp;`). The guard
decides and normalises; the writer escapes. A10's reference keeps escaping because it is a
self-contained "produce an attribute value" helper with no writer behind it — a different
position in the pipeline, not a disagreement. `SEC-1219` asserts they are byte-identical
once `escapeHtml` is applied to A05's output, so neither can drift.

**2. A same-document `#fragment` is preserved rather than resolved. CONFIRMED — and folded
back into the reference.** A05 and the lead are both right. Resolving `#main` against the
production origin rewrites every in-page anchor and breaks it in local development, on
staging and in the demo. A fragment carries no scheme and cannot be a script URL, so
accepting it widens the set of _relative forms preserved_, not the scheme allowlist.
`tests/security/helpers/html.ts` now does the same, and `#main` and `#javascript:alert(1)`
are both in the `SEC-1218` corpus so the agreement is proven rather than assumed.

**3. A protocol-relative `//evil.example/x` is not refused. CONFIRMED — and it should stay
that way.** The lead's reasoning is correct: this is destination policy, not a scheme
guard, and the two belong in different places. Refusing off-site links inside a function
named `safeHref` would silently break every legitimate outbound link and teach callers
that the guard is unpredictable. One addition, which A05 already implemented: the rendered
target must be **absolute**, so a reviewer reading the HTML sees `https://evil.example/x`
rather than something that looks same-origin. Off-site _policy_ belongs with
`isExternalHref` and `rel="noopener noreferrer"`, which A05 has. If a future feature lets a
customer supply a link target, that is when a destination allowlist is needed — and it is a
second control, not a change to this one.

---

## On the lead's change to `SQL_KEYWORD` — agreed, with one addition

The lead tightened the detector to require an uppercase verb **and** a clause, because the
case-insensitive version flagged A06's payment-recovery notice ("you can update your card",
mentioning "runs" and "evidence") as an unscoped query, and added `SEC-205` to fail the
build on any lowercase SQL verb in the data layer.

**That reasoning is right and I would not change it.** A detector that cries wolf on
English gets muted, and muted is worse than absent because it looks like coverage. The
compensating control is the correct one: tightening to uppercase opens a loophole, and
`SEC-205` closes it rather than leaving it open and hoping. The measurement — 121
statements detected before and after, across 285 literals — is the right way to justify a
change to a security check, and I have copied the method in `SEC-206`.

`blankComments` preserving byte offsets, so `isExempt` can still find a marker that lives
in a comment, is a genuine improvement on my `stripComments`, which would have silently
broken every exemption.

My one addition is `SEC-206`, above: I measured it the same way (576 literals, 221
SQL-shaped, 108 touching customer tables) and it is **additive**, in its own file, so the
lead's measured baseline for `SEC-202` stays valid.

---

## Accepted, documented risks

Each is a real gap we are choosing to carry, and saying so.

| #        | Risk                                                                                                                                                                                                                                                                                                                                                                                                    | Why acceptable now                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What changes it                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **R-01** | **DNS rebinding** cannot be mitigated on Workers — `fetch` does not expose resolved addresses. `SEC-018` tests the logic for a future runtime.                                                                                                                                                                                                                                                          | The allowlist is three fixed provider hostnames we control, never assembled from customer input, so an attacker cannot introduce a name whose DNS they own.                                                                                                                                                                                                                                                                                                                    | Any feature letting a customer supply a hostname. It must not ship on this runtime.                              |
| **R-02** | **AAD does not survive full key + full row compromise** — an attacker holding both replays the row's own AAD.                                                                                                                                                                                                                                                                                           | AAD is a tenant-confusion control and is described as one. The key lives only in Worker secrets.                                                                                                                                                                                                                                                                                                                                                                               | A KMS or per-tenant key wrapping.                                                                                |
| **R-03** | **No penetration test, no bug bounty, no formal incident response, no certification.**                                                                                                                                                                                                                                                                                                                  | `SECURITY.md` says so publicly. Claiming otherwise would be the worst thing in the repository.                                                                                                                                                                                                                                                                                                                                                                                 | Revenue or a contract that requires one.                                                                         |
| **R-04** | **Timing side channels are not eliminated** — JavaScript on a shared runtime cannot be constant-time.                                                                                                                                                                                                                                                                                                   | `timingSafeEqual` removes early exits. The realistic oracle is a differing status or message, and the webhook route already collapses all refusals to one answer.                                                                                                                                                                                                                                                                                                              | Nothing practical on this runtime.                                                                               |
| **R-05** | **The secret scanner is pattern-based** and would miss an unprefixed or base64'd credential.                                                                                                                                                                                                                                                                                                            | A safety net, not the gate. It covers every provider we use and the full history.                                                                                                                                                                                                                                                                                                                                                                                              | A provider whose key has no recognisable shape.                                                                  |
| **R-06** | **Sign-in enumeration is unproven.** No behavioural test yet asserts that a registered and an unregistered address get the same body, status and timing.                                                                                                                                                                                                                                                | No real sign-in exists yet; `/app` is synthetic.                                                                                                                                                                                                                                                                                                                                                                                                                               | A02's session wiring. This becomes a Gate A row the day it lands.                                                |
| **R-07** | **`/app` is a public demo workspace.** Anyone can read it.                                                                                                                                                                                                                                                                                                                                              | It is synthetic by construction, banner-marked on every page, and has nothing to buy. Verified live.                                                                                                                                                                                                                                                                                                                                                                           | A real port behind `/app` without the 401 gate (`SEC-213`) still holding.                                        |
| **R-10** | **`credential_versions.owner_scope` still allows an intra-regime collision.** A02's `0002` migration constrains the column to `connection:?*` or `user:?*`, which closes the cross-regime half of T-TEN-03. It does not stop `user:usr_abc:recovery` being produced by both `totpScope('usr_abc:recovery')` and `recoveryScope('usr_abc')` — a string CHECK cannot; a `scope_kind` discriminator would. | **A10's adjudication: do not hold the release.** The residual is `countRecoveryCodes` returning a wrong figure, and it requires a user id containing a colon. Two independent mitigations, both now asserted by tests: `newId` emits Crockford base32 with no colon (`SEC-643`), and TOTP and recovery material carry different AAD purposes so nothing cross-decrypts (`SEC-644`). `SEC-642` pins that the collision is real at the string level so this cannot be forgotten. | An id sourced from an external system rather than `newId`. `SEC-643` is where to start if that is ever proposed. |
| **R-08** | **`wrangler.jsonc` contains D1 database ids.**                                                                                                                                                                                                                                                                                                                                                          | Not credentials; access needs a Cloudflare API token; Wrangler requires them.                                                                                                                                                                                                                                                                                                                                                                                                  | Nothing.                                                                                                         |
| **R-09** | **`audit_events` is an ordinary table** with no tamper-evidence or retention guarantee.                                                                                                                                                                                                                                                                                                                 | `SECURITY.md` already says ordinary application logs are not immutable, and the product makes no forensic claim.                                                                                                                                                                                                                                                                                                                                                               | Any marketing copy that claims otherwise. That claim must not be made.                                           |

---

## Re-run record

| Date                        | Who                    | `tsc`                        | `npx vitest run tests/security` | `scan-secrets --history`                             | Gate A                      | Gate B   |
| --------------------------- | ---------------------- | ---------------------------- | ------------------------------- | ---------------------------------------------------- | --------------------------- | -------- |
| 2026-09-19 09:35            | A10 pass 1             | 0 errors                     | 156: 150 pass, 6 fail           | 1 hit (A02 fixture)                                  | —                           | —        |
| 2026-09-19 10:35            | A10 pass 2 (mid)       | 1 error (A07, in flight)     | 221: 217 pass, 4 fail           | clean, 362 files                                     | FAIL                        | PASS     |
| 2026-09-19 11:05            | A10 pass 2 (final)     | 0 errors                     | 226: 224 pass, 2 fail           | tree clean, 377 files; `--history` 7 hits (F16)      | FAIL (A-20, A-21, F15, F16) | PASS     |
| 2026-09-19 (eve)            | A10 pass 3 (open)      | 7 errors (A05/A07 in flight) | 226: 220 pass, 6 fail           | tree 2 hits (A11 artifact)                           | FAIL                        | PASS     |
| **2026-09-19 (eve, final)** | **A10 pass 3 (final)** | **0 errors**                 | **245: 243 pass, 2 fail**       | tree **clean, 416 files**; `--history` **red (F16)** | **FAIL** (A-20 only)        | **PASS** |
|                             |                        |                              |                                 |                                                      |                             |          |

**The two remaining failures:**

```
AUTH-511  an approval is never consumed                        F17, blocks Gate A, A07+A06
SEC-632   --history red on committed synthetic fixtures        F16, Medium, lead
```

**Do not make either green by weakening the test.**

F17 is four lines of SQL, written out above. It is the only thing on Gate A that is still
red, and it guards the path where money leaves.

F16 is not fixed by dropping `--history` from CI and not by loosening the
`stripe-webhook-secret` rule, which is the rule that would catch the real thing. It is
fixed by (1) not shaping fixtures like real secrets — Stripe treats the endpoint secret as
an opaque ASCII string and Svix needs only valid base64 after the prefix, so no test needs
a literal `whsec_` prefix, and `SEC-633` enforces that going forward — and (2) a small
committed allowlist of blob SHAs for what is already in history. A SHA is a precise,
auditable exemption in a way a pattern is not.

## What changed in pass three, in one paragraph

Three of A10's own checks (`SEC-201`, `SEC-202`, `SEC-206`) went red against
`apps/app/src/lib/auth.ts` when real authentication landed, which is the checks working:
raw SQL on a customer-scoped table appeared outside the data layer and was caught within
the hour. A02 moved it and added the markers, and shipped a migration constraining
`owner_scope` and requiring the key version inside the AAD — closing pass-one finding F5 at
the database rather than by convention. A05 built the link guard and A10 verified it
independently rather than accepting it. A-21 went from ABSENT to proven behaviourally
against real SQLite. The gate moved from five red rows to one.
