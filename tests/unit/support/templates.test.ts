/**
 * CUST-2xx — transactional templates.
 *
 * The rule these tests protect is the product's own thesis: we say a sending service
 * accepted a message, never that anyone received it. A template that quietly says
 * "delivered" would contradict the thing we sell, in writing, to the customer who bought
 * it.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import { PLAN_AT_ALLOWANCE } from '@verify/ui';
import { PAYMENT_FAILURE_GRACE_DAYS } from '@app/billing/config';
import { PAYMENT_RECOVERY_DAYS, PAYMENT_RECOVERY_POLICY } from '@app/billing/policy';
import {
  NOTIFICATION_TEMPLATE,
  OPTIONAL_TEMPLATES,
  escapeHtml,
  renderNotification,
  type NotificationTemplate,
  type TemplateVariablesByTemplate,
} from '@app/notifications/templates';

/** One set of variables per template, so every template can be rendered in one sweep. */
const VARS: { [T in NotificationTemplate]: TemplateVariablesByTemplate[T] } = {
  sign_in_link: {
    signInUrl: 'https://verify.example/auth/abc',
    expiresInMinutes: 15,
  },
  welcome: { workspaceName: 'Acme', setupUrl: 'https://verify.example/setup' },
  first_material_failure: {
    workspaceName: 'Acme',
    workflowName: 'Enquiry acknowledgement',
    runUrl: 'https://verify.example/runs/run_1',
    reasonSentence: 'The CRM record carrying this enquiry reference was not found.',
  },
  recovery: {
    workspaceName: 'Acme',
    workflowName: 'Enquiry acknowledgement',
    resultsUrl: 'https://verify.example/results',
    interruptionStartedAt: '2026-09-18T09:00:00.000Z',
  },
  provider_disconnected: {
    workspaceName: 'Acme',
    provider: 'HubSpot',
    reconnectUrl: 'https://verify.example/connections',
    reasonSentence: 'The authorisation expired.',
  },
  allowance_approaching: {
    workspaceName: 'Acme',
    runsUsed: 450,
    periodEndsAt: '2026-10-01T00:00:00.000Z',
  },
  allowance_reached: {
    workspaceName: 'Acme',
    periodEndsAt: '2026-10-01T00:00:00.000Z',
  },
  payment_problem: {
    workspaceName: 'Acme',
    billingPortalUrl: 'https://verify.example/billing',
    reasonSentence: 'The card was declined.',
    daysRemaining: 5,
    graceDays: PAYMENT_RECOVERY_DAYS,
  },
  cancellation_confirmed: {
    workspaceName: 'Acme',
    accessEndsAt: '2026-10-01T00:00:00.000Z',
    timing: 'period_end',
  },
  data_export_ready: {
    workspaceName: 'Acme',
    downloadUrl: 'https://verify.example/export/abc',
    expiresAt: '2026-09-26T00:00:00.000Z',
  },
  deletion_scheduled: {
    workspaceName: 'Acme',
    deletionAt: '2026-09-26T00:00:00.000Z',
    cancelUrl: 'https://verify.example/account/delete/cancel',
  },
  deletion_completed: {
    workspaceName: 'Acme',
    retainedStatement: 'We still hold 2 billing records.',
  },
};

function renderAll() {
  return NOTIFICATION_TEMPLATE.map((template) => renderNotification(template, VARS[template]));
}

