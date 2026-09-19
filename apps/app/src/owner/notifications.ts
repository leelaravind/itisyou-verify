/**
 * Notification delivery health, for the operations screen.
 *
 * ## Why this exists
 *
 * A09 sends notifications **at most once**. If a worker dies between claiming a
 * `notification_deliveries` row and the provider accepting the message, the row stays
 * `pending` and nothing resends it. That is a deliberate choice and the right one: a second
 * "your data has been deleted" email is worse than a missing one, and an automatic retry
 * cannot tell the difference between "never sent" and "sent, then we crashed".
 *
 * The consequence is that **the owner is the retry mechanism**. A design that quietly makes
 * a person the fallback, and then does not tell them, has not chosen at-most-once — it has
 * chosen to lose messages. So the rows surface here, where the owner is already looking,
 * with the age of each one and what it was trying to say.
 *
 * This module implements no sending and no retry. It is a read and a rendering contract.
 */

/** A delivery that claimed a row and never reported an outcome. */
export interface StuckNotification {
  readonly id: string;
  /** The template name, e.g. `deletion_complete`. Not the message body. */
  readonly template: string;
  readonly channel: string;
  /** Null for a platform-level notification with no workspace. */
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly ageSeconds: number;
  readonly attemptCount: number;
  /**
   * What the provider last said, if anything. Null means it never answered — which is the
   * whole reason the row is stuck.
   */
  readonly providerStatus: string | null;
}

/**
 * Anything older than this and still `pending` is not in flight; it is abandoned.
 *
 * Fifteen minutes is far longer than any send should take and short enough that an owner
 * checking once a day still sees it. It is deliberately not the same number as the runner
 * heartbeat window — these are unrelated failures and tying them together would make one of
 * them wrong the next time the other is tuned.
 */
export const NOTIFICATION_STUCK_AFTER_SECONDS = 15 * 60;

export interface NotificationHealth {
  readonly stuck: readonly StuckNotification[];
  /** Pending rows younger than the threshold. Probably fine; shown as context, not alarm. */
  readonly inFlight: number;
  /** Why we cannot say, when we cannot. Null when the read worked. */
  readonly unavailableReason: string | null;
}

/**
 * The read I need from A09 — deliberately one method.
 *
 * `notification_deliveries` already carries everything: `state`, `created_at`,
 * `attempt_count`, `provider_status`, `template`, `channel`, `workspace_id`. What does not
 * exist is a listing scoped to *stuck pending*: A02's `notifications` repository lists by
 * template and recency, which is the wrong axis for this question.
 *
 * **Asked of A09, through the lead:** a repository function shaped like
 *
 * ```ts
 * notifications.listStuckPending(db, { olderThan: string; limit: number }): Promise<NotificationRow[]>
 * ```
 *
 * over `WHERE state = 'pending' AND created_at <= ?`, ordered oldest first. Nothing about it
 * is workspace-scoped, because this is a platform-owner view, and it returns `workspace_id`
 * so the page can say whose message it is.
 */
export interface NotificationHealthPort {
  health(input: { readonly now: Date; readonly stuckAfterSeconds: number }): Promise<NotificationHealth>;
}

/** The honest default until that read exists. It claims nothing. */
export class NotificationHealthUnavailable implements NotificationHealthPort {
  async health(): Promise<NotificationHealth> {
    return {
      stuck: [],
      inFlight: 0,
      unavailableReason:
        'We cannot tell you whether any notification is stuck. The read this needs does not exist yet, so an empty ' +
        'list here means "not checked", not "nothing wrong". Messages are sent at most once by design, which means a ' +
        'send interrupted halfway is never retried automatically — until this is wired, the only way to find one is to ' +
        'ask.',
    };
  }
}

/** An in-memory implementation for tests and for the synthetic port. */
export class StaticNotificationHealth implements NotificationHealthPort {
  readonly #rows: readonly { id: string; template: string; channel: string; workspaceId: string | null; createdAt: string; attemptCount: number; providerStatus: string | null }[];

  constructor(
    rows: readonly {
      id: string;
      template: string;
      channel: string;
      workspaceId: string | null;
      createdAt: string;
      attemptCount: number;
      providerStatus: string | null;
    }[] = [],
  ) {
    this.#rows = rows;
  }

  async health(input: { readonly now: Date; readonly stuckAfterSeconds: number }): Promise<NotificationHealth> {
    const stuck: StuckNotification[] = [];
    let inFlight = 0;
    for (const row of this.#rows) {
      const created = Date.parse(row.createdAt);
      if (Number.isNaN(created)) continue;
      const ageSeconds = Math.max(0, Math.floor((input.now.getTime() - created) / 1000));
      if (ageSeconds < input.stuckAfterSeconds) {
        inFlight += 1;
        continue;
      }
      stuck.push({
        id: row.id,
        template: row.template,
        channel: row.channel,
        workspaceId: row.workspaceId,
        createdAt: row.createdAt,
        ageSeconds,
        attemptCount: row.attemptCount,
        providerStatus: row.providerStatus,
      });
    }
    stuck.sort((a, b) => b.ageSeconds - a.ageSeconds);
    return { stuck, inFlight, unavailableReason: null };
  }
}

/** What the owner should actually do about a stuck row. One sentence, per template family. */
export function suggestedActionFor(template: string): string {
  if (template.includes('deletion')) {
    return 'Check whether the deletion itself completed before telling the customer anything. The message is the receipt, not the work.';
  }
  if (template.includes('export')) {
    return 'Check whether the export file exists. If it does, send the link by hand; if it does not, start the export again.';
  }
  if (template.includes('payment') || template.includes('invoice')) {
    return 'Check the payment provider for the real outcome before contacting the customer. Their record there is the truth.';
  }
  return 'Confirm what actually happened before re-sending anything. A duplicate is worse than a late one.';
}
