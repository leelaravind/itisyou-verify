/**
 * CUST-109..CUST-120 — the connect card.
 *
 * The cases that matter here are about what the page refuses to soften. A04 wrote the
 * permission notice next to the code that uses the credential; the only way that honesty
 * survives is if it cannot be demoted to a footnote, hidden behind a disclosure control, or
 * quietly outranked by a reassuring tick.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@verify/ui';
import { setupGuide } from '@verify/connectors';
import { ConnectPage } from '../../../apps/app/src/routes/app/onboardingPages.js';
import { ConnectionsPage } from '../../../apps/app/src/routes/app/accountPages.js';
import { CONNECTION_PRESENTATION } from '../../../apps/app/src/routes/app/chrome.js';
import {
  SyntheticCustomerDataPort,
  resetSyntheticState,
} from '../../../apps/app/src/routes/app/syntheticPort.js';
import type { ConnectionView } from '../../../apps/app/src/routes/app/port.js';

/**
 * The visible text of a rendered page: tags removed, the five escaped characters decoded,
 * whitespace collapsed. Prose assertions run against this rather than against raw markup,
 * because a sentence that wraps across lines in the source is still one sentence to a
 * reader — and because a quotation mark in the copy arrives as `&quot;`, which is the
 * escaping working rather than the copy being wrong.
 */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    provider: 'resend',
    displayName: 'Resend',
    status: 'not_connected',
    accountLabel: null,
    lastCheckedAt: null,
    problem: null,
    nextStep: null,
    ...overrides,
  };
}

async function renderConnect(
  overrides: Partial<ConnectionView> = {},
  canSubmit = true,
): Promise<string> {
  return render(
    ConnectPage({
      connections: [connection(overrides)],
      csrfToken: 'token',
      submitted: null,
      canSubmitCredentials: canSubmit,
    }),
  );
}

