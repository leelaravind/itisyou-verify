-- Constrain credential_versions at the database, not only in application code.
--
-- credential_versions has no workspace_id column: `owner_scope` IS its scope. If a caller
-- ever writes a third shape, the tenant binding silently stops meaning anything, and no
-- application-layer check catches a row inserted by a future code path nobody reviewed.
-- The database should refuse it outright.
--
-- The aad CHECK enforces that the key version is inside the authenticated data (finding
-- F2 from the security review): a row whose AAD does not carry `kv=` cannot be stored at
-- all, so a downgrade to an older key version cannot be forged by editing a column.
-- This is safe to enforce now precisely because no credential has ever been written —
-- the service is not yet accepting connections.
--
-- SQLite cannot ALTER TABLE ... ADD CONSTRAINT, so this is the table-rebuild form.
-- Nothing holds a foreign key TO credential_versions, so no PRAGMA toggling is needed.

CREATE TABLE credential_versions_new (
  id            TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  -- GLOB is case-sensitive, which is what we want here; `?` forces at least one
  -- character after the colon, so 'user:' with an empty id is rejected.
  owner_scope   TEXT NOT NULL CHECK (
                  owner_scope GLOB 'connection:?*' OR owner_scope GLOB 'user:?*'
                ),
  key_version   INTEGER NOT NULL CHECK (key_version >= 1),
  ciphertext    TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  aad           TEXT NOT NULL CHECK (aad LIKE 'v1|kv=%'),
  created_at    TEXT NOT NULL,
  retired_at    TEXT
);

INSERT INTO credential_versions_new
  (id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at, retired_at)
SELECT id, connection_id, owner_scope, key_version, ciphertext, nonce, aad, created_at, retired_at
  FROM credential_versions;

DROP TABLE credential_versions;

ALTER TABLE credential_versions_new RENAME TO credential_versions;

CREATE INDEX idx_credver_scope ON credential_versions(owner_scope, retired_at);
