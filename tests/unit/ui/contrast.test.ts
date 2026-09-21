/**
 * RESIL-176..RESIL-182 — the palette's accessibility claims, computed rather than asserted
 * in prose.
 *
 * ## Why this file exists
 *
 * `packages/ui/src/tokens.ts` carried the comment:
 *
 *     faint  4.88:1  AA body (4.49:1 on `sunken`, still AA)
 *
 * 4.49 is not AA. AA body text is 4.5:1. The number was measured correctly and the
 * conclusion drawn from it was wrong, and because it lived in a comment rather than in a
 * test, nothing contradicted it. A future reader would have trusted it.
 *
 * That is the same defect class as the demo page's verification-rate meter rendering 33%
 * as a full bar (see `apps/app/src/index.ts` and the development story): a claim that
 * outran what was actually true, on a product whose entire argument is that it does not do
 * that. A comment is a claim with no test behind it.
 *
 * CUST-003 in `tokens.test.ts` did check text contrast, but only against `paper` and
 * `surface`. `sunken` — a real page background, used by `.band` and by the sunken panels —
 * was never in the loop, so the one pair that failed was the one pair nobody computed.
 * This file closes that by construction: every foreground is checked against *every*
 * background it can legally appear on, in both themes, and RESIL-179 fails if a token is
 * ever added without being classified, so the loop cannot silently stop covering something.
 *
 * RESIL-181 is the anti-drift lock proper. It recomputes each ratio written in the
 * tokens.ts comment block and asserts both that the computation matches and that the
 * literal text is still present in the file. Change a colour without changing the comment
 * and it fails; change the comment without changing the colour and it fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, type Palette } from '@verify/ui';

const TOKENS_SOURCE = readFileSync(
  join(process.cwd(), 'packages', 'ui', 'src', 'tokens.ts'),
  'utf8',
);

/**
 * WCAG 2.1 relative luminance, from the specification rather than from memory.
 * The 0.04045 threshold is the value in WCAG 2.1; 0.03928 appears in WCAG 2.0 and in a
 * great deal of copied code. Between the two the largest possible difference in a final
 * ratio is far below the second decimal place we report, but the specification's number is
 * the one to write down.
 */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

/** Two decimal places, the precision every ratio in this codebase is quoted to. */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

type PaletteKey = keyof Palette;

/**
 * What each token is *for*. This is the completeness contract: RESIL-179 asserts that
 * every key of the palette appears in exactly one list, so a new colour cannot be added
 * without someone deciding what threshold applies to it. That decision is the thing that
 * was missing when `sunken` was left out of the contrast loop.
 */
const ROLES = {
  /** Backgrounds that page content sits on. Every foreground is tested against all three. */
  surfaces: ['paper', 'surface', 'sunken'],
  /** Prose ranks. Body text: 4.5:1 on every surface. */
  bodyText: ['ink', 'muted', 'faint'],
  /** The four statuses. Body text on every surface, and on their own badge tint. */
  statusText: ['verified', 'failed', 'unverified', 'pending'],
  /** Badge fills. Tested as the background of their own status, in the order above. */
  tints: ['tintVerified', 'tintFailed', 'tintUnverified', 'tintPending'],
  /** Non-text: a control boundary and a focus indicator. WCAG 1.4.11 — 3:1. */
  uiBoundaries: ['fieldBorder', 'focus'],
  /** Decorative hairlines. Deliberately BELOW 3:1; no meaning may depend on seeing them. */
  decorative: ['rule', 'ruleStrong'],
  /** Foreground for the solid-ink primary button. Tested against `ink`. */
  onInk: ['onInk'],
} as const satisfies Record<string, readonly PaletteKey[]>;

const THEMES: readonly (readonly [string, Palette])[] = [
  ['light', LIGHT],
  ['dark', DARK],
];

