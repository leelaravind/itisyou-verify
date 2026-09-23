#!/usr/bin/env node
/**
 * Release gate and deploy.
 *
 *   node scripts/release.mjs --env staging
 *   node scripts/release.mjs --env production
 *   node scripts/release.mjs --env production --dry-run
 *   node scripts/release.mjs --env production --check-gate-artefact
 *   node scripts/release.mjs --env production --check-gate-artefact --gate-artefact <path>
 *
 * Every gate below has to pass before anything is deployed. The gates are in this
 * order on purpose: the cheap checks fail fast, and the secret scan runs over the
 * *built bundle* as well as the source, because a value that is safe in a source
 * file can still be inlined into a bundle by a build step.
 *
 * The number that authorises a PRODUCTION deploy is not measured here. It is measured
 * by CI on a clean checkout and carried in the `release-gate-<sha>` artefact; this
 * script refuses production unless that artefact was produced at HEAD. `--dry-run`
 * still runs every gate, so it is the safe way to find out whether the artefact you
 * hold is the right one. `--check-gate-artefact` runs only that one gate and exits.
 *
 * This script never creates a resource, never changes a DNS record and never spends
 * money. It runs checks and calls `wrangler deploy`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const env = envIndex === -1 ? null : args[envIndex + 1];
const dryRun = args.includes('--dry-run');
const skipTests = args.includes('--skip-tests');
const artefactIndex = args.indexOf('--gate-artefact');
const GATE_ARTEFACT = artefactIndex === -1 ? 'reports/release-gate.json' : args[artefactIndex + 1];
/**
 * Run only the artefact gate and stop. Deploys nothing, builds nothing, needs no clean
 * tree. It answers one question — "would the artefact I have let this commit reach
 * production?" — in a second rather than ten minutes, and makes the gate itself testable.
 */
