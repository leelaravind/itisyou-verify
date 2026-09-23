# Session handover — ITISYOU Verify

## 23 September 2026 — current state

Written at a clean stopping point: working tree clean, everything pushed, all gates green.
**Everything below the horizontal rule is the 21 September handover, kept for its history
and superseded by this section wherever the two disagree.**

| | |
| --- | --- |
| `main` | `cb9d726` |
| **Production** | **`28d11336b14808a6b7b2302e053d6e24389ace8d`** |
| Staging | `effbe70` (behind main) |
| Tests | 2875 passing, 4 skipped |
| Lint / secret scan / ledger | clean, clean, PASS |
| Migrations | `0009` applied to production, staging and local. **Nothing pending anywhere.** |

**Three commits are on `main` and undeployed**: `1017347`, `cc6eda4`, `cb9d726` — the
workspace layout, the counting fix and the Resend capability correction. Deploying them
needs no migration and no new approval beyond the owner naming the candidate.

### The one thing to pick up

**Searchable record and message selectors for the manual test form.** Groundwork is in; the
feature is not. `GET /emails` is in Resend's frozen operation table with its customer-facing
purpose; HubSpot's `contact_search` already exists and supports `HAS_PROPERTY`. The port
methods, the route and the UI are outstanding.

**The constraint that shapes it: selecting a record fills its IDENTIFIER only.** The expected
correlation reference and intended recipient stay the customer's own input, or come from the
original enquiry. They are never pre-filled from the record or message just displayed — a
verification that compares an observed value against itself proves nothing, and reporting
that as a pass is the exact failure this product exists to refuse. The selector shows
observed values so a human can choose; it must not turn them into expectations.

Also required: ambiguity gets an explanation and manual entry, never a silent "most recent";
searching, selecting, refreshing status and opening the form consume no allowance; cost is
stated before submitting.

### Corrections from this session, so they are not re-learned

1. **Resend DOES list sent messages** (`GET /emails`). I claimed twice it could not, from a
   connector comment that listed only the retrieve endpoint. Corrected at source.
2. **"5 of 3 runs shown" was not a display bug.** Two definitions of "a test run" existed —
   `runs.is_synthetic` for counts, `source_events.source` for rows, badges and filters. The
   source event is now the single authority everywhere, including the owner's platform
   count. Billing still counts both kinds.
3. **Production was never rolled back.** An earlier report said `29164e3` when it was
   `0db4704`; a stale reading, not a deployment event.

### What caught real defects that a passing suite did not

Reading the **deployed site** (`handleScheduled` never passed `sendUsageAlert`, so a tested
retry pass would never have run in production); driving the **real layer instead of a stub**
(a failed notification key is claimed forever, invisible behind a fake sender); and a
**bounded independent audit** of the diff, which found that defect and an overclaim in a
commit message of mine.

### Limitations, stated rather than fixed

- **Signed-event testing on production is unverified**, not passed: the signature gate fires
  before admission control and completing it needs the event-signing root key.
- **Usage-alert delivery on production is unobserved** — at 12 of 500 nothing is eligible.
  Do not burn runs to force it.
- **Mobile screenshots are local evidence** (`wrangler dev` + seeded local admin fixture).
  Deployed controls were verified by served HTML and live POSTs instead.
- The three `auto-journey-*` production runs are **real automation traffic** by every
  definition the product has, identifiable by event id only, and they count in the
  automation verification rate. Excluding them would be a deliberate change.

Ads paused. Live payments disabled. No migration authorised beyond `0009`, already applied.

---

## 21 September 2026 — superseded

Written 21 September 2026, 08:40 UTC. **Corrected at 14:10 UTC** after an independent
meta-audit found this file, the first in its own prescribed reading order, still describing
as open several defects that the same day had already fixed and deployed. Every figure below
is re-read, or says it could not be. **Updated again for the afternoon candidate**, with the
machine clock reading 14:05Z on 21 September. **Production now serves it**: the release that
had aborted at a refused migration step ran whole at 14:00Z, staging first, then production,
from one gate artefact. Nothing was skipped to achieve that. (The 14:10 UTC stamps above came
from a session whose clock ran ahead of this one; they are left as written rather than
quietly re-dated.)
Figures are read from the repository, the deployed services or their databases; where
something could not be read, it says so. No credentials, cookies or codes appear here.

