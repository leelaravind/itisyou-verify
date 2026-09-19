/**
 * Factual skeleton for terms, privacy, refund and subprocessor pages.
 *
 * This is data for A05/A09 to render, not finished legal text, and it is not legal
 * advice. Anything marked TODO_OWNER_INPUT is a placeholder the business owner must fill
 * in before publishing — never invent a company registration, address, VAT number or
 * certification in its place.
 */

export const OWNER_LEGAL_IDENTITY = {
  registeredBusinessName: 'TODO_OWNER_INPUT',
  registeredAddress: 'TODO_OWNER_INPUT',
  companyRegistrationNumber: 'TODO_OWNER_INPUT',
  vatNumber: 'TODO_OWNER_INPUT',
  /** e.g. sole trader, limited company. Owner must state this; never assumed. */
  legalStructure: 'TODO_OWNER_INPUT',
  /** Any claimed certification (e.g. ISO 27001) must be TODO until actually held and evidenced. */
  certifications: 'TODO_OWNER_INPUT — none held unless the owner supplies evidence',
  contactEmailForLegalNotices: 'TODO_OWNER_INPUT',
} as const;

export interface DataFlowStage {
  readonly order: number;
  readonly stage: string;
  readonly description: string;
}

/** The actual data flow, for the privacy page. Keep in sync with docs/agent-brief.md stack decisions. */
export const DATA_FLOW: readonly DataFlowStage[] = [
  {
    order: 1,
    stage: 'Browser',
    description:
      'Your browser talks to our application over HTTPS when you sign in, configure a workflow, or view results.',
  },
  {
    order: 2,
    stage: 'Cloudflare Workers and D1 (EU-West)',
    description:
      'Our application runs on Cloudflare Workers, with data stored in Cloudflare D1, a SQL database, in the EU-West region. This is where your workspace configuration, source events and retained evidence live.',
  },
  {
    order: 3,
    stage: 'HubSpot',
    description:
      'We read your contact records back from HubSpot, using the read access you grant us, to check them against your rules.',
  },
  {
    order: 4,
    stage: 'Resend',
    description:
      'We read message status events back from your Resend account to check whether the acknowledgement email reached the point your rules require.',
  },
  {
    order: 5,
    stage: 'Stripe',
    description:
      'Billing is handled entirely by Stripe hosted Checkout and the Stripe Billing Portal. Card details never reach our servers.',
  },
  {
    order: 6,
    stage: 'Optional model provider',
    description:
      'Only if you turn on the optional AI assistant: the specific text needed to answer your request is sent to a model provider. The assistant is off by default and never decides a verification result, an access right, or a charge.',
  },
] as const;

export const EVIDENCE_RETENTION_NOTE =
  'Evidence we retrieve from HubSpot and Resend is kept for 30 days by default, then removed. This retention period is a fixed system limit, not a per-customer setting.';

export interface Subprocessor {
  readonly name: string;
  readonly role: string;
  readonly dataInvolved: string;
}

/** Subprocessor list for the privacy/legal pages. Update if the connector or infra list changes. */
export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: 'Cloudflare',
    role: 'Application hosting, database (D1) and cron scheduling',
    dataInvolved: 'All workspace configuration, source events and retained evidence',
  },
  {
    name: 'HubSpot',
    role: 'Customer-connected CRM evidence source (read access only)',
    dataInvolved: 'The specific contact record fields your workflow rules reference',
  },
  {
    name: 'Resend',
    role: 'Customer-connected email evidence source (read access only)',
    dataInvolved: 'Message status events for the acknowledgement email your workflow rules reference',
  },
  {
    name: 'Stripe',
    role: 'Payment processing and billing management',
    dataInvolved: 'Billing details and subscription status; we never see full card numbers',
  },
  {
    name: 'Optional model provider',
    role: 'Powers the optional AI assistant, only when a customer enables it',
    dataInvolved: 'Only the text needed to answer the specific assistant request',
  },
] as const;

export const REFUND_POLICY_SUMMARY =
  'You can cancel at any time from the billing portal; cancelling stops the next renewal and you keep access for the rest of the period already paid for. We do not offer partial refunds for the unused part of a billing period unless required by law. TODO_OWNER_INPUT: state here if the owner wants to offer any discretionary refund policy beyond what is legally required.';

export const TERMS_SKELETON_NOTE =
  'This is a factual skeleton, not finished terms of service. It must be reviewed by the business owner (and, if the owner chooses, a solicitor) before publishing, and every TODO_OWNER_INPUT field above must be filled in with real, verifiable information — never a placeholder company registration, address, VAT number or certification.';
