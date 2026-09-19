/**
 * The scheduler: the part of the product that works when nobody is watching.
 *
 * `handleScheduled` is the single entry point the Worker's `scheduled()` handler calls.
 * Everything else here is exported for tests and for the owner-facing operations view.
 */
export {
  handleScheduled,
  runSchedulerTick,
  createRetentionSweeper,
  PRODUCTION_CONNECTORS,
  IMPLEMENTED_SCHEDULER_PASSES,
  type SchedulerPass,
  type SchedulerEnv,
  type ScheduledOptions,
  type TickDeps,
  type TickReport,
  type RunPassReport,
} from './tick';

export {
  TickBudget,
  TICK_DEFAULTS,
  observationsRemainingAfter,
  type BudgetStop,
  type TickBudgetOptions,
} from './budget';

export {
  observeRun,
  deferredOutcome,
  hasWorkingEvidenceAccess,
  summariseEvidence,
  MAX_EXTERNAL_CALLS_PER_RUN,
  type ObservationOutcome,
  type ObservationNote,
  type ObserveDeps,
} from './observe';

export {
  dispatchOutbox,
  dispatchBackoffSeconds,
  defaultOutboxHandlers,
  runCreatedHandler,
  runDecidedAcknowledgeHandler,
  readRunDecidedPayload,
  MAX_DISPATCH_ATTEMPTS,
  DISPATCH_BACKOFF_BASE_SECONDS,
  DISPATCH_BACKOFF_MAX_SECONDS,
  type DispatchDeps,
  type DispatchReport,
  type RunDecidedPayload,
} from './dispatch';

export { runRetentionPass, type RetentionPassDeps, type RetentionPassReport } from './retention';

export {
  createD1CredentialResolver,
  NOT_CONNECTED_RESOLVER,
  CONNECTOR_CREDENTIAL_PURPOSE,
  type D1CredentialResolverOptions,
} from './credentials';

export {
  SILENT_LOGGER,
  type ConnectionResolution,
  type ConnectionUnavailableReason,
  type ConnectorRegistry,
  type CredentialResolver,
  type DigestFn,
  type ElapsedFn,
  type IdFactory,
  type OutboxEvent,
  type OutboxHandler,
  type ResolvedConnection,
  type RetentionSweeper,
  type SchedulerLogger,
} from './ports';
