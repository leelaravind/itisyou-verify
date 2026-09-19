/**
 * The typed maintenance job vocabulary.
 *
 * Two things this file exists to make impossible:
 *
 *  1. **An arbitrary command.** A job carries a `typed_kind` from a closed allowlist and a
 *     payload validated against that kind's schema. The runner maps the kind to a
 *     compiled-in command. Nothing in the payload becomes part of a shell string, ever —
 *     not a path, not a note, not a brief.
 *  2. **A natural-language request becoming an instruction.** A free-text request from the
 *     owner (or worse, from an assistant proposal) becomes a `MaintenanceBrief`: capped,
 *     control-character-stripped, marked `needs_review`, and carried to the runner as
 *     *data on stdin*. The runner hands it to a coding agent as a prompt if one is
 *     available, and otherwise returns `infrastructure_error`. It is never concatenated
 *     into a command line.
 *
 * Paths are data. `validateRepoPath` rejects traversal, absolute paths, Windows drive
 * letters, UNC prefixes, percent-encoding and anything outside a conservative charset —
 * and the runner resolves each accepted path under the repository root and re-checks
 * containment before it is used.
 */

export const MAINTENANCE_JOB_KINDS = [
  'run_health_checks',
  'collect_redacted_diagnostics',
  'run_test_suite',
  'investigate_incident',
  'prepare_patch',
  'execute_approved_release',
] as const;

export type MaintenanceJobKind = (typeof MAINTENANCE_JOB_KINDS)[number];

export function isMaintenanceJobKind(value: unknown): value is MaintenanceJobKind {
  return typeof value === 'string' && (MAINTENANCE_JOB_KINDS as readonly string[]).includes(value);
}

/** Kinds that can move money or change what customers are served. Approval-bound. */
export const APPROVAL_REQUIRED_KINDS: ReadonlySet<MaintenanceJobKind> = new Set([
  'execute_approved_release',
]);

/** Kinds that genuinely need a coding agent, and therefore have a capability precondition. */
export const CODING_AGENT_KINDS: ReadonlySet<MaintenanceJobKind> = new Set([
  'investigate_incident',
  'prepare_patch',
]);

export const MAINTENANCE_LIMITS = {
  MAX_BRIEF_SUMMARY_CHARS: 200,
  MAX_BRIEF_CONTEXT_CHARS: 2_000,
  MAX_BRIEF_CONSTRAINTS: 8,
  MAX_CONSTRAINT_CHARS: 200,
  MAX_PATHS: 20,
  MAX_PATH_CHARS: 200,
  /** How long a runner may hold a claim before it is reclaimable. */
  LEASE_SECONDS: 900,
  /** A device with no heartbeat for this long is displayed as offline. */
  OFFLINE_AFTER_SECONDS: 180,
  /** Pairing codes are short-lived by design. */
  PAIRING_CODE_TTL_SECONDS: 600,
  /** Cap on a redacted result document. */
  MAX_RESULT_CHARS: 16_000,
} as const;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type PathRejection =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'ABSOLUTE'
  | 'DRIVE_LETTER'
  | 'BACKSLASH'
  | 'TRAVERSAL'
  | 'DOT_SEGMENT'
  | 'EMPTY_SEGMENT'
  | 'PERCENT_ENCODED'
  | 'ILLEGAL_CHARACTER'
  | 'FORBIDDEN_PREFIX';

export type PathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: PathRejection };

/** Directories a maintenance job has no business naming. */
const FORBIDDEN_PREFIXES = ['.git/', 'node_modules/', '.wrangler/', 'secrets/', '.secrets/'];

const ALLOWED_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

/**
 * A repository-relative POSIX path, or a typed rejection.
 *
 * Every rule here is a denial of a real traversal technique, not a style preference:
 * `..` segments, an absolute path, a Windows drive (`C:`), a UNC or backslash separator,
 * a percent-encoded `%2e%2e`, a NUL or any other character outside the allowlist.
 */
