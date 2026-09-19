# Security acceptance — the launch gate

**Owner:** A10 (security). **Read by:** the lead, before any deployment that can be
reached by a customer or can take money.
**Baseline recorded:** 2026-09-19. **Result column is filled in at the time of the gate,
not in advance.**

## How to use this document

Run:

```
npx tsc -p tsconfig.json --noEmit
npx vitest run --config tests/security/vitest.config.ts
node scripts/scan-secrets.mjs --history
```

Then walk the table. Every **BLOCKING** row must be `PASS` before the service is
reachable by a paying customer. **NON-BLOCKING** rows are risks we are choosing to carry
for an early release; each one names what we are accepting, so the decision is recorded
rather than forgotten.

### What this document deliberately does not claim

This is a one-person, early-stage service. It has no security team, no penetration test,
no bug-bounty programme, no 24/7 on-call, no formal incident-response rehearsal and no
certification. `SECURITY.md` says so publicly and should keep saying so. A short list of
controls that genuinely work, with tests that genuinely run, is worth more than a long
list of claims — and claiming a maturity we do not have would be the most serious
security problem in the repository.

---

## A. Blocking for commercial launch

| # | Check | Test ID | Status at baseline | Result at gate |
| --- | --- | --- | --- | --- |
| **SEC-ACC-01** | The security suite runs as part of `pnpm test`. Add `'tests/security/**/*.test.ts'` to `include` in the root `vitest.config.ts`. **A suite CI never executes is not a control.** | (config change) | **FAIL** — `npx vitest run tests/security` reports *No test files found*; the suite only runs via `--config tests/security/vitest.config.ts` | ☐ |
| **SEC-ACC-02** | `npx tsc -p tsconfig.json --noEmit` is clean. | — | **PASS at 09:34.** (At 09:32 it showed 3 errors — `packages/domain/src/explain.ts` used two reason codes absent from the frozen `REASON_CODE` contract, and `tests/unit/security/signatures.test.ts` had two `BufferSource` errors. A02/A03 fixed both during the review. Zero errors were ever in `tests/security/`.) | ☐ |
| **SEC-ACC-03** | `openCredential` cannot be called without an expected AAD. Until it can, AAD binds nothing against a confused-deputy read. | `AUTH-114` | **FAIL** (finding F1) | ☐ |
| **SEC-ACC-04** | Every query touching a customer-scoped table names `workspace_id`, or carries an explicit `tenant-scope:exempt <reason>` comment. | `AUTH-202`, `AUTH-204` | **FAIL** (finding F2) — 7 unmarked statements, all believed legitimate cross-tenant sweeps, none yet declared | ☐ |
| **SEC-ACC-05** | A child row (`evidence`, `assertions`, `run_attempts`, `credential_versions`) is never read without proving parentage in the same statement. | `AUTH-204` | **FAIL** | ☐ |
| **SEC-ACC-06** | No SQL fragment is accepted as a function parameter. | `AUTH-203` | **FAIL** (finding F3) — `budget.ts` `guardSql: string` | ☐ |
| **SEC-ACC-07** | A ciphertext sealed for workspace A does not open in workspace B's context, even holding the wrapping key. | `SEC-502`, `AUTH-103` | **PASS** | ☐ |
| **SEC-ACC-08** | AES-GCM uses a fresh 12-byte nonce per seal; identical plaintext yields distinct ciphertext. | `SEC-508`, `SEC-509`, `AUTH-106` | **PASS** | ☐ |
| **SEC-ACC-09** | Stripe webhook signatures verify over raw bytes, reject `v0`, reject tampering, and reject replay outside 300s. | `SEC-401`–`SEC-410`, `AUTH-124`, `AUTH-125` | **PASS** | ☐ |
| **SEC-ACC-10** | Resend/Svix signatures verify with a base64-decoded secret over `id.timestamp.body`, reject id/timestamp/body swaps. | `SEC-420`–`SEC-428` | **PASS** | ☐ |
| **SEC-ACC-11** | A02's and A10's independently written verifiers agree byte-for-byte in both directions, for both providers. | `AUTH-120`–`AUTH-123` | **PASS** | ☐ |
| **SEC-ACC-12** | A duplicate provider event id cannot produce a second effect. Requires the `webhook_receipts` insert in the same transaction as the effect. | `AUTH-008` (schema) + a `BILL-` case A06 owes | **PARTIAL** — schema proved, behaviour unproved | ☐ |
| **SEC-ACC-13** | Source-event signatures reject a body change, a stale timestamp, a future timestamp and a foreign workflow key. | `AUTH-109`–`AUTH-113`, `AUTH-117` | **PASS** | ☐ |
| **SEC-ACC-14** | Every outbound URL passes the guard: https only, no userinfo, port 443, no IP literals, allowlisted host, redirects re-checked per hop. | `SEC-001`–`SEC-022` | **PASS.** A04 adopted the reference verbatim into `packages/connectors/src/url-guard.ts` during the review and *tightened* it (`allowSubdomains: false`, three hosts). Diff confirmed: no logic edited. Re-point `tests/security/unit/url-guard.test.ts` at `@verify/connectors` once it exports the module | ☐ |
| **SEC-ACC-15** | No connector calls `fetch` without the guard, and none uses `redirect: 'follow'`. | `SEC-602`, `SEC-603` | **PASS, but currently vacuous** — `packages/connectors/src/` holds only `url-guard.ts`; no connector calls `fetch` yet. Re-run when the HubSpot/Resend adapters land | ☐ |
| **SEC-ACC-16** | Approvals bind to budget + audience + creative + destination + duration + currency + action type. A one-penny change produces a different hash; key reordering does not. | `SEC-301`–`SEC-318`, `AUTH-126` | **PASS** | ☐ |
| **SEC-ACC-17** | An approval is consumed exactly once, atomically, before any money moves. | a `OWNER-`/`ADS-` case A07/A12 owe | **ABSENT** | ☐ |
| **SEC-ACC-18** | CSV exports neutralise formula leaders, inside quoting, in one function that both prefixes and quotes. | `SEC-201`–`SEC-207`, `AUTH-127` | **PASS for the primitive.** BLOCKING until A09's export writer uses a single combined function | ☐ |
| **SEC-ACC-19** | Every field that round-trips to HTML is escaped; no `javascript:`/`data:` survives in an `href`; Markdown is allowlist-only. | `SEC-101`–`SEC-114` | **PASS against the A10 reference.** BLOCKING until A05's components use it | ☐ |
| **SEC-ACC-20** | CSRF: double-submit **and** an Origin/Referer check, applied by default middleware to every state-changing route, exempting only signed webhook routes. | `AUTH-134`–`AUTH-139` | **PARTIAL** — primitives PASS except `AUTH-137`; no middleware exists | ☐ |
| **SEC-ACC-21** | `csrfCookie` never emits a `__Host-` name without `Secure`. | `AUTH-137` | **FAIL** (finding F4) | ☐ |
| **SEC-ACC-22** | A new session id is issued and the old row revoked on every privilege transition (magic link, TOTP, invite acceptance). | an `AUTH-` case A02 owes | **ABSENT** | ☐ |
| **SEC-ACC-23** | Owner-only routes verify session + `is_platform_owner` + `mfa_verified_at` within 15 minutes. A guessed owner path is indistinguishable from any other 404. | an `OWNER-` case A07 owes | **ABSENT** | ☐ |
| **SEC-ACC-24** | No Stripe identifier is ever accepted from the browser; checkout sessions and portal links resolve from the session's workspace. | a `BILL-` case A06 owes | **ABSENT** | ☐ |
| **SEC-ACC-25** | Every authenticated response sends `Cache-Control: private, no-store` and `Vary: Cookie`, from middleware, not per route. | an `API-` case A02/A05 owe | **ABSENT** — safe today only because Cloudflare does not cache HTML/JSON by default | ☐ |
| **SEC-ACC-26** | CI holds no deployment secret, never uses `pull_request_target`, pins `permissions: contents: read`, and pins every action to a commit SHA. | `SEC-620`–`SEC-623` | **PASS** | ☐ |
| **SEC-ACC-27** | `node scripts/scan-secrets.mjs --history` is clean and runs on every pull request. | `SEC-610`, `SEC-611`, `SEC-624` | **FAIL at 09:35** — 1 hit: `tests/unit/security/redact.test.ts:46 [assigned-secret-literal]`. It is a synthetic fixture; **A02 must add the `secret-scan:allow` marker to that line**. A10's own fixture on `security-package.test.ts:332` was marked. A blocking-but-trivial fix; do not disable the rule. | ☐ |
| **SEC-ACC-28** | No secret name appears in `wrangler.jsonc`, no source maps are emitted, no secret name appears in a public asset. | `SEC-612`–`SEC-614` | **PASS** | ☐ |
| **SEC-ACC-29** | Sign-in returns the same body, status and approximate timing for a registered and an unregistered address; every unauthorised resource returns 404, never 403. | an `API-` case A02 owes | **ABSENT** | ☐ |
| **SEC-ACC-30** | The assistant has no tool that can write a verification status, an entitlement, a refund, a role or a budget movement; `ASSISTANT_MODE` defaults to `off`. | a `BUDGET-` case A08 owes | **ABSENT** — no assistant code exists, which is currently the strongest form of this control | ☐ |

