/**
 * The development story must not describe a safeguard that is not in force.
 *
 * The story documents, correctly, that email normalisation does not strip `+tags`. That is
 * a property of the `normalised_email_equals` operator — and on 2026-09-19 no customer
 * workflow emitted that operator, so the paragraph read as a protection customers had and
 * did not. These cases pin the qualification that was added, in both copies of the story
 * and in the story page's journey step, until the per-run binding lands and the wording can
 * be replaced with a statement that the check is in force.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNEY_STEPS } from '@app/routes/public/story/narrative';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const SOURCE = read('docs/development-story.md');
const PUBLISHED = read('apps/app/public/development-story.md');

describe('the story qualifies the recipient comparison honestly', () => {
  it('DOC-130 the published story is a byte-identical copy of the source story', () => {
    expect(PUBLISHED).toBe(SOURCE);
  });

  it('DOC-131 the +tag safeguard is labelled a property of the operator, not of every run, and the operator list says what real runs check', () => {
    // The good reasoning survives.
    expect(SOURCE).toContain('does **not** strip `+tags`');
    expect(SOURCE).toContain('Verification must never widen');
    // It is labelled a property of the operator, and the story records the day it was not in force.
    expect(SOURCE).toContain(
      'That reasoning is a property of the `normalised_email_equals` operator',
    );
    expect(SOURCE).toContain('the safeguard\napplies to a real run');
    // The rule-language section tells the defect and the fix, and labels the proof honestly.
    expect(SOURCE).toContain('could come back verified');
    expect(SOURCE).toContain('closed, typed reference (`expected_from`)');
    expect(SOURCE).toContain('not yet against a live\nprovider account');
    // It no longer sits under "Not yet true".
    expect(SOURCE).not.toMatch(/\*\*Not yet true\.\*\* That a verified run proves/);
  });

  it('DOC-132 the story page’s rule-language step names the binding as a closed reference', () => {
    const step = JOURNEY_STEPS.find((s) => s.title === 'The customer’s rules are evaluated');
    expect(step).toBeDefined();
    expect(step?.body).toContain('as a closed reference, not an expression');
    expect(step?.body).toContain('the address this enquiry named');
  });
});
