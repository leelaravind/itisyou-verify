/**
 * Design tokens — the single source of truth for every colour, size and rhythm in the
 * interface. `styles.ts` emits CSS custom properties from these values; nothing else
 * hard-codes a hex or a pixel.
 *
 * ## The direction, stated once so it can be argued with
 *
 * This product sells the difference between a claim and an observation. The interface
 * makes that difference literal, and spends its entire design budget on it:
 *
 *  1. **Colour is reserved for evidence.** There is no brand colour. The only hues on any
 *     page are the four run statuses, so a colour on screen always carries a verdict and
 *     never decorates. Links are ink with an underline; the primary button is solid ink;
 *     the focus ring is blue because a focus ring is a function, not a brand.
 *  2. **If a human wrote it, it is set in sans. If a machine produced it, it is set in
 *     mono.** Every retrieved value, expected value, identifier, timestamp, status label
 *     and field name is monospaced. The reader learns this rule in two screens and can
 *     then tell our prose from the record at a glance.
 *  3. **The evidence margin.** A fixed left column carries the status glyph and the
 *     origin of a finding; the content column carries the plain sentence. It collapses to
 *     a stacked row under 40rem rather than squeezing.
 *
 * ## Accessibility of the status palette
 *
 * Status is never signalled by hue alone. Every status carries three signals: a glyph
 * (distinct silhouette, not a coloured dot), a text label, and a border. Measured WCAG 2.1
 * contrast ratios are recorded against each token below and were computed from these exact
 * values, not estimated.
 */

/** The four run statuses, in the frozen contract's own vocabulary. */
export type StatusKey = 'VERIFIED' | 'FAILED' | 'UNVERIFIED' | 'PENDING';

/** Assertion-level statuses, which map onto the same visual vocabulary. */
export type AssertionKey = 'SUPPORTED' | 'CONTRADICTED' | 'UNKNOWN' | 'PENDING';

/**
 * Which visual status an assertion status wears. `SUPPORTED` borrows VERIFIED's green,
 * `CONTRADICTED` borrows FAILED's red, `UNKNOWN` borrows UNVERIFIED's amber — deliberate,
 * because the customer-facing meaning is the same at both levels.
 */
export const ASSERTION_TO_STATUS: Readonly<Record<AssertionKey, StatusKey>> = {
  SUPPORTED: 'VERIFIED',
  CONTRADICTED: 'FAILED',
  UNKNOWN: 'UNVERIFIED',
  PENDING: 'PENDING',
};

/**
 * Light palette. Cool paper rather than warm cream: this is an instrument readout, not a
 * letterpress poster.
 *
 * Measured against `paper` (#F1F4F6) unless noted:
 *   ink        16.48:1  AAA body
 *   muted       6.94:1  AA  body
 *   faint       4.96:1  AA  body (4.55:1 on `sunken`, 5.48:1 on `surface` — AA on all three)
 *
 *               `faint` was #5E6C78 until 2026-09-19. That value measured 4.49:1 on
 *               `sunken` and this comment called it "still AA". It is not: AA body text
 *               is 4.5:1 and 4.49 is below it. The claim, not the colour, was the real
 *               defect — a false accessibility assertion in a comment a future reader
 *               would have trusted. #5D6B77 is the minimum darkening that clears the
 *               threshold on the worst backdrop while keeping three distinct text ranks
 *               (muted 6.94:1, faint 4.96:1 on paper). Every ratio in this file is now
 *               asserted mechanically by tests/unit/ui/contrast.test.ts, which recomputes
 *               them from these exact values; a comment can no longer drift from a colour.
 *   verified    5.97:1  AA  (5.72:1 on its own tint)
 *   failed      6.62:1  AA  (6.20:1 on its own tint)
 *   unverified  6.42:1  AA  (6.15:1 on its own tint)
 *   pending     7.40:1  AAA (6.94:1 on its own tint)
 *   fieldBorder 3.88:1 on paper, 4.28:1 on surface — clears the 3:1 required of a UI
 *               component boundary by WCAG 1.4.11
 *   focus       5.29:1 on paper — clears 3:1 for a non-text indicator with room to spare
 *   `rule` and `ruleStrong` are decorative hairlines carrying no information; they are
 *   deliberately below 3:1 and no meaning depends on seeing them.
 */
export const LIGHT = {
  paper: '#F1F4F6',
  surface: '#FFFFFF',
  sunken: '#E5EBEF',
  ink: '#10161C',
  muted: '#48555F',
  faint: '#5D6B77',
  rule: '#CBD4DC',
  ruleStrong: '#A5B2BE',
  fieldBorder: '#6E7C88',
  focus: '#1A5FD0',
  verified: '#0E6A4C',
  failed: '#A81F14',
  unverified: '#7D4E00',
  pending: '#3F5163',
  tintVerified: '#E4F2EC',
  tintFailed: '#FBE8E6',
  tintUnverified: '#F7EEDC',
  tintPending: '#E8EDF2',
  onInk: '#F1F4F6',
} as const;

