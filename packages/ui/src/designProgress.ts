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

/**
 * Every approved screen, and whether its own layout has been built.
 *
 * Reconciled on 20 September 2026 by opening each served screenshot under
 * `docs/screenshots/stitch/<slug>-1440.png` beside the reference `screen.png` under
 * `design/stitch/screens/` and comparing section order, card arrangement, column counts
 * and hero structure. A route with no screenshot is `false`. A route with no approved
 * screen at all cannot be composed against one and is `false` too. Two labels were
 * corrected to the routes that actually exist: `/app/onboarding` and
 * `/app/onboarding/workflow` were never served; the reference each stood for is served at
 * `/app/onboarding/compatibility` and `/app/onboarding/outcome`.
 */
export const STITCH_SCREENS: readonly { readonly route: string; readonly composed: boolean }[] = [
  // home-1440.png against itisyou_verify_ground_truth_automation_verification_for_agencies
  { route: '/', composed: true },
  // pricing-1440.png against pricing_policy_itisyou_verify
  { route: '/pricing', composed: true },
  // how-it-works-1440.png against how_it_works_demonstration_itisyou_verify
  { route: '/how-it-works', composed: true },
  // demo-1440.png against the same reference: framed run table with the tally under it
  { route: '/demo', composed: true },
  // No approved screen exists for this route, so there is nothing to compose against.
  { route: '/security', composed: false },
  // app-1440.png against customer_dashboard_itisyou_verify
  { route: '/app', composed: true },
  // app-onboarding-compatibility-1440.png: the reference's probe cards lent their sunken
  // panes, and nothing else — section order and columns here are ours.
  { route: '/app/onboarding/compatibility', composed: false },
  // No screenshot under docs/screenshots/stitch/, and not recomposed.
  { route: '/app/onboarding/connect', composed: false },
  // app-onboarding-outcome-1440.png against workflow_configuration_itisyou_verify
  { route: '/app/onboarding/outcome', composed: true },
  // app-onboarding-review-1440.png against compatibility_proof_checkout_review_itisyou_verify
  { route: '/app/onboarding/review', composed: true },
  // app-connections-1440.png against connections_evidence_sources_itisyou_verify
  { route: '/app/connections', composed: true },
  // app-runs-id-failed-1440.png against run_details_evidence_itisyou_verify
  { route: '/app/runs/:id', composed: true },
  // app-usage-1440.png against reports_exports_itisyou_verify; the four count cards sit
  // under the meter rather than above it, as the reference has them.
  { route: '/app/usage', composed: true },
  // app-billing-1440.png against billing_cancellation_support_itisyou_verify
  { route: '/app/billing', composed: true },
  // owner-1440.png and owner-known-1440.png against owner_overview_itisyou_verify; the
  // reference's fixed side navigation is shared chrome and was not translated.
  { route: '/owner', composed: true },
  // owner-quality-1440.png against automated_testing_and_cleanup_centre_itisyou_verify;
  // the reference's cleanup half is served at /owner/cleanup, which is not composed.
  { route: '/owner/quality', composed: true },
  // No approved screen exists for these two routes.
  { route: '/admin/login', composed: false },
  { route: '/support', composed: false },
  // A reference exists (visual_development_story_itisyou_verify); no screenshot, not built.
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
