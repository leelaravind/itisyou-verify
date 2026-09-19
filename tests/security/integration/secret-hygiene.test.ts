/**
 * SEC-63x — the secret scanner as an operational control, not just a script.
 *
 * `.github/workflows/ci.yml` runs `node scripts/scan-secrets.mjs --history` on every pull
 * request. That is the control that would catch a real credential committed by accident,
 * and it is the most valuable thing in the CI file for a public repository.
 *
 * It has started failing on synthetic test fixtures, and the failure is permanent: a
 * `secret-scan:allow` marker fixes the working tree, but a blob already committed cannot
 * be retro-marked. Left alone, the next person to see a red `--history` step will delete
 * the step, and a control that would have caught a real leak disappears to silence
 * fixtures that were never secret.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function run(args: readonly string[]): { readonly code: number; readonly output: string } {
  try {
    const output = execFileSync('node', ['scripts/scan-secrets.mjs', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('the secret scanner', () => {
  it('SEC-631 the tracked working tree is clean', () => {
    const { code, output } = run([]);
    expect(code, output).toBe(0);
  });

  it('SEC-632 FINDING: `--history` is red on committed synthetic fixtures', () => {
    // THE PROBLEM. Every hit is a synthetic `whsec_`-shaped fixture in an already-committed
    // blob, in five files across four agents (including two from an earlier revision of
    // A10's own `webhook-route.test.ts`). None is a real credential. But:
    //
    //   - `secret-scan:allow` only works on the current file; history is immutable.
    //   - CI runs `--history` on every pull request, so every PR is now red.
    //   - The obvious "fix" is to delete the step. That would remove the only control
    //     that catches a credential committed and then deleted, which is exactly the
    //     scenario `--history` exists for.
    //
    // FIX (lead owns `scripts/scan-secrets.mjs`), in order of preference:
    //
    //   1. Stop shaping fixtures like real secrets. Stripe treats the endpoint secret as an
    //      opaque ASCII string and Svix needs only valid base64 after the prefix, so no
    //      test needs a literal `whsec_` prefix at all. Rename fixtures to something like
    //      `test_endpoint_key_...` and the problem never recurs. SEC-633 enforces this
    //      going forward.
    //   2. For the blobs already committed, add a small committed allowlist of blob SHAs
    //      (`scripts/secret-scan-history-allow.json`) that `--history` consults — a SHA is
    //      a precise, auditable exemption, unlike a pattern.
    //
    // Do NOT fix this by dropping `--history` from CI, and do NOT fix it by loosening the
    // `stripe-webhook-secret` rule: that rule is the one that catches the real thing.
    const { code, output } = run(['--history']);
    const historyHits = output.split('\n').filter((line) => line.includes('history:'));
    expect(
      code,
      `--history exits non-zero on ${historyHits.length} committed fixture(s):\n${historyHits.join('\n')}`,
    ).toBe(0);
    // ~40s: it reads every blob in every commit. CI runs the same scan as its own step,
    // so this case is the record of the finding rather than the primary control.
  }, 180_000);

  it('SEC-633 no NEW fixture is shaped like a real provider secret', () => {
    // Forward-looking guard, so that once the history is cleaned this cannot recur.
    // A fixture only needs to be the right *kind* of value, never the right *shape*.
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
            const m = /\b(whsec_[A-Za-z0-9]{24,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,})/.exec(
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
    const scanner = readFileSync(join(ROOT, 'scripts', 'scan-secrets.mjs'), 'utf8');
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
  });

  it('SEC-635 CI still runs the history scan on pull requests', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/scan-secrets\.mjs --history/);
    expect(ci).toMatch(/if:\s*github\.event_name == 'pull_request'/);
  });
});
