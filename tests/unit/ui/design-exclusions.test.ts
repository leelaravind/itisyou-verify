/**
 * The owner's design exclusions, asserted as properties of the served stylesheet.
 *
 * ## Why this file exists
 *
 * The owner gave a list of devices this product may not use, and said in terms that it
 * overrides any conflicting style in the approved Stitch design. On 21 September 2026 an
 * audit found NINE things worth fixing, of which EIGHT map to a named exclusion (the ninth, item 9 below, is dead code the gradient left behind rather than a breach). A later meta-audit also found two breaches this list MISSED, em dashes in copy and a three-column card grid on /security, both fixed the same day. The list:
 *
 *   1. a mint-to-cyan gradient painting the hero headline
 *   2. a blurred radial orb behind two hero panels
 *   3. drop shadows on every card, panel, results frame and the sticky header
 *   4. a 12px backdrop blur making the header glass
 *   5. 8px soft corners on every container
 *   6. Inter sitting second in the sans stack, so every machine with Inter installed
 *      rendered the site in an excluded face
 *   7. pure white as the light palette's surface, behind every card and the header
 *   8. coloured left-border callouts, on the callout, the UNVERIFIED follow-up line and
 *      the pre-checkout must-read line
 *   9. two brand custom properties left emitted with nothing reading them
 *
 * Every one had arrived with a comment explaining why the approved design wanted it. That
 * is the failure mode this file is for: each was defensible on its own and the list was
 * nobody's job. Fixing them one at a time leaves the next person reading the same
 * reference and reaching the same conclusions.
 *
 * So the list is the test. These cases do not check that the pages look good, which is not
 * a property a unit test can hold; they check that a named device is absent from the sheet
 * every page serves. An absence is checkable everywhere at once, which is exactly what the
 * nine individual fixes were not.
 *
 * Case ids `RESIL-911..RESIL-917`.
 *
 * Not covered here, deliberately, because they are properties of copy or of a page rather
 * than of the stylesheet, and are held elsewhere: no fake testimonials, no three-tier
 * pricing (CUST-704 asserts every pound sign on the home page is the one plan price), no
 * emojis or checkmark bullets, and no "It's not X, it's Y" copy. Em dashes ARE covered,
 * by RESIL-916, but against rendered pages rather than against the stylesheet.
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
];

/*
 * "No decorative animation" used to live in BANNED as a bare `@keyframes` needle, on the
 * reasoning that a keyframe animation in this sheet would only ever be decoration. On 21
 * September 2026 the owner reversed the earlier no-motion rule and asked for restrained,
 * purposeful motion -- short content transitions, disclosure expansion, loading feedback,
 * action-completion feedback, tasteful hover transitions -- and a bare `@keyframes` needle
 * cannot tell a genuine one of those from an ornament. It is checked below instead, more
 * precisely than a substring ban could manage: exactly two `@keyframes` rules may exist, each
 * named, each with a stated reason it is not decoration --
 *
 *   `spin`  the rotation on LoadingState's glyph -- see packages/ui/src/components/icons.ts
 *           and .spinner in the stylesheet. Runs only while aria-busy is genuinely true; it
 *           is real "this is still being checked" feedback.
 *   `enter` a small opacity-and-translateY settle on a page's own content boxes (.card,
 *           .panel, .status-card and the rest -- see the "entrance settle" section of
 *           styles.ts). It plays exactly once, when the content first paints, and is finished
 *           in 220ms -- well under a reader's time to start reading. It is not perpetual, not
 *           re-triggered by scrolling (nothing here observes scroll position), and it is tied
 *           to the same real event the spinner is tied to: this content just arrived.
 *
 * -- nothing may declare a third, and every `animation:` value in the sheet must be `none`
 * (the reduced-motion reset, still the opposite of the thing being excluded) or one of those
 * two. Perpetual motion untied to a real waiting state, flashing, animated arrows and
 * bouncing decorations are exactly as forbidden as they were; this file no longer confuses
 * "declares a keyframe" with "is decoration".
 */
