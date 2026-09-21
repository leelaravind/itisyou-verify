/**
 * The motion contract, asserted against the served stylesheet.
 *
 * The owner asked for restrained, purposeful motion and named the occasions: short content
 * transitions, disclosure expansion, loading feedback, clear action completion, tasteful
 * hover. This file is what stops that becoming either nothing or decoration, because neither
 * failure is visible in a screenshot: a missing transition looks like a design choice and an
 * excessive one looks like a design choice.
 *
 * What is asserted is the OCCASION, not the aesthetic. Each case names a real event a reader
 * causes and checks that the sheet responds to it.
 *
 * Case ids `RESIL-919..RESIL-923`.
 */
import { describe, expect, it } from 'vitest';
import { CSS } from '@verify/ui';

/** The declarations of one rule in the collapsed sheet, or '' if the rule is absent. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector}{`);
  if (at === -1) return '';
  const open = at + selector.length + 1;
  return CSS.slice(open, CSS.indexOf('}', open));
}

describe('the motion contract', () => {
  it('RESIL-919 every duration and easing comes from a token, never a literal', () => {
    // A literal duration is how a sheet ends up with six different speeds and no reason for
    // any of them. Every transition and animation must name the tokens.
    const durations = [...CSS.matchAll(/transition:([^;}]+)/g)].map((m) => (m[1] ?? '').trim());
    expect(durations.length, 'nothing transitions at all').toBeGreaterThan(5);
    for (const value of durations) {
      if (value.startsWith('none')) continue;
      expect(value, `a hard-coded duration: ${value}`).not.toMatch(/\d+m?s/);
      expect(value, `no token in: ${value}`).toMatch(/var\(--dur-(fast|base)\)/);
      expect(value, `no easing in: ${value}`).toMatch(/var\(--ease\)/);
    }
  });

  it('RESIL-920 a disclosure expands rather than snapping, and does it off the layout path', () => {
    // grid-template-rows, not height: height forces layout on every frame. Both disclosures
    // in the product use the same device, so one behaves like the other.
    for (const selector of ['.disc__body', '.callout__detail-body']) {
      const declarations = rule(selector);
      expect(declarations, `${selector} is not in the sheet`).not.toBe('');
      expect(declarations, `${selector} does not animate`).toContain('grid-template-rows');
      expect(declarations, `${selector} animates height`).not.toMatch(/transition:[^;]*height/);
    }
    expect(rule('.disc[open]>.disc__body')).toContain('grid-template-rows:1fr');
  });

  it('RESIL-921 a press, a hover and a focus each get feedback', () => {
    // The three events a reader causes most often. A control that does not acknowledge a
    // press reads as a control that did not receive it.
    expect(rule('.btn:active'), 'a button does not move when pressed').toContain('transform');
    expect(rule('.btn'), 'the press is not transitioned').toContain('transform var(--dur-fast)');
    expect(rule('.nav a'), 'navigation does not respond to hover').toContain('transition:color');
    // Focus is the one that must never be a transition alone: the ring is drawn outright.
    expect(CSS).toContain('.disc__summary:focus-visible{outline:2px solid var(--c-focus)');
  });

  it('RESIL-922 a verdict never animates, and the page that promises stillness keeps it', () => {
    /*
     * The one rule motion may not break. A verdict that fades in reads as an effect rather
     * than as a finding, and this product is an argument about the difference.
     */
    const entrance = /animation:enter[^;}]*/.exec(CSS)?.[0] ?? '';
    expect(entrance, 'the entrance settle is gone').not.toBe('');
    const enterRule = /([^{}]+)\{[^}]*animation:enter/.exec(CSS)?.[1] ?? '';
    expect(enterRule, 'the large verdict badge settles in').not.toContain('badge--lg');
    for (const verdictish of ['.verdict', '.badge--lg', '.score']) {
      expect(rule(verdictish), `${verdictish} animates`).not.toMatch(/transition:(?!none)/);
    }
    // And the development story, which tells readers nothing there is animated.
    expect(CSS).toContain('.story-section .disc');
  });

  it('RESIL-923 reduced motion removes all of it, delay included', () => {
    const at = CSS.indexOf('@media (prefers-reduced-motion:reduce){');
    expect(at, 'the reduced-motion block is gone').toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('\n}', at));
    for (const declaration of [
      'animation-duration:.01ms!important',
      'animation-delay:0ms!important',
      'transition-duration:.01ms!important',
      'transition-delay:0ms!important',
    ]) {
      expect(block, `${declaration} is missing`).toContain(declaration);
    }
  });
});
