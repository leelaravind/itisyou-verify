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
 */
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

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
const MAX_LIFETIME_SECONDS = 12 * 60 * 60;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/** One `wrangler d1 execute` call. Local by default; `--remote` for staging. */
function execute(sql) {
  const flags = env === 'staging' ? ['--remote', '--env', 'staging'] : ['--local'];
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DATABASE, ...flags, '--command', sql],
    { cwd: 'apps/app', stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' },
  );
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

// The user row is created once and reused; a fresh session is minted every time, because
// the session is the thing that expires.
execute(
  `INSERT INTO users (id, auth_subject, display_name, is_platform_owner, created_at)
   VALUES (${quote(userId)}, ${quote(AUTOMATION_SUBJECT)}, 'Automation test identity', 0, ${quote(createdAt)})
   ON CONFLICT(auth_subject) DO UPDATE SET display_name = excluded.display_name;`,
);

// `is_platform_owner = 0` is asserted rather than assumed: a previous seed against a
// database somebody had edited must not silently hand the suite owner rights.
execute(`UPDATE users SET is_platform_owner = 0 WHERE auth_subject = ${quote(AUTOMATION_SUBJECT)};`);

execute(
  `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, mfa_verified_at, is_automation)
   SELECT ${quote(sessionId)}, id, ${quote(createdAt)}, ${quote(expiresAt)}, ${quote(createdAt)}, ${quote(createdAt)}, 1
     FROM users WHERE auth_subject = ${quote(AUTOMATION_SUBJECT)};`,
);

const seed = {
  environment: env,
  baseUrl: BASE_URL,
  sessionCookieName,
  sessionCookieValue,
  csrfCookieName,
  csrfToken,
  createdAt,
  expiresAt,
  lifetimeSeconds: MAX_LIFETIME_SECONDS,
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
      `export E2E_BASE_URL=${BASE_URL}`,
      '',
    ].join('\n'),
  );
}
