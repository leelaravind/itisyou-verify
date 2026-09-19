/**
 * AUTH-0xx — tenancy and idempotency invariants asserted directly against the shipped
 * schema in `migrations/0001_init.sql`.
 *
 * D1/SQLite has no row-level security, so tenant isolation is 100% application-enforced
 * (brief rule 1). These cases do not prove the application enforces it — only that the
 * columns and constraints the enforcement DEPENDS on are present and have not been
 * removed by a later migration. They are cheap, they run today, and they fail loudly if
 * someone drops a UNIQUE constraint to "fix" a duplicate-key error in production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const schema = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

/** Extracts the body of `CREATE TABLE <name> ( ... );`. */
function tableBody(name: string): string {
  const re = new RegExp(`CREATE TABLE ${name}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
  const m = re.exec(schema);
  if (m === null || m[1] === undefined) {
    throw new Error(`AUTH schema check: table ${name} not found in migrations/`);
  }
  return m[1];
}

/**
 * Every table that holds data belonging to one paying customer. If a route can reach a
 * row in one of these, the query MUST carry workspace_id in its WHERE clause.
 */
const WORKSPACE_SCOPED_TABLES = [
  'memberships',
  'invitations',
  'connections',
  'workflows',
  'workflow_versions',
  'source_events',
  'runs',
  'run_attempts',
  'assertions',
  'evidence',
  'orders',
  'subscriptions',
  'entitlements',
  'refunds',
] as const;

describe('tenant-scope invariants in the schema', () => {
  it('AUTH-001 every customer-scoped table carries a workspace_id column', () => {
    for (const table of WORKSPACE_SCOPED_TABLES) {
      expect(tableBody(table), table).toMatch(/\bworkspace_id\b/);
    }
  });

  it('AUTH-002 child tables denormalise workspace_id so a composite check is possible', () => {
    // runs -> run_attempts -> assertions and runs -> evidence. Without workspace_id on
    // the child, a "fetch evidence by id" route can only check the parent by joining,
    // and the join is exactly where a developer forgets the tenant predicate.
    for (const table of ['run_attempts', 'assertions', 'evidence', 'workflow_versions']) {
      expect(tableBody(table), table).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
    }
  });

  it('AUTH-003 source events are unique per workspace, not globally', () => {
    // UNIQUE (workspace_id, external_event_id) — a global UNIQUE on external_event_id
    // would leak the existence of another tenant's event id through a 409.
    expect(tableBody('source_events')).toMatch(/UNIQUE\s*\(\s*workspace_id\s*,\s*external_event_id\s*\)/i);
  });

  it('AUTH-004 sessions store a hash of the cookie, never the cookie value', () => {
    const body = tableBody('sessions');
    expect(body).toMatch(/id\s+TEXT\s+PRIMARY KEY/i);
    expect(schema).toMatch(/hash of the cookie value, not the value itself/i);
    // A session row must be revocable and expiring.
    expect(body).toMatch(/\brevoked_at\b/);
    expect(body).toMatch(/\bexpires_at\b/);
  });

  it('AUTH-005 login tokens and invitations are stored as hashes only', () => {
    expect(tableBody('login_tokens')).toMatch(/token_hash\s+TEXT\s+PRIMARY KEY/i);
    expect(tableBody('invitations')).toMatch(/token_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    // No column may hold the plaintext token.
    expect(tableBody('login_tokens')).not.toMatch(/\btoken\s+TEXT/i);
    expect(tableBody('invitations')).not.toMatch(/\btoken\s+TEXT/i);
  });

  it('AUTH-006 the owner MFA gate has somewhere to record recent strong auth', () => {
    expect(tableBody('sessions')).toMatch(/mfa_verified_at/);
    expect(tableBody('users')).toMatch(/is_platform_owner/);
    // TOTP secrets are a reference into credential_versions, never a column of `users`.
    expect(tableBody('users')).toMatch(/totp_secret_ref/);
    expect(tableBody('users')).not.toMatch(/totp_secret\s+TEXT/);
  });

  it('AUTH-007 stored credentials are ciphertext with a nonce, a key version and AAD', () => {
    const body = tableBody('credential_versions');
    for (const column of ['ciphertext', 'nonce', 'aad', 'key_version', 'owner_scope']) {
      expect(body, column).toMatch(new RegExp(`\\b${column}\\b`));
    }
    // There must be no plaintext column to fall back to.
    expect(body).not.toMatch(/\b(secret|plaintext|access_token|api_key)\b/i);
  });

  it('AUTH-008 provider webhook deliveries are at-most-once per (provider, event_id)', () => {
    expect(tableBody('webhook_receipts')).toMatch(/UNIQUE\s*\(\s*provider\s*,\s*event_id\s*\)/i);
  });

  it('AUTH-009 every retryable money mutation has a UNIQUE idempotency key', () => {
    expect(tableBody('orders')).toMatch(/idempotency_key\s+TEXT\s+UNIQUE/i);
    expect(tableBody('refunds')).toMatch(/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(tableBody('budget_entries')).toMatch(/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(tableBody('outbox')).toMatch(/unique_event_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  });

  it('AUTH-010 an approval binds to a canonical payload hash and expires', () => {
    const body = tableBody('approvals');
    expect(body).toMatch(/canonical_payload_hash\s+TEXT\s+NOT NULL/i);
    expect(body).toMatch(/maximum_amount_minor/);
    expect(body).toMatch(/expires_at\s+TEXT\s+NOT NULL/i);
    expect(body).toMatch(/status\s+TEXT\s+NOT NULL\s+CHECK[^)]*'consumed'/i);
  });

  it('AUTH-011 no money column is stored as a floating-point type', () => {
    const moneyColumns = schema.match(/^\s*\w*(?:amount|minor|price|spend|budget)\w*\s+(\w+)/gim) ?? [];
    for (const line of moneyColumns) {
      expect(line.toUpperCase(), line).not.toMatch(/\b(REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC)\b/);
    }
  });

  it('AUTH-012 the subscription table has a monotonic guard against out-of-order events', () => {
    // Stripe explicitly does not guarantee event ordering, so a stale
    // `customer.subscription.updated` must never downgrade a newer state.
    expect(tableBody('subscriptions')).toMatch(/provider_event_created\s+INTEGER\s+NOT NULL/i);
    expect(tableBody('subscriptions')).toMatch(/UNIQUE\s*\(\s*provider_subscription_id\s*,\s*environment\s*\)/i);
  });

  it('AUTH-013 test and live billing objects cannot collide', () => {
    expect(tableBody('billing_customers')).toMatch(/environment\s+TEXT\s+NOT NULL\s+CHECK/i);
    expect(tableBody('billing_customers')).toMatch(/UNIQUE\s*\(\s*stripe_customer_id\s*,\s*environment\s*\)/i);
  });

  it('AUTH-014 analytics store no raw IP address and expire', () => {
    const body = tableBody('visit_sessions');
    expect(body).not.toMatch(/\bip\b|ip_address|remote_addr/i);
    expect(body).toMatch(/expires_at\s+TEXT\s+NOT NULL/i);
  });

  it('AUTH-015 evidence has a retention expiry and stores a redacted summary only', () => {
    const body = tableBody('evidence');
    expect(body).toMatch(/redacted_summary\s+TEXT\s+NOT NULL/i);
    expect(body).toMatch(/expires_at\s+TEXT\s+NOT NULL/i);
    expect(body).not.toMatch(/raw_payload|payload_json/i);
  });
});