---

## B. Accepted, documented risks for an early release

Each of these is a real gap. We are choosing to carry it, and saying so.

| # | Risk | Why it is acceptable now | What would change that |
| --- | --- | --- | --- |
| **SEC-RISK-01** | **DNS rebinding** — a hostname that passes the allowlist can resolve to a private address. Cloudflare Workers does not expose resolved addresses to `fetch`, so the post-DNS check cannot be implemented. (`SEC-018` tests the logic for a future runtime.) | The allowlist is a short list of fixed provider hostnames we control and never assemble from customer input, so an attacker cannot introduce a hostname whose DNS they own. | Any feature that lets a customer supply a hostname. That feature must not ship on this runtime. |
| **SEC-RISK-02** | **AAD does not survive full key + full row compromise.** An attacker holding both replays the row's own AAD. | AAD is a tenant-confusion control and is honestly described as one in the threat model. The key lives only in Worker secrets, never in the database or the repository. | Moving to a KMS/HSM with per-tenant keys, or envelope-wrapping per workspace. |
| **SEC-RISK-03** | **No penetration test, no bug bounty, no formal incident response.** | `SECURITY.md` states this publicly and offers private vulnerability reporting. Claiming otherwise would be worse. | Revenue that justifies a test, or a customer contract that requires one. |
| **SEC-RISK-04** | **Timing side channels are not eliminated.** JavaScript on a shared runtime cannot be made constant-time. | `timingSafeEqual` removes obvious early exits. The realistic oracle is a differing status code or message, and eliminating that is SEC-ACC-29 (blocking). | Nothing practical on this runtime. |
| **SEC-RISK-05** | **The secret scanner is pattern-based** and will miss an unprefixed or base64'd credential. | It is a safety net; the gate is that secrets only reach `wrangler secret put`. It covers every provider we actually use (`SEC-624`) and the full git history. | Adding a provider whose key has no recognisable shape. |
| **SEC-RISK-06** | **`pnpm lint` cannot run** — no `eslint.config.*` exists, and CI currently warns instead of failing. | Lint is a quality control, not a security control, and `tsc --noEmit` with `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` covers the dangerous class. | The config landing — at which point the CI guard must be deleted, not left in place. |
| **SEC-RISK-07** | **`wrangler.jsonc` contains D1 database ids.** | Not credentials; access requires a Cloudflare API token; Wrangler requires them in config. | Nothing. |
| **SEC-RISK-09** | **`pnpm install` fails locally** — `pnpm-workspace.yaml` has placeholder strings in `allowBuilds` (`esbuild: set this to true or false`) and pnpm halts with *"Run `pnpm approve-builds`"*. This will break the CI install step. The `wrangler deploy --dry-run` build itself is confirmed working. | Not a security defect, but it makes CI red, and a red CI gets ignored. **Lead: replace the placeholders with booleans.** | Nothing; fix it. |
| **SEC-RISK-08** | **No formal log retention or tamper-evidence.** `audit_events` is an ordinary table. | `SECURITY.md` already says *"Ordinary application logs are not immutable"*, and the product makes no forensic-certification claim. | Any claim to the contrary in marketing copy. That claim must not be made. |

