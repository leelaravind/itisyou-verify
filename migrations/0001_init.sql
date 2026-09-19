-- ITISYOU Verify — initial schema (D1 / SQLite).
-- Invariants: every customer-scoped row carries workspace_id; the application layer
-- enforces tenant scope on every read and write (plan §15). Times are ISO-8601 UTC strings.
-- Money is integer minor units. Never add a REAL column for money.

-- ---------- identity ----------

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  auth_subject      TEXT NOT NULL UNIQUE,   -- normalised email for magic-link identity
  display_name      TEXT,
  is_platform_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_platform_owner IN (0,1)),
  totp_secret_ref   TEXT,                   -- reference into credential_versions, never the secret
  totp_enrolled_at  TEXT,
  created_at        TEXT NOT NULL,
  disabled_at       TEXT
);

CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active','paused','suspended','deleted')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  retention_policy_version INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('workspace_admin','workspace_viewer')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invitations (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  intended_email TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('workspace_admin','workspace_viewer')),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  redeemed_at    TEXT
);
CREATE INDEX idx_invitations_ws ON invitations(workspace_id);

-- Opaque, revocable server-side sessions. No long-lived token ever reaches localStorage.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,         -- hash of the cookie value, not the value itself
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  mfa_verified_at TEXT,                     -- recent strong auth gate for owner actions
  is_automation   INTEGER NOT NULL DEFAULT 0 CHECK (is_automation IN (0,1)),
  revoked_at      TEXT,
  user_agent_hash TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('signin','invite','owner_bootstrap')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_tokens_expiry ON login_tokens(expires_at);

-- ---------- connections and credentials ----------

CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('hubspot','resend')),
  external_account_id TEXT,
  status              TEXT NOT NULL CHECK (status IN
                        ('not_connected','authorising','testing','ready','degraded','expired','revoked','unsupported')),
  scopes              TEXT NOT NULL DEFAULT '[]',
  last_check_at       TEXT,
  last_error_code     TEXT,
  created_at          TEXT NOT NULL,
  revoked_at          TEXT,
  UNIQUE (workspace_id, provider)
);
CREATE INDEX idx_connections_ws ON connections(workspace_id);

-- Ciphertext only. Never serialised through any API. Key material lives in Worker secrets.
CREATE TABLE credential_versions (
  id            TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  owner_scope   TEXT NOT NULL,              -- 'connection:<id>' or 'user:<id>' for TOTP
  key_version   INTEGER NOT NULL,
  ciphertext    TEXT NOT NULL,              -- base64 AES-GCM
  nonce         TEXT NOT NULL,              -- base64 12-byte IV
  aad           TEXT NOT NULL,              -- bound context: workspace+provider+purpose
  created_at    TEXT NOT NULL,
  retired_at    TEXT
);
CREATE INDEX idx_credver_scope ON credential_versions(owner_scope, retired_at);

-- ---------- workflows ----------

CREATE TABLE workflows (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft','active','paused','archived')),
  current_version_id TEXT,
  coverage_mode      TEXT NOT NULL CHECK (coverage_mode IN ('customer_triggered','independently_sourced')),
  signing_key_hash   TEXT,                  -- hash of the workflow event-signing key
  signing_key_ref    TEXT,                  -- credential_versions id holding the encrypted key
  last_event_at      TEXT,
  expected_activity  TEXT,                  -- drives the distinct inactivity warning
  created_at         TEXT NOT NULL,
  archived_at        TEXT
);
CREATE INDEX idx_workflows_ws ON workflows(workspace_id, status);

-- Immutable once created. Edits create a new version; past runs keep their own.
CREATE TABLE workflow_versions (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL,
  version_number   INTEGER NOT NULL,
  rules_json       TEXT NOT NULL,           -- validated WorkflowRules
  rules_hash       TEXT NOT NULL,
  deadline_seconds INTEGER NOT NULL,
  schema_version   INTEGER NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (workflow_id, version_number)
);

-- ---------- runs and evidence ----------

