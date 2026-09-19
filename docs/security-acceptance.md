# Security acceptance — the launch gate

**Owner:** A10 (security), independent of the implementing agents.
**Read by:** the lead, before any deployment that can be reached by a customer or can take
money.

| Pass | Date | What existed |
| --- | --- | --- |
| 1 | 2026-09-19 (morning) | Contracts, schema, A02's security primitives and data layer |
| **2 — current** | **2026-09-19 (afternoon)** | **The assembled system, deployed at https://verify.itisyou.app** |

## The two gates, and why they are different

The founder needs one question answered before taking a customer's money and a different,
much smaller question answered before leaving a marketing site on the internet. Conflating
them either blocks a harmless public site for months or ships a commerce system on the
strength of "the home page looks fine".

- **Gate A — COMMERCE.** Everything that must hold before a real card is charged, a real
  credential is stored, or a real customer's data enters the system. **Three things are
  not passing: A-20, A-21 and F15.** Do not take money.
- **Gate B — PUBLIC SITE.** Everything that must hold for a public site with no customer
  data and nothing for sale. **This gate is passing, and the site is already live.** I
  verified it by fetching it, not by reading the source.

A row in Gate A that is red does not mean the site should come down. A row in Gate B that
is red means it should.

## Commands, and what they actually returned

```
npx vitest run tests/security          → 221 cases: 220 pass, 1 FAIL   (the one finding still open)
npx tsc -p tsconfig.json --noEmit      → 0 errors
node scripts/scan-secrets.mjs --history → clean. 377 tracked files, full history.
```

Three findings were raised in this pass. A06 and A02/A09 closed two of them while the
review was still running, so the numbers above are the end state, not the worst state.
The middle of the pass looked like this, and it is recorded because it is the honest
account of what was found:

```
221 cases: 217 pass, 4 FAIL   SEC-431, SEC-432, SEC-206, SEC-1214
```

The whole suite now runs under `pnpm test` — the root `vitest.config.ts` includes
`tests/security/**/*.test.ts`. Pass one's SEC-ACC-01 is closed.

---

## Gate A — blocking before this service takes money

