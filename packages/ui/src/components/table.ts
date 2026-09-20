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
  /**
   * Shown in place of the table when there are no rows.
   *
   * Optional, but leaving it out is not free: see the floor below. Supply real copy
   * wherever a reader could reasonably meet the empty case, because "Nothing here yet" is
   * a floor, not an answer — a good empty state says what to do next.
   */
  readonly empty?: Html;
  /**
   * Below phone-landscape width, stack each row into one record led by its column heads,
   * the way the approved phone dashboard draws its run feed. Each cell carries its head in
   * `data-label` so the stylesheet can repeat it; the real `<thead>` stays in the document
   * for assistive technology. Above that width the table is the ordinary scrolling table.
   */
  readonly stack?: boolean;
}

export function Table<Row>(options: TableOptions<Row>): Html {
  if (options.rows.length === 0 && options.empty !== undefined) {
    return options.empty;
  }

  const stacked = options.stack === true;
  const labelFor = (column: TableColumn<Row>): string | null => (stacked ? column.header : null);

  /*
   * The floor.
   *
   * `empty` is optional, and every table that forgot it drew its column headers over an
   * empty `<tbody>` — which reads as a table that failed to load, not as a collection with
   * nothing in it. The first user of any screen is the one who meets that, and the one
   * least able to tell the two apart. So a table with no rows and no `empty` branch says
   * so in a row of its own rather than silently rendering a header and a gap.
   *
   * This is deliberately a weak default. It exists so an omission degrades to something
   * truthful instead of something broken, not so callers can skip writing the real thing.
   */
  const emptyRow =
    options.rows.length === 0
      ? html`<tr>
          <td ${attrs({ colspan: String(options.columns.length) })} class="muted">Nothing here yet.</td>
        </tr>`
      : null;

  return html`<div class="tablewrap" role="region" tabindex="0" aria-label="${options.caption}">
    <table ${attrs({ class: stacked ? 'table table--stack' : 'table' })}>
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
                  ? html`<th
                      ${attrs({
                        scope: 'row',
                        class: column.numeric === true ? 'num' : null,
                        'data-label': labelFor(column),
                      })}
                    >
                      ${column.cell(row)}
                    </th>`
                  : html`<td
                      ${attrs({
                        class: column.numeric === true ? 'num' : null,
                        'data-label': labelFor(column),
                      })}
                    >
                      ${column.cell(row)}
                    </td>`,
              )}
            </tr>`,
        )}
        ${emptyRow}
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
