/**
 * The two authorised real provider reads — ledger cases `CONN-900` and `CONN-901`.
 *
 * **These are the only tests in the repository permitted to contact a provider, and
 * neither runs today.** No credential exists, so both skip. They are written now so that
 * the moment a credential appears they can be run in one command, and so the ledger
 * entries have something real to become.
 *
 * Why they exist: every other connector test drives a stub built from the provider's
 * published documentation. A stub proves our code handles the payload *we believe* the
 * provider sends. It cannot prove the provider sends it. Until these run, every claim
 * about reading records back is DESIGNED, NOT OBSERVED, and the launch material says
 * exactly that.
 *
 * To run them, once a HubSpot developer test account and a Resend test account exist:
 *
 *   VERIFY_PROVIDER_PROOF=1 \
 *   VERIFY_PROVIDER_ACCOUNT_KIND=test \
 *   VERIFY_HUBSPOT_TEST_TOKEN=... \
 *   VERIFY_HUBSPOT_TEST_PORTAL_ID=<developer test portal id> \
 *   VERIFY_HUBSPOT_TEST_CONTACT_ID=<id of the one seeded contact> \
 *   VERIFY_RESEND_TEST_TOKEN=... \
 *   VERIFY_RESEND_TEST_MESSAGE_ID=<id of one already-sent test message> \
 *   npx vitest run tests/integration/connectors/live-smoke.test.ts
 *
 * `tests/setup.ts` blocks every outbound fetch and its host allowlist is empty. Running
 * these for real also needs the lead to add `api.hubapi.com` and `api.resend.com` to it
 * for that run — deliberately a separate, visible act, owned by the lead and not by this
 * file. It should not be possible to contact a provider from the test suite by accident.
 *
 * Note on ids: `CONN-900` and `CONN-901` appear **only** on the tests that make a real
 * call. The guard cases below carry their own ids, so no results artefact can ever record
 * a provider-backed id as passing without a provider having been contacted.
 */
import { describe, expect, it } from 'vitest';
import { EMAIL_STATUS } from '@verify/contracts';
import { HubSpotConnector, ResendConnector, mapResendLastEvent } from '@verify/connectors';

const env = (name: string): string => process.env[name] ?? '';

/** Anything that smells of production. Any one of these blocks the run outright. */
function productionSmell(): string | null {
  if (env('NODE_ENV') === 'production') return 'NODE_ENV is production';
  if (env('STRIPE_MODE') === 'live') return 'STRIPE_MODE is live';
  if (env('CF_ENV') === 'production' || env('ENVIRONMENT') === 'production') {
    return 'the environment is marked production';
  }
  if (env('VERIFY_PROVIDER_ACCOUNT_KIND') !== 'test') {
    return 'VERIFY_PROVIDER_ACCOUNT_KIND is not "test" — you must affirm this is a developer test account';
  }
  return null;
}

const OPTED_IN = env('VERIFY_PROVIDER_PROOF') === '1';
const BLOCKED_BY = productionSmell();

const HUBSPOT_TOKEN = env('VERIFY_HUBSPOT_TEST_TOKEN');
const HUBSPOT_PORTAL = env('VERIFY_HUBSPOT_TEST_PORTAL_ID');
const HUBSPOT_CONTACT = env('VERIFY_HUBSPOT_TEST_CONTACT_ID');
const RESEND_TOKEN = env('VERIFY_RESEND_TEST_TOKEN');
const RESEND_MESSAGE = env('VERIFY_RESEND_TEST_MESSAGE_ID');

const HUBSPOT_READY = HUBSPOT_TOKEN !== '' && HUBSPOT_PORTAL !== '' && HUBSPOT_CONTACT !== '';
const RESEND_READY = RESEND_TOKEN !== '' && RESEND_MESSAGE !== '';

const HUBSPOT_ENABLED = OPTED_IN && HUBSPOT_READY && BLOCKED_BY === null;
const RESEND_ENABLED = OPTED_IN && RESEND_READY && BLOCKED_BY === null;

function reasonFor(credentialPresent: boolean, provider: string): string {
  if (!OPTED_IN) return 'VERIFY_PROVIDER_PROOF is not 1 — a real provider read must be asked for explicitly';
  if (!credentialPresent) return `no ${provider} test credential is configured`;
  return BLOCKED_BY ?? '';
}

/**
 * Turn the global fetch guard's message into an instruction rather than a puzzle.
 * `tests/setup.ts` is the lead's file; this only explains what it did.
 */
