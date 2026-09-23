/**
 * Form fields.
 *
 * Every field is a real labelled control inside a real `<form method="post">`. The error
 * message renders *next to the field*, is referenced by `aria-describedby`, and sets
 * `aria-invalid` — so the same information reaches a sighted user, a screen-reader user
 * and a user who has turned images and colour off. Nothing here needs JavaScript.
 */
import { attrs, cx, html, type Html } from '../html.js';

export type FieldControl =
  'text' | 'email' | 'url' | 'password' | 'number' | 'tel' | 'textarea' | 'select';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldOptions {
  readonly name: string;
  /**
   * The element id, when the name alone is not unique on the page: two forms posting the
   * same field name (one per provider) must not share an id, or each label points at the
   * other form's input. Defaults to one derived from the name.
   */
  readonly id?: string;
  readonly label: string;
  readonly control?: FieldControl;
  readonly value?: string;
  /** Guidance shown before the control. Never the same sentence as the label. */
  readonly hint?: string;
  /** Inline error. `null` renders nothing — an empty error box is noise. */
  readonly error?: string | null;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly autocomplete?: string;
  readonly inputmode?: string;
  /** Machine-shaped values (ids, property names, keys) are set in mono. */
  readonly mono?: boolean;
  readonly options?: readonly SelectOption[];
  readonly rows?: number;
  readonly readonly?: boolean;
  /** Not `readonly`: a disabled control is not submitted at all, and says so visually. */
  readonly disabled?: boolean;
  readonly pattern?: string;
  readonly maxlength?: number;
}

/** A stable, collision-resistant id from a field name. */
function fieldId(name: string): string {
  return `f-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

export function Field(options: FieldOptions): Html {
  const id = fieldId(options.id ?? options.name);
  const control = options.control ?? 'text';
  const hasError = typeof options.error === 'string' && options.error.length > 0;
  const hintId = options.hint === undefined ? null : `${id}-hint`;
  const errorId = hasError ? `${id}-error` : null;
  const describedBy = [hintId, errorId].filter((v): v is string => v !== null).join(' ');

  const shared = {
    id,
    name: options.name,
    required: options.required === true,
    'aria-invalid': hasError ? 'true' : null,
    'aria-describedby': describedBy.length > 0 ? describedBy : null,
    readonly: options.readonly === true,
    disabled: options.disabled === true,
  } as const;

  let field: Html;
  if (control === 'textarea') {
    field = html`<textarea
      ${attrs({
        ...shared,
        class: cx('textarea', options.mono === true ? 'input--mono' : ''),
        rows: options.rows ?? 5,
        placeholder: options.placeholder ?? null,
        maxlength: options.maxlength ?? null,
      })}
    >
${options.value ?? ''}</textarea
    >`;
  } else if (control === 'select') {
    field = html`<select ${attrs({ ...shared, class: 'select' })}>
      ${(options.options ?? []).map(
        (option) =>
          html`<option ${attrs({ value: option.value, selected: option.value === options.value })}>
            ${option.label}
          </option>`,
      )}
    </select>`;
  } else {
    field = html`<input
      ${attrs({
        ...shared,
        class: cx('input', options.mono === true ? 'input--mono' : ''),
        type: control,
        value: options.value ?? null,
        placeholder: options.placeholder ?? null,
        autocomplete: options.autocomplete ?? null,
        inputmode: options.inputmode ?? null,
        pattern: options.pattern ?? null,
        maxlength: options.maxlength ?? null,
      })}
    />`;
  }

  return html`<div class="field">
    <label class="field__label" for="${id}"
      >${options.label}${
        options.required === true
          ? html` <span class="field__req">required</span>`
          : html` <span class="field__req">optional</span>`
      }</label
    >
    ${options.hint === undefined ? null : html`<p class="field__hint" id="${hintId}">${options.hint}</p>`}
    ${field}
    ${hasError ? html`<p class="field__error" id="${errorId}" role="alert">${options.error}</p>` : null}
  </div>`;
}

export interface CheckboxOptions {
  readonly name: string;
  readonly label: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly error?: string | null;
  readonly disabled?: boolean;
}

export function Checkbox(options: CheckboxOptions): Html {
  const id = fieldId(options.name);
  const hasError = typeof options.error === 'string' && options.error.length > 0;
  return html`<div class="field">
    <div class="check">
      <input
        ${attrs({
          type: 'checkbox',
          id,
          name: options.name,
          value: options.value ?? 'yes',
          checked: options.checked === true,
          disabled: options.disabled === true,
          'aria-invalid': hasError ? 'true' : null,
          'aria-describedby': hasError ? `${id}-error` : null,
        })}
      />
      <label for="${id}">${options.label}</label>
    </div>
    ${hasError ? html`<p class="field__error" id="${id}-error" role="alert">${options.error}</p>` : null}
  </div>`;
}

export interface FieldsetOptions {
  readonly legend: string;
  /** One sentence about what this group of fields is for. */
  readonly hint?: string;
  readonly body: Html;
}

export function Fieldset(options: FieldsetOptions): Html {
  return html`<fieldset class="fieldset">
    <legend>${options.legend}</legend>
    ${options.hint === undefined ? null : html`<p class="fieldset__hint">${options.hint}</p>`}
    ${options.body}
  </fieldset>`;
}

/**
 * The CSRF hidden field. A02 owns token generation; this only renders what it is handed,
 * and renders a visible, loud placeholder if it is handed nothing — a form that silently
 * posts without a token would be worse than one that says it is broken.
 */
export function CsrfField(token: string | null): Html {
  if (token === null || token.length === 0) {
    return html`<input type="hidden" name="csrf_token" value="" data-csrf="missing" />`;
  }
  return html`<input type="hidden" name="csrf_token" value="${token}" />`;
}
