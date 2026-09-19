/**
 * CUST-009..CUST-024 — component rendering, escaping, and the honesty rules.
 *
 * The escaping cases are the ones that matter most: a workflow name and a CRM value are
 * both customer-controlled, and both are rendered on a page a second person in the
 * workspace reads. The assertions here check the *rendered bytes*, not that a helper was
 * called.
 */
import { describe, expect, it } from 'vitest';
import {
  AssertionBadge,
  AssertionRow,
  Breadcrumb,
  Button,
  Callout,
  Card,
  Checkbox,
  ClaimRule,
  CoverageNotice,
  CsrfField,
  EmptyState,
  ErrorState,
  Field,
  Fieldset,
  HealthReadout,
  InactivityNotice,
  LoadingState,
  NextStep,
  Pagination,
  RunVerdict,
  StandingLimitations,
  StatusBadge,
  Table,
  html,
  render,
  STANDING_LIMITATIONS_PARAGRAPH,
} from '@verify/ui';
import {
  describeCoverage,
  detectInactivity,
  explainRunStatus,
  summariseWorkflowHealth,
} from '@verify/domain';

const HOSTILE_NAME = '<script>alert("xss")</script>';
const HOSTILE_VALUE = '"><img src=x onerror=alert(1)>';

describe('components', () => {
  it('CUST-009 a status badge carries a glyph, a text label and a border, never colour alone', async () => {
    const markup = await render(StatusBadge({ status: 'VERIFIED' }));
    expect(markup).toContain('Verified');
    expect(markup).toContain('<svg');
    expect(markup).toContain('badge--verified');
    expect(markup).toContain('data-status="VERIFIED"');
    // The accessible name says what the word means, not just the word.
    expect(markup).toContain('Status: ');
  });

  it('CUST-010 all four run statuses render a distinct label and modifier class', async () => {
    const expected = [
      ['VERIFIED', 'Verified'],
      ['FAILED', 'Failed'],
      ['UNVERIFIED', 'Unverified'],
      ['PENDING', 'Pending'],
    ] as const;
    for (const [status, label] of expected) {
      const markup = await render(StatusBadge({ status }));
      expect(markup).toContain(label);
      expect(markup).toContain(`badge--${status.toLowerCase()}`);
    }
  });

  it('CUST-011 an assertion badge uses check wording, not run wording', async () => {
    expect(await render(AssertionBadge({ status: 'SUPPORTED' }))).toContain('Confirmed');
    expect(await render(AssertionBadge({ status: 'CONTRADICTED' }))).toContain('Not as expected');
    expect(await render(AssertionBadge({ status: 'UNKNOWN' }))).toContain('Could not confirm');
    expect(await render(AssertionBadge({ status: 'PENDING' }))).toContain('Still checking');
  });

  it('CUST-012 a workflow name containing a script tag is escaped, not executed', async () => {
    const markup = await render(Card({ title: HOSTILE_NAME, body: html`<p>${HOSTILE_NAME}</p>` }));
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;&#x2F;script&gt;'.replace('&#x2F;', '/'));
  });

  it('CUST-013 a CRM value containing an image-onerror payload is escaped inside an attribute and in text', async () => {
    const markup = await render(
      ClaimRule({ status: 'FAILED', claim: HOSTILE_VALUE, observed: HOSTILE_VALUE }),
    );
    // The payload survives as *text* — that is correct, and is what the customer needs to
    // see. What must not survive is a tag boundary or a quote that could close an attribute.
    expect(markup).not.toContain('<img');
    expect(markup).not.toMatch(/<[a-z]+[^>]*onerror/i);
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).toContain('&quot;&gt;');
  });

  it('CUST-014 a hostile value in a table cell and in a field value is escaped', async () => {
    const table = await render(
      Table({
        caption: 'Runs',
        columns: [{ key: 'a', header: 'Value', cell: (row: { v: string }) => row.v }],
        rows: [{ v: HOSTILE_VALUE }],
      }),
    );
    expect(table).not.toContain('<img');
    expect(table).toContain('&lt;img');

    const field = await render(
      Field({ name: 'correlationProperty', label: 'Property', value: HOSTILE_VALUE }),
    );
    expect(field).not.toContain('<img');
    expect(field).toContain('&lt;img');
    expect(field).not.toMatch(/value="[^"]*"[^>]*onerror/);
  });

  it('CUST-015 a hostile value used as a table caption cannot break out of the aria-label attribute', async () => {
    const markup = await render(
      Table({
        caption: HOSTILE_VALUE,
        columns: [{ key: 'a', header: 'A', cell: () => 'x' }],
        rows: [{}],
      }),
    );
    expect(markup).toContain('aria-label="&quot;&gt;&lt;img');
    expect(markup).not.toContain('aria-label=""><img');
  });

  it('CUST-016 next_step of null renders nothing at all — no element, no filler text', async () => {
    expect(NextStep(null)).toBeNull();
    expect(NextStep('   ')).toBeNull();
    const withStep = NextStep('Reconnect HubSpot.');
    expect(withStep).not.toBeNull();
    expect(await render(withStep!)).toContain('Reconnect HubSpot.');
  });

  it('CUST-017 a verified run verdict renders no next step, because the engine offers none', async () => {
    const markup = await render(
      RunVerdict({ status: 'VERIFIED', explanation: explainRunStatus('VERIFIED') }),
    );
    expect(markup).not.toContain('Next step');
    expect(markup).toContain('Verified');
  });

  it('CUST-018 an unverified run verdict does render its next step', async () => {
    const markup = await render(
      RunVerdict({ status: 'UNVERIFIED', explanation: explainRunStatus('UNVERIFIED') }),
    );
    expect(markup).toContain('Next step');
    expect(markup).toContain('connection status');
  });

  it('CUST-019 verified_percentage of null renders a headline, never a bar and never a zero', async () => {
    const health = summariseWorkflowHealth({ verified: 0, failed: 0, unverified: 0, pending: 0 });
    expect(health.verified_percentage).toBeNull();
    const markup = await render(HealthReadout(health));
    expect(markup).toContain('No runs received yet');
    expect(markup).toContain('data-score="none"');
    expect(markup).not.toContain('class="meter"');
    expect(markup).not.toContain('0%');
    expect(markup).not.toContain('100%');
  });

  it('CUST-020 awaiting_first_result also renders a headline rather than a rate', async () => {
    const health = summariseWorkflowHealth({ verified: 0, failed: 0, unverified: 0, pending: 4 });
    expect(health.state).toBe('awaiting_first_result');
    const markup = await render(HealthReadout(health));
    expect(markup).toContain('Waiting for the first result');
    expect(markup).not.toContain('class="meter"');
  });

  it('CUST-021 a real percentage does render a bar, with the number in its accessible name', async () => {
    const health = summariseWorkflowHealth({ verified: 1, failed: 1, unverified: 1, pending: 1 });
    expect(health.verified_percentage).toBe(33);
    const markup = await render(HealthReadout(health));
    expect(markup).toContain('class="meter"');
    expect(markup).toContain('data-score="33"');
    expect(markup).toContain('33% of 3 decided runs were verified');
  });

  it('CUST-022 the coverage limitation is rendered as visible body text, not inside a details or a title attribute', async () => {
    for (const mode of ['customer_triggered', 'independently_sourced'] as const) {
      const coverage = describeCoverage({ coverage_mode: mode });
      expect(coverage.limitation).not.toBeNull();
      const markup = await render(CoverageNotice(coverage));
      expect(markup).toContain('data-coverage-limitation');
      expect(markup).toContain(coverage.limitation!.slice(0, 40));
      expect(markup).not.toContain('<details');
      expect(markup).not.toContain('<summary');
      expect(markup).not.toMatch(/title="[^"]*receive nothing/);
    }
  });

  it('CUST-023 the inactivity signal renders as its own block, separate from any percentage', async () => {
    const report = detectInactivity({
      lastEventAt: null,
      expectedActivity: { window_seconds: 3600, minimum_events: 1 },
      now: new Date('2026-03-01T12:00:00.000Z'),
    });
    const markup = await render(InactivityNotice(report));
    expect(markup).toContain('No enquiries received yet');
    expect(markup).not.toContain('class="meter"');
    expect(markup).not.toContain('%');
  });

  it('CUST-024 the standing limitations paragraph is rendered verbatim from A01, not paraphrased', async () => {
    const markup = await render(StandingLimitations());
    expect(markup).toContain('data-standing-limitations');
    expect(markup).toContain(STANDING_LIMITATIONS_PARAGRAPH.slice(0, 80));
    expect(markup).toContain('We make no accuracy, security or uptime certification.');
  });
});

