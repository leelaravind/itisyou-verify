# Release verification — independent, from the outside

**Verifier:** independent release verifier, read-only. **Recorded:** 2026-09-20, 07:29–07:36Z.
**Repository HEAD at start:** `3a7924c`; **HEAD moved to `ac35a26` at 07:31Z** while these passes ran.
Working tree carried 16 modified and 3 untracked files throughout (none of them the files inspected in Pass 1).
**Database read:** staging D1 `verify-itisyou-db-staging` (`b680f037-…`), SELECT only, via the Cloudflare MCP. Nothing was written, nothing was deployed, production was not queried.

Verdicts: **CONFIRMED** = reproduced from evidence I gathered myself · **REFUTED** = evidence contradicts the claim · **COULD NOT VERIFY** = no evidence available to me either way.

---

## Pass 1 — Payment path, reproduced from the staging database and HEAD

| Claim | Evidence checked | Verdict | Note |
| --- | --- | --- | --- |
| One activation exists for the paid workspace | `SELECT * FROM subscriptions` → **1 row**: `sub_01M2YPZ02Y…`, `workspace_id=ws_automation_test`, `status='active'`, `environment='test'`, `provider_subscription_id=sub_1UHa1q…`, `provider_event_created=1789869535` (=01:58:55Z), `updated_at=06:09:55.521Z`, `reconciled_at=07:30:39Z`. `billing_customers` → 1 row (`cus_VIAI…`, created 01:55:08Z). `orders` 1, `refunds` 0, `workspaces` 1. | **CONFIRMED** | Exactly one subscription, active. `updated_at` is 162 ms after receipt `whr_01M2YPYZ…` was received (06:09:55.359Z), which ties the activation to a webhook delivery rather than a hand edit. |
| One allowance exists for the paid workspace | `SELECT * FROM entitlements` → **2 rows**, both `ws_automation_test`: (a) `ent_slice_0001` · `billing_period=2026-10-19` · `run_limit=10` · `consumed=3` · `updated_at=2026-09-19T22:00:55Z`; (b) `ent_01M2YPVQ3W…` · `billing_period=2026-10-20` · `run_limit=500` · `consumed=11` · `updated_at=2026-09-20T07:20:39Z`. | **REFUTED as stated** | Two entitlement rows, not one. Row (b) is the Stripe-created allowance: its ULID sits milliseconds after receipt `whr_01M2YPVPQM…` (06:08:08Z), its period matches the subscription's `current_period_end` date, and `consumed` moved to 11 at 07:20:39Z — the tick that decided today's runs — so the runtime is drawing from it. Row (a) predates today's events by eight hours, has a hand-shaped id that appears nowhere in the tracked tree (`git grep ent_slice_0001` → nothing), and sits in a period no subscription has. It was not created by Stripe. It is inert today (`updated_at` yesterday) but it is a second allowance on the paid workspace, and `period.ts:30` records that two rows under `UNIQUE (workspace_id, billing_period)` has been a real bug before. |
| Receipts show exactly one row per distinct Stripe event id | `SELECT * FROM webhook_receipts WHERE provider='stripe'` → **3 rows**, `event_id` = `evt_1UHa1s…Aw6GJ8UC` (06:08:08Z), `…FNvu2DCz` (06:09:55Z), `…fBiSDXSK` (06:10:11Z); all `processing_status='processed'`; `COUNT(DISTINCT event_id)`=3. Schema: `UNIQUE (provider, event_id)`. 11 receipts across all providers. | **CONFIRMED** | No duplicate row exists and the schema forbids one. The three ids share Stripe's creation stamp (`1UHa1s` ≈ 01:58Z) and were received at 06:08–06:10Z, consistent with "resent this morning". |
| A replay did not add a second row | As above; no `duplicate` rows present. Route code (`stripe.ts` step 5) answers a replay with `200 {duplicate:true}` and writes nothing. | **CONFIRMED (no second row) / COULD NOT VERIFY (that a replay was attempted)** | The database cannot show whether a replay was ever sent; it can only show that none landed. |
| Guard: configured values trimmed | `git show HEAD:apps/app/src/billing/mount.ts` lines 130, 170, 171, 186, 252 — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_PATH_ID`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_UNKNOWN_KEY` each `.trim()`ed where read; supplied `opaqueId` deliberately not trimmed. Working tree identical to HEAD for this file. | **CONFIRMED** | Committed in `c9267bc`; lint fix in `9649ecb`. |
| Guard: a log is supplied to the webhook route | `mount.ts:234-238` `defaultWebhookLog` → `console.warn('stripe_webhook', entry)`; `mount.ts:256` `log: parts.log ?? defaultWebhookLog`. `stripe.ts` still falls back to a no-op if `deps.log` is undefined, but the deps assembler always supplies one. | **CONFIRMED** | |
| Guard: workspace-existence check before writing | **Not in `mount.ts` or `stripe.ts`.** Present in `apps/app/src/billing/events.ts:142` (`checkout.session.completed` → `checkout_for_unknown_workspace`) and `:261` (subscription events → `subscription_for_unknown_workspace`), both via `data.workspaceExists()` before any write; port method at `port.ts:151`, D1 impl in `db/billingPort.ts`. Working tree identical to HEAD. | **CONFIRMED (with location corrected)** | Committed in `47873e9`. If the handover names `mount.ts`/`stripe.ts` as the location, that is wrong; the guard lives in the event handlers. |

