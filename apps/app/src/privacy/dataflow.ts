/**
 * A machine-readable inventory of where data actually goes.
 *
 * The privacy page renders this, so it has to describe the system as built, not as
 * intended. Two rules:
 *
 *  - **Nothing aspirational.** If a node is not in the code today, it is not in here. A
 *    privacy page that lists a subprocessor we do not use is as wrong as one that omits
 *    one we do.
 *  - **Nothing invented.** Where we do not know something — the region a third party
 *    processes in, the owner's trading details — the value says so rather than guessing.
 *    `region: 'provider_determined'` is an honest answer; a confident "EU only" about
 *    somebody else's infrastructure is not.
 *
 * A01's `DATA_FLOW` and `SUBPROCESSORS` in `@verify/ui` are the published prose. This
 * file is the structured version, and a test asserts that every stage and every
 * subprocessor A01 published has a node here — so the two cannot drift apart.
 */
import { DATA_FLOW, SUBPROCESSORS } from '@verify/ui';

export const DATA_CATEGORY = [
  'account_identity',
  'workspace_configuration',
  'workflow_rules',
  'source_events',
  'crm_evidence',
  'email_evidence',
  'billing_details',
  'support_messages',
  'website_analytics',
  'assistant_prompt',
] as const;
export type DataCategory = (typeof DATA_CATEGORY)[number];

export type NodeKind =
  'customer_device' | 'our_infrastructure' | 'subprocessor' | 'optional_subprocessor';

export interface DataFlowNode {
  readonly id: string;
  readonly name: string;
  readonly operator: string;
  readonly kind: NodeKind;
  /**
   * Where processing happens. `provider_determined` is used wherever the location is the
   * third party's to decide and we have not verified a contractual region.
   */
  readonly region: 'eu_west' | 'customer_device' | 'provider_determined';
  readonly purpose: string;
  readonly dataCategories: readonly DataCategory[];
  /** What leaves us for this node. Empty for nodes we only read from. */
  readonly whatWeSend: string;
  /** What comes back. Empty for nodes we only send to. */
  readonly whatWeReceive: string;
  /** False for anything a customer has to switch on. */
  readonly enabledByDefault: boolean;
  /** The `RETENTION_POLICY` label that covers whatever this node causes us to store. */
  readonly retentionLabel: string | null;
}

export interface DataFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly transport: 'https';
  /** What makes this hop happen. Never "continuously" unless it genuinely is. */
  readonly trigger: string;
}

/* -------------------------------------------------------------------------- */
/* nodes                                                                      */
/* -------------------------------------------------------------------------- */