function explain(error: unknown, host: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Blocked outbound fetch')) {
    return `The global test fetch guard blocked this call. For an authorised provider read the lead must add ${host} to ALLOWED_HOSTS in tests/setup.ts for that run.`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// The guards. These run every day; the reads below do not.
// ---------------------------------------------------------------------------

describe('the live-read guards', () => {
  it('CONN-214 refuses a real provider read unless it was explicitly asked for', () => {
    // The presence of a credential is not consent. Without the opt-in flag, neither read
    // is enabled no matter what else is set.
    expect(OPTED_IN).toBe(false);
    expect(HUBSPOT_ENABLED).toBe(false);
    expect(RESEND_ENABLED).toBe(false);
  });

  it('CONN-215 names why each real read is disabled, so a skip is never silent', () => {
    expect(reasonFor(HUBSPOT_READY, 'HubSpot')).not.toBe('');
    expect(reasonFor(RESEND_READY, 'Resend')).not.toBe('');
  });

  it('CONN-216 treats anything resembling production as a hard block', () => {
    for (const [name, value] of [
      ['NODE_ENV', 'production'],
      ['STRIPE_MODE', 'live'],
      ['ENVIRONMENT', 'production'],
    ] as const) {
      const previous = process.env[name];
      process.env[name] = value;
      process.env['VERIFY_PROVIDER_ACCOUNT_KIND'] = 'test';
      try {
        expect(productionSmell(), name).not.toBeNull();
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
        delete process.env['VERIFY_PROVIDER_ACCOUNT_KIND'];
      }
    }
  });

  it('CONN-217 requires an explicit affirmation that the account is a test account', () => {
    expect(productionSmell()).toContain('VERIFY_PROVIDER_ACCOUNT_KIND');
  });
});

// ---------------------------------------------------------------------------
// CONN-900 — HubSpot
// ---------------------------------------------------------------------------

describe('provider-backed: a real HubSpot read', () => {
  it.runIf(HUBSPOT_ENABLED)(
    'CONN-900 a real HubSpot read returns a contact whose shape matches CrmRecordEvidence',
    async () => {
      const connector = new HubSpotConnector({ timeoutMs: 15_000 });
      const credentials = { accessToken: HUBSPOT_TOKEN };

      // Call one: who does this token belong to? If it is not the portal we were told to
      // expect, stop here and read nothing at all.
      let validation;
      try {
        validation = await connector.validateConnection({
          credentials,
          connection: { provider: 'hubspot', account_id: null },
          now: new Date(),
        });
      } catch (error) {
        throw new Error(explain(error, 'api.hubapi.com'));
      }
      expect(validation.error, JSON.stringify(validation.error)).toBeNull();
      expect(
        validation.account_id,
        'the token belongs to a different HubSpot account than the one configured; refusing to read from it',
      ).toBe(HUBSPOT_PORTAL);

      // Call two, and only two: one contact, by id, with a named property list.
      const result = await connector.fetchEvidence({
        credentials,
        connection: {
          provider: 'hubspot',
          account_id: validation.account_id,
          correlation_property: 'email',
        },
        locator: { record_id: HUBSPOT_CONTACT },
        occurredAt: new Date(),
        now: new Date(),
      });

      expect(result.calls_made, 'a provider-backed case must make exactly one read').toBe(1);
      expect(result.gaps, JSON.stringify(result.gaps)).toHaveLength(0);
      expect(result.evidence).toHaveLength(1);

      const evidence = result.evidence[0];
      expect(evidence?.kind).toBe('crm_record');
      if (evidence === undefined || evidence.kind !== 'crm_record') return;

      // The assertions that matter: the live payload produced a valid CrmRecordEvidence,
      // attributed to the account the token actually belongs to.
      expect(evidence.provider).toBe('hubspot');
      expect(evidence.provider_account_id).toBe(HUBSPOT_PORTAL);
      expect(evidence.origin).toBe('provider_readback');
      expect(typeof evidence.record_id).toBe('string');
      expect(evidence.record_id.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(evidence.observed_at))).toBe(false);
      if (evidence.created_at !== null) {
        expect(Number.isNaN(Date.parse(evidence.created_at))).toBe(false);
      }
      for (const [key, value] of Object.entries(evidence.properties)) {
        expect(value === null || typeof value === 'string', `${key} was not a string or null`).toBe(true);
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// CONN-901 — Resend
// ---------------------------------------------------------------------------

describe('provider-backed: a real Resend read', () => {
  it.runIf(RESEND_ENABLED)(
    'CONN-901 a real Resend read returns a status the adapter maps into EMAIL_STATUS',
    async () => {
      const connector = new ResendConnector({ timeoutMs: 15_000 });

      let result;
      try {
        result = await connector.fetchEvidence({
          credentials: { accessToken: RESEND_TOKEN },
          connection: { provider: 'resend', account_id: null },
          locator: { message_id: RESEND_MESSAGE },
          occurredAt: new Date(),
          now: new Date(),
        });
      } catch (error) {
        throw new Error(explain(error, 'api.resend.com'));
      }

      expect(result.calls_made, 'a provider-backed case must make exactly one read').toBe(1);
      expect(result.gaps, JSON.stringify(result.gaps)).toHaveLength(0);
      expect(result.evidence).toHaveLength(1);

      const evidence = result.evidence[0];
      expect(evidence?.kind).toBe('email_event');
      if (evidence === undefined || evidence.kind !== 'email_event') return;

      // The assertion this case exists for: whatever Resend actually said, we mapped it
      // into the frozen vocabulary rather than crashing or guessing.
      expect(
        (EMAIL_STATUS as readonly string[]).includes(evidence.status),
        `Resend returned a status the adapter mapped to "${evidence.status}", which is not in EMAIL_STATUS`,
      ).toBe(true);
      expect(evidence.provider).toBe('resend');
      expect(evidence.origin).toBe('provider_readback');
      expect(evidence.provider_account_id.startsWith('resend-key-')).toBe(true);
      expect(Number.isNaN(Date.parse(evidence.occurred_at))).toBe(false);

      // And the mapping table still refuses to invent a delivery for a name it does not
      // know — the drift this case exists to catch.
      expect(mapResendLastEvent('a_status_resend_has_never_published')).toBeNull();
    },
    30_000,
  );
});
