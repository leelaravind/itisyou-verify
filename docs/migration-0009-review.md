# Migration 0009, before it goes near production

`migrations/0009_workflow_admission_controls.sql`. Applied to **staging** on 23 September
2026 and verified there. **Not applied to production**, and this document exists so the
decision to apply it is made on facts rather than on my say-so. The earlier approval covered
a different, no-op migration and is not approval for this one.

## What it changes

Three `ALTER TABLE workflows ADD COLUMN` statements. Nothing else — no table is created,
dropped or rewritten, no index is added, no existing column is altered, and no row is
updated.

| Column | Type | Default | Meaning when NULL |
| --- | --- | --- | --- |
| `admissions_paused_at` | `TEXT` | none, so NULL | Admitting normally |
| `admission_limit_per_period` | `INTEGER` | none, so NULL | No ceiling beyond the plan |
| `usage_alert_key` | `TEXT` | none, so NULL | No usage warning announced yet |

**Every existing row gets NULL in all three, and NULL is the correct present-day value for
each.** No workflow has been paused, none has a customer ceiling, and none has had a usage
warning announced — because until this candidate none of those things could exist. There is
no backfill, and none is needed.

## Why it is low risk on SQLite/D1

`ADD COLUMN` with no `NOT NULL` and no default is a metadata-only change in SQLite: the
table is not rewritten and existing rows are not touched. It does not take a long lock and
its cost does not scale with row count. `workflows` currently holds one row on production.

## What reads and writes these columns

- `apps/app/src/db/admissionControls.ts` — reads the pause and the ceiling on the signed-event
  path.
- `apps/app/src/db/usageAlerts.ts` — reads and writes `usage_alert_key`.
- `apps/app/src/db/customerPort.ts` — reads all three for the workspace panel; writes the
  first two from the two new controls.

Every one of those statements is scoped by `workspace_id` in its predicate.

## Ordering: the migration must go first

The code reads these columns unconditionally. **Deploying the worker before applying the
migration would break `/app` and the signed-event route** with `no such column`, which is
exactly the failure the local Playwright run hit when the local database was a migration
behind. So the order is: apply the migration, then deploy. Not the reverse.

The converse is safe: applying the migration and *not* deploying leaves three unused columns
and changes no behaviour. That asymmetry is what makes this recoverable.

## Recovery

**If the migration is applied and the deploy is then abandoned**, nothing needs undoing. The
columns sit unread. The currently deployed worker does not mention them.

**If the deploy is applied and needs reverting**, redeploy the previous commit through the
existing gate. The columns stay; the old worker ignores them. No data is lost because none
of these columns holds anything the product cannot recompute or do without: a pause is a
switch the customer can set again, a ceiling likewise, and `usage_alert_key` only suppresses
a warning that would otherwise be sent again.

**If the columns themselves must go**, SQLite supports `ALTER TABLE workflows DROP COLUMN`
for columns with no index, constraint or generated dependency, which these have none of. It
is not expected to be needed, and I would not run it without asking.

### The one thing a rollback does not preserve, and what to do about it

A pause and a ceiling are **stored state that only the new code reads**. Roll the worker back
and the columns still hold what the customer set — but nothing consults them, so:

- a workspace the customer **paused** starts admitting again, and every admitted event is
  charged against their allowance;
- a workspace at a **ceiling** stops being capped and can run to the full plan allowance.

Neither is a data loss. It is worse in kind: usage resumes **without the customer's
intention**, and the first they would know is the bill.

So a rollback of this candidate is not a neutral act, and must not be treated as one.

**Before rolling back, run this and read the answer:**

```sql
SELECT id, workspace_id, admissions_paused_at, admission_limit_per_period
  FROM workflows
 WHERE admissions_paused_at IS NOT NULL
    OR admission_limit_per_period IS NOT NULL;
```

- **No rows.** Nobody has set either control. Roll back freely; the columns are inert.
- **Any rows.** Each one is a customer instruction the old code cannot honour. Do one of:
  1. **Preferred — do not roll back.** Fix forward. The controls are additive; a defect in
     them is unlikely to be worth resuming somebody's billing over.
  2. **Roll back and preserve the intention by other means.** For a paused workspace, that
     means stopping admission some other way before the old worker is live — there is no
     other customer-facing switch, so in practice this means telling the customer their
     pause is not in force, rather than pretending it is.
  3. **Roll back and accept it**, only if the affected customer has said they are content.

**Capture the rows before rolling back either way.** The query above, saved, is the record of
what each customer had asked for, and is what the settings are restored from when the
candidate is redeployed. The columns themselves survive a rollback untouched — it is only
their enforcement that stops — so restoring is a matter of redeploying, not of rewriting
data.

**This asymmetry is the reason to prefer fixing forward.** Applying the migration and not
deploying changes nothing. Deploying and rolling back changes whether customers are billed.

## What I am asking for

Approval to run, from `apps/app`:

```
npx wrangler d1 migrations apply verify-itisyou-db-production --env production --remote
```

then deploy `957bc1e` (or its successor) through `scripts/release.mjs` with its matching
gate artefact. Both steps, in that order.

## What has already been proved, and where

- Applied to staging and the three columns confirmed present on `workflows`.
- Staging serves the candidate: `/health` reports `957bc1e25abfa98ef6dd703993251251c7501f03`.
- 2860 vitest cases pass, including the admission controls through the real signed-event
  route (`BILL-901..911`) and the alert wiring.
- The controls render and fit at 390px and 1440px (`CUST-969`, Playwright, real viewport).
