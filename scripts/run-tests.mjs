#!/usr/bin/env node
/**
 * Run the vitest suite and refuse to call it green unless every signal agrees.
 *
 * Why this exists. Under load, vitest's worker → main RPC can time out
 * (`[vitest-worker]: Timeout calling "onTaskUpdate"`). vitest records that as an
 * "unhandled error" and sets the exit code to 1, but the pass/fail counts are never
 * touched, so the summary reads all-green while the process exits red — and the
 * results carried by the lost call are simply absent from the counts. A file can also
 * fail to be collected at all and never appear in the summary. Two agents hit this
 * independently on the same tree; the headline number was wrong in the direction of
 * false confidence. vitest's own message says as much: "This might cause false
 * positive tests."
 *
 * So this wrapper takes the exit code directly and cross-checks it against:
 *   1. the JSON reporter's own counts (failed suites / failed tests / success flag);
 *   2. the text output, for the RPC-timeout and unhandled-error banners;
 *   3. the number of test files vitest reported against the number on disk that match
 *      the include globs in vitest.config.ts — a file that was never collected is a
 *      disagreement, not a pass.
 * Any disagreement exits 1 with a loud banner. A clean run exits 0 and says so.
 *
 * CONFIRMED ROOT CAUSE (2026-09-19): this is not a concurrency/pool-size problem. It is
 * SEC-632 (`tests/security/integration/secret-hygiene.test.ts`), which calls
 * `execFileSync('node', ['scripts/scan-secrets.mjs', '--history', ...])` synchronously
 * and blocks its worker's event loop for ~200s scanning full git history. birpc's
 * hard-coded 60s `DEFAULT_TIMEOUT` for the pending `onTaskUpdate` RPC has long expired
 * by the time the loop unblocks, so the timeout fires immediately afterwards, vitest
 * logs it as an "unhandled error" and sets exit code 1 — while the printed pass/fail
 * counts, computed before the loop ever blocked, stay green. This is why the "failing"
 * file looked different between runs: it was whichever file happened to share a worker
 * with SEC-632, not a real flake. Lowering `maxWorkers` does not fix this — it only
 * changes which files get starved alongside it. The wrapper below therefore also
 * fingerprints the specific outlier-duration test file so this is a one-run diagnosis,
 * not a six-hour one, and surfaces the raw unhandled-error text instead of just naming
 * the regex that matched it.
 *
 * Usage: `pnpm test` (this), or `node scripts/run-tests.mjs [vitest args]`.
 * Positional filters (`tests/unit`) are passed through; the on-disk file count check is
 * skipped when a filter is present because the expected set is then vitest's to decide.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const JSON_OUT = join(REPORTS, 'vitest-results.json');

// Mirror of `test.include` in vitest.config.ts. If that list changes, change this one.
const INCLUDE_DIRS = ['tests/unit', 'tests/integration', 'tests/security'];
const TEST_FILE = /\.test\.ts$/;

// Anything matching these in vitest's output means the counts cannot be trusted.
const POISON = [
  /Timeout calling "/,
  /Unhandled Errors?/,
  /Vitest caught \d+ unhandled error/,
  /\[vitest-(worker|pool|api)\]/,
];

const userArgs = process.argv.slice(2);
const hasFilter = userArgs.some((a) => !a.startsWith('-'));
const inCI = Boolean(process.env.CI);

mkdirSync(REPORTS, { recursive: true });

const vitestArgs = [
  'vitest',
  'run',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${JSON_OUT}`,
  ...(inCI ? ['--reporter=junit', `--outputFile.junit=${join(REPORTS, 'junit.xml')}`] : []),
  ...userArgs,
];

function listTestFiles(dir) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    const p = join(abs, entry);
    if (statSync(p).isDirectory()) out.push(...listTestFiles(join(dir, entry)));
    else if (TEST_FILE.test(entry)) out.push(p);
  }
  return out;
}

function normalise(p) {
  return relative(ROOT, resolve(p)).split(sep).join('/');
}

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI, '');

/** Pull the "Unhandled Error(s)" section(s) out of vitest's text output, verbatim. */
function extractUnhandledErrors(text) {
  const plain = stripAnsi(text);
  const blocks = [];
  const re = /⎯+\s*Unhandled Errors?\s*⎯+([\s\S]*?)(?:\n\n\n|\n⎯{5,}\n\s*\n)/g;
  let m;
  while ((m = re.exec(plain))) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

/**
 * birpc's pending-call timeout is a hard-coded 60s. A test file whose wall-clock
 * duration approaches or exceeds that is a candidate for having blocked its worker's
 * event loop long enough to trip it — report it by name instead of leaving the reader
 * to guess which of N files did it.
 */
const BIRPC_TIMEOUT_MS = 60_000;
function findBlockingCandidates(results) {
  const rows = (results?.testResults ?? [])
    .map((r) => ({
      name: normalise(r.name ?? r.testFilePath ?? ''),
      durationMs:
        typeof r.endTime === 'number' && typeof r.startTime === 'number'
          ? r.endTime - r.startTime
          : null,
    }))
    .filter((r) => r.durationMs != null)
    .sort((a, b) => b.durationMs - a.durationMs);
  return rows.filter((r) => r.durationMs >= BIRPC_TIMEOUT_MS * 0.75);
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const rule = '!'.repeat(width);
  console.error(`\n${rule}`);
  for (const l of lines) console.error(`! ${l.padEnd(width - 4)} !`);
  console.error(`${rule}\n`);
}

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', vitestArgs, {
  cwd: ROOT,
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

let captured = '';
child.stdout.on('data', (chunk) => {
  captured += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  captured += chunk;
  process.stderr.write(chunk);
});

child.on('close', (code, signal) => {
  const exitCode = code ?? 1;
  const problems = [];

  if (signal) problems.push(`vitest was terminated by signal ${signal}`);

  const poisoned = POISON.filter((re) => re.test(captured)).map((re) => re.source);
  if (poisoned.length) {
    problems.push(
      `GREEN-SUMMARY-BUT-EXIT-1: vitest reported an RPC timeout or unhandled error ` +
        `(matched: ${poisoned.join(', ')}) — the printed pass/fail counts predate this ` +
        `and cannot be trusted even where they look green`,
    );
    for (const block of extractUnhandledErrors(captured)) {
      problems.push('--- unhandled error text (verbatim) ---', ...block.split('\n'), '---');
    }
  }

  let results = null;
  if (existsSync(JSON_OUT)) {
    try {
      results = JSON.parse(readFileSync(JSON_OUT, 'utf8'));
    } catch (error) {
      problems.push(`could not parse ${normalise(JSON_OUT)}: ${error.message}`);
    }
  } else {
    problems.push(`vitest did not write ${normalise(JSON_OUT)} — the run did not complete`);
  }

  let summary = 'no JSON summary';
  if (results) {
    const failedTests = results.numFailedTests ?? 0;
    const failedSuites = results.numFailedTestSuites ?? 0;
    const reportedFiles = Array.isArray(results.testResults) ? results.testResults.length : 0;
    summary =
      `files ${reportedFiles}, tests ${results.numPassedTests ?? 0} passed / ` +
      `${failedTests} failed / ${results.numPendingTests ?? 0} skipped`;

    if (exitCode !== 0 && failedTests === 0 && failedSuites === 0) {
      problems.push(
        `GREEN-SUMMARY-BUT-EXIT-1: summary is green (0 failures) but vitest exited ` +
          `${exitCode} — results are NOT trustworthy`,
      );
    }
    if (exitCode === 0 && (failedTests > 0 || failedSuites > 0 || results.success === false)) {
      problems.push(`vitest exited 0 but the JSON reports failures — results are NOT trustworthy`);
    }

    // Checked unconditionally — independent of exitCode/failedTests. A file already at
    // 45s+ is a latent birpc-timeout risk whether or not it has tripped the RPC yet in
    // THIS run: the next run with slightly more contention, or a slightly slower CI
    // box, is the one where it does. Catching it on a green run is the point.
    const blockers = findBlockingCandidates(results);
    if (blockers.length) {
      problems.push(
        `LATENT-BIRPC-RISK: ${blockers.length} test file(s) ran long enough to plausibly ` +
          `block their worker's event loop past birpc's hard-coded ${BIRPC_TIMEOUT_MS / 1000}s ` +
          `RPC timeout (the exact threshold this check is measuring against) — this fires ` +
          `regardless of exit code, because a file that hasn't tripped the timeout yet in ` +
          `this run is still a defect. Check these first:`,
        ...blockers.map((b) => `    ${b.name} (${Math.round(b.durationMs)}ms)`),
      );
    }

    if (!hasFilter) {
      const onDisk = INCLUDE_DIRS.flatMap(listTestFiles).map(normalise).sort();
      const reported = new Set(
        (results.testResults ?? []).map((r) => normalise(r.name ?? r.testFilePath ?? '')),
      );
      const missing = onDisk.filter((f) => !reported.has(f));
      if (missing.length) {
        problems.push(
          `${missing.length} test file(s) on disk were never reported by vitest — silently not collected:`,
          ...missing.map((m) => `    ${m}`),
        );
      }
      summary += ` (on disk: ${onDisk.length} files)`;
    }
  }

  if (problems.length) {
    banner([
      'TEST RUN IS NOT TRUSTWORTHY — treat it as failed',
      `vitest exit code: ${exitCode}; ${summary}`,
      ...problems,
    ]);
    process.exit(1);
  }

  if (exitCode !== 0) {
    console.error(`\nrun-tests: vitest exited ${exitCode}; ${summary}`);
    process.exit(exitCode);
  }

  console.log(`\nrun-tests: exit 0 and every cross-check agrees; ${summary}`);
  process.exit(0);
});
