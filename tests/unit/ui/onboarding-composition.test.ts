/**
 * CUST-951..CUST-953 — the composition of the two onboarding steps recomposed to the
 * approved designs on 20 September 2026: the connect step, against the connections
 * reference (the one approved screen that draws a credential paste flow), and the
 * compatibility step, against the compatibility / proof / checkout-review reference.
 *
 * As with CUST-901..908 these cases pin the arrangement — which block precedes which, what
 * sits in the wider column, that the count strip wears the same label and badge as the
 * cards it counts — by reading the rendered bytes and the served stylesheet. They pin just
 * as hard what must NOT have changed: every paste form still posts to the same action with
 * the same token and the same hidden provider, the permission notice still precedes the
 * paste box, the compatibility control is still the inert element and not a button, and
 * no word from either reference arrived with the layout. The connections reference carries
 * four providers, a "sandbox" banner, an encryption architecture and an audit ledger; the
 * compatibility reference a price, VAT, a card on file and an "unconditional" refund. None
 * of that is ours.
 */
import { describe, expect, it } from 'vitest';
import { CSS, render } from '@verify/ui';
import { setupGuide } from '@verify/connectors';
import {
  CompatibilityPage,
  ConnectPage,
} from '../../../apps/app/src/routes/app/onboardingPages.js';
import { CONNECTION_PRESENTATION } from '../../../apps/app/src/routes/app/chrome.js';
import {
  SyntheticCustomerDataPort,
  resetSyntheticState,
} from '../../../apps/app/src/routes/app/syntheticPort.js';
import type {
  ConnectionView,
  ConnectorCompatibility,
} from '../../../apps/app/src/routes/app/port.js';

const CSRF = 'test-csrf-token';

function text(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

/** The declarations of one rule in the collapsed sheet, or an empty string if it is absent. */
function declarationsFor(selector: string): string {
  const at = CSS.indexOf(`${selector}{`);
  if (at === -1) return '';
  const open = at + selector.length + 1;
  return CSS.slice(open, CSS.indexOf('}', open));
}

function port(): SyntheticCustomerDataPort {
  resetSyntheticState();
  return new SyntheticCustomerDataPort();
}

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    provider: 'hubspot',
    displayName: 'HubSpot',
    status: 'not_connected',
    accountLabel: null,
    lastCheckedAt: null,
    problem: null,
    nextStep: null,
    ...overrides,
  };
}

const resend = (overrides: Partial<ConnectionView> = {}): ConnectionView =>
  connection({ provider: 'resend', displayName: 'Resend', ...overrides });

async function connect(connections: readonly ConnectionView[]): Promise<string> {
  return render(ConnectPage({ connections, csrfToken: CSRF, submitted: null, canSubmitCredentials: true }));
}

/**
 * Phrases the two reference screens carry and these pages must never render. Layout only.
 * Provider names other than our two are on the list; our own two are not, because the
 * pages name them truthfully.
 */
// claim-scan:allow these are the strings the cases below assert are ABSENT from the rendered pages
const REFERENCE_COPY_THAT_MUST_NOT_ARRIVE = [
  'Postmark',
  'Attio',
  'SendGrid',
  'Acme',
  'ws_984e1',
  'SANDBOX EVALUATION',
  'Probe',
  'Isolation',
  'AES-256',
  'HMAC-SHA256',
  'Settling',
  'Telemetry',
  'Ledger',
  'Forensic',
  'Remediation',
  'Pre-Flight',
  'VAT',
  'HMRC',
  'Unconditional',
  'Zero-Trust',
  'SOC2',
  'Deterministic',
  'Attestation',
  'Visa',
  'Immutable',
];

