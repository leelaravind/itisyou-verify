/**
 * Table.
 *
 * Always wrapped in its own `overflow-x:auto` container so a wide row scrolls inside the
 * table rather than pushing the page body sideways — a horizontally scrolling document on
 * a phone is the single most common way a "responsive" layout is actually broken.
 *
 * The wrapper is a focusable `role="region"` with an accessible name, because a scrollable
 * container that cannot be reached by keyboard is unusable without a pointer.
 */
import { attrs, html, type Html } from '../html.js';

export interface TableColumn<Row> {
  readonly key: string;
  readonly header: string;
  /** Right-aligned tabular numerals, and never wrapped. */
  readonly numeric?: boolean;
  /** Marks this column as the row's heading — one per table at most. */
  readonly rowHeader?: boolean;
  readonly cell: (row: Row) => Html | string;
}

export interface TableOptions<Row> {
  /** Describes the table to someone who cannot see it. Required, not optional. */
  readonly caption: string;
  /** Hide the caption visually while keeping it for assistive technology. */
  readonly captionHidden?: boolean;
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  /** Shown in place of the table body when there are no rows. */
  readonly empty?: Html;
}

export function Table<Row>(options: TableOptions<Row>): Html {
  if (options.rows.length === 0 && options.empty !== undefined) {
    return options.empty;
  }

  return html`<div class="tablewrap" role="region" tabindex="0" aria-label="${options.caption}">
    <table class="table">
      <caption ${attrs({ class: options.captionHidden === true ? 'sr-only' : null })}>
        ${options.caption}
      </caption>
      <thead>
        <tr>
          ${options.columns.map(
            (column) =>
              html`<th ${attrs({ scope: 'col', class: column.numeric === true ? 'num' : null })}>
                ${column.header}
              </th>`,
          )}
        </tr>
      </thead>
      <tbody>
        ${options.rows.map(
          (row) =>
            html`<tr>
              ${options.columns.map((column) =>
                column.rowHeader === true
                  ? html`<th ${attrs({ scope: 'row', class: column.numeric === true ? 'num' : null })}>
                      ${column.cell(row)}
                    </th>`
                  : html`<td ${attrs({ class: column.numeric === true ? 'num' : null })}>
                      ${column.cell(row)}
                    </td>`,
              )}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

/** A definition list for a single record's fields. Keys in mono, values in mono. */
export function KeyValues(entries: readonly (readonly [string, Html | string])[]): Html {
  return html`<dl class="kv">
    ${entries.map(
      ([key, value]) => html`<dt>${key}</dt>
      <dd>${value}</dd>`,
    )}
  </dl>`;
}
