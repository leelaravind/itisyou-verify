/**
 * Alert-storm suppression.
 *
 * A provider outage does not fail one run. It fails every run in flight, then every run
 * that arrives while it lasts. Without grouping, a two-hour HubSpot incident sends a
 * customer forty emails, they add a filter, and the one email that mattered — the
 * deletion confirmation, the payment failure — goes to the same folder. Alert fatigue is
 * not a cosmetic problem; it destroys the channel.
 *
 * Two rules:
 *
 *  1. **One notification per workspace, per subject, per material transition.** Repeats
 *     inside the grouping window are recorded as suppressed and not sent. "Material
 *     transition" means the state actually changed — not that another run of the same
 *     already-failing workflow also failed.
 *
 *  2. **A recovery notification sends only if a failure notification actually went out.**
 *     "Good news: the thing you were never told about is fixed" is noise at best and
 *     alarming at worst. `state === 'sent'` is the test — a failure notification that was
 *     itself suppressed, or that the sending service refused, does not earn a recovery.
 *
 * Everything here is a decision. Nothing here sends. `send.ts` sends.
 */
import { toIso } from '../lib/time';
import type { SupportDataPort } from '../support/port';
import type { NotificationTemplate } from './templates';

/**
 * One hour. Chosen to match the product's own settling window — A01's copy already tells
 * customers "a result can take up to an hour to settle", so an alert cadence faster than
 * that would be reporting churn we have told them to expect.
 */
export const ALERT_GROUPING_WINDOW_SECONDS = 3_600;

/**
 * How far back a recovery looks for the failure it is recovering from. Seven days: longer
 * than any plausible provider incident, short enough that a recovery email never refers
 * to something the customer has forgotten.
 */
export const RECOVERY_LOOKBACK_SECONDS = 7 * 24 * 3_600;

export const MATERIAL_TRANSITION = [
  /** A workflow moved from producing verified results to failing a mandatory check. */
  'started_failing',
  /** That same workflow is producing verified results again. */
  'recovered',
  /** A connection stopped working: authorisation expired, permission removed, revoked. */
  'provider_unavailable',
] as const;
export type MaterialTransition = (typeof MATERIAL_TRANSITION)[number];

const TEMPLATE_FOR: Readonly<Record<MaterialTransition, NotificationTemplate>> = {
  started_failing: 'first_material_failure',
  recovered: 'recovery',
  provider_unavailable: 'provider_disconnected',
};

export function templateForTransition(transition: MaterialTransition): NotificationTemplate {
  return TEMPLATE_FOR[transition];
}

export type GroupingReason =
  /** Nothing comparable inside the window. Send it. */
  | 'first_in_window'
  /** We already told this workspace about this subject inside the window. */
  | 'already_notified_in_window'
  /** A recovery with no failure notification behind it. */
  | 'no_failure_notification_sent'
  /** A recovery for an episode we have already reported as recovered. */
  | 'already_recovered';

export interface GroupingDecision {
  readonly send: boolean;
  readonly reason: GroupingReason;
  /** Stable, episode-scoped, timestamp-free. Hand this straight to `sendNotification`. */
  readonly notificationKey: string;
  readonly template: NotificationTemplate;
}

export interface AlertContext {
  readonly workspaceId: string;
  /**
   * What the alert is about: a workflow id for failure and recovery, a provider name for
   * a connection problem. Grouping is per subject, so a HubSpot outage does not silence a
   * Resend outage.
   */
  readonly subject: string;
  readonly transition: MaterialTransition;
  /**
   * A stable identifier for *this episode* — the instant the workflow entered the failing
   * state, the connection's expiry timestamp, or the id of the first failing run.
   *
   * It must be stable for the whole episode and different for the next one. Never
   * `Date.now()`: that would defeat the `UNIQUE` key and send one email per redelivery.
   * A recovery uses the same episode id as the failure it closes.
   */
  readonly episodeId: string;
  readonly now: Date;
}

