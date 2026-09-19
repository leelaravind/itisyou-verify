/**
 * Sending a notification, exactly once, and recording only what we can actually observe.
 *
 * Three rules, in priority order:
 *
 *  1. **At most once.** Every notification carries a `notification_key`. The key is
 *     `UNIQUE` in `notification_deliveries`, and the claim is
 *     `INSERT … ON CONFLICT DO NOTHING`. A duplicate queue message loses the race, gets
 *     `inserted: false`, and sends nothing. If a process dies between claiming the key
 *     and settling it, the row stays `pending` and the message is *not* sent by a later
 *     duplicate. That is a deliberate at-most-once choice: a customer receiving the same
 *     "your data has been deleted" email twice is worse than a missing one the owner
 *     queue can see and resend by hand under a new key.
 *
 *  2. **Never claim delivery.** We can observe that a sending service accepted a message.
 *     We cannot observe that a receiving mail server took it, and we certainly cannot
 *     observe that a person read it. The recorded `provider_status` therefore comes from
 *     a fixed vocabulary in this file, never from the provider's own marketing words —
 *     and a provider token shaped like "delivered" at the acceptance step is normalised
 *     to `accepted_by_sending_service`, because that is all it actually proves. This is
 *     the same distinction the product sells; the notification layer does not get an
 *     exemption from it.
 *
 *  3. **Never break a request path.** If `RESEND_API_KEY` is unset, or the transport
 *     throws, or the database write fails, this function records what it can and returns
 *     a result. It does not throw. The core service works with no email configured.
 */
import { hashToken } from '@verify/security';
import { newId, ID_PREFIX } from '../lib/ids';
import { addSecondsIso, toIso } from '../lib/time';
import type {
  NotificationChannel,
  NotificationState,
  NotificationTransport,
  OutboundMessage,
  SupportDataPort,
} from '../support/port';
import { renderNotification, type NotificationTemplate, type TemplateVariables } from './templates';

/* -------------------------------------------------------------------------- */
/* recorded status vocabulary                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The only statuses this system will write to `notification_deliveries.provider_status`.
 *
 * There is no `delivered` member and there must never be one.
 */
export const RECORDED_STATUS = [
  'accepted_by_sending_service',
  'rejected_by_sending_service',
  'sending_service_unavailable',
  'send_attempts_exhausted',
  'no_email_transport_configured',
  'no_telegram_transport_configured',
  'recipient_address_unusable',
  'refused_by_content_policy',
  'transport_error',
  'suppressed_by_grouping',
  'suppressed_by_preference',
] as const;
export type RecordedStatus = (typeof RECORDED_STATUS)[number];

/**
 * Normalise whatever a transport says into one recorded status.
 *
 * The provider's own word is deliberately discarded. A sending service that answers
 * "delivered" to a submission call is telling us it accepted the message — it cannot know
 * more than that at the instant it answers — so acceptance is the only thing recorded.
 *
 * Exported so a test can prove that no input, including the literal string `delivered`,
 * produces a recorded status claiming delivery.
 */
export function recordedStatusFor(result: {
  readonly accepted: boolean;
  readonly providerStatus: string;
  readonly retryable: boolean;
}): RecordedStatus {
  if (result.accepted) return 'accepted_by_sending_service';
  const token = result.providerStatus.trim().toLowerCase();
  if (result.retryable) return 'sending_service_unavailable';
  if (token.includes('invalid') || token.includes('recipient')) {
    return 'recipient_address_unusable';
  }
  return 'rejected_by_sending_service';
}

/**
 * The customer- and owner-facing sentence for a recorded status. Every sentence here is
 * checkable against something we observed.
 *
 * NEW WORDING (A09): A01 wrote no delivery-status copy. Flagged in the handoff.
 */
export const STATUS_STATEMENT: Readonly<Record<RecordedStatus, string>> = {
  accepted_by_sending_service:
    'The sending service accepted this message. That is not the same as the message reaching the recipient’s mail server, and we do not claim it did.',
  rejected_by_sending_service: 'The sending service refused this message, so it was never sent.',
  sending_service_unavailable:
    'We could not reach the sending service within the attempts allowed, so this message was not sent.',
  send_attempts_exhausted:
    'We tried the allowed number of times and the sending service never accepted this message.',
  no_email_transport_configured:
    'No email sending service is configured, so nothing was sent. The message and the reason are recorded, and no part of the service depends on it having gone out.',
  no_telegram_transport_configured:
    'The owner’s Telegram channel is not configured, so nothing was sent there. The message and the reason are recorded, and nothing waits on it.',
  refused_by_content_policy:
    'This message was refused before it was sent, because its content or its kind is not permitted on the channel it was addressed to.',
  recipient_address_unusable:
    'The sending service would not accept this recipient address, so nothing was sent.',
  transport_error:
    'Something went wrong on our side while attempting to send, so this message was not sent.',
  suppressed_by_grouping:
    'This message was not sent because we had already told this workspace about the same situation inside the grouping window.',
  suppressed_by_preference:
    'This message was not sent because the workspace has turned this kind of notification off.',
};

