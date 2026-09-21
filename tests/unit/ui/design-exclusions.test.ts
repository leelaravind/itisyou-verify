/**
 * The owner's design exclusions, asserted as properties of the served stylesheet.
 *
 * ## Why this file exists
 *
 * The owner gave a list of devices this product may not use, and said in terms that it
 * overrides any conflicting style in the approved Stitch design. On 21 September 2026 an
 * audit found six of them shipped: a mint-to-cyan gradient painting the hero headline, a
 * blurred radial orb behind two hero panels, drop shadows on every card and on the sticky
 * header, a 12px backdrop blur making the header glass, 8px soft corners on every
 * container, and Inter sitting second in the font stack, which meant every machine with
 * Inter installed rendered the site in an excluded face.
 *
 * Every one of those had arrived with a comment explaining why the approved design wanted
 * it. That is the failure mode this file is for: each was defensible on its own and the
 * list was nobody's job. Fixing them one at a time leaves the next person reading the same
 * reference and reaching the same conclusions.
 *
 * So the list is the test. These cases do not check that the pages look good, which is not
 * a property a unit test can hold; they check that a named device is absent from the sheet
 * every page serves. An absence is checkable everywhere at once, which is exactly what the
 * six individual fixes were not.
 *
 * Case ids `RESIL-911..RESIL-915`.
 *
 * Not covered here, deliberately, because they are properties of copy or of a page rather
 * than of the stylesheet, and are held elsewhere: no fake testimonials, no three-tier
 * pricing (CUST-704 asserts every pound sign on the home page is the one plan price), no
 * emojis or checkmark bullets, no "It's not X, it's Y" copy, and no em dashes in copy.
 */
import { describe, expect, it } from 'vitest';
import { CSS, FONT, LIGHT, DARK, render } from '@verify/ui';
import { HomePage } from '../../../apps/app/src/routes/public/home.js';
import {
  HowItWorksPage,
  PricingPage,
  SecurityPage,
} from '../../../apps/app/src/routes/public/marketing.js';
import { DemoPage } from '../../../apps/app/src/routes/public/demo.js';

/** A device, and the strings that would mean it is back. */
const BANNED: readonly (readonly [string, readonly string[]])[] = [
  ['harsh gradients', ['linear-gradient', 'radial-gradient', 'conic-gradient']],
  ['drop shadows', ['box-shadow', 'drop-shadow']],
  ['glass effects', ['backdrop-filter', 'blur(']],
  // A radial orb is a positioned circle behind content. `border-radius:50%` is how one is
  // drawn and nothing else in this interface is a circle, so the token is the signal.
  ['radial orbs', ['border-radius:50%']],
  // Decorative motion. A keyframe animation in this sheet would only ever be decoration.
  // `transition` on a control is functional and stays; so does `animation:none`, which is
  // the reduced-motion reset and is the opposite of the thing being excluded.
  ['decorative animation', ['@keyframes']],
];