export function validateRepoPath(candidate: unknown): PathCheck {
  if (typeof candidate !== 'string') return { ok: false, reason: 'EMPTY' };
  const value = candidate.trim();
  if (value.length === 0) return { ok: false, reason: 'EMPTY' };
  if (value.length > MAINTENANCE_LIMITS.MAX_PATH_CHARS) return { ok: false, reason: 'TOO_LONG' };
  if (value.includes('%')) return { ok: false, reason: 'PERCENT_ENCODED' };
  if (value.includes('\\')) return { ok: false, reason: 'BACKSLASH' };
  if (/^[A-Za-z]:/.test(value)) return { ok: false, reason: 'DRIVE_LETTER' };
  if (value.startsWith('/') || value.startsWith('~')) return { ok: false, reason: 'ABSOLUTE' };
  if (!ALLOWED_PATH_CHARS.test(value)) return { ok: false, reason: 'ILLEGAL_CHARACTER' };

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: 'EMPTY_SEGMENT' };
    if (segment === '..') return { ok: false, reason: 'TRAVERSAL' };
    if (segment === '.') return { ok: false, reason: 'DOT_SEGMENT' };
  }

  const lower = value.toLowerCase();
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (lower === prefix.slice(0, -1) || lower.startsWith(prefix)) {
      return { ok: false, reason: 'FORBIDDEN_PREFIX' };
    }
  }
  return { ok: true, path: value };
}

// ---------------------------------------------------------------------------
// The reviewed brief
// ---------------------------------------------------------------------------

export interface MaintenanceBrief {
  readonly summary: string;
  readonly context: string;
  readonly constraints: readonly string[];
  /**
   * `needs_review` until a human has read it. The hosted side refuses to enqueue a
   * coding-agent job whose brief is still `needs_review`, so a proposal cannot become a
   * running agent without a person in between.
   */
  readonly review_state: 'needs_review' | 'reviewed';
  /** Who reviewed it. `null` while unreviewed. */
  readonly reviewed_by: string | null;
}

function clean(text: unknown, maxChars: number): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    const keep = ch === '\n';
    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    out += keep || printable ? ch : ' ';
  }
  return out.trim().slice(0, maxChars);
}

/**
 * Turn free text into a brief. The result is always `needs_review`.
 *
 * This is the only door natural language has into the maintenance system, and it is a
 * one-way door into a *data* structure. There is no branch anywhere downstream that turns
 * any of these three fields into an executable token.
 */
export function briefFromNaturalLanguage(request: {
  readonly summary: string;
  readonly context?: string;
  readonly constraints?: readonly string[];
}): MaintenanceBrief {
  const constraints = (request.constraints ?? [])
    .slice(0, MAINTENANCE_LIMITS.MAX_BRIEF_CONSTRAINTS)
    .map((item) => clean(item, MAINTENANCE_LIMITS.MAX_CONSTRAINT_CHARS))
    .filter((item) => item.length > 0);

  return {
    summary: clean(request.summary, MAINTENANCE_LIMITS.MAX_BRIEF_SUMMARY_CHARS),
    context: clean(request.context ?? '', MAINTENANCE_LIMITS.MAX_BRIEF_CONTEXT_CHARS),
    constraints,
    review_state: 'needs_review',
    reviewed_by: null,
  };
}

/** Mark a brief reviewed. Deliberately a separate, owner-driven step. */
export function markBriefReviewed(brief: MaintenanceBrief, reviewedBy: string): MaintenanceBrief {
  return { ...brief, review_state: 'reviewed', reviewed_by: reviewedBy };
}

function parseBrief(value: unknown): MaintenanceBrief | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const summary = clean(source['summary'], MAINTENANCE_LIMITS.MAX_BRIEF_SUMMARY_CHARS);
  if (summary.length === 0) return null;
  const rawConstraints = source['constraints'];
  const constraints = Array.isArray(rawConstraints)
    ? rawConstraints
        .slice(0, MAINTENANCE_LIMITS.MAX_BRIEF_CONSTRAINTS)
        .map((item) => clean(item, MAINTENANCE_LIMITS.MAX_CONSTRAINT_CHARS))
        .filter((item) => item.length > 0)
    : [];
  const reviewState = source['review_state'] === 'reviewed' ? 'reviewed' : 'needs_review';
  const reviewedBy = source['reviewed_by'];
  return {
    summary,
    context: clean(source['context'], MAINTENANCE_LIMITS.MAX_BRIEF_CONTEXT_CHARS),
    constraints,
    review_state: reviewState,
    reviewed_by: typeof reviewedBy === 'string' ? reviewedBy.slice(0, 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Payload validation, per kind
// ---------------------------------------------------------------------------

export const TEST_SUITES = ['unit', 'integration', 'security', 'typecheck', 'all'] as const;
export type TestSuite = (typeof TEST_SUITES)[number];

export const DIAGNOSTIC_AREAS = ['database', 'connectors', 'scheduler', 'billing'] as const;
export type DiagnosticArea = (typeof DIAGNOSTIC_AREAS)[number];

export const RELEASE_ENVIRONMENTS = ['staging', 'production'] as const;
export type ReleaseEnvironment = (typeof RELEASE_ENVIRONMENTS)[number];

export type MaintenancePayload =
  | { readonly kind: 'run_health_checks' }
  | { readonly kind: 'collect_redacted_diagnostics'; readonly area: DiagnosticArea }
  | { readonly kind: 'run_test_suite'; readonly suite: TestSuite }
  | {
      readonly kind: 'investigate_incident';
      readonly incident_ref: string;
      readonly brief: MaintenanceBrief;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'prepare_patch';
      readonly brief: MaintenanceBrief;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'execute_approved_release';
      readonly environment: ReleaseEnvironment;
      readonly approval_id: string;
    };

export type PayloadRejection = { readonly field: string; readonly reason: string };

export type PayloadCheck =
  | { readonly ok: true; readonly payload: MaintenancePayload }
  | { readonly ok: false; readonly problems: readonly PayloadRejection[] };

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function readPaths(raw: unknown, problems: PayloadRejection[]): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({ field: 'paths', reason: 'paths must be an array of repository paths' });
    return [];
  }
  if (raw.length > MAINTENANCE_LIMITS.MAX_PATHS) {
    problems.push({ field: 'paths', reason: `at most ${MAINTENANCE_LIMITS.MAX_PATHS} paths` });
    return [];
  }
  const out: string[] = [];
  for (const candidate of raw) {
    const check = validateRepoPath(candidate);
    if (!check.ok) {
      problems.push({ field: 'paths', reason: `rejected path (${check.reason})` });
      continue;
    }
    out.push(check.path);
  }
  return out;
}