| # | Check | Test ID | Result (pass 2) |
| --- | --- | --- | --- |
| **A-01** | An unknown webhook endpoint id cannot inject a forged provider event, **even when the fallback key is known**. | `SEC-431` | **PASS.** Was a reproduced CRITICAL (status 200) at 10:35; A06 fixed it at 10:51. `SEC-431` is now a permanent regression test that injects the fallback key. |
| **A-02** | No cryptographic constant used in a comparison is a literal in this public repository. | `SEC-432` | **PASS.** The fallback key is now derived per deployment. |
| **A-03** | Stripe signatures verify over raw bytes, before any parse; bad signature is 400, never 200. | `SEC-434`, `SEC-435`, `SEC-436` | **PASS.** Verified against the real Hono route. |
| **A-04** | The webhook never reveals *why* it refused, and never echoes the signing secret. | `SEC-437`, `SEC-441` | **PASS.** |
| **A-05** | An unknown endpoint and a wrong secret are indistinguishable to the caller. | `SEC-433` | **PASS**, and it survived A-01's fix — which was the point of asserting it separately. |
| **A-06** | A signature minted for one endpoint is not accepted at another. | `SEC-442` | **PASS.** |
| **A-07** | A test-mode event delivered to a live endpoint is refused. | `SEC-439` | **PASS.** |
| **A-08** | A duplicate provider event id produces no second effect. | `SEC-440` | **PASS.** Behavioural, over the real route. Closes pass one's SEC-ACC-12. |
| **A-09** | An oversized body is refused before it is read or parsed. | `SEC-438` | **PASS.** |
| **A-10** | `openCredential` cannot be called without an expected AAD. | `AUTH-114` | **PASS.** Pass-one finding F1 closed by A02. |
| **A-11** | A ciphertext sealed for workspace A does not open in B's context, even holding the key. | `SEC-502`, `AUTH-103` | **PASS.** |
| **A-12** | `key_version` is bound inside the AAD. | `AUTH-115` | **PASS.** Pass-one F5 closed. |
| **A-13** | Every query on a customer-scoped table names `workspace_id` or is marked exempt. | `SEC-202`, `SEC-204` | **PASS.** Pass-one F2 closed — A02/A09 added the markers during this pass. |
| **A-14** | The same, judged on the **predicate** rather than the column list. | `SEC-206` | **PASS.** Was FAIL, with 4 statements scoped only by their SELECT list; A02/A09 added per-statement markers during this pass. |
| **A-15** | No SQL fragment is accepted as a function parameter. | `SEC-203` | **PASS.** Pass-one F3 closed. |
| **A-16** | No customer-facing page can name a tenant: no `CustomerDataPort` method takes a workspace id. | `AUTH-402`, `AUTH-403` | **PASS.** A05's design survived contact with the call sites. |
| **A-17** | `getCaseForOwner` is the only by-id-without-workspace support read, and it says so. | `AUTH-410`, `AUTH-411` | **PASS.** |
| **A-18** | No Stripe identifier is accepted from a browser; the checkout-session reverse lookup is reachable only from the signature-verified webhook path. | `AUTH-420`, `AUTH-421` | **PASS.** Closes pass one's SEC-ACC-24. |
| **A-19** | An approval binds budget + audience + creative + destination + duration + currency + action type; one penny changes the hash. | `SEC-301`–`SEC-318`, `SEC-722` | **PASS.** |
| **A-20** | An approval is consumed exactly once, atomically, before money moves. | owed by A07/A12 | **ABSENT.** Still the largest untested money path. |
| **A-21** | A new session id is issued and the old row revoked on every privilege transition. | owed by A02 | **ABSENT.** Session wiring not yet landed. |

**Gate A verdict: DO NOT TAKE MONEY — but the reason is now narrow.** The webhook door
(A-01 to A-09) is closed and proven. What remains is **A-20**, nothing yet consumes an
approval atomically before money moves, and **A-21**, no session rotation on a privilege
transition because the session wiring has not landed. Both are real work, not oversights.
F15 should be fixed before any customer-authored value can reach a link target.

---

## Gate B — blocking for a public site with nothing for sale

This gate was assessed against **the deployed site**, by fetching it on 2026-09-19.

