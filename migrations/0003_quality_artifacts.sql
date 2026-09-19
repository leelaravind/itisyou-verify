-- Storage for the release evidence pack: test-report.md, test-results.json, junit.xml,
-- test-cases.json and release-readiness.md, produced by scripts/build-test-report.mjs.
--
-- D1 rather than the Worker's asset directory, deliberately. `apps/app/public` is served
-- to anyone, and these files name failing case ids, internal paths and infrastructure
-- detail — publishing them there would make "authenticated download" a fiction. D1 is
-- already bound, needs no new account resource, and the pack is small (the largest file
-- is around 270KB).
--
-- `part` exists so a growing suite cannot silently outgrow a row. The store writes
-- ordered parts and reassembles them on read, so a report that doubles in size next
-- month does not fail in a way nobody notices until they need the evidence.
--
-- Not a customer-scoped table: it holds our own release evidence, never a customer's
-- data, which is why it carries no workspace_id and does not appear in the tenant-scope
-- scan's table list.

CREATE TABLE quality_artifacts (
  id           TEXT NOT NULL,          -- 'test-report.md', 'junit.xml', …
  part         INTEGER NOT NULL,       -- 0-based ordinal; reassembled in order on read
  body         TEXT NOT NULL,
  commit_sha   TEXT,                   -- the candidate the pack describes
  generated_at TEXT,                   -- when the runner produced it
  uploaded_at  TEXT NOT NULL,
  PRIMARY KEY (id, part)
);

-- Serving a pack reads every part of one id in order.
CREATE INDEX idx_quality_artifacts_id ON quality_artifacts(id, part);

-- Finding the pack for a given release candidate.
CREATE INDEX idx_quality_artifacts_commit ON quality_artifacts(commit_sha);