CREATE TABLE source_events (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id          TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('signed_customer_event','synthetic_demo','owner_test')),
  external_event_id    TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  correlation_key_hash TEXT NOT NULL,
  payload_hash         TEXT NOT NULL,
  payload_json         TEXT NOT NULL,       -- minimal validated envelope, not the raw request
  UNIQUE (workspace_id, external_event_id)
);
CREATE INDEX idx_source_events_wf ON source_events(workflow_id, received_at);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id         TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  source_event_id     TEXT NOT NULL UNIQUE REFERENCES source_events(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','FAILED','UNVERIFIED')),
  revision            INTEGER NOT NULL DEFAULT 1,
  observation_count   INTEGER NOT NULL DEFAULT 0,
  deadline_at         TEXT NOT NULL,
  next_check_at       TEXT,                 -- NULL means terminal; the scheduler ignores it
  is_synthetic        INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at          TEXT NOT NULL,
  completed_at        TEXT
);
-- The single indexed due-job query. Bounded batch, never a full tenant scan.
CREATE INDEX idx_runs_due ON runs(next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX idx_runs_ws_created ON runs(workspace_id, created_at DESC);
CREATE INDEX idx_runs_wf_created ON runs(workflow_id, created_at DESC);

CREATE TABLE run_attempts (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL,
  attempt_number   INTEGER NOT NULL,
  lease_id         TEXT,
  lease_expires_at TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  outcome          TEXT,
  error_code       TEXT,
  UNIQUE (run_id, attempt_number)
);
CREATE INDEX idx_attempts_lease ON run_attempts(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

CREATE TABLE assertions (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  rule_id          TEXT NOT NULL,
  label            TEXT NOT NULL,
  mandatory        INTEGER NOT NULL CHECK (mandatory IN (0,1)),
  status           TEXT NOT NULL CHECK (status IN ('PENDING','SUPPORTED','CONTRADICTED','UNKNOWN')),
  reason_code      TEXT NOT NULL,
  expected_display TEXT,
  observed_display TEXT,
  observed_at      TEXT,
  evidence_id      TEXT,
  UNIQUE (run_id, revision, rule_id)
);
CREATE INDEX idx_assertions_run ON assertions(run_id, revision);

CREATE TABLE evidence (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  origin             TEXT NOT NULL CHECK (origin IN ('provider_readback','provider_webhook','customer_claim')),
  provider_record_id TEXT,
  observed_at        TEXT NOT NULL,
  content_digest     TEXT NOT NULL,
  redacted_summary   TEXT NOT NULL,         -- masked values only; never a whole provider payload
  expires_at         TEXT NOT NULL
);
CREATE INDEX idx_evidence_run ON evidence(run_id);
CREATE INDEX idx_evidence_expiry ON evidence(expires_at);

CREATE TABLE webhook_receipts (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  connection_id     TEXT,
  workspace_id      TEXT,
  event_id          TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('received','processed','ignored','invalid','duplicate')),
  UNIQUE (provider, event_id)
);
CREATE INDEX idx_webhook_receipts_ws ON webhook_receipts(workspace_id, received_at);

-- Bridges the DB-commit / job-dispatch boundary. Tolerates duplicate delivery.
CREATE TABLE outbox (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT,
  event_type       TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  unique_event_key TEXT NOT NULL UNIQUE,
  payload_json     TEXT NOT NULL,
  dispatch_state   TEXT NOT NULL CHECK (dispatch_state IN ('pending','dispatched','failed','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,
  last_error       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_outbox_due ON outbox(next_attempt_at) WHERE dispatch_state = 'pending';

-- ---------- commerce ----------

CREATE TABLE billing_customers (
  workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  environment        TEXT NOT NULL CHECK (environment IN ('test','live')),
  created_at         TEXT NOT NULL,
  UNIQUE (stripe_customer_id, environment)
);

CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN
                        ('draft','compatible','rejected','checkout_created','payment_pending','active',
                         'expired','failed','cancelled','refunded')),
  rejection_reason    TEXT,
  price_id            TEXT,
  amount_minor        INTEGER,
  currency            TEXT,
  checkout_session_id TEXT,
  idempotency_key     TEXT UNIQUE,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_orders_ws ON orders(workspace_id, created_at DESC);

CREATE TABLE subscriptions (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_subscription_id TEXT NOT NULL,
  environment              TEXT NOT NULL CHECK (environment IN ('test','live')),
  status                   TEXT NOT NULL,
  price_id                 TEXT,
  current_period_end       TEXT,
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  reconciled_at            TEXT,
  -- monotonic guard: an older provider event may never overwrite a newer state
  provider_event_created   INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL,
  UNIQUE (provider_subscription_id, environment)
);
CREATE INDEX idx_subs_ws ON subscriptions(workspace_id);

CREATE TABLE entitlements (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  billing_period TEXT NOT NULL,
  plan_version   INTEGER NOT NULL,
  run_limit      INTEGER NOT NULL,
  consumed       INTEGER NOT NULL DEFAULT 0,
  reserved       INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, billing_period)
);

CREATE TABLE refunds (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id           TEXT,
  provider_refund_id TEXT,
  amount_minor       INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN
                       ('requested','queued_for_owner','submitted','pending','succeeded','failed','rejected')),
  reason             TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  approval_id        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_refunds_ws ON refunds(workspace_id, created_at DESC);

-- ---------- budget ----------

CREATE TABLE budget_accounts (
  id                     TEXT PRIMARY KEY,
  scope                  TEXT NOT NULL UNIQUE,
  currency               TEXT NOT NULL,
  authorised_limit_minor INTEGER NOT NULL,
  spent_minor            INTEGER NOT NULL DEFAULT 0,
  reserved_minor         INTEGER NOT NULL DEFAULT 0,
  committed_minor        INTEGER NOT NULL DEFAULT 0,
  safety_buffer_minor    INTEGER NOT NULL DEFAULT 0,
  revision               INTEGER NOT NULL DEFAULT 1,
  updated_at             TEXT NOT NULL
);

CREATE TABLE budget_entries (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES budget_accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('reserve','release','spend','commit','uncommit','credit')),
  amount_minor    INTEGER NOT NULL,
  source          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  reconciled_at   TEXT
);
CREATE INDEX idx_budget_entries_acct ON budget_entries(account_id, created_at DESC);

-- ---------- owner operations ----------

CREATE TABLE approvals (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL REFERENCES users(id),
  action_type            TEXT NOT NULL,
  canonical_payload_hash TEXT NOT NULL,
  maximum_amount_minor   INTEGER,
  currency               TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('granted','consumed','expired','revoked')),
  note                   TEXT,
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  consumed_at            TEXT
);
CREATE INDEX idx_approvals_lookup ON approvals(action_type, canonical_payload_hash, status);

