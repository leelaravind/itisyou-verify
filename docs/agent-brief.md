# ITISYOU Verify — frozen contract v1 and shared engineering brief

Every implementation agent reads this before touching code. It is the single source of
truth for shared decisions. If you need something changed here, say so in your handoff
instead of editing it yourself — the lead owns this file and the shared schema.

## What the product is

ITISYOU Verify checks whether a business automation actually completed an agreed task,
using evidence retrieved independently from connected systems. Version one supports one
workflow shape: **an enquiry should create the correct CRM record and trigger an
acknowledgement email.** First connectors: HubSpot (CRM) and Resend (email).

The service observes. It never modifies a customer's CRM, sends replacement emails or
repairs their automation.

### The four statuses — never invent a fifth

| Status | Meaning |
| --- | --- |
| `VERIFIED` | Every mandatory assertion has sufficient supporting evidence. |
| `FAILED` | Evidence contradicts a mandatory rule, or a deadline failure is supported by *working* evidence access. |
| `UNVERIFIED` | Access, correlation or evidence is missing or ambiguous. Not a failure, not a pass. |
| `PENDING` | Still inside the agreed completion window. |

Absence of evidence is `UNVERIFIED`, never `VERIFIED` and never silently `FAILED`.
A workflow's own "success" webhook is a trigger, not proof.

## Stack decisions (settled — do not re-litigate)

| Concern | Decision | Why |
| --- | --- | --- |
| Runtime | One Cloudflare Worker, `apps/app` | Free within the existing account plan; no second deployment to keep in sync in v1 |
| Routing / SSR | Hono + `hono/jsx` server rendering | Tiny bundle, no client framework, accessible by default, progressive enhancement |
| Data | Cloudflare D1 (SQLite), `migrations/` | Already entitled; relational integrity for tenant scoping |
| Background work | D1 due-job table + a one-minute cron trigger | Deterministic, testable, no Queues dependency, £0 incremental |
| Money | Stripe hosted Checkout + hosted Billing Portal | No card data ever touches us |
| Email | Resend | Also our first email-evidence connector |
| Identity | Email magic link (opaque server-side sessions) + TOTP for the owner | No hand-written password cryptography; sessions are revocable |
| Validation | Zod at every external boundary | One schema, one error shape |
| Tests | Vitest (unit + integration), Playwright (browser) | Already installed |
| Language | TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | Catches the class of bug this product cannot afford |

## Non-negotiable engineering rules

1. **Tenant scope is application-enforced.** Every query that touches a customer-scoped
   table takes `workspace_id` and includes it in the `WHERE` clause. Never assume the
   database protects you. Composite lookups must prove the child belongs to the parent
   *within the same workspace*.
2. **Money is integer minor units.** No floating point anywhere near a cap or a price.
   Use `@verify/contracts`'s `Money` helpers.
3. **Time is ISO-8601 UTC strings** in storage, `Date` in memory. No local time, ever.
4. **Idempotency on every mutation that can be retried.** Stable keys, `UNIQUE`
   constraints, and a duplicate returns the original result rather than a second effect.
5. **Never trust a browser-supplied** price, amount, workspace id, subscription status,
   role or entitlement. Resolve all of them server-side from the session.
6. **Never return 200 with a fabricated success** after an upstream error. Use 202 for
   accepted async work, 409 for idempotency conflicts, 422 for invalid configuration,
   429 for rate limits, 503 for unavailable dependencies.
7. **No secrets in logs, errors, API responses or the repository.** Stored credentials
   are never serialised back out — not even masked, unless the mask is generated fresh.
8. **No customer-controlled URL is ever fetched.** Provider hosts are a fixed allowlist.
9. **Model output can never decide** verification success, access rights, charges or
   refunds. The optional assistant proposes; server code authorises.
10. **Errors are typed.** Throw `AppError` from `@verify/contracts`; the central handler
    turns it into the public envelope with a `request_id`.

## Repository layout and ownership

