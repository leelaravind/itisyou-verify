/**
 * Rendering A01's `TODO_OWNER_INPUT` placeholders, visibly.
 *
 * The rule, stated once: a legal page that silently omits a trading address is worse than
 * one that shows it is incomplete. A visitor who cannot find a company registration number
 * needs to know it is missing — not be left to assume they missed it.
 *
 * So a placeholder is never hidden, never replaced with a plausible-looking value, and
 * never quietly dropped from the page. It renders as a marked gap with a sentence saying
 * what belongs there and who has to supply it.
 */
import { html, type Html } from '@verify/ui';

/** True when A01's content module is still carrying a placeholder rather than a real value. */
export function isPlaceholder(value: string): boolean {
  return value.includes('TODO_OWNER_INPUT');
}

export interface TodoOptions {
  /** The field name from `OWNER_LEGAL_IDENTITY`, shown so the owner knows what to fill in. */
  readonly field: string;
  readonly value: string;
  /** What a reader should do in the meantime. Rendered whether or not the value is missing. */
  readonly explanation?: string;
}

/**
 * Render an owner-supplied legal value, or a visible gap where one is still missing.
 * Anything after the `TODO_OWNER_INPUT` marker in A01's constant is kept — she sometimes
 * writes the qualifying sentence there, and dropping it would lose information.
 */
export function TodoOwnerInput(options: TodoOptions): Html {
  if (!isPlaceholder(options.value)) {
    // The explanation describes the GAP, so it belongs only to the placeholder branch. It
    // used to print here too, and /support showed the real address followed by "the support
    // address has not been published yet" (audit, 23 Sept).
    return html`<span class="mono">${options.value}</span>`;
  }
  const qualifier = options.value.replace(/^TODO_OWNER_INPUT\s*(—|-)?\s*/, '').trim();
  return html`<span class="stack-sm" data-todo-owner-input="${options.field}">
    <strong class="mono">Not yet published · ${options.field}</strong>
    <span class="small">
      This detail has not been supplied by the business owner yet. It is a UK sole trader and the
      registered details are coming. We are showing the gap rather than filling it with a placeholder that
      looks real.
    </span>
    ${qualifier.length === 0 ? null : html`<span class="small muted">${qualifier}</span>`}
    ${options.explanation === undefined ? null : html`<span class="small muted">${options.explanation}</span>`}
  </span>`;
}

/**
 * A list of owner legal fields, each rendered with `TodoOwnerInput`. Used by the terms and
 * privacy pages so all the gaps are in one obvious place rather than scattered.
 */
export function OwnerIdentityList(entries: readonly (readonly [string, string, string])[]): Html {
  return html`<dl class="kv">
    ${entries.map(
      ([label, field, value]) => html`<dt>${label}</dt>
        <dd>${TodoOwnerInput({ field, value })}</dd>`,
    )}
  </dl>`;
}