## Pass 2 — Workflow path, reproduced from `runs`, `assertions`, `evidence`

All four runs: `workspace_id=ws_automation_test`, `workflow_id=wf_slice_proof_0001`, `is_synthetic=0`, `observation_count=1`, `runs.revision=4`, assertions at `revision=2` (I did not establish what `runs.revision` counts; noting the mismatch, not calling it a defect).

| Run | Claimed | `runs.status` | Assertions (rule → status / reason · expected → observed) | Evidence row | Verdict |
| --- | --- | --- | --- | --- | --- |
| `run_01M2YTSKKM2DC653F9BA114937` | VERIFIED, HubSpot read-back | **VERIFIED** (decided 07:20:39Z) | `crm_correlation_matches` → SUPPORTED / MATCHED · `ENQ-MATCH-0001` → `ENQ-MATCH-0001`; `crm_record_exists` → SUPPORTED / MATCHED · present → `871054966976`; both cite `evd_01M2YV0J4V…` | `evd_01M2YV0J4V8DE1619E3F41482C` · **`provider='hubspot'`** · **`origin='provider_readback'`** · `provider_record_id=871054966976` · observed 07:20:39Z | **CONFIRMED** |
| `run_01M2YTSKRX1960E7D29C38477E` | FAILED, VALUE_MISMATCH, evidence hubspot/provider_readback, correlation CONTRADICTED not UNKNOWN | **FAILED** (decided 07:20:39Z) | `crm_correlation_matches` → **CONTRADICTED / VALUE_MISMATCH** · `ENQ-OTHER-9999` → `ENQ-MATCH-0001` · `observed_at=07:14:10.833Z`; `crm_record_exists` → SUPPORTED / MATCHED · present → `871054966976`; both cite `evd_01M2YV0MN4…` | `evd_01M2YV0MN4FB9D3EA8136243BB` · **`provider='hubspot'`** · **`origin='provider_readback'`** · `provider_record_id=871054966976` · observed 07:20:39Z | **CONFIRMED** — the claim that matters most holds on the row values |
| `run_01M2YT605AA5897F63C1C44F76` | UNVERIFIED, CONNECTION_UNAVAILABLE | **UNVERIFIED** (deadline 07:07:11Z, decided 07:10:39Z) | both rules → UNKNOWN / CONNECTION_UNAVAILABLE · `observed_display=null` · `evidence_id=null` | none | **CONFIRMED** |
| `run_01M2YS2Z45DE24EF1E8F2B41B0` | FAILED, RECORD_NOT_FOUND | **FAILED** (deadline 06:48:03Z, decided 06:50:39Z) | both rules → UNKNOWN / RECORD_NOT_FOUND · `observed_display=null` · `evidence_id=null` | none | **CONFIRMED** |

