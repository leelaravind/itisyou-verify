/**
 * The test centre.
 *
 * Two properties. One: nothing that looks like a command, a path or an address can be
 * dispatched — the allowlist is the only vocabulary. Two: with no executor, the job queues
 * and says why, and is never reported as a pass.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_STATE_TEXT,
  NO_EXECUTOR_LIMITATION,
  QUALITY_ARTIFACTS,
  QUALITY_SUITES,
  StaticQualityArtifactStore,
  UnboundQualityArtifactStore,
  artifactMeta,
  assertNoExecutableShape,
  dispatchQualityRun,
  isAllowedSuite,
  isQualityArtifactId,
  isLiveState,
  qualityDedupeKey,
  stateIsVerdict,
  suiteById,
  type DispatchDeps,
  type ExecutorAvailability,
  type QualityRun,
} from '@app/owner/quality';
import { JOB_STATE } from '@verify/contracts';

const AT = '2026-09-19T12:00:00.000Z';

const AVAILABLE: ExecutorAvailability = { executor: 'github_actions', available: true, reason: null };
const UNAVAILABLE: ExecutorAvailability = {
  executor: 'local_runner',
  available: false,
  reason: 'No runner device is paired with this deployment.',
};

function deps(options: { availability: ExecutorAvailability; existing?: QualityRun[] }): {
  deps: DispatchDeps;
  stored: QualityRun[];
} {
  const stored: QualityRun[] = options.existing ?? [];
  let counter = 0;
  return {
    stored,
    deps: {
      findLive: async (key) => stored.find((r) => r.dedupeKey === key) ?? null,
      availability: async () => options.availability,
      persist: async (run) => {
        stored.unshift(run);
      },
      newId: () => {
        counter += 1;
        return `qrn_${counter}`;
      },
    },
  };
}

const REQUEST = { suiteId: 'unit', environment: 'staging', commitSha: 'abc123', requestedBy: 'usr_owner', at: AT };

describe('quality centre', () => {
  it('OWNER-060 a suite id outside the allowlist is rejected', async () => {
    const { deps: d, stored } = deps({ availability: AVAILABLE });
    const result = await dispatchQualityRun({ ...REQUEST, suiteId: 'totally_made_up' }, d);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('suite_not_allowed');
    expect(stored).toHaveLength(0);
  });

  it('OWNER-061 a shell command is rejected before the allowlist is even consulted', async () => {
    const { deps: d } = deps({ availability: AVAILABLE });
    const result = await dispatchQualityRun({ ...REQUEST, suiteId: 'unit; rm -rf /' }, d);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unsafe_suite_id');
  });

  it('OWNER-062 a filesystem path, a URL and a repository reference are all rejected', () => {
    expect(assertNoExecutableShape('../../etc/passwd')).toBe(false);
    expect(assertNoExecutableShape('https://example.invalid/script.sh')).toBe(false);
    expect(assertNoExecutableShape('git@example.invalid:me/repo.git')).toBe(false);
    expect(assertNoExecutableShape('scripts/build-test-report.mjs')).toBe(false);
    expect(assertNoExecutableShape('--eval')).toBe(false);
    expect(assertNoExecutableShape('unit')).toBe(true);
  });

  it('OWNER-063 every allowlisted suite passes the shape check it is protected by', () => {
    for (const suite of QUALITY_SUITES) {
      expect(assertNoExecutableShape(suite.id)).toBe(true);
      expect(isAllowedSuite(suite.id)).toBe(true);
    }
  });

  it('OWNER-064 with an executor available the job is queued', async () => {
    const { deps: d, stored } = deps({ availability: AVAILABLE });
    const result = await dispatchQualityRun(REQUEST, d);
    if (!result.ok) throw new Error('unreachable');
    expect(result.run.state).toBe('queued');
    expect(result.run.blockedReason).toBeNull();
    expect(stored).toHaveLength(1);
  });

  it('OWNER-065 with no executor the job queues as awaiting_runner and says why', async () => {
    const { deps: d, stored } = deps({ availability: UNAVAILABLE });
    const result = await dispatchQualityRun(REQUEST, d);
    if (!result.ok) throw new Error('unreachable');
    expect(result.run.state).toBe('awaiting_runner');
    expect(result.run.blockedReason).toBe(UNAVAILABLE.reason);
    // The job is real and saved — it is not silently dropped.
    expect(stored).toHaveLength(1);
  });

  it('OWNER-066 with no executor nothing is reported as passed and no counts are invented', async () => {
    const { deps: d } = deps({ availability: UNAVAILABLE });
    const result = await dispatchQualityRun(REQUEST, d);
    if (!result.ok) throw new Error('unreachable');
    expect(stateIsVerdict(result.run.state)).toBe(false);
    expect(result.run.passed).toBeNull();
    expect(result.run.failed).toBeNull();
    expect(result.run.totalCases).toBeNull();
    expect(result.run.limitations).toBe(NO_EXECUTOR_LIMITATION);
  });

  it('OWNER-067 a duplicate request deduplicates rather than starting a second run', async () => {
    const { deps: d, stored } = deps({ availability: AVAILABLE });
    const first = await dispatchQualityRun(REQUEST, d);
    const second = await dispatchQualityRun(REQUEST, d);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.deduplicated).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(stored).toHaveLength(1);
  });

  it('OWNER-068 a request for a different commit is a different run', async () => {
    const { deps: d, stored } = deps({ availability: AVAILABLE });
    await dispatchQualityRun(REQUEST, d);
    const second = await dispatchQualityRun({ ...REQUEST, commitSha: 'def456' }, d);
    if (!second.ok) throw new Error('unreachable');
    expect(second.deduplicated).toBe(false);
    expect(stored).toHaveLength(2);
  });

  it('OWNER-069 a finished run does not absorb a fresh request', async () => {
    const { deps: d, stored } = deps({ availability: AVAILABLE });
    const first = await dispatchQualityRun(REQUEST, d);
    if (!first.ok) throw new Error('unreachable');
    stored[0] = { ...first.run, state: 'passed' };
    const second = await dispatchQualityRun(REQUEST, d);
    if (!second.ok) throw new Error('unreachable');
    expect(second.deduplicated).toBe(false);
    expect(isLiveState('passed')).toBe(false);
  });

  it('OWNER-070 the dedupe key is stable across calls and varies with the environment', async () => {
    const a = await qualityDedupeKey({ suiteId: 'unit', environment: 'staging', commitSha: 'x' });
    const b = await qualityDedupeKey({ suiteId: 'unit', environment: 'staging', commitSha: 'x' });
    const c = await qualityDedupeKey({ suiteId: 'unit', environment: 'production', commitSha: 'x' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('OWNER-071 every job state has a plain-language meaning, including the three that are not verdicts', () => {
    for (const state of JOB_STATE) {
      const text = JOB_STATE_TEXT[state];
      expect(text.label.length).toBeGreaterThan(0);
      expect(text.meaning.length).toBeGreaterThan(20);
    }
    expect(JOB_STATE_TEXT.timed_out.meaning).toMatch(/not a pass/i);
    expect(JOB_STATE_TEXT.infrastructure_error.meaning).toMatch(/nothing is proved/i);
    expect(JOB_STATE_TEXT.awaiting_runner.meaning).toMatch(/no result exists/i);
  });

  it('OWNER-072 only passed and failed are treated as verdicts about the code', () => {
    expect(stateIsVerdict('passed')).toBe(true);
    expect(stateIsVerdict('failed')).toBe(true);
    for (const state of ['queued', 'awaiting_runner', 'running', 'cancelled', 'timed_out', 'infrastructure_error'] as const) {
      expect(stateIsVerdict(state)).toBe(false);
    }
  });

  it('OWNER-073 every suite states what it does not prove', () => {
    for (const suite of QUALITY_SUITES) {
      expect(suite.doesNotProve.length).toBeGreaterThan(20);
      expect(suite.mayCostMoney).toBe(false);
    }
    expect(suiteById('unit')?.label).toBe('Unit tests');
    expect(suiteById('nope')).toBeNull();
  });

  it('OWNER-074 the artifact list is exactly the four files the report script produces', () => {
    expect(QUALITY_ARTIFACTS.map((a) => a.id).sort()).toEqual([
      'junit.xml',
      'release-readiness.md',
      'test-report.md',
      'test-results.json',
    ]);
    expect(isQualityArtifactId('test-report.md')).toBe(true);
    expect(isQualityArtifactId('../../.dev.vars')).toBe(false);
    expect(artifactMeta('junit.xml')?.contentType).toMatch(/xml/);
  });

  it('OWNER-075 an unbound artifact store returns nothing and explains why, rather than an empty file', async () => {
    const store = new UnboundQualityArtifactStore();
    expect(await store.get()).toBeNull();
    expect(store.unavailableReason()).toMatch(/not been uploaded/i);
  });

  it('OWNER-076 a bound artifact store returns the real bytes', async () => {
    const store = new StaticQualityArtifactStore([
      { id: 'test-report.md', body: '# report\n', generatedAt: AT, commitSha: 'abc' },
    ]);
    const stored = await store.get('test-report.md');
    expect(stored?.body).toBe('# report\n');
    expect(store.unavailableReason()).toBeNull();
  });
});
