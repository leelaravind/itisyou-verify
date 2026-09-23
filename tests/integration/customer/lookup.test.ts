/**
 * Finding a record or message to test with: does choosing one fill an id, and only an id?
 *
 * ## The failure this file is built around
 *
 * The easy version of a picker copies what it shows. Choose a contact and its correlation
 * value lands in "the value in your correlation property"; choose a message and its
 * recipient lands in "the address it should have reached". Every test run afterwards then
 * compares an observed value with itself and passes. That would be the product reporting
 * the exact kind of false pass it exists to refuse, and it would look like a convenience.
 *
 * So the cases below drive `POST /app/test-verification/lookup` through the real Worker
 * with a real session and CSRF pair, stub the PROVIDERS (never our code), and check:
 *
 *  - a pick fills the identifier and leaves both expectations exactly as the reader left
 *    them, including empty;
 *  - the contact finder never requests, and never shows, the correlation value;
 *  - nothing here admits an event, creates a run or moves the allowance;
 *  - searches are bounded: a paging cap, a per-workspace rate limit, one provider call per
 *    press, and a refusal that reaches no provider when a bound is hit;
 *  - a failed search explains itself, says nothing was charged, leaves manual entry open
 *    and does not move the connection's status;
 *  - Enter can search but can never start a charged check.
 *
 * Case ids `VERIFY-905..VERIFY-919`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@verify/security';
import {
  getSignedIn,
  postSignedIn,
  servedStylesheet,
  signedInWorkspace,
  visibleText,
  type SignedIn,
} from './harness.js';

/** Assembled at runtime: a credential-shaped literal is rejected by the secret scanner. */
const HUBSPOT_TOKEN = ['pat', 'eu1', '00000000-0000-4000-8000-000000000021'].join('-');
const RESEND_KEY = ['re', '0000000000000000000000000000000021'].join('_');
const WRAPPING_KEY = toBase64(new Uint8Array(32).fill(21));
const ENV = { CREDENTIAL_KEY_V1: WRAPPING_KEY } as const;
const PROPERTY = 'verify_correlation_id';
/** A correlation value the provider holds. It must never reach the page. */
const OBSERVED_REFERENCE = 'ENQ-OBSERVED-7731';

const MSG_A = '0f2b6a8e-1c7d-4e5f-9a0b-1c2d3e4f5a61';
const MSG_B = '0f2b6a8e-1c7d-4e5f-9a0b-1c2d3e4f5a62';
const MSG_C = '0f2b6a8e-1c7d-4e5f-9a0b-1c2d3e4f5a63';