`docs/workflow-evidence.md` names staging Worker version `432f4500…` uploaded 06:05:37Z; Cloudflare reports `verify-itisyou-staging` `modified_on=2026-09-20T06:05:42Z`. Consistent.

## Pass 3 — Release gate reality

Gates run locally at 07:31:23Z on the **dirty working tree** (16 modified, 3 untracked); HEAD was `3a7924c` when they started and `ac35a26` before they finished. These are readings of a working tree, not properties of a commit — the ledger checker says so itself.

| Gate | Verbatim tail | Exit |
| --- | --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | *(no output)* | 0 |
| `npx eslint . --max-warnings=0` | *(no output)* | 0 |
| `npx vitest run` | ` Test Files  179 passed \| 1 skipped (180)` · `      Tests  2705 passed \| 3 skipped (2708)` · `   Start at  08:31:27` · `   Duration  19.52s (transform 30.03s, setup 6.05s, import 92.59s, tests 69.91s, environment 88ms)` | 0 |
| `node scripts/verify-test-cases.mjs --strict` | `Ledger integrity: PASS` · `A sound ledger proves the count is honest. It does not make a failing suite green.` · `These totals are a reading of a working tree at ac35a269e3ef, 19 uncommitted change(s) — not a gate result.` (passing 2629 countable; ledger 2761 / tree 2742 / in ledger not tree 19) | 0 |
| `node scripts/scan-claims.mjs` | `scan:claims — clean. 65 public-surface file(s) scanned.` · `461 tracked file(s) out of scope` · `5 line(s) exempted by "claim-scan:allow"` · `WARNING: no rendered output was scanned. Pass --paths <dir> with the served HTML. Source is a proxy; what was served is the measurement.` · `Note: this proves no BANNED phrase is present. It does not prove the remaining claims are true.` | 0 |
| `node scripts/scan-secrets.mjs` | `scan:secrets — clean. 712 tracked files.` | 0 |

| Claim | Evidence checked | Verdict | Note |
| --- | --- | --- | --- |
| `release.mjs` refuses an artefact with `runners.playwright.stats.unexpected > 0` | HEAD `ac35a26` (and `3a7924c`): `const pw = artefact.runners?.playwright; if (pw?.executed === true) { … if (unexpected > 0) complain(…) …` | **CONFIRMED** | Added in `e9f6d0e`. |
| …with `flaky > 0` | same block: `if (flaky > 0) complain(…)` | **CONFIRMED** | |
| …with no browser run | `else { complain('the gate artefact records no browser run at all…') }` | **CONFIRMED** | |
| The refusal is a refusal | `complain()` **throws only when `--env production`**; for staging it prints `note (staging is advisory): …` and continues. | **CONFIRMED for production only** | A staging release with a red browser suite still proceeds. That is the script's stated design, but "the gate refuses" is true of production alone. Also new at `ac35a26`: production requires HEAD to be an ancestor of `origin/main` (fetches first). |
| `reports/release-gate.json` is a current, passing artefact | Local file: `commit_sha=e0aa820…`, `produced_at=06:18:12Z`, `produced_by=github-actions`, `tree_clean=true`, `accounting.failing=0`, `gate.met=true`, **`runners.playwright.stats = {expected:12, skipped:26, unexpected:3, flaky:0}`**. Not tracked by git (no history). | **REFUTED** | The artefact on disk is the one the lead's own comment cites as the failure case: three browser cases failed and the gate did not see them. Fed to `release.mjs --env production` today it is refused twice over — wrong commit, and `unexpected: 3`. |
| CI artefacts for the fix commits are green | Downloaded `release-gate-e9f6d0e…` and `release-gate-3a7924c…` from CI runs 35496636593 / 35496846129: both `produced_by=github-actions`, `tree_clean=true`, `citable=2621`, `gate.met=true`, `floors_met=true`, `ledger.checker_exit_code=0`, vitest 2681 passed / 0 failed, **playwright `expected:15, unexpected:0, flaky:0`**. | **CONFIRMED** | Neither has been copied into `reports/`. CI for `ac35a26` (run 35497115333) also succeeded; its artefact was not downloaded. |

