/**
 * What the customer has to do, in their words.
 *
 * Data only — no markup, no framework. A05 renders it; A04 owns whether it is true.
 * Keeping the words here rather than in the page means the sentence a customer reads about
 * what a credential can do is written next to the code that uses the credential, and
 * changes when that code does.
 *
 * The rule this file exists to obey: **tell the customer what they are handing over
 * before they hand it over.** Resend publishes no read-only key, so connecting Resend
 * means giving us a key that could also send mail as their domain. A customer deserves to
 * be told that on the page where they paste it, not to discover it later.
 */
import { HUBSPOT_READ_SCOPE } from './hubspot.js';
import type { ProviderId } from './types.js';

/**
 * Where a Resend callback lands.
 *
 * Declared here, beside the customer-facing instruction that tells them to point a webhook
 * at it, so the sentence and the route cannot drift apart. `apps/app/src/routes/webhooks/
 * resend.ts` imports this rather than repeating the string.
 *
 * The final segment is an **opaque per-connection id**, not the workspace id and not the
 * connection id: the endpoint must not be guessable from anything the customer's own
 * identity reveals. It is a gate, not a secret — the route rejects an id it did not issue
 * before it does any work on the event, which is what stops a leaked URL being a
 * capability on its own.
 */
export const RESEND_WEBHOOK_PATH_PREFIX = '/api/v1/webhooks/resend/';

/** The path for one connection's endpoint. */
export function resendWebhookPath(opaqueEndpointId: string): string {
  return `${RESEND_WEBHOOK_PATH_PREFIX}${encodeURIComponent(opaqueEndpointId)}`;
}

/**
 * The absolute URL to show the customer.
 *
 * Returns `null` when there is no endpoint id yet, so a caller cannot accidentally render
 * a half-built URL ending in a slash and have somebody paste it into Resend.
 */
export function resendWebhookUrl(baseUrl: string, opaqueEndpointId: string | null): string | null {
  if (opaqueEndpointId === null || opaqueEndpointId === '') return null;
  return `${baseUrl.replace(/\/+$/, '')}${resendWebhookPath(opaqueEndpointId)}`;
}

export interface SetupField {
  /** Matches the `fieldErrors` key `establishConnection` returns. */
  readonly name: 'access_token' | 'webhook_secret';
  readonly label: string;
  /** Shown under the field, before anything is typed. */
  readonly hint: string;
  readonly placeholder: string;
  readonly required: boolean;
  /** True when the value is a credential: render as a password field, never echo it back. */
  readonly secret: boolean;
}

export interface SetupInstruction {
  readonly step: number;
  readonly text: string;
}

/** Everything A05 needs to render one provider's connect card. */
export interface ProviderSetupGuide {
  readonly provider: ProviderId;
  readonly displayName: string;
  /** One line: what this connection is for. */
  readonly purpose: string;
  /** Ordered, literal instructions. Each one is a thing the customer does in the provider. */
  readonly instructions: readonly SetupInstruction[];
  readonly fields: readonly SetupField[];
  /**
   * The permission we ask for, and — where it is broader than what we use — why, stated
   * plainly. **Rendered prominently, above the paste box, not in a footnote.**
   */
  readonly permissionNotice: {
    readonly headline: string;
    readonly body: string;
    /** True when the permission is wider than what we actually need. */
    readonly broaderThanNeeded: boolean;
  };
  /** Exactly what we read. Rendered as a list. */
  readonly weRead: readonly string[];
  /** Exactly what we never do. Rendered as a list. */
  readonly weNeverDo: readonly string[];
  /** Things this connection cannot prove, however well it is set up. */
  readonly cannotProve: readonly string[];
  /** What happens immediately after the paste, so nobody is surprised by a live call. */
  readonly whatHappensNext: string;
  /**
   * The path prefix of the endpoint the customer must point a webhook at, or `null` when
   * this provider needs no webhook. Compose it with `resendWebhookUrl(baseUrl, id)` —
   * never by hand, and never render it without an endpoint id.
   */
  readonly webhookPathPrefix: string | null;
  readonly docUrl: string;
}

