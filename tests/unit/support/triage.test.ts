/**
 * CUST-2xx — deterministic support triage.
 *
 * The cases that matter here are the ones where getting it wrong costs the customer
 * something they cannot get back: a refund demand answered by a rule, a deletion request
 * filed as "other", a security report sitting in a queue for a week.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORT_CATEGORY, SUPPORT_PRIORITY } from '@app/support/port';
import { ESCALATION_STATEMENT, triage } from '@app/support/triage';

const base = { workspaceId: 'ws_1' as string | null, linkedRunId: null };

describe('support triage', () => {
  it('CUST-210 a billing dispute escalates to the owner with a typed reason', () => {
    const decision = triage({
      ...base,
      subject: 'I have been charged twice this month',
      bodyRedacted: 'My card shows two payments and I want a refund for one of them.',
    });
    expect(decision.category).toBe('billing_dispute');
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('billing_dispute_needs_a_person');
    expect(decision.priority).toBe('urgent');
    expect(decision.initialState).toBe('escalated');
  });

  it('CUST-211 a deletion request escalates rather than being auto-answered', () => {
    const decision = triage({
      ...base,
      subject: 'Please delete my data',
      bodyRedacted: 'I would like you to erase my data and close the workspace.',
    });
    expect(decision.category).toBe('data_deletion');
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('deletion_request_needs_a_person');
  });

  it('CUST-212 a security report escalates and is urgent', () => {
    const decision = triage({
      ...base,
      subject: 'Possible vulnerability in your report links',
      bodyRedacted: 'I think I can read a report belonging to someone else.',
    });
    expect(decision.category).toBe('security_report');
    expect(decision.priority).toBe('urgent');
    expect(decision.escalationReason).toBe('security_report_needs_a_person');
  });

  it('CUST-213 a message we cannot categorise escalates instead of being filed as unimportant', () => {
    const decision = triage({
      ...base,
      subject: 'Quick question',
      bodyRedacted: 'Something odd happened yesterday afternoon.',
    });
    expect(decision.category).toBe('other');
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('customer_impact_unclear');
    expect(decision.priority).not.toBe('low');
    expect(decision.matchedRules).toEqual([]);
  });

  it('CUST-214 a cancellation is escalated so it cannot be delayed by a queue', () => {
    const decision = triage({
      ...base,
      subject: 'Cancel my subscription',
      bodyRedacted: 'Please stop billing me from next month.',
    });
    expect(decision.category).toBe('cancellation');
    expect(decision.escalationReason).toBe('cancellation_must_not_be_delayed');
    expect(decision.priority).toBe('high');
  });

  it('CUST-215 an ordinary setup question is not escalated', () => {
    const decision = triage({
      ...base,
      subject: 'How do I connect HubSpot?',
      bodyRedacted: 'Getting started with my first workflow and the correlation property.',
    });
    expect(decision.escalate).toBe(false);
    expect(decision.escalationReason).toBeNull();
    expect(decision.initialState).toBe('open');
  });

  it('CUST-216 two serious matters in one message escalate as conflicting signals', () => {
    const decision = triage({
      ...base,
      subject: 'Refund and delete my data',
      bodyRedacted:
        'I want my money back for the double charge, and then please erase my data entirely.',
    });
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('conflicting_signals');
    // A conflict is never quieter than the loudest thing in it.
    expect(decision.priority).toBe('urgent');
  });

  it('CUST-217 triage is deterministic — same input, same decision, no clock involved', () => {
    const input = {
      ...base,
      subject: 'Connection expired',
      bodyRedacted: 'HubSpot connection says the authorisation expired, how do I reconnect?',
    };
    const first = triage(input);
    const second = triage(input);
    expect(second).toEqual(first);
    expect(first.category).toBe('connection_problem');
  });

  it('CUST-218 every decision uses the fixed taxonomy and the schema priorities', () => {
    const samples = [
      'Charged twice',
      'Delete my account',
      'Vulnerability report',
      'Cancel please',
      'Export my data',
      'Cannot connect Resend',
      'Why is this failing, the result is wrong',
      'Invoice and VAT question',
      'How do I set up a workflow',
      'Feature request: do you support Salesforce',
      'Bananas',
    ];
    for (const subject of samples) {
      const decision = triage({ ...base, subject, bodyRedacted: subject });
      expect(SUPPORT_CATEGORY as readonly string[]).toContain(decision.category);
      expect(SUPPORT_PRIORITY as readonly string[]).toContain(decision.priority);
    }
  });

  it('CUST-219 every escalation reason has a plain-language statement for the owner', () => {
    for (const [reason, statement] of Object.entries(ESCALATION_STATEMENT)) {
      expect(statement.length, reason).toBeGreaterThan(30);
      expect(statement, reason).not.toMatch(/TODO/);
    }
  });
});
