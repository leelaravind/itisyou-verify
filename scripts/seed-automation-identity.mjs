#!/usr/bin/env node
/**
 * Seed the scoped automation test identity and print the cookies the browser suite needs.
 *
 *   node scripts/seed-automation-identity.mjs --env local
 *   node scripts/seed-automation-identity.mjs --env staging
 *   node scripts/seed-automation-identity.mjs --env local --json > .e2e-session.json
 *
 * Then:
 *
 *   eval "$(node scripts/seed-automation-identity.mjs --env local)"
 *   pnpm test:e2e
 *
 * ## What this is, and what it is not
 *
 * It is a real row in the real `sessions` table. `/owner` and `/app` keep every guard they
 * have: the suite is let in because it genuinely holds a session, not because anything was
 * relaxed for it. There is no test-only route, no backdoor and no weakened check — A07
 * refused all three and was right to.
 *
 * The identity gets `owner.view`, `quality.dispatch` and `cleanup.preview` and nothing
 * else. It can never activate an advert, issue a refund, move budget or become platform
 * owner: `capabilitiesFor()` tests `isAutomation` before `isPlatformOwner`, so those four
 * are absent from the set rather than guarded by a condition somebody could get wrong.
 *
 * ## Production is refused before anything is minted
 *
 * `--env production` exits non-zero without touching a database and without generating a
 * cookie value, so there is nothing to leak even if the guard is ignored.
 *
 * ## Read the cookie NAME from the output
 *
 * Over http the name is `verify_session`; over https it is `__Host-verify_session`. A
 * `__Host-` cookie without `Secure` is rejected by the browser, so seeding the wrong name
 * sets nothing and the suite silently behaves as though it were signed out.
 *
 * ## A second identity: `SEED_WORKFLOW_ADMIN=1`, opt-in only
 *
 * Set `SEED_WORKFLOW_ADMIN=1` in the environment to also seed a **separate** `workspace_admin`
 * identity, scoped to the same synthetic workspace and nothing else. This is not the viewer
 * identity elevated — it is its own user, its own session, its own membership row — because a
 * standing credential that can both read and write is a different, larger risk than two
 * standing credentials each scoped to what they need.
 *
 * The owner's written reason for granting it, verbatim:
 *
 * > Without an identity that can configure a workflow, no workflow can be configured in any
 * > test, so the vertical slice can never be proven, so the product would ship on unit tests
 * > alone. This project has now found five separate workstreams whose code was correct,
 * > thoroughly tested and reachable by no request. Shipping on that basis is the specific
 * > failure the slice exists to prevent, and it is a larger risk than a scoped admin
 * > credential.
 *
 * The bounds that make the grant safe, each enforced below rather than merely intended:
 *   - a separate user and session, never the viewer's credential widened;
 *   - membership only in `ws_automation_test`, which is `is_synthetic = 1` — `AUTH-460` in
 *     the integration suite asserts this identity has no membership anywhere else, so a bug
 *     that pointed it at a real workspace would fail a test, not ship quietly;
 *   - no owner or platform scope of any kind (`is_platform_owner = 0`, asserted the same way
 *     the viewer's is below);
 *   - it does not exist unless `SEED_WORKFLOW_ADMIN=1` is set — a deployment that does not
 *     opt in seeds only the read-only viewer, exactly as before this identity existed.
 */
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (globalThis.crypto === undefined) globalThis.crypto = webcrypto;

const args = process.argv.slice(2);
const env = args[args.indexOf('--env') + 1];
const asJson = args.includes('--json');

if (!['local', 'staging'].includes(env)) {
  console.error('usage: node scripts/seed-automation-identity.mjs --env <local|staging> [--json]');
  console.error('production is refused: this identity must not exist there.');
  process.exit(2);
}

const DATABASE = env === 'staging' ? 'verify-itisyou-db-staging' : 'verify-itisyou-db-staging';
const BASE_URL =
  env === 'staging'
    ? 'https://verify-itisyou-staging.kpleelaaravind.workers.dev'
    : (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8788');

// ---------------------------------------------------------------------------
// The seed. Deliberately the same arithmetic as `apps/app/src/db/automationSeed.ts`;
// this script cannot import TypeScript, so the values it derives are the ones that file
// derives, and `AUTH-440` in the integration suite pins them against each other.
// ---------------------------------------------------------------------------

const AUTOMATION_SUBJECT = 'automation@itisyou.test';
/** A distinct user, a distinct subject — never the viewer's identity elevated. */
const AUTOMATION_ADMIN_SUBJECT = 'automation-admin@itisyou.test';
/** Stable, so a re-seed reuses the workspace rather than accumulating them. */
const WORKSPACE_ID = 'ws_automation_test';
const MAX_LIFETIME_SECONDS = 12 * 60 * 60;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SEED_WORKFLOW_ADMIN = process.env.SEED_WORKFLOW_ADMIN === '1';

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function newId(prefix, at) {
  let remaining = Math.floor(at);
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const tail = crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 16);
  return `${prefix}_${time}${tail}`;
}

