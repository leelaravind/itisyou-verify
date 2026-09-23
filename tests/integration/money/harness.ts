/**
 * The money-path integration harness.
 *
 * Builds the **real** things: A02's SQLite-backed `Db` over the real migrations, A06's
 * `D1BillingDataPort`, A16's events route assembled exactly as `money/mount.ts` assembles
 * it, and a signing key issued through the same function the activation page will call.
 *
 * What is faked is only the outside world, and only where there is nothing to fake it
 * with: the clock, the id factory, and a provider gateway that **throws if it is touched**
 * — which is itself an assertion, because admission must never reach a provider.
 *
 * ## The anchor is chosen to be hostile
 *
 * `SUBSCRIPTION_PERIOD_END` is deliberately neither the run's calendar month nor the run's
 * own date. A harness whose allowance key happened to coincide with either would let a
 * caller that re-derived the key pass — which is exactly how A13-010 survived two green
 * suites. If any part of this path slices a date instead of asking `billing/period.ts`,
 * these tests go red.
 */
import { signRequest } from '@verify/security';
import type { BillingGatewayPort } from '@app/billing/gateway';
import type { BillingRuntime } from '@app/billing/runtime';
import { allowancePeriodKey } from '@app/billing/period';
import { PAYMENT_FAILURE_GRACE_DAYS, PLAN } from '@app/billing/config';
import { D1BillingDataPort } from '@app/db/billingPort';
import { createEventsRoute, KEY_ID_HEADER, SIGNATURE_HEADER } from '@app/money/eventsRoute';
import { createSigningKeyResolver, issueWorkflowSigningKey } from '@app/money/signingKeys';
import { createTestDb, seedWorkspace, type SeededWorkspace, type TestDb } from '../db/harness';
import { D1AllowanceRepair, D1WorkflowSigningKeys } from './d1ports';

/** The tick this suite runs at. Inside the paid period, and not on its boundary. */
export const NOW = '2026-09-19T10:00:00.000Z';

/**
 * The subscription's current period end.
 *
 * `2026-10-05` is neither `2026-09` (the run's calendar month) nor `2026-09-19` (the run's
 * date), so a re-derived key cannot accidentally match the real one.
 */
export const SUBSCRIPTION_PERIOD_END = '2026-10-05T00:00:00.000Z';

/** The one correct allowance key, from the one function allowed to produce it. */
export const ALLOWANCE_KEY = allowancePeriodKey(SUBSCRIPTION_PERIOD_END);

/** The calendar-month key the old code wrote. Never correct; used to seed the defect. */
export const LEGACY_MONTH_KEY = '2026-09';

/** A synthetic root key. 64 hex characters of nothing; not a credential. */
export const TEST_ROOT_KEY = 'a'.repeat(64);

export const ENVIRONMENT = 'test' as const;

/** A gateway that fails the test if anything reaches it. Admission calls no provider. */
export const NO_PROVIDER: BillingGatewayPort = new Proxy({} as BillingGatewayPort, {
  get(_target, property) {
    return () => {
      throw new Error(
        `the money path reached the provider gateway (${String(property)}); admission must not`,
      );
    };
  },
});

export interface MoneyHarness {
  readonly h: TestDb;
  readonly ws: SeededWorkspace;
  readonly keyId: string;
  readonly secret: string;
  readonly app: ReturnType<typeof createEventsRoute>;
  readonly billing: BillingRuntime;
  readonly repair: D1AllowanceRepair;
  /** Ids handed out in order, so a failure names the row it wrote. */
  readonly ids: string[];
  close(): void;
}

export interface HarnessOptions {
  /** The allowance row's key. Defaults to the correct one. */
  readonly billingPeriod?: string;
  readonly runLimit?: number;
  /** Omit to seed no subscription at all. */
  readonly subscription?: {
    readonly status?: string;
    readonly currentPeriodEnd?: string | null;
    /** Sets `updated_at`, which is when a payment-recovery window is measured from. */
    readonly updatedAt?: string;
  } | null;
  /** Absent means the deployment cannot verify signatures. Used by the 503 case. */
  readonly rootKey?: string;
  readonly now?: string;
  /**
   * Captures what the route asks the transport to send, and decides the outcome.
   *
   * Absent means the deployment has no transport wired, which is a real configuration: the
   * route must admit every event correctly and simply never warn.
   */
  readonly sendUsageAlert?: (request: {
    notificationKey: string;
    template: string;
    recipientEmail: string;
  }) => Promise<{ outcome: 'sent' | 'duplicate' | 'suppressed' | 'failed' }>;
}

