/**
 * Finders for the test verification form: pick a HubSpot contact or a sent Resend message
 * instead of hunting for its id.
 *
 * ## The one rule
 *
 * Choosing fills an IDENTIFIER and nothing else. The value the record should carry in the
 * correlation property, and the address the message should have reached, are the
 * customer's own statement of what ought to be true. They are never taken from what is on
 * screen: a check that compares an observed value with itself proves nothing, and a pass
 * built that way is the failure this product exists to refuse. So the contact finder does
 * not even show the correlation value, and the message finder shows the recipient only so a
 * person can tell one message from another, with a sentence saying it is not copied.
 *
 * ## No script, and nothing here costs a run
 *
 * The finders live inside the test form so that what the reader has already typed travels
 * with every search. Their buttons submit the same form to `/app/test-verification/lookup`
 * (`formaction`), skipping the required-field check (`formnovalidate`) because a search is
 * not the form's purpose. That route admits nothing and never touches the allowance.
 *
 * Enter in any field goes to the form's DEFAULT button, the first submit button in the form.
 * That is a hidden lookup button, so an Enter press can search but can never spend a run:
 * starting a check takes a deliberate press of the button that says it costs one.
 */
import { Button, Table, attrs, html, type Html } from '@verify/ui';
import { formatInstant } from '../public/shared.js';
import { formMessage } from './chrome.js';
import type { LookupView, MessageCandidateView, RecordCandidateView } from './port.js';

export const LOOKUP_ACTION = '/app/test-verification/lookup';

/** What the reader had typed, carried through every search and every pick. */
export interface TestFormValues {
  readonly crmRecordId: string;
  readonly correlationValue: string;
  readonly messageId: string;
  readonly expectedRecipient: string;
  readonly recordQuery: string;
  readonly messageQuery: string;
}

export const EMPTY_TEST_FORM: TestFormValues = {
  crmRecordId: '',
  correlationValue: '',
  messageId: '',
  expectedRecipient: '',
  recordQuery: '',
  messageQuery: '',
};

/**
 * The form's default button, placed first so Enter resolves to it.
 *
 * The route decides what an Enter meant from which search box the reader CHANGED since the
 * page was drawn (each box carries its drawn value in a hidden `...Was` field), then from
 * which one has text at all. When it still cannot tell, it re-renders what was typed and
 * asks. It never starts a check.
 */
export function enterDefaultButton(): Html {
  return Button({
    label: 'Search',
    type: 'submit',
    name: 'lookup',
    value: 'enter',
    formAction: LOOKUP_ACTION,
    formNoValidate: true,
    hidden: true,
  });
}

function searchBar(options: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly buttonLabel: string;
  readonly lookup: string;
}): Html {
  const id = `f-${options.name}`;
  return html`<label class="field__label" for="${id}">${options.label}</label>
    <div class="lookup__bar">
      <input
        ${attrs({
          id,
          name: options.name,
          class: 'input',
          type: 'search',
          value: options.value === '' ? null : options.value,
          placeholder: options.placeholder,
          maxlength: 100,
          autocomplete: 'off',
        })}
      />
      <input type="hidden" name="${options.name}Was" ${attrs({ value: options.value })} />
      ${Button({
        label: options.buttonLabel,
        type: 'submit',
        name: 'lookup',
        value: options.lookup,
        formAction: LOOKUP_ACTION,
        formNoValidate: true,
      })}
    </div>`;
}

function pager(options: {
  readonly view: LookupView<unknown>;
  readonly cursorName: string;
  readonly pageName: string;
  readonly moreLookup: string;
  readonly moreLabel: string;
}): Html | null {
  const { view } = options;
  if (view.pageLimitReached) {
    return html`<p class="lookup__note">
      There are more, but a lookup stops after ${String(view.page)} pages. Narrow the search, or type the id.
    </p>`;
  }
  if (view.nextCursor === null) return null;
  return html`<input type="hidden" name="${options.cursorName}" ${attrs({ value: view.nextCursor })} />
    <input type="hidden" name="${options.pageName}" ${attrs({ value: String(view.page) })} />
    <div class="btn-row">
      ${Button({
        label: options.moreLabel,
        type: 'submit',
        name: 'lookup',
        value: options.moreLookup,
        formAction: LOOKUP_ACTION,
        formNoValidate: true,
      })}
    </div>`;
}

function useButton(label: string, name: string, id: string, ariaLabel: string): Html {
  return Button({
    label,
    type: 'submit',
    name,
    value: id,
    formAction: LOOKUP_ACTION,
    formNoValidate: true,
    ariaLabel,
  });
}

function lookupOutcome(view: LookupView<unknown> | null): Html | null {
  if (view === null || view.message === null) return null;
  return formMessage(view.message, view.state === 'results' ? 'note' : 'warn');
}