**Read `docs/completion-checklist.md` first.** It became the authoritative status list at
16:35 UTC on 21 September: one row per item with an owner, acceptance criteria, evidence and
one of pending / working / blocked / verified / deployed, with visual, functional and
deployment separated and an issue register with severity. The launch checklist below keeps the
launch-blocker history and the screen checklist keeps the per-screen comparison detail;
neither is a competing status list any more.

Nothing is blocked on the owner. The two items that were are closed: on 22 September they
signed in, reached the owner panel and reported it fine, and they sent a test message to
support@itisyou.app and received it. Live payments remain a separate, owner-gated DECISION
rather than an open task: `docs/live-payment-approval.md`, NOT READY, 3 of 13.

Then read in this order: this file → `docs/launch-checklist.md` (the one checklist) →
`docs/owner-actions.md` (what only the owner can do) → `docs/live-payment-approval.md` (the
live-payment decision) → `docs/handover-evidence.md` (one page of sourced claims).

## 1. Repository and deployment state

| Item                        | Value                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Branch                      | `main`                                                                                                         |
| HEAD                        | see `git rev-parse HEAD`; this row went stale twice on 21 Sept and is no longer pinned here                   |
| Working tree                | single worktree `H:/itisyou-verify`, no stashes. Check it; do not trust a recorded state    |
| Production                  | `58c46184f339` at 06:38Z on 22 Sept; later commits are documentation and evidence. Read it, do not trust this row |
| Staging                     | the same commit, deployed from the same gate artefact moments before production |
| Undeployed work             | None at the time of writing; later commits are documentation and evidence only. Per-release evidence lives in `docs/evidence/production-*.txt` |
| Last CI run used to release | `gh run list` — releases require the CI artefact `release-gate-<fullsha>` for HEAD (see §6)                    |

**Release procedure that works** (all four traps hit this weekend are avoided by it).
Nothing in it deletes evidence: each release keeps its own artefact under
`reports/release-gate/<sha12>/`, and `--gate-artefact` points the script at it, so a later
release never overwrites or removes an earlier one. `reports/` is git-ignored, so keeping it
cannot dirty the tree and cannot break the gate.

```
SHA=$(git rev-parse HEAD); SHORT=${SHA:0:12}
git status --short                                   # must print nothing
mkdir -p reports/release-gate/$SHORT
gh run download <runId> -n release-gate-$SHA -D reports/release-gate/$SHORT
node scripts/release.mjs --env staging    --gate-artefact reports/release-gate/$SHORT/release-gate.json
node scripts/release.mjs --env production --gate-artefact reports/release-gate/$SHORT/release-gate.json
curl -s https://verify.itisyou.app/health
```

Staging first, then production, with the same artefact and therefore the same candidate.
`node scripts/release.mjs --check-gate-artefact --gate-artefact <path>` answers "would this
artefact let this commit reach production" in a second, without deploying anything.

The earlier version of this PROCEDURE ran `rm -rf reports` before and after every release.
That threw away the gate artefact, both test reports and the served HTML captured for the
rendered claim scan: exactly the evidence a release is supposed to leave behind. Removed on
21 September 2026 at the owner's instruction.

To be exact about what changed, because a commit message on this made it sound like a code
change and a meta-audit called that out: `scripts/release.mjs` was **not modified**. It
already accepted `--gate-artefact` and `--check-gate-artefact`. What changed is the written
procedure above and the habit of keeping `reports/release-gate/<sha12>/` per commit.

One consequence worth knowing before you cite anything from there: **`reports/` is
git-ignored**, so artefacts under it exist only on the machine that produced them. Evidence
that a document points at has been copied into `docs/evidence/`, which is tracked.

Wrangler commands run from `apps/app`. The gate runs the whole suite locally and refuses a
dirty tree, a stale story copy (`apps/app/public/development-story.md` must equal
`docs/development-story.md`) and any Playwright failure. A `release_deployed:<env>:<sha12>`
Telegram message goes to the owner once per deployed commit (proof: a
`notification_deliveries` row).

## 2. Completed requirements, with where the evidence is