let open: SignedIn | null = null;
afterEach(() => {
  open?.h.close();
  open = null;
  vi.unstubAllGlobals();
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

type Reply = { readonly status?: number; readonly body: unknown } | 'unreachable';

/** A provider stand-in routed by host and path, recording every call made to it. */
function stubProviders(routes: {
  readonly tokenInfo?: Reply;
  readonly contactSearch?: Reply;
  readonly domains?: Reply;
  readonly emails?: Reply;
}): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const path = new URL(url).pathname;
    const reply: Reply | undefined = path.endsWith('/access-token-info')
      ? routes.tokenInfo
      : path === '/crm/v3/objects/contacts/search'
        ? routes.contactSearch
        : path === '/domains'
          ? routes.domains
          : path === '/emails'
            ? routes.emails
            : undefined;
    if (reply === undefined) return new Response('{}', { status: 404 });
    if (reply === 'unreachable') throw new TypeError('network unreachable');
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

const HEALTHY_HUBSPOT = { body: { hubId: 24680, scopes: ['crm.objects.contacts.read'] } };

function contact(id: string, first: string, last: string, email: string): unknown {
  return {
    id,
    // The provider sends the correlation value back if asked; this stand-in sends it even
    // unasked, so the page is proven not to render it rather than merely never given it.
    properties: {
      firstname: first,
      lastname: last,
      email,
      createdate: '2026-09-20T09:00:00.000Z',
      [PROPERTY]: OBSERVED_REFERENCE,
    },
    createdAt: '2026-09-20T09:00:00.000Z',
    archived: false,
  };
}

const THREE_CONTACTS = {
  body: {
    total: 3,
    results: [
      contact('101', 'Ada', 'Lovelace', 'ada@example.test'),
      contact('102', 'Grace', 'Hopper', 'grace@example.test'),
      contact('103', 'Alan', 'Turing', 'alan@example.test'),
    ],
    paging: { next: { after: '10' } },
  },
};

function sent(id: string, to: string, subject: string, lastEvent: string): unknown {
  return {
    id,
    to: [to],
    from: 'hello@example.test',
    subject,
    created_at: '2026-09-22T08:00:00.000Z',
    last_event: lastEvent,
  };
}

const THREE_MESSAGES = {
  body: {
    object: 'list',
    has_more: true,
    data: [
      sent(MSG_A, 'observed-a@example.test', 'Thanks for your enquiry', 'delivered'),
      sent(MSG_B, 'observed-b@example.test', 'Your quote', 'bounced'),
      sent(MSG_C, 'observed-c@example.test', 'Thanks for your enquiry', 'sent'),
    ],
  },
};

/** A workspace that could run a test: subscribed, with a correlation property published. */
async function ready(): Promise<SignedIn> {
  open = await signedInWorkspace({ consumed: 7 });
  open.h.raw
    .prepare('UPDATE workflow_versions SET rules_json = ? WHERE workspace_id = ?')
    .run(
      JSON.stringify({ schema_version: 1, crm_correlation_property: PROPERTY, assertions: [] }),
      open.workspaceId,
    );
  return open;
}

async function connect(session: SignedIn, provider: 'hubspot' | 'resend'): Promise<void> {
  stubProviders(
    provider === 'hubspot' ? { tokenInfo: HEALTHY_HUBSPOT } : { domains: { body: { data: [] } } },
  );
  const served = await postSignedIn(
    session,
    '/app/onboarding/connect',
    {
      provider,
      intent: 'credentials',
      access_token: provider === 'hubspot' ? HUBSPOT_TOKEN : RESEND_KEY,
    },
    { env: ENV },
  );
  expect(served.status, `the fixture must start from a real ${provider} credential`).toBe(200);
  vi.unstubAllGlobals();
}

const TYPED = {
  crmRecordId: '',
  correlationValue: 'ENQ-TYPED-BY-CUSTOMER',
  messageId: '',
  expectedRecipient: 'should-reach@example.test',
  submissionId: '11111111-2222-4333-8444-555555555555',
};

async function lookup(
  session: SignedIn,
  fields: Record<string, string>,
  env: Readonly<Record<string, unknown>> = ENV,
): Promise<{ status: number; html: string }> {
  return postSignedIn(session, '/app/test-verification/lookup', fields, {
    csrfSourcePath: '/app',
    env,
  });
}

/** The `value` attribute of one named input, or null when it carries none. */
function inputValue(markup: string, name: string): string | null {
  const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(markup)?.[0];
  if (tag === undefined) throw new Error(`no input named ${name} was rendered`);
  const value = /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
  // An empty value is nothing filled in, whichever way the template spells it.
  return value === '' ? null : value;
}

/** Everything that would show the allowance or the pipeline moved. */
function ledgerOf(session: SignedIn): Record<string, unknown> {
  const ent = session.h.raw
    .prepare('SELECT SUM(consumed) AS consumed, SUM(reserved) AS reserved FROM entitlements')
    .get() as Record<string, unknown>;
  const runs = session.h.raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
  const events = session.h.raw.prepare('SELECT COUNT(*) AS n FROM source_events').get() as {
    n: number;
  };
  return { ...ent, runs: runs.n, events: events.n };
}

describe('the finders on the test verification form', () => {
  it('VERIFY-905 the finders sit inside the form, submit elsewhere, and Enter can never start a charged check', async () => {
    const session = await ready();
    const served = await getSignedIn(session, '/app');
    expect(served.status).toBe(200);
    const form = /<form[^>]*data-verify-form[\s\S]*?<\/form>/.exec(served.html)?.[0] ?? '';
    expect(form, 'the test form was not rendered').not.toBe('');

    // The first submit button in the form is its default for Enter. It must be a lookup.
    const firstButton = /<button[^>]*>/.exec(form)?.[0] ?? '';
    expect(firstButton).toContain('formaction="/app/test-verification/lookup"');
    expect(firstButton).toContain('formnovalidate');
    expect(firstButton).toContain('value="enter"');
    expect(firstButton).toContain('hidden');
    // And it is actually not drawn. `.btn{display:inline-flex}` beats the browser's own
    // [hidden] rule, so without this the form opened with a stray "Search" button that a
    // screen reader could not see. Found by an independent review, not by this case.
    expect(servedStylesheet(served.html)).toContain('.btn[hidden]{display:none}');

    // Both finders are there, and every lookup button skips the required-field check.
    expect(form).toContain('data-lookup="records"');
    expect(form).toContain('data-lookup="messages"');
    const lookupButtons =
      form.match(/<button[^>]*formaction="\/app\/test-verification\/lookup"[^>]*>/g) ?? [];
    expect(lookupButtons.length).toBeGreaterThanOrEqual(3);
    for (const button of lookupButtons) expect(button).toContain('formnovalidate');

    // And the one button that costs a run goes to the form's own action, no other.
    const charged = form.match(/<button[^>]*>\s*Run a test verification/g) ?? [];
    expect(charged).toHaveLength(1);
    expect(charged[0]).not.toContain('formaction');
  });

  it('VERIFY-906 a contact search shows who each contact is, never the correlation value, and keeps what was typed', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    const before = ledgerOf(session);
    const provider = stubProviders({ contactSearch: THREE_CONTACTS });

    const served = await lookup(session, { ...TYPED, lookup: 'records', recordQuery: 'example' });

    expect(served.status).toBe(200);
    const text = visibleText(served.html);
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('grace@example.test');
    expect(served.html).toContain('name="pickRecord" value="101"');
    // The value under test is neither shown nor carried anywhere in the page.
    expect(served.html, 'the observed correlation value reached the page').not.toContain(
      OBSERVED_REFERENCE,
    );
    // What the reader typed survives the search.
    expect(inputValue(served.html, 'correlationValue')).toBe('ENQ-TYPED-BY-CUSTOMER');
    expect(inputValue(served.html, 'expectedRecipient')).toBe('should-reach@example.test');
    expect(inputValue(served.html, 'submissionId')).toBe(TYPED.submissionId);

    // One provider call, a read, asking for recognisable fields only.
    expect(provider.calls).toHaveLength(1);
    const request = JSON.parse(provider.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(request['query']).toBe('example');
    expect(JSON.stringify(request['filterGroups'])).toContain('HAS_PROPERTY');
    expect(request['properties']).not.toContain(PROPERTY);

    // Free: nothing admitted, nothing reserved, nothing consumed.
    expect(ledgerOf(session)).toEqual(before);
  });

  it('VERIFY-907 choosing a contact fills the record id, leaves both expectations exactly as they were, and clears its finished search', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    const provider = stubProviders({ contactSearch: THREE_CONTACTS });

    const served = await lookup(session, {
      ...TYPED,
      correlationValue: '',
      expectedRecipient: '',
      pickRecord: '102',
    });

    expect(served.status).toBe(200);
    expect(inputValue(served.html, 'crmRecordId')).toBe('102');
    // The search that found it is over; its text would make a later Enter ambiguous.
    expect(inputValue(served.html, 'recordQuery')).toBeNull();
    expect(
      inputValue(served.html, 'correlationValue'),
      'a pick supplied an expectation',
    ).toBeNull();
    expect(
      inputValue(served.html, 'expectedRecipient'),
      'a pick supplied an expectation',
    ).toBeNull();
    expect(visibleText(served.html)).toContain('Only its id');
    // A pick is local: it asks the provider nothing.
    expect(provider.calls).toHaveLength(0);
  });

  it('VERIFY-908 choosing a message fills the message id and never the recipient it was sent to', async () => {
    const session = await ready();
    await connect(session, 'resend');
    const before = ledgerOf(session);
    const provider = stubProviders({ emails: THREE_MESSAGES });

    const listed = await lookup(session, { ...TYPED, expectedRecipient: '', lookup: 'messages' });
    expect(listed.status).toBe(200);
    expect(visibleText(listed.html)).toContain('observed-a@example.test');
    expect(listed.html).toContain(`name="pickMessage" value="${MSG_B}"`);
    expect(provider.calls[0]?.url).toBe('https://api.resend.com/emails?limit=20');
    expect(provider.calls[0]?.method).toBe('GET');
    // What a browser would actually submit on a pick is every control in the form, so the
    // listing itself must carry no second expectation field and no observed address in any
    // control's value. Asserting only the picked page would miss a leak placed here.
    const form = /<form[^>]*data-verify-form[\s\S]*?<\/form>/.exec(listed.html)?.[0] ?? '';
    expect(form.match(/name="expectedRecipient"/g) ?? []).toHaveLength(1);
    expect(form.match(/name="correlationValue"/g) ?? []).toHaveLength(1);
    expect(form, 'an observed address sits in a form control').not.toMatch(
      /<(input|textarea|select|button)[^>]*value="observed-/,
    );

    const picked = await lookup(session, { ...TYPED, expectedRecipient: '', pickMessage: MSG_B });
    expect(inputValue(picked.html, 'messageId')).toBe(MSG_B);
    expect(
      inputValue(picked.html, 'expectedRecipient'),
      'the observed recipient became the expectation',
    ).toBeNull();
    expect(picked.html).not.toContain('value="observed-b@example.test"');
    expect(ledgerOf(session)).toEqual(before);
  });

  it('VERIFY-909 a message filter says how many messages it looked through rather than implying a full search', async () => {
    const session = await ready();
    await connect(session, 'resend');
    stubProviders({ emails: THREE_MESSAGES });

    const served = await lookup(session, { ...TYPED, lookup: 'messages', messageQuery: 'quote' });
    const text = visibleText(served.html);
    expect(text).toContain('1 of 3 messages match "quote"');
    expect(text).toContain('older messages were not looked at');
    expect(served.html).toContain(`value="${MSG_B}"`);
    expect(served.html).not.toContain(`name="pickMessage" value="${MSG_A}"`);
    // Resend said there are more, so the next page is offered with its cursor.
    expect(inputValue(served.html, 'messageCursor')).toBe(MSG_C);
  });

  it('VERIFY-910 no match and one match are both answers for a person: nothing is chosen for them', async () => {
    const session = await ready();
    await connect(session, 'hubspot');

    stubProviders({ contactSearch: { body: { total: 0, results: [] } } });
    const none = await lookup(session, { ...TYPED, lookup: 'records', recordQuery: 'nobody' });
    expect(visibleText(none.html)).toContain('matched "nobody"');
    expect(visibleText(none.html)).toContain('type the record id in');
    expect(inputValue(none.html, 'crmRecordId')).toBeNull();

    vi.unstubAllGlobals();
    stubProviders({
      contactSearch: {
        body: { total: 1, results: [contact('555', 'Only', 'One', 'one@example.test')] },
      },
    });
    const one = await lookup(session, { ...TYPED, lookup: 'records', recordQuery: 'only' });
    expect(one.html).toContain('name="pickRecord" value="555"');
    // Exactly one match is still not a choice made for the reader.
    expect(inputValue(one.html, 'crmRecordId'), 'a single match was silently filled in').toBeNull();
  });

  it('VERIFY-911 a refused search says why, says nothing was charged, keeps manual entry, and leaves the connection as it was', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    const statusBefore = session.h.raw
      .prepare("SELECT status, last_error_code FROM connections WHERE provider = 'hubspot'")
      .get();
    const before = ledgerOf(session);

    stubProviders({
      contactSearch: {
        status: 401,
        body: { status: 'error', category: 'INVALID_AUTHENTICATION', message: 'expired' },
      },
    });
    const refused = await lookup(session, { ...TYPED, lookup: 'records' });
    expect(refused.status).toBe(200);
    const text = visibleText(refused.html);
    expect(text).toContain('HubSpot refused the stored key');
    expect(text).toContain('Nothing was charged');
    expect(refused.html).toContain('name="crmRecordId"');
    expect(inputValue(refused.html, 'correlationValue')).toBe('ENQ-TYPED-BY-CUSTOMER');

    vi.unstubAllGlobals();
    stubProviders({ contactSearch: 'unreachable' });
    const silent = await lookup(session, { ...TYPED, lookup: 'records' });
    // Silence is not absence.
    expect(visibleText(silent.html)).toContain('says nothing about whether the record exists');

    const statusAfter = session.h.raw
      .prepare("SELECT status, last_error_code FROM connections WHERE provider = 'hubspot'")
      .get();
    expect(statusAfter, 'a lookup moved the connection status').toEqual(statusBefore);
    expect(ledgerOf(session)).toEqual(before);
  });

  it('VERIFY-912 paging stops at the cap without asking the provider, and a tampered cursor is refused the same way', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    const provider = stubProviders({ contactSearch: THREE_CONTACTS });

    const capped = await lookup(session, {
      ...TYPED,
      lookup: 'records-more',
      recordCursor: '40',
      recordPage: '5',
    });
    expect(visibleText(capped.html)).toContain('as far as a lookup pages');
    expect(provider.calls, 'a capped page reached HubSpot').toHaveLength(0);

    const tampered = await lookup(session, {
      ...TYPED,
      lookup: 'records-more',
      recordCursor: '5000',
      recordPage: '1',
    });
    expect(visibleText(tampered.html)).toContain('Nothing was charged');
    expect(provider.calls, 'an out-of-range cursor reached HubSpot').toHaveLength(0);

    const second = await lookup(session, {
      ...TYPED,
      lookup: 'records-more',
      recordCursor: '10',
      recordPage: '1',
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(provider.calls[0]?.body ?? '{}')).toMatchObject({ after: '10' });

    // The page counter is the form's to send, so it cannot be the real bound. The server
    // allows four continuations per window whatever the counter says: the tampered one
    // and the one above spent two, two more succeed, and the next is refused unasked.
    for (const cursor of ['20', '30']) {
      await lookup(session, {
        ...TYPED,
        lookup: 'records-more',
        recordCursor: cursor,
        recordPage: '1',
      });
    }
    expect(provider.calls).toHaveLength(3);
    const walked = await lookup(session, {
      ...TYPED,
      lookup: 'records-more',
      recordCursor: '10',
      recordPage: '1',
    });
    expect(visibleText(walked.html)).toContain('as far as a lookup pages');
    expect(provider.calls, 'a fifth continuation reached HubSpot').toHaveLength(3);
  });

  it('VERIFY-919 at the last page, a provider that has more says so rather than ending in silence', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    // HubSpot offers a cursor past the connector's offset cap, which the connector drops.
    stubProviders({
      contactSearch: { body: { ...THREE_CONTACTS.body, paging: { next: { after: '50' } } } },
    });
    const last = await lookup(session, {
      ...TYPED,
      lookup: 'records-more',
      recordCursor: '40',
      recordPage: '4',
    });
    expect(last.status).toBe(200);
    expect(last.html).toContain('data-lookup-results="records"');
    expect(visibleText(last.html)).toContain('Narrow the search');
    expect(last.html, 'a cursor past the cap was offered').not.toContain('name="recordCursor"');
  });

  it('VERIFY-913 searches are rate limited per workspace and provider, and the refusal reaches no provider', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    const provider = stubProviders({ contactSearch: THREE_CONTACTS });

    for (let press = 0; press < 20; press += 1) {
      const served = await lookup(session, { ...TYPED, lookup: 'records' });
      expect(served.status).toBe(200);
    }
    expect(provider.calls).toHaveLength(20);
    const limited = await lookup(session, { ...TYPED, lookup: 'records' });
    expect(visibleText(limited.html)).toContain('a lot of searches in a short time');
    expect(provider.calls, 'the 21st search reached HubSpot').toHaveLength(20);
  });

  it('VERIFY-914 with nothing connected, or as a viewer, a lookup is refused and no provider is asked', async () => {
    const session = await ready();
    const provider = stubProviders({ contactSearch: THREE_CONTACTS, emails: THREE_MESSAGES });

    const unconnected = await lookup(session, { ...TYPED, lookup: 'messages' });
    expect(visibleText(unconnected.html)).toContain('no Resend connection to look in');
    expect(provider.calls).toHaveLength(0);

    vi.unstubAllGlobals();
    await connect(session, 'hubspot');
    session.h.raw.prepare("UPDATE memberships SET role = 'workspace_viewer'").run();
    const again = stubProviders({ contactSearch: THREE_CONTACTS });
    await lookup(session, { ...TYPED, lookup: 'records' });
    expect(again.calls, 'a viewer searched a provider').toHaveLength(0);
  });

  it('VERIFY-915 Enter searches the box that has text, and when it cannot tell, it searches nothing and starts nothing', async () => {
    const session = await ready();
    await connect(session, 'resend');
    const before = ledgerOf(session);
    const provider = stubProviders({ emails: THREE_MESSAGES });

    const inferred = await lookup(session, { ...TYPED, lookup: 'enter', messageQuery: 'quote' });
    expect(inferred.html).toContain('data-lookup-results="messages"');
    expect(provider.calls).toHaveLength(1);

    // Met in the browser: a contact search leaves its text in its box, so "which box has
    // text" alone refused an Enter pressed in the message box. The box the reader EDITED
    // since the page was drawn decides it.
    const edited = await lookup(session, {
      ...TYPED,
      lookup: 'enter',
      recordQuery: 'ada',
      recordQueryWas: 'ada',
      messageQuery: 'quote',
      messageQueryWas: '',
    });
    expect(edited.html).toContain('data-lookup-results="messages"');
    expect(provider.calls).toHaveLength(2);

    const unclear = await lookup(session, {
      ...TYPED,
      lookup: 'enter',
      crmRecordId: '101',
      messageId: MSG_A,
    });
    expect(visibleText(unclear.html)).toContain('Nothing was started and nothing was searched');
    expect(inputValue(unclear.html, 'crmRecordId')).toBe('101');
    expect(provider.calls).toHaveLength(2);
    expect(ledgerOf(session)).toEqual(before);
  });

  it('VERIFY-916 a lookup without a valid CSRF pair is refused before any provider is called', async () => {
    const session = await ready();
    await connect(session, 'hubspot');
    const provider = stubProviders({ contactSearch: THREE_CONTACTS });
    const served = await postSignedIn(
      session,
      '/app/test-verification/lookup',
      { ...TYPED, lookup: 'records' },
      { csrfSourcePath: '/app', env: ENV, csrfTokenOverride: 'not-the-token' },
    );
    expect(served.status).toBeGreaterThanOrEqual(400);
    expect(provider.calls).toHaveLength(0);
  });

  it('VERIFY-917 a choice that is not a provider id fills nothing in', async () => {
    const session = await ready();
    const record = await lookup(session, { ...TYPED, crmRecordId: '', pickRecord: '12a; DROP' });
    expect(visibleText(record.html)).toContain('was not a HubSpot record id');
    expect(inputValue(record.html, 'crmRecordId')).toBeNull();
    const message = await lookup(session, { ...TYPED, pickMessage: 'not-a-message' });
    expect(visibleText(message.html)).toContain('was not a Resend message id');
    expect(inputValue(message.html, 'messageId')).toBeNull();
  });

  it('VERIFY-918 a submission that fails validation comes back with what was typed, under the same submission identity', async () => {
    const session = await ready();
    const served = await postSignedIn(
      session,
      '/app/test-verification',
      { ...TYPED, crmRecordId: '', messageId: '' },
      { csrfSourcePath: '/app', env: ENV },
    );
    expect(served.status).toBe(422);
    expect(inputValue(served.html, 'correlationValue')).toBe('ENQ-TYPED-BY-CUSTOMER');
    expect(inputValue(served.html, 'expectedRecipient')).toBe('should-reach@example.test');
    expect(inputValue(served.html, 'submissionId')).toBe(TYPED.submissionId);
  });
});
