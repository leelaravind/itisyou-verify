/**
 * CUST-001..CUST-008 — the design system's own invariants.
 *
 * These are the properties a component test cannot check for you: that the palette clears
 * WCAG, that both themes are actually defined, and that the stylesheet has not quietly
 * grown past the size that justified inlining it.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CSS, CSS_BYTES, DARK, LIGHT, STATUS_PRESENTATION, THEME_SCRIPT, TYPE } from '@verify/ui';

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

describe('design tokens', () => {
  it('CUST-001 every status colour clears WCAG AA for body text on the page background, in both themes', () => {
    for (const palette of [LIGHT, DARK]) {
      for (const key of ['verified', 'failed', 'unverified', 'pending'] as const) {
        expect(contrast(palette[key], palette.paper), `${key} on paper`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrast(palette[key], palette.surface), `${key} on surface`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('CUST-002 every status colour clears AA against its own badge tint, so the label stays readable', () => {
    const pairs = [
      ['verified', 'tintVerified'],
      ['failed', 'tintFailed'],
      ['unverified', 'tintUnverified'],
      ['pending', 'tintPending'],
    ] as const;
    for (const palette of [LIGHT, DARK]) {
      for (const [colour, tint] of pairs) {
        expect(
          contrast(palette[colour], palette[tint]),
          `${colour} on ${tint}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('CUST-003 body, muted and faint text all clear AA, and a field border clears the 3:1 required of a control boundary', () => {
    for (const palette of [LIGHT, DARK]) {
      expect(contrast(palette.ink, palette.paper)).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.muted, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.faint, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.fieldBorder, palette.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.focus, palette.paper)).toBeGreaterThanOrEqual(3);
    }
  });

  it('CUST-004 the stylesheet is still small enough to justify inlining it', () => {
    const compressed = gzipSync(Buffer.from(CSS)).length;
    expect(CSS_BYTES).toBeGreaterThan(1000);
    // Past roughly 10KB compressed, a cached static file beats inlining on repeat views.
    expect(compressed).toBeLessThan(10_000);
  });

  it('CUST-005 both palettes stay reachable, and the approved one is what a visitor meets', () => {
    // This case used to assert that a dark PREFERENCE reached the dark palette. The
    // owner-approved Stitch system is dark, so that is now what the bare `:root` carries
    // and an OS preference no longer overrules it -- the first attempt let
    // `prefers-color-scheme: light` switch away, which meant most machines still met the
    // old look and the deployed page was indistinguishable from the one before the change.
    //
    // The property the case exists for is unchanged: neither palette may quietly become
    // unreachable. The light one is still emitted and still reachable by explicit choice.
    expect(CSS, 'the bare root must carry the approved palette').toContain(
      ':root{color-scheme:dark',
    );
    expect(CSS, 'an explicit dark override must exist').toContain(':root[data-theme="dark"]');
    expect(CSS, 'an explicit light override must exist').toContain(':root[data-theme="light"]');
    expect(CSS, 'the light palette must still be emitted').toContain(LIGHT.paper);
  });

  it('RESIL-183 the responsive ladder survives, so no token change can quietly drop mobile', () => {
    /*
     * The owner asked for the approved design across desktop AND mobile. The palette was
     * changed at the token layer, which restyles every screen at once and could in
     * principle have been done in a way that left the layout rules behind -- and nothing in
     * the suite was watching the breakpoints.
     *
     * These are the widths the stylesheet actually uses: a phone-only rule below 40rem, and
     * a ladder up through tablet to desktop. The case asserts they are all still emitted. It
     * does NOT assert the pages look like the two Stitch mobile references, which is a
     * separate piece of work recorded as outstanding in `docs/stitch-mapping.md`. A test
     * that implied otherwise would be the kind of claim this product exists to refuse.
     */
    const required = [
      '@media (max-width:39.99rem)',
      '@media (min-width:34rem)',
      '@media (min-width:40rem)',
      '@media (min-width:46rem)',
      '@media (min-width:52rem)',
      '@media (min-width:60rem)',
    ];
    for (const query of required) {
      expect(CSS, `the stylesheet no longer emits ${query}`).toContain(query);
    }
  });

  it('RESIL-184 the sticky header survives, and keeps an opaque fallback', () => {
    /*
     * The first piece of Stitch composition rather than palette: the approved header is
     * fixed with a blurred backdrop, and that is the one element all nineteen screens
     * share. Asserted because it is a single rule carrying a design decision, and because
     * the translucent colour must never be the ONLY background declared -- a browser
     * without colour mixing would then render a see-through header over scrolling text.
     */
    expect(CSS, 'the header is no longer sticky').toMatch(/\.site\{[^}]*position:sticky/);
    expect(CSS, 'no opaque fallback before the translucent value').toMatch(
      /\.site\{[^}]*background:var\(--c-surface\)[^}]*background:color-mix/,
    );
    expect(CSS, 'the blur has no unsupported-browser guard').toContain(
      '@supports not (backdrop-filter:blur(1px))',
    );
  });

  it('RESIL-185 the display sizes compute to the approved pixel values at both design widths', () => {
    /*
     * `empirical_verification_system/DESIGN.md` specifies the scale in pixels at two
     * widths: display-lg is 36px mobile and 56px desktop, display-md is 28px and 40px.
     * Those are expressed here as clamps, which is the right shape for a fluid page and
     * the wrong shape for trusting by eye -- a clamp can be "about right" and be neither
     * designed number.
     *
     * So this evaluates the clamp arithmetic at 375px and 1440px and checks the endpoints
     * ARE the designed values. It is the difference between implementing a design and
     * implementing something that resembles it.
     */
    const px = (token: string, viewport: number): number => {
      const m = /clamp\(([\d.]+)rem,\s*([\d.]+)rem \+ ([\d.]+)vw,\s*([\d.]+)rem\)/.exec(token);
      if (m === null) throw new Error(`${token} is not a two-ended clamp`);
      const [min, base, vw, max] = [m[1], m[2], m[3], m[4]].map((part) => Number(part ?? NaN));
      if ([min, base, vw, max].some((n) => n === undefined || Number.isNaN(n))) {
        throw new Error(`${token} has a part that is not a number`);
      }
      const fluid = (base as number) * 16 + ((vw as number) / 100) * viewport;
      return Math.round(Math.min(Math.max(fluid, (min as number) * 16), (max as number) * 16));
    };

    expect(px(TYPE.display, 375), 'display-lg at the mobile width').toBe(36);
    expect(px(TYPE.display, 1440), 'display-lg at the desktop width').toBe(56);
    expect(px(TYPE.h1, 375), 'display-md at the mobile width').toBe(28);
    expect(px(TYPE.h1, 1440), 'display-md at the desktop width').toBe(40);
    // The two fixed sizes, straight from the spec.
    expect(TYPE.h2, 'headline-lg is 24px').toBe('1.5rem');
    expect(TYPE.h3, 'headline-sm is 18px').toBe('1.125rem');
  });

  it('CUST-006 reduced motion is respected and focus is always visible', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion:reduce)');
    expect(CSS).toContain(':focus-visible{outline:2px solid var(--c-focus)');
  });

  it('CUST-007 the four statuses have four different glyphs, so they survive greyscale', () => {
    const glyphs = Object.values(STATUS_PRESENTATION).map((presentation) => presentation.glyph);
    expect(new Set(glyphs).size).toBe(4);
    for (const presentation of Object.values(STATUS_PRESENTATION)) {
      expect(presentation.label.length).toBeGreaterThan(0);
    }
  });

  it('CUST-008 the only script the site ships is the theme reader, and it touches nothing else', () => {
    expect(THEME_SCRIPT).toContain('verify-theme');
    expect(THEME_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|document\.write|eval/);
    expect(THEME_SCRIPT.length).toBeLessThan(400);
  });
});
