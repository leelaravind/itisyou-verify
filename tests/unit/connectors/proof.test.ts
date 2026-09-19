/**
 * The proof run.
 *
 * The property under test: a proof can always say "I could not prove this", and it can
 * never say "pass" for a reason other than evidence. Several tests here assert that a
 * refusal happened *and* that no external call was made to produce it.
 *
 * `fetch` is stubbed throughout; no provider has been contacted from this file.
 */
import { describe, expect, it } from 'vitest';
import { runProof, crmPropertiesFor } from '@verify/connectors';
import {
  CORRELATION_VALUE,
  RECIPIENT,
  T_EVENT,
  T_INSIDE_WINDOW,
  makeAssertion,
  makeStandardWorkflow,
  makeWorkflowRules,
  rulesFor,
} from '../../fixtures/index.js';

const HUBSPOT_TOKEN = ['pat','na1','11111111-2222-3333-4444-555555555555'].join('-');
const RESEND_TOKEN = 're_0000000000000000000000000000';
const PORTAL = '1020304';
const FOREIGN_PORTAL = '9999999';
const EMAIL_ACCOUNT = 'resend-key-0123456789abcdef';
const CORRELATION_PROPERTY = 'verify_correlation_id';
const MESSAGE_ID = '56761188-7520-42d8-8898-ff6fc54ce618';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function contact(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: '33451',
    properties: {
      hs_object_id: '33451',
      email: RECIPIENT,
      createdate: '2026-03-01T12:01:00.000Z',
      [CORRELATION_PROPERTY]: CORRELATION_VALUE,
    },
    createdAt: '2026-03-01T12:01:00.000Z',
    archived: false,
    ...overrides,
  };
}

function email(overrides: Record<string, unknown> = {}): unknown {
  return {
    object: 'email',
    id: MESSAGE_ID,
    to: [RECIPIENT],
    from: 'Acme <ack@example.test>',
    created_at: '2026-03-01T12:01:30.000Z',
    subject: 'Thanks for your enquiry',
    last_event: 'delivered',
    ...overrides,
  };
}

interface Stubs {
  readonly tokenInfo?: () => Response;
  readonly search?: () => Response;
  readonly resend?: () => Response;
}

function stubs(routes: Stubs = {}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes('access-token-info')) {
      return routes.tokenInfo?.() ?? json({ hubId: Number(PORTAL), scopes: ['crm.objects.contacts.read'] });
    }
    if (url.includes('api.resend.com')) return routes.resend?.() ?? json(email());
    return routes.search?.() ?? json({ total: 1, results: [contact()] });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const crmSource = {
  provider: 'hubspot' as const,
  credentials: { accessToken: HUBSPOT_TOKEN },
  connection: {
    provider: 'hubspot' as const,
    account_id: PORTAL,
    correlation_property: CORRELATION_PROPERTY,
  },
};

const emailSource = {
  provider: 'resend' as const,
  credentials: { accessToken: RESEND_TOKEN },
  connection: { provider: 'resend' as const, account_id: EMAIL_ACCOUNT },
};

const locator = { correlation_value: CORRELATION_VALUE, message_id: MESSAGE_ID, recipient: RECIPIENT };

function proofInput(overrides: Record<string, unknown> = {}) {
  return {
    rules: makeStandardWorkflow(),
    locator,
    crm: crmSource,
    email: emailSource,
    occurredAt: T_EVENT,
    now: T_INSIDE_WINDOW,
    ...overrides,
  };
}

const noSleep = async (): Promise<void> => {};

// ---------------------------------------------------------------------------

