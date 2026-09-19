/**
 * Every path that admits or performs billable work, enumerated — and what enforces it.
 *
 * ## Why a list, and why it is code
 *
 * "A path you cannot enumerate is a path you cannot claim is covered." The audit's finding
 * was not that the entitlement logic was wrong; it was that **no request reached it**, and
 * that survived several rounds of review because reviewing means reading the logic, and
 * the logic read correctly. The only way that does not recur is if the set of doors is
 * written down somewhere a change has to update.
 *
 * So this is a constant, not a document. `BILL-360` walks the shipped source for route
 * definitions and scheduler passes and fails when it finds one this list does not mention.
 * A new endpoint is then a red test with the endpoint's own name in it, rather than a gap
 * somebody notices a quarter later.
 *
 * ## What counts as billable
 *
 * A path is billable when traversing it can **reserve or consume a unit of plan
 * allowance**, or perform the verification work a unit pays for. Everything else — reading
 * a page, signing in, a provider callback that only records evidence — is listed as not
 * billable, with the reason, because "not billable" is also a claim.
 */

export type EnforcementKind =
  /** `checkAdmission` is called before any write. */
  | 'admission_gate'
  /**
   * The unit was taken when the work was admitted; this path spends what is already held.
   * Re-checking entitlement here would strand work the customer has already paid for.
   */
  | 'holds_existing_reservation'
  /** Nothing billable happens here, so there is nothing to enforce. */
  | 'not_billable';

export interface MoneyPath {
  /** How the outside world reaches it: an HTTP method and path, or a scheduler pass. */
  readonly entryPoint: string;
  /** The file that owns the entry point. Checked by `BILL-360` against the tree. */
  readonly file: string;
  readonly billable: boolean;
  readonly enforcement: EnforcementKind;
  /** Where the enforcement actually happens. `null` only when `not_billable`. */
  readonly enforcedAt: string | null;
  /** Why this classification is right. Written for somebody re-deriving it, not for a log. */
  readonly reason: string;
}

/**
 * The doors.
 *
 * Ordered by how a unit of allowance moves through the system: taken at the events route,
 * spent by the scheduler, released or settled there too.
 */
export const MONEY_PATHS: readonly MoneyPath[] = Object.freeze([
  {
    entryPoint: 'POST /api/v1/events',
    file: 'apps/app/src/money/eventsRoute.ts',
    billable: true,
    enforcement: 'admission_gate',
    enforcedAt: 'apps/app/src/money/eventsRoute.ts checkAdmission',
    reason:
      'The only path that can reserve a unit. `checkAdmission` runs before `admitOnce`, so ' +
      'a workspace we have decided not to serve never reaches the reservation at all.',
  },
  {
    entryPoint: 'scheduler pass: due_job',
    file: 'apps/app/src/scheduler/tick.ts',
    billable: true,
    enforcement: 'holds_existing_reservation',
    enforcedAt: 'apps/app/src/scheduler/observe.ts resolveAllowancePeriodKey',
    reason:
      'Performs the verification a reserved unit already paid for, and settles that unit ' +
      'against the period it was taken from. Re-checking entitlement here would abandon ' +
      'work the customer has been charged for — the documented rule for a queue retry.',
  },
  {
    entryPoint: 'scheduler pass: outbox',
    file: 'apps/app/src/scheduler/dispatch.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'Announces what the due-job pass already committed. It reserves nothing and calls no ' +
      'provider on the customer’s behalf.',
  },
  {
    entryPoint: 'scheduler pass: retention',
    file: 'apps/app/src/scheduler/retention.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'Deletes expired evidence. It has no knowledge of subscription status, deliberately: ' +
      'that absence is what makes "nothing is deleted for non-payment" provable.',
  },
  {
    entryPoint: 'POST /api/v1/webhooks/stripe/:opaqueId',
    file: 'apps/app/src/routes/webhooks/stripe.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'Changes entitlement rather than spending it, and only behind a verified signature. ' +
      'Gating it on entitlement would be circular.',
  },
  {
    entryPoint: 'POST /api/v1/webhooks/resend/:opaqueId',
    file: 'apps/app/src/routes/webhooks/resend.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'Records delivery evidence for a run that already holds a unit, and promotes a ' +
      'connection. A provider callback never reserves — the same rule the allowance ' +
      'arithmetic keeps.',
  },
  {
    entryPoint: 'POST /api/v1/runner/*',
    file: 'apps/app/src/maintenance/routes.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'The owner’s own device-signed maintenance runner. It touches no customer allowance ' +
      'and authenticates with an Ed25519 device signature rather than a session.',
  },
  {
    entryPoint: 'POST /api/v1/billing/provision-price',
    file: 'apps/app/src/billing/provision.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason: 'An owner bootstrap that creates a Stripe price. No customer work is admitted.',
  },
  {
    entryPoint: 'GET|POST /app/*',
    file: 'apps/app/src/routes/app/index.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'The customer application: sign-in, history, export, card update and cancellation. ' +
      'These must keep working during a payment problem — gating them is the behaviour ' +
      'the recovery policy exists to forbid.',
  },
  {
    entryPoint: 'GET /support/contact, POST /support',
    file: 'apps/app/src/support/publicRoute.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'The signed-out support form. It admits no work against any workspace — it takes no ' +
      'workspace id and writes a case with workspace_id NULL — so there is no allowance to ' +
      'reserve. Gating it would be the exact behaviour the recovery policy forbids: the ' +
      'people who most need to reach us are the ones whose service is paused or who cannot ' +
      'sign in. Abuse is bounded by a rate limit, not by entitlement.',
  },
  {
    entryPoint: 'GET|POST /owner/*, /admin/*',
    file: 'apps/app/src/routes/owner/index.ts',
    billable: false,
    enforcement: 'not_billable',
    enforcedAt: null,
    reason:
      'The owner panel. Guarded by owner authentication and, for anything that moves money, ' +
      'by a single-use approval — a different control from plan allowance.',
  },
]);

/** The paths that can take a unit of a customer’s allowance. */
export function billablePaths(): readonly MoneyPath[] {
  return MONEY_PATHS.filter((path) => path.billable);
}

/**
 * Paths a reader should treat as unproven.
 *
 * Empty is the goal and not the default. Anything listed here is a door somebody believes
 * is covered and nobody has demonstrated, and it belongs in the handoff rather than in a
 * summary sentence.
 */
export const UNVERIFIED_PATHS: readonly string[] = Object.freeze([]);
