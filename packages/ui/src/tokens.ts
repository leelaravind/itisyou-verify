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
 * Dark palette — the owner-approved Stitch "Empirical Verification System".
 *
 * ## Why this replaced the previous dark palette, and what it costs
 *
 * The comment at the top of this file argues that colour should be reserved for evidence
 * and that the product should carry no brand hue. That was my reasoning, and it was
 * genuinely held. The owner commissioned a design in Stitch, approved it, and asked for it
 * to be implemented; a design decision belongs to the person whose product it is, so the
 * approved palette wins and the argument above is now a record of what was traded away
 * rather than a rule still being followed.
 *
 * What is NOT traded away is the evidence vocabulary. Stitch names four status colours and
 * they map one-to-one onto the four run statuses this product is built around —
 * `status-confirmed` to VERIFIED, `status-discrepancy` to FAILED, `status-inconclusive` to
 * UNVERIFIED, `status-pending` to PENDING. Status is still never signalled by hue alone:
 * the glyph, the label and the border all survive unchanged, which is why RESIL-182 still
 * passes.
 *
 * ## The one value that is not Stitch's
 *
 * `pending` is `#a3b1c4` where Stitch specifies `#94a3b8`. Stitch's value reads 6.7:1 on
 * any badge tint dark enough to sit inside this palette, and this file's own floor for a
 * status on its own tint is 7.8:1. The choice was to lower the floor or to lighten the
 * slate by a shade that is still plainly the same colour; lowering a measured
 * accessibility minimum to fit a palette is the kind of quiet subtraction this project has
 * been caught making before. Everything else is Stitch's value unchanged.
 *
 * Measured against `paper` (#0f131c), recomputed from these exact values rather than
 * carried over:
 *   ink 14.39:1, muted 10.45:1, faint 7.65:1, verified 10.88:1, failed 10.94:1,
 *   unverified 10.93:1, pending 8.53:1, focus 10.93:1, fieldBorder 5.85:1.
 * Each status on its own tint stays at or above 7.8:1 — the measured floor is 8.18:1,
 * which is `pending`, the value discussed above.
 */
export const DARK = {
  /** Stitch `surface` / `background`. */
  paper: '#0f131c',
  /** Stitch `surface-container`. */
  surface: '#1c2029',
  /** Stitch `surface-canvas`, the lowest container. */
  sunken: '#0a0e17',
  /** Stitch `on-surface`. */
  ink: '#dfe2ef',
  muted: '#b7c4cf',
  faint: '#9aa8b5',
  rule: '#2a3340',
  /** Stitch `border-hairline`. */
  ruleStrong: '#3c4a42',
  /** Stitch `outline`. */
  fieldBorder: '#86948a',
  /** Stitch `border-active` / `secondary`. A focus ring is a function, and this one is loud. */
  focus: '#4cd7f6',
  /** Stitch `status-confirmed`. */
  verified: '#4edea3',
  /** Stitch `status-discrepancy`. */
  failed: '#ffb4ab',
  /** Stitch `status-inconclusive`. */
  unverified: '#ffb95f',
  /** Stitch `status-pending`, lightened one shade — see the note above. */
  pending: '#a3b1c4',
  tintVerified: '#0d2a20',
  tintFailed: '#2c1614',
  tintUnverified: '#2b1f0d',
  tintPending: '#111823',
  onInk: '#0f131c',
} as const;

/** Both palettes carry the same keys; the values are plain strings, not literals. */
export type Palette = { readonly [K in keyof typeof LIGHT]: string };

/**
 * Type stacks. No webfont: a Worker that inlines its whole stylesheet should not then
 * block first paint on a third-party font host, and a font request to fonts.gstatic.com
 * would be a subprocessor we have not declared on the privacy page.
 */
export const FONT = {
  /**
   * Prose. Everything a person at this company wrote.
   *
   * The approved Stitch system specifies Plus Jakarta Sans for headings and Inter for
   * body. Both are NAMED FIRST and neither is fetched: the stack falls through to the
   * system UI face when they are not installed locally. That is deliberate and the reason
   * is on the privacy page -- a `fonts.gstatic.com` request would make Google a
   * subprocessor we have not declared, and a Worker that inlines its whole stylesheet
   * should not then block first paint on a third-party host. Self-hosting them as Worker
   * assets is the honest way to get the exact faces and is not done yet; until it is, this
   * renders in the system face rather than pretending otherwise.
   */
  sans: '"Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  /** Evidence. Everything a machine produced: values, ids, timestamps, status labels. */
  mono: '"JetBrains Mono", ui-monospace, "Cascadia Mono", "Cascadia Code", "SF Mono", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Type scale. Display sizes are fluid; body sizes are fixed so line length stays honest. */
/**
 * Type scale — the approved Stitch scale, converted rather than approximated.
 *
 * `empirical_verification_system/DESIGN.md` specifies sizes in pixels at two widths:
 * `display-lg` 56px with a 36px mobile variant, `display-md` 40px with 28px mobile,
 * `headline-lg` 24px and `headline-sm` 18px. Body sizes were already 16/14/12 and match.
 *
 * The two display sizes are expressed as clamps solved across a 375px–1440px viewport so
 * the endpoints ARE the designed values rather than something near them: at 375px the
 * display computes to 36px and at 1440px to 56px. A designer who measures the rendered
 * page at either width gets the number they drew.
 *
 * The previous scale topped out at 48px, which is a fifth smaller than the design and the
 * difference a hero headline is mostly made of. Body, small and micro are unchanged;
 * Stitch's `body-sm` is 13px against our 12px micro, and 12px is kept because it is the
 * floor the contrast and readability work was done against.
 */
export const TYPE = {
  /** Stitch `display-lg`: 36px at 375px, 56px at 1440px. */
  display: 'clamp(2.25rem, 1.8099rem + 1.878vw, 3.5rem)',
  /** Stitch `display-md`: 28px at 375px, 40px at 1440px. */
  h1: 'clamp(1.75rem, 1.4859rem + 1.127vw, 2.5rem)',
  /** Stitch `headline-lg`. */
  h2: '1.5rem',
  /** Stitch `headline-sm`. */
  h3: '1.125rem',
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

/**
 * Corner radii. These already matched the approved scale and are now labelled with it:
 * Stitch's `rounded.DEFAULT` is 0.25rem and `rounded.lg` is 0.5rem, which is what these
 * two were. Nothing changed; the comment stops the next person re-deriving it.
 */
export const RADIUS = {
  /** Controls: inputs, buttons, badges. Stitch `rounded.DEFAULT`. */
  control: '4px',
  /** Containers: cards, callouts, tables. Stitch `rounded.lg`. */
  container: '8px',
} as const;

/**
 * Elevation — the piece of the approved design this interface did not have at all.
 *
 * The Stitch screens put `shadow-sm` on cards and `shadow-lg` on the surfaces that sit
 * above them, and the header carries `0 1px 8px rgba(0,0,0,0.04)`. Our interface was
 * entirely flat: a card was a 1px rule and nothing else. On the light palette that read as
 * deliberate restraint; on the approved dark palette, where `surface` (#1c2029) sits only
 * a shade above `paper` (#0f131c), a hairline is doing all the work of separating a card
 * from the page and it is not enough.
 *
 * Both values are pure black at low alpha rather than a tinted shadow, because the palette
 * is dark and a coloured shadow on a dark ground reads as a glow — which the designs do use
 * deliberately, on the primary call to action only, and which would be wrong on every card.
 *
 * The border stays. Shadow is the secondary signal here, not the primary one: it disappears
 * in forced-colors mode and under some high-contrast settings, and a card must still have
 * an edge when it does.
 */
export const ELEVATION = {
  /** Cards and other resting surfaces. Stitch `shadow-sm`. */
  rest: '0 1px 2px rgba(0,0,0,0.28), 0 1px 8px rgba(0,0,0,0.16)',
  /** Surfaces that sit above the page: the sticky header. */
  raised: '0 1px 8px rgba(0,0,0,0.24)',
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
