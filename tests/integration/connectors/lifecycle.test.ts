/**
 * CONN-050 — the one authorised real read against HubSpot.
 *
 * **This is the only test in the repository permitted to contact HubSpot, and it does not
 * run today.** No HubSpot credential exists, so it skips. It is written now so that the
 * moment a credential appears it can be run in one command, and so that the ledger entry
 * `CONN-050` has something real to become.
 *
 * Why it exists at all: every other connector test drives a stub built from HubSpot's
 * published documentation. A stub proves our code handles the payload *we believe* HubSpot
 * sends. It cannot prove HubSpot sends it. Until this runs, every claim about reading a
 * record back is DESIGNED, NOT OBSERVED, and the launch material says exactly that.
 *
 * What it does when it runs:
 *   - One `validateConnection` call (token info) and one contact read. Two calls, capped.
 *   - Read only. There is no write path in the connector to invoke.
 *   - Asserts the live payload normalises into valid `CrmRecordEvidence`.
 *
 * What it refuses to do:
 *   - Run without an explicit opt-in. Presence of a token is not consent.
 *   - Run against a portal other than the one named in the environment. If the token turns
 *     out to belong to a different HubSpot account, the test fails and reads nothing more.
 *   - Run in anything that looks like production.
 *
 * To run it, once a HubSpot developer test account exists:
 *
 *   VERIFY_PROVIDER_PROOF=1 \
 *   VERIFY_PROVIDER_ACCOUNT_KIND=test \
 *   VERIFY_HUBSPOT_TEST_TOKEN=pat-… \
 *   VERIFY_HUBSPOT_TEST_PORTAL_ID=<the developer test portal id> \
 *   VERIFY_HUBSPOT_TEST_CONTACT_ID=<id of the one seeded contact> \
 *   npx vitest run tests/integration/connectors/lifecycle.test.ts
 *
 * `tests/setup.ts` blocks every outbound fetch. Running this for real also needs the lead
 * to add `api.hubapi.com` to its `ALLOWED_HOSTS` for that run — deliberately a separate,
 * visible act, owned by the lead and not by this file.
 */
import { describe, expect, it } from 'vitest';
import { EMAIL_STATUS } from '@verify/contracts';
import { HubSpotConnector } from '@verify/connectors';

const env = (name: string): string => process.env[name] ?? '';

/** Anything that smells of production. Any one of these blocks the run outright. */
function productionSmell(): string | null {
  if (env('NODE_ENV') === 'production') return 'NODE_ENV is production';
  if (env('STRIPE_MODE') === 'live') return 'STRIPE_MODE is live';
  if (env('CF_ENV') === 'production' || env('ENVIRONMENT') === 'production') return 'the environment is production';
  if (env('VERIFY_PROVIDER_ACCOUNT_KIND') !== 'test') {
    return 'VERIFY_PROVIDER_ACCOUNT_KIND is not "test" — you must affirm this is a developer test account';
  }
  return null;
}

const TOKEN = env('VERIFY_HUBSPOT_TEST_TOKEN');
const EXPECTED_PORTAL = env('VERIFY_HUBSPOT_TEST_PORTAL_ID');
const CONTACT_ID = env('VERIFY_HUBSPOT_TEST_CONTACT_ID');

const optedIn = env('VERIFY_PROVIDER_PROOF') === '1';
const haveCredential = TOKEN !== '' && EXPECTED_PORTAL !== '' && CONTACT_ID !== '';
const blockedBy = productionSmell();
const enabled = optedIn && haveCredential && blockedBy === null;

const skipReason = !optedIn
  ? 'VERIFY_PROVIDER_PROOF is not 1 — a real provider read must be asked for explicitly'
  : !haveCredential
    ? 'no HubSpot test credential is configured'
    : (blockedBy ?? '');

/**
 * Turn the global fetch guard's message into an instruction rather than a puzzle.
 * `tests/setup.ts` is the lead's file; this only explains what it did.
 */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Blocked outbound fetch')) {
    return 'The global test fetch guard blocked this call. For an authorised provider read the lead must add api.hubapi.com to ALLOWED_HOSTS in tests/setup.ts for that run.';
  }
  return message;
}

describe('CONN-050 provider-backed: a real HubSpot read', () => {
  it.runIf(!enabled)(`CONN-050 is skipped, and says why: ${skipReason || 'disabled'}`, () => {
    // A deliberately trivial assertion. Its job is to make the skip visible in the report
    // rather than silently absent, so nobody can mistake "not run" for "passed".
    expect(enabled).toBe(false);
    expect(skipReason).not.toBe('');
  });

  it.runIf(enabled)(
    'CONN-050 a real HubSpot read returns a contact whose shape matches CrmRecordEvidence',
    async () => {
      const connector = new HubSpotConnector({ timeoutMs: 15_000 });
      const credentials = { accessToken: TOKEN };

      // Call one: who does this token belong to? If it is not the portal we were told to
      // expect, stop here and read nothing.
      let validation;
      try {
        validation = await connector.validateConnection({
          credentials,
          connection: { provider: 'hubspot', account_id: null },
          now: new Date(),
        });
      } catch (error) {
        throw new Error(explain(error));
      }
      expect(validation.error, JSON.stringify(validation.error)).toBeNull();
      expect(
        validation.account_id,
        'the token belongs to a different HubSpot account than the one configured; refusing to read from it',
      ).toBe(EXPECTED_PORTAL);

      // Call two, and only two: one contact, by id, with a named property list.
      const result = await connector.fetchEvidence({
        credentials,
        connection: {
          provider: 'hubspot',
          account_id: validation.account_id,
          correlation_property: 'email',
        },
        locator: { record_id: CONTACT_ID },
        occurredAt: new Date(),
        now: new Date(),
      });

      expect(result.calls_made, 'a provider-backed case must make exactly one read').toBe(1);
      expect(result.gaps, JSON.stringify(result.gaps)).toHaveLength(0);
      expect(result.evidence).toHaveLength(1);

      const evidence = result.evidence[0];
      expect(evidence?.kind).toBe('crm_record');
      if (evidence === undefined || evidence.kind !== 'crm_record') return;

      // The assertions that actually matter: the live payload produced a valid
      // CrmRecordEvidence, attributed to the account the token belongs to.
      expect(evidence.provider).toBe('hubspot');
      expect(evidence.provider_account_id).toBe(EXPECTED_PORTAL);
      expect(evidence.origin).toBe('provider_readback');
      expect(typeof evidence.record_id).toBe('string');
      expect(evidence.record_id.length).toBeGreaterThan(0);
      expect(typeof evidence.observed_at).toBe('string');
      expect(Number.isNaN(Date.parse(evidence.observed_at))).toBe(false);
      if (evidence.created_at !== null) {
        expect(Number.isNaN(Date.parse(evidence.created_at))).toBe(false);
      }
      for (const [key, value] of Object.entries(evidence.properties)) {
        expect(typeof key).toBe('string');
        expect(value === null || typeof value === 'string', `${key} was not a string or null`).toBe(true);
      }
      // A sanity check that the frozen vocabulary is still the one we think it is.
      expect(EMAIL_STATUS.includes('delivered')).toBe(true);
    },
    30_000,
  );
});