---

## C. Re-run record

| Date | Who | `tsc` | Security suite | `scan-secrets --history` | Blocking items outstanding |
| --- | --- | --- | --- | --- | --- |
| 2026-09-19 09:32 | A10 (first pass) | 3 errors (0 in `tests/security/`) | 156 cases: **150 pass, 6 fail** | clean, 49 tracked files | — |
| 2026-09-19 09:35 | A10 (final, tree moved under review) | **0 errors** | 156 cases: **150 pass, 6 fail** | **1 hit** in `tests/unit/security/redact.test.ts:46` (A02 fixture, needs a marker) | SEC-ACC-01, 03–06, 12, 14, 15, 17–25, 27, 29, 30 |
| | | | | | |
| | | | | | |

**Baseline failure detail — all six are findings, none is a broken test:**

```
AUTH-114  openCredential must REQUIRE an expected AAD             (finding F1, critical)
AUTH-115  key_version must be inside the AAD                      (finding F5, medium)
AUTH-137  __Host- cookie emitted without Secure                   (finding F4, medium)
AUTH-202  7 customer-scoped queries with no workspace_id and no exempt marker (F2, high)
AUTH-203  budget.ts interpolates ${params.guardSql}               (finding F3, medium)
AUTH-204  2 child-row reads without parentage in the statement    (F2, high)
```

**Do not make these green by weakening a test.** Each one is fixed by changing the code it
points at, or — for the four cross-tenant sweeps that are genuinely correct — by adding a
`tenant-scope:exempt <reason>` comment, which records the decision instead of hiding it.
