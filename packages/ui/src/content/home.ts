/**
 * Marketing home page copy. Plain data only — A05 renders it.
 */

export const HOME_HEADLINE = 'Know whether your automation actually did the job.';

export const HOME_SUBHEAD =
  'A workflow that runs without an error is not the same as a workflow that produced the right result. We check the second thing, by reading HubSpot and Resend back ourselves.';

export interface HomeStep {
  readonly step: 1 | 2 | 3;
  readonly title: string;
  readonly description: string;
}

/** The three-step explanation: connect, define the expected result, receive evidence. */
export const HOME_HOW_IT_WORKS: readonly HomeStep[] = [
  {
    step: 1,
    title: 'Connect HubSpot and Resend',
    description:
      'Give us read access to your HubSpot contacts and to the Resend account your acknowledgement emails go through. We never ask for write access, and we never fetch a URL you supply — only the two connected providers.',
  },
  {
    step: 2,
    title: 'Define the expected result',
    description:
      'Tell us which HubSpot property carries your correlation value, and set the checks that must be true: the record exists with the right value, the email reached the right recipient, the status reached the point you need. Your automation sends us one signed message per enquiry naming what it expects — that message is a trigger, never proof on its own.',
  },
  {
    step: 3,
    title: 'Receive the evidence',
    description:
      'We read the record and the email status back ourselves and tell you verified, failed, unverified or pending, with the reason for each check and the evidence attached. No fifth status, no silent guessing.',
  },
];

export interface HomeExclusion {
  readonly heading: string;
  readonly body: string;
}

/** Honest "what this does not do" section for the home page. */
export const HOME_WHAT_THIS_DOES_NOT_DO: readonly HomeExclusion[] = [
  {
    heading: 'It does not watch your automation platform',
    body: 'We never see inside n8n, Make, Zapier or whatever runs your workflow. We only see what exists in HubSpot and Resend afterwards, so we cannot tell you which step of your automation went wrong.',
  },
  {
    heading: 'It does not fix anything',
    body: 'We do not create or edit CRM records, and we do not send a replacement email. We report what we find; your team still does the fixing.',
  },
  {
    heading: 'It does not cover every workflow',
    body: 'Version one checks exactly one shape: an enquiry that should create the correct CRM record and trigger an acknowledgement email, using HubSpot and Resend only.',
  },
  {
    heading: 'It does not detect a run that never started, by default',
    body: 'If your automation never calls us, we have nothing to check and show nothing — not a pass, not a failure. Only workflows configured with an independently sourced trigger can show a run that never started at all, and that coverage mode is always shown next to the result.',
  },
  {
    heading: 'It is not instant',
    body: 'Results depend on a scheduled check, not a live push. A result can take up to an hour to settle.',
  },
];
