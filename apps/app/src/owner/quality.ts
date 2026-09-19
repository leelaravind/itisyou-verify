/**
 * The test centre — `/owner/quality`.
 *
 * The owner presses a button and a test suite runs. The entire security of that sentence
 * rests on one decision: **the browser never names what to execute.** It names a suite id
 * from a closed list, and the list is the only thing that knows about commands, scripts,
 * repositories or paths. There is no field anywhere in this module that could carry
 * `npm run ; rm -rf /`, a git URL or `../../etc/passwd`, because no field is ever used to
 * build a command — the runner resolves a suite id to its own local recipe.
 *
 * {@link assertNoExecutableShape} exists anyway, as a second wall. An allowlist that is
 * later "temporarily" widened is exactly the change nobody reviews carefully.
 *
 * ## No executor means no result
 *
 * A Cloudflare Worker cannot run a test suite. If nothing is listening — no paired runner
 * device, no CI hook — the job is **queued and shown as `awaiting_runner` with the reason**.
 * It is never reported as passing, and the dispatch never quietly becomes a no-op that
 * renders a green tick. That is the whole reason this file returns a dependency instead of
 * a result.
 */
import type { JobState } from '@verify/contracts';
import { sha256Hex, stableStringify } from '@verify/security';

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

export interface QualitySuite {
  readonly id: string;
  readonly label: string;
  /** What this suite actually proves, for the owner who is about to press the button. */
  readonly proves: string;
  /** What it cannot prove. Always rendered beside the button. */
  readonly doesNotProve: string;
  /** Roughly how long it takes, so the owner knows whether to wait. */
  readonly typicalMinutes: number;
  /** True when the suite may reach a real provider and therefore may cost money. */
  readonly mayCostMoney: boolean;
}

/**
 * Every suite the owner may dispatch. The `id` is the ONLY thing that crosses the network
 * from the browser. A runner maps an id to its own command; this deployment never does.
 */
export const QUALITY_SUITES: readonly QualitySuite[] = [
  {
    id: 'unit',
    label: 'Unit tests',
    proves: 'The rules, the money arithmetic and the decision logic behave as written.',
    doesNotProve: 'Nothing about the database, the browser or any provider.',
    typicalMinutes: 1,
    mayCostMoney: false,
  },
  {
    id: 'integration',
    label: 'Integration tests',
    proves: 'The database work — tenant scoping, idempotency, budget guards — against a real SQLite.',
    doesNotProve:
      'Cloudflare D1 over the network. The SQL is real; the network, the replicas and true parallelism are not exercised.',
    typicalMinutes: 3,
    mayCostMoney: false,
  },
  {
    id: 'security',
    label: 'Security regression',
    proves: 'The specific attacks we have already defended against stay defended.',
    doesNotProve: 'That there is no attack we have not thought of. No test suite proves that.',
    typicalMinutes: 2,
    mayCostMoney: false,
  },
  {
    id: 'browser',
    label: 'Browser tests',
    proves: 'The pages work with a keyboard, at phone width, in a real rendering engine.',
    doesNotProve: 'Behaviour on a physical device, on a real network, or with assistive technology in use.',
    typicalMinutes: 6,
    mayCostMoney: false,
  },
  {
    id: 'full',
    label: 'Everything',
    proves: 'All of the above in one run, which is what the release report is built from.',
    doesNotProve: 'Anything the individual suites do not prove.',
    typicalMinutes: 10,
    mayCostMoney: false,
  },
  {
    id: 'release_report',
    label: 'Rebuild the release evidence pack',
    proves: 'Regenerates the test report, the results file and the release-readiness decision from a real run.',
    doesNotProve: 'Nothing extra — it is the "everything" run plus the paperwork.',
    typicalMinutes: 11,
    mayCostMoney: false,
  },
];

export type QualitySuiteId = string;

const SUITE_BY_ID = new Map(QUALITY_SUITES.map((s) => [s.id, s]));

export function isAllowedSuite(id: string): boolean {
  return SUITE_BY_ID.has(id);
}

export function suiteById(id: string): QualitySuite | null {
  return SUITE_BY_ID.get(id) ?? null;
}

/**
 * Second wall. Rejects anything shaped like a command, a path, a URL or a repository
 * reference before the allowlist is even consulted, so a future widening of the list
 * cannot turn a suite id into an execution vector.
 */
