/**
 * Site-wide factual copy: product identity, the four statuses in customer language, and
 * the standing limitations paragraph that must appear beside every result.
 *
 * Plain data only. No JSX, no components, no styling. A05 renders this.
 */

export const PRODUCT_NAME = 'ITISYOU Verify';

/** One line. Never claim real-time, never claim coverage this product doesn't have. */
export const ONE_LINE_PROMISE =
  'Your automation says it worked. We read the CRM record and the email outcome back from HubSpot and Resend ourselves, and tell you what the evidence actually shows.';

export interface StatusDefinition {
  readonly status: 'VERIFIED' | 'FAILED' | 'UNVERIFIED' | 'PENDING';
  /** Short label shown next to the status badge. */
  readonly label: string;
  /** Full sentence explaining what the status means, in customer language. */
  readonly description: string;
}

/** The four statuses — never a fifth. Matches RUN_STATUS in @verify/contracts exactly. */
export const STATUS_DEFINITIONS: readonly StatusDefinition[] = [
  {
    status: 'VERIFIED',
    label: 'Verified',
    description:
      'Every check you set as mandatory has enough supporting evidence from HubSpot and Resend.',
  },
  {
    status: 'FAILED',
    label: 'Failed',
    description:
      'The evidence contradicts one of your mandatory checks, or the completion deadline passed while we could still reach both providers.',
  },
  {
    status: 'UNVERIFIED',
    label: 'Unverified',
    description:
      'We could not get a clear answer — access, correlation or evidence was missing or ambiguous. This is not a pass and not a failure.',
  },
  {
    status: 'PENDING',
    label: 'Pending',
    description: 'Still inside the agreed completion window. We are still checking.',
  },
] as const;

/**
 * The standing limitations paragraph. Must appear beside every result screen, not just
 * once in the footer. Keep this in sync with README.md "What it deliberately does not do".
 */
export const STANDING_LIMITATIONS_PARAGRAPH =
  'We only check one thing: whether your enquiry produced the correct HubSpot record and an acknowledgement email, using evidence we read back ourselves. We never modify your CRM, send a replacement email, or fix your automation. Absence of evidence is shown as unverified, never as a pass. We cannot tell you that a run never started: we only learn about an enquiry when your automation sends us an event, and we have built no way to find enquiries it never reported. "Accepted by the sending service" and "delivered to the receiving server" are different things, and an email being opened is never treated as proof anyone read it. A result can take up to an hour to settle, because we check on a schedule, not instantly. We make no accuracy, security or uptime certification.';

/**
 * The activation-status notice.
 *
 * Added 2026-09-19 after an internal audit found the defect pattern "correct code,
 * thoroughly tested, reached by nothing" in the parts of the system that turn a signed
 * event into a checked, paid-for run. Specifically, as of this writing: there is no
 * mounted route that receives a customer's signed event at all, the Resend webhook route
 * exists but is not mounted, nothing on a live request path consults the plan allowance or
 * a failed-payment state, and the payment-recovery day-8 sweep and subscription
 * reconciliation are both written but never invoked by the scheduler.
 *
 * This notice exists so that every page describing how the product works can stay up —
 * the design is real and the description is honest — without implying a stranger reading
 * it today can hand over a card and get a working, monitored workflow this minute. A05:
 * render this prominently on any page that leads toward connecting a real account or
 * paying (home, pricing, the onboarding flow's entry point), and treat its presence as the
 * signal to keep the checkout and "go live" steps disabled until the lead confirms the
 * gaps above are wired. Remove this constant's usage — not its accuracy — once they are;
 * it should stop being rendered because it stops being true, not because it stops being
 * inconvenient.
 */
export interface ServiceActivationNotice {
  readonly headline: string;
  readonly body: string;
}

export const SERVICE_ACTIVATION_NOTICE: ServiceActivationNotice = {
  headline: 'We are not yet accepting live verification traffic',
  body: 'Everything on this site describes how ITISYOU Verify is built to work, and the underlying checking logic is real and tested. But the parts that connect a real workspace to that logic are not finished: the endpoint that receives your automation\'s signed events is not live yet, a completed Resend connection cannot yet reach "ready", and the checks that pause verification at your plan allowance or after a failed payment do not yet run automatically. Because of that, we are not taking payment or activating new workspaces right now. Read on for how it will work — this notice will come down once it actually does.',
};

/**
 * The short version of the activation notice, for the footer of every page.
 *
 * The footer previously carried a one-line product description in the present tense — "A
 * service that reads HubSpot and Resend back itself and reports what the evidence shows."
 * — on every page including the legal ones, where it was the last sentence a reader saw.
 * Present tense on a service not yet taking traffic is a claim, not a description.
 *
 * This is deliberately not the full `SERVICE_ACTIVATION_NOTICE`: the footer is not the
 * place to argue the case, and a second full copy of the banner on a page that already
 * carries it teaches readers to skip both. One line, the same fact, and it links nowhere
 * clever.
 */
export const FOOTER_SERVICE_DESCRIPTION =
  'ITISYOU Verify is built to read HubSpot and Resend back itself and report what the evidence shows. Not yet accepting live verification traffic: we are not taking payment or activating workspaces while the endpoint that receives your automation’s signed events is not live.';

/**
 * What has, and has not, been proven against a real provider.
 *
 * ## Why this is separate from the activation notice
 *
 * They are two different gaps and merging them would hide the smaller one. The activation
 * notice says the *plumbing between a workspace and the checking logic* is unfinished. This
 * says something narrower and, for this product, more pointed: the connector code that reads
 * HubSpot and Resend has never been pointed at a real HubSpot or Resend account.
 *
 * `tests/integration/connectors/live-smoke.test.ts` states it without euphemism — the two
 * provider-backed cases skip because no credential exists, and until they run "every claim
 * about reading records back is DESIGNED, NOT OBSERVED". A stub proves our code handles the
 * payload we *believe* the provider sends. It cannot prove the provider sends it.
 *
 * The product's whole argument is that a system reporting on its own work is not proof. A
 * connector proven only against a stub we wrote is exactly that shape of evidence, and
 * saying so on the pages that make the claim is the only position consistent with selling
 * this at all.
 *
 * Remove this when `CONN-900` and `CONN-901` have actually run — not when it reads badly.
 */
export const PROVIDER_PROOF_NOTICE: ServiceActivationNotice = {
  headline: 'Our HubSpot and Resend connectors have not yet been run against a real account',
  body: 'The code that reads a record back from HubSpot and a message outcome back from Resend is written and tested, but it has never been run against a real HubSpot or Resend account — every connector test so far runs against stubs built from published provider documentation. A stub proves we handle the response we believe a provider sends; it cannot prove the provider sends it. We will say here when that has been done, with the date. Until then, treat every description of reading your records back as designed and tested rather than observed in production.',
};