| Requirement                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox payment path on **production**, end to end                                                                            | `docs/launch-checklist.md` D1.1–1.6: order `ord_01M31E6KYED181BAC8307E46E9` created by production 07:34Z, paid with Stripe's test card, three signed events `processed`, subscription `active`, one 500-run entitlement, Stripe resend answered `duplicate: true` with the row unchanged, `/app/billing` and `/app/usage` showing it (21 Sept) |
| Sandbox payment path on staging                                                                                               | `docs/live-payment-approval.md` §1 (P3–P5), `docs/workflow-evidence.md`                                                                                                                                                                                                                                                                        |
| Verification engine against real HubSpot and Resend (VERIFIED, FAILED by value mismatch, FAILED by absent record, UNVERIFIED) | `docs/workflow-evidence.md` §(a)–(e); run ids in `docs/launch-checklist.md` D2                                                                                                                                                                                                                                                                 |
| Usage increments and matches the customer page                                                                                | `docs/workflow-evidence.md` §(e): consumed 11→12, page 12/500                                                                                                                                                                                                                                                                                  |
| Owner path on production: bootstrap, authenticator, MFA-gated action, closed bootstrap                                        | production `audit_events`: `owner.bootstrap granted` 10:59Z, `auth.totp.enrolled` 11:09Z, `auth.totp.accepted` 11:37Z, `owner.workspace.created` 11:39Z, `owner.bootstrap already_bootstrapped` 11:59Z (20 Sept); `docs/owner-actions.md`                                                                                                      |
| Anonymous access refused everywhere in the panel                                                                              | `/owner`, `/owner/customers`, `/admin/authenticator` → 404; `/admin` → 303; `/app` → 401 (curl, 20–21 Sept)                                                                                                                                                                                                                                    |
| Public claims corrected and scanned as served                                                                                 | `scripts/scan-claims.mjs` runs inside the release over 7 served pages; `packages/ui/src/content/site.ts` notice                                                                                                                                                                                                                                |
| Tests                                                                                                                         | ledger `docs/test-cases.json` 2,831 rows at 14:10Z on 21 Sept, `--strict` PASS. Suite counts in this file and in commit messages are **unit + integration unless they say otherwise**; the full run including `tests/security` is larger. A count without that qualifier is not to be trusted                                                                                                                  |
| Stitch design                                                                                                                 | 15 of 19 screens composed (`packages/ui/src/designProgress.ts`); exports in `design/stitch/` (see §5)                                                                                                                                                                                                                                          |
| Owner alerts via Telegram                                                                                                     | payments-configured, design-figure and release milestones delivered (`notification_deliveries`)                                                                                                                                                                                                                                                |
| Advertising                                                                                                                   | campaign 24269887676 submitted 20 Sept; **paused 21 Sept 08:50 UK by the owner's account, intentionally**; £12.25 total budget; 0 impressions; £0.00 spent                                                                                                                                                                                     |
| Development stories                                                                                                           | `docs/development-story-events.json` EVT-0001..0048 (validated), `docs/development-story.md` + published copy, `docs/development-story-agent.md`                                                                                                                                                                                               |

## 3. Remaining requirements — owner, dependency, next concrete action

