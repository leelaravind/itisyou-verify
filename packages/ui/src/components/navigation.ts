/**
 * Breadcrumb and Pagination.
 *
 * Pagination here is cursor-based, not page-numbered, because the run list is cursor
 * paginated and offering "page 7 of 40" over a cursor API would be a lie the UI could not
 * honour. The control says what it can actually do: newer, older, and how many rows this
 * page holds.
 */
import { attrs, html, type Html } from '../html.js';

export interface Crumb {
  readonly label: string;
  /** Omit on the final crumb — the current page is not a link to itself. */
  readonly href?: string;
}

export function Breadcrumb(items: readonly Crumb[]): Html {
  return html`<nav class="crumbs" aria-label="Breadcrumb">
    <ol>
      ${items.map((item, index) => {
        const isLast = index === items.length - 1;
        return html`<li>
          ${item.href === undefined || isLast
            ? html`<span ${attrs({ 'aria-current': isLast ? 'page' : null })}>${item.label}</span>`
            : html`<a href="${item.href}">${item.label}</a>`}
        </li>`;
      })}
    </ol>
  </nav>`;
}

export interface PaginationOptions {
  /** Link to the previous (newer) page, or null when this is the first page. */
  readonly newerHref: string | null;
  /** Link to the next (older) page, or null when there is nothing further back. */
  readonly olderHref: string | null;
  /** How many rows this page is showing. */
  readonly shown: number;
  /** What the rows are, for the status line: "runs", "workflows". */
  readonly noun: string;
  readonly label?: string;
}

export function Pagination(options: PaginationOptions): Html {
  if (options.newerHref === null && options.olderHref === null) {
    return html`<p class="pager__status">${options.shown} ${options.noun} — this is all of them</p>`;
  }
  return html`<nav class="pager" aria-label="${options.label ?? 'Pagination'}">
    ${options.newerHref === null
      ? html`<span class="btn" aria-disabled="true">Newer</span>`
      : html`<a class="btn" href="${options.newerHref}" rel="prev">Newer</a>`}
    <p class="pager__status">Showing ${options.shown} ${options.noun}</p>
    ${options.olderHref === null
      ? html`<span class="btn" aria-disabled="true">Older</span>`
      : html`<a class="btn" href="${options.olderHref}" rel="next">Older</a>`}
  </nav>`;
}
