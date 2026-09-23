/**
 * What each provider credential is actually used for, derived from the operation
 * allowlists rather than described beside them.
 *
 * ## Why this is not a paragraph on a page
 *
 * The connections screen used to say "we only ever read" and leave it there. A customer
 * deciding whether to hand over a key to their CRM deserves the list: which calls exist,
 * what each one is for, and the fact that the list is exhaustive because the connector
 * builds every URL from a frozen table and cannot construct one that is not in it.
 *
 * The purposes below are the only prose here. The METHOD and PATH come from
 * `HUBSPOT_OPERATIONS` and `RESEND_OPERATIONS` themselves, so the page cannot drift from
 * the code: `CONN-524` fails if an operation is added to either table without a purpose,
 * and fails if a purpose is written for an operation that does not exist.
 */
import { HUBSPOT_OPERATIONS } from './hubspot.js';
import { RESEND_OPERATIONS } from './resend.js';

export interface ProviderRead {
  /** As the connector will send it, e.g. "GET /crm/v3/objects/contacts/". */
  readonly call: string;
  /** One clause, in the customer's terms, about what we use it for. */
  readonly purpose: string;
}

const HUBSPOT_PURPOSES: Readonly<Record<keyof typeof HUBSPOT_OPERATIONS, string>> = {
  token_info: 'checks the key is live and reads which scopes it carries',
  contact_by_id: 'reads back the one contact an enquiry names',
  contact_search: 'finds that contact by your correlation property when no id was given',
};

const RESEND_PURPOSES: Readonly<Record<keyof typeof RESEND_OPERATIONS, string>> = {
  retrieve_email: 'reads the delivery outcome of one acknowledgement we were told about',
  list_domains: 'checks the key is live, and which sending domains it can see',
  list_emails:
    'lists recent messages you have sent, so you can pick one to test rather than hunt for its id',
};

function describe(
  operations: Readonly<Record<string, { readonly method: string; readonly path: string }>>,
  purposes: Readonly<Record<string, string>>,
): readonly ProviderRead[] {
  return Object.entries(operations).map(([name, operation]) => ({
    call: `${operation.method} ${operation.path}`,
    purpose: purposes[name] ?? 'no purpose recorded',
  }));
}

/** Every HubSpot call this application can make. There is no other. */
export const HUBSPOT_READS: readonly ProviderRead[] = Object.freeze(
  describe(HUBSPOT_OPERATIONS, HUBSPOT_PURPOSES),
);

/** Every Resend call this application can make. `POST /emails` is not among them. */
export const RESEND_READS: readonly ProviderRead[] = Object.freeze(
  describe(RESEND_OPERATIONS, RESEND_PURPOSES),
);

/** The calls for one provider id, or an empty list for a provider we do not connect. */
export function readsFor(provider: string): readonly ProviderRead[] {
  if (provider === 'hubspot') return HUBSPOT_READS;
  if (provider === 'resend') return RESEND_READS;
  return [];
}
