/**
 * Rules-based FAQ matching over A01's published answers.
 *
 * **No model is involved.** This matcher can do exactly two things: return one of A01's
 * answers *verbatim*, or say it has no match and the question is going to a person. It
 * cannot summarise, paraphrase, combine two answers, or generate a sentence. Every string
 * it can return as an answer is already in `packages/ui/src/content/faq.ts` and already
 * checked against the claims map.
 *
 * The failure mode this is built to avoid is not "unhelpful". It is a confident, fluent,
 * wrong answer about retention, cancellation or what we can actually detect — the exact
 * class of answer that makes a customer trust a claim we never made. So the thresholds
 * are deliberately conservative and the tie-break is deliberately pessimistic: a close
 * second place is treated as ambiguity, not as a near-miss worth guessing at.
 */
import { FAQ_ENTRIES, type FaqEntry } from '@verify/ui';

/** Minimum share of the asker's content words an entry must cover. */
export const MIN_COVERAGE = 0.6;
/** Minimum number of content words in common. One word in common is a coincidence. */
export const MIN_MATCHED_TOKENS = 2;
/** How far ahead of second place the winner must be before we call it a match. */
export const MIN_MARGIN = 0.1;

/** Words carrying no topic signal. Removing them stops "do you" matching everything. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'all',
  'am',
  'an',
  'and',
  'any',
  'anything',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'each',
  'ever',
  'for',
  'from',
  'get',
  'give',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'like',
  'll',
  'me',
  'mine',
  'more',
  'my',
  'need',
  'no',
  'not',
  'of',
  'on',
  'one',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'please',
  'put',
  're',
  's',
  'said',
  'same',
  'say',
  'see',
  'she',
  'should',
  'so',
  'some',
  'something',
  't',
  'take',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'things',
  'this',
  'those',
  'to',
  'up',
  'us',
  'use',
  'used',
  'very',
  've',
  'want',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
]);

/**
 * High-signal words and phrases per A01 entry id, for wording a customer uses that A01's
 * question does not contain. These widen *recall*; they never change an answer.
 *
 * An id absent from this map still matches on its question text. An id here that A01
 * later removes simply stops being reachable — nothing breaks, and nothing is invented.
 */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'different-from-automation-error-alerts': [
    'error alerts',
    'monitoring',
    'alerting',
    'zapier',
    'make',
    'n8n',
  ],
  'evidence-source-down': ['outage', 'down', 'unreachable', 'offline', 'provider down'],
  'run-never-started': [
    'never started',
    'never ran',
    'did not run',
    'missing run',
    'silent failure',
  ],
  'store-customer-data': ['store', 'storage', 'keep', 'retain', 'customer data', 'personal data'],
  'how-cancel': ['cancel', 'cancelling', 'cancellation', 'unsubscribe', 'stop subscription'],
  'data-used-to-train': ['train', 'training', 'model', 'models', 'ai', 'llm', 'machine learning'],
  'what-workflows-supported': [
    'workflows',
    'supported',
    'salesforce',
    'pipedrive',
    'mailgun',
    'sendgrid',
    'integrations',
  ],
  'what-do-i-need-before-starting': [
    'requirements',
    'prerequisites',
    'before starting',
    'setup',
    'set up',
    'onboarding',
  ],
  'what-counts-as-a-run': ['run', 'runs', 'counted', 'counts', 'allowance', 'quota', 'usage'],
  'what-happens-over-allowance': [
    'over allowance',
    'exceed',
    'limit reached',
    'overage',
    'out of runs',
  ],
  'accepted-vs-delivered': ['accepted', 'delivered', 'delivery', 'inbox', 'bounce', 'bounced'],
  'do-you-modify-anything': ['modify', 'change', 'write', 'edit', 'resend email', 'fix'],
  'what-is-coverage-mode': [
    'coverage mode',
    'coverage',
    'customer triggered',
    'independently sourced',
  ],
  'how-long-evidence-kept': [
    'retention',
    'how long',
    'kept',
    'thirty days',
    '30 days',
    'evidence retention',
  ],
  'invite-team': ['invite', 'team', 'seats', 'colleague', 'viewer', 'users'],
  'connection-expires': [
    'expires',
    'expired',
    'reconnect',
    'reauthorise',
    'reauthorize',
    'lost access',
    'revoked',
  ],
  'ai-decide-pass-fail': ['ai decide', 'ai decides', 'model decide', 'automatic decision'],
  'is-this-real-time': [
    'real time',
    'realtime',
    'instant',
    'instantly',
    'immediately',
    'how fast',
    'latency',
  ],
  'tax-and-currency': ['tax', 'vat', 'currency', 'gbp', 'invoice total'],
};

export interface FaqCandidate {
  readonly entryId: string;
  readonly coverage: number;
  readonly matchedTokens: number;
}

