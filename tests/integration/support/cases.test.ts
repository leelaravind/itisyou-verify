/**
 * CUST-2xx — support cases and the public form, end to end.
 *
 * The property that matters most here is redaction *on the way in*. A test that reads a
 * case back and finds no key proves nothing if the raw text was stored and masked on
 * read — so these assertions look at what the port was actually handed.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { InMemoryRateLimiter, InMemorySupportData } from '@app/support/memory';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  createCase,
  redactSupportBody,
  transitionCase,
} from '@app/support/cases';
import { FORM_LIMITS, submitSupportForm, type SupportFormContext } from '@app/support/form';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function context(
  port: InMemorySupportData,
  overrides: Partial<SupportFormContext> = {},
): SupportFormContext {
  return {
    port,
    rateLimiter: new InMemoryRateLimiter(),
    clientHash: 'client-hash-1',
    workspaceId: null,
    servicePaused: false,
    now: NOW,
    ...overrides,
  };
}

describe('support cases', () => {
  it('CUST-270 a signed-out visitor can open a case, and it carries no workspace', async () => {
    const port = new InMemorySupportData();
    const outcome = await submitSupportForm(context(port), {
      email: 'visitor@example.com',
      subject: 'Locked out',
      message: 'I cannot sign in and the link never arrives.',
      runId: '',
    });

    expect(outcome.case.record.workspaceId).toBeNull();
    expect(port.cases.size).toBe(1);
    // "I cannot sign in" matches no rule, so triage escalates rather than guessing that a
    // person locked out of their account is a low-priority query.
    expect(outcome.case.triage.escalationReason).toBe('customer_impact_unclear');
    expect(outcome.case.acknowledgement).toMatch(/straight to the owner/i);
    expect(outcome.case.acknowledgement).toMatch(
      /we do not send an automated answer pretending to be one/i,
    );
  });

  it('CUST-271 the body is redacted before it reaches the port, not on the way out', async () => {
    const port = new InMemorySupportData();
    await createCase(
      port,
      {
        workspaceId: 'ws_1',
        contactEmail: 'owner@example.com',
        subject: 'Connection broken',
        body: 'Here is the key I used: re_ABCDEFGH12345678 and my colleague is bob@example.com.',
      },
      NOW,
    );

    const stored = [...port.cases.values()][0];
    expect(stored?.bodyRedacted).not.toContain('re_ABCDEFGH12345678');
    expect(stored?.bodyRedacted).toContain('[redacted:credential]');
    expect(stored?.bodyRedacted).not.toContain('bob@example.com');
    expect(stored?.bodyRedacted).toContain('b**@example.com');
  });

  it('CUST-272 a pasted bearer token, API key assignment and card number are all removed', () => {
    const { text, kinds } = redactSupportBody(
      [
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'api_key = 8f4c2a9d1e7b3f6a',
        'card 4111 1111 1111 1111',
        'link https://app.example/callback?code=abc123&state=xyz',
      ].join('\n'),
    );

    expect(text).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(text).not.toContain('8f4c2a9d1e7b3f6a');
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).not.toContain('code=abc123');
    expect(kinds).toContain('bearer_token');
    expect(kinds).toContain('credential');
    expect(kinds).toContain('payment_card');
    expect(kinds).toContain('url_query');
  });

  it('CUST-273 ordinary prose survives redaction intact', () => {
    const prose =
      'Re: my subscription. The token expired message keeps appearing and I do not know why.';
    const { text } = redactSupportBody(prose);
    expect(text).toBe(prose);
  });

  it('CUST-274 an over-long body is truncated and the truncation is recorded, not hidden', () => {
    const { text, kinds } = redactSupportBody('a'.repeat(9_000));
    expect(kinds).toContain('truncated');
    expect(text).toContain('[truncated by');
  });

  it('CUST-275 the form works while the service is paused, and says so', async () => {
    const port = new InMemorySupportData();
    const outcome = await submitSupportForm(context(port, { servicePaused: true }), {
      email: 'visitor@example.com',
      subject: 'Is anything working',
      message: 'Your status page says paused. I still need to cancel.',
      runId: '',
    });

    expect(port.cases.size).toBe(1);
    expect(outcome.case.acknowledgement).toMatch(/currently paused/i);
    // And the pause did not downgrade the triage decision.
    expect(outcome.case.record.category).toBe('cancellation');
  });

  it('CUST-276 the form is rate limited per client, with a Retry-After', async () => {
    const port = new InMemorySupportData();
    const shared = context(port, { rateLimiter: new InMemoryRateLimiter() });
    const submission = (n: number) => ({
      email: `visitor${String(n)}@example.com`,
      subject: 'Question',
      message: 'A question about setting up my first workflow.',
      runId: '',
    });

    for (let i = 0; i < FORM_LIMITS.PER_CLIENT_PER_HOUR; i += 1) {
      await submitSupportForm(shared, submission(i));
    }

    await expect(submitSupportForm(shared, submission(99))).rejects.toMatchObject({
      httpStatus: 429,
    });
  });

  it('CUST-277 the form is rate limited per address, even from different clients', async () => {
    const port = new InMemorySupportData();
    const limiter = new InMemoryRateLimiter();
    const submission = {
      email: 'flooder@example.com',
      subject: 'Question',
      message: 'A question about setting up my first workflow.',
      runId: '',
    };

    for (let i = 0; i < FORM_LIMITS.PER_EMAIL_PER_HOUR; i += 1) {
      await submitSupportForm(
        context(port, {
          rateLimiter: limiter,
          clientHash: `client-${String(i)}`,
        }),
        submission,
      );
    }

    await expect(
      submitSupportForm(
        context(port, { rateLimiter: limiter, clientHash: 'client-fresh' }),
        submission,
      ),
    ).rejects.toMatchObject({ httpStatus: 429 });
  });

  it('CUST-278 an oversized payload is refused before the body is parsed', async () => {
    const port = new InMemorySupportData();
    await expect(
      submitSupportForm(context(port), { email: 'a@b.co' }, FORM_LIMITS.MAX_PAYLOAD_BYTES + 1),
    ).rejects.toMatchObject({ httpStatus: 413 });
    expect(port.cases.size).toBe(0);
  });

  it('CUST-279 an invalid submission is a typed 422, and nothing is stored', async () => {
    const port = new InMemorySupportData();
    const error = await submitSupportForm(context(port), {
      email: 'nope',
      subject: '',
      message: '',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).httpStatus).toBe(422);
    expect(port.cases.size).toBe(0);
  });

  it('CUST-280 a transition outside the table is refused without touching the row', async () => {
    const port = new InMemorySupportData();
    const created = await createCase(
      port,
      {
        workspaceId: 'ws_1',
        contactEmail: 'owner@example.com',
        subject: 'Setup help',
        body: 'How do I connect HubSpot for my first workflow?',
      },
      NOW,
    );

    expect(canTransition('closed', 'answered')).toBe(false);
    const outcome = await transitionCase(
      port,
      {
        id: created.record.id,
        workspaceId: 'ws_1',
        from: 'closed',
        to: 'answered',
      },
      NOW,
    );
    expect(outcome).toEqual({ changed: false, reason: 'not_allowed' });
    expect(port.cases.get(created.record.id)?.state).toBe('open');
  });

  it('CUST-281 two owners transitioning the same case: exactly one wins', async () => {
    const port = new InMemorySupportData();
    const created = await createCase(
      port,
      {
        workspaceId: 'ws_1',
        contactEmail: 'owner@example.com',
        subject: 'Setup help',
        body: 'How do I connect HubSpot for my first workflow?',
      },
      NOW,
    );

    const first = await transitionCase(
      port,
      {
        id: created.record.id,
        workspaceId: 'ws_1',
        from: 'open',
        to: 'answered',
      },
      NOW,
    );
    const second = await transitionCase(
      port,
      {
        id: created.record.id,
        workspaceId: 'ws_1',
        from: 'open',
        to: 'closed',
      },
      NOW,
    );

    expect(first.changed).toBe(true);
    expect(second).toEqual({
      changed: false,
      reason: 'state_moved_underneath',
    });
    expect(port.cases.get(created.record.id)?.state).toBe('answered');
  });

  it('CUST-282 a case belonging to another workspace is not readable, and not transitionable', async () => {
    const port = new InMemorySupportData();
    const created = await createCase(
      port,
      {
        workspaceId: 'ws_1',
        contactEmail: 'owner@example.com',
        subject: 'Setup help',
        body: 'How do I connect HubSpot for my first workflow?',
      },
      NOW,
    );

    expect(await port.getCase(created.record.id, 'ws_2')).toBeNull();
    const outcome = await transitionCase(
      port,
      {
        id: created.record.id,
        workspaceId: 'ws_2',
        from: 'open',
        to: 'closed',
      },
      NOW,
    );
    expect(outcome.changed).toBe(false);
    expect(port.cases.get(created.record.id)?.state).toBe('open');
  });

  it('CUST-283 every state in the transition table is one the schema allows', () => {
    const schemaStates = ['open', 'awaiting_owner', 'answered', 'escalated', 'closed'];
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(schemaStates).toContain(from);
      for (const to of targets) expect(schemaStates, `${from} -> ${to}`).toContain(to);
    }
  });

  it('CUST-284 a billing dispute submitted through the public form starts escalated', async () => {
    const port = new InMemorySupportData();
    const outcome = await submitSupportForm(context(port), {
      email: 'visitor@example.com',
      subject: 'Charged twice',
      message: 'You have taken two payments this month and I want a refund for one.',
      runId: '',
    });

    expect(outcome.case.record.state).toBe('escalated');
    expect(outcome.case.record.priority).toBe('urgent');
    // And the FAQ matcher did not answer it on the way past.
    expect(outcome.suggestion.matched).toBe(false);
  });
});
