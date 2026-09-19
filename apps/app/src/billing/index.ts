/**
 * The billing subsystem's public surface.
 *
 * `memory.ts` is deliberately absent: it is a test double and must not be reachable from
 * production code by an accidental import.
 */
export {
  PLAN,
  PLAN_VERSION,
  PAYMENT_FAILURE_GRACE_DAYS,
  MAX_WEBHOOK_BODY_BYTES,
  buildBillingConfig,
  checkoutReturnUrls,
  portalReturnUrl,
  resolvePlan,
  type BillingConfig,
  type BillingConfigInput,
  type BillingEnvironment,
  type PlanDefinition,
} from './config';

export type {
  AllowanceRecord,
  BillingCustomerRecord,
  BillingDataPort,
  OrderRecord,
  RefundRecord,
  RefundState,
  SubscriptionRecord,
  WebhookAdmission,
  WebhookProcessingStatus,
} from './port';

export type {
  BillingGatewayPort,
  GatewayCheckoutSession,
  GatewayCustomer,
  GatewayPortalSession,
  GatewayRefund,
  GatewaySubscription,
} from './gateway';

export {
  systemClock,
  type BillingClock,
  type BillingContactLookup,
  type BillingIdFactory,
  type BillingRuntime,
  type EligibilityCheck,
  type EligibilityResult,
} from './runtime';

export {
  PAYMENT_RECOVERY_DAYS,
  PAYMENT_RECOVERY_POLICY,
  PRE_CHECKOUT_DISCLOSURE,
  entitlementWithRecovery,
  paymentRecoveryWindow,
  recoveryStatement,
  type PaymentRecoveryPolicy,
  type PaymentRecoveryWindow,
  type PreCheckoutDisclosure,
  type RecoveryAwareEntitlement,
  type RecoveryPhase,
} from './policy';

export {
  expirePaymentRecoveryWindows,
  paymentProblemNotification,
  recoveryStatus,
  type PaymentProblemNotification,
  type RecoverySweepOptions,
  type RecoverySweepReport,
  type RecoveryStatusView,
  type SuspendedSubscription,
} from './recovery';

export {
  GRACE_SUBSCRIPTION_STATUSES,
  SERVING_SUBSCRIPTION_STATUSES,
  TERMINAL_ORDER_STATUSES,
  allowancePeriodKey,
  asSubscriptionStatus,
  billingPeriodKey,
  entitlementFor,
  graceDeadline,
  orderTransition,
  providerModeMatches,
  reconcileSubscription,
  unixToIso,
  type EntitlementView,
  type OrderEvent,
  type OrderTransition,
  type ProviderSubscriptionSnapshot,
  type ServiceLevel,
  type SubscriptionDecision,
} from './state';

export {
  admissionDecision,
  allowanceView,
  atAllowance,
  consume,
  release,
  remainingRuns,
  reserve,
  rollover,
  type AdmissionDecision,
  type AdmissionKind,
  type AllowanceSnapshot,
  type AllowanceView,
} from './entitlements';

export {
  checkoutIdempotencyKey,
  readCheckoutReturn,
  startCheckout,
  type CheckoutDeps,
  type CheckoutReturnView,
  type StartCheckoutParams,
  type StartCheckoutResult,
} from './checkout';

export {
  cancelSubscription,
  openBillingPortal,
  type CancellationResult,
  type CancellationTiming,
  type OpenPortalResult,
} from './portal';

export {
  BILLING_SECRET_NAMES,
  BillingConfigurationError,
  assertBillingSecrets,
  billingConfigFromEnv,
  billingEnvironmentOf,
  checkBillingSecrets,
  createBillingRuntime,
  createEndpointSecretResolver,
  createStripeWebhookDeps,
  type BillingEnv,
  type BillingRuntimeParts,
} from './mount';

export {
  createProvisionRoute,
  provisionIdempotencyKey,
  provisionPlanPrice,
  type ProvisionFailureCode,
  type ProvisionOutcome,
  type ProvisionRouteDeps,
  type ProvisioningGateway,
} from './provision';

export {
  preCheckoutDisclosureText,
  preCheckoutPanel,
  type DisclosureFact,
  type DisclosureSection,
  type PreCheckoutPanel,
} from './disclosure';

export {
  REFUND_POLICY_RULES,
  applyProviderRefund,
  customerVisibleRefundState,
  decideRefund,
  isRefundPolicyRule,
  listRefundQueue,
  providerRefundEvent,
  refundApprovalPayload,
  recommendRefund,
  refundIdempotencyKey,
  refundTransition,
  requestRefund,
  type OwnerDecisionParams,
  type RefundEvent,
  type RefundPolicyRule,
  type RefundQueueItem,
  type RefundRecommendation,
  type RefundTransition,
  type RequestRefundParams,
  type RequestRefundResult,
} from './refunds';

export {
  reconcileSubscriptions,
  type Discrepancy,
  type DiscrepancyKind,
  type ReconciliationReport,
} from './reconcile';

export {
  HANDLED_EVENT_TYPES,
  handleStripeEvent,
  invoicePeriodEnd,
  invoicePeriodStart,
  invoiceSubscriptionId,
  type EventOutcome,
  type StripeEventShape,
} from './events';
