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
import { PLAN_CANCELLATION_WORDING } from '@verify/ui';
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
  },
  cancellation_confirmed: {
    workspaceName: 'Acme',
    accessEndsAt: '2026-10-01T00:00:00.000Z',
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

  it("CUST-205 the payment-problem message reuses A01's cancellation wording verbatim", () => {
    const rendered = renderNotification('payment_problem', VARS.payment_problem);
    expect(rendered.text).toContain(PLAN_CANCELLATION_WORDING);
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
});