describe('notification templates', () => {
  it('CUST-200 every template produces a subject, a text body, an HTML body and a stated reason', () => {
    for (const rendered of renderAll()) {
      expect(rendered.subject.length, rendered.template).toBeGreaterThan(0);
      expect(rendered.text.length, rendered.template).toBeGreaterThan(40);
      expect(rendered.html.startsWith('<p>'), rendered.template).toBe(true);
      expect(rendered.reason.toLowerCase(), rendered.template).toContain('you are receiving this');
      // The reason must be in both bodies, not only in the metadata.
      expect(rendered.text, rendered.template).toContain(rendered.reason);
    }
  });

  it('CUST-201 no template ever claims an email was delivered to anyone', () => {
    for (const rendered of renderAll()) {
      const body = `${rendered.subject} ${rendered.text}`.toLowerCase();
      expect(body, rendered.template).not.toMatch(/\bdelivered\b/);
      expect(body, rendered.template).not.toMatch(/\bdelivery confirmed\b/);
    }
  });

  it('CUST-202 a customer-controlled value is escaped in the HTML body', () => {
    const rendered = renderNotification('welcome', {
      workspaceName: '<script>alert(1)</script>',
      setupUrl: 'https://verify.example/setup',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    // The text body carries the value literally, which is correct for plain text.
    expect(rendered.text).toContain('<script>alert(1)</script>');
  });

  it('CUST-203 a non-https action URL is rendered as inert text rather than a link', () => {
    const rendered = renderNotification('sign_in_link', {
      signInUrl: 'javascript:alert(1)',
      expiresInMinutes: 15,
    });
    expect(rendered.html).not.toContain('href');
    expect(rendered.html).toContain('Sign in');
  });

  it('CUST-204 the allowance templates read their numbers from LIMITS rather than a literal', () => {
    const reached = renderNotification('allowance_reached', VARS.allowance_reached);
    expect(reached.text).toContain(String(LIMITS.PLAN_RUNS_PER_PERIOD));
    const approaching = renderNotification('allowance_approaching', VARS.allowance_approaching);
    expect(approaching.subject).toContain(String(LIMITS.PLAN_RUNS_PER_PERIOD));
  });

  it("CUST-205 the allowance notice reuses A01's at-allowance wording verbatim", () => {
    const rendered = renderNotification('allowance_approaching', VARS.allowance_approaching);
    expect(rendered.text).toContain(PLAN_AT_ALLOWANCE);
  });

  it('CUST-206 operational and legal messages are not switchable off', () => {
    expect(OPTIONAL_TEMPLATES.has('sign_in_link')).toBe(false);
    expect(OPTIONAL_TEMPLATES.has('payment_problem')).toBe(false);
    expect(OPTIONAL_TEMPLATES.has('deletion_completed')).toBe(false);
    expect(OPTIONAL_TEMPLATES.has('cancellation_confirmed')).toBe(false);
    expect(OPTIONAL_TEMPLATES.has('first_material_failure')).toBe(true);
  });

  it('CUST-207 escapeHtml neutralises every character that can break out of a text node', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('CUST-208 the payment-problem message never says nothing has been suspended', () => {
    // The sentence this replaces was true when written and false under the approved
    // policy. It is the exact regression this case exists to prevent.
    const base = {
      workspaceName: 'Acme',
      billingPortalUrl: 'https://verify.example/billing',
      reasonSentence: 'The card was declined.',
    };
    for (const days of [undefined, 0, 1, 5]) {
      const rendered = renderNotification('payment_problem', {
        ...base,
        ...(days === undefined ? {} : { daysRemaining: days }),
      });
      const body = rendered.text.toLowerCase();
      expect(body, String(days)).not.toContain('we have not suspended anything');
      expect(body, String(days)).not.toContain('nothing has been suspended');
      expect(body, String(days)).not.toMatch(/nothing has stopped/);
    }
  });

  it('CUST-209 the payment-problem message leads with the pause, not with "a billing issue"', () => {
    const rendered = renderNotification('payment_problem', VARS.payment_problem);
    expect(rendered.subject.toLowerCase()).toContain('new runs are paused');
    const firstParagraph = rendered.text.split('\n\n')[0] ?? '';
    expect(firstParagraph.toLowerCase()).toContain('paused checking new verification runs');
  });

  it('CUST-285 the payment-problem message lists everything the policy says stays available', () => {
    const rendered = renderNotification('payment_problem', VARS.payment_problem);
    const body = rendered.text.toLowerCase();
    for (const phrase of [
      'sign in',
      'run history',
      'retention period',
      'export your data',
      'update your payment method',
      'cancel',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
    // And the policy's own list has not grown a line this message does not cover.
    expect(PAYMENT_RECOVERY_POLICY.whatStaysAvailable).toHaveLength(6);
  });

  it('CUST-286 the recovery window is read from the approved constant, never hard-coded', () => {
    const withCount = renderNotification('payment_problem', {
      ...VARS.payment_problem,
      daysRemaining: 3,
    });
    expect(withCount.text).toContain('3 days left');
    expect(withCount.text).toContain(`${String(PAYMENT_RECOVERY_DAYS)}-day recovery window`);

    // No `daysRemaining` — the window length is still stated, from the constant.
    const withoutCount = renderNotification('payment_problem', {
      workspaceName: 'Acme',
      billingPortalUrl: 'https://verify.example/billing',
      reasonSentence: 'The card was declined.',
    });
    expect(withoutCount.text).toContain(
      `${String(PAYMENT_FAILURE_GRACE_DAYS)}-day recovery window`,
    );
    expect(PAYMENT_RECOVERY_DAYS).toBe(PAYMENT_FAILURE_GRACE_DAYS);

    const singular = renderNotification('payment_problem', {
      ...VARS.payment_problem,
      daysRemaining: 1,
    });
    expect(singular.text).toContain('1 day left');
  });

  it('CUST-287 day eight is stated as suspended and unpaid, never as cancelled or deleted', () => {
    const rendered = renderNotification('payment_problem', VARS.payment_problem);
    const body = rendered.text.toLowerCase();
    expect(body).toContain('marked unpaid');
    expect(body).toContain('it is not cancelled');
    expect(body).toContain('nothing of yours is deleted');
    expect(body).toContain('published retention policy');
  });

  it('CUST-229 the resumption promise keeps its standard and admits the automatic check is unfinished', () => {
    // The sentence this pins replaced one that was true about our intent and false about
    // our behaviour: `reconcileSubscriptions()` and `runBillingMaintenance()` have no
    // callers, so nothing automatically resumes on a confirmed payment. It sat at the end
    // of a message telling someone their service is paused, which is the worst possible
    // place for a reassurance the product cannot honour — the customer waits, and nothing
    // happens.
    const body = renderNotification('payment_problem', VARS.payment_problem).text.toLowerCase();

    // 1. The standard survives: confirmed, never a retry or a promise to pay.
    expect(body).toContain('a confirmed payment');
    expect(body).toContain('not a retry and not a promise to pay');
    expect(body).toContain('actually gone through');

    // 2. It admits the automatic path is unfinished rather than implying it works.
    expect(body).toContain('still finishing the automatic check');

    // 3. It gives a route that actually exists today — a person.
    expect(body).toContain('contact us');
    expect(body).toContain('by hand');

    // And it no longer states the bare promise the code cannot keep.
    expect(body).not.toContain('checking starts again when a payment is actually confirmed');
    expect(body).not.toContain('we will not tell you it is working again until it is');
  });

  it('CUST-288 an immediate cancellation is not told it keeps a period it has already lost', () => {
    const atPeriodEnd = renderNotification('cancellation_confirmed', {
      workspaceName: 'Acme',
      accessEndsAt: '2026-10-01T00:00:00.000Z',
      timing: 'period_end',
    });
    expect(atPeriodEnd.text).toContain('the end of the period you have already paid for');

    const immediate = renderNotification('cancellation_confirmed', {
      workspaceName: 'Acme',
      accessEndsAt: '2026-09-19T12:00:00.000Z',
      timing: 'immediately',
    });
    expect(immediate.text).not.toContain('the end of the period you have already paid for');
    expect(immediate.text).toContain('take effect immediately');
  });
});