/** `template:workspace:subject:episode`. No clock anywhere in it. */
export function alertNotificationKey(context: AlertContext): string {
  return [
    TEMPLATE_FOR[context.transition],
    context.workspaceId,
    context.subject,
    context.episodeId,
  ].join(':');
}

/** The prefix that identifies every notification of one template about one subject. */
function subjectPrefix(
  template: NotificationTemplate,
  workspaceId: string,
  subject: string,
): string {
  return `${template}:${workspaceId}:${subject}:`;
}

function secondsBefore(now: Date, seconds: number): string {
  return toIso(new Date(now.getTime() - seconds * 1_000));
}

/**
 * Decide whether this alert should be sent.
 *
 * Reads only `notification_deliveries`, which is the record of what the customer actually
 * received. It deliberately does not read run state: "have we already told them?" is a
 * question about our outbox, not about their workflow.
 */
export async function decideAlert(
  port: SupportDataPort,
  context: AlertContext,
): Promise<GroupingDecision> {
  const template = TEMPLATE_FOR[context.transition];
  const notificationKeyValue = alertNotificationKey(context);

  if (context.transition === 'recovered') {
    return decideRecovery(port, context, template, notificationKeyValue);
  }

  const since = secondsBefore(context.now, ALERT_GROUPING_WINDOW_SECONDS);
  const recent = await port.findNotifications({
    workspaceId: context.workspaceId,
    template,
    since,
    keyPrefix: subjectPrefix(template, context.workspaceId, context.subject),
  });

  // A record in any state other than `failed` means we already acted on this situation:
  // `sent` reached them, `suppressed` was a deliberate decision not to, and `pending`
  // means an attempt is in flight. Only an outright failure earns another try.
  const alreadyHandled = recent.some((row) => row.state !== 'failed');

  return {
    send: !alreadyHandled,
    reason: alreadyHandled ? 'already_notified_in_window' : 'first_in_window',
    notificationKey: notificationKeyValue,
    template,
  };
}

async function decideRecovery(
  port: SupportDataPort,
  context: AlertContext,
  template: NotificationTemplate,
  notificationKeyValue: string,
): Promise<GroupingDecision> {
  const since = secondsBefore(context.now, RECOVERY_LOOKBACK_SECONDS);

  const failures = await port.findNotifications({
    workspaceId: context.workspaceId,
    template: 'first_material_failure',
    since,
    keyPrefix: subjectPrefix('first_material_failure', context.workspaceId, context.subject),
  });

  // `sent` only. A failure notification we suppressed, or that the sending service
  // refused, never reached the customer — so there is nothing for a recovery to close.
  const failureWasSent = failures.some((row) => row.state === 'sent');
  if (!failureWasSent) {
    return {
      send: false,
      reason: 'no_failure_notification_sent',
      notificationKey: notificationKeyValue,
      template,
    };
  }

  const recoveries = await port.findNotifications({
    workspaceId: context.workspaceId,
    template: 'recovery',
    since,
    keyPrefix: subjectPrefix('recovery', context.workspaceId, context.subject),
  });
  const alreadyRecovered = recoveries.some(
    (row) => row.notificationKey === notificationKeyValue && row.state !== 'failed',
  );
  if (alreadyRecovered) {
    return {
      send: false,
      reason: 'already_recovered',
      notificationKey: notificationKeyValue,
      template,
    };
  }

  return {
    send: true,
    reason: 'first_in_window',
    notificationKey: notificationKeyValue,
    template,
  };
}

/** Owner-visible explanation of a grouping decision. */
export const GROUPING_REASON_STATEMENT: Readonly<Record<GroupingReason, string>> = {
  first_in_window:
    'Nothing comparable had been sent to this workspace inside the grouping window, so this alert was sent.',
  already_notified_in_window:
    'This workspace had already been told about this subject inside the grouping window, so this alert was recorded and not sent.',
  no_failure_notification_sent:
    'No failure notification about this subject ever reached this workspace, so there was nothing for a recovery notification to close.',
  already_recovered:
    'This episode had already been reported as recovered, so this alert was recorded and not sent.',
};