describe("the owner's design exclusions hold in the served stylesheet", () => {
  it('RESIL-911 no excluded visual device appears anywhere in the stylesheet', () => {
    for (const [device, needles] of BANNED) {
      for (const needle of needles) {
        expect(CSS, `${device}: "${needle}" is in the stylesheet`).not.toContain(needle);
      }
    }
    // Exactly two @keyframes rules may exist: the loading spinner's rotation and the
    // one-shot content entrance settle. A third would be motion somebody added for its own
    // sake, which is exactly what this case exists to catch.
    const keyframeNames = [...CSS.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
    expect(
      keyframeNames,
      'the stylesheet does not declare exactly the two allowed @keyframes rules',
    ).toEqual(['spin', 'enter']);
    // Every `animation:` in the sheet must be the reduced-motion reset, the loading spin or
    // the entrance settle. Anything else is motion somebody added for its own sake.
    const animations = [...CSS.matchAll(/animation:([^;}!]+)/g)].map((m) => (m[1] ?? '').trim());
    for (const value of animations) {
      expect(
        value === 'none' || /^spin\b/.test(value) || /^enter\b/.test(value),
        `animation:${value} is none of the reduced-motion reset, the loading spin or the entrance settle`,
      ).toBe(true);
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
    /*
     * What is forbidden is DRAWING a left edge, not removing one: `.results>.callout` sets
     * `border-left:0` precisely so a callout sits flush inside the frame, and a rule that
     * takes an edge away cannot be the device the exclusion names.
     */
    /*
     * One carve-out, narrow and named: a hairline BETWEEN two grid cells. The comparison
     * device on the home page puts "what was reported" beside "what we retrieved", and the
     * line between them is the same hairline a table draws between two columns, not an
     * accent bar on the leading edge of a block. It is 1px of `--c-rule`, the neutral rule
     * colour, it carries no tone, and it exists only while the two columns are side by
     * side. Everything else stays forbidden, including any coloured or thick left edge on
     * this selector: the value is pinned, not just the selector.
     */
    const DIVIDER = { selector: '.ediff__col', value: '1px solid var(--c-rule)' };
    const leftRules = [...CSS.matchAll(/([^{}]+)\{[^}]*?border-left(?:-color|-width|-style)?:([^;}]+)/g)]
      .map((m) => ({ selector: (m[1] ?? '').trim(), value: (m[2] ?? '').trim() }))
      .filter((rule) => !/^(?:0(?:px)?|none)$/.test(rule.value))
      .filter(
        (rule) => !(rule.selector.endsWith(DIVIDER.selector) && rule.value === DIVIDER.value),
      )
      .map((rule) => `${rule.selector} => ${rule.value}`);
    expect(leftRules, 'a left-edge rule is back in the stylesheet').toEqual([]);
    // And the replacement is really there, on the callout base rather than on one tone.
    expect(CSS).toMatch(/\.callout\{[^}]*border-top-width:3px/);
    for (const tone of ['limit', 'warn', 'note', 'todo']) {
      expect(CSS, `the ${tone} tone has no top rule`).toMatch(
        new RegExp(`\\.callout--${tone}\\{[^}]*border-top-(?:color|style)`),
      );
    }
    /*
     * And nothing takes it away again, which the four assertions above cannot see.
     *
     * `.results>.callout` zeroed `border-top` so a callout would sit flush inside the
     * results frame. That was right while the tone lived on the left border and became a
     * silent deletion the moment the tone moved to the top: at 0,2,0 it beats
     * `.callout--limit` at 0,1,0, so /demo's amber callout inside that frame lost its
     * colour and a todo callout there would have lost the dash that is the only thing
     * separating it from limit without reading the hue. An independent review found it;
     * the assertions above could not, because they only ask whether the tone rules exist.
     */
    const suppressors = [...CSS.matchAll(/([^{}]*\.callout[^{}]*)\{([^}]*)\}/g)].filter(
      ([, , body]) => /border-top\s*:\s*(?:0|none)\b/.test(body ?? ''),
    );
    expect(
      suppressors.map(([, selector]) => (selector ?? '').trim()),
      'a rule removes the callout tone rule again',
    ).toEqual([]);
  });

  it('RESIL-918 the reduced-motion reset zeroes the delay too, so no staggered element is left invisible', () => {
    /*
     * Found on a rendered page, not by reading this file: the fourth status card on the
     * home page measured opacity 0 with reduced motion requested.
     *
     * The entrance animation starts from opacity 0 and the four cards are staggered by up
     * to 120ms. The reset shortened the DURATION to 0.01ms and left the DELAY alone, so for
     * those 120ms the card sat at its from-state: invisible, to exactly the reader who asked
     * for less motion. Content must never be waiting on a timer to become visible, so the
     * reset now zeroes delay as well, on both animation and transition.
     */
    const at = CSS.indexOf('@media (prefers-reduced-motion:reduce){');
    expect(at, 'the reduced-motion block is gone').toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('\n}', at));
    for (const declaration of [
      'animation-duration:.01ms!important',
      'animation-delay:0ms!important',
      'transition-duration:.01ms!important',
      'transition-delay:0ms!important',
    ]) {
      expect(block, declaration + ' is missing from the reduced-motion reset').toContain(declaration);
    }

    // And the thing that made it matter: something really is staggered, so the reset is not
    // guarding a case that cannot happen.
    expect(CSS).toMatch(/animation-delay:[1-9][0-9]*ms/);
  });
});