describe('the connect card', () => {
  it('CUST-109 the Resend permission notice appears in full, above the paste box, not in a footnote', async () => {
    const markup = await renderConnect();
    const guide = setupGuide('resend');

    // Verbatim, not paraphrased. A04 owns whether it is true; this page only renders it.
    expect(text(markup)).toContain(collapse(guide.permissionNotice.headline));
    expect(text(markup)).toContain(collapse(guide.permissionNotice.body));

    // Above the paste box, measured by position rather than asserted by intent.
    const noticeAt = markup.indexOf('data-permission-notice="resend"');
    const pasteAt = markup.indexOf('id="f-access_token"');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(pasteAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(pasteAt);
  });

  it('CUST-110 the permission notice is not behind a disclosure control and is not visually demoted', async () => {
    const markup = await renderConnect();
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<summary');
    // `warn`, because Resend's key is broader than we need. Not `note`, which would let it
    // read as ordinary small print.
    expect(setupGuide('resend').permissionNotice.broaderThanNeeded).toBe(true);
    expect(markup).toContain('callout--warn');
    expect(markup).not.toMatch(/data-permission-notice="resend"[^>]*class="[^"]*micro/);
  });

  it('CUST-111 it says plainly what the key could do, and does not pretend it is narrower', async () => {
    const markup = await renderConnect();
    expect(text(markup)).toContain('Resend has no read-only key');
    expect(text(markup)).toContain('send mail from your domain');
    expect(text(markup)).toContain('delete resources in your Resend account');
    // And the counterweight, which is also true, is present rather than replacing the above.
    expect(text(markup)).toContain('the connector has no send path in it at all');
  });

  it('CUST-112 the webhook-only alternative is offered, with its cost stated', async () => {
    const markup = await renderConnect();
    expect(text(markup)).toContain('connect the webhook only and leave the key blank');
    expect(text(markup)).toContain('stays unverified');
    // The signing secret is genuinely optional, and the field says so.
    const secretField = setupGuide('resend').fields.find((f) => f.name === 'webhook_secret');
    expect(secretField?.required).toBe(false);
    expect(markup).toMatch(/for="f-webhook_secret"[\s\S]{0,120}optional/);
  });

  it('CUST-113 "testing" reads as unfinished and never wears a tick', async () => {
    expect(CONNECTION_PRESENTATION.testing.label).toBe('Not finished yet');
    expect(CONNECTION_PRESENTATION.testing.status).toBe('PENDING');
    expect(CONNECTION_PRESENTATION.authorising.status).toBe('PENDING');
    expect(CONNECTION_PRESENTATION.ready.status).toBe('VERIFIED');

    const markup = await renderConnect({ status: 'testing' });
    expect(text(markup)).toContain('Not finished yet');
    expect(markup).toContain('badge--pending');
    expect(markup).not.toContain('badge--verified');
    expect(text(markup)).toContain('that is not the same as it working');
  });

  it('CUST-114 the same honesty holds on the connections page, not just during onboarding', async () => {
    const markup = await render(
      ConnectionsPage({
        connections: [
          connection({ status: 'testing' }),
          connection({ provider: 'hubspot', displayName: 'HubSpot', status: 'ready' }),
        ],
        csrfToken: 'token',
        submitted: null,
      }),
    );
    expect(text(markup)).toContain('Not finished yet');
    expect(markup).toContain('badge--pending');
    expect(text(markup)).toContain('Ready');
  });

  it('CUST-115 a credential field is a password input and is never echoed back', async () => {
    const markup = await renderConnect();
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autocomplete="off"');
    // No `value` attribute on either secret field — not the submitted one, not even masked.
    expect(markup).not.toMatch(/id="f-access_token"[^>]*value=/);
    expect(markup).not.toMatch(/id="f-webhook_secret"[^>]*value=/);
  });

  it('CUST-116 a rejected credential reports that nothing was stored, beside the field it concerns', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const result = await port.submitConnectionCredentials({
      provider: 'resend',
      accessToken: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors['access_token']).toContain('starts re_');
    expect(result.message).toContain('nothing was stored');

    const markup = await render(
      ConnectPage({
        connections: [connection()],
        csrfToken: 'token',
        submitted: result,
        submittedProvider: 'resend',
        canSubmitCredentials: true,
      }),
    );
    expect(markup).toContain('id="f-access_token-error"');
    expect(markup).toContain('aria-describedby="f-access_token-hint f-access_token-error"');
  });

  it('CUST-117 a well-shaped credential is still not called working, because nothing checked it', async () => {
    resetSyntheticState();
    const port = new SyntheticCustomerDataPort();
    const result = await port.submitConnectionCredentials({
      provider: 'resend',
      accessToken: 're_abcdefghijklmnop',
    });
    // Shape is fine, so no field error — but `ok` stays false, because storing is not validating.
    expect(result.fieldErrors).toEqual({});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('nothing was stored');
    expect(result.message).toContain('not going to mark the connection working on our own say-so');

    const after = (await port.connections()).find((c) => c.provider === 'resend');
    expect(after?.status).toBe('testing');
    expect(after?.problem).toContain('not finished');
  });

  it('CUST-118 HubSpot’s notice says the scope is the narrowest available, and is not dressed as a warning', async () => {
    const markup = await render(
      ConnectPage({
        connections: [
          connection({ provider: 'hubspot', displayName: 'HubSpot', status: 'not_connected' }),
        ],
        csrfToken: 'token',
        submitted: null,
        canSubmitCredentials: true,
      }),
    );
    const guide = setupGuide('hubspot');
    expect(guide.permissionNotice.broaderThanNeeded).toBe(false);
    expect(markup).toContain(guide.permissionNotice.headline);
    expect(text(markup)).toContain('It cannot create, change or delete anything in your CRM');
    expect(markup).not.toContain('callout--warn');
  });

  it('CUST-119 every setup instruction, and all three scope lists, reach the page', async () => {
    const markup = await renderConnect();
    const guide = setupGuide('resend');
    for (const instruction of guide.instructions) {
      expect(text(markup), instruction.text).toContain(collapse(instruction.text));
    }
    for (const line of [...guide.weRead, ...guide.weNeverDo, ...guide.cannotProve]) {
      expect(text(markup), line).toContain(collapse(line));
    }
    expect(text(markup)).toContain(collapse(guide.whatHappensNext));
  });

  it('CUST-120 when the port cannot check a credential, the page says so instead of offering a live-looking button', async () => {
    const markup = await renderConnect({}, false);
    expect(text(markup)).toContain('We cannot check a credential yet');
    expect(text(markup)).toContain('Do not paste a real key until this notice is gone');
    expect(markup).toContain('disabled');
  });
});
