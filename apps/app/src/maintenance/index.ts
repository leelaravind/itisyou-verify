/**
 * The maintenance connector — hosted side.
 *
 * Read `docs/assistant-and-maintenance.md` before wiring any of this into a page. The
 * short version, stated here so it cannot be lost in a refactor:
 *
 *   This service **cannot** command a coding agent on the owner's machine. There is no
 *   inbound API for that. What exists is a local process the owner runs, under their own
 *   account, which polls these endpoints outbound, claims one job, runs a fixed command,
 *   and posts back a redacted result. When that process is not running, jobs queue and
 *   everything else about the service carries on.
 */
export {
  MAINTENANCE_JOB_KINDS,
  MAINTENANCE_LIMITS,
  APPROVAL_REQUIRED_KINDS,
  CODING_AGENT_KINDS,
  DIAGNOSTIC_AREAS,
  RELEASE_ENVIRONMENTS,
  TEST_SUITES,
  briefFromNaturalLanguage,
  isMaintenanceJobKind,
  markBriefReviewed,
  validateMaintenancePayload,
  validateRepoPath,
  type DiagnosticArea,
  type MaintenanceBrief,
  type MaintenanceJobKind,
  type MaintenancePayload,
  type PathCheck,
  type PathRejection,
  type ReleaseEnvironment,
  type TestSuite,
} from './kinds.js';

export {
  CLAIMABLE_STATES,
  TERMINAL_STATES,
  maintenanceJobs,
  runnerDevices,
  type MaintenanceJobRow,
  type MaintenanceJobState,
  type RunnerDeviceRow,
  type RunnerDeviceStatus,
} from './store.js';

export {
  RUNNER_HEADERS,
  RUNNER_SIGNATURE_VERSION,
  RUNNER_TIMESTAMP_TOLERANCE_SECONDS,
  authenticateRunner,
  canonicalRunnerString,
  completePairing,
  generatePairingCode,
  hashPairingCode,
  openPairing,
  parsePublicKey,
  presenceOf,
  readRunnerHeaders,
  type DevicePresence,
  type PairingInvitation,
  type PairingResult,
  type RunnerAuthFailure,
  type RunnerAuthResult,
  type RunnerRequestParts,
} from './devices.js';

export {
  RESULT_OUTCOMES,
  enqueueJob,
  leaseOneJob,
  recordJobResult,
  redactResultText,
  runnerAvailability,
  runnerStatus,
  validateRunnerResult,
  type EnqueueParams,
  type EnqueueRefusal,
  type EnqueueResult,
  type LeaseResult,
  type LeasedJob,
  type ResultOutcome,
  type ResultResponse,
  type RunnerAvailability,
  type RunnerStatusView,
  type StoredResult,
} from './jobs.js';

export {
  createD1ReleaseApprovalAuthority,
  noActionTypeCoversRelease,
  type ReleaseApprovalAuthority,
  type ReleaseApprovalRejection,
  type ReleaseCoverage,
  type ReleasePayload,
} from './approvalAuthority.js';

export { createRunnerRoutes, type RunnerRouteDeps } from './routes.js';

/** Live bindings for A07's owner ports in `apps/app/src/owner/runner.ts`. */
export { D1AssistantStatusPort, D1MaintenanceRunnerPort } from './ownerPort.js';
