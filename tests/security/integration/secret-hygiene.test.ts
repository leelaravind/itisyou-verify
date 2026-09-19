/**
 * SEC-63x — the secret scanner as an operational control, not just a script.
 *
 * `.github/workflows/ci.yml` runs `node scripts/scan-secrets.mjs --history` on every pull
 * request, and `scripts/release.mjs` runs the same scan as a release gate. That is the
 * control that catches a credential committed and then quietly deleted — the working tree
 * is clean in that scenario and only history remembers — and it is the most valuable thing
 * in the CI file for a public repository.
 *
 * ## SEC-632, and what it actually was
 *
 * This file used to run for **218,015 ms** against a next-slowest file of 2,188 ms — a
 * hundredfold outlier — because `SEC-632` called
 * `execFileSync('node', ['scripts/scan-secrets.mjs', '--history'])` synchronously. Two
 * consequences, both reproduced on an idle machine with a single worker:
 *
 *   - `execFileSync` blocks the worker's event loop for the whole scan. vitest's
 *     worker→main RPC (birpc) has a **hard-coded 60 s** pending-call timeout for
 *     `onTaskUpdate`, not reachable from the public config in either the old or the new
 *     vitest — both were diffed — so raising it was never available. The timer expired
 *     while the loop was blocked, fired the instant it unblocked, and vitest recorded an
 *     unhandled error and exited 1 while printing an all-green summary computed before the
 *     block. `scripts/run-tests.mjs` names that `GREEN-SUMMARY-BUT-EXIT-1`.
 *   - The "failing" file appeared to move between runs because it was whichever file
 *     shared a worker with this one, which sent an earlier investigation chasing agent
 *     concurrency. It was never concurrency. It was also not merely a reporting problem:
 *     the lost `onTaskUpdate` calls carried real results, so four genuinely failing owner
 *     cases were being counted as passes.
 *
 * **But the invocation was the symptom, not the defect.** The question nobody had asked
 * was why a scan of a 45-commit repository took three and a half minutes at all. It was
 * spawning `git cat-file -t`, then `-s`, then `cat-file blob` — three processes per object
 * — over ~2,036 objects: roughly 4,660 process creations, at ~24 ms each on Windows. That
 * is the entire runtime. `git cat-file --batch-check` and `--batch` read every object
 * through one long-lived process instead, in bounded chunks:
 *
 *     before: 110,957 ms          after: 1,718 ms          (~65x, same objects scanned)
 *
 * So the scan is back in this suite, where its security coverage belongs, and it is back
 * on the terms the failure taught: **asynchronous** (the loop keeps turning, so progress
 * reporting never stalls), **bounded** (an explicit deadline), and **cleaned up** (the
 * child is killed on timeout and on failure, not left behind). The wall-clock budget is
 * asserted, so this cannot silently regress into a blocking outlier again — and it is set
 * to the same 45 s threshold `run-tests.mjs` flags as a latent blocker, so this case fails
 * before the runner has to warn about it.
 *
 * The scan still runs in CI on every pull request and in the release gate on every
 * release; SEC-635 asserts both, so the step cannot be quietly deleted either. Nothing the
 * scanner checks was narrowed, and the control was verified end to end against a planted
 * historical match: a `whsec_`-shaped literal committed and then deleted leaves the
 * working-tree scan green and `--history` red, which is exactly the scenario it exists for.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * birpc's pending-call timeout is a hard-coded 60 s and `run-tests.mjs` flags any file at
 * or above 45 s as a latent blocker. Both numbers are the reason this budget exists.
 */
const SCAN_BUDGET_MS = 45_000;
/** The hard deadline. Past this the child is killed rather than waited on. */
const SCAN_DEADLINE_MS = 50_000;

interface ScanOutcome {
  readonly code: number;
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Run the scanner without blocking the event loop, under an explicit deadline, and never
 * leave a child behind.
 *
 * `execFileSync` is deliberately not used anywhere in this file — SEC-632 asserts that.
 * Even the tracked-tree scan, which finishes in well under a second, goes through this
 * path: the rule is easier to keep than a threshold, and a fast command today is a slow
 * one after the repository grows.
 *
 * Cleanup is unconditional. On the deadline the child is sent `SIGKILL`; on any error it
 * is killed too; and the timer is always cleared, so a passing case cannot leave a handle
 * holding the worker open. Output is capped so a runaway child cannot exhaust memory
 * instead of exhausting time.
 */
function runScanner(args: readonly string[]): Promise<ScanOutcome> {
  const MAX_OUTPUT = 8 * 1024 * 1024;
  return new Promise<ScanOutcome>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['scripts/scan-secrets.mjs', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let settled = false;

    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SCAN_DEADLINE_MS);
    // Never hold the worker open on our own account.
    deadline.unref?.();

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Belt and braces: if the process is somehow still alive, it does not outlive us.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve({ code, output, durationMs: Date.now() - startedAt, timedOut });
    };