async function hashToken(token, domain) {
  const data = new TextEncoder().encode(`verify.token.v1.${domain}:${token}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Run SQL through `wrangler d1 execute`, from a file rather than `--command`.
 *
 * `--command` with `shell: true` is broken on Windows: the argument is not quoted, so the
 * statement splits on whitespace and wrangler reports `Unknown arguments: INTO, users,
 * (id,,…`. Writing the SQL to a temp file and passing `--file` sidesteps shell quoting
 * entirely, removes the command-length ceiling, and lets one call carry several statements
 * — which is what makes the workspace and its membership land together below.
 *
 * The temp file holds no secret: the session id it writes is already a hash, and the
 * cookie value never appears in it. It is removed in a `finally` regardless.
 */
function execute(sql) {
  const flags = env === 'staging' ? ['--remote', '--env', 'staging'] : ['--local'];
  const dir = mkdtempSync(join(tmpdir(), 'verify-seed-'));
  const file = join(dir, 'seed.sql');
  try {
    writeFileSync(file, sql, 'utf8');
    execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, ...flags, '--file', file], {
      cwd: 'apps/app',
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const now = new Date();
const createdAt = now.toISOString();
const expiresAt = new Date(now.getTime() + MAX_LIFETIME_SECONDS * 1000).toISOString();
const secure = new URL(BASE_URL).protocol === 'https:';

const sessionCookieName = secure ? '__Host-verify_session' : 'verify_session';
const csrfCookieName = secure ? '__Host-verify_csrf' : 'verify_csrf';
const sessionCookieValue = base64url(randomBytes(32));
const csrfToken = base64url(randomBytes(32));
const userId = newId('usr', now.getTime());

const sessionId = await hashToken(sessionCookieValue, 'session');

// The admin identity's own values — computed unconditionally (it is cheap and keeps the
// branching below to "which SQL and output to include", not "which values exist").
const adminSessionCookieValue = base64url(randomBytes(32));
const adminCsrfToken = base64url(randomBytes(32));
const adminUserId = newId('usr', now.getTime());
const adminSessionId = await hashToken(adminSessionCookieValue, 'session');

/**
 * Everything the identity needs, in one file.
 *
 * The workspace is the part that was missing. Without it `/owner` answered 200 and `/app`
 * answered 401, because `resolveSession` requires a membership — one absent row presenting
 * as sixteen failing customer cases, which invites the conclusion that there are sixteen
 * defects in the customer pages.
 *
 * The membership is **`workspace_viewer`**, deliberately. A test identity that can change a
 * customer's configuration is a standing credential that can change a customer's
 * configuration, sitting in an environment variable. Read-only gives the suite a surface to
 * measure without that. If a scoped write is genuinely needed later it gets its own
 * narrowly-scoped identity and a stated reason.
 *
 * `is_synthetic = 1` so every count, list and owner view that filters synthetic data
 * continues to exclude it, and nobody mistakes it for a customer.
 */
const statements = [
  // The user row is created once and reused; a fresh session is minted every time,
  // because the session is the thing that expires.
  `INSERT INTO users (id, auth_subject, display_name, is_platform_owner, created_at)
   VALUES (${quote(userId)}, ${quote(AUTOMATION_SUBJECT)}, 'Automation test identity', 0, ${quote(createdAt)})
   ON CONFLICT(auth_subject) DO UPDATE SET display_name = excluded.display_name;`,

  // `is_platform_owner = 0` is asserted rather than assumed: a previous seed against a
  // database somebody had edited must not silently hand the suite owner rights.
  `UPDATE users SET is_platform_owner = 0 WHERE auth_subject = ${quote(AUTOMATION_SUBJECT)};`,

  // The synthetic workspace the customer pages render.
  `INSERT INTO workspaces (id, name, status, is_synthetic, retention_policy_version, created_at)
   VALUES (${quote(WORKSPACE_ID)}, 'Automation test workspace', 'active', 1, 1, ${quote(createdAt)})
   ON CONFLICT(id) DO UPDATE SET status = 'active', is_synthetic = 1;`,

  // Read-only. This is the line that keeps the credential harmless.
  `INSERT INTO memberships (workspace_id, user_id, role, created_at)
   SELECT ${quote(WORKSPACE_ID)}, id, 'workspace_viewer', ${quote(createdAt)}
     FROM users WHERE auth_subject = ${quote(AUTOMATION_SUBJECT)}
   ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'workspace_viewer';`,

  `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation)
   SELECT ${quote(sessionId)}, id, ${quote(createdAt)}, ${quote(expiresAt)}, ${quote(createdAt)}, ${quote(createdAt)}, 1
     FROM users WHERE auth_subject = ${quote(AUTOMATION_SUBJECT)};`,
];

/**
 * The second identity, gated behind `SEED_WORKFLOW_ADMIN=1` — see the file header for the
 * written reason and the bounds it must hold to. Everything below is a mirror of the block
 * above with one deliberate difference: the membership role is `workspace_admin`, and the
 * subject, user id and session are entirely separate rows.
 */
if (SEED_WORKFLOW_ADMIN) {
  statements.push(
    `INSERT INTO users (id, auth_subject, display_name, is_platform_owner, created_at)
     VALUES (${quote(adminUserId)}, ${quote(AUTOMATION_ADMIN_SUBJECT)}, 'Automation workflow-admin test identity', 0, ${quote(createdAt)})
     ON CONFLICT(auth_subject) DO UPDATE SET display_name = excluded.display_name;`,

    // Asserted, not assumed — same reasoning as the viewer's identical line above.
    `UPDATE users SET is_platform_owner = 0 WHERE auth_subject = ${quote(AUTOMATION_ADMIN_SUBJECT)};`,

    // The *same* synthetic workspace — not a second one. Scoping this identity to a
    // workspace that is `is_synthetic = 1` is what "cannot touch a real one" means in
    // practice: there is no membership row anywhere else for it to touch through.
    `INSERT INTO memberships (workspace_id, user_id, role, created_at)
     SELECT ${quote(WORKSPACE_ID)}, id, 'workspace_admin', ${quote(createdAt)}
       FROM users WHERE auth_subject = ${quote(AUTOMATION_ADMIN_SUBJECT)}
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'workspace_admin';`,

    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation)
     SELECT ${quote(adminSessionId)}, id, ${quote(createdAt)}, ${quote(expiresAt)}, ${quote(createdAt)}, ${quote(createdAt)}, 1
       FROM users WHERE auth_subject = ${quote(AUTOMATION_ADMIN_SUBJECT)};`,
  );
}