describe('forms and interaction', () => {
  it('CUST-025 a field error is announced, linked by aria-describedby and marks the control invalid', async () => {
    const markup = await render(
      Field({ name: 'email', label: 'Email address', error: 'Enter a complete email address.' }),
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="f-email-error"');
    expect(markup).toContain('id="f-email-error"');
    expect(markup).toContain('role="alert"');
  });

  it('CUST-026 a field with a hint and an error describes itself with both, in that order', async () => {
    const markup = await render(
      Field({
        name: 'prop',
        label: 'Property',
        hint: 'Letters and numbers.',
        error: 'Choose a property.',
      }),
    );
    expect(markup).toContain('aria-describedby="f-prop-hint f-prop-error"');
  });

  it('CUST-027 a field with no error renders no error element at all', async () => {
    const markup = await render(Field({ name: 'prop', label: 'Property' }));
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('aria-invalid');
  });

  it('CUST-028 every field label is bound to its control by id', async () => {
    const markup = await render(Field({ name: 'subject', label: 'Subject' }));
    expect(markup).toContain('for="f-subject"');
    expect(markup).toContain('id="f-subject"');
  });

  it('CUST-029 a CSRF field renders the token, and marks itself missing rather than silently empty', async () => {
    expect(await render(CsrfField('abc123'))).toContain('name="csrf_token" value="abc123"');
    expect(await render(CsrfField(null))).toContain('data-csrf="missing"');
  });

  it('CUST-030 buttons are real buttons and links are real anchors — never a clickable div', async () => {
    const button = await render(Button({ label: 'Save changes', variant: 'primary' }));
    expect(button).toMatch(/^<button/);
    expect(button).toContain('type="submit"');
    const link = await render(Button({ label: 'See the demo', href: '/demo' }));
    expect(link).toMatch(/^<a/);
    expect(link).toContain('href="/demo"');
    for (const markup of [button, link]) {
      expect(markup).not.toContain('onclick');
    }
  });

  it('CUST-031 an external link carries rel="noopener noreferrer"', async () => {
    const markup = await render(
      Button({ label: 'Billing portal', href: 'https://example.test/p', external: true }),
    );
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('CUST-032 a fieldset has a legend, and a checkbox is bound to its own label', async () => {
    const markup = await render(
      Fieldset({
        legend: 'Required checks',
        body: Checkbox({ name: 'requireRecordExists', label: 'A CRM record was created' }),
      }),
    );
    expect(markup).toContain('<legend>Required checks</legend>');
    expect(markup).toContain('for="f-requireRecordExists"');
  });

  it('CUST-033 a table is wrapped in its own horizontally scrollable, keyboard-reachable region', async () => {
    const markup = await render(
      Table({ caption: 'Runs', columns: [{ key: 'a', header: 'A', cell: () => 'x' }], rows: [{}] }),
    );
    expect(markup).toContain('class="tablewrap" role="region" tabindex="0"');
    expect(markup).toContain('aria-label="Runs"');
    expect(markup).toContain('scope="col"');
  });

  it('CUST-034 a table with a row header marks it with scope="row"', async () => {
    const markup = await render(
      Table({
        caption: 'Runs',
        columns: [{ key: 'id', header: 'Run', rowHeader: true, cell: () => 'run_1' }],
        rows: [{}],
      }),
    );
    expect(markup).toContain('scope="row"');
  });

  it('CUST-035 pagination offers newer and older rather than a page number a cursor API cannot honour', async () => {
    const both = await render(
      Pagination({ newerHref: '/a?cursor=0', olderHref: '/a?cursor=50', shown: 25, noun: 'runs' }),
    );
    expect(both).toContain('rel="prev"');
    expect(both).toContain('rel="next"');
    expect(both).not.toMatch(/page \d+ of \d+/i);

    const single = await render(
      Pagination({ newerHref: null, olderHref: null, shown: 3, noun: 'runs' }),
    );
    expect(single).toContain('3 runs — this is all of them');
    expect(single).not.toContain('<a');
  });

  it('CUST-036 a breadcrumb marks only the last item as the current page', async () => {
    const markup = await render(
      Breadcrumb([
        { label: 'Workspace', href: '/app' },
        { label: 'Runs', href: '/app/runs' },
        { label: 'run_1' },
      ]),
    );
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect((markup.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it('CUST-037 the three states say what to do, and render no action block when there is no action', async () => {
    const empty = await render(
      EmptyState({ title: 'No runs received yet', body: 'Nothing has reached us.' }),
    );
    expect(empty).not.toContain('state__actions');

    const error = await render(
      ErrorState({
        title: 'We could not save that',
        body: 'Nothing was changed.',
        requestId: 'req_1',
      }),
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('req_1');

    const loading = await render(
      LoadingState({ title: 'Still checking', body: 'The window is open.' }),
    );
    expect(loading).toContain('aria-live="polite"');
    expect(loading).toContain('aria-busy="true"');
  });

  it('CUST-038 a callout can be given the limit tone, which is what the coverage limitation uses', async () => {
    const markup = await render(
      Callout({ tone: 'limit', title: 'What this cannot see', body: html`<p>x</p>` }),
    );
    expect(markup).toContain('callout--limit');
    expect(markup).toContain('data-tone="limit"');
  });

  it('CUST-039 an assertion row shows the plain sentence, and the reason code only as a trailing note', async () => {
    const markup = await render(
      AssertionRow({
        status: 'UNKNOWN',
        explanation: {
          rule_id: 'email_delivered',
          headline: 'Could not confirm: The acknowledgement email reached the recipient',
          sentence: 'We asked the email provider for events on this message and it reported none.',
          next_step: 'Check that your automation actually sent the acknowledgement.',
          detail: 'We expected one of: delivered. We did not retrieve a value.',
        },
        reasonCode: 'EVENT_NOT_OBSERVED',
        mandatory: true,
      }),
    );
    const sentenceAt = markup.indexOf('We asked the email provider');
    const codeAt = markup.indexOf('EVENT_NOT_OBSERVED');
    expect(sentenceAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(sentenceAt);
    expect(markup).toContain('Could not confirm');
  });

  it('CUST-040 an optional check is labelled optional so it cannot be mistaken for a required one', async () => {
    const markup = await render(
      AssertionRow({
        status: 'CONTRADICTED',
        explanation: { rule_id: 'r', headline: 'h', sentence: 's', next_step: null, detail: null },
        mandatory: false,
      }),
    );
    expect(markup).toContain('optional');
  });
});