| #   | Requirement                                                                                               | Owner        | Depends on                                 | Next concrete action                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Legal identity on `/terms` and `/privacy` (L5)                                                            | lead         | owner values in §4 (confirmed)             | Edit `OWNER_LEGAL_IDENTITY` in `packages/ui/src/content/legal.ts` with §4 values; set `companyRegistrationNumber` to "Not applicable (sole trader)", `vatNumber` to "Not VAT-registered", `certifications` to "None"; remove `TERMS_SKELETON_NOTE` only when every field is real; update tests that assert "Not yet published"; deploy; confirm on the served pages   |
| R2  | VAT wording (L6)                                                                                          | lead         | owner decision in §4 (confirmed)           | Replace "any tax required by law … is calculated and added by our payment provider" on `/pricing`, `/terms`, review page with "£29.00 per month. We are not VAT-registered, so no VAT is charged." Keep a sentence that overseas buyers may owe local taxes; **do not** enable Stripe Tax; update CUST-333 and related assertions; deploy                             |
| R3  | Owner alerts on first live payment and every failed live charge (L7)                                      | lead         | none                                       | In `apps/app/src/billing/events.ts`: on `checkout.session.completed` in live mode → `spending_decision` alert once; on `invoice.payment_failed` → `critical_incident`; test through the real webhook path; ledger rows                                                                                                                                                |
| R4  | Live Stripe objects (L2, L3)                                                                              | owner        | R1–R3 done; owner approval of pack §4      | In the **parent** account `acct_1UHU2QP8C4JrYWQF` (not the sandbox): live £29.00 monthly price; restricted live key; new opaque webhook path id; live destination with the six event types; secrets via `wrangler secret put … --env production`. Exact steps: `docs/live-payment-approval.md` §4                                                                     |
| R5  | `STRIPE_MODE` → `live` on production (L4), first live charge on the owner's card, refund through `/owner` | lead + owner | R4; owner's explicit "approved" on pack §4 | Pack §4 steps 6–9. **Separately gated; not started.**                                                                                                                                                                                                                                                                                                                 |
| R6  | Organic posts (O4)                                                                                        | owner        | none                                       | Approve or edit the two posts in `docs/organic-launch.md` §4.3 and §5.3; the lead posts nothing                                                                                                                                                                                                                                                                       |
| R7  | Onboarding entry controls are taken down unconditionally                                                  | lead         | owner policy decision                      | `apps/app/src/routes/app/workspacePage.ts:96` ("Start the setup") and the compatibility step's "These all apply — continue" render `UnavailableAction` whenever no workflow exists, regardless of environment or owner controls; this session drove the steps by their form routes. Decide the policy (owner control? environment flag?) and make the CTA conditional |
| R8  | Support mailbox `support@itisyou.app` receive + reply                                                     | owner + lead | none                                       | See §4 "Contact". DNS proves MX → Cloudflare Email Routing; the routing **rule** for `support@` and a live receipt test are unverified; replying _as_ `support@` needs an outbound identity (Resend domain or SMTP "send as")                                                                                                                                         |
| R9  | Remaining Stitch screens (4 of 19)                                                                        | lead         | design references; batch-03 retrieval (§5) | `/security` (no approved reference — needs one), `/admin/login`, `/support`, `/development-story/visual`; also `/owner/cleanup`. Follow §5 exclusions                                                                                                                                                                                                                 |
| R10 | Stitch batch-03 retrieval                                                                                 | lead         | Stitch MCP (session `d63ebe`'s work)       | `design/stitch/screens/batch-03/README.md` — list project `12603262649263949929`, diff against `INVENTORY.md`, export only new screens                                                                                                                                                                                                                                |
| R11 | Ten genuine external visits                                                                               | —            | organic posts / ads                        | Honest count: 0 attributable. Ads paused by owner; posts unapproved                                                                                                                                                                                                                                                                                                   |
| R15 | ~~Promote the candidate to production~~ **done 14:00Z**                                                     | —            | —                                          | `6fae121148ff` released to staging then production from one gate artefact. Earlier in the afternoon this row read BLOCKED: the release aborted because the permission classifier refused `npx wrangler d1 migrations apply … --env production --remote`, which `scripts/release.mjs` runs unconditionally and offers no flag to skip. No flag was added; the same command was accepted on the later attempt. Kept visible because the next reader will meet the same classifier |
| R16 | Owner panel walkthrough on production                                                                     | owner + lead | one owner action, everything else verified | Owner signs in at `https://verify.itisyou.app/admin/login` and confirms a TOTP code, then either says so and the lead reads the panel, or runs `node scripts/owner-panel-walkthrough.mjs --cookie-file <file>` with the session cookie from their own browser. That script only ever GETs and cannot mint a session; it refuses a file that is not a session cookie, and redacts anything credential-shaped before printing. **A production session must not be seeded and authentication must not be bypassed.** Readiness evidence: `docs/evidence/owner-actions-readiness.txt` |
| R18 | ~~Compare the remaining eleven screens with their references~~ **done**                                            | lead         | none                                       | `docs/screen-checklist.md` lists them: how-it-works, demo, support, the development story, five customer screens, five owner screens. All eleven were read beside their references at 1440, 834 and 390 on 21 Sept. Four changed; the rest are recorded as compared and unchanged with a reason each. Nothing in that file is marked pending for comparison any more |
| R17 | ~~Owner and admin panel recomposition~~ **done**                                                          | —            | —                                          | 14 callouts retoned so that red means a problem and nothing else; the placeholder banner, the unknown-figures notice and the unpaired-runner notice cut to one sentence with the rest behind a disclosure; the launch strip states a shared freshness once. Rendered through the real router for all 13 owner GETs and captured at three widths. OWNER-919..923 hold it, and were mutation-checked by reverting a tone |
| R12 | Development stories for the next work                                                                     | lead         | as work lands                              | Append events after EVT-0058 (21 Sept added EVT-0056 connection test, EVT-0057 guided test verification, EVT-0058 motion) with `commit_sha` and `test_evidence_refs`; keep `apps/app/public/development-story.md` identical to `docs/development-story.md` (DOC-130)                                                                                                                                                                                               |
| R13 | Cleanup                                                                                                   | lead         | none                                       | Browser tabs left open on Resend/Stripe/HubSpot/Google Ads dashboards (owner's profile) — close them; scratch scripts live under this session's scratchpad only                                                                                                                                                                                                       |
| R14 | Owner dashboard re-check with the owner's own session                                                     | owner        | none                                       | The owner's session was rotated out by the customer sign-in on 20 Sept. Sign in at `/admin/login`, confirm a code, open `/owner` and one control; record                                                                                                                                                                                                              |

## 4. Owner-confirmed details (21 September 2026)

- **Legal identity:** Leela Aravind Karlapudi, trading as ITISYOU. **Structure:** sole trader.
- **Correspondence address:** Lytchett House, 13 Freeland Park, Wareham Road, Poole, Dorset, BH16 6FA.
- **Contact:** support@itisyou.app. DNS read 08:30Z: MX `route1/2/3.mx.cloudflare.net` (Cloudflare Email Routing), SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`, DMARC `p=none`. **Not verified:** that a routing rule exists for `support@` and that mail arrives; the Cloudflare dashboard needed a sign-in this session did not perform. **Reply capability:** Cloudflare Email Routing is receive-only; sending as `support@itisyou.app` needs a verified sending domain (the Resend account already sends the sign-in mail from the configured `RESEND_FROM_ADDRESS`) or an SMTP "send as" identity in the owner's mail client. Next action: owner confirms the rule in Cloudflare → Email → Email Routing → Routes; lead sends one test message and records receipt; then decide the reply identity. Configure without touching any other mail service.
- **VAT:** not VAT-registered. UK pricing £29 per month, no VAT charged. This does **not** settle tax for overseas markets; the wording must say local taxes may apply elsewhere.
- **Company registration number:** not applicable.
- **Ads:** intentionally paused (change history 21 Sept 08:50 UK). **Keep paused until the owner explicitly approves resuming.**
- **Live-payment activation:** separately gated; pack §4 runs only on the owner's explicit approval after §1 is all PASS.

## 5. Design task, skills, Stitch status, export locations

**Task.** Use the downloaded Stitch references (`design/stitch/screens/batch-02/…`, 20 screens,
plus new exports as they arrive) to finish the website in the existing **Hono server-rendered
HTML/CSS** stack. No framework migration. Generated content is reference material; preserve
accurate product capabilities, pricing, security statements and functional flows from the code.
Include real product demonstrations, appropriate loading states, and the Terms and Privacy
pages. Clear typography, restrained colours, purposeful layouts.

**Owner's exclusions — these override any conflicting Stitch style:** no harsh gradients;
no rainbow, neon or pastel palettes; no purple-and-black styling; no pure-white backgrounds;
no drop shadows; no glass effects; no soft rounded cards; no radial orbs; no dot grids; no
generic three-feature-card rows; no bento grids; no decorative terminals; no three-tier
pricing; no Lucide icons; no sparkle icons; no emojis; no checkmark bullets; no animated
arrows; no decorative hover animations; no Inter, Geist or Space Grotesk fonts; no coloured
left-border callouts; no em dashes; no "It's not X, it's Y" copy; no fake testimonials.

**Exported design locations.** `design/stitch/exports/*.zip` (two validated archives),
`design/stitch/screens/batch-01/`, `design/stitch/screens/batch-02/` (supersedes batch-01;
the 16 required screens are mapped in `design/stitch/INVENTORY.md`), `design/MAPPING.md`
(palette decision, 109 findings), `design/REVIEW.md`, `design/tokens.css`,
`docs/stitch-mapping.md`. `design/stitch/screens/batch-03/` holds only a README: **nothing
from the two generations the owner mentioned is on disk.**

**Stitch MCP status.** No `mcp__stitch*` tool exists in this session's toolset; the MCP
connection work lives in peer session "Add Stitch MCP with Google API authentication
[d63ebe]", offline at 08:25Z. Generation cannot be resumed from here.

**Installed skills** (as listed to this session at 08:35Z after the owner ran `/plugin`, which
reported "Installed 2 plugins"): `stitch-build:*` (react-components, react-native,
react-vite-dashboard, remotion, shadcn-ui), `stitch-design:*` (code-to-design,
extract-design-md, extract-static-html, generate-design, manage-design-system,
upload-to-stitch), `stitch-utilities:*` (design-md, enhance-prompt, site-md, stitch-loop,
taste-design), `example-skills:*`, `design`, `design-system`, `ui-styling`, `ui-ux-pro-max`,
`frontend-design`, `banner-design`, `slides`, `web-perf`, `cloudflare`, `cloudflare-one`,
`durable-objects`, `workers-best-practices`, `wrangler`, `nextjs-on-cloudflare`,
`sandbox-*`, `turnstile-spin`, `dataviz`, `artifact-*`, `claude-api`, `code-review`,
`security-review`, `simplify`, `run`, `init`, `loop`, `schedule`, `workflow-authoring`,
`claude-in-chrome`, `update-config`, `keybindings-help`, `fewer-permission-prompts`.
**This session invoked none of the design or Stitch skills.** Note the `stitch-build:*` skills
target React/Vite/React Native/shadcn — they do not fit this Hono stack and must not be used
to migrate it.

## 6. Verification commands and their latest results

| Command (from `H:/itisyou-verify`)                                                                                                                     | Latest result                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                       | clean (21 Sept 13:4xZ, at `07a42794620c`)                                                                 |
| `pnpm lint`                                                                                                                                            | clean                                                                                                     |
| `pnpm exec vitest run tests/unit tests/integration tests/security`                                                                                     | 2,789 passed / 4 skipped across 190 files, 2 files skipped (21 Sept 13:4xZ)                               |
| `pnpm test` (full, via `scripts/run-tests.mjs`)                                                                                                        | last full run 20 Sept 09:5xZ: 2,737 passed / 4 skipped; since then every commit passed CI (`gh run list`) |
| `node scripts/verify-test-cases.mjs --strict`                                                                                                          | Ledger integrity PASS; 2,845 cases                                                                        |
| `node scripts/verify-story.mjs`                                                                                                                        | record well-formed, EVT-0001..0058                                                                        |
| `node scripts/scan-claims.mjs` / `scan-secrets.mjs`                                                                                                    | clean (run inside every release too)                                                                      |
| `curl -s https://verify.itisyou.app/health`                                                                                                            | commit `c2972fb85489` (17:35Z, 21 Sept)                                                                  |
| `curl -s https://verify-itisyou-staging.kpleelaaravind.workers.dev/health`                                                                              | commit `c2972fb85489` (17:35Z, 21 Sept)                                                                  |
| `node scripts/scan-secrets.mjs`                                                                                                                         | clean, 798 tracked files                                                                                  |
| `curl -sI https://verify.itisyou.app/pricing \| grep -i form-action`                                                                                   | `form-action 'self' https://checkout.stripe.com https://billing.stripe.com`                               |
| Production DB reads (from `apps/app`): `pnpm exec wrangler d1 execute verify-itisyou-db-production --env production --remote --json --command "<SQL>"` | see §2 for the rows read; never select secret columns                                                     |

**Sandbox proof vs live readiness, kept apart.** Sandbox: proven on production (D1.1-1.6,
§2 row 1). Live: **NOT READY, 3 of 13 FAIL** as of 21 Sept 14:00Z. L5, L6 and L7 are PASS and
deployed. What remains is L2, L3 and L4, all owner-only, in that order.

## 7. Constraints that remain in force

- £100 startup budget; £15 all-in ads cap (campaign total £12.25 = £14.99 with UK DST fee and VAT); £30 contingency separately gated; spend so far £0.00.
- Stripe test mode everywhere; live charges off until the owner approves pack §4; the first live charge is the owner's own card, refunded through `/owner`.
- Secrets only via `wrangler secret put` (prompted, from `apps/app`); never in chat, logs, screenshots or Git; test and production secrets separate; no changes to the owner's other projects' keys.
- Never bypass a denied tool or a security control; do not weaken tests; do not label unfinished work complete.
- Provider read-back is the only verdict source; stored signed webhooks do not feed a verdict — say so wherever it matters.
- Do not kill other sessions' processes, `git stash` bare, or edit `~/.claude/settings.json`; use the session scratchpad for temp files.
- Ads stay paused; live payments stay gated; posts are the owner's to publish.

## 8. Known defects and gaps not to be called complete on the strength of a unit test

**Corrected 14:10Z.** The three items struck through below were listed here as open while
they were already fixed and deployed the same morning. A meta-audit found them. Left visible
rather than deleted, because a handover that silently rewrites its own history teaches the
next reader to trust it less, not more.

- ~~Onboarding CTAs taken down unconditionally (R7)~~ **fixed and deployed** at `d11c271654bd`;
  both controls render on `session.role === 'workspace_admin'`, verified on deployed staging
  for both roles.
- ~~Payment alerts absent (R3)~~ **fixed**; see L7, and BILL-662 for what actually proves the
  live/test gate.
- ~~Legal pages carry placeholders (R1) and a tax sentence the checkout does not implement (R2)~~
  **fixed and deployed**, read back from the served pages.
- **Closed at 14:00Z:** the billing-portal fix and the connection and test-verification actions
  are live on production at `6fae121148ff`. They were verified signed in, in both roles, on
  deployed staging (`docs/evidence/staging-verification-a904db086221.txt`); on production the
  served commit, the anonymous refusals, the stylesheet and 39 screens were read back
  (`docs/evidence/production-6fae121148ff.txt`). The signed-in screens were **not** re-exercised
  on production, because that would mean seeding a session there. If you need that proof, do it
  through a real sign-in, not a seeded row.
- The owner panel **has still not been walked through signed in** (R16). It has been recomposed
  and rendered through the real router for every owner GET, but every one of those renders used
  the in-memory port; nobody has seen the panel against production data, and nobody may seed a
  production session to fake that.
- The **missing Stitch screens were not generated** (R9, checklist 6.14). A generation run stalled
  after roughly 140k tokens and was stopped on the owner's cost instruction. `/security` still has
  no owner-approved reference, so it cannot be composed against one.
- The **guided test verification proves the pipeline, not the customer's automation.** It writes a
  real source event through `sourceEvents.admitOnce`, spends one run from the allowance and is
  decided by the real evaluator against real provider reads. The page says a pass proves nothing
  about whether the customer's own automation reports its enquiries. Do not let that sentence be
  edited out.
- The **connection test checks API access and webhook readiness only.** `workflowVerification` is a
  field on the result type whose value is always `not_checked`, so the page structurally cannot
  claim the workflow is verified. Do not collapse the three findings into one tick.
- Support mailbox unverified (R8): DNS proves Cloudflare Email Routing; whether a routing rule
  exists for `support@` could not be determined from this machine and is an owner action.
- Four screens not composed; `/security` has no owner-approved reference.
- `docs/gap-register.md` carries stale rows; 13 ledger rows sit on borrowed ids; the
  `transport` column and webhook evidence reaching the evaluator remain deferred.
- Browser tabs on the owner's provider dashboards: not reachable from a fresh session's tab
  group, so the owner closes them.

## 9. Running jobs

None started by this session are still running. All background tasks (CI watches, release
chains, log tails) completed; their last outputs are in this session's scratchpad. To check the
platform: `gh run list --limit 5`; `curl -s https://verify.itisyou.app/health`; from `apps/app`,
`pnpm exec wrangler tail --env production --format json` (read-only). Stitch generations: none
known to this session (§5).
