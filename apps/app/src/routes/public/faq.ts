/**
 * Access to A01's FAQ entries by id, and the shared FAQ rendering.
 *
 * Lookup throws rather than falling back. If someone deletes an entry A01 wrote, the page
 * must fail at build/typecheck-adjacent time rather than quietly render a blank answer —
 * a missing answer on a page that promises honesty is the worst possible failure mode.
 */
import { FAQ_ENTRIES, html, type Html, type FaqEntry } from '@verify/ui';

export function findFaq(id: string): FaqEntry {
  const entry = FAQ_ENTRIES.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`FAQ entry not found: ${id}. It is A01's content; do not invent a replacement.`);
  }
  return entry;
}

/** Render a selection of FAQ entries, in the order given. */
export function FaqList(ids: readonly string[]): Html {
  return html`<div class="faq">
    ${ids.map((id) => {
      const entry = findFaq(id);
      return html`<div id="faq-${entry.id}">
        <h3>${entry.question}</h3>
        <p>${entry.answer}</p>
      </div>`;
    })}
  </div>`;
}

/** Every entry A01 wrote, in her order. */
export function FaqAll(): Html {
  return FaqList(FAQ_ENTRIES.map((entry) => entry.id));
}