/* -------------------------------------------------------------------------- */
/* request and result                                                         */
/* -------------------------------------------------------------------------- */

/** Bounded retries. Three attempts, then we stop and record what happened. */
export const MAX_SEND_ATTEMPTS = 3;
/** Deterministic exponential backoff in milliseconds: 1s, 4s. No jitter, so tests pin it. */
export const BACKOFF_BASE_MS = 1_000;

export interface SendRequest<T extends NotificationTemplate> {
  /**
   * The idempotency key. Must be derived from the *event*, never from the clock:
   * `deletion_completed:ws_123` is right, `deletion_completed:ws_123:1758240000` is not.
   */
  readonly notificationKey: string;
  readonly workspaceId: string | null;
  readonly recipientEmail: string;
  readonly template: T;
  readonly vars: TemplateVariables<T>;
  /** Pre-decided suppression from `grouping.ts` or a customer preference. */
  readonly suppress?: Extract<
    RecordedStatus,
    'suppressed_by_grouping' | 'suppressed_by_preference'
  >;
}

export interface SendResult {
  readonly notificationKey: string;
  /**
   * `duplicate` means the key was already claimed and nothing was sent this time — the
   * original outcome is in `state`.
   */
  readonly outcome: 'sent' | 'duplicate' | 'suppressed' | 'failed';
  readonly state: NotificationState;
  readonly attemptCount: number;
  readonly providerStatus: RecordedStatus | null;
  /** One honest sentence. Never says "delivered". */
  readonly statement: string;
}