/** The contact finder, rendered inside the record id field's group. */
export function recordFinder(options: {
  readonly values: TestFormValues;
  readonly view: LookupView<RecordCandidateView> | null;
  readonly correlationProperty: string;
}): Html {
  const view = options.view;
  const results =
    view === null || view.state !== 'results' || view.items.length === 0
      ? null
      : html`<div class="lookup__results" data-lookup-results="records">
          ${Table<RecordCandidateView>({
            caption: `HubSpot contacts carrying ${options.correlationProperty}, newest first`,
            stack: true,
            columns: [
              {
                key: 'name',
                header: 'Contact',
                rowHeader: true,
                cell: (row) => row.name ?? html`<span class="muted">No name</span>`,
              },
              {
                key: 'email',
                header: 'Email',
                cell: (row) => row.email ?? html`<span class="muted">None</span>`,
              },
              {
                key: 'created',
                header: 'Created',
                cell: (row) => (row.createdAt === null ? '-' : formatInstant(row.createdAt)),
              },
              {
                key: 'id',
                header: 'Record id',
                cell: (row) => html`<span class="mono">${row.id}</span>`,
              },
              {
                key: 'use',
                header: 'Choose',
                cell: (row) =>
                  useButton(
                    'Use this record',
                    'pickRecord',
                    row.id,
                    `Use record ${row.id}${row.name === null ? '' : `, ${row.name}`}`,
                  ),
              },
            ],
            rows: view.items,
          })}
          <p class="lookup__note">
            Choosing fills in the record id only. The value in ${options.correlationProperty} is not shown
            and never filled in for you: type the reference the enquiry actually carried.
          </p>
          ${pager({
            view,
            cursorName: 'recordCursor',
            pageName: 'recordPage',
            moreLookup: 'records-more',
            moreLabel: 'More contacts',
          })}
        </div>`;

  return html`<div class="lookup" data-lookup="records">
    ${searchBar({
      name: 'recordQuery',
      label: 'Or find the contact in HubSpot',
      value: options.values.recordQuery,
      placeholder: 'Name or email, or leave empty for the newest',
      buttonLabel: 'Find contacts',
      lookup: 'records',
    })}
    ${lookupOutcome(view)} ${results}
  </div>`;
}

/** The message finder, rendered inside the message id field's group. */
export function messageFinder(options: {
  readonly values: TestFormValues;
  readonly view: LookupView<MessageCandidateView> | null;
}): Html {
  const view = options.view;
  const results =
    view === null || view.state !== 'results' || view.items.length === 0
      ? null
      : html`<div class="lookup__results" data-lookup-results="messages">
          <p class="lookup__note">
            ${
              view.query === ''
                ? `The ${String(view.examined)} most recent messages Resend sent${view.page > 1 ? ', continued' : ''}.`
                : `${String(view.items.length)} of ${String(view.examined)} messages match "${view.query}". Resend has no search, so older messages were not looked at.`
            }
          </p>
          ${Table<MessageCandidateView>({
            caption: 'Messages sent through Resend, newest first',
            stack: true,
            columns: [
              {
                key: 'sent',
                header: 'Sent',
                rowHeader: true,
                cell: (row) => (row.sentAt === null ? '-' : formatInstant(row.sentAt)),
              },
              {
                key: 'to',
                header: 'To',
                cell: (row) =>
                  row.to.length === 0
                    ? html`<span class="muted">Not given</span>`
                    : row.to.join(', '),
              },
              {
                key: 'subject',
                header: 'Subject',
                cell: (row) => row.subject ?? html`<span class="muted">No subject</span>`,
              },
              {
                key: 'last',
                header: 'Last reported',
                cell: (row) => row.lastEvent ?? html`<span class="muted">Nothing yet</span>`,
              },
              {
                key: 'id',
                header: 'Message id',
                cell: (row) => html`<span class="mono">${row.id}</span>`,
              },
              {
                key: 'use',
                header: 'Choose',
                cell: (row) =>
                  useButton('Use this message', 'pickMessage', row.id, `Use message ${row.id}`),
              },
            ],
            rows: view.items,
          })}
          <p class="lookup__note">
            Choosing fills in the message id only. The address is shown so you can tell messages apart; the
            address it SHOULD have reached is still yours to type, because that is what gets checked.
          </p>
          ${pager({
            view,
            cursorName: 'messageCursor',
            pageName: 'messagePage',
            moreLookup: 'messages-more',
            moreLabel: 'Older messages',
          })}
        </div>`;

  return html`<div class="lookup" data-lookup="messages">
    ${searchBar({
      name: 'messageQuery',
      label: 'Or pick a message Resend sent',
      value: options.values.messageQuery,
      placeholder: 'Filter by recipient or subject, or leave empty',
      buttonLabel: 'Show messages',
      lookup: 'messages',
    })}
    ${lookupOutcome(view)} ${results}
  </div>`;
}
