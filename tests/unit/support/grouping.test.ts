/**
 * CUST-2xx — alert-storm suppression.
 *
 * A two-hour provider incident must produce one email, not forty. And a recovery email
 * must never be the first thing a customer hears about a problem: "good news, the thing
 * you were never told about is fixed" is worse than silence.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySupportData } from '@app/support/memory';
import {
  ALERT_GROUPING_WINDOW_SECONDS,
  alertNotificationKey,
  decideAlert,
  templateForTransition,
} from '@app/notifications/grouping';
import type { NotificationState } from '@app/support/port';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function seedNotification(
  port: InMemorySupportData,
  key: string,
  template: string,
  state: NotificationState,
  createdAt: string,
): void {
  port.notifications.set(key, {
    id: `ntf_${key}`,
    workspaceId: 'ws_1',
    notificationKey: key,
    channel: 'email',
    recipientHash: 'hash',
    template,
    state,
    attemptCount: 1,
    providerStatus: state === 'sent' ? 'accepted_by_sending_service' : null,
    createdAt,
    sentAt: state === 'sent' ? createdAt : null,
  });
}

const failing = {
  workspaceId: 'ws_1',
  subject: 'wf_1',
  transition: 'started_failing' as const,
  episodeId: '2026-09-19T11:00:00.000Z',
  now: NOW,
};

describe('alert grouping', () => {
  it('CUST-230 the first material failure in the window is sent', async () => {
    const port = new InMemorySupportData();
    const decision = await decideAlert(port, failing);
    expect(decision.send).toBe(true);
    expect(decision.reason).toBe('first_in_window');
    expect(decision.template).toBe('first_material_failure');
  });

  it('CUST-231 a repeat inside the window collapses into the one already sent', async () => {
    const port = new InMemorySupportData();
    seedNotification(
      port,
      alertNotificationKey(failing),
      'first_material_failure',
      'sent',
      '2026-09-19T11:30:00.000Z',
    );
    // A different episode id, ten minutes later — a second outage in the same storm.
    const decision = await decideAlert(port, {
      ...failing,
      episodeId: '2026-09-19T11:40:00.000Z',
    });
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('already_notified_in_window');
  });

  it('CUST-232 a recovery does not send when no failure notification was ever sent', async () => {
    const port = new InMemorySupportData();
    const decision = await decideAlert(port, {
      ...failing,
      transition: 'recovered',
    });
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('no_failure_notification_sent');
  });

  it('CUST-233 a recovery sends when a failure notification actually went out', async () => {
    const port = new InMemorySupportData();
    seedNotification(
      port,
      alertNotificationKey(failing),
      'first_material_failure',
      'sent',
      '2026-09-19T11:00:00.000Z',
    );
    const decision = await decideAlert(port, {
      ...failing,
      transition: 'recovered',
    });
    expect(decision.send).toBe(true);
    expect(decision.template).toBe('recovery');
  });

  it('CUST-234 a failure notification that was itself suppressed does not earn a recovery', async () => {
    const port = new InMemorySupportData();
    seedNotification(
      port,
      alertNotificationKey(failing),
      'first_material_failure',
      'suppressed',
      '2026-09-19T11:00:00.000Z',
    );
    const decision = await decideAlert(port, {
      ...failing,
      transition: 'recovered',
    });
    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('no_failure_notification_sent');
  });

  it('CUST-235 grouping is per subject — a HubSpot outage does not silence a Resend outage', async () => {
    const port = new InMemorySupportData();
    const hubspot = {
      workspaceId: 'ws_1',
      subject: 'hubspot',
      transition: 'provider_unavailable' as const,
      episodeId: 'e1',
      now: NOW,
    };
    seedNotification(
      port,
      alertNotificationKey(hubspot),
      'provider_disconnected',
      'sent',
      '2026-09-19T11:50:00.000Z',
    );
    const resend = await decideAlert(port, {
      ...hubspot,
      subject: 'resend',
      episodeId: 'e2',
    });
    expect(resend.send).toBe(true);
    const sameProvider = await decideAlert(port, {
      ...hubspot,
      episodeId: 'e3',
    });
    expect(sameProvider.send).toBe(false);
  });

  it('CUST-236 the notification key is episode-scoped and contains no clock reading', () => {
    const key = alertNotificationKey(failing);
    expect(key).toBe('first_material_failure:ws_1:wf_1:2026-09-19T11:00:00.000Z');
    // Deciding twice at different wall-clock times yields the same key.
    const later = alertNotificationKey({
      ...failing,
      now: new Date('2026-09-19T18:00:00.000Z'),
    });
    expect(later).toBe(key);
  });

  it('CUST-237 an alert outside the grouping window is treated as a new situation', async () => {
    const port = new InMemorySupportData();
    const longAgo = new Date(
      NOW.getTime() - (ALERT_GROUPING_WINDOW_SECONDS + 60) * 1_000,
    ).toISOString();
    seedNotification(
      port,
      'first_material_failure:ws_1:wf_1:old',
      'first_material_failure',
      'sent',
      longAgo,
    );
    const decision = await decideAlert(port, { ...failing, episodeId: 'new' });
    expect(decision.send).toBe(true);
  });

  it('CUST-238 every material transition maps to a template that exists', () => {
    expect(templateForTransition('started_failing')).toBe('first_material_failure');
    expect(templateForTransition('recovered')).toBe('recovery');
    expect(templateForTransition('provider_unavailable')).toBe('provider_disconnected');
  });
});
