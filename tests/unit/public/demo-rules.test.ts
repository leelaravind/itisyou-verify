/**
 * The demo performs no check that a real run does not.
 *
 * Until 2026-09-19 `/demo` and the synthetic customer dashboard judged their runs against
 * `normalised_email_equals` on the recipient — an operator the evaluator implements and no
 * customer workflow emits, because the onboarding composer asserts only that the recipient
 * `exists`. A visitor was shown a comparison the product never performs on a real run.
 *
 * These cases pin both surfaces to the composer's own output, and pin the demo page to
 * saying, beside its rule table, what the recipient check does not prove. They are the
 * interim control while the per-run binding (gap register: "A verified run does not prove
 * the acknowledgement reached the enquirer") is with the lead; when it lands, the composer
 * changes, both surfaces follow automatically, and only CUST-470's wording needs revisiting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import { render } from '@verify/ui';
import { composeWorkflowRules } from '@app/db/ruleCompiler';
import { DemoPage } from '@app/routes/public/demo';
import { DEMO_RULES, DEMO_RUNS } from '@app/routes/public/demoData';
import { currentRules, resetSyntheticState } from '@app/routes/app/syntheticPort';

function composed(correlationProperty = 'verify_correlation_id') {
  const result = composeWorkflowRules({
    correlationProperty,
    deadlineSeconds: LIMITS.DEFAULT_DEADLINE_SECONDS,
    coverageMode: 'customer_triggered',
    requireRecordExists: true,
    requireCorrelationMatch: true,
    requireEmailDelivered: true,
    requireRecipientMatch: true,
  });
  if (!result.ok) throw new Error(result.failure.message);
  return result.rules;
}

afterEach(() => {
  resetSyntheticState();
});

describe('the demo judges against the rules a real workspace gets', () => {
  it('CUST-468 the demo’s rules are byte-identical to the onboarding composer’s output for every check switched on', () => {
    expect(DEMO_RULES).toEqual(composed());
    // The fixture the demo used to run carried this operator; the composer never has.
    // The recipient check is the bound comparison, not the `exists` placeholder it replaced.
    const recipient = DEMO_RULES.assertions.find((a) => a.field === 'message.recipient');
    expect(recipient?.operator).toBe('normalised_email_equals');
    expect(recipient?.expected_from).toBe('source_event.email_recipient');
    // Every run on the page was judged against those same rules, so the labels match too.
    for (const run of DEMO_RUNS) {
      expect(run.results.map((r) => r.rule_id)).toEqual(
        DEMO_RULES.assertions.map((a) => a.rule_id),
      );
    }
  });

  it('CUST-469 the synthetic customer dashboard composes its rules through the same compiler', () => {
    // The synthetic port's initial state has every check on and the same correlation property.
    expect(currentRules()).toEqual(composed());
  });

  it('CUST-470 the demo page says, beside its rule table, what the recipient check proves and how that was proven', async () => {
    const markup = await render(DemoPage());
    expect(markup).toContain('What the last check proves, and how that was proven');
    expect(markup).toContain('comes back failed, not verified');
    expect(markup).toContain('has not run\n            against a live Resend account');
    // The rule table carries the composer's label and the operator that actually runs.
    expect(markup).toContain('The acknowledgement went to the address the enquiry named');
    expect(markup).toContain('normalised_email_equals');
    // The demo's verified run was judged against the bound check, with the enquiry's own value.
    const recipientCheck = DEMO_RUNS[0]?.results.find(
      (r) => r.rule_id === 'email_recipient_matches',
    );
    expect(recipientCheck?.status).toBe('SUPPORTED');
    expect(recipientCheck?.expected_display).toBe('ada@example.test');
  });
});
