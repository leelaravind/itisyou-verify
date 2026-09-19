/**
 * CONN-051 — the one authorised real read against Resend.
 *
 * **This is the only test in the repository permitted to contact Resend, and it does not
 * run today.** No Resend credential exists, so it skips.
 *
 * Why it exists: Resend's event vocabulary is the single mapping in this product most
 * likely to drift. A stub can never notice a renamed event type, because we wrote the
 * stub from the same documentation we wrote the mapping from. This case is the only thing
 * that could catch `email.delivery_delayed` quietly becoming something else.
 *
 * What it does when it runs: one `GET /emails/{id}` for one message we sent ourselves,
 * and one assertion — that whatever `last_event` comes back maps to a member of the frozen
 * `EMAIL_STATUS` vocabulary, and does not silently become `delivered`.
 *
 * What it refuses to do: run without explicit opt-in, run outside a test account, run in
 * anything resembling production, or send an email. It reads one message that a human
 * already sent; it does not create one.
 *
 * To run it, once a Resend test account exists:
 *
 *   VERIFY_PROVIDER_PROOF=1 \
 *   VERIFY_PROVIDER_ACCOUNT_KIND=test \
 *   VERIFY_RESEND_TEST_TOKEN=re_… \
 *   VERIFY_RESEND_TEST_MESSAGE_ID=<id of one message already sent from that account> \
 *   npx vitest run tests/integration/connectors/resend-observation.test.ts
 *
 * As with CONN-050, the lead must also allow `api.resend.com` in `tests/setup.ts` for that
 * run. That is deliberately a separate, visible act.
 */
import { describe, expect, it } from 'vitest';
import { EMAIL_STATUS } from '@verify/contracts';
import { ResendConnector, mapResendLastEvent } from '@verify/connectors';

const env = (name: string): string => process.env[name] ?? '';

function productionSmell(): string | null {
  if (env('NODE_ENV') === 'production') return 'NODE_ENV is production';
  if (env('STRIPE_MODE') === 'live') return 'STRIPE_MODE is live';
  if (env('CF_ENV') === 'production' || env('ENVIRONMENT') === 'production') return 'the environment is production';
  if (env('VERIFY_PROVIDER_ACCOUNT_KIND') !== 'test') {
    return 'VERIFY_PROVIDER_ACCOUNT_KIND is not "test" — you must affirm this is a test account';
  }
  return null;
}

const TOKEN = env('VERIFY_RESEND_TEST_TOKEN');
const MESSAGE_ID = env('VERIFY_RESEND_TEST_MESSAGE_ID');

const optedIn = env('VERIFY_PROVIDER_PROOF') === '1';
const haveCredential = TOKEN !== '' && MESSAGE_ID !== '';
const blockedBy = productionSmell();
const enabled = optedIn && haveCredential && blockedBy === null;

const skipReason = !optedIn
  ? 'VERIFY_PROVIDER_PROOF is not 1 — a real provider read must be asked for explicitly'
  : !haveCredential
    ? 'no Resend test credential is configured'
    : (blockedBy ?? '');

function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Blocked outbound fetch')) {
    return 'The global test fetch guard blocked this call. For an authorised provider read the lead must add api.resend.com to ALLOWED_HOSTS in tests/setup.ts for that run.';
  }
  return message;
}

describe('CONN-051 provider-backed: a real Resend read', () => {
  it.runIf(!enabled)(`CONN-051 is skipped, and says why: ${skipReason || 'disabled'}`, () => {
    expect(enabled).toBe(false);
    expect(skipReason).not.toBe('');
  });

  it.runIf(enabled)(
    'CONN-051 a real Resend read returns a status the adapter maps into EMAIL_STATUS',
    async () => {
      const connector = new ResendConnector({ timeoutMs: 15_000 });
      const credentials = { accessToken: TOKEN };

      let result;
      try {
        result = await connector.fetchEvidence({
          credentials,
          connection: { provider: 'resend', account_id: null },
          locator: { message_id: MESSAGE_ID },
          occurredAt: new Date(),
          now: new Date(),
        });
      } catch (error) {
        throw new Error(explain(error));
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

      // And the mapping table itself still refuses to invent a delivery for a name it
      // does not know — the drift this case is here to catch.
      expect(mapResendLastEvent('a_status_resend_has_never_published')).toBeNull();
    },
    30_000,
  );
});
