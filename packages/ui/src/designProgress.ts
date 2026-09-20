/**
 * How much of the owner's approved design is actually composed.
 *
 * ## Why this is a module and not a number in a message
 *
 * The owner asked for a percentage. A percentage written into an alert string is a claim
 * nobody can check and that nothing fails when it goes stale — this repository has already
 * published a figure of "34 findings" that turned out to be 109, in five places at once.
 * So the two counts live here, next to a list naming every screen, and the percentage is
 * arithmetic rather than an assertion.
 *
 * ## What "composed" means, precisely
 *
 * NOT "the palette applies". The approved colour system, type scale, elevation, sticky
 * header and accent reach all nineteen screens, because every component reads the same
 * custom properties — that was done at the token layer and was the easy half. A screen
 * counts as composed only when its own layout has been built against its reference:
 * section order, card arrangement, column counts, hero structure.
 *
 * Claiming the design is live on the strength of the token layer would be true of one
 * layer and false of what a person sees, which is the exact shape of claim this product
 * exists to refuse.
 */

/** Every approved screen, and whether its own layout has been built. */
export const STITCH_SCREENS: readonly { readonly route: string; readonly composed: boolean }[] = [
  { route: '/', composed: true },
  { route: '/pricing', composed: true },
  { route: '/how-it-works', composed: true },
  { route: '/demo', composed: true },
  { route: '/security', composed: true },
  { route: '/app', composed: false },
  { route: '/app/onboarding', composed: false },
  { route: '/app/onboarding/connect', composed: false },
  { route: '/app/onboarding/workflow', composed: false },
  { route: '/app/onboarding/review', composed: false },
  { route: '/app/connections', composed: false },
  { route: '/app/runs/:id', composed: false },
  { route: '/app/usage', composed: false },
  { route: '/app/billing', composed: false },
  { route: '/owner', composed: false },
  { route: '/owner/quality', composed: false },
  { route: '/admin/login', composed: false },
  { route: '/support', composed: false },
  { route: '/development-story/visual', composed: false },
];

export interface DesignProgress {
  readonly composed: number;
  readonly total: number;
  /** Whole percent, rounded DOWN. A design that is 94.9% done is not 95% done. */
  readonly percent: number;
}

export function designProgress(
  screens: readonly { readonly composed: boolean }[] = STITCH_SCREENS,
): DesignProgress {
  const total = screens.length;
  const composed = screens.filter((s) => s.composed).length;
  // Rounded down on purpose. Every other number on this product rounds toward the less
  // flattering answer -- the demo meter draws 33% as 30 and only a true 100% fills the bar
  // -- and a progress figure reported to the person paying for it gets the same treatment.
  return { composed, total, percent: total === 0 ? 0 : Math.floor((composed / total) * 100) };
}