CREATE TABLE campaigns (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  external_id           TEXT,
  state                 TEXT NOT NULL,
  approved_payload_hash TEXT,
  approval_id           TEXT,
  packet_json           TEXT NOT NULL,
  budget_minor          INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  starts_at             TEXT,
  ends_at               TEXT,
  last_sync_at          TEXT,
  last_sync_error       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE campaign_metrics (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  interval_start TEXT NOT NULL,
  interval_end   TEXT NOT NULL,
  impressions    INTEGER,
  clicks         INTEGER,
  spend_minor    INTEGER,
  currency       TEXT,
  received_at    TEXT NOT NULL,
  UNIQUE (campaign_id, interval_start, interval_end)
);

CREATE TABLE notification_deliveries (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT,
  notification_key TEXT NOT NULL UNIQUE,
  channel          TEXT NOT NULL,
  recipient_hash   TEXT NOT NULL,
  template         TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending','sent','failed','suppressed')),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  provider_status  TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT
);
CREATE INDEX idx_notif_ws ON notification_deliveries(workspace_id, created_at DESC);

CREATE TABLE audit_events (
  id                TEXT PRIMARY KEY,
  actor             TEXT NOT NULL,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('user','system','provider','runner','automation')),
  workspace_id      TEXT,
  action            TEXT NOT NULL,
  target            TEXT,
  request_id        TEXT,
  occurred_at       TEXT NOT NULL,
  redacted_metadata TEXT
);
CREATE INDEX idx_audit_time ON audit_events(occurred_at DESC);
CREATE INDEX idx_audit_ws ON audit_events(workspace_id, occurred_at DESC);

CREATE TABLE support_cases (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT,
  contact_email TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body_redacted TEXT NOT NULL,
  category      TEXT NOT NULL,
  priority      TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  state         TEXT NOT NULL CHECK (state IN ('open','awaiting_owner','answered','escalated','closed')),
  linked_run_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_support_state ON support_cases(state, created_at DESC);

-- ---------- maintenance runner ----------

CREATE TABLE runner_devices (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id),
  label              TEXT NOT NULL,
  public_key         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending_pair','active','revoked')),
  pairing_code_hash  TEXT,
  pairing_expires_at TEXT,
  last_heartbeat_at  TEXT,
  created_at         TEXT NOT NULL,
  revoked_at         TEXT
);

CREATE TABLE maintenance_jobs (
  id               TEXT PRIMARY KEY,
  typed_kind       TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 5,
  approval_id      TEXT,
  state            TEXT NOT NULL CHECK (state IN
                     ('queued','awaiting_runner','leased','running','passed','failed','cancelled','timed_out','infrastructure_error')),
  lease_device_id  TEXT,
  lease_nonce      TEXT,
  lease_expires_at TEXT,
  result_json      TEXT,
  requested_by     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_maint_state ON maintenance_jobs(state, created_at);

-- ---------- quality centre, cleanup, analytics, settings ----------

CREATE TABLE quality_runs (
  id          TEXT PRIMARY KEY,
  suite_id    TEXT NOT NULL,
  environment TEXT NOT NULL,
  executor    TEXT NOT NULL CHECK (executor IN ('hosted','github_actions','local_runner')),
  state       TEXT NOT NULL CHECK (state IN
                ('queued','awaiting_runner','running','passed','failed','cancelled','timed_out','infrastructure_error')),
  commit_sha  TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  total_cases INTEGER,
  passed      INTEGER,
  failed      INTEGER,
  skipped     INTEGER,
  started_at  TEXT,
  ended_at    TEXT,
  report_ref  TEXT,
  limitations TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE cleanup_runs (
  id             TEXT PRIMARY KEY,
  state          TEXT NOT NULL CHECK (state IN ('preview','approved','running','completed','partial','failed','cancelled')),
  categories     TEXT NOT NULL,
  inventory_json TEXT NOT NULL,
  inventory_hash TEXT NOT NULL,
  report_json    TEXT,
  requested_by   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);

-- Aggregate-only launch analytics. No raw IP is ever stored (plan §25.4).
CREATE TABLE visit_sessions (
  id             TEXT PRIMARY KEY,          -- salted daily hash, not a durable identifier
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  landing_path   TEXT NOT NULL,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('external','internal_test','bot_suspected','unknown')),
  page_views     INTEGER NOT NULL DEFAULT 1,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_visits_class ON visit_sessions(classification, first_seen_at);
CREATE INDEX idx_visits_expiry ON visit_sessions(expires_at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
