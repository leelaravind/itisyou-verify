#!/usr/bin/env node
/**
 * Release gate and deploy.
 *
 *   node scripts/release.mjs --env staging
 *   node scripts/release.mjs --env production
 *   node scripts/release.mjs --env production --dry-run
 *
 * Every gate below has to pass before anything is deployed. The gates are in this
 * order on purpose: the cheap checks fail fast, and the secret scan runs over the
 * *built bundle* as well as the source, because a value that is safe in a source
 * file can still be inlined into a bundle by a build step.
 *
 * This script never creates a resource, never changes a DNS record and never spends
 * money. It runs checks and calls `wrangler deploy`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const env = envIndex === -1 ? null : args[envIndex + 1];
const dryRun = args.includes('--dry-run');
const skipTests = args.includes('--skip-tests');

if (!env || !['staging', 'production'].includes(env)) {
  console.error('usage: node scripts/release.mjs --env <staging|production> [--dry-run]');
  process.exit(2);
}

if (skipTests && env === 'production') {
  console.error('release — --skip-tests is refused for production. The gate exists for a reason.');
  process.exit(2);
}

const APP = 'apps/app';
let failed = false;

function step(name, fn) {
  process.stdout.write(`\n▸ ${name}\n`);
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed = true;
    process.stdout.write(`  ✗ ${name}\n`);
    if (err?.stdout) process.stdout.write(String(err.stdout));
    if (err?.stderr) process.stdout.write(String(err.stderr));
    throw new Error(`release gate failed at: ${name}`);
  }
}

function run(cmd, cmdArgs, opts = {}) {
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

function capture(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', shell: process.platform === 'win32' });
}

console.log(`ITISYOU Verify — release to ${env}${dryRun ? ' (dry run)' : ''}`);

try {
  step('working tree is clean', () => {
    const status = capture('git', ['status', '--porcelain']).trim();
    if (status) {
      console.log(status);
      throw new Error('uncommitted changes — deploy only what is committed and reviewable');
    }
  });

  step('record the candidate commit', () => {
    const sha = capture('git', ['rev-parse', 'HEAD']).trim();
    const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    console.log(`  candidate ${sha.slice(0, 12)} on ${branch}`);
    if (env === 'production' && branch !== 'main') {
      throw new Error(`production deploys come from main, not ${branch}`);
    }
  });

  step('dependencies match the lockfile', () => run('pnpm', ['install', '--frozen-lockfile']));
  step('typecheck', () => run('pnpm', ['typecheck']));
  step('lint', () => run('pnpm', ['lint']));

  if (!skipTests) {
    step('unit, integration and security suites', () => run('pnpm', ['test']));
  } else {
    console.log('\n▸ tests SKIPPED by flag — this release is not gated');
  }

  step('test ledger integrity', () => run('node', ['scripts/verify-test-cases.mjs']));
  step('development story integrity', () => run('node', ['scripts/verify-story.mjs']));
  step('secret scan — tracked tree and full history', () =>
    run('node', ['scripts/scan-secrets.mjs', '--history']));

  step('build the worker bundle', () =>
    run('pnpm', ['--filter', '@verify/app', 'build']));

  step('secret scan — built bundle', () => {
    const dist = `${APP}/dist`;
    if (!existsSync(dist)) throw new Error(`${dist} does not exist; the build produced nothing to scan`);
    run('node', ['scripts/scan-secrets.mjs', '--paths', dist]);
  });

  step('database migrations', () => {
    const dbName = `verify-itisyou-db-${env}`;
    if (dryRun) {
      console.log(`  would run: wrangler d1 migrations apply ${dbName} --env ${env} --remote`);
      return;
    }
    run('npx', ['wrangler', 'd1', 'migrations', 'apply', dbName, '--env', env, '--remote'], { cwd: APP });
  });

  step('deploy', () => {
    if (dryRun) {
      console.log(`  would run: wrangler deploy --env ${env}`);
      return;
    }
    run('npx', ['wrangler', 'deploy', '--env', env], { cwd: APP });
  });

  step('post-deploy smoke check', () => {
    if (dryRun) {
      console.log('  would probe /health on the deployed origin');
      return;
    }
    const base =
      env === 'production'
        ? 'https://verify-itisyou-production.kpleelaaravind.workers.dev'
        : 'https://verify-itisyou-staging.kpleelaaravind.workers.dev';
    // The workers.dev origin is probed rather than the custom domain, because this
    // machine's local DNS resolver is unreliable and a DNS failure here would look
    // like a deployment failure.
    const res = spawnSync('curl', ['-s', '-m', '30', `${base}/health`], { encoding: 'utf8' });
    const body = (res.stdout ?? '').trim();
    console.log(`  ${body || '(no response)'}`);
    if (!body.includes('"database":"reachable"')) {
      throw new Error('health check did not report a reachable database');
    }
  });

  console.log(`\nrelease — ${env} deploy complete.`);
  console.log('This proves the gates passed and the service answers. It does not prove');
  console.log('the product is correct, secure or ready to sell. See docs/security-acceptance.md.');
  process.exit(0);
} catch (err) {
  console.error(`\nrelease — ABORTED: ${err.message}`);
  console.error('Nothing was deployed.' + (failed ? '' : ' Fix the failure above and run again.'));
  process.exit(1);
}