const gateCheckOnly = args.includes('--check-gate-artefact');

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
/** HEAD at the moment of the release, filled in by the candidate-commit step. */
let candidateSha = null;
/** True once wrangler has actually deployed. Post-deploy gates cannot undo that. */
let deployed = false;

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
    // Without this the reason is swallowed and every gate failure reads identically.
    if (err?.message && !err.stdout && !err.stderr) process.stdout.write(`    ${err.message}\n`);
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
  if (!gateCheckOnly) {
    step('working tree is clean', () => {
      const status = capture('git', ['status', '--porcelain']).trim();
      if (status) {
        console.log(status);
        throw new Error('uncommitted changes — deploy only what is committed and reviewable');
      }
    });
  }

  step('record the candidate commit', () => {
    const sha = capture('git', ['rev-parse', 'HEAD']).trim();
    const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    candidateSha = sha;
    console.log(`  candidate ${sha.slice(0, 12)} on ${branch}`);
    if (env === 'production') {
      // The invariant is "this commit is on the pushed main history", not "the current
      // branch is named main". The name check permitted a local `main` holding unpushed
      // commits and refused a detached worktree sitting exactly on a pushed, CI-tested one
      // -- which is the shape a release takes while agents hold uncommitted work in the
      // primary tree. Fetch first so `origin/main` means what the remote says, not what
      // this clone last saw.
      capture('git', ['fetch', '--quiet', 'origin', 'main']);
      const onMain = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (onMain.status !== 0) {
        throw new Error(
          `production deploys come from the pushed main history; ${sha.slice(0, 12)} is not on origin/main`,
        );
      }
      console.log('  on origin/main: yes');
    }
  });

  // -------------------------------------------------------------------------
  // The CI gate artefact.
  //
  // A test total taken on a developer machine is a reading of a working tree: on this
  // repository the suite moved by 400 cases in twenty minutes while it was being
  // measured, and one category read zero because files landed mid-run. So the number
  // that gates a production deploy is defined as a property of a COMMIT — produced by
  // CI, on a clean checkout, at a known SHA — and this step refuses to deploy unless the
  // artefact in front of it was produced that way, for exactly this commit.
  //
  // This is deliberately structural. "Remember to check the CI run first" is not a gate;
  // it is a hope. Download the `release-gate-<sha>` artefact from the CI run for this
  // commit into reports/ (or point at it with --gate-artefact) before releasing.
  // -------------------------------------------------------------------------
  step(`release gate artefact matches HEAD (${GATE_ARTEFACT})`, () => {
    const advisory = env !== 'production';
    const complain = (message) => {
      if (advisory) {
        console.log(`  note (${env} is advisory): ${message}`);
        return;
      }
      throw new Error(message);
    };

    if (!existsSync(GATE_ARTEFACT)) {
      complain(
        `${GATE_ARTEFACT} does not exist. The production number comes from CI on a clean ` +
          `checkout, not from this machine: download the release-gate artefact for ` +
          `${candidateSha.slice(0, 12)} from its CI run, or pass --gate-artefact <path>.`,
      );
      return;
    }

    let artefact;
    try {
      artefact = JSON.parse(readFileSync(GATE_ARTEFACT, 'utf8'));
    } catch (error) {
      complain(`${GATE_ARTEFACT} is not readable JSON: ${error.message}`);
      return;
    }

    if (artefact.kind !== 'release-gate' || artefact.schema_version !== 1) {
      complain(`${GATE_ARTEFACT} is not a v1 release-gate artefact`);
      return;
    }

    console.log(
      `  artefact  ${String(artefact.commit_sha ?? '(none)').slice(0, 12)} produced by ${artefact.produced_by}, tree ${artefact.tree_clean ? 'clean' : 'DIRTY'}`,
    );
    console.log(
      `  citable   ${artefact.gate?.citable_distinct_passing_cases} distinct passing cases (minimum ${artefact.gate?.total_minimum})`,
    );

    if (artefact.commit_sha !== candidateSha) {
      complain(
        `the gate artefact was produced at ${String(artefact.commit_sha).slice(0, 12)} but HEAD is ` +
          `${candidateSha.slice(0, 12)}. A number measured at another commit is not evidence about ` +
          'this one. Push this commit, let CI produce its artefact, and release that.',
      );
    }
    if (artefact.produced_by !== 'github-actions') {
      complain(
        `the gate artefact was produced by \`${artefact.produced_by}\`, not by CI. A local run ` +
          'measures a working tree, not a commit.',
      );
    }
    if (artefact.tree_clean !== true) {
      complain(
        'the gate artefact was produced from a dirty working tree, so it belongs to no commit',
      );
    }
    if (artefact.ledger?.checker_exit_code !== 0) {
      complain(`the ledger checker exited ${artefact.ledger?.checker_exit_code} in that CI run`);
    }
    if (artefact.gate?.met !== true) {
      complain(
        `that CI run counted ${artefact.gate?.citable_distinct_passing_cases} distinct passing cases, ` +
          `below the minimum of ${artefact.gate?.total_minimum}`,
      );
    }
    if (artefact.floors_met !== true) {
      const short = (artefact.floors ?? []).filter((f) => !f.met);
      complain(
        `${short.length} category/categories are below floor in that CI run: ` +
          short.map((f) => `${f.category} ${f.counted}/${f.minimum}`).join(', '),
      );
    }

    /*
     * The browser suite.
     *
     * This check did not exist, and its absence was not theoretical. The artefact for
     * `e0aa820` carried `runners.playwright.stats.unexpected: 3` and `accounting.failing: 0`
     * in the same file, `gate.met` was true, and production was deployed from it. Three
     * browser cases failed and nothing between them and a live deployment looked.
     *
     * The cause is that the two halves never met. `verify-test-cases.mjs` reads the ledger
     * and the vitest results; it never opens the Playwright report, so a failing browser
     * case cannot become a `failing` row in the accounting. CI's own comment says such a
     * case "becomes a recorded failure"; it became a number nothing read.
     *
     * `flaky` is refused as well as `unexpected`. A case that passed on retry is a case
     * whose result depends on timing, and "it went green the second time" is not evidence
     * about this commit -- it is the reason to look, not permission to ship.
     */
    const pw = artefact.runners?.playwright;
    if (pw?.executed === true) {
      const unexpected = Number(pw.stats?.unexpected ?? 0);
      const flaky = Number(pw.stats?.flaky ?? 0);
      console.log(
        `  browser   ${pw.stats?.expected ?? 0} passed, ${unexpected} failed, ${flaky} flaky, ` +
          `${pw.stats?.skipped ?? 0} skipped`,
      );
      if (unexpected > 0) {
        complain(
          `${unexpected} browser case(s) FAILED in that CI run. The vitest accounting reports ` +
            `\`failing: ${artefact.accounting?.failing ?? 0}\` because it never reads the ` +
            'Playwright report — that is how this shipped once already. Fix the cases or ' +
            'disable the capability they cover; do not release around them.',
        );
      }
      if (flaky > 0) {
        complain(
          `${flaky} browser case(s) passed only on retry in that CI run. A result that depends ` +
            'on timing is not evidence about this commit.',
        );
      }
    } else {
      complain(
        'the gate artefact records no browser run at all. The browser suite covers the ' +
          'purchase and owner paths; releasing without it is releasing without them.',
      );
    }
  });

  if (gateCheckOnly) {
    console.log(
      `\nrelease — gate artefact accepted for ${env}. Nothing was deployed (--check-gate-artefact).`,
    );
    process.exit(0);
  }

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
    run('node', ['scripts/scan-secrets.mjs', '--history']),
  );

  // Placed beside the secret scan because it guards the same class of harm: something
  // true-sounding reaching a stranger. A false SOC 2 badge is not a smaller problem than
  // a leaked key, it is a different one with the same root — shipping an assertion
  // nobody checked.
  step('claim scan — public surfaces', () => run('node', ['scripts/scan-claims.mjs']));

  step('build the worker bundle', () => run('pnpm', ['--filter', '@verify/app', 'build']));

  step('secret scan — built bundle', () => {
    const dist = `${APP}/dist`;
    if (!existsSync(dist))
      throw new Error(`${dist} does not exist; the build produced nothing to scan`);
    run('node', ['scripts/scan-secrets.mjs', '--paths', dist]);
  });

  step('database migrations', () => {
    const dbName = `verify-itisyou-db-${env}`;
    if (dryRun) {
      console.log(`  would run: wrangler d1 migrations apply ${dbName} --env ${env} --remote`);
      return;
    }
    run('npx', ['wrangler', 'd1', 'migrations', 'apply', dbName, '--env', env, '--remote'], {
      cwd: APP,
    });
  });

  step('deploy', () => {
    if (dryRun) {
      console.log(`  would run: wrangler deploy --env ${env}`);
      return;
    }
    // The commit is injected as a binding AND written onto the Cloudflare version as a
    // message. Two records because they fail differently: the binding answers "what is
    // serving this request" from outside, over HTTP, to anyone; the version message
    // answers "what did we deploy" in the account's own audit trail even if the Worker
    // will not boot. Before this, neither existed -- `/health` reported no commit and
    // `wrangler deployments list` showed version ids with no tag and no message, so the
    // question "does production have this fix" had no answer that did not rest on my word.
    run(
      'npx',
      [
        'wrangler',
        'deploy',
        '--env',
        env,
        '--var',
        `COMMIT_SHA:${candidateSha}`,
        // No space in the value. `run()` goes through a shell on Windows, and a quoted
        // argument containing a space arrived at wrangler as two arguments -- the second a
        // stray positional it refused. The first attempt to deploy with a version message
        // failed on exactly this, after every gate had passed.
        '--message',
        `release-${candidateSha.slice(0, 12)}`,
      ],
      { cwd: APP },
    );
    deployed = true;
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
    // It must be THIS commit answering, not merely something. On 23 September the check
    // passed while /health still reported the previous commit for several seconds of
    // propagation: "reachable" was true of the old version. So the served commit is compared
    // with the candidate, retrying for up to a minute while the rollout settles, and a
    // different commit after that is a failure, not a pass.
    let body = '';
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const res = spawnSync('curl', ['-s', '-m', '30', `${base}/health`], { encoding: 'utf8' });
      body = (res.stdout ?? '').trim();
      if (body.includes(`"commit":"${candidateSha}"`)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
    console.log(`  ${body || '(no response)'}`);
    if (!body.includes(`"commit":"${candidateSha}"`)) {
      throw new Error(`health did not report the candidate ${candidateSha.slice(0, 12)} within a minute`);
    }
    if (!body.includes('"database":"reachable"')) {
      throw new Error('health check did not report a reachable database');
    }
  });

  // The strongest form of the claim gate: not what the source says, not what the bundle
  // contains, but what a stranger actually receives. This project already learned the
  // difference the expensive way — a 33% meter rendered as a full bar while the template
  // was correct and the test asserting the template was correct. Only fetching the page
  // told the truth. The same reasoning applies to a sentence.
  step('claim scan — pages as actually served', () => {
    if (dryRun) {
      console.log('  would fetch the public pages and scan what was served');
      return;
    }
    const base =
      env === 'production'
        ? 'https://verify-itisyou-production.kpleelaaravind.workers.dev'
        : 'https://verify-itisyou-staging.kpleelaaravind.workers.dev';
    const paths = ['/', '/how-it-works', '/pricing', '/demo', '/terms', '/privacy', '/security'];
    const dir = 'reports/served';
    mkdirSync(dir, { recursive: true });
    const fetched = [];
    for (const p of paths) {
      const name = p === '/' ? 'root' : p.replace(/^\//, '').replace(/\//g, '_');
      const res = spawnSync('curl', ['-s', '-m', '30', `${base}${p}`], { encoding: 'utf8' });
      const html = res.stdout ?? '';
      if (!html.trim()) throw new Error(`${p} returned nothing; cannot scan what was served`);
      writeFileSync(`${dir}/${name}.html`, html, 'utf8');
      fetched.push(p);
    }
    console.log(`  fetched ${fetched.length} page(s): ${fetched.join(' ')}`);
    run('node', ['scripts/scan-claims.mjs', '--paths', dir]);
  });

  console.log(`\nrelease — ${env} deploy complete.`);
  console.log('This proves the gates passed and the service answers. It does not prove');
  console.log('the product is correct, secure or ready to sell. See docs/security-acceptance.md.');
  process.exit(0);
} catch (err) {
  console.error(`\nrelease — ABORTED: ${err.message}`);
  if (deployed) {
    // Saying "nothing was deployed" here would be false, and falsely reassuring in the
    // one direction that matters: the build IS live and a gate has just objected to it.
    // The post-deploy gates — the smoke check and the scan of pages as actually served —
    // run after wrangler by necessity, because they measure the running service. So a
    // failure in them is a failure of something already serving traffic.
    console.error(
      `\nTHE DEPLOY ALREADY HAPPENED. ${env} is running this build and the failure above is\n` +
        'about the running service, not about a build that was stopped. Either fix forward\n' +
        'and release again, or roll back deliberately — but do not read this as "no change".',
    );
  } else {
    console.error(
      'Nothing was deployed.' + (failed ? '' : ' Fix the failure above and run again.'),
    );
  }
  process.exit(1);
}