export const DATA_FLOW_NODES: readonly DataFlowNode[] = [
  {
    id: 'browser',
    name: 'Your browser',
    operator: 'You',
    kind: 'customer_device',
    region: 'customer_device',
    purpose: 'Signing in, configuring a workflow, reading results, submitting a support message.',
    dataCategories: [
      'account_identity',
      'workspace_configuration',
      'workflow_rules',
      'support_messages',
    ],
    whatWeSend: 'The pages you request, and a session cookie that is an opaque reference.',
    whatWeReceive: 'What you type, and nothing else. There is no client-side analytics script.',
    enabledByDefault: true,
    retentionLabel: null,
  },
  {
    id: 'workers_d1',
    name: 'Cloudflare Workers and D1 (EU-West)',
    operator: 'Cloudflare',
    kind: 'our_infrastructure',
    region: 'eu_west',
    purpose:
      'Runs the application and stores everything we hold: your workspace, workflow rules, source events, run results and retained evidence.',
    dataCategories: [
      'account_identity',
      'workspace_configuration',
      'workflow_rules',
      'source_events',
      'crm_evidence',
      'email_evidence',
      'support_messages',
      'website_analytics',
    ],
    whatWeSend: 'Nothing leaves this node except to the nodes listed below.',
    whatWeReceive: 'Every request the application serves.',
    enabledByDefault: true,
    retentionLabel: 'Evidence',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    operator: 'HubSpot',
    kind: 'subprocessor',
    region: 'provider_determined',
    purpose:
      'The CRM evidence source. We read contact records back using the read access you grant, to check them against your rules.',
    dataCategories: ['crm_evidence'],
    whatWeSend:
      'A read request identifying the record or correlation value we are looking for. We never write, create or edit anything.',
    whatWeReceive:
      'The specific contact record fields your workflow rules reference. We do not mirror your CRM.',
    enabledByDefault: true,
    retentionLabel: 'Evidence',
  },
  {
    id: 'resend',
    name: 'Resend',
    operator: 'Resend',
    kind: 'subprocessor',
    region: 'provider_determined',
    purpose:
      'The email evidence source, and the service that sends our own transactional messages.',
    dataCategories: ['email_evidence', 'account_identity'],
    whatWeSend:
      'Read requests for message status events, and the transactional emails we send you — sign-in links, failure notices, deletion confirmations.',
    whatWeReceive:
      'Message status events for the acknowledgement email your rules reference, and whether the sending service accepted a message we submitted. Acceptance is never treated as proof that anyone received it.',
    enabledByDefault: true,
    retentionLabel: 'Notification records',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    operator: 'Stripe',
    kind: 'subprocessor',
    region: 'provider_determined',
    purpose:
      'Payment processing and billing management, through hosted Checkout and the hosted Billing Portal.',
    dataCategories: ['billing_details'],
    whatWeSend:
      'A reference to your workspace and the plan you are buying. Card details never reach our servers, so we have none to send.',
    whatWeReceive:
      'Subscription status, period dates and a customer reference. We never receive a full card number.',
    enabledByDefault: true,
    retentionLabel: 'Billing and tax records',
  },
  {
    id: 'model_provider',
    name: 'Optional model provider',
    operator: 'The model provider configured for the optional assistant',
    kind: 'optional_subprocessor',
    region: 'provider_determined',
    purpose:
      'Powers the optional AI assistant. Off by default, and it can never decide a verification result, an access right or a charge.',
    dataCategories: ['assistant_prompt'],
    whatWeSend: 'Only the text needed to answer the specific request you made.',
    whatWeReceive: 'Suggested wording, which a person or server code then acts on or ignores.',
    enabledByDefault: false,
    retentionLabel: null,
  },
];

/* -------------------------------------------------------------------------- */
/* edges                                                                      */
/* -------------------------------------------------------------------------- */

export const DATA_FLOW_EDGES: readonly DataFlowEdge[] = [
  {
    from: 'browser',
    to: 'workers_d1',
    transport: 'https',
    trigger: 'You use the application.',
  },
  {
    from: 'workers_d1',
    to: 'hubspot',
    transport: 'https',
    trigger: 'A scheduled check needs to read a CRM record for a run.',
  },
  {
    from: 'workers_d1',
    to: 'resend',
    transport: 'https',
    trigger:
      'A scheduled check needs email status events, or we have a transactional message to send you.',
  },
  {
    from: 'workers_d1',
    to: 'stripe',
    transport: 'https',
    trigger: 'You start a checkout, open the billing portal, or your subscription changes.',
  },
  {
    from: 'workers_d1',
    to: 'model_provider',
    transport: 'https',
    trigger: 'You ask the optional assistant a question, having first switched it on.',
  },
];

/* -------------------------------------------------------------------------- */
/* consistency with A01's published copy                                      */
/* -------------------------------------------------------------------------- */

/**
 * A01's published stage names, in order, mapped to node ids here.
 *
 * Exported so a test can prove the mapping covers everything A01 published. If A01 adds a
 * stage and nobody maps it, the test fails rather than the privacy page quietly omitting
 * a place data goes.
 */
export const A01_STAGE_TO_NODE: Readonly<Record<string, string>> = {
  Browser: 'browser',
  'Cloudflare Workers and D1 (EU-West)': 'workers_d1',
  HubSpot: 'hubspot',
  Resend: 'resend',
  Stripe: 'stripe',
  'Optional model provider': 'model_provider',
};