## Pass 4 — Public claims, live (fetched 07:31:18Z, header `x-verify-internal: probe`)

| Page | HTTP | "never run against a live account" | "have not yet been run against a real account" | "proven against mocks" | "credentials do not exist" |
| --- | --- | --- | --- | --- | --- |
| `/` | 200 | 0 | **1** | 0 | 0 |
| `/how-it-works` | 200 | 0 | **1** | 0 | 0 |
| `/demo` | 200 | 0 | **1** | 0 | 0 |
| `/security` | 200 | 0 | **1** | 0 | 0 |
| `/development-story/visual` | 200 | 0 | 0 | **2** | **1** |
| `/health` | 200 | 0 | 0 | 0 | 0 |

| Claim | Evidence checked | Verdict | Note |
| --- | --- | --- | --- |
| The false claims are fixed in source | At `e0aa820`: `packages/ui/src/content/site.ts:126` headline `'Our HubSpot and Resend connectors have not yet been run against a real account'`; `apps/app/src/routes/public/story/narrative.ts:690` body `'…those credentials do not exist yet — until they do, the connector path is proven against mocks…'` and `:581`. At HEAD: none of the four phrases appears in `apps/` or `packages/` except inside comments explaining their removal. Removed by `3a7924c` (07:25Z; CI success). "never run against a live account" was removed earlier by `a220707` (03:57Z). | **CONFIRMED (committed)** | |
| The fixes are deployed | Served pages above still carry the `3a7924c`-removed phrases: 1 hit on each of four pages, 3 hits on the story page. The `a220707` phrase is gone from all six pages. | **REFUTED — not deployed** | Production is serving pre-`3a7924c` content. |
| `/health` returns a `commit` field | Body: `{"service":"itisyou-verify","environment":"production","database":"reachable","checked_at":"2026-09-20T07:31:18.026Z"}` (custom domain); identical shape on `verify-itisyou-production.kpleelaaravind.workers.dev` and on staging. | **REFUTED — no `commit` field** | The field exists in source (`index.ts:444`, `d4fc79f`) and the injection in `release.mjs`; neither deployment has it. |
| Production is at HEAD | `git rev-parse HEAD` = `ac35a26` (07:31Z). Cloudflare `verify-itisyou-production` `modified_on=2026-09-20T06:20:27Z`; staging `06:05:42Z`. Seven commits are later than the production upload: `47873e9` 06:28Z, `d4fc79f` 06:44Z, `121214d` 06:52Z, `d44cdf5` 06:59Z, `e9f6d0e` 07:21Z, `3a7924c` 07:25Z, `ac35a26` 07:31Z. | **REFUTED — production is behind by at least 7 commits** | Which commit production *is* cannot be observed (no `commit` in `/health`, no version message). Inference only: the sole commit between 06:16Z and 06:28Z is `e0aa820`, the local gate artefact is for `e0aa820`, and the served phrases match `e0aa820` source. Staging by the same inference is `9649ecb`. |
| The probe header kept me out of the visitor count | `growth/visits.ts:150-154` accepts the header only when its value `timingSafeEqual`s the `INTERNAL_TEST_TOKEN` secret (`index.ts:333`); the literal `probe` is not that value. | **COULD NOT VERIFY — most likely not excluded** | Assume these eight fetches were counted as visits if `ANALYTICS_SALT` is set in production. |

## Pass 5 — The four states

No deploy workflow exists in `.github/workflows/` (only `ci.yml`, which states deployment is manual). "Deployed" therefore rests on Cloudflare's `modified_on` timestamps (production 06:20:27Z, staging 06:05:42Z), never on CI. "Production verified" means observed on the live service by me.

