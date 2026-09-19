/**
 * The money path, as one surface.
 *
 * Two entry points and nothing else the composition root should need:
 *
 *  - `createMoneyRoutes(env, parts)` — the signed-event door, `POST /api/v1/events`.
 *  - `runMoneyMaintenance(deps, options)` — every money job the cron tick must drive.
 *
 * Everything else exported here is for tests, for the owner panel, or for A02's data layer
 * to implement. If a new caller needs more than the two entry points above, that is worth
 * a second look: the reason this module has a small surface is that a large one is how
 * half a path gets wired.
 */
export {
  createEventsRoute,
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  type EventsLog,
  type EventsRouteDeps,
  type EventRejection,
} from './eventsRoute';

export {
  admissionOnlyConfig,
  createAdmissionRuntime,
  createMoneyRoutes,
  moneyPathReadiness,
  type MoneyEnv,
  type MoneyMountParts,
  type MoneyPathReadiness,
} from './mount';

export {
  moneyMaintenanceLogLine,
  moneyMaintenanceNotifications,
  runMoneyMaintenance,
  ALLOWANCE_REPAIR_EVERY_MINUTES,
  type MoneyMaintenanceDeps,
  type MoneyMaintenanceOptions,
  type MoneyMaintenanceReport,
} from './maintenance';

export {
  candidateKeysForMonth,
  reconcileAllowancePeriods,
  DEFAULT_RUN_SCAN_LIMIT,
  DEFAULT_WORKSPACE_LIMIT,
  type AllowanceReconciliationReport,
  type CounterRepair,
  type LegacyFold,
  type ReconcileAllowanceOptions,
} from './periodReconciliation';

export {
  createSigningKeyResolver,
  deriveSigningSecret,
  issueWorkflowSigningKey,
  signingKeyMaterial,
  SIGNING_KEY_REF_PREFIX,
  WORKFLOW_SIGNING_HASH_DOMAIN,
  type IssuedSigningKey,
  type ResolvedSigningKey,
  type SigningKeyResolution,
  type SigningKeyResolver,
} from './signingKeys';

export {
  billablePaths,
  MONEY_PATHS,
  UNVERIFIED_PATHS,
  type EnforcementKind,
  type MoneyPath,
} from './paths';

export type {
  AllowanceRepairPort,
  AllowanceRowSnapshot,
  RunPeriodFact,
  SigningKeyStore,
  StoredSigningKey,
} from './ports';
