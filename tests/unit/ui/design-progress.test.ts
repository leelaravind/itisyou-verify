/**
 * CUST-720..723 — the design figure the owner is sent on Telegram.
 *
 * A percentage in a message is a claim nobody can check and that nothing fails when it
 * goes stale. This repository has already published a figure of "34 findings" that turned
 * out to be 109, in five places at once. So the arithmetic is asserted here and the
 * message is built from it.
 */
import { describe, expect, it } from 'vitest';
import { STITCH_SCREENS, designProgress } from '@verify/ui';

describe('the design progress figure', () => {
  it('CUST-720 the percentage is arithmetic over the screen list, not a written-down number', () => {
    const progress = designProgress();
    expect(progress.total).toBe(STITCH_SCREENS.length);
    expect(progress.composed).toBe(STITCH_SCREENS.filter((s) => s.composed).length);
    expect(progress.percent).toBe(Math.floor((progress.composed / progress.total) * 100));
  });

  it('CUST-721 a partly finished screen rounds DOWN, never up', () => {
    // Every other figure on this product rounds toward the less flattering answer: the
    // demo meter draws 33% as 30, and only a true 100% fills the bar. A progress figure
    // reported to the person paying for the work gets the same treatment.
    const nineteen = Array.from({ length: 19 }, (_, i) => ({ composed: i < 18 }));
    // 18/19 is 94.7%. It must not be reported as 95.
    expect(designProgress(nineteen).percent).toBe(94);
  });

  it('CUST-722 nothing composed is 0%, and everything composed is 100%', () => {
    expect(designProgress([{ composed: false }, { composed: false }]).percent).toBe(0);
    expect(designProgress([{ composed: true }, { composed: true }]).percent).toBe(100);
    // An empty list cannot be 100% done. Zero of zero is zero, not complete.
    expect(designProgress([]).percent).toBe(0);
  });

  it('CUST-723 composed means the screen\u2019s own layout, not that the palette reaches it', () => {
    // The distinction the whole figure depends on. The token layer reaches all nineteen
    // screens because every component reads the same custom properties; that is not the
    // design being implemented. If this list is ever flipped wholesale to true because
    // "the palette applies", the figure becomes the exact claim this product refuses.
    //
    // Reconciled 20 September 2026: /app and /owner were the two examples here until each
    // was built against its reference and the served screenshot compared with it; later
    // the same day /app/onboarding/compatibility and /app/onboarding/connect left this
    // list the same way (CUST-951..953 pin their arrangement). The routes below are the
    // ones that still only wear the palette — three have no approved screen at all, so
    // they can never be "composed against" one — and every route in the list must name
    // an address the Worker actually serves.
    const composed = STITCH_SCREENS.filter((s) => s.composed).map((s) => s.route);
    for (const route of ['/security', '/admin/login', '/support', '/development-story/visual']) {
      expect(composed, route).not.toContain(route);
    }
    expect(STITCH_SCREENS.map((s) => s.route)).not.toContain('/app/onboarding');
    expect(STITCH_SCREENS.map((s) => s.route)).not.toContain('/app/onboarding/workflow');
    expect(composed.length).toBeLessThan(STITCH_SCREENS.length);
  });
});