describe('the connect step composition', () => {
  it('CUST-951 the notice precedes the cards, the cards sit two abreast from desktop width with the readback pane under each head and the permission notice still above the paste box, and the closing band counts the connections by the label and badge each card wears beside the way onward', async () => {
    const connections = [connection(), resend({ status: 'testing' })];
    const markup = await connect(connections);

    const notice = markup.indexOf('You can carry on setting up while a connection is unfinished');
    const cards = markup.indexOf('<div class="split" data-connect-cards>');
    const band = markup.indexOf('<div class="cta-band">');
    expect(notice).toBeGreaterThan(-1);
    expect(cards).toBeGreaterThan(notice);
    expect(band).toBeGreaterThan(cards);
    expect(count(markup, 'data-connect-card=')).toBe(connections.length);
    // Two abreast only from desktop width. Each card carries a form, so a tablet stacks
    // them rather than squeezing a password field into a third of the page.
    expect(declarationsFor('.split')).not.toContain('grid-template-columns');
    expect(CSS).toContain('@media (min-width:64rem){.split{grid-template-columns:repeat(2,minmax(0,1fr))}}');

    // Inside each card, in document order: the head, the readback pane, the permission
    // notice, the paste box, the two boundary lists. Every line of all three lists is
    // present, in the pane or in the lists, and the form kept its action, token and provider.
    for (const c of connections) {
      const guide = setupGuide(c.provider);
      const card = markup.indexOf(`data-connect-card="${c.provider}"`);
      const slice = markup.slice(card, markup.indexOf('</section>', card));
      const pane = slice.indexOf(`<div class="pane" data-connect-reads="${c.provider}">`);
      const permission = slice.indexOf(`data-permission-notice="${c.provider}"`);
      const form = slice.indexOf('<form method="post" action="/app/onboarding/connect"');
      const boundaries = slice.indexOf(`data-connect-boundaries="${c.provider}"`);
      for (const at of [pane, permission, form, boundaries]) expect(at, c.provider).toBeGreaterThan(-1);
      expect(pane, c.provider).toBeLessThan(permission);
      expect(permission, c.provider).toBeLessThan(form);
      expect(form, c.provider).toBeLessThan(boundaries);
      for (const line of guide.weRead) expect(text(slice.slice(pane, permission)), line).toContain(collapse(line));
      for (const line of [...guide.weNeverDo, ...guide.cannotProve]) {
        expect(text(slice.slice(boundaries)), line).toContain(collapse(line));
      }
      const formSlice = slice.slice(form, slice.indexOf('</form>', form));
      expect(formSlice, c.provider).toContain(`name="csrf_token" value="${CSRF}"`);
      expect(formSlice, c.provider).toContain(`<input type="hidden" name="provider" value="${c.provider}" />`);
      expect(formSlice, c.provider).toContain('<input type="hidden" name="intent" value="credentials" />');
      expect(formSlice, c.provider).toMatch(/<button[^>]*type="submit"/);
    }

    // The band: the tally, then the way onward. One entry per label the cards wear, each
    // wearing the card's badge — never a label no card carries, never a tick for a
    // connection that is not finished.
    const bandSlice = markup.slice(band);
    const tally = bandSlice.indexOf('<ul class="tally" aria-label="Connections by state">');
    const onward = bandSlice.indexOf('href="/app/onboarding/mapping"');
    expect(tally).toBeGreaterThan(-1);
    expect(onward).toBeGreaterThan(tally);
    const tallySlice = bandSlice.slice(tally, bandSlice.indexOf('</ul>', tally));
    expect(tallySlice).toContain(`data-connection-tally="${CONNECTION_PRESENTATION.not_connected.label}"`);
    expect(tallySlice).toContain(`data-connection-tally="${CONNECTION_PRESENTATION.testing.label}"`);
    expect(count(tallySlice, '<span class="tally__count">1</span>')).toBe(2);
    expect(tallySlice).toContain('badge--unverified');
    expect(tallySlice).toContain('badge--pending');
    expect(tallySlice).not.toContain('badge--verified');
    // Not every connection is ready, so the way onward is not the primary control.
    expect(bandSlice).not.toContain('btn--primary');

    // Every connection ready: no notice, and the way onward is primary.
    const ready = await connect([connection({ status: 'ready' }), resend({ status: 'ready' })]);
    expect(ready).not.toContain('You can carry on setting up while a connection is unfinished');
    expect(ready.slice(ready.indexOf('<div class="cta-band">'))).toContain('btn--primary');

    // No connections: the honest empty state, no cards, no tally, the notice still shown
    // (zero connections is the furthest thing from ready), and the way onward not primary.
    const empty = await connect([]);
    expect(empty).not.toContain('data-connect-cards');
    expect(empty).not.toContain('aria-label="Connections by state"');
    expect(empty).toContain('No providers to connect');
    expect(empty).toContain('You can carry on setting up while a connection is unfinished');
    expect(empty).toContain('href="/app/onboarding/mapping"');
    expect(empty).not.toContain('btn--primary');
  });
});

