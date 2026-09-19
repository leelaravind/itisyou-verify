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
  'We only check one thing: whether your enquiry produced the correct HubSpot record and an acknowledgement email, using evidence we read back ourselves. We never modify your CRM, send a replacement email, or fix your automation. Absence of evidence is shown as unverified, never as a pass. By default we cannot tell you a run never started at all — only workflows set up with an independently sourced trigger can show that. "Accepted by the sending service" and "delivered to the receiving server" are different things, and an email being opened is never treated as proof anyone read it. A result can take up to an hour to settle, because we check on a schedule, not instantly. We make no accuracy, security or uptime certification.';
