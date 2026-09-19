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

// ---------------------------------------------------------------------------
// Evidence transport — the count stage (c) of the transport migration needs to see.
//
// `packages/contracts/src/evidence.ts` (commit `6509969`) added `transport: 'live' |
// 'simulated' | 'unknown'`, recording whether a piece of evidence actually left the
// process, independently of `origin` (which only records the channel). Requiring
// `transport === 'live'` for a mandatory assertion is the correct end state — accepting
// anything less is the same failure this field exists to catch, one layer up — but the
// evaluator (`packages/domain/src/evaluate.ts`) does not check it yet, deliberately: every
// piece of evidence produced before `6509969` has no `transport` at all, so flipping that
// switch today would move the citable gate number for a reason invisible to anyone reading
// it, and a gate that moves invisibly is how people learn to stop trusting it.
//
// So this section exists to make the *pending* state visible instead of silent. It answers
// one question: of the evidence PATHS capable of independently supporting a mandatory
// assertion (`provider_readback` / `provider_webhook`), how many have ever been confirmed
// to leave the process for real?
//
// This is a table, not a computed scan of the evidence contract, because that scan would
// require importing a TypeScript workspace package into a loader-free Node script. The
// table must be kept in sync with each connector's `capabilities().origins` by hand; a
// drift here is a defect in this table, not in the connectors, and would be caught the
// moment a new provider or origin is added without a matching row.
const MANDATORY_CAPABLE_TRANSPORT_PATHS = [
  {
    provider: 'hubspot',
    origin: 'provider_readback',
    // The one test permitted to make a real call and so the only evidence this path will
    // ever have that `transport: 'live'` actually happened. See
    // tests/integration/connectors/live-smoke.test.ts.
    confirming_case_id: 'CONN-900',
    confirmable: true,
  },
  {
    provider: 'resend',
    origin: 'provider_readback',
    confirming_case_id: 'CONN-901',
    confirmable: true,
  },
  {
    provider: 'resend',
    origin: 'provider_webhook',
    // Deliberately not confirmable through this mechanism. A valid Svix signature proves
    // the bytes match the shared secret and are fresh; it does not prove the request that
    // carried them was ever really received, so no test can honestly assert `live` here —
    // asserting it would reproduce the exact defect this field exists to catch. This path
    // stays `unknown` by design, tracked so it is visible, and its owner is whoever holds
    // `apps/app/src/routes/webhooks/resend.ts` — not this gate, and not stage (c)'s trigger.
    confirming_case_id: null,
    confirmable: false,
  },
];

function vitestStatus(caseId) {
  if (!vitest || !Array.isArray(vitest.cases)) return null;
  const found = vitest.cases.find((c) => c.id === caseId);
  return found ? found.status : null;
}

const transportPaths = MANDATORY_CAPABLE_TRANSPORT_PATHS.map((p) => {
  const status = p.confirming_case_id === null ? null : vitestStatus(p.confirming_case_id);
  return {
    ...p,
    live_confirmed: p.confirmable && status === 'passed',
    last_checked_status: status,
  };
});

const confirmableTotal = transportPaths.filter((p) => p.confirmable).length;
const confirmedLive = transportPaths.filter((p) => p.live_confirmed).length;
const pendingLive = transportPaths.filter((p) => p.confirmable && !p.live_confirmed);
const excludedByDesign = transportPaths.filter((p) => !p.confirmable);

const evidenceTransport = {
  // Named precisely so it survives being quoted alone: this is a count of PATHS (provider ×
  // origin combinations), not of test cases or of live runs.
  description:
    'Evidence paths capable of independently supporting a mandatory assertion (origin provider_readback or provider_webhook) for which transport: "live" has never been confirmed. Not a failure and not folded into the floors or the citable total — it is the number that says whether requiring transport: "live" in the evaluator (stage c of the transport migration) would currently be safe.',
  mandatory_capable_paths_total: transportPaths.length,
  confirmable_paths_total: confirmableTotal,
  confirmed_live: confirmedLive,
  pending_confirmation: pendingLive.map((p) => ({
    provider: p.provider,
    origin: p.origin,
    confirming_case_id: p.confirming_case_id,
    last_checked_status: p.last_checked_status,
  })),
  excluded_by_design: excludedByDesign.map((p) => ({
    provider: p.provider,
    origin: p.origin,
    reason:
      'a signature proves the bytes are authentic and fresh, not that the request was really received; no test can honestly assert live for this path, so it is tracked separately and is not part of the stage-c trigger',
  })),
  stage_c_trigger:
    'The evaluator may start requiring transport === "live" for a mandatory-supporting ' +
    'provider_readback assertion once EVERY row in confirmable_paths_total above reads ' +
    'confirmed_live === true, i.e. pending_confirmation is empty — concretely, once ' +
    'CONN-900 (HubSpot) and CONN-901 (Resend) have both actually run against a real, ' +
    'authorised credential and passed, rather than skipping. It does NOT require the ' +
    'excluded_by_design row (resend provider_webhook) to ever be confirmed: that path is ' +
    'permanently unknown by design, and the trigger condition must not be written in a ' +
    'way that can never be satisfied because of it. Whether provider_webhook should then ' +
    'be barred from mandatory support entirely, or judged by a different rule, is a ' +
    'separate product decision for whoever owns that route, not a precondition of this one.',
};

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

  // ----- the transport migration's own gate, reported here so it is seen rather than
  // sought out. Not part of `floors_met` or `gate.met`: it blocks nothing today. -----
  evidence_transport: evidenceTransport,

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
console.log('  evidence transport — mandatory-capable paths with transport never confirmed live');
console.log(
  `    confirmed live      ${evidenceTransport.confirmed_live} / ${evidenceTransport.confirmable_paths_total}`,
);
if (evidenceTransport.pending_confirmation.length > 0) {
  for (const p of evidenceTransport.pending_confirmation) {
    console.log(
      `    PENDING             ${p.provider} ${p.origin} — awaiting ${p.confirming_case_id} (currently ${p.last_checked_status ?? 'not run'})`,
    );
  }
} else {
  console.log('    none pending — stage (c) trigger condition is met for every confirmable path');
}
for (const p of evidenceTransport.excluded_by_design) {
  console.log(`    excluded by design  ${p.provider} ${p.origin} — ${p.reason}`);
}
console.log('');
console.log(
  `  citable number  ${artefact.gate.citable_distinct_passing_cases} (minimum ${artefact.gate.total_minimum})`,
);
console.log(`  ${artefact.citation_rule}`);
console.log('');
process.exit(0);
