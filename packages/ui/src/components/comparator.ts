/**
 * The claim/evidence comparator — `design/MAPPING.md` §8, built from that specification.
 *
 * Two sources for the same set of fields: what the customer's workflow reported, beside
 * what we retrieved ourselves, with a verdict on every row and one for the panel. It is the
 * multi-field, two-column sibling of `ClaimRule`; a single assertion should still use that.
 *
 * It is not a diff viewer. A diff shows what changed between two versions of one thing.
 * This shows two different *kinds of statement* about one event — an assertion and a
 * finding — and the asymmetry is the point: the right column can legitimately hold
 * nothing, and it says so in words.
 *
 * Rules this component makes unbreakable:
 *   - It is a `table`, with a caption, three column heads and a row header per field, so a
 *     screen reader hears one row as one unit with its verdict first. The heads are prose.
 *   - The left head names WHO made the claim ("Reported by your workflow"); the right names
 *     what we DID ("What we retrieved"). Never "reality", "truth", "actual" or "claimed".
 *   - An UNVERIFIED row is never an empty cell, an em dash or a spinner: it is the words
 *     `no reading` in a dashed box, plus a reason line naming what blocked the check, in
 *     the row, visible. When the panel is UNVERIFIED those rows lead.
 *   - A FAILED row emphasises BOTH values. We know they disagree, not which side is wrong.
 *   - The panel verdict is the domain's decision, passed in. It is never re-derived here:
 *     a summary row is exactly where a partial result would get rounded up unnoticed, and
 *     the run-level precedence belongs to the frozen contract, not to a component.
 *   - No inline style, no script, no animation near a verdict, no colour-only signal.
 */
import { attrs, cx, html, type Html } from '../html.js';
import type { AssertionKey, StatusKey } from '../tokens.js';
import { AssertionBadge, StatusBadge } from './statusBadge.js';

export interface ComparatorRow {
  /** The field being compared. Rendered once, as the row header. */
  readonly field: string;
  readonly status: AssertionKey;
  /** What the workflow reported — the rule's expectation for this enquiry. */
  readonly reported: string;
  /** What we retrieved. `null` means we retrieved nothing; the state decides the words. */
  readonly retrieved: string | null;
  /** Why the check could not close. Mandatory for UNKNOWN; rendered for PENDING if given. */
  readonly reason?: string | null;
}

export interface ComparatorOptions {
  /** The run identity — "Enquiry #84920 — acknowledgement email". */
  readonly caption: string;
  /** A mono second line under the caption: when it was checked, when the window closed. */
  readonly detail?: string;
  readonly rows: readonly ComparatorRow[];
  /** The run's status as the domain decided it. Never computed from the rows here. */
  readonly verdict: StatusKey;
  /** The plain sentence for the panel verdict. Derived from the rows when omitted. */
  readonly verdictSentence?: string;
  readonly reportedHeading?: string;
  readonly retrievedHeading?: string;
  readonly id?: string;
}

const RETRIEVED_WORDS: Readonly<Record<AssertionKey, string | null>> = {
  SUPPORTED: null,
  CONTRADICTED: null,
  UNKNOWN: 'no reading',
  PENDING: 'not checked yet',
};

/**
 * How a row presents, given the panel it sits in.
 *
 * The evaluator records a check it has looked for and not yet found as `UNKNOWN` with
 * reason `AWAITING_EVIDENCE`, and the run stays `PENDING` while the window is open. Drawn
 * literally, every row of a pending run would wear the dashed ring and the words "no
 * reading" — a run that is simply early would look exactly like one we could not check.
 * So inside a PENDING panel an UNKNOWN row presents as PENDING: the clock, "Still
 * checking", the words "not checked yet". The raw status is kept on the row as
 * `data-assertion-status`, and the reason line ("We have not received the evidence for
 * this check yet") says precisely what is true. Outside a PENDING panel nothing is
 * remapped: once the window has closed, an UNKNOWN is a hole and is drawn as one.
 */
function presentedStatus(row: ComparatorRow, verdict: StatusKey): AssertionKey {
  return verdict === 'PENDING' && row.status === 'UNKNOWN' ? 'PENDING' : row.status;
}

/** The right-hand cell's text. A missing value gets the state's words, never a blank. */
function retrievedText(row: ComparatorRow, presented: AssertionKey): string {
  const words = RETRIEVED_WORDS[presented];
  if (words !== null) return words;
  if (row.retrieved !== null) return row.retrieved;
  // A contradiction with nothing retrieved is "the record does not exist" — different from
  // UNVERIFIED's "we could not look", so it gets different words.
  return presented === 'CONTRADICTED' ? 'nothing found' : 'no value retrieved';
}

