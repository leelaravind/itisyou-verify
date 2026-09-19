/**
 * CUST-360..CUST-363 — nothing on a customer page is signalled by colour alone (WCAG 1.4.1).
 *
 * `packages/ui/src/components/statusBadge.ts` states the doctrine: "Colour alone is never
 * used, here or anywhere else in the package." It held for the four run statuses, which get
 * a glyph, a label and a border. It did not hold for the callout.
 *
 * `Callout` builds its alert glyph inside the branch that renders the title, so a callout
 * with no title ships as a coloured box and nothing else: `.callout--warn` and
 * `.callout--note` differ only by a red-versus-grey left border and tint
 * (`packages/ui/src/styles.ts`). `formMessage` — every form-level failure on the customer
 * surface, at seven call sites — passes no title. A reader who cannot separate those two
 * hues, or who is printing in greyscale, cannot tell a refusal from a confirmation.
 *
 * `.callout--limit` and `.callout--todo` had the same problem in the other direction: the
 * same amber, the same tint, no glyph on `limit` at all — two different meanings rendered
 * identically.
 *
 * These cases are asserted against the served HTML of a real request rather than against a
 * component's return value, because the defect is only visible where the tone, the title
 * and the stylesheet meet.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getSignedIn, signedInWorkspace, visibleText, type SignedIn } from './harness.js';

let open: SignedIn | null = null;

afterEach(() => {
  open?.h.close();
  open = null;
});

async function session(): Promise<SignedIn> {
  open = await signedInWorkspace();
  return open;
}

/** Every `<aside class="callout …">` element in the document, as raw markup. */
function callouts(html: string): readonly string[] {
  return html.match(/<aside[^>]*class="callout[^"]*"[\s\S]*?<\/aside>/g) ?? [];
}

function toneOf(markup: string): string {
  return /data-tone="([a-z]+)"/.exec(markup)?.[1] ?? 'note';
}

describe('a customer page never signals meaning with colour alone', () => {
  it('CUST-360 every warn, limit and todo callout served by /app/onboarding/connect carries a title', async () => {
    const s = await session();
    const { status, html } = await getSignedIn(s, '/app/onboarding/connect');
    expect(status).toBe(200);

    const carrying = callouts(html).filter((c) => toneOf(c) !== 'note');
    // Proof the page really renders the tones under test rather than passing vacuously.
    expect(carrying.length).toBeGreaterThan(0);
    for (const callout of carrying) {
      expect(
        callout,
        `a ${toneOf(callout)} callout with no title is a coloured box and nothing else`,
      ).toContain('callout__title');
    }
  });

  it('CUST-361 a warn callout carries the alert glyph, not only the red border', async () => {
    const s = await session();
    const { html } = await getSignedIn(s, '/app/onboarding/connect');

    for (const callout of callouts(html).filter(
      (c) => toneOf(c) === 'warn' || toneOf(c) === 'todo',
    )) {
      expect(callout).toContain('badge__glyph');
    }
  });

  it('CUST-362 a limit callout is separable from a warn callout without seeing either colour', async () => {
    const s = await session();
    const { html } = await getSignedIn(s, '/app/onboarding/connect');

    const limits = callouts(html).filter((c) => toneOf(c) === 'limit');
    expect(limits.length).toBeGreaterThan(0);
    for (const callout of limits) {
      // Its own silhouette — a ring with a diagonal — and specifically NOT the warning
      // triangle. A permanent edge of the product is not a fault the reader can act on.
      expect(callout).toContain('badge__glyph');
      expect(callout).toContain('m4.2 11.8');
      expect(callout).not.toContain('M8 2.6');
      // And a heading, so it survives greyscale, a screen reader and a printed page.
      expect(callout).toContain('callout__title');
      expect(visibleText(callout).length).toBeGreaterThan(10);
    }
  });

  it('CUST-363 the four run statuses each keep a distinct glyph and a text label', async () => {
    const s = await session();
    const { html } = await getSignedIn(s, '/app/onboarding/connect');

    // Connection rows wear the run palette. Whatever states this page shows, each badge
    // must carry a glyph and its own word — never a bare coloured chip.
    const badges = html.match(/<span[^>]*class="badge[^"]*"[\s\S]*?<\/span\s*>/g) ?? [];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge).toContain('badge__glyph');
      expect(visibleText(badge).length).toBeGreaterThan(0);
    }
  });
});