execute(statements.join('\n'));

const seed = {
  environment: env,
  baseUrl: BASE_URL,
  workspaceId: WORKSPACE_ID,
  workspaceRole: 'workspace_viewer',
  sessionCookieName,
  sessionCookieValue,
  csrfCookieName,
  csrfToken,
  createdAt,
  expiresAt,
  lifetimeSeconds: MAX_LIFETIME_SECONDS,
  ...(SEED_WORKFLOW_ADMIN
    ? {
        admin: {
          workspaceId: WORKSPACE_ID,
          workspaceRole: 'workspace_admin',
          sessionCookieName,
          sessionCookieValue: adminSessionCookieValue,
          csrfCookieName,
          csrfToken: adminCsrfToken,
        },
      }
    : {}),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(seed, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `export E2E_AUTOMATION_SESSION=${sessionCookieValue}`,
      `export E2E_AUTOMATION_COOKIE_NAME=${sessionCookieName}`,
      `export E2E_AUTOMATION_CSRF=${csrfToken}`,
      `export E2E_AUTOMATION_CSRF_COOKIE_NAME=${csrfCookieName}`,
      `export E2E_AUTOMATION_WORKSPACE=${WORKSPACE_ID}`,
      `export E2E_BASE_URL=${BASE_URL}`,
      ...(SEED_WORKFLOW_ADMIN
        ? [
            `export E2E_AUTOMATION_ADMIN_SESSION=${adminSessionCookieValue}`,
            `export E2E_AUTOMATION_ADMIN_CSRF=${adminCsrfToken}`,
          ]
        : []),
      '',
    ].join('\n'),
  );
}