/** A01's subprocessor names mapped to node ids, for the same reason. */
export const A01_SUBPROCESSOR_TO_NODE: Readonly<Record<string, string>> = {
  Cloudflare: 'workers_d1',
  HubSpot: 'hubspot',
  Resend: 'resend',
  Stripe: 'stripe',
  'Optional model provider': 'model_provider',
};

export function nodeById(id: string): DataFlowNode | undefined {
  return DATA_FLOW_NODES.find((node) => node.id === id);
}

/** The published stages, in A01's order, paired with this file's structured node. */
export function publishedDataFlow(): readonly {
  readonly order: number;
  readonly stage: string;
  readonly description: string;
  readonly node: DataFlowNode | undefined;
}[] {
  return DATA_FLOW.map((stage) => ({
    order: stage.order,
    stage: stage.stage,
    description: stage.description,
    node: nodeById(A01_STAGE_TO_NODE[stage.stage] ?? ''),
  }));
}

/** The published subprocessor list, paired with this file's structured node. */
export function publishedSubprocessors(): readonly {
  readonly name: string;
  readonly role: string;
  readonly dataInvolved: string;
  readonly node: DataFlowNode | undefined;
}[] {
  return SUBPROCESSORS.map((sub) => ({
    name: sub.name,
    role: sub.role,
    dataInvolved: sub.dataInvolved,
    node: nodeById(A01_SUBPROCESSOR_TO_NODE[sub.name] ?? ''),
  }));
}

/**
 * Everything a customer can ask us for, and what happens when they do.
 *
 * NEW WORDING (A09): A01 wrote no data-rights copy. Flagged in the handoff. Deliberately
 * describes what we actually do, rather than quoting law nobody here has verified.
 */
export interface CustomerRequest {
  readonly id: string;
  readonly request: string;
  readonly howToAsk: string;
  readonly whatHappens: string;
}

export const CUSTOMER_REQUESTS: readonly CustomerRequest[] = [
  {
    id: 'copy_of_data',
    request: 'A copy of everything you hold about my workspace',
    howToAsk: 'From the account page while signed in, or by sending us a support message.',
    whatHappens:
      'We build a file containing your workspace, members, workflows, runs, assertions, retained evidence, support messages, notification records, audit records and billing records, as JSON or CSV. It never contains a stored provider credential, in any form.',
  },
  {
    id: 'correction',
    request: 'Correct something that is wrong',
    howToAsk: 'Send us a support message saying what is wrong.',
    whatHappens:
      'Configuration you control — your workspace name, workflow rules, contact address — you can change yourself. Evidence we read back from HubSpot or Resend is a record of what those systems said at the time; we will not alter it, because an altered record of evidence is worthless. If it is wrong, the place to correct it is the source system, and the next check will read the corrected value.',
  },
  {
    id: 'deletion',
    request: 'Delete my workspace and its data',
    howToAsk: 'From the account page while signed in, or by sending us a support message.',
    whatHappens:
      'We schedule the deletion with a short grace period so it can be undone, then revoke your sessions and stored credentials, stop scheduled checks, and remove your evidence, runs, configuration, support messages and notification records. We send you a statement of exactly what remains and why.',
  },
  {
    id: 'stop_optional_processing',
    request: 'Stop the optional AI assistant being used on my data',
    howToAsk: 'Turn it off in settings. It is off unless you turned it on.',
    whatHappens:
      'No text is sent to any model provider. The core service does not depend on a model and behaves identically.',
  },
  {
    id: 'complain',
    request: 'Complain about how my data has been handled',
    howToAsk: 'Send us a support message. It is escalated to the owner and not auto-answered.',
    whatHappens:
      'A person replies. If you are not satisfied with the answer, you can take it to the data protection regulator in your country; we do not claim any approval or endorsement from one.',
  },
];
