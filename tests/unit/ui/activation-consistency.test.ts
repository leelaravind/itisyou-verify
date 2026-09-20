/**
 * One fact, six copies, and no way for them to disagree in silence.
 *
 * ## Why this file exists
 *
 * "Why are we not taking payment yet?" is answered in six places: the activation banner,
 * the footer line, the FAQ answer, the control's own reason constant, the `/demo` provider
 * notice and the product specification. Between 19 and 20 September 2026 three of them were
 * corrected and three were not, and two of the stale three were serving statements that had
 * stopped being true — on `/pricing`, next to a corrected copy contradicting them. The
 * independent auditor found the first pair, then a third, then a fourth in the document
 * that *specifies* the notice, across three separate passes.
 *
 * Each fix was correct and none of them stopped it happening again, because the defect is
 * not any one string: it is that nothing fails when two of them disagree.
 *
 * So this file asserts the property directly. It does not check wording, which must be free
 * to differ — a footer line is not a banner. It checks that every copy names the same two
 * outstanding gaps, and that none of them still names a gap that has been closed. Correct
 * the fact in one place and this file tells you the other five.
 *
 * Case ids `DOC-500..DOC-502`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_UNAVAILABLE_REASON,
  FAQ_ENTRIES,
  FOOTER_SERVICE_DESCRIPTION,
  PROVIDER_PROOF_NOTICE,
  SERVICE_ACTIVATION_NOTICE,
} from '@verify/ui';

/** The answer to "why can I not buy this yet", wherever a person can read it. */
const COPIES: readonly (readonly [string, string])[] = [
  ['the activation banner', SERVICE_ACTIVATION_NOTICE.body],
  ['the footer line', FOOTER_SERVICE_DESCRIPTION],
  ["the control's reason", ACTIVATION_UNAVAILABLE_REASON],
  ['the FAQ answer', FAQ_ENTRIES.map((entry) => JSON.stringify(entry)).join(' ')],
  ['the product specification', readFileSync('docs/product-scope.md', 'utf8')],
];

/**
 * The two things that are actually still outstanding, as short phrases rather than
 * sentences, so each copy may word its own sentence however suits its surface.
 */
const OUTSTANDING: readonly (readonly [string, RegExp])[] = [
  [
    'no purchase completed end to end',
    /purchase has (?:been|never been) completed end to end|no purchase has been completed end to end/i,
  ],
  ['no HubSpot record read back', /read back from a real portal/i],
];

/**
 * Claims that were true once and are not any more. Every one of these was live on the site
 * after the thing it describes had started working.
 */
const CLOSED: readonly (readonly [string, RegExp])[] = [
  ['the signed-event endpoint is live', /signed events is not live/i],
  ['a Resend connection can reach ready', /cannot yet (?:finish )?reach(?:ing)? "ready"/i],
  ['the allowance is enforced on the request path', /do not yet run automatically/i],
];

describe('every copy of the activation reason says the same thing', () => {
  it('DOC-500 no copy still names a gap that has been closed', () => {
    for (const [where, text] of COPIES) {
      for (const [what, pattern] of CLOSED) {
        expect(pattern.test(text), `${where} still claims: ${what}`).toBe(false);
      }
    }
  });

  it('DOC-501 the banner, the footer and the FAQ each name both outstanding gaps', () => {
    // The three a visitor reads on the pages an advert can land on. The control's reason
    // is checked separately below because it is one sentence by design.
    for (const where of ['the activation banner', 'the footer line', 'the FAQ answer']) {
      const text = COPIES.find(([name]) => name === where)?.[1] ?? '';
      for (const [what, pattern] of OUTSTANDING) {
        expect(pattern.test(text), `${where} does not name: ${what}`).toBe(true);
      }
    }
  });

  it('DOC-502 the control and the provider notice agree with the banner', () => {
    // Two surfaces that sit directly above a purchase decision. Neither may be the one
    // that still says something else.
    for (const [where, text] of [
      ["the control's reason", ACTIVATION_UNAVAILABLE_REASON],
      ['the /demo provider notice', JSON.stringify(PROVIDER_PROOF_NOTICE)],
    ] as const) {
      for (const [what, pattern] of CLOSED) {
        expect(pattern.test(text), `${where} still claims: ${what}`).toBe(false);
      }
    }
    expect(
      OUTSTANDING.some(([, pattern]) => pattern.test(ACTIVATION_UNAVAILABLE_REASON)),
      'the control gives a reason that names neither outstanding gap',
    ).toBe(true);
  });
});