describe('palette contrast', () => {
  it('RESIL-176 every text rank clears AA body on every surface it can appear on, in both themes', () => {
    for (const [theme, palette] of THEMES) {
      for (const fg of ROLES.bodyText) {
        for (const bg of ROLES.surfaces) {
          const ratio = contrast(palette[fg], palette[bg]);
          expect(
            round2(ratio),
            `${theme}: ${fg} (${palette[fg]}) on ${bg} (${palette[bg]}) is ${ratio.toFixed(2)}:1, below the 4.5:1 AA body minimum`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('RESIL-177 every status clears AA on every surface and on its own badge tint, in both themes', () => {
    for (const [theme, palette] of THEMES) {
      ROLES.statusText.forEach((status, index) => {
        for (const bg of ROLES.surfaces) {
          const ratio = contrast(palette[status], palette[bg]);
          expect(
            round2(ratio),
            `${theme}: ${status} on ${bg} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        const tint = ROLES.tints[index];
        expect(tint, `no tint declared for ${status}`).toBeDefined();
        const tintRatio = contrast(palette[status], palette[tint as PaletteKey]);
        expect(
          round2(tintRatio),
          `${theme}: ${status} on ${String(tint)} is ${tintRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  it('RESIL-178 control boundaries and the focus ring clear the 3:1 of WCAG 1.4.11 on every surface, and the badge border clears it too', () => {
    for (const [theme, palette] of THEMES) {
      for (const fg of ROLES.uiBoundaries) {
        for (const bg of ROLES.surfaces) {
          const ratio = contrast(palette[fg], palette[bg]);
          expect(
            round2(ratio),
            `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the 3:1 required of a UI component boundary`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      // The badge border is `currentColor` — the status colour itself (styles.ts, .badge).
      // It is the signal that survives forced-colours mode, where backgrounds are
      // overridden but borders are kept, so it carries a 1.4.11 obligation of its own.
      for (const status of ROLES.statusText) {
        for (const bg of ROLES.surfaces) {
          expect(
            round2(contrast(palette[status], palette[bg])),
            `${theme}: ${status} badge border on ${bg}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      expect(round2(contrast(palette.onInk, palette.ink))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('RESIL-179 every palette token is classified, so no colour can be added without a threshold being chosen for it', () => {
    const classified = new Set<string>(Object.values(ROLES).flat());
    const declared = Object.keys(LIGHT);
    for (const key of declared) {
      expect(
        classified.has(key),
        `palette token "${key}" has no role in tests/unit/ui/contrast.test.ts. Add it to ROLES and decide which threshold applies — this test exists because \`sunken\` was once outside the loop and the one pair nobody computed was the one pair that failed.`,
      ).toBe(true);
    }
    // And the reverse: a role naming a token that no longer exists is a stale test.
    for (const key of classified) {
      expect(declared, `ROLES names "${key}", which is not in the palette`).toContain(key);
    }
    // Both palettes must carry the same keys, or one theme is silently untested.
    expect(Object.keys(DARK).sort()).toEqual(declared.sort());
  });

  it('RESIL-180 decorative hairlines stay decorative — if one rises above 3:1 it is carrying meaning and must be reclassified', () => {
    for (const [theme, palette] of THEMES) {
      for (const key of ROLES.decorative) {
        for (const bg of ROLES.surfaces) {
          const ratio = contrast(palette[key], palette[bg]);
          expect(
            ratio,
            `${theme}: ${key} on ${bg} is ${ratio.toFixed(2)}:1. tokens.ts documents it as a decorative hairline "deliberately below 3:1". If that is no longer true, move it to ROLES.uiBoundaries and fix the comment.`,
          ).toBeLessThan(3);
        }
      }
    }
  });

  it('RESIL-181 every ratio written in the tokens.ts comment block is the ratio its colours actually produce, and is still written there', () => {
    /** [theme, foreground, background, the number the comment claims]. */
    const asserted: readonly (readonly [string, PaletteKey, PaletteKey, number])[] = [
      ['light', 'ink', 'paper', 16.48],
      ['light', 'muted', 'paper', 6.94],
      ['light', 'faint', 'paper', 4.96],
      ['light', 'faint', 'sunken', 4.55],
      // 5.29, not 5.48: `surface` moved from #FFFFFF to #FAFBFC when the owner's
      // exclusion on pure-white backgrounds was applied. Still AA, and the number moved
      // with the colour, which is what this case exists to force.
      ['light', 'faint', 'surface', 5.29],
      ['light', 'verified', 'paper', 5.97],
      ['light', 'verified', 'tintVerified', 5.72],
      ['light', 'failed', 'paper', 6.62],
      ['light', 'failed', 'tintFailed', 6.2],
      ['light', 'unverified', 'paper', 6.42],
      ['light', 'unverified', 'tintUnverified', 6.15],
      ['light', 'pending', 'paper', 7.4],
      ['light', 'pending', 'tintPending', 6.94],
      ['light', 'fieldBorder', 'paper', 3.88],
      ['light', 'fieldBorder', 'surface', 4.14],
      ['light', 'focus', 'paper', 5.29],
      // Recomputed when the dark palette became the owner-approved Stitch system. These
      // moved together with the comment in tokens.ts, which is the whole point of this
      // case: neither the numbers nor the colours may change on their own.
      ['dark', 'ink', 'paper', 14.39],
      ['dark', 'muted', 'paper', 10.45],
      ['dark', 'faint', 'paper', 7.65],
      ['dark', 'verified', 'paper', 10.88],
      ['dark', 'failed', 'paper', 10.94],
      ['dark', 'unverified', 'paper', 10.93],
      ['dark', 'pending', 'paper', 8.53],
      ['dark', 'focus', 'paper', 10.93],
      ['dark', 'fieldBorder', 'paper', 5.85],
    ];

    for (const [theme, fg, bg, claim] of asserted) {
      const palette = theme === 'light' ? LIGHT : DARK;
      expect(
        round2(contrast(palette[fg], palette[bg])),
        `${theme}: tokens.ts claims ${fg} on ${bg} is ${claim.toFixed(2)}:1`,
      ).toBe(claim);
      // The number must still be in the file. Deleting the comment breaks this test
      // rather than quietly removing the claim it was documenting.
      expect(
        TOKENS_SOURCE,
        `tokens.ts no longer states the ${claim.toFixed(2)}:1 ratio for ${theme} ${fg} on ${bg}`,
      ).toContain(`${claim.toFixed(2)}:1`);
    }

    // The dark palette's summary claim: each status on its own tint is at or above 7.8:1.
    const tintFloor = ROLES.statusText.map((status, index) =>
      contrast(DARK[status], DARK[ROLES.tints[index] as PaletteKey]),
    );
    expect(Math.min(...tintFloor)).toBeGreaterThanOrEqual(7.8);
    expect(TOKENS_SOURCE).toContain('7.8:1');
  });

  it('RESIL-182 the four statuses are NOT separable by luminance, which is why glyph and label carry the meaning', () => {
    // This is the measurement behind WCAG 1.4.1 for this product specifically. If these
    // ever became separable, colour would start carrying information on its own — and the
    // moment someone relied on that, a greyscale print or a colour vision deficiency would
    // take it away again. The rule is that colour is never the only signal, so this test
    // asserts the premise rather than hoping for it.
    for (const [theme, palette] of THEMES) {
      const keys = ROLES.statusText;
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const a = keys[i] as PaletteKey;
          const b = keys[j] as PaletteKey;
          const ratio = contrast(palette[a], palette[b]);
          expect(
            ratio,
            `${theme}: ${a} vs ${b} is ${ratio.toFixed(2)}:1 — near-identical in greyscale, as expected`,
          ).toBeLessThan(1.5);
        }
      }
    }
  });
});