    child.on('error', (error) => {
      output += `\n${String(error)}`;
      settle(1);
    });
    child.on('close', (code, signal) => settle(signal === null ? (code ?? 1) : 1));
  });
}

const readRepoFile = (...parts: readonly string[]): string =>
  readFileSync(join(ROOT, ...parts), 'utf8');

describe('the secret scanner', () => {
  it('SEC-631 the tracked working tree is clean', async () => {
    const { code, output, timedOut } = await runScanner([]);
    expect(timedOut, `the tracked-tree scan did not finish inside ${SCAN_DEADLINE_MS}ms`).toBe(
      false,
    );
    expect(code, output).toBe(0);
  });

  it(
    'SEC-632 no credential-shaped literal exists anywhere in the repository history',
    async () => {
      // THE CONTROL. `--history` reads every blob in every commit, which is the only way to
      // catch a credential that was committed and then deleted: in that scenario the
      // working tree is clean and SEC-631 above passes. Verified end to end against a
      // planted match — a `whsec_`-shaped literal committed and then removed leaves the
      // tree scan green and this one red.
      //
      // Do NOT fix a failure here by dropping `--history` from CI, by loosening the
      // `stripe-webhook-secret` rule, or by making this case synchronous again. If a hit is
      // a synthetic fixture already frozen in a committed blob, pin its full SHA in
      // `ALLOWED_HISTORY_BLOBS` with a written justification — SEC-635 keeps that list
      // honest, and SEC-633 stops it needing to grow.
      const { code, output, durationMs, timedOut } = await runScanner(['--history']);

      expect(timedOut, `the history scan did not finish inside ${SCAN_DEADLINE_MS}ms`).toBe(false);

      const historyHits = output.split('\n').filter((line) => line.includes('history:'));
      expect(
        code,
        `--history exits non-zero on ${historyHits.length} committed blob(s):\n${historyHits.join('\n')}`,
      ).toBe(0);
      // A scan that read nothing would also exit 0 — a shallow clone, or a history pass
      // that silently stopped walking. Assert it actually reported on history, so this
      // case cannot pass by having checked nothing.
      expect(output, 'the history pass reported nothing — did it scan anything?').toMatch(
        /full history/,
      );

      // The regression guard for SEC-632 itself. The scan takes ~1.7s since the scanner
      // stopped spawning three git processes per object; anything approaching 45s means
      // that batching has been undone, and a slow file here is a defect even when it
      // passes — it is what blocks progress reporting and makes co-scheduled tests
      // unattributable.
      expect(
        durationMs,
        `the history scan took ${durationMs}ms. Budget is ${SCAN_BUDGET_MS}ms — see the ` +
          `header of this file: the fix was batching git cat-file, not a longer timeout.`,
      ).toBeLessThan(SCAN_BUDGET_MS);

      // And it must stay non-blocking. `execFileSync` holds the worker's event loop; that
      // is what tripped birpc's fixed 60s RPC timer and made the suite exit 1 under a
      // green summary. The needle is assembled at runtime so this case does not match its
      // own source — the same trick the brief prescribes for credential-shaped fixtures.
      const BLOCKING_CALL = 'execFile' + 'Sync';
      const self = readRepoFile('tests', 'security', 'integration', 'secret-hygiene.test.ts');
      const sourceLines = self
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      expect(
        sourceLines.filter((line) => line.includes(BLOCKING_CALL)),
        `${BLOCKING_CALL} blocks the vitest worker event loop — use the bounded async helper`,
      ).toEqual([]);
    },
    SCAN_DEADLINE_MS + 10_000,
  );

  it('SEC-633 no NEW fixture is shaped like a real provider secret', () => {
    // Forward-looking guard, so that once the history is cleaned this cannot recur.
    // A fixture only needs to be the right *kind* of value, never the right *shape*.
    // This is also what stops the blob allowlist growing: without it, an allowlist is just
    // a slower way of turning the control off.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const source = readFileSync(p, 'utf8');
          source.split('\n').forEach((line, i) => {
            if (line.includes('secret-scan:allow')) return;
            // The shapes the scanner's high-confidence rules match.
            const m =
              /\b(whsec_[A-Za-z0-9]{24,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,})/.exec(
                line,
              );
            if (m !== null) offenders.push(`${relative(ROOT, p)}:${i + 1}  ${m[1]?.slice(0, 12)}…`);
          });
        }
      }
    };
    walk(join(ROOT, 'tests'));
    walk(join(ROOT, 'apps'));
    walk(join(ROOT, 'packages'));
    expect(offenders).toEqual([]);
  });

  it('SEC-634 the scanner still recognises every provider shape we depend on', () => {
    // Whatever is done about SEC-632, none of these rules may be weakened or removed.
    const scanner = readRepoFile('scripts', 'scan-secrets.mjs');
    for (const rule of [
      'stripe-secret',
      'stripe-webhook-secret',
      'resend-key',
      'hubspot-token',
      'openrouter-key',
      'private-key-block',
      'jwt-with-payload',
      'aws-access-key',
      'github-pat',
    ]) {
      expect(scanner, `rule ${rule} was removed`).toContain(rule);
    }
    // The batched reader is the reason this scan is affordable everywhere it runs. If it
    // goes back to a process per object, SEC-632 becomes a three-minute test again.
    expect(scanner, 'the history pass no longer batches git cat-file').toMatch(
      /cat-file'?,?\s*'--batch-check'/,
    );
    // Every child process the scanner starts is bounded and killed rather than waited on
    // indefinitely. An unbounded spawn is what produced SEC-632.
    expect(scanner, 'git child processes are no longer bounded').toMatch(/timeout:\s*GIT_TIMEOUT_MS/);
    expect(scanner, 'a timed-out git child is no longer killed').toMatch(/killSignal:\s*'SIGKILL'/);
  });

  it('SEC-635 the history scan runs in CI and in the release gate, and its exemptions stay pinned', () => {
    // These assertions are what stop the step being deleted; the step is what runs the
    // scan on code this suite never sees — a fork's pull request, a release candidate.
    const ci = readRepoFile('.github', 'workflows', 'ci.yml');
    expect(ci).toMatch(/scan-secrets\.mjs --history/);
    expect(ci).toMatch(/if:\s*github\.event_name == 'pull_request'/);
    // `--history` is meaningless against a shallow clone: git would have no older blobs to
    // read and the step would pass by having nothing to check. That is the failure mode a
    // reader would never notice, so it is asserted rather than assumed.
    expect(ci, 'the history scan needs fetch-depth: 0, or it silently scans nothing').toMatch(
      /fetch-depth:\s*0/,
    );

    const release = readRepoFile('scripts', 'release.mjs');
    expect(release, 'the release gate no longer runs the full-history secret scan').toMatch(
      /scan-secrets\.mjs['"],\s*['"]--history/,
    );

    // The historical-blob allowlist stays a precise, auditable exemption. A blob SHA is its
    // content, so each entry exempts exactly one known file; a pattern would not, and
    // anything shorter than a full 40-hex SHA is a blanket exemption wearing a disguise.
    const scanner = readRepoFile('scripts', 'scan-secrets.mjs');
    const block = /const ALLOWED_HISTORY_BLOBS = new Map\(\[([\s\S]*?)\n\]\);/.exec(scanner);
    expect(block, 'ALLOWED_HISTORY_BLOBS is gone or was reshaped').not.toBeNull();
    const entries = [...(block?.[1] ?? '').matchAll(/'([0-9a-f]{6,64})'/g)].map((m) => m[1] ?? '');
    expect(entries.length, 'the history allowlist is empty or unreadable').toBeGreaterThan(0);
    for (const sha of entries) {
      expect(sha, `history allowlist entry "${sha}" is not a full 40-character blob SHA`).toMatch(
        /^[0-9a-f]{40}$/,
      );
    }
    // Every exemption carries the reason it was granted, on the entry, in the file.
    const justifications = [...(block?.[1] ?? '').matchAll(/'[^']{12,}'\s*,/g)].length;
    expect(
      justifications,
      'every allowlisted blob needs a written justification beside its SHA',
    ).toBeGreaterThanOrEqual(entries.length);
    // And the scanner must still print the exemption count on a clean run. An exemption
    // nobody sees is an exemption nobody reviews.
    expect(scanner).toMatch(/exemptedBlobs/);
  });
});
