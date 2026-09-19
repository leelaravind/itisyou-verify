# Resilience evidence

The earlier backup-restoration claim was **withdrawn** on 19 September because its cited
evidence did not exist: the gap register said "recorded in the story" and the development
story contained no such event. A drill had been run, but the databases were deleted, no
test covered it, and the in-repo backup test was in-memory with a single tenant.

This document is the replacement. Every number below came from a command run against real
remote Cloudflare D1, and the commands are named so anyone can repeat them.

---

## 1. Isolated restore — **proven**

Run 19 September 2026 against real remote D1, not a local harness and not an in-memory
database.

### Method

1. `wrangler d1 export verify-itisyou-db-staging --remote` — the real staging database.
2. `wrangler d1 create verify-restore-drill` — an isolated database, never bound to any Worker.
3. `wrangler d1 execute verify-restore-drill --remote --file <export>` — the restore.
4. Staging is nearly empty (one workspace, no runs), so a restore of it proves only that the
   mechanism runs. **Two synthetic tenants with full referential structure were therefore
   seeded into the drill** — workspaces, workflows, workflow versions, source events, runs
   and evidence — and that database was exported and restored into a *second* isolated
   database, so the comparison is between two databases that both contain data.
5. Both drill databases deleted; `wrangler d1 list` confirms zero remaining.

Seeding had to satisfy the real schema, which refused the first attempt outright
(`NOT NULL constraint failed: workspaces.status`). Runs require a `workflow_version_id` and
a `source_event_id` under foreign keys; evidence requires a `content_digest`, a
`redacted_summary` and an `expires_at`. That refusal is worth recording: a restore drill
against a schema that would accept anything proves much less.

### Result

| Check | Source | Restored |
| --- | --- | --- |
| workspaces / runs / evidence / source_events | 3 / 3 / 3 / 3 | **3 / 3 / 3 / 3** |
| run statuses, in id order | `VERIFIED,UNVERIFIED,FAILED` | **`VERIFIED,UNVERIFIED,FAILED`** |
| evidence content digests | `digest_alpha_one,digest_alpha_two,digest_beta_one` | **identical** |
| schema objects | 42 tables | **42 tables** |

Cross-tenant checks on the **restored** copy:

| Check | Result |
| --- | --- |
| evidence rows whose workspace differs from their run's workspace | **0** |
| runs referencing a workspace that does not exist | **0** |
| evidence referencing a workspace that does not exist | **0** |
| per-tenant separation | `ws_drill_alpha` → 2 runs, `ws_drill_beta` → 1 run |

The status check matters more than the counts. A restore that preserved every row but
collapsed `UNVERIFIED` into `VERIFIED` would pass a row count and destroy the only thing
this product sells.

### What this does not prove

It does not prove a restore at volume — three runs is not three million. It does not prove
point-in-time recovery, only export-and-restore. And it was run against staging's schema;
production carries the same four migrations, but that is an inference from the migration
table rather than a second drill.

---

## 2. Outage behaviour — **proven by test, not yet by a live provider outage**

The engine's behaviour when a provider cannot be reached is covered and load-bearing:

- A provider that cannot be reached yields **UNVERIFIED, never FAILED** — `decide.ts`
  returns `UNVERIFIED_ACCESS` before any absence check runs, asserted by `VERIFY-100` and
  `VERIFY-153` at the deadline.
- A timeout is classified `PROVIDER_UNAVAILABLE` → `EVIDENCE_UNAVAILABLE`, and **never**
  `RECORD_NOT_FOUND` or `EVENT_NOT_OBSERVED` — the only two reasons permitted to turn a
  mandatory unknown into a failure.
- The customer-facing wording now says the gap is on our side rather than implying a fault
  in their automation.

**Honest limit:** no real provider outage has been observed, because no real provider
credential exists on this project. Every one of these is a scripted connector in the
harness. That is a genuinely weaker claim than a live outage and is recorded as such.

---

## 3. Rollback — **partially proven, and one caveat is disclosed**

Cloudflare Workers keeps every deployment version, and a rollback is a version switch
rather than a rebuild. `wrangler deployments list` shows the version history for both
environments, and the release script records the candidate commit on every deploy.

**The caveat, disclosed rather than discovered later:** a workflow version published with
the new `expected_from` binding would be `rules_unusable` under a deployment rolled back
past that contract change, because the rules schema object is `.strict()`. That degrades a
run to **UNVERIFIED**, never to a false pass — the safe direction — but it is a real
constraint on rolling back across that commit.

The same applies to migration `0002`: a Worker rolled back to before it must not write
credentials, because the CHECK constraint on the authenticated-data shape would reject the
older format. The recommendation on record is to accept that restriction rather than widen
the constraint, because widening would reopen the downgrade path the constraint exists to
close.

**Not yet done:** an actual rollback of a deployed environment followed by a probe. That is
the remaining piece of this section and it is not claimed.