export interface SendDependencies {
  readonly port: SupportDataPort;
  /**
   * Absent when `RESEND_API_KEY` is unset. That is a normal configuration, not an error:
   * every notification is then recorded as `suppressed` and nothing throws.
   */
  readonly transport?: NotificationTransport | undefined;
  /** Injected so tests do not sleep. Defaults to a real timer. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
}

const realWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Build the transport from the Worker environment.
 *
 * Returns `undefined` when no key is configured. Callers must treat that as ordinary.
 */
export function transportFromEnv(
  env: { readonly RESEND_API_KEY?: string | undefined },
  build: (apiKey: string) => NotificationTransport,
): NotificationTransport | undefined {
  const key = env.RESEND_API_KEY;
  if (typeof key !== 'string' || key.trim().length === 0) return undefined;
  return build(key);
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* -------------------------------------------------------------------------- */
/* send                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A channel-agnostic dispatch: an already-rendered message, addressed and keyed.
 *
 * `sendNotification` is the email-shaped wrapper around this. Owner alerts on Telegram go
 * through the same function, which is the point — at-most-once on `notification_key`,
 * bounded retries, and "accepted, never delivered" are properties of *sending*, not
 * properties of email, and duplicating them per channel is how one channel quietly loses
 * one of them.
 */
export interface DispatchRequest {
  readonly notificationKey: string;
  readonly workspaceId: string | null;
  readonly channel: NotificationChannel;
  /**
   * The addressee, hashed before storage. An email address, or the owner's chat
   * reference. Never stored in the clear.
   */
  readonly recipient: string;
  /** Recorded verbatim in the `template` column. */
  readonly template: string;
  readonly message: OutboundMessage;
  /** Validates the addressee for this channel. Defaults to "non-empty". */
  readonly recipientIsUsable?: (recipient: string) => boolean;
  readonly suppress?: Extract<
    RecordedStatus,
    'suppressed_by_grouping' | 'suppressed_by_preference'
  >;
  /** Status recorded when no transport is configured. Names the missing channel. */
  readonly noTransportStatus?: Extract<
    RecordedStatus,
    'no_email_transport_configured' | 'no_telegram_transport_configured'
  >;
}

/**
 * Claim the key, send with bounded retries, record the outcome.
 *
 * Never throws. Every exit path returns a `SendResult` and leaves exactly one row in
 * `notification_deliveries` for this key.
 */
export async function dispatchNotification(
  deps: SendDependencies,
  request: DispatchRequest,
): Promise<SendResult> {
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? realWait;
  const createdAt = toIso(now());

  let claim;
  try {
    const recipientHash = await hashToken(
      request.recipient.trim().toLowerCase(),
      'notification-recipient',
    );
    claim = await deps.port.claimNotification({
      id: newId(ID_PREFIX.notification),
      workspaceId: request.workspaceId,
      notificationKey: request.notificationKey,
      channel: request.channel,
      recipientHash,
      template: request.template,
      createdAt,
    });
  } catch {
    // The claim itself failed. Nothing was sent and nothing was recorded, so the caller
    // may retry the whole operation under the same key — which is exactly why the key
    // must not contain a timestamp.
    return {
      notificationKey: request.notificationKey,
      outcome: 'failed',
      state: 'failed',
      attemptCount: 0,
      providerStatus: 'transport_error',
      statement: STATUS_STATEMENT.transport_error,
    };
  }

  if (!claim.inserted) {
    // The single most important branch in this file. Somebody already claimed this key.
    const existing = claim.record;
    return {
      notificationKey: request.notificationKey,
      outcome: 'duplicate',
      state: existing.state,
      attemptCount: existing.attemptCount,
      providerStatus: asRecordedStatus(existing.providerStatus),
      statement:
        'This notification was already handled under the same key, so nothing was sent again.',
    };
  }

  if (request.suppress !== undefined) {
    return settle(deps, request.notificationKey, 'suppressed', 0, request.suppress, now);
  }

  if (deps.transport === undefined) {
    return settle(
      deps,
      request.notificationKey,
      'suppressed',
      0,
      request.noTransportStatus ?? 'no_email_transport_configured',
      now,
    );
  }

  const recipient = request.recipient.trim();
  const usable = request.recipientIsUsable ?? ((value: string) => value.length > 0);
  if (!usable(recipient)) {
    return settle(deps, request.notificationKey, 'failed', 0, 'recipient_address_unusable', now);
  }

  const outbound: OutboundMessage = { ...request.message, to: recipient };

  let attempt = 0;
  let last: RecordedStatus = 'send_attempts_exhausted';

  while (attempt < MAX_SEND_ATTEMPTS) {
    attempt += 1;
    let result;
    try {
      result = await deps.transport.send(outbound);
    } catch {
      last = 'transport_error';
      if (attempt >= MAX_SEND_ATTEMPTS) break;
      await wait(BACKOFF_BASE_MS * 4 ** (attempt - 1));
      continue;
    }

    last = recordedStatusFor(result);
    if (result.accepted) {
      return settle(deps, request.notificationKey, 'sent', attempt, last, now);
    }
    if (!result.retryable || attempt >= MAX_SEND_ATTEMPTS) {
      return settle(deps, request.notificationKey, 'failed', attempt, last, now);
    }
    await wait(BACKOFF_BASE_MS * 4 ** (attempt - 1));
  }

  return settle(deps, request.notificationKey, 'failed', attempt, last, now);
}

/**
 * Send one of the twelve customer templates by email.
 *
 * A thin wrapper: it renders, then hands the rendered message to `dispatchNotification`.
 * Every guarantee lives in that function, so email and Telegram cannot drift apart.
 */
export async function sendNotification<T extends NotificationTemplate>(
  deps: SendDependencies,
  request: SendRequest<T>,
): Promise<SendResult> {
  const rendered = renderNotification(request.template, request.vars);
  return dispatchNotification(deps, {
    notificationKey: request.notificationKey,
    workspaceId: request.workspaceId,
    channel: 'email',
    recipient: request.recipientEmail,
    template: request.template,
    message: {
      to: request.recipientEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    },
    recipientIsUsable: (value) => EMAIL_SHAPE.test(value),
    ...(request.suppress === undefined ? {} : { suppress: request.suppress }),
    noTransportStatus: 'no_email_transport_configured',
  });
}

function asRecordedStatus(value: string | null): RecordedStatus | null {
  if (value === null) return null;
  return (RECORDED_STATUS as readonly string[]).includes(value) ? (value as RecordedStatus) : null;
}

async function settle(
  deps: SendDependencies,
  notificationKey: string,
  state: NotificationState,
  attemptCount: number,
  status: RecordedStatus,
  now: () => Date,
): Promise<SendResult> {
  const settledAt = toIso(now());
  try {
    await deps.port.settleNotification({
      notificationKey,
      state,
      attemptCount,
      providerStatus: status,
      settledAt,
    });
  } catch {
    // The send already happened or already did not happen. Losing the bookkeeping write
    // must not turn into an exception on a request path; the owner queue will show the
    // row as `pending`, which is the honest reading of "we do not know".
  }
  return {
    notificationKey,
    outcome: state === 'sent' ? 'sent' : state === 'suppressed' ? 'suppressed' : 'failed',
    state,
    attemptCount,
    providerStatus: status,
    statement: STATUS_STATEMENT[status],
  };
}

/* -------------------------------------------------------------------------- */
/* keys                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build a notification key from stable parts.
 *
 * Every part must be something that identifies the *event*: a workspace id, a run id, a
 * billing period, a material transition. Never `Date.now()`, never a random id — either
 * would make every redelivery a fresh send.
 */
export function notificationKey(
  template: NotificationTemplate,
  ...parts: readonly string[]
): string {
  const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length === 0) {
    throw new TypeError('a notification key needs at least one stable identifying part');
  }
  return [template, ...cleaned].join(':');
}

/**
 * The link-expiry helper used by `data_export_ready`. Here rather than in the template so
 * the template stays pure over its variables.
 */
export function exportLinkExpiry(from: Date, seconds: number): string {
  return addSecondsIso(from, seconds);
}