export interface FaqMatch {
  readonly matched: true;
  readonly entryId: string;
  readonly question: string;
  /** Verbatim from A01. Never rewritten, never trimmed, never combined. */
  readonly answer: string;
  readonly coverage: number;
}

export interface FaqNoMatch {
  readonly matched: false;
  readonly reason: 'empty_question' | 'no_candidate' | 'low_confidence' | 'ambiguous';
  /** What to say to the customer. Says we do not know; does not attempt an answer. */
  readonly statement: string;
  /**
   * The closest candidates, for the owner's queue only. These are diagnostics, not
   * answers, and must never be rendered to a customer as "did you mean".
   */
  readonly nearest: readonly FaqCandidate[];
}

export type FaqLookup = FaqMatch | FaqNoMatch;

/**
 * NEW WORDING (A09): A01 wrote no "we do not know" copy. Flagged in the handoff.
 */
export const NO_MATCH_STATEMENT =
  'We do not have a published answer that matches this, so we are not going to guess at one. A person will read your message and reply.';

const AMBIGUOUS_STATEMENT =
  'Your question could be about more than one thing and we would rather not answer the wrong one. A person will read your message and reply.';

const EMPTY_STATEMENT =
  'There was no question to match. A person will read your message and reply.';

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crude singularisation. Enough to make "runs" match "run" without a stemmer. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('es') && !token.endsWith('ses')) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

function contentTokens(text: string): readonly string[] {
  return normalise(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

function entryTokens(entry: FaqEntry): ReadonlySet<string> {
  const tokens = new Set<string>(contentTokens(entry.question));
  for (const keyword of KEYWORDS[entry.id] ?? []) {
    for (const token of contentTokens(keyword)) tokens.add(token);
  }
  return tokens;
}

function phraseHit(normalisedQuestion: string, entry: FaqEntry): boolean {
  for (const keyword of KEYWORDS[entry.id] ?? []) {
    const phrase = normalise(keyword);
    if (phrase.includes(' ') && normalisedQuestion.includes(phrase)) return true;
  }
  return false;
}

/**
 * Match a customer question against A01's FAQ.
 *
 * Returns either one of A01's entries verbatim, or an honest no-match. There is no third
 * outcome and no generated text on any path.
 */
export function matchFaq(question: string, entries: readonly FaqEntry[] = FAQ_ENTRIES): FaqLookup {
  const normalised = normalise(typeof question === 'string' ? question : '');
  const asked = contentTokens(normalised);

  if (asked.length === 0) {
    return {
      matched: false,
      reason: 'empty_question',
      statement: EMPTY_STATEMENT,
      nearest: [],
    };
  }

  const askedSet = new Set(asked);
  const scored: FaqCandidate[] = entries
    .map((entry) => {
      const tokens = entryTokens(entry);
      let matchedTokens = 0;
      for (const token of askedSet) if (tokens.has(token)) matchedTokens += 1;
      const coverage = phraseHit(normalised, entry)
        ? Math.max(0.95, matchedTokens / askedSet.size)
        : matchedTokens / askedSet.size;
      return { entryId: entry.id, coverage, matchedTokens };
    })
    .filter((candidate) => candidate.matchedTokens > 0)
    .sort((a, b) => b.coverage - a.coverage || b.matchedTokens - a.matchedTokens);

  const best = scored[0];
  if (best === undefined) {
    return {
      matched: false,
      reason: 'no_candidate',
      statement: NO_MATCH_STATEMENT,
      nearest: [],
    };
  }

  const nearest = scored.slice(0, 3);

  if (best.coverage < MIN_COVERAGE || best.matchedTokens < MIN_MATCHED_TOKENS) {
    return {
      matched: false,
      reason: 'low_confidence',
      statement: NO_MATCH_STATEMENT,
      nearest,
    };
  }

  const runnerUp = scored[1];
  if (runnerUp !== undefined && best.coverage - runnerUp.coverage < MIN_MARGIN) {
    return {
      matched: false,
      reason: 'ambiguous',
      statement: AMBIGUOUS_STATEMENT,
      nearest,
    };
  }

  const entry = entries.find((e) => e.id === best.entryId);
  if (entry === undefined) {
    // Unreachable: `best.entryId` came from `entries`. Treated as no-match rather than
    // thrown, because a support path must never 500 on a lookup.
    return {
      matched: false,
      reason: 'no_candidate',
      statement: NO_MATCH_STATEMENT,
      nearest,
    };
  }

  return {
    matched: true,
    entryId: entry.id,
    question: entry.question,
    answer: entry.answer,
    coverage: best.coverage,
  };
}

/**
 * The set of answers this matcher is allowed to return. Exported so a test can assert
 * that every answer it ever emits is one of A01's strings, byte for byte.
 */
export function publishedAnswers(entries: readonly FaqEntry[] = FAQ_ENTRIES): ReadonlySet<string> {
  return new Set(entries.map((e) => e.answer));
}
