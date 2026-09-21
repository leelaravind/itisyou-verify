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
 *   faint       4.96:1  AA  body (4.55:1 on `sunken`, 5.29:1 on `surface` — AA on all three)
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
 *   fieldBorder 3.88:1 on paper, 4.14:1 on surface — clears the 3:1 required of a UI
 *               component boundary by WCAG 1.4.11
 *   focus       5.29:1 on paper — clears 3:1 for a non-text indicator with room to spare
 *   `rule` and `ruleStrong` are decorative hairlines carrying no information; they are
 *   deliberately below 3:1 and no meaning depends on seeing them.
 */
export const LIGHT = {
  paper: '#F1F4F6',
  /* Off-white, not #FFFFFF: the owner's exclusions say no pure-white backgrounds, and
     this token is the background of every card, panel, table frame and the header. The
     shift is small on purpose. It is enough that no surface on the page is pure white,
     and small enough that every contrast ratio measured against `surface` above still
     holds with room to spare. */
  surface: '#FAFBFC',
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
   * body. Inter has been removed from the stack: the owner's exclusions name it, and the
   * exclusions override a conflicting Stitch style. It was only the second entry, which
   * made it easy to read as harmless, and that is exactly what it was not: a stack is a
   * list of faces the page WILL render in, so on any machine with Inter installed, which
   * is a great many developer machines, the excluded face is what a reader actually saw.
   *
   * Plus Jakarta Sans is NAMED FIRST and is not fetched: the stack falls through to the
   * system UI face when it is not installed locally. That is deliberate and the reason is
   * on the privacy page -- a `fonts.gstatic.com` request would make Google a subprocessor
   * we have not declared, and a Worker that inlines its whole stylesheet should not then
   * block first paint on a third-party host. Self-hosting it as a Worker asset is the
   * honest way to get the exact face and is not done yet; until it is, this renders in the
   * system face rather than pretending otherwise.
   */
  sans: '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
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
  /**
   * The mono "figure" ranks — a computed number a reader is meant to register at a glance:
   * a dashboard score, a run count, a plan price. Before this scale existed each one
   * hard-coded its own rem value (2.25rem, 2rem, 2.5rem, 1.75rem) with no relationship
   * between them, which is the same defect rule 2 at the top of this file names for prose
   * versus mono generally, one level down: four numbers that all mean "this is the
   * headline figure" and do not agree on how large that is. The four values below are
   * exactly the ones already rendered — nothing on screen moves — so this is the token
   * layer catching up to a scale that was already there by accident and naming it on
   * purpose, not a redesign.
   */
  figureXs: '1.75rem',
  figureSm: '2rem',
  figure: '2.25rem',
  figureLg: '2.5rem',
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
 * Corner radii.
 *
 * `control` is Stitch's `rounded.DEFAULT` and is kept: a 4px corner on a button, an input
 * or a badge is how a control says it is a control, and nothing in the owner's exclusions
 * is about controls.
 *
 * `container` was Stitch's `rounded.lg`, 8px, and is now 0. The owner's exclusions name
 * "soft rounded cards", and an 8px corner over a translucent surface with a drop shadow
 * under it is precisely that shape. The exclusions override a conflicting reference style,
 * so the reference loses. A square container also makes the hairline rule the only edge a
 * card has, which is the honest version of what the border was already doing.
 *
 * Deliberately a token and not a search-and-replace: every container on nineteen screens
 * reads this one value, so the decision is in one place and cannot half-apply.
 */
export const RADIUS = {
  /** Controls: inputs, buttons, badges. Stitch `rounded.DEFAULT`. */
  control: '4px',
  /** Containers: cards, callouts, tables. Square, by the owner's exclusion. */
  container: '0',
} as const;

/**
 * Brand accent — display only, and deliberately NOT a status colour.
 *
 * The approved Stitch system defines `primary` (#6ffbbe) and `secondary` (#4cd7f6)
 * separately from its four status colours, and the hero headline uses a gradient between
 * them on one clipped span. Reusing `verified` for that gradient would have been easier and
 * would have been wrong: on this interface a green word carries a verdict, and a reader
 * meeting one in a headline would reasonably read it as one. `primary` is a shade off
 * `status-confirmed` (#6ffbbe against #4edea3) precisely so the two can sit on the same
 * page without being confused, and that distinction only survives if it is honoured here.
 *
 * Both are measured against the two surfaces they can appear on, recomputed from these
 * values: primary 14.35:1 on paper and 12.59:1 on surface; secondary 10.93:1 and 9.59:1.
 * Every one clears AA body text, which is stricter than the 3:1 large text would need.
 *
 * Kept out of `Palette` on purpose. `Palette` is the set of colours a component may reach
 * for, and every member of it is classified by the contrast suite against a threshold
 * chosen for its ROLE. These two have one use, in one rule, on text that is never the only
 * way a fact is conveyed. RESIL-187 measures them rather than letting them escape.
 */
export const BRAND = {
  /** Stitch `primary`. */
  primary: '#6ffbbe',
  /** Stitch `secondary`, which is also the focus ring. */
  secondary: '#4cd7f6',
} as const;

/*
 * Elevation was here, and has been removed. 21 September 2026.
 *
 * The Stitch screens put `shadow-sm` on cards and `shadow-lg` on the surfaces above them,
 * and this interface adopted both. The owner's exclusions say "no drop shadows", and they
 * override a conflicting reference style, so the shadows go.
 *
 * The argument the removed token made was real and has to be answered rather than
 * ignored: on the dark palette `surface` (#1c2029) sits only a shade above `paper`
 * (#0f131c), so a hairline was carrying the whole job of separating a card from the page,
 * and a shadow was helping it. The answer is not a shadow, because shadow was never the
 * dependable half of that pair: it disappears in forced-colors mode and under several
 * high-contrast settings, so a card had to survive without it anyway.
 *
 * What actually changed, stated exactly, because the first version of this comment
 * overstated it and an independent review measured the overstatement:
 *
 *  - FOUR rules moved from `--c-rule` to `--c-rule-strong`: `.card`, `.panel`, `.results`
 *    and `.site`, which are the surfaces that were carrying a shadow. Other containers
 *    (`.claimrule`, `.callout`, `.disclosure`, `.band`) keep `--c-rule` and were never
 *    elevated, so nothing about them changed or needed to.
 *  - it is a MORE VISIBLE hairline, not a compliant boundary. Measured: on DARK,
 *    `ruleStrong` on `surface` is 1.75:1 where `rule` was 1.28:1; on LIGHT, 2.09:1 against
 *    1.45:1. Both stay below 3:1 deliberately, and `RESIL-180` asserts that they do,
 *    because a container edge here is decoration and no meaning depends on seeing it. The
 *    thing a reader must always be able to find is the content, and every card's heading,
 *    badge and label carry their own contrast.
 *
 * So this is the better half of a pair being strengthened, not a replacement of equal
 * weight. Saying so is the point: a comment claiming the shadow's job was taken over would
 * be exactly the sort of unearned claim this repository keeps catching in its own copy.
 *
 * Nothing imports ELEVATION any more. If a shadow is ever wanted again it needs the
 * owner's exclusion list changed first, not a token added back quietly.
 */

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

/**
 * Motion. One shared curve, two durations, one entrance distance — so every transition and
 * animation in the sheet reads as a single deliberate hand rather than a scatter of magic
 * numbers. This is a forensic verification tool, not a landing page: motion here confirms
 * that something happened, it does not perform.
 *
 *  - `fast` is for a control acknowledging a touch: a button, a link, a field border, a
 *    disclosure marker. Quick enough to feel like a direct response, not a lag.
 *  - `base` is for content: an entrance settle, a disclosure opening, a row of verdicts
 *    appearing. Slower than `fast` because it is moving more, never because it is decorating.
 *  - `ease` decelerates into its resting position and never overshoots. The same curve on a
 *    120ms hover and a 220ms entrance is what makes the two read as one language rather than
 *    two different libraries glued together.
 *  - `rise` is how far an entering element travels. Small on purpose: a hint that content
 *    settled into place, not a slide-in that makes the reader wait for it to arrive.
 */
export const MOTION = {
  fast: '120ms',
  base: '220ms',
  ease: 'cubic-bezier(0.22,0.61,0.36,1)',
  rise: '0.5rem',
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
