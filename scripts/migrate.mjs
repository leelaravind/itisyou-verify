#!/usr/bin/env node
/**
 * Apply D1 migrations, with the guards `wrangler d1 migrations apply` does not have.
 *
 *   node scripts/migrate.mjs --env local
 *   node scripts/migrate.mjs --env staging
 *   node scripts/migrate.mjs --env production --confirm
 *
 * Guards:
 *  - production requires an explicit --confirm, so a mistyped flag cannot migrate live data
 *  - every pending migration is printed and inspected for destructive statements first
 *  - a destructive statement in a production migration is refused unless --allow-destructive
 *    is also given, because a code rollback does not reverse a dropped column
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const env = args[args.indexOf('--env') + 1];
const confirmed = args.includes('--confirm');
const allowDestructive = args.includes('--allow-destructive');

if (!['local', 'staging', 'production'].includes(env)) {
  console.error('usage: node scripts/migrate.mjs --env <local|staging|production> [--confirm]');
  process.exit(2);
}

const MIGRATIONS_DIR = 'migrations';
const DESTRUCTIVE = [
  { id: 'drop-table', re: /\bDROP\s+TABLE\b/i },
  { id: 'drop-column', re: /\bDROP\s+COLUMN\b/i },
  { id: 'drop-index', re: /\bDROP\s+INDEX\b/i },
  { id: 'delete-without-where', re: /\bDELETE\s+FROM\s+\w+\s*;/i },
  { id: 'update-without-where', re: /\bUPDATE\s+\w+\s+SET\b(?![\s\S]*\bWHERE\b)/i },
  { id: 'rename-column', re: /\bRENAME\s+COLUMN\b/i },
  { id: 'truncate', re: /\bTRUNCATE\b/i },
];

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`migrate — no .sql files in ${MIGRATIONS_DIR}/`);
  process.exit(1);
}

console.log(`migrate — ${files.length} migration file(s) in ${MIGRATIONS_DIR}/:`);
const findings = [];
for (const f of files) {
  const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
  const hits = DESTRUCTIVE.filter((d) => d.re.test(sql)).map((d) => d.id);
  console.log(`  ${f}${hits.length ? `   ⚠ ${hits.join(', ')}` : ''}`);
  if (hits.length) findings.push({ file: f, hits });
}

if (findings.length > 0 && env === 'production' && !allowDestructive) {
  console.error('\nmigrate — REFUSED. A production migration contains destructive statements:');
  for (const f of findings) console.error(`  ${f.file}: ${f.hits.join(', ')}`);
  console.error('\nA code rollback does not reverse a dropped column. Prefer expand/contract:');
  console.error('  1. add the new shape, deploy code that writes both');
  console.error('  2. backfill, deploy code that reads the new shape');
  console.error('  3. only then, in a later release, remove the old shape');
  console.error('\nIf this really is intended, re-run with --allow-destructive.');
  process.exit(1);
}

if (env === 'production' && !confirmed) {
  console.error('\nmigrate — production requires --confirm. Nothing was applied.');
  process.exit(1);
}

const dbName = env === 'local' ? 'verify-itisyou-db-staging' : `verify-itisyou-db-${env}`;
const wranglerArgs = ['wrangler', 'd1', 'migrations', 'apply', dbName];
if (env === 'local') {
  wranglerArgs.push('--env', 'staging', '--local');
} else {
  wranglerArgs.push('--env', env, '--remote');
}

console.log(`\nmigrate — applying to ${dbName} (${env})…\n`);
try {
  execFileSync('npx', wranglerArgs, {
    stdio: 'inherit',
    cwd: 'apps/app',
    shell: process.platform === 'win32',
  });
} catch {
  console.error('\nmigrate — wrangler reported a failure. Check the output above.');
  process.exit(1);
}
console.log('\nmigrate — done.');
