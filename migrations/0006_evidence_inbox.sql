-- Authenticated provider callbacks that could not yet be bound to a run.
--
-- A delivery event can legitimately arrive before the run it belongs to: the customer's
-- automation sends the email, the provider fires `email.sent` within milliseconds, and the
-- signed source event describing the enquiry arrives after. Discarding that callback throws
-- away the only record that the message was ever delivered; attaching it to whichever run
-- happens to be open attaches it to somebody else's enquiry. Neither is acceptable, so it
-- is parked here instead, addressed by the provider's own message id, and claimed later by
-- the run that turns out to be waiting for it.
--
-- Everything in this table has already had its signature verified. An unauthenticated
-- callback never reaches it.
--
-- Bounded three ways, because an inbox nobody empties is a disk-filling service:
--   * `expires_at`  -- swept on the same retention schedule as evidence.
--   * a per-workspace row cap enforced on write, oldest evicted first.
--   * `UNIQUE (workspace_id, provider, provider_event_id)` -- a provider replaying the
--     same delivery writes one row, so a retry storm cannot inflate it.
CREATE TABLE evidence_inbox (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id      TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  -- The provider's id for the CALLBACK. Used for deduplication.
  provider_event_id  TEXT NOT NULL,
  -- The provider's id for the MESSAGE. This is what a run is matched on, and the only
  -- reason this row can ever be claimed.
  message_id         TEXT NOT NULL,
  -- Why it could not be bound when it arrived: `unmatched` or `ambiguous`. Kept apart on
  -- purpose; an ambiguous callback must never later be claimed as though it were merely
  -- early, so only `unmatched` rows are eligible for claiming.
  reason             TEXT NOT NULL CHECK (reason IN ('unmatched', 'ambiguous')),
  content_digest     TEXT NOT NULL,
  redacted_summary   TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  claimed_at         TEXT,
  claimed_run_id     TEXT,
  UNIQUE (workspace_id, provider, provider_event_id)
);

-- The claim path: one workspace, one message id, not yet claimed, not expired.
CREATE INDEX idx_evidence_inbox_claim
  ON evidence_inbox (workspace_id, message_id, claimed_at);

-- The eviction and retention paths both sweep oldest-first within a workspace.
CREATE INDEX idx_evidence_inbox_age ON evidence_inbox (workspace_id, received_at);
