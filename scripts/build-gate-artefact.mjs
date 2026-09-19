#!/usr/bin/env node
/**
 * build-gate-artefact.mjs — produce the ONE number anyone is allowed to cite.
 *
 *   node scripts/build-gate-artefact.mjs
 *   node scripts/build-gate-artefact.mjs --allow-dirty   # local inspection only
 *
 * ## Why this file exists
 *
 * A total taken from a live working tree is not a measurement of anything. On this
 * repository, with twelve agents committing continuously, the suite went from 1,793 to
 * 2,196 distinct cases inside twenty minutes, and one category read **0 passing** purely
 * because thirteen files landed after that run had started. Every one of those numbers
 * was produced by a correct script reading a tree that was changing underneath it.
 *
 * So the gate number is defined as a property of a COMMIT, not of a machine:
 *
 *   - it is produced on a clean checkout, in CI, at a known SHA;
 *   - it is written to `reports/release-gate.json` and uploaded as a build artefact
 *     named after that SHA;
 *   - `scripts/release.mjs` refuses a production deploy unless the artefact it can see
 *     was produced by CI at exactly the SHA being deployed.
 *
 * Anything printed by a local run — by this script with `--allow-dirty`, by
 * `verify-test-cases.mjs`, by `build-test-report.mjs` — is a READING OF A WORKING TREE
 * AT A SHA. It is useful for development and it is not a gate result. The artefact
 * carries `produced_by` and `tree_clean` so that distinction survives being copied into
 * a status update.
 *
 * Inputs (all optional except the ledger checker; each missing input is recorded as
 * missing rather than assumed):
 *   reports/test-results.json   vitest run, written by scripts/build-test-report.mjs
 *   reports/pw.json             playwright run, `npx playwright test --reporter=json`
 *
 * Exit codes: 0 the artefact was written, 1 it could not be (never a "gate passed" code —
 * read the artefact for that).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ARGS = new Set(process.argv.slice(2));
const ALLOW_DIRTY = ARGS.has('--allow-dirty');

const OUT_DIR = 'reports';
const OUT_PATH = join(OUT_DIR, 'release-gate.json');
mkdirSync(OUT_DIR, { recursive: true });

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', shell: false }).trim();
  } catch {
    return null;
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(
      `build-gate-artefact — ${path} exists but is not readable JSON: ${error.message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provenance. `produced_by` is the field the release gate keys on.
// ---------------------------------------------------------------------------

const inGithubActions = process.env.GITHUB_ACTIONS === 'true';
const commitSha = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']);
const porcelain = git(['status', '--porcelain']);
const treeClean = porcelain === '';

if (commitSha === null) {
  console.error(
    'build-gate-artefact — cannot resolve HEAD. An artefact with no commit is worthless.',
  );
  process.exit(1);
}
if (!treeClean && !ALLOW_DIRTY) {
  console.error('build-gate-artefact — the working tree is not clean, so this run cannot');
  console.error('  produce a number that belongs to a commit. Commit, or pass --allow-dirty');
  console.error('  to write a clearly-labelled local reading that the release gate will refuse.');
  console.error(`\n${porcelain}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The ledger checker, in its machine-readable form. Its exit code is taken directly.
// ---------------------------------------------------------------------------

let checkerExit = 0;
let ledgerJson = null;
try {
  const raw = execFileSync('node', ['scripts/verify-test-cases.mjs', '--json'], {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  ledgerJson = JSON.parse(raw);
} catch (error) {
  checkerExit = typeof error.status === 'number' ? error.status : 1;
  // A checker that exits 1 still prints its JSON on stdout. A broken ledger is a fact to
  // record in the artefact, not a reason to write no artefact at all.
  try {
    ledgerJson = JSON.parse(String(error.stdout ?? ''));
  } catch {
    ledgerJson = null;
  }
}
if (ledgerJson === null) {
  console.error('build-gate-artefact — the ledger checker produced no parseable JSON. Refusing to');
  console.error('  write an artefact that would look authoritative while measuring nothing.');
  process.exit(1);
}

// The floors are defined in the checker and exported by it. They are never restated here:
// two copies of a threshold drift, and the copy nobody is watching is the one that drifts.
const minimums = ledgerJson.category_minimums;
if (minimums === undefined || minimums === null) {
  console.error('build-gate-artefact — the checker did not export `category_minimums`.');
  console.error('  Refusing to invent the floors locally.');
  process.exit(1);
}
const floors = Object.entries(minimums).map(([category, minimum]) => {
  const counted = ledgerJson.by_category?.[category]?.counted ?? 0;
  return {
    category,
    counted,
    minimum,
    met: counted >= minimum,
    short_by: Math.max(0, minimum - counted),
  };
});

// ---------------------------------------------------------------------------
// Runner evidence. Absent is recorded as absent.
// ---------------------------------------------------------------------------

const vitest = readJson(join(OUT_DIR, 'test-results.json'));
const playwright = readJson(join(OUT_DIR, 'pw.json'));

const runners = {
  // The ledger's own split: every case, by the runner that measured it.
  ledger_split: ledgerJson.accounting?.by_runner ?? null,
  ledger_passing_split: ledgerJson.accounting?.passing_by_runner ?? null,
  vitest: vitest
    ? {
        executed: true,
        distinct_cases: vitest.counts?.distinct_cases ?? null,
        passed: vitest.counts?.passed ?? null,
        failed: vitest.counts?.failed ?? null,
        skipped: vitest.counts?.skipped ?? null,
        commit_sha: vitest.meta?.commit_sha ?? null,
        tree_clean: vitest.meta?.tree_clean ?? null,
      }
    : {
        executed: false,
        reason: 'reports/test-results.json absent — run scripts/build-test-report.mjs first',
      },
  playwright: playwright
    ? { executed: true, stats: playwright.stats ?? null }
    : {
        executed: false,
        reason:
          'reports/pw.json absent. The browser suite needs wrangler dev plus a seeded automation identity; until this job runs it, every playwright-only case is unmeasured here and counts zero.',
      },
};

// A vitest run recorded at a different commit than this artefact is not evidence for this
// commit. Say so rather than folding it in.
const vitestSameCommit =
  vitest && vitest.meta?.commit_sha ? vitest.meta.commit_sha === commitSha : null;

const artefact = {
  schema_version: 1,
  kind: 'release-gate',
  produced_by: inGithubActions ? 'github-actions' : 'local',
  produced_at: new Date().toISOString(),
  commit_sha: commitSha,
  commit_sha_short: commitSha.slice(0, 12),
  branch: process.env.GITHUB_REF_NAME ?? git(['rev-parse', '--abbrev-ref', 'HEAD']),
  tree_clean: treeClean,
  node: process.version,
  workflow: inGithubActions
    ? {
        repository: process.env.GITHUB_REPOSITORY ?? null,
        run_id: process.env.GITHUB_RUN_ID ?? null,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        ref: process.env.GITHUB_REF ?? null,
        event: process.env.GITHUB_EVENT_NAME ?? null,
      }
    : null,

  // ----- the seven buckets, verbatim from the checker -----
  accounting: ledgerJson.accounting ?? null,
  exclusions: ledgerJson.exclusions ?? null,

  // ----- the per-runner split -----
  runners,
  vitest_run_matches_this_commit: vitestSameCommit,

  // ----- the twelve floors -----
  floors,
  floors_met: floors.every((f) => f.met),

  // ----- the single citable number -----
  gate: {
    requirement: 'at least 500 distinct passing countable cases',
    total_minimum: ledgerJson.total_minimum ?? 500,
    citable_distinct_passing_cases: ledgerJson.counted_passing ?? null,
    met: (ledgerJson.counted_passing ?? 0) >= (ledgerJson.total_minimum ?? 500),
  },

  ledger: {
    entries: ledgerJson.ledger_entries ?? null,
    snapshot_commit: ledgerJson.snapshot_commit ?? null,
    integrity_failures: ledgerJson.failures ?? null,
    reconciliation_defects: ledgerJson.reconciliation_defects ?? null,
    checker_exit_code: checkerExit,
  },

  citation_rule: produceCitationRule(inGithubActions, treeClean),
};

function produceCitationRule(isCi, clean) {
  if (isCi && clean) {
    return `Citable. Produced by CI on a clean checkout at ${commitSha.slice(0, 12)}. This is the only number that may be quoted for the 500-distinct-test requirement, and it is a property of this commit.`;
  }
  return 'NOT CITABLE. This is a reading of a working tree on a developer machine, not a gate result. scripts/release.mjs refuses a production deploy on it.';
}

writeFileSync(OUT_PATH, `${JSON.stringify(artefact, null, 2)}\n`);

const n = (v) => String(v ?? '-').padStart(6);
const a = artefact.accounting ?? {};
console.log('');
console.log(`release gate artefact — ${OUT_PATH}`);
console.log(`  commit        ${artefact.commit_sha_short} on ${artefact.branch}`);
console.log(
  `  produced by   ${artefact.produced_by}${artefact.tree_clean ? ' (clean tree)' : ' (DIRTY TREE)'}`,
);
console.log('');
console.log(`    discovered   (a test carrying the id exists)        ${n(a.discovered)}`);
console.log(`  + planned      (designed, no test written yet)        ${n(a.planned)}`);
console.log(`  = ledger entries                                     ${n(artefact.ledger.entries)}`);
console.log(`      executed                                         ${n(a.executed)}`);
console.log(`      not executed                                     ${n(a.not_executed)}`);
console.log(`      passing                                          ${n(a.passing)}`);
console.log(`      countable                                        ${n(a.countable)}`);
console.log(`      excluded                                         ${n(a.passing_not_countable)}`);
console.log('');
console.log(
  `  by runner     vitest=${runners.ledger_split?.vitest ?? '-'}  playwright=${runners.ledger_split?.playwright ?? '-'}  not-run=${runners.ledger_split?.none ?? '-'}`,
);
console.log(
  `  vitest run    ${runners.vitest.executed ? `${runners.vitest.passed} passed of ${runners.vitest.distinct_cases} distinct` : 'NOT EXECUTED'}`,
);
console.log(`  playwright    ${runners.playwright.executed ? 'executed' : 'NOT EXECUTED'}`);
console.log('');
for (const f of floors) {
  console.log(
    `  ${f.category.padEnd(30)} ${String(f.counted).padStart(5)} / ${String(f.minimum ?? '?').padStart(3)}  ${f.met ? 'ok' : `SHORT by ${f.short_by}`}`,
  );
}
console.log('');
console.log(
  `  citable number  ${artefact.gate.citable_distinct_passing_cases} (minimum ${artefact.gate.total_minimum})`,
);
console.log(`  ${artefact.citation_rule}`);
console.log('');
process.exit(0);