/**
 * Dark palette. Every ratio here is higher than its light counterpart — measured against
 * `paper` (#0D1217):
 *   ink 16.12:1, muted 8.81:1, faint 6.54:1, verified 9.52:1, failed 8.57:1,
 *   unverified 9.47:1, pending 9.06:1, focus 8.78:1, fieldBorder 4.38:1.
 * Each status on its own tint stays at or above 7.8:1.
 */
export const DARK = {
  paper: '#0D1217',
  surface: '#161D25',
  sunken: '#090D11',
  ink: '#E9EEF3',
  muted: '#A6B3C0',
  faint: '#8C9AA8',
  rule: '#27313B',
  ruleStrong: '#3C4954',
  fieldBorder: '#6B7C8C',
  focus: '#7FB3FF',
  verified: '#5CCCA4',
  failed: '#FF9082',
  unverified: '#E8AE45',
  pending: '#A4B6C9',
  tintVerified: '#10261F',
  tintFailed: '#2A1613',
  tintUnverified: '#291F0E',
  tintPending: '#151D26',
  onInk: '#0D1217',
} as const;

/** Both palettes carry the same keys; the values are plain strings, not literals. */
export type Palette = { readonly [K in keyof typeof LIGHT]: string };

/**
 * Type stacks. No webfont: a Worker that inlines its whole stylesheet should not then
 * block first paint on a third-party font host, and a font request to fonts.gstatic.com
 * would be a subprocessor we have not declared on the privacy page.
 */
export const FONT = {
  /** Prose. Everything a person at this company wrote. */
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  /** Evidence. Everything a machine produced: values, ids, timestamps, status labels. */
  mono: 'ui-monospace, "Cascadia Mono", "Cascadia Code", "SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Type scale. Display sizes are fluid; body sizes are fixed so line length stays honest. */
export const TYPE = {
  display: 'clamp(2rem, 1.35rem + 2.7vw, 3rem)',
  h1: 'clamp(1.625rem, 1.35rem + 1.15vw, 2.125rem)',
  h2: '1.3125rem',
  h3: '1.0625rem',
  body: '1rem',
  small: '0.875rem',
  micro: '0.75rem',
} as const;

/** 4px base. Named by step so a component never invents an in-between value. */
export const SPACE = {
  x1: '0.25rem',
  x2: '0.5rem',
  x3: '0.75rem',
  x4: '1rem',
  x6: '1.5rem',
  x8: '2rem',
  x12: '3rem',
  x16: '4rem',
  x24: '6rem',
} as const;

export const RADIUS = {
  /** Controls: inputs, buttons, badges. */
  control: '4px',
  /** Containers: cards, callouts, tables. */
  container: '8px',
} as const;

export const LAYOUT = {
  /** Reading measure for prose. Roughly 68 characters at the body size. */
  measure: '38rem',
  /** Wide container for tables, dashboards and multi-column marketing sections. */
  wide: '72rem',
  /**
   * The evidence margin.
   *
   * 7.5rem, not 5.5rem: the widest status badge ("Unverified", glyph + label + padding)
   * measures about 7.2rem, and at 5.5rem it overlapped the sentence beside it on every
   * screenshot. A verdict that overlaps its own explanation is not a small cosmetic fault
   * on this product.
   */
  margin: '7.5rem',
  /** The steps gutter, which only ever holds a two-digit number. */
  stepMargin: '3.5rem',
  /** Below this width the evidence margin stacks above its content instead of beside it. */
  stackAt: '40rem',
} as const;

export interface StatusPresentation {
  readonly key: StatusKey;
  /** Sentence-case label shown to customers. Always rendered — colour is never the only cue. */
  readonly label: string;
  /** CSS custom property name holding this status's foreground colour. */
  readonly colorVar: string;
  /** CSS custom property name holding this status's tint background. */
  readonly tintVar: string;
  /** Glyph id — a distinct silhouette, so the four remain separable in greyscale. */
  readonly glyph: 'check' | 'cross' | 'dash' | 'arc';
}

/**
 * How each status presents itself. The labels match A01's `STATUS_DEFINITIONS` exactly;
 * this table holds only the visual half.
 */
export const STATUS_PRESENTATION: Readonly<Record<StatusKey, StatusPresentation>> = {
  VERIFIED: {
    key: 'VERIFIED',
    label: 'Verified',
    colorVar: '--c-verified',
    tintVar: '--c-verified-tint',
    glyph: 'check',
  },
  FAILED: {
    key: 'FAILED',
    label: 'Failed',
    colorVar: '--c-failed',
    tintVar: '--c-failed-tint',
    glyph: 'cross',
  },
  UNVERIFIED: {
    key: 'UNVERIFIED',
    label: 'Unverified',
    colorVar: '--c-unverified',
    tintVar: '--c-unverified-tint',
    glyph: 'dash',
  },
  PENDING: {
    key: 'PENDING',
    label: 'Pending',
    colorVar: '--c-pending',
    tintVar: '--c-pending-tint',
    glyph: 'arc',
  },
};

/** Labels for assertion-level statuses. Distinct wording from run status, deliberately. */
export const ASSERTION_LABEL: Readonly<Record<AssertionKey, string>> = {
  SUPPORTED: 'Confirmed',
  CONTRADICTED: 'Not as expected',
  UNKNOWN: 'Could not confirm',
  PENDING: 'Still checking',
};