describe("the owner's design exclusions hold in the served stylesheet", () => {
  it('RESIL-911 no excluded visual device appears anywhere in the stylesheet', () => {
    for (const [device, needles] of BANNED) {
      for (const needle of needles) {
        expect(CSS, `${device}: "${needle}" is in the stylesheet`).not.toContain(needle);
      }
    }
    // Every `animation:` in the sheet must be the reduced-motion reset. Anything else is
    // motion somebody added for its own sake.
    const animations = [...CSS.matchAll(/animation:([^;}!]+)/g)].map((m) => (m[1] ?? '').trim());
    for (const value of animations) {
      expect(value, `animation:${value} is not the reduced-motion reset`).toBe('none');
    }
  });

  it('RESIL-912 containers are square, and the edge that replaced their shadow is the stronger rule', () => {
    /*
     * "No soft rounded cards" is one token, `RADIUS.container`, read by every container on
     * nineteen screens. Asserting the emitted custom property rather than each selector is
     * the point: a selector-by-selector check would pass while a single new card opted
     * out.
     *
     * Controls keep their 4px. A corner on a button is how a control says it is a control,
     * and nothing in the exclusions is about controls.
     */
    expect(CSS, 'the container radius is not square').toContain('--r-container:0;');
    expect(CSS, 'controls lost their corner').toContain('--r-control:4px;');
    // Nothing may hard-code a container corner behind the token's back. Anything that is
    // not the token, the control token, the 2px focus ring or an explicit reset is a
    // container corner someone wrote by hand.
    const radii = [...CSS.matchAll(/border-radius:([^;}]+)/g)].map((m) => (m[1] ?? '').trim());
    const allowed = new Set(['var(--r-container)', 'var(--r-control)', '2px', '0', '3px']);
    for (const value of radii) {
      expect(allowed.has(value), `border-radius:${value} is hard-coded`).toBe(true);
    }
  });

  it('RESIL-913 no excluded typeface is named in any font stack', () => {
    /*
     * A font stack is a list of faces the page WILL render in, not a list of preferences.
     * Inter was second in the sans stack behind a face that is not fetched, so on any
     * machine with Inter installed, which is most developer machines, the excluded face is
     * what a reader actually saw. "It is only a fallback" was the reasoning that let it
     * stand, and it was wrong on the only question that matters.
     */
    for (const face of ['Inter', 'Geist', 'Space Grotesk']) {
      expect(FONT.sans, `${face} is in the sans stack`).not.toContain(face);
      expect(FONT.mono, `${face} is in the mono stack`).not.toContain(face);
      expect(CSS, `${face} is in the stylesheet`).not.toContain(face);
    }
  });

  it('RESIL-914 no surface is pure white, in either palette', () => {
    for (const [name, palette] of [
      ['light', LIGHT],
      ['dark', DARK],
    ] as const) {
      for (const key of ['paper', 'surface', 'sunken'] as const) {
        expect(
          palette[key].toUpperCase(),
          `${name}.${key} is pure white`,
        ).not.toMatch(/^#(?:FFF|FFFFFF)$/);
      }
    }
    expect(CSS, 'a pure white is hard-coded in the stylesheet').not.toMatch(
      /#fff(?:fff)?\b/i,
    );
  });

  it('RESIL-916 no public page shows an em dash or an en dash to a reader', async () => {
    /*
     * "No em dashes" is a property of copy, so it is checked against what a reader sees
     * rather than against the source: the source is full of them and they belong there,
     * in comments, where no reader meets them. 146 were removed from copy on 21 September
     * 2026 and a source-level grep could not tell the two apart without an allowlist that
     * would rot.
     *
     * The scope is the five public pages, and the gap in it is stated rather than papered
     * over, because a guard that implies more coverage than it has is worse than a narrow
     * one: the signed-in and owner screens are not rendered here, which needs a session
     * fixture and belongs in an integration test. Their copy was swept on the same day and
     * nothing holds it there yet.
     *
     * `/demo` joined this list second. Its status explanations come from
     * `packages/domain`, which the first sweep did not cover, so for one commit it still
     * showed four dashes and the case said so instead of quietly covering four pages and
     * implying five.
     *
     * The character class covers the en dash too. It was being used for date ranges, and
     * a reader cannot tell the two apart at a glance.
     */
    const pages: readonly (readonly [string, string])[] = [
      ['/', await render(HomePage())],
      ['/pricing', await render(PricingPage())],
      ['/how-it-works', await render(HowItWorksPage())],
      ['/demo', await render(DemoPage())],
      ['/security', await render(SecurityPage())],
    ];
    for (const [path, markup] of pages) {
      const visible = markup
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–');
      const found = [...visible.matchAll(/[^\s]*[–—][^\s]*/g)].map((m) => m[0]);
      expect(found, `${path} shows a dash to a reader: ${found.join(' | ')}`).toEqual([]);
    }
  });

  it('RESIL-917 no public page shows a reader the syntax of a source comment', async () => {
    /*
     * Found on the served /terms on 21 September 2026, and it had been there since the
     * line was written: an exemption marker for `scripts/scan-claims.mjs` had been put in
     * JSX brace-and-star form inside an `html` tagged template. That is not a comment
     * here. The template's literal parts are raw HTML, so the whole marker, including the
     * word "claim-scan:allow" and its reason, was rendered as a visible line of prose
     * directly above the heading it was exempting.
     *
     * The class of bug is a comment convention from another framework surviving into a
     * stack that does not have it, which no typecheck or lint catches because the result
     * is a valid string. So the assertion is on what a reader sees, and it covers the
     * three comment forms that could arrive the same way. Real HTML comments are stripped
     * first, because those ARE comments here and are invisible on the page.
     */
    const pages: readonly (readonly [string, string])[] = [
      ['/', await render(HomePage())],
      ['/pricing', await render(PricingPage())],
      ['/how-it-works', await render(HowItWorksPage())],
      ['/demo', await render(DemoPage())],
      ['/security', await render(SecurityPage())],
    ];
    for (const [path, markup] of pages) {
      const visible = markup.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
      for (const form of ['{/*', '*/}', '/**', 'claim-scan:allow', 'secret-scan:allow']) {
        expect(visible, `${path} shows a reader ${form}`).not.toContain(form);
      }
    }
  });

  it('RESIL-915 a toned block is ruled along its top, never down its left edge', () => {
    /*
     * "No coloured left-border callouts". The callout, the UNVERIFIED follow-up line and
     * the pre-checkout must-read line all carried a 2-3px coloured left border; they now
     * carry the same rule along the top, which is the device the status cards already
     * used. Nothing that carried meaning moved: the tone is still a colour, the todo tone
     * is still the only dashed one, and every tint behind a body is unchanged, so no
     * contrast measurement moved with it.
     *
     * The assertion is on the shape rather than on the four selectors, because the reason
     * this needed fixing at all is that the device kept being copied to new blocks.
     */
    const leftRules = [...CSS.matchAll(/border-left(?:-color|-width|-style)?:([^;}]+)/g)].map(
      (m) => (m[1] ?? '').trim(),
    );
    expect(leftRules, 'a left-edge rule is back in the stylesheet').toEqual([]);
    // And the replacement is really there, on the callout base rather than on one tone.
    expect(CSS).toMatch(/\.callout\{[^}]*border-top-width:3px/);
    for (const tone of ['limit', 'warn', 'note', 'todo']) {
      expect(CSS, `the ${tone} tone has no top rule`).toMatch(
        new RegExp(`\\.callout--${tone}\\{[^}]*border-top-(?:color|style)`),
      );
    }
  });
});