const EXECUTABLE_SHAPE = /[/\\:;&|<>$`'"*?\s]|\.\.|^-/;

export function assertNoExecutableShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return !EXECUTABLE_SHAPE.test(value);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type QualityExecutor = 'hosted' | 'github_actions' | 'local_runner';

export interface QualityRun {
  readonly id: string;
  readonly suiteId: string;
  readonly environment: string;
  readonly executor: QualityExecutor;
  readonly state: JobState;
  readonly commitSha: string | null;
  readonly dedupeKey: string;
  readonly requestedBy: string;
  readonly totalCases: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  /** Which artifact set this run produced, or null while it has produced none. */
  readonly reportRef: string | null;
  /** What this run could not prove. Always present, never an empty string. */
  readonly limitations: string;
  /**
   * Why the run is not progressing, when it is not. Null when it is running normally.
   * This is the field that replaces a fabricated success.
   */
  readonly blockedReason: string | null;
}

/** States from which a request for the same suite deduplicates rather than starting again. */
const LIVE_STATES: ReadonlySet<JobState> = new Set<JobState>(['queued', 'awaiting_runner', 'running']);

export function isLiveState(state: JobState): boolean {
  return LIVE_STATES.has(state);
}

export function isTerminalState(state: JobState): boolean {
  return !LIVE_STATES.has(state);
}

/**
 * The key two identical requests collide on: suite, environment and the commit under test.
 * Deliberately not the requester or the time — a double-tapped button and two browser tabs
 * are the cases this exists for.
 */
export async function qualityDedupeKey(input: {
  readonly suiteId: string;
  readonly environment: string;
  readonly commitSha: string | null;
}): Promise<string> {
  return sha256Hex(
    `verify.quality.v1:${stableStringify({
      suite_id: input.suiteId,
      environment: input.environment,
      commit_sha: input.commitSha,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ExecutorAvailability {
  readonly executor: QualityExecutor;
  readonly available: boolean;
  /** Why not, when not. Shown verbatim on the page. Never null when unavailable. */
  readonly reason: string | null;
}

export interface DispatchInput {
  readonly suiteId: string;
  readonly environment: string;
  readonly commitSha: string | null;
  readonly requestedBy: string;
  readonly at: string;
}

export interface DispatchDeps {
  /** A live run with this dedupe key, if there is one. */
  readonly findLive: (dedupeKey: string) => Promise<QualityRun | null>;
  readonly availability: () => Promise<ExecutorAvailability>;
  readonly persist: (run: QualityRun) => Promise<void>;
  readonly newId: () => string;
}

export type DispatchResult =
  | { readonly ok: true; readonly run: QualityRun; readonly deduplicated: boolean }
  | {
      readonly ok: false;
      readonly reason: 'suite_not_allowed' | 'unsafe_suite_id';
      readonly detail: string;
    };

export const NO_EXECUTOR_LIMITATION =
  'This run has not executed. No test executor is connected to this deployment, so nothing has been ' +
  'proved either way. The job is queued and will run when an executor is available.';

/**
 * Ask for a suite to run.
 *
 * Returns the existing run when one is already live for the same suite, environment and
 * commit — the second press of a button is the same request, not a second one.
 */
export async function dispatchQualityRun(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (!assertNoExecutableShape(input.suiteId)) {
    return {
      ok: false,
      reason: 'unsafe_suite_id',
      detail:
        'That is not a suite name. Only the named suites on this page can be run, and nothing that looks ' +
        'like a command, a path or an address is accepted here at all.',
    };
  }
  const suite = suiteById(input.suiteId);
  if (suite === null) {
    return {
      ok: false,
      reason: 'suite_not_allowed',
      detail: `There is no test suite called "${input.suiteId}". Choose one of the suites listed on this page.`,
    };
  }

  const dedupeKey = await qualityDedupeKey({
    suiteId: suite.id,
    environment: input.environment,
    commitSha: input.commitSha,
  });

  const existing = await deps.findLive(dedupeKey);
  if (existing !== null && isLiveState(existing.state)) {
    return { ok: true, run: existing, deduplicated: true };
  }

  const availability = await deps.availability();
  const state: JobState = availability.available ? 'queued' : 'awaiting_runner';

  const run: QualityRun = {
    id: deps.newId(),
    suiteId: suite.id,
    environment: input.environment,
    executor: availability.executor,
    state,
    commitSha: input.commitSha,
    dedupeKey,
    requestedBy: input.requestedBy,
    totalCases: null,
    passed: null,
    failed: null,
    skipped: null,
    startedAt: null,
    endedAt: null,
    createdAt: input.at,
    reportRef: null,
    limitations: availability.available ? suite.doesNotProve : NO_EXECUTOR_LIMITATION,
    blockedReason: availability.available
      ? null
      : (availability.reason ??
        'No test executor is connected to this deployment.'),
  };

  await deps.persist(run);
  return { ok: true, run, deduplicated: false };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Plain language for every job state. Never a bare state word on a page. */
export const JOB_STATE_TEXT: Readonly<Record<JobState, { readonly label: string; readonly meaning: string }>> = {
  queued: {
    label: 'Queued',
    meaning: 'An executor has accepted the job and has not started it yet.',
  },
  awaiting_runner: {
    label: 'Waiting for a runner',
    meaning:
      'Nothing is connected that can run tests. The job is saved and will run when something is. No result exists yet.',
  },
  running: { label: 'Running', meaning: 'The suite is executing now.' },
  passed: { label: 'Passed', meaning: 'Every case in this suite executed and passed on the commit named below.' },
  failed: { label: 'Failed', meaning: 'At least one case failed. The report names which.' },
  cancelled: { label: 'Cancelled', meaning: 'Someone stopped this run before it finished. Nothing is proved.' },
  timed_out: {
    label: 'Timed out',
    meaning: 'The run exceeded its time limit and was stopped. This is not a pass and not a failure.',
  },
  infrastructure_error: {
    label: 'Could not run',
    meaning:
      'Something in the machinery failed — not the code under test. Nothing is proved either way; run it again.',
  },
};

/** True when a state carries a genuine verdict about the code. */
export function stateIsVerdict(state: JobState): boolean {
  return state === 'passed' || state === 'failed';
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export type QualityArtifactId =
  | 'test-report.md'
  | 'test-results.json'
  | 'junit.xml'
  | 'release-readiness.md';

export interface QualityArtifactMeta {
  readonly id: QualityArtifactId;
  readonly label: string;
  readonly contentType: string;
  readonly description: string;
}

/** The four files `scripts/build-test-report.mjs` produces, and nothing else. */
export const QUALITY_ARTIFACTS: readonly QualityArtifactMeta[] = [
  {
    id: 'test-report.md',
    label: 'Test report',
    contentType: 'text/markdown; charset=utf-8',
    description: 'The human-readable report: what ran, what passed, and what the run does not prove.',
  },
  {
    id: 'test-results.json',
    label: 'Test results',
    contentType: 'application/json; charset=utf-8',
    description: 'Every case with its id, outcome and timing, for anyone who wants to check the totals.',
  },
  {
    id: 'junit.xml',
    label: 'JUnit XML',
    contentType: 'application/xml; charset=utf-8',
    description: 'The same results in the format other tools read.',
  },
  {
    id: 'release-readiness.md',
    label: 'Release readiness',
    contentType: 'text/markdown; charset=utf-8',
    description: 'The release decision, the blockers, and the dependencies no test can clear.',
  },
];

const ARTIFACT_BY_ID = new Map(QUALITY_ARTIFACTS.map((a) => [a.id as string, a]));

export function isQualityArtifactId(value: string): value is QualityArtifactId {
  return ARTIFACT_BY_ID.has(value);
}

export function artifactMeta(id: string): QualityArtifactMeta | null {
  return ARTIFACT_BY_ID.get(id) ?? null;
}

export interface StoredArtifact {
  readonly id: QualityArtifactId;
  readonly body: string;
  /** When the pack this file belongs to was produced. Null when genuinely unknown. */
  readonly generatedAt: string | null;
  readonly commitSha: string | null;
}

/**
 * Where the evidence pack lives.
 *
 * A Worker has no filesystem, and `reports/` must not be published through the public
 * asset directory — those files would then be world-readable, which is precisely what
 * "authenticated downloads" rules out. So this is a port: the lead binds an implementation
 * that reads from wherever the pack is actually stored for that deployment (R2, KV, or a
 * build-time embed), and until one is bound the route says so rather than serving nothing
 * and calling it a download.
 */
export interface QualityArtifactStore {
  get(id: QualityArtifactId): Promise<StoredArtifact | null>;
  /** Why the store is empty, when it is. Rendered on the page. */
  unavailableReason(): string | null;
}

/** The honest default: no pack is bound to this deployment, and the page says so. */
export class UnboundQualityArtifactStore implements QualityArtifactStore {
  async get(): Promise<StoredArtifact | null> {
    return null;
  }

  unavailableReason(): string {
    return (
      'No test evidence pack is attached to this deployment. The files are produced by ' +
      '`scripts/build-test-report.mjs` on a machine that can run the suite, and they have not been uploaded here. ' +
      'Until they are, there is nothing to download — not an empty file, and not an older run pretending to be this one.'
    );
  }
}

/** An in-memory store, for tests and for a deployment that embeds the pack at build time. */
export class StaticQualityArtifactStore implements QualityArtifactStore {
  readonly #items: ReadonlyMap<string, StoredArtifact>;

  constructor(items: readonly StoredArtifact[]) {
    this.#items = new Map(items.map((i) => [i.id as string, i]));
  }

  async get(id: QualityArtifactId): Promise<StoredArtifact | null> {
    return this.#items.get(id) ?? null;
  }

  unavailableReason(): string | null {
    return this.#items.size === 0
      ? 'The evidence pack attached to this deployment is empty.'
      : null;
  }
}