/**
 * Validate a payload against its kind. An unknown kind is refused here, at enqueue, which
 * is the earliest possible point — a job row never exists with a kind nothing can run.
 */
export function validateMaintenancePayload(kind: unknown, raw: unknown): PayloadCheck {
  if (!isMaintenanceJobKind(kind)) {
    return {
      ok: false,
      problems: [{ field: 'typed_kind', reason: 'unknown maintenance job kind' }],
    };
  }
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const problems: PayloadRejection[] = [];

  switch (kind) {
    case 'run_health_checks':
      return { ok: true, payload: { kind } };

    case 'collect_redacted_diagnostics': {
      const area = oneOf(source['area'] ?? 'database', DIAGNOSTIC_AREAS);
      if (area === null) problems.push({ field: 'area', reason: 'unknown diagnostic area' });
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, payload: { kind, area: area as DiagnosticArea } };
    }

    case 'run_test_suite': {
      const suite = oneOf(source['suite'], TEST_SUITES);
      if (suite === null) problems.push({ field: 'suite', reason: 'unknown test suite' });
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, payload: { kind, suite: suite as TestSuite } };
    }

    case 'investigate_incident': {
      const incidentRef = source['incident_ref'];
      if (typeof incidentRef !== 'string' || incidentRef.length === 0 || incidentRef.length > 100) {
        problems.push({ field: 'incident_ref', reason: 'incident_ref must be a short string' });
      }
      const brief = parseBrief(source['brief']);
      if (brief === null)
        problems.push({ field: 'brief', reason: 'a brief with a summary is required' });
      const paths = readPaths(source['paths'], problems);
      return problems.length > 0
        ? { ok: false, problems }
        : {
            ok: true,
            payload: {
              kind,
              incident_ref: incidentRef as string,
              brief: brief as MaintenanceBrief,
              paths,
            },
          };
    }

    case 'prepare_patch': {
      const brief = parseBrief(source['brief']);
      if (brief === null)
        problems.push({ field: 'brief', reason: 'a brief with a summary is required' });
      const paths = readPaths(source['paths'], problems);
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, payload: { kind, brief: brief as MaintenanceBrief, paths } };
    }

    case 'execute_approved_release': {
      const environment = oneOf(source['environment'], RELEASE_ENVIRONMENTS);
      if (environment === null) {
        problems.push({
          field: 'environment',
          reason: 'environment must be staging or production',
        });
      }
      const approvalId = source['approval_id'];
      if (typeof approvalId !== 'string' || approvalId.length === 0 || approvalId.length > 100) {
        problems.push({ field: 'approval_id', reason: 'a granted approval id is required' });
      }
      return problems.length > 0
        ? { ok: false, problems }
        : {
            ok: true,
            payload: {
              kind,
              environment: environment as ReleaseEnvironment,
              approval_id: approvalId as string,
            },
          };
    }

    default: {
      // `kind` is narrowed to never here; the branch exists so adding a kind to the
      // allowlist without a schema is a compile error rather than a runtime surprise.
      const exhaustive: never = kind;
      return {
        ok: false,
        problems: [{ field: 'typed_kind', reason: `no schema for ${String(exhaustive)}` }],
      };
    }
  }
}