export async function createMoneyHarness(options: HarnessOptions = {}): Promise<MoneyHarness> {
  const h = createTestDb();
  const now = options.now ?? NOW;
  const ws = seedWorkspace(h, 'money', {
    createdAt: now,
    billingPeriod: options.billingPeriod ?? ALLOWANCE_KEY,
    ...(options.runLimit === undefined ? {} : { runLimit: options.runLimit }),
  });

  const subscription = options.subscription;
  if (subscription !== null) {
    h.raw
      .prepare(
        `INSERT INTO subscriptions
           (id, workspace_id, provider_subscription_id, environment, status, price_id,
            current_period_end, cancel_at_period_end, provider_event_created, updated_at)
         VALUES (?, ?, ?, 'test', ?, 'price_test123', ?, 0, 0, ?)`,
      )
      .run(
        'sub_money',
        ws.workspaceId,
        'sub_provider_money',
        subscription?.status ?? 'active',
        subscription?.currentPeriodEnd === undefined
          ? SUBSCRIPTION_PERIOD_END
          : subscription.currentPeriodEnd,
        subscription?.updatedAt ?? now,
      );
  }

  const rootKey = options.rootKey ?? TEST_ROOT_KEY;
  // Issued through the shipped function, against the shipped `workflows.setSigningKey`.
  const issued = await issueWorkflowSigningKey(
    { db: h.db, rootKey: TEST_ROOT_KEY, now },
    { workspaceId: ws.workspaceId, workflowId: ws.workflowId },
  );

  const ids: string[] = [];
  let counter = 0;
  const mint = (prefix: string): string => {
    counter += 1;
    const id = `${prefix}_t${String(counter).padStart(4, '0')}`;
    ids.push(id);
    return id;
  };

  const billing: BillingRuntime = {
    config: {
      environment: ENVIRONMENT,
      plan: PLAN,
      priceId: '',
      publicBaseUrl: 'https://verify.example',
      gracePeriodDays: PAYMENT_FAILURE_GRACE_DAYS,
    },
    data: new D1BillingDataPort(h.db),
    gateway: NO_PROVIDER,
    now: () => now,
    newId: mint,
  };

  const app = createEventsRoute({
    db: h.db,
    resolveSigningKey: createSigningKeyResolver({
      store: new D1WorkflowSigningKeys(h.db),
      rootKey,
    }),
    billing: {
      ...billing,
      // A workspace we can write to. Without a contact there is nobody to warn, which is a
      // real state the alert code returns null for — and not the one these cases are about.
      billingContact: async () => ({ workspaceName: 'Test workspace', email: 'ada@example.test' }),
    },
    now: () => new Date(now),
    newId: mint,
    ...(options.sendUsageAlert === undefined ? {} : { sendUsageAlert: options.sendUsageAlert }),
  });

  return {
    h,
    ws,
    keyId: issued.keyId,
    secret: issued.secret,
    app,
    billing,
    repair: new D1AllowanceRepair(h.db),
    ids,
    close: () => h.close(),
  };
}

/** A well-formed source event for the seeded workflow. */
export function eventBody(
  ws: SeededWorkspace,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: 'evt-000000001',
    workflow_id: ws.workflowId,
    occurred_at: NOW,
    correlation_id: 'enq_0000000000000001',
    expected: { email_recipient: 'ada@example.test' },
    ...overrides,
  };
}

export interface PostOptions {
  /** Replace the signature header entirely. `null` omits it. */
  readonly signature?: string | null;
  readonly keyId?: string | null;
  /** Unix seconds to sign with. Defaults to the harness clock. */
  readonly timestamp?: number;
  /** Sign with this instead of the issued secret. */
  readonly secret?: string;
  readonly contentLength?: string;
}

/**
 * POST a signed event through the real route.
 *
 * The signature is computed over the exact bytes sent, which is the property the whole
 * scheme rests on: a re-serialised body is a different document.
 */
export async function postEvent(
  harness: MoneyHarness,
  body: Record<string, unknown> | string,
  options: PostOptions = {},
): Promise<Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });

  const keyId = options.keyId === undefined ? harness.keyId : options.keyId;
  if (keyId !== null) headers.set(KEY_ID_HEADER, keyId);

  if (options.signature === undefined) {
    headers.set(
      SIGNATURE_HEADER,
      await signRequest({
        secret: options.secret ?? harness.secret,
        rawBody: raw,
        timestamp: options.timestamp ?? Math.floor(Date.parse(NOW) / 1000),
      }),
    );
  } else if (options.signature !== null) {
    headers.set(SIGNATURE_HEADER, options.signature);
  }

  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);

  return harness.app.fetch(
    new Request('https://verify.example/api/v1/events', { method: 'POST', headers, body: raw }),
  );
}

/** Read the allowance row straight out of the database. No repository in the way. */
export function allowanceRow(
  h: TestDb,
  workspaceId: string,
  billingPeriod: string,
): { run_limit: number; consumed: number; reserved: number } | undefined {
  return h.raw
    .prepare(
      'SELECT run_limit, consumed, reserved FROM entitlements WHERE workspace_id = ? AND billing_period = ?',
    )
    .get(workspaceId, billingPeriod) as
    { run_limit: number; consumed: number; reserved: number } | undefined;
}

export function allowanceRows(
  h: TestDb,
  workspaceId: string,
): { billing_period: string; run_limit: number; consumed: number; reserved: number }[] {
  return h.raw
    .prepare(
      'SELECT billing_period, run_limit, consumed, reserved FROM entitlements WHERE workspace_id = ? ORDER BY billing_period',
    )
    .all(workspaceId) as {
    billing_period: string;
    run_limit: number;
    consumed: number;
    reserved: number;
  }[];
}

export function runRows(
  h: TestDb,
  workspaceId: string,
): { id: string; status: string; created_at: string; next_check_at: string | null }[] {
  return h.raw
    .prepare(
      'SELECT id, status, created_at, next_check_at FROM runs WHERE workspace_id = ? ORDER BY created_at',
    )
    .all(workspaceId) as {
    id: string;
    status: string;
    created_at: string;
    next_check_at: string | null;
  }[];
}
