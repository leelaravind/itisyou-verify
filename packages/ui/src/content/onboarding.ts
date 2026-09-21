/**
 * The onboarding guide.
 *
 * Written to close a real gap: the FAQ answer `what-do-i-need-before-starting` promised
 * "see our onboarding guide for the exact steps" before this file existed, and A05 had to
 * render a visible callout admitting the page was missing. That was the honest fallback,
 * not the fix. This is the fix.
 *
 * Every fact below is taken from `docs/connectors.md` (A04, verified against vendor
 * documentation 2026-09-19) — nothing here is invented or aspirational. If a connector
 * detail changes, this file and that document must change together.
 */

export interface OnboardingGuideStep {
  readonly id: string;
  readonly stepNumber: 1 | 2 | 3 | 4;
  readonly title: string;
  /** What the customer must already have, or go and get, before this step. */
  readonly whatYouNeed: readonly string[];
  /** What the customer actually does, in order. */
  readonly whatToDo: readonly string[];
  /** The honest caveat for this step — never omitted where one exists. */
  readonly honestCaveat: string | null;
}

export const ONBOARDING_INTRO =
  "This is not a one-click connection. You need an existing enquiry automation that already creates a HubSpot contact and sends an acknowledgement email through Resend: we verify that automation, we do not build it for you. Four things have to be true before we can check a single enquiry. Budget a real afternoon for this if you built the automation yourself; longer if you need someone else's help to change it. This guide describes the steps as the product is designed to work; see the notice on this page about whether we are accepting live traffic yet before you start handing over credentials.";

export const ONBOARDING_GUIDE_STEPS: readonly OnboardingGuideStep[] = [
  {
    id: 'connect-hubspot',
    stepNumber: 1,
    title: 'Connect HubSpot with a private app token',
    whatYouNeed: [
      'A HubSpot account with permission to create a private app (Settings → Integrations → Private Apps).',
    ],
    whatToDo: [
      'Create a private app, or edit an existing one.',
      'Grant it exactly one scope: crm.objects.contacts.read. We ask for nothing broader.',
      'Save the app and copy the access token. It starts pat- (pat-eu- if your account is in the EU data centre).',
      'Paste the token into your workspace. We check the scope it actually carries immediately, and tell you straight away if the required scope is missing, rather than letting a run fail silently later.',
    ],
    honestCaveat:
      'We use a private app token, not a "Connect with HubSpot" button. A public OAuth app needs HubSpot marketplace review, which this product has not gone through. A private app token is yours: you scope it, and you can revoke it at any time from HubSpot; we cannot revoke it for you, only stop using our copy.',
  },
  {
    id: 'correlation-property',
    stepNumber: 2,
    title: 'Add a correlation property to your HubSpot contacts',
    whatYouNeed: [
      'A HubSpot contact property that will carry a value unique to each enquiry; most agencies reuse an existing "enquiry reference" or "lead source ID" field, or create a new one.',
      'Your automation must already be capable of writing a value into that property when it creates the contact. If it is not doing this today, that is the real setup work: a change inside your own automation, not inside ours.',
    ],
    whatToDo: [
      'Decide which property carries the correlation value, or create one in HubSpot if none exists.',
      'Tell us the exact property name when you set up your workflow rules.',
      'Confirm your automation writes a stable, unique value to that property for every enquiry it handles, before you send us the first signed event referencing it.',
    ],
    honestCaveat:
      "We match a HubSpot record to your enquiry only by this property's value. If your automation is not reliably writing it, we cannot find the right record, and the run will come back unverified rather than a guess.",
  },
  {
    id: 'connect-resend',
    stepNumber: 3,
    title: 'Connect Resend: an API key and a webhook signing secret',
    whatYouNeed: [
      'A Resend account that sends the acknowledgement email your automation triggers.',
      'A Resend API key (starts re_) from the Resend dashboard.',
      "A webhook signing secret (starts whsec_) from the Resend dashboard's Webhooks section.",
    ],
    whatToDo: [
      'Create or copy an existing API key and paste it into your workspace.',
      'In the Resend dashboard, create a webhook endpoint pointed at the address we give you, and subscribe it to: email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained, email.failed.',
      'Copy the webhook signing secret into your workspace. Your connection is designed to stay marked incomplete until a correctly signed event has actually arrived from Resend, not just when you save the settings.',
    ],
    honestCaveat:
      'Resend has no read-only API key: only "full access" or "sending access", and reading a message back requires full access. We are asking for more power than we use, because Resend offers nothing narrower, and we say so rather than letting the permission name imply otherwise. If you would rather not hand over a full-access key, you can run on webhook evidence alone; you lose the ability to re-check a message on demand, so a run whose webhook never arrives stays unverified instead of being resolvable by asking Resend directly. Also: Resend\'s API has no way for us to create the webhook endpoint for you. This step is manual, on your side, every time. As of this writing our side of that webhook is not yet reachable either, the route exists in our codebase but is not yet live, so a Resend connection cannot currently finish reaching "ready" for a real workspace. Do not treat this step as complete until we tell you it is live.',
  },
  {
    id: 'signed-event',
    stepNumber: 4,
    title: 'Send us one signed event per enquiry from your automation',
    whatYouNeed: [
      'A signing key, issued from your workspace once the connections above are in place.',
      'The ability to add one more step to your existing automation: an HTTP call to us.',
    ],
    whatToDo: [
      'Add a step to your automation, after it has kicked off the CRM and email actions, that sends us a signed event naming the correlation value it expects in HubSpot and the recipient it expects Resend to have handled.',
      'That event is what starts a run. Nothing is checked before it arrives.',
    ],
    honestCaveat:
      'This event is a trigger, not proof. We do not trust it: it only tells us what to go and check. The result you get back is decided entirely by what we read from HubSpot and Resend afterwards, never by what this event claims happened. By default, if this step never fires for a given enquiry, we have nothing to check and nothing to show; we do not treat silence as a pass. As of this writing, the endpoint that receives this event is not yet live for real workspaces: this step describes the design, not something you can wire up today.',
  },
];

export const ONBOARDING_DONE_MEANS =
  'Once all four steps are complete and live traffic is switched on, your next signed event starts a real run. It can take up to the completion window your workflow is set to, ten minutes by default, never more than an hour, to settle into verified, failed or unverified. Nothing about this is instant, and nothing is checked retroactively for enquiries that happened before you finished setting up.';