| Path | Owner | Contents |
| --- | --- | --- |
| `packages/contracts/` | lead (frozen) | Zod schemas, shared types, status vocabularies, money. **Read-only for agents.** |
| `packages/domain/` | A03 | Pure rule evaluation, decision table, run state machine, retry scheduling |
| `packages/security/` | A02 | AES-GCM credential envelopes, HMAC signatures, hashing, redaction, CSRF |
| `packages/connectors/` | A04 | HubSpot, Resend, Stripe adapters behind one interface |
| `packages/ui/` | A05 | Design tokens, layout, accessible components, shared page chrome |
| `apps/app/src/db/` | A02 | Tenant-scoped data access; the only place raw SQL lives |
| `apps/app/src/lib/` | A02 | ids, time, request context, error handler, rate limiting |
| `apps/app/src/routes/public/` | A05 | Marketing, demo, legal, development story |
| `apps/app/src/routes/app/` | A05 | Customer dashboard, onboarding, reports |
| `apps/app/src/routes/api/` | A02 + owning agent | Versioned JSON API |
| `apps/app/src/routes/owner/` | A07 | Owner dashboard |
| `apps/app/src/routes/webhooks/` | A06 / A04 | Signed provider callbacks |
| `apps/app/src/scheduler/` | A03 | Cron entry point, due-job dispatcher, outbox |
| `apps/app/src/assistant/` | A08 | Optional AI, typed tools, maintenance runner API |
| `apps/app/src/support/` | A09 | Support queue, notifications, export/deletion |
| `apps/app/src/growth/` | A12 | Campaign packets, ad adapter, visit analytics |
| `migrations/` | lead only | Additive migrations. **Never edit `0001_init.sql`.** |
| `tests/` | every agent writes its own; A11 owns the ledger | See test ID rules below |
| `docs/` | shared | Public documentation |

Stay inside your owned paths. If you need a change in someone else's file, describe it in
your handoff. Never delete, revert or reformat another agent's work.

## Shared vocabulary in code

Import everything shared from `@verify/contracts`:

```ts
import { type RunStatus, type WorkflowRules, LIMITS, AppError, money } from '@verify/contracts';
```

`LIMITS` holds the bounded values (assertion counts, deadlines, retries, retention,
plan allowance). Use the constant; do not retype the number.

## Tests

- Unit tests: `tests/unit/<area>/<name>.test.ts`
- Integration tests: `tests/integration/<area>/<name>.test.ts`
- Browser tests: `tests/e2e/<name>.spec.ts`

Every test carries a stable case ID in its title, e.g.:

```ts
it('VERIFY-012 returns FAILED when a mandatory CRM field contradicts the rule', ...)
```

ID prefixes by category: `VERIFY` (rules/evidence), `CONN` (connectors), `PERSIST`
(persistence/queues/concurrency), `AUTH` (auth/roles/tenancy), `BILL` (checkout/refunds),
`CUST` (customer lifecycle/UI), `OWNER` (owner panel/approvals/quality/cleanup), `API`
(validation/security/privacy), `BUDGET` (budgets/models/maintenance), `ADS`
(advertising/analytics), `RESIL` (accessibility/resilience/deployment), `DOC`
(development stories/release hygiene), `SEC` (security regression tests owned by A10).

A case counts once. Repeated runs, viewport copies and snapshots without assertions do
not count. Never weaken a test to make a bug pass.

Run with `pnpm test`. Outbound `fetch` is blocked in tests — stub it.

## What you must never do

- Spend money, create an ad campaign, send a real email to a real person, or charge a card.
- Commit a credential, a `.env`, a browser storage state, or a real customer record.
- Touch any Cloudflare resource that is not named `verify-itisyou-*`. The account holds
  32 other Workers and 13 other D1 databases belonging to unrelated projects.
- Claim a test passed that you did not run, or a provider integration works when only a
  mock was exercised. Label mocks as mocks.
- `git checkout`, `git reset`, `git stash` or `git clean` — the lead handles version control.

## Your handoff

Return: what you changed (paths), which tests you actually ran and their real output,
assumptions you made, defects you left behind, what you depend on, and the next action.
No generic "done".
