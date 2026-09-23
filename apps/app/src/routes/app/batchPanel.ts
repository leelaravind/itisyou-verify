/**
 * Test several enquiries at once, from the customer's own saved list.
 *
 * The list is the customer's statement of each enquiry: the record, the reference it should
 * carry, where the acknowledgement should have gone, and optionally the message. Running it
 * is one press. Nothing in it is read back from a provider, because a check that compares
 * an observed value with itself proves nothing.
 *
 * Saving the list is free and separate from running it, so the cost can be stated above the
 * one button that spends it, with the number of runs it will use.
 */
import {
  Button,
  ButtonRow,
  Callout,
  CsrfField,
  Disclosure,
  Table,
  attrs,
  html,
  type Html,
} from '@verify/ui';
import { formMessage } from './chrome.js';
import type { SavedTestEnquiries, TestBatchLineError, TestEnquiryRow } from './port.js';

export interface BatchPanelOptions {
  readonly saved: SavedTestEnquiries;
  readonly csrfToken: string | null;
  /** Minted per render: a double press of one page reuses the runs it bought. */
  readonly batchId: string;
  readonly runsRemaining: number;
  readonly maxRows: number;
  /** What a save or run just did. */
  readonly notice?: { readonly message: string; readonly ok: boolean } | null;
  readonly lineErrors?: readonly TestBatchLineError[];
  /** What the reader typed, echoed back when a save was refused. */
  readonly draft?: string | null;
}

function asLines(rows: readonly TestEnquiryRow[]): string {
  return rows
    .map((row) =>
      [row.crmRecordId, row.correlationValue, row.expectedRecipient, row.messageId]
        .filter((field, index) => index < 3 || field !== '')
        .join(', '),
    )
    .join('\n');
}

export function batchPanel(options: BatchPanelOptions): Html {
  const rows = options.saved.rows;
  const count = rows.length;
  const affordable = count > 0 && count <= options.runsRemaining;
  const withoutMessage = rows.filter((row) => row.messageId === '').length;
  const errors = options.lineErrors ?? [];

  return html`<section class="stack" id="test-batch" aria-labelledby="test-batch-heading" data-test-batch>
    <div class="section-head">
      <div class="section-head__text">
        <p class="eyebrow">Several at once</p>
        <h2 id="test-batch-heading">Run your test enquiries</h2>
      </div>
      <p class="small muted">
        Your own list of test enquiries, run with one press. Every value in it is yours: we read the
        records and messages back and compare, and we never copy what we read into what we expect.
      </p>
    </div>

    ${options.notice == null ? null : formMessage(options.notice.message, options.notice.ok ? 'note' : 'warn')}
    ${
      errors.length === 0
        ? null
        : html`<ul class="small" data-batch-errors>
            ${errors.map(
              (error) =>
                html`<li>${error.line === 0 ? 'The list' : `Line ${String(error.line)}`}: ${error.error}</li>`,
            )}
          </ul>`
    }

    ${
      count === 0
        ? html`<p class="small">No test enquiries saved yet. Add them below; saving costs nothing.</p>`
        : html`${Table<TestEnquiryRow>({
            caption: 'Your saved test enquiries',
            stack: true,
            columns: [
              {
                key: 'record',
                header: 'Record id',
                rowHeader: true,
                cell: (row) => html`<span class="mono">${row.crmRecordId}</span>`,
              },
              {
                key: 'reference',
                header: 'Expected reference',
                cell: (row) => html`<span class="mono">${row.correlationValue}</span>`,
              },
              {
                key: 'recipient',
                header: 'Expected recipient',
                cell: (row) => row.expectedRecipient,
              },
              {
                key: 'message',
                header: 'Message id',
                cell: (row) =>
                  row.messageId === ''
                    ? html`<span class="muted">None, so the email checks cannot pass</span>`
                    : html`<span class="mono">${row.messageId}</span>`,
              },
            ],
            rows,
          })}
            ${Callout({
              tone: 'limit',
              title: `Running this list uses ${String(count)} ${count === 1 ? 'run' : 'runs'}, and ${String(options.runsRemaining)} remain`,
              body: html`<p>
                  Each enquiry is admitted exactly like one from your automation, so each costs one run.
                  ${
                    withoutMessage === 0
                      ? null
                      : html`${String(withoutMessage)} ${withoutMessage === 1 ? 'has' : 'have'} no message id, so
                        ${withoutMessage === 1 ? 'its' : 'their'} email checks will end unverified: that is the
                        check telling you it had nothing to read, not a fault.`
                  }
                </p>`,
            })}
            <form method="post" action="/app/test-batch/run" class="stack-sm" data-batch-run>
              ${CsrfField(options.csrfToken)}
              <input type="hidden" name="batchId" ${attrs({ value: options.batchId })} />
              ${ButtonRow([
                Button({
                  label: `Run all ${String(count)} (uses ${String(count)} ${count === 1 ? 'run' : 'runs'})`,
                  variant: 'primary',
                  type: 'submit',
                  disabled: !affordable,
                }),
              ])}
              ${
                affordable
                  ? null
                  : html`<p class="small">Not enough runs remain for the whole list, so it cannot be started.</p>`
              }
            </form>`
    }

    ${Disclosure({
      open: errors.length > 0,
      summary: count === 0 ? 'Add test enquiries' : 'Edit the list',
      body: html`<form method="post" action="/app/test-batch/save" class="stack-sm" data-batch-save>
        ${CsrfField(options.csrfToken)}
        <label class="field__label" for="f-enquiries">One enquiry per line</label>
        <p class="field__hint" id="f-enquiries-hint">
          record id, expected reference, expected recipient, message id (optional). Commas or tabs;
          lines starting with # are ignored. At most ${String(options.maxRows)}.
        </p>
        <textarea
          ${attrs({
            id: 'f-enquiries',
            name: 'enquiries',
            class: 'textarea input--mono',
            rows: 6,
            'aria-describedby': 'f-enquiries-hint',
            'aria-invalid': errors.length > 0 ? 'true' : null,
          })}
        >
${options.draft ?? asLines(rows)}</textarea
        >
        ${ButtonRow([Button({ label: 'Save list', type: 'submit' })])}
        <p class="small muted">Saving runs nothing and costs nothing.</p>
      </form>`,
    })}
  </section>`;
}