describe('the compatibility step composition', () => {
  it('CUST-952 the head sits beside a count of providers by the label each card wears, the notice precedes the grid, the provider cards stack in the wider column with their facts in a pane, and the commitment and the inert control take the narrower one — read after every card', async () => {
    const p = port();
    const entries = await p.connectorCompatibility();
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every((entry) => entry.supported)).toBe(true);
    const markup = await render(CompatibilityPage(entries));

    const head = markup.indexOf('<div class="section-head">');
    const tally = markup.indexOf('<ul class="tally" aria-label="Providers by state">', head);
    const notice = markup.indexOf('data-activation-notice', tally);
    const grid = markup.indexOf('<div class="grid grid-7-5">', notice);
    const providers = markup.indexOf('<div class="stack" data-compatibility-providers>', grid);
    const control = markup.indexOf('<div class="stack" data-compatibility-control>', providers);
    const commitment = markup.indexOf('>One more thing, and it is real work<', control);
    const unavailable = markup.indexOf('data-unavailable', commitment);
    const onward = markup.indexOf('href="/how-it-works"', unavailable);
    for (const at of [head, tally, notice, grid, providers, control, commitment, unavailable, onward]) {
      expect(at).toBeGreaterThan(-1);
    }
    // One column until desktop width, then seven parts to five.
    expect(CSS).toContain('@media (min-width:60rem){.grid-7-5{grid-template-columns:minmax(0,7fr) minmax(0,5fr);align-items:start}}');

    // One card per provider in the wider column, each with its facts in a pane, all of
    // them before the control column begins.
    const providersSlice = markup.slice(providers, control);
    expect(count(providersSlice, '<div class="pane">')).toBe(entries.length);
    expect(count(providersSlice, 'class="card__title"')).toBe(entries.length);
    for (const entry of entries) {
      expect(text(providersSlice)).toContain(entry.displayName);
      expect(text(providersSlice)).toContain(entry.purpose);
      for (const requirement of entry.requirements) expect(text(providersSlice)).toContain(requirement);
    }

    // The tally names only labels that occur, wearing the badge the cards wear.
    const tallySlice = markup.slice(tally, markup.indexOf('</ul>', tally));
    expect(tallySlice).toContain('data-compatibility-tally="Supported"');
    expect(tallySlice).toContain(`<span class="tally__count">${String(entries.length)}</span>`);
    expect(tallySlice).toContain('badge--verified');
    expect(tallySlice).not.toContain('data-compatibility-tally="Not supported"');
    expect(tallySlice).not.toContain('badge--failed');

    // The control is the same inert element as before the layout moved: nothing a form
    // could submit, nothing focusable, on the whole page.
    expect(markup).not.toMatch(/<form[\s>]/);
    expect(markup).not.toMatch(/<button[\s>]/);
    expect(text(markup.slice(unavailable))).toContain('These all apply — continue');

    // One provider unsupported: the warn callout precedes the grid, its card wears the
    // label, and the tally counts it under that label with the failed badge — one each.
    const mixed: readonly ConnectorCompatibility[] = [
      entries[0]!,
      { ...entries[1]!, supported: false, unsupportedReason: 'A reason the port gave.' },
    ];
    const blocked = await render(CompatibilityPage(mixed));
    const warn = blocked.indexOf('>Something here is not supported<');
    expect(warn).toBeGreaterThan(-1);
    expect(warn).toBeLessThan(blocked.indexOf('<div class="grid grid-7-5">'));
    expect(text(blocked)).toContain('A reason the port gave.');
    const mixedTally = blocked.slice(
      blocked.indexOf('aria-label="Providers by state"'),
      blocked.indexOf('</ul>', blocked.indexOf('aria-label="Providers by state"')),
    );
    expect(mixedTally).toContain('data-compatibility-tally="Supported"');
    expect(mixedTally).toContain('data-compatibility-tally="Not supported"');
    expect(mixedTally).toContain('badge--failed');
    expect(count(mixedTally, '<span class="tally__count">1</span>')).toBe(2);

    // No providers: no tally and no cards, but the notice and the control still stand.
    const none = await render(CompatibilityPage([]));
    expect(none).not.toContain('aria-label="Providers by state"');
    expect(none).not.toContain('<div class="pane">');
    expect(none).toContain('data-activation-notice');
    expect(none).toContain('data-unavailable');
  });
});

describe('the reference copy stays in the reference', () => {
  it('CUST-953 neither recomposed onboarding step emits a style attribute, a phrase from its reference, a pound figure, a trial or a certification', async () => {
    const p = port();
    const pages: readonly (readonly [string, string])[] = [
      [
        '/app/onboarding/connect',
        await render(
          ConnectPage({
            connections: await p.connections(),
            csrfToken: CSRF,
            submitted: null,
            canSubmitCredentials: true,
          }),
        ),
      ],
      ['/app/onboarding/compatibility', await render(CompatibilityPage(await p.connectorCompatibility()))],
    ];
    for (const [path, markup] of pages) {
      // style-src-attr 'none': a style attribute here renders as nothing, silently.
      expect(markup, path).not.toMatch(/\sstyle=/);
      const body = text(markup);
      for (const phrase of REFERENCE_COPY_THAT_MUST_NOT_ARRIVE) {
        expect(body, `${path} carries "${phrase}"`).not.toContain(phrase);
      }
      // Neither step states a price — the one real price is on the review step — so no
      // pound figure at all may arrive here, not even the right one.
      expect(body, path).not.toMatch(/£\d/);
      expect(body, path).not.toMatch(/\btrial\b/i);
      expect(body, path).not.toMatch(/per[- ]seat|per[- ]user/i);
      expect(body, path).not.toMatch(/\bSOC\s?2\b/i);
      expect(body, path).not.toMatch(/\b(guaranteed?|100%)\b/i);
    }
  });
});
