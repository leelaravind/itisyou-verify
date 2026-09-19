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
    problems.push(`vitest reported an RPC timeout or unhandled error (${poisoned.join(', ')})`);
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
        `summary is green (0 failures) but vitest exited ${exitCode} — results are NOT trustworthy`,
      );
    }
    if (exitCode === 0 && (failedTests > 0 || failedSuites > 0 || results.success === false)) {
      problems.push(`vitest exited 0 but the JSON reports failures — results are NOT trustworthy`);
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