describe('proof run refusals', () => {
  it('CONN-194 refuses to run when nothing is required, because a pass would mean nothing', async () => {
    const { fetchImpl, calls } = stubs();
    const result = await runProof(
      proofInput({
        rules: rulesFor(makeAssertion({ rule_id: 'optional_only', mandatory: false })),
        runtime: { fetchImpl, sleep: noSleep },
      }),
    );
    expect(result.ran).toBe(false);
    expect(result.status).toBeNull();
    expect(result.blockedReason).toContain('no required checks');
    expect(calls).toHaveLength(0);
  });

  it('CONN-195 refuses to run when a rule reads from a source that is not connected', async () => {
    const { fetchImpl, calls } = stubs();
    const result = await runProof(proofInput({ email: null, runtime: { fetchImpl, sleep: noSleep } }));
    expect(result.ran).toBe(false);
    expect(result.blockedReason).toContain('your email provider');
    expect(calls).toHaveLength(0);
  });

  it('CONN-196 names both disconnected sources rather than only the first', async () => {
    const { fetchImpl } = stubs();
    const result = await runProof(
      proofInput({ crm: null, email: null, runtime: { fetchImpl, sleep: noSleep } }),
    );
    expect(result.blockedReason).toContain('your CRM');
    expect(result.blockedReason).toContain('your email provider');
    expect(result.sources.map((s) => s.provider).sort()).toEqual(['hubspot', 'resend']);
    expect(result.sources.every((s) => !s.connected)).toBe(true);
  });

  it('CONN-197 refuses when there is no CRM locator to look anything up with', async () => {
    const { fetchImpl, calls } = stubs();
    const result = await runProof(
      proofInput({ locator: { message_id: MESSAGE_ID }, runtime: { fetchImpl, sleep: noSleep } }),
    );
    expect(result.ran).toBe(false);
    expect(result.blockedReason).toContain('correlation property');
    expect(calls).toHaveLength(0);
  });

  it('CONN-198 refuses when there is no message id, because Resend cannot be searched', async () => {
    const { fetchImpl, calls } = stubs();
    const result = await runProof(
      proofInput({ locator: { correlation_value: CORRELATION_VALUE }, runtime: { fetchImpl, sleep: noSleep } }),
    );
    expect(result.ran).toBe(false);
    expect(result.blockedReason).toContain('cannot be searched');
    expect(calls).toHaveLength(0);
  });

  it('CONN-199 always gives a blockedReason exactly when it did not run', async () => {
    const { fetchImpl } = stubs();
    const blockedResult = await runProof(proofInput({ crm: null, runtime: { fetchImpl, sleep: noSleep } }));
    const ranResult = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    expect(blockedResult.ran).toBe(false);
    expect(blockedResult.blockedReason).not.toBeNull();
    expect(ranResult.ran).toBe(true);
    expect(ranResult.blockedReason).toBeNull();
  });
});

