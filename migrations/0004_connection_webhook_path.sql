-- The opaque per-connection path segment a provider posts its callbacks to.
--
-- Without this there is no id-to-connection lookup, so the Resend webhook route can
-- never resolve an endpoint and a Resend connection can never reach `ready` — the
-- connector correctly refuses to treat a stored signing secret as evidence that
-- anything works.
--
-- Deliberately NOT derived from workspace_id or connection id. The path appears in a
-- URL the customer pastes into a third-party dashboard, so it travels further than any
-- of our other identifiers and must carry no information about who it belongs to. It is
-- generated at connect time with at least 128 bits of randomness.
--
-- It is not a credential: the route rejects an id it did not issue, and a valid
-- signature over an unknown id is still refused. The opaque id is a second gate, not the
-- only one — that lesson came from a finding where an unknown endpoint id was accepted
-- because the code rejected on the signature comparison rather than on the lookup result.
--
-- Nullable, because a connection exists before its endpoint does. SQLite permits many
-- NULLs under a UNIQUE index, so uniqueness binds only to issued ids.

ALTER TABLE connections ADD COLUMN webhook_path_id TEXT;

CREATE UNIQUE INDEX idx_connections_webhook_path ON connections(webhook_path_id);