| Fix | Commit(s) | Code fixed | CI passed | Deployed to production | Production verified |
| --- | --- | --- | --- | --- | --- |
| Webhook trim | `c9267bc` 06:00Z (mount.ts) + `9649ecb` 06:00:44Z (lint) | **Yes** — `mount.ts` lines 130/170/171/186/252 at HEAD | `c9267bc` **FAILED** (run 35492952030: `Unexpected console statement… mount.ts#235`); `9649ecb` **success** (35493114747) | **Inferred yes** — production uploaded 06:20:27Z, after 06:00:44Z; not provable (no `commit` in `/health`) | **COULD NOT VERIFY** on production. Indirect evidence on *staging* only: three real Stripe events were accepted and processed at 06:08–06:10Z on a Worker uploaded 06:05:42Z. |
| Webhook log | same commits | **Yes** — `mount.ts:234-256` | as above | **Inferred yes**, same basis | **COULD NOT VERIFY** — no log access from here |
| Unknown-workspace guard | `47873e9` 06:28Z | **Yes** — `events.ts:142`, `:261` | **success** (35494318342) | **No** — commit is 8 min after the production upload; 23 min after staging's | **Not deployed**, so not verifiable |
| Version marker (`/health.commit`, `--var COMMIT_SHA`) | `d4fc79f` 06:44Z | **Yes** — `index.ts:444`, `release.mjs` deploy step | **success** (35495031380) | **No** | **REFUTED live** — `/health` has no `commit` on production or staging |
| Browser gate in `release.mjs` | `e9f6d0e` 07:21Z (+ `ac35a26` 07:31Z origin/main check) | **Yes** — three `complain()` branches at HEAD | **success** (35496636593; artefact playwright 15/0/0); `ac35a26` success (35497115333) | **n/a — a release-time script, not deployed code. Not yet exercised by any production release.** | **Not exercised.** The artefact on disk (`e0aa820`, `unexpected:3`) is one it would refuse. |
| False-claim corrections | `a220707` 03:57Z (story diagram), `40b59fc` 03:36Z (docs only), `3a7924c` 07:25Z (site.ts headline, narrative.ts body, story md) | **Yes** — phrases absent from `apps/`/`packages/` at HEAD | all **success** (35487901039, 35487141069, 35496846129) | `a220707`: **inferred yes**; `3a7924c`: **No** | `a220707` phrase: **CONFIRMED absent** on all six pages. `3a7924c` phrases: **REFUTED — still served** (4 pages × "have not yet been run against a real account"; story page × "proven against mocks" ×2, "credentials do not exist" ×1). |
| Rule 7 visit classification | `a77290d` 04:01Z (`growthPort.ts`, `growth/memory.ts`, `growth/port.ts`) | **Yes** | **success** (35488099710) | **Inferred yes** — 06:20:27Z upload is after 04:01Z | **COULD NOT VERIFY** — would need a production DB read or a behavioural probe; neither permitted/available |

---

## Everything I could not verify, and why

1. **Which commit production (and staging) is actually running.** `/health` carries no `commit`, Cloudflare exposes only `modified_on`, and the version-message injection is in a commit that has not been deployed. `e0aa820` / `9649ecb` are timestamp inferences, not observations.
2. **That the webhook trim, webhook log, `a220707` correction and rule-7 fix are on production.** Their commits predate the 06:20:27Z upload, but "deployed" here is the same inference as item 1. Only the `a220707` phrase removal was confirmed on the live pages.
3. **That the webhook log, trim and rule-7 behaviour work on production.** No production log access, no production DB access (by instruction), and no observable side effect from outside.
4. **That a replay of a Stripe event was actually sent.** The receipts table records first deliveries only; a replay produces a 200 and no row, so the database cannot distinguish "replayed and deduplicated" from "never replayed".
5. **Who or what created `ent_slice_0001`** (the second entitlement row on the paid workspace). Its id appears nowhere in the tracked tree; its `updated_at` is 2026-09-19T22:00:55Z. It was not Stripe.
6. **That my probe requests were excluded from the visitor count.** The header must match the `INTERNAL_TEST_TOKEN` secret; `probe` does not.
7. **What `runs.revision = 4` versus `assertions.revision = 2` means** for the four runs. Consistent across all four; not established as right or wrong.
8. **The release-gate artefact for `ac35a26`.** CI succeeded; I did not download it. `reports/release-gate.json` on disk is for `e0aa820` and would be refused for production.
9. **The local gate results as properties of a commit.** All six gates passed, on a dirty tree whose HEAD moved mid-run. CI's artefacts for `e9f6d0e` and `3a7924c` are the citable numbers, not these.