describe('a proof that succeeds', () => {
  it('CONN-200 proves every check from evidence read back from the connected accounts', async () => {
    const { fetchImpl } = stubs();
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));

    expect(result.ran).toBe(true);
    expect(result.status).toBe('VERIFIED');
    expect(result.notProved).toHaveLength(0);
    expect(result.proved.map((p) => p.rule_id)).toContain('crm_record_exists');
    expect(result.summary).toContain('reading the evidence back');
  });

  it('CONN-201 reports which account each piece of evidence was attributed to', async () => {
    const { fetchImpl } = stubs();
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));

    const crm = result.sources.find((s) => s.provider === 'hubspot');
    expect(crm?.accountId).toBe(PORTAL);
    expect(crm?.accountMatchedConnection).toBe(true);
    expect(crm?.evidenceCount).toBe(1);
  });

  it('CONN-202 records that the evidence came from a readback, not from a customer claim', async () => {
    const { fetchImpl } = stubs();
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    for (const source of result.sources) {
      expect(source.origins).not.toContain('customer_claim');
      expect(source.origins).toContain('provider_readback');
    }
  });

  it('CONN-203 requests only the CRM properties the rules actually name', () => {
    const rules = makeWorkflowRules({
      assertions: [
        makeAssertion({ rule_id: 'a', field: 'record.id', operator: 'exists', expected: '' }),
        makeAssertion({
          rule_id: 'b',
          field: 'record.property',
          property_name: 'lifecyclestage',
          operator: 'equals',
          expected: 'lead',
          label: 'Lifecycle stage is lead',
        }),
      ],
    });
    expect(crmPropertiesFor(rules)).toEqual(['lifecyclestage']);
    expect(crmPropertiesFor(makeStandardWorkflow())).toEqual([]);
  });

  it('CONN-204 stays inside the ordinary observation budget', async () => {
    const { fetchImpl, calls } = stubs();
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    // One CRM search plus one Resend read. The stored account id means no identity call.
    expect(result.callsMade).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

describe('a proof that cannot prove things', () => {
  it('CONN-205 reports "could not prove" rather than FAILED when the record is absent', async () => {
    const { fetchImpl } = stubs({ search: () => json({ total: 0, results: [] }) });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));

    expect(result.ran).toBe(true);
    // Absence becomes a failure only at a real deadline in a real run, never at proof time.
    expect(result.status).toBe('UNVERIFIED');
    expect(result.status).not.toBe('FAILED');
    expect(result.notProved.some((s) => s.rule_id === 'crm_record_exists' && s.blocking)).toBe(true);
  });

  it('CONN-206 reports "could not prove" when the provider was unreachable', async () => {
    const { fetchImpl } = stubs({ search: () => json({ status: 'error' }, 503) });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    expect(result.status).toBe('UNVERIFIED');
    expect(result.notProved.length).toBeGreaterThan(0);
    const crm = result.sources.find((s) => s.provider === 'hubspot');
    expect(crm?.gaps[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('CONN-207 gives every shortfall a sentence a customer can act on', async () => {
    const { fetchImpl } = stubs({ search: () => json({ total: 0, results: [] }) });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    for (const shortfall of result.notProved) {
      expect(shortfall.sentence.length).toBeGreaterThan(10);
      expect(shortfall.detail).toContain('We expected');
    }
  });

  it('CONN-208 reports an ambiguous match as unproven, never as a pass', async () => {
    const { fetchImpl } = stubs({
      search: () => json({ total: 2, results: [contact(), contact({ id: '33452' })] }),
    });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    expect(result.status).toBe('UNVERIFIED');
    expect(result.notProved.some((s) => s.reason_code === 'RECORD_AMBIGUOUS')).toBe(true);
  });

  it('CONN-209 still reports FAILED for a genuine contradiction, which needs no deadline', async () => {
    const { fetchImpl } = stubs({ resend: () => json(email({ last_event: 'bounced' })) });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    expect(result.status).toBe('FAILED');
    expect(result.summary).toContain('real finding');
  });

  it('CONN-210 fails a proof whose record belongs to a different account, and says which', async () => {
    const { fetchImpl } = stubs({
      tokenInfo: () => json({ hubId: Number(FOREIGN_PORTAL), scopes: ['crm.objects.contacts.read'] }),
    });
    const result = await runProof(
      proofInput({
        crm: { ...crmSource, connection: { ...crmSource.connection, reverify_account: true } },
        runtime: { fetchImpl, sleep: noSleep },
      }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.notProved.some((s) => s.reason_code === 'RECORD_WRONG_ACCOUNT')).toBe(true);
    const crm = result.sources.find((s) => s.provider === 'hubspot');
    expect(crm?.accountId).toBe(FOREIGN_PORTAL);
    expect(crm?.accountMatchedConnection).toBe(false);
  });

  it('CONN-211 refuses to call an accepted-but-not-delivered email a proof of delivery', async () => {
    const { fetchImpl } = stubs({ resend: () => json(email({ last_event: 'sent' })) });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    expect(result.status).not.toBe('VERIFIED');
    expect(result.notProved.some((s) => s.rule_id === 'email_delivered')).toBe(true);
  });

  it('CONN-212 never reports an empty notProved alongside a non-verified status', async () => {
    for (const stub of [
      { search: () => json({ total: 0, results: [] }) },
      { search: () => json({ status: 'error' }, 500) },
      { resend: () => json(email({ last_event: 'opened' })) },
    ]) {
      const { fetchImpl } = stubs(stub);
      const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
      if (result.status !== 'VERIFIED') {
        expect(result.notProved.length, JSON.stringify(stub)).toBeGreaterThan(0);
      }
    }
  });

  it('CONN-213 never leaks a credential into a proof result', async () => {
    const { fetchImpl } = stubs({ search: () => json({ status: 'error' }, 500) });
    const result = await runProof(proofInput({ runtime: { fetchImpl, sleep: noSleep } }));
    const text = JSON.stringify(result);
    expect(text).not.toContain(HUBSPOT_TOKEN);
    expect(text).not.toContain(RESEND_TOKEN);
  });
});