/**
 * Order the rows for reading. When the panel is UNVERIFIED the rows that caused it lead,
 * because the reader's first question is "which one?". Otherwise the caller's order stands.
 * Stable, so ties keep their source order.
 */
export function orderComparatorRows(
  rows: readonly ComparatorRow[],
  verdict: StatusKey,
): readonly ComparatorRow[] {
  if (verdict !== 'UNVERIFIED') return rows;
  return [...rows].sort((a, b) => Number(b.status === 'UNKNOWN') - Number(a.status === 'UNKNOWN'));
}

/**
 * The strip's sentence, from the row counts. This describes the verdict it was handed; it
 * does not decide one. "1 of 4" is stated so a mixed panel can never read as a pass.
 */
export function comparatorSentence(rows: readonly ComparatorRow[], verdict: StatusKey): string {
  const total = rows.length;
  const items = (n: number): string => `${String(n)} of ${String(total)} item${total === 1 ? '' : 's'}`;
  const count = (status: AssertionKey): number =>
    rows.filter((row) => presentedStatus(row, verdict) === status).length;
  switch (verdict) {
    case 'VERIFIED':
      return total === 1 ? 'The item matched.' : 'Every item matched.';
    case 'FAILED':
      return `${items(count('CONTRADICTED'))} did not match what was reported.`;
    case 'UNVERIFIED': {
      const unknown = count('UNKNOWN');
      if (unknown > 0) return `We could not check ${items(unknown)}.`;
      const pending = count('PENDING');
      if (pending > 0) return `${items(pending)} were still unchecked when the window closed.`;
      return 'We could not check this run.';
    }
    case 'PENDING':
      return `${items(count('PENDING'))} are still inside the completion window.`;
    default:
      return '';
  }
}

function cellModifier(presented: AssertionKey, side: 'reported' | 'retrieved'): string {
  switch (presented) {
    case 'CONTRADICTED':
      return 'compare__cell--emphasis';
    case 'UNKNOWN':
      return side === 'retrieved' ? 'compare__cell--unverified' : '';
    case 'PENDING':
      return side === 'retrieved' ? 'compare__cell--pending' : '';
    default:
      return '';
  }
}

export function Comparator(options: ComparatorOptions): Html {
  const reportedHeading = options.reportedHeading ?? 'Reported by your workflow';
  const retrievedHeading = options.retrievedHeading ?? 'What we retrieved';
  const rows = orderComparatorRows(options.rows, options.verdict);
  const sentence = options.verdictSentence ?? comparatorSentence(options.rows, options.verdict);

  return html`<div ${attrs({ class: 'compare', id: options.id ?? null })}>
    <table class="compare__table" role="table">
      <caption>
        <p class="compare__caption">${options.caption}</p>
        ${options.detail === undefined ? null : html`<p class="compare__detail">${options.detail}</p>`}
      </caption>
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">Field</th>
          <th scope="col" role="columnheader">${reportedHeading}</th>
          <th scope="col" role="columnheader">${retrievedHeading}</th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        ${rows.map((row) => {
          const presented = presentedStatus(row, options.verdict);
          return html`<tr
            ${attrs({
              role: 'row',
              'data-row-status': presented,
              'data-assertion-status': row.status,
            })}
          >
            <th scope="row" role="rowheader">
              <div class="compare__field">
                ${AssertionBadge({ status: presented })}
                <span>${row.field}</span>
                ${
                  presented === 'UNKNOWN' || (presented === 'PENDING' && typeof row.reason === 'string')
                    ? html`<p class="compare__reason" data-row-reason>
                        ${row.reason ?? 'Why this check could not be completed was not recorded.'}
                      </p>`
                    : null
                }
              </div>
            </th>
            <td
              ${attrs({
                role: 'cell',
                class: cx('compare__cell--reported', cellModifier(presented, 'reported')),
                'data-label': reportedHeading,
              })}
            >
              <p class="compare__value">${row.reported}</p>
            </td>
            <td
              ${attrs({
                role: 'cell',
                class: cx('compare__cell--retrieved', cellModifier(presented, 'retrieved')),
                'data-label': retrievedHeading,
              })}
            >
              <p class="compare__value">${retrievedText(row, presented)}</p>
            </td>
          </tr>`;
        })}
      </tbody>
    </table>
    <div class="compare__foot">
      <p class="compare__verdict" data-compare-verdict="${options.verdict}">
        ${StatusBadge({ status: options.verdict })}<span>${sentence}</span>
      </p>
    </div>
  </div>`;
}
