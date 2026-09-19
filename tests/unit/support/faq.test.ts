/**
 * CUST-2xx — rules-based FAQ matching.
 *
 * The failure this suite exists to prevent is not "unhelpful". It is a fluent, confident,
 * wrong answer about retention or cancellation — an answer the customer will reasonably
 * treat as a promise. So the interesting assertions are the ones where the matcher
 * declines.
 */
import { describe, expect, it } from 'vitest';
import { FAQ_ENTRIES } from '@verify/ui';
import { NO_MATCH_STATEMENT, matchFaq, publishedAnswers } from '@app/support/faq';

describe('FAQ matching', () => {
  it("CUST-220 a matching question returns A01's published answer byte for byte", () => {
    const result = matchFaq('How long do you keep evidence for?');
    expect(result.matched).toBe(true);
    if (!result.matched) return;
    const published = FAQ_ENTRIES.find((e) => e.id === 'how-long-evidence-kept');
    expect(result.entryId).toBe('how-long-evidence-kept');
    expect(result.answer).toBe(published?.answer);
  });

  it('CUST-221 an unrelated question returns no match rather than a plausible wrong answer', () => {
    const result = matchFaq('Can I get a refund for last month?');
    expect(result.matched).toBe(false);
    if (result.matched) return;
    expect(result.statement).toBe(NO_MATCH_STATEMENT);
    expect(result.statement.toLowerCase()).toContain('a person will read your message');
  });

  it('CUST-222 a question that could be about two published answers is declined, not guessed', () => {
    // "data" and "keep" overlap the storage answer and the retention answer almost
    // equally. Picking one would be a coin flip presented as a fact.
    const result = matchFaq('data data');
    expect(result.matched).toBe(false);
  });

  it('CUST-223 an empty question is a no-match, not a crash and not a default answer', () => {
    for (const input of ['', '   ', '???']) {
      const result = matchFaq(input);
      expect(result.matched, JSON.stringify(input)).toBe(false);
    }
  });

  it('CUST-224 every answer the matcher can emit is one of A01’s published strings', () => {
    const allowed = publishedAnswers();
    const questions = [
      ...FAQ_ENTRIES.map((e) => e.question),
      'is this real time',
      'do you use ai to decide pass or fail',
      'what counts as a run',
      'what happens if I go over my included runs',
    ];
    let matches = 0;
    for (const question of questions) {
      const result = matchFaq(question);
      if (!result.matched) continue;
      matches += 1;
      expect(allowed.has(result.answer), question).toBe(true);
    }
    // Sanity: the matcher is not simply declining everything.
    expect(matches).toBeGreaterThan(5);
  });

  it('CUST-225 a single word in common is not enough to be a match', () => {
    const result = matchFaq('evidence');
    expect(result.matched).toBe(false);
    if (result.matched) return;
    expect(result.reason).not.toBe('no_candidate');
  });

  it('CUST-226 a no-match names the diagnostics separately from the answer', () => {
    const result = matchFaq('what is your uptime guarantee');
    expect(result.matched).toBe(false);
    if (result.matched) return;
    // Nearest candidates exist for the owner queue, but there is no `answer` field at all
    // on a no-match, so no caller can accidentally render one.
    expect('answer' in result).toBe(false);
    expect(Array.isArray(result.nearest)).toBe(true);
  });

  it('CUST-227 the accepted-versus-delivered answer is reachable, because it is the one people ask', () => {
    const result = matchFaq('what is the difference between an email being accepted and delivered');
    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.entryId).toBe('accepted-vs-delivered');
  });
});