const HUBSPOT_GUIDE: ProviderSetupGuide = Object.freeze({
  provider: 'hubspot',
  displayName: 'HubSpot',
  purpose:
    'So we can read the CRM record your automation is supposed to create, directly from HubSpot.',
  instructions: Object.freeze([
    { step: 1, text: 'In HubSpot, go to Settings, then Integrations, then Private Apps.' },
    {
      step: 2,
      text: 'Create a private app. Call it something you will recognise later, such as "ITISYOU Verify".',
    },
    {
      step: 3,
      text: `On the Scopes tab, tick exactly one scope: ${HUBSPOT_READ_SCOPE}. Do not tick any write scope; we have no use for one.`,
    },
    {
      step: 4,
      text: 'Create the app, then copy the access token from the Auth tab. It starts pat-.',
    },
    {
      step: 5,
      text: 'Paste it below. We will check it against HubSpot straight away and tell you what we found.',
    },
  ]),
  fields: Object.freeze([
    {
      name: 'access_token' as const,
      label: 'HubSpot private app token',
      hint: 'Starts pat-. From the Auth tab of your private app.',
      placeholder: 'pat-na1-…',
      required: true,
      secret: true,
    },
  ]),
  permissionNotice: Object.freeze({
    headline: `We ask for one read-only scope: ${HUBSPOT_READ_SCOPE}`,
    body: 'That is the narrowest permission HubSpot offers for reading contacts, and it is the only one we ask for. It cannot create, change or delete anything in your CRM. If you tick additional scopes we will not use them.',
    broaderThanNeeded: false,
  }),
  weRead: Object.freeze([
    'One contact at a time, found either by an id your automation gives us or by the reference it writes into a property you choose.',
    'A named list of properties on that contact: the ones your checks mention, plus the email address, the record id and the creation date. Never the whole record.',
    'Which HubSpot account your token belongs to, so we can prove the record we read is in your account and not somebody else’s.',
  ]),
  weNeverDo: Object.freeze([
    'Create, update, delete, merge or archive anything in your CRM. There is no code path in this product that could.',
    'Read companies, deals, tickets, notes, timeline events or files.',
    'Enrol a contact in a workflow or change a lifecycle stage.',
    'Store your token in plain text, or show it back to you: not even masked.',
  ]),
  cannotProve: Object.freeze([
    'A contact that was created and then deleted before we looked. That is indistinguishable to us from one that never existed.',
    'Anything about a contact the private app has not been granted access to.',
    'Which of two contacts is the right one, when both carry the same reference. We report that as ambiguous rather than guessing.',
  ]),
  whatHappensNext:
    'As soon as you paste it we make one read-only call to HubSpot to check the token works and to find out which account it belongs to. If it fails, nothing is saved at all.',
  webhookPathPrefix: null,
  docUrl: 'https://developers.hubspot.com/docs/guides/apps/private-apps/overview',
});

const RESEND_GUIDE: ProviderSetupGuide = Object.freeze({
  provider: 'resend',
  displayName: 'Resend',
  purpose:
    'So we can see whether the acknowledgement email actually reached the recipient, from Resend rather than from your automation.',
  instructions: Object.freeze([
    {
      step: 1,
      text: 'In Resend, open API Keys and create a key with Full access. Read the note above first: Resend has no read-only option.',
    },
    { step: 2, text: 'Copy the key. It starts re_.' },
    {
      step: 3,
      text: 'Open Webhooks in Resend and add an endpoint pointing at the URL shown beside this step. It is unique to your connection: do not share it, and do not retype it from memory.',
    },
    {
      step: 4,
      text: 'Subscribe that endpoint to email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained and email.failed.',
    },
    { step: 5, text: 'Copy the signing secret for that endpoint. It starts whsec_.' },
    {
      step: 6,
      text: 'Paste both below. The connection stays unfinished until a correctly signed message actually arrives; we will not mark it working on our own say-so.',
    },
  ]),
  fields: Object.freeze([
    {
      name: 'access_token' as const,
      label: 'Resend API key',
      hint: 'Starts re_. Must be a full-access key; see the note above.',
      placeholder: 're_…',
      required: true,
      secret: true,
    },
    {
      name: 'webhook_secret' as const,
      label: 'Webhook signing secret',
      hint: 'Starts whsec_. Beside the webhook endpoint in Resend.',
      placeholder: 'whsec_…',
      required: false,
      secret: true,
    },
  ]),
  permissionNotice: Object.freeze({
    headline: 'Resend has no read-only key, so this key can also send email as your domain',
    body:
      'Resend offers exactly two permission levels: "sending access", which can only send, and "full access", which can create, delete, get and update any resource. There is nothing in between. Reading a message back therefore needs a full-access key, which means the key you give us could also send mail from your domain and delete resources in your Resend account. We only ever read, and the connector has no send path in it at all, but we are not going to pretend the key is narrower than it is. ' +
      'If you would rather not hand that over: connect the webhook only and leave the key blank. A signed delivery callback is independent evidence and needs no key. You lose the ability for us to re-check a message on demand, which means a run whose callback never arrived stays unverified instead of being resolvable.',
    broaderThanNeeded: true,
  }),
  weRead: Object.freeze([
    'One message at a time, by the message id your automation recorded when it sent the acknowledgement.',
    'The delivery events Resend sends us for that message, after we have verified the signature on them.',
    'Your list of domains, once, when you connect: only to check the key works.',
  ]),
  weNeverDo: Object.freeze([
    'Send an email. The send endpoint is not in this connector and cannot be called from it.',
    'Delete or change anything in your Resend account.',
    'Treat an open or a click as proof that a person read anything.',
    'Store your key or signing secret in plain text, or show either back to you.',
  ]),
  cannotProve: Object.freeze([
    'Which Resend team the evidence came from. Resend publishes no account identifier, so we identify the connection by a fingerprint of the key itself.',
    'When a delivery happened, if we only have the API read. Resend tells us the latest status but not its timestamp; only a signed webhook carries the event time.',
    'Anything about a message we were never told the id of.',
  ]),
  whatHappensNext:
    'As soon as you paste the key we make one read-only call to Resend to check it works. The connection then stays in testing until a correctly signed webhook message arrives and we can read it.',
  webhookPathPrefix: RESEND_WEBHOOK_PATH_PREFIX,
  docUrl: 'https://resend.com/docs/dashboard/webhooks/introduction',
});

const GUIDES: Readonly<Record<ProviderId, ProviderSetupGuide>> = Object.freeze({
  hubspot: HUBSPOT_GUIDE,
  resend: RESEND_GUIDE,
});

export function setupGuide(provider: ProviderId): ProviderSetupGuide {
  return GUIDES[provider];
}

export function allSetupGuides(): readonly ProviderSetupGuide[] {
  return Object.freeze([HUBSPOT_GUIDE, RESEND_GUIDE]);
}
