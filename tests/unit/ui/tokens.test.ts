/**
 * CUST-001..CUST-008 — the design system's own invariants.
 *
 * These are the properties a component test cannot check for you: that the palette clears
 * WCAG, that both themes are actually defined, and that the stylesheet has not quietly
 * grown past the size that justified inlining it.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CSS, CSS_BYTES, DARK, LIGHT, STATUS_PRESENTATION, THEME_SCRIPT } from '@verify/ui';

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

  it('CUST-005 the dark palette is reachable both by preference and by an explicit override, in both directions', () => {
    expect(CSS).toContain('@media (prefers-color-scheme:dark)');
    expect(CSS).toContain(':root:not([data-theme="light"])');
    expect(CSS).toContain(':root[data-theme="dark"]');
    expect(CSS).toContain(':root[data-theme="light"]');
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
