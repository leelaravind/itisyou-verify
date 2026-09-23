# Full site audit — 23 September 2026

Four review tracks ran at the same time against production (`810b1d9`, then the fix sprint
below) and the repository. Each finding carries evidence in its track's report; raw request
and response captures are in the auditing session's scratchpad, not in this repository.

| Track | Scope | Method | Model |
| --- | --- | --- | --- |
| A | Public site: 13 pages, headers, links, copy, SEO | read-only GET/HEAD crawl, ~1.8 req/s | Sonnet |
| B | Signed-in customer app, every GET page, finder | the owner's own browser session, read-only; free lookups only | Sonnet |
| C | API, webhooks, owner/admin edges, CSRF, caching | ~65 requests that are refused by design; code review | Sonnet |
| D | Code, tests, docs consistency; all gates run | read-only static review | Fable |

**Raw findings: 44. After de-duplication: 42 unique.** (C7 is the root cause of C1; A8 is
part of D19.) **Critical 0 · High 5 · Medium 13 · Low 15 · Info 9.**

**Fixed and released in the same sprint: 8** (3 high, 4 medium, 1 low), each with a test.
**Open: 34**, listed below as a backlog.

## Fixed this sprint

| # | Sev | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| D1 | High | The owner's `expensive_verification` pause was not honoured by the production tick (`handleScheduled` never passed `suspendDueRuns`) | read in `handleScheduled`; control now `kind: 'action'` | OWNER-931, 932 |
| C1 (+C7) | High | Owner/admin route-existence oracle: invented paths got a bare 13-byte 404, real refused ones the branded 404 | `routes.notFound(refuseNotFound)` on the owner sub-app | OWNER-935 (through the Worker entry) |
| C2 | High | Release smoke check accepted any commit answering `/health` | must report the candidate SHA; retries for a minute | release script |
| C3 | Medium | No CSRF check on `POST /admin/login` | checked; refused request sends nothing | OWNER-933 |
| A1 | Medium | `/support` showed the real address beside "not been published yet" | explanation only for placeholders | CUST-974 |
| B1 | Medium | Duplicate `id="f-access_token"` on the connect page; labels focused the wrong input | provider-scoped ids | CUST-975 |
| D7 | Medium | Runs pager dropped `show=test`; cursor unencoded | pager keeps filter, encodes | VERIFY-936 |
| C5 | Low | No CSRF check on `POST /admin/sign-out` | checked | OWNER-934 |

## Open backlog (34), highest first

**High**
- D2 Owner settings saved but read by nothing: pricing, retention, notifications, business, access mode. Wire each or label "recorded, not applied".
- D3 Customer privacy requests (export, delete, cancel deletion) have no routes; the deletion pass drains an always-empty queue; three email templates link to routes that do not exist. The privacy copy promises "deletion confirmations".

**Medium**
- C4 No `Cache-Control` on 401/400/413 API and webhook refusals and sub-app 404s.
- D4 Owner controls page reads `since`/`by`; `setControl` writes `changedAt`/`changedBy`: always "since — by unknown".
- D5 Admission-time usage alert has no billing contact wired; only the tick's retry can send.
- D6 Owner "Check this run again" is a permanent stub on the real port with a false reason (could reuse `checkWatchedRun`).
- D8 Signed-out support form `/support/contact` is linked from nowhere.
- D9 Staging cron `*/5` never hits `RECOVERY_SWEEP_MINUTE = 7`.
- D10 Scheduler failures are invisible in production logs (no logger passed; money and deletion reports never logged).
- D11 Test gaps: `checkWatchedRun` suspended / claimed-elsewhere / failed outcomes; `/app/live` due-run branch; no browser test of `LIVE_SCRIPT` behaviour.
- D12 `POST /api/v1/billing/provision-price` documented, not mounted.

**Low**
- A2 "both both" in development-story event text. A3 `/how-it-works` jumps h1→h3. A4 no Open Graph tags. A5 trailing-slash and upper-case paths 404.
- B2 "Last observed" shows the evidence's own timestamp (e.g. the contact's create date), which can precede "Enquiry received"; relabel. B3 Billing is not in the top navigation.
- C6 No CSRF on `POST /admin/bootstrap` (needs the bootstrap token and a redeemed link; minimal risk).
- D13 Owner MFA challenge on a POST always returns to `/owner` (referer is a full URL).
- D14 Docs and comments still say the site ships one script; it ships two (theme, live pages).
- D15 `isPlaceholderId` refuses any one-character repeat of 3+ (e.g. `111`); consider zeros only, or 8+ characters.
- D16 Two ids interpolated into URLs unencoded (onboarding activation, quality report).
- D17 Dead `ALWAYS_REACHABLE_PATHS` naming paths that do not exist.
- D18 `purgeExpired` never called; Resend correlation misses parked silently; an in-memory owner app built at import time and unused.
- D19 Unreachable exports and orphan routes: assistant, alert grouping and four templates, growth helpers, refund helpers, `POST /owner/refunds`, `/owner/orders/:id/reject`, runner pairing, `/admin/authenticator` unlinked, `/development-story/visual` unlinked (A8).

**Info**
- A6 no canonical links. A7 no sitemap; robots.txt has no `Sitemap:`. A9 four pages without a meta description. A10 two long meta descriptions. A11 `docs/product-scope.md` gaps section is stale.
- B4 onboarding review cites `docs/privacy-retention.md` as plain text. B5 phone-width pass could not run: the browser tool's resize did not take effect.
- D20 ledger header still says "generated 2026-09-20". D21 test counts in the handover drift.

## Checked and found clean (abridged)

Security headers on every response, including 404s and 401s; HTTPS redirect; no stack traces;
no CORS misconfiguration; CSP is a hash allow-list that nothing served violates; webhook
size caps and timing equalisation; every `/app/*` route session- and tenant-scoped,
including the new live endpoints and lookups; price, run count, retention, recovery window and
VAT wording identical on every page; figures agree across `/app`, `/app/usage` and
`/app/runs` (13 runs: 3 automation, 10 test); no console errors or CSP violations on any
signed-in page; finder fills ids only and costs nothing (usage unchanged before and after);
all gates pass.