| # | Check | Evidence | Result |
| --- | --- | --- | --- |
| **B-01** | No customer data is reachable. | `GET /app` renders a workspace built by `SyntheticCustomerDataPort`, banner "This workspace is showing synthetic data", ids `run_syn_*`, email masked `o**@example.test`. | **PASS** |
| **B-02** | Nothing is purchasable. | `POST /app/onboarding/checkout` → **503**, no stack trace, no secret, no Stripe redirect. `billingPortalLink()` returns null with an honest reason. | **PASS** |
| **B-03** | Synthetic data can never be mistaken for real data. | `SEC-210`, `SEC-211`, `SEC-212` | **PASS** |
| **B-04** | An unauthenticated request to an owner route is an ordinary 404. | `GET /owner`, `/owner/dashboard` → **404**, identical to `/debug` and `/.well-known/x`. | **PASS** |
| **B-05** | The owner capability model cannot be widened by a flag. | `AUTH-301`–`AUTH-312` | **PASS** |
| **B-06** | The scoped automation identity cannot activate ads, refund, move budget or self-promote. | `AUTH-310`, `AUTH-311`, `AUTH-312` | **PASS.** The denials are structural — the capability is absent from the set. |
| **B-07** | Consequential owner actions require recent strong auth; a future-dated timestamp is not freshness. | `AUTH-320`–`AUTH-323` | **PASS** |
| **B-08** | No source map, no debug endpoint, no source file is served. | `/index.js.map`, `/assets/app.js.map`, `/src/index.ts`, `/debug` → all **404**. | **PASS** |
| **B-09** | A strict CSP with no `unsafe-inline`. | Live header: `default-src 'none'`; `script-src` and `style-src` by SHA-256 hash; `script-src-attr 'none'`; `base-uri 'none'`; `frame-ancestors 'none'`. | **PASS.** Better than pass one asked for. |
| **B-10** | Transport and framing headers. | Live: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` denying camera/mic/geo/payment. | **PASS** |
| **B-11** | No private response can enter a shared cache. | Live: `/app`, `/app/runs`, `/owner` all `Cache-Control: no-store`; `Vary: Cookie` present site-wide. | **PASS.** Closes pass one's SEC-ACC-25. |
| **B-12** | Escaping on every field that round-trips to HTML. | `SEC-1210`–`SEC-1213` against A05's shipped `packages/ui`. | **PASS** |
| **B-13** | A link target cannot carry a `javascript:` scheme. | `SEC-1214` | **FAIL.** Finding F15. **Not exploitable today** — every href is a literal, and the CSP blocks `javascript:` navigation — so this does **not** block Gate B. It blocks Gate A. |
| **B-14** | CSV exports neutralise formula leaders, with the apostrophe inside the quotes. | `SEC-1201`–`SEC-1205` | **PASS.** A09's claim verified, not accepted: byte-identical to the reference across 23 corpus values. Closes pass one's SEC-ACC-18. |
| **B-15** | The assistant has no tool that can write a status, entitlement, refund, role or budget. | `SEC-701`, `SEC-702`, `SEC-703` | **PASS** |
| **B-16** | Injected instructions in ingested text fire no tool; proposals are refused outright on an untrusted turn. | `SEC-710`–`SEC-714` | **PASS.** The refusal precedes the permission check, which is the right order. |
| **B-17** | A model cannot mint an approval: the hash is over the server's payload. | `SEC-720`, `SEC-721`, `SEC-722` | **PASS.** A model-written summary is not part of the binding. |
| **B-18** | Every outbound URL passes the SSRF guard. | `SEC-001`–`SEC-022`, `SEC-602`, `SEC-603` | **PASS.** A04 adopted the reference verbatim and tightened it (`allowSubdomains: false`, three hosts). |
| **B-19** | CI holds no deployment secret, never uses `pull_request_target`, pins `contents: read` and every action to a SHA. | `SEC-620`–`SEC-623` | **PASS** |
| **B-20** | The repository and its full history contain no secret. | `SEC-610`, `SEC-611`, `SEC-624` | **PASS.** `scan:secrets — clean. 362 tracked files, full history.` Closes pass one's SEC-ACC-27 — the lead fixed the fixture and taught the scanner to honour a marker on the preceding line. |
| **B-21** | `tsc --noEmit` is clean. | — | **1 error**, in A07's in-flight `routes/owner/index.ts` (`'pairing' is declared but never read`). Not a security defect and not mine. |

**Gate B verdict: PASS.** The live site is safe to leave up. B-13 is the only red row and
it is doubly mitigated; it is carried into Gate A.

---

## Findings raised in this pass

| # | Finding | Severity | Owner | Test | Live? |
| --- | --- | --- | --- | --- | --- |
| **F13** | **Any unknown webhook endpoint id accepted a forged event.** The route fell back to a hardcoded `DECOY_SECRET` when `resolveEndpointSecret` returned null, then acted on the result if the signature verified. The repository is public, so the constant was not a secret: sign a body with it, POST to `/api/v1/webhooks/stripe/<invented-id>`, and a fabricated `checkout.session.completed` or `invoice.paid` reached the real handler. Reproduced: **expected 400, got 200.** | **CRITICAL** | A06 | `SEC-431`, `SEC-432` | **CLOSED** 10:51. Never live — the route was not mounted. The fix fails closed on the lookup and derives the fallback per deployment. |
| **F14** | 4 statements satisfied the tenant-scope check only because `workspace_id` appeared in their SELECT column list, not their predicate. All 4 were correct cross-tenant sweeps; none was declared. | **Medium** | A02/A09 | `SEC-206` | **CLOSED.** Per-statement markers added. |
| **F15** | `packages/ui` interpolates `href` with no scheme guard, so `javascript:` survives intact. Mitigated twice today (every href is a literal; the CSP blocks it) and live the moment a link target comes from a CRM value, a report link or a campaign destination. | **Medium** | A05 | `SEC-1214` | **OPEN** — the one red test. |

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

| # | Risk | Why acceptable now | What changes it |
| --- | --- | --- | --- |
| **R-01** | **DNS rebinding** cannot be mitigated on Workers — `fetch` does not expose resolved addresses. `SEC-018` tests the logic for a future runtime. | The allowlist is three fixed provider hostnames we control, never assembled from customer input, so an attacker cannot introduce a name whose DNS they own. | Any feature letting a customer supply a hostname. It must not ship on this runtime. |
| **R-02** | **AAD does not survive full key + full row compromise** — an attacker holding both replays the row's own AAD. | AAD is a tenant-confusion control and is described as one. The key lives only in Worker secrets. | A KMS or per-tenant key wrapping. |
| **R-03** | **No penetration test, no bug bounty, no formal incident response, no certification.** | `SECURITY.md` says so publicly. Claiming otherwise would be the worst thing in the repository. | Revenue or a contract that requires one. |
| **R-04** | **Timing side channels are not eliminated** — JavaScript on a shared runtime cannot be constant-time. | `timingSafeEqual` removes early exits. The realistic oracle is a differing status or message, and the webhook route already collapses all refusals to one answer. | Nothing practical on this runtime. |
| **R-05** | **The secret scanner is pattern-based** and would miss an unprefixed or base64'd credential. | A safety net, not the gate. It covers every provider we use and the full history. | A provider whose key has no recognisable shape. |
| **R-06** | **Sign-in enumeration is unproven.** No behavioural test yet asserts that a registered and an unregistered address get the same body, status and timing. | No real sign-in exists yet; `/app` is synthetic. | A02's session wiring. This becomes a Gate A row the day it lands. |
| **R-07** | **`/app` is a public demo workspace.** Anyone can read it. | It is synthetic by construction, banner-marked on every page, and has nothing to buy. Verified live. | A real port behind `/app` without the 401 gate (`SEC-213`) still holding. |
| **R-08** | **`wrangler.jsonc` contains D1 database ids.** | Not credentials; access needs a Cloudflare API token; Wrangler requires them. | Nothing. |
| **R-09** | **`audit_events` is an ordinary table** with no tamper-evidence or retention guarantee. | `SECURITY.md` already says ordinary application logs are not immutable, and the product makes no forensic claim. | Any marketing copy that claims otherwise. That claim must not be made. |

---

## Re-run record

| Date | Who | `tsc` | `npx vitest run tests/security` | `scan-secrets --history` | Gate A | Gate B |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-19 09:35 | A10 pass 1 | 0 errors | 156: 150 pass, 6 fail | 1 hit (A02 fixture) | — | — |
| 2026-09-19 10:35 | A10 pass 2 (mid) | 1 error (A07, in flight) | 221: 217 pass, 4 fail | clean, 362 files | FAIL | PASS |
| **2026-09-19 10:55** | **A10 pass 2 (final)** | **0 errors** | **221: 220 pass, 1 fail** | **clean, 377 files** | **FAIL** (A-20, A-21, F15) | **PASS** |
| | | | | | | |

**The one remaining failure:**

```
SEC-1214  javascript: survives into an href                    F15, Medium, A05
```

**Do not make it green by weakening the test.** `SEC-1215` beside it already tests the fix
target: route every non-literal href through a scheme allowlist — or better, a branded
`Url` type that only the guard can produce, so an unguarded string cannot reach an `href`
at all.
