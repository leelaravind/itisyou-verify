/**
 * Empty, error and loading states.
 *
 * An empty screen is an invitation to act, not an apology; an error says what happened and
 * what to do, in the interface's voice, and never says sorry; a loading state names what is
 * being waited for rather than showing an anonymous spinner.
 *
 * All three take an optional action — and render nothing where there is no genuine action,
 * which is the same rule A03's `next_step: null` follows.
 */
import { attrs, html, type Html } from '../html.js';
import { iconAlert, iconSpinner } from './icons.js';

export interface StateOptions {
  readonly title: string;
  readonly body: string;
  /** Buttons or links. Omit entirely when there is nothing useful to offer. */
  readonly actions?: readonly Html[];
  readonly id?: string;
}

export function EmptyState(options: StateOptions): Html {
  return html`<div ${attrs({ class: 'state', id: options.id ?? null })}>
    <p class="state__title">${options.title}</p>
    <p class="state__body">${options.body}</p>
    ${
      options.actions === undefined || options.actions.length === 0
        ? null
        : html`<div class="state__actions">${options.actions}</div>`
    }
  </div>`;
}

export interface ErrorStateOptions extends StateOptions {
  /** The request id from the error envelope, so support can find the same event. */
  readonly requestId?: string;
}

/**
 * `role="alert"` so it is announced when it replaces content after a failed post. It is
 * left-aligned, unlike the empty state, because an error is read rather than admired.
 */
export function ErrorState(options: ErrorStateOptions): Html {
  return html`<div ${attrs({ class: 'state state--error', role: 'alert', id: options.id ?? null })}>
    <p class="state__title">${iconAlert()} ${options.title}</p>
    <p class="state__body">${options.body}</p>
    ${
      options.requestId === undefined
        ? null
        : html`<p class="micro mono gap-top">Reference: ${options.requestId}</p>`
    }
    ${
      options.actions === undefined || options.actions.length === 0
        ? null
        : html`<div class="state__actions align-start">${options.actions}</div>`
    }
  </div>`;
}

export interface LoadingStateOptions {
  /** What is being waited for, named specifically. "Loading" on its own is not a message. */
  readonly title: string;
  readonly body: string;
}

/**
 * A server-rendered waiting state — used where a result genuinely has not settled yet
 * (this product checks on a schedule, so "we are still looking" is a real page state, not
 * a spinner covering a network request). `aria-live="polite"` rather than `alert`: a
 * pending result is not urgent.
 *
 * The rotating glyph beside the title is reinforcement, not the signal: `aria-live` and
 * `aria-busy` on the container are what actually say "this is still moving" to someone who
 * cannot see it, and the glyph is `aria-hidden`. It carries no colour and is not one of the
 * four status glyphs, so it cannot be read as a verdict about evidence — only as "we have
 * not reached one yet".
 */
export function LoadingState(options: LoadingStateOptions): Html {
  return html`<div class="state state--loading" aria-live="polite" aria-busy="true">
    <p class="state__title">${iconSpinner()} ${options.title}</p>
    <p class="state__body">${options.body}</p>
  </div>`;
}
